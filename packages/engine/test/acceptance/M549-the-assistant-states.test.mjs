// M549, WA-state: the workspace assistant's state from real configuration
// (UI1 slice 48, sandbox lane; the assistant design of 2026-10-27, §2;
// E183 D1, E184; SEAM.md §§567, 568).
//
//   (a) With a whole block, each state the design's table names follows from
//       real configuration, the first failing condition winning, in order:
//       `credential_missing` (the block's reference not loaded, and again
//       when the saved credential manifest cannot be read), then
//       `qualification_pending` through its stages (no attempt; the
//       attempt's qualification_approval open; its entry's trust_activation
//       open), then `ready` once the owner activated the assistant-template
//       entry, then `limit_reached` once the day cannot hold one more turn.
//       Each state but `ready` refuses a message with its own code
//       (assistant_credential_missing 409, assistant_qualification_pending
//       409, assistant_limit_reached 429) and admits nothing: no receipt, no
//       turn. The harness's in-process fake is never consulted while a block
//       exists: no read names provider `fake`, no refused state is answered
//       by it, and no message carries its measured zero.
//   (b) A store failure while the state is computed (the `budget_read`
//       fault on the account `workspace_assistant`) is 503
//       `assistant_state_unavailable`, never `ready`; the same failure in a
//       message's admission refuses it (the store's own 500 `store_error`,
//       or 503) and admits nothing; with the fault gone the state reads
//       `ready` again.
//
// The scripted backend stands in for a real provider; no model is called.

import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  ASSISTANT_CONTRACT,
  BLOCK,
  KEY_REF,
  TEST_KEY,
  assertMessageRefused,
  askAndSettle,
  assistantAttempt,
  assistantScripts,
  assistantState,
  block,
  conversation,
  counts,
  newConversation,
  nextMidnight,
  obeyingAssistantCanaries,
  readyAssistant,
  receipts,
  refusalOf,
  reply,
} from './harness/assistant.mjs';
import { armFault, clearFaults } from './harness/engine.mjs';
import { holdSecret } from './harness/records.mjs';
import { approveAttempt, attemptFixture, waitAttempt } from './harness/sandbox/qualify.mjs';
import { consumeEngine, openEngineDecision } from './harness/trust.mjs';

const STATE = (s) => `${s.state} (configured ${s.configured}; ${s.reason})`;

function assertNotFake(s, what) {
  assert.notEqual(s.provider, 'fake', `${what}: the state names the block's provider, never the harness fake (${STATE(s)})`);
  assert.equal(s.provider, BLOCK.backend, `${what}: provider is the block's backend`);
  assert.equal(s.model, BLOCK.model, `${what}: model is the block's model`);
}

describe("M549 the assistant's state from real configuration", () => {
  test('(a) in order: credential_missing, qualification_pending through its stages, ready, limit_reached; each state not ready refuses a message with its code and admits nothing; the harness fake is never consulted', async (t) => {
    const b = block({ day_limit_billable_tokens: 50_000, turn_limit_billable_tokens: 40_000 });
    const { fx, standIn, fixtureProject } = await attemptFixture(t, { config: { workspace_assistant: b } });
    const conv = await newConversation(fx);

    // credential_missing: the block's reference is not loaded.
    let s = await assistantState(fx);
    assert.equal(s.version, 1, 'the capability stays version 1');
    assert.deepEqual([s.state, s.configured], ['credential_missing', false], `no credential held: ${STATE(s)}`);
    assertNotFake(s, 'credential_missing');
    assert.ok(s.reason.includes(KEY_REF), `the reason names the reference the block names (${s.reason})`);
    assert.ok(!JSON.stringify(s).includes(TEST_KEY), 'nothing in the state shows a credential value');
    assert.deepEqual([s.account?.day_limit, s.account?.turn_limit], [50_000, 40_000], 'the account is the block\'s, shown though not ready');
    await assertMessageRefused(fx, conv, 'm549-a1', refusalOf('credential_missing').status, refusalOf('credential_missing').code, 'credential_missing');

    // qualification_pending, no attempt yet.
    await holdSecret(fx.engine, KEY_REF, TEST_KEY);
    s = await assistantState(fx);
    assert.deepEqual([s.state, s.configured], ['qualification_pending', false], `the credential held, no entry: ${STATE(s)}`);
    assertNotFake(s, 'qualification_pending');
    assert.equal(s.qualification?.stage, 'not_proposed', `no attempt: stage not_proposed (${JSON.stringify(s.qualification)})`);
    assert.equal(s.qualification?.decision ?? null, null, 'no decision is open');
    await assertMessageRefused(fx, conv, 'm549-a2', refusalOf('qualification_pending').status, refusalOf('qualification_pending').code, 'qualification_pending, not proposed');

    // qualification_pending at the attempt's approval.
    obeyingAssistantCanaries(fx);
    const proposed = await assistantAttempt(fx, standIn, fixtureProject, { approve: false });
    s = await assistantState(fx);
    assert.equal(s.state, 'qualification_pending', `an attempt proposed: ${STATE(s)}`);
    assert.deepEqual([s.qualification?.stage, s.qualification?.attempt, s.qualification?.decision?.kind], ['qualification_approval', proposed.id, 'qualification_approval'], `the stage and the open decision (${JSON.stringify(s.qualification)})`);
    assert.ok(s.what_to_do.includes(s.qualification.decision.id), `what to do names the open decision (${s.what_to_do})`);

    // qualification_pending at the entry's activation.
    await approveAttempt(fx, fixtureProject, proposed.id);
    const done = await waitAttempt(fx.home, proposed.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 300_000 });
    assert.equal(done.status, 'succeeded', `the fixture is live: the assistant's attempt passed (${JSON.stringify(done.canaries)})`);
    s = await assistantState(fx);
    assert.equal(s.state, 'qualification_pending', `the attempt passed, its entry not yet active: ${STATE(s)}`);
    assert.deepEqual([s.qualification?.stage, s.qualification?.trust_entry, s.qualification?.decision?.kind], ['trust_activation', done.trust_entry, 'trust_activation'], `the stage and the open decision (${JSON.stringify(s.qualification)})`);
    await assertMessageRefused(fx, conv, 'm549-a3', refusalOf('qualification_pending').status, refusalOf('qualification_pending').code, 'qualification_pending, activation open');

    // ready.
    const activation = await openEngineDecision(fx, fixtureProject, 'trust_activation', done.trust_entry);
    await consumeEngine(fx, activation, 'approve');
    s = await assistantState(fx);
    assert.deepEqual([s.state, s.configured, s.trust_entry], ['ready', true, done.trust_entry], `the entry active: ${STATE(s)}`);
    assertNotFake(s, 'ready');
    assert.equal(s.account.remaining, 50_000, 'nothing spent yet');

    // credential_missing again: the saved credential manifest cannot be read.
    const manifest = join(fx.home, 'provider-credentials.json');
    writeFileSync(manifest, '{ not a manifest', { mode: 0o600 });
    s = await assistantState(fx);
    assert.deepEqual([s.state, s.configured], ['credential_missing', false], `an unreadable manifest outranks everything after it: ${STATE(s)}`);
    assert.ok(s.reason.includes('credential_manifest_invalid'), `the reason says so (${s.reason})`);
    await assertMessageRefused(fx, conv, 'm549-a4', refusalOf('credential_missing').status, refusalOf('credential_missing').code, 'credential_missing, manifest');
    rmSync(manifest);
    assert.equal((await assistantState(fx)).state, 'ready', 'the manifest gone, ready again');

    // limit_reached: one turn spends 20,000; 20,000 + 40,000 > 50,000.
    assistantScripts(fx, [{ steps: [counts(20_000, 0), reply('Nothing is waiting on you.')] }]);
    const turn = await askAndSettle(fx, conv, 'm549-a5');
    assert.equal(turn.turn?.outcome, 'completed', `the turn completed (${JSON.stringify(turn.turn)})`);
    s = await assistantState(fx);
    assert.deepEqual([s.state, s.configured], ['limit_reached', true], `the day cannot hold one more turn: ${STATE(s)}`);
    assertNotFake(s, 'limit_reached');
    assert.deepEqual([s.account.used_known, s.account.fits_one_more_turn, s.account.resets_at], [20_000, false, nextMidnight(new Date().toISOString())], `the account says why (${JSON.stringify(s.account)})`);
    const refused = await assertMessageRefused(fx, conv, 'm549-a6', refusalOf('limit_reached').status, refusalOf('limit_reached').code, 'limit_reached');
    assert.equal(refused.body.subject?.state, 'limit_reached', 'the refusal names the state');

    // The fake was never consulted.
    const c = await conversation(fx, conv);
    for (const m of c.messages) assert.notEqual(m.usage?.provider, 'fake', `no message carries the fake's usage (${m.intent_id} ${m.role}: ${JSON.stringify(m.usage)})`);
    assert.equal(receipts(fx.home).length, 1, 'one receipt: the one admitted turn');
  });

  test('(b) a budget_read fault on the account while the state is computed: 503 assistant_state_unavailable, never ready; at an admission: refused (a store failure), nothing admitted; cleared: ready', async (t) => {
    const { fx } = await readyAssistant(t);
    const conv = await newConversation(fx);
    await armFault(fx.engine, { point: 'budget_read', project: 'workspace_assistant', times: 1 });
    const res = await fx.engine.get('/v1/assistant');
    assert.equal(res.status, ASSISTANT_CONTRACT.state_unavailable.status, `the state read fails closed (body: ${res.text})`);
    assert.equal(res.body?.code, ASSISTANT_CONTRACT.state_unavailable.code, `with assistant_state_unavailable (body: ${res.text})`);
    assert.ok(!/"state":"ready"/.test(res.text), 'the refusal never says ready');

    await armFault(fx.engine, { point: 'budget_read', project: 'workspace_assistant', times: 1 });
    const before = receipts(fx.home).length;
    // The admission recomputes the state in the transaction of its receipt;
    // the injected failure rolls that transaction back. The design names no
    // code for it beyond "store error" (§4's first row): the engine's
    // ordinary store_error (500), or the state's 503, is accepted; that it
    // is a refusal that admits nothing is what is pinned (SEAM.md §568).
    const r = await assertMessageRefused(fx, conv, 'm549-b1', [500, 503], ['store_error', 'assistant_state_unavailable'], 'the account unreadable at admission');
    assert.equal(receipts(fx.home).length, before, 'no receipt');
    assert.ok(r.body?.reason, 'the refusal explains itself');
    await clearFaults(fx.engine);
    assert.equal((await assistantState(fx)).state, 'ready', 'with the fault gone the state reads ready');
  });
});
