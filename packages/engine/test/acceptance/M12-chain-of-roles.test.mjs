// M12, the chain of roles (slice 3, second session). Plan §3.2 M12 ("... or at
// `max_chained_roles`, one case at a time. ... Ineligible work never launches;
// other eligible work progresses. ... Chaining stops at the declared human
// boundary"); D1 §8.1 step 8 ("skip items with ... a chaining boundary
// reached under `max_chained_roles`"); D1-34 ("Dispatch stops at the
// boundary; the next step is a decision"); E24 item 1; SEAM.md §§12, 40.
//
// `max_chained_roles` says how many roles may run one after another with no
// human step between them. E24 item 1 fixes what counts: a run is chained
// when it is dispatched for work that a previous run's outcome created. Work
// created by a fixture or a person, the repair of a failed run and a Resume
// are not chained, and a run that is not chained starts a chain of one.
//
// With the default, 1, the first role after any human step runs, and work
// its outcome created waits at the boundary: the engine raises a decision on
// it, once, and dispatches it only when a person has answered. In slice 3 two
// outcomes create work: a nomination (the candidate's verification) and the
// integration of a committed plan (its stages' work).
//
// Not here: a limit above 1. Raising `max_chained_roles` widens what the
// engine may do unasked and takes the `policy_widening` route (row M49,
// slice 5); see COVERAGE.md.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertWorkHistory } from './harness/invariants.mjs';
import { addGitProject, addItem, addStagedProject, permittedEdit, roleThat, runToEnd, waitForCandidates, writePlan } from './harness/gitruns.mjs';
import { assertCommitted, getPolicy, workItemsOf } from './harness/journal.mjs';
import { addWork, answerDecision, decisionsAbout, resumeWork, runsOf, scriptedEngine, stopRun, tick, tickUntil, waitForRun, waitForRunState, waitForWork, workItem } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const ticks = async (fx, project, n = 2) => {
  for (let i = 0; i < n; i++) await tick(fx.engine, project);
};
const launchesOf = (fx, item) => fx.scripted.launches({ work_item: item }).length;
const boundaryDecisions = (fx, item) => decisionsAbout(fx.home, item, 'blocker');

// A T2 project whose one stage has been built and nominated: the candidate's
// verification work now exists, created by the Builder run's outcome.
async function nominatedStage(t) {
  const fx = await scriptedEngine(t);
  fx.scripted.defaultScript(script.complete());
  const { project, items } = await addStagedProject(fx, { tier: 'T2' });
  fx.scripted.script(items[0], [roleThat([permittedEdit()])]);
  const run = await runToEnd(fx, project.id, items[0]);
  assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true });
  const [candidate] = await waitForCandidates(fx, project.id);
  const verification = workItemsOf(fx.home, project.id).find((work) => work.kind === 'verification' && work.subject?.candidate === candidate.id);
  assert.ok(verification, "the fixture is live: the candidate's verification work exists");
  return { fx, project, built: items[0], verification: verification.id };
}

// The item waits at the chaining boundary: eligible, never launched, with one
// open blocker that names it and offers to continue or to cancel.
function assertAtBoundary(fx, item, what) {
  const row = workItem(fx.home, item);
  assert.equal(row.status, 'eligible', `${what}: the work stays eligible; it is not parked, it waits for a person`);
  assert.deepEqual([runsOf(fx.home, item).length, launchesOf(fx, item)], [0, 0], `${what}: it was not dispatched and no role was launched for it`);
  const decisions = boundaryDecisions(fx, item);
  assert.equal(decisions.length, 1, `${what}: one decision was raised on it, however many ticks ran`);
  const [decision] = decisions;
  assert.deepEqual([decision.status, decision.subject_type, decision.subject_id], ['open', 'work_item', item], `${what}: the next step is a decision about that work`);
  assert.deepEqual(JSON.parse(decision.options).map((o) => o.key).sort(), ['cancel', 'continue'], `${what}: it offers to continue or to cancel`);
  assert.ok(JSON.parse(decision.blocked_while_open).work_items.includes(item), `${what}: the decision blocks the work while it is open`);
  assert.equal(JSON.parse(row.blocker).reason, 'max_chained_roles', `${what}: the work names its cause`);
  assert.equal(JSON.parse(row.blocker).decision, decision.id);
  return decision;
}

describe('M12 chaining stops at max_chained_roles', () => {
  test("work that a run's outcome created is not launched without a human step: the next step is a decision, asked once, while another project's work progresses; once a person continues, it is launched once", async (t) => {
    const { fx, project, built, verification } = await nominatedStage(t);
    assert.equal((await getPolicy(fx.engine, project.id)).effective.max_chained_roles, 1, 'the fixture is live: the default limit is one role');
    const other = await addGitProject(fx);
    const otherItem = await addItem(fx, other.id, 'verification');

    await ticks(fx, project.id, 3);
    const decision = assertAtBoundary(fx, verification, 'after three ticks');
    await waitForWork(fx.home, otherItem, 'complete');
    assert.equal(launchesOf(fx, otherItem), 1, "the other project's eligible work was launched meanwhile");

    // A restart does not ask the question again, and launches nothing.
    await fx.engine.kill();
    await fx.start();
    await ticks(fx, project.id);
    assert.equal(assertAtBoundary(fx, verification, 'after a restart').id, decision.id);

    // The human step.
    await answerDecision(fx.engine, project.id, decision.id, 'continue');
    assert.equal(launchesOf(fx, verification), 0, 'the answer launches nothing by itself: the scheduler dispatches');
    await tickUntil(fx.engine, project.id, () => workItem(fx.home, verification).status === 'complete', { max: 6, what: 'the verification to complete' });
    assert.deepEqual([runsOf(fx.home, verification).length, launchesOf(fx, verification)], [1, 1], 'it was dispatched and launched once');
    assert.equal(workItem(fx.home, built).status, 'verifying', "the verification's completion does not complete the stage's work: that is its stage gate's (row M44), and this fixture declares no check");
    assert.equal(boundaryDecisions(fx, verification).length, 1, 'and no second decision was raised');
    withStore(fx.home, (db) => assertWorkHistory(db, verification));
  });

  test('cancel at the boundary cancels the work without a launch', async (t) => {
    const { fx, project, built, verification } = await nominatedStage(t);
    await ticks(fx, project.id);
    const decision = assertAtBoundary(fx, verification, 'at the boundary');
    await answerDecision(fx.engine, project.id, decision.id, 'cancel');
    await ticks(fx, project.id);
    assert.deepEqual([workItem(fx.home, verification).status, runsOf(fx.home, verification).length, launchesOf(fx, verification)], ['cancelled', 0, 0]);
    assert.equal(workItem(fx.home, built).status, 'verifying', 'work whose verification was cancelled is not complete');
    withStore(fx.home, (db) => assertWorkHistory(db, verification));
  });

  test("the work a committed plan registers is work an Architect's run created: its stages are not built without a human step", async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(roleThat([permittedEdit()]));
    const project = await addGitProject(fx);
    const replan = await addItem(fx, project.id, 'replan');
    fx.scripted.script(replan, [roleThat([writePlan(2, [{ number: 1, goal: 'the only stage' }])])]);
    await runToEnd(fx, project.id, replan);
    const stage = workItemsOf(fx.home, project.id).find((work) => work.kind === 'stage_build');
    assert.ok(stage, 'the fixture is live: the plan registered its stage\'s work');
    await ticks(fx, project.id, 3);
    const decision = assertAtBoundary(fx, stage.id, 'after three ticks');
    await answerDecision(fx.engine, project.id, decision.id, 'continue');
    const run = await runToEnd(fx, project.id, stage.id);
    assert.equal(run.outcome, 'completed');
    assert.equal(launchesOf(fx, stage.id), 1);
  });
});

describe('M12 what is not a chain', () => {
  test("work a fixture created, the repair of a failed run and a Resume are dispatched without a human step, also right after another run, and also while chained work waits at its boundary", async (t) => {
    const { fx, project, verification } = await nominatedStage(t);
    await ticks(fx, project.id);
    assertAtBoundary(fx, verification, 'the chained work');

    // Work created by a fixture, dispatched right after the Builder's run: not chained.
    const plain = await addWork(fx.engine, project.id, 'review');
    await tickUntil(fx.engine, project.id, () => workItem(fx.home, plain).status === 'complete', { max: 6, what: 'the fixture-created work to complete' });
    assert.deepEqual([launchesOf(fx, plain), boundaryDecisions(fx, plain).length], [1, 0], 'launched, with no decision');

    // The repair of a failed run: not chained.
    const repaired = await addWork(fx.engine, project.id, 'review');
    fx.scripted.script(repaired, [script.crash(), script.complete()]);
    await tickUntil(fx.engine, project.id, () => workItem(fx.home, repaired).status === 'complete', { max: 8, what: 'the repaired work to complete' });
    assert.deepEqual([runsOf(fx.home, repaired).map((r) => r.outcome), boundaryDecisions(fx, repaired).length], [['failed', 'completed'], 0], 'the repair run was launched with no decision');

    // A Resume: not chained.
    const resumed = await addWork(fx.engine, project.id, 'review');
    fx.scripted.script(resumed, [script.hold('gate'), script.complete()]);
    await tick(fx.engine, project.id);
    const first = await waitForRun(fx.home, resumed, { state: 'executing' });
    await fx.scripted.waitForHolding({ work_item: resumed });
    await stopRun(fx.engine, project.id, first.id);
    await waitForRunState(fx.home, first.id, 'ended');
    await waitForWork(fx.home, resumed, 'held');
    await resumeWork(fx.engine, project.id, resumed);
    await tickUntil(fx.engine, project.id, () => workItem(fx.home, resumed).status === 'complete', { max: 6, what: 'the resumed work to complete' });
    assert.deepEqual([runsOf(fx.home, resumed).length, boundaryDecisions(fx, resumed).length], [2, 0], 'the resumed run was launched with no decision');

    // Through all of it the chained work stayed where it was, with its one decision.
    assertAtBoundary(fx, verification, 'the chained work, still');
  });
});
