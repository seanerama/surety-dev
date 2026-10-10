// Developer tests for M4 slice 26's pure parts: ownership by the recorded
// cgroup (the driver's reading of slice 26: the name in an intent and the
// recorded cgroup equal to the read one whenever both exist), in the
// reconcile mapping and in the precondition's list of units of unknown
// ownership (D4 §§2.4, 4.1, 4.6, 9.2).

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { judgeReconcile, unaccountedUnits } = await import(join(dist, 'deploy', 'reconcile.js'));

const DIGEST = `sha256:${'a'.repeat(64)}`;
const APP = { pid: 100001, start_time: 1002 };
const unit = (name, over = {}) => ({ resource: name, kind: 'unit', recorded: true, state: 'active', pendingJob: false, generation: 2, cgroup: `/cg/${name}`, instance: APP, tree: DIGEST, ...over });
const read = (inventory, complete = true) => ({ ok: { outcome: 'unknown', complete, inventory, reads: [], identity: [] } });
const deploy = (over = {}) => ({
  kind: 'deploy',
  prefix: 'p-',
  digest: DIGEST,
  create_units: ['p-g2.service'],
  prior: [],
  stop_units: [],
  recorded: ['p-g2.service'],
  recorded_cgroups: { 'p-g2.service': '/cg/p-g2.service' },
  launch_granted: true,
  app_instance: APP,
  ...over,
});

test('reconcile: g read in its recorded cgroup is applied; in another cgroup it is conflicting, never applied', () => {
  assert.equal(judgeReconcile(read([unit('p-g2.service')]), deploy()).outcome, 'applied');
  assert.equal(judgeReconcile(read([unit('p-g2.service', { cgroup: '/cg/elsewhere' })]), deploy()).outcome, 'conflicting');
});

test('reconcile: a cgroup not read, or none recorded, decides nothing by itself', () => {
  assert.equal(judgeReconcile(read([unit('p-g2.service', { cgroup: null })]), deploy()).outcome, 'applied');
  assert.equal(judgeReconcile(read([unit('p-g2.service', { cgroup: '/cg/other' })]), deploy({ recorded_cgroups: {} })).outcome, 'applied');
});

test('unknown ownership: a prefixed unit no intent names, and a recorded one in another cgroup, are listed by exact name; the owned one is not', () => {
  const inventory = [unit('p-g2.service'), unit('p-g5.service'), unit('p-g1.service', { cgroup: '/cg/elsewhere' }), { resource: '/run/x', kind: 'directory', state: 'present', pendingJob: false, generation: 9 }];
  const listed = unaccountedUnits(inventory, ['p-g1.service', 'p-g2.service'], { 'p-g1.service': '/cg/p-g1.service', 'p-g2.service': '/cg/p-g2.service' });
  assert.deepEqual(
    listed.map((u) => [u.unit, u.why]),
    [
      ['p-g5.service', 'no_intent'],
      ['p-g1.service', 'other_cgroup'],
    ],
  );
  assert.deepEqual(unaccountedUnits([unit('p-g2.service', { cgroup: null, state: 'failed' })], ['p-g2.service'], { 'p-g2.service': '/cg/p-g2.service' }), [], 'a unit with no cgroup (failed) is accounted by its name');
});

test('teardown: a runtime directory, link socket or populated cgroup of a covered generation left is partial, never applied; with none left it is applied', () => {
  const teardown = { kind: 'teardown', prefix: 'p-', digest: null, create_units: [], prior: [], stop_units: ['p-g3.service'], recorded: ['p-g3.service'], recorded_cgroups: {}, launch_granted: false, app_instance: null };
  for (const kind of ['directory', 'socket', 'cgroup']) {
    const left = { resource: `/home/run/env-g3${kind === 'socket' ? '/in.sock' : ''}`, kind, recorded: true, state: kind === 'cgroup' ? 'populated' : 'present', pendingJob: false, generation: 3 };
    assert.equal(judgeReconcile(read([left]), teardown).outcome, 'partial', `a ${kind} left`);
  }
  assert.equal(judgeReconcile(read([]), teardown).outcome, 'applied');
});
