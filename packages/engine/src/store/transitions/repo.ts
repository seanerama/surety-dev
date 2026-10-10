// What the store knows of a project's repository (D1 §§3.3, 3.5, 7.2, 7.6):
// the ref registry, managed checkouts, lineages and revisions, and the
// out-of-band observations integrity records. Every function here runs
// inside the caller's transaction.

import { notFound } from './common.js';
import { type DecisionRow, invalidateDecision, raiseDecision } from './decisions.js';
import { oobOptions } from './queue.js';
import { markStale } from './evidence.js';
import type { Tx } from './tx.js';

export type RefKind = 'integration' | 'lineage' | 'nomination' | 'recovery' | 'oob' | 'keep';

export interface RegistryRow {
  id: string;
  project: string;
  ref: string;
  kind: RefKind;
  expected_oid: string;
  immutable: number;
}

export interface CheckoutRow {
  id: string;
  project: string;
  kind: 'integration_worktree' | 'run_workspace';
  path: string;
  baseline: string;
  owner_run: string | null;
  released_at: string | null;
}

export interface OobRow {
  id: string;
  project: string;
  subject_kind: 'ref' | 'checkout' | 'repository' | 'environment';
  ref: string | null;
  checkout: string | null;
  expected: string;
  found: string | null;
  disposition: string | null;
  decision: string;
  closed_at: string | null;
}

export interface Baseline {
  head: string;
  index_hash: string;
  tracked_tree_hash: string;
}

// A per-project counter kept in projects.seq_counters (keep and oob refs).
export function nextCounter(tx: Tx, project: string, name: string): number {
  const row = tx.db.prepare('SELECT "seq_counters" FROM "projects" WHERE "id" = ?').get(project) as { seq_counters: string } | undefined;
  if (!row) throw notFound('project', project);
  const counters = JSON.parse(row.seq_counters) as Record<string, number>;
  const next = (counters[name] ?? 0) + 1;
  counters[name] = next;
  tx.db.prepare('UPDATE "projects" SET "seq_counters" = ? WHERE "id" = ?').run(JSON.stringify(counters), project);
  return next;
}

export function registryRow(tx: Tx, project: string, ref: string): RegistryRow | undefined {
  return tx.db.prepare('SELECT * FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(project, ref) as RegistryRow | undefined;
}

// Register a ref, or move the expected commit of one already registered.
// An immutable ref's expected commit never changes.
export function registerRef(tx: Tx, args: { project: string; ref: string; kind: RefKind; expected: string; immutable?: boolean }): RegistryRow {
  const existing = registryRow(tx, args.project, args.ref);
  if (existing) {
    if (existing.immutable === 0 && existing.expected_oid !== args.expected) {
      tx.db.prepare('UPDATE "ref_registry" SET "expected_oid" = ? WHERE "id" = ?').run(args.expected, existing.id);
    }
    return registryRow(tx, args.project, args.ref)!;
  }
  tx.db
    .prepare('INSERT INTO "ref_registry" ("id", "created_at", "project", "ref", "kind", "expected_oid", "immutable") VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tx.newId('ref_'), tx.at, args.project, args.ref, args.kind, args.expected, args.immutable ? 1 : 0);
  return registryRow(tx, args.project, args.ref)!;
}

export const integrationRef = (branch: string): string => `refs/heads/${branch}`;

export function projectRepoRow(tx: Tx, project: string): { id: string; dev_repo_path: string; integration_branch: string; tier: string; registration_state: string } {
  const row = tx.db.prepare('SELECT "id", "dev_repo_path", "integration_branch", "tier", "registration_state" FROM "projects" WHERE "id" = ?').get(project) as
    | { id: string; dev_repo_path: string; integration_branch: string; tier: string; registration_state: string }
    | undefined;
  if (!row) throw notFound('project', project);
  return row;
}

// The project's open lineage on its integration branch, opened if it has
// none (a project created through the API needs one as soon as anything is
// recorded on a lineage; SEAM.md §42).
export function openLineage(tx: Tx, project: string): string {
  const p = projectRepoRow(tx, project);
  const row = tx.db.prepare('SELECT "id" FROM "lineages" WHERE "project" = ? AND "branch" = ? AND "open" = 1').get(project, p.integration_branch) as { id: string } | undefined;
  if (row) return row.id;
  const id = tx.newId('lin_');
  tx.db.prepare('INSERT INTO "lineages" ("id", "created_at", "project", "branch", "started_from_candidate", "open") VALUES (?, ?, ?, ?, NULL, 1)').run(id, tx.at, project, p.integration_branch);
  return id;
}

export function recordRevision(tx: Tx, args: { project: string; sha: string; parent: string | null; kind: string; run: string | null }): string {
  const lineage = openLineage(tx, args.project);
  const id = tx.newId('rev_');
  tx.db
    .prepare('INSERT INTO "revisions" ("id", "created_at", "project", "sha", "lineage", "parent_sha", "kind", "created_by_run", "recorded_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, tx.at, args.project, args.sha, lineage, args.parent, args.kind, args.run, tx.at);
  tx.emit('revision.recorded', { project: args.project, revision: id, run: args.run }, { sha: args.sha, parent_sha: args.parent, kind: args.kind });
  return id;
}

// ---- managed checkouts ---------------------------------------------------------

export function addCheckout(tx: Tx, args: { project: string; kind: CheckoutRow['kind']; path: string; baseline: Baseline; run: string | null }): string {
  const id = tx.newId('mco_');
  tx.db
    .prepare('INSERT INTO "managed_checkouts" ("id", "created_at", "project", "kind", "path", "baseline", "owner_run") VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, tx.at, args.project, args.kind, args.path, JSON.stringify(args.baseline), args.run);
  return id;
}

export function releaseCheckouts(tx: Tx, where: { run?: string; id?: string }): void {
  if (where.run !== undefined) tx.db.prepare('UPDATE "managed_checkouts" SET "released_at" = ? WHERE "owner_run" = ? AND "released_at" IS NULL').run(tx.at, where.run);
  if (where.id !== undefined) tx.db.prepare('UPDATE "managed_checkouts" SET "released_at" = ? WHERE "id" = ? AND "released_at" IS NULL').run(tx.at, where.id);
}

// A run's workspace, re-baselined when the run ends: what the role left is
// the baseline integrity compares it with from then on.
export function rebaselineRunCheckout(tx: Tx, run: string, baseline: Baseline): void {
  tx.db.prepare('UPDATE "managed_checkouts" SET "baseline" = ? WHERE "owner_run" = ? AND "released_at" IS NULL').run(JSON.stringify(baseline), run);
}

// ---- out-of-band observations (D1 §7.6; SEAM.md §32) ---------------------------------

export interface Observation {
  subject: 'ref' | 'checkout' | 'repository';
  ref?: string; // registry row id
  checkout?: string; // managed checkout id
  expected: string;
  found: string | null;
}

export function openObservation(tx: Tx, project: string, o: Pick<Observation, 'subject' | 'ref' | 'checkout'>): OobRow | undefined {
  return tx.db
    .prepare(
      `SELECT * FROM "out_of_band_changes" WHERE "project" = ? AND "subject_kind" = ? AND "disposition" IS NULL AND "closed_at" IS NULL
       AND ("ref" IS ? OR "ref" = ?) AND ("checkout" IS ? OR "checkout" = ?)`,
    )
    .get(project, o.subject, o.ref ?? null, o.ref ?? null, o.checkout ?? null, o.checkout ?? null) as OobRow | undefined;
}

// Record an observation, once: one that is already recorded and
// unreconciled is not recorded again. Returns the row.
export function recordObservation(tx: Tx, project: string, o: Observation): OobRow {
  const existing = openObservation(tx, project, o);
  if (existing && existing.found === o.found) return existing;
  if (existing) {
    // What is there now is not what was observed: the old observation, and
    // the question about it, are closed, and what is there now is observed
    // and asked about (SEAM.md §79).
    tx.db.prepare('UPDATE "out_of_band_changes" SET "closed_at" = ? WHERE "id" = ?').run(tx.at, existing.id);
    const d = tx.db.prepare('SELECT * FROM "decisions" WHERE "id" = ?').get(existing.decision) as DecisionRow;
    invalidateDecision(tx, d, 'the subject changed again');
  }
  const id = tx.newId('oob_');
  let what = 'The repository cannot be read: nothing about it can be established until it can.';
  if (o.subject === 'ref') {
    const row = tx.db.prepare('SELECT "ref" FROM "ref_registry" WHERE "id" = ?').get(o.ref) as { ref: string };
    what = `The registered ref ${row.ref} is ${o.found === null ? 'gone' : `at ${o.found}`}, where the engine expects ${o.expected}. Nothing was absorbed or undone.`;
  } else if (o.subject === 'checkout') {
    const row = tx.db.prepare('SELECT "path" FROM "managed_checkouts" WHERE "id" = ?').get(o.checkout) as { path: string };
    what = `The managed checkout ${row.path} differs from its baseline. Nothing in it was changed.`;
  }
  const decision = raiseDecision(tx, {
    project,
    kind: 'out_of_band_change',
    subjectType: 'out_of_band_change',
    subjectId: id,
    question: what,
    options: oobOptions(tx, { subject_kind: o.subject, ref: o.ref ?? null, found: o.found }),
    manifest: { subject_kind: o.subject, expected: o.expected, found: o.found },
  });
  tx.db
    .prepare(
      `INSERT INTO "out_of_band_changes" ("id", "created_at", "project", "subject_kind", "ref", "checkout", "expected", "found", "detected_at", "decision")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, tx.at, project, o.subject, o.ref ?? null, o.checkout ?? null, o.expected, o.found, tx.at, decision.id);
  tx.emit('repo.out_of_band', { project, out_of_band_change: id }, { subject_kind: o.subject, expected: o.expected, found: o.found, decision: decision.id });
  // An observation is an input of every evaluation of the project (D1 §9.5).
  markStale(tx, { project });
  return tx.db.prepare('SELECT * FROM "out_of_band_changes" WHERE "id" = ?').get(id) as OobRow;
}

// The repository can be read again: its observation is closed, its decision
// invalidated (the condition is gone), and repo.reconciled emitted.
export function closeRepositoryObservation(tx: Tx, project: string): boolean {
  const row = openObservation(tx, project, { subject: 'repository' });
  if (!row) return false;
  tx.db.prepare('UPDATE "out_of_band_changes" SET "closed_at" = ? WHERE "id" = ?').run(tx.at, row.id);
  const d = tx.db.prepare('SELECT * FROM "decisions" WHERE "id" = ?').get(row.decision) as DecisionRow;
  invalidateDecision(tx, d, 'the repository can be read again');
  tx.emit('repo.reconciled', { project, out_of_band_change: row.id }, { subject_kind: 'repository', closed: 'readable' });
  markStale(tx, { project });
  return true;
}

// Does an unreconciled observation of the integration branch or of the
// repository hold the project (SEAM.md §32, "What is blocked")?
export function blockingObservation(db: Tx['db'], project: string): OobRow | undefined {
  return db
    .prepare(
      `SELECT o.* FROM "out_of_band_changes" o LEFT JOIN "ref_registry" r ON r."id" = o."ref"
       WHERE o."project" = ? AND o."disposition" IS NULL AND o."closed_at" IS NULL
       AND (o."subject_kind" = 'repository' OR (o."subject_kind" = 'ref' AND r."kind" = 'integration'))
       ORDER BY o."subject_kind" DESC LIMIT 1`,
    )
    .get(project) as OobRow | undefined;
}

// The registered nomination ref of a candidate (D1 §7.7; SEAM.md §42).
export const nominationRef = (seq: number): string => `refs/surety/cand/${seq}`;

// Does an unreconciled observation of a candidate's own nomination ref hold
// that candidate's gates (D1 §§7.6 "all block affected gates", 9.3(3); row
// M24)? The marker names the revision the candidate is; while it has been
// moved or deleted out of band and nobody has answered, what the candidate's
// gates would vouch for is not established.
export function candidateObservation(db: Tx['db'], project: string, seq: number): OobRow | undefined {
  return db
    .prepare(
      `SELECT o.* FROM "out_of_band_changes" o JOIN "ref_registry" r ON r."id" = o."ref"
       WHERE o."project" = ? AND o."subject_kind" = 'ref' AND o."disposition" IS NULL AND o."closed_at" IS NULL
       AND r."kind" = 'nomination' AND r."ref" = ?
       ORDER BY o."detected_at", o."id" LIMIT 1`,
    )
    .get(project, nominationRef(seq)) as OobRow | undefined;
}
