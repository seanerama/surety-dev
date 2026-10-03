// M101, no entry, no dispatch; session mode refused; the qualification
// authority is no bypass (M2 slice 10, kernel lane). M2 plan §3.1 M101;
// D2 §§1.8, 4.1, 7.2, K10, A.7 (D2-T01, D2-A11); AR B04; BS §3; SEAM.md
// §§113, 116, 118.
//
// A project whose policy names a real backend is dispatched to nothing
// unless an entry for that backend is `active`: no entry, a `proposed` one
// and a `revoked` one each refuse the dispatch before launch with
// `backend_refused`, as M08 pins for an engine with no backend at all, and
// no process of the backend is ever started (the stand-in's own log and the
// host's process table both say so). Session mode is refused on the same
// code even beside an active one-shot entry, with no fallback to one-shot,
// and a session-mode entry can never be active. An authorized qualification
// attempt is an authority to run its own canaries and nothing else: it
// dispatches no project work, of its fixture project or of any other.
//
// Every case here is expected to fail on the engine these tests were
// written against, which has no trust table (COVERAGE.md, "M2 slice 10").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { ledgerRows } from './harness/ledger.mjs';
import { readRun } from './harness/reads.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { addWork, assertRunEnded, requestTick, runsOf, waitForRun, waitForWork } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { BACKENDS, PARK_ON_REFUSAL, directUpdateRefused, eventsNamed, installAttempt, installTrustEntry, realBackendProject, refusedTrustEntry, standInProcesses, trustEntry, useBackend } from './harness/trust.mjs';

// One dispatch of a verification item of `project`, refused before launch
// with `backend_refused`: the run ends refused / preflight_refused, its one
// receipt has the observation `refused` and nothing else, no ledger row, no
// `domain.placed`, and the stand-in was neither launched nor is running.
// The project's policy parks a refused item at its first refusal
// (PARK_ON_REFUSAL; objection 002): a refused item that returned to
// `eligible` would be offered again before the next item (SEAM.md §15, one
// run per project, oldest first), and a tick the engine requests itself
// could refuse it twice. So the item is read `parked`, with its one refusal
// counted and the blocker that names the limit (SEAM.md §15).
async function assertDispatchRefused(fx, standIn, project, what) {
  const item = await addWork(fx.engine, project, 'verification');
  const launchesBefore = standIn.launches().length;
  await requestTick(fx.engine, project);
  const run = await waitForRun(fx.home, item, { state: 'ended' });
  const facts = assertRunEnded(fx.home, run.id, { outcome: 'refused', reason_class: 'preflight_refused', launched: false, recovery: false });
  assert.deepEqual(facts.receipts.map((receipt) => receipt.statuses), [['refused']], `${what}: the receipt has the observation refused and nothing else`);
  assert.deepEqual(ledgerRows(fx.home, project).filter((row) => row.run === run.id), [], `${what}: no ledger row`);
  assert.equal((await readRun(fx.engine, project, run.id)).code, 'backend_refused', `${what}: the run read reports backend_refused`);
  assert.deepEqual(eventsNamed(fx.home, 'domain.placed').filter((event) => event.subject?.run === run.id), [], `${what}: no domain.placed event for the run`);
  assert.equal(standIn.launches().length, launchesBefore, `${what}: the stand-in binary was not launched`);
  assert.deepEqual(standInProcesses(standIn), [], `${what}: no process of the backend is in the process table`);
  assert.equal(fx.scripted.launches({ work_item: item }).length, 0, `${what}: and no scripted role stood in for it`);
  const parked = await waitForWork(fx.home, item, 'parked');
  assert.equal(parked.preflight_refusals, 1, `${what}: the refusal is counted on the work item, once`);
  assert.equal(JSON.parse(parked.blocker).reason, 'preflight_refusals_max', `${what}: the item is parked at the limit the policy set`);
  assert.equal(runsOf(fx.home, item).length, 1, `${what}: one run of the item`);
  return run;
}

describe('M101 no entry, no dispatch', () => {
  test('(a) no entry, (b) a proposed entry, (c) a revoked entry: each dispatch to the real backend is refused backend_refused before launch, uncharged, with no domain placed and no process of the backend ever started', async (t) => {
    const { fx, standIn, project } = await realBackendProject(t, { policy: PARK_ON_REFUSAL });
    assert.deepEqual([...(await fx.engine.engineInfo()).backends].sort(), ['scripted'], 'the fixture is live: no real backend is dispatchable before any entry exists');

    await assertDispatchRefused(fx, standIn, project, '(a) no entry');

    const proposed = await installTrustEntry(fx.engine, standIn, { status: 'proposed' });
    assert.equal(trustEntry(fx.home, proposed.id)?.status, 'proposed', 'the fixture is live: a proposed entry exists');
    await assertDispatchRefused(fx, standIn, project, '(b) a proposed entry');

    const revoked = await installTrustEntry(fx.engine, standIn, { status: 'revoked' });
    assert.equal(trustEntry(fx.home, revoked.id)?.status, 'revoked', 'the fixture is live: a revoked entry exists');
    await assertDispatchRefused(fx, standIn, project, '(c) a revoked entry');
    assert.ok(!(await fx.engine.engineInfo()).backends.includes(BACKENDS.claude), 'a backend with no active entry is not among the backends the engine would dispatch to');
  });

  test('(d) session mode is refused backend_refused beside an active one-shot entry, with no fallback to one-shot; the session routes stay 501; a session-mode entry can never be active', async (t) => {
    const { fx, standIn, project } = await realBackendProject(t, { policy: PARK_ON_REFUSAL });
    const active = await installTrustEntry(fx.engine, standIn, { status: 'active' });
    assert.equal(trustEntry(fx.home, active.id)?.status, 'active', 'the fixture is live: an active one-shot entry exists');
    await changePolicy(fx.engine, project, { backend_mode: 'session_headless' });

    await assertDispatchRefused(fx, standIn, project, '(d) session mode');

    // M08's refusal of the session routes is unchanged.
    for (const path of [`/v1/projects/${project}/sessions`, `/v1/projects/${project}/sessions/run_00000000000000000000000000/turns`]) {
      assertRefused(await fx.engine.post(path, {}), 501, 'unsupported', `POST ${path}`);
    }

    // A session_headless entry can never be active: the fixture refuses to
    // install one, and the store refuses to make a proposed one active.
    await refusedTrustEntry(fx.engine, standIn, { status: 'active', mode: 'session_headless' }, { field: 'mode' });
    const session = await installTrustEntry(fx.engine, standIn, { status: 'proposed', mode: 'session_headless' });
    assert.equal(trustEntry(fx.home, session.id)?.mode, 'session_headless', 'the fixture is live: a proposed session-mode entry can be written');
    await fx.engine.stop();
    const attempt = directUpdateRefused(fx.home, 'UPDATE "trust_entries" SET "status" = \'active\', "activated_by" = ? WHERE "id" = ?', trustEntry(fx.home, active.id).activated_by, session.id);
    assert.equal(attempt.refused, true, `the store refuses to make a session_headless entry active (${attempt.code})`);
    assert.match(attempt.code, /^SQLITE_CONSTRAINT/, 'with a constraint error, not a silently ignored write');
    assert.equal(trustEntry(fx.home, session.id).status, 'proposed', 'the entry is still proposed');
  });

  test('(e) an authorized qualification attempt dispatches nothing but its canaries: an ordinary item of its fixture project and one of another project are both refused backend_refused', async (t) => {
    const { fx, standIn, project } = await realBackendProject(t, { policy: PARK_ON_REFUSAL });
    const other = (await addGitProject(fx)).id;
    await useBackend(fx.engine, other, BACKENDS.claude, { roles: ['verifier'], extra: PARK_ON_REFUSAL });
    fx.scripted.defaultScript(script.complete());
    const attempt = await installAttempt(fx.engine, standIn, { status: 'authorized', fixture_project: project });
    assert.ok(attempt, 'the fixture is live: an authorized attempt for the backend exists, with the first project as its fixture project');

    await assertDispatchRefused(fx, standIn, project, "(e) the attempt's fixture project");
    await assertDispatchRefused(fx, standIn, other, '(e) another project');
    assert.equal(standIn.launches().length, 0, 'the attempt launched nothing for project work');
  });
});
