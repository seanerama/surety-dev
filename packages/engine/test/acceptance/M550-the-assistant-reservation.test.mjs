// M550, WA-reserve: the account's admission by reservation (UI1 slice 48,
// sandbox lane; the assistant design of 2026-10-27, §1.3 step 1, §1.2
// "Period and reset"; E184; SEAM.md §§567, 568).
//
// A turn is admitted in the store transaction that writes its receipt, only
// if  used_known + unknown_allowance + reserved + turn_limit <= day_limit,
// where `reserved` is the remaining turn limit of every turn under way.
//
//   (a) Two messages sent at once, in two conversations, when the day holds
//       only one more turn: exactly one is admitted. The other is refused
//       429 `assistant_limit_reached` with the four numbers (used_known,
//       unknown_allowance, reserved, turn_limit; with day_limit and
//       resets_at) and no receipt; meanwhile the state is `limit_reached`
//       with the running turn's reservation shown. Once that turn ends its
//       reservation is released and the state is `ready` again.
//   (b) At the limit after spending: refused 429 `assistant_limit_reached`
//       with the four numbers as the day stands, no receipt and no turn.
//       The day turns at 00:00Z of the engine's clock: after it the account
//       is a new day's (nothing used, resets_at the next midnight), a turn
//       is admitted again and charged to the new day, and the earlier rows
//       keep their own day. Nothing carries over and nothing was reset by a
//       route.
//
// The scripted backend stands in for a real provider; no model is called.
// The engine's clock is the harness's controlled clock (SEAM.md §18).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  accountRows,
  accountView,
  allowanceOf,
  ask,
  askAndSettle,
  assertMessageRefused,
  assistantScripts,
  assistantState,
  block,
  cancelMessage,
  conversation,
  counts,
  hold,
  messagesOf,
  newConversation,
  nextMidnight,
  readyAssistant,
  receipts,
  reply,
  turnOf,
  waitTurn,
} from './harness/assistant.mjs';
import { waitFor } from './harness/engine.mjs';
import { advanceClock } from './harness/runs.mjs';

const B = block({ day_limit_billable_tokens: 70_000, turn_limit_billable_tokens: 40_000 });

describe("M550 the account's admission by reservation", () => {
  test('(a) two messages at once when the day holds one more turn: one admitted, the other 429 assistant_limit_reached with the four numbers and no receipt; the reservation shown while the turn runs and released when it ends', async (t) => {
    const { fx } = await readyAssistant(t, { block: B });
    assistantScripts(fx, [{ steps: [hold('held')], on_term: 'exit' }, { steps: [hold('held')], on_term: 'exit' }]);
    const [c1, c2] = [await newConversation(fx), await newConversation(fx)];
    const sent = [
      { conv: c1, intent: 'm550-a1', res: null },
      { conv: c2, intent: 'm550-a2', res: null },
    ];
    for (const s of sent) s.pending = ask(fx, s.conv, s.intent).then((res) => (s.res = res));
    const refusedOne = await waitFor(() => sent.find((s) => s.res !== null && s.res.status >= 400), { timeoutMs: 60_000, what: 'one of the two messages to be refused' });
    const admitted = sent.find((s) => s !== refusedOne);
    const turn = await waitTurn(fx, admitted.intent, { status: null });
    assert.equal(turnOf(fx.home, refusedOne.intent), null, 'the refused message has no turn');
    assert.equal(receipts(fx.home).length, 1, 'one receipt: two admissions did not pass the same remainder');

    const r = refusedOne.res;
    assert.equal(r.status, 429, `refused 429 (body: ${r.text})`);
    assert.equal(r.body.code, 'assistant_limit_reached', `assistant_limit_reached (body: ${r.text})`);
    const sub = r.body.subject ?? {};
    assert.deepEqual(
      { used_known: sub.used_known, unknown_allowance: allowanceOf(sub), reserved: sub.reserved, turn_limit: sub.turn_limit, day_limit: sub.day_limit },
      { used_known: 0, unknown_allowance: 0, reserved: 40_000, turn_limit: 40_000, day_limit: 70_000 },
      `the four numbers, with the day limit (subject: ${JSON.stringify(sub)})`,
    );
    let s = await assistantState(fx);
    assert.equal(sub.resets_at, nextMidnight(`${s.account.day}T12:00:00.000Z`), `resets_at is the next 00:00Z after the account's day (${s.account.day})`);
    assert.equal(s.state, 'limit_reached', `while the turn runs the day holds no other (${s.reason})`);
    assert.deepEqual([s.account.reserved, s.account.turns_under_way, s.account.remaining], [40_000, 1, 30_000], `the running turn's reservation (${JSON.stringify(s.account)})`);

    // End the running turn: its reservation is released.
    const owner = await waitFor(async () => messagesOf(await conversation(fx, admitted.conv), admitted.intent).owner ?? undefined, { what: 'the admitted owner message' });
    await waitFor(() => fx.scripted.launches({ invocation: turn.invocation })[0], { timeoutMs: 60_000, what: 'the admitted turn to launch' });
    const cancelled = await cancelMessage(fx, admitted.conv, owner.id);
    assert.equal(cancelled.status, 200, `the owner cancels the running turn (body: ${cancelled.text})`);
    await waitTurn(fx, admitted.intent);
    await admitted.pending;
    s = await assistantState(fx);
    assert.deepEqual([s.state, s.account.reserved, s.account.turns_under_way], ['ready', 0, 0], `the reservation released (${JSON.stringify(s.account)})`);
  });

  test('(b) at the limit after spending: 429 assistant_limit_reached with the day\'s numbers, no receipt; the day turns at 00:00Z: a new day\'s account, a turn admitted and charged to it, earlier rows keep their day', async (t) => {
    const { fx } = await readyAssistant(t, { block: B });
    assistantScripts(fx, [{ steps: [counts(35_000, 0), reply('Nothing is waiting on you.')] }, { steps: [counts(1_000, 10), reply('A new day.')] }]);
    const conv = await newConversation(fx);
    const spent = await askAndSettle(fx, conv, 'm550-b1');
    assert.equal(spent.turn?.outcome, 'completed', `the first turn completed (${JSON.stringify(spent.turn)})`);
    const day1 = (await accountView(fx)).day;

    const refused = await assertMessageRefused(fx, conv, 'm550-b2', 429, 'assistant_limit_reached', 'at the limit');
    const sub = refused.body.subject;
    assert.deepEqual(
      { used_known: sub.used_known, unknown_allowance: allowanceOf(sub), reserved: sub.reserved, turn_limit: sub.turn_limit, day_limit: sub.day_limit, resets_at: sub.resets_at },
      { used_known: 35_000, unknown_allowance: 0, reserved: 0, turn_limit: 40_000, day_limit: 70_000, resets_at: nextMidnight(`${day1}T12:00:00.000Z`) },
      `35,000 + 0 + 0 + 40,000 > 70,000 (subject: ${JSON.stringify(sub)})`,
    );
    assert.equal(receipts(fx.home).length, 1, 'still one receipt');

    // 00:00Z of the engine's clock (not yet advanced: the wall clock), and a minute.
    await advanceClock(fx.engine, Math.ceil((Date.parse(sub.resets_at) - Date.now()) / 1000) + 60);
    const s = await assistantState(fx);
    assert.notEqual(s.account.day, day1, `the account is a new day's (${JSON.stringify(s.account)})`);
    assert.deepEqual(
      [s.state, s.account.used_known, allowanceOf(s.account), s.account.reserved, s.account.remaining, s.account.resets_at],
      ['ready', 0, 0, 0, 70_000, nextMidnight(`${s.account.day}T12:00:00.000Z`)],
      `nothing of the earlier day carries over (${JSON.stringify(s.account)})`,
    );
    const next = await askAndSettle(fx, conv, 'm550-b3');
    assert.equal(next.turn?.outcome, 'completed', `a turn is admitted on the new day (${JSON.stringify(next.turn)})`);
    const rows = accountRows(fx.home);
    assert.deepEqual(rows.map((r) => r.day_utc), [day1, s.account.day], 'each row keeps the day it was charged on');
    const snap = receipts(fx.home).at(-1).budget_snapshot;
    assert.deepEqual([snap.day, snap.turn_limit_billable_tokens, snap.day_limit_billable_tokens], [s.account.day, 40_000, 70_000], `the new receipt fixes the new day and the limits (${JSON.stringify(snap)})`);
  });
});
