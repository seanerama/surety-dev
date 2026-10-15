// The conformance stage (D6 §8.1 steps 5 and 6, §8.3; K11; B11, B12; A.5;
// E6; E142 item 3; SEAM.md §§382, 385). Store side: every function here
// runs in a transaction; the digests it compares were read with git on the
// main thread before it (gates/prepare.ts).
//
// The lifecycle stands where stage-build work stands for any other stage,
// on the stage itself (A.5 ConformanceStageState), with no work item and no
// `stage_build` at any point:
//
//   source_bound   at publication: the application source bound to the
//                  immutable adoption revision A, the stage `integrated` at
//                  the integration head of that moment;
//   nominated      a candidate holds it (the engine's own nomination,
//                  `engine_cadence`, once the phase's authoring is ready);
//   verifying      its stage gate is evaluated and not yet decided;
//   conformed      its stage gate satisfied on the approved conformance set;
//   blocked        a required check failed, the source moved, or a finding
//                  blocks: visibly, until a governed correction (a protected
//                  correction of the check, or a specification change) gives
//                  fresh evidence. No repair-before-conformance route exists
//                  (E142 item 3), and a `fix` disposition records and
//                  resolves nothing (B12).
//
// Reading of D6 §8.1 step 5 (the coordinator's ruling, 2026-10-12):
// publication binds the source; c-1 is nominated once the phase's authoring
// is ready, so that its checks run under the applied protected version.

import { parseJson } from '../store/transitions/common.js';
import type { CandidateRow } from '../store/transitions/evidence.js';
import { integrationRef, registryRow, projectRepoRow } from '../store/transitions/repo.js';
import type { Tx } from '../store/transitions/tx.js';
import { illegal } from '../store/transitions/common.js';
import { adoptionOf } from './records.js';

type Db = Tx['db'];

export interface ConformanceStageRow {
  id: string;
  project: string;
  phase_plan: string;
  created_at: string;
  status: string;
  implements: string;
  source_revision: string | null;
  conformance_source_digest: string | null;
  conformance_state: string | null;
  cancelled_at: string | null;
}

export const conformanceStagesOf = (db: Db, project: string): ConformanceStageRow[] =>
  db.prepare('SELECT * FROM "stages" WHERE "project" = ? AND "conformance" = 1 AND "cancelled_at" IS NULL ORDER BY rowid').all(project) as ConformanceStageRow[];

export const isConformanceStage = (db: Db, stage: string | null): boolean => stage !== null && db.prepare('SELECT 1 FROM "stages" WHERE "id" = ? AND "conformance" = 1').get(stage) !== undefined;

// At publication (K11): no stage_build; the source bound to A.
export function bindConformanceStage(tx: Tx, args: { project: string; stage: string; head: string }): void {
  const a = adoptionOf(tx.db, args.project);
  if (!a) throw illegal('binding a conformance stage of a project that was not adopted', { project: args.project, stage: args.stage });
  tx.db
    .prepare(`UPDATE "stages" SET "status" = 'integrated', "integrated_revision" = ?, "source_revision" = ?, "conformance_source_digest" = ?, "conformance_state" = 'source_bound' WHERE "id" = ?`)
    .run(args.head, a.pinned_revision, a.source_digest, args.stage);
  tx.emit('conformance.source_bound', { project: args.project, stage: args.stage }, { source_revision: a.pinned_revision, conformance_source_digest: a.source_digest });
  tx.emit('stage.conformance_integrated', { project: args.project, stage: args.stage }, { integrated_revision: args.head, source_revision: a.pinned_revision });
}

// The candidates a conformance stage is held by: every candidate nominated
// after its publication (its source binding precedes them all; its own
// state, not a work item, says whether it is done).
// Whether a candidate of the project was nominated since the first event
// about the stage, by the event log's order (the slice-36 review's M3).
export function nominatedSince(db: Db, project: string, stage: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM "events" n WHERE n."type" = 'candidate.nominated' AND json_extract(n."subject", '$.project') = ?
           AND n."seq" >= COALESCE((SELECT MIN(e."seq") FROM "events" e WHERE json_extract(e."subject", '$.stage') = ?), 0) LIMIT 1`,
      )
      .get(project, stage) !== undefined
  );
}

// Which came first is read from the event log's order, never from wall time
// (D1's monotonic rule; BS5 §4.1 rule 17): the candidate's nomination and
// the first event about the stage. Where either is not found, the stage is
// taken to hold the candidate (unknown fails closed).
export function conformanceHeldBy(db: Db, candidate: CandidateRow): string[] {
  if (!db.prepare('SELECT 1 FROM "candidates" WHERE "id" = ?').get(candidate.id)) return [];
  const nominated = (db.prepare(`SELECT MIN("seq") AS s FROM "events" WHERE "type" = 'candidate.nominated' AND json_extract("subject", '$.candidate') = ?`).get(candidate.id) as { s: number | null }).s;
  return conformanceStagesOf(db, candidate.project)
    .filter((st) => {
      const first = (db.prepare(`SELECT MIN("seq") AS s FROM "events" WHERE json_extract("subject", '$.stage') = ?`).get(st.id) as { s: number | null }).s;
      return nominated === null || first === null || first <= nominated;
    })
    .map((st) => st.id);
}

// The nomination owed: once the phase's authoring is ready, the head is
// nominated once by the engine's cadence, at every tier (at T1 the phase's
// own nomination is the same one). A reading of D6 §8.1 step 5, accepted by
// the coordinator on 2026-10-12: publication binds the source to A; c-1 is
// nominated here, once authoring is ready, so its checks run under the
// applied protected version rather than at the instant of publication.
export function conformanceNominationDue(tx: Tx, args: { project: string }): void {
  for (const s of conformanceStagesOf(tx.db, args.project)) {
    if (s.conformance_state !== 'source_bound') continue;
    const plan = tx.db.prepare('SELECT "authoring_ready_at", "status", "active" FROM "phase_plans" WHERE "id" = ?').get(s.phase_plan) as { authoring_ready_at: string | null; status: string; active: number } | undefined;
    if (!plan || plan.authoring_ready_at === null || plan.status !== 'published' || plan.active !== 1) continue;
    // A candidate nominated after the stage, by the event log's order, not
    // by wall time (the slice-36 review's M3; as conformanceHeldBy).
    const held = nominatedSince(tx.db, args.project, s.id);
    if (held) continue;
    const due = (tx.db.prepare('SELECT "nomination_due" FROM "projects" WHERE "id" = ?').get(args.project) as { nomination_due: string | null }).nomination_due;
    if (due !== null) continue;
    const p = projectRepoRow(tx, args.project);
    const head = registryRow(tx, args.project, integrationRef(p.integration_branch))?.expected_oid ?? null;
    if (head === null) continue;
    tx.db.prepare('UPDATE "projects" SET "nomination_due" = ? WHERE "id" = ?').run(JSON.stringify({ revision: head, by: 'engine_cadence', chain: 0 }), args.project);
  }
}

// A nomination finalized: a conformance stage still source_bound is now held.
export function conformanceNominated(tx: Tx, args: { project: string; candidate: string }): void {
  tx.db.prepare(`UPDATE "stages" SET "conformance_state" = 'nominated' WHERE "project" = ? AND "conformance" = 1 AND "conformance_state" = 'source_bound' AND "cancelled_at" IS NULL`).run(args.project);
}

// ---- the source projection (B11) ----------------------------------------------------------

// What the main thread reads before an evaluation of a project with a
// conformance stage: the revisions whose projections it digests.
export function conformanceFactsRead(db: Db, args: { project: string; candidate: string }): { repo: string; branch: string; candidate_revision: string; head: string | null; stages: { id: string; source_revision: string | null }[] } | null {
  const stages = conformanceStagesOf(db, args.project);
  if (stages.length === 0) return null;
  const c = db.prepare('SELECT "revision" FROM "candidates" WHERE "id" = ? AND "project" = ?').get(args.candidate, args.project) as { revision: string } | undefined;
  if (!c) return null;
  const p = db.prepare('SELECT "dev_repo_path", "integration_branch" FROM "projects" WHERE "id" = ?').get(args.project) as { dev_repo_path: string; integration_branch: string };
  const head = (db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(args.project, integrationRef(p.integration_branch)) as { expected_oid: string } | undefined)?.expected_oid ?? null;
  return { repo: p.dev_repo_path, branch: p.integration_branch, candidate_revision: c.revision, head, stages: stages.map((s) => ({ id: s.id, source_revision: s.source_revision })) };
}

// The digests the main thread read: null where git could not say.
export interface ConformanceFacts {
  candidate_revision: string;
  candidate_digest: string | null;
  head: string | null;
  head_digest: string | null;
  // stage id → the digest of its bound source revision as read now.
  source_digests: Record<string, string | null>;
}

// The candidate's projection digest, recorded once read (the Alpha barrier
// reads it; never a guess).
export function recordCandidateDigest(tx: Tx, args: { candidate: string; facts: ConformanceFacts | undefined }): void {
  const f = args.facts;
  if (!f || f.candidate_digest === null) return;
  tx.db.prepare('UPDATE "candidates" SET "source_digest" = ? WHERE "id" = ? AND "revision" = ? AND "source_digest" IS NULL').run(f.candidate_digest, args.candidate, f.candidate_revision);
}

// D6 §8.1 step 5 (B11): `CONFORMANCE_SOURCE_MOVED` for a conformance stage's
// gate when the candidate's application source is not A's, when the
// integration branch carries an application-source change (no source change
// is made in phase 1), when the stage's binding is not the pinned A or no
// longer has A's digest, and whenever one of these was not read (unknown is
// moved, never equal). The subjects name what moved.
export function sourceMoved(db: Db, args: { project: string; stage: string; facts: ConformanceFacts | undefined }): string[] {
  const s = db.prepare('SELECT * FROM "stages" WHERE "id" = ?').get(args.stage) as ConformanceStageRow | undefined;
  const a = adoptionOf(db, args.project);
  if (!s || !a) return ['adoption'];
  const out: string[] = [];
  const recorded = s.conformance_source_digest;
  if (s.source_revision !== a.pinned_revision) out.push(`source_revision:${s.source_revision ?? 'none'}`);
  if (recorded === null || recorded !== a.source_digest) out.push('conformance_source_digest');
  const f = args.facts;
  if (!f) return [...out, 'unread:projection'];
  const bound = f.source_digests[s.id];
  if (bound === undefined || bound === null) out.push('unread:source_revision');
  else if (bound !== recorded) out.push(`source_revision:${s.source_revision}`);
  if (f.candidate_digest === null) out.push('unread:candidate');
  else if (f.candidate_digest !== recorded) out.push(`candidate:${f.candidate_revision}`);
  if (f.head_digest === null) out.push('unread:integration_head');
  else if (f.head_digest !== recorded) out.push(`integration_head:${f.head ?? 'none'}`);
  return out;
}

// What a conformance stage's gate evaluation rests on of its source (the
// driver's rulings on M413 (d) and M408 (e), slice 37): the commit the
// engine expects the integration branch at (the registry's), the head the
// evaluation read, the number of adoptions of out-of-band moves of the
// integration branch so far, and the stage's recorded binding.
export function conformanceSnapshot(db: Db, stage: string, facts: ConformanceFacts | undefined): { expected: string | null; head: string | null; adopted: number; source_revision: string | null; source_digest: string | null } {
  const s = db.prepare('SELECT "project", "source_revision", "conformance_source_digest" FROM "stages" WHERE "id" = ?').get(stage) as
    | { project: string; source_revision: string | null; conformance_source_digest: string | null }
    | undefined;
  return {
    expected: s ? integrationExpected(db, s.project) : null,
    head: facts?.head ?? null,
    adopted: s ? integrationAdoptions(db, s.project) : 0,
    source_revision: s?.source_revision ?? null,
    source_digest: s?.conformance_source_digest ?? null,
  };
}

// Out-of-band moves of the integration branch the owner adopted (a
// commit's, or a checkout's edits'): the source changes no engine run made.
function integrationAdoptions(db: Db, project: string): number {
  const repo = db.prepare('SELECT "integration_branch" FROM "projects" WHERE "id" = ?').get(project) as { integration_branch: string } | undefined;
  if (!repo) return 0;
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM "events" WHERE "type" = 'repo.reconciled' AND json_extract("subject", '$.project') = ?
           AND json_extract("payload", '$.disposition') = 'adopt' AND json_extract("payload", '$.ref') = ?`,
      )
      .get(project, integrationRef(repo.integration_branch)) as { n: number }
  ).n;
}

function integrationExpected(db: Db, project: string): string | null {
  const repo = db.prepare('SELECT "integration_branch" FROM "projects" WHERE "id" = ?').get(project) as { integration_branch: string } | undefined;
  if (!repo) return null;
  return (db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(project, integrationRef(repo.integration_branch)) as { expected_oid: string } | undefined)?.expected_oid ?? null;
}

// Whether what a conformance stage's last evaluation rested on has moved
// since: the stage's recorded binding, or an adopted out-of-band move of the
// integration branch (an unadopted one is integrity's, and holds the
// project meanwhile). The engine's own journaled moves (its records, a later
// phase's integrations) never make it due: the change phase changes the
// source by design (the driver's ruling on M408 (e)). The next evaluation
// reads the application source again and names CONFORMANCE_SOURCE_MOVED if
// it moved. An evaluation with no snapshot (made before this rule) is due
// once.
function conformanceInputsMoved(db: Db, project: string, stage: string, snapshotJson: string | null): boolean {
  const snap = parseJson<{ conformance?: { adopted?: number; source_revision: string | null; source_digest: string | null } }>(snapshotJson)?.conformance;
  if (!snap || typeof snap.adopted !== 'number') return true;
  const s = db.prepare('SELECT "source_revision", "conformance_source_digest" FROM "stages" WHERE "id" = ?').get(stage) as { source_revision: string | null; conformance_source_digest: string | null } | undefined;
  if (!s || s.source_revision !== snap.source_revision || s.conformance_source_digest !== snap.source_digest) return true;
  return integrationAdoptions(db, project) !== snap.adopted;
}

// The stage's state after an evaluation of its gate (A.5). A conformed
// stage stays conformed unless its source moved (CONFORMANCE_SOURCE_MOVED):
// no other reason of a later evaluation (a check not yet run again) takes
// its conformance away.
export function conformanceAfterEvaluation(tx: Tx, args: { stage: string; satisfied: boolean; blocked: boolean; evaluation: string; sourceMoved?: boolean }): void {
  const s = tx.db.prepare('SELECT "conformance_state" FROM "stages" WHERE "id" = ?').get(args.stage) as { conformance_state: string | null } | undefined;
  if (!s) return;
  if (s.conformance_state === 'conformed') {
    if (args.sourceMoved === true) tx.db.prepare(`UPDATE "stages" SET "conformance_state" = 'blocked' WHERE "id" = ?`).run(args.stage);
    return;
  }
  const next = args.satisfied ? 'conformed' : args.blocked ? 'blocked' : 'verifying';
  if (args.satisfied) tx.db.prepare(`UPDATE "stages" SET "conformance_state" = 'conformed', "status" = 'verified' WHERE "id" = ?`).run(args.stage);
  else tx.db.prepare('UPDATE "stages" SET "conformance_state" = ? WHERE "id" = ?').run(next, args.stage);
}

// The conformance stages a candidate holds whose gate is due: no evaluation
// yet, or the latest stale; never once conformed.
export function dueConformanceGates(db: Db, candidate: CandidateRow): string[] {
  const out: string[] = [];
  for (const id of conformanceHeldBy(db, candidate)) {
    const s = db.prepare('SELECT "conformance_state" FROM "stages" WHERE "id" = ?').get(id) as { conformance_state: string | null };
    const latest = db
      .prepare(`SELECT "stale", "inputs_snapshot" FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'stage' AND "stage" = ? ORDER BY rowid DESC, "id" DESC LIMIT 1`)
      .get(candidate.id, id) as { stale: number; inputs_snapshot: string } | undefined;
    // Due: never evaluated, stale, or its source moved since (a conformed
    // stage included: its conformance holds only while its source does).
    const moved = latest !== undefined && conformanceInputsMoved(db, candidate.project, id, latest.inputs_snapshot);
    if (s.conformance_state === 'conformed') {
      if (moved) out.push(id);
      continue;
    }
    if (!latest || latest.stale === 1 || moved) out.push(id);
  }
  return out;
}

// ---- the Alpha barrier (D6 §8.1 step 6; B11; D6-R10; SEAM.md §385) --------------------------

// Whether an adopted project's change-phase replan may be created: phase 1
// (its conformance phase) complete, and `alpha_complete` satisfied for a
// candidate whose application source is A: deployed, its latest
// alpha_complete evaluation satisfied and not stale, its recorded projection
// digest A's. A failed, unknown or stale verification, or a candidate whose
// projection is not A's or was never read, leaves it closed.
export function alphaBarrier(db: Db, project: string): { adopted: boolean; open: boolean; reason: string | null; candidate: string | null } {
  const a = adoptionOf(db, project);
  if (!a) return { adopted: false, open: true, reason: null, candidate: null };
  const candidates = db.prepare(`SELECT "id", "source_digest", "progress" FROM "candidates" WHERE "project" = ? ORDER BY "seq"`).all(project) as { id: string; source_digest: string | null; progress: string }[];
  for (const c of candidates) {
    if (c.source_digest === null || c.source_digest !== a.source_digest) continue;
    if (c.progress !== 'alpha_deployed') continue;
    const last = db.prepare(`SELECT "outcome", "stale" FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'alpha_complete' ORDER BY rowid DESC, "id" DESC LIMIT 1`).get(c.id) as { outcome: string; stale: number } | undefined;
    if (last && last.outcome === 'satisfied' && last.stale === 0) return { adopted: true, open: true, reason: null, candidate: c.id };
  }
  return {
    adopted: true,
    open: false,
    reason: 'CONFORMANCE_ALPHA_PENDING: no candidate whose application source is A has a satisfied, current alpha_complete; the change-phase replan waits for the owner\'s deployment of the adopted code and its verification',
    candidate: null,
  };
}

// The barrier's tick step: phase 1 of an adopted project complete, the
// barrier open, the replan created once from its trigger (idempotent).
export function conformancePhaseComplete(db: Db, project: string): { plan: string; phase: number } | null {
  if (!adoptionOf(db, project)) return null;
  const p = db.prepare(`SELECT "id", "phase_number" FROM "phase_plans" WHERE "project" = ? AND "phase_number" = 1 AND "completed_at" IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get(project) as { id: string; phase_number: number } | undefined;
  return p ? { plan: p.id, phase: p.phase_number } : null;
}

export const conformanceStateOf = (db: Db, project: string): { stage: string; state: string | null; source_revision: string | null; reasons: unknown }[] =>
  conformanceStagesOf(db, project).map((s) => {
    const last = db.prepare(`SELECT "reasons" FROM "gate_evaluations" WHERE "gate_kind" = 'stage' AND "stage" = ? ORDER BY rowid DESC, "id" DESC LIMIT 1`).get(s.id) as { reasons: string } | undefined;
    return { stage: s.id, state: s.conformance_state, source_revision: s.source_revision, reasons: parseJson<unknown>(last?.reasons ?? null) };
  });

// The conformance phase of an adopted project (B12; D6 §8.1 steps 5 and 6,
// §8.3): until phase 1 is complete and the Alpha barrier has opened, no
// source change is made, so a `fix` records and blocks. A conformed stage
// does not end it: the phase gate and the Alpha of the adopted code are
// still ahead (the slice-32 review's S2).
export function inConformancePhase(db: Db, project: string): boolean {
  if (!adoptionOf(db, project)) return false;
  if (conformancePhaseComplete(db, project) === null) return true;
  return !alphaBarrier(db, project).open;
}
