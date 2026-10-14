// M436, the autonomy profiles (slice 37; kernel lane). M5 plan §3.7 M436 (a)
// to (d) and (f); D6-X01, D6-X02, D6-X03; D6 §6.5, §6.7; K3; Q3; N02; D1-34;
// SEAM.md §429 (e), the floor, is `M436-the-floor-under-phase`; its
// project-lane part is `M436-the-phase-profile-on-the-project-lane`.
//
//   (a) `step`: a boundary decision after a role run (D1-34), the decision's
//       preview naming the chain's origin (`chain_origin` †);
//   (b) `stage`: the chain Builder, checks, Verifier, Reviewer runs with no
//       decision and the boundary falls before the next stage's Builder; two
//       independent stages build at once (K2), each chain runs with no
//       decision, and the boundary falls before the next phase's replan
//       (D6 §6.7). The reading: two independent stages are not "next" to one
//       another, so neither waits for the other's chain;
//   (c) `phase` with `max_chained_roles` 1 and the budgets set high: the
//       boundary at the cap on chain depth alone, the origin named on the
//       work (`work_items.chain_origin` †) and in the decision's preview; a
//       fresh plan-stage trigger is a chain of its own; a person's
//       `continue` begins a new chain whose origin is the continued item; the
//       repair budget binds separately, never as the chain cap;
//   (d) `phase`: every stage, the phase verification and the replan with no
//       decision; a boundary only at the routed kinds (the toolchain's
//       unclassifiable correction, a `plan_approval` of an uncertain replan,
//       `spec_change`, CR-1's correction); no chain boundary;
//   (f) a Reviewer's sign-off bound at claim is not copied to the successor
//       a later integration makes (K2: stage 2 integrates while stage 1's
//       Reviewer holds); the sensitive area survives a plan replacement (the
//       inherited findings' half is M430 (f), not re-tested).
//
// Order is read by insertion (`seq`, the role program's launch log), never
// by a wall-clock timestamp (the slice-36 ruling).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, confirmRequired, consume } from './harness/decisions.mjs';
import { waitFor } from './harness/engine.mjs';
import { addGitProject, addStagedProject, permittedEdit, roleThat, roleThatHolds, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { changePolicy, getPolicy, workItemsOf } from './harness/journal.mjs';
import {
  ROUTED_KINDS,
  builderScript,
  changeRequest,
  nextPhasePublished,
  phaseCompleted,
  phasePlansOf,
  planChecks,
  runsOfProject,
  signoffsOfProject,
  workOf,
} from './harness/journey/drive.mjs';
import { journey35, replan35, stagesWith } from './harness/journey/plan35.mjs';
import { MODULES_JSON_SERVICE_SECRETS, REQUIREMENTS, SPEC_SERVICE_SECRETS, STAGES, T2_KINDS, specText } from './harness/journey/reference.mjs';
import { postChange } from './harness/journey/review31b.mjs';
import { answerDecision, pauseProject, resumeProject, runsOf, scriptedEngine, tick, waitForRun, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import {
  boundaryDecisions,
  candidatesOf,
  chainOriginOf,
  decisionSeq,
  decisionsSince,
  holding,
  launchesOfKind,
  originOf,
  pumpSome,
  stageRows,
  stageWork,
  workRow,
} from './harness/exec37/autonomy.mjs';

const NOT_PLAN = ROUTED_KINDS.filter((k) => k !== 'plan_approval');
const MODULES = '.surety/architecture/modules.json';
const active = (x) => x.active === 1 || x.active === true;

describe('M436 (a) step', () => {
  test('(a) a boundary decision after the Builder\'s run; its preview and the work name the chain\'s origin', async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    const { project, items, plan } = await addStagedProject(fx, { tier: 'T2', autonomy: 'step' });
    fx.scripted.script(items[0], [roleThat([permittedEdit()])]);
    await runToEnd(fx, project.id, items[0]);
    const [candidate] = await waitForCandidates(fx, project.id);
    const verification = workItemsOf(fx.home, project.id).find((w) => w.kind === 'verification' && w.subject?.candidate === candidate.id);
    assert.ok(verification, 'the fixture is live: the nomination made verification work');
    await tick(fx.engine, project.id, { rounds: 3 });
    const [boundary, ...more] = boundaryDecisions(fx.home, project.id).filter((d) => d.subject_id === verification.id);
    assert.ok(boundary && more.length === 0, `one boundary decision on the verification after the Builder's run (${JSON.stringify(boundaryDecisions(fx.home, project.id).map((d) => d.subject_id))})`);
    assert.deepEqual(boundary.options.map((o) => o.key).sort(), ['cancel', 'continue'], 'it offers to continue or to cancel (D1-34)');
    assert.deepEqual(runsOf(fx.home, verification.id), [], 'the verification was not dispatched');
    const origin = originOf('plan', plan.stages[0].id);
    assert.deepEqual(chainOriginOf(fx.home, verification.id), origin, `the work names its chain's origin, the stage's plan trigger (work_items.chain_origin †; got ${JSON.stringify(chainOriginOf(fx.home, verification.id))})`);
    assert.deepEqual(boundary.dependency_manifest?.chain_origin, origin, `and the decision's preview names it (${JSON.stringify(boundary.dependency_manifest)})`);
    await answerDecision(fx.engine, project.id, boundary.id, 'continue');
    await tick(fx.engine, project.id, { rounds: 2 });
    await waitForRun(fx.home, verification.id, { state: 'ended' });
    assert.equal(boundaryDecisions(fx.home, project.id).filter((d) => d.subject_id === verification.id).length, 1, 'no second decision on it');
  });
});

describe('M436 (b) stage', () => {
  test('(b) a chain: stage 1\'s Builder, checks, Verifier and Reviewer run with no decision; the boundary falls before stage 2\'s Builder; continued, stage 2\'s chain runs with no decision', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { autonomy: 'stage' } });
    const since = decisionSeq(fx.home, p.id);
    const [s1, s2] = stageRows(fx.home, p.id);
    const reached = await pumpSome(
      fx,
      ctx,
      () => {
        const rows = stageRows(fx.home, p.id);
        const w2 = stageWork(fx.home, p.id, s2.id);
        const b = boundaryDecisions(fx.home, p.id, since).find((d) => d.subject_id === w2.id);
        return rows[0].status === 'verified' && b ? b : undefined;
      },
      { what: 'stage 1 verified and stage 2\'s Builder at its boundary', max: 200, answerKinds: NOT_PLAN },
    );
    const w1 = stageWork(fx.home, p.id, s1.id);
    const w2 = stageWork(fx.home, p.id, s2.id);
    const raised = decisionsSince(fx.home, p.id, since);
    const other = raised.filter((d) => !NOT_PLAN.includes(d.kind) && d.id !== reached.id);
    assert.deepEqual(other.map((d) => [d.kind, d.subject_id]), [], 'no decision within stage 1\'s chain but the routed toolchain correction');
    assert.deepEqual(runsOf(fx.home, w2.id), [], 'stage 2\'s Builder waits at the boundary, not dispatched');
    const kindsRun = new Set(runsOfProject(fx.home, p.id).filter((r) => r.state === 'ended').map((r) => workRow(fx.home, r.work_item)?.kind));
    for (const k of ['stage_build', 'verification', 'review']) assert.ok(kindsRun.has(k), `stage 1's ${k} ran`);
    assert.equal(workItem(fx.home, w1.id).status, 'complete', 'stage 1\'s work complete');
    await answer(fx.engine, p.id, reached, 'continue');
    const after = decisionSeq(fx.home, p.id);
    await pumpSome(fx, ctx, () => stageRows(fx.home, p.id)[1].status === 'verified' || undefined, { what: 'stage 2 verified', max: 200, answerKinds: NOT_PLAN });
    const later = decisionsSince(fx.home, p.id, after).filter((d) => !NOT_PLAN.includes(d.kind));
    assert.deepEqual(later.map((d) => [d.kind, d.subject_id]), [], 'continued, stage 2\'s chain runs with no decision');
  });

  test('(b) two independent stages under stage: both Builders run at once, each chain with no decision; the boundary falls before the next phase\'s replan', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { autonomy: 'stage' }, stages: stagesWith(1, { 2: { depends_on: [] } }) });
    const since = decisionSeq(fx.home, p.id);
    await pumpSome(fx, ctx, () => launchesOfKind(fx, 'verification').length > 0 || launchesOfKind(fx, 'stage_build').length >= 2 || undefined, { what: 'a Verifier or both Builders launched', max: 200, answerKinds: NOT_PLAN });
    const all = fx.scripted.launches();
    const firstVerifier = all.findIndex((l) => l.work_kind === 'verification');
    const builders = all.map((l, i) => [l.work_kind, i]).filter(([k]) => k === 'stage_build').map(([, i]) => i);
    assert.ok(
      builders.length >= 2 && (firstVerifier === -1 || builders[1] < firstVerifier),
      `the two independent stages' Builders both launched before either stage's Verifier (K2; the reading: neither is the other's next stage) (launch order: ${JSON.stringify(all.map((l) => l.work_kind))}; boundaries: ${JSON.stringify(boundaryDecisions(fx.home, p.id, since).map((d) => d.subject_id))})`,
    );
    const replanWaiting = await pumpSome(
      fx,
      ctx,
      () => {
        const [r] = workOf(fx.home, p.id, 'replan');
        return r && boundaryDecisions(fx.home, p.id, since).find((d) => d.subject_id === r.id);
      },
      { what: 'both stages verified and the replan at its boundary', max: 300, answerKinds: NOT_PLAN },
    );
    assert.deepEqual(stageRows(fx.home, p.id).filter((s) => s.phase_number === 1).map((s) => s.status), ['verified', 'verified']);
    const inside = decisionsSince(fx.home, p.id, since).filter((d) => !NOT_PLAN.includes(d.kind) && d.id !== replanWaiting.id);
    assert.deepEqual(inside.map((d) => [d.kind, d.subject_id]), [], 'no decision within either chain or the phase verification');
    assert.deepEqual(runsOf(fx.home, replanWaiting.subject_id), [], 'the replan waits at the boundary (D6 §6.7)');
  });
});

describe('M436 (c) phase and max_chained_roles', () => {
  test('(c) the cap on chain depth alone, with the budgets high: the origin named; a fresh plan-stage trigger a chain of its own; continue begins a new chain', async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    // Objection 094: K1 makes the plan's new eligible work request a tick and
    // K2 lets both stages build at once, so the project is paused until its
    // stages are scripted and its policy set, and stage 2's Builder holds
    // until stage 1's candidate has been read.
    const project = await addGitProject(fx, { tier: 'T2' });
    await pauseProject(fx.engine, project.id);
    const planned = await fx.engine.post('/v1/harness/fixtures/plan', { project: project.id, stages: [1, 2].map((n) => ({ number: n, goal: `stage ${n} of the fixture plan` })) });
    assert.equal(planned.status, 201, `plan fixture (body: ${planned.text})`);
    const plan = planned.body;
    const items = plan.stages.map((stage) => stage.work_item);
    fx.scripted.script(items[0], [roleThat([permittedEdit()])]);
    fx.scripted.script(items[1], [roleThatHolds([], [step.write('src/two.js', 'export const two = 2;\n')])]);
    await changePolicy(fx.engine, project.id, { max_chained_roles: 1 });
    // Every budget high: a widening, confirmed by the owner (M49).
    const wide = { repair_attempts_max: 10, no_progress_max: 5 };
    await consume(fx, project.id, await confirmRequired(fx, `/v1/projects/${project.id}/policy`, wide), 'approve');
    await waitFor(async () => (await getPolicy(fx.engine, project.id)).effective.repair_attempts_max === 10 || undefined, { what: 'the budgets raised' });
    await resumeProject(fx.engine, project.id);
    await runToEnd(fx, project.id, items[0]);
    const [c1] = await waitForCandidates(fx, project.id);
    const v1 = workItemsOf(fx.home, project.id).find((w) => w.kind === 'verification' && w.subject?.candidate === c1.id);
    await tick(fx.engine, project.id, { rounds: 3 });
    const [b] = boundaryDecisions(fx.home, project.id).filter((d) => d.subject_id === v1.id);
    assert.ok(b, 'the verification (chain depth 1) waits at the cap of 1 under phase');
    assert.equal(workRow(fx.home, v1.id).blocker?.reason, 'max_chained_roles', 'the cause is the chain cap, not a budget');
    const o1 = originOf('plan', plan.stages[0].id);
    assert.deepEqual(chainOriginOf(fx.home, v1.id), o1, `its chain's origin is stage 1's plan trigger (work_items.chain_origin †; got ${JSON.stringify(chainOriginOf(fx.home, v1.id))})`);
    assert.deepEqual(b.dependency_manifest?.chain_origin, o1, `named in the boundary's preview (${JSON.stringify(b.dependency_manifest)})`);
    // Stage 2's work: a fresh plan-stage trigger, a chain of its own, not held by stage 1's.
    const w2 = workRow(fx.home, items[1]);
    assert.equal(w2.chain, 0, 'stage 2\'s work begins a chain');
    assert.deepEqual(chainOriginOf(fx.home, items[1]), originOf('plan', plan.stages[1].id), 'whose origin is its own plan trigger');
    fx.scripted.release(items[1], 'gate');
    await tick(fx.engine, project.id, { rounds: 2 });
    await waitForRun(fx.home, items[1], { state: 'ended' });
    // Continued: a new chain, its origin the continued item's trigger.
    await answerDecision(fx.engine, project.id, b.id, 'continue');
    const v1now = workRow(fx.home, v1.id);
    assert.equal(v1now.chain, 0, 'continue begins a new chain');
    assert.deepEqual(chainOriginOf(fx.home, v1.id), originOf(v1now.trigger_source, v1now.trigger_id, v1now.trigger_generation), 'whose origin is the continued item');
  });

  test('(c) the repair budget binds separately: a failing Builder parks on repair_attempts_max, never as the chain cap', async (t) => {
    const fx = await scriptedEngine(t);
    // Objection 094: the stage's work is scripted before anything can tick
    // (K1: new eligible work requests a tick), the project paused meanwhile.
    const project = await addGitProject(fx, { tier: 'T2' });
    await pauseProject(fx.engine, project.id);
    const planned = await fx.engine.post('/v1/harness/fixtures/plan', { project: project.id, stages: [{ number: 1, goal: 'stage 1 of the fixture plan' }] });
    assert.equal(planned.status, 201, `plan fixture (body: ${planned.text})`);
    const items = planned.body.stages.map((stage) => stage.work_item);
    fx.scripted.script(items[0], [script.crash(3)]);
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 0 });
    await resumeProject(fx.engine, project.id);
    await runToEnd(fx, project.id, items[0]);
    await tick(fx.engine, project.id, { rounds: 2 });
    const row = workRow(fx.home, items[0]);
    assert.deepEqual([row.status, row.blocker?.reason], ['parked', 'repair_attempts_max'], `parked on the repair budget (${JSON.stringify(row.blocker)})`);
    assert.deepEqual(boundaryDecisions(fx.home, project.id), [], 'no chain boundary');
  });
});

describe('M436 (d) phase: a boundary only where F routes a decision', () => {
  test('(d) phase 1, its verification, an uncertain replan and CR-1: the only decisions raised are the routed ones; no chain boundary, no blocker', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    fx.scripted.kindScript('replan', [replan35({ conformance: 'uncertain' }), replan35({ spec_version: 2 }), replan35({ spec_version: 2 })]);
    const since = decisionSeq(fx.home, p.id);
    await phaseCompleted(fx, ctx, 1, { max: 200 });
    await nextPhasePublished(fx, ctx, 2, { max: 80 });
    await changeRequest(fx, ctx);
    const raised = decisionsSince(fx.home, p.id, since);
    const kinds = [...new Set(raised.map((d) => d.kind))].sort();
    assert.deepEqual(raised.filter((d) => !ROUTED_KINDS.includes(d.kind)).map((d) => [d.kind, d.subject_type, d.dependency_manifest?.cause ?? null]), [], `nothing but the routed kinds (raised: ${JSON.stringify(kinds)})`);
    for (const k of ['check_correction_unclassifiable', 'plan_approval', 'spec_change']) assert.ok(kinds.includes(k), `the routed ${k} raised (${JSON.stringify(kinds)})`);
    assert.ok(runsOfProject(fx.home, p.id).some((r) => workRow(fx.home, r.work_item)?.kind === 'phase_verification'), 'the phase verification ran unattended');
    assert.ok(phasePlansOf(fx.home, p.id).some((x) => x.phase_number === 2 && active(x)), 'phase 2 published after the routed plan_approval');
    assert.deepEqual(boundaryDecisions(fx.home, p.id), [], 'no chain boundary');
  });
});

describe('M436 (f) the floor across rebases and replacements', () => {
  test('(f) stage 2 integrates while stage 1\'s Reviewer holds its claim: the sign-off is bound to stage 1\'s candidate and never copied to the successor', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    const auto = { review_auto: { reason: 'The approved specification requires these checks.' } };
    fx.scripted.kindScript('review', { steps: [step.hold('gate', { heartbeat_ms: 250 }), auto] });
    // Stage 2's Builder holds before its result, so its integration follows the Reviewer's claim.
    fx.scripted.kindScript('stage_build', [builderScript(1), { steps: [step.hold('gate', { heartbeat_ms: 250 }), ...builderScript(2).steps] }, builderScript(3), builderScript(4)]);
    // A review of a protected proposal (no candidate) is released at once.
    const releaseProposalReviews = async () => {
      for (const l of launchesOfKind(fx, 'review')) {
        const w = workRow(fx.home, l.work_item);
        if (w?.subject?.proposal && holding(fx, l)) fx.scripted.release(l.work_item, 'gate');
      }
    };
    const both = await pumpSome(
      fx,
      ctx,
      () => {
        const review = launchesOfKind(fx, 'review').find((l) => workRow(fx.home, l.work_item)?.subject?.candidate && holding(fx, l));
        const builder2 = launchesOfKind(fx, 'stage_build')[1];
        return review && holding(fx, builder2) ? { review, builder2 } : undefined;
      },
      { what: 'stage 1\'s Reviewer holding its claim while stage 2\'s Builder runs (K2: one run per work item, not per project)', max: 200, answerKinds: NOT_PLAN, each: releaseProposalReviews },
    );
    const c1 = workRow(fx.home, both.review.work_item).subject.candidate;
    const c1seq = candidatesOf(fx.home, p.id).find((x) => x.id === c1).seq;
    fx.scripted.release(both.builder2.work_item, 'gate');
    const successor = await pumpSome(fx, ctx, () => candidatesOf(fx.home, p.id).find((c) => c.seq > c1seq), { what: 'stage 2 integrated and its successor nominated while the Reviewer holds', max: 60, answerKinds: NOT_PLAN, each: releaseProposalReviews });
    fx.scripted.release(both.review.work_item, 'gate');
    await pumpSome(fx, ctx, () => stageRows(fx.home, p.id).every((s) => s.status === 'verified') || undefined, {
      what: 'both stages verified',
      max: 200,
      answerKinds: NOT_PLAN,
      each: async () => {
        for (const l of launchesOfKind(fx, 'review')) if (holding(fx, l)) fx.scripted.release(l.work_item, 'gate');
      },
    });
    const heldRun = runsOf(fx.home, both.review.work_item)[0];
    const signoffs = signoffsOfProject(fx.home, p.id).filter((s) => s.scope === 'candidate');
    const fromHeld = signoffs.filter((s) => s.run === heldRun.id);
    assert.deepEqual(fromHeld.map((s) => s.candidate), [c1], `the held Reviewer's sign-off is bound to the candidate it claimed (${JSON.stringify(fromHeld)})`);
    for (const s of signoffs.filter((x) => x.candidate === successor.id)) {
      const run = runsOfProject(fx.home, p.id).find((r) => r.id === s.run);
      assert.equal(run ? workRow(fx.home, run.work_item)?.subject?.candidate : undefined, successor.id, `a sign-off on the successor comes only from a Reviewer that claimed it, never a copy (${JSON.stringify(s)})`);
    }
  });

  test('(f) a plan replacement keeps the sensitive area: one that drops it from the stage touching its module is refused PLAN_AREA_UNVALIDATED; the published one carries it', async (t) => {
    const floor = [...T2_KINDS, 'sensitivity_floor'];
    const sensitive = stagesWith(1, { 2: { validation: { sensitive_areas: ['secrets_credentials'], kinds: floor } } });
    const { fx, p, ctx, plan } = await journey35(t, { spec: SPEC_SERVICE_SECRETS, over: { [MODULES]: MODULES_JSON_SERVICE_SECRETS }, stages: sensitive });
    const R1_V2 = specText({
      version: 2,
      requirements: REQUIREMENTS.map((r) => (r.key === 'R1' ? { ...r, criteria: [{ id: 'R1.1', text: 'Given the numbers 2 and 3, when `sum(2, 3)` of `src/sum.mjs` is called, then it returns the number 5, not a string.' }] } : r)),
    }).replace('| service | `server.mjs` | none |', '| service | `server.mjs` | secrets_credentials |');
    fx.scripted.kindScript('spec_change', roleThat([step.write('.surety/spec/spec.md', R1_V2)], { changes: [{ key: 'R1', kind: 'criteria_changed', reason: 'R1.1 names the type' }] }));
    const dropped = stagesWith(1, { 2: { validation: { sensitive_areas: [], kinds: T2_KINDS } } });
    fx.scripted.kindScript('replan', [replan35({ phase: 1, spec_version: 2, stages: dropped, conformance: 'uncertain' }), replan35({ phase: 1, spec_version: 2, stages: sensitive, conformance: 'uncertain' }), replan35({ spec_version: 2 })]);
    // Readiness withheld: only the change and the replacement are answered.
    await postChange(fx, ctx, 'R1.1 names the type.');
    const g2 = await pumpSome(fx, ctx, () => phasePlansOf(fx.home, p.id).find((x) => x.phase_number === 1 && active(x) && x.generation === plan.generation + 1), {
      what: 'the replacement published as generation 2',
      max: 200,
      answerKinds: ['spec_change', 'plan_approval'],
    });
    const refused = planChecks(fx.home, p.id).filter((c) => (c.reasons ?? []).some((r) => r.code === 'PLAN_AREA_UNVALIDATED'));
    assert.ok(refused.length >= 1, `the replacement dropping the area was refused PLAN_AREA_UNVALIDATED (${JSON.stringify(planChecks(fx.home, p.id).map((c) => [c.outcome, (c.reasons ?? []).map((r) => r.code)]))})`);
    const kept = stageRows(fx.home, p.id).filter((s) => s.phase_plan === g2.id || (s.plan_generation === g2.generation && s.phase_number === 1));
    const touching = stageRows(fx.home, p.id).filter((s) => s.phase_number === 1 && s.status !== 'cancelled' && (s.validation?.sensitive_areas ?? []).includes('secrets_credentials'));
    assert.ok(touching.length >= 1, `after the replacement the stage touching service still validates secrets_credentials (${JSON.stringify(stageRows(fx.home, p.id).map((s) => [s.number, s.status, s.plan_generation, s.validation?.sensitive_areas]))}; generation 2's stages ${kept.length})`);
    assert.ok(STAGES[1].length === 2);
  });
});
