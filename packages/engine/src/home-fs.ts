// The engine home's filesystem (D1 §6.1; E36 item 7; SEAM.md §88). The
// engine cannot check that storage honours a sync. It refuses a home on a
// kind of filesystem known not to keep what is written to it, or not to give
// sync guarantees: memory-backed, network and user-space filesystems. Any
// other kind starts normally, a kind the engine has never heard of included.
//
// The kind is the filesystem type of the mount that holds the home, as
// /proc/self/mountinfo names it; a type with a subtype (`fuse.sshfs`) is of
// the kind before the dot. The decision is made before the lock is taken and
// before anything is written.

import { readFileSync, realpathSync } from 'node:fs';

import { Refusal } from './refusal.js';

const UNSAFE: Record<string, 'memory' | 'network' | 'user_space'> = {
  tmpfs: 'memory',
  ramfs: 'memory',
  nfs: 'network',
  nfs4: 'network',
  cifs: 'network',
  smb3: 'network',
  smbfs: 'network',
  ncpfs: 'network',
  afs: 'network',
  ceph: 'network',
  glusterfs: 'network',
  fuse: 'user_space',
  fuseblk: 'user_space',
  '9p': 'user_space',
};

const CLASS_TEXT = { memory: 'a memory-backed filesystem, which loses everything at power loss', network: 'a network filesystem, which gives no local sync guarantee', user_space: 'a user-space filesystem, which gives no sync guarantee the engine can rely on' };

// A mount point as mountinfo writes it: space, tab, newline and backslash
// are octal escapes.
const unescape = (text: string): string => text.replace(/\\([0-7]{3})/g, (_m, octal: string) => String.fromCharCode(parseInt(octal, 8)));

// The filesystem type of the mount that holds `path`, or null if it cannot
// be found.
export function filesystemOf(path: string): string | null {
  let real: string;
  let table: string;
  try {
    real = realpathSync(path);
    table = readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return null;
  }
  let best: { point: string; type: string } | null = null;
  for (const line of table.split('\n')) {
    const at = line.indexOf(' - ');
    if (at < 0) continue;
    const point = unescape(line.slice(0, at).split(' ')[4] ?? '');
    const type = line.slice(at + 3).split(' ')[0] ?? '';
    if (point === '' || type === '') continue;
    const holds = point === '/' || real === point || real.startsWith(`${point}/`);
    if (holds && (best === null || point.length >= best.point.length)) best = { point, type };
  }
  return best?.type ?? null;
}

// Refuses a home on an unsafe kind. `given` replaces the detection, not the
// judgement (the harness names a kind it cannot mount).
export function checkHomeFilesystem(home: string, given: string | null): void {
  const found = given ?? filesystemOf(home);
  if (found === null) {
    throw new Refusal(
      500,
      'unsafe_filesystem',
      'The kind of filesystem the engine home is on could not be determined, so the engine cannot tell whether what it writes there survives.',
      'Put the engine home on a local disk filesystem (ext4, xfs or btrfs, say) the engine can identify, and start again.',
      { path: '.', filesystem: null },
    );
  }
  const kind = found.split('.')[0]!;
  const cls = UNSAFE[kind];
  if (cls === undefined) return;
  throw new Refusal(
    500,
    'unsafe_filesystem',
    `The engine home is on ${found}: ${CLASS_TEXT[cls]}. The engine refuses to keep its store there.`,
    'Set SURETY_HOME to a directory on a local disk filesystem (ext4, xfs or btrfs, say) and start again.',
    { path: '.', filesystem: found },
  );
}
