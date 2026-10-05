// Developer tests for what Sean's second real-agent run found (2026-10-05):
// (1) under the real lane the egress proxy resolves by the system's
// resolver, not the harness's map, which the real lane never fills; (2) an
// unknown usage observed on the backend's terminal event does not stop a run
// that is ending by itself (it was recorded stopped / budget /
// budget_usage_unknown), while every other budget answer stops as before;
// (3) a failed exit's reason names what the engine saw of its cause, bounded
// and scrubbed. No name is resolved here and nothing is connected to: the
// system resolver is compared by identity, never called.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const seam = await import(join(dist, 'testing', 'seam.js'));
const { activeResolver, systemResolver } = await import(join(dist, 'invoke', 'proxy', 'resolver.js'));
const { budgetStopFor } = await import(join(dist, 'invoke', 'choke.js'));
const { ClaudeStream } = await import(join(dist, 'invoke', 'adapters', 'claude.js'));
const { exitCause, scrubText, EXIT_CAUSE_MAX } = await import(join(dist, 'invoke', 'exit-cause.js'));

test('the resolver: the system one outside harness mode; the harness map in harness mode; the system one under the real lane', async () => {
  assert.equal(activeResolver(), systemResolver, 'outside harness mode');
  assert.equal(seam.configureHarness(true, []), null);
  seam.setRealLane(false);
  const harness = activeResolver();
  assert.notEqual(harness, systemResolver, 'plain harness mode keeps the harness map');
  await assert.rejects(harness.resolve('api.provider.example'), (e) => e.code === 'ENOTFOUND', 'a name the empty map does not hold does not resolve');
  seam.setRealLane(true);
  assert.equal(seam.seamRealLane(), true);
  assert.equal(activeResolver(), systemResolver, 'under the real lane: the system resolver');
  seam.setRealLane(false);
  assert.notEqual(activeResolver(), systemResolver, 'and back to the map when the real lane is off');
});

// The run's last two lines, in the shape Claude Code 2.1.289 wrote them.
const ERROR_TEXT = "API Error: Couldn't connect through your proxy (ERR_PROXY_TUNNEL) — the proxy refused the tunnel: check its credentials and that it allows this host";
const ZERO = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
const LINES = [
  JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read'], model: 'claude-sonnet-5-5', apiKeySource: 'none', session_id: 's' }),
  JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: null, error: 'unknown' }),
  JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', usage: ZERO, content: [{ type: 'text', text: ERROR_TEXT }] }, error: 'server_error', is_api_error_message: true }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: null, result: ERROR_TEXT, total_cost_usd: 0, usage: ZERO, modelUsage: {}, num_turns: 1 }),
];

test("the run's terminal line: a failure whose usage is unknown, observed on the terminal event", () => {
  const stream = new ClaudeStream({ costAs: 'estimated' });
  let last = null;
  const usage = [];
  for (const l of LINES) {
    last = stream.feed(l);
    usage.push(...last.usage.map((u) => ({ ...u, terminal: last.terminal !== null })));
  }
  assert.equal(last.terminal, 'failure');
  const terminalObs = usage.filter((u) => u.terminal);
  assert.equal(terminalObs.length, 1);
  assert.equal(terminalObs[0].raw.usage_final, false, 'zeroed totals of a failure are no measurement: the usage is not final');
  for (const k of Object.keys(ZERO)) assert.equal(terminalObs[0].raw[k], undefined, `no ${k} is recorded as zero`);
});

test('a budget answer stops the run as before, except budget_usage_unknown on the terminal event', () => {
  assert.equal(budgetStopFor('budget_usage_unknown', { terminal: true }), null, "on the backend's terminal event: the run ends by its exit");
  assert.equal(budgetStopFor('budget_usage_unknown', { terminal: false }), 'budget_usage_unknown', 'mid-run: a stop, as before');
  assert.equal(budgetStopFor('budget_usage_unknown'), 'budget_usage_unknown', 'the scripted protocol: a stop, as before');
  for (const limit of ['budget_run_billable_tokens', 'budget_day_unknown_tokens', 'budget_day_verified_usd', 'budget_unreadable']) {
    assert.equal(budgetStopFor(limit, { terminal: true }), limit, `${limit} on the terminal event is still a stop`);
    assert.equal(budgetStopFor(limit, { terminal: false }), limit);
  }
  assert.equal(budgetStopFor(null, { terminal: true }), null);
});

test("a failed exit's cause: the terminal event and the proxy's refusals, as the engine saw them", () => {
  const stream = new ClaudeStream({ costAs: 'estimated' });
  for (const l of LINES) stream.feed(l);
  const egress = Array.from({ length: 23 }, () => ({ authority: 'api.anthropic.com:443', decision: 'refused', reason: 'resolve_failed' }));
  const cause = exitCause(stream.summary(), egress);
  assert.match(cause, /its terminal event reports api_error: "API Error: Couldn't connect through your proxy \(ERR_PROXY_TUNNEL\)/);
  assert.match(cause, /the proxy refused 23 CONNECTs \(resolve_failed: api\.anthropic\.com:443 x23\) and accepted 0/);
  assert.ok(cause.length <= EXIT_CAUSE_MAX);
  assert.equal(exitCause(null, []), null, 'nothing seen, nothing claimed');
  assert.equal(exitCause(null, [{ authority: 'a.example:443', decision: 'accepted', reason: null }]), null, 'no refusal, no terminal failure: no cause named');
});

test('the cause is bounded and holds no credential or header value', () => {
  const secretish = 'Authorization: Bearer abc.def-ghi and x-api-key=sk-ant-0123456789abcdef cookie: session=1 ' + 'y'.repeat(5000);
  const stream = new ClaudeStream({ costAs: 'reported' });
  stream.feed(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: secretish, usage: ZERO, modelUsage: {} }));
  const many = Array.from({ length: 50 }, (_, i) => ({ authority: `h${i}.example:443`, decision: 'refused', reason: 'not_listed' }));
  const cause = exitCause(stream.summary(), many);
  assert.ok(cause.length <= EXIT_CAUSE_MAX, `bounded (${cause.length})`);
  for (const bad of ['abc.def-ghi', 'sk-ant-0123456789abcdef', 'session=1']) assert.ok(!cause.includes(bad), `no ${bad}`);
  assert.match(cause, /and 46 more/);
  assert.equal(scrubText('Proxy-Authorization: Basic dXNlcjpwYXNz'), 'Proxy-Authorization: [removed]');
  assert.equal(scrubText('token sk-abcdef123456 here'), 'token [removed] here');
});
