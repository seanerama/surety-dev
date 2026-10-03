// Sentinel processes of the test's own (M2 plan §2.3 "Sentinels"; rows
// M115 (g), M117 (a); SEAM.md §128). A host sentinel lives outside every
// domain and must survive whatever a role does; a cgroup sentinel is a
// process the test places inside a cgroup of the engine's scope, which the
// engine must never take for its own (a recreated quarantined domain, a
// path under another scope). The test cannot migrate a process out of its
// own cgroup into the user manager's subtree directly (the common ancestor
// may be the root cgroup), so a cgroup sentinel is started in a transient
// scope of its own through the manager, then moved.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { waitFor } from '../engine.mjs';
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

// A `sleep` started in its own transient user scope through the manager,
// then moved into `dir` (when given). Returns {pid, unit, alive, cgroup, kill}.
export async function cgroupSentinel(t, dir = null) {
  const unit = `surety-test-sentinel-${randomBytes(4).toString('hex')}.scope`;
  const runner = spawn('systemd-run', ['--user', '--scope', '--quiet', `--unit=${unit}`, 'sleep', '3600'], { stdio: 'ignore', detached: true });
  runner.unref();
  const pid = await waitFor(
    () => {
      const scope = scopePathOf(unit);
      if (scope === null) return undefined;
      try {
        return procsOf(scope).find((p) => /(^|\/)sleep$/.test(hostProcess(p)?.cmdline[0] ?? ''));
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
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    },
  };
  t.after(() => sentinel.kill());
  return sentinel;
}
