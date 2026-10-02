// Whether a commit is in a repository's object store, read from the object
// files themselves (E37 item 4; SEAM.md §§59, 93). The backup the running
// engine takes checks every commit its manifest lists this way: it runs no
// git, reads no repository configuration and so runs no repository code, and
// does not wait on a repository whose git another process holds up. A loose
// object's header is inflated; a packed object is found through the pack
// index and its type read from the pack entry, following delta bases. An
// object in an alternate object store, or anything that cannot be read, is
// not found: the answer is "present" only when the object was seen.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { constants, inflateSync } from 'node:zlib';

const COMMIT = 1;
const OFS_DELTA = 6;
const REF_DELTA = 7;

// The common git directory of a repository's working tree or bare directory.
function commonDir(repo: string): string | null {
  let gitDir = join(repo, '.git');
  try {
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = isAbsolute(m[1]!) ? m[1]! : resolve(repo, m[1]!);
    }
  } catch {
    if (existsSync(join(repo, 'objects')) && existsSync(join(repo, 'HEAD'))) gitDir = repo;
    else return null;
  }
  try {
    const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    return isAbsolute(common) ? common : resolve(gitDir, common);
  } catch {
    return gitDir;
  }
}

function looseType(objects: string, oid: string): string | null {
  const path = join(objects, oid.slice(0, 2), oid.slice(2));
  let head: Buffer;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(512);
      const n = readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  try {
    const text = inflateSync(head, { finishFlush: constants.Z_SYNC_FLUSH }).toString('latin1');
    const space = text.indexOf(' ');
    return space > 0 ? text.slice(0, space) : null;
  } catch {
    return null;
  }
}

interface Pack {
  idx: Buffer;
  pack: string;
  count: number;
  hashLength: number;
}

function packsOf(objects: string, hashLength: number): Pack[] {
  const dir = join(objects, 'pack');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.idx'));
  } catch {
    return [];
  }
  const packs: Pack[] = [];
  for (const name of names) {
    try {
      const idx = readFileSync(join(dir, name));
      if (idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) continue;
      packs.push({ idx, pack: join(dir, name.replace(/\.idx$/, '.pack')), count: idx.readUInt32BE(8 + 255 * 4), hashLength });
    } catch {
      // an index that cannot be read finds nothing
    }
  }
  return packs;
}

// The offset of `oid` in the pack, or null.
function offsetIn(p: Pack, oid: Buffer): number | null {
  const fanout = 8;
  const first = oid[0]!;
  let lo = first === 0 ? 0 : p.idx.readUInt32BE(fanout + (first - 1) * 4);
  let hi = p.idx.readUInt32BE(fanout + first * 4);
  const names = fanout + 256 * 4;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const cmp = p.idx.compare(oid, 0, p.hashLength, names + mid * p.hashLength, names + (mid + 1) * p.hashLength);
    if (cmp === 0) {
      const offsets = names + p.count * p.hashLength + p.count * 4;
      const small = p.idx.readUInt32BE(offsets + mid * 4);
      if ((small & 0x80000000) === 0) return small;
      const large = offsets + p.count * 4 + (small & 0x7fffffff) * 8;
      return Number(p.idx.readBigUInt64BE(large));
    }
    // `compare` compares the entry with oid: below 0 when the entry is before it.
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  return null;
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, n);
}

// The type of the object at `offset` in a pack, following delta bases.
function packedType(packs: Pack[], p: Pack, offset: number, depth = 0): number | null {
  if (depth > 64) return null;
  let fd: number;
  try {
    fd = openSync(p.pack, 'r');
  } catch {
    return null;
  }
  try {
    const head = readAt(fd, offset, 64);
    if (head.length === 0) return null;
    let i = 0;
    let byte = head[i++]!;
    const type = (byte >> 4) & 7;
    while (byte & 0x80) {
      if (i >= head.length) return null;
      byte = head[i++]!;
    }
    if (type === OFS_DELTA) {
      let b = head[i++]!;
      let back = b & 0x7f;
      while (b & 0x80) {
        if (i >= head.length) return null;
        b = head[i++]!;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      return packedType(packs, p, offset - back, depth + 1);
    }
    if (type === REF_DELTA) {
      const base = head.subarray(i, i + p.hashLength);
      for (const q of packs) {
        const at = offsetIn(q, base);
        if (at !== null) return packedType(packs, q, at, depth + 1);
      }
      return null;
    }
    return type;
  } finally {
    closeSync(fd);
  }
}

// Is `oid` a commit in the repository at `repo`? False when it is not, or
// when that cannot be seen.
export function commitPresent(repo: string, oid: string): boolean {
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) return false;
  const common = commonDir(repo);
  if (common === null) return false;
  const objects = join(common, 'objects');
  const loose = looseType(objects, oid);
  if (loose !== null) return loose === 'commit';
  const hashLength = oid.length / 2;
  const packs = packsOf(objects, hashLength);
  const id = Buffer.from(oid, 'hex');
  for (const p of packs) {
    const at = offsetIn(p, id);
    if (at !== null) return packedType(packs, p, at) === COMMIT;
  }
  return false;
}
