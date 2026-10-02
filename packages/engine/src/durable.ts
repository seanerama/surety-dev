// Making what the engine writes durable (D1 §§6.1, 14.1, 18; SEAM.md §60).
// Anything the engine writes and relies on after a restart is synced before
// it is relied on: a file's content by its own fsync, and the directory that
// names it by the directory's fsync.

import { closeSync, constants, fsyncSync, lstatSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function syncDirectory(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Replace `file` with `data` so that after a crash or a power loss it holds
// either what it held before or all of `data`: written and synced under a
// temporary name, renamed into place, and the directory synced.
export function writeFileDurable(file: string, data: string | Buffer, mode = 0o600): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    unlinkSync(temp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  syncDirectory(dirname(file));
}

// Sync every regular file and directory under `root` (symbolic links are
// not followed), then `root` itself. Used for what git writes without a sync
// of its own: the files a new worktree checks out and its metadata.
export function syncTree(root: string): void {
  const st = lstatSync(root);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const name of readdirSync(root)) syncTree(join(root, name));
    syncDirectory(root);
    return;
  }
  if (!st.isFile()) return;
  const fd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
