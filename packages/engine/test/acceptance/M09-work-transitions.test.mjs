// M09, the transition table (slice 2). Plan §3.2 M09; D1 §4.3, A.5; build
// spec §6 correction 11; Review B10. The legal work-item transitions are one
// table held as data. For every M1 work kind, every edge the Verifier's table
// (contract/work-items.json) lists is accepted and every other edge is an
// atomic refusal: in particular a review never enters integration, and an
// item leaves awaiting_decision only for the continuation it stored.
//
// The edges are attempted through the engine's own transition function
// (SEAM.md §15, POST /v1/harness/work/:w/transition), because no public
// route can ask for most of them. The cases are generated from the contract
// table, never from the engine's. The project is paused so that the
// scheduler leaves these items alone.
//
// Paths taken by real runs are in M09-work-paths.test.mjs; an answered
// blocker is in M09-blocked-continuation.test.mjs.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { addProject, addWork, countOf, driveTo, forceTransition, installPlan, pauseProject, scriptedEngine, workItem } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { illegalEdgeCases, legalEdges, m1Kinds, routeTo } from './harness/transitions.mjs';

async function pausedProject(t) {
  const fx = await scriptedEngine(t);
  const project = await addProject(fx);
  await pauseProject(fx.engine, project.id);
  return { fx, project: project.id };
}

// `count` fresh eligible items of `kind`. A stage_build item is the work of
// a stage, so those come from a plan fixture.
async function freshItems(engine, project, kind, count) {
  if (kind === 'stage_build') {
    const plan = await installPlan(
      engine,
      project,
      Array.from({ length: count }, (_, i) => ({ number: i + 1, goal: `stage ${i + 1}` })),
    );
    return plan.stages.map((s) => s.work_item);
  }
  const items = [];
  for (let i = 0; i < count; i++) items.push(await addWork(engine, project, kind));
  return items;
}

const workEvents = (home, id) =>
  withStore(home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" LIKE 'work.%' AND json_extract("subject", '$.work_item') = ?`).get(id).n);

describe('M09 every edge outside the table is an atomic refusal', () => {
  for (const kind of m1Kinds()) {
    test(`${kind}: illegal edges from every status it can reach`, async (t) => {
      const { fx, project } = await pausedProject(t);
      const cases = illegalEdgeCases(kind);
      const items = await freshItems(fx.engine, project, kind, cases.length);
      let attempted = 0;
      for (const [i, c] of cases.entries()) {
        const id = items[i];
        const label = `${kind} at ${c.from}${c.continuation ? ` (continuation ${c.continuation})` : ''}`;
        assert.equal(workItem(fx.home, id).status, 'eligible', `${label}: a fixture item starts eligible`);
        await driveTo(fx.engine, id, c.route);
        const before = workItem(fx.home, id);
        const events = workEvents(fx.home, id);
        assert.equal(before.status, c.from, `${label}: reached by legal steps`);
        for (const to of c.targets) {
          assertRefused(await forceTransition(fx.engine, id, to), 409, 'illegal_transition', `${label} → ${to}`);
          attempted++;
        }
        assert.deepEqual(workItem(fx.home, id), before, `${label}: no refused edge changed the row`);
        assert.equal(workEvents(fx.home, id), events, `${label}: no refused edge wrote an event`);
        assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, id)), ['eligible', ...c.route], `${label}: the item's history is the legal route and nothing else`);
      }
      assert.ok(attempted >= 50, `${kind}: ${attempted} illegal edges attempted`);
      assert.equal(countOf(fx.home, 'runs'), 0, 'the transition route launches nothing');
    });
  }
});

describe('M09 every edge in the table is accepted', () => {
  for (const kind of m1Kinds()) {
    test(`${kind}: its path, the common templates it can reach, Stop and Abandon from every owning status`, async (t) => {
      const { fx, project } = await pausedProject(t);
      const edges = legalEdges(kind);
      const items = await freshItems(fx.engine, project, kind, edges.length);
      for (const [i, e] of edges.entries()) {
        const id = items[i];
        // A `continue` edge is legal only for the continuation the item stored.
        const route = routeTo(kind, e.from, e.via === 'continue' ? { continuation: e.to } : {});
        await driveTo(fx.engine, id, route);
        const res = await forceTransition(fx.engine, id, e.to);
        assert.equal(res.status, 200, `${kind}: ${e.from} → ${e.to} (${e.via}) is in the table (body: ${res.text})`);
        assert.equal(workItem(fx.home, id).status, e.to, `${kind}: ${e.from} → ${e.to} took effect`);
        assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, id)), ['eligible', ...route, e.to], `${kind}: one event per step`);
      }
      assert.equal(countOf(fx.home, 'runs'), 0, 'the transition route launches nothing');
    });
  }
});
