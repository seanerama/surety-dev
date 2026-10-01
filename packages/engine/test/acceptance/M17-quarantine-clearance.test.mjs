// M17 (slice 2). Plan §3.2 M17; D1 §§4.5, 16; RN R3; build spec §6
// corrections 2 and 13; Review B17; D1-08, D1-26; SEAM.md §§14, 16. A
// quarantine ends when, and only when, the boundary reports the domain
// terminated. Starting from the durable state of M16 (a quarantined run,
// after a restart), observed emptiness moves the domain quarantined →
// terminated and lets the run end with the outcome it already had: one
// ledger row, one final workspace disposition, the reservation released
// once, no capability revived. Repeating the observation changes nothing.
// Then the work continues: the project is free again, and Resume starts a
// new run.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertWorkHistory, eventsAbout, runFacts } from './harness/invariants.mjs';
import {
  addProject,
  addWork,
  assertRunEnded,
  assertRunQuarantined,
  resumeWork,
  runsOf,
  scriptedEngine,
  stopRun,
  tick,
  tickUntil,
  waitForQuarantine,
  waitForRun,
  waitForRunState,
  waitForWork,
  workItem,
} from './harness/runs.mjs';
import { BOUNDARY, script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const GRACE = { terminate_grace: 1, kill_grace: 1 };

// Every row the run owns, and its work item: its domains, ownership,
// receipts with their observations, usage and ledger rows, leases, grants,
// workspace and decisions. For "repeating it changed nothing".
const rowsAbout = (home, runId) => withStore(home, (db) => JSON.parse(JSON.stringify(runFacts(db, runId))));
const countEvents = (home, runId, type) => withStore(home, (db) => eventsAbout(db, 'run', runId, type).length);

describe('M17 a quarantine is cleared by observed termination, once', () => {
  test('a stopped run whose cancellation failed ends as stopped when the boundary reports its domain empty', async (t) => {
    const fx = await scriptedEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const waiting = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.hold('gate', { before: [step.usage({ input_tokens: 11 })] }), script.complete()]);
    fx.scripted.script(waiting, [script.complete()]);
    await tick(fx.engine, project);
    await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });
    const domain = withStore(fx.home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "run" = ?').get(first.id));

    // M16's durable state: Stop, failed cancellation, quarantine, restart.
    fx.scripted.boundary({ domains: { [domain.id]: BOUNDARY.running } });
    await stopRun(fx.engine, project, first.id);
    await waitForQuarantine(fx.home, first.id);
    await fx.engine.kill();
    await fx.start();
    const quarantined = assertRunQuarantined(fx.home, first.id, { outcome: 'stopped' });
    const reservation = quarantined.leases.find((l) => l.resource_kind === 'quarantine');
    const grant = quarantined.grants[0];
    assert.ok(grant.revoked_at, 'the capability is already revoked');

    // The boundary now reports the domain empty. The next observation clears the quarantine.
    fx.scripted.boundary({ domains: { [domain.id]: BOUNDARY.terminated } });
    await tick(fx.engine, project);
    await waitForRunState(fx.home, first.id, 'ended');
    const ended = assertRunEnded(fx.home, first.id, { outcome: 'stopped', reason_class: 'human_stop', workspace: 'retained', launched: true, recovery: false });
    assert.equal(ended.domains[0].status, 'terminated', 'quarantined → terminated');
    withStore(fx.home, (db) => {
      assert.equal(eventsAbout(db, 'domain', domain.id, 'domain.quarantined').length, 1);
      assert.equal(eventsAbout(db, 'domain', domain.id, 'domain.terminated').length, 1);
    });
    const released = ended.leases.find((l) => l.id === reservation.id);
    assert.ok(released.released_at, 'the reservation is released');
    assert.equal(ended.leases.filter((l) => l.resource_kind === 'quarantine').length, 1, 'and there was only ever one');
    assert.equal(ended.grants.length, 1, 'no new capability was issued to the old run');
    assert.ok(ended.grants[0].revoked_at, 'and the old one was not revived');
    assert.equal(ended.receipts[0].usage.length, 1, 'usage observed before the Stop is still there');
    assert.equal((await waitForWork(fx.home, item, 'held')).status, 'held', 'the stopped work is held, now that cleanup is established');

    // The project is free again: the item that waited is dispatched.
    await tick(fx.engine, project);
    await waitForWork(fx.home, waiting, 'complete');

    // Repeat the observation and the cleanup: more ticks, then a restart.
    const settled = rowsAbout(fx.home, first.id);
    const endedEvents = countEvents(fx.home, first.id, 'run.ended');
    for (let i = 0; i < 2; i++) await tick(fx.engine, project);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, project);
    assert.deepEqual(rowsAbout(fx.home, first.id), settled, 'repeating the observation writes nothing: one ledger row, one disposition, one release');
    assert.equal(countEvents(fx.home, first.id, 'run.ended'), endedEvents);
    assertRunEnded(fx.home, first.id, { outcome: 'stopped', launched: true, recovery: false });

    // Continuation: an explicit Resume, a new run, the work completes.
    await resumeWork(fx.engine, project, item);
    await tick(fx.engine, project);
    await waitForWork(fx.home, item, 'complete');
    const [, second] = runsOf(fx.home, item);
    assert.equal(second.parent_run, first.id);
    assert.notEqual(second.grant, grant.id, 'the new run has a capability of its own');
    withStore(fx.home, (db) => assertWorkHistory(db, item));
  });

  test('a run quarantined after its role finished keeps the outcome it recorded when the quarantine is cleared', async (t) => {
    const fx = await scriptedEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const waiting = await addWork(fx.engine, project, 'review');
    fx.scripted.defaultScript(script.complete([step.usage({ input_tokens: 3 })]));
    fx.scripted.boundary({ default: BOUNDARY.unknown });
    await tick(fx.engine, project);
    const first = await waitForRun(fx.home, item);
    await waitForQuarantine(fx.home, first.id);
    const quarantined = assertRunQuarantined(fx.home, first.id);
    const recorded = quarantined.run.outcome;

    // Membership becomes readable again, and the domain is in fact empty.
    fx.scripted.boundary({ default: BOUNDARY.auto });
    await tick(fx.engine, project);
    await waitForRunState(fx.home, first.id, 'ended');
    const ended = assertRunEnded(fx.home, first.id, { outcome: recorded, launched: true, recovery: false });
    assert.equal(ended.run.reason_class, quarantined.run.reason_class, 'the recorded cause is unchanged');

    assert.equal(ended.receipts[0].usage.length, 1);

    // Whatever that outcome made of the work, the project is free again and
    // both items get done: at once if the run was recorded completed, by a
    // repair run if it was recorded failed.
    await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'complete' && workItem(fx.home, waiting).status === 'complete', {
      max: 6,
      what: 'both items to complete after the quarantine was cleared',
    });
    withStore(fx.home, (db) => {
      assertWorkHistory(db, item);
      assertWorkHistory(db, waiting);
    });
  });
});
