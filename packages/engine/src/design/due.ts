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
// Objection 126 (open for Sean): this slice opens the Designer session by
// the owner's own command, never by answering `open`; an `open` answer is
// consumed and, while a stage stays held, the question is raised again at
// the next review, so a hold is never without an open question naming it.

import { type KindSpec, type Subject, consumed, recordApproval, recordIntent } from '../store/transitions/queue.js';
import { consumeDecision } from '../store/transitions/decisions.js';
import { openDecision } from '../store/transitions/decisions.js';
import { policyRevision, projectPolicy } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import { recordMetMilestones } from '../scheduler/milestones.js';
import { raiseQuestion } from '../store/transitions/queue.js';
import { type DesignDueState, designDueState, heldStages } from './readiness.js';
import { designPolicyOf } from './policy.js';

export const DESIGN_DUE_KEYS = ['stage', 'held_stages', 'stale_screens', 'policy_revision'];

export function writeDueState(tx: Tx, project: string, state: DesignDueState): void {
  tx.db.prepare('UPDATE "projects" SET "design_due" = ? WHERE "id" = ?').run(JSON.stringify(state), project);
}

function dueFacts(tx: Tx, project: string) {
  const state = designDueState(tx.db, project);
  const stage = state.stage ?? 'before_build';
  const held = heldStages(tx.db, project);
  const manifest = { stage, held_stages: held, stale_screens: [] as { screen: string; target: string }[], policy_revision: policyRevision(tx.db, project) };
  return { state, stage, held, manifest };
}

export const DESIGN_DUE: KindSpec = {
  preview(tx, d: Subject) {
    const project = d.project!;
    const { state, stage, held, manifest } = dueFacts(tx, project);
    if (designPolicyOf(tx.db, project) === 'off' && stage !== 'alpha_review') return null;
    if (stage !== 'alpha_review' && held.length === 0) return null;
    const command = stage === 'alpha_review' ? 'surety session open designer --review' : 'surety session open designer';
    const evidence = { stage, held_stages: held, stale_screens: manifest.stale_screens, command, ...(state.note ? { note: state.note } : {}) };
    const what =
      stage === 'alpha_review'
        ? 'The Alpha is deployed: review it against the design.'
        : stage === 'revise'
          ? `The design was sent back for revision${state.note ? ` ("${state.note}")` : ''}; ${held.length} UI stage(s) wait on it.`
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
  answer(tx, d, option, note) {
    consumeDecision(tx, d, option, note);
    const project = d.project!;
    const state = designDueState(tx.db, project);
    if (option === 'waive') {
      const held = heldStages(tx.db, project);
      writeDueState(tx, project, { ...state, waived: [...new Set([...(state.waived ?? []), ...held])] });
      for (const stage of held) tx.emit('design.waived', { project, stage }, { decision: d.id, reason: note });
      recordMetMilestones(tx, project);
      return consumed(d);
    }
    if (option === 'later') {
      const max = projectPolicy(tx.db, project).design_due_max_defer ?? 604_800;
      writeDueState(tx, project, { ...state, later_until: new Date(Date.parse(tx.at) + max * 1000).toISOString() });
      return consumed(d);
    }
    if (option === 'policy_off') {
      // A policy revision through the policy's own commit (D1 §11.4): the
      // widening route's effect, with the change named (a narrowing: it
      // confirms nothing beyond the owner's answer here).
      const approval = recordApproval(tx, d, { consequence: 'design turned off', subjectType: 'project', subjectId: project });
      return consumed(d, [recordIntent(tx, d, { approval, kind: 'policy_widening', plan: { change: { design: 'off' } } })]);
    }
    // `open`: the owner opens the session by its command (objection 126).
    return consumed(d);
  },
};

// The review of design_due (D7 §11): raised while a stage is held and none
// is open (and no deferral runs), its next generation when its subjects
// changed; closed (invalidated, "the question no longer stands") by the
// decisions' review when nothing it names is held. Idempotent.
export function reviewDesignDue(tx: Tx, project: string): void {
  const digest = (tx.db.prepare('SELECT "design_inventory_digest" FROM "projects" WHERE "id" = ?').get(project) as { design_inventory_digest: string | null } | undefined)?.design_inventory_digest ?? null;
  if (digest === null) return;
  const state = designDueState(tx.db, project);
  if (state.later_until && Date.parse(state.later_until) > Date.parse(tx.at)) return;
  if (state.later_until) {
    const { later_until: _done, ...rest } = state;
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
