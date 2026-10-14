// M432 (d) (slice 36; kernel lane). M5 plan §3.6 M432; D6-C03 ("an
// unreadable blob refuses the proposal, never an empty impact"); D6 §4.4
// ("an impact the engine cannot compute ... refuses the proposal with the
// reason"); B05; SEAM.md §§418, 419; the driver's ruling Q2 (2026-10-13).
//
// The reference project at `spec_ready`. A Spec Writer's proposal whose
// index has a row that does not parse (R2's phase "one"), and one whose blob
// cannot be read when the impact is computed (the harness fault
// `spec_blob_read` †): each refused at the run, the reason named; no side
// ref, no `spec_impact` record, no `spec_change` decision; the request
// `failed` after its repair, naming the reason.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { armFault, clearFaults } from './harness/engine.mjs';
import { recordsOf } from './harness/records.mjs';
import { script } from './harness/scripted.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { journeyContext, specRevisions } from './harness/journey/drive.mjs';
import { specReady } from './harness/journey/plan35.mjs';
import { SPEC_CHANGES, changeDecisions, changeScript, refOid, runsOfItem, sideRef, untilProposedOrFailed } from './harness/journey/change36.mjs';

async function refused(t, { spec, fault, names, row, what }) {
  const fx = await scriptedEngine(t);
  fx.scripted.defaultScript(script.complete());
  const p = await specReady(fx);
  const ctx = journeyContext(fx, p);
  fx.scripted.kindScript('spec_change', changeScript(spec, [{ key: 'R3', kind: 'text_changed', reason: what }]));
  if (fault) await armFault(fx.engine, { point: 'spec_blob_read', project: p.id, times: 6 });
  const res = await fx.engine.post(`/v1/projects/${p.id}/spec/change-requests`, { text: what });
  assert.equal(res.status, 201, `${what}: the request is recorded (→ ${res.status} ${res.text})`);
  const id = res.body.request.id;
  const { request } = await untilProposedOrFailed(fx, ctx, id, { max: 40 });
  if (fault) await clearFaults(fx.engine);
  const runs = runsOfItem(fx.home, request.work_item);
  assert.equal(request.status, 'failed', `${what}: the proposal is refused and the request fails after its repair, never proposed with an impact (it is ${request.status}; runs ${JSON.stringify(runs.map((r) => [r.outcome, r.reason_class, r.reason_text]))})`);
  assert.ok(runs.length >= 1, `${what}: the Spec Writer ran`);
  for (const r of runs) {
    assert.deepEqual([r.outcome, r.reason_class], ['failed', 'invalid_result'], `${what}: each run is refused invalid_result (${r.reason_text})`);
    assert.ok((r.reason_text ?? '').includes(names), `${what}: naming ${names} (${r.reason_text})`);
    if (row) assert.ok((r.reason_text ?? '').includes(row), `${what}: naming the row ${row} (${r.reason_text})`);
  }
  assert.ok((request.failure ?? '').includes(names), `${what}: the request's failure names ${names} (${request.failure})`);
  assert.equal(request.impact, null, `${what}: no impact recorded`);
  assert.deepEqual(recordsOf(fx.home, p.id, 'spec_impact'), [], `${what}: no spec_impact record, empty or otherwise`);
  assert.equal(refOid(p.repo.path, sideRef(request.seq)), null, `${what}: no side ref`);
  assert.deepEqual(changeDecisions(fx.home, id), [], `${what}: no spec_change decision`);
  assert.equal(specRevisions(fx.home, p.id).length, 1, `${what}: the approved specification is unchanged`);
}

describe('M432 (d) an impact the engine cannot compute refuses the proposal', () => {
  test('an index row that does not parse: refused naming the index defect and its row (spec_index_invalid, A.6); no impact, no side ref, no decision', async (t) => {
    await refused(t, { spec: SPEC_CHANGES.indexUnparsable, names: 'index_invalid', row: 'R2', what: 'an index row that does not parse' });
  });

  test('a blob unreadable when the impact is computed (spec_blob_read †): refused naming the unreadable blob; no impact, no side ref, no decision', async (t) => {
    await refused(t, { spec: SPEC_CHANGES.r3Statement, fault: true, names: 'spec_blob_unreadable', what: 'a blob that cannot be read' });
  });
});
