// M450, deferred authoring and the exception (slice 37; kernel lane). M5
// plan §3.7 M450; D6-W06; D6 §6.2, A.2 (`CheckObligationReason`
// `deferred_authoring`; BlockerOption `build_first`), A.3 (`check_obligations`,
// `phase_plans.authoring_ready_by → decisions`), B.7 (`deferred_criteria`); F
// §5.1; B07, N04; carried item (v) (slice 35's ruling 9); SEAM.md §§351,
// 428
//
// The reference project published with its project paused
// (`harness/exec37/authoring.mjs`), its phase-1 authoring scripted:
//   (a) a Verifier result with `deferred_criteria`: R1.1 waiting for the
//       interface `sum` (module `lib`, stage 1), R2.2 for stage 2; the checks
//       of R1.1 (`accept-r1`, `integration-lib`) and of R2.2 (`integration`)
//       left out, `accept-r2` covering R2.1. One `check_obligations` row per
//       entry: `reason` `deferred_authoring`, its `criteria`, no `check`,
//       `prerequisite` † as the result gave it, `deferred_reason` † the
//       Verifier's text, `follow_up` † `{trigger_source:
//       "deferred_authoring", trigger_id, trigger_generation: 1}`; one
//       `check.obligation_recorded` each. The authoring applied still makes
//       the phase ready (the deferral is an obligation, not a hold).
//   (b) the prerequisite integrated once: the follow-up `check_authoring`
//       from that trigger identity, exactly one; stage 2 integrated twice (a
//       `fix` after a finding) and an engine restart: still exactly one.
//   (c) while the deferred checks do not exist: `AUTHORING_INCOMPLETE`
//       naming the criteria on the `phase` gate and on `alpha_authorize`
//       (the owner's deploy request refused, carried item (v)); once they
//       exist and pass (the follow-ups applied), the phase completes and
//       the deploy request is issued: the reason cleared on both.
//   (d) `build_first` on the parked authoring item's blocker: without
//       `review`, refused 400 `invalid_value` naming `review`, nothing
//       changed; with reason and review: recorded with all three (the
//       engine's binding `{phase_plan, generation}`), the phase's
//       `authoring_ready_by` the decision, the Builders released, the plan
//       read showing the exception †, and `AUTHORING_INCOMPLETE` kept on the
//       gate: no coverage waived.
//   (e) a follow-up addition beside an existing default-inputs check
//       (`tree-lint`): the classifier's class, not the requested tightening,
//       the fingerprint change of `tree-lint` recorded on the proposal.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { definitionText } from './harness/checks/fixtures.mjs';
import { decision } from './harness/decisions.mjs';
import { requestDeployment } from './harness/deploy/kernel.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { raiseFindings, review } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import {
  ROUTED_KINDS,
  alphaReady,
  candidatesOfProject,
  phaseCompleted,
  planOfPhase,
  pump,
  readPlan,
  stagesOfPlan,
  workOf,
} from './harness/journey/drive.mjs';
import { BUILDER_FILES, CHECK_PROGRAMS, SERVER_MJS, authoringFiles } from './harness/journey/reference.mjs';
import { tick, waitForIdle } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { authoringItems, authoringRuns, builderRuns, eventsOfProject, go, obligationRows, openOf, pausedDeveloping, planRow, proposalRows, until } from './harness/exec37/authoring.mjs';

const json = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);
const writes = (files) => Object.entries(files).map(([path, text]) => step.write(path, text));
const DEFS = (key) => `.surety/checks/defs/${key}.json`;
const all1 = authoringFiles(1);

// Phase 1's authoring with R1.1 and R2.2 deferred.
const DEFERRED = Object.freeze([
  { criterion: 'R1.1', reason: 'src/sum.mjs does not exist until stage 1 writes it.', prerequisite: { interface: 'sum' } },
  { criterion: 'R2.2', reason: 'The /sum route does not exist until stage 2 writes server.mjs.', prerequisite: { stage: 2 } },
]);
function deferringAuthoring({ add = {} } = {}) {
  const files = { ...all1, ...add };
  for (const key of ['accept-r1', 'integration-lib', 'integration']) delete files[DEFS(key)];
  for (const path of ['.surety/checks/tests/sum.test.mjs', '.surety/checks/tests/integration-lib.test.mjs', '.surety/checks/tests/integration.test.mjs']) delete files[path];
  const r2 = JSON.parse(files[DEFS('accept-r2')]);
  files[DEFS('accept-r2')] = `${JSON.stringify({ ...r2, covers: { criteria: ['R2.1'] } }, null, 2)}\n`;
  return roleThat(writes(files), { proposal: { rationale: 'Phase 1\'s checks; R1.1 and R2.2 deferred to their interfaces.', requested_change_kind: 'unclassifiable' }, deferred_criteria: DEFERRED });
}
// The follow-ups: R1.1's checks (after stage 1), R2.2's (after stage 2).
const followUpR1 = roleThat(writes({ [DEFS('accept-r1')]: all1[DEFS('accept-r1')], [DEFS('integration-lib')]: all1[DEFS('integration-lib')], '.surety/checks/tests/sum.test.mjs': CHECK_PROGRAMS['.surety/checks/tests/sum.test.mjs'], '.surety/checks/tests/integration-lib.test.mjs': CHECK_PROGRAMS['.surety/checks/tests/integration-lib.test.mjs'] }), { proposal: { rationale: 'R1.1\'s deferred checks, now that src/sum.mjs exists.', requested_change_kind: 'tightening' } });
const followUpR2 = roleThat(writes({ [DEFS('integration')]: all1[DEFS('integration')], '.surety/checks/tests/integration.test.mjs': CHECK_PROGRAMS['.surety/checks/tests/integration.test.mjs'], [DEFS('accept-r2')]: all1[DEFS('accept-r2')] }), { proposal: { rationale: 'R2.2\'s deferred checks, now that the route exists.', requested_change_kind: 'tightening' } });

const deferredObligations = (home, project) => obligationRows(home, project).filter((o) => o.reason === 'deferred_authoring');
const followUps = (home, project) => authoringItems(home, project).filter((w) => w.trigger_source === 'deferred_authoring');
const integrationsOf = (home, project, item) => eventsOfProject(home, 'work.integrated', project).filter((e) => e.subject?.work_item === item);
const reasonsOf = (res) => res.body?.evaluation?.reasons ?? res.body?.subject?.reasons ?? [];
const incompleteNames = (reasons) => reasons.filter((r) => r.code === 'AUTHORING_INCOMPLETE').flatMap((r) => (r.subjects ?? []).map(String));

describe('M450 deferred authoring and the exception', () => {
  test('(a) each deferred entry an obligation with reason, prerequisite and follow-up; (b) the follow-up eligible once, through a fix and a restart; (c) AUTHORING_INCOMPLETE on phase and alpha_authorize until the deferred checks pass', async (t) => {
    const { fx, p, ctx, plan } = await pausedDeveloping(t);
    fx.scripted.kindScript('check_authoring', [deferringAuthoring(), followUpR1, followUpR2]);
    // Stage 2's Builder holds, so the state before its integration can be read.
    fx.scripted.kindScript('stage_build', [roleThat(writes(BUILDER_FILES[1])), { steps: [step.hold('s2', { heartbeat_ms: 250 }), ...roleThat(writes(BUILDER_FILES[2])).steps] }]);
    await go(fx, p);
    await readyWithDeferrals(fx, ctx, p, plan, 'phase 1 ready with its deferrals');

    // (a)
    const obligations = deferredObligations(fx.home, p.id);
    assert.equal(obligations.length, 2, `one deferred_authoring obligation per entry (${JSON.stringify(obligationRows(fx.home, p.id))})`);
    for (const entry of DEFERRED) {
      const o = obligations.find((x) => (x.criteria ?? []).includes(entry.criterion));
      assert.ok(o, `an obligation for ${entry.criterion}`);
      assert.equal(o.check ?? null, null, 'no check yet');
      assert.equal(o.resolved_at ?? null, null, 'unresolved');
      assert.deepEqual(o.prerequisite, entry.prerequisite, 'its prerequisite as the result gave it (prerequisite †)');
      assert.equal(o.deferred_reason, entry.reason, 'the Verifier\'s reason (deferred_reason †)');
      assert.equal(o.follow_up?.trigger_source, 'deferred_authoring', `its follow-up identity (follow_up †) (${JSON.stringify(o.follow_up)})`);
      assert.ok(typeof o.follow_up?.trigger_id === 'string' && o.follow_up.trigger_id.length > 0 && o.follow_up.trigger_generation === 1, 'trigger id and generation 1');
    }
    const recorded = eventsOfProject(fx.home, 'check.obligation_recorded', p.id).filter((e) => e.payload?.reason === 'deferred_authoring');
    assert.equal(recorded.length, 2, 'check.obligation_recorded per entry');

    // (b) R1.1's prerequisite, the interface `sum` (stage 1): its follow-up once.
    await until(fx, ctx, () => fx.scripted.launches({ work_kind: 'stage_build' }).length >= 2 || undefined, { what: 'stage 2\'s Builder holding', answerKinds: ROUTED_KINDS });
    const stages = stagesOfPlan(fx.home, plan.id);
    const r1 = obligations.find((o) => o.criteria.includes('R1.1'));
    const r2 = obligations.find((o) => o.criteria.includes('R2.2'));
    const followOf = (o) => followUps(fx.home, p.id).filter((w) => w.trigger_id === o.follow_up.trigger_id);
    assert.equal(followOf(r1).length, 1, `stage 1 integrated: R1.1's follow-up check_authoring exists once (${JSON.stringify(followUps(fx.home, p.id).map((w) => [w.trigger_id, w.status]))})`);
    assert.equal(followOf(r2).length, 0, 'R2.2\'s waits for stage 2');

    // (c) while R2.2's checks do not exist: phase and alpha_authorize.
    const c1 = candidatesOfProject(fx.home, p.id).at(-1);
    const phaseRes = await fx.engine.post(`/v1/projects/${p.id}/candidates/${c1.id}/gates/phase`, { phase_plan: plan.id });
    assert.equal(phaseRes.status, 200, phaseRes.text);
    assert.ok(incompleteNames(reasonsOf(phaseRes)).some((s) => s.includes('R2.2')), `AUTHORING_INCOMPLETE naming R2.2 on the phase gate (${JSON.stringify(reasonsOf(phaseRes))})`);
    await alphaReady(fx, ctx);
    const refused = await requestDeployment(fx.engine, p.id, c1.id, 'alpha');
    assertRefused(refused, 409, 'authorization_not_issued', 'a deploy request while R2.2\'s checks are deferred');
    assert.ok(incompleteNames(reasonsOf(refused)).some((s) => s.includes('R2.2')), `AUTHORING_INCOMPLETE naming R2.2 on alpha_authorize (${JSON.stringify(reasonsOf(refused))})`);

    // (b) stage 2 integrated, then integrated again by a fix, then a restart.
    fx.scripted.release('all', 's2');
    const stage2 = stages.find((s) => s.number === 2);
    await until(fx, ctx, () => followOf(r2).length > 0 || undefined, { what: 'R2.2\'s follow-up after stage 2 integrated', answerKinds: ROUTED_KINDS });
    assert.equal(followOf(r2).length, 1, 'R2.2\'s follow-up once');
    await waitForIdle(fx.home, p.id, { timeoutMs: 60_000 }).catch(() => null);
    const c2 = candidatesOfProject(fx.home, p.id).at(-1);
    const [found] = await raiseFindings(fx, p.id, c2.id, [{ category: 'defect', severity: 'low', message: 'server.mjs: a trailing newline is missing.', criterion: 'R2.2' }], { kind: 'verification' });
    fx.scripted.kindScript('fix', roleThat(writes({ 'server.mjs': `${SERVER_MJS}\n` })));
    await review(fx, p.id, found.candidate, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    const fixItem = await until(fx, ctx, () => workOf(fx.home, p.id, 'fix').find((w) => integrationsOf(fx.home, p.id, w.id).length > 0), { what: 'the fix integrated (stage 2\'s lineage, a second integration)', answerKinds: ROUTED_KINDS });
    assert.ok(fixItem, 'a second integration of stage 2\'s code');
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.equal(followOf(r1).length, 1, 'R1.1\'s follow-up still once after the fix and the restart');
    assert.equal(followOf(r2).length, 1, 'R2.2\'s follow-up still once after the fix and the restart');
    assert.equal(followUps(fx.home, p.id).length, 2, 'no other follow-up');

    // (c) the deferred checks exist and pass: the phase completes, the reason cleared.
    const done = await phaseCompleted(fx, ctx, 1);
    assert.ok(done.completed_at, 'phase 1 completes once the deferred checks pass');
    const finalPhase = rowsOfEvaluation(fx.home, done.completion_binding.candidate, 'phase').at(-1);
    assert.ok(!incompleteNames(finalPhase?.reasons ?? []).length, `no AUTHORING_INCOMPLETE on the completing phase evaluation (${JSON.stringify(finalPhase?.reasons)})`);
    assert.ok(deferredObligations(fx.home, p.id).every((o) => o.resolved_at), 'both deferred obligations resolved');
    const issued = await requestDeployment(fx.engine, p.id, done.completion_binding.candidate, 'alpha');
    assert.ok(!incompleteNames(reasonsOf(issued)).length, `alpha_authorize no longer carries AUTHORING_INCOMPLETE (→ ${issued.status} ${issued.text})`);
    assert.ok([200, 201].includes(issued.status), `the deploy request issued (→ ${issued.status} ${issued.text})`);
    assert.ok(stage2);
  });

  test('(d) build_first: refused without the review; with reason, review and binding: recorded, the Builders released, the obligations and gate reasons kept', async (t) => {
    const { fx, p, ctx, plan } = await pausedDeveloping(t, { policy: { repair_attempts_max: 0 } });
    fx.scripted.kindScript('check_authoring', script.invalid({ status: 'not-a-result' }));
    await go(fx, p);
    const [item] = authoringItems(fx.home, p.id);
    const blocker = await until(fx, ctx, () => openOf(fx.home, p.id, 'blocker').find((d) => d.subject_id === item.id), { what: 'the authoring item parked with a blocker' });
    const options = (json(blocker.options) ?? blocker.options ?? []).map((o) => o.key);
    assert.ok(options.includes('build_first'), `the authoring blocker offers build_first (A.2) (${JSON.stringify(options)})`);
    const path = `/v1/projects/${p.id}/decisions/${blocker.id}/answer`;
    const REASON = 'The workshop is tomorrow; the checks follow once the service exists.';
    // Without the review: refused, nothing changed.
    const noReview = await fx.engine.post(path, { option: 'build_first', preview_hash: blocker.preview_hash, reason: REASON });
    assertRefused(noReview, 400, 'invalid_value', 'build_first without an independent review');
    assert.equal(noReview.body?.subject?.field, 'review', `the refusal names review (${noReview.text})`);
    assert.equal(decision(fx.home, blocker.id).status, 'open', 'the blocker still open');
    assert.equal(planRow(fx.home, plan.id).authoring_ready_at ?? null, null, 'no readiness');
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.deepEqual(builderRuns(fx.home, p.id), [], 'no Builder');
    // With reason and review.
    const REVIEW = { kind: 'human', reviewer: 'Astra', note: 'Read the plan; building first is safe for phase 1.' };
    const res = await fx.engine.post(path, { option: 'build_first', preview_hash: blocker.preview_hash, reason: REASON, review: REVIEW });
    assert.equal(res.status, 200, `build_first with reason and review (→ ${res.status} ${res.text})`);
    const answered = json(decision(fx.home, blocker.id).answer);
    assert.equal(answered?.reason, REASON, `the reason recorded (${JSON.stringify(answered)})`);
    assert.deepEqual(answered?.review, REVIEW, 'the review recorded');
    assert.deepEqual(answered?.binding, { phase_plan: plan.id, generation: plan.generation }, 'the gate-visible binding the engine computed');
    const row = planRow(fx.home, plan.id);
    assert.ok(row.authoring_ready_at, 'readiness by the exception');
    assert.equal(row.authoring_ready_by, blocker.id, 'authoring_ready_by the decision (A.3)');
    const read = await readPlan(fx, p.id);
    assert.equal(read.plan?.authoring_exception?.decision, blocker.id, `the plan read shows the exception † (${JSON.stringify(read.plan?.authoring_exception)})`);
    await until(fx, ctx, () => builderRuns(fx.home, p.id)[0], { what: 'the Builders released by the exception' });
    // No coverage waived: the gate still names what is not authored.
    const c = await until(fx, ctx, () => candidatesOfProject(fx.home, p.id)[0], { what: 'a candidate', max: 40 });
    const g = await fx.engine.post(`/v1/projects/${p.id}/candidates/${c.id}/gates/phase`, { phase_plan: plan.id });
    assert.ok(incompleteNames(reasonsOf(g)).some((s) => s.includes('R1.1')), `AUTHORING_INCOMPLETE kept on the phase gate (${JSON.stringify(reasonsOf(g))})`);
    assert.equal(planOfPhase(fx.home, p.id, 1).find((x) => x.id === plan.id).completed_at ?? null, null, 'the phase not complete');
  });

  test('(e) a follow-up addition beside a default-inputs check: the classifier\'s class and the fingerprint change recorded; no assumed tightening', async (t) => {
    const { fx, p, ctx, plan } = await pausedDeveloping(t);
    const TREE_LINT = { [DEFS('tree-lint')]: definitionText('tree-lint', { kind: 'security_lint', command: ['node', '.surety/checks/lint.mjs'], timeout_s: 60, gate_kinds: ['stage', 'alpha_authorize'] }) };
    fx.scripted.kindScript('check_authoring', [deferringAuthoring({ add: TREE_LINT }), followUpR1, followUpR2]);
    await go(fx, p);
    await readyWithDeferrals(fx, ctx, p, plan, 'phase 1 ready');
    const follow = await pump(fx, ctx, () => {
      const items = new Set(followUps(fx.home, p.id).map((w) => w.id));
      return withStore(fx.home, (db) =>
        db.prepare(`SELECT p."id" FROM "protected_proposals" p JOIN "runs" r ON r."id" = p."run" WHERE p."project" = ? ORDER BY p."seq"`).all(p.id),
      ).map((r) => proposalRows(fx.home, p.id).find((x) => x.id === r.id)).find((x) => x.classified_change_kind && items.has(runItem(fx.home, x.run)));
    }, { what: 'the first follow-up\'s proposal classified', max: 60 });
    assert.equal(follow.requested_change_kind, 'tightening');
    assert.notEqual(follow.classified_change_kind, 'tightening', `the classifier's class: tree-lint's default inputs cover the files the follow-up adds (${follow.classified_change_kind})`);
    const entry = (follow.fingerprint_changes ?? []).find((c) => c.check === 'tree-lint');
    assert.ok(entry && entry.from !== entry.to, `fingerprint_changes † names tree-lint with differing fingerprints (${JSON.stringify(follow.fingerprint_changes)})`);
  });
});

// Phase 1 ready with its deferrals accepted; on failure, what the authoring runs ended with.
async function readyWithDeferrals(fx, ctx, p, plan, what) {
  try {
    return await until(fx, ctx, () => planRow(fx.home, plan.id).authoring_ready_at, { what, answerKinds: ROUTED_KINDS, max: 30 });
  } catch (err) {
    const runs = authoringRuns(fx.home, p.id).map((r) => [r.outcome, r.reason_class, r.reason_text]);
    throw new Error(`${err.message}; the authoring runs ended ${JSON.stringify(runs)} (a result carrying deferred_criteria (B.7) must be accepted)`);
  }
}

function rowsOfEvaluation(home, candidate, kind) {
  return withStore(home, (db) => db.prepare('SELECT * FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = ? ORDER BY rowid').all(candidate, kind)).map((e) => ({ ...e, reasons: json(e.reasons) }));
}
function runItem(home, run) {
  return withStore(home, (db) => db.prepare('SELECT "work_item" FROM "runs" WHERE "id" = ?').get(run))?.work_item;
}
