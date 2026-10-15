// Sentinel processes of the test's own (M2 plan §2.3 "Sentinels"; rows
// M115 (g), M117 (a); SEAM.md §128). A host sentinel lives outside every
// domain and must survive whatever a role does; a cgroup sentinel is a
// process the test places inside a cgroup of the engine's scope, which the
// engine must never take for its own (a recreated quarantined domain, a
// path under another scope). The test cannot migrate a process out of its
// own cgroup into the user manager's subtree directly (the common ancestor
// may be the root cgroup), so a cgroup sentinel is started in a transient
// scope of its own through the manager, then moved.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { waitFor } from '../engine.mjs';
import { signalPid, signallable } from '../proc.mjs';
import { cgroupOfPid, moveIntoCgroup, procsOf, scopePathOf } from './cgroup.mjs';
import { hostProcess, isHostAlive } from './procs.mjs';

// A long-lived process outside every domain: {pid, alive, kill}.
export function hostSentinel(t) {
  const child = spawn('sleep', ['3600'], { stdio: 'ignore' });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // gone
    }
  });
  return { pid: child.pid, alive: () => isHostAlive(child.pid), kill: () => child.kill('SIGKILL') };
}

// The sentinels made for each home, numbered from 1.
const made = new Map();

// A `sleep` started in its own transient user scope through the manager,
// then moved into `dir` (when given). Returns {pid, unit, alive, cgroup, kill}.
// The unit is named from the test's own disposable home (BS5 §4.1 rules 1
// and 2; the driver's ruling, slice 37; SEAM §462):
// `surety-<h12(home)>-sentinel-<n>.scope`, `h12` the first twelve hex digits
// of the home path's SHA-256 (as `homeHash` names the home's deploy units),
// and in cleanup the sentinel's own `sleep` is killed and the unit stopped by
// exactly that name.
export async function cgroupSentinel(t, dir = null, { home } = {}) {
  if (typeof home !== 'string' || home.length === 0) throw new Error('cgroupSentinel: the test\'s own home names the unit; none was given');
  const n = (made.get(home) ?? 0) + 1;
  made.set(home, n);
  const unit = `surety-${createHash('sha256').update(home).digest('hex').slice(0, 12)}-sentinel-${n}.scope`;
  const runner = spawn('systemd-run', ['--user', '--scope', '--quiet', `--unit=${unit}`, 'sleep', '3600'], { stdio: 'ignore', detached: true });
  runner.unref();
  const pid = await waitFor(
    () => {
      const scope = scopePathOf(unit);
      if (scope === null) return undefined;
      try {
        return procsOf(scope).find((p) => signallable(p) && /(^|\/)sleep$/.test(hostProcess(p)?.cmdline[0] ?? ''));
      } catch {
        return undefined;
      }
    },
    { timeoutMs: 10_000, what: `the sentinel's sleep in its scope ${unit}` },
  );
  if (dir !== null) moveIntoCgroup(pid, dir);
  const sentinel = {
    pid,
    unit,
    alive: () => isHostAlive(pid),
    cgroup: () => cgroupOfPid(pid),
    kill: () => {
      signalPid(pid, 'SIGKILL');
    },
  };
  t.after(() => {
    sentinel.kill();
    // By exactly its name; a scope already emptied and collected is not loaded.
    spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore', timeout: 30_000 });
  });
  return sentinel;
}
