// M425, plan references and approvals (slice 35; kernel lane). M5 plan §3.5
// M425; D6-P01, D6-P02; D6 §5.3 items 1 and 2, A.4; B03; the driver's
// rulings of 2026-10-13; SEAM.md §§406 to 408.
//
// (a) each reference refused at the first Architect close: an unknown
//     requirement, a withdrawn one, an unknown module, an unknown ADR, a
//     criterion of a requirement the stage does not implement, a `depends_on`
//     naming no stage, a duplicate stage number. Each: 422 `plan_refused`
//     naming the reason and its subject, a refused `plan_checks` row with the
//     subjects, `baseline.plan_refused`, nothing published;
// (b) a correct plan: no reason;
// (c) a plan prepared against a superseded spec version: PLAN_STALE_BASELINE
//     (a superseded architecture or roadmap version: M424 (f) and M448 (a),
//     not re-written);
// (d) a head moved under the session by a protected application and the
//     session's own checkpoint (harmless): re-based, rechecked, published
//     with `prepared_against_revision` the moved head (a material move, a new
//     approved spec version: M424 (f), not re-written);
// (e) an ADR the plan references deleted by a competing proposal between the
//     plan's check and its publication: 409 `plan_generation_stale`, the
//     cause naming `PLAN_UNKNOWN_ADR ADR-002` (the driver's ruling).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { governedEdit, humanApplies } from './harness/gates.mjs';
import { consume, decision } from './harness/decisions.mjs';
import { NOTHING, nothingPublished, planOfPhase, waitPublished } from './harness/journey/drive.mjs';
import {
  approvedChange,
  codesOf,
  firstClose,
  journey35,
  nextReplanOutcome,
  phaseOf,
  refusalText,
  replan35,
  seenNow,
  specReady,
  stagesWith,
  subjectsOf,
} from './harness/journey/plan35.mjs';
import { ADR_KEY, REQUIREMENTS, ROADMAP_JSON, STAGES, adrText, architectFiles, specText } from './harness/journey/reference.mjs';
import { refOid } from './harness/repos.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { closeSession, openSession, saveSession, sayAndSettle, scriptTurns, turnResult, turnThatWrites } from './harness/sessions.mjs';

// One refused attempt: 422 plan_refused naming `code` and `subject`; the check
// row refused with the subject; one baseline.plan_refused; nothing published.
function assertRefusedFor(fx, p, attempt, code, subject, what) {
  assert.equal(attempt.res.status, 422, `${what}: the close is refused (→ ${attempt.res.status} ${attempt.res.text})`);
  assert.equal(attempt.res.body?.code, 'plan_refused', `${what}: plan_refused`);
  assert.ok(refusalText(attempt.res).includes(code) && refusalText(attempt.res).includes(subject), `${what}: the refusal names ${code} and ${subject} (${refusalText(attempt.res)})`);
  assert.ok(attempt.check && attempt.check.outcome === 'refused', `${what}: a refused plan_checks row is recorded (SEAM.md §407) (latest: ${JSON.stringify(attempt.check && { outcome: attempt.check.outcome, reasons: attempt.check.reasons })})`);
  assert.ok(subjectsOf(attempt.check, code).includes(subject), `${what}: the check's ${code} names ${subject} (${JSON.stringify(attempt.check.reasons)})`);
  assert.equal(attempt.refusals.length, 1, `${what}: one baseline.plan_refused`);
  assert.ok(JSON.stringify(attempt.refusals[0].payload ?? {}).includes(code), `${what}: the event carries the reason (${JSON.stringify(attempt.refusals[0].payload)})`);
  assert.deepEqual(nothingPublished(fx.home, p.id, { allowKinds: ['spec_change', 'check_correction', 'replan'] }), NOTHING, `${what}: nothing published`);
}

// The reference variants of (a), each one defect in the reference plan.
// Subjects as SEAM.md §407 pins them.
const REFERENCES = [
  { what: 'an unknown requirement', code: 'PLAN_UNKNOWN_REQUIREMENT', subject: 'R9', stages: stagesWith(1, { 1: { implements: ['R1', 'R9'] } }) },
  { what: 'an unknown module', code: 'PLAN_UNKNOWN_MODULE', subject: 'ui', stages: stagesWith(1, { 1: { modules: ['lib', 'ui'] } }) },
  { what: 'an unknown ADR', code: 'PLAN_UNKNOWN_ADR', subject: 'ADR-009', stages: stagesWith(1, { 1: { adrs: [ADR_KEY, 'ADR-009'] } }) },
  { what: 'a criterion of a requirement the stage does not implement', code: 'PLAN_CRITERION_MISMATCH', subject: 'R2.1', stages: stagesWith(1, { 1: { validation: { criteria: ['R1.1', 'R2.1'] } } }) },
  { what: 'a depends_on naming no stage', code: 'PLAN_UNKNOWN_STAGE', subject: 'stage 2 -> 7', stages: stagesWith(1, { 2: { depends_on: [7] } }) },
  { what: 'a duplicate stage number', code: 'PLAN_DUPLICATE_STAGE', subject: 'stage 1', stages: stagesWith(1, { 2: { number: 1, depends_on: [] } }) },
];

describe('M425 plan references and approvals', () => {
  test('(a) each reference refused at the close with its reason, plan_refused, baseline.plan_refused and the refused plan_check; (b) the correct plan has no reason', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await specReady(fx);
    for (const v of REFERENCES) {
      const attempt = await firstClose(fx, p, { stages: v.stages });
      assertRefusedFor(fx, p, attempt, v.code, v.subject, v.what);
    }
    // (b) the reference plan itself.
    const correct = await firstClose(fx, p);
    assert.equal(correct.res.status, 200, `the correct plan's close is accepted (→ ${correct.res.status} ${correct.res.text})`);
    assert.equal(correct.check?.outcome, 'passed');
    assert.deepEqual(correct.check.reasons, [], 'no reason');
    assert.equal(correct.refusals.length, 0, 'no baseline.plan_refused');
  });

  test('(a) a withdrawn requirement: PLAN_UNKNOWN_REQUIREMENT naming it; (c) a plan prepared against a superseded spec version: PLAN_STALE_BASELINE', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await specReady(fx);
    // R4 withdrawn by an approved change (version 2).
    const withoutR4 = specText({ version: 2, requirements: REQUIREMENTS.filter((r) => r.key !== 'R4') });
    await approvedChange(fx, p, withoutR4, 2, [{ key: 'R4', kind: 'withdrawn', reason: 'the stats route is dropped' }]);
    const roadmap = { '.surety/roadmap/roadmap.json': { ...ROADMAP_JSON, phases: [phaseOf(1), { ...phaseOf(2), requirement_ids: ['R3'] }] } };
    const withdrawn = await firstClose(fx, p, { over: roadmap, specVersion: 2, stages: stagesWith(1, { 1: { implements: ['R1', 'R4'] } }) });
    assertRefusedFor(fx, p, withdrawn, 'PLAN_UNKNOWN_REQUIREMENT', 'R4', 'a stage implementing the withdrawn R4');
    // (c) the same products, prepared against spec version 1.
    const stale = await firstClose(fx, p, { over: roadmap, specVersion: 1 });
    assert.equal(stale.res.status, 422, `prepared against spec 1 is refused (→ ${stale.res.status} ${stale.res.text})`);
    assert.ok(refusalText(stale.res).includes('PLAN_STALE_BASELINE'), `naming PLAN_STALE_BASELINE (${refusalText(stale.res)})`);
    assert.ok(codesOf(stale.check).includes('PLAN_STALE_BASELINE') && stale.check.outcome === 'refused', `the refused check records it (${JSON.stringify(stale.check?.reasons)})`);
    // The control: prepared against spec 2 it passes.
    const current = await firstClose(fx, p, { over: roadmap, specVersion: 2 });
    assert.equal(current.res.status, 200, `prepared against spec 2 it is accepted (→ ${current.res.status} ${current.res.text})`);
  });

  test('(d) a protected application and the session\'s own checkpoint move the head under the session: re-based, rechecked, published with prepared_against_revision the moved head', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await specReady(fx);
    const run = await openSession(fx, p.id, 'architect');
    const opened = refOid(p.repo.path, p.repo.ref);
    scriptTurns(fx, run.id, [turnThatWrites(architectFiles({ revision: opened }), { reply: 'Architecture, map, ADR, roadmap and phase 1.', done: true })]);
    await sayAndSettle(fx, p.id, run.id, 'Design Tally and plan phase 1.');
    await saveSession(fx, p.id, run.id);
    // The owner's governed edit, applied: an engine commit on the integration branch.
    const proposal = await governedEdit(fx, p, { protected_paths: ['.surety/checks/', 'docs/'] });
    await humanApplies(fx, p, proposal, 'tightening');
    const moved = refOid(p.repo.path, p.repo.ref);
    assert.notEqual(moved, opened, 'the fixture is live: the head moved after the session opened');
    const closed = await fx.engine.post(`/v1/projects/${p.id}/sessions/${run.id}/close`, {});
    assert.equal(closed.status, 200, `the close is accepted: a harmless move is re-based (→ ${closed.status} ${closed.text})`);
    for (const d of closed.body.decisions ?? []) await consume(fx, p.id, decision(fx.home, d.id), 'approve');
    const published = await waitPublished(fx, p.id);
    assert.equal(published.prepared_against_revision, moved, `the publication is prepared against the moved head ${moved}, not the head at open ${opened} (D6 §5.3 item 2)`);
  });

  test('(e) an ADR the routed plan references deleted by a competing proposal published first: 409 plan_generation_stale, the cause naming PLAN_UNKNOWN_ADR ADR-002', async (t) => {
    const ADR_2 = '.surety/adrs/ADR-002.md';
    const { fx, p, ctx } = await journey35(t, { over: { [ADR_2]: adrText({ key: 'ADR-002', decision: 'Answers are JSON.' }) } });
    // Proposal A: the replan, referencing ADR-002, declared uncertain so it awaits the owner.
    fx.scripted.kindScript('replan', [replan35({ conformance: 'uncertain', stages: stagesWith(2, { 3: { adrs: [ADR_KEY, 'ADR-002'] } }) })]);
    const seen = seenNow(fx.home, p.id);
    const a = await nextReplanOutcome(fx, ctx, 2, seen);
    assert.ok(a.approval, `the replan awaits the owner (${JSON.stringify(Object.keys(a))})`);
    // Proposal B: the owner's Architect session for phase 2, deleting ADR-002.
    const run = await openSession(fx, p.id, 'architect');
    const head = refOid(p.repo.path, p.repo.ref);
    // Retiring ADR-002 is an architecture revision (version 2), which the roadmap names (version 2).
    const plan = { phase: 2, prepared_against: { spec_version: 1, architecture_version: 2, roadmap_version: 2, revision: head }, stages: STAGES[2], conformance: 'within_baseline' };
    const roadmap = { ...ROADMAP_JSON, version: 2, architecture_version: 2 };
    scriptTurns(fx, run.id, [
      {
        steps: [
          step.delete(ADR_2),
          step.write('.surety/roadmap/roadmap.json', `${JSON.stringify(roadmap, null, 2)}\n`),
          step.write('.surety/phases/phase-2.json', `${JSON.stringify(plan, null, 2)}\n`),
          step.result(turnResult({ reply: 'ADR-002 retired; phase 2 planned.', artifact_changed: true, done: true })),
        ],
      },
    ]);
    await sayAndSettle(fx, p.id, run.id, 'Retire ADR-002 and plan phase 2.');
    await saveSession(fx, p.id, run.id);
    const closed = await closeSession(fx, p.id, run.id);
    for (const d of closed.decisions ?? []) await consume(fx, p.id, decision(fx.home, d.id), 'approve');
    const publishedB = await tickUntil(fx.engine, p.id, () => planOfPhase(fx.home, p.id, 2).find((x) => x.published_at), { max: 8, what: 'the competing proposal to be published' });
    assert.ok(publishedB, 'the competing proposal is published first');
    // A answered now: refused at publication.
    const res = await fx.engine.post(`/v1/projects/${p.id}/decisions/${a.approval.id}/answer`, { option: 'approve', preview_hash: a.approval.preview_hash });
    assert.equal(res.status, 409, `the earlier proposal is refused at its publication (→ ${res.status} ${res.text})`);
    assert.equal(res.body?.code, 'plan_generation_stale');
    assert.match(JSON.stringify(res.body), /PLAN_UNKNOWN_ADR[^"]*ADR-002/, `the cause names PLAN_UNKNOWN_ADR ADR-002 (the driver's ruling) (${res.text})`);
    assert.equal(planOfPhase(fx.home, p.id, 2).filter((x) => x.published_at).length, 1, 'one phase-2 plan published, B\'s');
    // Objection 082: a completed plan stays its phase's active generation, so phase 2's is read by its phase.
    assert.equal(planOfPhase(fx.home, p.id, 2).find((x) => x.active === 1 || x.active === true)?.id, publishedB.id, 'B\'s plan is phase 2\'s active generation');
  });
});
