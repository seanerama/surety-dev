// M512, `design_due` and no silent stalls (slice 44; kernel lane). M6 plan
// §3.6 M512 as amended by E162 item 1; D7 §11 as corrected, §2, §10.1; G5;
// BS6 §4.1 rule 25 as amended; errata E179; SEAM.md §§485, 491, 514, 547, 550, 551, 558, 559, 560.
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
//     `waiting`, never `done`, never passed (E162 item 1; rule 25); and
//     a rerun's leftovers (M519 finding F2; SEAM.md §550): read before any
//     engine starts, an eligible UI stage the engine holds `design_pending`
//     is held, not earlier work that could be dispatched; an item not held
//     still refuses the rerun; a stage the store as it stands releases is
//     counted, and a design milestone that cannot be judged is never held;
//     likewise (E177 finding F6; SEAM.md §558) an eligible stage the engine
//     holds `authoring_readiness` (its phase's authoring parked on an open
//     blocker) is held, not earlier work; once the store releases it (the
//     authoring retried and applied) it is counted and refuses; an item not
//     held and a run not ended still refuse; the recorded `held` is never
//     the judge, either way; an authoring milestone that cannot be judged is
//     never held;
//     and a rerun's act record (M519 finding F3; SEAM.md §551): a step's
//     per-act record covers every attempt of it from the first (the
//     store's acts and their performers' entries), never the rerun's alone;
//     a first run's record is as before; and a run directory from before
//     the attempts were kept is rebuilt once over every attempt, bounded by
//     the step's end;
//     and the Alpha step's end (finding F29 of the M535 Waterlog
//     continuation; SEAM.md §559): with Alpha deployed under policy and
//     design_due (alpha_review) raised before the step starts, an owner
//     finding_disposition left open (a Designer requirement_conflict,
//     change_spec its only option) is handed to the review, recorded open
//     and unanswered with its finding and options, and printed; nothing is
//     answered or routed; a genuine question (blocker, plan_approval,
//     spec_change, design_approval, a check correction) open at its end
//     still fails it, the step's condition holding at its first poll; the
//     review presents the handed question and does not end while it is open;
//     and the review's end under errata E179 (SEAM.md §560): a Designer
//     requirement_conflict question the owner acknowledged by his own record
//     (owner-act.mjs `question_acknowledged`, after it was raised, naming the
//     decision, its requirement, implications and follow-up), holding no
//     gate, stays open at the review's end, recorded open and acknowledged
//     with its verification gap, and the run's end is "completed under
//     E179", not M535 (j) as written, and not clean; unacknowledged, its
//     acknowledgement refused (dated before, another decision or
//     requirement, the driver's or a non-terminal record, no follow-up, a
//     gate held, an interface disputed, another kind, outside E179's two
//     questions) or beside a genuine question, the step fails naming it;
//     and a fix the engine can no longer move (finding F33 of the M535
//     Waterlog recovery attempt, with F19; objection 209; Sean's ruling of
//     2026-10-23, errata E179 item 8; SEAM.md §561): a `fix` left `verifying`
//     with no run, no pending check execution, no pending verification, no
//     due gate and no repair due on any unsuperseded candidate holding it is
//     neither runnable nor in flight: activity() names it `stuck`, never
//     `runnable`; with nothing else running, queued or asked the runner's
//     stall judgement is `silent` and its engine-driven wait fails at once
//     naming it, never at its deadline; the review's end fails at once naming
//     it (an E179-acknowledged question beside it changes nothing), never
//     judged ended, and ends only with nothing stuck; a pending check
//     execution on its candidate, an eligible item not held, and a fix the
//     engine's predicates cannot judge (unknown) are still counted (the
//     state on a store backup, every question about the fixes consumed,
//     since the engine of Sean's D-3 asks `fix_unjudged` about them, E180);
//     and stuck work at every step boundary (D-5, Sean's ruling of
//     2026-10-23, errata E180; SEAM.md §563): each step's rule-25 judgement
//     records it (`stuck`) without changing an intermediate step's
//     acceptance; the run's end (M535 (j)'s `e179Record`/`e179RunEnd`, M519
//     (h)'s `runEndStuck`) never passes with it.
// The engine never answers it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { CODES, consume, decision } from './harness/decisions.mjs';
import { REPO_ROOT, waitFor } from './harness/engine.mjs';
import { changePolicy, getPolicy, policyRevisions } from './harness/journal.mjs';
import { alphaDeployed, alphaReady, journeyContext, pump, runsOfProject, workOf } from './harness/journey/drive.mjs';
import { addWork, advanceClock, engineTimeMs, forceTransition, pauseProject, resumeProject, scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { openSession, runRow, saveSession, sayAndSettle, scriptTurns, turnResult } from './harness/sessions.mjs';
import { REVIEW_PATH } from './harness/design/reference.mjs';
import { postCloseRaw } from './harness/session-lane.mjs';
import { script, step } from './harness/scripted.mjs';
import { answerWith, assertHoldsAccounted, assertReRaised, designRevisions, designScripts, openDesignDue, readDesign, scriptBuilders, stageRow, stageWork, toPublished } from './harness/design/drive.mjs';
import { designHoldAccounts } from './harness/design/holds.mjs';
import { BEFORE_BUILD, KERNEL_KINDS } from './harness/design/check41.mjs';
import { TWO_DAYS, designDues, designWithCriterion, designedPantry, engineNow, escalations, openDues, policyEffective, stageIdsOf, waivedEvents } from './harness/design/plan44.mjs';
import { realStep } from './harness/real/lane.mjs';
import { activity, quietState, ruleTwentyFive, stepVerdicts } from './harness/real/m6-lane.mjs';
import * as m6lane from './harness/real/m6-lane.mjs';
import { approveBatch } from './harness/design/check41.mjs';
import { leftovers, refuseLeftovers } from './harness/real/checks-journey.mjs';
import { authoringItems, authoringRuns, authoringWith, builderRuns, go, openOf, pausedDeveloping, planRow, until } from './harness/exec37/authoring.mjs';
import { copyStore, openStore, storePath, withStore } from './harness/store.mjs';
import { ALPHA_ONLY, ALPHA_ONLY_REQUIRED, supersededFix } from './harness/checks/stuck-fix.mjs';
import { operatorRequest, recordExit } from './harness/checks/selection.mjs';

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

  test("(k) F29, the Alpha step's end: an owner finding_disposition open at Alpha (a Designer requirement_conflict, change_spec its only option) is handed to the review, recorded open and unanswered, never dropped; the review presents it and does not end until it is answered; a genuine question still fails the Alpha step; Alpha deployed before the step starts bypasses neither", async (t) => {
    const fx = await scriptedEngine(t);
    // The Waterlog continuation's shape (F29): the Designer reports a requirement_conflict in the design session; the owner
    // leaves its question open (routing it starts a Spec Writer run whose approval re-derives the inventory and stales the
    // design); the design approved, the phase built and complete, Alpha deployed under policy and design_due (alpha_review)
    // raised, all before the Alpha step starts.
    const CONFLICT = { category: 'requirement_conflict', severity: 'medium', message: 'R3 needs the list offline, which no interface offers', requirement: 'R3' };
    const d = await designedPantry(fx, { policy: { ...TO_ALPHA, design: 'both' }, name: 'pantry-f29', findings: [CONFLICT] });
    const project = d.p.id;
    const conflictQuestion = () => openOf(fx.home, project, 'finding_disposition').filter((q) => q.subject_type === 'design_finding');
    const [fd] = conflictQuestion();
    assert.ok(fd, `the Designer's requirement_conflict is an open owner question (${JSON.stringify(openOf(fx.home, project, 'finding_disposition'))})`);
    assert.deepEqual([fd.scope, (fd.options ?? []).map((o) => o.key)], ['design_conflict', ['change_spec']], `its only option is change_spec (D7 §4.5) (${JSON.stringify(fd.options)})`);
    const findingOf = () => withStore(fx.home, (db) => db.prepare('SELECT "id", "category", "requirement", "status", "message" FROM "design_findings" WHERE "id" = ?').get(fd.subject_id));
    assert.deepEqual([findingOf().category, findingOf().requirement, findingOf().status], ['requirement_conflict', 'R3', 'open'], 'the finding, open');
    await alphaReady(fx, d.ctx, { port: 8082 });
    await alphaDeployed(fx, d.ctx, { max: 200 });
    const due = await pump(fx, d.ctx, () => (openDesignDue(fx.home, project)?.evidence?.stage === 'alpha_review' ? openDesignDue(fx.home, project) : undefined), { what: 'design_due (alpha_review)', max: 20 });
    assert.deepEqual(conflictQuestion().map((q) => q.id), [fd.id], 'the finding_disposition still open at Alpha, unanswered');
    await waitForIdle(fx.home, project);

    // A run directory of the real-lane runner's form per judgement, inside this test's root (removed with it).
    const runCtx = (tag, home) => {
      const runDir = join(fx.root, `k-f29-${tag}`);
      mkdirSync(join(runDir, 'observed'), { recursive: true, mode: 0o700 });
      symlinkSync(home, join(runDir, 'home'));
      return { runDir, keyValue: null, rehearsal: false, waitMinutes: 0 };
    };
    // The engine as the step sees it, every call kept: a step whose condition holds at its first poll ticks nothing.
    const watched = (home, engine) => {
      const calls = [];
      const proxy = new Proxy(engine, {
        get(target, prop) {
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? (...args) => (calls.push(`${String(prop)} ${args[0] ?? ''}`), v.apply(target, args)) : v;
        },
      });
      return { fx: { ...fx, home, engine: proxy }, calls };
    };
    // What the step prints for Sean (tellSean writes standard error).
    const printedBy = async (fn) => {
      const printed = [];
      const write = process.stderr.write;
      process.stderr.write = function (chunk, ...rest) {
        printed.push(String(chunk));
        return write.call(this, chunk, ...rest);
      };
      try {
        return { outcome: await fn().then((value) => ({ value, error: null }), (error) => ({ value: null, error })), printed: printed.join('') };
      } finally {
        process.stderr.write = write;
      }
    };
    const previousMinutes = process.env.SURETY_REAL_ACT_RECORD_MINUTES;
    process.env.SURETY_REAL_ACT_RECORD_MINUTES = '0';
    t.after(() => {
      if (previousMinutes === undefined) delete process.env.SURETY_REAL_ACT_RECORD_MINUTES;
      else process.env.SURETY_REAL_ACT_RECORD_MINUTES = previousMinutes;
    });
    const ALPHA = 'm6x_alpha';
    const REVIEW = 'm6x_review';

    // The Alpha step on this home: its condition holds at its first poll (Alpha deployed, design_due raised).
    const live = runCtx('alpha', fx.home);
    const w = watched(fx.home, fx.engine);
    const a = await printedBy(() => m6lane.alphaStep(live, 'M535', w.fx, project));
    assert.equal(a.outcome.error, null, `the Alpha step passes, the open finding_disposition handed to the review (it failed: ${a.outcome.error?.message})`);
    assert.deepEqual(w.calls, [], `the step ended at its first poll: the engine not ticked (${JSON.stringify(w.calls)})`);
    // Not dropped: the step's value records it open and unanswered, handed to the review, with its finding and options.
    const handed = a.outcome.value.rule_25.handed_over;
    const entry = handed.find((h) => h.id === fd.id);
    assert.ok(entry, `recorded in rule_25.handed_over (${JSON.stringify(handed)})`);
    assert.deepEqual(
      [entry.kind, entry.status, entry.answered, entry.scope, entry.options, entry.handed_to],
      ['finding_disposition', 'open', false, 'design_conflict', ['change_spec'], REVIEW],
      `kind, open, not answered, its options, handed to the review (${JSON.stringify(entry)})`,
    );
    assert.deepEqual(
      [entry.subject?.type, entry.subject?.id, entry.subject?.category, entry.subject?.requirement, entry.subject?.status],
      ['design_finding', fd.subject_id, 'requirement_conflict', 'R3', 'open'],
      `naming its finding, still open (${JSON.stringify(entry.subject)})`,
    );
    assert.match(entry.note ?? '', /not answered/, `the record says it was not answered (${entry.note})`);
    assert.match(entry.note ?? '', /verified/, `and that nothing it names is verified by the handover (${entry.note})`);
    assert.ok(handed.some((h) => h.kind === 'design_due' && h.id === due.id && h.handed_to === REVIEW), `design_due (alpha_review) handed to the review as before (${JSON.stringify(handed)})`);
    // The observation says so: the step's recorded value, and the notice printed at its end.
    const observed = JSON.parse(readFileSync(join(live.runDir, 'observed', 'M535.json'), 'utf8'));
    assert.ok(observed.alpha.rule_25.handed_over.some((h) => h.id === fd.id && h.status === 'open'), 'observed/M535.json records it');
    assert.match(a.printed, new RegExp(`finding_disposition ${fd.id}[^\\n]*`), `the step's end tells Sean of it (${a.printed.slice(-1200)})`);
    assert.match(a.printed, new RegExp(`${REVIEW}`), 'naming the review it is handed to');
    assert.deepEqual(stepVerdicts(live.runDir, [ALPHA]).map((v) => v.status), ['done'], 'the step recorded done');
    // Not resolved: nothing answered, nothing routed.
    assert.deepEqual([decision(fx.home, fd.id).status, decision(fx.home, fd.id).answer], ['open', null], 'the question still open, unanswered');
    assert.equal(findingOf().status, 'open', 'the finding still open, not routed');

    // Genuine questions still fail the Alpha step, with its condition holding at the first poll: on copies of the store
    // (never the engine's home), each with one more open question of the kind, the step ticks nothing and fails naming it.
    const GENUINE = ['blocker', 'plan_approval', 'spec_change', 'design_approval', 'check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening'];
    const noEngine = (calls) => new Proxy({}, { get: (_, prop) => (...args) => { calls.push(`${String(prop)} ${args[0] ?? ''}`); throw new Error(`no engine call expected (${String(prop)} ${args[0] ?? ''})`); } });
    for (const kind of GENUINE) {
      const snap = join(fx.root, `k-f29-store-${kind}`);
      mkdirSync(snap, { recursive: true, mode: 0o700 });
      const src = openStore(storePath(fx.home), { readonly: true });
      try {
        await src.backup(join(snap, 'store.db'));
      } finally {
        src.close();
      }
      const id = `dec_f29_${kind}`;
      withStore(snap, (db) => {
        const row = db.prepare('SELECT * FROM "decisions" WHERE "id" = ?').get(fd.id);
        const seq = db.prepare('SELECT MAX("seq") AS n FROM "decisions" WHERE "project" = ?').get(project).n + 1;
        const clone = { ...row, id, kind, seq, status: 'open', answer: null, consumed_at: null };
        const cols = Object.keys(clone);
        db.prepare(`INSERT INTO "decisions" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => clone[c]));
      }, { readonly: false });
      const ctx = runCtx(`alpha-${kind}`, snap);
      const calls = [];
      const g = await printedBy(() => m6lane.alphaStep(ctx, 'M535', { ...fx, home: snap, engine: noEngine(calls) }, project));
      assert.ok(g.outcome.error, `${kind}: the Alpha step fails`);
      assert.equal(g.outcome.error.message, `${ALPHA} not passed: questions raised before its end are still open (BS6 §4.1 rule 25): ${kind} ${id}`, `${kind}: naming it alone, the finding_disposition and design_due handed over`);
      assert.deepEqual(calls, [], `${kind}: its condition held at the first poll, nothing ticked`);
      assert.deepEqual(stepVerdicts(ctx.runDir, [ALPHA]).map((v) => [v.status, v.passed]), [['failed', false]], `${kind}: the step recorded failed`);
    }

    // The next owner checkpoint, the review: it presents the question and does not end while it is open (its rule 25
    // hands over nothing). Its wait here is 0 minutes, so it ends at its first poll, not passed, naming it.
    const r = await printedBy(() => m6lane.reviewStep(live, 'M535', watched(fx.home, fx.engine).fx, project));
    assert.ok(r.outcome.error, 'the review does not end while the question is open');
    assert.match(r.outcome.error.message, new RegExp(`finding_disposition", ?"${fd.id}`), `naming it (${r.outcome.error.message})`);
    const shown = r.printed.split('\n').find((l) => l.startsWith(`Decision finding_disposition ${fd.id}`));
    assert.ok(shown, `presented to Sean at the review (${r.printed.slice(-2000)})`);
    assert.ok(!shown.includes('not one this step expects'), `as one the review expects (${shown})`);
    assert.match(shown, /options: change_spec/, `with its option (${shown})`);
    assert.deepEqual(stepVerdicts(live.runDir, [REVIEW]).map((v) => [v.status, v.passed]), [['failed', false]], 'the review recorded failed, never passed');
    assert.deepEqual(m6lane.HANDOVER.review, [], 'the review hands over nothing');
    assert.throws(() => ruleTwentyFive(fx.home, project, REVIEW, { handover: m6lane.HANDOVER.review }), new RegExp(`finding_disposition ${fd.id}`), "the review's rule 25 names it while it is open");
    // Answered by the owner, its question no longer stands against the review.
    await consume(fx, project, fd, 'change_spec');
    let after = null;
    try {
      ruleTwentyFive(fx.home, project, REVIEW, { handover: m6lane.HANDOVER.review });
    } catch (err) {
      after = err.message;
    }
    assert.ok(!String(after ?? '').includes(fd.id), `answered, it is not named (${after})`);
  });

  test("(k) E179, the review's end under E179: a Designer requirement_conflict question the owner acknowledged by his own record, holding no gate, stays open, recorded open and acknowledged, and the run is completed under E179, not as M535 (j) is written; unacknowledged, refused (dated before it was raised, another decision, another requirement, the driver's or a non-terminal record, a gate held, another kind, a question E179 does not name) or beside a genuine question, it fails", async (t) => {
    const fx = await scriptedEngine(t);
    const CONFLICT = { category: 'requirement_conflict', severity: 'medium', message: 'R3 needs the list offline, which no interface offers', requirement: 'R3' };
    const d = await designedPantry(fx, { policy: { ...TO_ALPHA, design: 'both' }, name: 'pantry-e179', findings: [CONFLICT] });
    const project = d.p.id;
    const [fd] = openOf(fx.home, project, 'finding_disposition').filter((q) => q.subject_type === 'design_finding');
    assert.ok(fd, 'the fixture is live: the requirement_conflict question open');
    assert.deepEqual((fd.options ?? []).map((o) => o.key), ['change_spec'], 'change_spec its only option');
    const findingOf = () => withStore(fx.home, (db) => db.prepare('SELECT "status" FROM "design_findings" WHERE "id" = ?').get(fd.subject_id));
    await alphaReady(fx, d.ctx, { port: 8083 });
    await alphaDeployed(fx, d.ctx, { max: 200 });
    await pump(fx, d.ctx, () => (openDesignDue(fx.home, project)?.evidence?.stage === 'alpha_review' ? openDesignDue(fx.home, project) : undefined), { what: 'design_due (alpha_review)', max: 20 });
    await waitForIdle(fx.home, project);

    const REVIEW = 'm6x_review';
    // A run directory of the runner's form, inside this test's root; `scope` the decisions E179 covers here (a real run's are E179's own).
    const runCtx = (tag, home, scope) => {
      const runDir = join(fx.root, `k-e179-${tag}`);
      mkdirSync(join(runDir, 'observed'), { recursive: true, mode: 0o700 });
      symlinkSync(home, join(runDir, 'home'));
      return { runDir, keyValue: null, rehearsal: false, waitMinutes: 2, ...(scope ? { e179Scope: scope } : {}) };
    };
    // Lines as owner-act.mjs writes them (its own terminal check is the script's; SEAM.md §542), or as driver-act.mjs does.
    const line = (ctx, entry, file = 'owner-acts.jsonl') => appendFileSync(join(ctx.runDir, 'observed', file), `${JSON.stringify(entry)}\n`);
    const after = (ms) => new Date(Math.max(Date.now(), Date.parse(fd.raised_at) + ms)).toISOString();
    const ack = (over = {}) => {
      const decision = over.decision ?? fd.id;
      const requirement = over.requirement ?? 'R3';
      return {
        act: 'question_acknowledged',
        at: after(1000),
        decision,
        requirement,
        implications: 'R3 stays as written; the list is not designed or verified for offline use.',
        follow_up: 'Route it change_spec after this run, then design the offline list.',
        words: `${decision} (${requirement}) acknowledged open: implications: offline use not designed or verified; deferred follow-up: route it change_spec after this run`,
        entered_via: 'owner-act.mjs',
        tty: true,
        uid: process.getuid?.() ?? null,
        user: 'owner',
        ...over,
      };
    };
    const printedBy = async (fn) => {
      const printed = [];
      const write = process.stderr.write;
      process.stderr.write = function (chunk, ...rest) {
        printed.push(String(chunk));
        return write.call(this, chunk, ...rest);
      };
      try {
        return { outcome: await fn().then((value) => ({ value, error: null }), (error) => ({ value: null, error })), printed: printed.join('') };
      } finally {
        process.stderr.write = write;
      }
    };
    const previousMinutes = process.env.SURETY_REAL_ACT_RECORD_MINUTES;
    process.env.SURETY_REAL_ACT_RECORD_MINUTES = '0';
    t.after(() => {
      if (previousMinutes === undefined) delete process.env.SURETY_REAL_ACT_RECORD_MINUTES;
      else process.env.SURETY_REAL_ACT_RECORD_MINUTES = previousMinutes;
    });
    const reviewJudgement = (ctx, home = fx.home) => {
      try {
        return { value: ruleTwentyFive(home, project, REVIEW, { handover: m6lane.HANDOVER.review, exception: ctx }), error: null };
      } catch (error) {
        return { value: null, error };
      }
    };

    // (a) Acknowledged by the owner's own record, after it was raised, naming the decision and R3, with its implications and
    // follow-up: the review step, run as the runner runs it while the owner reviews the Alpha (a review-mode session, its
    // verdicts confirmed and his confirmation recorded), ends with the question still open.
    const a = runCtx('a', fx.home, [fd.id]);
    line(a, ack());
    const step$ = printedBy(() => m6lane.reviewStep(a, 'M535', fx, project));
    const run = await openSession(fx, project, 'designer', { mode: 'review' });
    const reviewJson = `${JSON.stringify({ design_version: 1, subject: { kind: 'candidate' }, screens: [{ target: 'web', key: 'S1', verdict: 'not_observed', not_observed_reason: 'owner_skipped', evidence: [], deltas: [] }, { target: 'android', key: 'S2', verdict: 'not_observed', not_observed_reason: 'no_native_runtime', evidence: [], deltas: [] }], revised_design: false, first_design: false }, null, 2)}\n`;
    scriptTurns(fx, run.id, [{ steps: [step.write(REVIEW_PATH, reviewJson), step.result(turnResult({ reply: 'The review is written.', artifact_changed: true, done: true }))] }]);
    await sayAndSettle(fx, project, run.id, 'Review the Alpha.');
    await saveSession(fx, project, run.id);
    const closed = await postCloseRaw(fx, project, run.id, {});
    assert.equal(closed.status, 200, `the review's close (${closed.text?.slice(0, 400)})`);
    let verdicts = null;
    for (let i = 0; i < 30 && !verdicts; i++) {
      await tick(fx.engine, project);
      verdicts = openOf(fx.home, project, 'design_verdicts')[0] ?? null;
    }
    assert.ok(verdicts, 'design_verdicts raised at the review\'s close');
    assert.equal((await answerWith(fx, project, verdicts, 'confirm')).status, 200, 'design_verdicts confirmed by the owner');
    line(a, { act: 'review_confirmation', at: new Date().toISOString(), words: 'I confirmed the review verdicts after reading them.', entered_via: 'owner-act.mjs', tty: true, uid: process.getuid?.() ?? null, user: 'owner' });
    const r = await step$;
    assert.equal(r.outcome.error, null, `the review ends with the acknowledged question open (it failed: ${r.outcome.error?.message})`);
    const r25 = r.outcome.value.rule_25;
    assert.deepEqual(r25.handed_over, [], 'the review hands over nothing');
    assert.equal(r25.completed_under, 'E179', 'completed under E179');
    assert.deepEqual(r25.acknowledged_open.map((x) => x.id), [fd.id], `recorded open and acknowledged (${JSON.stringify(r25.acknowledged_open)})`);
    const entry = r25.acknowledged_open[0];
    assert.deepEqual(
      [entry.kind, entry.status, entry.answered, entry.requirement, entry.exception, entry.options, entry.subject?.id, entry.subject?.category],
      ['finding_disposition', 'open', false, 'R3', 'E179', ['change_spec'], fd.subject_id, 'requirement_conflict'],
      `its record: open, not answered, R3, E179, its options and finding (${JSON.stringify(entry)})`,
    );
    assert.match(entry.verification_gap ?? '', /R3 is not verified/, `its verification gap (${entry.verification_gap})`);
    assert.deepEqual([entry.acknowledgement?.decision, entry.acknowledgement?.requirement], [fd.id, 'R3'], 'the owner\'s record it rests on');
    assert.doesNotMatch(JSON.stringify(entry), /"status":"(resolved|accepted|verified|dispositioned)"/, 'never recorded resolved, accepted or verified');
    assert.match(r.printed, /completed under E179, not as M519 \(h\) \/ M535 \(j\) are written/, 'the review\'s end says so');
    assert.deepEqual(stepVerdicts(a.runDir, [REVIEW]).map((v) => v.status), ['done'], 'the review recorded done');
    const observedA = JSON.parse(readFileSync(join(a.runDir, 'observed', 'M535.json'), 'utf8'));
    assert.deepEqual(observedA.review.rule_25.acknowledged_open.map((x) => x.id), [fd.id], 'observed/M535.json records it');
    // M535 (j)'s end judgement: completed under E179, the rows not satisfied as written, not clean; the final record says both.
    const end = m6lane.e179RunEnd(a, 'M535', fx.home, project);
    assert.deepEqual([end.completed_under, end.satisfied_as_written, end.clean], ['E179', false, false], `the run's end (${JSON.stringify(end)})`);
    assert.match(end.statement, /completed under E179, not as written: M519 \(h\) \/ M535 \(j\) .* are not satisfied/, end.statement);
    assert.deepEqual(end.open_acknowledged.map((x) => [x.id, x.requirement]), [[fd.id, 'R3']], 'the final record lists it with its requirement');
    assert.deepEqual(end.unacknowledged, [], 'nothing else open');
    assert.deepEqual([decision(fx.home, fd.id).status, decision(fx.home, fd.id).answer, findingOf().status], ['open', null, 'open'], 'nothing answered or routed');
    // The owner's record is his own: owner-act.mjs records an acknowledgement only in his terminal.
    const typed = spawnSync(process.execPath, [join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M6-real-lane', 'owner-act.mjs'), a.runDir, 'question_acknowledged'], { input: '', encoding: 'utf8' });
    assert.deepEqual([typed.status, /only in your own terminal/.test(typed.stderr)], [2, true], `owner-act.mjs refuses an acknowledgement typed by no terminal (${typed.status} ${typed.stderr})`);

    // (b) The same question unacknowledged: the review's judgement and the run's end fail naming it.
    const b = runCtx('b', fx.home, [fd.id]);
    const jb = reviewJudgement(b);
    assert.match(jb.error?.message ?? 'it passed', new RegExp(`${REVIEW} not passed: .*finding_disposition ${fd.id}`), '(b) unacknowledged: the review fails naming it');
    assert.throws(() => m6lane.e179RunEnd(b, 'M535', fx.home, project), new RegExp(`not acknowledged under E179: finding_disposition ${fd.id}`), '(b) and the run\'s end');

    // (e) Records that do not count: dated before it was raised; naming another decision; another requirement; the driver's
    // record; a line not from owner-act.mjs in a terminal; no follow-up stated.
    const notCounted = [
      ['dated before', ack({ at: new Date(Date.parse(fd.raised_at) - 1000).toISOString() }), 'owner-acts.jsonl', /not after the question was raised/],
      ['another decision', ack({ decision: 'dec_00000000000000000000000000' }), 'owner-acts.jsonl', null],
      ['another requirement', ack({ requirement: 'R2' }), 'owner-acts.jsonl', /does not name the question's requirement R3/],
      ['the driver\'s', { ...ack(), acted_by: 'driver', entered_via: 'driver-act.mjs' }, 'driver-acts.jsonl', null],
      ['no terminal', ack({ tty: false }), 'owner-acts.jsonl', null],
      ['no follow-up', ack({ follow_up: '' }), 'owner-acts.jsonl', /states no deferred follow-up/],
    ];
    for (const [tag, e, file, reason] of notCounted) {
      const c = runCtx(`e-${tag.replace(/\W+/g, '-')}`, fx.home, [fd.id]);
      line(c, e, file);
      const j = reviewJudgement(c);
      assert.match(j.error?.message ?? 'it passed', new RegExp(`finding_disposition ${fd.id}`), `(e) ${tag}: not counted, the review fails naming it`);
      if (reason) assert.match(j.error.message, reason, `(e) ${tag}: the refusal's reason named`);
    }
    // Scope: a question E179 does not name (a real run's scope, E179's two decisions) is refused.
    const outside = runCtx('e-outside', fx.home, null);
    line(outside, ack());
    assert.match(reviewJudgement(outside).error?.message ?? 'it passed', /refused: not one of the questions E179 names/, '(4) a question E179 does not name: refused');

    // (c), (d), (4) on copies of the store (a backup, never the engine's home).
    const snapshot = async (tag, change) => {
      const dir = join(fx.root, `k-e179-store-${tag}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const src = openStore(storePath(fx.home), { readonly: true });
      try {
        await src.backup(join(dir, 'store.db'));
      } finally {
        src.close();
      }
      withStore(dir, change, { readonly: false });
      return dir;
    };
    const cloneAs = (db, kind, id) => {
      const row = db.prepare('SELECT * FROM "decisions" WHERE "id" = ?').get(fd.id);
      const seq = db.prepare('SELECT MAX("seq") AS n FROM "decisions" WHERE "project" = ?').get(project).n + 1;
      const clone = { ...row, id, kind, seq, status: 'open', answer: null, consumed_at: null };
      const cols = Object.keys(clone);
      db.prepare(`INSERT INTO "decisions" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => clone[c]));
    };
    // (c) An acknowledged question that holds a gate: refused, the reason named.
    const gated = await snapshot('gate', (db) => db.prepare('UPDATE "decisions" SET "blocked_while_open" = ? WHERE "id" = ?').run(JSON.stringify({ work_items: ['wi_e179_held'] }), fd.id));
    const c1 = runCtx('c-gate', gated, [fd.id]);
    line(c1, ack());
    assert.match(reviewJudgement(c1, gated).error?.message ?? 'it passed', new RegExp(`finding_disposition ${fd.id} \\(acknowledgement under E179 refused: it holds a gate while open`), '(c) holding a gate: refused, named');
    const disputed = await snapshot('interface', (db) => db.prepare('UPDATE "design_findings" SET "interface" = ? WHERE "id" = ?').run('add-item', fd.subject_id));
    const c2 = runCtx('c-interface', disputed, [fd.id]);
    line(c2, ack());
    assert.match(reviewJudgement(c2, disputed).error?.message ?? 'it passed', /refused: its finding disputes the interface add-item/, '(c) disputing an interface (a design approval held): refused, named');
    // (d) A genuine question open beside the acknowledged one: the step fails naming it alone.
    for (const kind of ['blocker', 'plan_approval', 'spec_change', 'design_approval', 'check_correction_tightening']) {
      const id = `dec_e179_${kind}`;
      const home = await snapshot(`d-${kind}`, (db) => cloneAs(db, kind, id));
      const c = runCtx(`d-${kind}`, home, [fd.id, id]);
      line(c, ack());
      line(c, ack({ decision: id, words: `${id} (R3) acknowledged open` }));
      const j = reviewJudgement(c, home);
      assert.match(j.error?.message ?? 'it passed', new RegExp(`still open \\(BS6 §4\\.1 rule 25\\): ${kind} ${id} \\(acknowledgement under E179 refused: E179 covers an open finding_disposition only, never a ${kind}\\)$`), `(d), (4) ${kind}: fails naming it alone, its acknowledgement refused (${j.error?.message})`);
    }
  });

  test('(k) M519 F2, a rerun\'s leftovers: an eligible UI stage the engine holds design_pending is held, not earlier work; an item not held still refuses; a stage the store releases is counted; unknown is never held', async (t) => {
    const { fx, p, ui } = await heldPantry(t, 'pantry-rerun');
    const uiWork = [2, 3].map((n) => stageWork(fx.home, p.id, n).id);
    const path = 'M512 (k) rerun';
    // A step that ended "not established": its project paused, its engine stopped. A rerun reads the store before any engine starts.
    await pauseProject(fx.engine, p.id);
    await fx.engine.kill();
    const facts = (home) => withStore(home, (db) => db.prepare(`SELECT "id", "kind", "status", "held", "dispatch_hold", "chain", "depends_on" FROM "work_items" WHERE "project" = ? AND "status" = 'eligible' ORDER BY "seq"`).all(p.id));
    const first = leftovers(fx.home, [p.id]);
    assert.equal(first.length, 1, `one project read (${JSON.stringify(first)})`);
    assert.equal(first[0].paused, true, 'the project paused');
    assert.deepEqual(sortedIds((first[0].design_held ?? []).map((w) => w.id)), sortedIds(uiWork), `both UI stages held design_pending, not leftover work (${JSON.stringify(first)}; eligible: ${JSON.stringify(facts(fx.home))})`);
    for (const w of first[0].design_held) assert.equal(w.held, 'design_pending', `${w.id} held design_pending`);
    assert.deepEqual(first[0].dispatchable, [], `nothing of the project could be dispatched (${JSON.stringify(first)}; eligible: ${JSON.stringify(facts(fx.home))})`);
    assert.doesNotThrow(() => refuseLeftovers(path, first, { evenIfPaused: true }), 'the rerun is not refused for the held UI stages');

    // An eligible item not held, beside them: the rerun is refused, naming it, and only it is counted.
    await fx.start();
    const loose = await addWork(fx.engine, p.id, 'review');
    await fx.engine.kill();
    const second = leftovers(fx.home, [p.id]);
    assert.deepEqual(second[0].dispatchable.map((w) => w.id), [loose], `only the item not held is counted (${JSON.stringify(second)})`);
    assert.deepEqual(sortedIds(second[0].design_held.map((w) => w.id)), sortedIds(uiWork), 'the UI stages still held');
    assert.throws(() => refuseLeftovers(path, second, { evenIfPaused: true }), (err) => err.message.includes('could be dispatched') && err.message.includes(loose), 'refused, naming the item not held');
    assert.doesNotThrow(() => refuseLeftovers(path, second, { evenIfPaused: false }), 'paused, with evenIfPaused false: not refused, as before');

    // Copies of the store, changed as the store would stand (not the engine's home).
    const copyOf = (name, change) => {
      const home = join(fx.root, `k-copy-${name}`, 'home');
      mkdirSync(home, { recursive: true, mode: 0o700 });
      copyStore(fx.home, home);
      const db = openStore(join(home, 'store.db'));
      try {
        change(db);
      } finally {
        db.close();
      }
      return home;
    };
    const stage2 = stageRow(fx.home, p.id, 2).id;
    const [work2, work3] = uiWork;
    // Released by the store as it stands (stage 2 waived, D7 §11): the engine's own predicate releases it, so it is counted.
    const waived = copyOf('waived', (db) => {
      const row = db.prepare('SELECT "design_due" FROM "projects" WHERE "id" = ?').get(p.id);
      const state = row.design_due ? JSON.parse(row.design_due) : {};
      db.prepare('UPDATE "projects" SET "design_due" = ? WHERE "id" = ?').run(JSON.stringify({ ...state, waived: [...(state.waived ?? []), stage2] }), p.id);
    });
    const released = leftovers(waived, [p.id]);
    assert.ok(released[0].dispatchable.some((w) => w.id === work2), `stage 2 released by the store as it stands is counted, whatever its recorded hold (${JSON.stringify(released)}; recorded: ${JSON.stringify(facts(waived).find((w) => w.id === work2)?.held)})`);
    assert.deepEqual((released[0].design_held ?? []).map((w) => w.id), [work3], 'stage 3 still held');
    // Unknown is never held: a design milestone naming no stage of the project, and a depends_on that cannot be read.
    for (const [name, value] of [
      ['missing-stage', (deps) => JSON.stringify(deps.map((d) => (d && d.milestone === 'design_ready' ? { ...d, stage: 'stage_00000000000000000000000000' } : d)))],
      ['unreadable', () => '[{"milestone":"design_ready"'],
    ]) {
      const home = copyOf(name, (db) => {
        const deps = JSON.parse(db.prepare('SELECT "depends_on" FROM "work_items" WHERE "id" = ?').get(work2).depends_on);
        db.prepare('UPDATE "work_items" SET "depends_on" = ? WHERE "id" = ?').run(value(deps), work2);
      });
      const read = leftovers(home, [p.id]);
      assert.deepEqual(read[0].dispatchable.filter((w) => w.id === work2).map((w) => w.design_hold), ['unknown'], `${name}: stage 2 counted, marked unknown (${JSON.stringify(read)})`);
      assert.throws(() => refuseLeftovers(path, read, { evenIfPaused: true }), (err) => err.message.includes(work2), `${name}: the rerun refused, naming it`);
    }
  });

  // E177 finding F6 (SEAM.md §558): the M535 Waterlog rerun refused for a stage whose phase's authoring was parked.
  test("(k) E177 F6, a rerun's leftovers: an eligible stage the engine holds authoring_readiness (its phase's authoring parked on an open blocker) is held, not earlier work; the hold cleared, it is counted; an item not held and a run not ended still refuse; the recorded hold is never the judge; unknown is never held", async (t) => {
    const { fx, p, ctx, plan } = await pausedDeveloping(t, { policy: { repair_attempts_max: 0 } });
    // Phase 1's authoring: its first run ends with no valid result (parked, a blocker owed: the Waterlog run's timeout stands so); its retry authors the checks.
    fx.scripted.kindScript('check_authoring', [script.invalid({ status: 'not-a-result' }), authoringWith(1)]);
    await go(fx, p);
    const [authoring] = authoringItems(fx.home, p.id);
    const blocker = await until(fx, ctx, () => openOf(fx.home, p.id, 'blocker').find((d) => d.subject_id === authoring.id), { what: "phase 1's authoring parked with a blocker" });
    const path = 'M512 (k) F6 rerun';
    const stages = workOf(fx.home, p.id, 'stage_build');
    const stageIds = stages.map((w) => w.id);
    const [stage1] = stageIds;
    // The fixture is live: the authoring parked, no readiness, every stage eligible on the phase's milestone and no design milestone, no Builder.
    assert.equal(authoringItems(fx.home, p.id)[0].status, 'parked', 'the authoring item parked');
    assert.equal(planRow(fx.home, plan.id).authoring_ready_at ?? null, null, 'no readiness');
    assert.ok(stages.length >= 1, 'the phase has stage work');
    for (const w of stages) {
      assert.equal(w.status, 'eligible', `${w.id} eligible`);
      assert.ok((w.depends_on ?? []).some((d) => d.milestone === 'authoring_ready' && d.phase_plan === plan.id), `${w.id} depends on the phase's authoring readiness (${JSON.stringify(w.depends_on)})`);
      assert.ok(!(w.depends_on ?? []).some((d) => d.milestone === 'design_ready'), `${w.id} has no design milestone`);
    }
    assert.deepEqual(builderRuns(fx.home, p.id), [], 'no Builder');
    // A step that ended "not established": its project paused, its engine stopped. The rerun reads the store before any engine starts.
    await pauseProject(fx.engine, p.id);
    await fx.engine.kill();
    const facts = (home) => withStore(home, (db) => db.prepare(`SELECT "id", "kind", "status", "held", "dispatch_hold", "chain", "depends_on" FROM "work_items" WHERE "project" = ? AND "status" = 'eligible' ORDER BY "seq"`).all(p.id));
    const first = leftovers(fx.home, [p.id]);
    assert.equal(first.length, 1, `one project read (${JSON.stringify(first)})`);
    assert.equal(first[0].paused, true, 'the project paused');
    assert.deepEqual(first[0].dispatchable, [], `nothing of the project could be dispatched: the stages wait on the parked authoring (${JSON.stringify(first)}; eligible: ${JSON.stringify(facts(fx.home))})`);
    assert.deepEqual(sortedIds((first[0].authoring_held ?? []).map((w) => w.id)), sortedIds(stageIds), `every stage held authoring_readiness, not leftover work (${JSON.stringify(first)})`);
    for (const w of first[0].authoring_held) assert.deepEqual(w, { id: w.id, kind: 'stage_build', held: 'authoring_readiness' }, `${w.id} listed with its hold`);
    assert.equal(first[0].design_held, undefined, "no design hold: §550's field absent");
    assert.deepEqual(first[0].live, [], 'no run not ended');
    assert.doesNotThrow(() => refuseLeftovers(path, first, { evenIfPaused: true }), 'the rerun is not refused for the stages held on authoring readiness');

    // Copies of the store, changed as the store would stand (never the engine's home).
    const copyOf = (name, change) => {
      const home = join(fx.root, `f6-copy-${name}`, 'home');
      mkdirSync(home, { recursive: true, mode: 0o700 });
      copyStore(fx.home, home);
      const db = openStore(join(home, 'store.db'));
      try {
        change(db);
      } finally {
        db.close();
      }
      return home;
    };
    const setHeld = (db, held) => {
      for (const id of stageIds) db.prepare('UPDATE "work_items" SET "held" = ? WHERE "id" = ?').run(held, id);
    };
    const READY_AT = '2026-10-21T00:00:00.000Z';
    // A stale recorded hold, one way: recorded authoring_readiness, the store releasing it (the phase ready): counted.
    const recordedHeld = copyOf('recorded-held', (db) => {
      db.prepare('UPDATE "phase_plans" SET "authoring_ready_at" = ? WHERE "id" = ?').run(READY_AT, plan.id);
      setHeld(db, 'authoring_readiness');
    });
    const released = leftovers(recordedHeld, [p.id]);
    assert.ok(released[0].dispatchable.some((w) => w.id === stage1), `released by the store as it stands, stage 1 is counted whatever its recorded hold (${JSON.stringify(released)}; recorded: ${JSON.stringify(facts(recordedHeld).map((w) => w.held))})`);
    assert.equal(released[0].authoring_held, undefined, `nothing held on authoring readiness (${JSON.stringify(released)})`);
    assert.throws(() => refuseLeftovers(path, released, { evenIfPaused: true }), (err) => err.message.includes(stage1), 'the rerun refused, naming stage 1');
    // The other way: the store holding it, the recorded hold none or another reason: held by the store as it stands.
    for (const recorded of [null, 'open_decision', 'resource_envelope']) {
      const home = copyOf(`recorded-${recorded ?? 'none'}`, (db) => setHeld(db, recorded));
      const read = leftovers(home, [p.id]);
      assert.deepEqual(read[0].dispatchable, [], `recorded ${recorded}: nothing counted, the store holds every stage (${JSON.stringify(read)})`);
      assert.deepEqual(sortedIds((read[0].authoring_held ?? []).map((w) => w.id)), sortedIds(stageIds), `recorded ${recorded}: every stage held authoring_readiness`);
      assert.doesNotThrow(() => refuseLeftovers(path, read, { evenIfPaused: true }), `recorded ${recorded}: not refused`);
    }
    // A recorded value that is no HoldReason cannot stand in the store (the column's CHECK): the check never reads the column, so no recorded value holds an item.
    assert.throws(() => copyOf('recorded-unknown', (db) => setHeld(db, 'not_a_hold_reason')), /CHECK constraint failed/, 'the store refuses a held value that is no HoldReason');
    // Unknown is never held: a milestone naming no plan of the project, one naming none at all, and the engine's predicate throwing.
    for (const [name, change] of [
      ['missing-plan', (db) => db.prepare('UPDATE "work_items" SET "depends_on" = ? WHERE "id" = ?').run(JSON.stringify(stages[0].depends_on.map((d) => (d && d.milestone === 'authoring_ready' ? { ...d, phase_plan: 'plan_00000000000000000000000000' } : d))), stage1)],
      ['no-plan', (db) => db.prepare('UPDATE "work_items" SET "depends_on" = ? WHERE "id" = ?').run(JSON.stringify(stages[0].depends_on.map((d) => (d && d.milestone === 'authoring_ready' ? { milestone: 'authoring_ready' } : d))), stage1)],
      ['predicate-throws', (db) => db.prepare('ALTER TABLE "phase_plans" RENAME COLUMN "authoring_ready_at" TO "authoring_ready_at_gone"').run()],
    ]) {
      const read = leftovers(copyOf(name, change), [p.id]);
      assert.deepEqual(read[0].dispatchable.filter((w) => w.id === stage1).map((w) => w.authoring_hold), ['unknown'], `${name}: stage 1 counted, marked unknown (${JSON.stringify(read)})`);
      assert.ok(!(read[0].authoring_held ?? []).some((w) => w.id === stage1), `${name}: stage 1 not held`);
      assert.throws(() => refuseLeftovers(path, read, { evenIfPaused: true }), (err) => err.message.includes(stage1), `${name}: the rerun refused, naming stage 1`);
    }
    // A run not ended still refuses, the stages held or not.
    const authoringRun = authoringRuns(fx.home, p.id)[0];
    assert.ok(authoringRun, 'the authoring run recorded');
    const liveRead = leftovers(copyOf('live-run', (db) => db.prepare(`UPDATE "runs" SET "state" = 'executing' WHERE "id" = ?`).run(authoringRun.id)), [p.id]);
    assert.deepEqual(liveRead[0].live.map((r) => r.id), [authoringRun.id], `the run not ended read (${JSON.stringify(liveRead)})`);
    assert.deepEqual(liveRead[0].dispatchable, [], 'nothing counted dispatchable');
    assert.throws(() => refuseLeftovers(path, liveRead, { evenIfPaused: true }), (err) => err.message.includes(authoringRun.id), 'a run not ended: refused, naming it');
    assert.throws(() => refuseLeftovers(path, liveRead, { evenIfPaused: false }), (err) => err.message.includes(authoringRun.id), 'a run not ended: refused with evenIfPaused false too');

    // An eligible item not held beside them: counted with the row as before, the rerun refused naming it; then cancelled through the engine.
    await fx.start();
    const loose = await addWork(fx.engine, p.id, 'review');
    await fx.engine.kill();
    const second = leftovers(fx.home, [p.id]);
    assert.deepEqual(second[0].dispatchable, [{ id: loose, kind: 'review', status: 'eligible', chain: 0, dispatch_hold: 0 }], `only the item not held is counted, its row as before (${JSON.stringify(second)})`);
    assert.deepEqual(sortedIds(second[0].authoring_held.map((w) => w.id)), sortedIds(stageIds), 'the stages still held');
    assert.throws(() => refuseLeftovers(path, second, { evenIfPaused: true }), (err) => err.message.includes('could be dispatched') && err.message.includes(loose), 'refused, naming the item not held');
    assert.doesNotThrow(() => refuseLeftovers(path, second, { evenIfPaused: false }), 'paused, with evenIfPaused false: not refused, as before');
    await fx.start();
    const cancelled = await forceTransition(fx.engine, loose, 'cancelled');
    assert.equal(cancelled.status, 200, `the loose item cancelled through the engine (${cancelled.text})`);

    // The hold cleared through the engine: the owner retries the authoring, its proposal is approved and applied, the phase ready.
    await resumeProject(fx.engine, p.id);
    await consume(fx, p.id, decision(fx.home, blocker.id), 'retry');
    const proposal = await until(fx, ctx, () => openOf(fx.home, p.id, 'check_correction_unclassifiable')[0], { what: "the retry's proposal routed to the owner" });
    // Paused before the approval, so that the phase's readiness dispatches nothing.
    await pauseProject(fx.engine, p.id);
    await consume(fx, p.id, decision(fx.home, proposal.id), 'approve');
    await waitFor(() => planRow(fx.home, plan.id).authoring_ready_at ?? undefined, { what: "phase 1's authoring readiness", timeoutMs: 30000 });
    await fx.engine.kill();
    assert.deepEqual(builderRuns(fx.home, p.id), [], 'no Builder: the project paused at readiness');
    const third = leftovers(fx.home, [p.id]);
    assert.ok(third[0].dispatchable.some((w) => w.id === stage1), `the hold cleared, stage 1 is counted (${JSON.stringify(third)}; eligible: ${JSON.stringify(facts(fx.home))})`);
    assert.equal(third[0].authoring_held, undefined, `nothing held on authoring readiness (${JSON.stringify(third)})`);
    assert.throws(() => refuseLeftovers(path, third, { evenIfPaused: true }), (err) => err.message.includes('could be dispatched') && err.message.includes(stage1), 'the rerun refused, naming stage 1');
  });

  test("(k) M519 F3, a rerun's act record: every attempt of the step from the first, never the rerun's alone; a first run's record as before; a run directory from before the attempts were kept rebuilt once, bounded by the step's end", async (t) => {
    const fx = await scriptedEngine(t);
    const d = await designedPantry(fx, { name: 'pantry-acts', approve: false });
    const project = d.p.id;
    const name = 'm6w_design';
    const batchIds = sortedIds([d.batch.design_approval.id, d.batch.spec_change.id]);
    const maxSeq = () => withStore(fx.home, (db) => db.prepare('SELECT MAX("seq") AS n FROM "events"').get().n);
    const atOf = (seq) => withStore(fx.home, (db) => db.prepare('SELECT "at" FROM "events" WHERE "seq" = ?').get(seq).at);
    const readJson = (file, empty) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : empty);
    // Run directories of the real-lane runner's form, inside this test's root (removed with it); `home` is the engine's.
    const runCtx = (tag) => {
      const runDir = join(fx.root, `k-acts-${tag}`);
      mkdirSync(join(runDir, 'observed'), { recursive: true, mode: 0o700 });
      symlinkSync(fx.home, join(runDir, 'home'));
      return { runDir, keyValue: null, rehearsal: false, waitMinutes: 0 };
    };
    const stepActs = (ctx) => m6lane.readActs(ctx, 'M519').filter((a) => a.step === name);
    // The driver's entry for each act (driver-act.mjs's form), at the act; under the engine's clock when `at` is given.
    const driverActs = (ctx, acts, at = null) => {
      for (const a of acts) {
        for (const i of a.items) appendFileSync(join(ctx.runDir, 'observed', 'driver-acts.jsonl'), `${JSON.stringify({ act: a.act, step: name, ...(i.decision ? { decision: i.decision, option: i.option } : {}), at: at ?? new Date().toISOString(), acted_by: 'driver', on_instruction: 'M512 (k): drive the acts yourself', entered_via: 'driver-act.mjs' })}\n`);
      }
    };
    const named = (tag) => [{ act: 'preview_inspection', route: `M512 (k) ${tag}`, store_actor: "the owner's routes", answered_at: null }];
    const rerun = (ctx) => {
      // As SURETY_REAL_RERUN=m6w_design applies it (lane.mjs applyRerun): the step cleared, its halt with it.
      const file = join(ctx.runDir, 'state.json');
      const st = readJson(file, null);
      delete st.steps[name];
      if (st.halted?.step === name) st.halted = null;
      st.reruns_applied = [...(st.reruns_applied ?? []), `${process.pid}:${name}`];
      writeFileSync(file, `${JSON.stringify(st, null, 2)}\n`);
    };
    const previousMinutes = process.env.SURETY_REAL_ACT_RECORD_MINUTES;
    process.env.SURETY_REAL_ACT_RECORD_MINUTES = '0';
    t.after(() => {
      if (previousMinutes === undefined) delete process.env.SURETY_REAL_ACT_RECORD_MINUTES;
      else process.env.SURETY_REAL_ACT_RECORD_MINUTES = previousMinutes;
    });

    // The rerun's run directory: its first attempt (F1's shape) holds the batched approval, the driver's
    // entries recorded, and halts. A first run's (its one attempt) sees the same acts: it runs inside it.
    const first = runCtx('first');
    const rerunDir = runCtx('rerun');
    const seqBefore = maxSeq();
    let firstRun = null;
    await assert.rejects(
      () =>
        m6lane.m6Step(rerunDir, name, async () => {
          firstRun = await m6lane.m6Step(first, name, async ({ startedAt }) => {
            const sinceSeq = maxSeq();
            await approveBatch(fx, d.ctx, d.batch);
            const found = m6lane.storeActs(fx.home, project, sinceSeq, named('first'));
            driverActs(first, found);
            driverActs(rerunDir, found);
            const recorded = await m6lane.recordActs(first, 'M519', name, { home: fx.home, project, sinceSeq, since: startedAt, named: named('first') });
            return { sinceSeq, startedAt, recorded };
          });
          throw new Error('M512 (k): the stand-in for F1, the step halted');
        }),
      /the stand-in for F1/,
    );
    assert.equal(readJson(join(rerunDir.runDir, 'state.json'), null)?.halted?.step, name, 'the first attempt halted the run directory');

    // (2) A first run: its record is the window its step passed, as before (no `window`), the combined approval in it.
    const old = m6lane.performers(first, m6lane.storeActs(fx.home, project, firstRun.sinceSeq, named('first')), firstRun.startedAt).map((a) => ({ ...a, step: name }));
    assert.deepEqual(stepActs(first), old, `a first run's act record is the one its window gives, as before (${JSON.stringify(stepActs(first).map((a) => [a.act, a.performer]))})`);
    assert.ok(stepActs(first).every((a) => !('window' in a)), 'a first run carries no window');
    const combinedFirst = stepActs(first).find((a) => a.act === 'combined_approval');
    assert.deepEqual([combinedFirst?.performer, sortedIds((combinedFirst?.items ?? []).map((i) => i.decision))], ['driver', batchIds], 'its combined approval: both decisions of the batch, the driver\'s');

    // The rerun (SURETY_REAL_RERUN=m6w_design): its own act only, the preview inspected again.
    rerun(rerunDir);
    const t2Seq = maxSeq();
    await m6lane.m6Step(rerunDir, name, async ({ startedAt }) => {
      const sinceSeq = maxSeq();
      driverActs(rerunDir, [{ act: 'preview_inspection', items: [{}] }]);
      return m6lane.recordActs(rerunDir, 'M519', name, { home: fx.home, project, sinceSeq, since: startedAt, named: named('rerun') });
    });
    const endSeq = maxSeq();
    // (1) The rerun's record covers both attempts: the first attempt's acts with their performers, and its own.
    const acts = stepActs(rerunDir);
    const combined = acts.find((a) => a.act === 'combined_approval');
    assert.ok(combined, `the combined approval of the first attempt is in the rerun's act record (${JSON.stringify(acts.map((a) => [a.act, a.performer]))})`);
    assert.deepEqual([combined.performer, sortedIds(combined.items.map((i) => i.decision))], ['driver', batchIds], 'both decisions, the driver\'s by his entries since the first attempt');
    for (const a of stepActs(first).filter((x) => x.act !== 'preview_inspection')) {
      const got = acts.find((x) => x.act === a.act);
      assert.ok(got, `the first attempt's ${a.act} recorded`);
      for (const i of a.items) assert.ok(got.items.some((x) => JSON.stringify(x) === JSON.stringify(i)), `${a.act}: its item ${JSON.stringify(i).slice(0, 200)}`);
    }
    const inspection = acts.find((a) => a.act === 'preview_inspection');
    assert.deepEqual(inspection?.items.map((i) => i.route), ['M512 (k) rerun'], 'the rerun\'s own act added');
    assert.equal(inspection?.performer, 'driver', 'its performer');
    assert.ok(acts.every((a) => a.window?.attempts?.length === 2), `each act carries the window of both attempts (${JSON.stringify(acts[0]?.window)})`);
    const attemptsOf = (ctx) => readJson(join(ctx.runDir, 'observed', 'step-attempts.json'), {})[name] ?? [];
    assert.equal(acts[0].window.performers_since, attemptsOf(rerunDir)[0]?.at, 'performers from the first attempt\'s start');
    assert.deepEqual(attemptsOf(rerunDir).map((a) => [typeof a.seq, typeof a.ended_seq]), [['number', 'number'], ['number', 'number']], 'both attempts kept with their sequences, start and end');
    assert.equal(attemptsOf(first).length, 1, "the first run's one attempt kept");

    // A run directory from before the attempts were kept (M519's ~/s6-1018): no step-attempts.json, the
    // last start only, and the rerun's record alone; the step before it ended before the first attempt.
    const legacy = runCtx('legacy');
    const t0 = atOf(seqBefore);
    const t2 = atOf(t2Seq);
    const tEnd = atOf(endSeq);
    writeFileSync(join(legacy.runDir, 'state.json'), `${JSON.stringify({ version: 1, steps: { m6w_qualify: { status: 'done', at: t0, value: {} }, [name]: { status: 'done', at: tEnd, value: {} } }, halted: { step: 'judge:M519 (c)', reason: 'the combined approval is in the per-act record', at: tEnd }, reruns_applied: [`1:${name}`] }, null, 2)}\n`);
    writeFileSync(join(legacy.runDir, 'observed', 'step-starts.json'), `${JSON.stringify({ [name]: t2 }, null, 2)}\n`);
    writeFileSync(join(legacy.runDir, 'observed', 'acts-M519.json'), `${JSON.stringify(acts.filter((a) => a.act === 'preview_inspection').map(({ window, ...a }) => a), null, 2)}\n`);
    // The driver's entries under the engine's clock, at each act (the store's answer times).
    for (const a of stepActs(first)) driverActs(legacy, [a], a.items[0].answered_at ?? t0);
    driverActs(legacy, [{ act: 'preview_inspection', items: [{}] }], tEnd);
    assert.equal(typeof m6lane.rebuildRerunActs, 'function', 'the harness rebuilds such a record (M519 F3)');
    const rebuilt = m6lane.rebuildRerunActs(legacy, 'M519', name, { project, named: () => named('rerun') });
    const legacyActs = stepActs(legacy);
    const lc = legacyActs.find((a) => a.act === 'combined_approval');
    assert.deepEqual([lc?.performer, sortedIds((lc?.items ?? []).map((i) => i.decision))], ['driver', batchIds], `rebuilt: the first attempt's combined approval, the driver's (${JSON.stringify(legacyActs.map((a) => [a.act, a.performer]))})`);
    assert.deepEqual(sortedIds(legacyActs.map((a) => a.act)), sortedIds(acts.map((a) => a.act)), 'the same acts as a directory that kept its attempts');
    assert.ok(legacyActs.every((a) => a.window?.attempts?.length === 2 && /inferred: .* m6w_qualify ended/.test(a.window.attempts[0].basis ?? '')), `the window inferred from the step before it, and said so (${JSON.stringify(legacyActs[0]?.window)})`);
    assert.equal(legacyActs[0].window.attempts[1].to_seq, withStore(fx.home, (db) => db.prepare('SELECT MAX("seq") AS n FROM "events" WHERE "at" <= ?').get(tEnd).n), 'bounded by the step\'s end (state.json)');
    assert.equal(rebuilt.length, legacyActs.length, 'returned as recorded');
    const kept = readFileSync(join(legacy.runDir, 'observed', 'acts-M519.json'), 'utf8');
    assert.equal(m6lane.rebuildRerunActs(legacy, 'M519', name, { project, named: () => named('rerun') }), null, 'rebuilt once: the attempts are now kept');
    assert.equal(readFileSync(join(legacy.runDir, 'observed', 'acts-M519.json'), 'utf8'), kept, 'the record unchanged by a second call');
    // A directory whose step was never rerun keeps its record (a first run's), and one whose first start is unknown is not rebuilt.
    assert.equal(m6lane.rebuildRerunActs(first, 'M519', name, { project }), null, 'a first run is not rebuilt');
    const unknown = runCtx('unknown');
    writeFileSync(join(unknown.runDir, 'state.json'), `${JSON.stringify({ version: 1, steps: { [name]: { status: 'done', at: tEnd, value: {} } }, halted: null, reruns_applied: [`1:${name}`] }, null, 2)}\n`);
    writeFileSync(join(unknown.runDir, 'observed', 'step-starts.json'), `${JSON.stringify({ [name]: t2 }, null, 2)}\n`);
    assert.equal(m6lane.rebuildRerunActs(unknown, 'M519', name, { project }), null, 'no step before it ended: unknown, not rebuilt');
    assert.match(JSON.stringify(readJson(join(unknown.runDir, 'observed', 'M519.json'), {})[`acts_not_rebuilt_${name}`] ?? null), /unknown/, 'and said so');
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

  test("(k) F33 (objection 209), a fix the engine can no longer move: two plain fixes left verifying (one held by a superseded candidate), nothing running, queued, asked or due: activity() names both stuck, never runnable; the stall judgement is silent and the engine-driven wait fails at once naming them, never at its deadline; the review's end fails at once naming them, an acknowledged question beside them or not, and ends only with nothing stuck; a pending check execution, an eligible item not held and a fix that cannot be judged are still counted", async (t) => {
    const fx = await scriptedEngine(t);
    // The run's state at its review step (F33), made through the engine's API (harness/checks/stuck-fix.mjs): the stage
    // verified, two owner `fix` dispositions on its candidate's findings naming `login`, required at alpha_authorize only
    // (no stage scope requires it: no evaluation the engine makes can judge them); fix 1's candidate verified and superseded
    // by fix 2's (which holds fix 1 by ancestry), verified; the engine ticked. Judged on a backup of the store with every
    // question about the fixes consumed: the run's engine asked none, and the engine of Sean's D-3 asks fix_unjudged (E180).
    const s = await supersededFix(fx, { defs: ALPHA_ONLY, required: ALPHA_ONLY_REQUIRED });
    const project = s.p.id;
    const ids = sortedIds(s.fixes.map((w) => w.id));
    await waitForIdle(fx.home, project);
    assert.deepEqual(s.fixes.map((w) => w.status), ['verifying', 'verifying'], 'the fixture is live: both fixes verifying');
    const snap = await observedCopy(fx, 'k-f33-observed', ids);
    const nowMs = engineTimeMs(fx.engine);
    const a = activity(snap, project, { nowMs });
    assert.deepEqual(
      { live: a.live, executions: a.executions, operations: a.operations, asked: a.asked },
      { live: [], executions: [], operations: [], asked: [] },
      "the fixture is live: nothing runs, is queued or is asked, as at the run's review step",
    );

    // Rule 25's "runnable" is what the engine can dispatch or is carrying; a verifying fix the engine can do nothing for
    // is neither runnable nor in flight (BS6 §4.1 rule 25; E162 item 1: pending engine work accounts, none is pending).
    const counted = a.runnable.filter((w) => ids.includes(w.id));
    assert.deepEqual(
      counted.map((w) => [w.id, w.kind, w.status]),
      [],
      `F33: activity() counts the verifying fixes ${counted.map((w) => w.id).join(', ')} as runnable although the engine can do nothing for them: no run, no pending check execution, no pending verification, no due gate and no repair due on any unsuperseded candidate holding them (the engine dispatches nothing for them at any tick), so the runner's stall judgement never fires and the review's end never comes: a stall masked as work (F19)`,
    );
    const stuck = a.stuck ?? [];
    assert.deepEqual(sortedIds(stuck.map((x) => x.id)), ids, `each is named stuck (${JSON.stringify(stuck)})`);
    const first = stuck.find((x) => x.id === s.fixes[0].id);
    assert.deepEqual([first.kind, first.status, first.finding], ['fix', 'verifying', s.findings[0].id], `fix 1 named with its kind, status and finding (${JSON.stringify(first)})`);
    assert.deepEqual(first.held_by, [s.c3.id], `held, by ancestry, by the one unsuperseded candidate (${JSON.stringify(first.held_by)})`);
    assert.deepEqual(first.own_candidates, [{ id: s.c2.id, superseded_by: s.c3.id }], `its own candidate, superseded (${JSON.stringify(first.own_candidates)})`);
    assert.ok(typeof first.why === 'string' && first.why.length > 0, `and why it is stuck (${first.why})`);
    const quiet = quietState(a);
    assert.equal(quiet.state, 'silent', `the stall judgement: silent, nothing runnable, in flight or asked (${JSON.stringify(quiet)})`);

    // The engine-driven wait (driveM6 with the stall check) on the backup, its ticks counted by a stand-in engine: it fails
    // at once naming them, three quiet rounds each after a tick, never its deadline.
    const calls = [];
    const standIn = { post: async (path) => (calls.push(`post ${path}`), { status: 200, body: {} }), get: async (path) => (calls.push(`get ${path}`), { status: 200, body: {} }) };
    let stalled = null;
    try {
      await m6lane.driveM6({ rehearsal: false }, { ...fx, home: snap, engine: standIn }, project, async () => undefined, { what: 'k_f33', stall: true, everyMs: 50, timeoutMs: 30_000 });
    } catch (err) {
      stalled = err;
    }
    assert.ok(stalled, 'the wait does not end');
    assert.match(stalled.message, /a silent stall \(BS6 §4\.1 rule 25\)/, `it fails as a silent stall (${stalled.message})`);
    assert.doesNotMatch(stalled.message, /not reached within/, 'not at its deadline');
    for (const id of ids) assert.ok(stalled.message.includes(id), `naming ${id} (${stalled.message})`);
    assert.ok(calls.filter((c) => c.startsWith('post') && c.endsWith('/tick')).length <= 3, `within three rounds (${JSON.stringify(calls)})`);

    // The review's end (its `done`): with the review confirmed and nothing running, queued or asked, the stuck fixes fail
    // it at once naming them (three quiet polls), never ended and never its deadline; an E179-acknowledged question beside
    // them changes nothing; with nothing stuck it ends, and its acts are judged after it as before (M535 (l), recordActs).
    assert.equal(typeof m6lane.reviewEndJudge, 'function', "the review's end judgement is the harness's own (exported for this case)");
    for (const [label, seen, excepted] of [
      ['nothing asked', a, new Set()],
      ['an E179-acknowledged question open', { ...a, asked: [{ id: 'dec_f33_acknowledged', kind: 'finding_disposition' }] }, new Set(['dec_f33_acknowledged'])],
    ]) {
      const judge = m6lane.reviewEndJudge('m6x_review');
      assert.equal(judge(seen, { confirmed: true, excepted }), false, `${label}: poll 1, the review not ended`);
      assert.equal(judge(seen, { confirmed: true, excepted }), false, `${label}: poll 2, the review not ended`);
      assert.throws(() => judge(seen, { confirmed: true, excepted }), (err) => /a silent stall/.test(err.message) && ids.every((id) => err.message.includes(id)), `${label}: poll 3, a silent stall naming both`);
    }
    const settled = m6lane.reviewEndJudge('m6x_review');
    assert.equal(settled({ ...a, stuck: [] }, { confirmed: true, excepted: new Set() }), true, 'nothing stuck, the review confirmed: it ends');
    const unconfirmed = m6lane.reviewEndJudge('m6x_review');
    assert.equal(unconfirmed({ ...a, stuck: [] }, { confirmed: false, excepted: new Set() }), false, 'not confirmed: not ended');
    const asking = m6lane.reviewEndJudge('m6x_review');
    for (let i = 0; i < 4; i++) assert.equal(asking({ ...a, asked: [{ id: 'dec_f33_open', kind: 'blocker' }] }, { confirmed: true, excepted: new Set() }), false, 'a question open beside them: the owner is asked, not a stall');

    // Genuinely live work is still counted. A check execution pending on the candidate holding them (requested on the
    // engine, judged on a backup): the fixes are in flight (the execution may judge them), the judgement busy.
    const { login: pending } = await operatorRequest(fx.engine, project, s.c3.id, ['login']);
    const withPending = activity(await observedCopy(fx, 'k-f33-pending', ids), project, { nowMs: engineTimeMs(fx.engine) });
    assert.deepEqual(withPending.executions.map((x) => x.id), [pending], 'the execution queued');
    assert.deepEqual(sortedIds(withPending.runnable.filter((w) => ids.includes(w.id)).map((w) => w.id)), ids, 'the fixes counted in flight while it is pending');
    assert.deepEqual(withPending.stuck ?? [], [], 'none stuck while it is pending');
    assert.equal(quietState(withPending).state, 'busy', 'busy');
    await recordExit(fx.engine, pending, 0, { output: 'login passed again\n' });
    await tick(fx.engine, project, { rounds: 2 });
    await waitForIdle(fx.home, project);
    assert.deepEqual(sortedIds((activity(await observedCopy(fx, 'k-f33-recorded', ids), project, { nowMs: engineTimeMs(fx.engine) }).stuck ?? []).map((x) => x.id)), ids, 'recorded, and nothing due after it: stuck again');
    // An eligible item not held (the project paused, so the engine dispatches nothing; the pause is not read): runnable.
    await pauseProject(fx.engine, project);
    const loose = await addWork(fx.engine, project, 'fix');
    const withLoose = activity(await observedCopy(fx, 'k-f33-loose', ids), project, { nowMs: engineTimeMs(fx.engine) });
    assert.ok(withLoose.runnable.some((w) => w.id === loose && w.status === 'eligible'), `an eligible item is runnable (${JSON.stringify(withLoose.runnable)})`);
    assert.ok(!(withLoose.stuck ?? []).some((x) => x.id === loose), 'never stuck');
    assert.equal(quietState(withLoose).state, 'busy', 'busy');
    // Unknown is never stuck: on a backup where the engine's predicate cannot read the holding candidate, the fixes are
    // counted, marked unknown.
    const broken = await observedCopy(fx, 'k-f33-unknown', ids);
    withStore(broken, (db) => db.prepare(`UPDATE "candidates" SET "held_work" = '{not json' WHERE "id" = ?`).run(s.c3.id), { readonly: false });
    const unknown = activity(broken, project, { nowMs: engineTimeMs(fx.engine) });
    const marked = unknown.runnable.filter((w) => ids.includes(w.id));
    assert.deepEqual(sortedIds(marked.map((w) => w.id)), ids, `the fixes counted when they cannot be judged (${JSON.stringify(unknown.runnable)})`);
    assert.ok(marked.every((w) => w.judged === 'unknown'), `marked unknown (${JSON.stringify(marked)})`);
    assert.deepEqual(unknown.stuck ?? [], [], 'never stuck');
  });

  test("(k) D-5 (objection 209; E180), stuck work at every step boundary: each step's rule-25 judgement records the fixes the engine can no longer move without changing an intermediate step's acceptance; the run's end (M535 (j)'s e179Record and e179RunEnd, M519 (h)'s runEndStuck) never passes with them, and passes as before with none", async (t) => {
    const fx = await scriptedEngine(t);
    const s = await supersededFix(fx, { defs: ALPHA_ONLY, required: ALPHA_ONLY_REQUIRED });
    const project = s.p.id;
    const ids = sortedIds(s.fixes.map((w) => w.id));
    await waitForIdle(fx.home, project);
    const snap = await observedCopy(fx, 'k-d5-stuck', ids);
    const nowMs = engineTimeMs(fx.engine);
    // Every step boundary: recorded, the intermediate step's acceptance unchanged (it does not fail for it).
    let value = null;
    let failed = null;
    try {
      value = ruleTwentyFive(snap, project, 'm6x_build', { handover: [], nowMs });
    } catch (err) {
      failed = err;
    }
    assert.equal(failed, null, `an intermediate step's acceptance is unchanged: its rule 25 does not fail for stuck work (${failed?.message})`);
    assert.deepEqual(
      sortedIds((value.stuck ?? []).map((x) => x.id)),
      ids,
      `D-5: the step's rule-25 value records the stuck work: the fixes ${ids.join(', ')} the engine can no longer move (value: ${JSON.stringify(Object.keys(value ?? {}))}, stuck ${JSON.stringify(value?.stuck)})`,
    );
    const entry = value.stuck.find((x) => x.id === s.fixes[0].id);
    assert.deepEqual([entry.kind, entry.status, entry.finding, entry.held_by], ['fix', 'verifying', s.findings[0].id, [s.c3.id]], `each named as activity() names it (${JSON.stringify(entry)})`);
    // The run's end: never passed with stuck work.
    const runDir = join(fx.root, 'k-d5-run');
    mkdirSync(join(runDir, 'observed'), { recursive: true, mode: 0o700 });
    const ctx = { runDir, keyValue: null, rehearsal: false };
    const rec = m6lane.e179Record(ctx, snap, project);
    assert.deepEqual(sortedIds((rec.stuck ?? []).map((x) => x.id)), ids, `M535 (j)'s record names the stuck work (${JSON.stringify(rec.stuck)})`);
    assert.deepEqual([rec.satisfied_as_written, rec.clean, rec.completed_under], [false, false, null], `not satisfied, not clean, not completed under E179 (${rec.statement})`);
    assert.throws(() => m6lane.e179RunEnd(ctx, 'M535', snap, project), (err) => ids.every((id) => err.message.includes(id)), "M535 (j)'s run end fails naming them");
    assert.equal(typeof m6lane.runEndStuck, 'function', "M519 (h)'s run-end check is the harness's own");
    assert.throws(() => m6lane.runEndStuck('M519', snap, project), (err) => ids.every((id) => err.message.includes(id)), "M519 (h)'s run end fails naming them");
    // With nothing stuck (the fixes completed, on a backup): recorded empty, and the run's end as before.
    const done = await observedCopy(fx, 'k-d5-done', ids);
    withStore(done, (db) => db.prepare(`UPDATE "work_items" SET "status" = 'complete' WHERE "id" IN (${ids.map(() => '?').join(', ')})`).run(...ids), { readonly: false });
    assert.deepEqual(ruleTwentyFive(done, project, 'm6x_build', { handover: [], nowMs }).stuck, [], 'nothing stuck: recorded empty');
    const clean = m6lane.e179Record(ctx, done, project);
    assert.deepEqual([clean.stuck, clean.satisfied_as_written, clean.clean], [[], true, true], `nothing stuck and nothing open: satisfied as written (${clean.statement})`);
    assert.doesNotThrow(() => m6lane.runEndStuck('M519', done, project), "M519 (h)'s run end passes with nothing stuck");
  });
});

// A backup of the engine's store in `fx.root/<tag>` (never the engine's home), every open question about the fixes
// `ids` consumed there: the run's state at its review step (F33), which the engine of Sean's D-3 no longer leaves
// unasked (E180). Returns the backup's home.
async function observedCopy(fx, tag, ids) {
  const snap = join(fx.root, tag);
  mkdirSync(snap, { recursive: true, mode: 0o700 });
  const src = openStore(storePath(fx.home), { readonly: true });
  try {
    await src.backup(join(snap, 'store.db'));
  } finally {
    src.close();
  }
  withStore(
    snap,
    (db) =>
      db
        .prepare(`UPDATE "decisions" SET "status" = 'consumed', "consumed_at" = ?, "answer" = ? WHERE "status" = 'open' AND "subject_id" IN (${ids.map(() => '?').join(', ')})`)
        .run(new Date().toISOString(), JSON.stringify({ option: 'retry', note: 'k-f33 backup', actor: 'human', at: new Date().toISOString() }), ...ids),
    { readonly: false },
  );
  return snap;
}

function DESIGN_DUE_OPTIONS(row) {
  return (row.options ?? []).map((o) => o.key).sort();
}
const designerRuns = (fx, project) => runsOfProject(fx.home, project).filter((r) => r.role === 'designer' && r.kind === 'session');
