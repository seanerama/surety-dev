// M401 (h), the 31b review's S1 (slice 31; kernel lane). D6 §4.3 to §4.5;
// §3.4's blockers on approve (the ruling Q4; SEAM §§346, 365); SEAM §374.
//
// A Spec Writer's proposal whose representation is readable but carries a
// blocking finding (R2.2 in the index and absent from §4) never reaches an
// approvable `spec_change` decision: any decision raised offers `approve`
// with a blocker and answering it is refused; the integration branch never
// moves; no spec revision is made; every journaled operation is finalized
// (nothing threw in a finalizer).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer } from './harness/decisions.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { specRevisions } from './harness/journey/drive.mjs';
import { SPEC_V2_DEFECT, integrationHead, journeyProject, postChange, pumpNoIdle, requestRow, specChangeDecisions, unfinalized } from './harness/journey/review31b.mjs';
import { step } from './harness/scripted.mjs';

describe('M401 (h) S1: a spec change whose proposal carries a blocking finding', () => {
  test('never reaches an approvable spec_change decision; the integration branch never moves; nothing throws in a finalizer', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    fx.scripted.kindScript('spec_change', roleThat([step.write('.surety/spec/spec.md', SPEC_V2_DEFECT)], { changes: [{ key: 'R2', kind: 'criteria_changed', reason: 'S1: a defective proposal' }] }));
    const head = integrationHead(p);
    const request = await postChange(fx, ctx, 'S1: reword R2.');
    // Rounds until the Spec Writer's run has ended and its proposal settled (no decision answered).
    await pumpNoIdle(
      fx,
      ctx,
      () => {
        const r = requestRow(fx.home, request.id);
        const runs = fx.scripted.launches({ work_kind: 'spec_change' });
        return runs.length > 0 && r.status !== 'requested' ? r : undefined;
      },
      { max: 20, what: 'the Spec Writer\'s proposal to settle', answerKinds: [] },
    ).catch(() => null);
    for (let i = 0; i < 3; i++) await pumpNoIdle(fx, ctx, () => i > 99, { max: 1, answerKinds: [] }).catch(() => null);
    for (const d of specChangeDecisions(fx.home, p.id).filter((row) => row.status === 'open')) {
      const approve = d.options.find((o) => o.key === 'approve');
      assert.ok(approve && (approve.blockers ?? []).length > 0, `a spec_change decision about a proposal with a blocking finding offers approve only with a blocker (${JSON.stringify(d.options)})`);
      const res = await answer(fx.engine, p.id, d, 'approve');
      assert.equal(res.status, 409, `approving it is refused (→ ${res.status} ${res.text})`);
    }
    assert.equal(specRevisions(fx.home, p.id).length, 1, 'no spec revision is made');
    assert.equal(integrationHead(p), head, 'the integration branch never moves');
    assert.deepEqual(unfinalized(fx.home, p.id).map((op) => [op.id, op.journal_kind, op.state]), [], 'every journaled operation is finalized: nothing threw in a finalizer');
  });
});
