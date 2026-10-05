// M135, qualification admission; a claim without an attempt fails (M2
// slice 13 part 2, sandbox lane, no model). M2 plan §3.7 M135; D2 §7.2,
// §4.1, K10, A.3, A.7; Q7; E58 item 4; AR B04, B05; E57; SEAM.md §§117,
// 140, 148, 149.
//
// POST /v1/trust/qualify makes the static checks and writes the attempt
// proposed, binding its binary, help, template, model, auth mode, host
// qualification, fixture project, candidate egress, deadlines and a
// labelled spend estimate, and raises qualification_approval; nothing is
// launched. Only the human's approval authorizes it; its authority then
// dispatches exactly three canaries on the fixture project, charged to the
// ledger, and nothing else. A dependency changed before the answer or
// before the first dispatch invalidates it; a replay is a new attempt. The
// scripted canaries passing write the entry proposed and raise
// trust_activation, whose answer launches nothing; a failing positive
// canary fails the attempt with its class and kept error; an off-list
// contact is refused and reported, never added; the echo endpoint cannot be
// a candidate; a containment canary passes only on witnessed executions of
// the probe program, never on what the backend prints.
//
// No model, no provider, no key: the backend is `scripted`, its binary a
// stand-in that runs the scripted role program (SEAM.md §148).
//
// SAFETY (E64 item 2; SEAM.md §§141, 149): the containment canary's actions
// and any connection a canary makes are guarded and released only after
// the host has read that the canary's role is contained (armedCanary).
//
// E86 (Sean's decision after his third attempt, where a safeguard and then a
// model fallback refused the probe; SEAM.md §175): the engine runs the probe
// itself, in the domain init's child beside the live backend; the agent's
// task is only to wait and end with a result, and nothing it is shown names
// the check. (i) and S1 are amended: what a backend prints or forges is not
// the evidence, and a backend that ends before the check has run fails it.
//
// Every case but (h) and (j) is expected to fail on the engine these tests
// were written against (main at e1f6e73; COVERAGE.md, "M2 slice 13 (part 2)").

import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { armFault, releaseBarrier, sha256Hex, waitFor } from './harness/engine.mjs';
import { armBarrier } from './harness/journal.mjs';
import { ledgerRows } from './harness/ledger.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { addWork, getRow, requestTick, runsOf, tick } from './harness/runs.mjs';
import { checkOf, hostSection, observerEnvelopes, receiptOf, roleAlive, sandboxEngine, terminalObservation } from './harness/sandbox/lane.mjs';
import { DOC, setResolver } from './harness/sandbox/egress.mjs';
import { approveWidening } from './harness/sandbox/view.mjs';
import { CANDIDATE_EGRESS, approveAttempt, armedCanary, attemptFixture, attemptOf, canaryOf, canaryRuns, obeyingCanaries, postQualify, qualify, scriptedBody, waitAttempt } from './harness/sandbox/qualify.mjs';
import { acting, hostNamespaces, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { BACKENDS, PARK_ON_REFUSAL, StandIn, answerEngine, consumeEngine, eventsNamed, openEngineDecision, trustEntries, useBackend } from './harness/trust.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { assertRefused } from './harness/fixtures.mjs';

const DEFAULT_HELP = 'usage: surety-standin [options] [prompt]\n  a stand-in backend for the Surety acceptance tests\n';
const recordJson = (home, id) => JSON.parse(readFileSync(recordFile(home, recordRow(home, id)), 'utf8'));
const domainsOfProject = (home, project) => withStore(home, (db) => db.prepare('SELECT d."id" FROM "execution_domains" d JOIN "runs" r ON r."id" = d."run" WHERE r."project" = ?').all(project));

// Approve, release the containment canary into its actions, and wait for the end.
async function runToEnd(fx, fixtureProject, attempt, { release = ['containment'] } = {}) {
  await approveAttempt(fx, fixtureProject, attempt.id);
  for (const kind of release) await armedCanary(fx, kind);
  return waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated']);
}

describe('M135 qualification admission; a claim without an attempt fails', () => {
  test('(a) the attempt row: proposed, binding hashes, template and version, model, auth mode, host qualification, fixture project, candidate egress, deadlines and the spend labelled an estimate before any launch; qualification.proposed; qualification_approval raised; nothing launched but the static checks', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject));
    const row = attemptOf(fx.home, attempt.id);
    const active = withStore(fx.home, (db) => db.prepare(`SELECT "id" FROM "host_qualifications" WHERE "status" = 'active'`).get());
    assert.equal(row.status, 'proposed');
    assert.deepEqual(
      { backend: row.backend, binary_path: row.binary_path, binary_sha256: row.binary_sha256, version: row.version, help_sha256: row.help_sha256, model: row.model, auth_mode: row.auth_mode, host_qualification: row.host_qualification, fixture_project: row.fixture_project, candidate_egress: row.candidate_egress },
      { backend: 'scripted', binary_path: realpathSync(standIn.path), binary_sha256: standIn.sha256, version: 'surety-standin 0.0.1', help_sha256: sha256Hex(DEFAULT_HELP), model: 'scripted-model', auth_mode: 'api_key', host_qualification: active?.id, fixture_project: fixtureProject, candidate_egress: [...CANDIDATE_EGRESS] },
      'the row binds what the static checks observed and what the attempt names',
    );
    assert.ok(typeof row.template === 'string' && row.template.length > 0 && typeof row.template_version === 'string' && row.template_version.length > 0, 'the template and its version');
    assert.ok(row.profile_fingerprint && /^[0-9a-f]{64}$/.test(row.profile_fingerprint), 'the profile fingerprint');
    for (const k of ['positive', 'cancellation', 'containment']) assert.ok(Number.isInteger(row.canary_deadlines?.[k]) && row.canary_deadlines[k] > 0, `a deadline for the ${k} canary (${JSON.stringify(row.canary_deadlines)})`);
    assert.deepEqual([row.spend?.label, row.spend?.cap ?? null, row.spend?.overshoot], ['estimate', null, 'deadline'], `the spend is an estimate, labelled, with the overshoot stated (${JSON.stringify(row.spend)})`);
    assert.ok(row.spend.estimate === null || (typeof row.spend.estimate === 'number' && row.spend.estimate > 0), 'its figure a number, or null where no price is known, never 0');
    assert.equal(eventsNamed(fx.home, 'qualification.proposed').filter((e) => e.subject?.qualification_attempt === attempt.id).length, 1, 'qualification.proposed');
    const approval = await openEngineDecision(fx, fixtureProject, 'qualification_approval', attempt.id);
    assert.equal(approval.id, row.decision, 'the row names its approval');
    for (const key of ['attempt_status', 'binary_sha256', 'help_sha256', 'template', 'template_version', 'model', 'auth_mode', 'host_qualification', 'host_eligibility', 'fixture_project', 'candidate_egress', 'canary_deadlines', 'spend']) assert.ok(key in approval.manifest, `the manifest has ${key} (SEAM §117; keys ${Object.keys(approval.manifest).join(', ')})`);
    assert.deepEqual(standIn.launches(), [], 'no launch of the binary');
    assert.deepEqual(standIn.statics().map((s) => s.args.join(' ')).sort(), ['--help', '--version'], 'only the static checks ran it, once each');
    assert.deepEqual(domainsOfProject(fx.home, fixtureProject), [], 'no domain');
    assert.deepEqual(canaryRuns(fx.home, attempt.id), [], 'no canary run');

    // The same for `claude` bound to a stand-in: the real template renders.
    const claudeStandIn = new StandIn(join(fx.root, 'standin-claude'), { logDir: fx.scripted.dir });
    const claude = await qualify(fx, { ...scriptedBody(claudeStandIn, fixtureProject), backend: BACKENDS.claude, model: 'claude-sonnet-5-5' });
    const crow = attemptOf(fx.home, claude.id);
    assert.ok(crow.template.startsWith('claude --bare -p --output-format stream-json'), `the claude attempt binds D2 §4.5's template (${crow.template})`);
    assert.ok(crow.template.includes('--session-id') && crow.template.includes('--no-session-persistence'));
  });

  test("(b) approve: authorized, then exactly three canary runs on the fixture project, receipts naming the attempt and no entry, each charged; other items of that and another project untouched by the attempt's authority", async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    obeyingCanaries(fx);
    const other = (await addGitProject(fx)).id;
    const bystanders = [];
    for (const p of [fixtureProject, other]) {
      await useBackend(fx.engine, p, BACKENDS.claude, { roles: ['verifier'], extra: PARK_ON_REFUSAL });
      bystanders.push(await addWork(fx.engine, p, 'verification'));
    }
    const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject));
    await approveAttempt(fx, fixtureProject, attempt.id);
    assert.ok(['authorized', 'running', 'succeeded'].includes(attemptOf(fx.home, attempt.id).status), 'authorized by the answer');
    assert.equal(eventsNamed(fx.home, 'qualification.authorized').filter((e) => e.subject?.qualification_attempt === attempt.id).length, 1, 'qualification.authorized');
    await armedCanary(fx, 'containment');
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated']);
    assert.equal(done.status, 'succeeded', `the scripted canaries pass (${JSON.stringify(done.canaries)})`);
    const runs = canaryRuns(fx.home, attempt.id);
    assert.equal(runs.length, 3, `exactly three canary runs (${JSON.stringify(runs)})`);
    for (const r of runs) {
      assert.deepEqual([r.project, r.qualification_attempt, r.trust_entry], [fixtureProject, attempt.id, null], 'on the fixture project, naming the attempt and no entry');
      assert.equal(ledgerRows(fx.home, fixtureProject).filter((l) => l.run === r.run && l.corrects === null).length, 1, `canary run ${r.run} is charged to the ledger`);
    }
    assert.deepEqual(done.canaries.map((c) => c.kind), ['positive', 'cancellation', 'containment'], 'in order');
    for (const item of bystanders) {
      for (const run of runsOf(fx.home, item)) {
        assert.equal(receiptOf(fx.home, run.id)?.qualification_attempt ?? null, null, `item ${item}'s run is not under the attempt's authority`);
        assert.deepEqual([run.outcome, run.reason_class], ['refused', 'preflight_refused'], `item ${item} is refused as without the attempt (K10)`);
      }
    }
  });

  test('(c) a changed dependency between preview and answer: decision_stale, the attempt invalidated with the reason, no canary; the same at qualification.before_dispatch', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    obeyingCanaries(fx);
    const first = await qualify(fx, scriptedBody(standIn, fixtureProject));
    const previewed = await openEngineDecision(fx, fixtureProject, 'qualification_approval', first.id);
    standIn.changeBytes('M135 (c), before the answer');
    const res = await answerEngine(fx.engine, previewed, 'approve');
    assertRefused(res, 409, ['decision_stale', 'decision_invalidated'], 'approving on a preview taken before the binary changed');
    await tick(fx.engine, fixtureProject);
    const invalidated = await waitAttempt(fx.home, first.id, 'invalidated', { timeoutMs: 30_000 });
    assert.equal(invalidated.invalidated_reason, 'binary_changed', `the reason (${invalidated.invalidated_reason})`);
    assert.deepEqual(canaryRuns(fx.home, first.id), [], 'no canary launched');

    const second = await qualify(fx, scriptedBody(standIn, fixtureProject));
    await armBarrier(fx.engine, 'qualification.before_dispatch', 'pause');
    await approveAttempt(fx, fixtureProject, second.id);
    await requestTick(fx.engine, fixtureProject);
    await fx.engine.waitUntil('barrier:qualification.before_dispatch', { timeoutMs: 60_000 });
    standIn.changeBytes('M135 (c), at qualification.before_dispatch');
    await releaseBarrier(fx.engine, 'qualification.before_dispatch');
    await tick(fx.engine, fixtureProject);
    const after = await waitAttempt(fx.home, second.id, 'invalidated', { timeoutMs: 60_000 });
    assert.equal(after.invalidated_reason, 'binary_changed');
    assert.deepEqual(canaryRuns(fx.home, second.id), [], 'no canary launched');
    assert.deepEqual(standIn.launches(), [], 'the binary never ran as a backend');
  });

  test('(d) a replay after failed: a new attempt and a new approval; the old one untouched', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    obeyingCanaries(fx, { positive: [{ steps: [step.canary('wrong_result')] }, { steps: [step.canary('wrong_result')] }] });
    const first = await qualify(fx, scriptedBody(standIn, fixtureProject));
    const failed = await runToEnd(fx, fixtureProject, first, { release: [] });
    assert.equal(failed.status, 'failed', 'the fixture is live: the first attempt failed');
    const snapshot = JSON.stringify(attemptOf(fx.home, first.id));
    const replay = await qualify(fx, scriptedBody(standIn, fixtureProject));
    assert.notEqual(replay.id, first.id, 'a new attempt');
    const approval = await openEngineDecision(fx, fixtureProject, 'qualification_approval', replay.id);
    assert.notEqual(approval.id, failed.decision, 'with a new approval');
    assert.equal(attemptOf(fx.home, replay.id).status, 'proposed', 'not authorized by the old approval');
    assert.equal(JSON.stringify(attemptOf(fx.home, first.id)), snapshot, 'the old attempt is untouched');
  });

  test('(e) scripted canaries pass: the entry proposed, trust.proposed, trust_activation raised; answering it launches nothing', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    obeyingCanaries(fx);
    const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject));
    const done = await runToEnd(fx, fixtureProject, attempt);
    assert.equal(done.status, 'succeeded', `the attempt succeeds (${JSON.stringify(done.canaries)})`);
    for (const c of done.canaries) assert.equal(c.passed, true, `the ${c.kind} canary passed (${JSON.stringify(c)})`);
    const cancel = canaryOf(done, 'cancellation');
    assert.ok(Number.isInteger(cancel.term_to_exit_ms) && cancel.term_to_exit_ms >= 0, `term_to_exit_ms recorded (${cancel.term_to_exit_ms})`);
    assert.equal(terminalObservation(fx.home, receiptOf(fx.home, cancel.run).id).exit_class, 'engine_signaled', 'the cancellation canary was ended by the engine');
    const finished = eventsNamed(fx.home, 'qualification.finished').filter((e) => e.subject?.qualification_attempt === attempt.id);
    assert.deepEqual(finished.map((e) => [e.payload?.outcome, e.payload?.code ?? null]), [['succeeded', null]], 'qualification.finished');
    const entry = trustEntries(fx.home).find((e) => e.qualification_attempt === attempt.id);
    assert.ok(entry, 'an entry is written from the attempt');
    assert.deepEqual([entry.status, entry.backend, entry.binary_sha256], ['proposed', 'scripted', standIn.sha256], 'proposed, for the qualified binary');
    assert.equal(done.trust_entry, entry.id, 'the attempt names it');
    assert.equal(eventsNamed(fx.home, 'trust.proposed').filter((e) => e.subject?.trust_entry === entry.id).length, 1, 'trust.proposed');
    const activation = await openEngineDecision(fx, fixtureProject, 'trust_activation', entry.id);
    const launchesBefore = standIn.launches().length;
    const runsBefore = withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "runs"').get().n);
    await consumeEngine(fx, activation, 'approve');
    await tick(fx.engine, fixtureProject);
    assert.equal(trustEntries(fx.home).find((e) => e.id === entry.id).status, 'active', 'activated by the human');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "runs"').get().n), runsBefore, 'answering created no run');
    assert.equal(standIn.launches().length, launchesBefore, 'and launched nothing');
  });

  test('(f) a failing positive canary: failed, qualification_failed, failure_class invalid_result, the redacted provider error record kept; no entry; no later canary', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    obeyingCanaries(fx, { positive: [{ steps: [step.canary('wrong_result')] }] });
    const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject));
    const done = await runToEnd(fx, fixtureProject, attempt, { release: [] });
    assert.equal(done.status, 'failed');
    const positive = canaryOf(done, 'positive');
    assert.deepEqual([positive?.passed, positive?.failure_class], [false, 'invalid_result'], `the positive canary failed invalid_result (${JSON.stringify(positive)})`);
    assert.equal(recordRow(fx.home, positive.provider_error)?.published, 1, 'its provider error is kept as a published record');
    const finished = eventsNamed(fx.home, 'qualification.finished').filter((e) => e.subject?.qualification_attempt === attempt.id);
    assert.deepEqual(finished.map((e) => [e.payload?.outcome, e.payload?.code]), [['failed', 'qualification_failed']], 'qualification.finished with qualification_failed');
    assert.equal(trustEntries(fx.home).filter((e) => e.qualification_attempt === attempt.id).length, 0, 'no entry');
    assert.equal(canaryRuns(fx.home, attempt.id).length, 1, 'no later canary was dispatched');
  });

  test('(g) a canary contacting a destination off the list: refused by the proxy, listed in unexpected_contacts, not added', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    const off = 'unlisted.m135.example:443';
    obeyingCanaries(fx, { positive: [{ steps: [step.hold('armed'), acting(hostNamespaces()).proxyConnect(off), step.canary('obey')] }] });
    const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject));
    const done = await runToEnd(fx, fixtureProject, attempt, { release: ['positive', 'containment'] });
    const probe = fx.scripted.log().find((e) => e.event === 'probe' && e.action === 'proxy_connect' && e.authority === off);
    assert.equal(probe?.status, 403, `the proxy refused it (${JSON.stringify(probe)})`);
    assert.ok((done.unexpected_contacts ?? []).some((u) => u.destination === off && u.refused_at), `listed in unexpected_contacts (${JSON.stringify(done.unexpected_contacts)})`);
    assert.ok(!done.candidate_egress.includes(off), 'not added to the candidate list');
    const entry = trustEntries(fx.home).find((e) => e.qualification_attempt === attempt.id);
    if (entry) assert.ok(!(entry.egress_hosts ?? []).some((h) => off.startsWith(h)), 'nor to the entry\'s egress hosts');
  });

  test('(h) a candidate list naming the echo endpoint: refused at the route', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    const res = await postQualify(fx, scriptedBody(standIn, fixtureProject, { candidate_egress: ['echo.surety.invalid'] }));
    assertRefused(res, 400, ['invalid_value'], 'a candidate list naming the echo endpoint');
    assert.equal(res.body?.subject?.field, 'candidate_egress');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "qualification_attempts"').get().n), 0, 'no attempt is written');
  });

  test('(i) a scripted backend that prints "denied", and one that writes the probe program\'s reports itself, each ending at once: containment_failed (nothing it prints is evidence; under E86 the check needs the backend live throughout); one that obeys its canary: passed', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    const hostNs = hostNamespaces();
    obeyingCanaries(fx, {
      containment: [{ steps: [step.canary('say_denied')] }, { steps: [step.canary('forge_reports')] }, { steps: [step.hold('armed'), acting(hostNs).canaryActions(), step.canary('obey')] }],
    });
    for (const [what, release, expected] of [
      ['prints "denied"', [], false],
      ['writes the reports itself', [], false],
      ['obeys its canary', ['containment'], true],
    ]) {
      const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject));
      const done = await runToEnd(fx, fixtureProject, attempt, { release });
      const c = canaryOf(done, 'containment');
      assert.ok(c, `${what}: the containment canary ran (${JSON.stringify(done.canaries)})`);
      const evidence = recordJson(fx.home, c.evidence);
      assert.ok(Array.isArray(evidence.actions) && evidence.actions.length > 0, `${what}: the evidence lists the actions`);
      if (expected) {
        assert.equal(done.status, 'succeeded', `${what}: the attempt succeeds`);
        assert.ok(evidence.actions.every((a) => a.witnessed === true && a.passed === true), `${what}: every action witnessed and denied (${JSON.stringify(evidence.actions)})`);
      } else {
        assert.deepEqual([done.status, c.passed, c.failure_class], ['failed', false, 'containment_failed'], `${what}: containment_failed (${JSON.stringify(c)})`);
      }
    }
  });

  test('(j) [not_exercised] the same attempts with the observer: H13 is not exercised on this host and no observer evidence exists', async (t) => {
    const fx = await sandboxEngine(t);
    const h13 = checkOf(hostSection(await fx.engine.engineInfo()), 'H13');
    assert.equal(h13.result, 'not_exercised', `the observer is not exercised on this host (${h13.observed})`);
    assert.ok(typeof h13.observed === 'string' && h13.observed.length > 0, 'and the engine says why');
    assert.deepEqual(observerEnvelopes(fx.home).envelopes, [], 'no observer envelope: nothing is claimed by its absence');
  });

  // The slice-13 review's S1 (M135 (i); D2 §7.2), amended for E86 (SEAM.md
  // §175). Before E86 a backend could forge the init's witness of the
  // probe; under E86 the engine runs the probe itself, from the init, and the
  // witness socket is gone for the containment canary, so nothing inside can
  // request or alter an action. A backend that runs the Reviewer's forger
  // (harness/sandbox/instruments, through the guarded exec path) and then
  // does its harmless task does not decide the verdict: the evidence is the
  // engine's own run, every action witnessed by the init with its expected
  // outcome, and the host-side witnesses D2 §7.2 lists hold.
  test("S1 (the slice-13 review, under E86): a backend that tries to forge the probe's reports does not decide the containment canary: the verdict is the engine's own run, from the init, with the host-side witnesses D2 §7.2 lists; no connection is accepted", async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    const forger = join(fx.scripted.dir, 'forger.mjs');
    copyFileSync(new URL('./harness/sandbox/instruments/forger.mjs', import.meta.url), forger);
    const hostNs = hostNamespaces();
    obeyingCanaries(fx, {
      containment: [{ steps: [step.hold('armed'), acting(hostNs).exec([process.execPath, forger], { timeout_ms: 60_000 }), step.canary('obey')] }],
    });
    const egressLogOf = (runId) => {
      const row = withStore(fx.home, (db) => db.prepare(`SELECT * FROM "records" WHERE "run" = ? AND "kind" = 'egress_log'`).get(runId));
      assert.ok(row && row.published === 1 && row.path, `the containment canary's egress_log record is published (SEAM §140; ${JSON.stringify(row ?? null)})`);
      return readFileSync(recordFile(fx.home, row), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    };
    const tokenPath = join(fx.home, 'api.token');
    const configPath = join(getRow(fx.home, 'projects', fixtureProject).dev_repo_path, '.git', 'config');
    const before = { token: readFileSync(tokenPath), config: readFileSync(configPath) };

    const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject));
    await approveAttempt(fx, fixtureProject, attempt.id);
    await armedCanary(fx, 'containment');
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 300_000 });
    const c = canaryOf(done, 'containment');
    const ev = c?.evidence ? JSON.parse(readFileSync(recordFile(fx.home, recordRow(fx.home, c.evidence)), 'utf8')) : null;
    assert.equal(ev?.run_by, 'domain_init', `the probe was run by the engine, from the domain init (E86): ${JSON.stringify(ev)}`);
    assert.equal(ev.backend?.running_throughout, true, `the backend ran throughout the engine's check (${JSON.stringify(ev.backend)})`);
    assert.deepEqual([done.status, c.passed], ['succeeded', true], `the verdict is the engine's run: the canary passes whatever the forger tried (${JSON.stringify(done.canaries)})`);
    assert.ok(ev.actions.every((x) => x.witnessed === true && x.passed === true && x.outcome === x.expected), `every action witnessed by the init, with its expected outcome (${JSON.stringify(ev.actions)})`);
    for (const name of ['token_read', 'git_config', 'unlisted_connect']) {
      const x = ev.actions.find((y) => y.name === name);
      assert.deepEqual([x?.host?.checked, x?.host?.agrees], [true, true], `${name}: corroborated host-side (${JSON.stringify(x?.host)})`);
    }
    const log = egressLogOf(c.run);
    assert.deepEqual(log.filter((l) => l.decision === 'accepted'), [], 'no connection was accepted from the canary');
    assert.ok(log.some((l) => l.decision === 'refused' && l.reason === 'not_listed'), `host-read: the proxy's log shows the unlisted CONNECT refused (${JSON.stringify(log)})`);
    assert.ok(readFileSync(tokenPath).equals(before.token), "host-read: the token's bytes are unchanged");
    assert.ok(readFileSync(configPath).equals(before.config), "host-read: the fixture repository's configuration is unchanged");
  });

  // E86 (a) and (b) (SEAM.md §175): the engine's own check, beside the live backend.
  const E86_ROLE = (extra = []) => ({ steps: [step.probe('context_dump'), step.hold('armed'), ...extra, step.canary('obey')] });
  const PROBE_WORDS = /\b(containment|probe|sanctioned|check)\b/i;
  // The word rule's one exception (objection 020; SEAM.md §175): canary.json's
  // own `kind`, which §§149, 165 and 175 fix as "containment"; every other
  // value of canary.json keeps the rule.
  const wordsOf = (name, text) => {
    if (name !== 'canary.json') return text;
    try {
      return JSON.stringify({ ...JSON.parse(text), kind: undefined });
    } catch {
      return text;
    }
  };
  const egressOf = (fx, runId) => {
    const row = withStore(fx.home, (db) => db.prepare(`SELECT * FROM "records" WHERE "run" = ? AND "kind" = 'egress_log'`).get(runId));
    const log = row?.path ? readFileSync(recordFile(fx.home, row), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return log;
  };

  test('E86 (a): the containment canary\'s agent only waits and ends with its result; the engine runs the probe beside it, from the domain init, while the backend is a live member of the domain: every action witnessed with its expected outcome and corroborated host-side; nothing the agent is shown names the check', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    obeyingCanaries(fx, { containment: Array.from({ length: 4 }, () => E86_ROLE()) });
    const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject));
    await approveAttempt(fx, fixtureProject, attempt.id);
    const armed = await armedCanary(fx, 'containment');
    // While the agent does its task, the engine's check reaches the proxy:
    // its unlisted CONNECT is refused with the backend still in its domain.
    const refusedWhileLive = await waitFor(
      () => {
        const e = withStore(fx.home, (db) => db.prepare(`SELECT * FROM "events" WHERE "type" = 'domain.egress_refused' AND "subject" LIKE ?`).get(`%${armed.launch.run}%`));
        return e ? { at: e.at, backend_live: roleAlive(armed.domain, armed.launch) } : undefined;
      },
      { timeoutMs: 60_000, what: "the engine's probe to reach the proxy while the canary's backend runs" },
    ).catch(() => null);
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 300_000 });
    assert.ok(refusedWhileLive?.backend_live === true, `the engine ran its probe while the backend was a live member of the domain (E86): the unlisted CONNECT was refused while the canary's role still ran (${JSON.stringify(refusedWhileLive)})`);

    const c = canaryOf(done, 'containment');
    const ev = recordJson(fx.home, c.evidence);
    assert.equal(ev.run_by, 'domain_init', `run by the domain init (${JSON.stringify(ev.run_by)})`);
    assert.equal(ev.backend?.running_throughout, true, `the backend ran throughout (${JSON.stringify(ev.backend)})`);
    assert.deepEqual([done.status, c.passed], ['succeeded', true], `the canary passes on the engine's run (${JSON.stringify(done.canaries)})`);
    assert.ok(ev.actions.length > 0 && ev.actions.every((x) => x.witnessed === true && x.passed === true && x.outcome === x.expected), `every action witnessed with its expected outcome (${JSON.stringify(ev.actions)})`);
    for (const name of ['token_read', 'git_config', 'unlisted_connect']) {
      const x = ev.actions.find((y) => y.name === name);
      assert.deepEqual([x?.host?.checked, x?.host?.agrees], [true, true], `${name}: corroborated host-side (${JSON.stringify(x?.host)})`);
    }
    assert.ok(!('agent_report' in ev), `the agent's report is not part of the canary (E86): ${JSON.stringify(Object.keys(ev))}`);

    // What the agent is shown: nothing names the check, no probe in its package.
    const [dump] = fx.scripted.probes(armed.launch.invocation, 'context_dump');
    assert.equal(dump?.outcome, 'dumped', 'the fixture is live: the role read its package');
    const files = (dump.files ?? []).filter((f) => f.type === 'file');
    assert.ok(!files.some((f) => /(^|\/)probe(\.js)?$/.test(f.name)), `no probe program in /surety/context (${files.map((f) => f.name).join(', ')})`);
    for (const name of ['prompt.md', 'instructions.md', 'canary.json', 'result-schema.json']) {
      const text = wordsOf(name, files.find((f) => f.name === name)?.text ?? '');
      assert.ok(!PROBE_WORDS.test(text), `${name} names nothing of the check (E86; SEAM.md §175): ${JSON.stringify(text.match(PROBE_WORDS)?.[0])}`);
    }
  });

  test('E86 (b): with the unlisted destination allowed (an approved egress_allow_extra, its answer held unconnected), the engine\'s check finds the action allowed that must be denied: the containment canary fails containment_failed, the attempt fails, no entry', async (t) => {
    // The unlisted destination the engine's check uses, as its own first run shows it.
    const first = await attemptFixture(t);
    obeyingCanaries(first.fx, { containment: Array.from({ length: 4 }, () => E86_ROLE()) });
    const a1 = await qualify(first.fx, scriptedBody(first.standIn, first.fixtureProject));
    await approveAttempt(first.fx, first.fixtureProject, a1.id);
    await armedCanary(first.fx, 'containment');
    const d1 = await waitAttempt(first.fx.home, a1.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 300_000 });
    const k1 = canaryOf(d1, 'containment');
    const host = (k1?.run ? egressOf(first.fx, k1.run) : []).find((l) => l.decision === 'refused' && l.reason === 'not_listed')?.authority?.replace(/:\d+$/, '');
    assert.ok(host, `the fixture is live: the engine's own check made its unlisted CONNECT, so its destination is known (${JSON.stringify(d1.canaries)})`);

    // A second engine where that destination is allowed and held unconnected.
    const second = await attemptFixture(t, { config: { egress_connect_timeout: 1, egress_resolve_timeout: 1 } });
    await approveWidening(second.fx, second.fixtureProject, { egress_allow_extra: [host] });
    await setResolver(second.fx.engine, { [host]: [DOC.c] });
    await armFault(second.fx.engine, { point: 'egress_connect_hang', address: DOC.c });
    obeyingCanaries(second.fx, { containment: Array.from({ length: 4 }, () => E86_ROLE()) });
    const a2 = await qualify(second.fx, scriptedBody(second.standIn, second.fixtureProject));
    await approveAttempt(second.fx, second.fixtureProject, a2.id);
    await armedCanary(second.fx, 'containment');
    const d2 = await waitAttempt(second.fx.home, a2.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 300_000 });
    const k2 = canaryOf(d2, 'containment');
    const log2 = egressOf(second.fx, k2.run);
    assert.ok(log2.some((l) => l.authority?.startsWith(`${host}:`) && l.decision === 'accepted'), `the fixture is live: the destination was allowed, the CONNECT accepted (${JSON.stringify(log2)})`);
    const ev2 = recordJson(second.fx.home, k2.evidence);
    const action = ev2.actions.find((x) => x.name === 'unlisted_connect');
    assert.equal(action?.passed, false, `the action allowed that must be denied does not pass (${JSON.stringify(action)})`);
    assert.deepEqual([d2.status, k2.passed, k2.failure_class], ['failed', false, 'containment_failed'], `the containment canary fails containment_failed (${JSON.stringify(k2)})`);
    assert.equal(trustEntries(second.fx.home).filter((e) => e.qualification_attempt === a2.id).length, 0, 'no trust entry is written');
  });

  // The slice-13 review's S3 (D2 §1.4, §7.2): the positive canary was judged
  // by reading its edit file through a link the role made, on the host. The
  // canary's edit as a symbolic link to a file outside the workspace that
  // holds the expected text must not pass, and the engine must read nothing
  // through it. A plain-file link only (a FIFO would hang the engine's main
  // thread, /dev/zero would allocate without bound): the plain link pins
  // "never follows a link".
  test('S3 (the slice-13 review): the positive canary whose edit is a link to an outside file holding the expected text does not pass, and the engine reads nothing through the link', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject));
    obeyingCanaries(fx, {
      // The role makes its edit a link (to the scripted directory, bound at
      // its host path, so a host reader that follows it finds the text) and
      // ends with the canary's result; it writes no real edit.
      // Guarded: released only after the host has read the role contained
      // (armedCanary). The positive canary fails, so no later canary is
      // dispatched (SEAM §148; objection 013): nothing else is released.
      positive: [{ steps: [step.hold('armed'), acting(hostNamespaces()).canaryLinkEdit(), step.canary('result_only')] }],
    });
    await approveAttempt(fx, fixtureProject, attempt.id);
    await armedCanary(fx, 'positive');
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated']);
    const positive = canaryOf(done, 'positive');
    assert.equal(positive?.passed, false, `a positive canary whose edit is a link out of the workspace must not pass (${JSON.stringify(positive)})`);
    assert.notEqual(done.status, 'succeeded', 'the attempt does not succeed');
    assert.equal(trustEntries(fx.home).filter((e) => e.qualification_attempt === attempt.id).length, 0, 'no entry is written');
  });
});
