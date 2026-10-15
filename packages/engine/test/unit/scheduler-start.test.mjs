// Developer test for the slice-37 review's S2: no tick of any kind runs
// before the scheduler has started (after the lift to full; D1 §1.4, §16; K1).
// Requests made during startup are coalesced into the first tick after the
// start. The tick itself is stubbed: nothing here reads a store.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { Scheduler } = await import(join(dist, 'scheduler', 'tick.js'));

const settle = () => new Promise((r) => setTimeout(r, 20));

test('S2: requests during startup run no tick; the start runs one tick for all of them', async (t) => {
  const s = Object.create(Scheduler.prototype);
  Object.assign(s, { flag: false, requests: 0, running: false, timer: null, stopped: false, started: false, lastTickAt: 0, rt: { deploy: null, setting: () => 3600 } });
  const ticks = [];
  s.tick = async (n) => {
    ticks.push(n);
  };
  t.after(() => s.stop());
  s.request(2);
  s.request(3);
  await settle();
  assert.deepEqual(ticks, [], 'no tick before the start');
  s.start();
  await settle();
  assert.deepEqual(ticks, [5], 'one tick after the start, the startup requests coalesced');
  s.request();
  await settle();
  assert.deepEqual(ticks, [5, 1], 'after the start, requests tick as before');
});
