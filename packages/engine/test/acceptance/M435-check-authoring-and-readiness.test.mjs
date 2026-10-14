// M435, check authoring per phase and readiness (slice 37; kernel lane). M5
// plan §3.7 M435 (a), (b), (d); D6-W04; D6 §6.2; F §3.10.3, §5.1; reading 4;
// B07, N01 (HoldReason `authoring_readiness`), N04; D6 C.2 K7 (M13 to M18:
// cancellation of new one-shot work); SEAM.md §§351, 428
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
    // N01: the hold is an interval recorded with its reason (SEAM.md §428; Q3: work.hold_began / work.hold_ended).
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

  test('(d) the run complete and the proposal not captured, then captured and unapplied: no readiness, no Builder; applied: readiness by that version, then the Builders', async (t) => {
    const { fx, p, ctx, plan } = await pausedDeveloping(t);
    await armBarrier(fx.engine, 'check_authoring.before_proposal', 'pause');
    await armBarrier(fx.engine, 'check_authoring.applied', 'pause');
    await go(fx, p);
    // Held before the proposal's capture: the Verifier's run has done its work.
    await round(fx, ctx).catch(() => null);
    await waitFor(() => barrierWaiting(fx, 'check_authoring.before_proposal'), { what: 'the engine to wait at check_authoring.before_proposal', timeoutMs: 60_000 });
    assert.equal(proposalRows(fx.home, p.id).length, 0, 'no proposal captured yet');
    assert.equal(planRow(fx.home, plan.id).authoring_ready_at ?? null, null, 'no readiness at the run\'s completion');
    assert.deepEqual(builderRuns(fx.home, p.id), [], 'no Builder');
    await release(fx, 'check_authoring.before_proposal');
    // Captured, unapplied: the owner's decision open.
    const open = await until(fx, ctx, () => openAuthoringDecision(fx, p), { what: 'the proposal captured and routed' });
    for (let i = 0; i < 3; i++) await round(fx, ctx);
    assert.equal(planRow(fx.home, plan.id).authoring_ready_at ?? null, null, 'a captured, unapplied proposal establishes no readiness');
    assert.deepEqual(builderRuns(fx.home, p.id), [], 'no Builder while the proposal is unapplied');
    // Applied: held after the version's transaction.
    await consume(fx, p.id, decision(fx.home, open.id), 'approve');
    await waitFor(
      async () => {
        if (await barrierWaiting(fx, 'check_authoring.applied')) return true;
        await tick(fx.engine, p.id, { rounds: 1 }).catch(() => null);
        return undefined;
      },
      { what: 'the engine to wait at check_authoring.applied', timeoutMs: 60_000 },
    );
    const row = planRow(fx.home, plan.id);
    const version = protectedVersionsOf(fx.home, p.id).at(-1);
    assert.ok(row.authoring_ready_at, 'readiness recorded with the application');
    assert.equal(row.authoring_ready_by, version.id, `readiness is the applied protected version (${row.authoring_ready_by} vs ${version.id})`);
    assert.deepEqual(builderRuns(fx.home, p.id), [], 'no Builder yet at the barrier');
    await release(fx, 'check_authoring.applied');
    await until(fx, ctx, () => builderRuns(fx.home, p.id)[0], { what: 'the Builders after readiness' });
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
