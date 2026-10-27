// M554, WA-recover: a turn under way when the engine is killed (UI1 slice
// 48; the assistant design of 2026-10-27, §1.3 step 3, §4's last row; D1
// §§16.1, 16.2; E184; the usability batch, the driver's shape of
// 2026-10-27; SEAM.md §§567, 568, 570).
//
//   (a) Sandbox lane. The engine is SIGKILLed while a turn runs (its usage
//       observed, its backend holding). At the next start recovery
//       establishes the turn's domain terminated (no process of it is left),
//       ends the turn `recovered` (observations dispatch_started, launched,
//       unknown), and writes its one ledger row: what it observed and the
//       turn limit less that as the unknown allowance. Nothing is replayed:
//       no second launch, no second receipt, the reservation released.
//   (b) NEW BEHAVIOUR (the usability batch; Builder's branch
//       `build/assistant-usability`). EXPECTED TO FAIL on engine main
//       600b6e88, where the owner's message of a recovered turn stays
//       `unknown`. Once recovery has concluded, the owner's message is
//       `status: "interrupted"` with `error.code: "assistant_interrupted"`
//       and `error.outcome: "recovered"`; its usage is what recovery charged
//       (`charged: true`, the row's counts and allowance); there is no
//       assistant message for it; and the conversation accepts a new
//       message under a new intent_id, which is admitted and completes.
//   (c) Kernel lane (the engine's scripted boundary, after a sandbox-lane
//       qualification). A kernel-lane turn completes (the scripted
//       boundary's path is live); then the engine is killed at the pause
//       point `assistant.before_spawn`, after the turn was dispatched and
//       before anything was spawned. At the next start the turn is ended
//       `refused` (reason `recovered`): nothing ran, so no ledger row, no
//       launch, the reservation released, never replayed. EXPECTED TO FAIL
//       until the seam can arm `assistant.before_spawn` (objection 215: the
//       pause point is reached in invoke/assistant-turn.ts but is not one of
//       the seam's barrier names, so neither --harness-barrier nor POST
//       /v1/harness/barriers accepts it).
//
// The scripted backend stands in for a real provider; no model is called.
// The engine is killed through its own child handle, by pid (engine.mjs).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BLOCK,
  KEY_REF,
  TEST_KEY,
  accountView,
  allowanceOf,
  ask,
  askAndSettle,
  assistantLaunches,
  assistantScripts,
  conversation,
  counts,
  domainOfTurn,
  hold,
  messagesOf,
  newConversation,
  readyAssistant,
  receipts,
  reply,
  restartAssistant,
  rowsOf,
  statusesOf,
  turnOf,
  waitTurn,
} from './harness/assistant.mjs';
import { waitFor } from './harness/engine.mjs';
import { holdSecret } from './harness/records.mjs';
import { withStore } from './harness/store.mjs';

const usageSeen = (home, invocation) => withStore(home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "usage_observations" WHERE "invocation" = ?').get(invocation).n > 0);

// A turn running with its usage observed (1,000 in, 10 out), its backend
// holding; then the engine SIGKILLed and started again. Returns what the
// test reads after the restart.
async function killedMidTurn(t) {
  const ready = await readyAssistant(t);
  const { fx } = ready;
  assistantScripts(fx, [{ steps: [counts(1_000, 10), hold('killed')], on_term: 'exit' }, { steps: [counts(200, 20), reply('After the restart.')] }]);
  const conv = await newConversation(fx);
  const pending = ask(fx, conv, 'm554-k').catch((err) => ({ error: String(err) }));
  const turn = await waitTurn(fx, 'm554-k', { status: null });
  await waitFor(() => usageSeen(fx.home, turn.invocation), { timeoutMs: 60_000, what: 'the turn\'s usage observed' });
  const launch = fx.scripted.launches({ invocation: turn.invocation })[0];
  assert.ok(launch, 'the fixture is live: the turn launched');
  assert.equal(turnOf(fx.home, 'm554-k').status, 'running', 'and is running when the engine is killed');
  await restartAssistant(fx, { killed: true });
  await pending;
  const ended = await waitTurn(fx, 'm554-k', { timeoutMs: 120_000 });
  return { ...ready, conv, turn: ended, launch };
}

describe('M554 a turn under way when the engine is killed', () => {
  test('(a) recovered at the next start: the domain terminated, the turn recovered, one row with the allowance, nothing replayed', async (t) => {
    const { fx, turn, launch } = await killedMidTurn(t);
    assert.deepEqual([turn.status, turn.outcome, turn.reason], ['ended', 'recovered', 'recovered'], `the turn's end (${JSON.stringify(turn)})`);
    assert.deepEqual(statusesOf(fx.home, turn.invocation), ['dispatch_started', 'launched', 'unknown'], 'its observations');
    assert.equal(domainOfTurn(fx.home, turn.invocation)?.status, 'terminated', 'its domain is terminated');
    assert.equal(fx.scripted.isLive(launch), false, 'no process of it is left');
    const rows = rowsOf(fx.home, turn.invocation);
    assert.equal(rows.length, 1, 'one row');
    assert.deepEqual(
      [rows[0].billable_in, rows[0].out, rows[0].usage_complete, rows[0].cost_status, rows[0].unknown_allowance_tokens],
      [1_000, 10, 0, 'unknown', BLOCK.turn_limit_billable_tokens - 1_010],
      `what it observed, and the turn limit less that as the allowance (${JSON.stringify(rows[0])})`,
    );
    await new Promise((r) => setTimeout(r, 3_000));
    assert.equal(fx.scripted.launches({ invocation: turn.invocation }).length, 1, 'never launched again');
    assert.equal(receipts(fx.home).length, 1, 'no second receipt');
    const a = await accountView(fx);
    assert.deepEqual([a.reserved, a.turns_under_way, a.used_known, allowanceOf(a)], [0, 0, 1_010, 38_990], `the reservation released; the charge counted (${JSON.stringify(a)})`);
  });

  test('(b) NEW BEHAVIOUR (fails on 600b6e88): the owner message is interrupted, assistant_interrupted, outcome recovered, with the recovered charge and no reply; the conversation accepts a new intent', async (t) => {
    const { fx, conv, turn } = await killedMidTurn(t);
    const row = rowsOf(fx.home, turn.invocation)[0];
    const m = await waitFor(
      async () => {
        const got = messagesOf(await conversation(fx, conv), 'm554-k');
        return got.owner && got.owner.status !== 'running' && got.owner.status !== 'unknown' ? got : undefined;
      },
      { timeoutMs: 30_000, what: 'the owner message to record the recovery (it stays unknown on 600b6e88)' },
    );
    assert.equal(m.owner.status, 'interrupted', `status interrupted (${JSON.stringify(m.owner)})`);
    assert.deepEqual([m.owner.error?.code, m.owner.error?.outcome], ['assistant_interrupted', 'recovered'], `the error (${JSON.stringify(m.owner.error)})`);
    assert.ok(m.owner.error?.reason && m.owner.error?.what_to_do, 'it explains itself');
    const u = m.owner.usage;
    assert.equal(u?.charged, true, `the usage is the recovered charge (${JSON.stringify(u)})`);
    assert.deepEqual(
      [u.input_tokens, u.output_tokens, u.unknown_allowance_tokens, u.cost_status, u.usage_complete],
      [row.billable_in, row.out, row.unknown_allowance_tokens, row.cost_status, false],
      `the usage is the row's (${JSON.stringify(u)}; row ${JSON.stringify(row)})`,
    );
    assert.equal(m.reply, null, 'no assistant message for it');
    const next = await askAndSettle(fx, conv, 'm554-k2');
    assert.ok([200, 202].includes(next.res.status), `a new intent is accepted (${next.res.status} ${next.res.text})`);
    assert.deepEqual([next.turn?.outcome, next.owner?.status], ['completed', 'completed'], `and completes (${JSON.stringify(next.turn)})`);
  });

  test('(c) kernel lane: a turn completes on the scripted boundary; one killed at assistant.before_spawn is ended refused at the next start, nothing charged or launched, never replayed (needs objection 215)', async (t) => {
    const { fx } = await readyAssistant(t);
    await restartAssistant(fx, { kernel: true });
    assistantScripts(fx, [{ steps: [counts(300, 30), reply('From the kernel lane.')] }, { steps: [reply('never launched')] }]);
    const conv = await newConversation(fx);
    const done = await askAndSettle(fx, conv, 'm554-c1');
    assert.equal(done.turn?.outcome, 'completed', `the kernel lane's path completes a turn (${JSON.stringify(done.turn)})`);
    const launchesBefore = assistantLaunches(fx).length;
    assert.equal(domainOfTurn(fx.home, done.turn.invocation)?.cgroup_path ?? null, null, 'the scripted boundary: no cgroup');

    // The engine dies at the pause point, after the dispatch, before the spawn.
    await fx.engine.stop();
    const engine = await fx.startKernel({ barriers: ['assistant.before_spawn=kill'] });
    await holdSecret(engine, KEY_REF, TEST_KEY);
    const pending = ask(fx, conv, 'm554-c2').catch((err) => ({ error: String(err) }));
    await waitFor(() => !engine.isRunning() || undefined, { timeoutMs: 60_000, what: 'the engine to die at assistant.before_spawn' });
    await pending;
    const before = turnOf(fx.home, 'm554-c2');
    assert.ok(before && before.status !== 'ended', `the turn was dispatched and not ended (${JSON.stringify(before)})`);
    await restartAssistant(fx, { kernel: true });
    const ended = await waitTurn(fx, 'm554-c2', { timeoutMs: 60_000 });
    assert.deepEqual([ended.outcome, ended.reason], ['refused', 'recovered'], `ended refused, recovered (${JSON.stringify(ended)})`);
    assert.deepEqual(rowsOf(fx.home, ended.invocation), [], 'nothing ran: no row');
    assert.equal(assistantLaunches(fx).length, launchesBefore, 'nothing launched, before or after the restart');
    const a = await accountView(fx);
    assert.deepEqual([a.reserved, a.turns_under_way], [0, 0], 'the reservation released');
    assert.equal(receipts(fx.home).length, 2, 'two receipts: never replayed');
  });
});
