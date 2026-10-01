// M16 (slice 2). Plan §3.2 M16; D1 §§4.5, 16.1; RN R3; build spec §6
// corrections 1 and 2; Review B08; D1-08; SEAM.md §§14, 16. When the
// execution boundary does not report a domain terminated, nothing may treat
// it as terminated: the run stays finalizing and quarantined, the workspace
// is kept, the lease becomes a quarantine reservation and not execution
// authority, a blocker says so, and nothing else of the project is
// dispatched. All of it survives a restart. An operator's acknowledgement is
// recorded and establishes nothing. Three ways into it: the role's process
// exited but the boundary still reports the domain running (a descendant
// lives on); the boundary cannot read membership; cancellation fails.
// The scripted boundary proves the engine's reaction. It qualifies no real
// containment (Plan §2).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  addProject,
  addWork,
  answerDecision,
  assertRunQuarantined,
  getRow,
  leasesOf,
  run as runRow,
  runsOf,
  scriptedEngine,
  stopRun,
  tick,
  waitForQuarantine,
  waitForRun,
  workItem,
} from './harness/runs.mjs';
import { BOUNDARY, script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const GRACE = { terminate_grace: 1, kill_grace: 1 };

// What must stay true for as long as the quarantine lasts, however many
// ticks run: not ended, nothing discarded, nothing reused.
async function assertQuarantineHolds(fx, project, { runId, item, waiting, outcome, blocker = 'open' }) {
  for (let i = 0; i < 2; i++) await tick(fx.engine, project);
  const facts = assertRunQuarantined(fx.home, runId, { outcome, blocker });
  assert.equal(runsOf(fx.home, item).length, 1, 'the quarantined work is not dispatched again');
  assert.equal(runsOf(fx.home, waiting).length, 0, 'nothing else of the project is dispatched onto what the run still holds');
  assert.equal(workItem(fx.home, waiting).status, 'eligible');
  assert.ok(!['complete', 'held'].includes(workItem(fx.home, item).status), `the work is neither complete nor released (it is ${workItem(fx.home, item).status})`);
  return facts;
}

// The same quarantine, read again after the engine was killed and restarted.
async function assertSurvivesRestart(fx, project, ids, before) {
  await fx.engine.kill();
  await fx.start();
  const after = await assertQuarantineHolds(fx, project, ids);
  assert.equal(after.run.outcome, before.run.outcome, 'the recorded outcome is unchanged');
  const reservation = (facts) => facts.leases.find((l) => l.resource_kind === 'quarantine' && l.released_at === null).id;
  assert.equal(reservation(after), reservation(before), 'the same quarantine reservation is still held');
  const blockerId = (facts) => facts.decisions.find((d) => d.kind === 'blocker').id;
  assert.equal(blockerId(after), blockerId(before), 'the same blocker is still there; the question is not asked twice');
  assert.equal(after.decisions.filter((d) => d.kind === 'blocker').length, 1, 'one blocker for one quarantine');
  for (const g of after.grants) assert.ok(g.revoked_at, 'no grant is live after the restart');
  return after;
}

describe('M16 unknown termination is never success', () => {
  test('the role process exited, but the boundary still reports the domain running', async (t) => {
    const fx = await scriptedEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const waiting = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.complete([step.write('report.txt', 'verified')])]);
    fx.scripted.script(waiting, [script.hold('gate')]);
    // The parent exits normally; the boundary says something of the domain still runs.
    fx.scripted.boundary({ default: BOUNDARY.running });

    await tick(fx.engine, project);
    const first = await waitForRun(fx.home, item);
    await waitForQuarantine(fx.home, first.id);
    const [launch] = fx.scripted.launches({ run: first.id });
    assert.equal(fx.scripted.isLive(launch), false, 'the process the engine spawned has exited');
    const ids = { runId: first.id, item, waiting };
    const before = await assertQuarantineHolds(fx, project, ids);
    assert.ok(existsSync(`${before.workspaces[0].path}/report.txt`), 'the workspace is kept as the role left it');
    const question = before.decisions.find((d) => d.kind === 'blocker');
    assert.ok(question.question.length > 0, 'the blocker says what is wrong');
    assert.ok(JSON.parse(question.options).some((o) => o.key === 'acknowledge'));

    const after = await assertSurvivesRestart(fx, project, ids, before);

    // The operator acknowledges. That is recorded, and it establishes nothing.
    const blocker = after.decisions.find((d) => d.kind === 'blocker');
    await answerDecision(fx.engine, project, blocker.id, 'acknowledge');
    assert.equal(getRow(fx.home, 'decisions', blocker.id).status, 'consumed');
    const acknowledged = await assertQuarantineHolds(fx, project, { ...ids, blocker: 'any' });
    assert.equal(acknowledged.domains[0].status, 'quarantined', 'an acknowledgement does not establish that the domain is empty');
    assert.equal(runRow(fx.home, first.id).state, 'finalizing');
    assert.ok(existsSync(`${before.workspaces[0].path}/report.txt`));
  });

  test('the boundary cannot read membership', async (t) => {
    const fx = await scriptedEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const waiting = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.hold('gate')]);
    fx.scripted.script(waiting, [script.hold('gate')]);
    await tick(fx.engine, project);
    await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });

    fx.scripted.boundary({ default: BOUNDARY.unknown });
    await stopRun(fx.engine, project, first.id);
    await waitForQuarantine(fx.home, first.id);
    const ids = { runId: first.id, item, waiting, outcome: 'stopped' };
    const before = await assertQuarantineHolds(fx, project, ids);
    assert.equal(leasesOf(fx.home, first.id).filter((l) => l.resource_kind === 'run' && l.released_at === null).length, 0, 'unknown is not execution authority');
    await assertSurvivesRestart(fx, project, ids, before);
  });

  test('cancellation fails: the boundary keeps reporting the domain running after Stop', async (t) => {
    const fx = await scriptedEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const waiting = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.hold('gate', { on_term: 'ignore' })]);
    fx.scripted.script(waiting, [script.hold('gate')]);
    await tick(fx.engine, project);
    await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });
    const domain = withStore(fx.home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "run" = ?').get(first.id));

    fx.scripted.boundary({ domains: { [domain.id]: BOUNDARY.running } });
    await stopRun(fx.engine, project, first.id);
    await waitForQuarantine(fx.home, first.id);
    const ids = { runId: first.id, item, waiting, outcome: 'stopped' };
    const before = await assertQuarantineHolds(fx, project, ids);
    assert.ok(existsSync(before.workspaces[0].path), 'the workspace is not discarded or reused');
    const after = await assertSurvivesRestart(fx, project, ids, before);

    const blocker = after.decisions.find((d) => d.kind === 'blocker');
    await answerDecision(fx.engine, project, blocker.id, 'acknowledge');
    const acknowledged = await assertQuarantineHolds(fx, project, { ...ids, blocker: 'any' });
    assert.equal(acknowledged.run.outcome, 'stopped');
    assert.equal(acknowledged.domains[0].status, 'quarantined', 'an acknowledgement does not establish that the domain is empty');
  });
});
