// M437 (a), (b): order and dependencies (M5 slice 37; kernel lane). M5 plan
// §3.7 M437; D6-X04; D6 §6.4, §6.6; K2; B08; SEAM.md §§347, 438
//
// The reference project's phase 1 of three stages on the journey's own path
// (journey35: the production approvals, publication and authoring), stage 2
// depending on stage 1 and stage 3 on nothing; each stage's Builder scripted
// by its work item. Stage work carries the two milestones of §347
// (`authoring_ready`, `stage_code`); `work.dependency_met` † is the event
// the scheduler records when one is met: `subject.work_item`,
// `payload.milestone` (`authoring_ready` | `stage_code`), and for
// `stage_code` `payload.stage` (the stage depended on).
//   (a) while stage 1 builds, stage 2's stage-code milestone is unmet and
//       it has no run; at stage 1's integration (the active generation's)
//       the milestone is met while stage 1 is still `integrated`, not
//       `verified` (its Verifier held); the independent stage 3 has only
//       the authoring milestone, met at readiness, at once;
//   (b) a parked stage holds its undispatched dependant and not the others,
//       in both orders: parked before any integration; integrated, then
//       parked before the dependant was dispatched (the historical
//       integration releasing nothing: the scripted envelope keeps every
//       new domain out until the park); and the dependant already running
//       when stage 1 parks goes on.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { recordExit } from './harness/checks/selection.mjs';
import { executionRow } from './harness/checks/fixtures.mjs';
import { ROUTED_KINDS, builderScript, queuedExecutions } from './harness/journey/drive.mjs';
import { pumpHolding } from './harness/journey/change36.mjs';
import { runsOf } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import {
  clearEnvelope,
  dependencyMet,
  eventsNamed,
  heldBuilder,
  holding,
  setEnvelope,
  settle,
  stageRow,
  threeStages,
  workRow,
} from './harness/exec37/envelope.mjs';

const NO_PLAN = ROUTED_KINDS.filter((k) => k !== 'plan_approval');
const HELD_VERIFIER = { steps: [step.hold('gate', { heartbeat_ms: 250 }), step.result()] };
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
// Ticks answering the routed decisions, recording queued executions by `exits` (null leaves one queued).
const advance = (J, done, { exits = () => 0, what, max = 120 } = {}) =>
  pumpHolding(J.fx, J.ctx, done, { exits: (x) => exits(x), hold: (x) => exits(x) === null, answerKinds: NO_PLAN, what, max });
const integratedEvent = (home, item) => eventsNamed(home, 'work.integrated').find((e) => e.subject?.work_item === item);

describe('M437 order and dependencies', () => {
  test('(a) the dependant is eligible at its dependency\'s integration, not while it builds and not waiting for verified; the independent stage at once', async (t) => {
    const J = await threeStages(t, { scripts: { 1: heldBuilder(1), 3: builderScript(3) } });
    const { fx, p, plan, items } = J;
    fx.scripted.kindScript('verification', HELD_VERIFIER);
    // Stage 1 building (its Builder held).
    await advance(J, () => holding(fx, items[1]), { what: 'stage 1\'s Builder building' });
    assert.equal(runsOf(fx.home, items[2]).length, 0, 'while stage 1 builds, its dependant has no run');
    assert.ok(!dependencyMet(fx.home, items[2]).some((e) => e.payload?.milestone === 'stage_code'), 'and its stage-code milestone is not met');
    // The independent stage: the authoring milestone alone, met at readiness, at once.
    const met3 = dependencyMet(fx.home, items[3]);
    assert.deepEqual(met3.map((e) => e.payload?.milestone), ['authoring_ready'], `the independent stage 3: work.dependency_met † for authoring readiness only, at once (${JSON.stringify(met3.map((e) => e.payload))})`);
    const ready1 = dependencyMet(fx.home, items[1]).find((e) => e.payload?.milestone === 'authoring_ready');
    assert.ok(ready1, 'stage 1\'s authoring milestone met');
    assert.ok(Math.abs(met3[0].seq - ready1.seq) < 50, `stage 3's milestone met with stage 1's, at readiness (seq ${met3[0].seq} and ${ready1.seq})`);
    // Stage 1 integrates; its Verifier holds, so it stays `integrated`.
    fx.scripted.release(items[1], 'gate');
    const verifierHeld = await advance(J, () => fx.scripted.launches({ work_kind: 'verification' }).find((l) => fx.scripted.eventsOf(l.pid, 'holding').length > 0), { what: 'stage 1\'s Verifier running, held' });
    assert.ok(verifierHeld, 'the fixture is live: stage 1\'s Verifier holds');
    const s1 = stageRow(fx.home, plan.id, 1);
    assert.equal(s1.status, 'integrated', 'stage 1 integrated, not verified');
    const met = await advance(J, () => dependencyMet(fx.home, items[2]).find((e) => e.payload?.milestone === 'stage_code'), { what: 'stage 2\'s stage-code milestone met at stage 1\'s integration', exits: () => 0, max: 20 });
    assert.equal(met.payload?.stage, s1.id, `the milestone names stage 1 (${JSON.stringify(met.payload)})`);
    const integrated = integratedEvent(fx.home, items[1]);
    assert.ok(integrated && met.seq > integrated.seq, `met after stage 1's work.integrated (seq ${met.seq} > ${integrated?.seq})`);
    assert.equal(stageRow(fx.home, plan.id, 1).status, 'integrated', 'met while stage 1 is integrated, not verified (its Verifier still held): eligibility does not wait for verified');
    fx.scripted.release('all', 'gate');
  });

  test('(b) parked before any integration: the dependant stays held depends_on with no run; the independent stage builds', async (t) => {
    const J = await threeStages(t, { policy: { repair_attempts_max: 0 }, scripts: { 1: script.crash(), 3: builderScript(3) } });
    const { fx, p, items } = J;
    await advance(J, () => (workRow(fx.home, items[1])?.status === 'parked' ? true : undefined), { what: 'stage 1\'s work parked' });
    await advance(J, () => (runsOf(fx.home, items[3]).length > 0 ? true : undefined), { what: 'the independent stage 3 dispatched', max: 20 });
    await settle(fx, p.id, 3);
    assert.equal(runsOf(fx.home, items[2]).length, 0, 'the parked stage\'s dependant has no run');
    const w2 = workRow(fx.home, items[2]);
    assert.notEqual(w2.status, 'cancelled', 'the dependant is held, not cancelled');
    const open = (json(w2.held_intervals) ?? []).filter((h) => h.to === undefined || h.to === null);
    assert.ok(open.some((h) => h.reason === 'depends_on'), `its open hold interval names depends_on (work_items.held_intervals †; ${JSON.stringify(w2.held_intervals)})`);
  });

  test('(b) integrated, then parked before the dependant was dispatched: the historical integration releases nothing; the independent stage goes on', async (t) => {
    const J = await threeStages(t, { policy: { repair_attempts_max: 0 }, scripts: { 1: heldBuilder(1), 3: builderScript(3) } });
    const { fx, p, plan, items } = J;
    await advance(J, () => holding(fx, items[1]), { what: 'stage 1\'s Builder building' });
    // No new domain admitted until the park (the scripted envelope †).
    await setEnvelope(fx, { mem_available: 0, default_current: 0 });
    fx.scripted.release(items[1], 'gate');
    await advance(J, () => (workRow(fx.home, items[1])?.status === 'parked' ? true : undefined), {
      what: 'stage 1 integrated, accept-r1 failing on its candidate, its work parked',
      exits: (x) => (x.key === 'accept-r1' ? 1 : 0),
    });
    const s1 = stageRow(fx.home, plan.id, 1);
    assert.ok(s1.integrated_revision, `the fixture is live: stage 1 has its historical integration (${JSON.stringify(s1)})`);
    assert.equal(runsOf(fx.home, items[2]).length, 0, 'the fixture is live: the dependant was not dispatched before the park');
    await clearEnvelope(fx);
    await settle(fx, p.id, 4);
    await advance(J, () => (runsOf(fx.home, items[3]).length > 0 ? true : undefined), { what: 'the independent stage 3 dispatched once the envelope admits', max: 20, exits: (x) => (x.key === 'accept-r1' ? 1 : 0) });
    await settle(fx, p.id, 3);
    assert.equal(runsOf(fx.home, items[2]).length, 0, 'the parked stage\'s historical integration released nothing: the dependant has no run');
    assert.ok(stageRow(fx.home, plan.id, 1).parked_at || workRow(fx.home, items[1]).status === 'parked', 'stage 1 parked');
  });

  test('(b) the dependant already building when stage 1 parks goes on under the gates', async (t) => {
    const J = await threeStages(t, { policy: { repair_attempts_max: 0 }, scripts: { 1: builderScript(1), 2: heldBuilder(2), 3: builderScript(3) } });
    const { fx, plan, items } = J;
    // Stage 1 integrated, its checks left queued; stage 2's Builder dispatched and held.
    await advance(J, () => holding(fx, items[2]), { what: 'stage 2\'s Builder building on stage 1\'s integration', exits: (x) => (x.key === 'accept-r1' ? null : 0) });
    // accept-r1 fails on stage 1's candidate: stage 1 parks.
    for (const x of queuedExecutions(fx.home, J.p.id)) if (x.key === 'accept-r1' && executionRow(fx.home, x.id)?.status === 'queued') await recordExit(fx.engine, x.id, 1);
    await advance(J, () => (workRow(fx.home, items[1])?.status === 'parked' ? true : undefined), { what: 'stage 1\'s work parked', exits: (x) => (x.key === 'accept-r1' ? 1 : 0) });
    assert.ok(holding(fx, items[2]), 'the running dependant is not stopped by the park');
    fx.scripted.release(items[2], 'gate');
    await advance(J, () => runsOf(fx.home, items[2]).find((r) => r.state === 'ended'), { what: 'stage 2\'s run ended', exits: (x) => (x.key === 'accept-r1' ? 1 : 0), max: 40 });
    const [run2] = runsOf(fx.home, items[2]);
    assert.deepEqual([run2.outcome, run2.reason_class], ['completed', 'none'], `the dependant's run goes on to completion (${run2.reason_text})`);
    assert.ok(['integrated', 'verified'].includes(stageRow(fx.home, plan.id, 2).status), `stage 2 integrated under the gates (${stageRow(fx.home, plan.id, 2).status})`);
  });
});
