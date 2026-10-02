// M26 (slice 3). Plan §3.3 M26 ("stage and intent finalizers": "Commit a
// valid Architect plan and a completed Builder stage, with finalizer inputs
// pinned before the git effect. Delay finalization while a newer plan fixture
// is introduced. ... The committed plan registers exactly its own
// stages/work; the stage finalizes against its pinned input. No recomputation
// from the newer plan, duplicate registration or ownerless committed
// artifact"); build spec §6 correction 14 (Review B05: "Every intent MUST
// persist or immutably reference its finalizer kind/version and exact semantic
// inputs before the external effect ... repeating it returns those same
// receipts without generating new candidate/stage/version identities or
// consulting a newer plan"); D1 §§7.7 to 7.10; D1-18, D1-32; F §3.10; SEAM.md
// §§41, 45; ../contract/journal.json (`finalizers`).
//
// An Architect's plan is a file it commits: .surety/phases/phase-<n>.json,
// {"phase": n, "stages": [{"number", "goal"}]}. The integration of that
// commit has a finalizer, and the finalizer registers the plan: its
// phase_plans row, one stage row per stage, and one stage_build work item per
// stage. A committed plan is schedulable by construction (D1 §7.8), so a plan
// that could not be registered is not committed: it rejects the run. The
// integration of a Builder's stage has a finalizer too, which marks that
// stage integrated at the run's commit.
//
// What a finalizer writes is fixed with the intent, before the effect. The
// cases stop the engine between the effect and the finalizer, change what a
// finalizer that recomputed would read (a newer plan in the store, a newer
// stage with the same number, the plan file in the role's workspace), and let
// the finalizer run, or kill the engine and let recovery run it. The receipts
// must be the committed plan's, exactly, with the same identities however
// often the engine is restarted afterwards.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { releaseBarrier, within } from './harness/engine.mjs';
import { assertWorkHistory, eventsAbout } from './harness/invariants.mjs';
import { addGitProject, addItem, addStagedProject, permittedEdit, planPath, planText, roleThat, roleThatHolds, runToEnd, runToHold, writePlan } from './harness/gitruns.mjs';
import {
  acceptanceState,
  armBarrier,
  assertCommitted,
  assertNothingAccepted,
  assertOperations,
  journalBarrier,
  operationDetails,
  phasePlansOf,
  receiptSnapshot,
  stagesOf,
  workItemsOf,
} from './harness/journal.mjs';
import { fileAt, refOid } from './harness/repos.mjs';
import { installPlan, requestTick, run as runRow, runsOf, scriptedEngine, tick, waitForRun, workItem } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const PHASE = 2;
const STAGES = [
  { number: 1, goal: 'export service' },
  { number: 2, goal: 'CSV endpoint' },
];

// The committed plan `stages` of phase `phase` is registered, exactly: one
// phase_plans row for its file, one stage row per stage, each with an
// eligible stage_build work item of its own that the plan, not a fixture,
// created. Returns {plan, stages, items}.
function assertPlanRegistered(fx, project, phase, stages) {
  const plans = phasePlansOf(fx.home, project.id).filter((plan) => plan.git_path === planPath(phase));
  assert.equal(plans.length, 1, `one phase_plans row records the committed plan file (found ${plans.length})`);
  const [plan] = plans;
  assert.equal(plan.phase_number, phase, 'the plan row carries its phase number');
  const rows = stagesOf(fx.home, project.id).filter((stage) => stage.phase_plan === plan.id);
  assert.deepEqual(
    rows.map((stage) => [stage.number, stage.goal]).sort(),
    stages.map((stage) => [stage.number, stage.goal]).sort(),
    "the plan's stage rows are the committed plan's stages, exactly",
  );
  const work = workItemsOf(fx.home, project.id);
  const items = [];
  for (const stage of rows) {
    const mine = work.filter((item) => item.subject?.stage === stage.id);
    assert.equal(mine.length, 1, `exactly one work item is the work of stage ${stage.number}`);
    const [item] = mine;
    assert.deepEqual(
      { kind: item.kind, source: item.trigger_source, id: item.trigger_id, generation: item.trigger_generation },
      { kind: 'stage_build', source: 'plan', id: stage.id, generation: 1 },
      `the work of stage ${stage.number} is a stage_build item whose trigger is the stage`,
    );
    assert.equal(stage.work_item, item.id, 'and the stage names it');
    const created = withStore(fx.home, (db) => eventsAbout(db, 'work_item', item.id, 'work.created'));
    assert.equal(created.length, 1);
    assert.notEqual(created[0].payload.test_fixture, true, 'it was created by the plan, not by a fixture');
    items.push(item);
  }
  return { plan, stages: rows, items };
}

describe('M26 a committed Architect plan registers exactly its own stages and work', () => {
  test('the integration of a commit that holds a phase plan registers the plan, one stage row per stage and one stage_build item per stage, and the replan work is complete', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'replan');
    fx.scripted.script(item, [roleThat([writePlan(PHASE, STAGES), step.write('.surety/adrs/0002-phase-two.md', '# Why phase two is cut this way\n')])]);
    const run = await runToEnd(fx, project.id, item);
    const committed = assertCommitted(fx, run.id, { kind: 'intent', parent: project.base, integrated: true, changes: { [planPath(PHASE)]: 'A', '.surety/adrs/0002-phase-two.md': 'A' } });
    assert.equal(fileAt(project.repo.path, committed.sha, planPath(PHASE)), planText(PHASE, STAGES), 'the plan is in the integrated commit as the Architect wrote it');

    const registered = assertPlanRegistered(fx, project, PHASE, STAGES);
    assert.ok(registered.stages.every((stage) => stage.status === 'planned' && stage.integrated_revision === null), 'the stages are planned');
    assert.ok(registered.items.every((work) => work.status === 'eligible'), 'their work is eligible');
    const all = workItemsOf(fx.home, project.id);
    assert.deepEqual(all.map((work) => work.id).sort(), [item, ...registered.items.map((work) => work.id)].sort(), 'the project holds the replan item and the stages\' work, and nothing else');
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'executing', 'integrating', 'integrated', 'complete'], 'the replan work is complete once its plan is integrated and registered');

    // Nothing is registered a second time: not by ticks, not by a restart.
    const before = { plans: phasePlansOf(fx.home, project.id).map((p) => p.id), stages: stagesOf(fx.home, project.id).map((s) => s.id), work: all.map((w) => w.id) };
    await tick(fx.engine, project.id);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, project.id);
    assert.deepEqual(
      { plans: phasePlansOf(fx.home, project.id).map((p) => p.id), stages: stagesOf(fx.home, project.id).map((s) => s.id), work: workItemsOf(fx.home, project.id).map((w) => w.id) },
      before,
      'ticks and a restart register nothing again',
    );
    assertOperations(fx.home, { project: project.id });
  });

  test('the finalizer is delayed while a newer plan is introduced: it registers the committed plan, exactly, and nothing of the newer one', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'replan');
    fx.scripted.script(item, [roleThatHolds([writePlan(PHASE, STAGES)])]);
    const { run } = await runToHold(fx, project.id, item);
    // Stop the integration after its effect and its receipt, before the probe and the finalizer.
    const barrier = journalBarrier('ref_update', 'receipt_committed');
    await armBarrier(fx.engine, barrier, 'pause');
    fx.scripted.release(item);
    await fx.engine.waitUntil(`barrier:${barrier}`);
    const [moving] = operationDetails(fx.home, { run: run.id, journalKind: 'ref_update' });
    assert.deepEqual(moving.events.map((e) => e.kind), ['intended', 'applied'], 'the integration is applied and not finalized');
    assert.equal(refOid(project.repo.path, project.repo.ref), moving.payload.new_oid, 'the branch holds the plan');
    assert.deepEqual(phasePlansOf(fx.home, project.id), [], 'nothing is registered before the finalizer');

    // Meanwhile a newer plan arrives in the store.
    const newer = await installPlan(fx.engine, project.id, [
      { number: 1, goal: 'the newer plan: stage one' },
      { number: 7, goal: 'the newer plan: stage seven' },
    ]);
    const newerStages = stagesOf(fx.home, project.id);
    assert.equal(newerStages.length, 2, 'the fixture is live: the newer plan has two stages');

    await releaseBarrier(fx.engine, barrier);
    await waitForRun(fx.home, item, { state: 'ended' });
    assertCommitted(fx, run.id, { kind: 'intent', parent: project.base, integrated: true, changes: { [planPath(PHASE)]: 'A' } });
    const registered = assertPlanRegistered(fx, project, PHASE, STAGES);

    // The newer plan is as it was: nothing of it was taken, changed or duplicated.
    const after = stagesOf(fx.home, project.id);
    assert.deepEqual(after.filter((stage) => stage.phase_plan === newer.plan.id), newerStages, 'the newer plan\'s stages are untouched');
    assert.equal(after.length, newerStages.length + STAGES.length, 'no stage beyond the two plans\'');
    assert.deepEqual(
      workItemsOf(fx.home, project.id).map((work) => work.id).sort(),
      [item, ...newer.stages.map((stage) => stage.work_item), ...registered.items.map((work) => work.id)].sort(),
      'the work is the replan item, the newer plan\'s and the committed plan\'s, each once',
    );
    assert.equal(workItem(fx.home, item).status, 'complete');
  });

  test('killed after the integration of a plan was confirmed and before its finalizer: the restart registers the plan once, from the commit, and a second restart registers nothing again', async (t) => {
    const barrier = journalBarrier('ref_update', 'probe_confirmed');
    const fx = await scriptedEngine(t, { barriers: [`${barrier}=kill`] });
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'replan');
    fx.scripted.script(item, [roleThat([writePlan(PHASE, STAGES)])]);
    const dead = fx.engine;
    await requestTick(dead, project.id).catch(() => {});
    assert.deepEqual(await within(dead.exited, 20_000), { code: null, signal: 'SIGKILL' }, `the engine kills itself at ${barrier}`);
    const [run] = runsOf(fx.home, item);
    const [moving] = operationDetails(fx.home, { run: run.id, journalKind: 'ref_update' });
    assert.deepEqual(moving.events.slice(0, 3).map((e) => e.kind), ['intended', 'applied', 'confirmed'], 'the integration was confirmed');
    assert.equal(phasePlansOf(fx.home, project.id).length, moving.finalized ? 1 : 0, 'the plan is registered exactly when the journal says finalized');
    assert.equal(refOid(project.repo.path, project.repo.ref), moving.payload.new_oid, 'the plan is on the integration branch');
    // What a finalizer that re-read the workspace would find.
    const workspace = withStore(fx.home, (db) => db.prepare('SELECT "path" FROM "workspaces" WHERE "run" = ?').get(run.id).path);
    writeFileSync(join(workspace, planPath(PHASE)), planText(PHASE, [{ number: 9, goal: 'rewritten while the engine was down' }]));

    await fx.start();
    const registered = assertPlanRegistered(fx, project, PHASE, STAGES);
    assert.equal(stagesOf(fx.home, project.id).length, STAGES.length, 'no ownerless stage, no stage read from the rewritten file');
    assert.equal(workItem(fx.home, item).status, 'complete', 'the committed plan has its owner: the replan work is complete, not held with a plan nobody registered');
    assert.equal(runRow(fx.home, run.id).outcome, 'recovered');

    const receipts = receiptSnapshot(fx.home, project.id);
    await fx.engine.kill();
    await fx.start();
    assert.deepEqual(receiptSnapshot(fx.home, project.id), receipts, 'a second restart writes nothing again: the same plan, stages and work, with the same identities');
    assert.deepEqual(assertPlanRegistered(fx, project, PHASE, STAGES).items.map((work) => work.id), registered.items.map((work) => work.id));
    assertOperations(fx.home, { project: project.id });
  });

  for (const [name, text] of [
    ['is not JSON', '{"phase": 2, "stages": [ this is not JSON'],
    ['has a stage with no goal', planText(PHASE, [{ number: 1, goal: 'export service' }, { number: 2 }])],
  ]) {
    test(`a plan file that ${name} rejects the whole result: no plan is committed that could not be registered`, async (t) => {
      const fx = await scriptedEngine(t);
      const project = await addGitProject(fx);
      const item = await addItem(fx, project.id, 'replan');
      fx.scripted.script(item, [roleThatHolds([step.write(planPath(PHASE), text), step.write('.surety/adrs/0003-a-decision.md', '# permitted, and rejected with the rest\n')])]);
      const { run } = await runToHold(fx, project.id, item);
      const before = acceptanceState(fx, project.id);
      fx.scripted.release(item);
      await waitForRun(fx.home, item, { state: 'ended' });
      assertNothingAccepted(fx, run.id, before, { reason: 'diff_violation', pathInReason: planPath(PHASE) });
      assert.deepEqual([phasePlansOf(fx.home, project.id), stagesOf(fx.home, project.id)], [[], []], 'nothing was registered');
      assert.deepEqual(workItemsOf(fx.home, project.id).map((work) => work.id), [item], 'no work was created');
    });
  }
});

describe('M26 a completed Builder stage finalizes against its pinned input', () => {
  test("the integration of a stage's work marks that stage integrated at the run's commit", async (t) => {
    const fx = await scriptedEngine(t);
    const { project, plan, items } = await addStagedProject(fx);
    fx.scripted.script(items[0], [roleThat([permittedEdit()])]);
    const [before] = stagesOf(fx.home, project.id);
    assert.deepEqual([before.id, before.integrated_revision], [plan.stages[0].id, null], 'the fixture is live: a stage that is not integrated');
    const run = await runToEnd(fx, project.id, items[0]);
    const committed = assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true });
    const [stage] = stagesOf(fx.home, project.id);
    assert.deepEqual({ id: stage.id, status: stage.status, integrated_revision: stage.integrated_revision, work_item: stage.work_item }, { id: plan.stages[0].id, status: 'integrated', integrated_revision: committed.sha, work_item: items[0] }, 'the stage is integrated at the commit');
  });

  test('the finalizer is delayed while a newer plan with a stage of the same number is introduced: the stage the run built is the one finalized, and the newer stage is untouched', async (t) => {
    const fx = await scriptedEngine(t);
    const { project, plan, items } = await addStagedProject(fx);
    fx.scripted.script(items[0], [roleThatHolds([permittedEdit()])]);
    const { run } = await runToHold(fx, project.id, items[0]);
    const barrier = journalBarrier('ref_update', 'receipt_committed');
    await armBarrier(fx.engine, barrier, 'pause');
    fx.scripted.release(items[0]);
    await fx.engine.waitUntil(`barrier:${barrier}`);
    const [moving] = operationDetails(fx.home, { run: run.id, journalKind: 'ref_update' });
    assert.deepEqual(moving.events.map((e) => e.kind), ['intended', 'applied']);
    assert.equal(stagesOf(fx.home, project.id)[0].integrated_revision, null, 'the stage is not finalized before the finalizer');

    // A newer plan arrives whose first stage has the same number.
    const newer = await installPlan(fx.engine, project.id, [{ number: 1, goal: 'the newer plan: another stage one' }]);
    await releaseBarrier(fx.engine, barrier);
    await waitForRun(fx.home, items[0], { state: 'ended' });
    const committed = assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true });

    const stages = stagesOf(fx.home, project.id);
    const built = stages.find((stage) => stage.id === plan.stages[0].id);
    const other = stages.find((stage) => stage.id === newer.stages[0].id);
    assert.deepEqual([built.status, built.integrated_revision], ['integrated', committed.sha], 'the stage whose work the run was is integrated at the commit');
    assert.deepEqual([other.status, other.integrated_revision], ['planned', null], 'the newer stage of the same number is as it was');
    assert.equal(stages.length, 2, 'and no stage was added');
    assert.deepEqual([workItem(fx.home, newer.stages[0].work_item).status, runsOf(fx.home, newer.stages[0].work_item).length], ['eligible', 0], 'its work was neither advanced nor run');
    assertOperations(fx.home, { project: project.id });
  });
});
