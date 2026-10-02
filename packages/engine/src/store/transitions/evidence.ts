// What a gate's evidence depends on, kept small so that every module that
// changes evidence can reach it (D1 §9.5; build spec §6 correction 17;
// SEAM.md §72): the staleness of evaluations, the delivery of requirements
// to a candidate, a candidate's ancestry, and the acceptance content hash.

import { canonical, sha256 } from './common.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

// Evaluations that used something that changed are stale (D1 §9.5). Staleness
// is not invalidation: a stale evaluation is computed again, nothing more.
export function markStale(tx: Tx, where: { project?: string; candidate?: string }): void {
  if (where.candidate !== undefined) tx.db.prepare('UPDATE "gate_evaluations" SET "stale" = 1 WHERE "candidate" = ? AND "stale" = 0').run(where.candidate);
  else if (where.project !== undefined) tx.db.prepare('UPDATE "gate_evaluations" SET "stale" = 1 WHERE "project" = ? AND "stale" = 0').run(where.project);
}

// What blocked a gate from outside its evidence has cleared, or appeared: the
// evaluations it applies to are stale (D1 §9.5; E41 item 5). `blockedBy`
// limits this to evaluations that carry one of these reasons.
export function markBlockedStale(tx: Tx, project: string, blockedBy: string[]): void {
  const rows = tx.db.prepare('SELECT "id", "reasons" FROM "gate_evaluations" WHERE "project" = ? AND "stale" = 0').all(project) as { id: string; reasons: string }[];
  for (const r of rows) {
    const codes = (JSON.parse(r.reasons) as { code: string }[]).map((x) => x.code);
    if (codes.some((c) => blockedBy.includes(c))) tx.db.prepare('UPDATE "gate_evaluations" SET "stale" = 1 WHERE "id" = ?').run(r.id);
  }
}

export interface CandidateRow {
  id: string;
  project: string;
  seq: number;
  revision: string;
  lineage: string;
  held_work: string;
  nominated_protected_version: string | null;
  progress: string;
}

export interface StageRow {
  id: string;
  project: string;
  number: number;
  implements: string;
  integrated_revision: string | null;
  work_item: string | null;
}

export interface CheckRow {
  id: string;
  project: string;
  key: string;
  protected_version: string;
  kind: string;
  required: number;
  gate_kinds: string;
  tier_floor: string | null;
  requirement_ids: string;
  runner_class: string;
  requires: string;
  sensitive_areas: string;
}

export const TIER_RANK: Record<string, number> = { T1: 1, T2: 2, T3: 3 };

// Is `ancestor` an ancestor of (or the same commit as) `descendant`, as git
// said and the engine recorded (revision_ancestry)? A pair never recorded is
// not taken for an ancestor: the main thread records every pair a scope
// needs before the scope is built.
export function isAncestorRecorded(db: Db, project: string, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const row = db.prepare('SELECT "is_ancestor" FROM "revision_ancestry" WHERE "project" = ? AND "ancestor" = ? AND "descendant" = ?').get(project, ancestor, descendant) as
    | { is_ancestor: number }
    | undefined;
  return row?.is_ancestor === 1;
}

// The (stage revision, candidate revision) pairs of a project whose ancestry
// is not yet recorded: what the main thread asks git.
export function ancestryPairs(db: Db, args: { project: string }): { ancestor: string; descendant: string }[] {
  return db
    .prepare(
      `SELECT DISTINCT s."integrated_revision" AS "ancestor", c."revision" AS "descendant" FROM "stages" s JOIN "candidates" c ON c."project" = s."project"
       WHERE s."project" = ? AND s."integrated_revision" IS NOT NULL AND s."integrated_revision" <> c."revision"
       AND NOT EXISTS (SELECT 1 FROM "revision_ancestry" a WHERE a."project" = s."project" AND a."ancestor" = s."integrated_revision" AND a."descendant" = c."revision")`,
    )
    .all(args.project) as { ancestor: string; descendant: string }[];
}

export function recordAncestry(tx: Tx, args: { project: string; pairs: { ancestor: string; descendant: string; is_ancestor: boolean }[] }): void {
  const insert = tx.db.prepare(
    'INSERT OR IGNORE INTO "revision_ancestry" ("id", "created_at", "project", "ancestor", "descendant", "is_ancestor") VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const p of args.pairs) insert.run(tx.newId('anc_'), tx.at, args.project, p.ancestor, p.descendant, p.is_ancestor ? 1 : 0);
}

export interface Delivery {
  delivered: string[];
  partial: string[];
  implementsOf: Map<string, string[]>;
}

// Delivery, per candidate (build spec §6 correction 8; SEAM.md §70): a
// requirement no stage implements, or none of whose stages is integrated at
// the candidate's revision or an ancestor of it, is not started; some is
// partial; all is delivered.
export function deliveryOf(db: Db, project: string, candidate: CandidateRow): Delivery {
  const stages = db.prepare('SELECT * FROM "stages" WHERE "project" = ?').all(project) as StageRow[];
  const requirements = (db.prepare('SELECT "id" FROM "requirements" WHERE "project" = ? ORDER BY "id"').all(project) as { id: string }[]).map((r) => r.id);
  const implementsOf = new Map<string, string[]>();
  for (const s of stages) implementsOf.set(s.id, JSON.parse(s.implements) as string[]);
  const integrated = (s: StageRow) => s.integrated_revision !== null && isAncestorRecorded(db, project, s.integrated_revision, candidate.revision);
  const delivered: string[] = [];
  const partial: string[] = [];
  for (const r of requirements) {
    const implementing = stages.filter((s) => implementsOf.get(s.id)!.includes(r));
    if (implementing.length === 0) continue;
    const done = implementing.filter(integrated).length;
    if (done === implementing.length) delivered.push(r);
    else if (done > 0) partial.push(r);
  }
  return { delivered, partial, implementsOf };
}

export function checksOfVersion(db: Db, version: string): CheckRow[] {
  return db.prepare('SELECT * FROM "checks" WHERE "protected_version" = ? ORDER BY "id"').all(version) as CheckRow[];
}

export const gateKindsOf = (c: CheckRow): string[] => JSON.parse(c.gate_kinds) as string[];
export const requirementsOf = (c: CheckRow): string[] => JSON.parse(c.requirement_ids) as string[];

// A required check of the tier (F §5.7): `required`, and no tier floor above
// the project's tier.
export const applies = (c: CheckRow, tier: string): boolean => c.required === 1 && (c.tier_floor === null || TIER_RANK[c.tier_floor]! <= TIER_RANK[tier]!);

// The acceptance content of a candidate (D1 §3.4): its revision, the
// effective protected fingerprint, the requirements delivered to it and the
// checks its obligations require, whatever the gate kind, so that one
// review's sign-off serves the stage gate and the authorization alike.
export function contentHash(db: Db, project: string, candidate: CandidateRow): string {
  const effective = db
    .prepare(`SELECT "id", "fingerprint" FROM "protected_versions" WHERE "project" = ? AND "authorized" = 1 AND "effective_from" IS NOT NULL AND "superseded_by" IS NULL`)
    .get(project) as { id: string; fingerprint: string } | undefined;
  const tier = (db.prepare('SELECT "tier" FROM "projects" WHERE "id" = ?').get(project) as { tier: string }).tier;
  const { delivered } = deliveryOf(db, project, candidate);
  const required = effective
    ? checksOfVersion(db, effective.id)
        .filter((c) => applies(c, tier) && gateKindsOf(c).some((k) => k === 'stage' || k === 'alpha_authorize'))
        .filter((c) => requirementsOf(c).length === 0 || requirementsOf(c).some((r) => delivered.includes(r)))
        .map((c) => c.id)
        .sort()
    : [];
  return sha256(
    canonical({ source_revision: candidate.revision, fingerprint: effective?.fingerprint ?? null, delivered: [...delivered].sort(), required, sensitivity: [] }),
  );
}

export function getCandidate(db: Db, id: string): CandidateRow | undefined {
  return db.prepare('SELECT * FROM "candidates" WHERE "id" = ?').get(id) as CandidateRow | undefined;
}

// The candidates a candidate descends from along the lineage chain
// (D1 §3.3; B02): the one its lineage started from, and so on back.
export function predecessors(db: Db, candidate: CandidateRow): string[] {
  const out: string[] = [];
  let lineage: string | null = candidate.lineage;
  for (let guard = 0; lineage !== null && guard < 10_000; guard++) {
    const row = db.prepare('SELECT "started_from_candidate" FROM "lineages" WHERE "id" = ?').get(lineage) as { started_from_candidate: string | null } | undefined;
    const from = row?.started_from_candidate ?? null;
    if (from === null || out.includes(from)) break;
    out.push(from);
    const prior = getCandidate(db, from);
    lineage = prior?.lineage ?? null;
  }
  return out;
}
