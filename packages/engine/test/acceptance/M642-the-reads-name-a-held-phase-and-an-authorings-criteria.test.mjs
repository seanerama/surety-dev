// M642, the reads name a held phase and an authoring's criteria (slice 50;
// kernel lane). The owner's M7 plan §3i, row M642; additive served shape; D1
// §12; the console's rows U56 to U60; DECISIONS item 57 work order 3 (the
// analyst's engine asks E1, E2, E3).
//
// (a) the plan read serves `plan.verification` as recorded and, while the
//     open plan's latest phase gate evaluation is fresh and not satisfied
//     with no owner act available, `completion_held_by {reason:
//     'phase_gate_not_satisfied', evaluation, candidate, evaluated_at, stale:
//     false, reasons, owner_act: null, text}`;
// (b) with an owner act available (an open decision that clears it),
//     `owner_act {decision}`;
// (c) a stale or satisfied evaluation serves no such entry, and the existing
//     `replacement_pending` variant is unchanged (M430);
// (d) the work read serves `authoring {phase_plan, phase_number, criteria,
//     kinds}` on a `check_authoring` item with trigger authoring_gap, from its
//     recorded trigger evidence, and nothing on other items;
// (e) NOW on a paused project with work eligible but for the pause names
//     those items in `reason` and serves `primary_action: 'resume'`;
//     unpaused, not.
//
// How each state is arranged (no fixture write to the store):
// - (a), (c) stale: the held-phase state of item 55 (a phase evaluated on a
//   superseded candidate) is no longer produced on the base (e6676c2d). The
//   same read state is reached by another route: the reference journey at T1
//   with a phase-only check (`phase-r1`, gate_kinds [phase], M634 (d)'s
//   authoring), whose execution the scripted check boundary records exit 1.
//   The phase gate is then fresh, not satisfied (CHECK_NOT_PASSED), with no
//   run, no work and no open decision: the stall the console's U58 reads.
//   Stale: the engine restarted (every not-satisfied evaluation is marked
//   stale at start, engine.ts staleUnsatisfiedAtStart), read before any tick;
//   one tick evaluates it afresh.
// - (b): M634's fixture: the T1 phase's Verifier raises a Low defect on the
//   nominated candidate, owed to the owner as `finding_disposition`; the
//   phase gate is not satisfied while it is open. Answered `fix`, the fix
//   integrates and its candidate supersedes the nominated one (item 55: the
//   phase follows it), so `plan.verification` carries followed_* fields;
//   then the phase completes (satisfied).
// - (c) replacement_pending: M430 R1's fixture (a replacement replan held in
//   flight past phase 1's last integration).
// - (d), (e): M641's fixture (harness/gap57.mjs): the gap authoring on
//   iteration 1's plan naming R1.2 and R3.2, with iteration 2's replan
//   eligible, the project paused through the owner's route.
//
// Readings this file makes (the report says them):
// - `text` is read as a non-empty string; its wording is the engine's.
// - `evaluated_at` is read as the evaluation's computed_at or created_at.
// - "nothing on other items" is read as `authoring` absent or null.
// - "names those items" is read as each eligible item's id or kind in the
//   reason; "unpaused, no primary_action" as no `resume`.
//
// SAFETY (BS6 §4.1; E64): the kernel lane; the scripted role program in the
// test's own home; nothing signalled but the test's own engine.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { consume, decisionsOn } from './harness/decisions.mjs';
import { evaluationsOf, findingsOf, sharedFixture } from './harness/gates.mjs';
import { oldAlphaRefused, restart, show } from './harness/gap57.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { ROUTED_KINDS, builderScript, phasePlansOf, planOfPhase, queuedExecutions, readPlan, runsOfProject, stagesOfPlan, workOf } from './harness/journey/drive.mjs';
import { journey35, replan35 } from './harness/journey/plan35.mjs';
import { advanceHolding, changeTouching, changed, S2 } from './harness/journey/review35.mjs';
import { postChange } from './harness/journey/review31b.mjs';
import { BUILDER_FILES, authoringFiles } from './harness/journey/reference.mjs';
import { candidatesOf, pumpSome } from './harness/exec37/autonomy.mjs';
import { ok } from './harness/prototype.mjs';
import { resumeProject, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const NOT_PLAN = ROUTED_KINDS.filter((k) => k !== 'plan_approval');
const json = (t) => (typeof t === 'string' ? JSON.parse(t) : (t ?? null));
const phaseEvals = (home, candidate) => evaluationsOf(home, candidate, 'phase').map((e) => ({ ...e, reasons: json(e.reasons) ?? [] }));
const recorded = (home, plan) => json(withStore(home, (db) => db.prepare('SELECT "verification" FROM "phase_plans" WHERE "id" = ?').get(plan)).verification);
const openDecisions = (home, project) => withStore(home, (db) => db.prepare(`SELECT "id", "kind", "subject_id" FROM "decisions" WHERE "project" = ? AND "status" = 'open'`).all(project));
const withPhaseOnly = () => {
  const files = { ...authoringFiles(1) };
  const r1 = JSON.parse(files['.surety/checks/defs/accept-r1.json']);
  files['.surety/checks/defs/phase-r1.json'] = `${JSON.stringify({ ...r1, key: 'phase-r1', gate_kinds: ['phase'] }, null, 2)}\n`;
  return files;
};
const authoringWith = (files) => roleThat(Object.entries(files).map(([path, content]) => step.write(path, content)), { proposal: { rationale: "Phase 1's checks, with a phase-only check.", requested_change_kind: 'unclassifiable' } });

// The `phase_gate_not_satisfied` entry for `evaluation` of `candidate`.
function assertHeld(held, { evaluation, candidate, ownerAct }) {
  assert.ok(held, 'plan.completion_held_by is served while the phase gate is fresh and not satisfied');
  assert.equal(held.reason, 'phase_gate_not_satisfied', `for the phase gate not satisfied (${show(held)})`);
  assert.equal(held.evaluation, evaluation.id, 'naming the evaluation');
  assert.equal(held.candidate, candidate, 'and its candidate');
  assert.ok([evaluation.computed_at, evaluation.created_at].includes(held.evaluated_at), `evaluated_at is the evaluation's (${held.evaluated_at}; computed_at ${evaluation.computed_at}, created_at ${evaluation.created_at})`);
  assert.equal(held.stale, false, 'stale: false');
  assert.deepEqual(held.reasons, evaluation.reasons, 'its reasons as recorded');
  assert.deepEqual(held.owner_act ?? null, ownerAct, `owner_act (${show(held.owner_act)})`);
  assert.ok(typeof held.text === 'string' && held.text.trim() !== '', `with the engine's sentence (${show(held.text)})`);
}
const notPhaseHeld = (held) => held === null || held === undefined || held.reason !== 'phase_gate_not_satisfied';

describe('M642 (a), (c) a phase held by a not-satisfied phase gate with no owner act', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    const { fx, p, ctx, plan } = await journey35(shared.context, { tier: 'T1' });
    fx.scripted.kindScript('check_authoring', [authoringWith(withPhaseOnly())]);
    const c1 = await pumpSome(fx, ctx, () => {
      const c = candidatesOf(fx.home, p.id)[0];
      return c && phaseEvals(fx.home, c.id).length > 0 ? c : undefined;
    }, { what: 'the T1 phase gate evaluated with phase-r1 failing', max: 300, answerKinds: NOT_PLAN, exits: (x) => (x.key === 'phase-r1' ? 1 : 0) });
    await tick(fx.engine, p.id, { rounds: 3 });
    Object.assign(S, { fx, p, ctx, plan, c1 });
  });
  after(() => shared.cleanup());

  test("(a) the plan read serves plan.verification as recorded and completion_held_by {reason: 'phase_gate_not_satisfied', …, owner_act: null}", async () => {
    const { fx, p, plan, c1 } = S;
    const evals = phaseEvals(fx.home, c1.id);
    const last = evals.at(-1);
    assert.deepEqual([last.outcome, last.stale], ['not_satisfied', 0], `the fixture is live: the latest phase evaluation fresh and not satisfied (${show(evals.map((e) => [e.id, e.outcome, e.stale, e.reasons]))})`);
    assert.deepEqual(openDecisions(fx.home, p.id), [], 'the fixture is live: no open decision');
    assert.deepEqual(runsOfProject(fx.home, p.id).filter((r) => r.state !== 'ended').map((r) => r.id), [], 'the fixture is live: no run under way');
    const read = await readPlan(fx, p.id);
    assert.deepEqual([read.plan?.id, read.plan?.completed_at ?? null], [plan.id, null], 'the fixture is live: phase 1 open');
    const stored = recorded(fx.home, plan.id);
    assert.ok(stored?.nominated_revision, `the fixture is live: the plan records its nomination (${show(stored)})`);
    assert.deepEqual(read.plan.verification, stored, `plan.verification served as recorded (${show(read.plan.verification)})`);
    assertHeld(read.plan.completion_held_by, { evaluation: last, candidate: c1.id, ownerAct: null });
  });

  test('(c) a stale evaluation serves no such entry; evaluated afresh, the entry is served again', async () => {
    const { fx, p, c1 } = S;
    await restart(fx);
    const stale = phaseEvals(fx.home, c1.id).at(-1);
    assert.equal(stale.stale, 1, `the fixture is live: after the restart the latest phase evaluation is stale (${show([stale.id, stale.outcome, stale.stale])})`);
    const read = await readPlan(fx, p.id);
    assert.ok(notPhaseHeld(read.plan?.completion_held_by), `no phase_gate_not_satisfied entry on a stale evaluation (${show(read.plan?.completion_held_by)})`);
    await tick(fx.engine, p.id, { rounds: 2 });
    const fresh = phaseEvals(fx.home, c1.id).at(-1);
    assert.deepEqual([fresh.outcome, fresh.stale, fresh.id !== stale.id], ['not_satisfied', 0, true], 'the fixture is live: evaluated afresh, still not satisfied');
    assertHeld((await readPlan(fx, p.id)).plan?.completion_held_by, { evaluation: fresh, candidate: c1.id, ownerAct: null });
  });
});

// ---- (b) an owner act available, M634's fixture ---------------------------------------------

const F1 = { category: 'defect', severity: 'low', message: 'src/sum.mjs: a string operand is concatenated, not added.', criterion: 'R1.1', check: 'accept-r1' };
const openOwed = (home, finding) => decisionsOn(home, 'finding_disposition', finding).find((d) => d.status === 'open');

describe('M642 (b), (c) an owner act available; followed, then satisfied', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    const { fx, p, ctx, plan } = await journey35(shared.context, { tier: 'T1' });
    fx.scripted.kindScript('verification', [roleThat([], { findings: [F1] })]);
    fx.scripted.kindScript('fix', [roleThat([step.write('NOTES.md', 'The fix.\n')])]);
    const c1 = await pumpSome(fx, ctx, () => {
      const c = candidatesOf(fx.home, p.id)[0];
      if (!c) return undefined;
      const raised = findingsOf(fx.home, p.id).filter((f) => f.candidate === c.id);
      return raised.length === 1 && openOwed(fx.home, raised[0].id) && phaseEvals(fx.home, c.id).length > 0 ? c : undefined;
    }, { what: "the T1 phase's candidate with its finding owed to the owner and its phase gate evaluated", max: 300, answerKinds: NOT_PLAN });
    const [finding] = findingsOf(fx.home, p.id).filter((f) => f.candidate === c1.id);
    Object.assign(S, { fx, p, ctx, plan, c1, finding });
  });
  after(() => shared.cleanup());

  test('(b) with an open decision that clears it: owner_act {decision}', async () => {
    const { fx, p, c1, finding } = S;
    const owed = openOwed(fx.home, finding.id);
    const last = phaseEvals(fx.home, c1.id).at(-1);
    assert.deepEqual([last.outcome, last.stale], ['not_satisfied', 0], `the fixture is live: fresh, not satisfied (${show([last.id, last.outcome, last.stale, last.reasons])})`);
    assert.deepEqual(openDecisions(fx.home, p.id).map((d) => d.id), [owed.id], 'the fixture is live: the owner\'s finding_disposition is the one open decision');
    const read = await readPlan(fx, p.id);
    assertHeld(read.plan?.completion_held_by, { evaluation: last, candidate: c1.id, ownerAct: { decision: owed.id } });
  });

  test('(a) plan.verification served as recorded with the followed candidate; (c) satisfied and complete: no such entry', async () => {
    const { fx, p, ctx, plan, c1, finding } = S;
    await consume(fx, p.id, openOwed(fx.home, finding.id), 'fix');
    const c2 = await pumpSome(fx, ctx, () => candidatesOf(fx.home, p.id).find((c) => c.seq > c1.seq), { what: 'the fix integrated and its candidate nominated', max: 120, answerKinds: NOT_PLAN });
    const followed = await pumpSome(fx, ctx, () => (recorded(fx.home, plan.id)?.followed_candidate ? recorded(fx.home, plan.id) : undefined), { what: 'the phase following the superseding candidate', max: 60, answerKinds: NOT_PLAN });
    const read = await readPlan(fx, p.id);
    assert.deepEqual(read.plan?.verification, recorded(fx.home, plan.id), `plan.verification served as recorded, followed_* included (${show(read.plan?.verification)}; recorded ${show(followed)}; c2 ${c2.id})`);
    const done = await pumpSome(fx, ctx, () => planOfPhase(fx.home, p.id, 1).find((x) => x.id === plan.id && x.completed_at), { what: 'phase 1 completed', max: 150, answerKinds: NOT_PLAN });
    assert.ok(phaseEvals(fx.home, done.completion_binding.candidate).some((e) => e.outcome === 'satisfied'), 'the fixture is live: satisfied');
    const after = await readPlan(fx, p.id);
    assert.ok(notPhaseHeld(after.plan?.completion_held_by), `no phase_gate_not_satisfied entry once satisfied (${show(after.plan?.completion_held_by)})`);
  });
});

// ---- (c) replacement_pending unchanged: M430 R1's fixture --------------------------------------

const DUMP = step.probe('context_dump');
const HOLD = step.hold('gate', { heartbeat_ms: 250 });
const S2R = changed(S2, { number: 3, goal: 'the service, restated', depends_on: [2] });
const builderS2R = roleThat([step.write('server.mjs', `${BUILDER_FILES[2]['server.mjs']}// R2 restated: a refused request names the parameter.\n`)]);
const refusedPlan = (b = []) => replan35({ phase: 1, spec_version: 2, stages: [{ ...S2R, depends_on: ['stage-x'] }], before: b });
const replacementPlan = (b = [], conformance = 'within_baseline') => replan35({ phase: 1, spec_version: 2, stages: [S2R], before: b, conformance });

describe('M642 (c) the replacement_pending variant unchanged', () => {
  test("(c) a satisfied phase gate held by a pending replacement: completion_held_by {reason: 'replacement_pending'} as before, no phase_gate_not_satisfied entry", async (t) => {
    const { fx, p, ctx, plan } = await journey35(t, { tier: 'T1' });
    fx.scripted.kindScript('stage_build', [builderScript(1), builderScript(2), builderS2R, builderS2R]);
    fx.scripted.kindScript('spec_change', changeTouching('R2', 'A user sums two numbers through the service, and a refused request names the parameter.'));
    fx.scripted.kindScript('check_correction', roleThat([], { spec_applicability: ['accept-r2', 'integration'].map((check) => ({ check, criteria: ['R1.1', 'R2.1', 'R2.2'], rationale: `${check} asserts what R2's criteria say; the restated statement leaves them unchanged.` })) }));
    fx.scripted.kindScript('replan', [refusedPlan([DUMP, HOLD]), replacementPlan([DUMP], 'uncertain')]);
    await postChange(fx, ctx, 'Restate R2.');
    const launch = await advanceHolding(fx, ctx, () => {
      const l = fx.scripted.launches({ work_kind: 'replan' })[0];
      return l && fx.scripted.eventsOf(l.pid, 'holding').length > 0 ? l : undefined;
    }, { what: 'the replacement replan launched and held' });
    const item = workOf(fx.home, p.id, 'replan').find((w) => w.id === launch.work_item);
    let quiet = 0;
    await advanceHolding(fx, ctx, () => {
      const built = stagesOfPlan(fx.home, plan.id).every((x) => x.status === 'integrated' || x.status === 'verified');
      const busy = runsOfProject(fx.home, p.id).some((r) => r.state !== 'ended' && r.work_item !== item.id) || queuedExecutions(fx.home, p.id).length > 0;
      quiet = built && !busy ? quiet + 1 : 0;
      return quiet >= 6 ? true : undefined;
    }, { what: "phase 1's stages integrated with the replacement held", max: 200 });
    const now = phasePlansOf(fx.home, p.id).find((x) => x.id === plan.id);
    assert.equal(now.completed_at ?? null, null, 'the fixture is live: phase 1 open while the replacement is in flight');
    const cands = candidatesOf(fx.home, p.id);
    const last = cands.length > 0 ? phaseEvals(fx.home, cands.at(-1).id).at(-1) : undefined;
    assert.equal(last?.outcome, 'satisfied', `the fixture is live: the latest phase evaluation satisfied (${show(last && [last.id, last.outcome, last.stale, last.reasons])})`);
    const held = (await readPlan(fx, p.id)).plan?.completion_held_by ?? null;
    assert.equal(held?.reason, 'replacement_pending', `the replacement_pending variant, unchanged (${show(held)})`);
    assert.equal(held.work_item, item.id, 'naming the pending replacement');
    assert.deepEqual([held.trigger?.source, held.trigger?.id], [item.trigger_source, item.trigger_id], 'with its trigger');
    assert.equal(held.question ?? null, null, 'and no open question while in flight');
    fx.scripted.release('all', 'gate');
  });
});

// ---- (d), (e) the work read and NOW: M641's fixture -------------------------------------------

describe('M642 (d), (e) the work read names an authoring\'s criteria; NOW names the paused work', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    J = await oldAlphaRefused(shared.context, { name: 'M642 de', port: 18651 });
  });
  after(() => shared.cleanup());

  test('(d) authoring {phase_plan, phase_number, criteria, kinds} on the authoring_gap item, from its trigger evidence; nothing on other items', async () => {
    const { fx, p, G, plan1 } = J;
    const items = (await ok(fx.engine.get(`/v1/projects/${p}/work`), 200, 'GET …/work')).work_items;
    const g = items.find((w) => w.id === G);
    assert.ok(g, 'the gap authoring is listed');
    const a = g.authoring;
    assert.ok(a && typeof a === 'object', `authoring served on the authoring_gap item (${show(g)})`);
    assert.deepEqual([a.phase_plan, a.phase_number, a.criteria, a.kinds], [plan1.id, 1, ['R1.2', 'R3.2'], []], `naming iteration 1's plan, phase 1, R1.2 and R3.2, no kind (${show(a)})`);
    const others = items.filter((w) => w.id !== G && !(w.kind === 'check_authoring' && w.trigger_source === 'authoring_gap'));
    assert.ok(others.some((w) => w.kind === 'check_authoring') && others.some((w) => w.kind === 'replan'), `the fixture is live: other items, a phase authoring and a replan among them (${show(others.map((w) => [w.kind, w.trigger_source]))})`);
    const carrying = others.filter((w) => w.authoring !== undefined && w.authoring !== null);
    assert.deepEqual(carrying.map((w) => [w.id, w.kind, w.trigger_source, w.authoring]), [], 'nothing on other items');
  });

  test("(e) paused with work eligible but for the pause: NOW names those items and serves primary_action 'resume'; unpaused, not", async () => {
    const { fx, p } = J;
    const project = (await ok(fx.engine.get(`/v1/projects/${p}`), 200, 'GET …/projects/:p')).project;
    assert.equal(project.paused, true, 'the fixture is live: paused');
    const eligible = (await ok(fx.engine.get(`/v1/projects/${p}/work`), 200, 'GET …/work')).work_items.filter((w) => w.status === 'eligible');
    assert.ok(eligible.length >= 2, `the fixture is live: the replan and the gap authoring eligible (${show(eligible.map((w) => [w.id, w.kind]))})`);
    assert.deepEqual(openDecisions(fx.home, p), [], 'the fixture is live: no open decision');
    const now = project.now;
    assert.equal(now?.primary_action, 'resume', `primary_action resume (${show(now)})`);
    for (const w of eligible) assert.ok(now.reason.includes(w.id) || now.reason.includes(w.kind), `the reason names ${w.id} (${w.kind}): ${now.reason}`);
    await resumeProject(fx.engine, p);
    const after = (await ok(fx.engine.get(`/v1/projects/${p}`), 200, 'GET …/projects/:p')).project;
    assert.equal(after.paused, false, 'resumed');
    assert.notEqual(after.now?.primary_action, 'resume', `unpaused, no resume (${show(after.now)})`);
  });
});
