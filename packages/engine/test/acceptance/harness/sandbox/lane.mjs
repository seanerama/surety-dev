// The sandbox lane's fixture (M2 slice 11; M2 plan §2.1; BS §8; SEAM.md
// §§122 to 131): the scripted engine of M1 started with the host checks
// running (`--harness-host-checks run`), from an environment that reaches
// the user manager, so that the scripted role runs inside the real sandbox
// under the real cgroup boundary and the scripted execution boundary is not
// used. What the tests read of the boundary is in cgroup.mjs and procs.mjs;
// what they read of the store is here.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { waitFor } from '../engine.mjs';
import { eventsAbout } from '../invariants.mjs';
import { addProject, addWork, run as runRow, scriptedEngine, tick, waitForRun } from '../runs.mjs';
import { script } from '../scripted.mjs';
import { withStore } from '../store.mjs';
import { cgroupOfPid, endScopeLeftovers, procsOf, scopePathOf, scopeUnit, scopeUnitPrefix, subtreeControl } from './cgroup.mjs';
import { members, roleMembers } from './procs.mjs';

// Ticks only when a test asks; short real-time grace periods, a little
// longer than the kernel lane's because TERM reaches the role through the
// domain init (SEAM.md §122).
export const SANDBOX_CONFIG = Object.freeze({ tick_interval: 600, terminate_grace: 3, kill_grace: 2 });

// The switch that makes an engine a sandbox-lane engine (SEAM.md §122).
export const HOST_CHECKS_RUN = Object.freeze(['--harness-host-checks', 'run']);

// The two variables through which the engine reaches the user manager
// (SEAM.md §122). A test that lacks them cannot run the lane: that is a
// failure of the lane, never a skip.
export function sandboxEnv() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  assert.ok(runtime && existsSync(runtime), `XDG_RUNTIME_DIR names the login session's runtime directory (it is ${JSON.stringify(runtime)}): the sandbox lane needs a login session of uid 1000 with the user manager running`);
  const bus = process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${join(runtime, 'bus')}`;
  return { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: bus };
}

// A home, a scripted directory and (unless start is false) a running
// sandbox-lane engine. Every start of the fixture carries the switch.
// `env` adds to the constructed environment of every engine; a start may
// take `env` of its own (M110 (b) unsets the manager's variables).
export async function sandboxEngine(t, { config = {}, barriers = [], until = 'full', start = true, env = {} } = {}) {
  const fx = await scriptedEngine(t, { config: { ...SANDBOX_CONFIG, ...config }, start: false, env: { ...sandboxEnv(), ...env } });
  fx.lane = 'sandbox';
  // Nothing of this fixture's engines outlives its test: a launcher left
  // waiting at a barrier by a case that failed is ended with its scope. The
  // prefix is taken now, while the home is there to resolve.
  const prefix = scopeUnitPrefix(fx.home);
  t.after(() => {
    endScopeLeftovers(prefix);
  });
  const plainStart = fx.start;
  fx.start = (opts = {}) => plainStart({ ...opts, args: [...HOST_CHECKS_RUN, ...(opts.args ?? [])] });
  if (start) await fx.start({ barriers, until });
  return fx;
}

// ---- the store's boundary rows ------------------------------------------------------------

const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

export function domainOf(home, runId) {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "run" = ? ORDER BY "id"').get(runId));
  return row ? { ...row, launch_binding: json(row.launch_binding), resource_events: json(row.resource_events) } : null;
}

export const domainRow = (home, id) => {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(id));
  return row ? { ...row, launch_binding: json(row.launch_binding), resource_events: json(row.resource_events) } : null;
};

export const ownershipOf = (home, domainId) => withStore(home, (db) => db.prepare('SELECT * FROM "process_ownership" WHERE "domain" = ?').get(domainId));

export const incarnationRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "engine_incarnations" WHERE "id" = ?').get(id));

export const incarnationsInOrder = (home) => withStore(home, (db) => db.prepare('SELECT * FROM "engine_incarnations" ORDER BY rowid').all());

// The terminal status observation of an invocation, with its exit class
// and evidence (SEAM.md §126), or null while there is none.
export function terminalObservation(home, invocation) {
  const row = withStore(home, (db) =>
    db.prepare(`SELECT * FROM "invocation_status_observations" WHERE "invocation" = ? AND "status" IN ('ended', 'unknown') ORDER BY "seq" DESC LIMIT 1`).get(invocation),
  );
  return row ? { ...row, exit_evidence: json(row.exit_evidence) } : null;
}

export const receiptOf = (home, runId) => withStore(home, (db) => db.prepare('SELECT * FROM "invocation_receipts" WHERE "run" = ?').get(runId));

export const eventsOf = (home, key, id, type) => withStore(home, (db) => eventsAbout(db, key, id, type));

// The seq of the first event of a type about a subject, or null.
export const firstSeq = (home, key, id, type) => eventsOf(home, key, id, type)[0]?.seq ?? null;

export const waitForEvent = (home, key, id, type, { count = 1, timeoutMs = 20_000 } = {}) =>
  waitFor(
    () => {
      const found = eventsOf(home, key, id, type);
      return found.length >= count ? found : undefined;
    },
    { timeoutMs, what: `${count} ${type} event(s) about ${key} ${id}` },
  );

export function updateDomain(home, id, fields) {
  const sets = Object.keys(fields)
    .map((k) => `"${k}" = ?`)
    .join(', ');
  withStore(home, (db) => db.prepare(`UPDATE "execution_domains" SET ${sets} WHERE "id" = ?`).run(...Object.values(fields), id), { readonly: false });
}

// ---- the engine's scope --------------------------------------------------------------------

// The running engine's incarnation scope as the store, the manager and the
// cgroup files show it (SEAM.md §124): {incarnation, unit, recorded, path}.
export async function scopeOf(fx) {
  const info = await fx.engine.engineInfo();
  const row = incarnationRow(fx.home, info.incarnation);
  const unit = scopeUnit(fx.home, info.incarnation);
  return { incarnation: info.incarnation, unit, recorded: row?.scope_cgroup ?? null, path: scopePathOf(unit), info };
}

// The engine runs in its scope's supervisor leaf (SEAM.md §124): the
// recorded path is the manager's path for the unit, the engine's own pid is
// in <scope>/supervisor/cgroup.procs, the scope delegates memory and pids.
export async function assertEngineInScope(fx) {
  const scope = await scopeOf(fx);
  assert.ok(scope.path, `the user manager lists the scope ${scope.unit} with a control group`);
  assert.equal(scope.recorded, scope.path, `engine_incarnations.scope_cgroup records the scope's cgroup path as the manager reports it`);
  const supervisor = join(scope.path, 'supervisor');
  assert.ok(procsOf(supervisor).includes(fx.engine.pid), `the engine's pid ${fx.engine.pid} is in ${supervisor}/cgroup.procs (it holds ${procsOf(supervisor).join(', ') || 'nothing'})`);
  assert.equal(cgroupOfPid(fx.engine.pid), supervisor, 'the process the test spawned is the one in the supervisor leaf: the engine enters its scope in place');
  const enabled = subtreeControl(scope.path);
  for (const c of ['memory', 'pids']) assert.ok(enabled.includes(c), `the scope's cgroup.subtree_control holds ${c} (it holds ${enabled.join(' ') || 'nothing'})`);
  return { ...scope, supervisor };
}

// ---- the host section of GET /v1/engine (SEAM.md §123) ----------------------------------

export const HOST_CHECK_IDS = Array.from({ length: 13 }, (_, i) => `H${i + 1}`);

export function hostSection(info) {
  const host = info.host_qualification;
  assert.ok(host && typeof host === 'object', `GET /v1/engine has host_qualification (keys: ${Object.keys(info).join(', ')})`);
  assert.ok(Array.isArray(host.checks), 'host_qualification.checks is a list');
  assert.deepEqual(
    host.checks.map((c) => c.id),
    HOST_CHECK_IDS,
    'the thirteen checks, H1 to H13, in order',
  );
  for (const c of host.checks) assert.ok(['passed', 'failed', 'not_exercised'].includes(c.result), `check ${c.id} has a result (${JSON.stringify(c.result)})`);
  return host;
}

export const checkOf = (host, id) => {
  const c = host.checks.find((x) => x.id === id);
  assert.ok(c, `host_qualification lists ${id}`);
  return c;
};

// ---- a role in the sandbox ---------------------------------------------------------------

// Dispatch one item and wait until its role holds at `gate` inside the
// sandbox: returns the run, its domain row, the scripted launch entry (pids
// as the sandbox numbers them) and the host's view of the role's process.
// `after` gives the steps the role takes once the hold is released (none by
// default: the role then exits 0 without a result).
export async function roleHolding(fx, project, item, { name = 'gate', before = [], after = [], on_term = 'exit', heartbeat_ms } = {}) {
  const held = script.hold(name, { before, on_term, heartbeat_ms });
  fx.scripted.script(item, [{ ...held, steps: [...held.steps, ...after] }]);
  await tick(fx.engine, project);
  const launch = await fx.scripted.waitForHolding({ work_item: item }, name);
  const run = await waitForRun(fx.home, item, { state: 'executing' });
  const domain = domainOf(fx.home, run.id);
  const member = await roleProcess(fx, domain, launch);
  return { run, domain, launch, member };
}

// The host process of a scripted launch: a member of the domain's cgroup
// carrying the invocation marker whose pid in the sandbox is the one the
// role logged (SEAM.md §125).
export async function roleProcess(fx, domain, launch) {
  return waitFor(
    () => {
      try {
        return roleMembers(domain.cgroup_path, launch.invocation).find((p) => p.innerPid === launch.pid);
      } catch {
        return undefined;
      }
    },
    { timeoutMs: 10_000, what: `the host process of the role (invocation ${launch.invocation}, pid ${launch.pid} in its namespace) in ${domain.cgroup_path}` },
  );
}

export const roleAlive = (domain, launch) => {
  try {
    return roleMembers(domain.cgroup_path, launch.invocation).some((p) => p.innerPid === launch.pid);
  } catch {
    return false;
  }
};

// Members of a domain other than the role program's processes: the launcher
// or the domain init (engine code), by command line.
export const engineMembers = (dir, program = 'child.mjs') => members(dir).filter((p) => !p.cmdline.some((a) => a.endsWith(program)));

// A fixture project with a verification item and the scripted role holding.
export async function projectWithRoleHolding(fx, opts = {}) {
  const project = (await addProject(fx)).id;
  const item = await addWork(fx.engine, project, 'verification');
  const held = await roleHolding(fx, project, item, opts);
  return { project, item, ...held };
}

// ---- the file barrier of the start (SEAM.md §128, scope.before_create) ----------------------

const releaseDir = (home) => join(home, 'harness-release');
export const waitScopeBarrier = (home, { timeoutMs = 20_000 } = {}) =>
  waitFor(() => (existsSync(join(releaseDir(home), 'scope.before_create.waiting')) ? true : undefined), { timeoutMs, what: 'the engine to wait at scope.before_create' });
export function releaseScopeBarrier(home) {
  mkdirSync(releaseDir(home), { recursive: true });
  writeFileSync(join(releaseDir(home), 'scope.before_create'), '');
}

export { runRow };

// ---- the optional observer (D2 §3.9, A.3; E57; objection 006) ------------------------------

// The observer's evidence envelopes in the store: `qualification_evidence`
// records whose bytes are, or hold under `observer`, an object with D2 A.3's
// `collector_version`. From slice 12 a qualified host and every validated
// mount plan write `qualification_evidence` records that are not envelopes
// (SEAM.md §§133, 138), so the kind alone says nothing. A record whose bytes
// cannot be read or parsed is not shown to be no envelope: it fails the case.
export function observerEnvelopes(home) {
  const rows = withStore(home, (db) => db.prepare(`SELECT * FROM "records" WHERE "kind" = 'qualification_evidence' ORDER BY rowid`).all());
  const found = [];
  for (const row of rows) {
    assert.ok(row.path !== null, `qualification_evidence record ${row.id} has its bytes (path null): what it holds is unknown`);
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(home, 'records', row.path), 'utf8'));
    } catch (err) {
      assert.fail(`qualification_evidence record ${row.id} cannot be read as JSON (${err.code ?? err.message}): what it holds is unknown`);
    }
    const isEnvelope = (v) => v !== null && typeof v === 'object' && 'collector_version' in v;
    if (isEnvelope(doc) || isEnvelope(doc?.observer) || (Array.isArray(doc?.observer) && doc.observer.some(isEnvelope))) found.push(row.id);
  }
  return { records: rows.length, envelopes: found };
}
