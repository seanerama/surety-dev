// M04, transition atomicity (slice 1). Plan §3.1 M04; D1 §§6.3, 12.1. A
// failure injected after a transition's domain write and before its event
// leaves neither the domain change nor an orphan event; a transition that
// commits changes its row and appends its event together. The transition
// used is project pause/resume (D1 §11.4, §8.4), the smallest slice-1 command
// with a domain write and an event.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { armFault } from './harness/engine.mjs';
import { assertRefused, maxEventSeq, projectFixture } from './harness/fixtures.mjs';
import { withStore } from './harness/store.mjs';

const pausedFlag = (home, project) =>
  withStore(home, (db) => db.prepare('SELECT "paused" FROM "projects" WHERE "id" = ?').get(project).paused);

const projectEvents = (home, type, project) =>
  withStore(home, (db) =>
    db
      .prepare(`SELECT * FROM "events" WHERE "type" = ? AND json_extract("subject", '$.project') = ? ORDER BY "seq"`)
      .all(type, project),
  );

describe('M04 a transition commits its row and its event together or not at all', () => {
  test('a failure between the domain write and the event write leaves nothing behind', async (t) => {
    const { engine, home, project } = await projectFixture(t);
    assert.equal(pausedFlag(home, project), 0);
    await armFault(engine, { point: 'before_event', event_type: 'project.paused' });
    const res = await engine.post(`/v1/projects/${project}/pause`);
    assertRefused(res, 500, 'store_error', 'pause with injected failure');
    assert.equal(pausedFlag(home, project), 0, 'no partial domain change');
    assert.equal(projectEvents(home, 'project.paused', project).length, 0, 'no orphan event');

    // The fault is one-shot; the same command then commits normally.
    const retry = await engine.post(`/v1/projects/${project}/pause`);
    assert.equal(retry.status, 200, retry.text);
    assert.equal(pausedFlag(home, project), 1);
    assert.equal(projectEvents(home, 'project.paused', project).length, 1);
  });

  test('a committed transition changes the projection only with its new event', async (t) => {
    const { engine, home, project } = await projectFixture(t);
    const start = maxEventSeq(home);

    const paused = await engine.post(`/v1/projects/${project}/pause`);
    assert.equal(paused.status, 200, paused.text);
    assert.equal(pausedFlag(home, project), 1);
    const pausedEvents = projectEvents(home, 'project.paused', project);
    assert.equal(pausedEvents.length, 1);
    assert.ok(pausedEvents[0].seq > start, 'event appended after the prior log');

    const resumed = await engine.post(`/v1/projects/${project}/resume`);
    assert.equal(resumed.status, 200, resumed.text);
    assert.equal(pausedFlag(home, project), 0);
    const resumedEvents = projectEvents(home, 'project.resumed', project);
    assert.equal(resumedEvents.length, 1);
    assert.ok(resumedEvents[0].seq > pausedEvents[0].seq, 'events are store-wide monotonic');
    assert.equal(projectEvents(home, 'project.paused', project).length, 1, 'history kept, not rewritten');
  });
});
