// M437, the slice-37 review's S1 (kernel lane). M5 plan §3.7 M437 (c), (e);
// D6-X05 (two independent stages build at once; integration is serial);
// D6 §6.4; K2; D1 §7.3 (snapshot validation), §7.5 (integration by rebase);
// the driver's ruling (2026-10-14): a ref moved by an engine-journaled
// operation is never a ref_violation; SEAM.md §450.
//
// Two independent stages of one project build at once (K2: no project run
// count). Stage B's Builder finishes first; its run's snapshot is held at
// the barrier `snapshot.before_validate_outside` † (after the run's facts
// are read, before `validateOutside` checks the registered refs and the
// other managed checkouts). Meanwhile stage A's Builder finishes and A
// integrates, moving refs/heads/main through the journal. B is then
// released: the move it finds is the engine's own, journaled, so B is not a
// ref_violation: it completes, and it integrates by rebase onto A's
// integration. Order is read by ancestry and by event seq, never by time.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';

import { releaseBarrier, waitFor } from './harness/engine.mjs';
import { addGitProject, roleThat, roleThatHolds } from './harness/gitruns.mjs';
import { armBarrier, revisionsOf, stagesOf } from './harness/journal.mjs';
import { pauseProject, resumeProject, runsOf, scriptedEngine, tick, waitForWork, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { barrierWaiting } from './harness/session-lane.mjs';

const BARRIER = 'snapshot.before_validate_outside';
const isAncestor = (repo, a, b) => {
  try {
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('M437 (S1) a run validated after another run of its project integrated', () => {
  test('(S1) stage B held before its outside validation while stage A integrates through the journal: B is no ref_violation, completes and integrates by rebase onto A', async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    const project = await addGitProject(fx, { tier: 'T2' });
    // The project paused while its plan is installed and its work scripted
    // (K1: new eligible work requests a tick at once; SEAM.md §447).
    await pauseProject(fx.engine, project.id);
    const planned = await fx.engine.post('/v1/harness/fixtures/plan', { project: project.id, stages: [1, 2].map((n) => ({ number: n, goal: `stage ${n} of the fixture plan` })) });
    assert.equal(planned.status, 201, `plan fixture (body: ${planned.text})`);
    const [itemA, itemB] = planned.body.stages.map((stage) => stage.work_item);
    fx.scripted.script(itemA, [roleThatHolds([step.write('src/a.js', 'export const a = 1;\n')])]);
    fx.scripted.script(itemB, [roleThat([step.write('src/b.js', 'export const b = 2;\n')])]);
    await armBarrier(fx.engine, BARRIER, 'pause');
    await resumeProject(fx.engine, project.id);
    await tick(fx.engine, project.id);

    // B finishes and is held before its outside validation; A is still building.
    await waitFor(
      async () => {
        if (await barrierWaiting(fx, BARRIER)) return true;
        await tick(fx.engine, project.id, { rounds: 1 }).catch(() => null);
        return undefined;
      },
      { timeoutMs: 60_000, what: `stage B's run held at ${BARRIER} †` },
    );
    await fx.scripted.waitForHolding({ work_item: itemA });
    const [runB] = runsOf(fx.home, itemB);
    assert.ok(runB && runB.state !== 'ended', `the fixture is live: B's run is held, not ended (${JSON.stringify(runB)})`);

    // A finishes and integrates: refs/heads/main moves through the journal.
    fx.scripted.release(itemA, 'gate');
    await waitForWork(fx.home, itemA, 'integrated', { timeoutMs: 60_000 }).catch(() => null);
    const stageA = () => stagesOf(fx.home, project.id).find((s) => s.work_item === itemA);
    await waitFor(() => stageA()?.integrated_revision ?? undefined, { timeoutMs: 60_000, what: 'stage A integrated while B is held' });
    const aRevision = stageA().integrated_revision;
    const [runA] = runsOf(fx.home, itemA);
    assert.ok(revisionsOf(fx.home, { run: runA.id }).some((r) => r.sha === aRevision), 'A\'s integration is the engine\'s, journaled');

    // B released: validated after A's move; no ref_violation.
    await releaseBarrier(fx.engine, BARRIER);
    const ended = await waitFor(
      async () => {
        const r = runsOf(fx.home, itemB).find((x) => x.state === 'ended');
        if (r) return r;
        await tick(fx.engine, project.id, { rounds: 1 }).catch(() => null);
        return undefined;
      },
      { timeoutMs: 60_000, what: 'B\'s run to end' },
    );
    assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], `B completes: a ref moved by the engine's journaled integration is no ref_violation (${ended.outcome} ${ended.reason_class} ${ended.reason_text})`);
    const stageB = await waitFor(() => stagesOf(fx.home, project.id).find((s) => s.work_item === itemB && s.integrated_revision) ?? undefined, { timeoutMs: 60_000, what: 'stage B integrated' });
    assert.ok(isAncestor(project.repo.path, aRevision, stageB.integrated_revision), 'B integrated by rebase onto A\'s integration');
    assert.ok(revisionsOf(fx.home, { run: ended.id }).some((r) => r.kind === 'engine_commit' && isAncestor(project.repo.path, r.sha, stageB.integrated_revision)), 'as an engine commit of B\'s run');
    assert.equal(runsOf(fx.home, itemB).length, 1, 'one run: B was not repaired or run again');
    assert.notEqual(workItem(fx.home, itemB).status, 'parked', 'and its work is not parked');
  });
});
