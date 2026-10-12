// M401 (h), the 31b review's S8 (slice 31; kernel lane). D1 §10.5 (an effect
// intent executes once and is done); D6 §4.5; SEAM §§353, 374.
//
// After CR-1 is approved and applied, its `spec_change_application` intent is
// `done`, `intent.done` is emitted for it once, and the effects step no
// longer takes it up: further ticks begin it no more (`intent.executing`
// once) and leave it `done`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { changeRequest } from './harness/journey/drive.mjs';
import { eventsOfIntent, intentRows, journeyProject } from './harness/journey/review31b.mjs';
import { tick } from './harness/runs.mjs';

describe('M401 (h) S8: the spec change\'s application intent is done once', () => {
  test('after the applied change: intent done, intent.done once, not begun again by later ticks', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    await changeRequest(fx, ctx);
    const [intent] = intentRows(fx.home, p.id, 'spec_change_application');
    assert.ok(intent, 'the fixture is live: the approval recorded its application intent');
    await tick(fx.engine, p.id, { rounds: 4 });
    const now = intentRows(fx.home, p.id, 'spec_change_application').find((i) => i.id === intent.id);
    assert.equal(now.status, 'done', `the application intent is done (${JSON.stringify(now)})`);
    assert.equal(eventsOfIntent(fx.home, 'intent.done', intent.id).length, 1, 'intent.done once for it');
    assert.equal(eventsOfIntent(fx.home, 'intent.executing', intent.id).length, 1, 'begun once: the effects step no longer takes it up');
  });
});
