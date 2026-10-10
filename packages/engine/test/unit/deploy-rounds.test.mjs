// Developer tests for M4 slice 25, verify behaviourally (D4 §§3.4, 5.3;
// the slice-25 review's S1 and m6): the identity read's judgment of the
// environment's prefix listing. Pure functions; no engine is started, no
// unit is created, and no systemctl runs.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { judgeOtherGeneration } = await import(join(root, 'dist', 'deploy', 'adapters', 'local-service.js'));

const PREFIX = 'surety-0123456789ab-env_01M4J9JJJ4KMQNWQCR5XPPTVNJ-';
const x = { target: 'app', unit: `${PREFIX}g1.service`, generation: 1 };
const matched = { target: 'app', method: 'tree_digest', expected: 'sha256:a', read: 'sha256:a', match: 'match', instance: { pid: 7, start_time: 9 }, generation: 1, at: 'now', detail: null };
const row = (unit, active) => `${unit} loaded ${active} running a unit`;
const derived = () => true;

test('S1: a listing that could not be made turns a match into unread, naming the generation and the listing; never left a match', () => {
  const r = judgeOtherGeneration(matched, x, PREFIX, null, derived);
  assert.deepEqual([r.read, r.match, r.instance, r.generation], ['unread', 'unread', 'unread', 'unread']);
  assert.equal(r.detail.field, 'generation');
  assert.equal(r.detail.failure, 'listing');
  assert.match(r.detail.why, /listing/);
});

test('S1: a read that already differs stays differs when the listing fails', () => {
  const differs = { ...matched, match: 'differs', detail: { field: 'tree' } };
  assert.equal(judgeOtherGeneration(differs, x, PREFIX, null, derived), differs);
});

test('m6: another unit of the prefix active, activating or reloading is another generation: differs, naming it', () => {
  for (const state of ['active', 'activating', 'reloading']) {
    const r = judgeOtherGeneration(matched, x, PREFIX, [row(x.unit, 'active'), row(`${PREFIX}g2.service`, state)].join('\n'), derived);
    assert.equal(r.match, 'differs', state);
    assert.equal(r.generation, 2, state);
    assert.equal(r.detail.field, 'generation', state);
  }
});

test('an inactive or failed other unit, the expected unit itself, and a unit outside the prefix leave the read as it was', () => {
  const listing = [row(x.unit, 'active'), row(`${PREFIX}g2.service`, 'inactive'), row(`${PREFIX}g3.service`, 'failed'), row('surety-ffffffffffff-env_x-g4.service', 'active')].join('\n');
  assert.equal(judgeOtherGeneration(matched, x, PREFIX, listing, derived), matched);
});
