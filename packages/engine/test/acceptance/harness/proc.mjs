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
