// M407 (d), the 31b review's S9 (slice 31; kernel lane). D6 §4.5 (a result
// of an earlier generation than an obligation on its check is history; the
// check owes a correction), §6.8 ("the rest shown pending"), A.8's spec read;
// SEAM §§353, 354, 374.
//
// After phase 1 completes, a spec change rewords R1's criterion and is
// approved; the Verifier's correction does not land (its run proposes
// nothing). Until it does, `GET …/spec` does not report R1 `verified`: it is
// `pending`, or `{unknown: <reason>}`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { roleThat } from './harness/gitruns.mjs';
import { obligationsOf, phaseCompleted, pump, readSpec, specRevisions } from './harness/journey/drive.mjs';
import { SPEC_R1_REWORDED, journeyProject, postChange } from './harness/journey/review31b.mjs';
import { step } from './harness/scripted.mjs';

describe('M407 (d) S9: the spec read after a delivered criterion is rewritten', () => {
  test('R1 is not reported verified while its correction has not landed', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    await phaseCompleted(fx, ctx, 1);
    const before = (await readSpec(fx, p.id)).requirements.find((r) => r.key === 'R1');
    assert.equal(before?.status, 'verified', `the fixture is live: R1 is verified after phase 1 (${JSON.stringify(before)})`);
    fx.scripted.kindScript('spec_change', roleThat([step.write('.surety/spec/spec.md', SPEC_R1_REWORDED)], { changes: [{ key: 'R1', kind: 'criteria_changed', reason: 'S9: R1.1 names the type' }] }));
    fx.scripted.kindScript('check_correction', roleThat([]));
    await postChange(fx, ctx, 'S9: R1.1 names the type.');
    await pump(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'spec version 2', max: 60 });
    assert.ok(obligationsOf(fx.home, p.id).some((o) => o.reason === 'spec_changed' && (o.criteria ?? []).includes('R1.1') && o.resolved_at === null), 'the fixture is live: R1.1\'s check owes a correction');
    const r1 = (await readSpec(fx, p.id)).requirements.find((r) => r.key === 'R1');
    const status = r1?.status;
    assert.ok(status === 'pending' || (status && typeof status === 'object' && typeof status.unknown === 'string'), `R1 is pending, or unknown with a reason, until its correction lands; never verified (${JSON.stringify(r1)})`);
  });
});
