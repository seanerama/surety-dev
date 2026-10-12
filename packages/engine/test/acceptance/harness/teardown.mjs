// The fail-closed teardown of a test home (SEAM.md §367; E64; BS5 §4.1).
//
// Why it exists. A test file runs in a process of its own that the runner
// (node:test `run({ timeout })`, scripts/run-tests.mjs) ends with SIGTERM
// when the file passes its time limit. SIGTERM ends a Node process at once:
// no `t.after`, `after` or `finally` runs, so the engine children the file
// spawned (not detached, but the kernel does not end a child with its
// parent) went on running, reparented, with their scopes, the deployment
// units their engines had made and their homes. And a fixture's own
// `t.after` removed the home before the operator guard's `after` read the
// store, so the guard could no longer show a unit to be the home's and only
// reported it. Found by the slice-31a gate (2026-10-12): six engines, six
// scopes, seven `surety-<h>-env_*-g1.service` units and seven homes left.
//
// What it does. Every engine the harness spawns, and every home it makes, is
// registered here. `teardownHome(home)` is synchronous and acts only on what
// is positively the home's (E64's two-part rule):
//   1. each engine child of the home still running: its pid is the child
//      handle's, /proc/<pid>/cmdline names `serve` and /proc/<pid>/environ
//      holds SURETY_HOME=<home>; then SIGKILL through that handle. Nothing
//      else is signalled; a pid that cannot be read is left and reported;
//   2. each loaded user unit named `surety-<h12(home)>-env_<ULID>-g<n>.service`
//      that the home's own store names in an attempt intent: stopped by its
//      exact name, reset if it failed. A unit that the store does not name
//      (or a store that cannot be read) is reported, never acted on;
//   3. the home's engine scopes (`surety-<h16>-<incarnation>.scope`): the
//      processes of their child cgroups ended as the sandbox lane always has
//      (sandbox/cgroup.mjs `endScopeLeftovers`, inside the test scope only).
// The user manager itself is never stopped, reloaded or re-executed; no
// sudo, no loginctl, no Docker.
//
// When it runs. From each fixture's `t.after` before the home is removed;
// and, for whatever is still registered, on SIGTERM, SIGINT and SIGHUP (then
// the process exits 128 + the signal's number) and at the process's `exit`.
// SIGKILL of the test process cannot be caught: that remains the runner's
// own leftover report (rule 7), which names what was left.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';

import { endScopeLeftovers, scopeUnitPrefix } from './sandbox/cgroup.mjs';
import { withStore } from './store.mjs';

const HOMES = new Map(); // home -> { engines: Set<ChildProcess>, roots: Set<string> }
export const TEARDOWN_LOG = []; // { home, unit?, engine?, action, why }

const entry = (home) => {
  let e = HOMES.get(home);
  if (!e) HOMES.set(home, (e = { engines: new Set(), roots: new Set() }));
  return e;
};

// An engine child the harness spawned for `home`.
export function registerEngine(home, child) {
  const e = entry(home);
  e.engines.add(child);
  child.once('exit', () => e.engines.delete(child));
}

// A home and the temporary root that holds it, removed after the teardown.
export function registerHome(home, root = null) {
  const e = entry(home);
  if (root !== null) e.roots.add(root);
}

const hash12 = (home) => createHash('sha256').update(home).digest('hex').slice(0, 12);
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const ownUnit = (home) => new RegExp(`^surety-${hash12(home)}-env_${ULID}-g[1-9][0-9]*\\.service$`);

function systemctl(args, timeout = 60_000) {
  return spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout });
}

// The exact unit names the home's own store recorded in its attempt intents, or null when it cannot be read.
function intendedUnits(home) {
  try {
    return withStore(home, (db) => db.prepare('SELECT "create_units" FROM "attempt_intents"').all()).flatMap((r) => {
      try {
        return JSON.parse(r.create_units ?? '[]') ?? [];
      } catch {
        return [];
      }
    });
  } catch {
    return null;
  }
}

function killEngine(home, child, why) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  let cmdline;
  let environ;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  } catch (err) {
    TEARDOWN_LOG.push({ home, engine: pid, action: 'left', why: `${why}: /proc/${pid} could not be read (${err.code}); nothing signalled` });
    return;
  }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !cmdline.includes('serve') || !environ.includes(`SURETY_HOME=${home}`)) {
    TEARDOWN_LOG.push({ home, engine: pid, action: 'left', why: `${why}: pid ${pid} is not this home's engine (${cmdline.join(' ')}); nothing signalled` });
    return;
  }
  try {
    child.kill('SIGKILL');
    TEARDOWN_LOG.push({ home, engine: pid, action: 'killed', why });
  } catch {
    // gone meanwhile
  }
}

// The fail-closed teardown of one home: its engines, its units, its scopes. Synchronous.
export function teardownHome(home, why = 'teardown') {
  const e = HOMES.get(home);
  if (e) for (const child of [...e.engines]) killEngine(home, child, why);
  // Units derived from the home's prefix, each shown to be the home's by its store.
  const listed = systemctl(['list-units', '--all', '--no-legend', '--plain', '--no-pager', '--full'], 30_000);
  if (listed.status !== 0) TEARDOWN_LOG.push({ home, action: 'unknown', why: `${why}: the user units could not be listed; whether a unit of this home is loaded is unknown` });
  else {
    const prefix = `surety-${hash12(home)}-env_`;
    const mine = listed.stdout
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((u) => u && u.startsWith(prefix));
    if (mine.length > 0) {
      const intended = intendedUnits(home);
      for (const unit of mine) {
        if (!ownUnit(home).test(unit) || intended === null || !intended.includes(unit)) {
          TEARDOWN_LOG.push({ home, unit, action: 'left', why: `${why}: ${intended === null ? "the home's store cannot be read" : 'no attempt intent of the store names it'}; not acted on` });
          continue;
        }
        const stop = systemctl(['stop', '--', unit]);
        const show = systemctl(['show', '-p', 'LoadState', '-p', 'ActiveState', '--', unit], 30_000);
        if (/ActiveState=failed/.test(show.stdout ?? '')) systemctl(['reset-failed', '--', unit], 30_000);
        TEARDOWN_LOG.push({ home, unit, action: stop.status === 0 ? 'stopped' : 'stop_failed', why });
      }
    }
  }
  try {
    for (const dir of endScopeLeftovers(scopeUnitPrefix(home))) TEARDOWN_LOG.push({ home, scope: dir, action: 'ended', why });
  } catch {
    // the home is gone, or no scope of it exists
  }
}

// Remove the home's registered roots (read-only artifacts made writable first).
function removeRoots(home) {
  const e = HOMES.get(home);
  if (!e || process.env.SURETY_KEEP_TMP === '1') return;
  for (const root of e.roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      spawnSync('chmod', ['-R', 'u+rwx', root]);
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        TEARDOWN_LOG.push({ home, action: 'left', why: `the root ${root} could not be removed` });
      }
    }
  }
}

export function forgetHome(home) {
  HOMES.delete(home);
}

// Everything still registered: on a signal or at exit.
function failClosed(why) {
  for (const home of [...HOMES.keys()]) {
    try {
      teardownHome(home, why);
      removeRoots(home);
    } catch (err) {
      process.stderr.write(`# fail-closed teardown of ${home}: ${err?.message ?? err}\n`);
    }
    HOMES.delete(home);
  }
  for (const e of TEARDOWN_LOG.filter((x) => x.why === why)) process.stderr.write(`# teardown (${why}): ${JSON.stringify(e)}\n`);
}

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
if (!globalThis.__suretyTeardownInstalled) {
  globalThis.__suretyTeardownInstalled = true;
  for (const [signal, n] of Object.entries(SIGNALS)) {
    process.on(signal, () => {
      failClosed(signal);
      process.exit(128 + n);
    });
  }
  process.on('exit', () => failClosed('exit'));
}
