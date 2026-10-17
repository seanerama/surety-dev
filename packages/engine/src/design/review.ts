// The design review (D7 §10; G13; Q4; SEAM.md §§489, 521 to 527): on
// `alpha_complete` under `at_alpha` or `both`, design_due asks for a review
// bound to the Alpha's candidate and its deployment; a review-mode Designer
// session is given the engine's own observations of the Alpha's web routes
// (each fetched by the engine through the service link, recorded as a
// `design_observation` record and a `design_evidence` row,
// `engine_observed`); its close records the review, every verdict only
// proposed; `design_verdicts`, the owner's answer, alone confirms them,
// with any verdict he edits or strikes. A web human test carries the
// owner's confirmed `matches` as `owner_accepted`, never `verified`, for
// the design version it was given on only; a native target is
// `not_observed` (`no_native_runtime`) and its human test stays pending
// (Q4). A confirmed verdict's implementation defects become findings
// against the review's candidate; its design deltas wait in the batch.
// Evidence is kept by provenance and never merged: no owner item is ever
// shown or counted as engine-observed (§10.5).

import type Database from 'better-sqlite3';

import { Refusal } from '../refusal.js';
import { notFound, parseJson } from '../store/transitions/common.js';
import { consumeDecision } from '../store/transitions/decisions.js';
import { runningService } from '../store/transitions/deploy.js';
import { SEVERITIES, raiseFinding } from '../store/transitions/findings.js';
import { OWED_SCOPE, type AnswerExtra, type KindSpec, type Subject, consumed, raiseQuestion, recordApproval } from '../store/transitions/queue.js';
import { effectiveVersion } from '../store/transitions/protected.js';
import { checksOfVersion } from '../store/transitions/evidence.js';
import type { Tx } from '../store/transitions/tx.js';
import { OBSERVED_ON } from './evidence.js';
import { designPolicyOf } from './policy.js';
import { designDueState } from './readiness.js';
import { writeDueState } from './due.js';
import { latestCheck } from './records.js';

type Db = Database.Database;

export interface ReviewArgs {
  project: string;
  run: string;
  design_revision: string | null;
  trigger: 'alpha_complete' | 'owner_command';
  subject: Record<string, unknown>;
  review_blob: string | null;
  verdicts: Record<string, unknown>[];
  // The design the review proposed beside its verdicts (D7 §10.3, §10.6).
  proposed_revision?: string | null;
}

export const VERDICTS = ['matches', 'deltas', 'not_observed'] as const;
export const DELTA_KINDS = ['design', 'implementation', 'both'] as const;
export const NOT_OBSERVED_REASONS = ['no_native_runtime', 'not_reached', 'owner_skipped'] as const;

// SEAM.md §524: how each provenance is shown.
export const PROVENANCE_LABEL: Record<string, string> = { engine_observed: 'engine-observed', owner_supplied: 'owner-supplied', owner_reported: 'owner-reported' };

// ---- alpha_review: design_due's stage once the Alpha is complete ---------------------------

const latestAlpha = (db: Db, project: string): { id: string; candidate: string } | undefined =>
  db.prepare(`SELECT "id", "candidate" FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" = 'alpha_complete' AND "outcome" = 'satisfied' ORDER BY rowid DESC LIMIT 1`).get(project) as
    | { id: string; candidate: string }
    | undefined;

// The deploy operation that put the candidate on Alpha (the newest of the
// project's for that candidate).
function deployOperationOf(db: Db, project: string, candidate: string): string | null {
  const rows = db.prepare(`SELECT "id", "subject" FROM "operations" WHERE "project" = ? AND "kind" = 'deploy' ORDER BY "seq" DESC`).all(project) as { id: string; subject: string }[];
  return (rows.find((r) => JSON.stringify(parseJson(r.subject) ?? {}).includes(candidate)) ?? rows[0])?.id ?? null;
}

// At the design's review: an `alpha_complete` satisfied since the last
// review puts design_due at stage `alpha_review`, bound to the Alpha's
// candidate and its deployment (D7 §10.1; SEAM.md §526).
export function noteAlphaReview(tx: Tx, project: string): void {
  const policy = designPolicyOf(tx.db, project);
  if (policy !== 'at_alpha' && policy !== 'both') return;
  const alpha = latestAlpha(tx.db, project);
  if (!alpha) return;
  const state = designDueState(tx.db, project) as ReturnType<typeof designDueState> & { alpha_pending?: string; alpha_reviewed?: string };
  if (state.alpha_pending === alpha.id || state.alpha_reviewed === alpha.id) return;
  // With no approved design (under `at_alpha`, or `both` with the design
  // before build waived) the review is a first design at Alpha (D7 §10.6;
  // SEAM.md §514): asked all the same.
  const operation = deployOperationOf(tx.db, project, alpha.candidate);
  const review = { kind: 'candidate', candidate: alpha.candidate, ...(operation ? { deployment: operation } : {}), gate_evaluation: alpha.id };
  writeDueState(tx, project, { ...state, stage: 'alpha_review', alpha_pending: alpha.id, review } as never);
  tx.emit('design.review_requested', { project }, { trigger: 'alpha_complete', gate_evaluation: alpha.id, candidate: alpha.candidate, deployment: operation });
}

// ---- what the engine observes for a review-mode session --------------------------------------

export interface ReviewTarget {
  environment: string;
  attempt: string;
  generation: number | null;
  candidate: string | null;
  routes: { screen: string; target: string; route: string }[];
  not_observed: { screen: string; target: string; reason: string }[];
}

// The approved design's screens with their routes (B.12 conventions.route).
function approvedScreens(db: Db, project: string): { key: string; target: string; route?: string }[] {
  const rev = db.prepare(`SELECT "content" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(project) as { content: string | null } | undefined;
  return (parseJson<{ screens?: { screens?: { key: string; target: string; route?: unknown; conventions?: { route?: unknown } }[] } }>(rev?.content ?? null)?.screens?.screens ?? []).map((s) => {
    const route = typeof s.route === 'string' ? s.route : s.conventions?.route;
    return { key: s.key, target: s.target, ...(typeof route === 'string' ? { route } : {}) };
  });
}

// The Alpha's running service and the approved design's screens: each web
// screen with a route is fetched; every other screen is not observable here.
export function reviewTarget(db: Db, args: { project: string }): ReviewTarget | null {
  const screens = approvedScreens(db, args.project);
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
    };
  }
  return null;
}

// The screens of no native runtime, with or without a running service.
export function notObservedScreens(db: Db, args: { project: string }): ReviewTarget['not_observed'] {
  return approvedScreens(db, args.project)
    .filter((s) => s.target !== 'web')
    .map((s) => ({ screen: s.key, target: s.target, reason: 'no_native_runtime' }));
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
  digest: string | null;
  truncated: boolean;
  reason?: string;
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
      digest: string | null;
      truncated: number | null;
      reason: string | null;
    }[]
  ).map((r) => ({
    screen: r.screen,
    target: r.target,
    route: r.route,
    status: r.status,
    provenance: 'engine_observed',
    record: r.record,
    evidence: r.id,
    bytes: r.bytes ?? 0,
    digest: r.digest,
    truncated: r.truncated === 1,
    ...(r.reason ? { reason: r.reason } : {}),
  }));
}

export function recordObservation(
  tx: Tx,
  args: { project: string; run: string; screen: string; target: string; route: string; status: number | null; bytes: number; digest: string; truncated: boolean; record: string | null; reason?: string | null },
): { evidence: string } {
  const id = tx.newId('dev_');
  tx.db
    .prepare(
      `INSERT INTO "design_evidence" ("id", "created_at", "project", "review", "run", "provenance", "format", "digest", "bytes", "target", "screen", "route", "status", "truncated", "observed_on", "record", "reason")
       VALUES (?, ?, ?, NULL, ?, 'engine_observed', 'http_response', ?, ?, ?, ?, ?, ?, ?, 'engine_fetch', ?, ?)`,
    )
    .run(id, tx.at, args.project, args.run, args.digest, args.bytes, args.target, args.screen, args.route, args.status, args.truncated ? 1 : 0, args.record, args.reason ?? null);
  return { evidence: id };
}

// ---- the review recorded and its verdicts asked about ------------------------------------------

export function recordReview(tx: Tx, args: ReviewArgs): { review: string; decision: string | null } {
  // An owner-invoked review's row was recorded at its opening, with the
  // subject as he gave it (SEAM.md §522): its verdicts are written to it.
  const opened = tx.db.prepare(`SELECT "id" FROM "design_reviews" WHERE "run" = ? AND "trigger" = 'owner_command' AND "review_blob" IS NULL ORDER BY rowid DESC LIMIT 1`).get(args.run) as { id: string } | undefined;
  const id = opened?.id ?? tx.newId('drv_');
  const state = designDueState(tx.db, args.project) as ReturnType<typeof designDueState> & { alpha_pending?: string; alpha_reviewed?: string };
  if (opened) {
    tx.db.prepare('UPDATE "design_reviews" SET "review_blob" = ?, "verdicts" = ?, "proposed_revision" = ? WHERE "id" = ?').run(args.review_blob, JSON.stringify(args.verdicts), args.proposed_revision ?? null, id);
  } else {
    // A review at Alpha is about the Alpha's candidate and its deployment,
    // as the engine bound them (D7 §10.1), never as the role's file says.
    const subject = args.trigger === 'alpha_complete' && state.review ? { kind: 'candidate', candidate: state.review.candidate, ...(state.review.deployment ? { deployment: state.review.deployment } : {}) } : args.subject;
    tx.db
      .prepare(`INSERT INTO "design_reviews" ("id", "created_at", "project", "design_revision", "run", "trigger", "subject", "review_blob", "verdicts", "proposed_revision") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tx.at, args.project, args.design_revision, args.run, args.trigger, JSON.stringify(subject), args.review_blob, JSON.stringify(args.verdicts), args.proposed_revision ?? null);
  }
  tx.db.prepare('UPDATE "design_evidence" SET "review" = ? WHERE "run" = ? AND "review" IS NULL').run(id, args.run);
  tx.emit('design.review_recorded', { project: args.project, design_review: id }, { trigger: args.trigger, verdicts: args.verdicts.length, run: args.run, ...(args.proposed_revision ? { design_revision: args.proposed_revision } : {}) });
  // The review design_due asked for is made (D7 §10.1).
  if (state.stage === 'alpha_review' && !opened) {
    const { stage: _stage, alpha_pending, review: _review, ...rest } = state;
    writeDueState(tx, args.project, { ...rest, ...(alpha_pending ? { alpha_reviewed: alpha_pending } : {}) } as never);
  }
  // A review with no verdict asks nothing of the owner.
  if (args.verdicts.length === 0) return { review: id, decision: null };
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
  confirmed_by: string | null;
  confirmation_decision: string | null;
  findings: string;
  proposed_revision: string | null;
}

interface Verdict {
  target: string;
  screen: string;
  verdict: string;
  status: string;
  observed_on?: string;
  not_observed_reason?: string;
  evidence: string[];
  deltas: { state?: string; owner_words: string; kind: string }[];
}

// The review file's blob as the project's latest design save left it (D7
// §10.3; SEAM.md §517: design_verdicts binds the review file's hash): the
// blob recorded at close until a later save changes the file at its path,
// which stales the question.
function reviewFileBlob(db: Db, r: Pick<ReviewRow, 'project' | 'run' | 'review_blob'>): string | null {
  if (r.review_blob === null) return null;
  const own = r.run ? latestCheck(db, { project: r.project, run: r.run }) : null;
  const path = Object.entries(own?.blobs ?? {}).find(([, b]) => b === r.review_blob)?.[0];
  if (path === undefined) return r.review_blob;
  const latest = latestCheck(db, { project: r.project });
  return latest?.blobs[path] ?? r.review_blob;
}

const evidenceRows = (db: Db, review: string) =>
  (db.prepare('SELECT "id", "provenance", "format", "target", "screen", "route", "status", "observed_on", "name", "record" FROM "design_evidence" WHERE "review" = ? ORDER BY rowid').all(review) as {
    id: string;
    provenance: string;
    format: string | null;
    target: string;
    screen: string | null;
    route: string | null;
    status: number | null;
    observed_on: string | null;
    name: string | null;
    record: string | null;
  }[]).map((e) => ({ ...e, label: PROVENANCE_LABEL[e.provenance] ?? e.provenance }));

// The provenance a verdict rests on (D7 §10.5): that of the evidence it
// names, or the owner's typed words where it names none.
export function verdictProvenance(db: Db, v: Pick<Verdict, 'evidence'>): string {
  const ids = Array.isArray(v.evidence) ? v.evidence : [];
  if (ids.length === 0) return 'owner_reported';
  const rows = ids.map((id) => db.prepare('SELECT "provenance" FROM "design_evidence" WHERE "id" = ?').get(id) as { provenance: string } | undefined).filter((x) => x !== undefined);
  const kinds = [...new Set(rows.map((r) => r!.provenance))];
  // Never merged: one provenance, or each named.
  return kinds.length === 1 ? kinds[0]! : kinds.length === 0 ? 'owner_reported' : kinds.sort().join('+');
}

export const DESIGN_VERDICTS: KindSpec = {
  preview(tx, d: Subject) {
    const r = tx.db.prepare('SELECT * FROM "design_reviews" WHERE "id" = ?').get(d.subject_id) as ReviewRow | undefined;
    if (!r || r.confirmation_decision !== null) return null;
    const verdicts = parseJson<Verdict[]>(r.verdicts) ?? [];
    const evidence = evidenceRows(tx.db, r.id);
    return {
      manifest: { review: r.id, review_blob: reviewFileBlob(tx.db, r), evidence: evidence.map((e) => e.id) },
      question: `The design review of ${r.trigger === 'alpha_complete' ? 'the Alpha' : 'the build'} proposes ${verdicts.length} verdict(s): ${verdicts.map((v) => `${String(v.target)} ${String(v.screen)} ${String(v.verdict)}`).join('; ')}. Confirm them as yours (editing or striking any), or reject them?`,
      options: [
        {
          key: 'confirm',
          label: 'Confirm',
          consequence:
            'The verdicts become yours, as you edit them; a struck one is not. A confirmed `matches` on a native runtime carries its target\'s human test as owner accepted for this design version (never verified); a target not observed stays pending. Each confirmed implementation defect becomes a finding against the review\'s candidate (severity medium unless you give one); a design delta waits in its batch.',
          effect: { design_review: r.id },
        },
        { key: 'reject', label: 'Reject', consequence: 'The verdicts stay proposals; nothing is accepted, filed or routed.', effect: { design_review: r.id } },
      ],
      evidence: {
        verdicts: verdicts.map((v) => ({ ...v, provenance: PROVENANCE_LABEL[verdictProvenance(tx.db, v)] ?? verdictProvenance(tx.db, v) })),
        evidence: evidence.map((e) => ({ id: e.id, label: e.label, format: e.format, target: e.target, screen: e.screen, route: e.route, status: e.status, observed_on: e.observed_on, name: e.name })),
      } as never,
    };
  },
  manifest(tx, d) {
    const r = tx.db.prepare('SELECT "id", "project", "run", "review_blob" FROM "design_reviews" WHERE "id" = ?').get(d.subject_id) as Pick<ReviewRow, 'id' | 'project' | 'run' | 'review_blob'> | undefined;
    const evidence = r ? (tx.db.prepare('SELECT "id" FROM "design_evidence" WHERE "review" = ? ORDER BY rowid').all(r.id) as { id: string }[]).map((e) => e.id) : [];
    return { review: r?.id ?? null, review_blob: r ? reviewFileBlob(tx.db, r) : null, evidence };
  },
  reraise: false,
  answer(tx, d, option, note, _facts, extra?: AnswerExtra) {
    const r = tx.db.prepare('SELECT * FROM "design_reviews" WHERE "id" = ?').get(d.subject_id) as ReviewRow | undefined;
    if (!r) throw notFound('design_review', d.subject_id);
    if (option !== 'confirm' && option !== 'reject') throw new Refusal(400, 'invalid_option', `"${option}" is not an option of design_verdicts.`, 'Answer confirm or reject.', { option });
    const proposed = parseJson<Verdict[]>(r.verdicts) ?? [];
    // Everything the confirmation carries is judged before anything is consumed.
    const shaped = option === 'confirm' ? confirmedVerdicts(proposed, extra) : null;
    consumeDecision(tx, d, option, note);
    if (option === 'reject') return consumed(d);
    recordApproval(tx, d, { consequence: 'the review\'s verdicts confirmed', subjectType: 'design_review', subjectId: r.id });
    const verdicts = shaped!.verdicts;
    tx.db.prepare('UPDATE "design_reviews" SET "verdicts" = ?, "confirmed_by" = ?, "confirmation_decision" = ? WHERE "id" = ?').run(JSON.stringify(verdicts), tx.actor.actor_kind, d.id, r.id);
    // Implementation defects of the confirmed verdicts, filed (D7 §10.3).
    const findings = fileDefects(tx, r, verdicts, shaped!.severity);
    if (findings.length > 0) tx.db.prepare('UPDATE "design_reviews" SET "findings" = ? WHERE "id" = ?').run(JSON.stringify(findings), r.id);
    tx.emit('design.verdicts_confirmed', { project: r.project, design_review: r.id }, {
      decision: d.id,
      verdicts: verdicts.map((v) => ({ target: v.target, screen: v.screen, verdict: v.verdict, status: v.status })),
      findings,
      severity: shaped!.severity,
    });
    return consumed(d, [{ kind: 'tick' }]);
  },
};

const invalidAnswer = (field: string, why: string) => new Refusal(422, 'invalid_value', `"${field}" ${why}.`, 'Edit or strike verdicts the review holds, by target and screen; nothing was changed.', { field });

// The proposals as the owner confirms them: edits replace a verdict's
// fields, a strike marks it struck, every other confirmed (SEAM.md §525).
function confirmedVerdicts(proposed: Verdict[], extra: AnswerExtra | undefined): { verdicts: Verdict[]; severity: string } {
  const at = (target: unknown, screen: unknown) => proposed.findIndex((v) => v.target === target && v.screen === screen);
  const edits = extra?.edits === undefined ? [] : extra.edits;
  const strikes = extra?.strikes === undefined ? [] : extra.strikes;
  if (!Array.isArray(edits)) throw invalidAnswer('edits', 'must be a list of {target, screen, verdict?, observed_on?, deltas?}');
  if (!Array.isArray(strikes)) throw invalidAnswer('strikes', 'must be a list of {target, screen}');
  const severity = extra?.severity === undefined ? 'medium' : extra.severity;
  if (typeof severity !== 'string' || !(SEVERITIES as readonly string[]).includes(severity)) throw invalidAnswer('severity', `must be one of ${SEVERITIES.join(', ')}`);
  const out: Verdict[] = proposed.map((v) => ({ ...v, status: 'confirmed' }));
  for (const [i, e] of edits.entries()) {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) throw invalidAnswer(`edits[${i}]`, 'must be an object');
    const x = e as Record<string, unknown>;
    for (const k of Object.keys(x)) if (!['target', 'screen', 'verdict', 'observed_on', 'deltas'].includes(k)) throw invalidAnswer(`edits[${i}].${k}`, 'is not a field of an edit');
    const j = at(x.target, x.screen);
    if (j < 0) throw invalidAnswer(`edits[${i}]`, `names no verdict of the review (${String(x.target)}/${String(x.screen)})`);
    const v = { ...out[j]! };
    if (x.verdict !== undefined) {
      if (typeof x.verdict !== 'string' || !(VERDICTS as readonly string[]).includes(x.verdict)) throw invalidAnswer(`edits[${i}].verdict`, `must be one of ${VERDICTS.join(', ')}`);
      v.verdict = x.verdict;
    }
    if (x.observed_on !== undefined) {
      if (typeof x.observed_on !== 'string' || !(OBSERVED_ON as readonly string[]).includes(x.observed_on)) throw invalidAnswer(`edits[${i}].observed_on`, `must be one of ${OBSERVED_ON.join(', ')}`);
      v.observed_on = x.observed_on;
    }
    if (x.deltas !== undefined) {
      if (!Array.isArray(x.deltas)) throw invalidAnswer(`edits[${i}].deltas`, 'must be a list of {state?, owner_words, kind}');
      v.deltas = x.deltas.map((dl, k) => {
        if (dl === null || typeof dl !== 'object' || Array.isArray(dl)) throw invalidAnswer(`edits[${i}].deltas[${k}]`, 'must be an object');
        const y = dl as Record<string, unknown>;
        for (const key of Object.keys(y)) if (!['state', 'owner_words', 'kind'].includes(key)) throw invalidAnswer(`edits[${i}].deltas[${k}].${key}`, 'is not a field of a delta');
        if (typeof y.owner_words !== 'string' || y.owner_words === '') throw invalidAnswer(`edits[${i}].deltas[${k}].owner_words`, 'must be the owner\'s words');
        if (typeof y.kind !== 'string' || !(DELTA_KINDS as readonly string[]).includes(y.kind)) throw invalidAnswer(`edits[${i}].deltas[${k}].kind`, `must be one of ${DELTA_KINDS.join(', ')}`);
        if (y.state !== undefined && typeof y.state !== 'string') throw invalidAnswer(`edits[${i}].deltas[${k}].state`, 'must be a string');
        return { ...(typeof y.state === 'string' ? { state: y.state } : {}), owner_words: y.owner_words, kind: y.kind };
      });
    }
    out[j] = v;
  }
  for (const [i, s] of strikes.entries()) {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) throw invalidAnswer(`strikes[${i}]`, 'must be {target, screen}');
    const x = s as Record<string, unknown>;
    const j = at(x.target, x.screen);
    if (j < 0) throw invalidAnswer(`strikes[${i}]`, `names no verdict of the review (${String(x.target)}/${String(x.screen)})`);
    out[j] = { ...out[j]!, status: 'struck' };
  }
  return { verdicts: out, severity };
}

// The candidate a review's defects are filed against (D7 §10.3): the
// review's; for an owner build, the one he named where the project holds
// it, or else the latest of the project.
function reviewCandidate(db: Db, r: ReviewRow): string | null {
  const subject = parseJson<{ candidate?: string }>(r.subject) ?? {};
  if (typeof subject.candidate === 'string' && db.prepare('SELECT 1 FROM "candidates" WHERE "id" = ? AND "project" = ?').get(subject.candidate, r.project)) return subject.candidate;
  return (db.prepare('SELECT "id" FROM "candidates" WHERE "project" = ? ORDER BY "seq" DESC LIMIT 1').get(r.project) as { id: string } | undefined)?.id ?? null;
}

// The check that decides a target's design criteria (D7 §10.3: "the design
// criteria's checks deciding"): a check of the effective protected version
// covering a criterion of the approved design for that target, or null.
function designCheckFor(db: Db, project: string, target: string): { check: string; criterion: string } | null {
  const rev = db.prepare(`SELECT "content" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(project) as { content: string | null } | undefined;
  const criteria = (parseJson<{ criteria?: { criteria?: { requirement?: string; text?: string; targets?: string[] }[] } }>(rev?.content ?? null)?.criteria?.criteria ?? []).filter(
    (c) => !Array.isArray(c.targets) || c.targets.length === 0 || c.targets.includes(target),
  );
  if (criteria.length === 0) return null;
  const ids = new Set<string>();
  for (const c of criteria) {
    const row = db.prepare('SELECT "criteria_text" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(project, c.requirement ?? '') as { criteria_text: string | null } | undefined;
    for (const t of parseJson<{ id: string; text: string }[]>(row?.criteria_text ?? null) ?? []) if (t.text.trim() === String(c.text ?? '').trim()) ids.add(t.id);
  }
  const version = effectiveVersion(db, project);
  if (!version || ids.size === 0) return null;
  // The finding names the criterion with the check, so the check verifies
  // it by that criterion (D3 §2.11 condition 2).
  for (const k of checksOfVersion(db, version.id).sort((a, b) => a.key.localeCompare(b.key))) {
    const covered = (parseJson<string[]>((k as unknown as { criteria: string | null }).criteria) ?? []).find((c) => ids.has(c));
    if (covered !== undefined) return { check: k.key, criterion: covered };
  }
  return null;
}

// Each implementation defect of a confirmed verdict (a delta of kind
// `implementation` or `both`) is one finding with its disposition owed to
// the owner; nothing from a struck verdict or a `design` delta.
function fileDefects(tx: Tx, r: ReviewRow, verdicts: Verdict[], severity: string): string[] {
  const subject = parseJson<{ build_ref?: string }>(r.subject) ?? {};
  const candidate = reviewCandidate(tx.db, r);
  const out: string[] = [];
  for (const v of verdicts) {
    if (v.status !== 'confirmed') continue;
    for (const dl of v.deltas ?? []) {
      if (dl.kind !== 'implementation' && dl.kind !== 'both') continue;
      const where = `${v.target} ${v.screen}${dl.state ? ` (${dl.state})` : ''}`;
      const id = raiseFinding(tx, {
        project: r.project,
        scope: candidate ? 'candidate' : 'project',
        candidate,
        run: r.run,
        role: 'designer',
        category: 'defect',
        severity,
        message: `${dl.owner_words} [design review ${r.id}, ${where}${typeof subject.build_ref === 'string' ? `, build ${JSON.stringify(subject.build_ref)}` : ''}]`,
        ...(() => {
          const decides = designCheckFor(tx.db, r.project, v.target);
          return decides ? { check: decides.check, criterion: decides.criterion } : {};
        })(),
      });
      raiseQuestion(tx, { project: r.project, kind: 'finding_disposition', subjectType: 'finding', subjectId: id, scope: OWED_SCOPE });
      out.push(id);
    }
  }
  return out;
}

// ---- the reads (SEAM.md §524) --------------------------------------------------------------------

// Every review of the project, its evidence labelled and counted by provenance.
export function reviewsView(db: Db, project: string): Record<string, unknown>[] {
  const rows = db.prepare('SELECT * FROM "design_reviews" WHERE "project" = ? ORDER BY rowid').all(project) as ReviewRow[];
  return rows.map((r) => {
    const evidence = evidenceRows(db, r.id);
    const count = (p: string) => evidence.filter((e) => e.provenance === p).length;
    return {
      id: r.id,
      trigger: r.trigger,
      subject: parseJson(r.subject),
      design_revision: r.design_revision,
      first_design: r.design_revision === null,
      verdicts: (parseJson<Verdict[]>(r.verdicts) ?? []).map((v) => ({ ...v, provenance: verdictProvenance(db, v) })),
      confirmed_by: r.confirmed_by,
      confirmation_decision: r.confirmation_decision,
      findings: parseJson(r.findings) ?? [],
      evidence: evidence.map((e) => ({ id: e.id, provenance: e.provenance, label: e.label, format: e.format, target: e.target, screen: e.screen, observed_on: e.observed_on, name: e.name })),
      evidence_by_provenance: { engine_observed: count('engine_observed'), owner_supplied: count('owner_supplied'), owner_reported: count('owner_reported') },
    };
  });
}

// A target's owner evidence: one entry per confirmed verdict of that
// target (none for a struck one), each bound to its design version,
// candidate or build, and runtime, shown "owner accepted" (Q4), apart from
// automated verification. `current`: the approved design revision in force.
export function humanTestEvidence(db: Db, project: string, target: string, current: string | null): { evidence: Record<string, unknown>[]; accepted: boolean } {
  const rows = db
    .prepare(`SELECT r.*, v."version" AS "design_version" FROM "design_reviews" r LEFT JOIN "design_revisions" v ON v."id" = r."design_revision" WHERE r."project" = ? AND r."confirmation_decision" IS NOT NULL ORDER BY r.rowid`)
    .all(project) as (ReviewRow & { design_version: number | null })[];
  const evidence: Record<string, unknown>[] = [];
  let accepted = false;
  for (const r of rows) {
    const subject = parseJson<{ candidate?: string; build_ref?: string }>(r.subject) ?? {};
    for (const v of parseJson<Verdict[]>(r.verdicts) ?? []) {
      if (v.target !== target || v.status !== 'confirmed') continue;
      const provenance = verdictProvenance(db, v);
      evidence.push({
        review: r.id,
        target: v.target,
        screen: v.screen,
        verdict: v.verdict,
        observed_on: v.observed_on ?? null,
        provenance,
        label: 'owner accepted',
        design_revision: r.design_revision,
        design_version: r.design_version,
        ...(typeof subject.candidate === 'string' ? { candidate: subject.candidate } : {}),
        ...(typeof subject.build_ref === 'string' ? { build_ref: subject.build_ref } : {}),
      });
      // Counted only for the design version it was given on, only from a
      // `matches` on a runtime that is not a simulation (D7 §10.2; Q4).
      if (current !== null && r.design_revision === current && v.verdict === 'matches' && v.observed_on !== undefined && v.observed_on !== 'simulation') accepted = true;
    }
  }
  return { evidence, accepted };
}
