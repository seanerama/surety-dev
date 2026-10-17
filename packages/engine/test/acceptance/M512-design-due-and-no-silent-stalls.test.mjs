// M512, `design_due` and no silent stalls (slice 44; kernel lane). M6 plan
// §3.6 M512 as amended by E162 item 1; D7 §11 as corrected, §2, §10.1; G5;
// BS6 §4.1 rule 25 as amended; SEAM.md §§485, 491, 514, 547.
//
// (a) its causes: the UI stages first held `design_pending` (at
//     derivation); `alpha_complete` under `at_alpha` and under `both`; sent
//     back with `revise` (with (f)). A design rejected is M505 (f)'s case and
//     `design_stale` M515's and M514 (c)'s;
// (b) the question's content: the held stages, the stale screens with their
//     targets, the exact command;
// (c) each option: `open` and `later` consume the question without
//     releasing the held stages or approving a design (E162 item 1);
//     `waive` (the stages proceed, `design.waived` with the owner's reason
//     on each, the design's human tests pending); `policy_off` (a policy
//     revision, design off); `later` past the bound (refused) and within it
//     (the deferral on the reads, re-raised at the owner's time); `open`: a
//     Designer session allocated, no process before the owner's first turn;
//     an `open` the engine cannot carry out (another role's session open):
//     an actionable question, the refusal named, and `open` answered again
//     once the other session is closed;
// (d) a Designer session ending without resolving the hold (its idle
//     timeout): design_due re-raised, said on the next read (M538 (f) the
//     budget and `--refuse`);
// (e) its escalation at `target_seconds` (2 d): `decision.escalated`;
// (f) a new cause while one is open: one row, its subjects updated, the
//     earlier generation stale, never a second open;
// (g) the plan read: each held stage with its hold, the open question and
//     its age;
// (h) at every case's end: every design-held stage accounted for by an
//     open owner question, an owner-opened active Designer session, pending
//     engine work or an unexpired owner deferral, the reads naming the cause
//     and the next action (`assertHoldsAccounted`, SEAM.md §547);
// (i) a restart: one open question, not two; a restart during a deferral:
//     the deferral survives it and re-raises when due;
// (j) a new cause during a deferral (the design sent back): the deferral
//     ends early and the question is re-raised;
// (k) an intentional wait as the journey reads it: during a deferral and
//     during an open Designer session, the plan read shows each stage held
//     and waiting, nothing ready, and the real-lane runner's judgement
//     (harness/real/m6-lane.mjs) reports waiting, its step recorded
//     `waiting`, never `done`, never passed (E162 item 1; rule 25).
// The engine never answers it.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { CODES, decision } from './harness/decisions.mjs';
import { waitFor } from './harness/engine.mjs';
import { changePolicy, getPolicy, policyRevisions } from './harness/journal.mjs';
import { alphaDeployed, alphaReady, journeyContext, pump, runsOfProject } from './harness/journey/drive.mjs';
import { advanceClock, engineTimeMs, scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { openSession, runRow, sayAndSettle, scriptTurns, turnResult } from './harness/sessions.mjs';
import { postCloseRaw } from './harness/session-lane.mjs';
import { step } from './harness/scripted.mjs';
import { answerWith, assertHoldsAccounted, assertReRaised, designRevisions, designScripts, openDesignDue, readDesign, scriptBuilders, stageRow, stageWork, toPublished } from './harness/design/drive.mjs';
import { designHoldAccounts } from './harness/design/holds.mjs';
import { BEFORE_BUILD, KERNEL_KINDS } from './harness/design/check41.mjs';
import { TWO_DAYS, designDues, designWithCriterion, designedPantry, engineNow, escalations, openDues, policyEffective, stageIdsOf, waivedEvents } from './harness/design/plan44.mjs';
import { realStep } from './harness/real/lane.mjs';
import { activity, quietState, ruleTwentyFive, stepVerdicts } from './harness/real/m6-lane.mjs';

const OWNER_NO_TIGHTENING = Object.freeze(['check_correction_unclassifiable', 'check_correction_loosening', 'plan_approval']);
const TO_ALPHA = Object.freeze({ autonomy: 'phase', alpha_deploy: 'on_phase_complete', phase_size: { min: 1, max: 5 } });
const uiLaunches = (fx, p) => [2, 3].flatMap((n) => fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n)?.id }));
const sortedIds = (ids) => [...ids].sort();
const NO_ANSWER = Object.freeze({ lane: 'kernel', answerKinds: [] });
const talk = (reply) => ({ steps: [step.result(turnResult({ reply }))] });
const at = (now, seconds) => new Date(Date.parse(now) + seconds * 1000).toISOString();
const stageWorkById = (fx, p, stageId) => [2, 3].map((n) => ({ s: stageRow(fx.home, p.id, n), w: stageWork(fx.home, p.id, n) })).find((x) => x.s?.id === stageId)?.w ?? null;
// What accounts for each held stage now, by the engine's clock (harness/design/holds.mjs).
const accountsNow = (fx, p) => designHoldAccounts(fx.home, p.id, { nowMs: engineTimeMs(fx.engine) });

// E162 item 1: an answer of `open` or `later` consumes the question, and
// releases no held stage and approves no design.
function assertConsumedNotReleased(fx, p, row, option, ui) {
  const d = decision(fx.home, row.id);
  assert.deepEqual([d.status, d.answer?.option], ['consumed', option], `${option}: the question consumed by the owner's answer (${JSON.stringify([d.status, d.answer])})`);
  for (const id of ui) {
    const w = stageWorkById(fx, p, id);
    assert.ok(['design_pending', 'design_stale'].includes(w?.held), `${option}: stage ${id} still held for its design (${JSON.stringify(w && { status: w.status, held: w.held })})`);
  }
  assert.deepEqual(designRevisions(fx.home, p.id).filter((r) => ['approved', 'approved_without_criteria'].includes(r.status)).map((r) => r.id), [], `${option}: no design approved`);
  assert.deepEqual(waivedEvents(fx.home, p.id), [], `${option}: nothing waived`);
}

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
    await assertHoldsAccounted(fx, p.id, '(a)');
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
    await assertHoldsAccounted(fx, p.id, '(c) waive');
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
    await assertHoldsAccounted(fx, p.id, '(c) policy_off');
  });

  test('(c) later: a time past design_due_max_defer (lowered) refused, the question still open; a time within it accepted: the question consumed, nothing released, the deferral on the reads; re-raised at that time', async (t) => {
    const { fx, p, due, ui } = await heldPantry(t, 'pantry-later');
    await changePolicy(fx.engine, p.id, { design_due_max_defer: 3600 });
    const now = await engineNow(fx);
    const current = openDesignDue(fx.home, p.id);
    const past = await answerWith(fx, p.id, current, 'later', { until: at(now, 7200) });
    assert.ok(past.status >= 400 && past.status < 500, `a time past the bound is refused (→ ${past.status} ${past.text})`);
    assert.match(past.text ?? '', /design_due_max_defer/, 'naming design_due_max_defer');
    assert.equal(decision(fx.home, current.id).status, 'open', 'the question still open');
    const until = at(now, 1800);
    const ok = await answerWith(fx, p.id, decision(fx.home, current.id), 'later', { until });
    assert.equal(ok.status, 200, `a time within the bound is accepted (${ok.text})`);
    // E162 item 1: consumed, nothing released or approved; the deferral accounts for the holds, on the reads.
    await tick(fx.engine, p.id, { rounds: 2 });
    await waitForIdle(fx.home, p.id);
    assertConsumedNotReleased(fx, p, current, 'later', ui);
    assert.equal(openDues(fx.home, p.id).length, 0, 'nothing asked while the deferral runs');
    await assertHoldsAccounted(fx, p.id, '(c) later, during the deferral');
    const during = accountsNow(fx, p);
    assert.ok(during.holds.length > 0 && during.holds.every((h) => h.accounts.some((a) => a.cause === 'deferral' && a.decision === current.id && a.until === until)), `each hold accounted for by the owner's deferral (${JSON.stringify(during.holds)})`);
    await advanceClock(fx.engine, 1800 + 60);
    await tick(fx.engine, p.id, { rounds: 2 });
    await waitForIdle(fx.home, p.id);
    const again = openDesignDue(fx.home, p.id);
    assert.ok(again, 'design_due open again once the owner\'s time passed');
    assert.ok(Date.parse(again.raised_at) >= Date.parse(until) - 10_000, `re-raised at the owner's time (${again.raised_at}; until ${until})`);
    await assertHoldsAccounted(fx, p.id, '(c) later');
    void due;
  });

  test('(c) open: the question consumed, nothing released or approved; a Designer session allocated, no process before the owner\'s first turn; the holds accounted for', async (t) => {
    const { fx, p, due, ui } = await heldPantry(t, 'pantry-open');
    const before = new Set(designerRuns(fx, p.id).map((r) => r.id));
    const res = await answerWith(fx, p.id, due, 'open');
    assert.equal(res.status, 200, `open answered (${res.text})`);
    const run = await pump(fx, { project: p.id, ...NO_ANSWER }, () => designerRuns(fx, p.id).find((r) => !before.has(r.id)), { what: 'the Designer session allocated', max: 4 });
    assert.deepEqual([run.role, run.kind], ['designer', 'session'], 'a session run of role designer (D6 §2.1)');
    assert.equal(run.session_state, 'allocated', `allocated (${run.session_state})`);
    assert.deepEqual(fx.scripted.launches({ run: run.id }), [], 'no process before the owner\'s first turn');
    // E162 item 1: `open` consumes the question; the held stages stay held, no design approved.
    assertConsumedNotReleased(fx, p, due, 'open', ui);
    await assertHoldsAccounted(fx, p.id, '(c) open, the session allocated');
    const during = accountsNow(fx, p);
    assert.ok(during.holds.length > 0 && during.holds.every((h) => h.accounts.some((a) => a.cause === 'session' && a.run === run.id)), `each hold accounted for by the owner's Designer session (${JSON.stringify(during.holds)})`);
    scriptTurns(fx, run.id, [talk('Shall we start with the list?')]);
    await sayAndSettle(fx, p.id, run.id, 'Let us design Pantry.');
    assert.equal(fx.scripted.launches({ run: run.id }).length, 1, 'the owner\'s first turn starts the first process');
    await assertHoldsAccounted(fx, p.id, '(c) open, after the first turn');
  });

  test('(c) an open the engine cannot carry out (another role\'s session open): an actionable question naming the refusal; open answered again once that session is closed', async (t) => {
    const { fx, p, due, ui } = await heldPantry(t, 'pantry-open-refused');
    const busy = await openSession(fx, p.id, 'spec_writer');
    const before = new Set(designerRuns(fx, p.id).map((r) => r.id));
    const res = await answerWith(fx, p.id, due, 'open');
    assert.equal(res.status, 200, `open answered (${res.text})`);
    const again = await pump(fx, { project: p.id, ...NO_ANSWER }, () => {
      const x = openDesignDue(fx.home, p.id);
      return x && x.id !== due.id ? x : undefined;
    }, { what: 'design_due asked again after the refused opening', max: 6 });
    assert.deepEqual(designerRuns(fx, p.id).filter((r) => !before.has(r.id)).map((r) => r.id), [], 'no Designer session allocated beside the open Spec Writer session');
    assert.ok(again.evidence?.open_refused?.reason, `the question names the refused opening (${JSON.stringify(again.evidence)})`);
    assert.match(again.question ?? '', /could not be opened/i, `and says so (${again.question})`);
    assert.deepEqual(sortedIds(again.evidence?.held_stages ?? []), sortedIds(ui), 'naming the held stages');
    assert.deepEqual(DESIGN_DUE_OPTIONS(again), ['later', 'open', 'policy_off', 'waive'], 'its four options');
    for (const key of ['waive', 'later', 'policy_off']) assert.deepEqual(again.options.find((o) => o.key === key)?.blockers ?? [], [], `actionable: ${key} unblocked`);
    await assertHoldsAccounted(fx, p.id, '(c) the refused opening');
    // The other session closed, the owner answers open again: the Designer session allocated.
    const closed = await postCloseRaw(fx, p.id, busy.id, { refuse: true });
    assert.equal(closed.status, 200, `the Spec Writer session closed (${closed.text})`);
    await waitFor(() => (runRow(fx.home, busy.id)?.state === 'ended' ? true : undefined), { what: 'the Spec Writer session ended', timeoutMs: 60_000 });
    const current = await pump(fx, { project: p.id, ...NO_ANSWER }, () => openDesignDue(fx.home, p.id) ?? undefined, { what: 'design_due open', max: 4 });
    const second = await answerWith(fx, p.id, current, 'open');
    assert.equal(second.status, 200, `open answered again (${second.text})`);
    const run = await pump(fx, { project: p.id, ...NO_ANSWER }, () => designerRuns(fx, p.id).find((r) => !before.has(r.id)), { what: 'the Designer session allocated', max: 4 });
    assert.equal(run.session_state, 'allocated', `allocated (${run.session_state})`);
    await assertHoldsAccounted(fx, p.id, '(c) open again');
  });

  test('(d) a Designer session ending without resolving the hold (its idle timeout): design_due re-raised, said on the next read', async (t) => {
    const { fx, p, due, ui } = await heldPantry(t, 'pantry-session-ends');
    const before = new Set(designerRuns(fx, p.id).map((r) => r.id));
    assert.equal((await answerWith(fx, p.id, due, 'open')).status, 200, 'open answered');
    const run = await pump(fx, { project: p.id, ...NO_ANSWER }, () => designerRuns(fx, p.id).find((r) => !before.has(r.id)), { what: 'the Designer session allocated', max: 4 });
    scriptTurns(fx, run.id, [talk('Shall we start with the list?')]);
    await sayAndSettle(fx, p.id, run.id, 'Let us design Pantry.');
    await advanceClock(fx.engine, 1200 + 60);
    await tick(fx.engine, p.id, { rounds: 2 });
    const ended = await waitFor(() => (runRow(fx.home, run.id)?.state === 'ended' ? runRow(fx.home, run.id) : undefined), { what: `run ${run.id} to end`, timeoutMs: 60_000 });
    assert.equal(ended.outcome, 'timed_out', `ended by its idle timeout (${ended.outcome} ${ended.reason_class})`);
    await tick(fx.engine, p.id, { rounds: 2 });
    await waitForIdle(fx.home, p.id);
    const again = await assertReRaised(fx, p.id, run.id, '(d) the idle timeout');
    assert.deepEqual(sortedIds(again.evidence?.held_stages ?? []), sortedIds(ui), 'naming the held stages');
  });

  test('(i) a restart during a deferral: the deferral survives it, nothing asked before its time, and re-raised when due', async (t) => {
    const { fx, p, due } = await heldPantry(t, 'pantry-later-restart');
    const until = at(await engineNow(fx), 3600);
    assert.equal((await answerWith(fx, p.id, due, 'later', { until })).status, 200, 'later answered');
    await tick(fx.engine, p.id, { rounds: 2 });
    await waitForIdle(fx.home, p.id);
    assert.equal(openDues(fx.home, p.id).length, 0, 'nothing asked while the deferral runs');
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    await waitForIdle(fx.home, p.id);
    assert.equal(openDues(fx.home, p.id).length, 0, `the deferral survives the restart: nothing asked before its time (${JSON.stringify(designDues(fx.home, p.id).map((d) => [d.id, d.status]))})`);
    const read = await readDesign(fx, p.id);
    assert.deepEqual([read.deferred?.until, read.deferred?.decision], [until, due.id], `GET …/design shows the deferral after the restart (${JSON.stringify(read.deferred)})`);
    await assertHoldsAccounted(fx, p.id, '(i) after the restart, during the deferral');
    await advanceClock(fx.engine, 3600 + 120);
    await tick(fx.engine, p.id, { rounds: 2 });
    await waitForIdle(fx.home, p.id);
    const again = openDesignDue(fx.home, p.id);
    assert.ok(again, 'design_due re-raised once its time passed');
    assert.ok(Date.parse(again.raised_at) >= Date.parse(until) - 10_000, `re-raised at the owner's time (${again.raised_at}; until ${until})`);
    assert.equal((await readDesign(fx, p.id)).deferred ?? null, null, 'the deferral over');
    assert.equal(openDues(fx.home, p.id).length, 1, 'one open question');
    await assertHoldsAccounted(fx, p.id, '(i) re-raised');
  });

  test('(j) a new cause during a deferral (the design sent back with revise): the deferral ends early, design_due re-raised', async (t) => {
    const fx = await scriptedEngine(t);
    const d = await designedPantry(fx, { name: 'pantry-later-revise', approve: false });
    const { p, ctx, batch } = d;
    const first = openDesignDue(fx.home, p.id);
    assert.ok(first, 'the fixture is live: design_due open beside the batch');
    const until = at(await engineNow(fx), 86_400);
    assert.equal((await answerWith(fx, p.id, first, 'later', { until })).status, 200, 'later answered');
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.equal(openDues(fx.home, p.id).length, 0, 'nothing asked while the deferral runs');
    assert.equal((await readDesign(fx, p.id)).deferred?.decision, first.id, 'the deferral on GET …/design');
    const res = await answerWith(fx, p.id, decision(fx.home, batch.design_approval.id), 'revise', { note: 'Make the add button larger.' });
    assert.equal(res.status, 200, `revise (${res.text})`);
    const again = await pump(fx, ctx, () => {
      const x = openDesignDue(fx.home, p.id);
      return x?.evidence?.stage === 'revise' ? x : undefined;
    }, { what: 'design_due re-raised stage revise during the deferral', max: 6 });
    assert.ok(Date.parse(again.raised_at) < Date.parse(until), `re-raised before the owner's time: the deferral ended early (${again.raised_at}; until ${until})`);
    assert.equal((await readDesign(fx, p.id)).deferred ?? null, null, 'the deferral over');
    assert.equal(openDues(fx.home, p.id).length, 1, 'one open question');
    await assertHoldsAccounted(fx, p.id, '(j)');
  });

  test('(k) an intentional wait as the journey reads it: a deferral and an open Designer session reported as waiting, never as completion or a passed step', async (t) => {
    const { fx, p, due, ui } = await heldPantry(t, 'pantry-waits');
    // A run directory of the real-lane runner's form per wait, inside this test's root (removed with it):
    // a step that ends waiting halts its run directory.
    const runDirOf = (cause) => {
      const runDir = join(fx.root, `k-run-${cause}`);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      return runDir;
    };
    // What the journey reads while it waits: each UI stage held and waiting, nothing ready or complete;
    // then the real-lane runner's step-end judgement (harness/real/m6-lane.mjs) on this home.
    const waitingOnReads = async (how, cause) => {
      const plan = await fx.engine.get(`/v1/projects/${p.id}/plan`);
      for (const id of ui) {
        const s = (plan.body?.plan?.stages ?? []).find((x) => x.id === id);
        assert.equal(s?.hold?.reason, 'design_pending', `${how}: stage ${s?.number} shown held design_pending (${JSON.stringify(s?.hold)})`);
        assert.ok(!['verified', 'complete', 'integrated'].includes(s?.status), `${how}: stage ${s?.number} not shown complete (${s?.status})`);
        const w = stageWorkById(fx, p, id);
        assert.ok(w.held_intervals.some((i) => i.to === undefined || i.to === null), `${how}: its design_pending interval still open (${JSON.stringify(w.held_intervals)})`);
      }
      const design = await readDesign(fx, p.id);
      assert.deepEqual((design.revisions ?? []).filter((r) => r.ready_at), [], `${how}: no design ready`);
      await assertHoldsAccounted(fx, p.id, how);
      const nowMs = engineTimeMs(fx.engine);
      let thrown = null;
      try {
        ruleTwentyFive(fx.home, p.id, how, { handover: ['design_due'], nowMs });
      } catch (err) {
        thrown = err;
      }
      assert.equal(thrown?.waiting, true, `${how}: rule 25's step-end judgement reports waiting, never a pass (${thrown?.message ?? 'it passed'})`);
      assert.ok(thrown.waits.some((w) => w.cause === cause), `${how}: naming the ${cause} (${JSON.stringify(thrown.waits)})`);
      const name = `k_${cause}`;
      const runDir = runDirOf(cause);
      const ctx = { runDir, keyValue: null };
      await assert.rejects(() => realStep(ctx, name, async () => ruleTwentyFive(fx.home, p.id, name, { handover: ['design_due'], nowMs })), (err) => err.waiting === true, `${how}: the step ends in its wait`);
      const verdict = stepVerdicts(runDir, [name])[0];
      assert.deepEqual([verdict.status, verdict.passed], ['waiting', false], `${how}: the step recorded waiting, not passed (${JSON.stringify(verdict)})`);
      return nowMs;
    };
    // A deferral: the runner's engine-driven wait judges it waiting, not a silent stall and not done.
    const until = at(await engineNow(fx), 3600);
    assert.equal((await answerWith(fx, p.id, due, 'later', { until })).status, 200, 'later answered');
    await tick(fx.engine, p.id, { rounds: 2 });
    await waitForIdle(fx.home, p.id);
    const nowMs = await waitingOnReads('(k) during the deferral', 'deferral');
    const a = activity(fx.home, p.id, { nowMs });
    const quiet = quietState(a);
    assert.equal(quiet.state, 'waiting', `the runner's stall judgement: waiting (${JSON.stringify(quiet)}; ${JSON.stringify({ live: a.live, executions: a.executions, runnable: a.runnable, operations: a.operations, asked: a.asked })})`);
    // An open Designer session: the deferral over, open answered.
    await advanceClock(fx.engine, 3600 + 120);
    await tick(fx.engine, p.id, { rounds: 2 });
    await waitForIdle(fx.home, p.id);
    const again = openDesignDue(fx.home, p.id);
    assert.ok(again, 'design_due re-raised after the deferral');
    const before = new Set(designerRuns(fx, p.id).map((r) => r.id));
    assert.equal((await answerWith(fx, p.id, again, 'open')).status, 200, 'open answered');
    await pump(fx, { project: p.id, ...NO_ANSWER }, () => designerRuns(fx, p.id).find((r) => !before.has(r.id)), { what: 'the Designer session allocated', max: 4 });
    await waitingOnReads('(k) during the open session', 'session');
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
    await assertHoldsAccounted(fx, p.id, '(f)');
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
    await assertHoldsAccounted(fx, a.id, '(a) at_alpha');
    // both: the design approved before build, the build, Alpha deployed.
    const d = await designedPantry(fx, { policy: { ...TO_ALPHA, design: 'both' }, name: 'pantry-both' });
    await alphaReady(fx, d.ctx, { port: 8081 });
    await alphaDeployed(fx, d.ctx, { max: 200 });
    const dueB = await pump(fx, d.ctx, () => (openDesignDue(fx.home, d.p.id)?.evidence?.stage === 'alpha_review' ? openDesignDue(fx.home, d.p.id) : undefined), { what: 'both: design_due alpha_review', max: 20 });
    assert.ok(dueB, 'raised on alpha_complete under both');
    await assertHoldsAccounted(fx, d.p.id, '(a) both');
  });
});

function DESIGN_DUE_OPTIONS(row) {
  return (row.options ?? []).map((o) => o.key).sort();
}
const designerRuns = (fx, project) => runsOfProject(fx.home, project).filter((r) => r.role === 'designer' && r.kind === 'session');
