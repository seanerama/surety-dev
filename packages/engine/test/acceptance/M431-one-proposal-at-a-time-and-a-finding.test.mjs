// M431 (b), (c) and M433 (c) (slice 36; kernel lane). M5 plan §3.6 M431,
// M433; D6-C01, D6-C04; D6 §4.2 ("one proposal at a time per project"),
// §4.5 (`reject`); D3 §5 X2; B05; SEAM.md §§416, 417.
//
// (b) three requests at `spec_ready`: while the first is dispatched, and
//     while its proposal awaits its decision, the other two wait `eligible`
//     with no run and no proposal; after the first is approved one of them
//     proceeds, its impact against version 2, the third still waiting; after
//     that one is rejected the third proceeds;
// M433 (c) the rejection: the side ref kept and still registered, the
//     request `rejected`, `spec.change_rejected`, no version and no
//     generation;
// (c) a `requirement_conflict` (the Architect's replan's, M427 (e)'s route)
//     answered `change_spec`: a request with source `finding` naming the
//     finding, its `spec_change` work, `spec.change_requested`, and its Spec
//     Writer launched.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, decisionsOn } from './harness/decisions.mjs';
import { findingsOf } from './harness/gates.mjs';
import { script } from './harness/scripted.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { eventsAbout, journeyContext, projectRow, specRevisions, workOf } from './harness/journey/drive.mjs';
import { journey35, phaseCompleteNoPlanAnswer, replan35, replanRunsOf, specReady } from './harness/journey/plan35.mjs';
import { REQUIREMENTS, specText } from './harness/journey/reference.mjs';
import { pumpNoIdle } from './harness/journey/review31b.mjs';
import {
  R3_STATEMENT,
  SPEC_CHANGES,
  changeDecisions,
  changeScript,
  impactRecordOf,
  pumpHolding,
  refOid,
  registryRow,
  requestRow,
  runsOfItem,
  sideRef,
  untilProposedOrFailed,
} from './harness/journey/change36.mjs';

const R1_TEXT = 'Given the numbers 2 and 3, when `sum(2, 3)` of `src/sum.mjs` is called, then it returns the number 5.';
const onV2 = (changes, version, what) =>
  specText({
    version,
    requirements: REQUIREMENTS.map((r) => (r.key === 'R1' ? { ...r, criteria: [{ id: 'R1.1', text: R1_TEXT }] } : changes[r.key] ? { ...r, ...changes[r.key] } : r)),
    changeLog: [
      { version: 2, date: '2026-10-13', change: 'R1.1 names the type', by: 'Sean' },
      { version, date: '2026-10-13', change: what, by: 'Sean' },
    ],
  });
const workOfRequest = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "work_items" WHERE "id" = (SELECT "work_item" FROM "spec_change_requests" WHERE "id" = ?)').get(id));

const CONFLICT = { category: 'requirement_conflict', severity: 'medium', message: 'R4 cannot be planned: /stats has no defined period, and R3 counts since the process started.', criterion: 'R4.1' };

describe('M431 one proposal at a time; a request from a finding', () => {
  test('(b) the others wait eligible while one is dispatched and while its proposal awaits; one proceeds at a time, against the version then current; M433 (c) the rejection keeps the ref', async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    const p = await specReady(fx);
    const ctx = journeyContext(fx, p);
    const later = { R3: onV2({ R3: { statement: R3_STATEMENT } }, 3, 'R3 sharpened'), R4: onV2({ R4: { statement: 'A user reads how many successful sums the service has served since it started.' } }, 3, 'R4 sharpened') };
    fx.scripted.kindScript('spec_change', [
      changeScript(SPEC_CHANGES.r1Reworded, [{ key: 'R1', kind: 'criteria_changed', reason: 'first' }], { hold: true }),
      changeScript(later.R3, [{ key: 'R3', kind: 'text_changed', reason: 'second' }]),
      changeScript(later.R4, [{ key: 'R4', kind: 'text_changed', reason: 'third' }]),
    ]);
    const post = async (text) => {
      const res = await fx.engine.post(`/v1/projects/${p.id}/spec/change-requests`, { text });
      assert.equal(res.status, 201, `${text} (→ ${res.status} ${res.text})`);
      return res.body.request.id;
    };
    const first = await post('First: R1.1 names the type.');
    await pumpHolding(fx, ctx, () => {
      const launch = fx.scripted.launches({ work_kind: 'spec_change' }).at(-1);
      return launch && fx.scripted.eventsOf(launch.pid, 'holding').length > 0 ? launch : undefined;
    }, { what: 'the first request\'s Spec Writer holding' });
    const second = await post('Second: R3 sharpened.');
    const third = await post('Third: R4 sharpened.');
    const waiting = (ids, what) => {
      for (const id of ids) {
        const w = workOfRequest(fx.home, id);
        assert.equal(w?.status, 'eligible', `${what}: request ${requestRow(fx.home, id).seq}'s work waits eligible (it is ${w?.status})`);
        assert.deepEqual(runsOfItem(fx.home, w.id), [], `${what}: no run for it`);
        assert.equal(requestRow(fx.home, id).status, 'requested', `${what}: no proposal`);
        assert.deepEqual(changeDecisions(fx.home, id), [], `${what}: no spec_change decision about it`);
      }
    };
    await tick(fx.engine, p.id, { rounds: 3 });
    waiting([second, third], 'while the first is dispatched');
    assert.equal(fx.scripted.launches({ work_kind: 'spec_change' }).length, 1, 'one Spec Writer launched, the first\'s');
    fx.scripted.release('all', 'gate');
    const one = await untilProposedOrFailed(fx, ctx, first);
    assert.ok(one.decision, `the first is proposed (${one.request.status} ${one.request.failure ?? ''})`);
    await tick(fx.engine, p.id, { rounds: 3 });
    waiting([second, third], 'while the first proposal awaits its decision');
    // The first approved: version 2.
    assert.equal((await answer(fx.engine, p.id, one.decision, 'approve')).status, 200);
    const v2 = await pumpHolding(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'version 2' });
    const next = await pumpHolding(fx, ctx, () => [second, third].map((id) => requestRow(fx.home, id)).find((r) => r.status !== 'requested'), { what: 'one waiting request to proceed' });
    const other = next.id === second ? third : second;
    const proposed = await untilProposedOrFailed(fx, ctx, next.id);
    assert.ok(proposed.decision, `it is proposed (${proposed.request.status} ${proposed.request.failure ?? ''})`);
    assert.equal(impactRecordOf(fx.home, next.id).value.approved_digest, v2.semantic_digest, 'its impact is computed against version 2, the version current when it ran');
    await tick(fx.engine, p.id, { rounds: 3 });
    waiting([other], 'while the second proposal awaits its decision');
    // M433 (c): the rejection.
    const generation = projectRow(fx.home, p.id).spec_evidence_generation;
    const oid = refOid(p.repo.path, sideRef(proposed.request.seq));
    assert.equal((await answer(fx.engine, p.id, proposed.decision, 'reject')).status, 200);
    await tick(fx.engine, p.id, { rounds: 2 });
    const rejected = requestRow(fx.home, next.id);
    assert.equal(rejected.status, 'rejected', 'the request is rejected');
    assert.equal(refOid(p.repo.path, sideRef(rejected.seq)), oid, 'its side ref is kept as history');
    assert.ok(registryRow(fx.home, p.id, sideRef(rejected.seq)), 'and still registered');
    const events = eventsAbout(fx.home, 'spec.change_rejected', p.id).filter((e) => e.subject?.spec_change_request === next.id);
    assert.equal(events.length, 1, 'one spec.change_rejected about it');
    assert.deepEqual(specRevisions(fx.home, p.id).map((r) => r.version), [1, 2], 'no version made by the rejection');
    assert.equal(projectRow(fx.home, p.id).spec_evidence_generation, generation, 'and no generation');
    // The third proceeds.
    const last = await untilProposedOrFailed(fx, ctx, other);
    assert.ok(last.decision, `the last waiting request proceeds after the rejection (${last.request.status} ${last.request.failure ?? ''})`);
  });

  test('(c) a requirement_conflict answered change_spec: a request from the finding, source finding, naming it; its work dispatched', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    fx.scripted.kindScript('replan', [replan35({ result: { findings: [CONFLICT] } }), replan35({ result: { findings: [CONFLICT] } })]);
    await phaseCompleteNoPlanAnswer(fx, ctx, 1);
    const run = await pumpNoIdle(fx, ctx, () => replanRunsOf(fx.home, p.id).find((r) => r.state === 'ended'), { what: 'the replan run to end', max: 60 });
    const finding = await pumpNoIdle(fx, ctx, () => findingsOf(fx.home, p.id).find((f) => f.category === 'requirement_conflict'), { what: 'the conflict recorded', max: 10 });
    const blocker = await pumpNoIdle(fx, ctx, () => decisionsOn(fx.home, 'blocker', run.work_item).find((d) => d.status === 'open'), { what: 'the blocker about the replan', max: 10 });
    fx.scripted.kindScript('spec_change', changeScript(specText({ version: 2, requirements: REQUIREMENTS.map((r) => (r.key === 'R4' ? { ...r, statement: 'A user reads how many sums the service has served since it started, counted per process.' } : r)), changeLog: [{ version: 2, date: '2026-10-13', change: 'R4: the period', by: 'Sean' }] }), [{ key: 'R4', kind: 'text_changed', reason: 'the period' }]));
    const res = await answer(fx.engine, p.id, blocker, 'change_spec');
    assert.equal(res.status, 200, `the owner answers change_spec (→ ${res.status} ${res.text})`);
    const request = await pumpNoIdle(fx, ctx, () => withStore(fx.home, (db) => db.prepare('SELECT * FROM "spec_change_requests" WHERE "project" = ?').get(p.id)), { what: 'a request from the finding', max: 6 }).catch(() => null);
    assert.ok(request, 'the change_spec answer records a spec change request (D6 §4.2)');
    assert.equal(request.source, 'finding', 'source finding');
    assert.equal(request.finding, finding.id, 'naming the finding');
    const requested = eventsAbout(fx.home, 'spec.change_requested', p.id).filter((e) => e.subject?.spec_change_request === request.id);
    assert.equal(requested.length, 1, 'spec.change_requested');
    assert.equal(requested[0].payload?.source, 'finding');
    const items = workOf(fx.home, p.id, 'spec_change');
    assert.equal(items.length, 1, `one spec_change work item (${JSON.stringify(items.map((w) => [w.id, w.status]))})`);
    assert.equal(request.work_item, items[0].id, 'the request\'s');
    const launched = await pumpNoIdle(fx, ctx, () => fx.scripted.launches({ work_kind: 'spec_change' }).at(-1), { what: 'the request\'s Spec Writer launched', max: 10, answerKinds: [] }).catch(() => null);
    assert.ok(launched, 'its Spec Writer is launched like the owner\'s');
  });
});
