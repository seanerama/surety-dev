// `surety design export` and `GET …/design/export` (D7 §5.7, A.8; SEAM.md
// §501): the design tree at a revision (`checkpoint`, `approved` or a
// commit), read from git, with an engine-authored `SIMULATIONS.txt` naming
// every simulated mockup. The route answers a POSIX ustar archive; the
// command writes the same entries into a directory the owner names. A read
// and a write, nothing else: no operation, no adapter, no qualification.
// Nothing of the tree is run or decoded; the archive is built and read
// here, with no dependency.

import { lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import type { Runtime } from '../runtime.js';
import { Refusal } from '../refusal.js';
import { engineMockups, simulationsText } from './preview-mockups.js';
import { designTreeAt } from './tree.js';

export const SIMULATIONS_FILE = 'SIMULATIONS.txt';

// The export's entries: {path relative to .surety/design/: bytes}, and
// SIMULATIONS.txt at the root.
export async function exportEntries(rt: Runtime, project: string, revision: string): Promise<Map<string, Buffer>> {
  const facts = await rt.read<{ repo: string; revision: string; targets: { target: string; technology: string }[] }>('design.export_facts', { project, revision });
  const tree = await designTreeAt(facts.repo, facts.revision);
  if (tree === null) throw new Refusal(404, 'not_found', `The design tree at ${facts.revision} could not be read.`, 'Name another revision.', { project, revision: facts.revision });
  const out = new Map<string, Buffer>();
  for (const [path, bytes] of [...tree.files.entries()].sort(([a], [b]) => a.localeCompare(b))) if (path !== SIMULATIONS_FILE) out.set(path, bytes);
  // What the preview would frame under `design_preview: static`.
  out.set(SIMULATIONS_FILE, Buffer.from(simulationsText(engineMockups(tree.files, { targets: facts.targets, design_preview: 'static' }))));
  return out;
}

// ---- ustar ------------------------------------------------------------------------------------

const BLOCK = 512;

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

function header(name: string, size: number, type: '0' | 'x'): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

const pad = (n: number): Buffer => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK, 0);

// A pax record `<len> path=<path>\n`, its length counting itself.
function paxPath(path: string): Buffer {
  const body = ` path=${path}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return Buffer.from(`${len}${body}`);
}

// The archive of `entries`, regular files only, in their order; a path
// longer than the header's 100 bytes carried by a pax `path` record.
export function ustar(entries: Map<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const [path, bytes] of entries) {
    if (Buffer.byteLength(path) > 100) {
      const pax = paxPath(path);
      parts.push(header('PaxHeader', pax.length, 'x'), pax, pad(pax.length));
    }
    parts.push(header(Buffer.byteLength(path) > 100 ? path.slice(0, 99) : path, bytes.length, '0'), bytes, pad(bytes.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

// The pax records of an extended header, each `<len> <key>=<value>\n`
// read by its length prefix; anything else is malformed.
function paxRecords(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0 || space === at || space - at > 20) throw new Error('a malformed pax record (no length)');
    const digits = data.subarray(at, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(digits)) throw new Error('a malformed pax record (its length)');
    const len = Number(digits);
    if (at + len > data.length || len <= space - at + 1 || data[at + len - 1] !== 0x0a) throw new Error('a malformed pax record (its length does not fit)');
    const record = data.subarray(space + 1, at + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq <= 0) throw new Error('a malformed pax record (no key)');
    out.set(record.slice(0, eq), record.slice(eq + 1));
    at += len;
  }
  return out;
}

// The regular files of an archive: {path: bytes}. Refused (thrown) unless
// every header's checksum is right, every entry lies wholly inside the
// buffer, and the archive ends with its two zero blocks.
export function readUstar(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const str = (h: Buffer, at: number, n: number): string => {
    const s = h.subarray(at, at + n);
    const z = s.indexOf(0);
    return s.subarray(0, z < 0 ? n : z).toString('utf8');
  };
  if (buf.length % BLOCK !== 0) throw new Error('not a whole number of 512-byte blocks');
  let off = 0;
  let pax: string | null = null;
  for (;;) {
    if (off + BLOCK > buf.length) throw new Error('the archive ends without its two zero blocks');
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) {
      if (off + 2 * BLOCK > buf.length || !buf.subarray(off + BLOCK, off + 2 * BLOCK).every((b) => b === 0)) throw new Error('the archive ends without its two zero blocks');
      if (pax !== null) throw new Error('a pax header names no entry');
      return out;
    }
    if (str(h, 257, 5) !== 'ustar') throw new Error(`not a ustar header at ${off}`);
    const stated = parseInt(str(h, 148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (!Number.isInteger(stated) || stated !== sum) throw new Error(`a bad header checksum at ${off}`);
    const sizeText = str(h, 124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error(`a bad size at ${off}`);
    const size = parseInt(sizeText, 8);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]!);
    const name = str(h, 0, 100);
    const prefix = str(h, 345, 155);
    off += BLOCK;
    const padded = size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (off + padded > buf.length) throw new Error(`an entry at ${off - BLOCK} runs past the archive's end`);
    const data = buf.subarray(off, off + size);
    off += padded;
    if (type === 'x') {
      pax = paxRecords(data).get('path') ?? null;
      continue;
    }
    if (type === 'g') {
      paxRecords(data);
      continue;
    }
    const path = pax ?? (prefix ? `${prefix}/${name}` : name);
    pax = null;
    if (type === '0') out.set(path, Buffer.from(data));
  }
}

// Each entry written under `dir`, which must not exist yet, or be an empty
// directory that is no link. A path that is absolute, empty or climbs out of
// `dir` is refused, and nothing is written.
export function writeEntries(dir: string, entries: Map<string, Buffer>): string[] {
  const root = resolve(dir);
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(root);
  } catch {
    st = null;
  }
  if (st !== null) {
    if (st.isSymbolicLink()) throw new Error(`${root} is a symbolic link: export into a new or empty directory`);
    if (!st.isDirectory()) throw new Error(`${root} is not a directory`);
    if (readdirSync(root).length > 0) throw new Error(`${root} is not empty: export into a new or empty directory`);
  }
  const targets: [string, Buffer][] = [];
  for (const [path, bytes] of entries) {
    const full = resolve(root, path);
    if (path === '' || isAbsolute(path) || path.split('/').some((s) => s === '..' || s === '' || s === '.') || !full.startsWith(`${root}${sep}`)) throw new Error(`the archive names ${JSON.stringify(path)}, which is not a path under ${root}`);
    targets.push([full, bytes]);
  }
  mkdirSync(root, { recursive: true });
  for (const [full, bytes] of targets) {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes, { flag: 'wx' });
  }
  return targets.map(([full]) => full.slice(root.length + 1));
}
