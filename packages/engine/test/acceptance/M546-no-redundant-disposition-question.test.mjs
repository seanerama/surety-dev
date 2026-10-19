// M546, no redundant disposition question (M6 slice 39, the corrections
// carried from M5; kernel lane, the scripted backend). M6 plan §3.1 M546;
// INK2-2; E154 item 6 (7); E156 Q1; BS6 §11.3; D3 §2.11; F §6.2; M42 (the
// owner's accept); SEAM.md §474.
//   (a) a Reviewer proposing `accept` on a finding the owner already
//       dispositioned `accept`: no `finding_disposition` question raised; the
//       proposal recorded against the owner's standing answer;
//   (b) a Reviewer proposing another disposition on that finding: as built
//       (unchanged), the owner is asked;
//   (c) a Reviewer proposing on a finding with no disposition: as built
//       (unchanged), the owner is asked;
//   (d) H1 (E171 item 5; E166 item 4; Sean's ruling, option B): a Reviewer's
//       own `fix` on a finding that names no check is refused. Nothing is
//       dispatched (no fix work, no check_correction work), the refusal is
//       recorded once by the event `finding.fix_refused` † (subject
//       {project, finding, run}, payload `reason` `verification_missing` and
//       `verification`, the finding's verification as the owed question's
//       manifest states it), the Reviewer's run is still accepted, and the
//       owner's owed question (scope `disposition_owed`) stays open with the
//       same id and no `fix` option. Its control: a Reviewer's plan-targeted
//       `fix` on its own `contract_conflict` naming no check is recorded and
//       makes its early replan, as before (D6 §5.7).
// (d)'s pin is SEAM.md §552. A `fix` on a finding that names a check, even
// one that does not cover its criterion, is unchanged (D3 §2.11's
// check_correction route, M235); so is the `unknown` state with a named check.
// The pin (SEAM.md §474): the proposal is recorded by the event
// `finding.proposal_standing` †, once, its subject naming the project, the
// finding and the Reviewer's run, its payload `disposition` (`accept`) and
// `decision`, the owner's consumed `finding_disposition` decision it stands
// on; the finding is left as the owner left it (status, disposition,
// authority and who dispositioned it unchanged, no proposal held on it).
// (b) and (c) are as built, kept so that the correction narrows nothing
// else.
//
// SAFETY (BS6 §4.1; E64): kernel lane; no domain, no unit; the test signals
// nothing.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, consume, decision, decisionsOn, openDecision } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { check, finding, installChecks, nominated, passAll, raiseFindings, review } from './harness/gates.mjs';
import { eventsOfType, workItemsOf } from './harness/journal.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

const DAY = 86_400;
const inDays = (n) => new Date(Date.now() + n * DAY * 1000).toISOString();
const show = (v) => JSON.stringify(v);
const defect = (severity, message) => ({ category: 'defect', severity, message });

const questionsOn = (fx, f) => decisionsOn(fx.home, 'finding_disposition', f);
const lastReviewRun = (fx, project) =>
  withStore(fx.home, (db) => db.prepare(`SELECT r.* FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."project" = ? AND w."kind" = 'review' ORDER BY r."seq" DESC LIMIT 1`).get(project));

// A T1 candidate with one required check passed and one Medium finding on it,
// naming no check and no criterion. `kind` is the work whose run raises it: a
// Reviewer's (the default), or a Verifier's ((d): T1 queues no review, so the
// finding is owed to the owner, SEAM.md §466; a fixture's review made beside
// it would be a review to come).
async function withFinding(t, { kind = 'review' } = {}) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx, { autonomy: 'step' });
  const project = ctx.project.id;
  const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })])).id;
  await passAll(fx.engine, project, ctx.candidate.id, [k.login]);
  const [found] = await raiseFindings(fx, project, ctx.candidate.id, [defect('medium', 'the export omits the header row')], { kind });
  return { fx, ctx, project, c1: ctx.candidate, found };
}

// The owner's accept, through the Reviewer's proposal and the owner's answer (M42).
async function ownerAccepts(fx, project, c1, found) {
  await review(fx, project, c1.id, { dispositions: [{ finding: found.id, disposition: 'accept' }] });
  const asked = await openDecision(fx, project, 'finding_disposition', found.id);
  await consume(fx, project, asked, 'approve');
  const accepted = finding(fx.home, found.id);
  assert.deepEqual([accepted.status, accepted.disposition, accepted.disposition_authority], ['dispositioned', 'accept', 'human'], `the fixture is live: the owner accepted the finding (${show(accepted)})`);
  const answered = questionsOn(fx, found.id);
  assert.deepEqual(answered.map((d) => d.status), ['consumed'], `the fixture is live: one question, answered (${show(answered.map((d) => [d.id, d.status]))})`);
  return { accepted, decision: answered[0] };
}

describe('M546 no redundant disposition question', () => {
  test('(a) a Reviewer proposing accept on a finding the owner already accepted: no finding_disposition question; the proposal recorded against the owner\'s standing answer', async (t) => {
    const { fx, project, c1, found } = await withFinding(t);
    const { accepted, decision } = await ownerAccepts(fx, project, c1, found);
    await review(fx, project, c1.id, { dispositions: [{ finding: found.id, disposition: 'accept' }] });
    const run = lastReviewRun(fx, project);
    await tick(fx.engine, project);
    const questions = questionsOn(fx, found.id);
    assert.deepEqual(
      questions.map((d) => [d.id, d.status]),
      [[decision.id, 'consumed']],
      `no finding_disposition question raised after the owner's accept: only the one he answered (${show(questions.map((d) => [d.id, d.status, d.scope]))})`,
    );
    const after = finding(fx.home, found.id);
    assert.deepEqual(
      [after.status, after.disposition, after.disposition_authority, after.disposition_by, after.proposed_disposition],
      [accepted.status, accepted.disposition, accepted.disposition_authority, accepted.disposition_by, null],
      `the finding as the owner left it, no proposal held on it (${show(after)})`,
    );
    const recorded = eventsOfType(fx.home, 'finding.proposal_standing').filter((e) => e.subject?.finding === found.id);
    assert.equal(recorded.length, 1, `the proposal recorded once: finding.proposal_standing † (${show(recorded)})`);
    assert.deepEqual(
      [recorded[0].subject?.project, recorded[0].subject?.run, recorded[0].payload?.disposition, recorded[0].payload?.decision],
      [project, run.id, 'accept', decision.id],
      `naming the Reviewer's run and the owner's standing answer (${show(recorded[0])})`,
    );
  });

  test('(b) a Reviewer proposing another disposition on that finding: the owner is asked, as built', async (t) => {
    const { fx, project, c1, found } = await withFinding(t);
    const { decision } = await ownerAccepts(fx, project, c1, found);
    await review(fx, project, c1.id, { dispositions: [{ finding: found.id, disposition: 'defer', linked_issue: 'ISSUE-7', defer_target: inDays(30) }] });
    const open = questionsOn(fx, found.id).filter((d) => d.status === 'open');
    assert.equal(open.length, 1, `one finding_disposition question raised for the other disposition (${show(questionsOn(fx, found.id).map((d) => [d.id, d.status]))})`);
    assert.notEqual(open[0].id, decision.id, 'a new question, not the answered one');
    assert.equal(eventsOfType(fx.home, 'finding.proposal_standing').filter((e) => e.subject?.finding === found.id).length, 0, 'not recorded as standing on the owner\'s answer');
  });

  test('(c) a Reviewer proposing accept on a finding with no disposition: the owner is asked, as built', async (t) => {
    const { fx, project, c1, found } = await withFinding(t);
    await review(fx, project, c1.id, { dispositions: [{ finding: found.id, disposition: 'accept' }] });
    const open = questionsOn(fx, found.id).filter((d) => d.status === 'open');
    assert.equal(open.length, 1, `one finding_disposition question raised (${show(questionsOn(fx, found.id).map((d) => [d.id, d.status]))})`);
    assert.equal(finding(fx.home, found.id).status, 'open', 'the finding as it was until the owner decides');
  });

  test("(d) H1: a Reviewer's own fix on a finding that names no check is refused: nothing dispatched, finding.fix_refused recorded once, the run accepted, the owner's owed question kept open with no fix", async (t) => {
    const { fx, project, c1, found } = await withFinding(t, { kind: 'verification' });
    assert.deepEqual([found.check, found.criterion ?? null], [null, null], `the fixture is live: the finding names no check and no criterion (${show(found)})`);

    // T1 queues no review, so the finding is owed to the owner (SEAM.md §466); fix is not offered (F4, E166 item 3).
    const owed = await openDecision(fx, project, 'finding_disposition', found.id, { max: 6 });
    assert.equal(owed.scope, 'disposition_owed', 'the fixture is live: the owner is asked the owed question');
    assert.ok(!owed.options.some((o) => o.key === 'fix'), `the fixture is live: fix is not offered (offered ${show(owed.options.map((o) => o.key))})`);
    assert.equal(owed.manifest.verification?.state, 'missing', `the fixture is live: its verification is missing (${show(owed.manifest.verification)})`);

    // The Reviewer dispositions it fix.
    const { run } = await review(fx, project, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    await tick(fx.engine, project);
    const after = finding(fx.home, found.id);
    assert.deepEqual(
      [after.status, after.disposition, after.disposition_authority, after.disposition_by, after.proposed_disposition],
      ['open', null, null, null, null],
      `the Reviewer's fix on a finding naming no check is refused: the finding is as it was (${show(after)})`,
    );
    assert.equal(eventsOfType(fx.home, 'finding.dispositioned').filter((e) => e.subject?.finding === found.id).length, 0, 'no disposition is recorded');
    const dispatched = workItemsOf(fx.home, project).filter((w) => ['fix', 'check_correction'].includes(w.kind) && (w.subject?.finding === found.id || w.trigger_id === found.id));
    assert.deepEqual(dispatched.map((w) => [w.kind, w.id]), [], 'nothing is dispatched: no fix work and no check_correction work for the finding');

    const refused = eventsOfType(fx.home, 'finding.fix_refused').filter((e) => e.subject?.finding === found.id);
    assert.equal(refused.length, 1, `the refusal recorded once: finding.fix_refused † (${show(refused)})`);
    assert.deepEqual(
      [refused[0].subject?.project, refused[0].subject?.finding, refused[0].subject?.run, refused[0].payload?.reason],
      [project, found.id, run.id, 'verification_missing'],
      `naming the project, the finding and the Reviewer's run, reason verification_missing (${show(refused[0])})`,
    );
    assert.deepEqual(refused[0].payload?.verification, owed.manifest.verification, 'its verification as the owed question states it: missing, no criterion, no check');

    const ran = withStore(fx.home, (db) => db.prepare('SELECT "outcome", "reason_class" FROM "runs" WHERE "id" = ?').get(run.id));
    assert.deepEqual([ran.outcome, ran.reason_class], ['completed', 'none'], "the Reviewer's run is still accepted");

    const questions = questionsOn(fx, found.id);
    assert.deepEqual(questions.map((d) => [d.id, d.status, d.scope]), [[owed.id, 'open', 'disposition_owed']], `the owner's owed question stays open, the same id, and nothing else is asked (${show(questions.map((d) => [d.id, d.status, d.scope]))})`);
    const current = decision(fx.home, owed.id);
    assert.ok(!current.options.some((o) => o.key === 'fix'), `still with no fix option (offered ${show(current.options.map((o) => o.key))})`);

    // The owner's fix is refused as before (queue.ts); his accept is taken.
    const res = await answer(fx.engine, project, current, 'fix');
    assertRefused(res, 400, 'invalid_value', "the owner's fix, not offered");
    assert.equal(decision(fx.home, owed.id).status, 'open', 'the refused answer consumed nothing');
    await consume(fx, project, current, 'accept');
    const accepted = finding(fx.home, found.id);
    assert.deepEqual([accepted.status, accepted.disposition, accepted.disposition_authority], ['dispositioned', 'accept', 'human'], `the owner's accept is recorded (${show(accepted)})`);

    // Control, the neighbouring route kept (Sean's refinement): a Reviewer's plan-targeted fix on its own
    // contract_conflict, which names no check, goes where it went before H1 (D6 §5.7; findings.ts's plan-target
    // branch): recorded with the Reviewer's authority, an early replan triggered by the finding, no fix work, no
    // refusal. The other neighbour, a fix on a finding naming a check that does not cover its criterion still
    // routing check_correction (D3 §2.11), is M235 (c)'s and (a) S2's contrast, unchanged.
    const [conflict] = await raiseFindings(fx, project, c1.id, [{ category: 'contract_conflict', severity: 'medium', message: 'the plan has the export send floats; the module map says integers' }]);
    assert.deepEqual([conflict.check, conflict.source_role], [null, 'reviewer'], `the fixture is live: the Reviewer's own contract_conflict, naming no check (${show(conflict)})`);
    await review(fx, project, c1.id, { dispositions: [{ finding: conflict.id, disposition: 'fix', target: 'plan' }] });
    const planned = finding(fx.home, conflict.id);
    assert.deepEqual([planned.status, planned.disposition, planned.disposition_authority], ['dispositioned', 'fix', 'reviewer'], `the plan-targeted fix is recorded, as before H1 (${show(planned)})`);
    const replans = workItemsOf(fx.home, project).filter((w) => w.kind === 'replan' && w.trigger_source === 'contract_conflict' && w.trigger_id === conflict.id);
    assert.equal(replans.length, 1, `one early replan triggered by the finding (${show(workItemsOf(fx.home, project).map((w) => [w.kind, w.trigger_source, w.trigger_id]))})`);
    assert.deepEqual(workItemsOf(fx.home, project).filter((w) => w.kind === 'fix' && (w.subject?.finding === conflict.id || w.trigger_id === conflict.id)).map((w) => w.id), [], 'no fix work for it');
    assert.equal(eventsOfType(fx.home, 'finding.fix_refused').filter((e) => e.subject?.finding === conflict.id).length, 0, 'and no refusal');
  });
});
