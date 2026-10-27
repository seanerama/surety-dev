// M553, WA-fail: one case per failure class the engine serves for a turn
// (UI1 slice 48, sandbox lane; the assistant design of 2026-10-27, §4's
// table; assistant/what-to-do.ts; E184; SEAM.md §§567 to 569).
//
// Each case: the turn's outcome and reason; its ledger row (one, as
// observed, with the unknown allowance where the usage is incomplete), or
// none for a turn refused before anything ran; the reservation released (no
// turn under way, nothing reserved) once it ended; the conversation's
// messages (the owner's message not completed, the error naming the class,
// its outcome and what to do, nothing of a failed reply kept); and no
// automatic retry: one launch per admitted turn, and no receipt but those
// of the messages sent.
//
//   On the scripted backend (qualified as the assistant, turn limit 40,000,
//   deadline 10 s):
//     assistant_turn_limit    stopped    usage past the turn limit in flight
//     assistant_usage_unknown stopped    a usage whose output count is unknown, mid-turn
//     assistant_timed_out     timed_out  the turn passes turn_deadline_seconds
//     assistant_cancelled     stopped    the owner's cancel
//     invalid_result          failed     a reply citing evidence it was not given;
//                                        a reply not of the schema
//     assistant_provider_error failed    the backend exits non-zero without a reply
//     backend_refused         refused    the entry's binary changed: refused before
//                                        launch, no row, the entry revoked
//   On a `claude-assistant-1` entry bound to the fake claude:
//     assistant_auth_failed   failed     the init reports no API key under the API-key mode
//     invalid_result          failed     the session fell back from the entry's model
//     assistant_provider_error failed    an error result and exit 1
//   with a completed turn as the control (cost reported by the stream).
//
// Not reachable here, and so not pinned by this row: isolation_unqualified
// and assistant_termination_unknown (they need a host that cannot hold the
// sandbox, or a domain whose end cannot be established), infra_error.
//
// No model is called: the scripted backend and the fake claude stand in.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ASSISTANT_CONTRACT,
  CLAUDE_BLOCK,
  accountView,
  ask,
  askAndSettle,
  assistantLaunches,
  assistantScripts,
  assistantState,
  block,
  cancelMessage,
  claudeAssistant,
  conversation,
  counts,
  hold,
  messagesOf,
  newConversation,
  readyAssistant,
  receipts,
  reply,
  rowsOf,
  statusesOf,
  usage,
  waitTurn,
} from './harness/assistant.mjs';
import { waitFor } from './harness/engine.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { trustEntry } from './harness/trust.mjs';

const B = block({ day_limit_billable_tokens: 1_000_000, turn_limit_billable_tokens: 40_000, turn_deadline_seconds: 10 });
const PARTIAL = 'PARTIAL-TEXT-THAT-MUST-NOT-BE-KEPT';

// The error a failed turn's messages carry, wherever the conversation puts
// it (the reply on 600b6e88; the owner's message on the usability batch).
const errorOf = (m) => m.reply?.error ?? m.owner?.error ?? null;

// The turn has a usage observation.
const usageSeen = (home, invocation) => withStore(home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "usage_observations" WHERE "invocation" = ?').get(invocation).n > 0);

// A settled failure: its turn, row and messages as the class requires.
async function assertFailure(fx, conv, intent, ended, { outcome, reason, row }) {
  assert.equal(outcome, ASSISTANT_CONTRACT.failure_classes[reason], `${reason}: the case expects the contract's outcome`);
  const t = ended.turn;
  assert.deepEqual([t?.status, t?.outcome, t?.reason], ['ended', outcome, reason], `${reason}: the turn's end (${JSON.stringify(t)})`);
  const rows = rowsOf(fx.home, t.invocation);
  if (row === null) assert.equal(rows.length, 0, `${reason}: no row (nothing ran)`);
  else {
    assert.equal(rows.filter((r) => r.corrects === null).length, 1, `${reason}: one original row`);
    for (const [k, v] of Object.entries(row)) assert.deepEqual(rows[0][k], v, `${reason}: row ${k} (${JSON.stringify(rows[0])})`);
  }
  const a = await accountView(fx);
  assert.deepEqual([a.reserved, a.turns_under_way], [0, 0], `${reason}: the reservation released (${JSON.stringify(a)})`);
  const m = messagesOf(await conversation(fx, conv), intent);
  assert.ok(m.owner && !['completed', 'unknown', 'running'].includes(m.owner.status), `${reason}: the owner's message is settled and not completed (${m.owner?.status})`);
  const err = errorOf(m);
  assert.deepEqual([err?.code, err?.outcome], [reason, outcome], `${reason}: the error names the class and the outcome (${JSON.stringify(err)})`);
  assert.ok(typeof err?.what_to_do === 'string' && err.what_to_do.length > 0, `${reason}: and says what to do`);
  assert.ok(!JSON.stringify(m.all).includes(PARTIAL), `${reason}: nothing of the backend's text is kept`);
  if (m.reply) assert.deepEqual([m.reply.status, m.reply.links], ['failed', []], `${reason}: a failed reply carries no links`);
  return { rows, messages: m };
}

describe('M553 one case per failure class the engine serves', () => {
  test('on the scripted backend: turn limit, usage unknown, deadline, cancel, invalid result (evidence, schema), provider error, backend refused; reservation released each time; no automatic retry', async (t) => {
    const { fx, standIn, entry } = await readyAssistant(t, { block: B });
    assistantScripts(fx, [
      { steps: [counts(50_000, 1), step.stdout(`${PARTIAL}\n`), hold('over')], on_term: 'exit' },
      { steps: [usage({ input_tokens: 100 }), hold('unknown')], on_term: 'exit' },
      { steps: [counts(1_000, 10), hold('slow')], on_term: 'exit' },
      { steps: [counts(500, 5), hold('held')], on_term: 'exit' },
      { steps: [counts(200, 20), reply(PARTIAL, { cited: ['ae_not_given'] })] },
      { steps: [step.result({ text: 5, cited_evidence: [], links: [] })] },
      { steps: [counts(300, 3), step.stdout(`${PARTIAL}\n`), step.exit(3)] },
    ]);
    const conv = await newConversation(fx);
    let sent = 0;
    const settle = async (intent) => {
      sent++;
      return askAndSettle(fx, conv, intent);
    };

    await assertFailure(fx, conv, 'm553-limit', await settle('m553-limit'), { outcome: 'stopped', reason: 'assistant_turn_limit', row: { billable_in: 50_000, out: 1, usage_complete: 0, unknown_allowance_tokens: 0 } });
    await assertFailure(fx, conv, 'm553-unknown', await settle('m553-unknown'), { outcome: 'stopped', reason: 'assistant_usage_unknown', row: { billable_in: 100, out: null, usage_complete: 0, unknown_allowance_tokens: 39_900 } });
    await assertFailure(fx, conv, 'm553-deadline', await settle('m553-deadline'), { outcome: 'timed_out', reason: 'assistant_timed_out', row: { billable_in: 1_000, out: 10, usage_complete: 0, unknown_allowance_tokens: 38_990 } });

    // The owner's cancel of a running turn.
    sent++;
    const pending = ask(fx, conv, 'm553-cancel');
    const running = await waitTurn(fx, 'm553-cancel', { status: null });
    await waitFor(() => fx.scripted.launches({ invocation: running.invocation })[0], { timeoutMs: 60_000, what: 'the turn to launch' });
    await waitFor(() => usageSeen(fx.home, running.invocation), { timeoutMs: 30_000, what: 'its usage observed' });
    const owner = messagesOf(await conversation(fx, conv), 'm553-cancel').owner;
    assert.equal((await cancelMessage(fx, conv, owner.id)).status, 200, 'the owner cancels');
    await waitTurn(fx, 'm553-cancel');
    await pending;
    await assertFailure(fx, conv, 'm553-cancel', { turn: await waitTurn(fx, 'm553-cancel') }, { outcome: 'stopped', reason: 'assistant_cancelled', row: { billable_in: 500, out: 5, usage_complete: 0, unknown_allowance_tokens: 39_495 } });

    await assertFailure(fx, conv, 'm553-evidence', await settle('m553-evidence'), { outcome: 'failed', reason: 'invalid_result', row: { billable_in: 200, out: 20 } });
    await assertFailure(fx, conv, 'm553-schema', await settle('m553-schema'), { outcome: 'failed', reason: 'invalid_result', row: { usage_complete: 1 } });
    await assertFailure(fx, conv, 'm553-exit', await settle('m553-exit'), { outcome: 'failed', reason: 'assistant_provider_error', row: { billable_in: 300, out: 3 } });

    // backend_refused: the entry's binary is not the one it names.
    const launchesBefore = assistantLaunches(fx).length;
    standIn.changeBytes('m553');
    const refused = await settle('m553-refused');
    await assertFailure(fx, conv, 'm553-refused', refused, { outcome: 'refused', reason: 'backend_refused', row: null });
    assert.deepEqual(statusesOf(fx.home, refused.turn.invocation), ['dispatch_started', 'refused'], 'refused before launch');
    assert.equal(assistantLaunches(fx).length, launchesBefore, 'nothing was launched');
    assert.equal(trustEntry(fx.home, entry).status, 'revoked', 'the entry is revoked');
    assert.equal((await assistantState(fx)).state, 'qualification_pending', 'and the state says so');

    // No automatic retry: one receipt per message sent, one launch per launched turn.
    await new Promise((r) => setTimeout(r, 3_000));
    const rs = receipts(fx.home);
    assert.equal(rs.length, sent, `one receipt per message sent (${rs.length} for ${sent})`);
    for (const r of rs) assert.ok(fx.scripted.launches({ invocation: r.id }).length <= 1, `invocation ${r.id} was launched at most once`);
    assert.equal(assistantLaunches(fx).length, sent - 1, 'every admitted turn but the refused one launched once, and nothing again');
  });

  test('on a claude-assistant-1 entry bound to the fake claude: authentication failure, model fallback, provider error; a completed turn as the control', async (t) => {
    const { fx, fake } = await claudeAssistant(t, { block: { ...CLAUDE_BLOCK, turn_limit_billable_tokens: 40_000 } });
    assert.equal((await assistantState(fx)).state, 'ready', 'the fixture is live: ready on the Claude-template entry');
    const conv = await newConversation(fx);

    fake.set({ role: 'assistant_reply', reply: { text: 'Nothing is waiting on you.', cited_evidence: [], links: [] } });
    const ok = await askAndSettle(fx, conv, 'm553-c-ok');
    assert.deepEqual([ok.turn?.outcome, ok.reply?.text ?? null], ['completed', 'Nothing is waiting on you.'], `control: a completed turn (${JSON.stringify(ok.turn)})`);
    const okRow = rowsOf(fx.home, ok.turn.invocation)[0];
    assert.deepEqual([okRow.cost_status, okRow.cost_usd, okRow.provider], ['reported', 0.004, 'claude'], `its row: the stream's reported cost (${JSON.stringify(okRow)})`);

    fake.set({ api_key_source: 'none' });
    await assertFailure(fx, conv, 'm553-c-auth', await askAndSettle(fx, conv, 'm553-c-auth'), { outcome: 'failed', reason: 'assistant_auth_failed', row: {} });

    fake.set({ role: 'assistant_reply', fallback: true, reply: { text: PARTIAL, cited_evidence: [], links: [] } });
    const fb = await askAndSettle(fx, conv, 'm553-c-fallback');
    await assertFailure(fx, conv, 'm553-c-fallback', fb, { outcome: 'failed', reason: 'invalid_result', row: {} });
    assert.match(fb.turn.reason_text ?? '', /model_fallback/, `the reason names the fallback (${fb.turn.reason_text})`);

    fake.set({});
    await assertFailure(fx, conv, 'm553-c-error', await askAndSettle(fx, conv, 'm553-c-error'), { outcome: 'failed', reason: 'assistant_provider_error', row: {} });
    assert.equal(receipts(fx.home).length, 4, 'one receipt per message: nothing retried');
  });
});
