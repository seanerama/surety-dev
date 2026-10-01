// M05, the dispatch case (slice 2). Plan §3.1 M05; D1 §§1.4, 6.4; build spec
// §6 correction 19; SEAM.md §§4, 5. A failing migration, or a changed
// checksum on an applied one, keeps the engine restricted, and a restricted
// engine dispatches nothing: eligible work stays where it is, no run is
// created, no role is launched. A correct restart then dispatches it.
// Slice 1 pinned that the scheduler never starts; this pins it with work
// that is ready to go.

import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { ENGINE_MIGRATIONS } from './harness/engine.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { addProject, addWork, countOf, runsOf, scriptedEngine, tick, waitForWork, workItem } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

// A home whose engine reads its migrations from a test-owned copy of the
// engine's own, with one project and one eligible item, and no engine running.
async function homeWithReadyWork(t) {
  const fx = await scriptedEngine(t, { start: false });
  const migrations = join(fx.root, 'migrations');
  mkdirSync(migrations);
  for (const name of readdirSync(ENGINE_MIGRATIONS).filter((n) => MIGRATION_FILE.test(n))) copyFileSync(join(ENGINE_MIGRATIONS, name), join(migrations, name));
  const start = (opts = {}) => fx.start({ ...opts, args: ['--harness-migrations', migrations] });
  const engine = await start();
  fx.scripted.defaultScript(script.complete());
  const project = (await addProject(fx)).id;
  // Paused while the work is installed, so that it is still eligible when the engine stops.
  await engine.post(`/v1/projects/${project}/pause`, {});
  const item = await addWork(engine, project, 'verification');
  await engine.post(`/v1/projects/${project}/resume`, {});
  await engine.stop();
  assert.equal(workItem(fx.home, item).status, 'eligible');
  assert.equal(runsOf(fx.home, item).length, 0);
  return { fx, migrations, start, project, item };
}

async function assertNothingDispatched(fx, engine, project, item, code) {
  const info = await engine.engineInfo();
  assert.equal(info.mode, 'restricted');
  assert.deepEqual([info.startup.failed?.step, info.startup.failed?.code], ['store', code]);
  assertRefused(await engine.post(`/v1/projects/${project}/tick`, {}), 503, 'engine_starting', 'a tick request while restricted');
  await sleep(2000);
  assert.equal(runsOf(fx.home, item).length, 0, 'no run was created for the eligible work');
  assert.equal(countOf(fx.home, 'runs'), 0);
  assert.equal(workItem(fx.home, item).status, 'eligible', 'the work is untouched');
  assert.equal(fx.scripted.launches().length, 0, 'no role was launched');
  assert.equal(engine.isRunning(), true, 'the engine stays up, restricted, with its failure readable');
}

describe('M05 a failed startup dispatches nothing', () => {
  test('a failing migration prevents dispatch of eligible work, and a correct restart dispatches it', async (t) => {
    const { fx, migrations, start, project, item } = await homeWithReadyWork(t);
    const broken = join(migrations, '9001_fixture_broken.sql');
    writeFileSync(broken, 'CREATE TABLE fixture_partial (id INTEGER PRIMARY KEY);\nTHIS IS NOT VALID SQL;\n');
    const restricted = await start({ until: 'failed' });
    await assertNothingDispatched(fx, restricted, project, item, 'migration_failed');
    await restricted.kill();

    rmSync(broken);
    const engine = await start();
    await tick(engine, project);
    await waitForWork(fx.home, item, 'complete');
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1);
  });

  test('a changed checksum on an applied migration prevents dispatch of eligible work', async (t) => {
    const { fx, migrations, start, project, item } = await homeWithReadyWork(t);
    const applied = readdirSync(migrations).filter((n) => MIGRATION_FILE.test(n)).sort()[0];
    const original = readFileSync(join(migrations, applied));
    appendFileSync(join(migrations, applied), '\n-- edited after it was applied\n');
    const restricted = await start({ until: 'failed' });
    await assertNothingDispatched(fx, restricted, project, item, 'migration_checksum_mismatch');
    await restricted.kill();

    writeFileSync(join(migrations, applied), original);
    const engine = await start();
    await tick(engine, project);
    await waitForWork(fx.home, item, 'complete');
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1);
  });
});
