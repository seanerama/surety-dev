// The engine's source revision (M544; E154 item 6 (5); D6 §7.6's host
// block): the commit the engine's own installation was built from, read once
// at the engine's start from the git repository its files stand in. It is
// read from files (HEAD, the ref it names, packed-refs), never by starting
// a process. The package version (`ENGINE_VERSION`, "0.0.0") is not a
// revision and is never presented as one: a revision that cannot be read is
// unknown, with its reason.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type EngineRevision = { revision: string } | { unknown: string };

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

// The git directory of the working tree that holds `start`, and its common
// directory (a linked worktree's refs live in the main repository's).
function gitDirs(start: string): { gitdir: string; common: string } | null {
  let dir = resolve(start);
  for (;;) {
    const dotgit = join(dir, '.git');
    if (existsSync(dotgit)) {
      let gitdir: string | null = null;
      try {
        if (statSync(dotgit).isDirectory()) gitdir = dotgit;
        else {
          const m = /^gitdir:\s*(.+)\s*$/m.exec(read(dotgit) ?? '');
          if (m) gitdir = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
        }
      } catch {
        gitdir = null;
      }
      if (gitdir === null) return null;
      const commondir = read(join(gitdir, 'commondir'))?.trim();
      return { gitdir, common: commondir ? (isAbsolute(commondir) ? commondir : resolve(gitdir, commondir)) : gitdir };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// The revision of the working tree holding `start` (default: the engine's
// own installation), or unknown naming why.
export function readRevision(start: string): EngineRevision {
  const dirs = gitDirs(start);
  if (dirs === null) return { unknown: `the engine at ${start} is not in a git working tree, so its source revision cannot be read` };
  const head = read(join(dirs.gitdir, 'HEAD'))?.trim();
  if (!head) return { unknown: `${join(dirs.gitdir, 'HEAD')} could not be read` };
  if (OBJECT_ID.test(head)) return { revision: head };
  const m = /^ref:\s*(\S+)$/.exec(head);
  if (!m) return { unknown: `${join(dirs.gitdir, 'HEAD')} names neither a commit nor a ref` };
  const ref = m[1]!;
  for (const base of [dirs.gitdir, dirs.common]) {
    const loose = read(join(base, ref))?.trim();
    if (loose && OBJECT_ID.test(loose)) return { revision: loose };
  }
  const packed = read(join(dirs.common, 'packed-refs')) ?? '';
  for (const line of packed.split('\n')) {
    const [oid, name] = line.trim().split(/\s+/);
    if (name === ref && oid && OBJECT_ID.test(oid)) return { revision: oid };
  }
  return { unknown: `HEAD names ${ref}, which names no commit (a branch with no commit, or a ref that could not be read)` };
}

let cached: EngineRevision | null = null;

// The revision of this engine's installation, read once per process: the
// engine's start (a later checkout in the same tree does not change what
// this engine was started from).
export function engineRevision(): EngineRevision {
  if (cached === null) cached = readRevision(dirname(fileURLToPath(import.meta.url)));
  return cached;
}
