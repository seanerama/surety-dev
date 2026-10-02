// M58, aging and notification ambiguity (slice 5). Plan §3.5 M58; D1 §§2.5,
// 3.5, 8.1 step 6, 10.4, D1-06, D1-14; RN §4; E9; build spec §8; SEAM.md §82.
//
// A decision left open past its target is escalated once per generation:
// `escalated_at` is set and one notification intent is recorded, in one
// transaction. Delivery is a separate attempt, and an attempt whose outcome
// the engine does not know is never simply repeated: the engine asks the
// channel what it has, resends only what is positively absent, and reports
// `unknown` when the channel cannot say.
//
// The channel is the scripted sink, a local program the test owns
// (harness/scripted/notify.mjs): no email, Webex or webhook is used. The
// decision's age is moved with the controlled clock. The two kill cases
// restart an engine whose clock was moved: what was escalated stays
// escalated, which is all they rely on.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decision, installSink, notificationIntents, openDecision, sinkLog, untilKilled } from './harness/decisions.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { armBarrier, changePolicy, eventsOfType } from './harness/journal.mjs';
import { addWork, advanceClock, scriptedEngine, tick, tickUntil, workItem } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';

const TARGET = 300; // seconds: the shortest target the configuration allows

// Work parked behind a blocker whose time-to-decision target is five
// minutes, in an engine whose notification channel is the scripted sink.
async function agingBlocker(t, sink) {
  const fx = await scriptedEngine(t, { config: { decision_targets: { blocker: TARGET } } });
  installSink(fx, sink);
  const project = (await addGitProject(fx)).id;
  await changePolicy(fx.engine, project, { repair_attempts_max: 0 });
  const item = await addWork(fx.engine, project, 'review');
  fx.scripted.script(item, [script.crash()]);
  await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'parked', { what: 'the work to be parked' });
  const blocker = await openDecision(fx, project, 'blocker', item);
  assert.deepEqual([blocker.target_seconds, blocker.escalated_at], [TARGET, null], 'the fixture is live: a five-minute target, not yet escalated');
  return { fx, project, blocker };
}

const deliveries = (fx) => sinkLog(fx).filter((entry) => entry.event === 'deliver');
const escalations = (fx, blocker) => eventsOfType(fx.home, 'decision.escalated').filter((event) => event.subject.decision === blocker.id).length;
const intentStatus = (fx, project) => notificationIntents(fx.home, project).map((intent) => intent.status);
const settled = (fx, project, status) => tickUntil(fx.engine, project, () => notificationIntents(fx.home, project)[0]?.status === status, { max: 6, what: `the notification intent to be ${status}` });

describe('M58 a decision past its target is escalated once, and an ambiguous delivery is never blindly repeated', () => {
  test('past its target the decision is escalated once and its notification is delivered once, however much more time passes', async (t) => {
    const { fx, project, blocker } = await agingBlocker(t);
    await tick(fx.engine, project);
    assert.deepEqual([decision(fx.home, blocker.id).escalated_at, intentStatus(fx, project)], [null, []], 'within its target nothing is escalated');

    await advanceClock(fx.engine, TARGET + 100);
    await settled(fx, project, 'delivered');
    const escalated = decision(fx.home, blocker.id);
    assert.ok(escalated.escalated_at, 'the decision is marked escalated');
    assert.equal(escalated.status, 'open', 'and is still open');
    assert.deepEqual(notificationIntents(fx.home, project).map((intent) => intent.source.decision), [blocker.id], 'one notification intent, for that decision');
    assert.deepEqual(deliveries(fx).map((entry) => [entry.decision, entry.outcome]), [[blocker.id, 'delivered']], 'the sink received it once');

    await advanceClock(fx.engine, TARGET + 100);
    await tick(fx.engine, project);
    await tick(fx.engine, project);
    assert.deepEqual([intentStatus(fx, project), deliveries(fx).length, escalations(fx, blocker)], [['delivered'], 1, 1], 'one escalation for one generation of the decision');
  });

  test('the engine is killed before the delivery: after the restart it asks the sink, finds nothing, and delivers once', async (t) => {
    const { fx, project, blocker } = await agingBlocker(t);
    await armBarrier(fx.engine, 'notify.before_delivery', 'kill');
    await advanceClock(fx.engine, TARGET + 100);
    await untilKilled(fx, project);
    assert.deepEqual([notificationIntents(fx.home, project).length, intentStatus(fx, project).includes('delivered'), deliveries(fx).length], [1, false, 0], 'the intent is durable and nothing has been delivered');

    await fx.start();
    await settled(fx, project, 'delivered');
    const calls = sinkLog(fx).map((entry) => [entry.event, entry.outcome]);
    assert.deepEqual([calls[0], calls.at(-1), deliveries(fx).length], [['lookup', 'absent'], ['deliver', 'delivered'], 1], `it reconciled first: a lookup that found nothing, then one delivery (sink calls: ${JSON.stringify(calls)})`);
    assert.deepEqual([intentStatus(fx, project), escalations(fx, blocker)], [['delivered'], 1]);
  });

  test('the engine is killed after the delivery and before its receipt: after the restart it asks the sink, finds the delivery, and does not send again', async (t) => {
    const { fx, project, blocker } = await agingBlocker(t);
    await armBarrier(fx.engine, 'notify.delivered', 'kill');
    await advanceClock(fx.engine, TARGET + 100);
    await untilKilled(fx, project);
    assert.deepEqual([deliveries(fx).length, intentStatus(fx, project).includes('delivered')], [1, false], 'the sink has the notification and the store has no receipt of it');

    await fx.start();
    await settled(fx, project, 'delivered');
    assert.equal(deliveries(fx).length, 1, 'it was not delivered a second time');
    assert.ok(sinkLog(fx).some((entry) => entry.event === 'lookup' && entry.outcome === 'found'), 'the receipt was reconstructed from what the sink holds');
    assert.equal(escalations(fx, blocker), 1);
  });

  test('the sink cannot confirm the delivery and cannot be asked: the intent is reported unknown and is not sent again, by later ticks or by a restart', async (t) => {
    const { fx, project } = await agingBlocker(t, { deliver: 'unknown', lookup: 'unknown' });
    await advanceClock(fx.engine, TARGET + 100);
    await settled(fx, project, 'unknown');
    assert.equal(eventsOfType(fx.home, 'notification.unknown').length >= 1, true, 'the unknown outcome is reported');
    await tick(fx.engine, project);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, project);
    await tick(fx.engine, project);
    assert.deepEqual([deliveries(fx).length, intentStatus(fx, project)], [1, ['unknown']], 'one attempt was made; an ambiguous delivery is not repeated');
  });
});
