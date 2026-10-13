// M401 (h), the 31b review's S8 (slice 31; kernel lane). D1 §10.5 (an effect
// intent executes once and is done); D6 §4.5; SEAM §§353, 374.
//
// After CR-1 is approved and applied, its `spec_change_application` intent is
// `done`, `intent.done` is emitted for it once, and the effects step no
// longer takes it up: further ticks begin it no more (`intent.executing`
// once) and leave it `done`.
//
// Objection 081 (upheld, 2026-10-13): the case reads the intent that was
// applied. When the phase-1 correction's protected application, answered in
// the same pump round, finishes first, CR-1's first intent is invalidated
// `EFFECT_PRECONDITION_CHANGED` (D1 §10.5) and the re-raised generation's
// intent is the one applied. Exactly one is applied, whichever it is.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { changeRequest } from './harness/journey/drive.mjs';
import { eventsOfIntent, intentRows, journeyProject } from './harness/journey/review31b.mjs';
import { tick } from './harness/runs.mjs';

describe('M401 (h) S8: the spec change\'s application intent is done once', () => {
  test('after the applied change: intent done, intent.done once, not begun again by later ticks', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    await changeRequest(fx, ctx);
    const intents = intentRows(fx.home, p.id, 'spec_change_application');
    const applied = intents.filter((i) => i.status === 'done');
    assert.equal(applied.length, 1, `the fixture is live: exactly one application intent was applied (${JSON.stringify(intents.map((i) => [i.id, i.status, i.invalidated_reason]))})`);
    for (const other of intents.filter((i) => i.status !== 'done')) assert.equal(other.status, 'invalidated', `any other intent was invalidated, never executed (${JSON.stringify(other)})`);
    const [intent] = applied;
    await tick(fx.engine, p.id, { rounds: 4 });
    const now = intentRows(fx.home, p.id, 'spec_change_application').find((i) => i.id === intent.id);
    assert.equal(now.status, 'done', `the applied intent stays done (${JSON.stringify(now)})`);
    assert.equal(intentRows(fx.home, p.id, 'spec_change_application').filter((i) => i.status === 'done').length, 1, 'and no other is applied by later ticks');
    assert.equal(eventsOfIntent(fx.home, 'intent.done', intent.id).length, 1, 'intent.done once for it');
    assert.equal(eventsOfIntent(fx.home, 'intent.executing', intent.id).length, 1, 'begun once: the effects step no longer takes it up');
  });
});
