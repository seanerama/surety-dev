// M67, second group: the engine under the power-loss shim (slice 4). Plan
// §3.6 M67; D1 §18 ("power loss means a filesystem-level simulation that
// discards unsynced writes"), D1-23, §§6.1, 6.5, 14.1, 16.2; E31 item 5;
// SEAM.md §60.
//
// Power is cut at the three boundaries the Plan names: after an effect's
// intent is committed, after a record is published, and after an effect was
// applied and before its receipt. A cut kills the engine and everything it
// started, and puts every file under the engine home and the repository
// back to what was last synced (harness/powerloss.mjs; M67-power-loss-shim-
// is-faithful.test.mjs shows that the shim tells the two apart). The engine
// is then started again, without the shim, on what is left.
//
// This is not a process kill: rows M18 and M33 kill the engine at the same
// kinds of boundary and keep everything the dead process had written. Here
// only what was synced is kept. The two results are reported separately.
// SEAM.md §60 says what a pass here does and does not show.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { sha256Hex } from './harness/engine.mjs';
import { PERMITTED_EDIT, addGitProject, addItem, permittedEdit, roleThat } from './harness/gitruns.mjs';
import { assertOperations, eventsOfType, journalBarrier, operationsOf, registryOf, revisionsOf } from './harness/journal.mjs';
import { PowerLoss } from './harness/powerloss.mjs';
import { assertRecordHolds, assertRecordsSound, recordFile, recordsOf } from './harness/records.mjs';
import { commitsNaming, fileAt, refOid, worktreeList } from './harness/repos.mjs';
import { assertRunEnded, requestTick, resumeWork, runsOf, scriptedEngine, tickUntil, waitForRunState, waitForWork, workItem } from './harness/runs.mjs';
import { RESULT_LINE, script, step } from './harness/scripted.mjs';

const MAIN = 'refs/heads/main';

// A project with one item of `kind`, set up by an engine that is then
// stopped. Everything on disk at that point is durable. The engine is
// started again under the shim with `barrier` armed, ticked, and waited for
// at the barrier: `cut()` cuts power there.
async function atBarrierUnderShim(t, { kind, barrier, role }) {
  const fx = await scriptedEngine(t);
  const project = await addGitProject(fx);
  const item = await addItem(fx, project.id, kind);
  fx.scripted.script(item, [role]);
  fx.scripted.defaultScript(script.complete());
  await fx.engine.stop();

  const power = new PowerLoss(join(fx.root, 'powerloss'), [fx.home, project.repo.path]);
  power.baseline();
  const engine = await fx.start({ env: power.env(), barriers: [`${barrier}=pause`] });
  await requestTick(engine, project.id);
  await engine.waitUntil(`barrier:${barrier}`, { timeoutMs: 60_000 });
  assert.ok(power.loaded().some((p) => p.pid === engine.pid), 'the shim is loaded into the engine');
  const cut = async () => {
    const changed = await power.cut({ pids: [engine.pid] });
    fx.scripted.killStrays();
    return changed;
  };
  return { fx, project, item, power, cut };
}

describe('M67 power is cut and only what was synced is kept', () => {
  test('after an intent commit: the intent is there on restart, its effect is not, and the work goes on', async (t) => {
    const barrier = journalBarrier('worktree_add', 'intent_committed');
    const { fx, project, item, cut } = await atBarrierUnderShim(t, { kind: 'verification', barrier, role: script.complete() });
    await cut();

    // What survived, before any engine looks at it.
    const [run] = runsOf(fx.home, item);
    assert.ok(run, 'the dispatch survived the cut');
    const [intent, ...more] = operationsOf(fx.home, { project: project.id, journalKind: 'worktree_add' });
    assert.ok(intent && more.length === 0, 'the operation whose intent was committed is in the store');
    assert.deepEqual(intent.events.map((e) => e.kind), ['intended'], 'with its intent and nothing after it');
    assert.equal(worktreeList(project.repo.path).length, 1, 'and no worktree: the effect had not been made');

    await fx.start();
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'recovered' });
    assert.equal(fx.scripted.launches().length, 0, 'recovery launched nothing');
    assertOperations(fx.home, { project: project.id });
    await waitForWork(fx.home, item, 'held');
    await resumeWork(fx.engine, project.id, item);
    await tickUntil(fx.engine, project.id, () => workItem(fx.home, item).status === 'complete', { what: 'the resumed work to complete' });
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1, 'one launch in all');
  });

  test('after a record publication: the published record is whole on restart and is served', async (t) => {
    const said = 'what the role wrote before the power went\n';
    const output = `${said}${RESULT_LINE}\n`;
    const { fx, project, item, cut } = await atBarrierUnderShim(t, { kind: 'verification', barrier: 'stream.published', role: script.complete([step.stdout(said)]) });
    await cut();

    const [record, ...more] = recordsOf(fx.home, project.id, 'transcript');
    assert.ok(record && more.length === 0, 'the transcript record survived the cut');
    assert.equal(record.published, 1, 'its publication was committed before the cut');
    assert.equal(sha256Hex(readFileSync(recordFile(fx.home, record))), sha256Hex(output), 'and its bytes are whole: they were synced before it was published');
    assertRecordsSound(fx.home, project.id);

    const engine = await fx.start();
    await waitForRunState(fx.home, runsOf(fx.home, item)[0].id, 'ended');
    await assertRecordHolds(engine, project.id, record.id, { kind: 'transcript', content: output });
    assert.deepEqual(eventsOfType(fx.home, 'record.missing'), [], 'recovery found no record missing');
    assertRecordsSound(fx.home, project.id);
  });

  test('after an effect was applied and before its receipt: recovery finds what git holds, and the integration is made exactly once', async (t) => {
    const barrier = journalBarrier('ref_update', 'effect_applied');
    const { fx, project, item, power, cut } = await atBarrierUnderShim(t, { kind: 'fix', barrier, role: roleThat([permittedEdit()]) });
    assert.ok(power.loaded().some((p) => p.comm === 'git'), 'the engine\'s git ran under the shim');
    await cut();

    const [run] = runsOf(fx.home, item);
    const [commit, ...others] = revisionsOf(fx.home, { run: run.id });
    assert.ok(commit && others.length === 0, 'the run\'s commit is recorded');
    const [move] = operationsOf(fx.home, { run: run.id, journalKind: 'ref_update' });
    assert.equal(move?.events[0]?.kind, 'intended', 'the integration\'s intent is in the store: it was durable before the effect was made');

    await fx.start();
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'recovered' });
    await waitForWork(fx.home, item, 'integrated');
    const repo = project.repo.path;
    assert.equal(refOid(repo, MAIN), commit.sha, 'the integration branch is at the run\'s commit');
    assert.equal(registryOf(fx.home, project.id)[MAIN].expected_oid, commit.sha, 'and the registry expects it there');
    assert.equal(fileAt(repo, commit.sha, PERMITTED_EDIT.path), PERMITTED_EDIT.content, 'the commit and what it holds are readable');
    assert.equal(commitsNaming(repo, run.id).length, 1, 'one commit names the run');
    const moves = operationsOf(fx.home, { run: run.id, journalKind: 'ref_update' });
    assert.deepEqual(moves.map((op) => [op.id, op.status, op.finalized]), [[move.id, 'succeeded', true]], 'the one ref update is finalized: recovered, not made a second time');
    assertOperations(fx.home, { project: project.id });
  });
});
