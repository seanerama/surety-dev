// M401 (h), the 31b review's S7 (slice 31; kernel lane). D6 §4.5 (the
// application rebases the side revision onto the head when the spec files
// alone changed), D1 §10.5 (a precondition failed: the intent invalidated,
// the next generation asked); SEAM §§353, 374.
//
// CR-1 is approved; while its effect waits at the barrier between the
// consuming transaction and the revalidation (SEAM §76), a Spec Writer
// session's checkpoint rewrites the same lines of the specification on the
// integration branch, so the side revision no longer rebases. Released: the `spec_change_application` intent is invalidated
// (never executed), the next generation's `spec_change` question is raised
// to the owner about the same request, and nothing loops silently: later
// rounds leave the intent invalidated and begin no application.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answerAndHoldEffect, decision } from './harness/decisions.mjs';
import { closeSession, openSession, saveSession, sayAndSettle, scriptTurns, turnThatWrites } from './harness/sessions.mjs';
import { specRevisions } from './harness/journey/drive.mjs';
import { REQUIREMENTS, specText } from './harness/journey/reference.mjs';
import { eventsOfIntent, integrationHead, intentRows, journeyProject, postChange, pumpNoIdle, specChangeDecisions } from './harness/journey/review31b.mjs';

// The same lines CR-1 rewrites (R2.1's criterion), rewritten another way on the integration branch.
const CONFLICTING = specText({
  requirements: REQUIREMENTS.map((r) => (r.key === 'R2' ? { ...r, criteria: [{ id: 'R2.1', text: 'Given the service is running, when a client requests GET /sum?a=2&b=3, then it answers 200 with {"sum": 5} as text.' }, r.criteria[1]] } : r)),
});

describe('M401 (h) S7: an approved spec change that no longer rebases', () => {
  test('its intent is invalidated, the next generation is asked of the owner, and nothing loops', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    const request = await postChange(fx, ctx, 'CR-1');
    const first = await pumpNoIdle(fx, ctx, () => specChangeDecisions(fx.home, p.id).find((d) => d.status === 'open'), { what: 'the spec_change question', max: 30, answerKinds: [] });
    // The owner's Spec Writer session rewrites the same lines in its workspace (its turn dispatched by ticks, before the answer).
    const before = integrationHead(p);
    const run = await openSession(fx, p.id, 'spec_writer');
    scriptTurns(fx, run.id, [turnThatWrites({ '.surety/spec/spec.md': CONFLICTING }, { reply: 'R2.1 reworded.', done: true })]);
    await sayAndSettle(fx, p.id, run.id, 'Reword R2.1.');
    // CR-1 approved: the answer asks for a tick at once, so the effect is held
    // at the barrier between its consuming transaction and its revalidation
    // (SEAM §76) while the session's checkpoint is saved; then released.
    const held = await answerAndHoldEffect(fx, p.id, first, 'approve');
    const saved = await Promise.race([
      saveSession(fx, p.id, run.id).then(() => 'saved'),
      new Promise((r) => setTimeout(() => r('blocked'), 30_000)),
    ]);
    assert.equal(saved, 'saved', 'the fixture is live: the save completes while the approved effect waits at its barrier');
    assert.notEqual(integrationHead(p), before, 'the fixture is live: the integration branch moved with the session\'s checkpoint');
    await held.release();
    await closeSession(fx, p.id, run.id, { refuse: true });
    const { intent } = held;
    const again = await pumpNoIdle(
      fx,
      ctx,
      () => specChangeDecisions(fx.home, p.id).find((d) => d.status === 'open' && d.subject_id === request.id && d.id !== first.id && d.semantic_generation > first.semantic_generation),
      { what: 'the next generation of the spec_change question', max: 20, answerKinds: [] },
    ).catch(() => null);
    const settled = intentRows(fx.home, p.id, 'spec_change_application').find((i) => i.id === intent.id);
    assert.ok(again, `the next generation is asked of the owner (the intent: ${settled.status}; ${eventsOfIntent(fx.home, 'intent.executing', intent.id).length} intent.executing; the questions: ${JSON.stringify(specChangeDecisions(fx.home, p.id).map((d) => [d.status, d.semantic_generation]))})`);
    assert.equal(settled.status, 'invalidated', `the application intent is invalidated (${JSON.stringify(settled)})`);
    for (let i = 0; i < 4; i++) await pumpNoIdle(fx, ctx, () => false, { max: 1, answerKinds: [] }).catch(() => null);
    assert.equal(intentRows(fx.home, p.id, 'spec_change_application').find((i) => i.id === intent.id).status, 'invalidated', 'and stays invalidated');
    assert.equal(eventsOfIntent(fx.home, 'intent.executing', intent.id).length, 0, 'no application was begun: nothing loops');
    assert.equal(specRevisions(fx.home, p.id).length, 1, 'no spec revision');
    assert.equal(decision(fx.home, first.id).status, 'consumed');
  });
});
