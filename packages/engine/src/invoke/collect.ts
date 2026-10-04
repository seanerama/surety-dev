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

// The writable locations of the role profile (D2 §2.3), as the role sees them,
// and where each is on the volatile filesystem.
export const WRITABLE_LOCATIONS: readonly { location: string; at: string; content: boolean }[] = [
  { location: '/surety/home', at: 'home', content: true },
  { location: '/surety/out', at: 'out', content: true },
  { location: '/tmp', at: 'tmp', content: true },
  // The workspace's changes reach the checkout only through materialization
  // behind the screen (sandbox/materialize.ts): listed here, not retained.
  { location: '/surety/workspace', at: 'upper', content: false },
  { location: '/surety/git/objects', at: 'gitobj/upper', content: false },
];

// The result's path on the volatile filesystem.
export const RESULT_PATH = 'out/result.json';

// A file whose name says it holds a credential is listed and never retained
// (D2 §2.5, §4.3).
const CREDENTIAL_NAMES = [
  /credential/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /^auth\.json$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx)$/i,
];
export const isCredentialName = (name: string): boolean => CREDENTIAL_NAMES.some((re) => re.test(name));

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
  kind: 'file' | 'dir' | 'link' | 'fifo' | 'socket' | 'device' | 'other';
  size: number;
  target?: string;
  sha256?: string;
  content?: string;
  encoding?: 'utf8' | 'base64';
  retained?: boolean;
}

export interface Inventory {
  locations: { location: string; entries: number; bytes: number }[];
  entries: InventoryEntry[];
  excluded: { path: string; reason: 'credential_name' }[];
  persistence_flags: string[];
  // Which bound stopped the walk, if any: the record is then incomplete.
  truncated: { limit: 'collect_entries_max' | 'provider_files_max_bytes' | 'collect_deadline'; value: number } | null;
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

const isUtf8 = (b: Buffer): boolean => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};

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

// The inventory of every writable location (D2 §4.3).
export function inventory(hold: VolatileHold | null, bounds: Bounds, persistenceFlags: string[]): Inventory {
  const out: Inventory = { locations: [], entries: [], excluded: [], persistence_flags: persistenceFlags, truncated: null, secret: null };
  if (hold === null || !hold.held) return out;
  const started = performance.now();
  let count = 0;
  let retainedBytes = 0;
  const stop = (limit: NonNullable<Inventory['truncated']>['limit'], value: number) => {
    out.truncated ??= { limit, value };
  };
  for (const loc of WRITABLE_LOCATIONS) {
    const summary = { location: loc.location, entries: 0, bytes: 0 };
    out.locations.push(summary);
    const base = join(hold.vol, loc.at);
    const walk = (rel: string): void => {
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
        if (performance.now() - started > bounds.deadlineMs) return stop('collect_deadline', bounds.deadlineMs / 1000);
        if (++count > bounds.entriesMax) return stop('collect_entries_max', bounds.entriesMax);
        const relPath = rel === '' ? name : `${rel}/${name}`;
        const path = `${loc.location}/${relPath}`;
        let st;
        try {
          st = lstatSync(join(base, relPath));
        } catch {
          continue;
        }
        summary.entries++;
        summary.bytes += st.isFile() ? st.size : 0;
        if (st.isSymbolicLink()) {
          let target = '';
          try {
            target = readlinkSync(join(base, relPath));
          } catch {
            target = '';
          }
          // A link is recorded with its target, never followed.
          out.entries.push({ path, kind: 'link', size: st.size, target: redactText(target) });
          if (scanBytes(Buffer.from(target)).hit) out.secret ??= { path, by: scanBytes(Buffer.from(target)).by };
          continue;
        }
        if (scanBytes(Buffer.from(name)).hit) out.secret ??= { path, by: scanBytes(Buffer.from(name)).by };
        if (st.isDirectory()) {
          out.entries.push({ path, kind: 'dir', size: 0 });
          walk(relPath);
          continue;
        }
        if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
          // Listed, never opened.
          out.entries.push({ path, kind: st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket' : 'device', size: 0 });
          continue;
        }
        if (!st.isFile()) {
          out.entries.push({ path, kind: 'other', size: 0 });
          continue;
        }
        if (isCredentialName(name)) {
          out.excluded.push({ path, reason: 'credential_name' });
          out.entries.push({ path, kind: 'file', size: st.size, retained: false });
          continue;
        }
        if (!loc.content) {
          out.entries.push({ path, kind: 'file', size: st.size, retained: false });
          continue;
        }
        if (retainedBytes + st.size > bounds.filesMaxBytes) {
          out.entries.push({ path, kind: 'file', size: st.size, retained: false });
          return stop('provider_files_max_bytes', bounds.filesMaxBytes);
        }
        const bytes = readFileBounded(join(base, relPath), st.size);
        if (bytes === null) {
          out.entries.push({ path, kind: 'other', size: st.size, retained: false });
          continue;
        }
        retainedBytes += bytes.length;
        const hit = scanBytes(bytes);
        if (hit.hit) out.secret ??= { path, by: hit.by };
        const utf8 = isUtf8(bytes);
        out.entries.push({
          path,
          kind: 'file',
          size: st.size,
          retained: true,
          encoding: utf8 ? 'utf8' : 'base64',
          content: utf8 ? redactText(bytes.toString('utf8')) : bytes.toString('base64'),
        });
      }
    };
    walk('');
  }
  return out;
}

// The bytes of the `provider_files` record (D2 §4.3; the shape the canaries
// fill on an entry: locations, persistence flags, exclusions).
export function inventoryRecord(inv: Inventory, about: { domain: string; run: string; invocation: string }): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        ...about,
        locations: inv.locations,
        persistence_flags: inv.persistence_flags,
        excluded: inv.excluded,
        entries: inv.entries,
        truncated: inv.truncated !== null,
        limit: inv.truncated,
        complete: inv.truncated === null,
      },
      null,
      1,
    ),
  );
}
