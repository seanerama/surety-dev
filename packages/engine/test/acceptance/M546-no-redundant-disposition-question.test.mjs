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
//       (unchanged), the owner is asked.
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

import { consume, decisionsOn, openDecision } from './harness/decisions.mjs';
import { check, finding, installChecks, nominated, passAll, raiseFindings, review } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

const DAY = 86_400;
const inDays = (n) => new Date(Date.now() + n * DAY * 1000).toISOString();
const show = (v) => JSON.stringify(v);
const defect = (severity, message) => ({ category: 'defect', severity, message });

const questionsOn = (fx, f) => decisionsOn(fx.home, 'finding_disposition', f);
const lastReviewRun = (fx, project) =>
  withStore(fx.home, (db) => db.prepare(`SELECT r.* FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."project" = ? AND w."kind" = 'review' ORDER BY r."seq" DESC LIMIT 1`).get(project));

// A T1 candidate with one required check passed and one Medium finding on it.
async function withFinding(t) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx, { autonomy: 'step' });
  const project = ctx.project.id;
  const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })])).id;
  await passAll(fx.engine, project, ctx.candidate.id, [k.login]);
  const [found] = await raiseFindings(fx, project, ctx.candidate.id, [defect('medium', 'the export omits the header row')]);
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
});
