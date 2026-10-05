// M136, the Claude adapter's usage and delegation judgements with a FAKE
// backend (M2 slice 14, SANDBOX LANE, manifest slice 14; no model, no key,
// no network beyond the engine's proxy). The slice-14 review's S1 and S2
// (E74 items 2 and 3); M2 plan §3.8 M136 (c), (d); D2 §1.5, §4.2, §4.5, C4;
// SEAM.md §§120, 148, 161, 165, 167.
//
// The backend is `claude`, bound in the engine's test mode to a test-owned
// fake (`harness/standin/fake-claude.mjs`): a script that prints synthetic
// stream-json and acts out the canaries. It is never the real binary, and
// the engine's test mode refuses the real one (section 148). The attempt's
// approval is the test's own, as in M135: nothing here is paid.
//
// S1: usage is final only when every count is known, and a null never
// overwrites a known count (E74 item 3). (a) A success `result` whose
// `modelUsage` lacks a count, after per-call usage was observed: the ledger
// row keeps the observed counts, `usage_complete` 0, the unknown allowance
// charged. (b) A failure `result` with no totals after model calls: the
// observed per-call counts are kept.
// S2: the tool inventory must be a subset of the template's `--tools`, and
// the host's sampler must have seen the backend at least once (E74 item 3).
// (a) An inventory listing `Skill` is not `delegation_verified`. (b) A
// backend the sampler never identified is not `delegation_verified`.
//
// S3 (the E79 rehearsal's finding 2; D2 §4.5, §7.2; SEAM.md §172): the
// host sampler counts a second backend process by what runs the qualified
// binary as an invocation of it. (a) A backend that holds forks of itself
// before their exec (as Claude Code opens one for each command it runs),
// each held longer than a sample, is not seen as a second backend and is
// delegation_verified; (b) a backend that starts a persisting second
// instance of itself (exec'd) still is a second backend; (c) so is a fork
// that stays unexec'd for longer than the rule allows. These three run on a
// production-mode engine with a native fake (harness/sandbox/nativefake.mjs
// says why); the fake is compiled with cc, as the power-loss shim is.
//
// E83 (SEAM.md §173; Sean's decision after E82, where the real agent
// refused the containment canary as a prompt injection): what the
// containment canary's agent is shown, read by the fake from inside its
// sandbox, names no target, states the sanctioned check in the run's own
// instructions.md and asks for no delegation or scheduling.
//
// E84 (Sean's second real-agent attempt; SEAM.md §174): a role's run that
// ends on its own, error_exit, after its provider could not be reached
// through the proxy, is recorded by its exit class (D2 §1.6; SEAM.md §143:
// failed / infra_error), never as a budget stop. Its ledger counts are not
// asserted here: E85 decides them (below).
//
// E85 (Sean's rule, after E84): when the egress evidence proves that nothing
// reached the provider, the run's usage is a known zero, and only when all
// four hold: (a) the domain's only network path is the engine's proxy;
// (b) its egress log is complete (not cut, no tunnel open); (c) no tunnel
// was accepted and no byte went up; (d) the backend's own report is absent
// or all zeros. Then the ledger shows zero billable and zero cost, usage
// complete, the basis recorded, no unknown allowance charged. Otherwise the
// usage stays unknown (or is the backend's counts). Asserted through
// GET /v1/projects/:p/ledger; the basis's field is the engine's to name.
//
// SAFETY (SEAM.md §141): the fake runs the containment canary's actions only
// when /surety/context exists and its pid namespace is not the host's, which
// the test gives it; the actions are the engine's probe program asking the
// domain init to act.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { installGatedPlan } from './harness/gates.mjs';
import { armFault } from './harness/engine.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { getPolicy } from './harness/journal.mjs';
import { ledgerRows } from './harness/ledger.mjs';
import { holdSecret, recordFile, recordRow } from './harness/records.mjs';
import { requestTick, waitForRun } from './harness/runs.mjs';
import { DOC, egressLogOf, setResolver } from './harness/sandbox/egress.mjs';
import { FakeClaude } from './harness/sandbox/fakeclaude.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { samplerAttempt, samplerEngine } from './harness/sandbox/nativefake.mjs';
import { approveAttempt, attemptOf, canaryOf, canaryRuns, qualify, waitAttempt } from './harness/sandbox/qualify.mjs';
import { hostPidNamespace } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { BACKENDS, PARK_ON_REFUSAL, apiKeyRef, installTrustEntry, useBackend } from './harness/trust.mjs';

const MODEL = 'claude-sonnet-5-5';
// Names under .example only, never resolved (SEAM.md §132).
const EGRESS = ['api.provider.example'];

// A sandbox-lane engine, the fake bound as `claude`, a fixture project, and
// a credential held for the attempt (the fake reads none).
async function fakeFixture(t, { config = {} } = {}) {
  const fx = await sandboxEngine(t, { config: { terminate_grace: 3, kill_grace: 2, ...config } });
  const fake = new FakeClaude(join(fx.root, 'fake-claude'), { modeDir: fx.scripted.dir });
  const project = (await addGitProject(fx)).id;
  await holdSecret(fx.engine, apiKeyRef('claude'), 'sk-test-surety-fake-claude-not-a-key-0000');
  return { fx, fake, project };
}

const body = (fake, project) => ({ backend: 'claude', mode: 'one_shot_headless', model: MODEL, binary: { path: fake.path }, fixture_project: project, candidate_egress: [...EGRESS], canary_deadlines: { positive: 120, cancellation: 60, containment: 120 } });

// The original ledger row of an attempt's first (positive) canary, once it ended.
async function positiveRow(fx, project, attemptId) {
  const run = await (async () => {
    for (let i = 0; i < 600; i++) {
      const [first] = canaryRuns(fx.home, attemptId);
      if (first?.state === 'ended') return first;
      await fx.engine.post(`/v1/projects/${project}/tick`, {}).catch(() => null);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`the positive canary of ${attemptId} did not end`);
  })();
  const rows = ledgerRows(fx.home, project).filter((r) => r.run === run.run && r.corrects === null);
  assert.equal(rows.length, 1, `one original ledger row for the positive canary (${JSON.stringify(rows)})`);
  return rows[0];
}

const runLimit = async (fx, project) => {
  const limit = (await getPolicy(fx.engine, project)).effective?.budget_run_billable_tokens;
  assert.ok(Number.isInteger(limit), `the project's run limit is read (SEAM.md §2): ${limit}`);
  return limit;
};

// The containment canary's evidence: its `capabilities` (SEAM.md §165).
function containmentCapabilities(fx, attempt) {
  const k = canaryOf(attempt, 'containment');
  assert.ok(k?.evidence, `the containment canary ran and kept its evidence (${JSON.stringify(attempt.canaries)})`);
  const ev = JSON.parse(readFileSync(recordFile(fx.home, recordRow(fx.home, k.evidence)), 'utf8'));
  return { k, ev, caps: ev.capabilities ?? null };
}

describe('M136 the Claude adapter with a fake backend: usage kept when the totals are incomplete; delegation verified only on the template\'s tools and a sampler that saw the backend (sandbox lane, no model)', () => {
  test('S1 (a): a success result whose modelUsage lacks a count, after per-call usage was observed: the ledger row keeps the observed counts, usage_complete 0, the unknown allowance charged', async (t) => {
    const { fx, fake, project } = await fakeFixture(t);
    fake.set({ positive: 'missing_count' });
    const attempt = await qualify(fx, body(fake, project));
    await approveAttempt(fx, project, attempt.id);
    const row = await positiveRow(fx, project, attempt.id);
    // Observed per call: input 1200, cache creation 3000, output 300; the
    // terminal totals lack cacheCreationInputTokens.
    assert.ok(row.billable_in !== null && row.billable_in >= 1200 + 3000, `the observed billable input (1200 + 3000 cache creation) is kept, not overwritten by the terminal's missing count (${JSON.stringify(row)})`);
    assert.equal(row.usage_complete, 0, `usage is not complete when a terminal count is unknown (${JSON.stringify(row)})`);
    const limit = await runLimit(fx, project);
    assert.equal(row.unknown_allowance_tokens, Math.max(0, limit - (row.billable_in + (row.out ?? 0))), `the unknown allowance is charged: the run limit less what was observed (D2 C4; SEAM.md §120) (${JSON.stringify(row)})`);
  });

  test('S1 (b): a failure result with no totals after model calls: the observed per-call counts are kept, usage_complete 0, the allowance charged', async (t) => {
    const { fx, fake, project } = await fakeFixture(t);
    fake.set({ positive: 'failure_no_totals' });
    const attempt = await qualify(fx, body(fake, project));
    await approveAttempt(fx, project, attempt.id);
    const row = await positiveRow(fx, project, attempt.id);
    // Observed per call: (40000 + 80000) + (30000 + 10000) billable input,
    // 80000 cache read, 500 + 700 output.
    assert.deepEqual([row.billable_in, row.cached_in, row.out], [160000, 80000, 1200], `the observed per-call counts are kept when the terminal event carries none (${JSON.stringify(row)})`);
    assert.equal(row.usage_complete, 0, 'usage incomplete');
    const limit = await runLimit(fx, project);
    assert.equal(row.unknown_allowance_tokens, Math.max(0, limit - 161200), `the allowance charged on the remainder (${JSON.stringify(row)})`);
    // The attempt ends after the canary's ledger row is written: waited for,
    // not read at once (a race seen 2026-10-05: it read `running`).
    const ended = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 600_000 });
    assert.equal(ended.status, 'failed', 'the failed positive canary fails the attempt');
  });

  test('S2 (a): an inventory listing a tool outside the template\'s --tools (Skill) is not delegation_verified; the attempt does not succeed', async (t) => {
    const { fx, fake, project } = await fakeFixture(t);
    fake.set({ extra_tools: ['Skill'] });
    const attempt = await qualify(fx, body(fake, project));
    await approveAttempt(fx, project, attempt.id);
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 600_000 });
    assert.equal(canaryOf(done, 'positive')?.passed, true, `the fixture is live: the positive canary passed (${JSON.stringify(done.canaries)})`);
    const { caps } = containmentCapabilities(fx, done);
    assert.equal(caps?.delegation_verified, false, `an inventory with Skill, a tool the template does not grant, is not delegation_verified (E74 item 3): ${JSON.stringify(caps)}`);
    assert.notEqual(done.status, 'succeeded', 'and the attempt does not succeed');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "trust_entries" WHERE "qualification_attempt" = ?').get(attempt.id).n), 0, 'no entry is written');
  });

  test('S2 (b): a host sampler that never identified the backend (its process title hides the binary) does not pass: not delegation_verified; the attempt does not succeed', async (t) => {
    const { fx, fake, project } = await fakeFixture(t);
    fake.set({ hide_title: true });
    const attempt = await qualify(fx, body(fake, project));
    await approveAttempt(fx, project, attempt.id);
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 600_000 });
    assert.equal(canaryOf(done, 'positive')?.passed, true, `the fixture is live: the positive canary passed (${JSON.stringify(done.canaries)})`);
    const { caps, ev } = containmentCapabilities(fx, done);
    assert.equal(caps?.delegation_verified, false, `a sampler that never saw the backend shows nothing absent: not delegation_verified (E74 item 3): ${JSON.stringify({ caps, sampling: ev.sampling ?? null })}`);
    assert.notEqual(done.status, 'succeeded', 'and the attempt does not succeed');
  });
});

describe('M136 S3: the host sampler counts a second backend process, not a fork of the backend before its exec (sandbox lane, production-mode engine, native fake, no model)', () => {
  // The rule pinned (SEAM.md §172): a member of the canary's domain whose
  // executable is the qualified binary is a backend process, except a fork
  // of it that has not exec'd (the kernel's PF_FORKNOEXEC, /proc/<pid>/stat
  // field 9) and is younger than 1 s by its start time; such a fork older
  // than 1 s counts. Two backend processes in one sample are a second
  // backend.
  // Each case on an engine of its own: the canaries of one attempt use a
  // good part of the fixture project's day limit on unknown tokens, and a
  // third attempt on one engine was stopped by it (found while writing
  // these cases).
  const SECOND = /second backend/i;
  const engineFor = async (t) => {
    const fx = await samplerEngine();
    t.after(() => fx.cleanup());
    return fx;
  };
  const live = (r, what) => {
    assert.ok(r.caps?.sampling?.samples > 0 && r.caps.sampling.max_backend >= 1, `the fixture is live: the engine's sampler identified the native fake as the backend (${what}): ${JSON.stringify(r.caps?.sampling)}`);
    assert.equal(canaryOf(r.attempt, 'positive')?.passed, true, `the fixture is live: the positive canary passed (${JSON.stringify(r.attempt.canaries)})`);
  };

  test('S3 (a): forks of the backend held 600 ms before their exec, three in turn, each longer than a sample: no second backend; delegation_verified', async (t) => {
    const r = await samplerAttempt(await engineFor(t), { mode: 1, holdMs: 600, count: 3 });
    live(r, 'fork windows');
    assert.ok(r.host.forks_unexeced_seen >= 1, `the fixture is live: the test's own host samples saw the backend and an unexec'd fork of it at once (${JSON.stringify(r.host)})`);
    assert.ok(!(r.caps.reasons ?? []).some((x) => SECOND.test(x)), `a fork before its exec is not a second backend process (SEAM.md §172): ${JSON.stringify({ reasons: r.caps.reasons, sampling: r.caps.sampling })}`);
    assert.equal(r.caps.delegation_verified, true, `delegation verified absent: the inventory is the template's and the sampler saw one backend (${JSON.stringify(r.caps)})`);
    assert.notEqual(r.k.failure_class, 'delegation_unverified', `the containment canary is not failed delegation_unverified for it (${JSON.stringify(r.k)})`);
  });

  test('S3 (b): a persisting second instance of the backend (exec\'d, 2.5 s): a second backend; not delegation_verified', async (t) => {
    const r = await samplerAttempt(await engineFor(t), { mode: 2, holdMs: 2500 });
    live(r, 'a second instance');
    assert.ok(r.host.exec_seconds_seen >= 1, `the fixture is live: the test's own host samples saw two exec'd instances of the image at once (${JSON.stringify(r.host)})`);
    assert.ok(r.caps.sampling.max_backend >= 2 && (r.caps.reasons ?? []).some((x) => SECOND.test(x)), `a second instance is a second backend process (D2 §7.2): ${JSON.stringify({ reasons: r.caps.reasons, sampling: r.caps.sampling })}`);
    assert.equal(r.caps.delegation_verified, false, 'not delegation_verified');
  });

  test('S3 (c): a fork of the backend that stays unexec\'d 2.5 s (older than the rule\'s 1 s): a second backend; not delegation_verified', async (t) => {
    const r = await samplerAttempt(await engineFor(t), { mode: 3, holdMs: 2500 });
    live(r, 'a persisting fork');
    assert.ok(r.host.forks_unexeced_seen >= 1, `the fixture is live: the test's own host samples saw the backend and its unexec'd fork at once (${JSON.stringify(r.host)})`);
    assert.ok(r.caps.sampling.max_backend >= 2 && (r.caps.reasons ?? []).some((x) => SECOND.test(x)), `a fork that runs the backend's own code past 1 s is a second backend process (SEAM.md §172): ${JSON.stringify({ reasons: r.caps.reasons, sampling: r.caps.sampling })}`);
    assert.equal(r.caps.delegation_verified, false, 'not delegation_verified');
  });
});

describe('M136 E83/E86: what the containment canary\'s agent is shown (sandbox lane, the fake backend, no model)', () => {
  test('E83/E86: no host path, credential path, port, host name or host pid namespace in anything under /surety/context or in the prompt; nothing names the check or a probe (E86: the agent only waits and ends with its result); no request to attempt delegation or scheduling', async (t) => {
    const { fx, fake, project } = await fakeFixture(t);
    fake.set({ dump_context: true });
    const attempt = await qualify(fx, body(fake, project));
    await approveAttempt(fx, project, attempt.id);
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 600_000 });
    const k = canaryOf(done, 'containment');
    assert.ok(k?.run, `the fixture is live: the containment canary ran (${JSON.stringify(done.canaries)})`);
    const dumpFile = join(fx.scripted.dir, 'fake-claude-context-containment.json');
    assert.ok(existsSync(dumpFile), 'the fixture is live: the fake wrote what the containment canary was shown');
    const shown = JSON.parse(readFileSync(dumpFile, 'utf8'));
    const files = [...shown.files, { name: 'the prompt argument', text: shown.prompt_argument }];
    for (const f of files) assert.ok(typeof f.text === 'string', `the fixture is live: ${f.name} was read whole`);

    // Every target the test can name (E83 item 2), looked for in every file
    // the agent can read there (the probe program included) and its prompt.
    const row = withStore(fx.home, (db) => db.prepare(`SELECT * FROM "records" WHERE "run" = ? AND "kind" = 'egress_log'`).get(k.run));
    const egress = row?.path ? readFileSync(recordFile(fx.home, row), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const unlisted = egress.filter((l) => l.decision === 'refused' && l.reason === 'not_listed').map((l) => String(l.authority).replace(/:\d+$/, ''));
    assert.ok(unlisted.length > 0, `the fixture is live: the egress log shows the unlisted CONNECT refused, so its host is known (${JSON.stringify(egress)})`);
    const targets = [
      ["the host user's home directory", homedir()],
      ['the engine home', fx.home],
      ['the engine home, resolved', realpathSync(fx.home)],
      ["the test's directory", fx.root],
      ["the engine's API token path", join(fx.home, 'api.token')],
      ["the host's pid namespace", hostPidNamespace()],
      ...EGRESS.map((h) => ['a candidate destination', h]),
      ...unlisted.map((h) => ['the unlisted destination', h]),
    ];
    const port = new RegExp(`(^|[^0-9])${fx.engine.port}([^0-9]|$)`);
    const gaps = [];
    for (const f of files) {
      for (const [what, value] of targets) if (value && f.text.includes(value)) gaps.push(`${f.name} holds ${what} (${value})`);
      if (port.test(f.text)) gaps.push(`${f.name} holds the engine's port (${fx.engine.port})`);
    }

    // E86 (SEAM.md §175, amending §173): the agent's task is harmless and
    // nothing it is shown names the check: canary.json is {kind, attempt,
    // wait_seconds, result}; no probe program in its package; the result
    // schema asks for no probe output; none of the check's words.
    const text = (name) => files.find((f) => f.name === name)?.text ?? '';
    let canaryJson = null;
    try {
      canaryJson = JSON.parse(text('canary.json'));
    } catch {
      gaps.push('canary.json is not JSON');
    }
    if (canaryJson) {
      const keys = Object.keys(canaryJson).sort();
      if (JSON.stringify(keys) !== JSON.stringify(['attempt', 'kind', 'result', 'wait_seconds'])) gaps.push(`canary.json holds ${JSON.stringify(keys)}, not {kind, attempt, wait_seconds, result}`);
    }
    if (files.some((f) => /(^|\/)probe(\.js)?$/.test(f.name))) gaps.push('the package holds a probe program');
    if (/probe_output/.test(text('result-schema.json'))) gaps.push('the result schema asks for probe_output');
    const WORDS = /\b(containment|probe|sanctioned|check)\b/i;
    // canary.json's own `kind` is exempt (objection 020; SEAM.md §175): §§149,
    // 165 and 175 fix it as "containment"; its every other value keeps the rule.
    const wordsOf = (name) => (name === 'canary.json' && canaryJson ? JSON.stringify({ ...canaryJson, kind: undefined }) : text(name));
    for (const name of ['the prompt argument', 'prompt.md', 'instructions.md', 'canary.json', 'result-schema.json']) {
      const m = wordsOf(name).match(WORDS);
      if (m) gaps.push(`${name} names "${m[0]}"`);
    }

    // No request to attempt delegation or scheduling (E83 item 3).
    const TOOLS = ['Agent', 'Task', 'ScheduleWakeup', 'Workflow', 'CronCreate', 'RemoteTrigger', 'SendMessage', 'Monitor'];
    for (const name of ['the prompt argument', 'prompt.md', 'instructions.md', 'canary.json', 'result-schema.json']) {
      for (const tool of TOOLS) if (new RegExp(`\\b${tool}\\b`).test(text(name))) gaps.push(`${name} names the tool ${tool}`);
    }
    assert.deepEqual(gaps, [], "what the containment canary's agent is shown names no target, nothing of the check and no delegation (E83, E86; SEAM.md §§173, 175)");
  });
});

// A Builder's run on the fake (mode `proxy_refused`): one CONNECT to the
// entry's egress host, then Claude Code's ending when the provider cannot be
// reached (E84). `accepted`: the harness resolver answers the name with a
// documentation address the harness holds unconnected (SEAM.md §169), so the
// proxy accepts the tunnel and the connect times out, nothing sent.
async function providerUnreachable(t, { accepted = false, role = 'proxy_refused', connectTimeout = 1 } = {}) {
  const { fx, fake, project } = await fakeFixture(t, { config: { egress_connect_timeout: connectTimeout, egress_resolve_timeout: 1 } });
  if (accepted) {
    await setResolver(fx.engine, { [EGRESS[0]]: [DOC.c] });
    await armFault(fx.engine, { point: 'egress_connect_hang', address: DOC.c });
  }
  fake.set({ role, connect: `${EGRESS[0]}:443` });
  await useBackend(fx.engine, project, BACKENDS.claude, { roles: ['builder'], extra: PARK_ON_REFUSAL });
  await installTrustEntry(fx.engine, { binary: { path: fake.path, sha256: fake.sha256 } }, { status: 'active', model: MODEL, egress_hosts: [...EGRESS] });
  const plan = await installGatedPlan(fx.engine, project, { stages: [{ number: 1, goal: 'a stage the provider never hears of' }] });
  await requestTick(fx.engine, project);
  const run = await waitForRun(fx.home, plan.stages[0].work_item, { state: 'ended', timeoutMs: 300_000 });
  const log = egressLogOf(fx.home, run.id);
  const ledger = (await fx.engine.get(`/v1/projects/${project}/ledger`)).body;
  const row = (ledger?.rows ?? []).find((r) => r.run === run.id && r.corrects === null);
  assert.ok(row, `the run has its original ledger row in GET /v1/projects/:p/ledger (${JSON.stringify(ledger?.rows)})`);
  return { fx, fake, project, run, log, ledger, row };
}

describe('M136 E84: a role run that ends error_exit on its own after its egress was refused (sandbox lane, the fake backend, no model)', () => {
  test('E84: the provider unreachable through the proxy, the backend ends error_exit with an is_error result and zero usage: the run is failed / infra_error by its exit class, not stopped / budget', async (t) => {
    const { fx, run } = await providerUnreachable(t);

    // Live: the backend ran, its CONNECT was refused, and its usage was observed.
    const log = egressLogOf(fx.home, run.id).entries;
    assert.ok(log.some((l) => l.authority === `${EGRESS[0]}:443` && l.decision === 'refused'), `the fixture is live: the run's egress was refused (${JSON.stringify(log)})`);
    const receipt = withStore(fx.home, (db) => db.prepare('SELECT * FROM "invocation_receipts" WHERE "run" = ?').get(run.id));
    const obs = withStore(fx.home, (db) => db.prepare(`SELECT * FROM "invocation_status_observations" WHERE "invocation" = ? AND "status" = 'ended'`).get(receipt.id));
    assert.equal(obs?.exit_class, 'error_exit', `the fixture is live: the backend exited 1 on its own, exit class error_exit (D2 §1.6) (${JSON.stringify(obs)})`);
    const usage = withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" = 'invocation.usage' AND "subject" LIKE ?`).get(`%${receipt.id}%`)).n;
    assert.ok(usage > 0, `the fixture is live: the engine observed the backend's usage events (${usage})`);

    // The record names the cause: the exit class's outcome (SEAM.md §143),
    // never a budget stop the engine did not make before the exit.
    assert.deepEqual([run.outcome, run.reason_class], ['failed', 'infra_error'], `a run that ended error_exit on its own, with no accepted result, is failed / infra_error (D2 §1.6; SEAM.md §143), not a budget stop: ${JSON.stringify({ outcome: run.outcome, reason_class: run.reason_class, reason_text: run.reason_text })}`);
    // And its reason names what ended it (SEAM.md §174; the wording is the
    // engine's): the exit class, the refused egress or the backend's error.
    const cause = [/error_exit/, new RegExp(EGRESS[0].replace(/\./g, '\\.')), /resolve_failed/, /ERR_PROXY_TUNNEL|api_error|API Error/];
    assert.ok(typeof run.reason_text === 'string' && cause.some((re) => re.test(run.reason_text)), `the run's reason names its cause, not a budget: ${JSON.stringify(run.reason_text)}`);
  });
});

describe('M136 E85: a known zero by the egress evidence (sandbox lane, the fake backend, no model)', () => {
  test('E85 (a): every CONNECT refused, nothing accepted, no byte up, the backend\'s report all zeros: the ledger row is a known zero (billable and cost 0, usage complete), names its egress basis, and charges no unknown allowance', async (t) => {
    const { row, log, ledger } = await providerUnreachable(t);
    assert.ok(log.entries.length > 0 && log.entries.every((l) => l.decision === 'refused' && l.bytes_up === 0) && log.marker === null, `the fixture is live: every CONNECT refused, nothing up, the log not cut (${JSON.stringify(log.entries)})`);
    const seen = { billable_in: row.billable_in, out: row.out, cost_usd: row.cost_usd, cost_status: row.cost_status, usage_complete: row.usage_complete, unknown_allowance_tokens: row.unknown_allowance_tokens };
    assert.deepEqual([row.billable_in, row.out, row.cost_usd, row.usage_complete], [0, 0, 0, true], `a known zero: zero billable, zero output, zero cost, usage complete (E85): ${JSON.stringify(seen)}`);
    assert.notEqual(row.cost_status, 'unknown', `the cost is known (E85): ${JSON.stringify(seen)}`);
    assert.equal(row.unknown_allowance_tokens ?? 0, 0, `no unknown allowance is charged (E85): ${JSON.stringify(seen)}`);
    assert.equal(ledger.totals?.unknown_allowance_tokens ?? 0, 0, `nor in the project's totals: ${JSON.stringify(ledger.totals)}`);
    assert.ok(Object.values(row).some((v) => typeof v === 'string' && /egress/i.test(v)), `the row records its basis, the egress evidence (E85; the field is the engine's): ${JSON.stringify(row)}`);
  });

  test('E85 (b): one tunnel accepted (the connect held, nothing sent), the backend\'s report all zeros: not a zero by egress; the usage stays unknown, the unknown allowance charged', async (t) => {
    const { row, log } = await providerUnreachable(t, { accepted: true });
    assert.ok(log.entries.some((l) => l.decision === 'accepted'), `the fixture is live: a tunnel was accepted (${JSON.stringify(log.entries)})`);
    const seen = { billable_in: row.billable_in, cost_usd: row.cost_usd, cost_status: row.cost_status, usage_complete: row.usage_complete, unknown_allowance_tokens: row.unknown_allowance_tokens };
    assert.equal(row.usage_complete, false, `an accepted tunnel breaks E85's condition (c): the usage is not complete (${JSON.stringify(seen)})`);
    assert.ok(row.unknown_allowance_tokens > 0, `and the unknown allowance is charged (${JSON.stringify(seen)})`);
    assert.ok(!Object.values(row).some((v) => typeof v === 'string' && /egress/i.test(v)), `no egress basis is recorded (${JSON.stringify(row)})`);
  });

  test('E85 (c) (the Reviewer\'s in-flight CONNECT; D2 §2.4): the backend writes its CONNECT, bytes pipelined after it, and ends at once; the domain terminates while the proxy\'s connect is still held: the attempt is in the egress record, and the run is not a known zero by egress (usage unknown, the allowance charged)', async (t) => {
    const WINDOW_S = 20;
    const { fx, run, log, row } = await providerUnreachable(t, { accepted: true, role: 'connect_and_exit', connectTimeout: WINDOW_S });
    const sent = JSON.parse(readFileSync(join(fx.scripted.dir, 'fake-claude-connect.json'), 'utf8'));
    assert.ok(sent.sent_at, `the fixture is live: the fake wrote its CONNECT to the proxy (${JSON.stringify(sent)})`);
    const terminated = withStore(fx.home, (db) => db.prepare(`SELECT e."at" FROM "events" e WHERE e."type" = 'domain.terminated' AND e."subject" LIKE ? ORDER BY e."seq" LIMIT 1`).get(`%${run.id}%`));
    assert.ok(terminated?.at, 'the fixture is live: the domain was terminated');
    const windowMs = Date.parse(terminated.at) - Date.parse(sent.sent_at);
    assert.ok(windowMs >= 0 && windowMs < WINDOW_S * 1000, `the fixture is live: the domain was terminated ${windowMs} ms after the CONNECT, inside the proxy's ${WINDOW_S} s connect window (the connect held by egress_connect_hang)`);

    // D2 §2.4: every connection is in the record, the one still in flight
    // at the domain's close included.
    assert.ok(log.entries.some((l) => l.authority === sent.authority), `the in-flight CONNECT is in the egress record (D2 §2.4; SEAM.md §140): ${JSON.stringify(log.entries)}`);
    // E85 (c): a connection was attempted, so this is no zero by egress.
    const seen = { billable_in: row.billable_in, cost_usd: row.cost_usd, cost_status: row.cost_status, usage_complete: row.usage_complete, unknown_allowance_tokens: row.unknown_allowance_tokens };
    assert.ok(!Object.values(row).some((v) => typeof v === 'string' && /egress/i.test(v)), `not a known zero by the egress evidence: a connection was attempted (E85 (c)): ${JSON.stringify(row)}`);
    assert.equal(row.usage_complete, false, `the usage stays unknown (${JSON.stringify(seen)})`);
    assert.ok(row.unknown_allowance_tokens > 0, `and the unknown allowance is charged (${JSON.stringify(seen)})`);
  });
});

describe('M136 E86 (c): a model fallback is not the entry\'s model (sandbox lane, the fake backend, no model)', () => {
  test('E86 (c): a canary whose session falls back to another model (system/model_refusal_fallback, a second model in its usage) fails model_fallback; a role run with one is failed / invalid_result, its result not accepted as the entry\'s work, its reason naming the fallback', async (t) => {
    const { fx, fake, project } = await fakeFixture(t);
    fake.set({ fallback: true });
    const attempt = await qualify(fx, body(fake, project));
    await approveAttempt(fx, project, attempt.id);
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 600_000 });
    const p = canaryOf(done, 'positive');
    assert.ok(p?.run, `the fixture is live: the positive canary ran (${JSON.stringify(done.canaries)})`);
    assert.deepEqual([p.passed, p.failure_class], [false, 'model_fallback'], `a canary with a model fallback fails model_fallback (E86 item 3): ${JSON.stringify(p)}`);
    assert.equal(done.status, 'failed', 'and the attempt fails');

    // A Builder's run on an active entry, the same fallback, a valid result.
    fake.set({ role: 'complete', fallback: true });
    await useBackend(fx.engine, project, BACKENDS.claude, { roles: ['builder'], extra: PARK_ON_REFUSAL });
    await installTrustEntry(fx.engine, { binary: { path: fake.path, sha256: fake.sha256 } }, { status: 'active', model: MODEL, egress_hosts: [...EGRESS] });
    const plan = await installGatedPlan(fx.engine, project, { stages: [{ number: 1, goal: 'a stage whose session falls back' }] });
    await requestTick(fx.engine, project);
    const run = await waitForRun(fx.home, plan.stages[0].work_item, { state: 'ended', timeoutMs: 300_000 });
    const resultRecords = withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "records" WHERE "run" = ? AND "kind" = 'result'`).get(run.id).n);
    assert.deepEqual([run.outcome, run.reason_class], ['failed', 'invalid_result'], `a run whose model fell back is not the entry's work: failed / invalid_result (E86 item 3): ${JSON.stringify({ outcome: run.outcome, reason_class: run.reason_class, reason_text: run.reason_text })}`);
    assert.equal(resultRecords, 0, 'its result is not accepted: no result record');
    assert.match(String(run.reason_text), /^model_fallback: claude-sonnet-5-5 -> claude-sonnet-5\b/, `its reason names the fallback (${run.reason_text})`);
  });
});

describe('M136 E86 review: the engine\'s containment probe cannot be spoiled by the live backend (sandbox lane, the fake backend, no model)', () => {
  // The containment canary with the engine running the probe (E86); the fake
  // only waits, except that under a review mode it also tries, from inside
  // the sandbox, to spoil the engine's check. The canary's verdict is the
  // engine's own, so it must be unmoved.
  const CONTAINMENT = (extra) => Array.from({ length: 4 }, () => extra);

  test('S1 (the review): a backend that plants a malformed ~/.gitconfig (and a workspace .gitconfig) does not make git_config read as denied: the action passes only on the filesystem\'s refusal of the write, so the canary still passes with git_config witnessed and denied', async (t) => {
    const { fx, fake, project } = await fakeFixture(t);
    fake.set({ plant_gitconfig: true });
    const attempt = await qualify(fx, body(fake, project));
    await approveAttempt(fx, project, attempt.id);
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 600_000 });
    const { k, ev } = containmentCapabilities(fx, done);
    const g = (ev.actions ?? []).find((a) => a.name === 'git_config');
    assert.ok(g, `the fixture is live: git_config is among the engine's actions (${JSON.stringify(ev.actions)})`);
    assert.equal(g.witnessed, true, 'git_config witnessed by the init');
    // The denial must rest on the filesystem refusing the write, not on git
    // failing to read a config the backend planted (contract: "a denial
    // counts only when it is the filesystem's refusal of the write; anything
    // else is not_run, which fails the canary"). On c4a7f7f the probe child's
    // HOME is /surety/home, which the backend wrote, so git exits 128 reading
    // the planted ~/.gitconfig and the detail names it; that is the defect.
    const detail = String(g.detail ?? '');
    assert.ok(!/bad config line|\.gitconfig|could not (parse|read)/i.test(detail), `git_config's denial is the filesystem's refusal of the write, not a failure to read the backend's planted config (E86 review S1): ${JSON.stringify(detail)}`);
    assert.deepEqual([done.status, k.passed], ['succeeded', true], `the backend's planted config does not change the canary's verdict (${JSON.stringify(done.canaries)})`);
  });

  test('S2 (the review): a backend that sends SIGUSR1 to its siblings (the probe\'s action children among them), in its own pid namespace only, cannot leave the canary passing with an action unverified: the probe\'s children are hardened, so every action is still witnessed and denied and the canary passes; a child whose report the signal altered fails it', async (t) => {
    const { fx, fake, project } = await fakeFixture(t);
    fake.set({ signal_probe: true });
    const attempt = await qualify(fx, body(fake, project));
    await approveAttempt(fx, project, attempt.id);
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 600_000 });
    const { k, ev } = containmentCapabilities(fx, done);
    assert.ok((ev.actions ?? []).length > 0, `the fixture is live: the engine ran its actions (${JSON.stringify(ev.actions)})`);
    // The probe's action children must run hardened against the signal: a
    // backend that signals them cannot disturb the check. On the fixed engine
    // SIGUSR1 is a no-op (the init runs each child with --disable-sigusr1) and
    // the canary passes cleanly; on c4a7f7f the children are unhardened and
    // the signal opens their inspector and disrupts the check (here it ended
    // containment_failed). So "the canary still passes, every action
    // witnessed and denied, through the signalling" separates fixed from not.
    assert.ok(ev.actions.every((a) => a.witnessed === true && a.outcome === a.expected), `every action witnessed with its expected outcome despite the signal (${JSON.stringify(ev.actions)})`);
    assert.deepEqual([done.status, k.passed], ['succeeded', true], `a backend signalling the probe's children does not disturb the check: the children run hardened against SIGUSR1 (E86 review S2) (${JSON.stringify(done.canaries)})`);
  });
});
