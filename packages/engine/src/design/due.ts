// `design_due` and no silent stalls (D7 §11; A.8; G5; SEAM.md §485): one
// open per project at a time, subject the project, human only. Raised when a
// UI stage is first held for design (at derivation, naming the stages it will
// hold), when a screen of the design in force is stale, when a design is sent
// back for revision, and on `alpha_complete` under `at_alpha` or `both`. Its
// question names the held stages, the stale screens and the exact command; a
// new cause updates its subjects, which stales it and raises the next
// generation, never a second row. The engine never answers it; it is closed
// by the engine only when nothing it names holds any more (the design ready,
// waived, or the policy off).
//
// Objections 126 and 145 (open for Sean): what `open` and `later` do to the
// question itself. As built in slice 40 and kept: an `open` answer is
// consumed, the Designer session allocated (slice 44), and while a stage
// stays held the question is raised again at the next review; a `later`
// answer is consumed and nothing is asked until the owner's time passes or a
// new cause appears. Either way the deferral and its decision are on every
// read (rule 25; the slice-44 review's S1).

import { type AnswerExtra, type KindSpec, type Subject, consumed, recordApproval, recordIntent } from '../store/transitions/queue.js';
import { Refusal } from '../refusal.js';
import { canonical, sha256 } from '../store/transitions/common.js';
import { consumeDecision } from '../store/transitions/decisions.js';
import { policyRevision, projectPolicy } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import { recordMetMilestones } from '../scheduler/milestones.js';
import { raiseQuestion } from '../store/transitions/queue.js';
import { type DesignDueState, designDueState, heldStages } from './readiness.js';
import { designPolicyOf } from './policy.js';
import { currentStaleScreens } from './stale.js';
import { deferredBatches } from './approval.js';

export const DESIGN_DUE_KEYS = ['stage', 'held_stages', 'stale_screens', 'policy_revision', 'inventory_failure', 'reason'];

// How many failed attempts at the inventory's commit design_due names.
export const INVENTORY_FAILURES_NAMED = 3;

// One attempt at the inventory's commit: a failure counted, a success
// clearing the count (design/driver.ts).
export function inventoryAttempt(tx: Tx, args: { project: string; failure: string | null }): void {
  const state = designDueState(tx.db, args.project);
  if (args.failure === null) {
    if (!state.inventory_failure) return;
    const { inventory_failure: _f, ...rest } = state;
    writeDueState(tx, args.project, rest);
    return;
  }
  writeDueState(tx, args.project, { ...state, inventory_failure: { count: (state.inventory_failure?.count ?? 0) + 1, reason: args.failure.slice(0, 500), at: tx.at } });
}

export function writeDueState(tx: Tx, project: string, state: DesignDueState): void {
  tx.db.prepare('UPDATE "projects" SET "design_due" = ? WHERE "id" = ?').run(JSON.stringify(state), project);
}

// The Designer session of a project allocated and not ended, or null.
export function liveDesignerSession(db: Tx['db'], project: string): string | null {
  return (db.prepare(`SELECT "id" FROM "runs" WHERE "project" = ? AND "role" = 'designer' AND "kind" = 'session' AND "state" <> 'ended' ORDER BY "seq" DESC LIMIT 1`).get(project) as { id: string } | undefined)?.id ?? null;
}

function dueFacts(tx: Tx, project: string) {
  const state = designDueState(tx.db, project);
  const stage = state.stage ?? 'before_build';
  const held = heldStages(tx.db, project);
  const failed = state.inventory_failure && state.inventory_failure.count >= INVENTORY_FAILURES_NAMED ? state.inventory_failure.reason : null;
  // The design in force's stale screens with their targets (D7 §9.1, §11).
  const stale = currentStaleScreens(tx.db, project);
  const session = liveDesignerSession(tx.db, project);
  const deferred = deferredBatches(tx.db, project);
  // What the question says beside its subjects, bound as one digest, so a
  // changed reason asks it again (the review's S5).
  const reason = sha256(canonical({ note: state.note ?? null, inventory_difference: state.inventory_difference ?? null, open_refused: state.open_refused ?? null, session, deferred_batches: deferred.map((b) => b.spec_change_request) }));
  const manifest = { stage, held_stages: held, stale_screens: stale, policy_revision: policyRevision(tx.db, project), inventory_failure: failed, reason };
  return { state, stage, held, stale, session, deferred, manifest };
}

export const DESIGN_DUE: KindSpec = {
  preview(tx, d: Subject) {
    const project = d.project!;
    const { state, stage, held, stale, session, deferred, manifest } = dueFacts(tx, project);
    if (designPolicyOf(tx.db, project) === 'off' && stage !== 'alpha_review') return null;
    // Stale screens raise it whether or not a stage is held (D7 §9.1).
    if (stage !== 'alpha_review' && held.length === 0 && stale.length === 0) return null;
    const command = stage === 'alpha_review' ? 'surety session open designer --review' : 'surety session open designer';
    const inventoryFailed = state.inventory_failure && state.inventory_failure.count >= INVENTORY_FAILURES_NAMED ? state.inventory_failure : null;
    const evidence = {
      stage,
      held_stages: held,
      stale_screens: manifest.stale_screens,
      command,
      ...(state.note ? { note: state.note } : {}),
      ...(inventoryFailed ? { inventory_failure: inventoryFailed } : {}),
      // The batch refused at raise (D7 §7.4; SEAM.md §519): what differs.
      ...(state.inventory_difference ? { inventory_difference: state.inventory_difference } : {}),
      // An `open` the engine could not carry out, and the session open now
      // (the review's S2).
      ...(state.open_refused ? { open_refused: state.open_refused } : {}),
      ...(session ? { designer_session: session } : {}),
      // A design batch held behind a pending correction (objection 166).
      ...(deferred.length > 0
        ? { batches_deferred: deferred.map((b) => ({ spec_change_request: b.spec_change_request, design_revision: b.design_revision, pending_corrections: b.pending_corrections.map((c) => ({ proposal: c.proposal, question: c.question })) })) }
        : {}),
    };
    const what = inventoryFailed
      ? `${held.length} UI stage(s) wait for a design, and the engine could not commit the interface inventory a Designer session needs (${inventoryFailed.count} attempts; the last: ${inventoryFailed.reason}).`
      : stage === 'alpha_review'
        ? 'The Alpha is deployed: review it against the design.'
        : stage === 'revise'
          ? stale.length > 0
            ? `${stale.length} screen(s) of the approved design are stale (${stale.map((x) => `${x.screen} on ${x.target}`).join(', ')}); ${held.length} UI stage(s) wait on them.`
            : `The design was sent back for revision${state.note ? ` ("${state.note}")` : ''}; ${held.length} UI stage(s) wait on it.`
          : `${held.length} UI stage(s) wait for an approved design before they build.`;
    const also = [
      ...(deferred.length > 0 ? [`A design batch is not raised yet: it waits for ${deferred.reduce((n, b) => n + b.pending_corrections.length, 0)} pending correction(s) of the protected checks; answer those first.`] : []),
      ...(state.open_refused ? [`The Designer session asked for could not be opened (${state.open_refused.reason}).`] : []),
      ...(session ? [`Designer session ${session} is open.`] : []),
    ].join(' ');
    return {
      manifest,
      question: `${what}${also ? ` ${also}` : ''} Open a Designer session (${command}), waive the design for the held stages, turn design off, or ask again later.`,
      options: [
        {
          key: 'open',
          label: 'Open a Designer session',
          consequence: `The engine opens a Designer session for you at its next tick (as ${command} would${stage === 'alpha_review' ? ', in review mode' : ''}); no process starts before your first turn; the held stages build once the design is approved and ready.`,
          effect: { project, command, ...(stage === 'alpha_review' ? { mode: 'review' } : {}) },
          blockers: session ? [`DESIGNER_SESSION_OPEN:${session}`] : [],
        },
        {
          key: 'waive',
          label: 'Waive',
          consequence: 'The held UI stages build with no design; the waiver is recorded on each, and any design human tests stay pending.',
          effect: { project, stages: held },
          // Nothing held, nothing to waive (the review's S4): stale screens
          // alone hold no stage; a revised design answers them.
          blockers: held.length === 0 ? ['NOTHING_HELD'] : [],
        },
        { key: 'policy_off', label: 'Turn design off', consequence: 'The project policy becomes design: off (a policy revision); the holds are released.', effect: { project, change: { design: 'off' } } },
        {
          key: 'later',
          label: 'Later',
          consequence: 'Asked again at a time you give, at most design_due_max_defer from now, or at once when a new cause appears (a stage held, a screen staled, a design rejected or sent back).',
          effect: { project },
        },
      ],
      evidence: evidence as never,
    };
  },
  manifest(tx, d) {
    return dueFacts(tx, d.project!).manifest;
  },
  reraise: true,
  answer(tx, d, option, note, _facts, extra?: AnswerExtra) {
    const project = d.project!;
    // `later` (D7 §11; SEAM.md §514): the owner's time, at most
    // design_due_max_defer from now; refused before anything is consumed.
    let until: string | null = null;
    if (option === 'later') {
      const max = projectPolicy(tx.db, project).design_due_max_defer ?? 604_800;
      const bound = Date.parse(tx.at) + max * 1000;
      if (extra?.until === undefined) until = new Date(bound).toISOString();
      else {
        const at = untilTime(extra.until);
        if (at === null) throw untilRefused('"until" must be an ISO 8601 time with Z or an offset, of a date that exists.', max);
        if (at < Date.parse(tx.at)) throw untilRefused(`"until" (${String(extra.until)}) is in the past (the engine's time is ${tx.at}).`, max);
        if (at > bound) throw untilRefused(`"until" is later than design_due_max_defer (${max} s) from now (${new Date(bound).toISOString()}).`, max, { key: 'design_due_max_defer', max_seconds: max, latest: new Date(bound).toISOString() });
        until = new Date(at).toISOString();
      }
    }
    consumeDecision(tx, d, option, note);
    const state = designDueState(tx.db, project);
    if (option === 'waive') {
      const held = heldStages(tx.db, project);
      writeDueState(tx, project, { ...state, waived: [...new Set([...(state.waived ?? []), ...held])] });
      for (const stage of held) tx.emit('design.waived', { project, stage }, { decision: d.id, reason: note });
      recordMetMilestones(tx, project);
      return consumed(d);
    }
    if (option === 'later') {
      // Bound to what the question named (the review's S1): a new cause
      // ends the deferral at once (reviewDesignDue).
      writeDueState(tx, project, { ...state, deferred: deferralBinding(tx, project, { until: until!, decision: d.id }) });
      return consumed(d);
    }
    if (option === 'policy_off') {
      // A policy revision through the policy's own commit (D1 §11.4): the
      // widening route's effect, with the change named (a narrowing: it
      // confirms nothing beyond the owner's answer here).
      const approval = recordApproval(tx, d, { consequence: 'design turned off', subjectType: 'project', subjectId: project });
      return consumed(d, [recordIntent(tx, d, { approval, kind: 'policy_widening', plan: { change: { design: 'off' } } })]);
    }
    // `open` (D7 §11; D6 §2.1): the Designer session is allocated by the
    // design driver at the next tick (a session's workspace is made on the
    // main thread), no process before the owner's first turn, in review mode
    // for an `alpha_review` question (the review's S3).
    requestDesignerSession(tx, project, d.id, (state.stage ?? 'before_build') === 'alpha_review' ? 'review' : null);
    return { ...consumed(d), effects: [{ kind: 'tick' }] };
  },
};

const untilRefused = (reason: string, max: number, subject: Record<string, unknown> = {}) =>
  new Refusal(422, 'invalid_value', reason, `Give a time from now to at most design_due_max_defer (${max} s) from now, as YYYY-MM-DDTHH:MM[:SS[.sss]] with Z or an offset; nothing was changed.`, { field: 'until', ...subject });

// An ISO 8601 time with its zone (Z or ±HH:MM) whose date and time exist
// (2026-02-30 does not), in ms; null otherwise.
export function untilTime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(v);
  if (!m) return null;
  const [y, mo, da, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return null;
  if (da < 1 || da > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  if (m[8] !== 'Z' && (Number(m[9]) > 23 || Number(m[10]) > 59)) return null;
  const at = Date.parse(v);
  return Number.isFinite(at) ? at : null;
}

// What a deferral was answered on: the held stages, the stale screens, the
// stage and the designs rejected or sent back so far.
function deferralBinding(tx: Tx, project: string, args: { until: string; decision: string }): NonNullable<DesignDueState['deferred']> {
  const state = designDueState(tx.db, project);
  return {
    until: args.until,
    decision: args.decision,
    held: heldStages(tx.db, project),
    stale: currentStaleScreens(tx.db, project).map((s) => `${s.screen}/${s.target}`),
    stage: state.stage ?? 'before_build',
    rejected: designsTurnedDown(tx.db, project),
  };
}
const designsTurnedDown = (db: Tx['db'], project: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM "decisions" WHERE "project" = ? AND "kind" = 'design_approval' AND "status" = 'consumed' AND json_extract("answer", '$.option') IN ('reject', 'revise')`).get(project) as { n: number }).n;

// A cause the deferral was not answered on (D7 §11): a stage held or a
// screen staled since, the stage moved, a design rejected or sent back.
function newCause(tx: Tx, project: string, deferred: NonNullable<DesignDueState['deferred']>): boolean {
  const now = deferralBinding(tx, project, { until: deferred.until, decision: deferred.decision });
  return now.held.some((x) => !deferred.held.includes(x)) || now.stale.some((x) => !deferred.stale.includes(x)) || now.stage !== deferred.stage || now.rejected > deferred.rejected;
}

// A Designer session asked for by an owner's answer (design_due's `open`,
// a replan blocker's `design`): allocated by the design driver at the next
// tick (design/driver.ts openRequested), in review mode for a review.
export function requestDesignerSession(tx: Tx, project: string, decision: string, mode: 'review' | null = null): void {
  const { open_refused: _r, open_mode: _m, ...state } = designDueState(tx.db, project);
  writeDueState(tx, project, { ...state, open_requested: decision, ...(mode ? { open_mode: mode } : {}) });
}

// An `open` the engine could not carry out (the review's S2): recorded so
// the next question says why, and asked again now.
export function openRefused(tx: Tx, args: { project: string; decision: string; reason: string }): void {
  writeDueState(tx, args.project, { ...designDueState(tx.db, args.project), open_refused: { decision: args.decision, reason: args.reason.slice(0, 500), at: tx.at } });
  reviewDesignDue(tx, args.project);
}

// The review of design_due (D7 §11): raised while a stage is held or a
// screen stale and none is open, its next generation when its subjects
// changed; closed (invalidated, "the question no longer stands") by the
// decisions' review when nothing it names holds. Not while a deferral runs,
// unless a new cause appears. Idempotent.
export function reviewDesignDue(tx: Tx, project: string): void {
  const digest = (tx.db.prepare('SELECT "design_inventory_digest" FROM "projects" WHERE "id" = ?').get(project) as { design_inventory_digest: string | null } | undefined)?.design_inventory_digest ?? null;
  const state = designDueState(tx.db, project);
  // No inventory yet: no question while its derivation is under way; one
  // naming the failure once its commit has failed repeatedly (no silent
  // stall, D7 §11; BS6 §4.1 rule 25).
  if (digest === null && (state.inventory_failure?.count ?? 0) < INVENTORY_FAILURES_NAMED) return;
  if (state.deferred) {
    if (Date.parse(state.deferred.until) > Date.parse(tx.at) && !newCause(tx, project, state.deferred)) return;
    const { deferred: _done, ...rest } = state;
    writeDueState(tx, project, rest);
  }
  // A revision's cause settled (the covering design approved, nothing held
  // and nothing stale): the next question starts from before_build again.
  if (state.stage === 'revise' && heldStages(tx.db, project).length === 0 && currentStaleScreens(tx.db, project).length === 0) {
    const { stage: _s, note: _n, inventory_difference: _d, ...rest } = designDueState(tx.db, project);
    writeDueState(tx, project, rest);
  }
  raiseQuestion(tx, { project, kind: 'design_due', subjectType: 'project', subjectId: project });
}
