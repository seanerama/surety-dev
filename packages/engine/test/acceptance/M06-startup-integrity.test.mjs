// M06, the startup `integrity` step shown to do real work (slice 3; an
// obligation recorded after the slice-1 review, E23 item 1). Plan §3.1 M06
// ("performs recovery before dispatch") and §3.3 M24; D1 §§1.4, 7.6, 16.1;
// SEAM.md §§4, 32.
//
// Slice 1 could only show that the step's name is listed. Here a registered
// project's repository is changed while the engine is down: its integration
// branch is moved by someone else. The restart's integrity step finds that
// before the engine reaches full mode, and nothing of the project is
// dispatched afterwards, while a project whose repository is as expected is
// dispatched as usual.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { addGitProject, addItem, permittedEdit, roleThat, runToEnd } from './harness/gitruns.mjs';
import { eventsOfType, outOfBand, registryOf } from './harness/journal.mjs';
import { commitOnRef, refOid } from './harness/repos.mjs';
import { runsOf, scriptedEngine, tick, workItem } from './harness/runs.mjs';

const MAIN = 'refs/heads/main';

describe('M06 the integrity step of a restart reads every registered repository before full mode', () => {
  test('a branch moved while the engine was down is found by the integrity step, before full mode and before any dispatch', async (t) => {
    const fx = await scriptedEngine(t);
    const changed = await addGitProject(fx, { name: 'changed-while-down' });
    const sound = await addGitProject(fx, { name: 'as-expected' });
    const itemChanged = await addItem(fx, changed.id, 'fix');
    const itemSound = await addItem(fx, sound.id, 'fix');
    fx.scripted.defaultScript(roleThat([permittedEdit()]));
    await fx.engine.stop();

    const stray = commitOnRef(changed.repo.path, MAIN, { 'stray.txt': 'pushed while the engine was down\n' });
    const engine = await fx.start();
    const info = await engine.engineInfo();
    assert.equal(info.mode, 'full', 'an out-of-band change in one project does not keep the engine restricted');
    assert.equal(info.startup.failed, null);
    assert.ok(info.startup.completed.indexOf('integrity') >= 0 && info.startup.completed.indexOf('integrity') < info.startup.completed.indexOf('full'), 'integrity completed before full mode');

    // The observation was made by that step: it is on record before this incarnation lifted to full mode.
    const observed = outOfBand(fx.home, changed.id);
    assert.equal(observed.length, 1, 'the moved branch was observed without any tick');
    assert.deepEqual([observed[0].subject_kind, observed[0].ref_name, observed[0].expected, observed[0].found], ['ref', MAIN, changed.base, stray]);
    const [found] = eventsOfType(fx.home, 'repo.out_of_band');
    const lifted = eventsOfType(fx.home, 'engine.mode_changed').at(-1);
    assert.ok(found.seq < lifted.seq, `the observation (seq ${found.seq}) precedes this incarnation's lift to full mode (seq ${lifted.seq})`);
    assert.deepEqual(outOfBand(fx.home, sound.id), [], 'the other project, whose repository is as expected, has no observation');

    // Before any dispatch: the changed project is never started on the moved branch; the other runs.
    const run = await runToEnd(fx, [sound.id, changed.id], itemSound);
    assert.equal(run.outcome, 'completed');
    for (let i = 0; i < 2; i++) await tick(fx.engine, sound.id);
    assert.equal(runsOf(fx.home, itemChanged).length, 0, 'nothing of the changed project is dispatched');
    assert.equal(workItem(fx.home, itemChanged).status, 'eligible');
    assert.equal(registryOf(fx.home, changed.id)[MAIN].expected_oid, changed.base, 'the registry still expects what it expected');
    assert.equal(refOid(changed.repo.path, MAIN), stray, 'and the branch is where it was found');
    assert.equal(outOfBand(fx.home, changed.id).length, 1, 'the ticks did not record it a second time');
  });
});
