// Developer tests for Codex qualification judged as a real backend (C2 of
// Codex support, 2026-10-27; D2 §§4.5, 4.6, 7.2): the attempt's driver
// judges each canary on Codex's stream as the adapter reads it, against a
// FAKE codex (fixtures/codex/fake-codex.mjs), which runs no model, holds no
// account and contacts nothing. The real `codex` binary is never executed.
//
// The driver runs here against a stub of the engine's store and launcher:
// each canary's run is the fake codex acting out canary.json in a temporary
// root, its stdout read by the Codex adapter, and the observation the choke
// point would keep is built from what it wrote. What the sandbox alone
// observes (the containment actions, the egress log) is synthetic and says
// so. The host's sampler reads real processes of this test's own (copies of
// bash, ended by their handles).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const codex = await import(join(dist, 'invoke', 'adapters', 'codex.js'));
const templates = await import(join(dist, 'invoke', 'adapters', 'templates.js'));
const { QualificationDriver, realFailureClass, realBackendOf, codexBeyondDomain } = await import(join(dist, 'trust', 'attempts.js'));
const { canaryObservations } = await import(join(dist, 'invoke', 'choke.js'));
const C = await import(join(dist, 'trust', 'canaries.js'));
const { ACTION_HARDENING } = await import(join(dist, 'invoke', 'probes', 'program.js'));
const { helpHash } = await import(join(dist, 'invoke', 'static.js'));
const { recordsDir } = await import(join(dist, 'records', 'files.js'));
const { startBackendSampler, isCompanion } = await import(join(dist, 'invoke', 'sampler.js'));
const { prepareQualify, CODEX_SESSIONS_NOT_BUILT } = await import(join(dist, 'trust', 'qualify.js'));
const { parseQualify, DEFAULT_EGRESS } = await import(join(dist, 'trust', 'qualify-command.js'));
const { attemptSpendEstimate, attemptSpendUnavailable, normalizeFor, CODEX_PRICE_TABLE } = await import(join(dist, 'store', 'transitions', 'ledger.js'));

const FAKE = join(here, 'fixtures', 'codex', 'fake-codex.mjs');
const KEY = 'sk-proj-SYNTHETICCODEXTESTKEY000000000000000000000000';
const T = templates.templateOf('codex');
const MODEL = 'gpt-5-codex';
const ONE_BACKEND = { samples: 6, max_backend: 1, max_members: 2, unclassified: 0, backend_cmdlines: ['codex exec --json'], transient_backend: 0, embedded_tool: 0, embedded_tool_cmdlines: [] };

// ---- the fake codex, run as the template runs it ----

// One canary's run: the fake given the template's arguments, environment and
// standard input, in a root of its own holding canary.json and prompt.md.
async function runCanary(dir, attempt, kind, mode = {}) {
  const root = mkdtempSync(join(dir, `${kind}-`));
  for (const d of ['surety/context', 'surety/out', 'surety/workspace']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'surety/context/prompt.md'), '# the prompt\n');
  writeFileSync(join(root, 'surety/context/canary.json'), JSON.stringify(C.canaryInstructions({ attempt, kind, deadlineSeconds: 60 })));
  const modeFile = join(root, 'mode.json');
  writeFileSync(modeFile, JSON.stringify({ root, linger_ms: 50, ...mode }));
  const env = { PATH: process.env.PATH, FAKE_CODEX_MODE: modeFile, ...templates.templateEnv(T, mode.key === undefined ? KEY : mode.key) };
  if (mode.key === null) for (const v of [T.keyVariable, ...T.keyAliases]) delete env[v];
  const child = spawn(process.execPath, [FAKE, ...T.render({ model: MODEL, invocation: 'inv_x' })], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.end(T.stdin);
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  let barrierSeen = false;
  let termToExitMs = null;
  const barrier = join(root, C.CANARY_BARRIER.slice(1));
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  if (kind === 'cancellation') {
    // The engine's end of the cancellation canary: the barrier seen, then
    // SIGTERM to this test's own child, timed to its exit.
    for (let i = 0; i < 200 && !existsSync(barrier); i++) await new Promise((r) => setTimeout(r, 25));
    barrierSeen = existsSync(barrier);
    const t0 = performance.now();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    termToExitMs = Math.round(performance.now() - t0);
  }
  const { code } = await exited;
  const s = new codex.CodexStream();
  for (const line of stdout.split('\n')) s.feed(line);
  const resultPath = join(root, 'surety/out/result.json');
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
  const edit = C.canaryEdit(attempt);
  const editPath = join(root, 'surety/workspace', edit.path);
  const editContent = existsSync(editPath) ? readFileSync(editPath, 'utf8') : null;
  return { code, summary: s.summary(), result, editContent, barrierSeen, termToExitMs };
}

// What the choke point would keep of the run (choke.ts recordCanary). The
// containment actions, the host's watch and the egress log are the sandbox's
// and are SYNTHETIC here: every action as expected, the provider's tunnel to
// api.openai.com carrying bytes both ways, the unlisted CONNECT refused.
function observation(kind, r, sampling) {
  const clean = r.code === 0 && r.summary.terminal?.type === 'turn.completed';
  const containment = kind === 'containment';
  return {
    kind,
    exitClass: kind === 'cancellation' ? 'engine_signaled' : clean ? 'clean' : 'error_exit',
    verdict: r.result === null ? 'absent' : 'accepted',
    value: r.result,
    resultValue: r.result,
    editContent: r.editContent,
    editObserved: r.editContent === null ? { type: 'missing' } : { type: 'file', bytes: Buffer.byteLength(r.editContent) },
    witnesses: containment ? C.CONTAINMENT_ACTIONS.map((a) => ({ action: a.name, outcome: a.expected, pid: 7, detail: 'synthetic', completed: true, backend_running: true, hardening: [...ACTION_HARDENING] })) : [],
    containment: containment ? { ns_pid: 2, seen: { host_pid: 200, at: 't0' }, requested_at: 't1', present_at_end: true, ended_at: 't2', reason: null } : null,
    containmentDone: containment ? { ran: true, backend_running: true, reason: null, at: 't2' } : null,
    barrierSeen: r.barrierSeen,
    barrierAt: r.barrierSeen ? 't1' : null,
    termToExitMs: r.termToExitMs,
    egress: [
      { authority: 'api.openai.com:443', decision: 'accepted', reason: null, opened_at: 't0', bytes_up: 900, bytes_down: 4000 },
      ...(containment ? [{ authority: C.CANARY_UNLISTED, decision: 'refused', reason: 'not_listed', opened_at: 't1' }] : []),
    ],
    providerFilesRecord: null,
    stream: null,
    codexStream: r.summary,
    sampling,
    exitStatus: r.code,
  };
}

// ---- the driver against a stub of the store and the launcher ----

async function attempt(t, { modes = {}, sampling = {}, model = MODEL, kinds } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cq-attempt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  mkdirSync(recordsDir(home), { recursive: true });
  writeFileSync(join(home, 'api.token'), 'synthetic-token\n');
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'config'), '[core]\n');
  // The binary as the help check runs it: a wrapper around the fake.
  const binary = join(dir, 'codex');
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(binary, 0o755);
  const help = await helpHash(binary, 'codex');
  assert.notEqual(help, null, 'the fake answers --help');
  const id = `att_codex_${Math.random().toString(36).slice(2, 10)}`;
  const row = {
    id,
    status: 'running',
    backend: 'codex',
    model,
    auth_mode: 'api_key',
    mode: 'one_shot_headless',
    session_entry: null,
    template: T.text,
    template_version: T.version,
    binary_path: binary,
    binary_sha256: 'synthetic',
    help_sha256: help,
    version: 'codex-cli 0.160.0',
    candidate_egress: JSON.stringify(['api.openai.com']),
    canary_deadlines: JSON.stringify({ positive: 30, cancellation: 30, containment: 30 }),
    fixture_project: 'prj_fixture',
    profile_fingerprint: 'synthetic',
    host_qualification: 'hq_synthetic',
  };
  const records = new Map();
  const canaries = [];
  let concluded = null;
  const runs = new Map();
  const rt = {
    home,
    boundary: () => 'kernel',
    services: null,
    scope: null,
    engine: async (op, args) => {
      if (op === 'qualification.start') return row;
      if (op === 'qualification.canary_item') return `item_${args.kind}`;
      if (op === 'qualification.canary') return canaries.push(args.canary);
      if (op === 'qualification.conclude') return (concluded = args);
      if (op === 'qualification.invalidate') return (concluded = { invalidated: args.reason });
      if (op === 'record.publish_whole') return records.set(args.id, args.path);
      if (op === 'record.scan') return null;
      throw new Error(`unexpected engine op ${op}`);
    },
    read: async (op, args) => {
      if (op === 'qualification.row') return row;
      if (op === 'qualification.drift') return null;
      if (op === 'qualification.target') return { repo, project: 'prj_fixture' };
      if (op === 'qualification.canary_run') return runs.get(args.item) ?? null;
      if (op === 'run.state') return 'ended';
      if (op === 'qualification.run_facts') return { outcome: 'completed', exit_class: null, transcript: null, provider_session_id: null };
      if (op === 'qualification.usage') return { observations: 3, cost: false };
      if (op === 'qualification.provider_files') return null;
      if (op === 'record.row') return null;
      throw new Error(`unexpected read ${op}`);
    },
  };
  const ran = [];
  const launcher = {
    dispatch: async (_target, item) => {
      const kind = item.id.replace(/^item_/, '');
      const r = await runCanary(dir, id, kind, modes[kind] ?? {});
      const run = `run_${kind}`;
      ran.push({ kind, r });
      canaryObservations.set(run, observation(kind, r, sampling[kind] ?? ONE_BACKEND));
      runs.set(item.id, run);
      return true;
    },
  };
  const driver = new QualificationDriver(rt, launcher);
  await driver.drive(id);
  const evidence = (c) => JSON.parse(readFileSync(join(recordsDir(home), records.get(c.evidence)), 'utf8'));
  const providerError = (c) => (c.provider_error === null ? null : JSON.parse(readFileSync(join(recordsDir(home), records.get(c.provider_error)), 'utf8')));
  return { concluded, canaries, ran, evidence, providerError, id };
}

test('a passing attempt: three canaries on the fake codex, the key delivered, nothing beyond the domain; the entry claims only what was seen', async (t) => {
  const a = await attempt(t);
  assert.deepEqual(a.canaries.map((c) => [c.kind, c.passed, c.failure_class]), [
    ['positive', true, null],
    ['cancellation', true, null],
    ['containment', true, null],
  ]);
  const pos = a.evidence(a.canaries[0]);
  assert.deepEqual(pos.credential_delivery.variables, ['CODEX_API_KEY', 'OPENAI_API_KEY']);
  assert.equal(pos.credential_delivery.variable, null, 'which variable Codex read is not established');
  assert.equal(pos.credential_delivery.established, true);
  assert.match(pos.credential_delivery.how, /turn\.completed.*agent message.*by elimination/);
  assert.equal(pos.stream.backend, 'codex');
  assert.equal(pos.stream.thread_id, '0199a213-81c0-7800-8aa1-bbab2a035a53');
  assert.equal(pos.stream.terminal.type, 'turn.completed');
  assert.deepEqual(pos.model, { requested: MODEL, reported: [], status: 'not_reported', text: 'model not reported: the stream named no model, so the model that answered is not established' });
  assert.ok(!JSON.stringify(pos).includes(KEY), 'the key is in no evidence');
  const cancel = a.evidence(a.canaries[1]);
  assert.equal(cancel.authenticated, true, 'answering when it reached the barrier');
  assert.ok(a.canaries[1].term_to_exit_ms !== null);
  const cont = a.evidence(a.canaries[2]);
  assert.equal(cont.capabilities.delegation_verified, true, JSON.stringify(cont.capabilities.reasons));
  assert.equal(cont.capabilities.basis, 'stream_and_host');
  assert.deepEqual(cont.capabilities.tools, [], 'no inventory: nothing claimed');
  assert.deepEqual(cont.capabilities.template_disabled, [...templates.CODEX_DISABLED_FEATURES, 'web_search', 'agents']);
  assert.ok(cont.controls.some((c) => c.name === 'provider_tunnel' && c.ran));
  const e = a.concluded.entry;
  assert.ok(e, 'the entry is written proposed');
  assert.equal(e.backend, 'codex');
  assert.deepEqual(e.capabilities, { tools: [], denied: [], features_disabled: [], delegation_verified: true });
  assert.deepEqual([e.usage_granularity, e.usage_semantics, e.cost_reporting], ['invocation', 'cumulative', 'tokens_only'], 'never reported');
  assert.deepEqual(e.egress_hosts, ['api.openai.com']);
  assert.equal(e.session_qualified, false);
});

test('a bad key: the positive canary fails auth_failed, delivery not established, the attempt ends there with no entry; the key in no record', async (t) => {
  const a = await attempt(t, { modes: { positive: { reject_key: KEY } } });
  assert.deepEqual(a.canaries.map((c) => [c.kind, c.passed, c.failure_class]), [['positive', false, 'auth_failed']]);
  assert.equal(a.concluded.entry, undefined, 'no entry');
  const ev = a.evidence(a.canaries[0]);
  assert.equal(ev.credential_delivery.established, false);
  assert.match(ev.stream.auth_failure, /401 Unauthorized/);
  assert.equal(ev.stream.failure.class, 'auth_failed');
  const pe = a.providerError(a.canaries[0]);
  assert.equal(pe.failure_class, 'auth_failed');
  assert.equal(pe.provider_error.failure.class, 'auth_failed');
  // No key at all: the same class.
  const none = await attempt(t, { modes: { positive: { key: null } } });
  assert.deepEqual(none.canaries.map((c) => c.failure_class), ['auth_failed']);
});

test('a web search item: the canary fails delegation_unverified at once, before any further canary', async (t) => {
  const a = await attempt(t, { modes: { positive: { outcome: 'web_search' } } });
  assert.deepEqual(a.canaries.map((c) => [c.kind, c.passed, c.failure_class]), [['positive', false, 'delegation_unverified']]);
  const ev = a.evidence(a.canaries[0]);
  assert.match(ev.beyond_domain[0], /web_search item \(provider_tool\)/);
  assert.deepEqual(ev.stream.beyond_domain.map((b) => b.type), ['web_search']);
  assert.equal(ev.result_matches, true, 'the work itself was done: the failure is the reach, not the result');
});

test('a second backend process: codex-code-mode-host on the host\'s samples counts as a second backend, and the canary fails delegation_unverified', async (t) => {
  // The host's reads, on processes of this test's own: copies of bash named
  // codex and codex-code-mode-host, each waiting on its pipe.
  const dir = mkdtempSync(join(tmpdir(), 'cq-companion-'));
  const kids = [];
  t.after(() => {
    for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });
  const backend = join(dir, 'codex');
  const host = join(dir, 'codex-code-mode-host');
  copyFileSync('/bin/bash', backend);
  copyFileSync('/bin/bash', host);
  const start = (bin) =>
    new Promise((resolve, reject) => {
      const k = spawn(bin, ['-c', 'read -r _'], { stdio: ['pipe', 'ignore', 'ignore'] });
      kids.push(k);
      k.once('spawn', () => resolve(k.pid));
      k.once('error', reject);
    });
  const pids = [await start(backend), await start(host)];
  writeFileSync(join(dir, 'cgroup.procs'), `${pids.join('\n')}\n`);
  const without = startBackendSampler(dir, backend, 0);
  without.sample();
  assert.equal(without.stop().max_backend, 1, 'by the binary alone the companion is not seen');
  const sampler = startBackendSampler(dir, backend, 0, undefined, codex.CODEX_COMPANION_PROCESSES);
  sampler.sample();
  const sampling = sampler.stop();
  assert.equal(sampling.max_backend, 2, JSON.stringify(sampling));
  assert.ok(sampling.backend_cmdlines.some((c) => c.includes('codex-code-mode-host')), JSON.stringify(sampling));
  assert.equal(isCompanion('/x/codex-code-mode-host', null, codex.CODEX_COMPANION_PROCESSES), true);
  assert.equal(isCompanion(null, 'codex-code-mode-host', codex.CODEX_COMPANION_PROCESSES), true);
  assert.equal(isCompanion('/x/codex-code-mode-host (deleted)', null, codex.CODEX_COMPANION_PROCESSES), true);
  assert.equal(isCompanion('/x/codex', 'codex', codex.CODEX_COMPANION_PROCESSES), false);
  assert.equal(isCompanion('/x/codex-code-mode-host', null, []), false);

  // Seen while the positive canary ran: it fails at once.
  const a = await attempt(t, { sampling: { positive: sampling } });
  assert.deepEqual(a.canaries.map((c) => [c.kind, c.passed, c.failure_class]), [['positive', false, 'delegation_unverified']]);
  assert.match(a.evidence(a.canaries[0]).beyond_domain[0], /second backend process.*codex-code-mode-host/);
  // Seen only during the containment canary: its actions held, the
  // delegation judgement fails it.
  const b = await attempt(t, { sampling: { containment: sampling } });
  assert.deepEqual(b.canaries.map((c) => [c.kind, c.passed, c.failure_class]), [
    ['positive', true, null],
    ['cancellation', true, null],
    ['containment', false, 'delegation_unverified'],
  ]);
  assert.equal(b.evidence(b.canaries[2]).capabilities.delegation_verified, false);
  assert.equal(b.concluded.entry, undefined);
});

test('the model: one the stream names that is not the entry\'s fails model_fallback; the requested one is "same"; none is "not reported", never verified', async (t) => {
  const s = new codex.CodexStream();
  for (const m of [{ type: 'thread.started', thread_id: 'th', model: 'gpt-5-mini' }, { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } }]) s.feed(JSON.stringify(m));
  const sum = s.summary();
  assert.deepEqual(sum.models_seen, ['gpt-5-mini']);
  assert.equal(codex.codexModelReport(sum, MODEL).status, 'other');
  assert.match(codex.codexModelFallback(sum, MODEL).text, /model_fallback: gpt-5-codex -> gpt-5-mini/);
  assert.equal(codex.codexModelReport(sum, 'gpt-5-mini').status, 'same');
  assert.equal(codex.codexModelFallback(sum, 'gpt-5-mini'), null);
  assert.equal(codex.codexModelReport(null, MODEL).status, 'not_reported');
  // The model the stream named is on the usage, so the ledger can price it
  // (estimated, labelled unconfirmed), never reported.
  const n = normalizeFor('codex', { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, usage_final: true, model: 'gpt-5-mini' });
  assert.equal(n.cost_status, 'estimated');
  assert.match(n.normalization_version, /^codex-exec-json-1\+openai-list-.*-unconfirmed$/);
  // In an attempt: an attempt whose requested model the fake's stream does
  // not name passes with "model not reported" (above); one naming another
  // model is not built into the fake, so the class is checked on the rule.
  const base = { stream: null, codex: sum, authFailure: null, obs: undefined, candidates: [], capabilities: null, containmentHeld: true };
  assert.equal(realFailureClass('positive', 'invalid_result', { ...base, fallback: true }), 'model_fallback');
});

test('session_headless is refused for codex with invalid_value naming that Codex sessions are not built; an entry\'s session qualification too', async () => {
  const body = { backend: 'codex', mode: 'session_headless', model: MODEL, candidate_egress: ['api.openai.com'] };
  await assert.rejects(prepareQualify(body, { fixtureProject: async () => assert.fail('nothing is made'), home: '/nonexistent' }), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.code, 'invalid_value');
    assert.equal(e.subject?.field, 'mode');
    assert.match(e.message, /Codex sessions are not built \(M5's not-claimed list\)/);
    return true;
  });
  assert.match(CODEX_SESSIONS_NOT_BUILT, /one_shot_headless/);
  const entryOf = async (id) => ({ id, status: 'active', backend: 'codex', binary_path: '/nonexistent/codex', binary_sha256: 'x', help_sha256: 'y', model: MODEL, auth_mode: 'api_key', egress_hosts: '["api.openai.com"]', session_qualified: 0 });
  await assert.rejects(prepareQualify({ entry: 'tre_codex', mode: 'session_headless' }, { fixtureProject: async () => assert.fail('nothing is made'), home: '/nonexistent', entryOf }), (e) => e.code === 'invalid_value' && e.subject?.field === 'mode' && /Codex sessions are not built/.test(e.message));
});

test('the default egress: api.openai.com for codex when none is named; a named host replaces it; claude unchanged', () => {
  assert.deepEqual(DEFAULT_EGRESS.codex, ['api.openai.com']);
  assert.deepEqual(DEFAULT_EGRESS.claude, ['api.anthropic.com']);
  assert.deepEqual(parseQualify(['codex', '--mode', 'one_shot_headless', '--model', MODEL]).body.candidate_egress, ['api.openai.com']);
  assert.deepEqual(parseQualify(['codex', '--mode', 'one_shot_headless', '--model', MODEL, '--egress', 'example.test']).body.candidate_egress, ['example.test']);
  assert.ok(!JSON.stringify(DEFAULT_EGRESS).includes('openex'));
});

test('the spend estimate: from the unconfirmed Codex price table, labelled so; a model it does not list has none, with the reason, never 0', () => {
  assert.equal(CODEX_PRICE_TABLE.confirmed, false);
  assert.match(CODEX_PRICE_TABLE.version, /unconfirmed/);
  const e = attemptSpendEstimate('codex', MODEL, 200_000);
  assert.deepEqual(e, { usd: 6, price_version: CODEX_PRICE_TABLE.version, prices: 'unconfirmed' });
  assert.equal(attemptSpendUnavailable('codex', MODEL), null);
  assert.equal(attemptSpendEstimate('codex', 'gpt-5.5-codex', 200_000), null);
  assert.match(attemptSpendUnavailable('codex', 'gpt-5.5-codex'), /no Codex price for gpt-5\.5-codex.*unknown, never 0/);
  // Claude's unchanged: no `prices` label of Codex's.
  const c = attemptSpendEstimate('claude', 'claude-sonnet-5-5', 200_000);
  assert.equal(c.prices, undefined);
  // A Codex ledger row is never `reported`: no model named, unknown.
  assert.equal(normalizeFor('codex', { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, usage_final: true }).cost_status, 'unknown');
  assert.equal(normalizeFor('codex', { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, usage_final: false, model: MODEL }).cost_status, 'unknown', 'partial usage is not priced');
});

test('the failure classes: Codex auth_failed is auth_failed; usage_limit and provider_error fall to the kind\'s class, the provider\'s class kept in the record', async (t) => {
  const sum = (lines) => {
    const s = new codex.CodexStream();
    for (const l of lines) s.feed(JSON.stringify(l));
    return s.summary();
  };
  const auth = sum([{ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } }]);
  const limit = sum([{ type: 'turn.failed', error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } }]);
  const other = sum([{ type: 'turn.failed', error: { message: 'stream disconnected before completion' } }]);
  assert.match(codex.codexAuthFailure(auth), /401/);
  assert.equal(codex.codexAuthFailure(limit), null);
  assert.equal(codex.codexFailure(limit).class, 'usage_limit');
  assert.equal(codex.codexFailure(other).class, 'provider_error');
  const base = { stream: null, obs: { exitClass: 'error_exit', exitStatus: 1, egress: [] }, candidates: ['api.openai.com'], capabilities: null, containmentHeld: false };
  assert.equal(realFailureClass('positive', 'invalid_result', { ...base, codex: auth, authFailure: codex.codexAuthFailure(auth) }), 'auth_failed');
  assert.equal(realFailureClass('positive', 'invalid_result', { ...base, codex: limit, authFailure: null }), 'invalid_result');
  assert.equal(realFailureClass('cancellation', 'barrier_not_reached', { ...base, codex: other, authFailure: null }), 'barrier_not_reached');
  // A stream with no line and a nonzero exit: unsupported_flag, as for claude.
  assert.equal(realFailureClass('positive', 'invalid_result', { ...base, codex: sum([]), authFailure: null }), 'unsupported_flag');
  // Something beyond the domain: delegation_unverified, unless containment itself did not hold.
  assert.equal(realFailureClass('positive', 'invalid_result', { ...base, codex: other, authFailure: null, beyondDomain: true }), 'delegation_unverified');
  assert.equal(realFailureClass('containment', 'containment_failed', { ...base, codex: other, authFailure: null, beyondDomain: true, containmentHeld: false }), 'containment_failed');
  // A clean positive with no command or file change: tool_action_missing.
  const idle = sum([{ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'x' } }, { type: 'turn.completed', usage: {} }]);
  assert.equal(realFailureClass('positive', 'invalid_result', { ...base, obs: { exitClass: 'clean', exitStatus: 0, egress: [] }, codex: idle, authFailure: null }), 'tool_action_missing');
  assert.equal(realBackendOf('codex'), 'codex');
  assert.equal(realBackendOf('scripted'), null);
  assert.deepEqual(codexBeyondDomain(null, null), []);

  // In an attempt: a usage limit on the positive canary fails it as the
  // kind's class, its provider_error record naming usage_limit.
  const a = await attempt(t, { modes: { positive: { outcome: 'usage_limit' } } });
  assert.deepEqual(a.canaries.map((c) => [c.kind, c.passed, c.failure_class]), [['positive', false, 'invalid_result']]);
  assert.equal(a.providerError(a.canaries[0]).provider_error.failure.class, 'usage_limit');
});
