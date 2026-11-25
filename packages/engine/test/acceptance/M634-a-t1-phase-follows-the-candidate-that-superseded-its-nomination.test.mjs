// M634, a T1 phase follows the candidate that superseded its nomination (the
// owner's M7 plan §3i, row M634; D6 §5.8; B06; E11; M428 (a); M406;
// accept.ts: a fix naming a finding is a cadence point; DECISIONS item 55).
// Found on Workshop Cut Planner iteration 2 (2026-11-25, 13:55Z to 14:16Z):
// at T1 the phase nominated the integration head once, when every stage was
// integrated (plan/phase.ts phaseCandidate records `nominated_revision`); the
// owner's `fix` of a finding raised on that candidate integrated a later
// head, whose cadence nomination superseded the nominated candidate; the
// phase gate was then evaluated on the superseded candidate at every tick
// (gate_01M89GSZXE… at 14:15:59Z on cand_01M89FTCZH…, reasons
// [{"code":"CANDIDATE_SUPERSEDED","subjects":["cand_01M89GPWFTRA368MQ647HV4Q4J"]}],
// fresh, not satisfied, while candidate 3's two stage gates were satisfied at
// the same tick) and the phase never completed, with nothing open for the
// owner.
//
// The fixture is the reference journey at T1 under `autonomy: phase` on the
// scripted backend (M428 (a), M406 at T1): both stages integrate, the phase
// nominates once, and its Verifier (the first `verification` launch, the
// scripted role) raises a Low defect naming R1.1 and `accept-r1` on that
// candidate. T1 queues no review, so the finding is owed to the owner
// (SEAM.md §466) as a `finding_disposition` question; the case answers it
// `fix` as the owner did. The fix's Builder (the scripted `fix` kind) writes
// a file; its integration is a cadence point and nominates the superseding
// candidate (E104). Every check result is the scripted boundary's (exit 0
// unless a case withholds it). No fixture write to the store.
//
// (a) the phase gate evaluated on the superseding candidate, not the
//     superseded one; once satisfied the phase completes with its binding
//     naming the superseding candidate; the plan's recorded nomination keeps
//     the first revision and records the followed candidate;
// (b) the stall, read as the fixed engine must not show it: with the
//     superseder's checks recorded, a phase evaluation of the superseder
//     exists within a few ticks, and no fresh phase evaluation of the
//     superseded candidate naming CANDIDATE_SUPERSEDED (the production
//     record) is recorded after the superseder's nomination. On the base the
//     failure message carries the superseded candidate's evaluations;
// (c) two supersessions in a row: the Verifier raised two findings (R1.1 /
//     accept-r1 and R2.1 / accept-r2); the owner fixes the first, then, with
//     the intermediate candidate's check results withheld at the scripted
//     boundary (so nothing is evaluated on it), the second: the newest
//     candidate is followed and the intermediate one gets no phase
//     evaluation;
// (d) the first nomination exactly once (M428 (a)), with a phase-only check
//     added to phase 1's authoring (`phase-r1`, gate_kinds [phase], covering
//     R1.1, as M428 (e) varies the authoring) so its registrations are
//     countable: no second nomination of the phase's revision, no
//     `nomination_due` left, the phase-only check registered once on the
//     nominated candidate and at most once (its own) on the superseder; then
//     M406's effects once per binding on the followed candidate, across ticks
//     and a restart.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { roleThat } from './harness/gitruns.mjs';
import { consume, decisionsOn } from './harness/decisions.mjs';
import { evaluationsOf, findingsOf, sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { ROUTED_KINDS, eventsAbout, executionsOf, planOfPhase, workOf } from './harness/journey/drive.mjs';
import { journey35 } from './harness/journey/plan35.mjs';
import { authoringFiles } from './harness/journey/reference.mjs';
import { candidatesOf, pumpSome } from './harness/exec37/autonomy.mjs';
import { tick, waitForIdle } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const NOT_PLAN = ROUTED_KINDS.filter((k) => k !== 'plan_approval');
const F1 = { category: 'defect', severity: 'low', message: 'src/sum.mjs: a string operand is concatenated, not added.', criterion: 'R1.1', check: 'accept-r1' };
const F2 = { category: 'defect', severity: 'low', message: 'src/service.mjs: a non-number answers 500, not 400.', criterion: 'R2.1', check: 'accept-r2' };
const FIXES = [roleThat([step.write('NOTES.md', 'The first fix.\n')]), roleThat([step.write('NOTES-2.md', 'The second fix.\n')])];
const SETTLED = ['recorded', 'cancelled', 'not_run', 'interrupted', 'quarantined'];

const json = (t) => (typeof t === 'string' ? JSON.parse(t) : (t ?? null));
const show = (v) => JSON.stringify(v);
const phaseEvals = (home, candidate) => evaluationsOf(home, candidate, 'phase').map((e) => ({ ...e, reasons: json(e.reasons) ?? [] }));
const brief = (e) => ({ id: e.id, outcome: e.outcome, stale: e.stale, reasons: e.reasons });
const supersededReason = (e) => e.reasons.find((r) => r.code === 'CANDIDATE_SUPERSEDED');
// The plan's recorded nomination (phase_plans.verification), as the store holds it.
const recorded = (home, plan) => json(withStore(home, (db) => db.prepare('SELECT "verification" FROM "phase_plans" WHERE "id" = ?').get(plan)).verification);
const planRow = (home, project, plan) => planOfPhase(home, project, 1).find((x) => x.id === plan);
const verificationOf = (home, project, candidate) => workOf(home, project, 'verification').filter((w) => w.subject?.candidate === candidate);
const openOwed = (home, finding) => decisionsOn(home, 'finding_disposition', finding).find((d) => d.status === 'open');
const nominationDue = (home, project) => withStore(home, (db) => db.prepare('SELECT "nomination_due" FROM "projects" WHERE "id" = ?').get(project)).nomination_due ?? null;
const gateEvaluatedSeq = (home, id) => Math.min(...eventsOfType(home, 'gate.evaluated').filter((e) => JSON.stringify(e).includes(id)).map((e) => e.seq));
const nominatedSeq = (home, candidate) => Math.min(...eventsOfType(home, 'candidate.nominated').filter((e) => JSON.stringify(e).includes(candidate)).map((e) => e.seq));
const settledOn = (home, candidate) => {
  const xs = executionsOf(home, candidate);
  return xs.length > 0 && xs.every((x) => SETTLED.includes(x.status));
};

// The journey at T1 to the phase's candidate verified with `findings` raised
// on it by its Verifier, each owed to the owner, and the phase gate evaluated
// on it not satisfied. `files`: phase 1's check authoring, varied.
async function verifiedWithFindings(t, findings, { files } = {}) {
  const { fx, p, ctx, plan } = await journey35(t, { tier: 'T1' });
  fx.scripted.kindScript('verification', [roleThat([], { findings })]);
  fx.scripted.kindScript('fix', FIXES);
  if (files) fx.scripted.kindScript('check_authoring', [roleThat(Object.entries(files).map(([path, content]) => step.write(path, content)), { proposal: { rationale: 'Phase 1\'s checks, with a phase-only check.', requested_change_kind: 'unclassifiable' } })]);
  const c1 = await pumpSome(
    fx,
    ctx,
    () => {
      const c = candidatesOf(fx.home, p.id)[0];
      if (!c) return undefined;
      const verified = verificationOf(fx.home, p.id, c.id).some((w) => w.status === 'complete');
      const raised = findingsOf(fx.home, p.id).filter((f) => f.candidate === c.id);
      const owed = raised.length === findings.length && raised.every((f) => openOwed(fx.home, f.id));
      return verified && owed && phaseEvals(fx.home, c.id).length > 0 ? c : undefined;
    },
    { what: 'the phase\'s T1 candidate verified, its findings owed to the owner and its phase gate evaluated', max: 300, answerKinds: NOT_PLAN },
  );
  assert.equal(candidatesOf(fx.home, p.id).length, 1, 'the fixture is live: one candidate, the phase\'s own nomination');
  assert.equal(c1.nominated_by, 'engine_cadence', 'the fixture is live: nominated by engine cadence');
  assert.equal(recorded(fx.home, plan.id)?.nominated_revision, c1.revision, `the fixture is live: the plan records the nominated revision (${show(recorded(fx.home, plan.id))})`);
  const onC1 = phaseEvals(fx.home, c1.id);
  assert.ok(onC1.every((e) => e.outcome !== 'satisfied'), `the fixture is live: the phase gate on the nominated candidate not satisfied while the finding is open (${show(onC1.map(brief))})`);
  assert.equal(planRow(fx.home, p.id, plan.id).completed_at ?? null, null, 'the fixture is live: phase 1 not complete');
  const raised = findingsOf(fx.home, p.id).filter((f) => f.candidate === c1.id);
  return { fx, p, ctx, plan, c1, raised };
}

// The owner answers `fix` on a finding; its fix's Builder integrates and the
// engine nominates the superseding candidate. `withheld`: candidates whose
// check results the scripted boundary holds back.
async function fixedAndSuperseded(J, f, { withheld = new Set(), after: prior } = {}) {
  const { fx, p, ctx } = J;
  const owed = openOwed(fx.home, f.id);
  assert.ok(owed, `the fixture is live: the owner's question on ${f.id} is open`);
  assert.ok(owed.options.some((o) => o.key === 'fix'), `the fixture is live: fix is offered (${show(owed.options.map((o) => o.key))})`);
  const fixesBefore = new Set(workOf(fx.home, p.id, 'fix').map((w) => w.id));
  await consume(fx, p.id, owed, 'fix');
  const from = prior ?? J.c1;
  const next = await pumpSome(fx, ctx, () => candidatesOf(fx.home, p.id).find((c) => c.seq > from.seq), {
    what: `the fix of ${f.id} integrated and its successor nominated`,
    max: 120,
    answerKinds: NOT_PLAN,
    record: (x) => !withheld.has(x.candidate),
  });
  const fix = workOf(fx.home, p.id, 'fix').filter((w) => !fixesBefore.has(w.id));
  assert.equal(fix.length, 1, `the fixture is live: one fix work item for ${f.id} (${show(fix.map((w) => [w.id, w.status, w.subject]))})`);
  assert.ok(
    eventsOfType(fx.home, 'work.integrated').some((e) => e.subject?.work_item === fix[0].id),
    'the fixture is live: the fix\'s Builder integrated',
  );
  assert.ok(nominatedSeq(fx.home, next.id) > Math.max(...eventsOfType(fx.home, 'work.integrated').filter((e) => e.subject?.work_item === fix[0].id).map((e) => e.seq)), 'nominated after the fix\'s integration');
  return next;
}

describe('M634 (a), (b) one fix supersedes the phase\'s nominated candidate', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    J = await verifiedWithFindings(shared.context, [F1]);
    J.c2 = await fixedAndSuperseded(J, J.raised[0]);
    const { fx, p, ctx, plan } = J;
    // The superseder's own checks recorded (or the phase already complete).
    await pumpSome(fx, ctx, () => settledOn(fx.home, J.c2.id) || Boolean(planRow(fx.home, p.id, plan.id).completed_at), {
      what: 'the superseding candidate\'s checks recorded',
      max: 120,
      answerKinds: NOT_PLAN,
    });
  });
  after(shared.cleanup);

  test('(b) the stall does not persist: a phase evaluation of the superseder within a few ticks; no fresh CANDIDATE_SUPERSEDED evaluation of the superseded candidate after the superseder\'s nomination', async () => {
    const { fx, p, ctx, c1, c2 } = J;
    let onC2 = null;
    try {
      onC2 = await pumpSome(fx, ctx, () => phaseEvals(fx.home, c2.id)[0], { what: 'a phase evaluation of the superseder', max: 8, answerKinds: NOT_PLAN });
    } catch {
      onC2 = null;
    }
    const onC1 = phaseEvals(fx.home, c1.id);
    const afterNomination = onC1.filter((e) => gateEvaluatedSeq(fx.home, e.id) > nominatedSeq(fx.home, c2.id));
    const stalled = afterNomination.filter((e) => e.stale === 0 && e.outcome !== 'satisfied' && (supersededReason(e)?.subjects ?? []).includes(c2.id));
    assert.ok(
      onC2,
      `a phase evaluation of the superseding candidate ${c2.id} within 8 ticks after its checks were recorded; none exists, and the phase gate is still read on the superseded ${c1.id}: ${show(onC1.map(brief))}`,
    );
    assert.deepEqual(stalled.map(brief), [], `no fresh, not-satisfied phase evaluation of the superseded candidate naming CANDIDATE_SUPERSEDED (${c2.id}) after the superseder's nomination`);
    void p;
  });

  test('(a) the phase gate evaluated on the superseding candidate; satisfied, the phase completes bound to it; the plan\'s recorded nomination keeps the first revision and records the followed candidate', async () => {
    const { fx, p, ctx, plan, c1, c2 } = J;
    const done = await pumpSome(fx, ctx, () => planRow(fx.home, p.id, plan.id).completed_at && planRow(fx.home, p.id, plan.id), {
      what: `phase 1 to complete on the superseding candidate ${c2.id} (phase evaluations on the superseded ${c1.id}: ${show(phaseEvals(fx.home, c1.id).map(brief))})`,
      max: 150,
      answerKinds: NOT_PLAN,
    });
    assert.equal(done.completion_binding?.candidate, c2.id, `the completion binding names the superseding candidate (${show(done.completion_binding)})`);
    const satisfied = phaseEvals(fx.home, c2.id).filter((e) => e.outcome === 'satisfied');
    assert.ok(satisfied.length > 0, `a satisfied phase evaluation of the superseding candidate (${show(phaseEvals(fx.home, c2.id).map(brief))})`);
    const onC1 = phaseEvals(fx.home, c1.id).filter((e) => gateEvaluatedSeq(fx.home, e.id) > nominatedSeq(fx.home, c2.id));
    assert.deepEqual(onC1.map(brief), [], 'no phase evaluation of the superseded candidate after the superseder\'s nomination');
    const [f1] = J.raised;
    assert.equal(findingsOf(fx.home, p.id).find((f) => f.id === f1.id).status, 'resolved', 'the fixed finding resolved on the superseding candidate');
    const nomination = recorded(fx.home, plan.id);
    assert.equal(nomination?.nominated_revision, c1.revision, `the recorded nomination keeps the first revision (${show(nomination)})`);
    assert.ok(JSON.stringify(nomination).includes(c2.id), `the recorded nomination records the followed candidate ${c2.id} (${show(nomination)})`);
    assert.equal(candidatesOf(fx.home, p.id).filter((c) => c.revision === c1.revision).length, 1, 'the first revision nominated once');
  });
});

describe('M634 (c) two supersessions in a row', () => {
  test('(c) a second fix after the first: the newest candidate is followed; the intermediate one gets no phase evaluation', async (t) => {
    const J = await verifiedWithFindings(t, [F1, F2]);
    const { fx, p, ctx, plan, c1 } = J;
    const [f1, f2] = J.raised;
    assert.deepEqual([f1.check !== null, f2.check !== null], [true, true], 'the fixture is live: both findings name their check');
    const withheld = new Set();
    const c2 = await fixedAndSuperseded(J, f1, { withheld });
    // The intermediate candidate's results held back at the scripted boundary,
    // so nothing is evaluated on it before the second fix supersedes it.
    withheld.add(c2.id);
    const c3 = await fixedAndSuperseded(J, f2, { withheld, after: c2 });
    const done = await pumpSome(fx, ctx, () => planRow(fx.home, p.id, plan.id).completed_at && planRow(fx.home, p.id, plan.id), {
      what: `phase 1 to complete on the newest candidate ${c3.id} (phase evaluations on ${c1.id}: ${show(phaseEvals(fx.home, c1.id).map(brief))})`,
      max: 150,
      answerKinds: NOT_PLAN,
      record: (x) => !withheld.has(x.candidate),
    });
    assert.equal(done.completion_binding?.candidate, c3.id, `the newest candidate followed: the completion bound to ${c3.id} (${show(done.completion_binding)})`);
    assert.ok(phaseEvals(fx.home, c3.id).some((e) => e.outcome === 'satisfied'), `a satisfied phase evaluation of the newest candidate (${show(phaseEvals(fx.home, c3.id).map(brief))})`);
    assert.deepEqual(phaseEvals(fx.home, c2.id).map(brief), [], 'the intermediate candidate gets no phase evaluation');
    const nomination = recorded(fx.home, plan.id);
    assert.equal(nomination?.nominated_revision, c1.revision, `the recorded nomination keeps the first revision (${show(nomination)})`);
    assert.ok(JSON.stringify(nomination).includes(c3.id), `the recorded nomination records the newest candidate ${c3.id} (${show(nomination)})`);
  });
});

// Phase 1's authoring with a phase-only check beside the reference ones.
function withPhaseOnly() {
  const files = { ...authoringFiles(1) };
  const r1 = JSON.parse(files['.surety/checks/defs/accept-r1.json']);
  files['.surety/checks/defs/phase-r1.json'] = `${JSON.stringify({ ...r1, key: 'phase-r1', gate_kinds: ['phase'] }, null, 2)}\n`;
  return files;
}
const phaseOnlyOn = (home, candidate) => executionsOf(home, candidate).filter((x) => x.key === 'phase-r1');

describe('M634 (d) the first nomination once; M406\'s effects once on the followed candidate', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    J = await verifiedWithFindings(shared.context, [F1], { files: withPhaseOnly() });
    J.c2 = await fixedAndSuperseded(J, J.raised[0]);
    const { fx, p, ctx, plan } = J;
    await pumpSome(fx, ctx, () => settledOn(fx.home, J.c2.id) || Boolean(planRow(fx.home, p.id, plan.id).completed_at), {
      what: 'the superseding candidate\'s checks recorded',
      max: 120,
      answerKinds: NOT_PLAN,
    });
    await tick(fx.engine, p.id, { rounds: 3 });
  });
  after(shared.cleanup);

  test('(d) the phase\'s nomination exactly once: no second nomination of its revision, no nomination_due left, the phase-only check registered once on the nominated candidate and at most once on the superseder', () => {
    const { fx, p, plan, c1, c2 } = J;
    const candidates = candidatesOf(fx.home, p.id);
    assert.deepEqual(candidates.map((c) => c.id), [c1.id, c2.id], `two candidates: the phase's nomination and the fix's (${show(candidates.map((c) => [c.id, c.nominated_by]))})`);
    assert.equal(eventsOfType(fx.home, 'candidate.nominated').filter((e) => JSON.stringify(e).includes(p.id)).length, 2, 'two nominations');
    assert.equal(candidates.filter((c) => c.revision === c1.revision).length, 1, 'the phase\'s revision nominated once');
    assert.equal(recorded(fx.home, plan.id)?.nominated_revision, c1.revision, 'the recorded nomination keeps the first revision');
    assert.equal(nominationDue(fx.home, p.id), null, 'no nomination_due left behind by the superseding candidate');
    const onC1 = phaseOnlyOn(fx.home, c1.id);
    assert.equal(onC1.length, 1, `the phase-only check registered once on the nominated candidate (${show(onC1.map((x) => [x.id, x.status, json(x.trigger)]))})`);
    const onC2 = phaseOnlyOn(fx.home, c2.id);
    assert.ok(onC2.length <= 1, `the phase-only check registered at most once on the superseder, its own (${show(onC2.map((x) => [x.id, x.status, json(x.trigger)]))})`);
  });

  test('(d) M406\'s effects once per binding on the followed candidate: completion, binding, baseline.phase_complete and one replan, unchanged across ticks and a restart', async () => {
    const { fx, p, ctx, plan, c1, c2 } = J;
    const done = await pumpSome(fx, ctx, () => planRow(fx.home, p.id, plan.id).completed_at && planRow(fx.home, p.id, plan.id), {
      what: `phase 1 to complete on the superseding candidate ${c2.id} (phase evaluations on ${c1.id}: ${show(phaseEvals(fx.home, c1.id).map(brief))})`,
      max: 150,
      answerKinds: NOT_PLAN,
    });
    assert.equal(done.completion_binding?.candidate, c2.id, `bound to the followed candidate (${show(done.completion_binding)})`);
    const own = phaseOnlyOn(fx.home, c2.id);
    assert.equal(own.length, 1, `the phase-only check registered once on the followed candidate, its own (${show(own.map((x) => [x.id, x.status]))})`);
    assert.equal(own[0].status, 'recorded', 'and recorded there');
    assert.equal(phaseOnlyOn(fx.home, c1.id).length, 1, 'still once on the nominated candidate');
    assert.equal(eventsAbout(fx.home, 'baseline.phase_complete', p.id).length, 1, 'baseline.phase_complete once');
    assert.equal(workOf(fx.home, p.id, 'replan').length, 1, 'one replan');
    await tick(fx.engine, p.id, { rounds: 3 });
    await waitForIdle(fx.home, p.id);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    const again = planRow(fx.home, p.id, plan.id);
    assert.equal(again.completed_at, done.completed_at, 'completed_at unchanged');
    assert.deepEqual(again.completion_binding, done.completion_binding, 'the binding unchanged');
    assert.equal(eventsAbout(fx.home, 'baseline.phase_complete', p.id).length, 1, 'no second completion');
    assert.equal(workOf(fx.home, p.id, 'replan').length, 1, 'no second replan');
    assert.equal(candidatesOf(fx.home, p.id).filter((c) => c.revision === c1.revision).length, 1, 'the phase\'s revision still nominated once');
  });
});
