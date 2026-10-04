// Host-side reads of the execution boundary (M2 slice 11, rows M110 to
// M118; D2 §§3.1 to 3.4; SEAM.md §§124, 125, 128). The tests read the
// delegated subtree's files directly, at the path the store records, and
// the user manager's view of the engine's scope through `systemctl --user`.
// Nothing here changes a cgroup the engine owns, except where a case says
// it does (making a file unreadable, removing a directory the engine has
// left quarantined), and then the case says so.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { waitFor } from '../engine.mjs';
import { signalPid, signallable } from '../proc.mjs';

export const CGROUP_ROOT = '/sys/fs/cgroup';

// The scope unit name (SEAM.md §124): `surety-<hash>-<incarnation>.scope`,
// <hash> the first 16 hex characters of the SHA-256 of the engine home's
// resolved path.
export const homeHash = (home) => createHash('sha256').update(realpathSync(home)).digest('hex').slice(0, 16);
export const scopeUnit = (home, incarnation) => `surety-${homeHash(home)}-${incarnation}.scope`;
export const scopeUnitPrefix = (home) => `surety-${homeHash(home)}-`;

// The user manager, as the tests reach it: the same login session the
// engine is started from.
function systemctl(args, { allowFailure = false } = {}) {
  const done = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 20_000 });
  if (done.status !== 0 && !allowFailure) throw new Error(`systemctl --user ${args.join(' ')} → ${done.status}: ${done.stderr}`);
  return done;
}

// Every scope unit the user manager lists whose name starts with `prefix`
// (`surety-<hash>-` for one home; `surety-` for every engine), with its
// state. `--all` so that a unit that is stopping is still seen.
export function listScopes(prefix = 'surety-') {
  const done = systemctl(['list-units', '--type=scope', '--all', '--no-legend', '--plain', '--no-pager']);
  return done.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[0] && cols[0].startsWith(prefix))
    .map((cols) => ({ unit: cols[0], load: cols[1], active: cols[2], sub: cols[3] }));
}

// The cgroup path of a scope unit as the manager reports it: an absolute
// path under /sys/fs/cgroup, or null when the manager does not know the unit.
export function scopePathOf(unit) {
  const done = systemctl(['show', '-p', 'ControlGroup', '--value', unit], { allowFailure: true });
  const value = done.stdout.trim();
  return done.status === 0 && value !== '' ? join(CGROUP_ROOT, value) : null;
}

// The user manager is reachable from this process (the tests' own
// precondition for the sandbox lane; H3 is the engine's check).
export function assertUserManagerReachable() {
  const done = systemctl(['is-system-running'], { allowFailure: true });
  assert.ok(['running', 'degraded'].includes(done.stdout.trim()), `the user manager answers from this session (systemctl --user is-system-running: ${done.stdout.trim() || done.stderr.trim()})`);
}

// A real daemon re-exec of the user manager (row M115 (h); plan question 6:
// a real stop is not made).
export function daemonReexec() {
  systemctl(['daemon-reexec']);
}

// ---- cgroup files ------------------------------------------------------------------

// `cgroup.events` as {populated, frozen}; throws with the error code when
// the file cannot be read (ENOENT when the directory is gone, EACCES when a
// case made it unreadable).
export function readEvents(dir) {
  const text = readFileSync(join(dir, 'cgroup.events'), 'utf8');
  const out = {};
  for (const line of text.split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    if (key) out[key] = Number(value);
  }
  return out;
}

export const populated = (dir) => readEvents(dir).populated;

export const cgroupExists = (dir) => existsSync(join(dir, 'cgroup.events'));

// The host pids in `cgroup.procs`, as integers.
export function procsOf(dir) {
  return readFileSync(join(dir, 'cgroup.procs'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(Number);
}

export const subtreeControl = (dir) => readFileSync(join(dir, 'cgroup.subtree_control'), 'utf8').trim().split(/\s+/).filter(Boolean);
export const controllers = (dir) => readFileSync(join(dir, 'cgroup.controllers'), 'utf8').trim().split(/\s+/).filter(Boolean);

// The cgroup of a host process, as an absolute path under /sys/fs/cgroup
// (the test runs in the root cgroup namespace, so this is the full path).
export function cgroupOfPid(pid) {
  const text = readFileSync(`/proc/${pid}/cgroup`, 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('0::'));
  if (!line) throw new Error(`no cgroup v2 line for pid ${pid}: ${text}`);
  return join(CGROUP_ROOT, line.slice(3).trim());
}

// ---- what the tests change in the cgroup tree, and where they may ---------------------
//
// A test changes cgroup files only inside a scope that is a test engine's
// (`surety-<16 hex>-inc_<ULID>.scope`) or a sentinel's of the tests' own
// (`surety-test-sentinel-<8 hex>.scope`), never anywhere else. The paths
// come from the store of the engine under test, and an engine that recorded
// a wrong one (the user's `app.slice`, the manager's own cgroup) must not
// turn a test's chmod, rmdir or kill into damage to the user's session:
// the same rule as the guard of `signal_all` (SEAM.md §127, "The guard";
// §128). Each function below refuses a path outside such a scope.
const ENGINE_SCOPE = /^surety-[0-9a-f]{16}-inc_[0-9A-HJKMNP-TV-Z]{26}\.scope$/;
const SENTINEL_SCOPE = /^surety-test-sentinel-[0-9a-f]{8}\.scope$/;
const isTestScope = (segment) => ENGINE_SCOPE.test(segment) || SENTINEL_SCOPE.test(segment);

// Where `dir` stands relative to a test scope: 'inside' (strictly below
// one), 'scope' (it is one), or null (anywhere else: refused).
export function testScopePosition(dir) {
  if (typeof dir !== 'string' || !dir.startsWith(`${CGROUP_ROOT}/`) || dir.includes('/../') || dir.endsWith('/..')) return null;
  const segments = dir.slice(CGROUP_ROOT.length + 1).split('/').filter(Boolean);
  const at = segments.findIndex(isTestScope);
  if (at < 0) return null;
  return at === segments.length - 1 ? 'scope' : 'inside';
}

function assertInsideTestScope(dir, what, { orScope = false } = {}) {
  const position = testScopePosition(dir);
  if (position === 'inside' || (orScope && position === 'scope')) return;
  throw new Error(`refusing to ${what} ${JSON.stringify(dir)}: the tests change cgroups only inside a test engine's scope or a test sentinel's (SEAM.md §128)`);
}

// A domain's cgroup files a case makes unreadable or unwritable, and restores.
export function makeUnreadable(dir, file = 'cgroup.events') {
  assertInsideTestScope(dir, 'chmod a file of');
  chmodSync(join(dir, file), 0o000);
}
export function restoreReadable(dir, file = 'cgroup.events') {
  assertInsideTestScope(dir, 'chmod a file of');
  chmodSync(join(dir, file), file === 'cgroup.kill' ? 0o200 : 0o644);
}

// Remove a cgroup directory the engine left (a quarantined domain the case
// replaces); fails unless it is empty.
export function removeCgroup(dir) {
  assertInsideTestScope(dir, 'remove');
  rmdirSync(dir);
}

// End every process of one cgroup of a test scope, from the test's side
// (a case that needs a domain emptied while its engine is dead).
export function killCgroup(dir) {
  assertInsideTestScope(dir, 'kill the members of');
  writeFileSync(join(dir, 'cgroup.kill'), '1');
}

// What a fixture's engines left in their scopes when its test is over: a
// launcher waiting at a barrier outlives its engine (SEAM.md §125), and a
// case that fails before it releases the launcher would leave it, and its
// scope, behind. Every member of every child cgroup of every scope whose
// unit name starts with `prefix` (one home's: `scopeUnitPrefix(home)`) is
// ended, by `cgroup.kill`, or one by one where a case left that file
// unwritable. Confined like every other change here: only inside a test
// engine's scope. Returns the directories it emptied. Never throws.
export function endScopeLeftovers(prefix) {
  const ended = [];
  if (!/^surety-[0-9a-f]{16}-$/.test(prefix)) return ended;
  let scopes = [];
  try {
    scopes = listScopes(prefix);
  } catch {
    return ended; // no user manager to ask: nothing of this lane can be running under it
  }
  for (const { unit } of scopes) {
    const scope = scopePathOf(unit);
    if (scope === null || testScopePosition(scope) !== 'scope') continue;
    let children = [];
    try {
      children = childCgroups(scope);
    } catch {
      continue; // gone meanwhile
    }
    for (const child of children) {
      const dir = join(scope, child);
      try {
        const pids = procsOf(dir);
        if (pids.length === 0) continue;
        try {
          killCgroup(dir);
        } catch {
          if (testScopePosition(dir) !== 'inside') continue;
          // One by one, and only what may be signalled at all: never 0 (the
          // test's own process group), 1, a negative number, or the test
          // itself, whatever cgroup.procs held (harness/proc.mjs).
          for (const pid of pids) signalPid(pid, 'SIGKILL');
        }
        ended.push(dir);
      } catch {
        // gone meanwhile
      }
    }
  }
  return ended;
}

// Write a pid into a cgroup's `cgroup.procs` from the test's side: the
// kernel refuses it unless the test may migrate the process (same uid,
// write access to the destination and the common ancestor).
export function moveIntoCgroup(pid, dir) {
  assertInsideTestScope(dir, 'move a process into');
  // A 0 written into cgroup.procs moves the writer itself.
  if (!signallable(pid)) throw new Error(`refusing to move pid ${JSON.stringify(pid)}: not a process the tests may act on (harness/proc.mjs)`);
  const done = spawnSync('sh', ['-c', 'echo "$1" > "$2"', 'sh', String(pid), join(dir, 'cgroup.procs')], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`writing pid ${pid} into ${dir}/cgroup.procs failed: ${done.stderr.trim()}`);
}

// One key of a flat-keyed cgroup file (`memory.events` `oom_kill`,
// `pids.events` `max`), as a number; throws when it cannot be read.
export function counterOf(dir, file, key) {
  const line = readFileSync(join(dir, file), 'utf8').split('\n').find((l) => l.trim().split(/\s+/)[0] === key);
  if (line === undefined) throw new Error(`${dir}/${file} has no ${key}`);
  return Number(line.trim().split(/\s+/)[1]);
}

// `pids.current` of a cgroup, as a number.
export const pidsCurrent = (dir) => Number(readFileSync(join(dir, 'pids.current'), 'utf8').trim());

// Lower a domain's `pids.max` from the test's side (M2 slice 13, row M130
// (h); SEAM.md §145). Confined as every change here is, and more narrowly:
// only a domain's own directory (`dom_<ULID>`) inside a test engine's
// scope, only `pids.max`, only a small positive integer. Lowering the limit
// ends no process; it only makes a later fork in the domain fail.
export function setPidsMax(dir, value) {
  assertInsideTestScope(dir, 'set pids.max of');
  if (!/\/dom_[0-9A-HJKMNP-TV-Z]{26}$/.test(dir)) throw new Error(`refusing to set pids.max of ${JSON.stringify(dir)}: only a domain's own directory`);
  if (!Number.isInteger(value) || value < 1 || value > 64) throw new Error(`refusing pids.max ${JSON.stringify(value)}: a small positive integer only`);
  writeFileSync(join(dir, 'pids.max'), String(value));
}

// Create a leaf cgroup under a test scope, or under a directory inside one
// (a scope the engine owns is writable by the same uid).
export function makeLeaf(parent, name) {
  assertInsideTestScope(parent, 'create a cgroup under', { orScope: true });
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`refusing the leaf name ${JSON.stringify(name)}`);
  const dir = join(parent, name);
  spawnSync('mkdir', [dir]);
  assert.ok(cgroupExists(dir), `a leaf cgroup ${dir} can be created`);
  return dir;
}

// ---- waits -------------------------------------------------------------------------

export const waitPopulated = (dir, value, { timeoutMs = 20_000 } = {}) =>
  waitFor(
    () => {
      try {
        return populated(dir) === value ? true : undefined;
      } catch {
        return undefined;
      }
    },
    { timeoutMs, what: `${dir} to read populated ${value}` },
  );

export const waitCgroupGone = (dir, { timeoutMs = 20_000 } = {}) => waitFor(() => (cgroupExists(dir) ? undefined : true), { timeoutMs, what: `${dir} to be removed` });

export const waitCgroupPresent = (dir, { timeoutMs = 20_000 } = {}) => waitFor(() => (cgroupExists(dir) ? true : undefined), { timeoutMs, what: `${dir} to exist` });

// The scope units of one home as the manager lists them, once they number
// `count` (a stopped scope goes within a moment of being emptied).
export const waitScopes = (home, count, { timeoutMs = 20_000 } = {}) =>
  waitFor(
    () => {
      const scopes = listScopes(scopeUnitPrefix(home));
      return scopes.length === count ? scopes : undefined;
    },
    { timeoutMs, what: `${count} scope(s) of home ${home} to be listed` },
  );

// Children of a cgroup directory that are themselves cgroups.
export const childCgroups = (dir) => readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
