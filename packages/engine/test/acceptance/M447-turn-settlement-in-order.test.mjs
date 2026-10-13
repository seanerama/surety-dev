// M447, turn settlement (slice 33; kernel lane with barriers; its sandbox
// half is `M447-turn-settlement-in-a-real-domain`). M5 plan §3.3 M447;
// D6-S10; D6 §2.1, §2.4; B01; E7, E10; D2 §1.4; SEAM.md §§344, 389.
//   (a) `session.turn_settled` once a turn, after the four facts (the domain
//       terminated, the collection terminal, the reply or failure recorded,
//       the usage recorded), the idle generation advanced by one;
//   (b) held at each of the four barriers `session.turn_settling.<fact>` †:
//       the session not idle, and a save and a turn refused
//       `session_not_idle`;
//   (c) usage unknown at settlement: `usage_status` `unknown` on the turn,
//       the turn's ledger row with its usage incomplete, never a zero;
//   (d) a crash between the collection and the reply's acceptance (the kill
//       barrier at `collected`), then recovery: no late reply appended, no
//       second charge for the invocation, the turn settled on its own row;
//   (e) the successor turn: a new receipt, and its package holding the
//       settled transcript.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { armBarrier } from './harness/journal.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { ledgerRowsOf, openSession, packageOf, postTurn, runRow, sayAndSettle, scriptTurns, transcriptEntries, turnRows, turnResult, turnThatDumps, turnThatSays } from './harness/sessions.mjs';
import { SETTLEMENT_FACTS, eventsOfRun, idleGeneration, invocationsOf, pauseAt, postSaveRaw, postTurnRaw, reached, release, sessionProject, sessionState, settling, untilSettled } from './harness/session-lane.mjs';

async function session(t, turns) {
  const fx = await scriptedEngine(t);
  const p = await sessionProject(fx);
  const run = await openSession(fx, p.id, 'vision');
  scriptTurns(fx, run.id, turns);
  return { fx, p, run };
}

describe('M447 turn settlement in order', () => {
  test('(a) session.turn_settled once a turn, after the four facts, the idle generation advanced by one', async (t) => {
    const { fx, p, run } = await session(t, [turnThatSays('One.'), turnThatSays('Two.')]);
    const g0 = idleGeneration(fx.home, run.id);
    await sayAndSettle(fx, p.id, run.id, 'First.');
    assert.equal(idleGeneration(fx.home, run.id), g0 + 1, 'advanced by one');
    await sayAndSettle(fx, p.id, run.id, 'Second.');
    assert.equal(idleGeneration(fx.home, run.id), g0 + 2, 'and by one again');
    const settled = eventsOfRun(fx.home, 'session.turn_settled', run.id);
    assert.equal(settled.length, 2, 'once a turn');
    const ledger = ledgerRowsOf(fx.home, p.id, run.id);
    const [first] = turnRows(fx.home, run.id);
    assert.ok(first.settled_at && ledger.length === 2, 'each turn settled with its ledger row');
    const ended = eventsOfRun(fx.home, 'invocation.status', run.id).filter((e) => /"ended"|"unknown"/.test(e.payload ?? ''));
    assert.ok(ended.length >= 1 && ended[0].seq < settled[0].seq, 'settled after the invocation\'s terminal status');
  });

  for (const fact of SETTLEMENT_FACTS) {
    test(`(b) held once ${fact}: the session not idle; a save and a turn refused session_not_idle`, async (t) => {
      const { fx, p, run } = await session(t, [turnThatSays('One.'), turnThatSays('Two.')]);
      await pauseAt(fx, settling(fact));
      await postTurn(fx, p.id, run.id, 'First.');
      void tick(fx.engine, p.id, { rounds: 1 }).catch(() => null);
      await reached(fx, settling(fact));
      assert.notEqual(sessionState(fx.home, run.id), 'open_idle', 'not idle');
      assertRefused(await postSaveRaw(fx, p.id, run.id), 409, 'session_not_idle', `a save held at ${fact}`);
      assertRefused(await postTurnRaw(fx, p.id, run.id, 'Too soon.'), 409, 'session_not_idle', `a turn held at ${fact}`);
      await release(fx, settling(fact));
      await untilSettled(fx, p.id, run.id, 1);
    });
  }

  test('(c) usage unknown at settlement: usage_status unknown, the ledger row\'s usage incomplete, never zero', async (t) => {
    const { fx, p, run } = await session(t, [{ steps: [step.result(turnResult({ reply: 'No usage reported.' }))] }]);
    const done = await sayAndSettle(fx, p.id, run.id, 'Go.');
    assert.equal(done.turn.usage_status, 'unknown', `usage_status unknown (${JSON.stringify(done.turn)})`);
    const [row] = ledgerRowsOf(fx.home, p.id, run.id);
    assert.ok(row && row.usage_complete === 0, `the ledger row's usage incomplete (${JSON.stringify(row)})`);
    assert.notEqual(row.cost_status, 'measured_zero', 'never a zero: charged by D2\'s policy');
  });

  test('(d) a crash between collection and the reply\'s acceptance, then recovery: no late reply, no second charge, the turn on its own row', async (t) => {
    const { fx, p, run } = await session(t, [turnThatSays('Late reply.'), turnThatSays('After.')]);
    await armBarrier(fx.engine, settling('collected'), 'kill');
    await postTurn(fx, p.id, run.id, 'First.');
    void tick(fx.engine, p.id, { rounds: 1 }).catch(() => null);
    await waitFor(() => (fx.engine.isRunning() ? undefined : true), { what: 'the engine to kill itself at collected' });
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    const [turn] = turnRows(fx.home, run.id);
    assert.ok(['unknown', 'failed', 'cancelled'].includes(turn.outcome), `the interrupted turn settled unknown, failed or cancelled on its own row (${JSON.stringify(turn)})`);
    assert.deepEqual(transcriptEntries(fx.home, run.id).filter((e) => e.speaker === 'role'), [], 'no late reply appended');
    const [invocation] = invocationsOf(fx.home, run.id);
    assert.equal(ledgerRowsOf(fx.home, p.id, run.id).filter((r) => r.invocation === invocation.id && r.corrects === null).length, 1, 'charged once');
  });

  test('(e) the successor turn: a new receipt, and its package holding the settled transcript', async (t) => {
    const { fx, p, run } = await session(t, [turnThatSays('The first reply.'), turnThatDumps({}, { reply: 'Second.' })]);
    await sayAndSettle(fx, p.id, run.id, 'The first message.');
    await sayAndSettle(fx, p.id, run.id, 'The second message.');
    const receipts = invocationsOf(fx.home, run.id);
    assert.equal(new Set(receipts.map((r) => r.id)).size, 2, 'a new receipt for the successor');
    const pkg = Object.values(packageOf(fx, run.id, 1) ?? {}).join('\n');
    for (const text of ['The first message.', 'The first reply.', 'The second message.']) assert.ok(pkg.includes(text), `the package holds "${text}"`);
    assert.equal(runRow(fx.home, run.id).session_state, 'open_idle');
  });
});
