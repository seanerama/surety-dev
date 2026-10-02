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
import { addGitProject } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { addProject, addWork, assertRunEnded, runsOf, scriptedEngine, tick, tickUntil, waitForQuarantine, waitForRun, waitForRunState, workItem } from './harness/runs.mjs';
import { BOUNDARY, script } from './harness/scripted.mjs';
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
    assert.deepEqual(
      { subject: [blocker.subject_type, blocker.subject_id], status: blocker.manifest.subject_status, cause: blocker.manifest.cause, quarantined: blocker.manifest.quarantined, continuation: blocker.manifest.continuation },
      { subject: ['work_item', item], status: 'parked', cause: 'repair_attempts_max', quarantined: false, continuation: 'eligible' },
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
});
