// M548, WA-cfg: the `workspace_assistant` block of config.json (UI1 slice
// 48; the assistant design of 2026-10-27, §1.2 "Where the limit lives", §2
// `unconfigured`; E183 D1; E184; SEAM.md §§567, 568).
//
//   (a) Outside the test mode, with no block, the assistant is
//       `unconfigured`: GET /v1/assistant says so (configured false,
//       provider `unconfigured`, no account, no actions), every
//       conversation route answers 503 `assistant_not_configured`, and no
//       real path is reachable: no receipt, no turn, no assistant directory
//       in the home. GET /v1/engine shows the key as
//       {value: null, source: "default"}.
//   (b) In the test mode with no block, only the in-process fake answers
//       (provider `fake`, its measured zero, no account) and still no real
//       path is reachable: a message answered by it writes no receipt, no
//       turn, no ledger row and no domain of the account.
//   (c) A partial or out-of-range block is refused at start (exit 4, the
//       refusal naming the field) and nothing is written under the home:
//       each of the six fields missing (none has a default), an unknown
//       field, a block that is not an object, an unknown backend, a model
//       that is not a model name, a credential reference that is not one of
//       the engine's or not the backend's, each number below its minimum,
//       above its maximum, not whole or not a number, a turn limit above the
//       day's, and the scripted backend outside the test mode.
//   (d) A whole block is taken exactly as written: GET /v1/engine shows it
//       with source `file`, and the account's limits are its numbers.
//
// (a) starts an engine without --harness, which makes its own scope (named
// from its own disposable home) under the user's service manager and removes
// it when it stops; the test only reads (SEAM.md §124; M4 build spec §4.1
// rules 1 and 2). The fixture's teardown ends it by its exact name.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { ASSISTANT_CONTRACT, BLOCK, HOME_CONTEXT, WAITING, accountRows, assistantState, block, receipts, refusalOf, turns } from './harness/assistant.mjs';
import { EXIT, engineFixture, freePort, makeTempDir, removeDir, snapshotDir, startRefused, writeEngineConfig } from './harness/engine.mjs';
import { sandboxEnv } from './harness/sandbox/lane.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

const KEY = 'workspace_assistant';

// Start with `config` in a fresh home; expect exit 4 with a refusal that
// names `field` with `code`, and nothing written under the home.
async function assertRefusedStart(t, config, { field, code = 'invalid_value', harness = true }) {
  const home = makeTempDir('m548');
  t.after(() => removeDir(home));
  const port = await freePort();
  writeEngineConfig(home, { api_port: port, ...config });
  const before = snapshotDir(home);
  const result = await startRefused({ home, harness });
  const label = JSON.stringify(config[KEY]);
  assert.equal(result.code, EXIT.config, `${label}: exit status ${EXIT.config} (stderr: ${result.stderr.slice(-600)})`);
  assert.equal(result.refusal?.code, code, `${label}: refusal code (stderr: ${result.stderr.slice(-600)})`);
  assert.equal(result.refusal?.subject?.field, field, `${label}: the refusal names the field`);
  assert.ok(result.refusal.reason && result.refusal.what_to_do, `${label}: the refusal explains itself`);
  assert.deepEqual(snapshotDir(home), before, `${label}: nothing written under the engine home`);
}

const without = (k) => Object.fromEntries(Object.entries(BLOCK).filter(([key]) => key !== k));

describe('M548 the workspace_assistant block', () => {
  test('(a) outside the test mode, no block: unconfigured; every conversation route 503 assistant_not_configured; no real path; GET /v1/engine shows {value: null, source: "default"}', async (t) => {
    const fx = await scriptedEngine(t, { start: false, env: sandboxEnv() });
    const engine = await fx.start({ harness: false });
    const info = await engine.engineInfo();
    assert.deepEqual(info.config?.[KEY], { value: null, source: 'default' }, `the key, absent: ${JSON.stringify(info.config?.[KEY])}`);
    const s = (await engine.get('/v1/assistant')).body;
    assert.deepEqual(
      { version: s.version, state: s.state, configured: s.configured, provider: s.provider, model: s.model, account: s.account, qualification: s.qualification, actions: s.actions },
      { version: 1, state: 'unconfigured', configured: false, provider: 'unconfigured', model: null, account: null, qualification: null, actions: [] },
      `GET /v1/assistant with no block (${JSON.stringify(s)})`,
    );
    for (const [method, path, body] of [
      ['GET', '/v1/assistant/conversations'],
      ['POST', '/v1/assistant/conversations', {}],
      ['GET', '/v1/assistant/actions'],
    ]) {
      const res = await engine.request(method, path, body === undefined ? {} : { body });
      assert.equal(res.status, 503, `${method} ${path} → 503 (body: ${res.text})`);
      assert.equal(res.body?.code, refusalOf('unconfigured').code, `${method} ${path}: assistant_not_configured`);
    }
    const msg = await engine.post('/v1/assistant/conversations/ac_01M5Z66665AVR8PD217Y4HJNGW/messages', { intent_id: 'm548-a', text: WAITING, context: HOME_CONTEXT });
    assert.equal(msg.status, 503, `a message is refused before anything (body: ${msg.text})`);
    assert.equal(msg.body?.code, 'assistant_not_configured');
    assert.deepEqual([receipts(fx.home).length, turns(fx.home).length, accountRows(fx.home).length], [0, 0, 0], 'no receipt, turn or row of the account');
    assert.equal(existsSync(join(fx.home, 'assistant')), false, 'no conversation was written');
    await engine.stop();
  });

  test('(b) in the test mode, no block: only the in-process fake answers, with no account; a message it answers reaches no real path', async (t) => {
    const { engine, home } = await engineFixture(t);
    const info = await engine.engineInfo();
    assert.deepEqual(info.config?.[KEY], { value: null, source: 'default' }, `the key, absent (${JSON.stringify(info.config?.[KEY])})`);
    const s = (await engine.get('/v1/assistant')).body;
    assert.deepEqual([s.provider, s.account, s.trust_entry], ['fake', null, null], `the test mode's fake, with no account (${JSON.stringify(s)})`);
    const conv = (await engine.post('/v1/assistant/conversations', {})).body.conversation.id;
    const res = await engine.post(`/v1/assistant/conversations/${conv}/messages`, { intent_id: 'm548-b', text: WAITING, context: HOME_CONTEXT });
    assert.equal(res.status, 200, `the fake answers (body: ${res.text})`);
    assert.deepEqual([res.body.message?.usage?.provider, res.body.message?.usage?.cost_status], ['fake', 'measured_zero'], 'the fake\'s own usage');
    assert.deepEqual([receipts(home).length, turns(home).length, accountRows(home).length], [0, 0, 0], 'no receipt, turn or row of the account');
    const domains = withStore(home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "execution_domains" WHERE "account" = 'workspace_assistant'`).get().n);
    assert.equal(domains, 0, 'no domain of the account');
  });

  test('(c) a partial or out-of-range block is refused at start, exit 4, naming the field, writing nothing; no field has a default', async (t) => {
    assert.deepEqual(Object.keys(BLOCK).sort(), [...ASSISTANT_CONTRACT.block.fields].sort(), 'the fixture block holds exactly the contract\'s fields');
    for (const k of ASSISTANT_CONTRACT.block.fields) await assertRefusedStart(t, { [KEY]: without(k) }, { field: `${KEY}.${k}` });
    await assertRefusedStart(t, { [KEY]: { ...BLOCK, limit_usd: 5 } }, { field: `${KEY}.limit_usd`, code: 'unknown_field' });
    for (const v of [null, [], 'scripted', 40_000]) await assertRefusedStart(t, { [KEY]: v }, { field: KEY });
    await assertRefusedStart(t, { [KEY]: block({ backend: 'gpt' }) }, { field: `${KEY}.backend` });
    await assertRefusedStart(t, { [KEY]: block({ model: '' }) }, { field: `${KEY}.model` });
    await assertRefusedStart(t, { [KEY]: block({ credential_ref: 'backend/other/api_key' }) }, { field: `${KEY}.credential_ref` });
    await assertRefusedStart(t, { [KEY]: block({ backend: 'claude', model: 'claude-sonnet-5-5', credential_ref: 'backend/codex/api_key' }) }, { field: `${KEY}.credential_ref` });
    for (const [k, { min, max }] of Object.entries(ASSISTANT_CONTRACT.block.numbers)) {
      const [below, above] = [min - 1, max + 1];
      for (const v of [below, above, 1500.5, '40000', -1]) {
        const b = block({ [k]: v, ...(k === 'turn_limit_billable_tokens' ? { day_limit_billable_tokens: ASSISTANT_CONTRACT.block.numbers.day_limit_billable_tokens.max } : {}) });
        await assertRefusedStart(t, { [KEY]: b }, { field: `${KEY}.${k}` });
      }
    }
    await assertRefusedStart(t, { [KEY]: block({ day_limit_billable_tokens: 39_999, turn_limit_billable_tokens: 40_000 }) }, { field: `${KEY}.turn_limit_billable_tokens` });
    await assertRefusedStart(t, { [KEY]: BLOCK }, { field: `${KEY}.backend`, harness: false });
  });

  test('(d) a whole block is taken exactly as written: GET /v1/engine shows it with source file; the account\'s limits are its numbers', async (t) => {
    const b = block({ day_limit_billable_tokens: 123_000, turn_limit_billable_tokens: 12_000, turn_deadline_seconds: 45 });
    const { engine } = await engineFixture(t, { config: { [KEY]: b } });
    const info = await engine.engineInfo();
    assert.deepEqual(info.config?.[KEY], { value: b, source: 'file' }, `the key as written (${JSON.stringify(info.config?.[KEY])})`);
    const s = await assistantState({ engine });
    assert.deepEqual([s.account?.day_limit, s.account?.turn_limit], [123_000, 12_000], `the account's limits are the block's (${JSON.stringify(s.account)})`);
    assert.notEqual(s.provider, 'fake', 'a block selects the real path, not the fake');
  });
});
