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
const { helpHash, featureInventory } = await import(join(dist, 'invoke', 'static.js'));
const CF = await import(join(dist, 'invoke', 'adapters', 'codex-features.js'));
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
  if (mode.key === null) for (const v of templates.keyVariables('codex')) delete env[v];
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

async function attempt(t, { modes = {}, sampling = {}, model = MODEL, kinds, features = {}, snapshots = {} } = {}) {
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
  // Its `features list` as `features` sets it (the static checks' run
  // passes no FAKE_CODEX_MODE, so the wrapper names the file).
  const featuresMode = join(dir, 'features-mode.json');
  writeFileSync(featuresMode, JSON.stringify(features));
  writeFileSync(binary, `#!/bin/sh\nFAKE_CODEX_MODE="${featuresMode}" exec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(binary, 0o755);
  const help = await helpHash(binary, 'codex');
  assert.notEqual(help, null, 'the fake answers --help');
  const inventory = await featureInventory(binary, 'codex', CF.CODEX_FEATURES_ARGS);
  assert.notEqual(inventory, null, 'the fake answers features list');
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
    feature_inventory: inventory.text,
    feature_inventory_sha256: inventory.sha256,
    feature_inventory_args: JSON.stringify(inventory.args),
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
      canaryObservations.set(run, { ...observation(kind, r, sampling[kind] ?? ONE_BACKEND), ...(snapshots[kind] === undefined ? {} : { codexShellSnapshots: snapshots[kind] }) });
      runs.set(item.id, run);
      return true;
    },
  };
  const driver = new QualificationDriver(rt, launcher);
  await driver.drive(id);
  const evidence = (c) => JSON.parse(readFileSync(join(recordsDir(home), records.get(c.evidence)), 'utf8'));
  const providerError = (c) => (c.provider_error === null ? null : JSON.parse(readFileSync(join(recordsDir(home), records.get(c.provider_error)), 'utf8')));
  return { concluded, canaries, ran, evidence, providerError, id, inventory };
}

test('a passing attempt: three canaries on the fake codex, the key delivered, nothing beyond the domain; the entry claims only what was seen', async (t) => {
  const a = await attempt(t);
  assert.deepEqual(a.canaries.map((c) => [c.kind, c.passed, c.failure_class]), [
    ['positive', true, null],
    ['cancellation', true, null],
    ['containment', true, null],
  ]);
  assert.equal(T.version, 'codex-exec-4', 'the attempt is on template version 4');
  const pos = a.evidence(a.canaries[0]);
  assert.deepEqual(pos.credential_delivery.variables, ['CODEX_API_KEY'], 'K3: the key in CODEX_API_KEY alone');
  assert.equal(pos.credential_delivery.variable, null, 'the stream does not name the variable Codex read');
  assert.match(pos.credential_delivery.how, /the key in CODEX_API_KEY was the only credential/);
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
  assert.equal(cont.capabilities.feature_inventory.verified, true, 'the 0.160.0 inventory, every family feature disabled or off');
  for (const h of HARDENING) assert.ok(cont.capabilities.feature_inventory.disabled_by_template.includes(h), `${h} recorded disabled by the template`);
  assert.deepEqual(cont.capabilities.feature_inventory.left_enabled, []);
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
  // (estimated, a lower bound from the pricing page), never reported.
  const n = normalizeFor('codex', { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, usage_final: true, model: 'gpt-5-mini' });
  assert.equal(n.cost_status, 'estimated');
  assert.equal(n.normalization_version, 'codex-exec-json-2+openai-pricing-page-2026-10-27+cache-write-not-reported-priced-as-input+lower-bound');
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

test('the spend estimate: from the pricing-page Codex price table, a lower bound with its reasons, a legacy model\'s status shown; a model it does not list has none, with the reason, never 0', () => {
  assert.equal(CODEX_PRICE_TABLE.version, 'openai-pricing-page-2026-10-27');
  assert.equal(CODEX_PRICE_TABLE.prices, 'from_pricing_page');
  const e = attemptSpendEstimate('codex', MODEL, 200_000);
  assert.deepEqual(Object.keys(e).sort(), ['bound', 'lower_bound_reasons', 'model_status', 'price_version', 'prices', 'usd']);
  assert.deepEqual([e.usd, e.price_version, e.prices, e.bound], [6, CODEX_PRICE_TABLE.version, 'from_pricing_page', 'lower']);
  assert.match(e.model_status, /shut down; API shutdown July 23, 2026/);
  assert.match(e.lower_bound_reasons[0], /long-context tier.*fast mode/);
  const sol = attemptSpendEstimate('codex', 'gpt-6.1-sol', 200_000);
  assert.equal(sol.usd, 6, 'three canaries at 200,000 tokens at $10 per 1M output');
  assert.equal(sol.model_status, undefined, 'a current model shows no status');
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

test('the failure classes: Codex auth_failed is auth_failed; usage_limit is usage_limit (K7); provider_error falls to the kind\'s class; the provider\'s class kept in the record', async (t) => {
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
  assert.equal(realFailureClass('positive', 'invalid_result', { ...base, codex: limit, authFailure: null }), 'usage_limit');
  assert.equal(realFailureClass('cancellation', 'barrier_not_reached', { ...base, codex: limit, authFailure: null }), 'usage_limit');
  assert.equal(realFailureClass('containment', 'containment_failed', { ...base, codex: limit, authFailure: null }), 'usage_limit');
  // An authentication failure still comes first, and a provider error is not a limit.
  assert.equal(realFailureClass('positive', 'invalid_result', { ...base, codex: limit, authFailure: 'unexpected status 401 Unauthorized' }), 'auth_failed');
  assert.equal(realFailureClass('positive', 'invalid_result', { ...base, codex: other, authFailure: null }), 'invalid_result');
  // Claude's stream is unchanged: no Codex stream, no usage_limit.
  assert.equal(realFailureClass('positive', 'invalid_result', { ...base, codex: null, stream: null, authFailure: null }), 'invalid_result');
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

  // In an attempt: a usage limit on the positive canary fails it
  // usage_limit, its provider_error record naming usage_limit as before.
  const a = await attempt(t, { modes: { positive: { outcome: 'usage_limit' } } });
  assert.deepEqual(a.canaries.map((c) => [c.kind, c.passed, c.failure_class]), [['positive', false, 'usage_limit']]);
  const pe = a.providerError(a.canaries[0]);
  assert.equal(pe.failure_class, 'usage_limit');
  assert.equal(pe.provider_error.failure.class, 'usage_limit');
  assert.match(pe.provider_error.failure.message, /429 Too Many Requests/);
  assert.equal(a.concluded.entry, undefined, 'no entry');
});

test('usage_limit is a CanaryFailureClass (D2 A.2 addition, K7 of 2026-10-28), last, after not_dispatched, and in the published contract', async () => {
  assert.ok(C.CANARY_FAILURE_CLASSES.includes('usage_limit'));
  assert.equal(C.CANARY_FAILURE_CLASSES.at(-1), 'usage_limit');
  assert.equal(C.CANARY_FAILURE_CLASSES.indexOf('usage_limit'), C.CANARY_FAILURE_CLASSES.indexOf('not_dispatched') + 1);
  assert.ok(!C.CANARY_FAILURE_CLASSES.includes('provider_error'), 'provider_error stays inside the canary\'s record, not a class');
  const { exportContract } = await import(join(dist, 'contract', 'document.js'));
  assert.deepEqual(exportContract().enums.CanaryFailureClass, [...C.CANARY_FAILURE_CLASSES]);
  const committed = JSON.parse(readFileSync(join(here, '..', '..', 'api', 'schema.json'), 'utf8'));
  assert.deepEqual(committed.enums.CanaryFailureClass, [...C.CANARY_FAILURE_CLASSES], 'the committed contract carries it');
});

// ---- the feature inventory (C2b; D2 §4.6, D2-T13) ----

const REAL_0160 = readFileSync(join(here, 'fixtures', 'codex', 'features-0.160.0.txt'), 'utf8');
const HARDENING = ['unbounded_connection_retries', 'system_proxy_fallback', 'image_generation', 'unified_exec_tty', 'sleep_tool', 'shell_snapshot'];

test('the classification against the saved 0.160.0 list: no unknown name, every basis stated; the source-grounded classes (C2c, K6 of 2026-10-28)', () => {
  const { features } = CF.parseCodexFeatures(REAL_0160);
  const unknown = features.filter((f) => !CF.CODEX_FEATURE_CLASSES.has(f.name)).map((f) => f.name);
  assert.deepEqual(unknown, [], 'no name of the saved inventory is unknown to the table');
  assert.equal(CF.CODEX_FEATURE_CLASSES.size, features.length, 'the table names exactly the 154 features the list names');
  for (const [n, c] of CF.CODEX_FEATURE_CLASSES) assert.ok(c.basis.length > 20, `${n} has a basis`);
  const cls = (n) => CF.CODEX_FEATURE_CLASSES.get(n);
  // Hardening: outside the family, the template disables them.
  for (const h of HARDENING) {
    assert.deepEqual([cls(h).family, cls(h).hardening], [false, true], h);
    assert.ok(templates.CODEX_DISABLED_FEATURES.includes(h), `--disable ${h}`);
  }
  assert.equal([...CF.CODEX_FEATURE_CLASSES.values()].filter((c) => c.hardening).length, 6);
  // unified_exec: the command tool, not delegation; it cannot be disabled.
  assert.deepEqual([cls('unified_exec').family, cls('unified_exec').hardening], [false, false]);
  assert.match(cls('unified_exec').basis, /cannot be disabled \(core\/src\/config\/managed_features\.rs:157-165\).*D2 §4\.4/);
  // Web search: the top-level key governs it; the -c override is the control.
  assert.equal(cls('web_search_request').family, true);
  assert.match(cls('web_search_request').basis, /top-level `web_search` key.*do not switch it off.*web_search="disabled"/);
  assert.match(cls('web_search_request').basis, /hosted tool.*api\.openai\.com/);
  for (const w of ['standalone_web_search', 'web_search_cached', 'web_search_request']) assert.ok(CF.codexTemplateDisables().has(w), `${w} covered by the override`);
  assert.ok(CF.codexTemplateDisables([], ['web_search="disabled"']).has('web_search_request'), 'the override alone covers it');
  // No reader: fail closed, said so.
  assert.equal(cls('workspace_dependencies').family, true);
  assert.match(cls('workspace_dependencies').basis, /^no reader in codex-rs at this tag; behaviour unestablished; fail closed/);
  // Removed no-ops and the multi_agent_v2-dependent names say so.
  for (const r of ['enable_fanout', 'remote_control', 'send_async_message']) assert.match(cls(r).basis, /removed at this tag, a no-op/, r);
  for (const r of ['agent_message_board', 'defer_mailbox_preemption']) assert.match(cls(r).basis, /only with multi_agent_v2/, r);
  // Named wrongly by name before, now by source: startup ordering, Windows only.
  assert.equal(cls('deferred_executor').family, false);
  assert.match(cls('deferred_executor').basis, /startup ordering, not scheduling/);
  assert.equal(cls('prefer_mxc').family, false);
  // A name classified by name only is off in the saved list, and says so.
  const on = new Map(features.map((f) => [f.name, f.enabled]));
  for (const [n, c] of CF.CODEX_FEATURE_CLASSES) if (/by name only/.test(c.basis)) assert.equal(on.get(n), false, `${n}: by name only, off`);
});

// The real 0.160.0 binary's list under the template's flags (C2d): run on
// 2026-10-28 in an empty CODEX_HOME with exactly CF.CODEX_FEATURES_ARGS
// (exit 0), saved verbatim.
const REAL_TEMPLATE = readFileSync(join(here, 'fixtures', 'codex', 'features-0.160.0-template.txt'), 'utf8');
const ARGS = [...CF.CODEX_FEATURES_ARGS];
const judged = (text, ...rest) => CF.judgeCodexFeatures({ text, sha256: 'x', args: ARGS }, ...rest);

test('the inventory\'s arguments are the template\'s own --disables and -c overrides, then features list, last (C2d): the two cannot drift', () => {
  const want = [...templates.CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]), ...templates.CODEX_CONFIG_OVERRIDES.flatMap((c) => ['-c', c]), 'features', 'list'];
  assert.deepEqual(ARGS, want);
  assert.deepEqual(ARGS.slice(-2), ['features', 'list']);
  // Every --disable and -c of the run's arguments is in the inventory's, in the same order.
  const run = T.render({ model: MODEL, invocation: 'inv_x' });
  const pairs = (a) => a.flatMap((x, i) => ((x === '--disable' || x === '-c') && i + 1 < a.length ? [`${x} ${a[i + 1]}`] : []));
  assert.deepEqual(pairs(ARGS), pairs(run), 'the same feature configuration as the launched run');
  assert.equal(pairs(ARGS).filter((p) => p.startsWith('--disable ')).length, 28);
  // The two the 0.160.0 binary rejects in front of features list are not passed.
  assert.ok(!ARGS.includes('--ignore-user-config') && !ARGS.includes('--strict-config'));
});

test('the real 0.160.0 list under the template\'s flags (saved): every --disabled name reads false, the same 154 names as the default list; the fake reproduces it byte for byte', async (t) => {
  const { features, unparsed } = CF.parseCodexFeatures(REAL_TEMPLATE);
  assert.equal(features.length, 154);
  assert.deepEqual(unparsed, []);
  const state = new Map(features.map((f) => [f.name, f.enabled]));
  for (const d of templates.CODEX_DISABLED_FEATURES) assert.equal(state.get(d), false, `${d} reads false under the template's flags`);
  for (const h of HARDENING) assert.equal(state.get(h), false, h);
  assert.deepEqual(features.map((f) => f.name), CF.parseCodexFeatures(REAL_0160).features.map((f) => f.name));
  assert.equal(state.get('unified_exec'), true, 'unified_exec cannot be disabled and the template does not try');
  const dir = mkdtempSync(join(tmpdir(), 'cq-fake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = join(dir, 'mode.json');
  writeFileSync(m, '{}');
  const p = join(dir, 'codex');
  writeFileSync(p, `#!/bin/sh\nFAKE_CODEX_MODE="${m}" exec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(p, 0o755);
  const inv = await featureInventory(p, 'codex', CF.CODEX_FEATURES_ARGS);
  assert.equal(inv.text, REAL_TEMPLATE, 'the fake honouring every --disable prints what the real binary printed');
});

test('the feature inventory: the template-flag list as recorded, every name classified; every --disable observed off, the override-only names configured; passes', () => {
  const j = judged(REAL_TEMPLATE);
  assert.equal(j.verified, true, JSON.stringify(j.reasons));
  assert.equal(j.failure_class, null);
  assert.deepEqual(j.args, ARGS);
  assert.deepEqual([j.left_enabled, j.unknown, j.unparsed, j.not_honoured], [[], [], [], []]);
  // Observed off: each of the 28 --disables, read false in the list.
  for (const d of templates.CODEX_DISABLED_FEATURES) assert.ok(j.disabled_by_template.includes(d), `${d} observed off`);
  for (const h of HARDENING) assert.ok(j.disabled_by_template.includes(h) && !j.configured_only.includes(h), `${h} observed off, not configured only`);
  // Configured only: the names an override alone covers (web search, the sub-agent names beside multi_agent).
  assert.deepEqual([...j.configured_only].sort(), ['multi_agent_mode', 'multi_agent_v2', 'standalone_web_search', 'web_search_cached', 'web_search_request']);
  assert.equal(j.disabled_by_template.length, 33, 'the 28 observed off and the 5 configured only');
  assert.ok(j.unavailable.includes('agent_message_board'), 'a family feature the list reports off is unavailable');
  assert.ok(j.outside_family_enabled.includes('unified_exec'), 'outside the family: recorded only');
});

test('the feature inventory judged: the default list (no flags) shows every --disable not honoured; recorded with no arguments, or other ones, not observed under the template\'s flags', () => {
  // The binary's defaults, as C2b recorded them: 27 of the 28 --disabled
  // features read true, so none of those is shown off.
  const d = judged(REAL_0160);
  assert.equal(d.verified, false);
  assert.equal(d.not_honoured.length, 27);
  assert.equal(d.failure_class, 'delegation_unverified', 'family features among them');
  const none = CF.judgeCodexFeatures({ text: REAL_TEMPLATE, sha256: 'x' });
  assert.equal(none.verified, false);
  assert.equal(none.failure_class, 'delegation_unverified');
  assert.match(none.reasons.join('\n'), /recorded no arguments for its inventory, so it is not known to have run under the template's flags/);
  const other = CF.judgeCodexFeatures({ text: REAL_TEMPLATE, sha256: 'x', args: ['features', 'list'] });
  assert.equal(other.verified, false);
  assert.match(other.reasons.join('\n'), /run with other arguments than the template's flags \(`features list`\)/);
});

test('the feature inventory judged: a family feature the template leaves on, an unknown feature, an empty list, an unparsed line, none recorded: each unverified, named', () => {
  const on = judged(REAL_TEMPLATE.replace(/^(agent_message_board\s+under development\s+)false$/m, '$1true'));
  assert.equal(on.verified, false);
  assert.deepEqual(on.left_enabled, ['agent_message_board']);
  assert.equal(on.failure_class, 'delegation_unverified');
  assert.match(on.reasons.join('\n'), /agent_message_board is on in the inventory/);
  const unknown = judged(`${REAL_TEMPLATE}background_scheduler                     stable             false\n`);
  assert.equal(unknown.verified, false, 'an unknown feature fails even when off');
  assert.deepEqual(unknown.unknown, [{ name: 'background_scheduler', stage: 'stable', enabled: false }]);
  assert.match(unknown.reasons.join('\n'), /background_scheduler \(stable, off\) is a feature this engine does not know/);
  assert.equal(judged('').verified, false);
  assert.match(judged('').reasons[0], /names no feature/);
  assert.match(judged('goals stable false\n').reasons.join('\n'), /does not name multi_agent/);
  assert.match(judged(`${REAL_TEMPLATE}what is this\n`).reasons.join('\n'), /not a feature, its stage and its state: "what is this"/);
  assert.match(CF.judgeCodexFeatures(null).reasons[0], /recorded no `codex features list` inventory/);
  assert.equal(CF.judgeCodexFeatures(null).failure_class, 'delegation_unverified');
  // Outside the family and not disabled: recorded only, never a failure.
  const outside = judged(REAL_TEMPLATE.replace(/^(js_repl\s+removed\s+)false$/m, '$1true'));
  assert.equal(outside.verified, true);
  assert.ok(outside.outside_family_enabled.includes('js_repl'));
});

test('the feature inventory judged (C2d): a --disabled feature the list reports on was not honoured: hardening alone fails unsupported_flag, a family one delegation_unverified, both delegation_unverified; one the list omits is not observed off', () => {
  const flip = (text, name) => text.replace(new RegExp(`^(${name}\\s+\\S.*?\\s+)false$`, 'm'), '$1true');
  const snap = judged(flip(REAL_TEMPLATE, 'shell_snapshot'));
  assert.equal(snap.verified, false);
  assert.deepEqual(snap.not_honoured, ['shell_snapshot']);
  assert.equal(snap.failure_class, 'unsupported_flag');
  assert.deepEqual(snap.reasons, ["shell_snapshot is disabled by the template (--disable shell_snapshot) but the inventory run under the template's flags reports it on: the flag was not honoured"]);
  assert.ok(!snap.disabled_by_template.includes('shell_snapshot'), 'not shown off');
  for (const h of HARDENING) {
    const j = judged(flip(REAL_TEMPLATE, h));
    assert.deepEqual([j.verified, j.failure_class, j.not_honoured], [false, 'unsupported_flag', [h]], h);
  }
  const goals = judged(flip(REAL_TEMPLATE, 'goals'));
  assert.deepEqual([goals.verified, goals.failure_class, goals.not_honoured], [false, 'delegation_unverified', ['goals']]);
  assert.match(goals.reasons[0], /^goals is disabled by the template \(--disable goals\) but the inventory run under the template's flags reports it on: the flag was not honoured$/);
  const both = judged(flip(flip(REAL_TEMPLATE, 'goals'), 'sleep_tool'));
  assert.deepEqual([both.failure_class, [...both.not_honoured].sort()], ['delegation_unverified', ['goals', 'sleep_tool']]);
  const omitted = judged(REAL_TEMPLATE.replace(/^shell_snapshot\s.*\n/m, ''));
  assert.deepEqual([omitted.verified, omitted.failure_class, omitted.not_honoured], [false, 'unsupported_flag', ['shell_snapshot']]);
  assert.match(omitted.reasons[0], /does not name it: it is not observed off/);
  // A hardening feature the template does not disable is recorded only, as before.
  const noSleep = templates.CODEX_DISABLED_FEATURES.filter((f) => f !== 'sleep_tool');
  const j = judged(flip(REAL_TEMPLATE, 'sleep_tool'), CF.codexTemplateDisables(noSleep), noSleep);
  assert.equal(j.verified, true, JSON.stringify(j.reasons));
  assert.ok(j.outside_family_enabled.includes('sleep_tool'));
});

test('the inventory recorded: features list run by the static checks under the template\'s flags, its text, SHA-256 and arguments; a binary that does not answer has none', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cq-inv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = (name, mode) => {
    const m = join(dir, `${name}.json`);
    writeFileSync(m, JSON.stringify(mode));
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\nFAKE_CODEX_MODE="${m}" exec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const inv = await featureInventory(bin('codex-a', {}), 'codex', CF.CODEX_FEATURES_ARGS);
  assert.equal(inv.text, REAL_TEMPLATE);
  assert.deepEqual(inv.args, ARGS, 'the arguments it was run with');
  const { createHash } = await import('node:crypto');
  assert.equal(inv.sha256, createHash('sha256').update(REAL_TEMPLATE).digest('hex'));
  assert.equal(await featureInventory(bin('codex-b', { features_exit: 2 }), 'codex', CF.CODEX_FEATURES_ARGS), null, 'a nonzero exit records none');
  // The template's two flags the real binary rejects there: no inventory.
  assert.equal(await featureInventory(bin('codex-c', {}), 'codex', ['--ignore-user-config', ...ARGS]), null);
  assert.equal(await featureInventory(bin('codex-d', {}), 'codex', ['--strict-config', ...ARGS]), null);
});

// C2e (observed on MAIN 2026-10-28): the real 0.160.0 binary's `features
// list` exits 1 "failed to resolve CODEX_HOME" when CODEX_HOME names no
// directory, while `--version` only warns; the static checks once set
// CODEX_HOME in their environment without making it. The fake now fails as
// the real binary does, so this pins the directory's creation.
test('the static checks make the CODEX_HOME they name (C2e): features list answers under the real static environment; with the directory gone it fails as the real binary does', async (t) => {
  const { versionOf } = await import(join(dist, 'invoke', 'static.js'));
  const dir = mkdtempSync(join(tmpdir(), 'cq-home-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = join(dir, 'mode.json');
  writeFileSync(m, '{}');
  const script = (name, before) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${before}FAKE_CODEX_MODE="${m}" exec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(p, 0o755);
    return p;
  };
  // What the static environment gives the binary: CODEX_HOME an existing,
  // empty directory, recorded by the wrapper before the fake runs.
  const seen = join(dir, 'seen.txt');
  const plain = script('codex', `{ [ -d "$CODEX_HOME" ] && echo dir || echo missing; ls -A "$CODEX_HOME" 2>/dev/null | wc -l; } > "${seen}"\n`);
  const inv = await featureInventory(plain, 'codex', CF.CODEX_FEATURES_ARGS);
  assert.notEqual(inv, null, 'features list answers: the static checks made CODEX_HOME');
  assert.equal(inv.text, REAL_TEMPLATE);
  assert.deepEqual(readFileSync(seen, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean), ['dir', '0'], 'an existing, empty directory');
  assert.equal(await versionOf(plain, 'codex'), 'codex-cli 0.160.0');
  assert.notEqual(await helpHash(plain, 'codex'), null);
  // The directory gone before the fake starts (the defect's environment):
  // features list fails, so no inventory; --version still answers.
  const gone = script('codex-gone', 'rmdir "$CODEX_HOME" || exit 9\n');
  assert.equal(await featureInventory(gone, 'codex', CF.CODEX_FEATURES_ARGS), null, 'no inventory with CODEX_HOME missing');
  assert.equal(await versionOf(gone, 'codex'), 'codex-cli 0.160.0', '--version does not need CODEX_HOME');
  // The fake run directly, as the real binary answered on 2026-10-28: a
  // missing CODEX_HOME exits 1 with the real message on standard error and
  // nothing on standard output; unset likewise; an existing empty one exits 0.
  const run = (env) => new Promise((resolve) => {
    const c = spawn(process.execPath, [FAKE, ...CF.CODEX_FEATURES_ARGS], { env: { PATH: process.env.PATH, FAKE_CODEX_MODE: m, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (status) => resolve({ status, out, err }));
  });
  const missing = await run({ CODEX_HOME: join(dir, 'no-such-codex-home') });
  assert.equal(missing.status, 1);
  assert.equal(missing.out, '');
  assert.match(missing.err, /^Error: failed to resolve CODEX_HOME\n/);
  const unset = await run({});
  assert.equal(unset.status, 1);
  assert.match(unset.err, /^Error: failed to resolve CODEX_HOME\n/);
  const notDir = await run({ CODEX_HOME: m });
  assert.equal(notDir.status, 1, 'a file is not a directory');
  const empty = join(dir, 'empty-codex-home');
  mkdirSync(empty);
  const present = await run({ CODEX_HOME: empty });
  assert.equal(present.status, 0);
  assert.equal(present.out, REAL_TEMPLATE);
});

test('the driver: all family features disabled or off, the three canaries run; one left on, or an unknown one, fails delegation_unverified, named, before any canary is launched', async (t) => {
  const ok = await attempt(t);
  assert.deepEqual(ok.canaries.map((c) => c.passed), [true, true, true]);
  assert.equal(ok.inventory.text, REAL_TEMPLATE);
  for (const [features, name] of [
    [{ features_set: { agent_message_board: true } }, 'agent_message_board'],
    [{ features_set: { overnight_runner: false } }, 'overnight_runner'],
  ]) {
    const a = await attempt(t, { features });
    assert.deepEqual(a.canaries.map((c) => [c.kind, c.run, c.passed, c.failure_class]), [['positive', null, false, 'delegation_unverified']]);
    assert.equal(a.ran.length, 0, 'no canary was launched');
    assert.equal(a.concluded.entry, undefined, 'no entry');
    const ev = a.evidence(a.canaries[0]);
    assert.equal(ev.outcome, 'not_launched');
    assert.equal(ev.feature_inventory.verified, false);
    assert.equal(ev.feature_inventory.sha256, a.inventory.sha256, 'the judgement names the inventory it judged');
    assert.match(ev.feature_inventory.reasons.join('\n'), new RegExp(name));
  }
});

test('the driver (C2d, the owner\'s question of 2026-10-28): a binary that accepts --disable shell_snapshot and ignores it fails the attempt unsupported_flag, named, before any canary; honouring every disable, the six hardening names are observed off', async (t) => {
  const bad = await attempt(t, { features: { features_ignore_disable: ['shell_snapshot'] } });
  assert.match(bad.inventory.text, /^shell_snapshot\s+stable\s+true$/m, 'the fake reports it on under the template\'s flags');
  assert.match(bad.inventory.text, /^sleep_tool\s+stable\s+false$/m, 'every other disable honoured');
  assert.deepEqual(bad.canaries.map((c) => [c.kind, c.run, c.passed, c.failure_class]), [['positive', null, false, 'unsupported_flag']]);
  assert.equal(bad.ran.length, 0, 'no canary was run');
  assert.equal(bad.concluded.entry, undefined, 'no entry');
  const ev = bad.evidence(bad.canaries[0]);
  assert.equal(ev.outcome, 'not_launched');
  assert.equal(ev.failure_class, 'unsupported_flag');
  assert.match(ev.reason, /shell_snapshot/);
  assert.deepEqual(ev.feature_inventory.not_honoured, ['shell_snapshot']);
  assert.equal(ev.feature_inventory.failure_class, 'unsupported_flag');
  assert.match(ev.feature_inventory.reasons.join('\n'), /shell_snapshot is disabled by the template \(--disable shell_snapshot\) but the inventory run under the template's flags reports it on: the flag was not honoured/);
  assert.deepEqual(ev.feature_inventory.args, ARGS, 'the arguments the inventory was run with');
  // A family feature ignored the same way stays delegation_unverified.
  const fam = await attempt(t, { features: { features_ignore_disable: ['hooks'] } });
  assert.deepEqual(fam.canaries.map((c) => [c.kind, c.run, c.passed, c.failure_class]), [['positive', null, false, 'delegation_unverified']]);
  assert.equal(fam.ran.length, 0);
  // The positive control: every disable honoured.
  const good = await attempt(t);
  assert.deepEqual(good.canaries.map((c) => c.passed), [true, true, true]);
  const caps = good.evidence(good.canaries[2]).capabilities.feature_inventory;
  assert.equal(caps.verified, true, JSON.stringify(caps.reasons));
  for (const h of HARDENING) assert.ok(caps.disabled_by_template.includes(h) && !caps.configured_only.includes(h), `${h} observed off`);
  assert.deepEqual(caps.not_honoured, []);
});

test('the shell snapshots (C2d): a Codex canary whose collection saw a file in $CODEX_HOME/shell_snapshots/ fails containment_failed, recorded; an empty one, or none, does not', async (t) => {
  const left = { state: 'present', type: 'dir', entries: 1, files: 1 };
  const pos = await attempt(t, { snapshots: { positive: left } });
  assert.deepEqual(pos.canaries.map((c) => [c.kind, c.passed, c.failure_class]), [['positive', false, 'containment_failed']]);
  assert.deepEqual(pos.evidence(pos.canaries[0]).shell_snapshots, { path: '/surety/home/.codex/shell_snapshots', ...left });
  const cont = await attempt(t, { snapshots: { containment: left } });
  assert.deepEqual(cont.canaries.map((c) => [c.kind, c.passed, c.failure_class]), [
    ['positive', true, null],
    ['cancellation', true, null],
    ['containment', false, 'containment_failed'],
  ]);
  const empty = await attempt(t, { snapshots: { positive: { state: 'present', type: 'dir', entries: 0, files: 0 }, containment: { state: 'absent' } } });
  assert.deepEqual(empty.canaries.map((c) => c.passed), [true, true, true]);
  assert.deepEqual(empty.evidence(empty.canaries[0]).shell_snapshots, { path: '/surety/home/.codex/shell_snapshots', state: 'present', type: 'dir', entries: 0, files: 0 });
  // Not observed is recorded as such, never as absent.
  assert.deepEqual(empty.evidence(empty.canaries[1]).shell_snapshots, { path: '/surety/home/.codex/shell_snapshots', state: 'not_observed' });
  // The auth failure stays first.
  assert.equal(realFailureClass('positive', 'invalid_result', { stream: null, codex: null, authFailure: 'x', obs: undefined, candidates: [], capabilities: null, containmentHeld: false, shellSnapshot: true }), 'auth_failed');
  assert.equal(realFailureClass('cancellation', 'barrier_not_reached', { stream: null, codex: null, authFailure: null, obs: undefined, candidates: [], capabilities: null, containmentHeld: false, shellSnapshot: true }), 'containment_failed');
});

// ---- the Codex price table (2026-10-28; PRICING.md of batch-2026-10-27d) ----

test('the price table: every row of the report, each with its pricing source and read date; the legacy rows marked; cache writes on the gpt-6 and gpt-5.6 rows only', () => {
  const rows = CODEX_PRICE_TABLE.models;
  assert.deepEqual(Object.keys(rows).sort(), ['gpt-5', 'gpt-5-codex', 'gpt-5-mini', 'gpt-5.3-codex', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra']);
  assert.deepEqual([rows['gpt-6.1-sol'].input, rows['gpt-6.1-sol'].cached_in, rows['gpt-6.1-sol'].out, rows['gpt-6.1-sol'].cache_write], [2, 0.1, 10, 1.25]);
  for (const [m, r] of Object.entries(rows)) {
    assert.equal(r.read, '2026-10-27', m);
    assert.ok(r.sources.includes(`https://developers.openai.com/api/docs/models/${m}`), m);
    assert.equal(r.sources.includes('https://developers.openai.com/api/docs/pricing'), m !== 'gpt-5-codex', `${m}: gpt-5-codex is on its model page only`);
    assert.equal(r.cache_write !== undefined, /^gpt-6|^gpt-5\.6/.test(m), `${m}'s cache-write rate`);
  }
  assert.deepEqual(['gpt-5', 'gpt-5-mini', 'gpt-5-codex', 'gpt-5.3-codex'].map((m) => rows[m].status), ['deprecated', 'deprecated', 'shut_down', 'deprecated']);
  assert.match(rows['gpt-5'].status_note, /December 11, 2026/);
  assert.match(rows['gpt-5.6-sol'].note, /promotional.*November 21, 2026/);
  assert.equal(CODEX_PRICE_TABLE.lower_bound_reasons.length, 4);
});

test('the ledger estimate for gpt-6.1-sol: the documented example usage priced as a lower bound, estimated never reported; a reported cache write at 1.25x input, kept in the raw usage; an unlisted model unknown with the reason', () => {
  // The documented `turn.completed` usage (input 24763, cached 24448, output
  // 122, reasoning 0): 315 plain input at $2, 24448 cached at $0.10, 122
  // output at $10 = $0.0042948.
  const doc = { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0, usage_final: true, model: 'gpt-6.1-sol' };
  const n = normalizeFor('codex', doc);
  assert.deepEqual([n.billable_in, n.cached_in, n.out, n.cost_status, n.cost_usd], [315, 24448, 122, 'estimated', 0.0042948]);
  assert.equal(n.normalization_version, 'codex-exec-json-2+openai-pricing-page-2026-10-27+cache-write-not-reported-priced-as-input+lower-bound');
  // Reasoning tokens are inside output: never added.
  assert.equal(normalizeFor('codex', { ...doc, reasoning_output_tokens: 80 }).cost_usd, 0.0042948);
  // A cache write reported: out of plain input, at 1.25x input ($2.50).
  // 763 plain at $2 + 4000 written at $2.50 + 20000 cached at $0.10 + 122
  // output at $10 = $0.014746.
  const w = normalizeFor('codex', { ...doc, cached_input_tokens: 20000, cache_write_input_tokens: 4000 });
  assert.deepEqual([w.billable_in, w.cost_status, w.cost_usd], [4763, 'estimated', 0.014746]);
  assert.equal(w.normalization_version, 'codex-exec-json-2+openai-pricing-page-2026-10-27+cache-write-reported-1.25x-input-30m+lower-bound');
  // A model with no write rate listed: the write at the input rate, said so.
  const g55 = normalizeFor('codex', { ...doc, model: 'gpt-5.5', cached_input_tokens: 20000, cache_write_input_tokens: 4000 });
  assert.match(g55.normalization_version, /\+cache-write-reported-at-input-no-write-rate-listed\+lower-bound$/);
  assert.equal(g55.cost_usd, (4763 * 5 + 20000 * 0.5 + 122 * 30) / 1e6);
  // More writes than uncached input contradicts the relation: unknown.
  assert.equal(normalizeFor('codex', { ...doc, cache_write_input_tokens: 400 }).cost_status, 'unknown');
  // The adapter keeps the field in the raw usage where the CLI gives it,
  // and never writes it as 0 where it does not.
  const fed = (line) => {
    const st = new codex.CodexStream();
    const out = st.feed(JSON.stringify(line));
    return out?.usage?.[0]?.raw ?? null;
  };
  const kept = fed({ type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 20000, cache_write_input_tokens: 4000, output_tokens: 122, reasoning_output_tokens: 0 } });
  assert.equal(kept.cache_write_input_tokens, 4000);
  const absent = fed({ type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 } });
  assert.equal('cache_write_input_tokens' in absent, false);
  // Never reported, whatever the usage.
  for (const x of [n, w, g55]) assert.notEqual(x.cost_status, 'reported');
  // An unlisted model: no estimate, the reason shown, never 0.
  const un = normalizeFor('codex', { ...doc, model: 'gpt-7-nova' });
  assert.deepEqual([un.cost_status, un.cost_usd], ['unknown', null]);
  assert.equal(attemptSpendEstimate('codex', 'gpt-7-nova', 200_000), null);
  assert.match(attemptSpendUnavailable('codex', 'gpt-7-nova'), /no Codex price for gpt-7-nova: the Codex price table \(openai-pricing-page-2026-10-27\) lists .*gpt-6\.1-sol.* only, so the spend is not estimated \(unknown, never 0\)/);
});
