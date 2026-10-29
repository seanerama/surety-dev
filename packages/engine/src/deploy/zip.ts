// A zip archive written and read with Node's own modules (zlib), for the
// downloadable Alpha deliverable (SHAPES.md §4): one entry per file given,
// in the order given, each stored or deflated (whichever is smaller), its
// CRC-32 computed here, every timestamp the one given (so the same files
// give the same bytes), Unix modes in the external attributes, a central
// directory and its end record. No ZIP64: more than 65535 entries, or a
// size or offset past 4 GiB - 1, is refused. The reader reads exactly what
// the writer writes (and checks every entry's CRC-32 and sizes); it is the
// developer tests' and the deliverable's own re-verification.

import { deflateRawSync, inflateRawSync } from 'node:zlib';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS date and time of an instant, in UTC (a zip names no zone); before
// 1980 is 1980-01-01 00:00:00.
export function dosTime(at: Date): { date: number; time: number } {
  const y = at.getUTCFullYear();
  if (!Number.isFinite(y) || y < 1980) return { date: (0 << 9) | (1 << 5) | 1, time: 0 };
  const year = Math.min(y, 2107) - 1980;
  return {
    date: (year << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
  };
}

export interface ZipEntry {
  name: string;
  bytes: Buffer;
  // The Unix mode bits (0o644 or 0o755); 0o644 when absent.
  mode?: number;
}

const LIMIT = 0xffffffff;

export function writeZip(entries: readonly ZipEntry[], at: Date): Buffer {
  if (entries.length > 0xffff) throw new Error('a zip without ZIP64 holds at most 65535 entries');
  const { date, time } = dosTime(at);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    if (name.length === 0 || name.length > 0xffff || e.name.startsWith('/') || e.name.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new Error(`${JSON.stringify(e.name)} is not a relative path a zip entry may have`);
    const crc = crc32(e.bytes);
    const deflated = deflateRawSync(e.bytes, { level: 9 });
    const stored = deflated.length >= e.bytes.length;
    const data = stored ? e.bytes : deflated;
    if (e.bytes.length > LIMIT || data.length > LIMIT || offset > LIMIT) throw new Error('a zip without ZIP64 holds no entry or offset past 4 GiB');
    const method = stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(e.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(e.bytes.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(0, 30); // extra
    c.writeUInt16LE(0, 32); // comment
    c.writeUInt16LE(0, 34); // disk
    c.writeUInt16LE(0, 36); // internal attributes
    c.writeUInt32LE((((0o100000 | ((e.mode ?? 0o644) & 0o777)) << 16) >>> 0) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  if (offset > LIMIT || dir.length > LIMIT) throw new Error('a zip without ZIP64 holds no directory past 4 GiB');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, dir, end]);
}

export interface ReadEntry {
  name: string;
  bytes: Buffer;
  mode: number;
  method: number;
  date: number;
  time: number;
}

// The entries of a zip, in its central directory's order, each inflated
// and checked against its CRC-32 and sizes; anything else throws.
export function readZip(zip: Buffer): ReadEntry[] {
  if (zip.length < 22) throw new Error('too short to be a zip');
  const endAt = zip.length - 22;
  if (zip.readUInt32LE(endAt) !== 0x06054b50) throw new Error('no end of central directory record at the end (a comment is not written here)');
  const count = zip.readUInt16LE(endAt + 10);
  const size = zip.readUInt32LE(endAt + 12);
  let at = zip.readUInt32LE(endAt + 16);
  if (at + size !== endAt) throw new Error('the central directory is not where its end record says');
  const out: ReadEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`central directory entry ${i} has no signature`);
    const method = zip.readUInt16LE(at + 10);
    const time = zip.readUInt16LE(at + 12);
    const date = zip.readUInt16LE(at + 14);
    const crc = zip.readUInt32LE(at + 16);
    const csize = zip.readUInt32LE(at + 20);
    const usize = zip.readUInt32LE(at + 24);
    const nlen = zip.readUInt16LE(at + 28);
    const xlen = zip.readUInt16LE(at + 30);
    const clen = zip.readUInt16LE(at + 32);
    const attrs = zip.readUInt32LE(at + 38);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nlen).toString('utf8');
    at += 46 + nlen + xlen + clen;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: no local header`);
    const lname = zip.readUInt16LE(local + 26);
    const lextra = zip.readUInt16LE(local + 28);
    if (zip.subarray(local + 30, local + 30 + lname).toString('utf8') !== name) throw new Error(`${name}: the local header names another entry`);
    const start = local + 30 + lname + lextra;
    const data = zip.subarray(start, start + csize);
    if (data.length !== csize) throw new Error(`${name}: its data is cut short`);
    const bytes = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
    if (bytes === null) throw new Error(`${name}: compression method ${method} is not one this reader reads`);
    if (bytes.length !== usize) throw new Error(`${name}: ${bytes.length} bytes, not the ${usize} recorded`);
    if (crc32(bytes) !== crc) throw new Error(`${name}: its CRC-32 does not match`);
    out.push({ name, bytes, mode: (attrs >>> 16) & 0o777, method, date, time });
  }
  return out;
}
