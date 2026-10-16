// The review an Alpha deployment's sign-off waits on (D3 §4.1; D4 §4.1; D6
// §6.8; E36 item 3; E150 item 3; found by real loop run 5).
//
// The engine queues a candidate's review at its stage gate (gates.ts
// queueReview). A candidate that holds no stage still verifying never has a
// stage gate: a phase verification's fix integrated after every stage was
// verified nominates one, the phase completes on it, and `alpha_authorize`
// then requires the tier's Reviewer sign-off (T2 and T3, `signoffsOf`) on
// content no Reviewer was ever asked about. Loop run 5's policy request was
// refused SIGNOFF_MISSING alone, recorded `not_issued` under its key, and
// nothing more happened. Here, when the deployment's only missing piece is
// that sign-off, the engine asks its Reviewer for it, once per candidate and
// acceptance content hash; the request waits while the review is under way
// (or awaiting its owner) and is made again when it ends. A Reviewer asked
// this way who signs none of it and raises nothing parks its review behind a
// blocker the owner sees (findings.ts recordReport), never a silent stall.

import type { Signoff } from '../../checks/scope.js';
import { parseJson } from './common.js';
import type { CandidateRow } from './evidence.js';
import type { Tx } from './tx.js';
import { observeTrigger } from './work.js';

type Db = Tx['db'];

// What a review asked for the Alpha deployment carries in its trigger
// evidence: the gate, the evaluation that found the sign-off missing, the
// content it is for and the sign-offs it is asked for.
export interface AlphaReviewEvidence {
  gate: 'alpha_authorize';
  evaluation: string;
  acceptance_content_hash: string;
  signoffs: Signoff[];
}

// 'coming': a review of the candidate is under way or awaits its owner;
// 'due': none is, and the engine's Reviewer has not yet been asked for this
// content on the deployment's behalf; 'asked': it has (the owner settled
// what came of it); 'none': nothing is missing, or something is missing that
// no role the engine dispatches signs.
export type AlphaReviewState = 'coming' | 'due' | 'asked' | 'none';

const TERMINAL = ['complete', 'cancelled'];

// The sign-offs the evaluation's scope requires that the candidate does not
// have, bound to the scope's acceptance content (as evaluateGate (6) reads
// them).
export function missingSignoffs(db: Db, evaluation: string): { candidate: string; hash: string; missing: Signoff[] } | null {
  const row = db
    .prepare(`SELECT g."candidate" AS "candidate", s."acceptance_content_hash" AS "hash", s."required_signoffs" AS "required" FROM "gate_evaluations" g JOIN "acceptance_scopes" s ON s."id" = g."scope" WHERE g."id" = ?`)
    .get(evaluation) as { candidate: string; hash: string | null; required: string | null } | undefined;
  if (!row || row.hash === null) return null;
  const required = parseJson<Signoff[]>(row.required) ?? [];
  const have = db.prepare('SELECT "role", "scope", "module" FROM "signoffs" WHERE "candidate" = ? AND "acceptance_content_hash" = ?').all(row.candidate, row.hash) as {
    role: string;
    scope: string;
    module: string | null;
  }[];
  const missing = required.filter((need) => !have.some((s) => s.role === need.role && s.scope === need.scope && (need.module === undefined || s.module === need.module)));
  return { candidate: row.candidate, hash: row.hash, missing };
}

interface ReviewRow {
  id: string;
  status: string;
  trigger_generation: number;
  trigger_evidence: string | null;
}

// The engine's reviews of the candidate (trigger (verification, <candidate>),
// as queueReview makes them), newest generation first.
function reviewsOf(db: Db, project: string, candidate: string): ReviewRow[] {
  return db
    .prepare(`SELECT "id", "status", "trigger_generation", "trigger_evidence" FROM "work_items" WHERE "project" = ? AND "kind" = 'review' AND "trigger_source" = 'verification' AND "trigger_id" = ? ORDER BY "trigger_generation" DESC`)
    .all(project, candidate) as ReviewRow[];
}

export const alphaEvidenceOf = (raw: string | null): AlphaReviewEvidence | null => {
  const e = parseJson<Partial<AlphaReviewEvidence>>(raw);
  return e !== null && e.gate === 'alpha_authorize' && typeof e.acceptance_content_hash === 'string' ? (e as AlphaReviewEvidence) : null;
};

// Is an engine review of the candidate under way, or waiting for its owner?
export function reviewUnderWay(db: Db, project: string, candidate: string): boolean {
  return reviewsOf(db, project, candidate).some((r) => !TERMINAL.includes(r.status));
}

export function alphaReviewState(db: Db, project: string, evaluation: string): AlphaReviewState {
  const m = missingSignoffs(db, evaluation);
  if (m === null || m.missing.length === 0) return 'none';
  // Every sign-off the scope rule requires is a Reviewer's (checks/scope.ts
  // signoffsOf); one of another role no engine run signs here.
  if (m.missing.some((s) => s.role !== 'reviewer')) return 'none';
  const reviews = reviewsOf(db, project, m.candidate);
  if (reviews.some((r) => !TERMINAL.includes(r.status))) return 'coming';
  if (reviews.some((r) => alphaEvidenceOf(r.trigger_evidence)?.acceptance_content_hash === m.hash)) return 'asked';
  return 'due';
}

// Ask the engine's Reviewer for the sign-offs the evaluation found missing,
// when they are due: the next generation of the candidate's review trigger,
// unchained (the deployment request is a fresh trigger, as a phase
// verification is), its evidence naming what it is for. Returns the state
// after: 'coming' once queued.
export function queueAlphaReview(tx: Tx, candidate: CandidateRow, evaluation: string): AlphaReviewState {
  const state = alphaReviewState(tx.db, candidate.project, evaluation);
  if (state !== 'due') return state;
  const m = missingSignoffs(tx.db, evaluation)!;
  const latest = reviewsOf(tx.db, candidate.project, candidate.id)[0];
  const evidence: AlphaReviewEvidence = { gate: 'alpha_authorize', evaluation, acceptance_content_hash: m.hash, signoffs: m.missing };
  // Its work.created names the gate and the evaluation (the label): the
  // event set is closed (D1 §12.1, A.6), so no event of its own.
  observeTrigger(
    tx,
    {
      project: candidate.project,
      kind: 'review',
      trigger_source: 'verification',
      trigger_id: candidate.id,
      trigger_generation: (latest?.trigger_generation ?? 0) + 1,
      subject: { candidate: candidate.id },
      chain: 0,
      trigger_evidence: evidence as unknown as Record<string, unknown>,
    },
    { gate: 'alpha_authorize', evaluation, signoffs: m.missing },
  );
  return 'coming';
}

// After a Reviewer's report on a review asked for the Alpha deployment
// (findings.ts recordReport): the sign-offs it was asked for that are still
// missing on the content it reviewed.
export function alphaSignoffsUnsigned(db: Db, args: { workItem: string; candidate: string; reviewed: string }): Signoff[] | null {
  const row = db.prepare('SELECT "trigger_evidence" FROM "work_items" WHERE "id" = ?').get(args.workItem) as { trigger_evidence: string | null } | undefined;
  const e = alphaEvidenceOf(row?.trigger_evidence ?? null);
  if (e === null) return null;
  const have = db.prepare('SELECT "role", "scope", "module" FROM "signoffs" WHERE "candidate" = ? AND "acceptance_content_hash" = ?').all(args.candidate, args.reviewed) as {
    role: string;
    scope: string;
    module: string | null;
  }[];
  return e.signoffs.filter((need) => !have.some((s) => s.role === need.role && s.scope === need.scope && (need.module === undefined || s.module === need.module)));
}
