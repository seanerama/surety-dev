// M433 (g), (d) and the 31b review's M2, as the slice-36 review found them
// (slice 36; kernel lane). D6 §4.5 ("what resolves an obligation: a protected
// correction applied that names the criteria, or the Verifier's explicit
// assessment on the correction item ... recorded with provenance"); the
// driver's rulings on the review's S1 and S3 (2026-10-14); SEAM §§61 (the
// `before_event` fault), 422, 423, 427.
//
// S1: the correction's run carries a proposal for accept-r2 and an assessment
//     that integration applies unchanged, and the capture's transaction is
//     faulted (`before_event` on `protected.proposed`). Once: the run either
//     fails and is repaired or retries the step and completes (objection
//     099, upheld); a fault that persists past the retries: nothing is
//     captured, assessed or resolved while it stands, and all of it once it
//     is cleared. Either way no assessment or resolution ever stands for a
//     run whose correction was not captured; in the end one assessment for
//     integration, and both obligations resolved.
// S3: the change lists accept-r2 and integration; the correction fixes
//     accept-r2's test and assesses neither. accept-r2's obligation is
//     resolved; the item does not complete; the remaining obligation returns
//     to `check_correction` work naming integration; no obligation is left
//     with no open work.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, decision } from './harness/decisions.mjs';
import { armFault, clearFaults } from './harness/engine.mjs';
import { tick } from './harness/runs.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { ROUTED_KINDS, authoringReady, obligationsOf, specRevisions, workOf } from './harness/journey/drive.mjs';
import { effectiveVersion } from './harness/gates.mjs';
import { journey35 } from './harness/journey/plan35.mjs';
import { CORRECTED_SERVICE_TEST } from './harness/journey/reference.mjs';
import { SPEC_CHANGES, changeScript, pumpHolding, untilProposedOrFailed } from './harness/journey/change36.mjs';

const OWNER_KINDS = ROUTED_KINDS.filter((k) => k !== 'spec_change');
const SERVICE_TEST = '.surety/checks/tests/service.test.mjs';
const PROPOSAL = { rationale: 'R2.1 and R2.2 now name the content type; accept-r2 reads it.', requested_change_kind: 'tightening' };
const ASSESSMENT = [{ check: 'integration', criteria: ['R2.2'], rationale: 'integration asserts the refusal\'s status alone, which the reworded R2.2 leaves unchanged.' }];
const runsOf = (home, item) => withStore(home, (db) => db.prepare('SELECT * FROM "runs" WHERE "work_item" = ? ORDER BY "seq"').all(item));
const obligations = (home, project) => Object.fromEntries(obligationsOf(home, project).filter((o) => o.reason === 'spec_changed').map((o) => [o.key, o]));

// The correction every launch of the request's item makes: accept-r2's test, and integration assessed.
const CORRECTION = roleThat([step.write(SERVICE_TEST, CORRECTED_SERVICE_TEST)], { proposal: PROPOSAL, spec_applicability: ASSESSMENT });
// The assessments recorded on the project (SEAM §422: the table `assessments`, a run per row).
const assessmentsOf = (home, project) => withStore(home, (db) => (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assessments'`).get() ? db.prepare('SELECT * FROM "assessments" WHERE "project" = ? ORDER BY rowid').all(project) : []));
const proposalsOfItem = (home, item) => withStore(home, (db) => db.prepare('SELECT p.* FROM "protected_proposals" p JOIN "runs" r ON r."id" = p."run" WHERE r."work_item" = ?').all(item));
// What stands for a run with no captured correction: an assessment of such a
// run, or an obligation resolved by one (the driver's ruling on S1).
function uncaptured(home, project, item) {
  const captured = new Set(proposalsOfItem(home, item).map((x) => x.run));
  const bad = [];
  const byId = new Map(assessmentsOf(home, project).map((a) => [a.id, a]));
  for (const a of byId.values()) if (!captured.has(a.run)) bad.push({ assessment: a.id, run: a.run });
  for (const o of obligationsOf(home, project).filter((x) => x.resolved_by && x.resolved_by.startsWith('asmt_'))) {
    const a = byId.get(o.resolved_by);
    if (!a || !captured.has(a.run)) bad.push({ obligation: o.key, resolved_by: o.resolved_by });
  }
  return bad;
}
// In the end: one assessment of integration, from a run that captured the
// correction; integration resolved by it and accept-r2 by the applied version.
function assertOneAssessment(home, project, item) {
  const integration = assessmentsOf(home, project).filter((a) => a.check_key === 'integration');
  assert.equal(integration.length, 1, `exactly one assessment for integration (${JSON.stringify(integration.map((a) => [a.id, a.run]))})`);
  assert.ok(proposalsOfItem(home, item).some((x) => x.run === integration[0].run), 'recorded by a run whose correction was captured');
  const end = obligations(home, project);
  assert.equal(end.integration.resolved_by, integration[0].id, 'integration resolved by that assessment');
  assert.equal(end['accept-r2'].resolved_by, effectiveVersion(home, project).id, 'accept-r2 resolved by the applied correction');
}

// The change rewording R2.1 and R2.2 (accept-r2 and integration listed),
// approved; `beforeAnswer` runs between the proposal and the answer.
async function approvedR2(fx, ctx, { beforeAnswer } = {}) {
  fx.scripted.kindScript('spec_change', changeScript(SPEC_CHANGES.r2Both, [{ key: 'R2', kind: 'criteria_changed', reason: 'content type' }]));
  const res = await fx.engine.post(`/v1/projects/${ctx.project}/spec/change-requests`, { text: 'The owner\'s change.' });
  assert.equal(res.status, 201, `POST …/spec/change-requests (→ ${res.status} ${res.text})`);
  const out = await untilProposedOrFailed(fx, ctx, res.body.request.id, ctx.holdOpts);
  assert.ok(out.decision, `the change is proposed (${out.request.status} ${out.request.failure ?? ''})`);
  if (beforeAnswer) await beforeAnswer();
  assert.equal((await answer(fx.engine, ctx.project, decision(fx.home, out.decision.id), 'approve')).status, 200, 'the owner approves it');
  await pumpHolding(fx, ctx, () => specRevisions(fx.home, ctx.project).find((r) => r.version === 2), { what: 'version 2', max: 20, ...ctx.holdOpts });
  const listed = Object.keys(obligations(fx.home, ctx.project)).sort();
  assert.deepEqual(listed, ['accept-r2', 'integration'], 'the fixture is live: obligations on accept-r2 and integration');
  const item = workOf(fx.home, ctx.project, 'check_correction').find((w) => JSON.stringify(w.subject ?? {}).includes(out.request.id));
  assert.ok(item, 'the fixture is live: the request\'s check_correction');
  return { request: out.request, item };
}

describe('M433: a correction run that fails, and one that resolves only part', () => {
  test('S1, one fault: whether the faulted capture fails the run (then its repair) or is retried within it, no obligation is resolved without its captured correction; one assessment for integration; both resolved', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 1 } });
    ctx.holdOpts = { answerKinds: OWNER_KINDS };
    fx.scripted.kindScript('check_correction', CORRECTION);
    await authoringReady(fx, ctx, 1);
    const { item } = await approvedR2(fx, ctx, { beforeAnswer: () => armFault(fx.engine, { point: 'before_event', event_type: 'protected.proposed' }) });
    const seen = [];
    await pumpHolding(fx, ctx, () => {
      seen.push(...uncaptured(fx.home, p.id, item.id));
      return Object.values(obligations(fx.home, p.id)).every((o) => o.resolved_at);
    }, { what: 'both obligations resolved', max: 80, ...ctx.holdOpts });
    seen.push(...uncaptured(fx.home, p.id, item.id));
    assert.deepEqual(seen, [], 'no assessment and no resolution ever stood for a run with no captured correction');
    const runs = runsOf(fx.home, item.id).filter((r) => r.state === 'ended');
    assert.ok(runs.some((r) => r.outcome === 'completed'), `a run of the correction completed, the first after a retry or its repair (${JSON.stringify(runs.map((r) => [r.outcome, r.reason_class]))})`);
    assertOneAssessment(fx.home, p.id, item.id);
  });

  test('S1, a fault that persists past the retries: while it stands nothing is captured, assessed or resolved; once it is cleared the correction and the assessment resolve both, one assessment', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 1 } });
    ctx.holdOpts = { answerKinds: OWNER_KINDS };
    fx.scripted.kindScript('check_correction', CORRECTION);
    await authoringReady(fx, ctx, 1);
    const { item } = await approvedR2(fx, ctx, { beforeAnswer: () => armFault(fx.engine, { point: 'before_event', event_type: 'protected.proposed', times: 1000 }) });
    // The correction's run reaches its acceptance and the capture keeps failing.
    await pumpHolding(fx, ctx, () => runsOf(fx.home, item.id).length > 0 && fx.scripted.launches({ work_item: item.id }).length > 0, { what: 'the correction launched', max: 30, ...ctx.holdOpts });
    const seen = [];
    for (let i = 0; i < 12; i++) {
      seen.push(...uncaptured(fx.home, p.id, item.id));
      await tick(fx.engine, p.id, { rounds: 1 });
      await new Promise((r) => setTimeout(r, 500));
    }
    seen.push(...uncaptured(fx.home, p.id, item.id));
    assert.deepEqual(seen, [], 'while the capture fails, no assessment or resolution stands for a run with no captured correction');
    assert.deepEqual(proposalsOfItem(fx.home, item.id), [], 'no proposal captured while the fault stands');
    assert.deepEqual(assessmentsOf(fx.home, p.id), [], 'no assessment recorded while the fault stands');
    const open = obligations(fx.home, p.id);
    assert.ok(Object.values(open).every((o) => o.resolved_at === null), `both obligations open while the fault stands (${JSON.stringify(Object.values(open).map((o) => [o.key, o.resolved_by]))})`);
    await clearFaults(fx.engine);
    await pumpHolding(fx, ctx, () => {
      seen.push(...uncaptured(fx.home, p.id, item.id));
      return Object.values(obligations(fx.home, p.id)).every((o) => o.resolved_at);
    }, { what: 'both obligations resolved once the fault is cleared', max: 80, ...ctx.holdOpts });
    assert.deepEqual(seen, [], 'no assessment or resolution ever stood for a run with no captured correction');
    assertOneAssessment(fx.home, p.id, item.id);
  });

  test('S3: a correction that fixes accept-r2 and assesses neither: the item does not complete; integration\'s obligation returns to check_correction work naming it', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    ctx.holdOpts = { answerKinds: OWNER_KINDS };
    fx.scripted.kindScript('check_correction', [
      roleThat([step.write(SERVICE_TEST, CORRECTED_SERVICE_TEST)], { proposal: PROPOSAL }),
      roleThat([], {}),
      roleThat([], {}),
      roleThat([], {}),
    ]);
    await authoringReady(fx, ctx, 1);
    const { item } = await approvedR2(fx, ctx);
    await pumpHolding(fx, ctx, () => obligations(fx.home, p.id)['accept-r2'].resolved_at, { what: 'accept-r2 resolved by the correction', max: 60, ...ctx.holdOpts });
    await pumpHolding(fx, ctx, () => false, { max: 10, ...ctx.holdOpts }).catch(() => null);
    const end = obligations(fx.home, p.id);
    assert.equal(end.integration.resolved_at, null, 'integration\'s obligation is still open: the correction named only accept-r2');
    const original = workOf(fx.home, p.id, 'check_correction').find((w) => w.id === item.id);
    assert.notEqual(original.status, 'complete', `the correction item does not complete with integration's obligation open (it is ${original.status})`);
    const open = workOf(fx.home, p.id, 'check_correction').filter((w) => !['complete', 'cancelled'].includes(w.status));
    const naming = open.filter((w) => {
      const blockers = withStore(fx.home, (db) => db.prepare(`SELECT "question", "evidence" FROM "decisions" WHERE "subject_id" = ? AND "status" = 'open'`).all(w.id));
      return JSON.stringify([w, blockers]).includes('integration');
    });
    assert.ok(naming.length > 0, `open check_correction work names integration, the remaining obligation (no orphan) (${JSON.stringify(open.map((w) => [w.id, w.status, w.subject, w.blocker]))})`);
  });
});
