// Slice 34's replan cases (M424; SEAM.md §403): the replan's scripts (held,
// refused, dumping its package), the pump that carries phase 1 to its
// completion while a replan holds, and the readers of the replan's runs and
// proposals. Kernel lane: the scripted backend, the scripted check boundary;
// nothing acts on a process but the test's own engine and its scripted roles.

import { STAGES, phasePlanMd } from './reference.mjs';
import { ROUTED_KINDS, replanScript, runsOfProject, workOf } from './drive.mjs';
import { pumpNoIdle } from './review31b.mjs';
import { step } from '../scripted.mjs';

const text = (v) => `${JSON.stringify(v, null, 2)}\n`;
// A hold that heartbeats, so its lease is renewed while the clock moves (as M15's).
const HOLD = step.hold('gate', { heartbeat_ms: 250 });
const RESULT = (summary) => step.result({ status: 'completed', summary, plan: 'phase-2', conformance: 'within_baseline' });

// phase-2.json prepared against the versions given and the run's HEAD; the
// steps `before` the writes and `after` them, then the result.
export function replanWith({ spec_version = 1, architecture_version = 1, roadmap_version = 1, stages = STAGES[2], before = [], after = [] } = {}) {
  const plan = { phase: 2, prepared_against: { spec_version, architecture_version, roadmap_version, revision: '__HEAD__' }, stages, conformance: 'within_baseline' };
  return {
    steps: [
      ...before,
      { write: { path: '.surety/phases/phase-2.json', content: text(plan), substitute_head: true } },
      step.write('.surety/phases/phase-2.md', phasePlanMd(2)),
      ...after,
      RESULT('phase 2 planned'),
    ],
  };
}

// A replan that dumps its package first and holds before its result.
export const replanDumpedAndHeld = () => replanWith({ before: [step.probe('context_dump')], after: [HOLD] });
// A replan held before its result (its plan written, not yet committed).
export const replanHeld = (versions = {}) => replanWith({ ...versions, after: [HOLD] });
// A replan whose stage 3 implements R9, which the specification lacks
// (PLAN_UNKNOWN_REQUIREMENT); `dump` dumps its package first.
export const UNKNOWN_KEY = 'R9';
export const replanUnknownRequirement = ({ dump = false } = {}) =>
  replanWith({ stages: STAGES[2].map((s) => (s.number === 3 ? { ...s, implements: [...s.implements, UNKNOWN_KEY] } : s)), before: dump ? [step.probe('context_dump')] : [] });
export { replanScript };

// The replan's launches, and whether the latest holds.
export const replanLaunches = (fx) => fx.scripted.launches({ work_kind: 'replan' });
export const replanHolding = (fx) => {
  const launch = replanLaunches(fx).at(-1);
  if (!launch) return undefined;
  return fx.scripted.eventsOf(launch.pid, 'holding').some((e) => e.hold === 'gate' && (launch.invocation === null || e.invocation === launch.invocation)) ? launch : undefined;
};

// Phase 1 carried to completion without waiting for idle (a held replan is
// a live run), until the replan's launch holds. `answerKinds`: the routed
// decisions the owner answers on the way.
export const untilReplanHolds = (fx, ctx, { answerKinds = ROUTED_KINDS } = {}) =>
  pumpNoIdle(fx, ctx, () => replanHolding(fx), { what: 'phase 1 complete and the replan holding', max: 600, answerKinds });

// The runs of the project's replan work, oldest first.
export function replanRuns(home, project) {
  const items = new Set(workOf(home, project, 'replan').map((w) => w.id));
  return runsOfProject(home, project).filter((r) => items.has(r.work_item));
}
