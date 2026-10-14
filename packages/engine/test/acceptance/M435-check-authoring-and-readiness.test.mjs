// M435, check authoring per phase and readiness (slice 37; kernel lane). M5
// plan §3.7 M435 (a), (b), (d); D6-W04; D6 §6.2; F §3.10.3, §5.1; reading 4;
// B07, N01 (HoldReason `authoring_readiness`), N04; D6 C.2 K7 (M13 to M18:
// cancellation of new one-shot work); SEAM.md §§351, 439
//
// The reference project published with its project paused, so that nothing
// of the plan is dispatched before the case has scripted the authoring run
// and armed its barriers (`harness/exec37/authoring.mjs`), then resumed.
//   (a) stage work's `authoring_ready` milestone is unmet until the phase's
//       readiness holds: each stage item is held with the hold reason
//       `authoring_readiness` (`work.hold_began` †), no Builder launches; the
//       hold ends and the first Builder launches only after
//       `phase.authoring_ready` (by event order, never by timestamps);
//   (b) the authoring package (the role's context dump): the plan's stages
//       with `implements` and `validation`, the module map's `interfaces`,
//       the architecture's text, the environments, the authoring result
//       schema with its governed-change permissions (`governed_changes`,
//       `check_commands`, `deferred_criteria`) and the sentence "a proposal
//       grants no execution authority", as text a test finds;
//   (d) the Verifier run complete and its proposal not yet captured (held at
//       `check_authoring.before_proposal` †), then captured and unapplied (the
//       human's decision open): no readiness, no Builder; applied (held at
//       `check_authoring.applied` †): readiness set by that protected version
//       in the transaction that made it effective, still no Builder; then the
//       Builders run. Rejected: no readiness, and the item's repair (a second
//       authoring run) or its blocker; never a Builder. The K7 straddle: the
//       authoring run stopped by the owner leaves its item `held`, no
//       readiness, no Builder.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume, decision } from './harness/decisions.mjs';
import { armBarrier } from './harness/journal.mjs';
import { protectedVersionsOf, stagesOfPlan, workOf } from './harness/journey/drive.mjs';
import { packageOf } from './harness/sessions.mjs';
import { barrierWaiting, release } from './harness/session-lane.mjs';
import { waitFor } from './harness/engine.mjs';
import { stopRun, tick, waitForRunState } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import {
  DUMP,
  authoringItems,
  authoringRuns,
  authoringWith,
  builderRuns,
  eventsOfProject,
  go,
  openOf,
  pausedDeveloping,
  planRow,
  proposalRows,
  round,
  until,
} from './harness/exec37/authoring.mjs';

const UNCLASSIFIABLE = 'check_correction_unclassifiable';
const openAuthoringDecision = (fx, p) => openOf(fx.home, p.id, UNCLASSIFIABLE)[0];
const stageItems = (fx, p) => workOf(fx.home, p.id, 'stage_build');

describe('M435 check authoring per phase and readiness', () => {
  test('(a) stage work held on authoring_readiness until the applied version; no Builder before; the hold ends after phase.authoring_ready', async (t) => {
    const { fx, p, ctx, plan } = await pausedDeveloping(t);
    await go(fx, p);
    const open = await until(fx, ctx, () => openAuthoringDecision(fx, p), { what: 'phase 1\'s toolchain proposal routed to the owner' });
    // Captured and unapplied: the milestone unmet, nothing built.
    await round(fx, ctx);
    await round(fx, ctx);
    assert.equal(planRow(fx.home, plan.id).authoring_ready_at ?? null, null, 'no readiness while the proposal awaits the owner');
    assert.deepEqual(builderRuns(fx.home, p.id), [], 'no Builder before readiness');
    for (const w of stageItems(fx, p)) {
      assert.ok((w.depends_on ?? []).some((d) => d.milestone === 'authoring_ready' && d.phase_plan === plan.id), `stage work depends on the phase's authoring readiness (${JSON.stringify(w.depends_on)})`);
      assert.equal(w.status, 'eligible', 'stage work stays eligible, undispatched');
    }
    // N01: the hold is an interval recorded with its reason (SEAM.md §439; Q3: work.hold_began / work.hold_ended).
    const began = eventsOfProject(fx.home, 'work.hold_began', p.id);
    for (const w of stageItems(fx, p)) {
      assert.ok(
        began.some((e) => e.subject?.work_item === w.id && e.payload?.reason === 'authoring_readiness'),
        `stage item ${w.id} has a hold interval begun with reason authoring_readiness (work.hold_began †) (${JSON.stringify(began.map((e) => [e.subject?.work_item, e.payload?.reason]))})`,
      );
    }
    // The owner approves the toolchain proposal: applied, ready, Builders.
    await consume(fx, p.id, decision(fx.home, open.id), 'approve');
    await until(fx, ctx, () => builderRuns(fx.home, p.id)[0], { what: 'the first Builder after readiness' });
    const [ready] = eventsOfProject(fx.home, 'phase.authoring_ready', p.id);
    assert.ok(ready, 'phase.authoring_ready emitted');
    const firstBuilder = builderRuns(fx.home, p.id)[0];
    const created = eventsOfProject(fx.home, 'run.created', p.id).find((e) => e.subject?.run === firstBuilder.id);
    assert.ok(created && created.seq > ready.seq, `the first Builder's run was created after phase.authoring_ready (run.created ${created?.seq}, ready ${ready.seq})`);
    const ended = eventsOfProject(fx.home, 'work.hold_ended', p.id).filter((e) => e.payload?.reason === 'authoring_readiness');
    for (const w of stageItems(fx, p)) {
      const e = ended.find((x) => x.subject?.work_item === w.id);
      assert.ok(e && e.seq >= ready.seq, `stage item ${w.id}'s authoring_readiness hold ended at or after readiness (work.hold_ended †) (${JSON.stringify(e ?? null)})`);
    }
  });

  test('(b) the authoring package states the plan, the interfaces, the architecture, the environments, the result schema with its governed-change permissions, and that a proposal grants no execution authority', async (t) => {
    const { fx, p, ctx } = await pausedDeveloping(t);
    fx.scripted.kindScript('check_authoring', [authoringWith(1, { before: [DUMP] })]);
    await go(fx, p);
    await until(fx, ctx, () => openAuthoringDecision(fx, p), { what: 'the authoring run to end with its proposal' });
    const [run] = authoringRuns(fx.home, p.id);
    const pkg = packageOf(fx, run.id);
    assert.ok(pkg, 'the authoring Verifier dumped its package');
    const text = Object.values(pkg).filter((x) => typeof x === 'string').join('\n');
    const expected = {
      'the stages with implements': /"implements"/.test(text) && text.includes('the sum library') && text.includes('the service'),
      'the stages with validation': /"validation"/.test(text) && text.includes('R2.2'),
      'the module map\'s interfaces': text.includes('sum-route') && text.includes('stats-route') && text.includes('src/sum.mjs'),
      'the architecture\'s text': text.includes('Tally: architecture'),
      'the environments': /\balpha\b/.test(text) && text.includes('local_service'),
      'the authoring result schema: governed_changes': text.includes('governed_changes'),
      'the authoring result schema: check_commands permission': text.includes('check_commands'),
      'the authoring result schema: deferred_criteria': text.includes('deferred_criteria'),
      'the sentence that a proposal grants no execution authority': /a proposal grants no execution authority/i.test(text),
    };
    const missing = Object.entries(expected).filter(([, ok]) => !ok).map(([what]) => what);
    assert.deepEqual(missing, [], `the phase-authoring package (N04) lacks: ${missing.join('; ')} (files: ${Object.keys(pkg).join(', ')})`);
  });

  // The slice-37 review (SEAM.md §449): observed, not true by construction.
  // A barrier held in the engine holds its selection too, so "no Builder while
  // held at a barrier" proves nothing; here the scheduler runs freely. The
  // first phase's proposal is unclassifiable and waits for the owner: while it
  // is captured and unapplied, rounds of ticks run and no Builder launches.
  // The rest is read from the recorded events: the authoring run's end and
  // the proposal's capture precede `phase.authoring_ready`, which precedes
  // every Builder's `run.created`; readiness is the applied version.
  test('(d) the run complete, then the proposal captured and unapplied with the scheduler running: no readiness, no Builder; applied: readiness by that version, and every Builder after it', async (t) => {
    const { fx, p, ctx, plan } = await pausedDeveloping(t);
    await go(fx, p);
    // Captured, unapplied: the owner's decision open, the scheduler not held.
    const open = await until(fx, ctx, () => openAuthoringDecision(fx, p), { what: 'the proposal captured and routed' });
    const [authoring] = authoringRuns(fx.home, p.id);
    assert.ok(authoring && authoring.state === 'ended', `the fixture is live: the Verifier's run has ended (${JSON.stringify(authoring)})`);
    for (let i = 0; i < 4; i++) await round(fx, ctx);
    assert.equal(planRow(fx.home, plan.id).authoring_ready_at ?? null, null, 'a run complete and its proposal captured, unapplied: no readiness');
    assert.deepEqual(builderRuns(fx.home, p.id), [], 'no Builder while the proposal is unapplied, the scheduler running');
    // Applied by the owner's approval.
    await consume(fx, p.id, decision(fx.home, open.id), 'approve');
    await until(fx, ctx, () => builderRuns(fx.home, p.id)[0], { what: 'the Builders after readiness' });
    const row = planRow(fx.home, plan.id);
    const version = protectedVersionsOf(fx.home, p.id).at(-1);
    assert.ok(row.authoring_ready_at, 'readiness recorded with the application');
    assert.equal(row.authoring_ready_by, version.id, `readiness is the applied protected version (${row.authoring_ready_by} vs ${version.id})`);
    const seqOf = (type, pred) => eventsOfProject(fx.home, type, p.id).filter(pred).map((e) => e.seq);
    const ended = seqOf('run.ended', (e) => e.subject?.run === authoring.id);
    const proposed = seqOf('protected.proposed', () => true);
    const ready = seqOf('phase.authoring_ready', (e) => JSON.stringify(e).includes(plan.id));
    const builders = builderRuns(fx.home, p.id).map((r) => seqOf('run.created', (e) => e.subject?.run === r.id)[0]);
    const order = { ended, proposed, ready, builders };
    assert.ok(ended.length === 1 && proposed.length >= 1 && ready.length === 1, `the fixture is live: each recorded (${JSON.stringify(order)})`);
    assert.ok(ended[0] < ready[0] && proposed[0] < ready[0], `readiness after the run's end and the proposal's capture, not at either (${JSON.stringify(order)})`);
    assert.ok(builders.every((seq) => Number.isInteger(seq) && seq > ready[0]), `every Builder created after phase.authoring_ready (${JSON.stringify(order)})`);
  });

  test('(d) rejected: no readiness; the item\'s repair or its blocker; never a Builder', async (t) => {
    const { fx, p, ctx, plan } = await pausedDeveloping(t);
    await go(fx, p);
    const open = await until(fx, ctx, () => openAuthoringDecision(fx, p), { what: 'the proposal routed to the owner' });
    await consume(fx, p.id, decision(fx.home, open.id), 'reject');
    const [item] = authoringItems(fx.home, p.id);
    const outcome = await until(
      fx,
      ctx,
      () => {
        const runs = authoringRuns(fx.home, p.id).filter((r) => r.work_item === item.id);
        if (runs.length > 1) return { repair: runs.at(-1) };
        const blocker = openOf(fx.home, p.id, 'blocker').find((d) => d.subject_id === item.id);
        return blocker ? { blocker } : undefined;
      },
      { what: 'the rejected authoring item repaired or parked with a blocker', max: 12 },
    );
    assert.ok(outcome.repair || outcome.blocker, 'repair or blocker');
    assert.equal(planRow(fx.home, plan.id).authoring_ready_at ?? null, null, 'a rejected proposal establishes no readiness');
    assert.deepEqual(builderRuns(fx.home, p.id), [], 'no Builder after the rejection');
  });

  test('(d), K7: the authoring run stopped by the owner: its item held, no readiness, no Builder', async (t) => {
    const { fx, p, ctx, plan } = await pausedDeveloping(t);
    fx.scripted.kindScript('check_authoring', [{ steps: [step.hold('gate', { heartbeat_ms: 250 })], on_term: 'exit' }]);
    await go(fx, p);
    await tick(fx.engine, p.id, { rounds: 2 });
    const [item] = authoringItems(fx.home, p.id);
    await fx.scripted.waitForHolding({ work_item: item.id });
    const [run] = authoringRuns(fx.home, p.id);
    await stopRun(fx.engine, p.id, run.id);
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 60_000 });
    for (let i = 0; i < 3; i++) await round(fx, ctx);
    assert.equal(authoringItems(fx.home, p.id).find((w) => w.id === item.id).status, 'held', 'the stopped authoring item is held');
    assert.equal(planRow(fx.home, plan.id).authoring_ready_at ?? null, null, 'no readiness');
    assert.deepEqual(builderRuns(fx.home, p.id), [], 'no Builder');
    assert.ok(stagesOfPlan(fx.home, plan.id).every((s) => s.status === 'planned'), 'every stage still planned');
  });
});
