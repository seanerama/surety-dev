// M436 (e)'s project-lane part: M401's project at `phase` with no boundary
// but the routed ones (slice 37; project lane, run with `npm test` like the
// sandbox lane, E92 item 2 (1)). M5 plan §3.7 M436 (e) ("project lane:
// M401's project at `phase` with no boundary but the routed ones"); D6-X03;
// D6 §6.5; F §9.1; E10; the driver's ruling Q14 of slice 37 (phase 1 to
// phase 2 published only: M401 part 2 counts the human acts to Alpha);
// BS5 §4.1 rules 12, 13 (met in slice 31), 20; SEAM.md §§356, 357, 440
// The kernel-lane cases of the row are `M436-the-autonomy-profiles` and
// `M436-the-floor-under-phase`.
//
// The reference project "Tally" (T2) on real `role` and `check` domains, the
// check runner self-tested at every start, `classifier_authority`
// `authoritative`, carried by the owner's routes and the engine's
// transitions from the idea to phase 2 published (`toPhaseTwoPublished`,
// part 1's path); nothing installed by fixture (rule 20). From the
// consolidated approval to phase 2's publication: the only decision raised
// and the only human act is the toolchain's unclassifiable correction (Q9);
// no chain boundary and no blocker; every launched one-shot has its ledger
// row; every check result on the project's candidates is an engine
// execution by a self-tested runner, none a fixture's.
//
// SAFETY (BS5 §4.1; E64; SEAM.md §§257, 356, 357). The test acts on no unit
// and signals nothing but its own engine (the verified kill); no environment
// is configured, so no unit is created; the file ends with `operatorGuard`;
// every engine start carries the real-adapter switch and the runner
// self-test.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { operatorGuard } from './harness/deploy/host.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { buildActs, resultsOf, runsOfProject } from './harness/journey/drive.mjs';
import { journeyEngine, toPhaseTwoPublished } from './harness/journey/project.mjs';
import { boundaryDecisions, decisionsSince, ledgerByRun, workRow } from './harness/exec37/autonomy.mjs';
import { withStore } from './harness/store.mjs';

describe('M436 (e) the phase profile on the project lane: the idea to phase 2 published with no boundary but the routed one', () => {
  const shared = sharedFixture();
  let guard;
  let J;
  before(async () => {
    guard = operatorGuard();
    const fx = await journeyEngine(shared.context, guard, { lane: 'project' });
    J = { fx, ...(await toPhaseTwoPublished(fx, { lane: 'project' })) };
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(e) from the publication to phase 2 published: the toolchain correction the only decision and the only human act; no chain boundary, no blocker', () => {
    const { fx, p, plan, ctx } = J;
    // The decisions raised after the publication (phase 1's plan row is written by the consolidated approval).
    const published = withStore(fx.home, (db) => db.prepare('SELECT MAX("seq") AS n FROM "decisions" WHERE "project" = ? AND "kind" IN (\'architecture_approval\', \'plan_approval\')').get(p.id).n);
    const raised = decisionsSince(fx.home, p.id, published);
    // Objection 105 (SEAM.md §451): under `authoritative` phase 2's authoring
    // tightening raises its question beside the Reviewer's review; the
    // Reviewer applies it, and no person answers it. So the questions raised
    // are the toolchain's correction and, at most, that tightening's.
    const show = JSON.stringify(raised.map((d) => [d.kind, d.subject_type, d.status, d.dependency_manifest?.cause ?? null]));
    assert.equal(raised.filter((d) => d.kind === 'check_correction_unclassifiable').length, 1, `the toolchain's correction raised once (${show})`);
    assert.ok(raised.every((d) => ['check_correction_unclassifiable', 'check_correction_tightening'].includes(d.kind)), `no other question raised (${show})`);
    for (const d of raised.filter((x) => x.kind === 'check_correction_tightening')) {
      const answer = d.answer ? (typeof d.answer === 'string' ? JSON.parse(d.answer) : d.answer) : null;
      assert.notEqual(answer?.actor, 'human', `the tightening's question is answered by no person (${JSON.stringify({ status: d.status, answer })})`);
    }
    assert.deepEqual(buildActs(ctx).map((a) => a.kind), ['check_correction_unclassifiable'], 'the one human act within the build (Q9)');
    assert.deepEqual(boundaryDecisions(fx.home, p.id), [], 'no chain boundary');
    assert.ok(plan, 'the fixture is live: phase 1 published');
    assert.ok(J.phase2Plan, 'and phase 2 published by the replan');
  });

  test('(e) every launched one-shot metered; every check result an engine execution by a self-tested runner', () => {
    const { fx, p } = J;
    const ledger = ledgerByRun(fx.home, p.id);
    // A run is charged at its terminal observation (D1 §13.1), so a run still
    // in flight is read once it has ended: under K1 the publication of phase 2
    // dispatches its check_authoring at once (objection 096).
    const unmetered = runsOfProject(fx.home, p.id).filter((r) => r.started_at && r.kind !== 'session' && r.state === 'ended' && !ledger.has(r.id));
    assert.deepEqual(unmetered.map((r) => [r.id, workRow(fx.home, r.work_item)?.kind]), [], 'a ledger row for every launched one-shot that has ended (E10)');
    assert.ok(runsOfProject(fx.home, p.id).filter((r) => r.started_at && r.kind !== 'session' && r.state === 'ended').length >= 5, 'the fixture is live: the phase\'s one-shots have ended');
    const results = resultsOf(fx.home, p.id);
    assert.ok(results.length > 0, 'the fixture is live: checks ran');
    assert.deepEqual(results.filter((r) => !r.runner_id || r.runner_id === 'test_fixture').map((r) => r.id), [], 'no result recorded by a fixture');
  });
});
