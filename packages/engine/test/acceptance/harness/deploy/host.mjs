// Fixtures, host-side reads and the operator's guard for the M4 slice-24
// rows (M307 to M313; SEAM.md §§256 to 263): the deployment on a real
// `local_service` unit, in the sandbox lane.
//
// SAFETY (BS4 §4.1, binding; E64; D4 §9.5; SEAM.md §257). Read before
// changing anything here.
//   1. Every unit a test acts on is named `surety-<h>-<env>-g<n>.service`
//      with <h> derived from the test's own disposable SURETY_HOME and
//      named in that home's store (an attempt intent's `create_units`), or
//      is a decoy the test created itself under an exact name. A unit is
//      stopped, restarted or reset only by that exact name, never by a
//      pattern, a glob, `--all` or a prefix. Listing units is a read; the
//      list is filtered here, in JavaScript, and grants nothing.
//   2. Nothing here stops, restarts, reloads, re-executes or daemon-reloads
//      the user's service manager, and nothing touches Docker or the system
//      manager. `systemctl --user` is called with `show`, `list-units`,
//      `is-system-running`, and, for an exact name only, `stop`, `restart`
//      and `reset-failed`; `systemd-run --user` only to create a decoy
//      under an exact name that does not yet exist.
//   3. A test acts on a service (stops or restarts its unit, or releases an
//      act of the fixture service) only after `assertServiceContained` has
//      read from the host that the unit carries its own home's prefix and
//      that the application's pid is in that unit's cgroup and in no host
//      namespace; the fixture service refuses every act from inside unless
//      it is contained (fixture-service.cjs). No process is signalled.
//   4. `operatorGuard` is every slice-24 file's before-and-after check
//      (row M313): it reports a leftover by exact name, fails the file for
//      it, and stops only exactly named units of the file's own homes that
//      the store's intents name. It never cleans by pattern.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { freePort, httpRequest } from '../engine.mjs';
import { tick } from '../runs.mjs';
import { sandboxEngine } from '../sandbox/lane.mjs';
import { CGROUP_ROOT, cgroupOfPid, procsOf } from '../sandbox/cgroup.mjs';
import { hostProcess } from '../sandbox/procs.mjs';
import { hostNamespaces, namespacesOf } from '../scripted.mjs';
import { withStore } from '../store.mjs';
// The real-path comparison of unrecordedUnderArtifacts (SEAM.md §264).
import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { permittedEdit, roleThat, runToEnd, waitForCandidates } from '../gitruns.mjs';
import { changePolicy } from '../journal.mjs';
import {
  GOVERNED_FILE,
  acceptance,
  checkProject,
  defPath,
  definitionText,
  governedText,
  installCheckProgram,
  installIndexedPlan,
  executionsOf,
  outputText,
  qualifyRunnerByFixture,
  smoke,
} from '../checks/fixtures.mjs';
import {
  RUNTIME,
  attemptIntent,
  attemptsOf,
  configContent,
  configure,
  deploy,
  homeHash,
  operationsOf,
  qualifyByFixture,
  roundsOf,
  teardown,
  unitPrefix,
  verificationsOf,
} from './kernel.mjs';

const json = (text) => (text === null || text === undefined ? text : typeof text === 'string' ? JSON.parse(text) : text);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The switch that gives a harness engine the real `local_service` adapter
// (SEAM.md §247). Every start of a sandbox-lane slice-24 engine carries it.
// The engine does not refuse to start without it (in harness mode the
// scripted adapter is the default, so M1 to M3 engines start unchanged):
// the harness makes and checks it instead (SEAM.md §265, `realAdapterStarts`).
export const REAL_ADAPTER = Object.freeze(['--harness-deploy-adapter', 'real']);

// The adapter a running harness engine selected, read back from its own
// argument vector (`/proc/<pid>/cmdline`, or the vector it was spawned with
// once it has exited): `real` or `scripted` by SEAM.md §247's rule (the
// switch's value; `scripted` when it is absent), or `ambiguous` when the
// switch is given more than once. `proc` false (an engine not yet known to
// have reached its own code, `until: 'none'`) reads the spawned vector.
export function deployAdapterOf(engine, { proc = true } = {}) {
  let argv = null;
  if (proc && engine.isRunning()) {
    try {
      argv = readFileSync(`/proc/${engine.pid}/cmdline`, 'utf8').replace(/\0$/, '').split('\0');
    } catch {
      argv = null;
    }
  }
  if (argv === null) argv = engine.proc.child.spawnargs;
  const at = argv.flatMap((a, i) => (a === '--harness-deploy-adapter' ? [i] : []));
  if (at.length > 1) return 'ambiguous';
  return at.length === 0 ? 'scripted' : argv[at[0] + 1];
}

export function assertRealAdapter(engine, what = 'the engine', opts = {}) {
  const adapter = deployAdapterOf(engine, opts);
  assert.equal(adapter, 'real', `${what} runs the real local_service adapter (--harness-deploy-adapter real, SEAM.md §265); it reads ${JSON.stringify(adapter)}, so a sandbox-lane file would be passing on the scripted adapter`);
}

// SEAM.md §265: every start of `fx` carries the real adapter's switch (added
// when a start's arguments do not name one; a start naming another value
// fails), and the started engine's own argument vector is read back to
// select `real`. hostDeployable applies it; a sandbox-lane file that builds
// its engine otherwise applies it before the first start.
export function realAdapterStarts(fx) {
  if (fx.realAdapter) return fx;
  const plainStart = fx.start;
  fx.start = async (opts = {}) => {
    const args = [...(opts.args ?? [])];
    const named = args.flatMap((a, i) => (a === '--harness-deploy-adapter' ? [args[i + 1]] : []));
    assert.ok(named.every((v) => v === 'real'), `a sandbox-lane engine is started with --harness-deploy-adapter real only (asked for ${JSON.stringify(named)}; SEAM.md §265)`);
    if (named.length === 0) args.unshift(...REAL_ADAPTER);
    else if (named.length > 1) assert.fail(`--harness-deploy-adapter given ${named.length} times (SEAM.md §265)`);
    const engine = await plainStart({ ...opts, args });
    assertRealAdapter(engine, 'the sandbox-lane engine just started', { proc: opts.until !== 'none' });
    return engine;
  };
  fx.realAdapter = true;
  return fx;
}

export const UID = process.getuid();
// Where the user manager's units have their cgroups (cgroup v2, the tests
// in the root cgroup namespace).
export const USER_MANAGER_CGROUP = join(CGROUP_ROOT, 'user.slice', `user-${UID}.slice`, `user@${UID}.service`);

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
export const ownUnitPattern = (home) => new RegExp(`^surety-${homeHash(home)}-env_${ULID}-g[1-9][0-9]*\\.service$`);
const GLOB = /[*?[\]\\\s]/;

export function assertOwnUnit(home, name, what = 'the unit') {
  assert.ok(typeof name === 'string' && ownUnitPattern(home).test(name), `${what} ${JSON.stringify(name)} is named surety-<h>-<env>-g<n>.service with <h> this test's own home's (SEAM.md §257)`);
}

// ---- the user manager, read only -------------------------------------------------------------

function systemctl(args, { timeoutMs = 30_000 } = {}) {
  return spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: timeoutMs });
}

export function managerState() {
  const done = systemctl(['is-system-running']);
  return (done.stdout ?? '').trim() || null;
}

// `systemctl --user show` of one exact unit name: {prop: value}, or null
// when the manager could not be asked (unread, never "absent").
export function unitShow(name, props) {
  assert.ok(typeof name === 'string' && name.endsWith('.service') && !GLOB.test(name), `an exact unit name, no pattern (${JSON.stringify(name)})`);
  const done = systemctl(['show', ...props.flatMap((p) => ['-p', p]), '--', name]);
  if (done.status !== 0) return null;
  const out = {};
  for (const line of done.stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

export const UNIT_PROPS = Object.freeze(['LoadState', 'ActiveState', 'SubState', 'Result', 'MainPID', 'ControlGroup', 'InvocationID', 'Delegate', 'Restart', 'MemoryMax', 'MemorySwapMax', 'TasksMax', 'StandardOutput', 'StandardError']);

// Every unit the user manager has loaded, in any state: [{unit, load, active, sub}], or null (unread).
export function listUnits() {
  const done = systemctl(['list-units', '--all', '--no-legend', '--plain', '--no-pager', '--full']);
  if (done.status !== 0) return null;
  return done.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c[0])
    .map((c) => ({ unit: c[0], load: c[1], active: c[2], sub: c[3] }));
}

// The loaded units carrying a home's unit prefix (`surety-<h>-env_`), by exact name.
export function unitsOfHome(home) {
  const units = listUnits();
  assert.ok(units !== null, 'the user units can be listed (systemctl --user list-units): what is loaded is otherwise unknown');
  const prefix = `surety-${homeHash(home)}-env_`;
  return units.filter((u) => u.unit.startsWith(prefix));
}

// Cgroup directories under the user manager whose name carries a prefix, to depth 3.
export function cgroupsNamed(prefix) {
  const found = [];
  const visit = (dir, depth) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(prefix)) found.push(join(dir, e.name));
      if (depth < 3) visit(join(dir, e.name), depth + 1);
    }
  };
  visit(USER_MANAGER_CGROUP, 0);
  return found;
}

export function journalOf(name) {
  assert.ok(!GLOB.test(name), `an exact unit name (${name})`);
  const done = spawnSync('journalctl', ['--user', '-u', name, '-o', 'cat', '--no-pager'], { encoding: 'utf8', timeout: 30_000 });
  return { status: done.status, text: `${done.stdout ?? ''}${done.stderr ?? ''}` };
}

// ---- the test's own acts on a unit, by exact name ---------------------------------------------

// The exact unit names the engine of `home` recorded in its attempt intents.
export function intendedUnits(home) {
  try {
    return withStore(home, (db) => db.prepare('SELECT "create_units" FROM "attempt_intents"').all()).flatMap((r) => json(r.create_units) ?? []);
  } catch {
    return [];
  }
}

function assertActable(home, name) {
  assertOwnUnit(home, name, 'the unit the test acts on');
  assert.ok(intendedUnits(home).includes(name), `the unit ${name} is named in an attempt intent of the test's own store (positively the test home's)`);
}

// Stop one of the test home's own units by its exact name (and reset it if it failed).
export function stopOwnUnit(home, name) {
  assertActable(home, name);
  const stop = systemctl(['stop', '--', name], { timeoutMs: 60_000 });
  const after = unitShow(name, ['LoadState', 'ActiveState']);
  if (after?.LoadState === 'loaded' && after?.ActiveState === 'failed') systemctl(['reset-failed', '--', name]);
  return stop.status;
}

// Restart one of the test home's own units by its exact name, after the containment read.
export function restartOwnUnit(ctx, svc) {
  assertServiceContained(ctx, svc, 'before the test restarts its unit');
  assertActable(ctx.fx.home, svc.unit);
  const done = systemctl(['restart', '--', svc.unit], { timeoutMs: 60_000 });
  return done.status;
}

// ---- decoys (D4-T02; M313 (a)): created and removed by exact name only -------------------------

const DECOY = /^sdlcx-decoy-[0-9a-f]{12}\.service$/;
export const decoyName = () => `sdlcx-decoy-${randomBytes(6).toString('hex')}.service`;

function assertDecoyName(name, allowed) {
  assert.ok(allowed.includes(name), `the decoy ${name} is one this test named`);
  assert.ok(DECOY.test(name) || /^surety-[0-9a-f]{12}-env_[0-9A-HJKMNP-TV-Z]{26}-g1\.service$/.test(name), `the decoy ${name} has an exact decoy form`);
}

// Create a decoy under an exact name that does not yet exist: a sleep, with small limits.
export function createDecoy(name, allowed) {
  assertDecoyName(name, allowed);
  const before = unitShow(name, ['LoadState']);
  assert.equal(before?.LoadState, 'not-found', `the decoy name ${name} is not in use (a name that exists is refused)`);
  const done = spawnSync('systemd-run', ['--user', `--unit=${name}`, '--quiet', '--collect', '--property=MemoryMax=16M', '--property=TasksMax=2', '/usr/bin/sleep', '3600'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(done.status, 0, `the decoy ${name} is created (${done.stderr})`);
}

export function removeDecoy(name, allowed) {
  assertDecoyName(name, allowed);
  systemctl(['stop', '--', name], { timeoutMs: 60_000 });
  const after = unitShow(name, ['LoadState', 'ActiveState']);
  if (after?.LoadState === 'loaded' && after?.ActiveState === 'failed') systemctl(['reset-failed', '--', name]);
  return unitShow(name, ['LoadState'])?.LoadState ?? null;
}

// ---- the operator's guard (row M313; BS4 §4.1 rule 7; SEAM.md §257) ----------------------------

const listOf = (dir, prefix) => {
  try {
    return readdirSync(dir).filter((n) => n.startsWith(prefix)).map((n) => join(dir, n));
  } catch {
    return null;
  }
};

// Taken first thing in a file. `track(fx)` names a home whose units are the
// file's; `decoy(name)` names a decoy the file created; `root(dir)` a
// directory of the file's own under /tmp. `finish()` makes the after-check
// and returns what it found; `assertClean()` fails the file on any of it.
export function operatorGuard() {
  const state = managerState();
  assert.equal(state, 'running', `before the file: the user manager reports running (systemctl --user is-system-running: ${JSON.stringify(state)}); nothing is run otherwise (BS4 §4.1 rule 7)`);
  const units = listUnits();
  assert.ok(units !== null, 'before the file: the user units can be listed');
  const before = { units, tmp: listOf('/tmp', 'surety-') ?? [], shm: listOf('/dev/shm', 'surety') ?? [] };
  const homes = [];
  const decoys = [];
  const roots = [];
  const guard = {
    before,
    track(fx) {
      if (!homes.includes(fx.home)) homes.push(fx.home);
      if (fx.root && !roots.includes(fx.root)) roots.push(fx.root);
      return fx;
    },
    decoy(name) {
      decoys.push(name);
      return name;
    },
    root(dir) {
      roots.push(dir);
      return dir;
    },
    decoys,
    homes,
    finish() {
      const problems = [];
      const stopped = [];
      const after = managerState();
      if (after !== 'running') problems.push(`the user manager reports ${JSON.stringify(after)} after the file, not running`);
      const now = listUnits();
      if (now === null) problems.push('after the file the user units could not be listed: whether a unit was left is unknown');
      for (const home of homes) {
        const prefix = `surety-${homeHash(home)}-env_`;
        const left = (now ?? []).filter((u) => u.unit.startsWith(prefix));
        for (const u of left) {
          problems.push(`unit left: ${u.unit} (${u.load} ${u.active} ${u.sub})`);
          if (ownUnitPattern(home).test(u.unit) && intendedUnits(home).includes(u.unit)) {
            stopOwnUnit(home, u.unit);
            stopped.push(u.unit);
          }
        }
        for (const dir of cgroupsNamed(prefix)) problems.push(`cgroup left: ${dir}`);
        const envIds = (() => {
          try {
            return withStore(home, (db) => db.prepare('SELECT "id" FROM "environments"').all()).map((r) => r.id);
          } catch {
            return [];
          }
        })();
        const run = join(home, 'run');
        const walk = (dir) => {
          let names;
          try {
            names = readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of names) {
            const full = join(dir, e.name);
            if (envIds.some((id) => e.name.includes(id)) || e.name.startsWith(prefix)) problems.push(`socket or runtime directory left: ${full}`);
            if (e.isDirectory()) walk(full);
          }
        };
        walk(run);
      }
      for (const name of decoys) {
        const s = unitShow(name, ['LoadState']);
        if (s?.LoadState !== 'not-found') {
          problems.push(`decoy left: ${name} (${s?.LoadState ?? 'unread'})`);
          removeDecoy(name, decoys);
        }
      }
      const activeBefore = before.units.filter((u) => u.unit.endsWith('.service') && u.active === 'active' && !u.unit.startsWith('surety-') && !decoys.includes(u.unit));
      for (const u of activeBefore) {
        const s = (now ?? []).find((x) => x.unit === u.unit);
        if (s === undefined || s.active !== 'active') problems.push(`a unit outside the prefix changed state: ${u.unit} was ${u.active} ${u.sub}, now ${s ? `${s.active} ${s.sub}` : 'not loaded'}`);
      }
      const mine = (path) => roots.some((r) => path === r || path.startsWith(`${r}${sep}`));
      for (const [dir, prefix, key] of [['/tmp', 'surety-', 'tmp'], ['/dev/shm', 'surety', 'shm']]) {
        for (const path of listOf(dir, prefix) ?? []) if (!before[key].includes(path) && !mine(path)) problems.push(`file left: ${path}`);
      }
      return { problems, stopped };
    },
    assertClean() {
      const { problems, stopped } = guard.finish();
      assert.deepEqual(problems, [], `the file left something of its own or changed something of the operator's (M313; reported by exact name${stopped.length > 0 ? `; the test home's own units ${stopped.join(', ')} were then stopped by exact name` : ''})`);
    },
  };
  return guard;
}

// ---- processes and trees, read from the host ---------------------------------------------------

// {pid, start_time} of a host process (start_time: /proc/<pid>/stat field 22,
// an integer), or null when it is gone.
export function procInstance(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, start_time: Number(rest[19]) };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ESRCH') return null;
    throw err;
  }
}

export function ppidOf(pid) {
  const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((l) => l.startsWith('PPid:'));
  return Number(line?.slice(5).trim());
}

// The inode of the socket `pid` holds listening on 127.0.0.1:<port> in its
// own network namespace, read from the host (`/proc/<pid>/net/tcp` and
// `/proc/<pid>/fd`), or null when it holds none (or is gone).
export function listenerOf(pid, port) {
  let table;
  try {
    table = readFileSync(`/proc/${pid}/net/tcp`, 'utf8').split('\n').slice(1);
  } catch {
    return null;
  }
  const local = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  const inodes = table.map((l) => l.trim().split(/\s+/)).filter((f) => f[1] === local && f[3] === '0A').map((f) => f[9]);
  if (inodes.length === 0) return null;
  let fds;
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return null;
  }
  for (const fd of fds) {
    let link;
    try {
      link = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
    if (inode !== undefined && inodes.includes(inode)) return inode;
  }
  return null;
}

// Poll a host-read fact until `probe` answers (no engine tick), bounded.
export async function hostUntil(probe, { timeoutMs = 30_000, intervalMs = 25, what = 'the expected host state' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const got = probe();
    if (got !== undefined && got !== null && got !== false) return got;
    if (Date.now() > until) assert.fail(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const cmdlineOf = (pid) => readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((a, i, all) => !(a === '' && i === all.length - 1));
export const exeShaOf = (pid) => sha256(readFileSync(`/proc/${pid}/exe`));

// The canonical manifest of a tree, walked from the host following no link
// and opening no special file (SEAM.md §260): {entries: [[path, "file",
// mode class, size, sha256 hex]] sorted by path, odd: [paths that are no
// regular file or directory]}.
export function treeManifest(root) {
  const entries = [];
  const odd = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      const rel = relative(root, full).split(sep).join('/');
      if (st.isDirectory()) visit(full);
      else if (st.isFile()) entries.push([rel, 'file', st.mode & 0o111 ? '100755' : '100644', st.size, sha256(readFileSync(full))]);
      else odd.push(rel);
    }
  };
  visit(root);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { entries, odd };
}

// The digest of a canonical manifest (SEAM.md §260).
export const manifestDigest = (entries) => `sha256:${sha256(JSON.stringify(entries))}`;

export const appRoot = (pid) => `/proc/${pid}/root/surety/app`;

// ---- the deployable project on the host (SEAM.md §§256, 258) ----------------------------------

export const FIXTURE_SERVICE = readFileSync(new URL('./fixture-service.cjs', import.meta.url), 'utf8');
const TARGET_CHECK = readFileSync(new URL('./target-check.mjs', import.meta.url), 'utf8');
const LINK_CHECK = readFileSync(new URL('./link-check.mjs', import.meta.url), 'utf8');
export const RELEASE = 'go';
// The second release of a plan with `then` (section 258): the check ends only once the test writes it.
export const RELEASE_AGAIN = 'again';

// The post-deploy check program, beside the M3 check program in its
// directory (so the same read_paths reach it), with a shebang naming the
// test's node.
export function installTargetCheck(prog) {
  const path = join(prog.dir, 'target-check.mjs');
  writeFileSync(path, `#!${process.execPath}\n${TARGET_CHECK}`);
  chmodSync(path, 0o755);
  return path;
}

// The link-probing post-deploy check program (row M314; SEAM.md §268),
// beside the others in the check directory, with the test's node.
export function installLinkCheck(prog) {
  const path = join(prog.dir, 'link-check.mjs');
  writeFileSync(path, `#!${process.execPath}\n${LINK_CHECK}`);
  chmodSync(path, 0o755);
  return path;
}

// The link check's report (its one output line), from its result record.
export function linkReport(ctx, execution) {
  const result = withStore(ctx.fx.home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ? ORDER BY rowid DESC').get(execution.id));
  assert.ok(result, `the link check ${execution.id} has a result`);
  const text = outputText(ctx.fx.home, result);
  const line = text.split('\n').find((l) => l.startsWith('SURETY-LINK-REPORT '));
  assert.ok(line, `the link check wrote its report (output: ${JSON.stringify(text.slice(0, 400))})`);
  return { result, report: JSON.parse(line.slice('SURETY-LINK-REPORT '.length)) };
}

// The service_link_log records of an environment's executions (D4 §5.2;
// SEAM.md §268): kind service_link_log, with their parsed JSON-line entries.
export function serviceLinkLogs(home, project) {
  const rows = withStore(home, (db) => db.prepare(`SELECT * FROM "records" WHERE "kind" = 'service_link_log' AND "project" = ? ORDER BY rowid`).all(project));
  return rows.map((row) => ({
    row,
    entries: row.path === null ? [] : readFileSync(join(home, 'records', row.path), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)),
  }));
}

// The host's namespaces in the form the fixture service's guard reads.
export const hostNsValue = () => {
  const ns = hostNamespaces();
  return `${ns.pid},${ns.net},${ns.mnt}`;
};

// The configuration of a host environment (SEAM.md §§245, 258): the
// fixture service on a port free on the host, its guard's input, a mark.
export async function hostConfig(over = {}) {
  const mark = randomBytes(6).toString('hex');
  const port = await freePort();
  return configContent({ port, env: { SURETY_TEST_HOST_NS: hostNsValue(), MARK: mark }, ...over });
}

// A sandbox-lane engine with the real adapter, and a T1 project whose
// revision holds the fixture service and whose checks run in real `check`
// domains: acceptance (R1.1) and smoke run the M3 program (exit 0), and
// `behaves`, the required post_deploy_behavior check of the alpha_complete
// scope, runs the target-check program held at RELEASE. Built, nominated,
// its workspace checks recorded, the runner qualified by §181's fixture and
// the adapter by §248's (the qualification stand-in). `guard` tracks the
// engine's home. Returns {fx, prog, project, p, candidate, stage, envs: {}}.
// `behaves` picks the post-deploy check program: `target` (the default, the
// target-check program held at RELEASE) or `link` (the link-probing program
// of row M314, with --host-ns so its instrument steps run only when it reads
// its own containment). `behavesTimeout` sets the check's `timeout_s`.
export async function hostDeployable(t, guard, { engineConfig = {}, engineArgs = [], policy = {}, files = {}, entries, governed = {}, qualify = true, behaves = 'target', behavesTimeout = 300 } = {}) {
  const fx = realAdapterStarts(await sandboxEngine(t, { start: false, config: engineConfig }));
  guard.track(fx);
  await fx.start({ args: [...REAL_ADAPTER, ...engineArgs] });
  const prog = installCheckProgram(fx.root);
  const target = installTargetCheck(prog);
  const link = installLinkCheck(prog);
  const behavesCommand =
    behaves === 'link'
      ? ['link', '--hold', RELEASE, '--release-dir', prog.releaseDir, '--host-ns', hostNsValue()]
      : ['target', '--hold', RELEASE, '--release-dir', prog.releaseDir];
  const projectFiles = {
    [GOVERNED_FILE]: governedText({ protected_paths: ['.surety/checks/'], check_commands: { probe: { path: prog.program }, target: { path: target }, link: { path: link } }, runner_config: { direct: { read_paths: prog.readPaths } }, ...governed }),
    [defPath('acc')]: acceptance('acc', ['R1.1'], { command: ['probe', 'exit', '0'], timeout: 120 }),
    [defPath('smoke')]: smoke('smoke', { command: ['probe', 'exit', '0'], timeout: 120 }),
    [defPath('behaves')]: definitionText('behaves', { kind: 'post_deploy_behavior', command: behavesCommand, timeout_s: behavesTimeout, gate_kinds: ['alpha_complete'], requires: ['environment', 'artifact_digest'] }),
    'server.js': FIXTURE_SERVICE,
    ...files,
  };
  const p = await checkProject(fx, { files: projectFiles, entries, tier: 'T1' });
  if (Object.keys(policy).length > 0) await changePolicy(fx.engine, p.id, policy);
  await qualifyRunnerByFixture(fx.engine);
  const plan = await installIndexedPlan(fx.engine, p.id, { index: [{ key: 'R1', criteria: ['R1.1'] }], stages: [{ number: 1, goal: 'the first stage', implements: ['R1'] }] });
  const [stage] = plan.stages;
  fx.scripted.script(stage.work_item, [roleThat([permittedEdit()], { nominate: true })]);
  const build = await runToEnd(fx, p.id, stage.work_item, { timeoutMs: 300_000 });
  assert.deepEqual([build.outcome, build.reason_class], ['completed', 'none'], `the Builder's run was accepted (${build.reason_text})`);
  const [candidate] = await waitForCandidates(fx, p.id);
  await ticksUntil(fx, p.id, () => {
    const latest = {};
    for (const x of executionsOf(fx.home, candidate.id)) if (['acc', 'smoke'].includes(x.key)) latest[x.key] = x;
    return ['acc', 'smoke'].every((k) => latest[k]?.status === 'recorded' && latest[k]?.result) ? latest : undefined;
  }, { timeoutMs: 600_000, what: "the candidate's workspace checks to be recorded" });
  const qualification = qualify ? await qualifyByFixture(fx.engine) : null;
  return { fx, prog, project: p.id, p, candidate, stage, qualification, envs: {} };
}

// Configure environment `name` of the project for the host; returns {id, name, config, content}.
export async function hostEnvironment(ctx, name, over = {}) {
  const content = await hostConfig(over);
  const done = await configure(ctx.fx.engine, ctx.project, name, content);
  const env = { ...done.environment, name, config: done.config, content };
  ctx.envs[name] = env;
  return env;
}

// Ask for ticks of the project until `probe` answers, in real time.
export async function ticksUntil(fx, project, probe, { timeoutMs = 240_000, what = 'the expected state' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > until) throw new Error(`${what} was not reached within ${timeoutMs} ms`);
    await tick(fx.engine, project, { rounds: 1, timeoutMs: 180_000 });
    await sleep(200);
  }
}

// The environment's newest operation of `kind`.
export const newestOperation = (ctx, env, kind = 'deploy') => operationsOf(ctx.fx.home, ctx.project, kind).filter((o) => o.target?.environment === env.id).at(-1) ?? null;

// The post-deploy executions of the candidate registered for an environment.
export const postDeployOf = (ctx, env) =>
  withStore(ctx.fx.home, (db) =>
    db
      .prepare(`SELECT x.*, c."key" AS "key" FROM "check_executions" x JOIN "checks" c ON c."id" = x."check" WHERE x."environment" = ? ORDER BY x."execution_seq"`)
      .all(env.id)
      .map((x) => ({ ...x, trigger: json(x.trigger), deployment: json(x.deployment) })),
  ).filter((x) => x.trigger?.source === 'deployment_verification');

export const domainRowOf = (home, id) => {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(id));
  return row ? { ...row, reservation: json(row.reservation), launch_binding: json(row.launch_binding) } : null;
};

// The service domain of an attempt (D4 A.3: execution_domains.attempt).
export const serviceDomainOf = (home, attempt) => {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "attempt" = ?').get(attempt));
  return row ? { ...row, reservation: json(row.reservation), app_exit: json(row.app_exit) } : null;
};

// The service of an operation's newest attempt as the store records it:
// {env, op, attempt, unit, init, app, domain}.
export function serviceOf(ctx, env, op) {
  const attempts = attemptsOf(ctx.fx.home, op.id);
  const attempt = attempts.at(-1);
  assert.ok(attempt, `the operation ${op.id} has an attempt`);
  const intent = attemptIntent(ctx.fx.home, attempt.id);
  const unit = intent?.create_units?.[0];
  return { env: env.id, op, attempt, unit, init: attempt.init_instance, app: attempt.app_instance, domain: serviceDomainOf(ctx.fx.home, attempt.id) };
}

// The test's half of E64's rule for a service (SEAM.md §§141, 257): the unit
// carries this home's prefix for its environment; the manager names its
// cgroup, the unit's own; the application's pid (the same process, by its
// start time) is in that cgroup's tree and listed in its cgroup.procs; and
// it is in none of the host's pid, network or mount namespaces.
export function assertServiceContained(ctx, svc, what = 'the service') {
  const { home } = ctx.fx;
  assertOwnUnit(home, svc.unit, `${what}: its unit`);
  assert.ok(svc.unit.startsWith(unitPrefix(home, svc.env)), `${what}: ${svc.unit} carries its environment's prefix ${unitPrefix(home, svc.env)}`);
  const show = unitShow(svc.unit, ['LoadState', 'ControlGroup']);
  assert.equal(show?.LoadState, 'loaded', `${what}: host-read, the manager has ${svc.unit} loaded`);
  const unitCg = join(CGROUP_ROOT, show.ControlGroup);
  assert.ok(unitCg.endsWith(`/${svc.unit}`), `${what}: host-read, the unit's ControlGroup is its own (${unitCg})`);
  const pid = svc.app?.pid;
  assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid, `${what}: the application's recorded pid is a host pid (${pid})`);
  const now = procInstance(pid);
  assert.ok(now !== null, `${what}: host-read, pid ${pid} exists`);
  assert.equal(now.start_time, svc.app.start_time, `${what}: host-read, pid ${pid} is the recorded application (its start time)`);
  const pidCg = cgroupOfPid(pid);
  assert.ok(pidCg === unitCg || pidCg.startsWith(`${unitCg}/`), `${what}: host-read, pid ${pid} is in the unit's cgroup tree (${pidCg})`);
  assert.ok(procsOf(pidCg).includes(pid), `${what}: host-read, pid ${pid} is listed in ${pidCg}/cgroup.procs`);
  const host = hostNamespaces();
  const own = namespacesOf(pid);
  for (const kind of ['pid', 'net', 'mnt']) assert.ok(own[kind] !== null && own[kind] !== host[kind], `${what}: host-read, pid ${pid} is not in the host's ${kind} namespace (${own[kind]})`);
  return { unitCg, pidCg };
}

// The held post-deploy check of an environment's newest round: the
// execution running in its `check` domain with the post-deploy check program
// (`program`, the target-check program by default, or the link check)
// holding at RELEASE as a member of the domain's cgroup. {execution, domain,
// member} or undefined.
export function heldCheck(ctx, env, { program = 'target-check.mjs' } = {}) {
  const x = postDeployOf(ctx, env).at(-1);
  if (!x || x.status !== 'running' || !x.domain) return undefined;
  const domain = domainRowOf(ctx.fx.home, x.domain);
  if (!domain?.cgroup_path) return undefined;
  let pids;
  try {
    pids = procsOf(domain.cgroup_path);
  } catch {
    return undefined;
  }
  for (const pid of pids) {
    const p = hostProcess(pid);
    if (p && p.cmdline.some((a) => a.endsWith(`/${program}`)) && p.cmdline.includes('--hold')) return { execution: x, domain, member: p };
  }
  return undefined;
}

// E64's rule for the link check (SEAM.md §§141, 257, 268): the check's own
// process is a member of its check domain's cgroup, and in none of the
// host's pid, network or mount namespaces. The test reads this before it
// writes the link check's plan (its half of the two-half rule).
export function assertCheckContained(ctx, held, what = 'the link check') {
  const pid = held.member?.pid;
  assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid, `${what}: its host pid (${pid})`);
  const cg = cgroupOfPid(pid);
  assert.ok(cg === held.domain.cgroup_path || cg.startsWith(`${held.domain.cgroup_path}/`), `${what}: host-read, pid ${pid} is in the check domain's cgroup (${cg})`);
  assert.ok(procsOf(held.domain.cgroup_path).includes(pid), `${what}: host-read, pid ${pid} is listed in the domain's cgroup.procs`);
  const host = hostNamespaces();
  const own = namespacesOf(pid);
  for (const kind of ['pid', 'net', 'mnt']) assert.ok(own[kind] !== null && own[kind] !== host[kind], `${what}: host-read, pid ${pid} is not in the host's ${kind} namespace`);
  return cg;
}

// Release the link check with its plan ({steps, exit}), after reading the
// check's containment from the host (the test's half of E64's rule).
export function releaseLink(ctx, held, plan) {
  assertCheckContained(ctx, held);
  writeFileSync(join(ctx.prog.releaseDir, RELEASE), JSON.stringify(plan));
}

// A request with a longer idle bound than the harness's 15 s (a request
// that seals a large artifact answers only when the sealing is done).
export function requestLong(engine, method, path, body, timeoutMs = 600_000) {
  const headers = { host: engine.authority, connection: 'close', 'x-surety-token': engine.token() };
  return httpRequest({ port: engine.port, method, path, headers, body, timeoutMs });
}

// Request the deployment of the candidate to `env` and ask for ticks until
// the round's post-deploy check holds. Returns {request, op, held, svc}.
export async function deployHeld(ctx, env, { timeoutMs = 300_000 } = {}) {
  const { fx, project, candidate } = ctx;
  const request = await deploy(fx.engine, project, candidate.id, env.name);
  const held = await ticksUntil(fx, project, () => heldCheck(ctx, env), { timeoutMs, what: `the round's post-deploy check of ${env.name} to hold` });
  const op = newestOperation(ctx, env);
  return { request, op, held, svc: serviceOf(ctx, env, op) };
}

// Release the held check with a plan ({get: [paths], exit}). An act among
// the paths is released only after the containment read of the service.
export function releaseCheck(ctx, svc, plan = { get: ['/hello'], exit: 0 }) {
  if ((plan.get ?? []).some((p) => p.startsWith('/act/'))) assertServiceContained(ctx, svc, 'before the test releases an act');
  writeFileSync(join(ctx.prog.releaseDir, RELEASE), JSON.stringify(plan));
}

// The second release of a held check whose plan named `then: RELEASE_AGAIN`. It names no act.
export function releaseAgain(ctx, plan = { get: [], exit: 0 }) {
  assert.ok(!(plan.get ?? []).some((p) => p.startsWith('/act/')), 'the second release names no act');
  writeFileSync(join(ctx.prog.releaseDir, RELEASE_AGAIN), JSON.stringify(plan));
}

// Ask for ticks until the operation's newest round has its verification
// row; then take the release file away for the next round. Returns {round, row}.
export async function verificationOf(ctx, op, { timeoutMs = 300_000 } = {}) {
  const found = await ticksUntil(
    ctx.fx,
    ctx.project,
    () => {
      const round = roundsOf(ctx.fx.home, op.id).at(-1);
      const row = round ? verificationsOf(ctx.fx.home, round.id).at(-1) : undefined;
      return row ? { round, row } : undefined;
    },
    { timeoutMs, what: `the verification row of ${op.id}` },
  );
  rmSync(join(ctx.prog.releaseDir, RELEASE), { force: true });
  rmSync(join(ctx.prog.releaseDir, RELEASE_AGAIN), { force: true });
  return found;
}

// Ask for ticks until the operation's newest round has its verification
// row, releasing its post-deploy check with a benign plan (no act) whenever
// it holds. For a round whose reads may end it before or without its check.
export async function settleRound(ctx, env, op, { plan = { get: ['/hello'], exit: 0 }, timeoutMs = 300_000 } = {}) {
  assert.ok(!(plan.get ?? []).some((p) => p.startsWith('/act/')), 'settleRound releases no act');
  const file = join(ctx.prog.releaseDir, RELEASE);
  const found = await ticksUntil(
    ctx.fx,
    ctx.project,
    () => {
      const round = roundsOf(ctx.fx.home, op.id).at(-1);
      const row = round ? verificationsOf(ctx.fx.home, round.id).at(-1) : undefined;
      if (row) return { round, row };
      if (heldCheck(ctx, env) && !existsSync(file)) writeFileSync(file, JSON.stringify(plan));
      return undefined;
    },
    { timeoutMs, what: `the verification row of ${op.id}` },
  );
  rmSync(file, { force: true });
  return found;
}

// A one-shot fault of the real adapter for an environment (SEAM.md §262):
// `init_report_altered`, `identity_start_time`, `identity_proc_unreadable` or
// `identity_listing_failed` (SEAM.md §272).
export async function armDeployFault(ctx, env, fault) {
  const res = await ctx.fx.engine.post('/v1/harness/deploy/faults', { environment: env.id, fault });
  assert.equal(res.status, 200, `the fault ${fault} is armed for ${env.name} (SEAM.md §262) (body: ${res.text})`);
}

// The held check's report of what the service answered (its output record).
export function targetReport(ctx, execution) {
  const result = withStore(ctx.fx.home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ? ORDER BY rowid DESC').get(execution.id));
  assert.ok(result, `the post-deploy check ${execution.id} has a result`);
  const text = outputText(ctx.fx.home, result);
  const line = text.split('\n').find((l) => l.startsWith('SURETY-TARGET-REPORT '));
  assert.ok(line, `the target-check program wrote its report (output: ${JSON.stringify(text.slice(0, 400))})`);
  return { result, report: JSON.parse(line.slice('SURETY-TARGET-REPORT '.length)) };
}

// The operator's teardown of `env`, and ticks until it is finalized. Returns the operation.
export async function teardownOnHost(ctx, env, { timeoutMs = 240_000 } = {}) {
  const asked = await teardown(ctx.fx.engine, ctx.project, env.name);
  assert.ok(asked.status >= 200 && asked.status < 300, `the operator's teardown of ${env.name} is accepted (→ ${asked.status} ${asked.text})`);
  return ticksUntil(ctx.fx, ctx.project, () => operationsOf(ctx.fx.home, ctx.project, 'teardown').filter((o) => o.target?.environment === env.id && o.finalized_at !== null).at(-1), { timeoutMs, what: `the teardown of ${env.name} to be finalized` });
}

// After a case: the environment torn down by the engine when it can be; a
// unit the engine could not tear down (its lease held by an ambiguous
// attempt) stopped by the test by its exact name. Returns what was left.
export async function endEnvironment(ctx, env, { engineTeardown = true } = {}) {
  if (engineTeardown) {
    try {
      await teardownOnHost(ctx, env, { timeoutMs: 120_000 });
    } catch {
      // the lease is held (an ambiguous attempt) or the teardown did not end: the test's own stop below
    }
  }
  const prefix = unitPrefix(ctx.fx.home, env.id);
  const left = (listUnits() ?? []).filter((u) => u.unit.startsWith(prefix)).map((u) => u.unit);
  for (const name of left) if (intendedUnits(ctx.fx.home).includes(name)) stopOwnUnit(ctx.fx.home, name);
  return left;
}

// A case's environment ended whatever happened (slice 26): a post-deploy
// check still held is let go first (a benign plan, no act, exit 1), so a
// failed case leaves no check holding the one check capacity kept free for
// the next case's round (as M311's heldCase does); the release file is taken
// away after.
export async function endCase(ctx, env) {
  const file = join(ctx.prog.releaseDir, RELEASE);
  const wrote = !existsSync(file);
  if (wrote) writeFileSync(file, JSON.stringify({ get: [], exit: 1 }));
  try {
    return await endEnvironment(ctx, env);
  } finally {
    if (wrote) rmSync(file, { force: true });
  }
}

// Every entry under $SURETY_HOME/artifacts/ that lies within no recorded artifact's path (SEAM.md §260).
// Compared by real path (SEAM.md §264): a row recorded under one spelling of
// the home (a symbolic link to it, or its real path) records the same
// directory under the other.
// A path that no longer exists is resolved through its nearest existing ancestor.
const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    const up = dirname(p);
    return up === p ? p : join(realOr(up), basename(p));
  }
};
export function unrecordedUnderArtifacts(home) {
  if (!existsSync(join(home, 'artifacts'))) return [];
  const root = realpathSync(join(home, 'artifacts'));
  const paths = withStore(home, (db) => db.prepare('SELECT "path" FROM "artifacts"').all()).map((r) => realOr(r.path));
  const inside = (p) => paths.some((a) => p === a || p.startsWith(`${a}${sep}`));
  const covers = (p) => paths.some((a) => a.startsWith(`${p}${sep}`));
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (inside(full)) continue;
      if (covers(full) && lstatSync(full).isDirectory()) visit(full);
      else out.push(full);
    }
  };
  visit(root);
  return out;
}

export { RUNTIME };
