// M429, phase verification work and its sign-off (slice 35; kernel lane). M5
// plan §3.5 M429; D6-F02; D6 §5.8, A.3; B06; the driver's rulings of
// 2026-10-13 (a refused sign-off writes no `signoffs` row, emits
// `signoff.refused` naming the binding and the cause, and the work
// completes; the superseded-candidate half of (d) deferred to slice 37);
// SEAM.md §§406, 412.
//
// (a) `phase_verification` dispatched after the phase checks ran, its
//     package holding the phase evaluation and the phase's findings;
// (b) its sign-off: `signoffs.scope` `phase`, `phase_plan` set, `binding`
//     {acceptance_hash, protected_version, spec_revision, plan_generation};
// (c) at T2, a result with no sign-off: the phase does not complete (T1
//     completes on the gate alone: M406 (a), M428 (a); T3 shares T2's rule,
//     not written, the driver's ruling 7);
// (d) a sign-off bound to a plan generation replaced while the Verifier ran:
//     refused;
// (e) a finding in its result: recorded from that run and dispositioned as
//     any finding.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { findingsOf, review } from './harness/gates.mjs';
import { answer } from './harness/decisions.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { ROUTED_KINDS, evaluationsOfKind, phaseCompleted, planOfPhase, runsOfProject, signoffsOfProject, workOf } from './harness/journey/drive.mjs';
import { journey35, nextReplanOutcome, openPlanApprovals, replan35 } from './harness/journey/plan35.mjs';
import { REQUIREMENTS, REQUIREMENTS_V2, specText } from './harness/journey/reference.mjs';
import { postChange, pumpNoIdle } from './harness/journey/review31b.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { packageOf } from './harness/sessions.mjs';

const DUMP = { probe: { action: 'context_dump' } };
const pvRuns = (home, project) => {
  const items = new Set(workOf(home, project, 'phase_verification').map((w) => w.id));
  return runsOfProject(home, project).filter((r) => items.has(r.work_item));
};

describe('M429 phase verification work and its sign-off', () => {
  test('(a) dispatched after the phase checks, its package holding the evaluation and the findings; (b) the sign-off scoped phase with phase_plan and the binding', async (t) => {
    const { fx, p, ctx, plan } = await journey35(t);
    fx.scripted.kindScript('phase_verification', { steps: [DUMP, ...roleThat([], { signoffs: [{ scope: 'phase' }] }).steps] });
    const done = await phaseCompleted(fx, ctx, 1);
    const [run] = pvRuns(fx.home, p.id);
    assert.ok(run, 'a phase_verification run');
    const evaluation = evaluationsOfKind(fx.home, p.id, 'phase').find((e) => e.candidate === done.completion_binding.candidate);
    assert.ok(evaluation, 'the phase evaluated on the bound candidate');
    const seqOf = (type, id) => eventsOfType(fx.home, type).filter((e) => JSON.stringify(e).includes(id)).map((e) => e.seq);
    const evaluated = seqOf('gate.evaluated', evaluation.id);
    const created = seqOf('work.created', run.work_item);
    assert.ok(evaluated.length && created.length && Math.min(...created) > Math.min(...evaluated), `the Verifier's work registered after the phase evaluation (${JSON.stringify({ evaluated, created })})`);
    const pkg = packageOf(fx, run.id);
    assert.ok(pkg, 'the Verifier dumped its package');
    const text = Object.values(pkg).filter((x) => typeof x === 'string').join('\n');
    assert.ok(text.includes(evaluation.id), `its package holds the phase evaluation (${Object.keys(pkg).join(', ')})`);
    assert.ok(Object.keys(pkg).some((n) => /finding/.test(n)), `and the phase's findings (${Object.keys(pkg).join(', ')})`);
    const signoff = signoffsOfProject(fx.home, p.id).find((s) => s.scope === 'phase');
    assert.ok(signoff, 'the phase sign-off recorded');
    assert.equal(signoff.phase_plan, plan.id, 'phase_plan set (A.3)');
    assert.deepEqual(Object.keys(signoff.binding ?? {}).sort(), ['acceptance_hash', 'plan_generation', 'protected_version', 'spec_revision'], `the binding's four fields (${JSON.stringify(signoff.binding)})`);
    assert.equal(signoff.binding.plan_generation, plan.generation);
  });

  test('(c) T2: a phase_verification result with no sign-off leaves the phase incomplete', async (t) => {
    const { fx, p, ctx, plan } = await journey35(t);
    fx.scripted.kindScript('phase_verification', roleThat([], {}));
    await pumpNoIdle(fx, ctx, () => pvRuns(fx.home, p.id).find((r) => r.state === 'ended'), { what: 'the phase_verification run to end', max: 400 });
    await tick(fx.engine, p.id, { rounds: 4 });
    assert.equal(planOfPhase(fx.home, p.id, 1).find((x) => x.id === plan.id).completed_at ?? null, null, 'not complete without the sign-off at T2');
    assert.deepEqual(signoffsOfProject(fx.home, p.id).filter((s) => s.scope === 'phase'), [], 'no phase sign-off');
  });

  test('(d) a sign-off bound to a plan generation replaced while the Verifier ran: refused, no signoffs row, signoff.refused naming the binding and the cause; the work completes', async (t) => {
    const { fx, p, ctx, plan } = await journey35(t);
    // A change touching R4 alone (phase 2), approved during phase 1: a replan of the
    // active plan, routed to the owner (declared uncertain) and left pending.
    const R4_ONLY = specText({ version: 2, requirements: REQUIREMENTS.map((r) => (r.key === 'R4' ? REQUIREMENTS_V2.find((x) => x.key === 'R4') : r)) });
    fx.scripted.kindScript('spec_change', roleThat([step.write('.surety/spec/spec.md', R4_ONLY)], { changes: [{ key: 'R4', kind: 'text_changed', reason: 'only successful sums are counted' }] }));
    fx.scripted.kindScript('replan', [replan35({ phase: 1, spec_version: 2, conformance: 'uncertain' }), replan35({ spec_version: 2 })]);
    fx.scripted.kindScript('phase_verification', { steps: [step.hold('gate', { heartbeat_ms: 250 }), ...roleThat([], { signoffs: [{ scope: 'phase' }] }).steps] });
    await postChange(fx, ctx, 'R4: count successful sums only.');
    const answerKinds = ROUTED_KINDS.filter((k) => k !== 'plan_approval');
    const outcome = await nextReplanOutcome(fx, ctx, 1, { runs: new Set(), approvals: new Set(), published: new Set([plan.id]) }, { max: 400, answerKinds });
    assert.ok(outcome.approval, `the replacement routed to the owner and pending (${JSON.stringify(outcome.failed ? [outcome.failed.reason_class, outcome.failed.reason_text] : Object.keys(outcome))})`);
    await pumpNoIdle(fx, ctx, () => {
      const launch = fx.scripted.launches({ work_kind: 'phase_verification' }).at(-1);
      const holding = launch && fx.scripted.eventsOf(launch.pid, 'holding').length > 0;
      return holding && openPlanApprovals(fx.home, p.id).length > 0 ? true : undefined;
    }, { what: 'the Verifier holding with the replacement pending', max: 600, answerKinds });
    const [pending] = openPlanApprovals(fx.home, p.id);
    const res = await answer(fx.engine, p.id, pending, 'approve');
    assert.equal(res.status, 200, `the owner approves the replacement during the hold (→ ${res.status} ${res.text})`);
    await pumpNoIdle(fx, ctx, () => planOfPhase(fx.home, p.id, 1).find((x) => (x.active === 1 || x.active === true) && x.generation === plan.generation + 1), { what: 'generation 2 active', max: 20, answerKinds });
    fx.scripted.release('all', 'gate');
    const ended = await pumpNoIdle(fx, ctx, () => pvRuns(fx.home, p.id).find((r) => r.state === 'ended'), { what: 'the Verifier to end', max: 20, answerKinds });
    assert.deepEqual(signoffsOfProject(fx.home, p.id).filter((s) => s.scope === 'phase'), [], 'no signoffs row');
    const refused = eventsOfType(fx.home, 'signoff.refused').filter((e) => JSON.stringify(e).includes(p.id) || JSON.stringify(e).includes(ended.id));
    assert.equal(refused.length, 1, 'one signoff.refused');
    assert.ok(JSON.stringify(refused[0]).includes('plan_generation') || JSON.stringify(refused[0]).includes('binding'), `naming the binding (${JSON.stringify(refused[0])})`);
    assert.ok(refused[0].payload?.cause || refused[0].payload?.reason, `and the cause (${JSON.stringify(refused[0])})`);
    const item = workOf(fx.home, p.id, 'phase_verification').find((w) => w.id === ended.work_item);
    assert.equal(item.status, 'complete', 'the work completes');
  });

  test('(e) a finding in the phase_verification result: recorded from that run and dispositioned as any finding', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    const FINDING = { category: 'defect', severity: 'medium', message: '/sum answers 200 for a=1e400 (Infinity).', check: 'accept-r2', criterion: 'R2.2' };
    fx.scripted.kindScript('phase_verification', roleThat([], { signoffs: [{ scope: 'phase' }], findings: [FINDING] }));
    await pumpNoIdle(fx, ctx, () => pvRuns(fx.home, p.id).find((r) => r.state === 'ended'), { what: 'the phase_verification run to end', max: 400 });
    const [run] = pvRuns(fx.home, p.id);
    const found = findingsOf(fx.home, p.id).find((f) => f.source_run === run.id);
    assert.ok(found, `the finding recorded from the phase_verification run (${JSON.stringify(findingsOf(fx.home, p.id).map((f) => [f.source_run, f.message]))})`);
    await review(fx, p.id, found.candidate, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    const fixes = workOf(fx.home, p.id, 'fix').filter((w) => JSON.stringify(w.subject ?? {}).includes(found.id) || w.trigger_id === found.id);
    assert.equal(fixes.length, 1, 'its fix disposition makes fix work, as for any finding');
  });
});
