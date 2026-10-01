// Developer tests for the work-item transition table (src/store/transitions/
// work-table.ts). The expectations are written from D1 A.5 and build spec §6
// correction 11 by hand; the acceptance suite checks the whole table against
// the Verifier's contract.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { DISPATCHABLE, isLegalWorkEdge } = await import(join(dist, 'store', 'transitions', 'work-table.js'));

const legal = (kind, from, to, continuation = null) => isLegalWorkEdge(kind, from, to, continuation);

test('each kind follows its own path and no other', () => {
  assert.ok(legal('stage_build', 'executing', 'integrating'));
  assert.ok(legal('stage_build', 'integrated', 'verifying'));
  assert.ok(legal('review', 'executing', 'complete'));
  assert.equal(legal('review', 'executing', 'integrating'), false, 'a review never integrates');
  assert.equal(legal('replan', 'integrated', 'verifying'), false, 'a replan has no verifying step');
  assert.ok(legal('replan', 'integrated', 'complete'));
  assert.equal(legal('verification', 'eligible', 'executing'), false, 'nothing skips claimed');
});

test('Stop and Abandon apply from every run-owning status, integrated and awaiting_decision included', () => {
  for (const from of ['claimed', 'executing', 'integrating', 'integrated', 'verifying']) {
    assert.ok(legal('stage_build', from, 'held'), `stop from ${from}`);
    assert.ok(legal('stage_build', from, 'eligible'), `abandon from ${from}`);
  }
  assert.ok(legal('verification', 'awaiting_decision', 'held'));
  assert.equal(legal('spec_change', 'awaiting_decision', 'held'), false, 'no run owns a spec_change');
  assert.equal(legal('verification', 'integrated', 'held'), false, 'a verification never reaches integrated');
});

test('awaiting_decision returns only to the continuation it stored', () => {
  assert.ok(legal('stage_build', 'awaiting_decision', 'integrating', 'integrating'));
  assert.equal(legal('stage_build', 'awaiting_decision', 'executing', 'integrating'), false);
  assert.equal(legal('stage_build', 'awaiting_decision', 'verifying', null), false);
  assert.equal(legal('verification', 'awaiting_decision', 'integrating', 'integrating'), false, 'not a status the kind has');
});

test('terminal statuses have no exit, and held and parked leave only by their causes', () => {
  for (const to of ['eligible', 'claimed', 'held', 'cancelled']) {
    assert.equal(legal('fix', 'complete', to), false);
    assert.equal(legal('fix', 'cancelled', to), false);
  }
  assert.ok(legal('fix', 'held', 'eligible'));
  assert.equal(legal('fix', 'held', 'executing'), false);
  assert.ok(legal('fix', 'parked', 'eligible'));
  assert.equal(legal('fix', 'parked', 'claimed'), false);
});

test('M1 dispatches exactly the kinds build spec §3 lists', () => {
  assert.deepEqual([...DISPATCHABLE].sort(), ['assessment', 'check_correction', 'fix', 'replan', 'review', 'stage_build', 'verification']);
});
