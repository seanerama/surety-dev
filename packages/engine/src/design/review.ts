// The design review (D7 §10; G13; Q4; SEAM.md §489): on `alpha_complete`
// under `at_alpha` or `both`, design_due asks for a review; a review-mode
// Designer session is given the engine's own observations of the Alpha's
// web routes (each fetched by the engine through the service link, recorded
// as a `design_observation` record and a `design_evidence` row,
// `engine_observed`); its close records the review, every verdict only
// proposed; `design_verdicts`, the owner's answer, alone confirms them. A
// web human test carries the owner's confirmed `matches` as
// `owner_accepted`, never `verified`; a native target is `not_observed`
// (`no_native_runtime`) and its human test stays pending (Q4).

import type Database from 'better-sqlite3';

import { Refusal } from '../refusal.js';
import { notFound, parseJson } from '../store/transitions/common.js';
import { consumeDecision } from '../store/transitions/decisions.js';
import { runningService } from '../store/transitions/deploy.js';
import { type KindSpec, type Subject, consumed, raiseQuestion, recordApproval } from '../store/transitions/queue.js';
import { projectPolicy } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import { designPolicyOf } from './policy.js';
import { designDueState } from './readiness.js';
import { writeDueState } from './due.js';

type Db = Database.Database;

export interface ReviewArgs {
  project: string;
  run: string;
  design_revision: string | null;
  trigger: 'alpha_complete' | 'owner_command';
  subject: Record<string, unknown>;
  review_blob: string | null;
  verdicts: Record<string, unknown>[];
}

// ---- alpha_review: design_due's stage once the Alpha is complete ---------------------------

const latestAlpha = (db: Db, project: string): { id: string; candidate: string } | undefined =>
  db.prepare(`SELECT "id", "candidate" FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" = 'alpha_complete' AND "outcome" = 'satisfied' ORDER BY rowid DESC LIMIT 1`).get(project) as
    | { id: string; candidate: string }
    | undefined;

// At the design's review: an `alpha_complete` satisfied since the last
// review puts design_due at stage `alpha_review` (D7 §10.1).
export function noteAlphaReview(tx: Tx, project: string): void {
  const policy = designPolicyOf(tx.db, project);
  if (policy !== 'at_alpha' && policy !== 'both') return;
  const alpha = latestAlpha(tx.db, project);
  if (!alpha) return;
  const state = designDueState(tx.db, project) as ReturnType<typeof designDueState> & { alpha_pending?: string; alpha_reviewed?: string };
  if (state.alpha_pending === alpha.id || state.alpha_reviewed === alpha.id) return;
  const approved = tx.db.prepare(`SELECT 1 FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') LIMIT 1`).get(project);
  if (!approved) return;
  writeDueState(tx, project, { ...state, stage: 'alpha_review', alpha_pending: alpha.id } as never);
  tx.emit('design.review_requested', { project }, { trigger: 'alpha_complete', gate_evaluation: alpha.id, candidate: alpha.candidate });
}

// ---- what the engine observes for a review-mode session --------------------------------------

export interface ReviewTarget {
  environment: string;
  attempt: string;
  generation: number | null;
  candidate: string | null;
  routes: { screen: string; target: string; route: string }[];
  not_observed: { screen: string; target: string; reason: string }[];
  max_bytes: number;
}

// The Alpha's running service and the approved design's screens: each web
// screen with a route is fetched; every other screen is not observable here.
export function reviewTarget(db: Db, args: { project: string }): ReviewTarget | null {
  const rev = db.prepare(`SELECT "content" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(args.project) as { content: string | null } | undefined;
  // A web screen's route is its B.12 convention `route` (D7 §5.3).
  const screens = (parseJson<{ screens?: { screens?: { key: string; target: string; route?: unknown; conventions?: { route?: unknown } }[] } }>(rev?.content ?? null)?.screens?.screens ?? []).map((s) => ({
    ...s,
    route: typeof s.route === 'string' ? s.route : s.conventions?.route,
  }));
  const envs = db.prepare(`SELECT "id" FROM "environments" WHERE "project" = ? AND "prefix" IS NOT NULL AND "name" <> 'design-preview' AND "qualification_run" IS NULL ORDER BY rowid`).all(args.project) as { id: string }[];
  for (const e of envs) {
    const svc = runningService(db, e.id);
    if (!svc || svc.supervision !== 'attached') continue;
    const alpha = latestAlpha(db, args.project);
    return {
      environment: e.id,
      attempt: svc.attempt,
      generation: svc.generation,
      candidate: alpha?.candidate ?? null,
      routes: screens.filter((s) => s.target === 'web' && typeof s.route === 'string').map((s) => ({ screen: s.key, target: s.target, route: s.route as string })),
      not_observed: screens.filter((s) => s.target !== 'web').map((s) => ({ screen: s.key, target: s.target, reason: 'no_native_runtime' })),
      max_bytes: (projectPolicy(db, args.project) as Record<string, number>).design_review_evidence_max_bytes ?? 67_108_864,
    };
  }
  return null;
}

export interface Observation {
  screen: string;
  target: string;
  route: string;
  status: number | null;
  provenance: 'engine_observed';
  record: string | null;
  evidence: string;
  bytes: number;
  truncated: boolean;
}

export function observationsOf(db: Db, args: { run: string }): Observation[] {
  return (
    db.prepare(`SELECT * FROM "design_evidence" WHERE "run" = ? AND "provenance" = 'engine_observed' ORDER BY rowid`).all(args.run) as {
      id: string;
      screen: string;
      target: string;
      route: string;
      status: number | null;
      record: string | null;
      bytes: number | null;
      truncated: number | null;
    }[]
  ).map((r) => ({ screen: r.screen, target: r.target, route: r.route, status: r.status, provenance: 'engine_observed', record: r.record, evidence: r.id, bytes: r.bytes ?? 0, truncated: r.truncated === 1 }));
}

export function recordObservation(
  tx: Tx,
  args: { project: string; run: string; screen: string; target: string; route: string; status: number | null; bytes: number; digest: string; truncated: boolean; record: string | null },
): { evidence: string } {
  const id = tx.newId('dev_');
  tx.db
    .prepare(
      `INSERT INTO "design_evidence" ("id", "created_at", "project", "review", "run", "provenance", "format", "digest", "bytes", "target", "screen", "route", "status", "truncated", "observed_on", "record")
       VALUES (?, ?, ?, NULL, ?, 'engine_observed', 'http_response', ?, ?, ?, ?, ?, ?, ?, 'engine_fetch', ?)`,
    )
    .run(id, tx.at, args.project, args.run, args.digest, args.bytes, args.target, args.screen, args.route, args.status, args.truncated ? 1 : 0, args.record);
  return { evidence: id };
}

// ---- the review recorded and its verdicts asked about ------------------------------------------

export function recordReview(tx: Tx, args: ReviewArgs): { review: string; decision: string | null } {
  const id = tx.newId('drv_');
  tx.db
    .prepare(`INSERT INTO "design_reviews" ("id", "created_at", "project", "design_revision", "run", "trigger", "subject", "review_blob", "verdicts") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, tx.at, args.project, args.design_revision, args.run, args.trigger, JSON.stringify(args.subject), args.review_blob, JSON.stringify(args.verdicts));
  tx.db.prepare('UPDATE "design_evidence" SET "review" = ? WHERE "run" = ? AND "review" IS NULL').run(id, args.run);
  tx.emit('design.review_recorded', { project: args.project, design_review: id }, { trigger: args.trigger, verdicts: args.verdicts.length, run: args.run });
  // The review design_due asked for is made (D7 §10.1).
  const state = designDueState(tx.db, args.project) as ReturnType<typeof designDueState> & { alpha_pending?: string; alpha_reviewed?: string };
  if (state.stage === 'alpha_review') {
    const { stage: _stage, alpha_pending, ...rest } = state;
    writeDueState(tx, args.project, { ...rest, ...(alpha_pending ? { alpha_reviewed: alpha_pending } : {}) } as never);
  }
  const d = raiseQuestion(tx, { project: args.project, kind: 'design_verdicts', subjectType: 'design_review', subjectId: id });
  return { review: id, decision: d?.id ?? null };
}

interface ReviewRow {
  id: string;
  project: string;
  design_revision: string | null;
  run: string | null;
  trigger: string;
  subject: string;
  review_blob: string | null;
  verdicts: string;
  confirmation_decision: string | null;
}

export const DESIGN_VERDICTS: KindSpec = {
  preview(tx, d: Subject) {
    const r = tx.db.prepare('SELECT * FROM "design_reviews" WHERE "id" = ?').get(d.subject_id) as ReviewRow | undefined;
    if (!r || r.confirmation_decision !== null) return null;
    const verdicts = parseJson<Record<string, unknown>[]>(r.verdicts) ?? [];
    const evidence = tx.db.prepare('SELECT "id", "provenance", "target", "screen", "route", "status", "record" FROM "design_evidence" WHERE "review" = ? ORDER BY rowid').all(r.id);
    return {
      manifest: { review: r.id, review_blob: r.review_blob, evidence: (evidence as { id: string }[]).map((e) => e.id) },
      question: `The design review of ${r.trigger === 'alpha_complete' ? 'the Alpha' : 'the build'} proposes ${verdicts.length} verdict(s): ${verdicts.map((v) => `${String(v.target)} ${String(v.screen)} ${String(v.verdict)}`).join('; ')}. Confirm them as yours?`,
      options: [
        { key: 'confirm', label: 'Confirm', consequence: 'The verdicts become yours: a web screen that matches carries its human test as owner_accepted (never verified); a target not observed stays pending.', effect: { design_review: r.id } },
        { key: 'reject', label: 'Reject', consequence: 'The verdicts stay proposals; nothing is accepted.', effect: { design_review: r.id } },
      ],
      evidence: { verdicts, evidence } as never,
    };
  },
  manifest(tx, d) {
    const r = tx.db.prepare('SELECT "id", "review_blob" FROM "design_reviews" WHERE "id" = ?').get(d.subject_id) as { id: string; review_blob: string | null } | undefined;
    const evidence = r ? (tx.db.prepare('SELECT "id" FROM "design_evidence" WHERE "review" = ? ORDER BY rowid').all(r.id) as { id: string }[]).map((e) => e.id) : [];
    return { review: r?.id ?? null, review_blob: r?.review_blob ?? null, evidence };
  },
  reraise: false,
  answer(tx, d, option, note) {
    const r = tx.db.prepare('SELECT * FROM "design_reviews" WHERE "id" = ?').get(d.subject_id) as ReviewRow | undefined;
    if (!r) throw notFound('design_review', d.subject_id);
    if (option !== 'confirm' && option !== 'reject') throw new Refusal(400, 'invalid_option', `"${option}" is not an option of design_verdicts.`, 'Answer confirm or reject.', { option });
    consumeDecision(tx, d, option, note);
    if (option === 'reject') return consumed(d);
    recordApproval(tx, d, { consequence: 'the review\'s verdicts confirmed', subjectType: 'design_review', subjectId: r.id });
    const verdicts = (parseJson<Record<string, unknown>[]>(r.verdicts) ?? []).map((v): Record<string, unknown> => ({ ...v, status: 'confirmed' }));
    tx.db.prepare('UPDATE "design_reviews" SET "verdicts" = ?, "confirmed_by" = ?, "confirmation_decision" = ? WHERE "id" = ?').run(JSON.stringify(verdicts), tx.actor.actor_kind, d.id, r.id);
    tx.emit('design.verdicts_confirmed', { project: r.project, design_review: r.id }, { decision: d.id, verdicts: verdicts.map((v) => ({ target: v.target, screen: v.screen, verdict: v.verdict })) });
    return consumed(d);
  },
};
