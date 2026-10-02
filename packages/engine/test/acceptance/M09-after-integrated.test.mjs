// M09, what follows `integrated` (slice 3, second session). Plan §3.2 M09
// ("For every enabled M1 work kind, run its legal path ... Legal paths reach
// their intended outcome without fictitious integration"); D1 §§4.3, 7.7,
// 7.8, A.5; F §5.6 (verification cadence), E11 (a candidate is a revision
// nominated for verification); build spec §6 correction 11; SEAM.md §40;
// ../contract/work-items.json.
//
// The first session took the four integrating kinds as far as `integrated`.
// Their paths go on:
//
//   replan, assessment   … integrated → complete. The Architect's work is
//                        complete once its artifacts are integrated (and, for
//                        a plan, registered: row M26).
//   stage_build, fix     … integrated → verifying → complete. The Builder's
//                        work is verified as part of a candidate. It becomes
//                        `verifying` when a candidate that holds it is
//                        nominated, and `complete` when that candidate's
//                        verification work is complete.
//
// Nothing here asserts a gate. M1's `stage` gate arrives in slice 5; from
// then on a stage's work is complete only when its gate is satisfied, and
// these cases change with it (COVERAGE.md). What slice 3 pins is the path:
// no Builder's work is complete without its candidate's verification, and
// nothing is integrated or verified that was not.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertWorkHistory } from './harness/invariants.mjs';
import { addGitProject, addItem, addStagedProject, permittedEdit, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { VALIDATION, assertCommitted, candidatesOf, workItemsOf } from './harness/journal.mjs';
import { answerDecision, assertRunEnded, decisionsAbout, installPlan, runsOf, scriptedEngine, tick, tickUntil, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { WORK } from './harness/transitions.mjs';

const pathOf = (fx, item) => withStore(fx.home, (db) => assertWorkHistory(db, item));
const ticks = async (fx, project, n = 2) => {
  for (let i = 0; i < n; i++) await tick(fx.engine, project);
};

// The candidate's verification work, let through the chain boundary by a
// person and run to its end. Returns its work item id.
async function verify(fx, project, candidate, { first = script.complete() } = {}) {
  const verification = workItemsOf(fx.home, project.id).find((work) => work.kind === 'verification' && work.subject?.candidate === candidate.id);
  assert.ok(verification, 'the candidate has verification work');
  fx.scripted.script(verification.id, [first, script.complete()]);
  const [boundary] = await tickUntil(
    fx.engine,
    project.id,
    () => {
      const open = decisionsAbout(fx.home, verification.id, 'blocker').filter((d) => d.status === 'open');
      return open.length > 0 ? open : undefined;
    },
    { max: 4, what: 'the decision at the chain boundary' },
  );
  await answerDecision(fx.engine, project.id, boundary.id, 'continue');
  await tickUntil(fx.engine, project.id, () => workItem(fx.home, verification.id).status === 'complete', { max: 8, what: "the candidate's verification to complete" });
  return verification.id;
}

describe("M09 the Architect's kinds are complete once their artifacts are integrated", () => {
  for (const kind of VALIDATION.roles.architect.kinds) {
    test(`a ${kind} item runs its whole path: ${WORK.kinds[kind].path.join(' → ')}`, async (t) => {
      const fx = await scriptedEngine(t);
      const project = await addGitProject(fx);
      const item = await addItem(fx, project.id, kind);
      fx.scripted.script(item, [roleThat([step.write('.surety/adrs/0001-a-decision.md', `# decided in a ${kind} run\n`)])]);
      const run = await runToEnd(fx, project.id, item);
      assertCommitted(fx, run.id, { kind: 'intent', parent: project.base, integrated: true, changes: { '.surety/adrs/0001-a-decision.md': 'A' } });
      assert.deepEqual(pathOf(fx, item), WORK.kinds[kind].path, 'the item ran its path, to complete, with nothing between integrated and complete');
      assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', launched: true });
      await ticks(fx, project.id);
      assert.deepEqual([runsOf(fx.home, item).length, workItemsOf(fx.home, project.id).length, candidatesOf(fx.home, project.id).length], [1, 1, 0], 'nothing more follows: no second run, no work created, nothing nominated');
    });
  }
});

describe("M09 the Builder's kinds are complete once their candidate is verified", () => {
  test(`a stage_build item runs its whole path: ${WORK.kinds.stage_build.path.join(' → ')}`, async (t) => {
    const fx = await scriptedEngine(t);
    const { project, items } = await addStagedProject(fx, { tier: 'T2' });
    fx.scripted.script(items[0], [roleThat([permittedEdit()])]);
    const run = await runToEnd(fx, project.id, items[0]);
    assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true });
    const [candidate] = await waitForCandidates(fx, project.id);
    assert.deepEqual(pathOf(fx, items[0]), WORK.kinds.stage_build.path.slice(0, -1), 'integrated, then verifying once its candidate is nominated; not complete');
    await ticks(fx, project.id);
    assert.equal(workItem(fx.home, items[0]).status, 'verifying', 'the work is not complete while its candidate is not verified');

    const verification = await verify(fx, project, candidate);
    assert.deepEqual(pathOf(fx, items[0]), WORK.kinds.stage_build.path, 'complete once the candidate\'s verification is complete');
    assert.deepEqual(pathOf(fx, verification), WORK.kinds.verification.path);
    assert.equal(runsOf(fx.home, items[0]).length, 1, 'the Builder ran once: verification is the Verifier\'s work, in a run of its own');
    assert.deepEqual(runsOf(fx.home, verification).map((r) => r.role), ['verifier']);
  });

  test("a verification that fails completes nothing: the Builder's work stays verifying until a repaired verification completes", async (t) => {
    const fx = await scriptedEngine(t);
    const { project, items } = await addStagedProject(fx, { tier: 'T2' });
    fx.scripted.script(items[0], [roleThat([permittedEdit()])]);
    await runToEnd(fx, project.id, items[0]);
    const [candidate] = await waitForCandidates(fx, project.id);
    // The Verifier's first run sends a result that is not valid; its repair completes.
    const verification = await verify(fx, project, candidate, { first: script.invalid({ verdict: 'not a result the schema knows' }) });
    const runs = runsOf(fx.home, verification);
    assert.deepEqual(runs.map((r) => [r.outcome, r.reason_class]), [['failed', 'invalid_result'], ['completed', 'none']], 'the verification failed once and was repaired');
    const events = withStore(fx.home, (db) => db.prepare(`SELECT "seq", "type", json_extract("subject", '$.work_item') AS "item", json_extract("subject", '$.run') AS "run" FROM "events" ORDER BY "seq"`).all());
    const builtComplete = events.find((e) => e.type === 'work.complete' && e.item === items[0]);
    const failedEnd = events.find((e) => e.type === 'run.ended' && e.run === runs[0].id);
    // The first thing the log says of the repairing run: it began after the failed one was over.
    const repairBegan = events.find((e) => e.run === runs[1].id);
    assert.ok(builtComplete && failedEnd && repairBegan);
    assert.ok(repairBegan.seq > failedEnd.seq, 'the repair began after the failed verification had ended');
    assert.ok(builtComplete.seq > repairBegan.seq, "the Builder's work was still verifying when the failed verification was over and its repair began: a verification that fails completes nothing");
    assert.equal(workItem(fx.home, items[0]).status, 'complete');
    assert.deepEqual(pathOf(fx, items[0]), WORK.kinds.stage_build.path);
  });

  test(`a fix item runs its whole path, ${WORK.kinds.fix.path.join(' → ')}: it stays integrated until a candidate that holds it is nominated, and is verified with that candidate`, async (t) => {
    const fx = await scriptedEngine(t);
    // T1: nothing is nominated until the Builder asks.
    const project = await addGitProject(fx, { tier: 'T1' });
    const fix = await addItem(fx, project.id, 'fix');
    fx.scripted.script(fix, [roleThat([step.write('src/fixed.js', 'export const fixed = true;\n')])]);
    const fixRun = await runToEnd(fx, project.id, fix);
    const fixed = assertCommitted(fx, fixRun.id, { kind: 'engine_commit', parent: project.base, integrated: true });
    await ticks(fx, project.id);
    assert.deepEqual(pathOf(fx, fix), WORK.kinds.fix.path.slice(0, 5), 'integrated, and not being verified: no candidate holds it yet');

    // A stage is then built on top of it, and the Builder asks for a nomination.
    const plan = await installPlan(fx.engine, project.id, [{ number: 1, goal: 'a stage built on the fix' }]);
    const stage = plan.stages[0].work_item;
    fx.scripted.script(stage, [roleThat([permittedEdit()], { nominate: true })]);
    const stageRun = await runToEnd(fx, project.id, stage);
    assertCommitted(fx, stageRun.id, { kind: 'engine_commit', parent: fixed.sha, integrated: true });
    const [candidate] = await waitForCandidates(fx, project.id);
    assert.deepEqual([pathOf(fx, fix), workItem(fx.home, stage).status], [WORK.kinds.fix.path.slice(0, -1), 'verifying'], 'the candidate holds both: both are being verified');

    await verify(fx, project, candidate);
    assert.deepEqual(pathOf(fx, fix), WORK.kinds.fix.path, 'the fix is complete with its candidate\'s verification');
    assert.deepEqual(pathOf(fx, stage), WORK.kinds.stage_build.path);
  });

  test('work integrated after a nomination is not held by that candidate: it stays integrated when the candidate is verified', async (t) => {
    const fx = await scriptedEngine(t);
    const { project, items } = await addStagedProject(fx, { tier: 'T2' });
    fx.scripted.script(items[0], [roleThat([permittedEdit()])]);
    await runToEnd(fx, project.id, items[0]);
    const [candidate] = await waitForCandidates(fx, project.id);
    // A source change after the nomination.
    const fix = await addItem(fx, project.id, 'fix');
    fx.scripted.script(fix, [roleThat([step.write('src/fixed.js', 'export const fixed = true;\n')])]);
    const fixRun = await runToEnd(fx, project.id, fix);
    assertCommitted(fx, fixRun.id, { kind: 'engine_commit', parent: candidate.revision, integrated: true });

    await verify(fx, project, candidate);
    assert.equal(workItem(fx.home, items[0]).status, 'complete', "the stage's work is complete: its candidate is verified");
    assert.deepEqual(pathOf(fx, fix), WORK.kinds.fix.path.slice(0, 5), 'the later fix is integrated and no more: the candidate that was verified does not hold it');
    assert.equal(candidatesOf(fx.home, project.id).length, 1, 'and nothing nominated it: a fix is no cadence point at T2');
  });
});
