// Developer tests for the launcher-exit tick (E79 item 2): when the launcher
// of a domain whose run is ending (closing, or quarantined) exits, the engine
// requests one tick, so that the domain is observed again now rather than at
// the next scheduled tick. A launcher of a run not ending asks for nothing;
// many exits in one turn of the event loop ask once. The runtime is a
// stand-in that counts tick requests; nothing is launched.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { Launcher } = await import(join(dist, 'invoke', 'choke.js'));
const { newHandle } = await import(join(dist, 'runtime.js'));

const CLAIM = { run: 'run_T', generation: 1, invocation: 'inv_T', project: 'prj_T', domain: 'dom_T', work_item: 'wi_T', work_kind: 'verification', role: 'verifier', base_revision: '0'.repeat(40) };
const turn = () => new Promise((r) => setImmediate(() => setImmediate(r)));

function standIn() {
  const ticks = { n: 0 };
  const launcher = new Launcher({ services: { requestTick: () => ticks.n++ } });
  return { launcher, ticks };
}

function launchWithExit() {
  let exit;
  const launcherExited = new Promise((r) => (exit = r));
  return { launch: { launcherExited }, exit };
}

test('the launcher of an ending run exits: one tick is requested', async () => {
  const { launcher, ticks } = standIn();
  const handle = newHandle(CLAIM);
  const { launch, exit } = launchWithExit();
  launcher.watchLauncherExit(handle, launch);
  handle.ending = true;
  exit();
  await turn();
  assert.equal(ticks.n, 1);
});

test('the launcher of a run that is not ending exits: no tick (its exit is the run\'s own path)', async () => {
  const { launcher, ticks } = standIn();
  const handle = newHandle(CLAIM);
  const { launch, exit } = launchWithExit();
  launcher.watchLauncherExit(handle, launch);
  exit();
  await turn();
  assert.equal(ticks.n, 0);
});

test('many launchers of ending runs exiting together ask for one tick; a later exit asks again', async () => {
  const { launcher, ticks } = standIn();
  const exits = [];
  for (let i = 0; i < 20; i++) {
    const handle = newHandle({ ...CLAIM, run: `run_${i}` });
    handle.ending = true;
    const { launch, exit } = launchWithExit();
    launcher.watchLauncherExit(handle, launch);
    exits.push(exit);
  }
  for (const exit of exits) exit();
  await turn();
  assert.equal(ticks.n, 1, 'no tick storm');
  const handle = newHandle(CLAIM);
  handle.ending = true;
  const { launch, exit } = launchWithExit();
  launcher.watchLauncherExit(handle, launch);
  exit();
  await turn();
  assert.equal(ticks.n, 2);
});
