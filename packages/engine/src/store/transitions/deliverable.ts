// The downloadable Alpha deliverable, the store's half (SHAPES.md §4; the
// owner's instruction and ruling of 2026-10-29): what the main thread needs
// to build a candidate's package (deploy/deliverable.ts), and the package's
// row, recorded once. A read of these starts no run, raises no decision,
// creates no work item and intends no operation.

import { Refusal } from '../../refusal.js';
import { notFound } from './common.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

export interface DeliverableRow {
  id: string;
  project: string;
  candidate: string;
  revision: string;
  artifact_digest: string;
  format: 'zip';
  version: string;
  filename: string;
  path: string;
  bytes: number;
  sha256: string;
  entries: number;
  // The manifest's JSON text.
  manifest: string;
  output_kind: 'static_site' | 'node_service' | 'unknown';
  built_at: string;
}

export interface DeliverableFacts {
  project: { id: string; name: string; repo: string };
  candidate: { id: string; seq: number; revision: string; nominated_at: string };
  // Whether the candidate's phase gate is satisfied now: its latest `phase`
  // evaluation satisfied and not stale; otherwise why not.
  ready: { ok: boolean; reason: string | null; evaluation: string | null };
  // The packages recorded for the candidate, newest first.
  rows: DeliverableRow[];
  // The runtime versions the project's environments pin (by path), for a
  // node service's prerequisites.
  runtimes: { path: string; sha256: string }[];
}

export function deliverableFacts(db: Db, args: { project: string; candidate: string }): DeliverableFacts {
  const p = db.prepare('SELECT "id", "name", "dev_repo_path" FROM "projects" WHERE "id" = ?').get(args.project) as { id: string; name: string; dev_repo_path: string } | undefined;
  if (!p) throw notFound('project', args.project);
  const c = db.prepare('SELECT "id", "project", "seq", "revision", "nominated_at" FROM "candidates" WHERE "id" = ?').get(args.candidate) as
    | { id: string; project: string; seq: number; revision: string; nominated_at: string }
    | undefined;
  if (!c || c.project !== args.project) throw notFound('candidate', args.candidate);
  const ev = db.prepare(`SELECT "id", "outcome", "stale", "reasons" FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'phase' ORDER BY rowid DESC LIMIT 1`).get(c.id) as
    | { id: string; outcome: string; stale: number; reasons: string }
    | undefined;
  let ready: DeliverableFacts['ready'];
  if (!ev) ready = { ok: false, reason: `No phase gate evaluation of candidate ${c.id} is recorded: its phase is not shown complete.`, evaluation: null };
  else if (ev.outcome !== 'satisfied') {
    let codes: string[] = [];
    try {
      codes = [...new Set((JSON.parse(ev.reasons) as { code: string }[]).map((r) => r.code))];
    } catch {
      codes = [];
    }
    ready = { ok: false, reason: `The latest phase gate evaluation of candidate ${c.id} (${ev.id}) is not satisfied${codes.length > 0 ? `: ${codes.join(', ')}` : ''}.`, evaluation: ev.id };
  } else if (ev.stale === 1) ready = { ok: false, reason: `The latest phase gate evaluation of candidate ${c.id} (${ev.id}) is stale: something it read changed since.`, evaluation: ev.id };
  else ready = { ok: true, reason: null, evaluation: ev.id };
  const rows = db.prepare('SELECT * FROM "deliverables" WHERE "candidate" = ? ORDER BY rowid DESC').all(c.id) as DeliverableRow[];
  const runtimes = (db.prepare(`SELECT "content" FROM "environment_configs" WHERE "project" = ? AND "status" = 'current'`).all(args.project) as { content: string }[])
    .map((r) => (JSON.parse(r.content) as { runtime?: { path: string; sha256: string } }).runtime)
    .filter((r): r is { path: string; sha256: string } => r !== undefined && typeof r.path === 'string');
  return { project: { id: p.id, name: p.name, repo: p.dev_repo_path }, candidate: { id: c.id, seq: c.seq, revision: c.revision, nominated_at: c.nominated_at }, ready, rows, runtimes };
}

// The package recorded, once per candidate and artifact digest; a second
// record of the same is the first row.
export function recordDeliverable(tx: Tx, args: Omit<DeliverableRow, 'id' | 'built_at'>): DeliverableRow {
  const existing = tx.db.prepare('SELECT * FROM "deliverables" WHERE "candidate" = ? AND "artifact_digest" = ?').get(args.candidate, args.artifact_digest) as DeliverableRow | undefined;
  if (existing) {
    if (existing.sha256 !== args.sha256 || existing.bytes !== args.bytes) {
      throw new Refusal(409, 'deliverable_not_ready', `A package of candidate ${args.candidate} is recorded with other bytes than were built now.`, 'Read the deliverable again; nothing new was recorded.', { candidate: args.candidate, deliverable: existing.id });
    }
    return existing;
  }
  const c = tx.db.prepare('SELECT "project" FROM "candidates" WHERE "id" = ?').get(args.candidate) as { project: string } | undefined;
  if (!c || c.project !== args.project) throw notFound('candidate', args.candidate);
  const id = tx.newId('dlv_');
  tx.db
    .prepare(
      `INSERT INTO "deliverables" ("id", "created_at", "project", "candidate", "revision", "artifact_digest", "format", "version", "filename", "path", "bytes", "sha256", "entries", "manifest", "output_kind", "built_at")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, tx.at, args.project, args.candidate, args.revision, args.artifact_digest, args.format, args.version, args.filename, args.path, args.bytes, args.sha256, args.entries, args.manifest, args.output_kind, tx.at);
  tx.emit('deliverable.built', { project: args.project, candidate: args.candidate, deliverable: id }, { artifact_digest: args.artifact_digest, filename: args.filename, bytes: args.bytes, sha256: args.sha256, output_kind: args.output_kind });
  return tx.db.prepare('SELECT * FROM "deliverables" WHERE "id" = ?').get(id) as DeliverableRow;
}
