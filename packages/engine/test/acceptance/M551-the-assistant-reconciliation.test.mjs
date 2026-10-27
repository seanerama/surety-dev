// M551, WA-reconcile: one original ledger row per assistant turn, and what
// it says (UI1 slice 48, sandbox lane; the assistant design of 2026-10-27,
// §1.3 steps 2 and 3 and its cost-status table; O6; E184; SEAM.md §§567,
// 568).
//
// Six turns on one engine, each ending differently, then the account:
//   - a cost the backend reported (> 0): `reported`, the amount as given;
//   - counts priced by the scripted price table (model `scripted-priced`):
//     `estimated`, labelled with the table's version;
//   - counts with no cost: `unknown`, cost null (never 0);
//   - counts with a reported cost of 0: not a measured zero for a real
//     turn: `unknown`, cost null, the report kept and the basis labelled;
//   - a partial usage (input known, output not) on a turn the engine ended:
//     usage incomplete, charged the turn limit less what was observed as an
//     unknown allowance;
//   - a turn the owner cancelled before it reported anything, in a sandbox
//     whose egress log shows nothing left it: the engine's own
//     egress-evidence zero (`measured_zero`, basis `egress-evidence-zero-1`,
//     the evidence kept in raw_usage), the only measured zero an assistant
//     row may carry.
// Each turn has exactly one original row (and no correction here); the
// account keeps reported and estimated dollars apart, counts the unknown-cost
// turns, sums the known tokens and the allowances apart, and never counts a
// dollar against the limit.
//
// The scripted backend stands in for a real provider; no model is called.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  accountRows,
  accountView,
  allowanceOf,
  askAndSettle,
  assistantScripts,
  block,
  cancelMessage,
  conversation,
  counts,
  hold,
  messagesOf,
  newConversation,
  readyAssistant,
  receipts,
  reply,
  rowsOf,
  usage,
  waitTurn,
  ask,
} from './harness/assistant.mjs';
import { waitFor } from './harness/engine.mjs';

const B = block({ day_limit_billable_tokens: 400_000, turn_limit_billable_tokens: 40_000 });
const ESTIMATE = (1_000 * 2 + 0 * 0.5 + 100 * 8) / 1_000_000; // the scripted price table, per million

describe('M551 one original row per assistant turn, and what it says', () => {
  test('reported, estimated and unknown kept apart; a provider\'s zero is unknown; an incomplete usage charged its allowance; the egress-evidence zero the only measured zero; one original row per turn; the account folds them apart', async (t) => {
    const { fx } = await readyAssistant(t, { block: B });
    assistantScripts(fx, [
      { steps: [counts(1_000, 200, { cost_usd: 0.02 }), reply('One.')] },
      { steps: [counts(1_000, 100, { model: 'scripted-priced' }), reply('Two.')] },
      { steps: [counts(500, 50), reply('Three.')] },
      { steps: [counts(300, 30, { cost_usd: 0 }), reply('Four.')] },
      { steps: [usage({ input_tokens: 1_000 }), hold('stuck')], on_term: 'exit' },
      { steps: [hold('held')], on_term: 'exit' },
    ]);
    const conv = await newConversation(fx);
    const ended = {};
    for (const [i, name] of [[1, 'reported'], [2, 'estimated'], [3, 'unknown'], [4, 'zero'], [5, 'incomplete']]) ended[name] = await askAndSettle(fx, conv, `m551-${i}`);
    // The sixth is held until the owner cancels it.
    const pending = ask(fx, conv, 'm551-6');
    const turn6 = await waitTurn(fx, 'm551-6', { status: null });
    await waitFor(() => fx.scripted.launches({ invocation: turn6.invocation })[0], { timeoutMs: 60_000, what: 'the sixth turn to launch' });
    const owner6 = await waitFor(async () => messagesOf(await conversation(fx, conv), 'm551-6').owner ?? undefined, { what: 'the sixth owner message' });
    assert.equal((await cancelMessage(fx, conv, owner6.id)).status, 200, 'the owner cancels the sixth turn');
    ended.egress = { turn: await waitTurn(fx, 'm551-6') };
    await pending;

    const one = (name) => {
      const rows = rowsOf(fx.home, ended[name].turn.invocation);
      assert.equal(rows.filter((r) => r.corrects === null).length, 1, `${name}: exactly one original row (rows: ${JSON.stringify(rows.map((r) => r.id))})`);
      const r = rows[0];
      assert.deepEqual([r.account, r.project, r.run, r.role], ['workspace_assistant', null, null, 'workspace_assistant'], `${name}: the account's row, no project or run`);
      return r;
    };

    const reported = one('reported');
    assert.deepEqual([reported.cost_status, reported.cost_usd, reported.billable_in, reported.out, reported.usage_complete, reported.unknown_allowance_tokens], ['reported', 0.02, 1_000, 200, 1, null], `reported (${JSON.stringify(reported)})`);
    const estimated = one('estimated');
    assert.deepEqual([estimated.cost_status, estimated.usage_complete, estimated.unknown_allowance_tokens], ['estimated', 1, null], `estimated (${JSON.stringify(estimated)})`);
    assert.ok(Math.abs(estimated.cost_usd - ESTIMATE) < 1e-9, `estimated at the table's prices: ${estimated.cost_usd} = ${ESTIMATE}`);
    assert.match(estimated.normalization_version, /scripted-prices-1/, 'the estimate names the price table it used');
    const unknown = one('unknown');
    assert.deepEqual([unknown.cost_status, unknown.cost_usd, unknown.billable_in, unknown.out], ['unknown', null, 500, 50], `unknown: the counts known, the cost not (${JSON.stringify(unknown)})`);
    const zero = one('zero');
    assert.deepEqual([zero.cost_status, zero.cost_usd], ['unknown', null], `a provider's own 0 on a real turn is not a measured zero (${JSON.stringify(zero)})`);
    assert.match(zero.normalization_version, /assistant-reported-zero-is-unknown/, 'the basis says why');
    assert.equal(zero.raw_usage.cost_usd, 0, 'the report is kept as it was');
    const incomplete = one('incomplete');
    assert.deepEqual(
      [ended.incomplete.turn.outcome, incomplete.usage_complete, incomplete.billable_in, incomplete.out, incomplete.cost_status, incomplete.unknown_allowance_tokens],
      ['stopped', 0, 1_000, null, 'unknown', 39_000],
      `incomplete: the engine ended it; observed 1,000, allowance 40,000 - 1,000 (${JSON.stringify(incomplete)}; turn ${JSON.stringify(ended.incomplete.turn)})`,
    );
    const egress = one('egress');
    assert.deepEqual(
      [ended.egress.turn.outcome, egress.cost_status, egress.cost_usd, egress.billable_in, egress.out, egress.usage_complete, egress.unknown_allowance_tokens, egress.normalization_version],
      ['stopped', 'measured_zero', 0, 0, 0, 1, null, 'egress-evidence-zero-1'],
      `the egress-evidence zero (${JSON.stringify(egress)})`,
    );
    assert.equal(egress.raw_usage.zero_basis?.kind, 'egress-evidence-zero-1', `the evidence kept on the row (${JSON.stringify(egress.raw_usage)})`);

    const rows = accountRows(fx.home);
    assert.equal(rows.length, receipts(fx.home).length, 'as many rows as receipts: one per turn');
    for (const r of rows) {
      if (r.cost_status === 'measured_zero') assert.equal(r.normalization_version, 'egress-evidence-zero-1', `a measured zero on an assistant row rests only on the egress evidence (${JSON.stringify(r)})`);
    }

    // The messages carry their row's figures, reported and estimated apart.
    const c = await conversation(fx, conv);
    const usageOf = (i) => messagesOf(c, `m551-${i}`).reply?.usage ?? messagesOf(c, `m551-${i}`).owner?.usage;
    assert.deepEqual([usageOf(1)?.cost_status, usageOf(1)?.cost_usd], ['reported', 0.02], `the first message's usage (${JSON.stringify(usageOf(1))})`);
    assert.equal(usageOf(2)?.cost_status, 'estimated', `the second message's usage (${JSON.stringify(usageOf(2))})`);
    assert.deepEqual([usageOf(3)?.cost_status, usageOf(3)?.cost_usd], ['unknown', null], 'the third: unknown, never 0 USD');

    const a = await accountView(fx);
    assert.deepEqual(
      { reported_usd: a.reported_usd, unknown_cost_turns: a.unknown_cost_turns, turns_charged: a.turns_charged, used_known: a.used_known, unknown_allowance: allowanceOf(a), reserved: a.reserved },
      { reported_usd: 0.02, unknown_cost_turns: 3, turns_charged: 6, used_known: 1_200 + 1_100 + 550 + 330 + 1_000 + 0, unknown_allowance: 39_000, reserved: 0 },
      `the account folds the rows apart (${JSON.stringify(a)})`,
    );
    assert.ok(Math.abs(a.estimated_usd - ESTIMATE) < 1e-9, `estimated dollars apart from reported (${a.estimated_usd})`);
    assert.equal(a.remaining, 400_000 - (4_180 + 39_000), 'the limit counts tokens and allowances, never dollars');
  });
});
