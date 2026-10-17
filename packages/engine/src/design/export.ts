// `surety design export` and `GET …/design/export` (D7 §5.7, A.8; SEAM.md
// §501): the design tree at a revision (`checkpoint`, `approved` or a
// commit), read from git, with an engine-authored `SIMULATIONS.txt` naming
// every simulated mockup. The route answers a POSIX ustar archive; the
// command writes the same entries into a directory the owner names. A read
// and a write, nothing else: no operation, no adapter, no qualification.
// Nothing of the tree is run or decoded; the archive is built and read
// here, with no dependency.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import type { Runtime } from '../runtime.js';
import { Refusal } from '../refusal.js';
import { siteMockups, simulationsText } from './preview/server.js';
import { designTreeAt } from './tree.js';

export const SIMULATIONS_FILE = 'SIMULATIONS.txt';

// The export's entries: {path relative to .surety/design/: bytes}, and
// SIMULATIONS.txt at the root.
export async function exportEntries(rt: Runtime, project: string, revision: string): Promise<Map<string, Buffer>> {
  const facts = await rt.read<{ repo: string; revision: string }>('design.export_facts', { project, revision });
  const tree = await designTreeAt(facts.repo, facts.revision);
  if (tree === null) throw new Refusal(404, 'not_found', `The design tree at ${facts.revision} could not be read.`, 'Name another revision.', { project, revision: facts.revision });
  const out = new Map<string, Buffer>();
  for (const [path, bytes] of [...tree.files.entries()].sort(([a], [b]) => a.localeCompare(b))) if (path !== SIMULATIONS_FILE) out.set(path, bytes);
  const mockups = siteMockups(tree.files.get('design.json') ?? null, tree.files.get('screens.json') ?? null);
  out.set(SIMULATIONS_FILE, Buffer.from(simulationsText(mockups)));
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

// The regular files of an archive this module wrote: {path: bytes}.
export function readUstar(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const str = (h: Buffer, at: number, n: number): string => {
    const s = h.subarray(at, at + n);
    const z = s.indexOf(0);
    return s.subarray(0, z < 0 ? n : z).toString('utf8');
  };
  let off = 0;
  let pax: string | null = null;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    if (str(h, 257, 5) !== 'ustar') throw new Error(`not a ustar header at ${off}`);
    const size = parseInt(str(h, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`a bad size at ${off}`);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]!);
    const name = str(h, 0, 100);
    const prefix = str(h, 345, 155);
    off += BLOCK;
    const data = buf.subarray(off, off + size);
    off += size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      pax = m ? m[1]! : null;
      continue;
    }
    const path = pax ?? (prefix ? `${prefix}/${name}` : name);
    pax = null;
    if (type === '0') out.set(path, Buffer.from(data));
  }
  return out;
}

// Each entry written under `dir` (made if absent); a path that is absolute,
// empty or climbs out of `dir` is refused, and nothing is written.
export function writeEntries(dir: string, entries: Map<string, Buffer>): string[] {
  const root = resolve(dir);
  const targets: [string, Buffer][] = [];
  for (const [path, bytes] of entries) {
    const full = resolve(root, path);
    if (path === '' || isAbsolute(path) || path.split('/').some((s) => s === '..' || s === '') || !full.startsWith(`${root}${sep}`)) throw new Error(`the archive names ${JSON.stringify(path)}, which is not a path under ${root}`);
    targets.push([full, bytes]);
  }
  mkdirSync(root, { recursive: true });
  for (const [full, bytes] of targets) {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
  }
  return targets.map(([full]) => full.slice(root.length + 1));
}
