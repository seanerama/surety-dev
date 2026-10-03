// Linux process identity, as the engine lock records it (SEAM.md "Engine lock").

import { readFileSync } from 'node:fs';

// Field 22 of /proc/<pid>/stat: start time in clock ticks since boot. The
// command name (field 2) may contain spaces and parentheses, so fields are
// counted from the last ')'.
export function procStartTime(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // rest[0] is field 3 (state); field 22 is rest[19].
  const value = rest[19];
  if (!/^\d+$/.test(value ?? '')) throw new Error(`unparseable /proc/${pid}/stat`);
  return value;
}

export const bootId = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Whether a test may signal a pid it READ from somewhere (a cgroup.procs
// file, a log a role wrote, a row of the store) rather than got from a child
// handle of its own: an integer greater than 1 that is not the test's own
// process or its parent. Anything else is never signalled: 0 addresses the
// caller's own process group (and is what a reader in another pid namespace
// sees in cgroup.procs for a process outside it), a negative number a whole
// group or, as -1, everything the caller may signal, and 1 is the system's
// init. The test-side half of the rule for destructive instruments (E64;
// SEAM.md §§127, 128).
export const signallable = (pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid;

// Send `signal` to such a pid. Returns whether it was sent: false for a pid
// that may not be signalled and for one that is gone or not ours.
export function signalPid(pid, signal = 'SIGKILL') {
  if (!signallable(pid)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
