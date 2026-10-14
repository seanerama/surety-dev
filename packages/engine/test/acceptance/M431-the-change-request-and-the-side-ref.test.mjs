// M431 (a), (d), (e), (f) (slice 36; kernel lane). M5 plan §3.6 M431;
// D6-C01, D6-C02; D6 §4.2, §4.3; K7, K8; B05; A.2 (`RefKind` `spec_change`);
// SEAM.md §§416, 417; the driver's rulings of 2026-10-13 (Q1).
//
// The reference project at `spec_ready` (no roadmap, so no replan):
// (a)  `surety spec change-request --project <p> --file <path>`: the
//      request, its record, its work and its event;
// (d)  the Spec Writer's diff committed on `refs/surety/spec-change/<seq>`,
//      registered `spec_change`, through the journal, the integration branch
//      untouched; `spec.change_proposed`;
// (e)  a diff touching a file outside `.surety/spec/`; a diff renumbering a
//      criterion: each refused at the run (`invalid_result`, the second
//      naming `spec_keys_renumbered`), no side ref, no decision;
// (f)  a side-ref write replayed after a kill: one proposal, its identity
//      kept; the side ref moved by hand before the answer: the answer
//      stale, and no byte of the moved revision ever integrated.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { assertStaleAnswer, answer, decision, reachBarrier } from './harness/decisions.mjs';
import { releaseBarrier } from './harness/engine.mjs';
import { armBarrier, operationDetails } from './harness/journal.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { commitOnRef } from './harness/repos.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { CHANGE_REQUEST } from './harness/journey/reference.mjs';
import { eventsAbout, journeyContext, specRevisions, workOf } from './harness/journey/drive.mjs';
import { specReady } from './harness/journey/plan35.mjs';
import {
  SPEC_CHANGES,
  SPEC_PATH,
  blobAt,
  changeDecisions,
  changeScript,
  openChangeDecision,
  pumpHolding,
  refOid,
  registryRow,
  requestRow,
  requestsOf,
  runsOfItem,
  sideRef,
  specAt,
  surety,
  untilProposedOrFailed,
} from './harness/journey/change36.mjs';

const R1_CHANGE = [{ key: 'R1', kind: 'criteria_changed', reason: 'R1.1 names the type' }];

async function atSpecReady(t, policy = {}) {
  const fx = await scriptedEngine(t);
  fx.scripted.defaultScript(script.complete());
  const p = await specReady(fx, { policy });
  const ctx = journeyContext(fx, p);
  return { fx, p, ctx };
}

describe('M431 the change request and the side ref', () => {
  test('(a) surety spec change-request --file: the request, its record, its work and its event', async (t) => {
    const { fx, p } = await atSpecReady(t);
    const [v1] = specRevisions(fx.home, p.id);
    fx.scripted.kindScript('spec_change', changeScript(SPEC_CHANGES.r1Reworded, R1_CHANGE));
    const file = join(fx.root, 'cr-1.md');
    writeFileSync(file, CHANGE_REQUEST);
    // (a)
    const out = surety(fx, ['spec', 'change-request', '--project', p.id, '--file', file]);
    assert.equal(out.status, 0, `surety spec change-request exits 0 (stdout ${out.stdout.slice(0, 600)}; stderr ${out.stderr.slice(0, 600)})`);
    assert.equal(out.stdout.trim().split('\n').length, 1, 'one line of JSON on standard output');
    const id = out.body?.request?.id;
    assert.match(id ?? '', /^scr_/, `the answer names the request (${out.stdout.slice(0, 400)})`);
    assert.equal(out.body.request.status, 'requested', 'requested');
    assert.match(out.body?.work_item?.id ?? '', /^wi_/, 'and its work item');
    const row = requestRow(fx.home, id);
    assert.deepEqual([row.project, row.seq, row.spec_revision, row.source], [p.id, 1, v1.id, 'owner'], 'the row: the project, seq 1, the current approved version, source owner');
    const text = recordRow(fx.home, row.text);
    assert.ok(text, 'the request\'s text is a record');
    assert.equal(readFileSync(recordFile(fx.home, text), 'utf8'), CHANGE_REQUEST, 'holding the file\'s bytes');
    const work = workOf(fx.home, p.id, 'spec_change');
    assert.deepEqual(work.map((w) => w.id), [out.body.work_item.id], 'one spec_change work item, the one answered');
    const requested = eventsAbout(fx.home, 'spec.change_requested', p.id);
    assert.equal(requested.length, 1, 'one spec.change_requested');
    assert.equal(requested[0].payload?.source, 'owner');
  });

  test('(d) the diff on refs/surety/spec-change/1, registered spec_change, through the journal; the integration branch untouched; spec.change_proposed', async (t) => {
    const { fx, p, ctx } = await atSpecReady(t);
    const [v1] = specRevisions(fx.home, p.id);
    const head = refOid(p.repo.path, p.repo.ref);
    fx.scripted.kindScript('spec_change', changeScript(SPEC_CHANGES.r1Reworded, R1_CHANGE));
    const res = await fx.engine.post(`/v1/projects/${p.id}/spec/change-requests`, { text: CHANGE_REQUEST });
    assert.equal(res.status, 201, `the request is recorded (→ ${res.status} ${res.text})`);
    const id = res.body.request.id;
    const { request, decision: d } = await untilProposedOrFailed(fx, ctx, id);
    assert.equal(request.status, 'proposed', `the proposal is recorded (${request.failure ?? ''})`);
    const ref = sideRef(1);
    const oid = refOid(p.repo.path, ref);
    assert.ok(oid, `${ref} exists`);
    assert.equal(request.proposal_revision, oid, 'the proposal binds the side ref\'s revision');
    assert.equal(specAt(p.repo.path, oid), SPEC_CHANGES.r1Reworded.trimEnd(), 'which holds the Spec Writer\'s specification');
    const reg = registryRow(fx.home, p.id, ref);
    assert.ok(reg, 'the side ref is registered');
    assert.equal(reg.kind, 'spec_change', `registered with RefKind spec_change (D6 A.2; K8), not ${reg.kind}`);
    const ops = operationDetails(fx.home, { project: p.id }).filter((op) => op.payload?.ref === ref);
    assert.equal(ops.length, 1, `one journaled write of the side ref (${JSON.stringify(ops.map((o) => o.kind))})`);
    assert.equal(ops[0].finalized, true, 'finalized');
    assert.equal(refOid(p.repo.path, p.repo.ref), head, 'the integration branch did not move');
    assert.equal(blobAt(p.repo.path, head), v1.git_blob, 'and still holds the approved specification');
    assert.equal(eventsAbout(fx.home, 'spec.change_proposed', p.id).length, 1, 'one spec.change_proposed');
    assert.ok(d, 'the spec_change decision is raised about the request');
    assert.equal(specRevisions(fx.home, p.id).length, 1, 'nothing of the approved specification changed');
  });

  test('(e) a diff outside .surety/spec/ (diff_violation, as M423 (d)); a renumbered criterion (invalid_result naming spec_keys_renumbered, Q1): each refused at the run, no side ref, no decision', async (t) => {
    const { fx, p, ctx } = await atSpecReady(t);
    const cases = [
      { what: 'a diff touching server.mjs', spec: SPEC_CHANGES.r1Reworded, extra: [{ write: { path: 'server.mjs', content: 'export {};\n' } }], code: 'server.mjs', reason: 'diff_violation' },
      { what: 'a renumbered criterion (R2.2 as R2.3)', spec: SPEC_CHANGES.renumbered, extra: [], code: 'spec_keys_renumbered', reason: 'invalid_result' },
    ];
    for (const c of cases) {
      fx.scripted.kindScript('spec_change', changeScript(c.spec, [{ key: 'R2', kind: 'criteria_changed', reason: c.what }], { extra: c.extra }));
      const res = await fx.engine.post(`/v1/projects/${p.id}/spec/change-requests`, { text: c.what });
      assert.equal(res.status, 201, `${c.what}: the request is recorded (→ ${res.status} ${res.text})`);
      const id = res.body.request.id;
      const { request } = await untilProposedOrFailed(fx, ctx, id, { max: 40 });
      const runs = runsOfItem(fx.home, request.work_item);
      assert.ok(runs.length > 0, `${c.what}: the Spec Writer ran`);
      assert.equal(request.status, 'failed', `${c.what}: the request fails after its repair, never proposed (it is ${request.status}; runs ${JSON.stringify(runs.map((r) => [r.outcome, r.reason_class, r.reason_text]))})`);
      for (const r of runs) assert.deepEqual([r.outcome, r.reason_class], ['failed', c.reason], `${c.what}: each run is refused ${c.reason} (${r.reason_text})`);
      assert.ok(runs.every((r) => (r.reason_text ?? '').includes(c.code)), `${c.what}: the refusal names ${c.code} (${JSON.stringify(runs.map((r) => r.reason_text))})`);
      assert.match(request.failure ?? '', /\S/, `${c.what}: the request names why it failed`);
      assert.equal(refOid(p.repo.path, sideRef(request.seq)), null, `${c.what}: no side ref`);
      assert.equal(request.proposal_revision, null, `${c.what}: no proposal`);
      assert.deepEqual(changeDecisions(fx.home, id), [], `${c.what}: no spec_change decision`);
    }
    assert.equal(specRevisions(fx.home, p.id).length, 1, 'the approved specification is unchanged');
  });

  test('(f) a side-ref write replayed after a kill: one proposal, its identity kept', async (t) => {
    const { fx, p, ctx } = await atSpecReady(t);
    const head = refOid(p.repo.path, p.repo.ref);
    fx.scripted.kindScript('spec_change', changeScript(SPEC_CHANGES.r1Reworded, R1_CHANGE, { hold: true }));
    const res = await fx.engine.post(`/v1/projects/${p.id}/spec/change-requests`, { text: 'Replay.' });
    assert.equal(res.status, 201);
    const id = res.body.request.id;
    await pumpHolding(fx, ctx, () => {
      const launch = fx.scripted.launches({ work_kind: 'spec_change' }).at(-1);
      return launch && fx.scripted.eventsOf(launch.pid, 'holding').length > 0 ? launch : undefined;
    }, { what: 'the Spec Writer holding' });
    // Paused after each ref_update's effect until the one paused is the side
    // ref's; then the engine is killed there, between the effect and its receipt.
    const ref = sideRef(1);
    const BARRIER = 'journal.ref_update.effect_applied';
    let released = false;
    let caught = null;
    for (let i = 0; i < 12; i++) {
      await armBarrier(fx.engine, BARRIER, 'pause');
      if (!released) {
        fx.scripted.release('all', 'gate');
        released = true;
      }
      await reachBarrier(fx, p.id, BARRIER);
      const pending = operationDetails(fx.home, { project: p.id }).filter((op) => !op.finalized && op.journal_kind === 'ref_update' && !op.events.some((e) => e.kind === 'applied'));
      caught = pending.find((op) => op.payload?.ref === ref) ?? null;
      if (caught) break;
      await releaseBarrier(fx.engine, BARRIER);
    }
    assert.ok(caught, 'the fixture is live: the engine paused after the side ref\'s effect, before its receipt');
    assert.ok(refOid(p.repo.path, ref), 'the side ref is written');
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 2 });
    const ops = operationDetails(fx.home, { project: p.id }).filter((op) => op.payload?.ref === ref);
    assert.equal(ops.length, 1, `one write of ${ref} (${JSON.stringify(ops.map((o) => o.events.map((e) => e.kind)))})`);
    assert.equal(ops[0].id, caught.id, 'the operation the kill interrupted');
    assert.equal(ops[0].finalized, true, 'recovered and finalized once');
    const request = requestRow(fx.home, id);
    const oid = refOid(p.repo.path, ref);
    assert.equal(request.status, 'proposed', `the request is proposed (${request.status} ${request.failure ?? ''})`);
    assert.equal(request.proposal_revision, oid, 'its proposal is the revision the side ref holds');
    assert.equal(eventsAbout(fx.home, 'spec.change_proposed', p.id).length, 1, 'one spec.change_proposed after the replay');
    assert.equal(changeDecisions(fx.home, id).length, 1, 'one spec_change decision');
    assert.equal(requestsOf(fx.home, p.id).length, 1, 'one request');
    assert.equal(refOid(p.repo.path, p.repo.ref), head, 'the integration branch did not move');
  });

  test('(f) the side ref moved by hand before the answer: the answer stale; no byte of the moved revision integrated', async (t) => {
    const { fx, p, ctx } = await atSpecReady(t);
    fx.scripted.kindScript('spec_change', changeScript(SPEC_CHANGES.r1Reworded, R1_CHANGE));
    const res = await fx.engine.post(`/v1/projects/${p.id}/spec/change-requests`, { text: 'Moved.' });
    assert.equal(res.status, 201);
    const id = res.body.request.id;
    const { request, decision: previewed } = await untilProposedOrFailed(fx, ctx, id);
    assert.ok(previewed, `the proposal is raised (${request.status} ${request.failure ?? ''})`);
    const proposal = request.proposal_revision;
    const ref = sideRef(1);
    const moved = commitOnRef(p.repo.path, ref, { [SPEC_PATH]: SPEC_CHANGES.moved }, { message: 'someone: not the proposal' });
    const movedBlob = blobAt(p.repo.path, moved);
    assert.equal(refOid(p.repo.path, ref), moved, 'the fixture is live: the side ref moved');
    await tick(fx.engine, p.id, { rounds: 2 });
    await assertStaleAnswer(fx, p.id, previewed, 'approve');
    // Whatever the engine asks next, the owner approves it; the moved bytes never land.
    for (let i = 0; i < 8; i++) {
      const d = openChangeDecision(fx.home, id);
      if (d) await answer(fx.engine, p.id, decision(fx.home, d.id), 'approve');
      await tick(fx.engine, p.id, { rounds: 1 });
    }
    assert.equal(requestRow(fx.home, id).proposal_revision, proposal, 'the proposal\'s identity is kept');
    const revisions = specRevisions(fx.home, p.id);
    assert.ok(!revisions.some((r) => r.git_blob === movedBlob), `no approved version holds the moved revision's specification (${JSON.stringify(revisions.map((r) => [r.version, r.git_blob]))})`);
    assert.notEqual(blobAt(p.repo.path, p.repo.ref), movedBlob, 'the integration branch never holds it');
  });
});
