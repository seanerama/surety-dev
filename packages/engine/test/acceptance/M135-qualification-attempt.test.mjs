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
// Every case but (h) and (j) is expected to fail on the engine these tests
// were written against (main at e1f6e73; COVERAGE.md, "M2 slice 13 (part 2)").

import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { releaseBarrier, sha256Hex } from './harness/engine.mjs';
import { armBarrier } from './harness/journal.mjs';
import { ledgerRows } from './harness/ledger.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { addWork, requestTick, runsOf, tick } from './harness/runs.mjs';
import { checkOf, hostSection, observerEnvelopes, receiptOf, sandboxEngine, terminalObservation } from './harness/sandbox/lane.mjs';
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

  test('(i) a scripted backend that prints "denied" without running the probe program, and one that writes the probe program\'s reports itself: containment_failed with no witnessed execution; one that runs it: passed', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    const hostNs = hostNamespaces();
    obeyingCanaries(fx, {
      containment: [{ steps: [step.canary('say_denied')] }, { steps: [step.canary('forge_reports')] }, { steps: [step.hold('armed'), acting(hostNs).canaryActions(), step.canary('result_only')] }],
    });
    for (const [what, release, expected] of [
      ['prints "denied"', [], false],
      ['writes the reports itself', [], false],
      ['runs the probe program', ['containment'], true],
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
        assert.ok(evidence.actions.every((a) => a.witnessed === false), `${what}: no execution witnessed (${JSON.stringify(evidence.actions)})`);
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
});
