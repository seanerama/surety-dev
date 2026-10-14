// M433 (g), (d) and the 31b review's M2, as the slice-36 review found them
// (slice 36; kernel lane). D6 §4.5 ("what resolves an obligation: a protected
// correction applied that names the criteria, or the Verifier's explicit
// assessment on the correction item ... recorded with provenance"); the
// driver's rulings on the review's S1 and S3 (2026-10-14); SEAM §§61 (the
// `before_event` fault), 422, 423, 427.
//
// S1: the correction's run carries a proposal for accept-r2 and an assessment
//     that integration applies unchanged, and its acceptance fails once (a
//     one-shot fault on `protected.proposed`). The failed run's assessment
//     resolves nothing: both obligations stay open after it. Its repair
//     captures the correction and the assessment, and resolves both then.
// S3: the change lists accept-r2 and integration; the correction fixes
//     accept-r2's test and assesses neither. accept-r2's obligation is
//     resolved; the item does not complete; the remaining obligation returns
//     to `check_correction` work naming integration; no obligation is left
//     with no open work.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, decision } from './harness/decisions.mjs';
import { armFault } from './harness/engine.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { ROUTED_KINDS, authoringReady, obligationsOf, specRevisions, workOf } from './harness/journey/drive.mjs';
import { effectiveVersion } from './harness/gates.mjs';
import { journey35 } from './harness/journey/plan35.mjs';
import { CORRECTED_SERVICE_TEST } from './harness/journey/reference.mjs';
import { SPEC_CHANGES, changeScript, launchHolding, pumpHolding, untilProposedOrFailed } from './harness/journey/change36.mjs';

const OWNER_KINDS = ROUTED_KINDS.filter((k) => k !== 'spec_change');
const SERVICE_TEST = '.surety/checks/tests/service.test.mjs';
const PROPOSAL = { rationale: 'R2.1 and R2.2 now name the content type; accept-r2 reads it.', requested_change_kind: 'tightening' };
const ASSESSMENT = [{ check: 'integration', criteria: ['R2.2'], rationale: 'integration asserts the refusal\'s status alone, which the reworded R2.2 leaves unchanged.' }];
const runsOf = (home, item) => withStore(home, (db) => db.prepare('SELECT * FROM "runs" WHERE "work_item" = ? ORDER BY "seq"').all(item));
const obligations = (home, project) => Object.fromEntries(obligationsOf(home, project).filter((o) => o.reason === 'spec_changed').map((o) => [o.key, o]));

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
  test('S1: the failed run\'s assessment resolves nothing; its repair captures the correction and the assessment and resolves both', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 1 } });
    ctx.holdOpts = { answerKinds: OWNER_KINDS };
    // Launch 1: the correction and the assessment (its acceptance faulted). Launch 2, the repair: the same, held before its result.
    fx.scripted.kindScript('check_correction', [
      roleThat([step.write(SERVICE_TEST, CORRECTED_SERVICE_TEST)], { proposal: PROPOSAL, spec_applicability: ASSESSMENT }),
      { steps: [step.write(SERVICE_TEST, CORRECTED_SERVICE_TEST), step.hold('gate', { heartbeat_ms: 250 }), step.result({ status: 'completed', summary: 'the correction', proposal: PROPOSAL, spec_applicability: ASSESSMENT })] },
    ]);
    await authoringReady(fx, ctx, 1);
    const { item } = await approvedR2(fx, ctx, { beforeAnswer: () => armFault(fx.engine, { point: 'before_event', event_type: 'protected.proposed' }) });
    const first = await pumpHolding(fx, ctx, () => runsOf(fx.home, item.id).find((r) => r.state === 'ended'), { what: 'the first correction run to end', max: 30, ...ctx.holdOpts });
    assert.notEqual(first.outcome, 'completed', `the fixture is live: the faulted acceptance fails the run (${first.outcome}/${first.reason_class}: ${first.reason_text})`);
    await pumpHolding(fx, ctx, () => launchHolding(fx, 'check_correction', 1), { what: 'the repair held before its result', max: 30, ...ctx.holdOpts });
    const after = obligations(fx.home, p.id);
    assert.equal(after.integration.resolved_at, null, `the failed run's assessment resolves nothing: integration's obligation stays open (resolved_by ${after.integration.resolved_by})`);
    assert.equal(after['accept-r2'].resolved_at, null, 'nor accept-r2\'s');
    fx.scripted.release('all', 'gate');
    await pumpHolding(fx, ctx, () => Object.values(obligations(fx.home, p.id)).every((o) => o.resolved_at), { what: 'both obligations resolved by the repair', max: 60, ...ctx.holdOpts });
    const end = obligations(fx.home, p.id);
    const second = runsOf(fx.home, item.id).at(-1);
    assert.equal(second.outcome, 'completed', 'the repair\'s run is accepted');
    assert.ok(end.integration.resolved_by, 'integration resolved by the repair\'s assessment');
    assert.equal(end['accept-r2'].resolved_by, effectiveVersion(fx.home, p.id).id, 'accept-r2 resolved by the applied correction');
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
