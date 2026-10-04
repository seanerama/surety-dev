// Developer tests for the Claude Code adapter (D2 §§1.2, 1.5, 1.6, 2.5, 4.2,
// 4.5, 7.2; M2 plan M136 to M139): the rendered template, the stream read
// into usage observations and the terminal event, the canary's readings of
// a stream (authentication, key delivery, the tool surface and delegation),
// the ledger's normalization of what the adapter observed, and the held key
// absent from everything the adapter hands on.
//
// The streams under fixtures/claude/ are SYNTHETIC: written for these tests
// from the event shapes the Claude Code documentation gives for
// `--output-format stream-json` (code.claude.com/docs, read for 2.1.289),
// never recorded from a run against a model. What a real run emits is the
// positive canary's to establish.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const claude = await import(join(dist, 'invoke', 'adapters', 'claude.js'));
const { TEMPLATES, PROMPT, sessionId } = await import(join(dist, 'invoke', 'adapters', 'templates.js'));
const { foldObservations, normalizeFor, terminalUsageObserved } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
const { holdSecret, redactValue } = await import(join(dist, 'records', 'redact.js'));
const { Launcher } = await import(join(dist, 'invoke', 'choke.js'));
const { newHandle } = await import(join(dist, 'runtime.js'));

const KEY = 'sk-ant-api03-SYNTHETICTESTKEY0000000000000000000000000000';

function read(name) {
  const stream = new claude.ClaudeStream();
  const usage = [];
  const terminals = [];
  for (const line of readFileSync(join(here, 'fixtures', 'claude', name), 'utf8').split('\n')) {
    const r = stream.feed(line);
    usage.push(...r.usage);
    if (r.terminal !== null) terminals.push(r.terminal);
  }
  return { stream, usage, terminals, summary: stream.summary() };
}

const ledgerOf = (usage) => {
  const raw = foldObservations(usage);
  return { raw, n: normalizeFor('claude', raw), final: terminalUsageObserved('claude', raw) };
};

test('the template renders D2 §4.5 exactly, the session id from the invocation, the prompt last and fixed', () => {
  const t = TEMPLATES.claude;
  const args = t.render({ model: 'claude-sonnet-5-5', invocation: 'inv_01ABC' });
  assert.deepEqual(args, [
    '--bare', '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-5-5',
    '--tools', 'Read,Edit,Write,Bash,Glob,Grep', '--disallowed-tools', 'Agent', 'Task', 'ScheduleWakeup', 'Workflow',
    '--permission-mode', 'bypassPermissions', '--no-session-persistence', '--session-id', sessionId('inv_01ABC'), PROMPT,
  ]);
  assert.match(sessionId('inv_01ABC'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a valid UUID, as --session-id requires');
  assert.equal(sessionId('inv_01ABC'), sessionId('inv_01ABC'));
  assert.notEqual(sessionId('inv_01ABC'), sessionId('inv_01ABD'));
  assert.ok(!PROMPT.startsWith('-'));
  assert.equal(t.keyVariable, 'ANTHROPIC_API_KEY');
  assert.deepEqual(t.persistenceFlags, ['--no-session-persistence']);
  assert.deepEqual(claude.CLAUDE_TEMPLATE_DENIED, ['Agent', 'Task', 'ScheduleWakeup', 'Workflow'], 'the denied names are the template\'s');
  for (const a of args) assert.ok(!a.includes('\n'), 'no argument carries text beyond the fixed template');
});

test('success: per-call usage once per API response, the totals replace it, cost reported, the terminal event success', () => {
  const { usage, terminals, summary } = read('success.jsonl');
  assert.deepEqual(terminals, ['success']);
  const deltas = usage.filter((u) => u.semantics === 'delta');
  assert.equal(deltas.length, 3, 'msg_1 appears twice and is counted once');
  assert.deepEqual(deltas[0].raw, { input_tokens: 10, cache_creation_input_tokens: 1200, cache_read_input_tokens: 0, model: 'claude-sonnet-5-5' });
  assert.ok(deltas.every((d) => !('output_tokens' in d.raw)), 'the per-call output count is a placeholder and is not observed');
  assert.equal(summary.usage_steps, 3);
  const { n, final } = ledgerOf(usage);
  assert.equal(final, true);
  assert.equal(n.billable_in, 30 + 1200, 'input plus cache creation');
  assert.equal(n.cached_in, 2400);
  assert.equal(n.out, 350);
  assert.equal(n.cost_status, 'reported');
  assert.equal(n.cost_usd, 0.0421);
  assert.equal(n.model_observed, 'claude-sonnet-5-5');
  assert.equal(n.normalization_version, 'claude-stream-json-1');
  assert.deepEqual(summary.init.tools, ['Bash', 'Edit', 'Read', 'Write']);
  assert.equal(summary.tool_uses.length, 2);
  assert.deepEqual(claude.claudeKeyDelivery(summary), { variable: 'ANTHROPIC_API_KEY', api_key_source: 'ANTHROPIC_API_KEY', established: true, basis: 'init.apiKeySource is ANTHROPIC_API_KEY and the model answered' });
  assert.equal(claude.claudeAuthFailure(summary), null);
});

test('a usage line is acted on during a pending challenge; a result waits', () => {
  assert.equal(claude.ClaudeStream.usageOnly('{"type":"assistant","message":{}}'), true);
  assert.equal(claude.ClaudeStream.usageOnly('{"type":"result","subtype":"success"}'), false);
  assert.equal(claude.ClaudeStream.usageOnly('{"type":"user","message":{"content":"\\"type\\":\\"assistant\\""}}'), false);
  assert.equal(claude.ClaudeStream.usageOnly('not json'), false);
});

test('the terminal event is success only for subtype success with is_error false', () => {
  const t = (obj) => new claude.ClaudeStream().feed(JSON.stringify({ type: 'result', ...obj })).terminal;
  assert.equal(t({ subtype: 'success', is_error: false }), 'success');
  assert.equal(t({ subtype: 'success', is_error: true }), 'failure');
  assert.equal(t({ subtype: 'success' }), 'failure', 'is_error missing is not false');
  assert.equal(t({ is_error: false }), 'failure', 'subtype missing is not success');
  for (const s of ['error_max_turns', 'error_during_execution', 'error_max_budget_usd', 'error_max_structured_output_retries']) assert.equal(t({ subtype: s, is_error: true }), 'failure');
  const { terminals, summary } = read('noise.jsonl');
  assert.deepEqual(terminals, ['failure']);
  assert.equal(summary.unparsed, 2, 'a non-JSON line and an array are counted, not acted on');
});

test('an error result: its totals kept, usage complete, cost reported, the terminal event failure', () => {
  const { usage, terminals } = read('error.jsonl');
  assert.deepEqual(terminals, ['failure']);
  const { n, final } = ledgerOf(usage);
  assert.equal(final, true);
  assert.equal(n.billable_in, 940);
  assert.equal(n.out, 20);
  assert.equal(n.cost_status, 'reported');
});

test('an authentication failure: auth_failed, its zeroed totals unknown and never zero, the key absent from what is kept', () => {
  holdSecret('backend/claude/api_key', KEY);
  const { usage, terminals, summary } = read('auth.jsonl');
  assert.deepEqual(terminals, ['failure'], 'a result of subtype success with is_error true is a failure');
  assert.match(claude.claudeAuthFailure(summary), /authentication_failed/);
  assert.equal(claude.claudeAnswered(summary), false);
  assert.equal(claude.claudeKeyDelivery(summary).established, null, 'not established without an answer');
  const { n, final } = ledgerOf(usage);
  assert.equal(final, false, 'zeroed totals of a failure are not the terminal usage');
  assert.equal(n.cost_status, 'unknown', 'cost unknown, not zero (M139)');
  assert.equal(n.cost_usd, null);
  assert.equal(n.billable_in, null);
  assert.equal(n.out, null);
  const error = redactValue(claude.claudeProviderError(summary));
  assert.equal(error.auth_failure, 'an assistant message carried error authentication_failed');
  assert.equal(error.result.api_error_status, 401);
  const text = JSON.stringify(error);
  assert.ok(!text.includes(KEY), 'the provider error, redacted, holds no key');
  assert.ok(!JSON.stringify(redactValue(usage)).includes(KEY));
});

test('no reported cost: estimated from the price table with its version, never zero, unknown for a model without a price; main-loop totals used without modelUsage', () => {
  const { usage } = read('no-cost.jsonl');
  const { raw, n, final } = ledgerOf(usage);
  assert.equal(raw.usage_scope, 'main_loop');
  assert.equal(final, true);
  assert.equal(n.cost_status, 'estimated');
  assert.equal(n.cost_usd, (105 * 2 + 0 * 0.2 + 7 * 10) / 1e6);
  assert.match(n.normalization_version, /^claude-stream-json-1\+anthropic-list-/);
  const other = normalizeFor('claude', { ...raw, model: 'a-model-without-a-price' });
  assert.equal(other.cost_status, 'unknown');
  assert.equal(other.cost_usd, null);
  assert.equal(n.billable_in, 105);
  assert.equal(n.out, 7);
});

test('a stream cut before its result (a cancelled canary): known input kept, output unknown, usage incomplete, no terminal event', () => {
  const { usage, terminals } = read('cut.jsonl');
  assert.deepEqual(terminals, []);
  const { n, final } = ledgerOf(usage);
  assert.equal(final, false);
  assert.equal(n.billable_in, 1520);
  assert.equal(n.out, null, 'null only where nothing was observed');
  assert.equal(n.cost_status, 'unknown');
});

const ONE = { samples: 4, max_backend: 1, max_members: 3, unclassified: 1, backend_cmdlines: [] };

test('capabilities: an inventory without delegation tools and one backend process verifies', () => {
  const c = claude.claudeCapabilities([read('success.jsonl').summary], ONE);
  assert.equal(c.delegation_verified, true, c.reasons.join('; '));
  assert.equal(c.basis, 'inventory');
  assert.deepEqual(c.tools, ['Bash', 'Edit', 'Read', 'Write']);
  assert.deepEqual(c.features_disabled, ['Agent', 'CronCreate', 'Monitor', 'RemoteTrigger', 'ScheduleWakeup', 'SendMessage', 'Task', 'Workflow']);
  assert.deepEqual(c.denied, ['Agent', 'ScheduleWakeup', 'Task', 'Workflow']);
});

test('capabilities: no host sample, or a second backend process, is not verified', () => {
  const s = [read('success.jsonl').summary];
  assert.equal(claude.claudeCapabilities(s, null).delegation_verified, false);
  assert.equal(claude.claudeCapabilities(s, { ...ONE, samples: 0 }).delegation_verified, false);
  const two = claude.claudeCapabilities(s, { ...ONE, max_backend: 2 });
  assert.equal(two.delegation_verified, false);
  assert.match(two.reasons.join(';'), /second backend process/);
});

test('capabilities: a listed delegation tool shown denied verifies; a background Bash is recorded', () => {
  const c = claude.claudeCapabilities([read('denial.jsonl').summary], ONE);
  assert.equal(c.delegation_verified, true, c.reasons.join('; '));
  assert.deepEqual(c.present, ['Agent']);
  assert.deepEqual(
    c.attempts.map((a) => [a.name, a.outcome]),
    [
      ['Agent', 'denied'],
      ['ScheduleWakeup', 'error'],
    ],
  );
  assert.equal(c.background_bash, 1);
});

test('capabilities: a delegation that ran, no inventory and no test, an unexercised listed tool: never verified', () => {
  const ran = claude.claudeCapabilities([read('ran.jsonl').summary], ONE);
  assert.equal(ran.delegation_verified, false);
  assert.match(ran.reasons.join(';'), /Agent was used and ran/);
  const nothing = claude.claudeCapabilities([], ONE);
  assert.equal(nothing.delegation_verified, false);
  assert.equal(nothing.basis, null);
  assert.match(nothing.reasons.join(';'), /delegation_unverified/);
  const listed = new claude.ClaudeStream();
  listed.feed(JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash', 'Monitor'] }));
  const m = claude.claudeCapabilities([listed.summary()], ONE);
  assert.equal(m.delegation_verified, false);
  assert.match(m.reasons.join(';'), /Monitor is in the tool inventory/);
});

test('capabilities: without an inventory, an executable test that delegated and scheduled, both refused, verifies', () => {
  const s = new claude.ClaudeStream();
  for (const e of [
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't2', name: 'CronCreate', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true }] } },
  ])
    s.feed(JSON.stringify(e));
  const c = claude.claudeCapabilities([s.summary()], ONE);
  assert.equal(c.basis, 'test');
  assert.equal(c.delegation_verified, true, c.reasons.join('; '));
});

test('the choke point reads a claude stream through the adapter: usage recorded redacted, the terminal event noted, no result taken from a line', async () => {
  holdSecret('backend/claude/api_key', KEY);
  const recorded = [];
  const rt = {
    role: async (name, _run, args) => {
      assert.equal(name, 'run.usage', 'nothing but usage reaches the store from a line');
      recorded.push(args);
      return true;
    },
    read: async () => null,
    setting: (k) => ({ lease_ttl: 90 })[k],
    requestEnd: () => assert.fail('no end requested'),
  };
  const handle = newHandle({ run: 'run_C', generation: 1, invocation: 'inv_C', project: 'prj_C', domain: 'dom_C', work_item: 'wi_C', work_kind: 'verification', role: 'verifier', base_revision: '0'.repeat(40) });
  handle.sandbox = {};
  handle.renewedAtMs = Date.now();
  handle.adapterStream = new claude.ClaudeStream();
  const launcher = new Launcher(rt);
  for (const line of readFileSync(join(here, 'fixtures', 'claude', 'auth.jsonl'), 'utf8').split('\n')) await launcher.callback(handle, line);
  assert.equal(handle.terminal, 'failure');
  assert.equal(handle.result, null);
  assert.ok(recorded.length >= 1);
  assert.ok(!JSON.stringify(recorded).includes(KEY));
  const ok = new claude.ClaudeStream();
  handle.adapterStream = ok;
  for (const line of readFileSync(join(here, 'fixtures', 'claude', 'success.jsonl'), 'utf8').split('\n')) await launcher.callback(handle, line);
  assert.equal(handle.terminal, 'success');
  assert.equal(handle.result, null, 'the result line is the terminal event, never the result');
});
