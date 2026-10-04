// M134, revocation on change; dispatch needs a current host qualification
// (M2 slice 13 part 2, sandbox lane). M2 plan §3.7 M134; D2 §4.1, §7.1,
// §7.3 (D2-T01 to D2-T05); AR N03, T03, T04; SEAM.md §§116, 123, 139, 150.
//
// An active entry for the stand-in is revoked when its binary's bytes, its
// help text, its template version, its profile fingerprint or its host
// identity changes: trust.revoked with the reason, the next dispatch
// refused backend_refused, a run already in flight left to end as it
// would. A failed host check suspends the entry without revoking it and a
// compatible restart restores dispatch with no new attempt; a restart under
// another mechanism refuses dispatch naming requalification.
//
// SAFETY: the stand-in records and holds; it runs nothing. The harness
// switches change only what the engine believes of its own start. No
// guarded action. The provider key is a test-made string.
//
// Every case is expected to fail on the engine these tests were written
// against (main at e1f6e73; COVERAGE.md, "M2 slice 13 (part 2)").

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { waitFor, writeEngineConfig } from './harness/engine.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { holdSecret } from './harness/records.mjs';
import { addWork, requestTick, run as runRow, runsOf, waitForRun, waitForRunState } from './harness/runs.mjs';
import { SANDBOX_CONFIG, domainOf, receiptOf, sandboxEngine, terminalObservation } from './harness/sandbox/lane.mjs';
import { refusedBeforeLaunch } from './harness/sandbox/view.mjs';
import { withStore } from './harness/store.mjs';
import { BACKENDS, PARK_ON_REFUSAL, StandIn, apiKeyRef, installTrustEntry, trustEntry, trustEvents, useBackend } from './harness/trust.mjs';
import { attemptsOf } from './harness/sandbox/qualify.mjs';

const KEY = `sk-test-key-for-the-stand-in-${randomBytes(6).toString('hex')}`;

// A sandbox-lane engine, the stand-in, two projects whose verifier is
// `claude`, and one active fixture entry for it.
async function revocationFixture(t, { config = {} } = {}) {
  const fx = await sandboxEngine(t, { config });
  const standIn = new StandIn(join(fx.root, 'standin'), { logDir: fx.scripted.dir });
  const projects = [];
  for (let i = 0; i < 2; i++) {
    const project = (await addGitProject(fx)).id;
    await useBackend(fx.engine, project, BACKENDS.claude, { roles: ['verifier'], extra: { ...PARK_ON_REFUSAL, repair_attempts_max: 0 } });
    projects.push(project);
  }
  await holdSecret(fx.engine, apiKeyRef(BACKENDS.claude), KEY);
  const entry = await installTrustEntry(fx.engine, standIn, { status: 'active' });
  assert.equal(trustEntry(fx.home, entry.id).status, 'active', 'the fixture is live: the entry is active');
  return { fx, standIn, projects, entry };
}

// Restart the engine with these switches; the resolver holds the key again.
async function restart(fx, args = []) {
  await fx.engine.stop();
  await fx.start({ args });
  await holdSecret(fx.engine, apiKeyRef(BACKENDS.claude), KEY);
}

function assertRevoked(fx, entry, reason) {
  const row = trustEntry(fx.home, entry.id);
  assert.deepEqual([row.status, row.revoked_reason], ['revoked', reason], `the entry is revoked for ${reason} (${row.status}, ${row.revoked_reason})`);
  assert.ok(row.revoked_at, 'revoked_at is set');
  const events = trustEvents(fx.home, entry.id, 'trust.revoked');
  assert.equal(events.length, 1, 'one trust.revoked');
  assert.equal(events[0].payload?.reason, reason, `trust.revoked names the reason (${JSON.stringify(events[0].payload)})`);
}

// A dispatch of a new item that reaches the stand-in.
async function dispatchReaches(fx, standIn, project) {
  const before = standIn.launches().length;
  const item = await addWork(fx.engine, project, 'verification');
  await requestTick(fx.engine, project);
  await waitFor(() => standIn.launches().length > before || runsOf(fx.home, item)[0]?.state === 'ended', { timeoutMs: 60_000, what: 'the dispatch to reach the stand-in or end' });
  assert.ok(standIn.launches().length > before, `the dispatch reached the stand-in (the run: ${JSON.stringify(runsOf(fx.home, item)[0])})`);
  const run = await waitForRun(fx.home, item, { state: 'ended', timeoutMs: 60_000 });
  return run;
}

const hostRows = (home) => withStore(home, (db) => db.prepare('SELECT "id", "status", "mechanism_fingerprint" FROM "host_qualifications" ORDER BY rowid').all());

// (a) and (b): the change is found by a dispatch while a run is in flight.
async function changeWhileInFlight(t, change, reason) {
  const { fx, standIn, projects, entry } = await revocationFixture(t);
  standIn.hold();
  const item = await addWork(fx.engine, projects[0], 'verification');
  await requestTick(fx.engine, projects[0]);
  await standIn.waitForLaunch({}, { timeoutMs: 60_000 });
  const inFlight = await waitForRun(fx.home, item, { state: 'executing' });
  change(standIn);
  const refused = await refusedBeforeLaunch(fx, projects[1], await addWork(fx.engine, projects[1], 'verification'), 'backend_refused', `after the ${reason}`);
  assertRevoked(fx, entry, reason);
  if (reason === 'binary_changed') assert.deepEqual([refused.shown.refusal.subject.expected_sha256, refused.shown.refusal.subject.found_sha256], [standIn.sha256, standIn.changedSha256], 'the refusal names the mismatch');
  assert.equal(runRow(fx.home, inFlight.id).state, 'executing', 'the run in flight is untouched by the revocation');
  assert.equal(domainOf(fx.home, inFlight.id).launch_state, 'authorized', 'its domain is not closed');
  standIn.release();
  const ended = await waitForRunState(fx.home, inFlight.id, 'ended', { timeoutMs: 60_000 });
  const terminal = terminalObservation(fx.home, receiptOf(fx.home, inFlight.id).id);
  assert.notEqual(terminal?.exit_class, 'engine_signaled', `the run in flight ended by its own exit, not by the engine (${JSON.stringify(terminal)}; ${ended.outcome}/${ended.reason_class})`);
}

// (c) to (e): the change is found at a start.
async function changeAtStart(t, { args = [], config }, reason) {
  const { fx, projects, entry } = await revocationFixture(t);
  if (config !== undefined) writeEngineConfig(fx.home, { ...SANDBOX_CONFIG, ...config });
  await restart(fx, args);
  assertRevoked(fx, entry, reason);
  await refusedBeforeLaunch(fx, projects[0], await addWork(fx.engine, projects[0], 'verification'), 'backend_refused', `after the ${reason}`);
  return { fx, entry };
}

describe('M134 revocation on change; dispatch needs a current host qualification', () => {
  test("(a) the binary's bytes changed: trust.revoked (binary_changed), the next dispatch backend_refused naming the mismatch, the run in flight untouched", async (t) => {
    await changeWhileInFlight(
      t,
      (standIn) => {
        standIn.changedSha256 = standIn.changeBytes('M134 (a)');
      },
      'binary_changed',
    );
  });

  test("(b) its help text changed (its bytes unchanged): trust.revoked (help_changed), the next dispatch backend_refused, the run in flight untouched", async (t) => {
    await changeWhileInFlight(t, (standIn) => standIn.changeHelp('usage: surety-standin, a changed help text\n'), 'help_changed');
  });

  test('(c) the template version changed (harness): revoked at the start (template_changed), dispatch backend_refused', async (t) => {
    await changeAtStart(t, { args: ['--harness-template-version', 'claude=claude-one-shot-m134c'] }, 'template_changed');
  });

  test('(d) the profile fingerprint changed (domain_writable_bytes): revoked at the start (profile_changed), dispatch backend_refused', async (t) => {
    const { fx } = await changeAtStart(t, { config: { domain_writable_bytes: 128 * 1024 * 1024 } }, 'profile_changed');
    assert.match(String((await fx.engine.engineInfo()).host_qualification?.profile_fingerprint), /^[0-9a-f]{64}$/, 'the engine read shows the profile fingerprint in force');
  });

  test('(e) the host identity changed (harness): revoked at the start (host_changed), dispatch backend_refused', async (t) => {
    await changeAtStart(t, { args: ['--harness-host-id', `m134e-${randomBytes(4).toString('hex')}`] }, 'host_changed');
  });

  test("(f) T04: a harness-failed check at start suspends the entry (active, dispatch isolation_unqualified); a compatible restart restores dispatch with no new attempt, the entry's own host qualification lapsed and the current one another", async (t) => {
    const { fx, standIn, projects, entry } = await revocationFixture(t);
    const ownRow = trustEntry(fx.home, entry.id).host_qualification;
    assert.ok(ownRow, 'the fixture is live: the entry records the host qualification in force when it was installed');
    const attemptsBefore = attemptsOf(fx.home).length;
    await restart(fx, ['--harness-host-check', 'H6=failed']);
    assert.equal(trustEntry(fx.home, entry.id).status, 'active', 'a failed check suspends the entry; it is not revoked');
    await refusedBeforeLaunch(fx, projects[0], await addWork(fx.engine, projects[0], 'verification'), 'isolation_unqualified', 'with H6 failed');
    await restart(fx);
    assert.equal(trustEntry(fx.home, entry.id).status, 'active');
    const run = await dispatchReaches(fx, standIn, projects[1]);
    assert.equal(receiptOf(fx.home, run.id).trust_entry, entry.id, 'dispatch is restored to the entry');
    assert.equal(attemptsOf(fx.home).length, attemptsBefore, 'with no new qualification attempt');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "invocation_receipts" WHERE "qualification_attempt" IS NOT NULL').get().n), 0, 'and no run under an attempt\'s authority, so no attempt\'s ledger row');
    const rows = hostRows(fx.home);
    assert.equal(rows.find((r) => r.id === ownRow)?.status, 'lapsed', "the entry's own host qualification row is lapsed");
    const active = rows.filter((r) => r.status === 'active');
    assert.equal(active.length, 1, 'one active row');
    assert.notEqual(active[0].id, ownRow, 'and it is another');
  });

  test('(g) an incompatible restart (another mechanism, harness): dispatch backend_refused naming requalification; the entry not revoked by that alone', async (t) => {
    const { fx, projects, entry } = await revocationFixture(t);
    const before = hostRows(fx.home).find((r) => r.status === 'active');
    await restart(fx, ['--harness-mechanism-variant', 'm134g']);
    const after = hostRows(fx.home).find((r) => r.status === 'active');
    assert.ok(after && after.mechanism_fingerprint !== before.mechanism_fingerprint, `the fixture is live: the active host qualification has another mechanism fingerprint (${before?.mechanism_fingerprint} → ${after?.mechanism_fingerprint})`);
    const { shown } = await refusedBeforeLaunch(fx, projects[0], await addWork(fx.engine, projects[0], 'verification'), 'backend_refused', 'under another mechanism');
    assert.equal(shown.refusal?.subject?.requalification_required, true, `the refusal names requalification (${JSON.stringify(shown.refusal)})`);
    assert.equal(trustEntry(fx.home, entry.id).status, 'active', 'not revoked by that alone');
  });
});
