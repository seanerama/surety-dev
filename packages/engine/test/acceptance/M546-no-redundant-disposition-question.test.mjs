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
//   (e) S1 (E172 item 7; Sean's direction of 2026-10-19 that an agent never
//       overrides the owner's standing decision; the driver's ruling under
//       his delegation): a finding the owner has dispositioned (his `accept`,
//       his `defer`, his `fix`) is left exactly as he left it by any entry a
//       later Reviewer's report makes on it. An entry the Reviewer's own
//       authority would otherwise record (a `fix` on a finding naming a
//       check, a plan-targeted `fix`, a Low `defer` with issue and target)
//       registers nothing (no fix work, no check_correction, no replan), is
//       recorded once by the event `finding.disposition_refused` † (subject
//       {project, finding, run}, payload `reason` `owner_decided`, the
//       Reviewer's `disposition`, and `target` where the entry had one), and
//       the run is still accepted. The proposals beyond its authority
//       (`accept`, a Medium `defer`) change nothing on the finding either.
//       (e) reads no question: which the owner is asked is (f)'s.
//   (f) S1, Sean's ruling of 2026-10-20 ("ask only if it differs"): a later
//       Reviewer's disposition on a finding the owner dispositioned that
//       differs from his raises one `finding_disposition` question to the
//       owner, scope `reviewer_disagrees`, offering `keep` (his stands) and
//       the Reviewer's disposition where his own route allows it (`fix` only
//       on a finding a check can verify), not his own; its manifest names his
//       standing disposition (`disposition`), the Reviewer's
//       (`proposed_disposition`) and the Reviewer's run (`proposed_by_run`).
//       His disposition stands until he answers. A further differing report
//       while it is open raises no second question. `keep` changes nothing
//       and consumes it; `fix` is recorded with authority `human` and its fix
//       work registered once, as his own route does. A matching Reviewer
//       disposition raises nothing.
// (d)'s pin is SEAM.md §552; (e)'s and (f)'s are SEAM.md §555. A `fix` on a finding that names a check, even
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

import { answer, assertPreview, consume, decision, decisionsOn, openDecision } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { check, finding, installChecks, nominated, passAll, raiseFindings, review } from './harness/gates.mjs';
import { eventsOfType, workItemsOf } from './harness/journal.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
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
    // The early replan this registers is dispatched at once, often by the engine's own requested tick before the
    // review's ticks return. With no script the scripted role holds until killed, and those ticks wait for every
    // run of the project to end, so it is scripted by kind and ends. What it reports is not this control's.
    fx.scripted.kindScript('replan', script.complete());
    await review(fx, project, c1.id, { dispositions: [{ finding: conflict.id, disposition: 'fix', target: 'plan' }] });
    // Read from what the route recorded, not the row: the scripted replan may already have ended, and a replan that
    // does not land reopens the plan-targeted disposition (M430 (iii)).
    const planned = eventsOfType(fx.home, 'finding.dispositioned').filter((e) => e.subject?.finding === conflict.id);
    assert.deepEqual(planned.map((e) => [e.payload?.disposition, e.payload?.authority]), [['fix', 'reviewer']], `the plan-targeted fix is recorded once with the Reviewer's authority, as before H1 (${show(planned)})`);
    const replans = workItemsOf(fx.home, project).filter((w) => w.kind === 'replan' && w.trigger_source === 'contract_conflict' && w.trigger_id === conflict.id);
    assert.equal(replans.length, 1, `one early replan triggered by the finding (${show(workItemsOf(fx.home, project).map((w) => [w.kind, w.trigger_source, w.trigger_id]))})`);
    assert.deepEqual(workItemsOf(fx.home, project).filter((w) => w.kind === 'fix' && (w.subject?.finding === conflict.id || w.trigger_id === conflict.id)).map((w) => w.id), [], 'no fix work for it');
    assert.equal(eventsOfType(fx.home, 'finding.fix_refused').filter((e) => e.subject?.finding === conflict.id).length, 0, 'and no refusal');
  });

  test("(e) S1: a finding the owner dispositioned stays as he left it whatever a later Reviewer reports on it: nothing registered, finding.disposition_refused recorded once per entry the Reviewer's authority would have recorded, the run accepted", async (t) => {
    const fx = await scriptedEngine(t);
    // Every run the case can cause is scripted by kind (the race M546 (d) met): the owner's fix registers fix work,
    // and on main the Reviewer's entries register fix work and an early replan, which are dispatched at once.
    for (const kind of ['fix', 'check_correction', 'replan']) fx.scripted.kindScript(kind, script.complete());
    const ctx = await nominated(fx, { autonomy: 'step' });
    const project = ctx.project.id;
    const c1 = ctx.candidate;
    const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })])).id;
    await passAll(fx.engine, project, c1.id, [k.login]);
    const named = (severity, message) => ({ category: 'defect', severity, message, check: 'login', criterion: 'R1.1' });
    const target = inDays(30);

    // The owner's fix, through the owed question: a Verifier's finding, raised before any review of the candidate
    // exists (T1 queues none, so it is owed to the owner, SEAM.md §466), naming a check that verifies it.
    const [fFix] = await raiseFindings(fx, project, c1.id, [named('medium', 'the session cookie outlives logout')], { kind: 'verification' });
    const owed = await openDecision(fx, project, 'finding_disposition', fFix.id, { max: 6 });
    assert.ok(owed.options.some((o) => o.key === 'fix'), `the fixture is live: fix is offered on the owed question (offered ${show(owed.options.map((o) => o.key))})`);
    await consume(fx, project, owed, 'fix');

    // The owner's accept (a Medium and a Low finding naming the check, and the Reviewer's own contract_conflict
    // naming none) and his defer, through a Reviewer's proposals and his approvals (M42).
    const [fAccept, fLow, fConflict, fDefer] = await raiseFindings(fx, project, c1.id, [
      named('medium', 'a session survives logout'),
      named('low', 'the logout link is misaligned'),
      { category: 'contract_conflict', severity: 'medium', message: 'the plan has the export send floats; the module map says integers' },
      named('medium', 'the login form keeps the password after a failure'),
    ]);
    await review(fx, project, c1.id, {
      dispositions: [
        { finding: fAccept.id, disposition: 'accept' },
        { finding: fLow.id, disposition: 'accept' },
        { finding: fConflict.id, disposition: 'accept' },
        { finding: fDefer.id, disposition: 'defer', linked_issue: 'ISSUE-9', defer_target: target },
      ],
    });
    for (const f of [fAccept, fLow, fConflict, fDefer]) await consume(fx, project, await openDecision(fx, project, 'finding_disposition', f.id), 'approve');

    const all = [fAccept, fLow, fConflict, fDefer, fFix];
    const ids = new Set(all.map((f) => f.id));
    const owner = (f) => {
      const row = finding(fx.home, f.id);
      return [row.status, row.disposition, row.disposition_authority, row.disposition_by, row.disposition_at, row.linked_issue, row.defer_target];
    };
    const left = Object.fromEntries(all.map((f) => [f.id, owner(f)]));
    assert.deepEqual(
      all.map((f) => left[f.id].slice(0, 3)),
      [
        ['dispositioned', 'accept', 'human'],
        ['dispositioned', 'accept', 'human'],
        ['dispositioned', 'accept', 'human'],
        ['dispositioned', 'defer', 'human'],
        ['dispositioned', 'fix', 'human'],
      ],
      `the fixture is live: the owner dispositioned all five (${show(left)})`,
    );
    assert.deepEqual([fConflict.check, fConflict.source_role, fLow.effective_severity], [null, 'reviewer', 'low'], 'the fixture is live: the Reviewer\'s own contract_conflict names no check; the Low finding is Low');
    const since = withStore(fx.home, (db) => db.prepare('SELECT MAX("seq") AS "n" FROM "events"').get().n);
    const workBefore = new Set(workItemsOf(fx.home, project).map((w) => w.id));
    const registered = () => workItemsOf(fx.home, project).filter((w) => !workBefore.has(w.id) && ['fix', 'check_correction', 'replan'].includes(w.kind)).map((w) => [w.kind, w.trigger_source, w.trigger_id]);
    const dispositioned = () => eventsOfType(fx.home, 'finding.dispositioned', since).filter((e) => ids.has(e.subject?.finding)).map((e) => [e.subject.finding, e.payload?.disposition, e.payload?.authority]);

    // A later Reviewer reports, on each, an entry its own authority would record on a finding no one dispositioned.
    const entries = [
      { finding: fAccept.id, disposition: 'fix' },
      { finding: fLow.id, disposition: 'defer', linked_issue: 'ISSUE-7', defer_target: target },
      { finding: fConflict.id, disposition: 'fix', target: 'plan' },
      { finding: fDefer.id, disposition: 'fix' },
      { finding: fFix.id, disposition: 'fix' },
    ];
    const { run } = await review(fx, project, c1.id, { dispositions: entries });
    await tick(fx.engine, project);

    assert.deepEqual(
      Object.fromEntries(all.map((f) => [f.id, owner(f)])),
      left,
      "a Reviewer's later disposition leaves every finding the owner dispositioned exactly as he left it: status, disposition, authority human, who and when, issue and target (S1)",
    );
    assert.deepEqual(dispositioned(), [], 'no disposition is recorded on them');
    assert.deepEqual(registered(), [], 'nothing is registered: no fix work, no check_correction work, no replan');
    const ran = withStore(fx.home, (db) => db.prepare('SELECT "outcome", "reason_class" FROM "runs" WHERE "id" = ?').get(run.id));
    assert.deepEqual([ran.outcome, ran.reason_class], ['completed', 'none'], "the Reviewer's run is still accepted");
    for (const e of entries) {
      const refused = eventsOfType(fx.home, 'finding.disposition_refused', since).filter((x) => x.subject?.finding === e.finding);
      assert.equal(refused.length, 1, `the attempt on ${e.finding} recorded once: finding.disposition_refused † (${show(refused)})`);
      assert.deepEqual(
        [refused[0].subject?.project, refused[0].subject?.finding, refused[0].subject?.run, refused[0].payload?.reason, refused[0].payload?.disposition, refused[0].payload?.target ?? null],
        [project, e.finding, run.id, 'owner_decided', e.disposition, e.target ?? null],
        `naming the project, the finding and the Reviewer's run, reason owner_decided, the Reviewer's disposition (${show(refused[0])})`,
      );
    }
    assert.deepEqual(eventsOfType(fx.home, 'finding.fix_refused', since).filter((e) => ids.has(e.subject?.finding)).map((e) => e.subject.finding), [], 'refused as the owner\'s decision, not for missing verification');

    // The proposals beyond a Reviewer's authority, matching or differing: the findings stay as he left them, and
    // nothing is registered. (Which of these asks him again, and how, is (f)'s: Sean's ruling of 2026-10-20.)
    await review(fx, project, c1.id, {
      dispositions: [
        { finding: fAccept.id, disposition: 'accept' },
        { finding: fConflict.id, disposition: 'defer', linked_issue: 'ISSUE-8', defer_target: target },
        { finding: fDefer.id, disposition: 'defer', linked_issue: 'ISSUE-9', defer_target: target },
        { finding: fFix.id, disposition: 'accept' },
      ],
    });
    await tick(fx.engine, project);
    assert.deepEqual(Object.fromEntries(all.map((f) => [f.id, owner(f)])), left, "a Reviewer's later proposals leave them as the owner left them too");
    assert.deepEqual(dispositioned(), [], 'still no disposition recorded on them');
    assert.deepEqual(registered(), [], 'still nothing registered');
  });

  test("(f) S1, ask only if it differs (Sean, 2026-10-20): a Reviewer's differing disposition on the owner's asks him once, keep or change; keep changes nothing, fix is his; a matching one asks nothing", async (t) => {
    const fx = await scriptedEngine(t);
    // The owner's fix registers fix work, dispatched at once: scripted by kind so its run ends (the race M546 (d) met).
    for (const kind of ['fix', 'check_correction', 'replan']) fx.scripted.kindScript(kind, script.complete());
    const ctx = await nominated(fx, { autonomy: 'step' });
    const project = ctx.project.id;
    const c1 = ctx.candidate;
    const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })])).id;
    await passAll(fx.engine, project, c1.id, [k.login]);
    const named = (message) => ({ category: 'defect', severity: 'medium', message, check: 'login', criterion: 'R1.1' });

    // The owner accepts two Medium findings naming login/R1.1, through a Reviewer's proposals and his approvals (M42).
    const [fKeep, fFix] = await raiseFindings(fx, project, c1.id, [named('a session survives logout'), named('the login form keeps the password after a failure')]);
    await review(fx, project, c1.id, { dispositions: [fKeep, fFix].map((f) => ({ finding: f.id, disposition: 'accept' })) });
    const approved = [];
    for (const f of [fKeep, fFix]) approved.push(await consume(fx, project, await openDecision(fx, project, 'finding_disposition', f.id), 'approve'));
    const owner = (f) => {
      const row = finding(fx.home, f.id);
      return [row.status, row.disposition, row.disposition_authority, row.disposition_by, row.disposition_at, row.linked_issue, row.defer_target];
    };
    const left = owner(fKeep);
    assert.deepEqual(
      [owner(fKeep).slice(0, 3), owner(fFix).slice(0, 3), approved.map((d) => d.manifest.verification?.state)],
      [['dispositioned', 'accept', 'human'], ['dispositioned', 'accept', 'human'], ['verifiable', 'verifiable']],
      `the fixture is live: the owner accepted both, and a check can verify each (${show([owner(fKeep), owner(fFix), approved.map((d) => d.manifest.verification)])})`,
    );
    const earlier = new Set([fKeep, fFix].flatMap((f) => questionsOn(fx, f.id).map((d) => d.id)));
    const asked = (f) => questionsOn(fx, f.id).filter((d) => !earlier.has(d.id)).map((d) => [d.id, d.status, d.scope]);
    const since = withStore(fx.home, (db) => db.prepare('SELECT MAX("seq") AS "n" FROM "events"').get().n);
    const workBefore = new Set(workItemsOf(fx.home, project).map((w) => w.id));
    const registered = () => workItemsOf(fx.home, project).filter((w) => !workBefore.has(w.id) && ['fix', 'check_correction', 'replan'].includes(w.kind)).map((w) => [w.kind, w.trigger_source, w.trigger_id]);
    const dispositioned = () => eventsOfType(fx.home, 'finding.dispositioned', since).filter((e) => [fKeep.id, fFix.id].includes(e.subject?.finding)).map((e) => [e.subject.finding, e.payload?.disposition, e.payload?.authority]);

    // A Reviewer reports fix on each: refused as (e), and the owner is asked whether to keep his accept.
    const { run } = await review(fx, project, c1.id, { dispositions: [fKeep, fFix].map((f) => ({ finding: f.id, disposition: 'fix' })) });
    await tick(fx.engine, project);
    assert.deepEqual([owner(fKeep), owner(fFix).slice(0, 3), registered()], [left, ['dispositioned', 'accept', 'human'], []], "the Reviewer's fix is refused as (e): his accept stands, nothing registered");
    const raised = asked(fKeep);
    assert.deepEqual(
      raised.map(([, status, scope]) => [status, scope]),
      [['open', 'reviewer_disagrees']],
      `one finding_disposition question raised to the owner, scope reviewer_disagrees: the Reviewer proposes fix, keep his accept or change (${show(questionsOn(fx, fKeep.id).map((d) => [d.id, d.status, d.scope]))})`,
    );
    const q = assertPreview(decision(fx.home, raised[0][0]));
    const keys = q.options.map((o) => o.key);
    assert.deepEqual([keys.includes('keep'), keys.includes('fix'), keys.includes('accept')], [true, true, false], `offering keep and fix (a check can verify it), not his own accept (offered ${show(keys)})`);
    assert.deepEqual(
      [q.manifest.disposition, q.manifest.proposed_disposition, q.manifest.proposed_by_run],
      ['accept', 'fix', run.id],
      `its manifest names his standing accept, the Reviewer's fix and the Reviewer's run (${show(q.manifest)})`,
    );

    // A second Reviewer's fix while it is open: no second question.
    await review(fx, project, c1.id, { dispositions: [{ finding: fKeep.id, disposition: 'fix' }] });
    await tick(fx.engine, project);
    assert.deepEqual(asked(fKeep), [[q.id, 'open', 'reviewer_disagrees']], `a further differing report while it is open raises no second question (${show(asked(fKeep))})`);

    // keep: nothing changes, the question consumed, and nothing asked again.
    await consume(fx, project, decision(fx.home, q.id), 'keep');
    await tick(fx.engine, project);
    assert.deepEqual(
      [[...owner(fKeep), finding(fx.home, fKeep.id).proposed_disposition], registered(), dispositioned(), asked(fKeep)],
      [[...left, null], [], [], [[q.id, 'consumed', 'reviewer_disagrees']]],
      'keep: the finding as he left it, no proposal held, nothing registered or recorded, the question consumed and none raised again',
    );

    // A matching Reviewer disposition (his accept) asks nothing.
    await review(fx, project, c1.id, { dispositions: [{ finding: fKeep.id, disposition: 'accept' }] });
    await tick(fx.engine, project);
    assert.deepEqual(asked(fKeep), [[q.id, 'consumed', 'reviewer_disagrees']], `a matching disposition raises no question (${show(asked(fKeep))})`);

    // fix on the other: recorded with his authority, its fix work registered once.
    const [[qFix, status]] = asked(fFix);
    assert.equal(status, 'open', `the fixture is live: the owner is asked about the other finding too (${show(asked(fFix))})`);
    await consume(fx, project, decision(fx.home, qFix), 'fix');
    await tick(fx.engine, project);
    const row = finding(fx.home, fFix.id);
    assert.deepEqual(
      [row.disposition, row.disposition_authority, dispositioned(), registered().filter(([kind]) => kind === 'fix')],
      ['fix', 'human', [[fFix.id, 'fix', 'human']], [['fix', 'finding', fFix.id]]],
      `his fix is recorded with authority human and its fix work registered once (${show(row)})`,
    );
  });
});
