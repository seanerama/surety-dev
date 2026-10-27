// M559, WA-turn: the message route's answer and the turn's states (UI1
// slice 48, sandbox lane; the usability batch of 2026-10-27, the driver's
// fixed shape; the assistant design §§1.3, 2, 4; E184; SEAM.md §570).
//
// NEW BEHAVIOUR (Builder's branch `build/assistant-usability`). EVERY CASE
// HERE IS EXPECTED TO FAIL on engine main 600b6e88, whose message route
// answers 200 only once the turn has ended, whose owner messages are
// `completed`, `failed` or `unknown`, whose account names its allowance
// `unknown_allowance`, and whose pending usage names provider
// `unconfigured`.
//
//   (a) On the real path `POST …/messages` answers 202 at the admission:
//       {conversation, message (the owner's, status `running`), turn: {id
//       (the invocation), status `running`, deadline_at (the receipt's),
//       cancel (its cancel route)}, reply: null}; the owner message's
//       pending usage names the configured backend and model, not yet
//       charged. `turn.cancel` works from the 202 until the end: a turn
//       cancelled while it runs ends `stopped` with its accounting kept (the
//       engine's egress-evidence zero, or what it reported), one cancelled
//       at once is ended without being resent; neither is ever launched
//       twice.
//   (b) A repeat POST with the same intent_id and body returns the intent's
//       current state (202 with the same running turn while it runs; its end
//       once ended) and starts no second turn; a different body under the
//       same intent_id is 409 `assistant_intent_conflict`.
//   (c) The owner message's status is one of `running | completed | failed |
//       stopped | timed_out | refused | interrupted | unknown`, its turn's:
//       a completed turn `completed`, a cancelled one `stopped`, an invalid
//       reply `failed`, a deadline `timed_out`, an admission refused at the
//       limit `refused` (interrupted: M554 (b)). The account and every
//       message's usage name the allowance `unknown_allowance_tokens` only.
//
// The mapping of each end to a status in (c) is the Verifier's reading of
// the driver's status set (each name its turn's outcome; an admission
// refusal `refused`), as the Builder's README states it too (SEAM.md §570).
//
// The scripted backend stands in for a real provider; no model is called.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ASSISTANT_CONTRACT,
  BLOCK,
  ask,
  assistantScripts,
  block,
  conversation,
  counts,
  hold,
  longRequest,
  messageBody,
  messagesOf,
  messagesPath,
  newConversation,
  readyAssistant,
  receipts,
  reply,
  rowsOf,
  settledMessages,
  turnOf,
  waitTurn,
} from './harness/assistant.mjs';
import { waitFor, within } from './harness/engine.mjs';

const STATUSES = ASSISTANT_CONTRACT.message_statuses;
const AT_ADMISSION_MS = 15_000;

// The POST's answer at the admission: within AT_ADMISSION_MS, or null.
async function answeredAtAdmission(fx, conv, intent, body = messageBody(intent)) {
  const pending = longRequest(fx, 'POST', messagesPath(conv), body);
  const res = await within(pending, AT_ADMISSION_MS);
  return { res, pending };
}

function assertAdmissionShape(res, { conv, intent, b = BLOCK }) {
  assert.ok(res, `the route answers at the admission, within ${AT_ADMISSION_MS} ms (600b6e88 answers only once the turn has ended)`);
  assert.equal(res.status, 202, `202 at the admission (body: ${res.text.slice(0, 400)})`);
  const body = res.body;
  assert.deepEqual(Object.keys(body).sort(), ['conversation', 'message', 'reply', 'turn'], `{conversation, message, turn, reply} (keys: ${Object.keys(body).join(', ')})`);
  assert.equal(body.conversation?.id, conv, 'the conversation');
  assert.deepEqual([body.message?.role, body.message?.intent_id, body.message?.status], ['user', intent, 'running'], `the owner message, running (${JSON.stringify(body.message).slice(0, 300)})`);
  assert.deepEqual(
    [body.message.usage?.provider, body.message.usage?.model, body.message.usage?.charged],
    [b.backend, b.model, false],
    `its pending usage names the configured backend and model, not yet charged (${JSON.stringify(body.message.usage)})`,
  );
  assert.equal(body.reply, null, 'no reply yet');
  const turn = body.turn;
  assert.match(String(turn?.id), /^inv_/, `turn.id is the invocation (${JSON.stringify(turn)})`);
  assert.equal(turn.status, 'running', 'turn.status running');
  assert.ok(typeof turn.cancel === 'string' && turn.cancel.startsWith('/v1/assistant/'), `turn.cancel is its cancel route (${JSON.stringify(turn.cancel)})`);
  return turn;
}

describe("M559 the message route's answer and the turn's states (new behaviour: fails on 600b6e88)", () => {
  test('(a) 202 at the admission with the turn and its cancel; turn.cancel works from the 202 until the end, keeps the accounting and never resends', async (t) => {
    const { fx } = await readyAssistant(t);
    assistantScripts(fx, [
      { steps: [hold('held')], on_term: 'exit' },
      { steps: [counts(500, 5), hold('held')], on_term: 'exit' },
    ]);
    const conv = await newConversation(fx);

    // Cancelled at once, from the 202.
    const now = await answeredAtAdmission(fx, conv, 'm559-a1');
    const t1 = assertAdmissionShape(now.res, { conv, intent: 'm559-a1' });
    const receipt = receipts(fx.home).find((r) => r.id === t1.id);
    assert.equal(t1.deadline_at, receipt?.deadline_at, 'turn.deadline_at is the receipt\'s');
    const c1 = await fx.engine.post(t1.cancel, {});
    assert.equal(c1.status, 200, `the cancel from the 202 is taken (body: ${c1.text})`);
    const e1 = await waitTurn(fx, 'm559-a1');
    assert.equal(e1.reason, 'assistant_cancelled', `ended by the owner's cancel (${JSON.stringify(e1)})`);
    assert.ok(fx.scripted.launches({ invocation: t1.id }).length <= 1, 'launched at most once');

    // Cancelled while it runs, its usage observed.
    const later = await answeredAtAdmission(fx, conv, 'm559-a2');
    const t2 = assertAdmissionShape(later.res, { conv, intent: 'm559-a2' });
    await waitFor(() => fx.scripted.launches({ invocation: t2.id })[0], { timeoutMs: 60_000, what: 'the turn to launch' });
    await waitFor(() => turnOf(fx.home, 'm559-a2')?.status === 'running' || undefined, { timeoutMs: 30_000, what: 'the turn running' });
    await new Promise((r) => setTimeout(r, 1_500));
    const c2 = await fx.engine.post(t2.cancel, {});
    assert.equal(c2.status, 200, `the cancel while running is taken (body: ${c2.text})`);
    const e2 = await waitTurn(fx, 'm559-a2');
    assert.deepEqual([e2.outcome, e2.reason], ['stopped', 'assistant_cancelled'], `stopped by the owner (${JSON.stringify(e2)})`);
    const row = rowsOf(fx.home, t2.id)[0];
    assert.ok(row, 'its row is written');
    assert.ok(
      (row.cost_status === 'measured_zero' && row.normalization_version === 'egress-evidence-zero-1') || (row.billable_in === 500 && row.out === 5),
      `its accounting kept: the egress-evidence zero or what it reported (${JSON.stringify(row)})`,
    );
    const m = await settledMessages(fx, conv, 'm559-a2');
    assert.deepEqual([m.owner.status, m.owner.error?.code], ['stopped', 'assistant_cancelled'], `the owner message (${JSON.stringify(m.owner)})`);
    await new Promise((r) => setTimeout(r, 2_000));
    assert.equal(fx.scripted.launches({ invocation: t2.id }).length, 1, 'never resent');
    assert.equal(receipts(fx.home).length, 2, 'two receipts for two messages');
    await Promise.all([now.pending, later.pending]);
  });

  test('(b) a repeat with the same intent and body returns its current state and starts no second turn; a different body is 409 assistant_intent_conflict; (c) the status set, each end its status, and one allowance name', async (t) => {
    const b = block({ day_limit_billable_tokens: 80_000, turn_limit_billable_tokens: 40_000, turn_deadline_seconds: 10 });
    const { fx } = await readyAssistant(t, { block: b });
    assistantScripts(fx, [
      { steps: [hold('gate')], on_term: 'exit' },
      { steps: [counts(1_000, 100), reply('Done.')] },
      { steps: [counts(200, 20), reply('Bad.', { cited: ['ae_not_given'] })] },
      { steps: [counts(1_000, 10), hold('slow')], on_term: 'exit' },
    ]);
    const conv = await newConversation(fx);

    // (b) the repeat, while running and once ended.
    const first = await answeredAtAdmission(fx, conv, 'm559-b1');
    const t1 = assertAdmissionShape(first.res, { conv, intent: 'm559-b1', b });
    const again = await within(longRequest(fx, 'POST', messagesPath(conv), messageBody('m559-b1')), AT_ADMISSION_MS);
    assert.ok(again, 'the repeat is answered at once');
    assert.deepEqual([again.status, again.body?.turn?.id, again.body?.turn?.status], [202, t1.id, 'running'], `the repeat returns the running turn (body: ${again.text.slice(0, 300)})`);
    const conflict = await fx.engine.post(messagesPath(conv), messageBody('m559-b1', 'A different question about what is waiting?'));
    assert.deepEqual([conflict.status, conflict.body?.code], [409, 'assistant_intent_conflict'], `a different body under the same intent (body: ${conflict.text})`);
    await fx.engine.post(t1.cancel, {});
    await waitTurn(fx, 'm559-b1');
    const ended = await fx.engine.post(messagesPath(conv), messageBody('m559-b1'));
    assert.deepEqual([ended.status, ended.body?.turn?.id, ended.body?.message?.status], [200, t1.id, 'stopped'], `the repeat after the end returns the end (body: ${ended.text.slice(0, 300)})`);
    assert.equal(receipts(fx.home).filter((r) => r.id === t1.id).length, 1, 'one receipt for the intent');
    assert.equal(receipts(fx.home).length, 1, 'no second turn');
    await first.pending;

    // (c) each end its status.
    const statusOf = async (intent) => {
      const res = await ask(fx, conv, intent);
      if (res.status >= 400) return { res, owner: messagesOf(await conversation(fx, conv), intent).owner };
      await waitTurn(fx, intent, { timeoutMs: 120_000 });
      return { res, ...(await settledMessages(fx, conv, intent)) };
    };
    const completed = await statusOf('m559-c1');
    const failed = await statusOf('m559-c2');
    const timedOut = await statusOf('m559-c3');
    const refused = await statusOf('m559-c4');
    assert.deepEqual(
      [completed.owner?.status, failed.owner?.status, timedOut.owner?.status, refused.owner?.status],
      ['completed', 'failed', 'timed_out', 'refused'],
      `each end its status (refusal: ${refused.res.status} ${refused.res.body?.code})`,
    );
    for (const m of (await conversation(fx, conv)).messages) assert.ok(STATUSES.includes(m.status), `${m.role} ${m.intent_id}: status ${m.status} is in the set`);
    assert.deepEqual([refused.res.status, refused.res.body?.code], [429, 'assistant_limit_reached'], 'the refusal was the limit');

    // One allowance name.
    const s = (await fx.engine.get('/v1/assistant')).body;
    assert.ok('unknown_allowance_tokens' in s.account && !('unknown_allowance' in s.account), `the account names the allowance unknown_allowance_tokens only (${Object.keys(s.account).join(', ')})`);
    const sub = refused.res.body.subject ?? {};
    assert.ok('unknown_allowance_tokens' in sub && !('unknown_allowance' in sub), `so does the limit's refusal (${JSON.stringify(sub)})`);
    const u = timedOut.owner.usage;
    assert.deepEqual([u?.charged, u?.unknown_allowance_tokens], [true, b.turn_limit_billable_tokens - 1_010], `the timed-out message's usage names its allowance (${JSON.stringify(u)})`);
    for (const m of (await conversation(fx, conv)).messages) assert.ok(!('unknown_allowance' in (m.usage ?? {})), `${m.intent_id}: no other allowance name`);
  });
});
