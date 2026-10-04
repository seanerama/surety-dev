// M131, known usage retained; a resume is a new invocation; the session id
// before launch (M2 slice 13 part 2, sandbox lane). M2 plan §3.6 M131; D2
// §1.5, §1.7, §5 C4, K6 (D2-A07 to D2-A12); D1 §15.3; AR B07, A10, A12;
// SEAM.md §§120, 139, 143, 146, 151.
//
// A run stopped after two usage observations keeps the folded tokens with
// its usage incomplete and the unknown allowance charged once, through a
// failed ledger write, its retry and a restart. A Resume is a new run with
// its own receipt, domain, workspace and context rebuilt from records; the
// real template's argv never resumes a provider session, and the stopped
// run's unaccepted result never becomes the new run's. Claude Code's
// --session-id is derived from the invocation id and recorded on the
// receipt before the launcher is placed; after a crash before
// authorization the resumed run has its own receipt and its own id.
//
// SAFETY: the stand-in records and holds; it runs nothing. The provider key
// is a test-made string held by the engine's resolver. No guarded action.
//
// Every case is expected to fail on the engine these tests were written
// against (main at e1f6e73; COVERAGE.md, "M2 slice 13 (part 2)").

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { armFault, releaseBarrier, waitFor } from './harness/engine.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { armBarrier, changePolicy } from './harness/journal.mjs';
import { ledgerRows } from './harness/ledger.mjs';
import { holdSecret, recordsOf } from './harness/records.mjs';
import { addWork, assertRunEnded, countOf, requestTick, resumeWork, run as runRow, runsOf, stopRun, tick, waitForRun, waitForRunState, waitForWork } from './harness/runs.mjs';
import { domainOf, eventsOf, receiptOf, roleHolding, sandboxEngine } from './harness/sandbox/lane.mjs';
import { unacceptedOf } from './harness/sandbox/result.mjs';
import { VALID_RESULT, step } from './harness/scripted.mjs';
import { BACKENDS, PARK_ON_REFUSAL, StandIn, apiKeyRef, installTrustEntry, useBackend } from './harness/trust.mjs';

const pick = (row, keys) => Object.fromEntries(keys.map((key) => [key, row[key]]));

// SEAM.md §146: the session id a receipt's id gives.
function sessionIdOf(invocation) {
  const h = createHash('sha256').update(`surety-session:${invocation}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// A sandbox-lane project whose verifier is `claude`, bound by an active
// fixture entry to a stand-in that logs into the scripted directory.
async function claudeVerifierProject(t) {
  const fx = await sandboxEngine(t, { config: { terminate_grace: 3, kill_grace: 2 } });
  const standIn = new StandIn(join(fx.root, 'standin'), { logDir: fx.scripted.dir });
  const project = (await addGitProject(fx)).id;
  await holdSecret(fx.engine, apiKeyRef(BACKENDS.claude), `sk-test-key-for-the-stand-in-${randomBytes(6).toString('hex')}`);
  await useBackend(fx.engine, project, BACKENDS.claude, { roles: ['verifier'], extra: { ...PARK_ON_REFUSAL, repair_attempts_max: 0 } });
  await installTrustEntry(fx.engine, standIn, { status: 'active' });
  return { fx, standIn, project };
}

const argAfter = (args, flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};

const manifestOf = (launch) => JSON.parse((launch.context ?? []).find((f) => f.name === 'manifest.json')?.text ?? 'null');

describe('M131 known usage retained; a resume is a new invocation; the session id before launch', () => {
  test('(a) two usage observations, then a Stop, with the ledger write failing once, its retry and a restart: the folded tokens kept, usage_complete 0, the unknown allowance per C4, one original row', async (t) => {
    const fx = await sandboxEngine(t, { config: { terminate_grace: 3, kill_grace: 2 } });
    const project = (await addGitProject(fx)).id;
    await changePolicy(fx.engine, project, { budget_run_billable_tokens: 10_000 });
    const item = await addWork(fx.engine, project, 'verification');
    await armFault(fx.engine, { point: 'before_event', event_type: 'ledger.row' });
    const { run } = await roleHolding(fx, project, item, { before: [step.usage({ input_tokens: 2000, output_tokens: 500 }), step.usage({ input_tokens: 4000, output_tokens: 1000 })] });
    await waitFor(() => (withObservations(fx, run.id) >= 2 ? true : undefined), { what: 'both usage observations to be recorded' });
    await stopRun(fx.engine, project, run.id);
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 60_000 });
    assertRunEnded(fx.home, run.id, { outcome: 'stopped', reason_class: 'human_stop', launched: true, recovery: false });
    const expected = { billable_in: 4000, out: 1000, usage_complete: 0, unknown_allowance_tokens: 5000 };
    const mine = () => ledgerRows(fx.home, project).filter((r) => r.run === run.id && r.corrects === null).map((r) => pick(r, Object.keys(expected)));
    assert.deepEqual(mine(), [expected], 'after the fault and the retry: one original row, the folded tokens kept, the allowance the run limit less what was observed');
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, project);
    assert.deepEqual(mine(), [expected], 'after a restart and a tick: still the one row, the allowance charged once');
  });

  test("(b) Resume: a new run, receipt, domain and workspace; the context rebuilt from the stopped run's records; no --resume in the executed argv; the old unaccepted_result never the new run's result", async (t) => {
    const { fx, standIn, project } = await claudeVerifierProject(t);
    standIn.leaveResult(VALID_RESULT);
    standIn.hold();
    const item = await addWork(fx.engine, project, 'verification');
    await requestTick(fx.engine, project);
    await waitFor(() => standIn.launches().length > 0 || runsOf(fx.home, item)[0]?.state === 'ended', { timeoutMs: 60_000, what: 'the stand-in to be launched' });
    assert.equal(standIn.launches().length, 1, `the fixture is live: the stand-in was launched (run: ${JSON.stringify(runsOf(fx.home, item)[0])})`);
    const first = await waitForRun(fx.home, item, { state: 'executing' });
    await stopRun(fx.engine, project, first.id);
    await waitForRunState(fx.home, first.id, 'ended', { timeoutMs: 60_000 });
    assertRunEnded(fx.home, first.id, { outcome: 'stopped', reason_class: 'human_stop', launched: true, recovery: false });
    const old = unacceptedOf(fx.home, first.id, project);
    assert.deepEqual(old.value, VALID_RESULT, 'the fixture is live: the stopped run published its result file as an unaccepted_result');

    standIn.release();
    await resumeWork(fx.engine, project, item);
    await requestTick(fx.engine, project);
    const second = await waitForRun(fx.home, item, { index: 1, state: 'ended', timeoutMs: 60_000 });
    assert.equal(second.parent_run, first.id, 'the resumed run is a new run linked to the stopped one');
    const [l1, l2] = standIn.launches();
    assert.ok(l2, 'the stand-in was launched for the resumed run');
    assert.notEqual(receiptOf(fx.home, second.id).id, receiptOf(fx.home, first.id).id, 'a new receipt');
    assert.notEqual(domainOf(fx.home, second.id).id, domainOf(fx.home, first.id).id, 'a new domain');
    assert.notEqual(second.workspace, first.workspace, 'a new workspace');
    assert.deepEqual([l1.invocation, l2.invocation].map((x) => x === null), [false, false]);
    assert.notEqual(l2.invocation, l1.invocation, 'the backend was launched as another invocation');
    for (const a of l2.args) assert.ok(a !== '--resume' && a !== 'resume' && !a.startsWith('--resume='), `the executed argv never resumes a provider session (${JSON.stringify(l2.args)})`);
    const manifest = manifestOf(l2);
    assert.ok(manifest, 'the resumed backend saw /surety/context/manifest.json');
    const prior = manifest.files.filter((f) => f.kind === 'prior_run');
    const firstRecords = recordsOfRun(fx, first.id);
    assert.ok(prior.length >= 1 && prior.every((f) => firstRecords.includes(f.source)), `the context is rebuilt from the stopped run's records (${JSON.stringify(prior)}; records ${firstRecords.join(', ')})`);
    const after = runRow(fx.home, second.id);
    assert.notEqual(after.result, old.row.id, 'the old unaccepted_result is not the new run\'s result');
    assert.notEqual(after.outcome, 'completed', `and never becomes current success (${after.outcome} / ${after.reason_class})`);
  });

  test('(c) A12: the rendered argv carries --session-id, the UUID derived from the invocation id, recorded on the receipt before domain.placed; a crash at launcher.before_authorization, then a Resume: the resumed run\'s receipt has its own id and its own session id, the old receipt unchanged', async (t) => {
    const { fx, standIn, project } = await claudeVerifierProject(t);
    const item = await addWork(fx.engine, project, 'verification');
    await armBarrier(fx.engine, 'launcher.before_placement', 'pause');
    await armBarrier(fx.engine, 'launcher.before_authorization', 'pause');
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:launcher.before_placement', { timeoutMs: 60_000 });
    const first = await waitForRun(fx.home, item);
    const r1 = receiptOf(fx.home, first.id);
    assert.equal(r1.provider_session_id, sessionIdOf(r1.id), `before placement the receipt holds the session id derived from its id (${r1.provider_session_id}; derived ${sessionIdOf(r1.id)})`);
    assert.deepEqual(eventsOf(fx.home, 'run', first.id, 'domain.placed'), [], 'and no domain.placed has been written');
    assert.equal(runRow(fx.home, first.id).provider_session_id, r1.provider_session_id, 'the run holds the same id');

    await releaseBarrier(fx.engine, 'launcher.before_placement');
    await fx.engine.waitUntil('barrier:launcher.before_authorization', { timeoutMs: 60_000 });
    await fx.engine.kill();
    await fx.start();
    const recovered = await waitForRunState(fx.home, first.id, 'ended', { timeoutMs: 60_000 });
    assert.deepEqual([recovered.outcome, recovered.reason_class], ['recovered', 'recovered'], 'recovery ended the run');
    assert.equal(standIn.launches().length, 0, 'the stand-in never ran for the crashed run');
    await waitForWork(fx.home, item, ['held', 'eligible', 'parked']);

    await resumeWork(fx.engine, project, item);
    await requestTick(fx.engine, project);
    await standIn.waitForLaunch({}, { timeoutMs: 60_000 });
    const second = await waitForRun(fx.home, item, { index: 1 });
    const r2 = receiptOf(fx.home, second.id);
    assert.notEqual(r2.id, r1.id, 'the resumed run has its own receipt');
    assert.equal(r2.provider_session_id, sessionIdOf(r2.id), 'and its own session id, derived from its own receipt');
    assert.notEqual(r2.provider_session_id, r1.provider_session_id);
    const [launch] = standIn.launches();
    assert.equal(argAfter(launch.args, '--session-id'), sessionIdOf(r2.id), `the rendered argv's --session-id is the derived UUID (${JSON.stringify(launch.args)})`);
    assert.match(argAfter(launch.args, '--session-id'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a UUID in RFC 9562 form');
    assert.equal(receiptOf(fx.home, first.id).provider_session_id, r1.provider_session_id, 'the old receipt is unchanged');
    await waitForRunState(fx.home, second.id, 'ended', { timeoutMs: 60_000 });
  });
});

const withObservations = (fx, runId) => {
  const receipt = receiptOf(fx.home, runId);
  return receipt ? countOf(fx.home, 'usage_observations', '"invocation" = ?', receipt.id) : 0;
};

const recordsOfRun = (fx, runId) => recordsOf(fx.home, runRow(fx.home, runId).project).filter((r) => r.run === runId).map((r) => r.id);
