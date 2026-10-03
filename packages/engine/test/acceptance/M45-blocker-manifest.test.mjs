// M45, the `blocker` manifest (slice 5). Plan §3.5 M45; build spec §6
// correction 22; RN §3 B12; Review B12; D1 §§10.5, 10.6; SEAM.md §§76, 77.
//
// A blocker's preview binds more than "the subject is parked": the cause,
// the evidence, the quarantine condition and the continuation an answer
// would allow. A subject can stay parked while its cause changes; the old
// preview is then stale although the action is still on offer. A valid
// answer resumes the bound continuation and nothing else: it launches
// nothing by itself, completes nothing, and attests nothing about
// termination (an acknowledged quarantine stays a quarantine: row M16).
//
// Per the Plan: a positive answer, a changed dependency under which the
// action remains eligible, and the quarantine condition changing. A blocker
// has no effect of its own to hold before execution.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODES, answer, assertStaleAnswer, consume, decision, decisionsOn, nextGeneration, openDecision } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { addGitProject, addItem, permittedEdit, roleThat, runToEnd } from './harness/gitruns.mjs';
import { changePolicy, registryOf, revisionsOf } from './harness/journal.mjs';
import { addProject, addWork, assertRunEnded, runsOf, scriptedEngine, tick, tickUntil, waitForQuarantine, waitForRun, waitForRunState, workItem } from './harness/runs.mjs';
import { refOid } from './harness/repos.mjs';
import { BOUNDARY, script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

// Work parked at its repair limit (no repair is allowed, and its one run
// failed), with the blocker the engine raised about it.
async function parked(t) {
  const fx = await scriptedEngine(t);
  const project = (await addGitProject(fx)).id;
  await changePolicy(fx.engine, project, { repair_attempts_max: 0 });
  const item = await addWork(fx.engine, project, 'review');
  fx.scripted.script(item, [script.crash(), script.crash()]);
  await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'parked', { what: 'the work to be parked' });
  return { fx, project, item, blocker: await openDecision(fx, project, 'blocker', item) };
}

const launches = (fx, item) => fx.scripted.launches({ work_item: item }).length;

describe('M45 the blocker manifest', () => {
  test('a valid answer resumes the bound continuation and nothing else: retry makes the work eligible, launches nothing by itself, and completes nothing', async (t) => {
    const { fx, project, item, blocker } = await parked(t);
    // The continuation names the status a retry resumes to and the revision
    // the next run starts from: null, the integration branch's head, for work
    // that never checkpointed (M2 slice 2; SEAM.md §105 refines §77's string).
    assert.deepEqual(
      { subject: [blocker.subject_type, blocker.subject_id], status: blocker.manifest.subject_status, cause: blocker.manifest.cause, quarantined: blocker.manifest.quarantined, continuation: blocker.manifest.continuation },
      { subject: ['work_item', item], status: 'parked', cause: 'repair_attempts_max', quarantined: false, continuation: { status: 'eligible', from: null } },
      'the preview binds the subject\'s status, the cause, the quarantine condition and the continuation',
    );

    await consume(fx, project, blocker, 'retry');
    assert.deepEqual([workItem(fx.home, item).status, workItem(fx.home, item).blocker, launches(fx, item)], ['eligible', null, 1], 'the work is eligible again, and the answer launched nothing');

    // The scheduler dispatches it once more. It fails again: the answer bought no completion.
    await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'parked', { what: 'the retried work to be parked again' });
    assert.deepEqual([runsOf(fx.home, item).length, launches(fx, item)], [2, 2], 'one more run, and no more');
    const again = await openDecision(fx, project, 'blocker', item);
    assert.deepEqual([again.id !== blocker.id, decision(fx.home, blocker.id).status], [true, 'consumed'], 'the new blocker is a new question; the answered one stays consumed');
  });

  test('the subject stays parked and its cause changes: the old preview is stale, nothing is resumed, and the next generation binds the new cause', async (t) => {
    const { fx, project, item, blocker } = await parked(t);
    await fx.engine.stop();
    withStore(fx.home, (db) => db.prepare(`UPDATE "work_items" SET "blocker" = json_set("blocker", '$.reason', 'deadline') WHERE "id" = ?`).run(item), { readonly: false });
    await fx.start();

    await assertStaleAnswer(fx, project, blocker, 'retry');
    assert.deepEqual([workItem(fx.home, item).status, runsOf(fx.home, item).length], ['parked', 1], 'the work is still parked and was not run again');
    const next = await nextGeneration(fx, project, blocker, { changed: 'cause' });
    assert.deepEqual([next.manifest.cause, next.manifest.subject_status], ['deadline', 'parked']);
    await consume(fx, project, next, 'cancel');
    assert.equal(workItem(fx.home, item).status, 'cancelled', 'the current preview can be answered');
  });

  test('the quarantine a blocker is about clears by observation: an answer that carries the old preview is refused, and it is the observation, not an answer, that ended the run', async (t) => {
    const fx = await scriptedEngine(t, { config: { terminate_grace: 1, kill_grace: 1 } });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.complete()]);
    fx.scripted.boundary({ default: BOUNDARY.unknown });
    await tick(fx.engine, project);
    const run = await waitForRun(fx.home, item);
    await waitForQuarantine(fx.home, run.id);
    const blocker = await openDecision(fx, project, 'blocker', run.id);
    assert.deepEqual([blocker.subject_type, blocker.manifest.quarantined], ['run', true]);

    // The boundary can be read again and reports the domain empty.
    fx.scripted.boundary({ default: BOUNDARY.auto });
    await tick(fx.engine, project);
    await waitForRunState(fx.home, run.id, 'ended');
    assertRefused(await answer(fx.engine, project, blocker, 'acknowledge'), 409, [CODES.stale, CODES.invalidated], 'acknowledging a quarantine that has cleared');
    await tick(fx.engine, project);
    assert.deepEqual(decisionsOn(fx.home, 'blocker', run.id).map((row) => row.status), ['invalidated'], 'the question no longer applies: it is closed, and not asked again');
    assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none' });
  });

  // M2 slice 2, B1 (SEAM.md §105): the stored continuation of a parked item.
  test('the stored continuation changes while the subject stays parked: the old preview is stale, nothing is resumed, and the next generation binds the continuation as it now is', async (t) => {
    // A fix whose first run checkpoints (row M21) and whose continuation run
    // then crashes with no repair allowed: parked, with the checkpoint as the
    // revision its next run would start from.
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 0 });
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([step.write('src/part-one.js', 'export const one = 1;\n')], { checkpoint: true }), script.crash(), roleThat([permittedEdit()])]);
    await tickUntil(fx.engine, project.id, () => workItem(fx.home, item).status === 'parked', { what: 'the continuation run to fail and the work to be parked' });
    const checkpoint = revisionsOf(fx.home, { project: project.id }).find((row) => row.kind === 'checkpoint');
    assert.ok(checkpoint, 'the fixture is live: the first run checkpointed');
    assert.deepEqual([workItem(fx.home, item).continue_from, runsOf(fx.home, item).length], [checkpoint.sha, 2], 'the fixture is live: the parked work would resume from the checkpoint, after two runs');
    const blocker = await openDecision(fx, project.id, 'blocker', item);
    assert.deepEqual(blocker.manifest.continuation, { status: 'eligible', from: checkpoint.sha }, 'the preview binds the continuation: the status a retry resumes to, and the revision the next run starts from');

    // No engine path changes a parked item's stored continuation while it is
    // parked; the store does, with the engine stopped, as the case above
    // changes the cause (SEAM.md §65). Resuming from the integration branch
    // instead of the checkpoint is another consequence of the same answer.
    await fx.engine.stop();
    withStore(fx.home, (db) => db.prepare('UPDATE "work_items" SET "continue_from" = NULL WHERE "id" = ?').run(item), { readonly: false });
    await fx.start();

    await assertStaleAnswer(fx, project.id, blocker, 'retry');
    assert.deepEqual([workItem(fx.home, item).status, runsOf(fx.home, item).length], ['parked', 2], 'the work is still parked and was not run again');
    const next = await nextGeneration(fx, project.id, blocker, { changed: 'continuation' });
    assert.deepEqual([next.manifest.continuation, next.manifest.cause, next.manifest.subject_status], [{ status: 'eligible', from: null }, 'repair_attempts_max', 'parked'], 'the next preview says the work would resume from the integration branch, and binds the rest as before');

    // The current preview can be answered, and what follows is what it
    // showed: a run from the integration branch's head, which the case's own
    // policy change moved past `project.base` (SEAM.md §27; objection 001),
    // and not from the checkpoint.
    const head = refOid(project.repo.path, project.repo.ref);
    assert.deepEqual(
      [registryOf(fx.home, project.id)[project.repo.ref].expected_oid, runsOf(fx.home, item)[0].base_revision, head === checkpoint.sha],
      [head, head, false],
      "the fixture is live: the registry expects the head, the first run started from it, and it is not the checkpoint",
    );
    await consume(fx, project.id, next, 'retry');
    const resumed = await runToEnd(fx, project.id, item, { index: 2 });
    assert.equal(resumed.base_revision, head, "the retried run starts from the integration branch's head, as the answered preview said, not from the checkpoint");
  });
});
