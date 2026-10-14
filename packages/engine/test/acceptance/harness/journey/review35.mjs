// The slice-35 review's cases (SEAM.md §415): early replacements that are
// pending while the stages they name move. Kernel lane: the scripted backend,
// the scripted check boundary; nothing acts on a process but the test's own
// engine and its scripted roles.

import assert from 'node:assert/strict';

import { recordExit } from '../checks/selection.mjs';
import { executionRow } from '../checks/fixtures.mjs';
import { answer, decision } from '../decisions.mjs';
import { roleThat } from '../gitruns.mjs';
import { tick } from '../runs.mjs';
import { step } from '../scripted.mjs';
import { withStore } from '../store.mjs';
import { ROUTED_KINDS, builderScript, openDecisions, phasePlansOf, queuedExecutions, stagesOfPlan, workOf } from './drive.mjs';
import { journey35, nextReplanOutcome, phaseOf, replan35, roadmapWith } from './plan35.mjs';
import { postChange } from './review31b.mjs';
import { CHECK_DEFS, CHECK_PROGRAMS, REQUIREMENTS, STAGES, authoringFiles, specText } from './reference.mjs';

export const S1 = STAGES[1][0];
export const S2 = STAGES[1][1];
export const S3 = { ...STAGES[2][0], number: 3, depends_on: [2] };
const DEFS = (k) => `.surety/checks/defs/${k}.json`;
// Phase 1 of three stages (R1, R2, R3), its authoring covering R3 (M430's).
export const ROADMAP3 = { '.surety/roadmap/roadmap.json': roadmapWith({ version: 1, phases: [{ ...phaseOf(1), requirement_ids: ['R1', 'R2', 'R3'] }, { ...phaseOf(2), requirement_ids: ['R4'] }] }) };
const AUTHORING3 = {
  ...authoringFiles(1),
  [DEFS('accept-r3')]: CHECK_DEFS[2][DEFS('accept-r3')],
  [DEFS('integration-tally')]: CHECK_DEFS[2][DEFS('integration-tally')],
  '.surety/checks/tests/tally.test.mjs': CHECK_PROGRAMS['.surety/checks/tests/tally.test.mjs'],
  '.surety/checks/tests/integration-tally.test.mjs': CHECK_PROGRAMS['.surety/checks/tests/integration-tally.test.mjs'],
};
export const authoring3 = roleThat(Object.entries(AUTHORING3).map(([path, content]) => step.write(path, content)), { proposal: { rationale: 'Phase 1\'s checks, R3 included.', requested_change_kind: 'unclassifiable' } });
// A change touching one phase-1 requirement's statement (`key`), as version 2.
export function changeTouching(key, statement) {
  const text = specText({ version: 2, requirements: REQUIREMENTS.map((r) => (r.key === key ? { ...r, statement } : r)) });
  return roleThat([step.write('.surety/spec/spec.md', text)], { changes: [{ key, kind: 'text_changed', reason: `${key} restated` }] });
}
export const HELD = (stage) => ({ steps: [step.hold('gate', { heartbeat_ms: 250 }), ...builderScript(stage).steps] });
export const changed = (s, extra = {}) => ({ ...s, tasks: [...s.tasks, `revised: ${s.goal}`], ...extra });

export const NO_PLAN_ANSWER = ROUTED_KINDS.filter((k) => k !== 'plan_approval');
export const active = (x) => x.active === 1 || x.active === true;
export const generationOf = (home, project, phase, n) => phasePlansOf(home, project).find((x) => x.phase_number === phase && x.generation === n) ?? null;
export const stageWorkOf = (home, project, stage) => workOf(home, project, 'stage_build').find((w) => w.subject?.stage === stage.id);
export const openBlockerAbout = (home, item) => {
  const row = withStore(home, (db) => db.prepare(`SELECT "id" FROM "decisions" WHERE "kind" = 'blocker' AND "subject_id" = ? AND "status" = 'open' ORDER BY "id" DESC`).get(item));
  return row ? decision(home, row.id) : null;
};

// The reference project at `developing` (tier, phase 1's stages and
// roadmap, policy), with a change touching `key` requested at once and its
// replacement (`replacement`, phase 1, declared `uncertain`) pending before
// any stage builds: readiness is withheld (the authoring decision left open)
// until the replacement awaits the owner. Returns the journey and the
// pending approval.
export async function replacementPending(t, { tier = 'T1', three = true, policy = {}, key = three ? 'R3' : 'R2', replacement, after = [], stageBuild, specVersion = 2 } = {}) {
  const J = await journey35(t, { tier, policy, ...(three ? { over: ROADMAP3, stages: [S1, S2, S3] } : {}) });
  const { fx, p, ctx, plan } = J;
  if (three) fx.scripted.kindScript('check_authoring', [authoring3]);
  if (stageBuild) fx.scripted.kindScript('stage_build', stageBuild);
  fx.scripted.kindScript('spec_change', changeTouching(key, `The statement of ${key}, restated by the owner.`));
  fx.scripted.kindScript('replan', [replanOf(replacement, specVersion), ...after]);
  await postChange(fx, ctx, `Restate ${key}.`);
  const out = await nextReplanOutcome(fx, ctx, 1, { runs: new Set(), approvals: new Set(), published: new Set([plan.id]) }, { max: 200, answerKinds: ['spec_change'] });
  assert.ok(out.approval, `the fixture is live: the replacement awaits the owner (${JSON.stringify(out.failed ? [out.failed.reason_class, out.failed.reason_text] : Object.keys(out))})`);
  return { ...J, pending: out.approval };
}

export const replanOf = (stages, spec_version = 2, extra = {}) => replan35({ phase: 1, spec_version, conformance: 'uncertain', stages, ...extra });

// Ticks, answering the routed decisions but `plan_approval`, recording each
// queued execution's exit by `exits(x)` (null leaves it queued), until `done`.
export async function advanceHolding(fx, ctx, done, { max = 200, exits = () => 0, what = 'the expected state' } = {}) {
  for (let i = 0; i < max; i++) {
    const v = await done();
    if (v !== undefined && v !== null && v !== false) return v;
    for (const x of queuedExecutions(fx.home, ctx.project)) {
      const code = exits(x);
      if (code === null || code === undefined) continue;
      if (executionRow(fx.home, x.id)?.status === 'queued') await recordExit(fx.engine, x.id, code).catch(() => null);
    }
    for (const d of openDecisions(fx.home, ctx.project)) {
      if (!NO_PLAN_ANSWER.includes(d.kind)) continue;
      await answer(fx.engine, ctx.project, d, d.options.some((o) => o.key === 'approve') ? 'approve' : d.options[0].key);
    }
    await tick(fx.engine, ctx.project, { rounds: 1 });
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what}: not reached within ${max} rounds`);
}

// The open `plan_approval` now (a harmless head move re-raises a pending one
// as its next generation, slice 34's ruling; SEAM.md §405), or null.
export const currentApproval = (home, project) => {
  const row = withStore(home, (db) => db.prepare(`SELECT "id" FROM "decisions" WHERE "project" = ? AND "kind" = 'plan_approval' AND "status" = 'open' ORDER BY "id" DESC`).get(project));
  return row ? decision(home, row.id) : null;
};

export { stagesOfPlan };
