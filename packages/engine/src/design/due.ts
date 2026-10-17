// `design_due` and no silent stalls (D7 §11; A.8; G5; SEAM.md §485): one
// open per project at a time, subject the project, human only. Raised when a
// UI stage is first held for design (at derivation, naming the stages it will
// hold), when a design is sent back for revision, and on `alpha_complete`
// under `at_alpha` or `both`. Its question names the held stages, the stale
// screens and the exact command; a new cause updates its subjects, which
// stales it and raises the next generation, never a second row. The engine
// never answers it; it is closed by the engine only when no stage it names
// is held any more (the design ready, waived, or the policy off).
//
// Objections 126 and 145 (open for Sean): what `open` and `later` do to the
// question itself. As built in slice 40 and kept: an `open` answer is
// consumed, the Designer session allocated (slice 44), and while a stage
// stays held the question is raised again at the next review; a `later`
// answer is consumed and nothing is asked until the owner's time passes.
// Stale screens raise it as held stages do (D7 §9.1).

import { type AnswerExtra, type KindSpec, type Subject, consumed, recordApproval, recordIntent } from '../store/transitions/queue.js';
import { Refusal } from '../refusal.js';
import { consumeDecision } from '../store/transitions/decisions.js';
import { openDecision } from '../store/transitions/decisions.js';
import { policyRevision, projectPolicy } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import { recordMetMilestones } from '../scheduler/milestones.js';
import { raiseQuestion } from '../store/transitions/queue.js';
import { type DesignDueState, designDueState, heldStages } from './readiness.js';
import { designPolicyOf } from './policy.js';
import { currentStaleScreens } from './stale.js';

export const DESIGN_DUE_KEYS = ['stage', 'held_stages', 'stale_screens', 'policy_revision', 'inventory_failure'];

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

function dueFacts(tx: Tx, project: string) {
  const state = designDueState(tx.db, project);
  const stage = state.stage ?? 'before_build';
  const held = heldStages(tx.db, project);
  const failed = state.inventory_failure && state.inventory_failure.count >= INVENTORY_FAILURES_NAMED ? state.inventory_failure.reason : null;
  // The approved design's stale screens with their targets (D7 §9.1, §11).
  const stale = currentStaleScreens(tx.db, project);
  const manifest = { stage, held_stages: held, stale_screens: stale, policy_revision: policyRevision(tx.db, project), inventory_failure: failed };
  return { state, stage, held, stale, manifest };
}

export const DESIGN_DUE: KindSpec = {
  preview(tx, d: Subject) {
    const project = d.project!;
    const { state, stage, held, stale, manifest } = dueFacts(tx, project);
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
    return {
      manifest,
      question: `${what} Open a Designer session (${command}), waive the design for the held stages, turn design off, or ask again later.`,
      options: [
        { key: 'open', label: 'Open a Designer session', consequence: `You open it with ${command}; the held stages build once the design is approved and ready.`, effect: { project, command } },
        { key: 'waive', label: 'Waive', consequence: 'The held UI stages build with no design; the waiver is recorded on each, and any design human tests stay pending.', effect: { project, stages: held } },
        { key: 'policy_off', label: 'Turn design off', consequence: 'The project policy becomes design: off (a policy revision); the holds are released.', effect: { project, change: { design: 'off' } } },
        { key: 'later', label: 'Later', consequence: 'Asked again at a time you give, at most design_due_max_defer from now.', effect: { project } },
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
        const at = typeof extra.until === 'string' ? Date.parse(extra.until) : Number.NaN;
        if (!Number.isFinite(at) || !/^\d{4}-\d{2}-\d{2}T/.test(String(extra.until))) {
          throw new Refusal(400, 'invalid_value', '"until" must be an ISO 8601 time.', `Give the time to ask again, at most design_due_max_defer (${max} s) from now; nothing was changed.`, { field: 'until' });
        }
        if (at > bound) {
          throw new Refusal(400, 'invalid_value', `"until" is later than design_due_max_defer (${max} s) from now (${new Date(bound).toISOString()}).`, 'Give a time within design_due_max_defer; nothing was changed.', {
            field: 'until',
            key: 'design_due_max_defer',
            max_seconds: max,
            latest: new Date(bound).toISOString(),
          });
        }
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
      writeDueState(tx, project, { ...state, later_until: until! });
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
    // main thread), no process before the owner's first turn. What the
    // answer does to the question itself is objection 126's, open for Sean:
    // consumed here, and raised again by the next review while a stage it
    // named stays held, as slice 40 built it.
    requestDesignerSession(tx, project, d.id);
    return { ...consumed(d), effects: [{ kind: 'tick' }] };
  },
};

// A Designer session asked for by an owner's answer (design_due's `open`,
// a replan blocker's `design`): allocated by the design driver at the next
// tick (design/driver.ts openRequested).
export function requestDesignerSession(tx: Tx, project: string, decision: string): void {
  writeDueState(tx, project, { ...designDueState(tx.db, project), open_requested: decision });
}

// The review of design_due (D7 §11): raised while a stage is held and none
// is open (and no deferral runs), its next generation when its subjects
// changed; closed (invalidated, "the question no longer stands") by the
// decisions' review when nothing it names is held. Idempotent.
export function reviewDesignDue(tx: Tx, project: string): void {
  const digest = (tx.db.prepare('SELECT "design_inventory_digest" FROM "projects" WHERE "id" = ?').get(project) as { design_inventory_digest: string | null } | undefined)?.design_inventory_digest ?? null;
  const state = designDueState(tx.db, project);
  // No inventory yet: no question while its derivation is under way; one
  // naming the failure once its commit has failed repeatedly (no silent
  // stall, D7 §11; BS6 §4.1 rule 25).
  if (digest === null && (state.inventory_failure?.count ?? 0) < INVENTORY_FAILURES_NAMED) return;
  if (state.later_until && Date.parse(state.later_until) > Date.parse(tx.at)) return;
  if (state.later_until) {
    const { later_until: _done, ...rest } = state;
    writeDueState(tx, project, rest);
  }
  // A revision's cause settled (the covering design approved, nothing held
  // and nothing stale): the next question starts from before_build again.
  if (state.stage === 'revise' && heldStages(tx.db, project).length === 0 && currentStaleScreens(tx.db, project).length === 0) {
    const { stage: _s, note: _n, inventory_difference: _d, ...rest } = designDueState(tx.db, project);
    writeDueState(tx, project, rest);
  }
  const open = openDecision(tx, project, 'design_due', 'project', project);
  if (open && open.status === 'open') {
    // refreshDecisions keeps it current; a subject that moved is raised again there.
    raiseQuestion(tx, { project, kind: 'design_due', subjectType: 'project', subjectId: project });
    return;
  }
  raiseQuestion(tx, { project, kind: 'design_due', subjectType: 'project', subjectId: project });
}
