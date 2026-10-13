// M411 (b), the owner's answers survive an unrelated spec change (slice 32's
// review, S3; kernel lane). D6 §8.1 step 2 (a requirement leaves the
// unconfirmed state only by the owner's explicit action on it), §4.5
// (requirements re-registered at a change: keys kept, withdrawn marked); K10;
// B10; SEAM.md §§379, 387.
//   (full) R3 withdrawn by the owner; an approved spec change about R2 alone:
//          R3 still `withdrawn`;
//   (scoped) R1 has criteria and is left unanswered, so it is
//          `descriptive_unverified`; an approved spec change about R2 alone:
//          R1 still `descriptive_unverified`, not promoted by the change.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { roleThat } from './harness/gitruns.mjs';
import { journeyContext, requirementsOf, specRevisions } from './harness/journey/drive.mjs';
import { step } from './harness/scripted.mjs';
import { adoptProject, chooseMode, confirmAndApprove, pump, retrofitEngine, retrofitSpecSession } from './harness/retrofit/drive.mjs';
import { REQUIREMENTS, retrofitSpecText } from './harness/retrofit/products.mjs';

// R2's statement reworded: the change is about R2 alone.
const R2_REWORDED = REQUIREMENTS.map((r) => (r.key === 'R2' ? { ...r, statement: 'A client sums two numbers through the service over HTTP and reads the sum as JSON.' } : r));

// The owner's change request about R2, the Spec Writer's change, the owner's approval: spec version 2.
async function changeAboutR2(fx, p) {
  fx.scripted.kindScript('spec_change', roleThat([step.write('.surety/spec/spec.md', retrofitSpecText({ version: 2, requirements: R2_REWORDED, changeLog: [{ version: 2, date: '2026-10-13', change: 'R2 reworded', by: 'Sean' }] }))], { changes: [{ key: 'R2', kind: 'text_changed', reason: 'R2 names JSON' }] }));
  const res = await fx.engine.post(`/v1/projects/${p.id}/spec/change-requests`, { text: 'R2 should say the sum is read as JSON.' });
  assert.equal(res.status, 201, `the owner's change request (→ ${res.status} ${res.text})`);
  const ctx = journeyContext(fx, { id: p.id, repo: p.repo }, { tier: 'T1' });
  return pump(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2) ?? undefined, { what: 'spec version 2', max: 30 });
}
const statusOf = (fx, p, key) => requirementsOf(fx.home, p.id).find((r) => r.key === key)?.status;

describe('M411 (b) S3: the owner\'s answers survive an unrelated spec change', () => {
  test('full: R3 withdrawn stays withdrawn when a change about R2 is approved', async (t) => {
    const fx = await retrofitEngine(t);
    const p = await adoptProject(fx);
    await chooseMode(fx, p.id, 'full');
    await retrofitSpecSession(fx, p.id);
    await confirmAndApprove(fx, p.id, { R1: 'confirm', R2: 'confirm', R3: 'withdraw', R4: 'defect' });
    assert.equal(statusOf(fx, p, 'R3'), 'withdrawn', 'the fixture is live: R3 withdrawn');
    await changeAboutR2(fx, p);
    assert.equal(statusOf(fx, p, 'R3'), 'withdrawn', 'R3 still withdrawn after the change about R2');
  });

  test('scoped: R1 with criteria, unanswered, stays descriptive_unverified when a change about R2 is approved', async (t) => {
    const fx = await retrofitEngine(t);
    const p = await adoptProject(fx);
    await chooseMode(fx, p.id, 'scoped');
    await retrofitSpecSession(fx, p.id);
    await confirmAndApprove(fx, p.id, { R2: 'confirm', R3: 'confirm', R4: 'defect' });
    assert.equal(statusOf(fx, p, 'R1'), 'descriptive_unverified', 'the fixture is live: R1 unanswered, descriptive_unverified');
    await changeAboutR2(fx, p);
    assert.equal(statusOf(fx, p, 'R1'), 'descriptive_unverified', 'R1 not promoted by a change about R2');
  });
});
