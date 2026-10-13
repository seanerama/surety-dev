// M408 (i), a confirmed requirement whose check fails on the unchanged code
// (slice 32; project lane). M5 plan §3.2 M408 (i); D6-J03 (its blocking-
// failure case); D6 §8.1 step 5, §8.3; B12; E142 item 3 (no repair before
// conformance: an adopted project whose unchanged code fails its confirmed
// baseline is visibly blocked); E141 item 4; SEAM.md §§382, 386. Split from
// `M408-the-retrofit-journey` (the driver's ruling, SEAM.md §357's way).
//
// The same adoption, with the README's false claim answered `confirm`: R4 is
// in the approved conformance set (the roadmap's phase 1, no phase 2), its
// check (`accept-r4`, GET /sum?a=x&b=3 answers 400) authored in phase 1 and
// run for real against source A, where the service answers 200. Read: the
// check fails on the unchanged code; the Verifier's finding gets no fix work
// in the conformance phase; the stage gate stays unsatisfied, naming the
// check; no Alpha (c-1 stays `developing`, no authorization); conformance is
// blocked and shown so; no source change is made.
//
// SAFETY (BS5 §4.1; E64): no environment is configured, so no service unit;
// the test signals nothing but its own engine; the file ends with
// `operatorGuard`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { operatorGuard } from './harness/deploy/host.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { candidatesOfProject, evaluationsOfKind, journeyContext, readPlan, readSpec, resultsOf, workOf } from './harness/journey/drive.mjs';
import { journeyEngine } from './harness/journey/project.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { withStore } from './harness/store.mjs';
import { adoptProject, chooseMode, confirmAndApprove, conformanceStages, gateReasons, pump, retrofitArchitectSession, retrofitScripts, retrofitSpecSession } from './harness/retrofit/drive.mjs';
import { conformanceStage, roadmapJson } from './harness/retrofit/products.mjs';

const resultsOfKey = (home, project, key) =>
  withStore(home, (db) => db.prepare('SELECT r.* FROM "check_results" r JOIN "checks" c ON c."id" = r."check" WHERE r."project" = ? AND c."key" = ? ORDER BY r."execution_seq"').all(project, key));

describe('M408 (i) a confirmed requirement that fails on the unchanged code blocks conformance, visibly', () => {
  const shared = sharedFixture();
  let guard;
  let J;
  before(async () => {
    guard = operatorGuard();
    const fx = await journeyEngine(shared.context, guard, { lane: 'project' });
    retrofitScripts(fx, { withR4: true });
    // The Verifier reports the failing check as a finding on c-1.
    fx.scripted.kindScript('verification', roleThat([], { findings: [{ category: 'defect', severity: 'medium', message: 'GET /sum?a=x&b=3 answers 200, not 400', check: 'accept-r4', criterion: 'R4.1' }] }));
    const p = await adoptProject(fx);
    await chooseMode(fx, p.id, 'full');
    await retrofitSpecSession(fx, p.id);
    await confirmAndApprove(fx, p.id, { R1: 'confirm', R2: 'confirm', R3: 'confirm', R4: 'confirm' });
    await retrofitArchitectSession(fx, p.id, p.repo, { roadmap: roadmapJson({ phase1: ['R1', 'R2', 'R3', 'R4'], phase2: [] }), stages: [conformanceStage({ implements: ['R1', 'R2', 'R3', 'R4'] })] });
    const ctx = journeyContext(fx, { id: p.id, repo: p.repo }, { lane: 'project', tier: 'T1' });
    // Until accept-r4 has a result on c-1 and the stage gate was evaluated after it.
    await pump(fx, ctx, () => {
      const c1 = candidatesOfProject(fx.home, p.id)[0];
      if (!c1) return undefined;
      const r4 = resultsOfKey(fx.home, p.id, 'accept-r4').filter((r) => r.candidate === c1.id);
      const gate = evaluationsOfKind(fx.home, p.id, 'stage').filter((e) => e.candidate === c1.id).at(-1);
      return r4.length > 0 && gate && gate.created_at >= r4.at(-1).created_at ? true : undefined;
    }, { what: 'accept-r4 run on c-1 and the stage gate after it' });
    // A few more rounds: nothing unblocks it.
    for (let i = 0; i < 3; i++) await pump(fx, ctx, () => undefined, { projectMs: 60_000 }).catch(() => null);
    J = { fx, p, ctx, c1: candidatesOfProject(fx.home, p.id)[0] };
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(i) accept-r4 fails on source A: run for real, no fix work, the gate unsatisfied naming the check, no Alpha, conformance blocked and shown; no source change', async () => {
    const { fx, p, c1 } = J;
    const r4 = resultsOfKey(fx.home, p.id, 'accept-r4').filter((r) => r.candidate === c1.id);
    assert.ok(r4.length > 0 && r4.every((r) => r.exit_status !== 0 && r.runner_id !== 'test_fixture'), `accept-r4 failed, run by the engine's runner (${JSON.stringify(r4.map((r) => [r.exit_status, r.runner_id]))})`);
    assert.ok(resultsOf(fx.home, p.id).filter((r) => r.candidate === c1.id && r.exit_status === 0).length > 0, 'the fixture is live: the other checks passed on the same candidate');
    assert.deepEqual(workOf(fx.home, p.id, 'fix'), [], 'no fix work in the conformance phase');
    assert.deepEqual(workOf(fx.home, p.id, 'stage_build'), [], 'no source change: no Builder');
    const gate = evaluationsOfKind(fx.home, p.id, 'stage').filter((e) => e.candidate === c1.id).at(-1);
    assert.notEqual(gate.outcome, 'satisfied', 'the stage gate unsatisfied');
    assert.match(JSON.stringify(gate.reasons), /accept-r4|R4\.1/, `naming the check or its criterion (${JSON.stringify(gateReasons(gate))})`);
    assert.equal(candidatesOfProject(fx.home, p.id).find((c) => c.id === c1.id).progress, 'developing', 'no Alpha: c-1 still developing');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "deployment_authorizations" WHERE "candidate" = ?').get(c1.id).n), 0, 'and no authorization');
    const [stage] = conformanceStages(fx.home, p.id);
    assert.equal(stage.conformance_state, 'blocked', 'conformance blocked');
    const shown = JSON.stringify(await readPlan(fx, p.id)) + JSON.stringify(await readSpec(fx, p.id));
    assert.match(shown, /blocked/, 'and shown so on the owner\'s reads');
  });
});
