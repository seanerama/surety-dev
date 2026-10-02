// The part of a backup made while the engine runs that reads the store and
// the records (store/backup.ts `backupWhileRunning`), in a worker thread so
// that neither the engine's main thread nor its store worker waits for it.
// The store is copied by SQLite's online backup in one step, so the copy is
// one read snapshot whatever the engine writes meanwhile; it is synced and
// hashed as a stream. The records the snapshot refers to are copied, synced
// and checked against their recorded length and hash. The commits it lists
// are confirmed afterwards, by engine git (store/backup.ts).

import { createHash } from 'node:crypto';
import { createReadStream, closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { type Manifest, closureOf } from './backup.js';

const data = workerData as { home: string; store: string; dir: string };

function syncPath(path: string, flags = constants.O_RDONLY): void {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function digest(path: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    createReadStream(path)
      .on('data', (chunk) => {
        hash.update(chunk);
        bytes += (chunk as Buffer).length;
      })
      .on('error', reject)
      .on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
}

async function run(): Promise<{ manifest: Manifest; repos: [string, string][] }> {
  const target = join(data.dir, 'store.db');
  const source = new Database(data.store, { fileMustExist: true });
  try {
    source.pragma('busy_timeout = 5000');
    // All remaining pages in one step: one read snapshot.
    await source.backup(target, { progress: () => 0x7fffffff });
  } finally {
    source.close();
  }
  syncPath(target);
  const manifest: Manifest = { label: 'complete', store: { file: 'store.db', ...(await digest(target)) }, records: [], git: [] };
  const snapshot = new Database(target, { readonly: true, fileMustExist: true });
  let closure;
  try {
    closure = closureOf(snapshot);
  } finally {
    snapshot.close();
  }
  mkdirSync(join(data.dir, 'records'), { recursive: true, mode: 0o700 });
  for (const r of closure.records) {
    const file = join('records', r.path);
    const from = join(data.home, 'records', r.path);
    if (!existsSync(from)) throw new Error(`record ${r.id} is referred to by the store, and its bytes are missing`);
    mkdirSync(dirname(join(data.dir, file)), { recursive: true, mode: 0o700 });
    copyFileSync(from, join(data.dir, file));
    syncPath(join(data.dir, file));
    const d = await digest(join(data.dir, file));
    if (d.sha256 !== r.sha256 || d.bytes !== r.bytes) throw new Error(`record ${r.id} does not have the hash the store recorded for it`);
    manifest.records.push({ id: r.id, file, ...d });
  }
  syncPath(join(data.dir, 'records'), constants.O_RDONLY | constants.O_DIRECTORY);
  manifest.git = closure.git;
  return { manifest, repos: [...closure.repos.entries()] };
}

run().then(
  (done) => parentPort!.postMessage({ ok: true, ...done }),
  (err: unknown) => parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
);
