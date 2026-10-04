// Collection from a domain's volatile filesystem (D2 §§1.4, 2.5, 3.7, 4.3; K4;
// AR B08, B09): only after the domain's termination is established, which
// includes closure to future launches, and only from the engine's own hold of
// the filesystem (sandbox/volatile.ts), never by a path the role could have
// changed. Two things are collected:
//
//   - the result, `/surety/out/result.json`, opened without following a link
//     and refused if it is anything but a regular file within
//     `result_max_bytes` (A.6 P18): a FIFO is never opened, a device never
//     read, nothing past the bound read;
//   - the inventory of every writable location (D2 §4.3: the private home,
//     the result directory, `/tmp`, the workspace's upper layer and the git
//     view's objects), walked without following links or opening special
//     files, within `collect_entries_max`, `provider_files_max_bytes` and
//     `collect_deadline`; a credential file is listed under `excluded` and
//     never retained; everything else passes the secret screen and the
//     redactor into one `provider_files` record.
//
// The secret screen (D2 §2.5): before anything collected is published, it is
// screened for every registered secret in its raw and escaped forms. A hit
// refuses that publication; the caller raises the Critical `security` finding
// and `evidence.secret_refused`, and the run cannot complete.
//
// Nothing here writes the volatile filesystem, signals or removes anything,
// or opens a path the hold does not name.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { redactText, scanBytes } from '../records/redact.js';
import { type RegularRead, readRegular, type VolatileHold } from './sandbox/volatile.js';

// The writable locations a role sees (D2 §2.3; SEAM.md §152), and where
// each is on the volatile filesystem. The workspace's upper layer is
// materialized behind the screen (sandbox/materialize.ts), not inventoried.
export const WRITABLE_LOCATIONS: readonly { location: string; at: string }[] = [
  { location: '/surety/home', at: 'home' },
  { location: '/surety/out', at: 'out' },
  { location: '/tmp', at: 'tmp' },
];

// The result's path on the volatile filesystem.
export const RESULT_PATH = 'out/result.json';

// A credential file is listed and never retained (D2 §2.5, §4.3): any path
// whose part under the private home is one of the operator credential
// locations of D2 §2.3 (SEAM.md §§120, 152).
const CREDENTIAL_DIRS = ['.ssh', '.gnupg', '.aws', '.config/gh', '.claude', '.codex', '.docker', '.kube'];
const CREDENTIAL_FILES = ['.netrc', '.git-credentials', '.npmrc'];
export function isCredentialPath(path: string): boolean {
  if (!path.startsWith('/surety/home/')) return false;
  const rel = path.slice('/surety/home/'.length);
  return CREDENTIAL_FILES.includes(rel) || CREDENTIAL_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

export interface Bounds {
  resultMaxBytes: number;
  entriesMax: number;
  filesMaxBytes: number;
  deadlineMs: number;
}

export type ResultCollection =
  | { state: 'read'; bytes: Buffer }
  | { state: 'absent' }
  | { state: 'refused'; reason: string; detail: string }
  | { state: 'secret'; by: string | null }
  | { state: 'not_held' };

export interface InventoryEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'fifo' | 'other';
  size?: number;
  target?: string;
  retained: boolean;
  content_base64?: string;
}

export interface Inventory {
  locations: InventoryEntry[];
  excluded: { path: string; reason: 'credential' }[];
  persistence_flags: string[];
  // Which bound stopped the walk, if any: the record is then incomplete.
  truncated: { key: 'collect_entries_max' | 'provider_files_max_bytes' | 'collect_deadline'; value: number } | null;
  // The screen's hit, if any: the record is then not published.
  secret: { path: string; by: string | null } | null;
}

// The result, read through the hold.
export function collectResult(hold: VolatileHold | null, bounds: Bounds): ResultCollection {
  if (hold === null || !hold.held) return { state: 'not_held' };
  const r: RegularRead = readRegular(hold.vol, RESULT_PATH, bounds.resultMaxBytes);
  if (r.state === 'absent') return { state: 'absent' };
  if (r.state === 'refused') return { state: 'refused', reason: r.reason, detail: r.detail };
  const found = scanBytes(r.bytes);
  if (found.hit) return { state: 'secret', by: found.by };
  return { state: 'read', bytes: r.bytes };
}


// Read a regular file reached without a link, at most `max` bytes; null if
// it is not one by the time it is opened.
function readFileBounded(path: string, max: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(Math.max(0, max));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, null);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

// The inventory of every writable location (D2 §4.3; SEAM.md §152), made
// after termination and after the result's collection. `delayMs` slows the
// handling of each entry (the engine's test mode only).
export async function inventory(hold: VolatileHold | null, bounds: Bounds, persistenceFlags: string[], delayMs = 0): Promise<Inventory> {
  const out: Inventory = { locations: [], excluded: [], persistence_flags: persistenceFlags, truncated: null, secret: null };
  if (hold === null || !hold.held) return out;
  const started = performance.now();
  let count = 0;
  let retainedBytes = 0;
  const stop = (key: NonNullable<Inventory['truncated']>['key'], value: number) => {
    out.truncated ??= { key, value };
  };
  const screen = (bytes: Buffer, path: string) => {
    const hit = scanBytes(bytes);
    if (hit.hit) out.secret ??= { path, by: hit.by };
  };
  for (const loc of WRITABLE_LOCATIONS) {
    const base = join(hold.vol, loc.at);
    const walk = async (rel: string): Promise<void> => {
      if (out.truncated) return;
      let names: string[];
      try {
        if (!lstatSync(join(base, rel)).isDirectory()) return;
        names = readdirSync(join(base, rel)).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (out.truncated) return;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        if (performance.now() - started > bounds.deadlineMs) return stop('collect_deadline', Math.round(bounds.deadlineMs / 1000));
        if (++count > bounds.entriesMax) return stop('collect_entries_max', bounds.entriesMax);
        const relPath = rel === '' ? name : `${rel}/${name}`;
        const path = `${loc.location}/${relPath}`;
        let st;
        try {
          st = lstatSync(join(base, relPath));
        } catch {
          continue;
        }
        screen(Buffer.from(name), path);
        if (isCredentialPath(path)) {
          out.excluded.push({ path, reason: 'credential' });
          out.locations.push({ path, type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : st.isFIFO() ? 'fifo' : 'other', retained: false });
          continue;
        }
        if (st.isSymbolicLink()) {
          let target = '';
          try {
            target = readlinkSync(join(base, relPath));
          } catch {
            target = '';
          }
          // A link is listed with its target as read, never followed.
          screen(Buffer.from(target), path);
          out.locations.push({ path, type: 'symlink', target: redactText(target), retained: false });
          continue;
        }
        if (st.isDirectory()) {
          out.locations.push({ path, type: 'dir', retained: false });
          await walk(relPath);
          continue;
        }
        if (st.isFIFO()) {
          out.locations.push({ path, type: 'fifo', retained: false });
          continue;
        }
        if (!st.isFile()) {
          out.locations.push({ path, type: 'other', retained: false });
          continue;
        }
        if (retainedBytes + st.size > bounds.filesMaxBytes) {
          out.locations.push({ path, type: 'file', size: st.size, retained: false });
          return stop('provider_files_max_bytes', bounds.filesMaxBytes);
        }
        const bytes = readFileBounded(join(base, relPath), st.size);
        if (bytes === null) {
          out.locations.push({ path, type: 'other', size: st.size, retained: false });
          continue;
        }
        retainedBytes += bytes.length;
        screen(bytes, path);
        out.locations.push({ path, type: 'file', size: st.size, retained: true, content_base64: Buffer.from(redactText(bytes.toString('latin1')), 'latin1').toString('base64') });
      }
    };
    await walk('');
  }
  return out;
}

// The bytes of the `provider_files` record (SEAM.md §152; the shape the
// canaries fill on an entry: locations, persistence flags, exclusions).
export function inventoryRecord(inv: Inventory): Buffer {
  return Buffer.from(
    JSON.stringify({
      locations: inv.locations,
      persistence_flags: inv.persistence_flags,
      excluded: inv.excluded,
      truncated: inv.truncated !== null,
      limit: inv.truncated,
      complete: inv.truncated === null,
    }),
  );
}
