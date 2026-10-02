// What kind of filesystem a path is on, as the kernel names it (row M67's
// unsafe-filesystem case; SEAM.md §88; E36 item 7).

import { readFileSync, realpathSync } from 'node:fs';

export const FILESYSTEMS = JSON.parse(readFileSync(new URL('../contract/filesystems.json', import.meta.url), 'utf8'));

// A mount point as /proc/self/mountinfo writes it: space, tab, newline and
// backslash are octal escapes.
const unescape = (text) => text.replace(/\\([0-7]{3})/g, (unused, octal) => String.fromCharCode(parseInt(octal, 8)));

// The filesystem type of the mount that holds `path`: the type field of the
// /proc/self/mountinfo line whose mount point is the longest one that is the
// path or a directory above it (the last such line, if a mount point is
// mounted over).
export function filesystemOf(path) {
  const real = realpathSync(path);
  let best = null;
  for (const line of readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
    if (line === '') continue;
    const [before, afterSeparator] = line.split(' - ');
    const mountPoint = unescape(before.split(' ')[4]);
    const type = afterSeparator.split(' ')[0];
    const holds = real === mountPoint || mountPoint === '/' || real.startsWith(`${mountPoint}/`);
    if (holds && (best === null || mountPoint.length >= best.mountPoint.length)) best = { mountPoint, type };
  }
  if (best === null) throw new Error(`no mount holds ${real}`);
  return best.type;
}
