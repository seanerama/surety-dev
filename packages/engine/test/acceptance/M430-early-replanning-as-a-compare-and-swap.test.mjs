// M430, early replanning as a compare-and-swap (slice 35; kernel lane). M5
// plan §3.5 M430 (a) to (d), (f), (g); D6-F04; D6 §5.7, §6.6, A.5; F
// §3.10.7; B08; the driver's rulings of 2026-10-13 (pending routed
// replacements answered during a held run until slice 37; a kept stage's
// number with other inputs is PLAN_DUPLICATE_STAGE; a superseded `building`
// stage integrates as history and its work completes `superseded`; the
// Reviewer's `fix` against the plan as `target: "plan"`; `replan` on the
// parked blocker and on X2's); SEAM.md §§406, 413.
//
// (a) each trigger with its evidence: an approved spec change touching the
//     current phase (`spec_change`); a parked stage's blocker answered
//     `replan` (`blocker_replan`); an objection's X2 blocker answered
//     `replan` (`objection_upheld`); a Reviewer's `contract_conflict` with
//     `fix` against the plan (`contract_conflict`);
// (b) an objection filed alone: nothing;
// (c) the replacement against `planned`, `building` and `integrated` stages:
//     generation 2 active, 1 `replaced`; the planned stage cancelled with its
//     work; the integrated one kept; only the remainder registered;
// (d) the `building` stage with changed tasks: its late integration is
//     history, its work `superseded`; with every input unchanged: retained;
// (f) delivery and dispatch from the active set; the finding kept;
// (g) what became stale recorded.
// (c) the open plan in an early replan's package (the driver's ruling of
//     2026-10-17 on M442 (c)'s intermittent failure; SEAM.md §548): its
//     stages' `depends_on` stated as stage numbers, the plan's own form, so
//     that a replan copying unbuilt stages that depend on one another as
//     the package states them is not refused, and publishes;
// (c), (d) S2 (E172 item 7; the driver's ruling of 2026-10-20 under Sean's
//     delegation; SEAM.md §556): a replacement that keeps a stage (integrated
//     or verified) whose dependency it supersedes is refused at the plan
//     check, `PLAN_UNKNOWN_STAGE` naming the kept stage and that dependency:
//     nothing published, the kept stage not dispatched. Stage 2 (depending on
//     stage 1) integrated; stage 1 integrated, its work parked, its blocker
//     answered `replan`, so the swap supersedes it (the trigger's own
//     subject) and keeps stage 2; the replacement lists stage 1 changed under
//     its number (stage 2 omitted, or listed as built), or renumbered 3.
// (e) is in `M430-two-replacements-and-a-restart.test.mjs`. The floor of
// (f) has no case: the reference project has no sensitive area (COVERAGE).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, decisionsOn } from './harness/decisions.mjs';
import { findingsOf, raiseFindings, review } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { ROUTED_KINDS, builderScript, candidatesOfProject, phasePlansOf, planOfPhase, pump, readPlan, runsOfProject, stagesOfPlan, workOf } from './harness/journey/drive.mjs';
import { journey35, nextReplanOutcome, openPlanApprovals, outcomes, phaseOf, planCheckRows, replan35, roadmapWith, subjectsOf } from './harness/journey/plan35.mjs';
import { advanceHolding, changed, openBlockerAbout } from './harness/journey/review35.mjs';
import { postChange, pumpNoIdle } from './harness/journey/review31b.mjs';
import { CHECK_DEFS, CHECK_PROGRAMS, REQUIREMENTS, STAGES, authoringFiles, specText } from './harness/journey/reference.mjs';
import { tick } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';

const json = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);
const active = (x) => x.active === 1 || x.active === true;
const S1 = STAGES[1][0];
const S2 = STAGES[1][1];
const S3 = { ...STAGES[2][0], number: 3, depends_on: [2] };
const THREE = [S1, S2, S3];
const ROADMAP3 = { '.surety/roadmap/roadmap.json': roadmapWith({ version: 1, phases: [{ ...phaseOf(1), requirement_ids: ['R1', 'R2', 'R3'] }, { ...phaseOf(2), requirement_ids: ['R4'] }] }) };
// Phase 1's authoring, R3's checks included.
const DEFS = (k) => `.surety/checks/defs/${k}.json`;
const AUTHORING3 = {
  ...authoringFiles(1),
  [DEFS('accept-r3')]: CHECK_DEFS[2][DEFS('accept-r3')],
  [DEFS('integration-tally')]: CHECK_DEFS[2][DEFS('integration-tally')],
  '.surety/checks/tests/tally.test.mjs': CHECK_PROGRAMS['.surety/checks/tests/tally.test.mjs'],
  '.surety/checks/tests/integration-tally.test.mjs': CHECK_PROGRAMS['.surety/checks/tests/integration-tally.test.mjs'],
};
const authoring3 = roleThat(Object.entries(AUTHORING3).map(([path, content]) => step.write(path, content)), { proposal: { rationale: 'Phase 1\'s checks, R3 included.', requested_change_kind: 'unclassifiable' } });
const R3_V2 = specText({ version: 2, requirements: REQUIREMENTS.map((r) => (r.key === 'R3' ? { ...r, statement: 'The library counts the successful sums served since the process started.' } : r)) });
const changeScript = roleThat([step.write('.surety/spec/spec.md', R3_V2)], { changes: [{ key: 'R3', kind: 'text_changed', reason: 'only successful sums are counted' }] });
const HELD_S2 = { steps: [step.hold('gate', { heartbeat_ms: 250 }), ...builderScript(2).steps] };

const replacementOf = (home, project) => phasePlansOf(home, project).filter((x) => x.phase_number === 1).map((x) => ({ ...x, replacement: json(x.replacement) }));
const runOf = (home, project, item) => runsOfProject(home, project).filter((r) => r.work_item === item);
const stageWorkOf = (home, project, stage) => workOf(home, project, 'stage_build').find((w) => w.subject?.stage === stage.id);

// The T1 project with the three-stage phase 1, a spec change touching R3
// approved before readiness (the authoring decision withheld), the
// replacement routed (`uncertain`) and pending, then readiness given, S1
// integrated and S2's Builder held. Returns the state at the hold.
async function replacementPendingWithS2Held(t, replacementStages) {
  const { fx, p, ctx, plan } = await journey35(t, { tier: 'T1', over: ROADMAP3, stages: THREE });
  fx.scripted.kindScript('check_authoring', [authoring3]);
  fx.scripted.kindScript('spec_change', changeScript);
  fx.scripted.kindScript('stage_build', [builderScript(1), HELD_S2, builderScript(2), builderScript(3), builderScript(3), builderScript(4)]);
  fx.scripted.kindScript('replan', [replan35({ phase: 1, spec_version: 2, conformance: 'uncertain', stages: replacementStages, before: [{ probe: { action: 'context_dump' } }] }), replan35({ spec_version: 2 })]);
  await postChange(fx, ctx, 'R3 counts successful sums only.');
  // Readiness withheld: only the spec change is answered until the replacement is pending.
  const outcome = await nextReplanOutcome(fx, ctx, 1, { runs: new Set(), approvals: new Set(), published: new Set([plan.id]) }, { max: 200, answerKinds: ['spec_change'] });
  assert.ok(outcome.approval, `the replacement routed to the owner and pending (${JSON.stringify(outcome.failed ? [outcome.failed.reason_class, outcome.failed.reason_text] : Object.keys(outcome))})`);
  const stagesBefore = stagesOfPlan(fx.home, plan.id);
  const answerKinds = ROUTED_KINDS.filter((k) => k !== 'plan_approval');
  await pumpNoIdle(fx, ctx, () => {
    const launch = fx.scripted.launches({ work_kind: 'stage_build' })[1];
    return launch && fx.scripted.eventsOf(launch.pid, 'holding').length > 0 ? launch : undefined;
  }, { what: 'S1 integrated and S2\'s Builder holding', max: 200, answerKinds });
  const states = Object.fromEntries(stagesOfPlan(fx.home, plan.id).map((s) => [s.number, s.status]));
  assert.deepEqual(states, { 1: 'integrated', 2: 'building', 3: 'planned' }, 'the fixture is live: integrated, building and planned at the swap');
  return { fx, p, ctx, plan, stagesBefore, answerKinds };
}

// S2 (E172 item 7; SEAM.md §556): the T2 reference project (stage 2 depends
// on stage 1), every check held queued until stage 2 integrates, then
// accept-r1 failing: stage 1 integrated with its work parked
// (`repair_attempts_max` 0) and its blocker answered `replan`, stage 2
// integrated. The replan (and its repair) writes `replacement`. Returns the
// replan's next outcome, the last plan check and stage 2's runs before.
async function keptDependentOfTheSubject(t, replacement) {
  const { fx, p, ctx, plan } = await journey35(t, { policy: { repair_attempts_max: 0 } });
  fx.scripted.kindScript('stage_build', [builderScript(1), builderScript(2), builderScript(1), builderScript(1)]);
  fx.scripted.kindScript('replan', [replan35({ phase: 1, stages: replacement }), replan35({ phase: 1, stages: replacement })]);
  const [s1, s2] = stagesOfPlan(fx.home, plan.id);
  await advanceHolding(fx, ctx, () => (stagesOfPlan(fx.home, plan.id)[1]?.status === 'integrated' ? true : undefined), { exits: () => null, what: 'stage 2 integrated, the checks held' });
  const blocker = await advanceHolding(fx, ctx, () => {
    const w = stageWorkOf(fx.home, p.id, s1);
    return w?.status === 'parked' ? openBlockerAbout(fx.home, w.id) : undefined;
  }, { exits: (x) => (x.key === 'accept-r1' ? 1 : 0), what: 'stage 1\'s work parked', max: 120 });
  const now = Object.fromEntries(stagesOfPlan(fx.home, plan.id).map((s) => [s.number, s]));
  assert.ok(now[1].status === 'integrated' && ['integrated', 'verified'].includes(now[2].status) && JSON.stringify(json(now[2].depends_on)) === JSON.stringify([s1.id]), `the fixture is live: stage 1 integrated and parked, stage 2 built on it (${JSON.stringify(Object.values(now).map((s) => [s.number, s.status, s.depends_on]))})`);
  assert.ok(blocker.options.some((o) => o.key === 'replan'), 'stage 1\'s blocker offers replan');
  const s2work = stageWorkOf(fx.home, p.id, s2);
  const s2runs = runOf(fx.home, p.id, s2work.id).length;
  assert.equal((await answer(fx.engine, p.id, blocker, 'replan')).status, 200, 'the owner answers replan');
  const out = await nextReplanOutcome(fx, ctx, 1, outcomes([plan.id]), { max: 200 });
  return { fx, p, plan, out, check: planCheckRows(fx.home, p.id).at(-1), s2work, s2runs };
}

// The ruling's three observables: refused naming stage 2 and its dependency
// 1, nothing published, stage 2 not dispatched.
function assertKeptDependentRefused({ fx, p, out, check, s2work, s2runs }, how) {
  const named = subjectsOf(check, 'PLAN_UNKNOWN_STAGE').some((s) => /^stage 2\s*(->|:)\s*(stage\s*)?1\b/.test(s));
  assert.ok(
    out.failed && check?.outcome === 'refused' && named,
    `a replacement keeping stage 2 while ${how} is refused at the plan check, PLAN_UNKNOWN_STAGE naming stage 2 and its dependency 1 (E172 item 7 S2; the driver's ruling) (outcome ${Object.keys(out).join(', ')}${out.failed ? `: ${out.failed.reason_text}` : ''}; check ${check?.outcome} ${JSON.stringify(check?.reasons)})`,
  );
  assert.deepEqual(phasePlansOf(fx.home, p.id).filter((x) => x.phase_number === 1 && x.generation > 1 && x.published_at).map((x) => x.generation), [], 'nothing published');
  assert.equal(runOf(fx.home, p.id, s2work.id).length, s2runs, 'the kept stage 2 not dispatched');
}

describe('M430 early replanning as a compare-and-swap', () => {
  test('(a) an approved spec change touching the current phase; (c) the swap against integrated, building and planned stages; (d) the building stage with changed tasks is history; (f) dispatch and completion from the active set; (g) the stale recorded', async (t) => {
    const S4 = { ...S2, number: 4, tasks: [...S2.tasks, 'name the refused parameter in the 400'], depends_on: [1] };
    const S5 = { ...S3, number: 5, tasks: ['write src/tally.mjs counting successful sums'], depends_on: [4] };
    const { fx, p, ctx, plan, answerKinds } = await replacementPendingWithS2Held(t, [S1, S4, S5]);
    const [replan] = workOf(fx.home, p.id, 'replan');
    assert.equal(replan.trigger_source, 'spec_change', '(a) the replan\'s trigger is the spec change');
    const [pending] = openPlanApprovals(fx.home, p.id);
    const res = await answer(fx.engine, p.id, pending, 'approve');
    assert.equal(res.status, 200, `the owner approves the replacement during S2's run (→ ${res.status} ${res.text})`);
    const g2 = await pumpNoIdle(fx, ctx, () => replacementOf(fx.home, p.id).find((x) => active(x) && x.generation === 2), { what: 'generation 2 active', max: 20, answerKinds });
    const g1 = replacementOf(fx.home, p.id).find((x) => x.id === plan.id);
    assert.equal(g1.status, 'replaced', '(c) generation 1 replaced');
    assert.ok(!active(g1), 'and not active');
    const stages1 = Object.fromEntries(stagesOfPlan(fx.home, plan.id).map((s) => [s.number, s]));
    assert.equal(stages1[3].status, 'cancelled', 'the planned S3 cancelled');
    assert.ok(stages1[3].cancelled_at, 'with cancelled_at');
    assert.equal(stageWorkOf(fx.home, p.id, stages1[3])?.status, 'cancelled', 'and its work');
    assert.equal(stages1[1].status, 'integrated', 'the integrated S1 kept, its identity and history');
    const remainder = stagesOfPlan(fx.home, g2.id);
    assert.deepEqual(remainder.map((s) => s.number).sort(), [4, 5], `only the remainder registered, no duplicate of S1 (${JSON.stringify(remainder.map((s) => s.number))})`);
    for (const s of remainder) assert.equal(workOf(fx.home, p.id, 'stage_build').filter((w) => w.subject?.stage === s.id).length, 1, `one stage_build for S${s.number}`);
    assert.ok(JSON.stringify(g2.replacement ?? {}).includes('spec_change'), `the trigger spec_change on the replacement (${JSON.stringify(g2.replacement)})`);
    assert.ok((g2.replacement?.stale ?? []).length > 0, `(g) what became stale recorded (${JSON.stringify(g2.replacement)})`);
    assert.ok(JSON.stringify(g2.replacement?.kept ?? []).includes(stages1[1].id), 'S1 listed kept');
    assert.ok(JSON.stringify(g2.replacement?.cancelled ?? []).includes(stages1[3].id), 'S3 listed cancelled');
    assert.ok(JSON.stringify(g2.replacement?.superseded ?? []).includes(stages1[2].id), 'S2 listed superseded');
    // (d) S2 released: its integration is history.
    fx.scripted.release('all', 'gate');
    await pumpNoIdle(fx, ctx, () => runOf(fx.home, p.id, stageWorkOf(fx.home, p.id, stages1[2]).id).find((r) => r.state === 'ended'), { what: 'S2\'s run to end', max: 20, answerKinds });
    const s2work = stageWorkOf(fx.home, p.id, stages1[2]);
    assert.ok(JSON.stringify(s2work).includes('superseded'), `(d) S2's work completes superseded (${JSON.stringify({ status: s2work.status, outcome: s2work.outcome })})`);
    assert.notEqual(stageWorkOf(fx.home, p.id, remainder.find((s) => s.number === 4))?.status, 'complete', 'S4\'s work is not fulfilled by S2\'s late integration');
    // (f) to completion from the active set.
    const done = await pump(fx, ctx, () => planOfPhase(fx.home, p.id, 1).find((x) => x.id === g2.id && x.completed_at), { what: 'phase 1 complete on generation 2', max: 160 });
    assert.deepEqual(runOf(fx.home, p.id, stageWorkOf(fx.home, p.id, stages1[3]).id), [], '(f) the cancelled S3 never dispatched');
    const candidates = candidatesOfProject(fx.home, p.id);
    assert.equal(candidates.length, 1, 'one T1 nomination, once S1, S4 and S5 were integrated');
    assert.equal(done.completion_binding.candidate, candidates[0].id);
    assert.equal(done.completion_binding.generation, 2, 'completed on the active generation');
  });

  test('(d) a building stage with every input unchanged: retained for the replacement, no duplicate', async (t) => {
    const S5 = { ...S3, number: 5, tasks: ['write src/tally.mjs counting successful sums'], depends_on: [2] };
    const { fx, p, ctx, plan, answerKinds } = await replacementPendingWithS2Held(t, [S1, S2, S5]);
    const [pending] = openPlanApprovals(fx.home, p.id);
    assert.equal((await answer(fx.engine, p.id, pending, 'approve')).status, 200);
    const g2 = await pumpNoIdle(fx, ctx, () => replacementOf(fx.home, p.id).find((x) => active(x) && x.generation === 2), { what: 'generation 2 active', max: 20, answerKinds });
    const stages1 = Object.fromEntries(stagesOfPlan(fx.home, plan.id).map((s) => [s.number, s]));
    assert.deepEqual(stagesOfPlan(fx.home, g2.id).map((s) => s.number), [5], `only S5 registered: S2 retained, never duplicated (${JSON.stringify(stagesOfPlan(fx.home, g2.id).map((s) => s.number))})`);
    assert.ok(JSON.stringify(g2.replacement?.retained ?? []).includes(stages1[2].id), `S2 listed retained (${JSON.stringify(g2.replacement)})`);
    fx.scripted.release('all', 'gate');
    await pumpNoIdle(fx, ctx, () => (stagesOfPlan(fx.home, plan.id).find((s) => s.number === 2)?.status === 'integrated' ? true : undefined), { what: 'S2 integrated', max: 20, answerKinds });
    const s2work = stageWorkOf(fx.home, p.id, stages1[2]);
    assert.ok(!JSON.stringify(s2work).includes('superseded'), 'S2\'s work is not superseded: its integration fulfils the replacement');
  });

  test('(c) the open plan in an early replan\'s package states depends_on as stage numbers; a replan copying the unbuilt stages as the package states them publishes (SEAM.md §548)', async (t) => {
    // Phase 1 of three stages, S2 depending on S1 and S3 on S2; a change
    // touching R3 approved before readiness, so no stage has built. The
    // replan (and its repair, should it be refused) lists S1 and S2 exactly
    // as its package's open-plan.json states them, and replaces S3 by S4.
    const S4 = { ...S3, number: 4, tasks: ['write src/tally.mjs counting successful sums'], depends_on: [2] };
    const { fx, p, ctx, plan } = await journey35(t, { tier: 'T1', over: ROADMAP3, stages: THREE });
    fx.scripted.kindScript('check_authoring', [authoring3]);
    fx.scripted.kindScript('spec_change', changeScript);
    const copying = { steps: [step.probe('context_dump'), step.planFromOpenPlan({ phase: 1, copy: [1, 2], add: [S4], spec_version: 2 }), step.result({ status: 'completed', summary: 'phase 1 replanned', plan: 'phase-1', conformance: 'within_baseline', adrs_changed: [] })] };
    fx.scripted.kindScript('replan', [copying, copying]);
    const gen1 = Object.fromEntries(stagesOfPlan(fx.home, plan.id).map((s) => [s.number, s.status]));
    await postChange(fx, ctx, 'R3 counts successful sums only.');
    const out = await nextReplanOutcome(fx, ctx, 1, outcomes([plan.id]), { max: 200, answerKinds: ['spec_change'] });
    // The package as the Architect read it: the open plan, its stages' dependencies.
    const launch = fx.scripted.launches({ work_kind: 'replan' })[0];
    assert.ok(launch, 'the replan launched');
    const dump = fx.scripted.probes(launch.invocation, 'context_dump').at(-1);
    const file = (dump?.files ?? []).find((f) => f.name === 'open-plan.json');
    assert.ok(file && typeof file.text === 'string', `the early replan's package carries the open plan (${JSON.stringify((dump?.files ?? []).map((f) => f.name))})`);
    const open = JSON.parse(file.text);
    assert.deepEqual(gen1, { 1: 'planned', 2: 'planned', 3: 'planned' }, 'the fixture is live: every stage planned, none built, before the change');
    assert.deepEqual(
      Object.fromEntries(open.stages.map((s) => [s.number, s.depends_on])),
      { 1: [], 2: [1], 3: [2] },
      `the open plan states each stage's depends_on as the stage numbers it was planned with, the plan's own form (${JSON.stringify(open.stages.map((s) => [s.number, s.depends_on]))})`,
    );
    const copied = fx.scripted.eventsOfInvocation(launch.invocation, 'plan_from_open_plan').at(-1);
    assert.equal(copied?.outcome, 'written', `the replan copied the stages from its package (${JSON.stringify(copied)})`);
    // Copied as stated, the plan is not refused, and it publishes (or routes to the owner, who approves).
    assert.ok(!out.failed, `the replan copying the inputs as the package states them is not refused (${JSON.stringify(out.failed ? [out.failed.reason_class, out.failed.reason_text] : null)})`);
    if (out.approval) assert.equal((await answer(fx.engine, p.id, out.approval, 'approve')).status, 200, 'the owner approves the replacement');
    const g2 = await pumpNoIdle(fx, ctx, () => replacementOf(fx.home, p.id).find((x) => active(x) && x.generation === 2 && x.published_at), { what: 'generation 2 published', max: 40, answerKinds: ['spec_change'] });
    const read = await readPlan(fx, p.id);
    assert.equal(read.plan?.id, g2.id, 'the plan read is generation 2');
    const numberOf = Object.fromEntries((read.plan.stages ?? []).map((s) => [s.id, s.number]));
    assert.deepEqual(
      Object.fromEntries((read.plan.stages ?? []).map((s) => [s.number, (s.depends_on ?? []).map((d) => numberOf[d] ?? d)])),
      { 1: [], 2: [1], 4: [2] },
      `generation 2's stages, each depending on the stage of the number the plan named (${JSON.stringify(read.plan.stages.map((s) => [s.number, s.depends_on]))})`,
    );
  });

  test('(a) a parked stage\'s blocker answered replan: blocker_replan with its evidence; the replacement recorded with the stale from the blocker', async (t) => {
    const { fx, p, ctx, plan } = await journey35(t, { policy: { repair_attempts_max: 0 } });
    fx.scripted.kindScript('stage_build', [script.crash(), script.crash(), builderScript(1), builderScript(2)]);
    const S1b = { ...S1, number: 3, tasks: ['write src/sum.mjs exporting sum(a, b) with Number arguments'] };
    const S2b = { ...S2, number: 4, depends_on: [3] };
    fx.scripted.kindScript('replan', [replan35({ phase: 1, stages: [S1b, S2b] }), replan35({})]);
    const item = () => workOf(fx.home, p.id, 'stage_build').find((w) => w.status === 'parked');
    const blocker = await pump(fx, ctx, () => {
      const w = item();
      return w && decisionsOn(fx.home, 'blocker', w.id).find((d) => d.status === 'open');
    }, { what: 'S1 parked with its blocker', max: 60 });
    const options = blocker.options.map((o) => o.key);
    for (const o of ['retry', 'replan', 'cancel']) assert.ok(options.includes(o), `the parked blocker offers ${o} (${JSON.stringify(options)})`);
    assert.equal((await answer(fx.engine, p.id, blocker, 'replan')).status, 200);
    const [r] = workOf(fx.home, p.id, 'replan');
    assert.ok(r, 'replan work created');
    assert.equal(r.trigger_source, 'blocker_replan');
    assert.ok([r.trigger_id, JSON.stringify(r.subject ?? {})].join(' ').match(new RegExp(`${blocker.id}|${item().id}`)), `its evidence names the blocker or the parked work (${JSON.stringify([r.trigger_id, r.subject])})`);
    const g2 = await pump(fx, ctx, () => replacementOf(fx.home, p.id).find((x) => active(x) && x.generation === 2), { what: 'the replacement published', max: 20 });
    assert.ok(JSON.stringify(g2.replacement ?? {}).includes('blocker_replan'), `the replacement records its trigger (${JSON.stringify(g2.replacement)})`);
    assert.ok((g2.replacement?.stale ?? []).length > 0, `(g) the stale recorded from the blocker's evidence (${JSON.stringify(g2.replacement)})`);
    const stages1 = stagesOfPlan(fx.home, plan.id);
    assert.deepEqual(stages1.map((s) => s.status), ['cancelled', 'cancelled'], 'the unbuilt stages of generation 1 cancelled');
  });

  test('(b) an objection filed alone creates nothing; (a) its X2 blocker answered replan: objection_upheld', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    fx.scripted.kindScript('stage_build', [builderScript(1, { objections: [{ check: 'accept-r1', category: 'contract_conflict', message: 'R1.1 says 5, but the plan\'s interface returns a string.' }] }), builderScript(1), builderScript(2)]);
    const exits = (x) => (x.key === 'accept-r1' ? 1 : 0);
    const blocker = await pump(fx, ctx, () => {
      for (const w of workOf(fx.home, p.id, 'stage_build')) {
        const d = decisionsOn(fx.home, 'blocker', w.id).find((x) => x.status === 'open' && x.options.some((o) => o.key === 'correct_check'));
        if (d) return d;
      }
      return undefined;
    }, { what: 'the X2 blocker', max: 60, exits });
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.deepEqual(workOf(fx.home, p.id, 'replan'), [], '(b) the objection filed, its blocker unanswered: no replan');
    assert.ok(blocker.options.some((o) => o.key === 'replan'), `the X2 blocker offers replan (${JSON.stringify(blocker.options.map((o) => o.key))})`);
    assert.equal((await answer(fx.engine, p.id, blocker, 'replan')).status, 200);
    const [r] = workOf(fx.home, p.id, 'replan');
    assert.ok(r, 'replan work created');
    assert.equal(r.trigger_source, 'objection_upheld');
    const objection = findingsOf(fx.home, p.id).find((f) => f.category === 'contract_conflict');
    assert.ok(objection && [r.trigger_id, JSON.stringify(r.subject ?? {})].join(' ').includes(objection.id), `its evidence names the objection (${JSON.stringify([r.trigger_id, r.subject, objection?.id])})`);
  });

  test('(a) a Reviewer\'s contract_conflict with fix against the plan: contract_conflict, no fix work; (f) the finding kept after the replacement', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    const S2b = { ...S2, number: 3, tasks: [...S2.tasks, 'read a and b as integers only'] };
    fx.scripted.kindScript('replan', [replan35({ phase: 1, stages: [S1, S2b] }), replan35({})]);
    const c1 = await pump(fx, ctx, () => candidatesOfProject(fx.home, p.id)[0], { what: 'stage 1\'s candidate', max: 60 });
    const [found] = await raiseFindings(fx, p.id, c1.id, [{ category: 'contract_conflict', severity: 'medium', message: 'The plan has stage 2 accept floats; the module map\'s sum-route says integers.' }]);
    await review(fx, p.id, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix', target: 'plan' }] });
    const [r] = workOf(fx.home, p.id, 'replan');
    assert.ok(r, 'replan work created by the disposition');
    assert.deepEqual([r.trigger_source, r.trigger_id], ['contract_conflict', found.id], 'trigger (contract_conflict, the finding)');
    assert.deepEqual(workOf(fx.home, p.id, 'fix'), [], 'no fix work: the fix is against the plan');
    await pump(fx, ctx, () => replacementOf(fx.home, p.id).find((x) => active(x) && x.generation === 2), { what: 'the replacement published', max: 40 });
    const after = findingsOf(fx.home, p.id).find((f) => f.id === found.id);
    assert.ok(after, '(f) the finding kept after the replacement');
    assert.equal(after.disposition, 'fix', 'with its disposition');
  });
  test('(c), (d) E172 S2: a replacement keeping stage 2 while it supersedes stage 1, its dependency, and lists stage 1 changed under its number: refused PLAN_UNKNOWN_STAGE (stage 2, 1); nothing published; stage 2 not dispatched', async (t) => {
    assertKeptDependentRefused(await keptDependentOfTheSubject(t, [changed(S1)]), 'stage 1 is replaced by a changed stage 1');
  });

  test('(c), (d) E172 S2: the same with stage 2 listed as built: refused PLAN_UNKNOWN_STAGE (stage 2, 1); nothing published; stage 2 not dispatched', async (t) => {
    assertKeptDependentRefused(await keptDependentOfTheSubject(t, [changed(S1), S2]), 'stage 1 is replaced by a changed stage 1 and stage 2 is listed as built');
  });

  test('(c), (d) E172 S2: a replacement keeping stage 2 while it drops stage 1 for stage 3: refused PLAN_UNKNOWN_STAGE (stage 2, 1); nothing published; stage 2 not dispatched', async (t) => {
    assertKeptDependentRefused(await keptDependentOfTheSubject(t, [changed(S1, { number: 3 })]), 'stage 1 is dropped for a stage 3');
  });
});

