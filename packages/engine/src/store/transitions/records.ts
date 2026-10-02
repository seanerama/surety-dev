// Records and stream chunk receipts, the store's side (D1 §§3.6, 14; build
// spec §6 correction 21; SEAM.md §§56-58). The bytes are written, synced and
// renamed on the main thread with no transaction open; each transition here
// records what is already durable.

import { illegal, notFound } from './common.js';
import { projectPolicy } from './settings.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

export interface RecordRow {
  id: string;
  created_at: string;
  project: string;
  kind: string;
  path: string | null;
  sha256: string | null;
  bytes: number | null;
  redaction_version: string;
  published: number;
  post_scan: 'pending' | 'clean' | 'hit';
  post_scan_finding: string | null;
  retain_until: string | null;
  run: string | null;
  published_at: string | null;
  missing_at: string | null;
}

function mustRecord(tx: Tx, id: string): RecordRow {
  const row = tx.db.prepare('SELECT * FROM "records" WHERE "id" = ?').get(id) as RecordRow | undefined;
  if (!row) throw notFound('record', id);
  return row;
}

// A stream's identity before publication (correction 21): its row,
// unpublished, with its hash and length unknown, naming the file its chunks
// are written to.
export function registerStream(tx: Tx, args: { id: string; project: string; run: string; kind: string; path: string; redactionVersion: string }): { id: string } {
  tx.db
    .prepare(
      `INSERT INTO "records" ("id", "created_at", "project", "kind", "path", "sha256", "bytes", "redaction_version", "published", "post_scan", "run")
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0, 'pending', ?)`,
    )
    .run(args.id, tx.at, args.project, args.kind, args.path, args.redactionVersion, args.run);
  return { id: args.id };
}

// A chunk whose bytes are synced in the stream's file. Receipts are
// contiguous from offset 0, and only an unpublished stream takes one.
export function chunkReceipt(tx: Tx, args: { record: string; offset: number; length: number; sha256: string }): { id: string } {
  const record = mustRecord(tx, args.record);
  if (record.published === 1) throw illegal('A chunk receipt for a published record', { record: record.id });
  const { end } = tx.db.prepare('SELECT COALESCE(SUM("length"), 0) AS "end" FROM "stream_chunk_receipts" WHERE "record" = ?').get(record.id) as { end: number };
  if (args.offset !== end) throw illegal(`A chunk at ${args.offset} of a stream whose receipts end at ${end}`, { record: record.id });
  const id = tx.newId('chunk_');
  tx.db
    .prepare('INSERT INTO "stream_chunk_receipts" ("id", "created_at", "project", "record", "offset", "length", "sha256") VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, tx.at, record.project, record.id, args.offset, args.length, args.sha256);
  return { id };
}

// The stream has ended and its file is synced under its immutable name: the
// record is published. Its receipts cover exactly its bytes.
export function publishStream(tx: Tx, args: { record: string; path: string; sha256: string; bytes: number }): void {
  const record = mustRecord(tx, args.record);
  if (record.published === 1) return;
  const { end } = tx.db.prepare('SELECT COALESCE(SUM("length"), 0) AS "end" FROM "stream_chunk_receipts" WHERE "record" = ?').get(record.id) as { end: number };
  if (end !== args.bytes) throw illegal(`Publishing a stream of ${args.bytes} bytes whose receipts cover ${end}`, { record: record.id });
  tx.db
    .prepare('UPDATE "records" SET "published" = 1, "sha256" = ?, "bytes" = ?, "path" = ?, "published_at" = ? WHERE "id" = ?')
    .run(args.sha256, args.bytes, args.path, tx.at, record.id);
  tx.emit('record.written', { project: record.project, record: record.id, run: record.run }, { kind: record.kind, bytes: args.bytes, sha256: args.sha256 });
}

// A record written whole (a result): its file is synced under its immutable
// name before this, and the row is published at once.
export function publishWhole(tx: Tx, args: { id: string; project: string; run: string | null; kind: string; path: string; sha256: string; bytes: number; redactionVersion: string }): void {
  tx.db
    .prepare(
      `INSERT INTO "records" ("id", "created_at", "project", "kind", "path", "sha256", "bytes", "redaction_version", "published", "post_scan", "run", "published_at")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)`,
    )
    .run(args.id, tx.at, args.project, args.kind, args.path, args.sha256, args.bytes, args.redactionVersion, args.run, tx.at);
  tx.emit('record.written', { project: args.project, record: args.id, run: args.run }, { kind: args.kind, bytes: args.bytes, sha256: args.sha256 });
}

// What the post-write scan found in the stored bytes. A hit is final: the
// record is no longer served (SEAM.md §57).
export function recordScan(tx: Tx, args: { record: string; hit: boolean; by: string | null }): void {
  const record = mustRecord(tx, args.record);
  if (record.post_scan === 'hit') return;
  if (!args.hit) {
    if (record.post_scan === 'pending') tx.db.prepare(`UPDATE "records" SET "post_scan" = 'clean' WHERE "id" = ?`).run(record.id);
    return;
  }
  tx.db.prepare(`UPDATE "records" SET "post_scan" = 'hit' WHERE "id" = ?`).run(record.id);
  tx.emit('record.secret_found', { project: record.project, record: record.id }, { by: args.by });
}

// Is a record referred to by something live? In slice 4 the one such thing
// is a run whose work item is not terminal (SEAM.md §58).
const REFERENCED = `EXISTS (SELECT 1 FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item"
  WHERE r."id" = rec."run" AND w."status" NOT IN ('complete', 'cancelled'))`;

// Published records whose retention has passed and that nothing refers to.
export function expirableRecords(db: Db, now: string): { id: string; project: string; path: string }[] {
  const rows = db
    .prepare(`SELECT rec."id", rec."project", rec."path", rec."created_at" FROM "records" rec WHERE rec."published" = 1 AND rec."path" IS NOT NULL AND NOT ${REFERENCED}`)
    .all() as { id: string; project: string; path: string; created_at: string }[];
  const days = new Map<string, number>();
  const nowMs = Date.parse(now);
  return rows.filter((r) => {
    if (!days.has(r.project)) days.set(r.project, projectPolicy(db, r.project).record_retention_days!);
    return Date.parse(r.created_at) + days.get(r.project)! * 86_400_000 <= nowMs;
  });
}

// The record expires: its row is kept, with its identity, and without its
// content. Returns the path whose file is to be removed, or null if the
// record is not (or no longer) one that expires.
export function expireRecord(tx: Tx, args: { record: string }): { path: string | null } {
  const still = expirableRecords(tx.db, tx.at).find((r) => r.id === args.record);
  if (!still) return { path: null };
  tx.db.prepare('UPDATE "records" SET "path" = NULL WHERE "id" = ?').run(still.id);
  tx.emit('record.expired', { project: still.project, record: still.id }, { path: still.path });
  return { path: still.path };
}

// Published, unexpired records that something refers to: what the audit at
// startup checks (D1 §16.1 step 5).
export function referencedRecords(db: Db): { id: string; path: string; sha256: string; bytes: number; missing_at: string | null }[] {
  return db
    .prepare(`SELECT rec."id", rec."path", rec."sha256", rec."bytes", rec."missing_at" FROM "records" rec WHERE rec."published" = 1 AND rec."path" IS NOT NULL AND ${REFERENCED} ORDER BY rec."created_at"`)
    .all() as { id: string; path: string; sha256: string; bytes: number; missing_at: string | null }[];
}

// The audit found a referenced record's bytes missing or not of its hash, or
// whole again.
export function recordAudited(tx: Tx, args: { record: string; whole: boolean; why?: string }): void {
  const record = mustRecord(tx, args.record);
  if (args.whole) {
    if (record.missing_at !== null) tx.db.prepare('UPDATE "records" SET "missing_at" = NULL WHERE "id" = ?').run(record.id);
    return;
  }
  if (record.missing_at !== null) return;
  tx.db.prepare('UPDATE "records" SET "missing_at" = ? WHERE "id" = ?').run(tx.at, record.id);
  tx.emit('record.missing', { project: record.project, record: record.id }, { why: args.why ?? null });
}

// Records the post-write scan is run over: every published record whose
// bytes are still stored.
export function storedRecords(db: Db): { id: string; path: string }[] {
  return db.prepare('SELECT "id", "path" FROM "records" WHERE "published" = 1 AND "path" IS NOT NULL ORDER BY "created_at"').all() as { id: string; path: string }[];
}

export function getRecord(db: Db, args: { project: string; record: string }): RecordRow {
  const row = db.prepare('SELECT * FROM "records" WHERE "id" = ?').get(args.record) as RecordRow | undefined;
  if (!row || row.project !== args.project) throw notFound('record', args.record);
  return row;
}
