// Developer tests for E74 (the subscription token beside the API key; the
// slice-14 review's S1 to S3 and the hardening of item 3), engine side, with
// no backend: the subscription template and its credential's delivery, the
// fold that never lets an unknown count replace a known one, the first
// terminal event winning, the key's path never echoed when it may be the
// key, the engine's own pinned copy of a binary, the fixture repository
// repaired, and the sampler stopping by itself. Streams are synthetic.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { templateOf, credentialRef, keyVariable, CLAUDE_QUIET_ENV } = await import(join(dist, 'invoke', 'adapters', 'templates.js'));
const claude = await import(join(dist, 'invoke', 'adapters', 'claude.js'));
const { foldObservations, normalizeFor, terminalUsageObserved } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
const { SecretFileRefused, readSecretFile, KEY_REFERENCES } = await import(join(dist, 'invoke', 'keys.js'));
const { pinBinary, backendsDir } = await import(join(dist, 'trust', 'pin.js'));
const { ensureFixtureRepo } = await import(join(dist, 'trust', 'fixture.js'));
const { startBackendSampler } = await import(join(dist, 'invoke', 'sampler.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-e74-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const feedAll = (stream, events) => {
  const usage = [];
  const out = [];
  for (const e of events) {
    const r = stream.feed(JSON.stringify(e));
    usage.push(...r.usage);
    out.push(r);
  }
  return { usage, out };
};

test('the subscription template: no --bare; safe mode, user settings only, no MCP; the token in CLAUDE_CODE_OAUTH_TOKEN; the quiet variables in both modes', () => {
  const sub = templateOf('claude', { authMode: 'subscription_token' });
  const key = templateOf('claude', { authMode: 'api_key' });
  assert.equal(templateOf('claude').version, key.version, 'api_key is the default mode');
  const args = sub.render({ model: 'claude-sonnet-5-5', invocation: 'inv_1' });
  assert.ok(!args.includes('--bare'), '--bare never reads CLAUDE_CODE_OAUTH_TOKEN');
  assert.deepEqual(args.slice(0, 5), ['-p', '--safe-mode', '--setting-sources', 'user', '--strict-mcp-config']);
  assert.deepEqual(args.slice(5), key.render({ model: 'claude-sonnet-5-5', invocation: 'inv_1' }).slice(2), 'the rest as the API-key template');
  assert.equal(sub.keyVariable, 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.equal(sub.keyRef, 'backend/claude/subscription_token');
  assert.equal(credentialRef('claude', 'subscription_token'), 'backend/claude/subscription_token');
  assert.equal(keyVariable('claude', 'subscription_token'), 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.equal(credentialRef('claude'), 'backend/claude/api_key');
  for (const t of [sub, key]) {
    assert.deepEqual(t.env, { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    for (const [k, v] of Object.entries(CLAUDE_QUIET_ENV)) assert.ok(t.text.includes(`${k}=${v}`), `the template's text binds ${k}`);
  }
  assert.notEqual(sub.version, key.version);
  assert.equal(key.version, 'claude-one-shot-2', 'the environment change is a template version change');
  assert.equal(templateOf('codex', { authMode: 'subscription_token' }), undefined, 'a backend without the mode has no template for it');
  assert.ok(KEY_REFERENCES.includes('backend/claude/subscription_token'));
});

test('subscription delivery: established only when the model answered with apiKeySource "none"; a key in use is not the token', () => {
  const answered = (source) => {
    const s = new claude.ClaudeStream({ costAs: 'estimated' });
    feedAll(s, [
      { type: 'system', subtype: 'init', tools: ['Read'], apiKeySource: source },
      { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] } },
    ]);
    return s.summary();
  };
  const ok = claude.claudeKeyDelivery(answered('none'), 'subscription_token');
  assert.deepEqual([ok.variable, ok.established], ['CLAUDE_CODE_OAUTH_TOKEN', true]);
  assert.match(ok.basis, /elimination/);
  assert.equal(claude.claudeAuthFailure(answered('none'), 'subscription_token'), null, '"none" is expected under the token');
  assert.match(claude.claudeAuthFailure(answered('none'), 'api_key'), /no API key/, 'and an auth failure under the key');
  const wrong = answered('ANTHROPIC_API_KEY');
  assert.equal(claude.claudeKeyDelivery(wrong, 'subscription_token').established, false);
  assert.match(claude.claudeAuthFailure(wrong, 'subscription_token'), /not the subscription token/);
});

test('subscription cost: Claude Code\'s figure recorded estimated with its label, never reported', () => {
  const s = new claude.ClaudeStream({ costAs: 'estimated' });
  const { usage } = feedAll(s, [{ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.05, usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } }]);
  const n = normalizeFor('claude', foldObservations(usage));
  assert.deepEqual([n.cost_status, n.cost_usd], ['estimated', 0.05]);
  assert.match(n.normalization_version, /claude-code-total_cost_usd/);
});

test('S1: a terminal total missing a count is not final, and never replaces the per-call count observed', () => {
  const s = new claude.ClaudeStream();
  const { usage } = feedAll(s, [
    { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 0 }, content: [] } },
    { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 100, outputTokens: 7, cacheReadInputTokens: 0 } } },
  ]);
  const raw = foldObservations(usage);
  assert.equal(raw.usage_final, false, 'cacheCreationInputTokens missing: not final');
  assert.equal(raw.cache_creation_input_tokens, 50, 'the per-call count stands');
  assert.equal(terminalUsageObserved('claude', raw), false);
  assert.equal(normalizeFor('claude', raw).billable_in, 150);
  assert.deepEqual(foldObservations([{ semantics: 'delta', raw: { input_tokens: 5 } }, { semantics: 'cumulative', raw: { input_tokens: null } }]), { input_tokens: 5 }, 'a null never overwrites a known count');
});

test('the first terminal event wins; a second is a protocol error, ignored with its usage', () => {
  const s = new claude.ClaudeStream();
  const { out } = feedAll(s, [
    { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } },
    { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 999 } },
  ]);
  assert.equal(out[0].terminal, 'success');
  assert.deepEqual([out[1].terminal, out[1].usage.length], [null, 0]);
  assert.match(out[1].protocolError, /second terminal/);
  assert.equal(s.summary().protocol_errors.length, 1);
});

test('a synthesized error message counts no usage; the message-id set is bounded', () => {
  const s = new claude.ClaudeStream();
  const { usage } = feedAll(s, [{ type: 'assistant', error: 'rate_limit', message: { id: 'e1', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] } }]);
  assert.equal(usage.length, 0);
  const many = new claude.ClaudeStream();
  let counted = 0;
  for (let i = 0; i < 10_005; i++) counted += many.feed(JSON.stringify({ type: 'assistant', message: { id: `m${i}`, usage: { input_tokens: 1 }, content: [] } })).usage.length;
  assert.equal(counted, 10_000);
  assert.equal(many.summary().usage_ids_truncated, true);
});

test('S3: a value given in place of the key file\'s path is never echoed', (t) => {
  const dir = scratch(t);
  const ref = 'backend/claude/subscription_token';
  const token = 'sk-ant-oat01-NOTAREALTOKEN000000000000000000000000';
  for (const given of [token, `/${token}`]) {
    let err = null;
    try {
      readSecretFile(ref, given, dir);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof SecretFileRefused);
    assert.ok(!err.shownPath.includes(token), `not echoed: ${err.shownPath}`);
    assert.ok(!err.why.includes(token));
  }
  const f = join(dir, 'tok');
  writeFileSync(f, token, { mode: 0o644 });
  chmodSync(f, 0o644);
  let err = null;
  try {
    readSecretFile(ref, f, join(dir, 'home'));
  } catch (e) {
    err = e;
  }
  assert.equal(err.shownPath, f, 'a real path is shown');
});

test("the engine's pinned copy: in its home, mode 0500, the same bytes, reused, the source untouched", async (t) => {
  const dir = scratch(t);
  const home = join(dir, 'home');
  mkdirSync(home);
  const src = join(dir, '2.1.289');
  writeFileSync(src, '#!/bin/sh\necho fake\n', { mode: 0o755 });
  const before = statSync(src);
  const a = await pinBinary(home, 'claude', src, '2.1.289 (Claude Code)');
  const sha = createHash('sha256').update(readFileSync(src)).digest('hex');
  assert.equal(a.sha256, sha);
  assert.equal(a.path, join(backendsDir(home), `claude-2.1.289-${sha.slice(0, 16)}`));
  assert.equal(statSync(a.path).mode & 0o777, 0o500);
  assert.equal(createHash('sha256').update(readFileSync(a.path)).digest('hex'), sha);
  const b = await pinBinary(home, 'claude', src, '2.1.289 (Claude Code)');
  assert.equal(b.path, a.path, 'the same copy is reused');
  assert.equal(statSync(src).mtimeMs, before.mtimeMs, 'the source is not written');
  assert.equal(statSync(src).mode & 0o777, 0o755);
});

test('the fixture repository is repaired when a start stopped half way', async (t) => {
  const home = scratch(t);
  configureGit({ deadlineSeconds: 10, outputCap: 1 << 20, home, incarnation: 'inc_unit' });
  const repo = join(home, 'qualification', 'fixture');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const made = await ensureFixtureRepo(home);
  const g = (...a) => execFileSync('git', ['-C', made, ...a]).toString().trim();
  assert.equal(g('rev-list', '--count', 'main'), '1', 'the missing commit made');
  assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'and HEAD detached');
  execFileSync('git', ['-C', made, 'checkout', '-q', 'main']);
  await ensureFixtureRepo(home);
  assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'an attached HEAD detached again');
  assert.equal(g('rev-list', '--count', 'main'), '1', 'nothing more committed');
});

test('the sampler stops by itself once the domain is gone, and reads nothing of a missing cgroup', async () => {
  const s = startBackendSampler('/sys/fs/cgroup/surety-unit-no-such-domain', process.execPath, 5);
  await new Promise((r) => setTimeout(r, 60));
  const report = s.stop();
  assert.deepEqual([report.samples, report.max_backend], [0, 0]);
  assert.ok(!existsSync('/sys/fs/cgroup/surety-unit-no-such-domain'));
});
