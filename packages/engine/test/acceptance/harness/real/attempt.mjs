// The real lane's qualification attempts (M2 slice 14; rows M136 to M139;
// D2 §7.2, K10, Q7; SEAM.md §§160 to 165). Each is one named step of the run
// directory (lane.mjs `realStep`): it runs at most once, waits for Sean's
// `qualification_approval` before any canary, and records what it saw.
//
//   attempt            the attempt with the dedicated key: the three canaries
//                      (M136, M137, M138 judge it); home `home/`
//   wrong_key_attempt  an attempt whose key is wrong on purpose (M139),
//                      home `home-auth/`; costs no tokens
//   activation         Sean's `trust_activation` of the entry the first one
//                      wrote (M140 needs it); home `home/`
//
// The engine is a production engine (no --harness) for all three: the entry
// the journey uses is written and activated exactly as D2 §7.2 says.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { changePolicy } from '../journal.mjs';
import { attemptOf } from '../sandbox/qualify.mjs';
import { withStore } from '../store.mjs';
import { trustEntries } from '../trust.mjs';
import {
  REAL,
  RUN_BILLABLE_MAX_USD,
  eventsAboutRun,
  initEvent,
  ledgerOriginal,
  observe,
  productionEngine,
  realStep,
  recordJson,
  recordText,
  recordsOfRun,
  sampleDomains,
  streamEvents,
  tellSean,
  terminalEvent,
  sha256,
  tickWhile,
  waitForSean,
  wrongKeyFile,
} from './lane.mjs';

const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));
const sha = (path) => (existsSync(path) ? sha256(readFileSync(path)) : null);

// The host-side witnesses of the containment canary the test reads itself
// (D2 §7.2; M138 (a)): the token's bytes and the fixture repository's
// configuration, before the attempt and after it.
function hostWitness(home, fixtureProject) {
  const repo = withStore(home, (db) => db.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(fixtureProject))?.dev_repo_path ?? null;
  const config = repo === null ? null : existsSync(join(repo, '.git', 'config')) ? join(repo, '.git', 'config') : join(repo, 'config');
  return { at: new Date().toISOString(), token_sha256: sha(join(home, 'api.token')), repo, repo_config: config, repo_config_sha256: config && sha(config) };
}

// The project policy every real-lane project runs under (E59; SEAM.md §161):
// all lowering changes, so none raises a decision.
export const realPolicy = (dayVerifiedUsd) => ({
  budget_run_billable_tokens: REAL.runBillableTokens,
  budget_day_verified_usd: dayVerifiedUsd,
  budget_day_unknown_tokens: REAL.dayUnknownTokens,
  ...REAL.roleDeadlines,
});

// The host facts the report records (M141): from the engine read, the active
// host qualification row and the host's own tools.
export function hostFacts(home, info) {
  const tool = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000 }).split('\n')[0].trim();
    } catch {
      return null;
    }
  };
  const osRelease = (() => {
    try {
      return /PRETTY_NAME="?([^"\n]*)"?/.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? null;
    } catch {
      return null;
    }
  })();
  const row = withStore(home, (db) => db.prepare(`SELECT * FROM "host_qualifications" WHERE "status" = 'active'`).get());
  return {
    host_id: readFileSync('/etc/machine-id', 'utf8').trim(),
    kernel: tool('uname', ['-r']),
    distribution: osRelease,
    wsl: /microsoft/i.test(tool('uname', ['-r']) ?? ''),
    node: process.version,
    git: tool('git', ['--version']),
    systemd: tool('systemctl', ['--version']),
    unshare: tool('unshare', ['--version']),
    setpriv: tool('setpriv', ['--version']),
    ip: tool('ip', ['-V']),
    engine_read: { host_qualification: info.host_qualification, bootstrap_exception: info.bootstrap_exception, backends: info.backends },
    host_qualification_row: row ? { ...row, checks: json(row.checks), probes: json(row.probes), tool_versions: json(row.tool_versions) } : null,
  };
}

// Everything about one attempt the cases and the report read, from the
// store and the records (the engine may be stopped).
export function collectAttempt(home, attemptId) {
  const attempt = attemptOf(home, attemptId);
  const runs = (attempt?.canaries ?? []).map((c) => {
    const run = withStore(home, (db) => db.prepare('SELECT * FROM "runs" WHERE "id" = ?').get(c.run));
    const receipt = withStore(home, (db) => db.prepare('SELECT * FROM "invocation_receipts" WHERE "run" = ?').get(c.run));
    const observation = receipt
      ? withStore(home, (db) => db.prepare(`SELECT * FROM "invocation_status_observations" WHERE "invocation" = ? AND "status" IN ('ended', 'unknown') ORDER BY "seq" DESC LIMIT 1`).get(receipt.id))
      : null;
    const domain = withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "run" = ?').get(c.run));
    const events = streamEvents(home, c.run);
    const egress = recordsOfRun(home, c.run, 'egress_log').flatMap((r) => (recordText(home, r) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const resultRecord = recordsOfRun(home, c.run, 'result')[0];
    return {
      kind: c.kind,
      canary: c,
      run: run && { id: run.id, state: run.state, outcome: run.outcome, reason_class: run.reason_class, reason_text: run.reason_text, provider_session_id: run.provider_session_id ?? null },
      receipt: receipt && { id: receipt.id, trust_entry: receipt.trust_entry, qualification_attempt: receipt.qualification_attempt, provider_session_id: receipt.provider_session_id ?? null },
      exit_class: observation?.exit_class ?? null,
      exit_evidence: json(observation?.exit_evidence) ?? null,
      domain: domain && { id: domain.id, cgroup_path: domain.cgroup_path, observation: domain.observation, launch_state: domain.launch_state, resource_events: json(domain.resource_events) },
      ledger: ledgerOriginal(home, c.run),
      records: recordsOfRun(home, c.run).map((r) => ({ id: r.id, kind: r.kind, published: r.published, bytes: r.bytes })),
      evidence: c.evidence ? recordJson(home, c.evidence) : null,
      provider_error: c.provider_error ? recordText(home, withStore(home, (db) => db.prepare('SELECT * FROM "records" WHERE "id" = ?').get(c.provider_error))) : null,
      result: resultRecord ? json(recordText(home, resultRecord)) : null,
      stream: { events: events.length, types: [...new Set(events.map((e) => `${e?.type}${e?.subtype ? `/${e.subtype}` : ''}`))], init: initEvent(events), terminal: terminalEvent(events) },
      egress_log: egress,
      events: eventsAboutRun(home, c.run).map((e) => ({ seq: e.seq, type: e.type, payload: e.payload })),
    };
  });
  const entry = attempt?.trust_entry ? trustEntries(home).find((e) => e.id === attempt.trust_entry) : null;
  const entryRow = entry ? withStore(home, (db) => db.prepare('SELECT * FROM "trust_entries" WHERE "id" = ?').get(entry.id)) : null;
  const events = withStore(home, (db) => db.prepare(`SELECT * FROM "events" WHERE "type" LIKE 'qualification.%' OR "type" LIKE 'trust.%' ORDER BY "seq"`).all()).map((e) => ({ seq: e.seq, type: e.type, subject: json(e.subject), payload: json(e.payload) }));
  return {
    attempt,
    runs,
    entry: entryRow ? { ...entryRow, ...entry, provider_files: json(entryRow.provider_files) } : null,
    entry_evidence: entry ? (entry.evidence ?? []).map((id) => ({ id, content: recordJson(home, id) })) : [],
    events,
  };
}

// Before Sean is asked: what the attempt binds, checked so that he is never
// asked to approve an attempt this lane would not accept (SEAM.md §161).
// Returns the facts printed for him.
function spendGuard(ctx, attempt, fixtureDayUsd) {
  assert.equal(attempt.status, 'proposed', 'the attempt waits for its approval');
  assert.equal(attempt.model, REAL.model, `the attempt binds the model Sean chose (E59): ${attempt.model}`);
  assert.equal(attempt.binary_sha256, ctx.binarySha256, 'the attempt binds the pinned binary, by hash');
  assert.deepEqual(attempt.candidate_egress, [...REAL.candidateEgress], 'the attempt proposes the provider and nothing else');
  assert.equal(attempt.spend?.label, 'estimate', `the spend is labelled an estimate (D2 §7.2, Q7): ${JSON.stringify(attempt.spend)}`);
  assert.equal(attempt.spend?.overshoot, 'deadline', 'with the overshoot stated');
  assert.ok(typeof attempt.spend?.estimate === 'number' && attempt.spend.estimate > 0, `the estimate is shown before approval, a figure greater than zero (SEAM.md §161): ${JSON.stringify(attempt.spend)}`);
  assert.ok(attempt.spend.estimate <= fixtureDayUsd, `the estimate (${attempt.spend.estimate} USD) is within the day limit the attempt runs under (${fixtureDayUsd} USD); otherwise Sean is not asked`);
  assert.equal(attempt.auth_mode, ctx.authMode, `the attempt binds the auth mode the lane runs in (E74 item 1): ${attempt.auth_mode}`);
  if (ctx.authMode === 'api_key') assert.deepEqual([attempt.spend?.provider_cap?.status, attempt.spend?.provider_cap?.usd], ['configured', REAL.providerCapUsd], `the provider-side cap is shown as configured, never as the engine's enforcement (D2 §4.2): ${JSON.stringify(attempt.spend)}`);
  else assert.ok(attempt.spend?.provider_cap === undefined || attempt.spend?.provider_cap === null, `a subscription has no dollar cap on its credential: none is shown (E74 item 1): ${JSON.stringify(attempt.spend)}`);
  return {
    'binary path': attempt.binary_path,
    'binary sha256': attempt.binary_sha256,
    version: attempt.version,
    model: attempt.model,
    'spend (the engine\'s estimate, labelled)': attempt.spend,
    'at most, billable tokens alone': `3 canaries x ${REAL.runBillableTokens} billable tokens x ${REAL.usdPerMillion.output} USD per million = ${(3 * RUN_BILLABLE_MAX_USD).toFixed(2)} USD, plus cache reads and any overshoot until a canary's deadline`,
    'day limit of the fixture project': `${fixtureDayUsd} USD verified`,
    'auth mode': ctx.authMode,
    'the only hard maximum':
      ctx.authMode === 'api_key'
        ? `the provider-side cap of ${REAL.providerCapUsd} USD on the key`
        : "your Claude subscription's own usage limits, which your own Claude use shares; the dollar figures are Claude Code's own estimates",
    'candidate egress': attempt.candidate_egress,
    'canary deadlines (s)': attempt.canary_deadlines,
    'host qualification': attempt.host_qualification,
  };
}

// One attempt, start to finish: propose, show, wait for Sean, run, record.
async function runAttempt(ctx, { homeName, keyFile, label, row }) {
  const fx = await productionEngine(ctx, homeName, { keyFile });
  try {
    const info = await fx.engine.engineInfo();
    observe(ctx, row, 'host', hostFacts(fx.home, info));
    assert.equal(info.bootstrap_exception, false, '`ui_bootstrap` is false during qualification (M141)');
    assert.equal(info.host_qualification?.eligible, true, `the host is qualified at this start: ${JSON.stringify(info.host_qualification?.failed_checks)}`);
    const fixtureProject = info.qualification_fixture_project;
    assert.match(String(fixtureProject), /^proj_[0-9A-HJKMNP-TV-Z]{26}$/, `GET /v1/engine names the engine's own qualification fixture project (SEAM.md §164): ${JSON.stringify(fixtureProject)}`);
    await changePolicy(fx.engine, fixtureProject, realPolicy(REAL.dayVerifiedUsd.qualification));

    const witnessBefore = hostWitness(fx.home, fixtureProject);
    const res = await fx.engine.post('/v1/trust/qualify', { backend: REAL.backend, mode: REAL.mode, model: REAL.model, candidate_egress: [...REAL.candidateEgress], canary_deadlines: { ...REAL.canaryDeadlines }, auth_mode: ctx.authMode });
    assert.equal(res.status, 201, `POST /v1/trust/qualify proposes the attempt (body: ${res.text})`);
    const id = res.body.qualification_attempt.id;
    const proposed = attemptOf(fx.home, id);
    observe(ctx, row, 'proposed', proposed);
    assert.equal(proposed.fixture_project, fixtureProject, "the canaries run on the engine's own fixture project");
    assert.deepEqual(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "invocation_receipts" WHERE "qualification_attempt" = ?').get(id).n), 0, 'nothing launched before the approval');

    const facts = spendGuard(ctx, proposed, REAL.dayVerifiedUsd.qualification);
    await waitForSean(ctx, fx, 'qualification_approval', id, { what: label, facts });

    const sampler = sampleDomains(fx.home, fixtureProject);
    const limitMs = (REAL.canaryDeadlines.positive + REAL.canaryDeadlines.cancellation + REAL.canaryDeadlines.containment) * 1000 + 20 * 60_000;
    let finished;
    try {
      finished = await tickWhile(fx, fixtureProject, () => (['succeeded', 'failed', 'invalidated'].includes(attemptOf(fx.home, id)?.status) ? attemptOf(fx.home, id) : undefined), { timeoutMs: limitMs, what: `attempt ${id} to finish` });
    } finally {
      observe(ctx, row, 'domain_samples', sampler.stop());
    }
    const collected = collectAttempt(fx.home, id);
    observe(ctx, row, 'attempt', collected);
    observe(ctx, row, 'host_witness', { before: witnessBefore, after: hostWitness(fx.home, fixtureProject) });
    tellSean(ctx, `SURETY REAL LANE: ${label}: the attempt ${id} ended ${finished.status}. Records kept under ${fx.home}.`);
    return { attempt: id, status: finished.status, entry: finished.trust_entry ?? null, fixture_project: fixtureProject, home: fx.home };
  } finally {
    await fx.engine.stop();
  }
}

// The attempt with the dedicated key (M136 to M138). A failed attempt is
// recorded and halts the run directory: no paid step follows it.
export async function qualificationAttempt(ctx) {
  return realStep(ctx, 'attempt', async () => {
    const out = await runAttempt(ctx, { homeName: 'home', keyFile: ctx.keyRef, label: 'the qualification attempt for Claude Code: three canaries (positive, cancellation, containment), paid', row: 'attempt' });
    if (out.status !== 'succeeded') throw new Error(`the qualification attempt ended ${out.status}; its records are in ${out.home}`);
    return out;
  });
}

// The attempt whose key is wrong (M139). Its expected end is `failed` with
// `auth_failed`: that is recorded, and only another outcome halts.
export async function wrongKeyAttempt(ctx) {
  return realStep(ctx, 'wrong_key_attempt', async () => {
    const wrong = wrongKeyFile(ctx);
    const out = await runAttempt(ctx, {
      homeName: 'home-auth',
      keyFile: wrong.file,
      label: `an attempt whose credential (${ctx.authMode}) is INVALID ON PURPOSE (M139): the provider refuses it; it uses no tokens. Approve it so the refusal is observed.`,
      row: 'wrong_key',
    });
    if (out.status !== 'failed') throw new Error(`the wrong-key attempt ended ${out.status}, not failed: an unexpected outcome`);
    return out;
  });
}

// Sean's activation of the entry the attempt wrote (M140's precondition).
// Answering launches nothing (D2 §4.1): checked here before anything else runs.
export async function activation(ctx) {
  return realStep(ctx, 'activation', async () => {
    const attemptStep = await qualificationAttempt(ctx);
    const fx = await productionEngine(ctx, 'home');
    try {
      const entryId = attemptStep.entry;
      assert.ok(entryId, 'the succeeded attempt wrote an entry');
      const before = { runs: withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "runs"').get().n), receipts: withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "invocation_receipts"').get().n) };
      const entry = trustEntries(fx.home).find((e) => e.id === entryId);
      if (entry.status === 'proposed') {
        await waitForSean(ctx, fx, 'trust_activation', entryId, {
          what: 'the activation of the Claude Code entry the attempt wrote. Activating launches nothing; it lets the journey (M140) dispatch real roles, each a paid run bounded by the journey project\'s limits.',
          facts: {
            entry: entryId,
            'binary sha256': entry.binary_sha256,
            version: entry.version,
            model: entry.model,
            capabilities: entry.capabilities,
            'egress hosts': entry.egress_hosts,
            'journey: at most, billable tokens alone': `${RUN_BILLABLE_MAX_USD.toFixed(2)} USD a run; the journey's projects have day limits of ${REAL.dayVerifiedUsd.pathOne} and ${REAL.dayVerifiedUsd.pathTwo} USD verified`,
          },
        });
      }
      const active = trustEntries(fx.home).find((e) => e.id === entryId);
      assert.equal(active.status, 'active', 'the entry is active after Sean\'s answer');
      const after = { runs: withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "runs"').get().n), receipts: withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "invocation_receipts"').get().n) };
      assert.deepEqual(after, before, 'answering trust_activation created no run and launched nothing (D2 §4.1; CH incident 10)');
      const info = await fx.engine.engineInfo();
      observe(ctx, 'activation', 'entry', { ...active, activated_by_decision: active.activated_by, backends: info.backends });
      return { entry: entryId, activated_by: active.activated_by };
    } finally {
      await fx.engine.stop();
    }
  });
}

export const canaryOfKind = (collected, kind) => collected.runs.find((r) => r.kind === kind);
export const homeOf = (ctx, name) => join(ctx.runDir, name);
