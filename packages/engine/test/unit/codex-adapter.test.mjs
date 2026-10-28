// Developer tests for the Codex adapter (C1 of Codex support, 2026-10-27;
// D2 §§1.2, 1.5, 1.6, 1.7, 2.5, 4.6): the `codex-exec-4` template's command
// line, standard input and environment; the `codex exec --json` stream read
// into usage observations and the terminal event; the ledger's
// `codex-exec-json-1` normalization (cached input split out of input, cost
// unknown, no price table); and the whole path against a FAKE codex
// (fixtures/codex/fake-codex.mjs), which runs no model and contacts nothing.
//
// The streams here are SYNTHETIC, written from the shapes OpenAI's
// non-interactive page documents; never recorded from a run against a
// model. The real `codex` binary is never executed by these tests.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const codex = await import(join(dist, 'invoke', 'adapters', 'codex.js'));
const claude = await import(join(dist, 'invoke', 'adapters', 'claude.js'));
const templates = await import(join(dist, 'invoke', 'adapters', 'templates.js'));
const { foldObservations, normalizeFor, terminalUsageObserved, attemptSpendEstimate, CODEX_NORMALIZATION } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
const { holdSecret } = await import(join(dist, 'records', 'redact.js'));
const { Launcher, adapterStreamFor } = await import(join(dist, 'invoke', 'choke.js'));
const { newHandle } = await import(join(dist, 'runtime.js'));
const { exitCause } = await import(join(dist, 'invoke', 'exit-cause.js'));

const FAKE = join(here, 'fixtures', 'codex', 'fake-codex.mjs');
const KEY = 'sk-proj-SYNTHETICCODEXTESTKEY000000000000000000000000';
const T = templates.templateOf('codex');

// Every option of `codex exec --help` for Codex CLI 0.160.0, as the
// assessment saved it (codex-assessment/outputs/codex-exec-help.txt).
const EXEC_HELP_0160 = ['-c', '--config', '--enable', '--disable', '--strict-config', '-i', '--image', '-m', '--model', '--oss', '--local-provider', '-p', '--profile', '-s', '--sandbox', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '-C', '--cd', '--worktree', '--add-dir', '--thread-source', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-schema', '--color', '--json', '-o', '--output-last-message', '-h', '--help', '-V', '--version'];

const feed = (lines) => {
  const s = new codex.CodexStream();
  const usage = [];
  const terminals = [];
  const protocol = [];
  for (const line of lines) {
    const r = s.feed(typeof line === 'string' ? line : JSON.stringify(line));
    usage.push(...r.usage);
    if (r.terminal !== null) terminals.push(r.terminal);
    if (r.protocolError !== null) protocol.push(r.protocolError);
  }
  return { s, usage, terminals, protocol, summary: s.summary() };
};

const GOOD = [
  { type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Repo contains docs, sdk, and examples directories.' } },
  { type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 } },
];

test('the template: codex-exec-4, the prompt on standard input exactly, no prompt argument, every flag in 0.160.0\'s help, the switches off, the six hardening disables, no --skip-git-repo-check', () => {
  assert.equal(T.version, 'codex-exec-4');
  assert.equal(T.authMode, 'api_key');
  assert.equal(T.keyRef, 'backend/codex/api_key');
  const args = T.render({ model: 'gpt-5.5-codex', invocation: 'inv_X' });
  assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
  assert.equal(args.at(-1), '-', 'standard input is the whole prompt');
  assert.equal(T.stdin, `${templates.PROMPT}\n`, 'standard input carries exactly the fixed prompt');
  assert.ok(T.stdin.includes('/surety/context/prompt.md') && T.stdin.includes('/surety/out/result.json'));
  assert.ok(!args.includes(templates.PROMPT), 'the prompt is not an argument (stdin would be appended to it)');
  assert.ok(!T.stdin.includes('"invocation"'), 'never the scripted request line');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.5-codex');
  assert.equal(args[args.indexOf('-C') + 1], '/surety/workspace');
  assert.equal(args[args.indexOf('-o') + 1], '/surety/out/last-message.txt', 'the one file it is told to write is under /surety/out');
  for (const a of args.filter((x) => x.startsWith('-') && x !== '-')) assert.ok(EXEC_HELP_0160.includes(a), `${a} is an option of codex exec 0.160.0`);
  for (const f of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config', '--dangerously-bypass-approvals-and-sandbox']) assert.ok(args.includes(f), f);
  assert.ok(!args.includes('--skip-git-repo-check'), 'D2 §4.6: not passed, so a broken git view fails visibly');
  assert.ok(!T.text.includes('--skip-git-repo-check'));
  const disabled = args.flatMap((a, i) => (a === '--disable' ? [args[i + 1]] : []));
  assert.deepEqual(disabled.slice(0, 5), ['multi_agent', 'goals', 'hooks', 'apps', 'memories']);
  assert.deepEqual(disabled, [...templates.CODEX_DISABLED_FEATURES]);
  for (const f of ['daemon_auto_start', 'worktrees', 'guardian_approval', 'in_app_local_automation', 'browser_use', 'computer_use', 'plugins', 'code_mode_host']) assert.ok(disabled.includes(f), f);
  // Version 4 (K6a, 2026-10-28): six hardening disables after version 3's twenty-two, each once.
  assert.deepEqual(disabled.slice(-6), ['unbounded_connection_retries', 'system_proxy_fallback', 'image_generation', 'unified_exec_tty', 'sleep_tool', 'shell_snapshot']);
  assert.equal(disabled.length, 28);
  assert.equal(new Set(disabled).size, disabled.length, 'no feature disabled twice');
  for (const f of disabled) assert.ok(T.text.includes(`--disable ${f} `), `the template text names --disable ${f}`);
  const overrides = args.flatMap((a, i) => (a === '-c' ? [args[i + 1]] : []));
  for (const o of ['web_search="disabled"', 'tools.web_search=false', 'check_for_update_on_startup=false', 'analytics.enabled=false', 'feedback.enabled=false', 'otel.metrics_exporter="none"', 'otel.exporter="none"', 'otel.trace_exporter="none"', 'agents.enabled=false', 'history.persistence="none"', 'cli_auth_credentials_store="ephemeral"', 'forced_login_method="api"']) {
    assert.ok(overrides.includes(o), o);
  }
  assert.ok(!args.some((a) => a.includes('sk-') || a.includes('<')), 'no credential and no placeholder in the rendered argv');
  assert.match(T.text, /\(environment: CODEX_API_KEY=<credential> CODEX_HOME=\/surety\/home\/\.codex\)/);
  assert.ok(!T.text.includes('OPENAI_API_KEY'), 'K3: OPENAI_API_KEY is not set (exec does not read it)');
  assert.match(T.text, /\(standard input: the fixed prompt\)/);
  assert.match(T.text, /Codex CLI 0\.160\.0/);
  assert.equal(templates.CODEX_TEMPLATE_CLI_VERSION, '0.160.0');
});

test('the environment: the one held key in CODEX_API_KEY alone, never OPENAI_API_KEY (K3), CODEX_HOME in the volatile home; the grant lists CODEX_API_KEY only; Claude unchanged', () => {
  assert.deepEqual(templates.templateEnv(T, KEY), { CODEX_HOME: '/surety/home/.codex', CODEX_API_KEY: KEY });
  assert.ok(!('OPENAI_API_KEY' in templates.templateEnv(T, KEY)), 'the engine sets no OPENAI_API_KEY');
  assert.equal(T.keyVariable, 'CODEX_API_KEY');
  assert.deepEqual(T.keyAliases ?? [], [], 'no alias variable');
  assert.deepEqual(templates.templateEnv(T, null), { CODEX_HOME: '/surety/home/.codex' }, 'no key, no key variable');
  assert.deepEqual(templates.keyVariables('codex'), ['CODEX_API_KEY']);
  assert.deepEqual(templates.keyVariables('claude'), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(templates.keyVariables('claude', 'subscription_token'), ['CLAUDE_CODE_OAUTH_TOKEN']);
  const c = templates.templateOf('claude');
  assert.deepEqual(templates.templateEnv(c, KEY), { ...templates.CLAUDE_QUIET_ENV, ANTHROPIC_API_KEY: KEY });
  assert.equal(c.stdin, undefined, 'Claude Code keeps its prompt argument; its stdin is unchanged');
  assert.equal(templates.templateOf('codex', { authMode: 'subscription_token' }), undefined, 'API-key mode only');
  assert.equal(templates.templateOf('codex', { purpose: 'assistant' }), undefined, 'no Codex assistant template');
});

test('the choke point picks the adapter per backend: Codex\'s for codex, Claude\'s for claude, the scripted protocol otherwise', () => {
  assert.ok(adapterStreamFor({ backend: 'codex', auth_mode: 'api_key' }) instanceof codex.CodexStream);
  assert.ok(adapterStreamFor({ backend: 'claude', auth_mode: 'api_key' }) instanceof claude.ClaudeStream);
  assert.equal(adapterStreamFor({ backend: 'scripted', auth_mode: 'api_key' }), null);
  assert.equal(adapterStreamFor(null), null);
});

test('a good stream: the thread id, the items, one cumulative usage with the thread id, the terminal event success', () => {
  const r = feed(GOOD);
  assert.deepEqual(r.terminals, ['success']);
  assert.equal(r.summary.thread_id, '0199a213-81c0-7800-8aa1-bbab2a035a53');
  assert.equal(r.summary.turns_started, 1);
  assert.deepEqual(r.summary.items.map((i) => [i.id, i.type, i.status]), [['item_1', 'command_execution', 'completed'], ['item_3', 'agent_message', null]]);
  assert.equal(r.summary.agent_message, 'Repo contains docs, sdk, and examples directories.');
  assert.deepEqual(r.summary.beyond_domain, []);
  assert.deepEqual(r.usage, [{ semantics: 'cumulative', raw: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0, usage_final: true, usage_scope: 'turn', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' } }]);
  assert.equal(r.s.usageOnly(JSON.stringify(GOOD[5])), false, 'no Codex line only reports usage: the terminal waits for a challenge');
  assert.equal(codex.codexFailure(r.summary), null);
});

test('the usage normalisation: billable input is input less cached, cached counted once, reasoning not added, cost unknown for a model the price table does not list (C2)', () => {
  const raw = foldObservations(feed(GOOD).usage);
  const n = normalizeFor('codex', raw);
  assert.equal(CODEX_NORMALIZATION, 'codex-exec-json-2');
  assert.deepEqual(n, { billable_in: 315, cached_in: 24448, out: 122, model_observed: null, normalization_version: 'codex-exec-json-2', cost_status: 'unknown', cost_usd: null });
  assert.equal(terminalUsageObserved('codex', raw), true);
  // reasoning tokens are kept in the raw usage and never added to output
  assert.equal(normalizeFor('codex', { ...raw, reasoning_output_tokens: 90 }).out, 122);
  // the scripted normalization, which codex had before, would have counted 24763 billable
  assert.equal(normalizeFor('scripted', raw).billable_in, 24763);
  // cached above input contradicts the assumed relation: billable unknown, never negative
  assert.equal(normalizeFor('codex', { input_tokens: 10, cached_input_tokens: 20, output_tokens: 1, usage_final: true }).billable_in, null);
  // a model the Codex price table (C2) does not list: no spend estimate, never zero
  assert.equal(attemptSpendEstimate('codex', 'gpt-5.5-codex', 200_000), null);
  assert.equal(normalizeFor('codex', { ...raw, model: 'gpt-5.5-codex' }).cost_status, 'unknown');
});

test('no usage, or a partial one: unknown, never zero, and not final', () => {
  const none = feed([GOOD[0], GOOD[1], { type: 'turn.completed' }]);
  assert.deepEqual(none.terminals, ['success']);
  assert.deepEqual(none.usage, [{ semantics: 'cumulative', raw: { usage_final: false, usage_scope: 'absent', thread_id: GOOD[0].thread_id } }]);
  const n = normalizeFor('codex', foldObservations(none.usage));
  assert.deepEqual([n.billable_in, n.cached_in, n.out, n.cost_status, n.cost_usd], [null, null, null, 'unknown', null]);
  assert.equal(terminalUsageObserved('codex', foldObservations(none.usage)), false);
  const partial = feed([GOOD[0], { type: 'turn.completed', usage: { input_tokens: 500, output_tokens: 20 } }]);
  const raw = foldObservations(partial.usage);
  assert.equal(raw.usage_final, false);
  const p = normalizeFor('codex', raw);
  assert.deepEqual([p.billable_in, p.cached_in, p.out], [null, null, 20], 'without the cached count the billable input is unknown');
  assert.equal(terminalUsageObserved('codex', raw), false);
  const bad = feed([{ type: 'turn.completed', usage: { input_tokens: -1, cached_input_tokens: 'x', output_tokens: 3 } }]);
  assert.deepEqual(bad.usage[0].raw, { output_tokens: 3, usage_final: false, usage_scope: 'turn' });
});

test('an authentication failure: the terminal event failure, auth_failed named, usage absent, the key absent from the reason', () => {
  const msg = `unexpected status 401 Unauthorized: {"error":{"message":"Incorrect API key provided: ${KEY}","code":"invalid_api_key"}}`;
  const r = feed([GOOD[0], GOOD[1], { type: 'error', message: msg }, { type: 'turn.failed', error: { message: msg } }]);
  assert.deepEqual(r.terminals, ['failure']);
  assert.equal(r.summary.terminal.type, 'turn.failed');
  assert.equal(codex.codexFailure(r.summary).class, 'auth_failed');
  assert.equal(r.usage[0].raw.usage_final, false);
  holdSecret('backend/codex/api_key', KEY);
  const cause = exitCause(null, [], r.summary);
  assert.match(cause, /auth_failed/);
  assert.ok(!cause.includes(KEY), 'the key never reaches the reason text');
  const limit = feed([{ type: 'turn.failed', error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } }]);
  assert.equal(codex.codexFailure(limit.summary).class, 'usage_limit');
  const other = feed([{ type: 'turn.failed', error: {} }]);
  assert.deepEqual(codex.codexFailure(other.summary), { class: 'provider_error', message: 'turn.failed without a message' });
});

test('a malformed stream: lines that are not the protocol are counted, nothing is usage, there is no terminal event', () => {
  const r = feed(['this is not JSON', '{"type":', '["an","array"]', '{"no_type":true}', '', '{"type":"item.completed","item":"not an object"}']);
  assert.deepEqual(r.terminals, []);
  assert.deepEqual(r.usage, []);
  assert.equal(r.summary.unparsed, 3);
  assert.equal(r.summary.lines, 5);
  assert.equal(r.summary.terminal, null);
});

test('a second terminal event is a protocol error, ignored with its usage; a web search is seen beyond the domain', () => {
  const r = feed([...GOOD, { type: 'turn.completed', usage: { input_tokens: 9e9, cached_input_tokens: 0, output_tokens: 9e9 } }]);
  assert.deepEqual(r.terminals, ['success']);
  assert.equal(r.protocol.length, 1);
  assert.equal(r.usage.length, 1, 'the second terminal\'s usage is not recorded');
  const w = feed([GOOD[0], { type: 'item.completed', item: { id: 'ws', type: 'web_search', query: 'q' } }, { type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call' } }]);
  assert.deepEqual(w.summary.beyond_domain.map((b) => [b.type, b.kind]), [['web_search', 'provider_tool'], ['mcp_tool_call', 'external_tool']]);
});

test('the choke point reads a codex stream through the adapter: usage recorded redacted, the terminal event noted, no result taken from a line', async () => {
  holdSecret('backend/codex/api_key', KEY);
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
  const handle = newHandle({ run: 'run_X', generation: 1, invocation: 'inv_X', project: 'prj_X', domain: 'dom_X', work_item: 'wi_X', work_kind: 'verification', role: 'verifier', base_revision: '0'.repeat(40) });
  handle.sandbox = {};
  handle.renewedAtMs = Date.now();
  handle.adapterStream = new codex.CodexStream();
  const launcher = new Launcher(rt);
  const msg = `unexpected status 401 Unauthorized: Incorrect API key provided: ${KEY}`;
  for (const line of [GOOD[0], { type: 'error', message: msg }, { type: 'turn.failed', error: { message: msg } }]) await launcher.callback(handle, JSON.stringify(line));
  assert.equal(handle.terminal, 'failure');
  assert.equal(handle.result, null);
  assert.equal(recorded.length, 1);
  assert.ok(!JSON.stringify(recorded).includes(KEY));
  handle.adapterStream = new codex.CodexStream();
  for (const line of GOOD) await launcher.callback(handle, JSON.stringify(line));
  assert.equal(handle.terminal, 'success');
  assert.equal(handle.result, null, 'turn.completed is the terminal event, never the result');
  assert.equal(recorded.at(-1).raw.cached_input_tokens, 24448);
});

// ---- against the fake codex ---------------------------------------------------------

function runFake(mode, { killAfterMs = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cx-fake-'));
  const root = join(dir, 'root');
  mkdirSync(join(root, 'surety', 'context'), { recursive: true });
  mkdirSync(join(root, 'surety', 'out'), { recursive: true });
  mkdirSync(join(root, 'surety', 'workspace'), { recursive: true });
  writeFileSync(join(root, 'surety', 'context', 'prompt.md'), '# The task\nDo the synthetic thing.\n');
  const modeFile = join(dir, 'mode.json');
  const dump = join(dir, 'dump.json');
  writeFileSync(modeFile, JSON.stringify({ root, dump, ...mode }));
  const env = { PATH: '/usr/bin:/bin', HOME: join(dir, 'home'), FAKE_CODEX_MODE: modeFile, ...templates.templateEnv(T, mode.key === undefined ? KEY : mode.key) };
  if (mode.key === null) for (const v of templates.keyVariables('codex')) delete env[v];
  const child = spawn(process.execPath, [FAKE, ...T.render({ model: 'gpt-5.5-codex', invocation: 'inv_F' })], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.end(T.stdin);
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  const timer = killAfterMs === null ? null : setTimeout(() => child.kill('SIGTERM'), killAfterMs);
  return new Promise((resolve) =>
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const r = feed(stdout.split('\n'));
      let result = null;
      try {
        result = JSON.parse(readFileSync(join(root, 'surety', 'out', 'result.json'), 'utf8'));
      } catch {
        result = null;
      }
      let given = null;
      try {
        given = JSON.parse(readFileSync(dump, 'utf8'));
      } catch {
        given = null;
      }
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, signal, result, given, ...r });
    }),
  );
}

test('the fake codex: given the template, it reads the fixed prompt from stdin, is given CODEX_API_KEY alone and reads it, writes the result file, and its stream parses to a complete usage', async () => {
  const r = await runFake({});
  assert.equal(r.code, 0);
  assert.equal(r.given.stdin, `${templates.PROMPT}\n`);
  assert.deepEqual(r.given.key_variables, ['CODEX_API_KEY'], 'the engine set CODEX_API_KEY only');
  assert.equal(r.given.key_read, 'CODEX_API_KEY');
  assert.equal(r.given.codex_home, '/surety/home/.codex');
  assert.deepEqual(r.result, { status: 'completed', summary: 'fake: the role did its work' });
  assert.deepEqual(r.terminals, ['success']);
  assert.equal(r.summary.thread_id, '0199a213-81c0-7800-8aa1-bbab2a035a53');
  const n = normalizeFor('codex', foldObservations(r.usage));
  assert.deepEqual([n.billable_in, n.cached_in, n.out, n.cost_status], [315, 24448, 122, 'unknown']);
  // A fake that reads OPENAI_API_KEY only now receives nothing: the engine
  // no longer delivers the key there (K3), so it fails authentication.
  const o = await runFake({ reads: 'OPENAI_API_KEY' });
  assert.deepEqual(o.given.key_variables, ['CODEX_API_KEY']);
  assert.equal(o.given.key_read, null, 'nothing in OPENAI_API_KEY');
  assert.deepEqual(o.terminals, ['failure']);
  assert.equal(codex.codexFailure(o.summary).class, 'auth_failed');
  const either = await runFake({ reads: 'either' });
  assert.equal(either.given.key_read, 'CODEX_API_KEY');
  assert.deepEqual(either.terminals, ['success']);
});

test('the fake codex: a bad key, no key, a usage limit, a timeout, malformed output, no usage', async () => {
  const bad = await runFake({ reject_key: KEY });
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.terminals, ['failure']);
  assert.equal(codex.codexFailure(bad.summary).class, 'auth_failed');
  assert.equal(bad.result, null);
  const none = await runFake({ key: null });
  assert.deepEqual(none.given.key_variables, []);
  assert.equal(codex.codexFailure(none.summary).class, 'auth_failed');
  const limit = await runFake({ outcome: 'usage_limit' });
  assert.equal(codex.codexFailure(limit.summary).class, 'usage_limit');
  const hang = await runFake({ outcome: 'timeout', hang_ms: 60_000 }, { killAfterMs: 300 });
  assert.equal(hang.code, 143);
  assert.deepEqual(hang.terminals, [], 'killed before its terminal event: never clean');
  assert.deepEqual(hang.usage, []);
  const mal = await runFake({ outcome: 'malformed' });
  assert.equal(mal.code, 0);
  assert.deepEqual(mal.terminals, [], 'exit 0 without a terminal event is not a success');
  assert.ok(mal.summary.unparsed >= 2);
  const nu = await runFake({ outcome: 'no_usage' });
  assert.deepEqual(nu.terminals, ['success']);
  assert.equal(terminalUsageObserved('codex', foldObservations(nu.usage)), false);
  const ws = await runFake({ outcome: 'web_search' });
  assert.deepEqual(ws.summary.beyond_domain.map((b) => b.type), ['web_search']);
});

test('the fake codex: a positive canary writes its edit and result from canary.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-canary-'));
  try {
    const root = join(dir, 'root');
    mkdirSync(join(root, 'surety', 'context'), { recursive: true });
    mkdirSync(join(root, 'surety', 'workspace'), { recursive: true });
    writeFileSync(join(root, 'surety', 'context', 'prompt.md'), 'canary\n');
    writeFileSync(join(root, 'surety', 'context', 'canary.json'), JSON.stringify({ kind: 'positive', edit: { path: 'canary/edit.txt', content: 'token-123\n' }, result: { status: 'completed', summary: 'canary done' } }));
    const modeFile = join(dir, 'mode.json');
    writeFileSync(modeFile, JSON.stringify({ root }));
    const child = spawn(process.execPath, [FAKE, ...T.render({ model: 'm', invocation: 'i' })], { env: { PATH: '/usr/bin:/bin', FAKE_CODEX_MODE: modeFile, ...templates.templateEnv(T, KEY) }, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.end(T.stdin);
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0);
    assert.equal(readFileSync(join(root, 'surety', 'workspace', 'canary', 'edit.txt'), 'utf8'), 'token-123\n');
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'surety', 'out', 'result.json'), 'utf8')), { status: 'completed', summary: 'canary done' });
    const r = feed(stdout.split('\n'));
    assert.deepEqual(r.terminals, ['success']);
    assert.ok(r.summary.items.some((i) => i.type === 'file_change'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
