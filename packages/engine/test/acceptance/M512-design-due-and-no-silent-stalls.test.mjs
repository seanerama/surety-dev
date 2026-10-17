// M512, `design_due` and no silent stalls (slice 44; kernel lane). M6 plan
// §3.6 M512; D7 §11, §2, §10.1; G5; BS6 §4.1 rule 25; SEAM.md §§485, 491,
// 514.
//
// (a) its causes: the UI stages first held `design_pending` (at
//     derivation); `alpha_complete` under `at_alpha` and under `both`; sent
//     back with `revise` (with (f)). A design rejected is M505 (f)'s case and
//     `design_stale` M515's and M514 (c)'s;
// (b) the question's content: the held stages, the stale screens with their
//     targets, the exact command;
// (c) each option: `waive` (the stages proceed, `design.waived` with the
//     owner's reason on each, the design's human tests pending);
//     `policy_off` (a policy revision, design off); `later` past the bound
//     (refused) and within it (re-raised at the owner's time); `open`: a
//     Designer session allocated and no process before the owner's first
//     turn. **What answering `open` does to the question itself is not
//     pinned (objection 126, open for Sean)**, and that case asserts no
//     invariant at its end;
// (d) a session ending with no product: M538 (f)'s case (slice 41), not
//     repeated;
// (e) its escalation at `target_seconds` (2 d): `decision.escalated`;
// (f) a new cause while one is open: one row, its subjects updated, the
//     earlier generation stale, never a second open;
// (g) the plan read: each held stage with its hold, the open question and
//     its age;
// (h) at every case's end (but `open`'s): no held stage without an open
//     design_due naming it (`assertNoSilentHold`);
// (i) a restart: one open question, not two. The engine never answers it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODES, decision } from './harness/decisions.mjs';
import { changePolicy, getPolicy, policyRevisions } from './harness/journal.mjs';
import { alphaDeployed, alphaReady, journeyContext, pump, runsOfProject } from './harness/journey/drive.mjs';
import { advanceClock, scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { sayAndSettle, scriptTurns, turnResult } from './harness/sessions.mjs';
import { step } from './harness/scripted.mjs';
import { answerWith, assertNoSilentHold, designScripts, openDesignDue, readDesign, scriptBuilders, stageRow, stageWork, toPublished } from './harness/design/drive.mjs';
import { BEFORE_BUILD, KERNEL_KINDS } from './harness/design/check41.mjs';
import { TWO_DAYS, designDues, designWithCriterion, designedPantry, engineNow, escalations, openDues, policyEffective, stageIdsOf, waivedEvents } from './harness/design/plan44.mjs';

const OWNER_NO_TIGHTENING = Object.freeze(['check_correction_unclassifiable', 'check_correction_loosening', 'plan_approval']);
const TO_ALPHA = Object.freeze({ autonomy: 'phase', alpha_deploy: 'on_phase_complete', phase_size: { min: 1, max: 5 } });
const uiLaunches = (fx, p) => [2, 3].flatMap((n) => fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n)?.id }));
const sortedIds = (ids) => [...ids].sort();

// Pantry under before_build, its API stage verified and its UI stages held.
async function heldPantry(t, name) {
  const fx = await scriptedEngine(t);
  const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name });
  designScripts(fx);
  scriptBuilders(fx, p.id);
  const ctx = journeyContext(fx, p, { lane: 'kernel' });
  ctx.answerKinds = [...KERNEL_KINDS];
  await pump(fx, ctx, () => (stageRow(fx.home, p.id, 1)?.status === 'verified' && [2, 3].every((n) => stageWork(fx.home, p.id, n)?.held === 'design_pending') ? true : undefined), { what: 'the API stage verified and the UI stages held design_pending', max: 80 });
  const due = openDesignDue(fx.home, p.id);
  assert.ok(due, 'the fixture is live: design_due open');
  return { fx, p, ctx, due, ui: stageIdsOf(fx.home, p.id, [2, 3]) };
}

describe('M512 design_due and no silent stalls', () => {
  test('(a) raised when the UI stages are first held; (b) its content; (g) the plan read; (e) escalated at 2 d; (i) a restart leaves one open; the engine never answers it', async (t) => {
    const { fx, p, due, ui } = await heldPantry(t, 'pantry-due');
    // (b) the question's text fields (SEAM.md §485).
    assert.equal(due.evidence?.stage, 'before_build', `stage before_build (${JSON.stringify(due.evidence)})`);
    assert.deepEqual(sortedIds(due.evidence?.held_stages ?? []), sortedIds(ui), 'naming both held UI stages');
    assert.ok(!(due.evidence?.held_stages ?? []).includes(stageRow(fx.home, p.id, 1).id), 'and not the API stage');
    assert.deepEqual(due.evidence?.stale_screens, [], 'no stale screen');
    assert.match(JSON.stringify(due.evidence?.command ?? ''), /surety session open designer/, `the exact command (D7 §11) (${JSON.stringify(due.evidence?.command)})`);
    assert.equal(due.target_seconds, TWO_DAYS, 'target_seconds 2 d (A.8; BS6 §11.1)');
    assert.deepEqual(DESIGN_DUE_OPTIONS(due), ['later', 'open', 'policy_off', 'waive'], 'its four options');
    // (g) GET …/plan: each held stage with its hold, the open question and its age (SEAM.md §514).
    const read = await fx.engine.get(`/v1/projects/${p.id}/plan`);
    assert.equal(read.status, 200, `GET …/plan (${read.status})`);
    for (const id of ui) {
      const s = (read.body?.plan?.stages ?? []).find((x) => x.id === id);
      assert.equal(s?.hold?.reason, 'design_pending', `stage ${s?.number}: its hold (${JSON.stringify(s?.hold)})`);
      assert.equal(s?.hold?.question, due.id, 'the open question');
      assert.ok(Number.isFinite(s?.hold?.age_seconds) && s.hold.age_seconds >= 0, `its age in seconds (${JSON.stringify(s?.hold)})`);
    }
    assert.equal(((read.body?.plan?.stages ?? []).find((x) => x.number === 1)?.hold ?? null), null, 'the API stage carries no hold');
    // (e) escalation at target_seconds.
    assert.deepEqual(escalations(fx.home, due.id), [], 'not escalated before 2 d');
    await advanceClock(fx.engine, TWO_DAYS + 60);
    await tick(fx.engine, p.id, { rounds: 2 });
    await waitForIdle(fx.home, p.id);
    assert.equal(escalations(fx.home, due.id).length >= 1, true, 'decision.escalated once 2 d passed (D1 §10)');
    // (i) a restart.
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    await waitForIdle(fx.home, p.id);
    assert.equal(openDues(fx.home, p.id).length, 1, `one open design_due after a restart, not two (${JSON.stringify(designDues(fx.home, p.id).map((d) => [d.id, d.status]))})`);
    // The engine never answers it.
    for (const d of designDues(fx.home, p.id)) assert.equal(d.answer ?? null, null, `design_due ${d.id} never answered by the engine (${JSON.stringify(d.answer)})`);
    assertNoSilentHold(fx.home, p.id, '(a)');
  });

  test('(c) waive with the owner\'s reason: the named stages proceed, design.waived with the reason on each, the design\'s human tests pending', async (t) => {
    const fx = await scriptedEngine(t);
    // A design with a criterion approved; its correction left unanswered, so the UI stages stay held.
    const d = await designedPantry(fx, { name: 'pantry-waive', model: designWithCriterion, answerKinds: OWNER_NO_TIGHTENING });
    const { p, ctx } = d;
    await pump(fx, ctx, () => ([2, 3].every((n) => stageWork(fx.home, p.id, n)?.held === 'design_pending') ? true : undefined), { what: 'the UI stages held, the design approved and not ready', max: 80 });
    const due = openDesignDue(fx.home, p.id);
    assert.ok(due, 'the fixture is live: design_due open while the approved design is not ready');
    const reason = 'The household needs the list this week; build it without the design.';
    const res = await answerWith(fx, p.id, due, 'waive', { note: reason });
    assert.equal(res.status, 200, `waive answered (${res.text})`);
    const ui = stageIdsOf(fx.home, p.id, [2, 3]);
    const waived = waivedEvents(fx.home, p.id);
    assert.deepEqual(sortedIds(waived.map((e) => e.subject?.stage)), sortedIds(ui), `design.waived once per named stage (${JSON.stringify(waived.map((e) => e.subject))})`);
    for (const e of waived) assert.match(JSON.stringify(e.payload), new RegExp(reason.slice(0, 30)), `with the owner's reason (${JSON.stringify(e.payload)})`);
    scriptBuilders(fx, p.id, { noDesign: true });
    await pump(fx, ctx, () => (uiLaunches(fx, p).length >= 2 ? true : undefined), { what: 'the waived UI stages dispatched', max: 40 });
    const design = await readDesign(fx, p.id);
    for (const target of ['web', 'android']) assert.equal((design.human_tests ?? []).find((h) => h.target === target)?.status, 'pending', `${target}'s human test stays pending (D7 §11)`);
    assertNoSilentHold(fx.home, p.id, '(c) waive');
  });

  test('(c) policy_off: design off by a policy revision, the holds released with design.waived on each', async (t) => {
    const { fx, p, ctx, due, ui } = await heldPantry(t, 'pantry-policy-off');
    const revisions = policyRevisions(fx.home, p.id).length;
    const res = await answerWith(fx, p.id, due, 'policy_off');
    assert.equal(res.status, 200, `policy_off answered (${res.text})`);
    await pump(fx, ctx, () => (policyRevisions(fx.home, p.id).length > revisions ? true : undefined), { what: 'the policy revision', max: 10 });
    assert.equal(policyEffective(fx.home, p.id)?.design, 'off', 'design: off in a new policy revision');
    assert.equal((await getPolicy(fx.engine, p.id)).effective?.design, 'off', 'and in force');
    assert.deepEqual(sortedIds(waivedEvents(fx.home, p.id).map((e) => e.subject?.stage)), sortedIds(ui), 'design.waived on each held stage (D7 §2)');
    scriptBuilders(fx, p.id, { noDesign: true });
    await pump(fx, ctx, () => (uiLaunches(fx, p).length >= 2 ? true : undefined), { what: 'the UI stages dispatched', max: 40 });
    assertNoSilentHold(fx.home, p.id, '(c) policy_off');
  });

  test('(c) later: a time past design_due_max_defer (lowered) refused, the question still open; a time within it accepted and the question re-raised at that time', async (t) => {
    const { fx, p, ctx, due } = await heldPantry(t, 'pantry-later');
    await changePolicy(fx.engine, p.id, { design_due_max_defer: 3600 });
    const now = await engineNow(fx);
    const at = (s) => new Date(Date.parse(now) + s * 1000).toISOString();
    const current = openDesignDue(fx.home, p.id);
    const past = await answerWith(fx, p.id, current, 'later', { until: at(7200) });
    assert.ok(past.status >= 400 && past.status < 500, `a time past the bound is refused (→ ${past.status} ${past.text})`);
    assert.match(past.text ?? '', /design_due_max_defer/, 'naming design_due_max_defer');
    assert.equal(decision(fx.home, current.id).status, 'open', 'the question still open');
    const until = at(1800);
    const ok = await answerWith(fx, p.id, decision(fx.home, current.id), 'later', { until });
    assert.equal(ok.status, 200, `a time within the bound is accepted (${ok.text})`);
    await advanceClock(fx.engine, 1800 + 60);
    await tick(fx.engine, p.id, { rounds: 2 });
    await waitForIdle(fx.home, p.id);
    const again = openDesignDue(fx.home, p.id);
    assert.ok(again, 'design_due open again once the owner\'s time passed');
    assert.ok(Date.parse(again.raised_at) >= Date.parse(until) - 10_000, `re-raised at the owner's time (${again.raised_at}; until ${until})`);
    assertNoSilentHold(fx.home, p.id, '(c) later');
    void ctx;
  });

  test('(c) open: a Designer session allocated, no process before the owner\'s first turn (the question\'s own state pending objection 126)', async (t) => {
    const { fx, p, due } = await heldPantry(t, 'pantry-open');
    const before = new Set(designerRuns(fx, p.id).map((r) => r.id));
    const res = await answerWith(fx, p.id, due, 'open');
    assert.equal(res.status, 200, `open answered (${res.text})`);
    const run = await pump(fx, { project: p.id, lane: 'kernel', answerKinds: [] }, () => designerRuns(fx, p.id).find((r) => !before.has(r.id)), { what: 'the Designer session allocated', max: 4 });
    assert.deepEqual([run.role, run.kind], ['designer', 'session'], 'a session run of role designer (D6 §2.1)');
    assert.equal(run.session_state, 'allocated', `allocated (${run.session_state})`);
    assert.deepEqual(fx.scripted.launches({ run: run.id }), [], 'no process before the owner\'s first turn');
    scriptTurns(fx, run.id, [{ steps: [step.result(turnResult({ reply: 'Shall we start with the list?' }))] }]);
    await sayAndSettle(fx, p.id, run.id, 'Let us design Pantry.');
    assert.equal(fx.scripted.launches({ run: run.id }).length, 1, 'the owner\'s first turn starts the first process');
  });

  test('(f) a new cause while one is open (sent back with revise): one row open, its subjects updated, the earlier generation stale, never a second', async (t) => {
    const fx = await scriptedEngine(t);
    const d = await designedPantry(fx, { name: 'pantry-revise', approve: false });
    const { p, ctx, batch } = d;
    const first = openDesignDue(fx.home, p.id);
    assert.ok(first && first.evidence?.stage === 'before_build', `the fixture is live: design_due open, before_build (${JSON.stringify(first?.evidence)})`);
    const note = 'Make the add button larger.';
    const res = await answerWith(fx, p.id, batch.design_approval, 'revise', { note });
    assert.equal(res.status, 200, `revise (${res.text})`);
    const now = await pump(fx, ctx, () => {
      const x = openDesignDue(fx.home, p.id);
      return x?.evidence?.stage === 'revise' ? x : undefined;
    }, { what: 'design_due re-raised stage revise', max: 6 });
    assert.equal(now.evidence?.note, note, 'with the owner\'s note');
    assert.deepEqual(sortedIds(now.evidence?.held_stages ?? []), sortedIds(stageIdsOf(fx.home, p.id, [2, 3])), 'still naming the held stages');
    assert.notEqual(decision(fx.home, first.id).status, 'open', 'the earlier generation is no longer open');
    const refused = await answerWith(fx, p.id, first, 'waive', { note: 'stale' });
    assert.deepEqual([refused.status, [CODES.stale, CODES.invalidated].includes(refused.body?.code)], [409, true], `an answer to the earlier generation is refused (${refused.text})`);
    assert.equal(openDues(fx.home, p.id).length, 1, 'never a second open design_due');
    assertNoSilentHold(fx.home, p.id, '(f)');
  });

  test('(a) alpha_complete under at_alpha and under both: design_due stage alpha_review', async (t) => {
    const fx = await scriptedEngine(t);
    // at_alpha: no hold, the UI stages built with no design, Alpha deployed.
    const { p: a } = await toPublished(fx, { policy: { ...TO_ALPHA, design: 'at_alpha' }, name: 'pantry-at-alpha' });
    designScripts(fx);
    scriptBuilders(fx, a.id, { noDesign: true });
    const actx = journeyContext(fx, a, { lane: 'kernel' });
    actx.answerKinds = [...KERNEL_KINDS];
    assert.equal(openDesignDue(fx.home, a.id), null, 'at_alpha: nothing asked before build');
    await alphaReady(fx, actx);
    await alphaDeployed(fx, actx, { max: 200 });
    const dueA = await pump(fx, actx, () => (openDesignDue(fx.home, a.id)?.evidence?.stage === 'alpha_review' ? openDesignDue(fx.home, a.id) : undefined), { what: 'at_alpha: design_due alpha_review', max: 20 });
    assert.match(JSON.stringify(dueA.evidence?.command ?? ''), /surety session open designer/, `the command (${JSON.stringify(dueA.evidence)})`);
    assertNoSilentHold(fx.home, a.id, '(a) at_alpha');
    // both: the design approved before build, the build, Alpha deployed.
    const d = await designedPantry(fx, { policy: { ...TO_ALPHA, design: 'both' }, name: 'pantry-both' });
    await alphaReady(fx, d.ctx, { port: 8081 });
    await alphaDeployed(fx, d.ctx, { max: 200 });
    const dueB = await pump(fx, d.ctx, () => (openDesignDue(fx.home, d.p.id)?.evidence?.stage === 'alpha_review' ? openDesignDue(fx.home, d.p.id) : undefined), { what: 'both: design_due alpha_review', max: 20 });
    assert.ok(dueB, 'raised on alpha_complete under both');
    assertNoSilentHold(fx.home, d.p.id, '(a) both');
  });
});

function DESIGN_DUE_OPTIONS(row) {
  return (row.options ?? []).map((o) => o.key).sort();
}
const designerRuns = (fx, project) => runsOfProject(fx.home, project).filter((r) => r.role === 'designer' && r.kind === 'session');
