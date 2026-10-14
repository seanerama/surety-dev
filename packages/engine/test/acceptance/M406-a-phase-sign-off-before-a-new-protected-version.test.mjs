// M406, the 31b review's S3 (slice 31; kernel lane). D6 §5.8 (B06: the
// phase sign-off is bound to the candidate's acceptance content hash, the
// effective protected version, the spec revision and the plan's generation;
// "a sign-off bound to a replaced plan or candidate is refused"); SEAM
// §§352, 374.
//
// Phase 1's Verifier signs the phase off (its run held until the case
// releases it); a governed correction (an added `check_commands` entry,
// unclassifiable, approved by the owner) is captured and classified, and,
// right after the sign-off is recorded, approved: a new protected version is
// effective on the same candidate. The sign-off made before it no longer
// counts: phase 1 does not complete on it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answerAndHoldEffect, decisionsOn } from './harness/decisions.mjs';
import { governedEdit } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { authoringReady, planOfPhase, signoffsOfProject } from './harness/journey/drive.mjs';
import { journeyProject, pumpNoIdle } from './harness/journey/review31b.mjs';
import { step } from './harness/scripted.mjs';
import { waitFor } from './harness/engine.mjs';
import { withStore } from './harness/store.mjs';

const effectiveNow = (home, project) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "protected_versions" WHERE "project" = ? AND "authorized" = 1 AND "effective_from" IS NOT NULL AND "superseded_by" IS NULL').get(project));

describe('M406 S3: a phase sign-off made before a new protected version', () => {
  test('no longer counts on the same candidate: phase 1 does not complete on it', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    fx.scripted.kindScript('phase_verification', { steps: [step.hold('gate'), ...roleThat([], { signoffs: [{ scope: 'phase' }] }).steps] });
    await authoringReady(fx, ctx, 1);
    // Phase 1 built and checked; its Verifier dispatched and held.
    const launch = await pumpNoIdle(fx, ctx, () => fx.scripted.launches({ work_kind: 'phase_verification' })[0], { what: 'phase 1\'s phase_verification run', max: 120 });
    // A governed correction captured and classified while it is held.
    const proposal = await governedEdit(fx, p, { check_commands: { node: { path: process.execPath }, probe: { path: '/usr/bin/true' } } });
    const question = await pumpNoIdle(fx, ctx, () => decisionsOn(fx.home, 'check_correction_unclassifiable', proposal.id).find((d) => d.status === 'open'), { what: 'the correction\'s question', max: 10, answerKinds: [] });
    const before = effectiveNow(fx.home, p.id);
    // M5 slice 37 (D6 K1; objection 100; SEAM.md §436): the Verifier's end and
    // the answer each request a tick, and a tick evaluates the phase before it
    // applies an approval's effect; so "the sign-off recorded; then the
    // correction approved, before any tick evaluates the phase with it" is
    // made by holding the approval's effect at `intent.recorded` (§76), which
    // holds the tick applying it (after that tick's phase step): the Verifier
    // is released there and its sign-off recorded under the version still in
    // effect; then the effect is let go and the new version takes effect
    // before any later tick evaluates the phase with that sign-off.
    const held = await answerAndHoldEffect(fx, p.id, question, 'approve');
    fx.scripted.release(launch.work_item, 'gate');
    // Polled with the effect held: the sign-off is recorded at the run's end, outside any tick.
    const recorded = await waitFor(() => signoffsOfProject(fx.home, p.id).find((x) => x.scope === 'phase'), { what: 'the phase sign-off to be recorded' }).catch(() => null);
    assert.ok(recorded, 'the fixture is live: the phase sign-off is recorded');
    assert.equal(recorded.binding?.protected_version, before.id, 'bound to the version effective when it was made');
    assert.equal(planOfPhase(fx.home, p.id, 1).find((x) => x.active === 1 || x.active === true)?.completed_at ?? null, null, 'the fixture is live: the phase is not complete when the sign-off is recorded');
    await held.release();
    const after = await pumpNoIdle(fx, ctx, () => { const e = effectiveNow(fx.home, p.id); return e && e.id !== before.id ? e : undefined; }, { what: 'the correction\'s version to be effective', max: 10, answerKinds: [] });
    for (let i = 0; i < 6; i++) await pumpNoIdle(fx, ctx, () => false, { max: 1, answerKinds: [] }).catch(() => null);
    const plan = planOfPhase(fx.home, p.id, 1).find((x) => x.active === 1 || x.active === true);
    if (plan.completed_at) {
      assert.notEqual(plan.completion_binding?.protected_version, before.id, 'the fixture is live: the phase did not complete before the new version took effect');
      const fresh = signoffsOfProject(fx.home, p.id).filter((s) => s.scope === 'phase' && s.candidate === plan.completion_binding.candidate && s.binding?.protected_version === after.id);
      assert.ok(fresh.length > 0, `phase 1 completed only on a sign-off bound to the new version, never on the one made before it (sign-offs: ${JSON.stringify(signoffsOfProject(fx.home, p.id).map((s) => s.binding))})`);
    }
  });
});
