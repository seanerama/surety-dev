// M444, the real retrofit journey (M5 slice 38; REAL LANE, manifest
// `real`). M5 plan §3.8 M444; D6-J04; D6 §8.5; E140 N3; E141 item 3; E144
// item 1; BS5 §12; SEAM.md §456. PAID, ONLY BY SEAN'S COMMAND (the
// driver's under his delegation, E144 item 2), on his subscription token,
// run ALONE with `node --test` after `npm run build`, never with
// `run-tests.mjs --lane real`, in the run directory of M443 (one home, the
// attempts paid once). Sean's steps: docs/acceptance/reports/M5-real-lane/README.md.
//
// The M4 real run's Builder repository, copied from
// `~/surety-m4-real-20261012/repos/` with its recorded head checked against
// M4's state.json and one recorded preparation commit removing its Surety
// records (E144 item 1); reconstruction (the retrofit fixture's repository,
// labelled) the stated fallback. `full` mode, T1, `alpha_deploy: manual`.
// The steps (M444_STEPS): Sean's `surety project adopt` and `adoption_mode`;
// his retrofit Spec Writer session, his confirmations and approval; his
// Architect session and the conformance plan; the conformance phase (a real
// Verifier authoring and adopting, the toolchain approved, the conformance
// stage with no Builder against source A, phase verification); his
// qualify-adapter; his `surety deploy` of c-1, which opens the Alpha
// barrier, with the teardown in its `finally`; the replan after
// `alpha_complete`; one phase-2 stage by a real Builder.
//   (a) as M409: the adoption pinned A, the signals, the mode Sean chose;
//   (b) `spec_claims` recorded; each produced requirement answered by Sean,
//       recorded with his option;
//   (c) one `conformance` stage registered for the approved conformance set;
//   (d) `adopted_tests` with the dependency boundary on the authoring
//       proposal where the Verifier adopted any, the copies under the
//       protected root; the toolchain approved;
//   (e) no `stage_build` in phase 1; c-1's application source A; its checks
//       engine-run; the gate as the checks decide, blocked and visible if a
//       confirmed requirement fails (B12: recorded, never moved);
//   (f) `alpha_deployed` for c-1, the pending requirements shown; the
//       `replan` created only after `alpha_complete`;
//   (g) the phase-2 stage verified;
//   (h) the teardown applied, nothing left; the claims and confirmations
//       kept for the report; the token absent as M443 (g); the run's scale
//       stated as small.
//
// The dress rehearsal (SURETY_REAL_REHEARSAL=1) adopts the retrofit
// fixture's repository and plays every role from its package; never
// evidence; it must pass on the revision run before any paid run.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { REAL_TEST_TIMEOUT_MS, judged, realPreflight, stepValue } from './harness/real/lane.mjs';
import {
  CONFIRM_PHRASE_M444,
  M444_STEPS,
  checkHome,
  markRunKind,
  homeOf,
  m5Activation,
  m5Attempts,
  m5rAdopt,
  m5rArchitecture,
  m5rConformance,
  m5rDeploy,
  m5rPhase2,
  m5rQualify,
  m5rRecords,
  m5rReplan,
  m5rSpec,
  m5rTeardown,
  showCost,
} from './harness/real/m5-lane.mjs';
import { sumsContent } from './harness/real/rehearsal-content.mjs';
import { withStore } from './harness/store.mjs';

const preflight = () => {
  const ctx = realPreflight({ confirm: CONFIRM_PHRASE_M444, order: M444_STEPS });
  checkHome(ctx);
  markRunKind(ctx);
  showCost(ctx, 'M444');
  return ctx;
};
const rows = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).all(...p));
const show = (v) => JSON.stringify(v)?.slice(0, 2000);
const json = (t) => (t === null || t === undefined ? t : typeof t === 'string' ? JSON.parse(t) : t);

async function upTo(ctx, last) {
  const steps = [
    ['m5_activation', async () => (await m5Attempts(ctx, 'M444'), m5Activation(ctx, 'M444', sumsContent()))],
    ['m5r_adopt', () => m5rAdopt(ctx)],
    ['m5r_spec', () => m5rSpec(ctx)],
    ['m5r_architecture', () => m5rArchitecture(ctx)],
    ['m5r_conformance', () => m5rConformance(ctx)],
    ['m5r_qualify', () => m5rQualify(ctx)],
    ['m5r_deploy', () => m5rDeploy(ctx)],
    // Its own recorded step, rerun alone by SURETY_REAL_RERUN=m5r_teardown without losing m5r_deploy's records (README §4).
    ['m5r_teardown', () => m5rTeardown(ctx)],
    ['m5r_replan', () => m5rReplan(ctx)],
    ['m5r_phase2', () => m5rPhase2(ctx)],
  ];
  for (const [name, run] of steps) {
    await run();
    if (name === last) return;
  }
}

describe('M444 the real retrofit journey (real lane, paid)', () => {
  test("(a) Sean's adoption: A pinned before the bootstrap, the signals, the mode he chose (full)", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M444 (a)', async () => {
      await upTo(ctx, 'm5r_adopt');
      const a = stepValue(ctx, 'm5r_adopt');
      assert.equal(a.adoption?.pinned_revision, a.source.prepared, `A is the prepared head of the copied repository (${show(a.adoption)})`);
      assert.ok(a.adoption?.signals && typeof a.adoption.signals === 'object', 'the signals recorded');
      assert.equal(a.mode, 'full', 'adoption_mode answered full');
    });
  });

  test("(b) the retrofit Spec Writer's claims recorded; each produced requirement answered by Sean with his option", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M444 (b)', async () => {
      await upTo(ctx, 'm5r_spec');
      const s = stepValue(ctx, 'm5r_spec');
      assert.ok(s.claims.length > 0, `spec_claims recorded (${show(s.claims)})`);
      const produced = s.requirements.filter((r) => r.reverse_engineered === 1 || r.reverse_engineered === true);
      assert.ok(produced.length > 0, 'requirements produced in retrofit mode, reverse_engineered');
      assert.ok(s.confirms.length >= produced.length && s.confirms.every((c) => c.status === 'consumed'), `each produced requirement's requirement_confirm answered (${show(s.confirms)})`);
      assert.ok(s.confirms.every((c) => ['confirm', 'defect', 'withdraw'].includes(json(c.answer)?.option)), 'each with the owner\'s option');
    });
  });

  test('(c) one conformance stage registered for the approved conformance set', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M444 (c)', async () => {
      await upTo(ctx, 'm5r_architecture');
      const a = stepValue(ctx, 'm5r_architecture');
      assert.equal(a.conformance_stages.length, 1, `one conformance stage (${show(a.conformance_stages)})`);
    });
  });

  test("(d) the real Verifier's authoring: adopted tests with their dependency boundary on the proposal where any were adopted, copies under the protected root; the toolchain approved", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M444 (d)', async () => {
      await upTo(ctx, 'm5r_conformance');
      const { project } = stepValue(ctx, 'm5r_adopt');
      const home = homeOf(ctx);
      const proposals = rows(home, 'SELECT * FROM "protected_proposals" WHERE "project" = ? ORDER BY "seq"', project);
      assert.ok(proposals.some((p) => p.status === 'applied'), `a proposal applied (${show(proposals.map((p) => [p.id, p.status]))})`);
      for (const p of proposals) {
        const adopted = json(p.adopted_tests ?? null) ?? [];
        for (const t of adopted) {
          assert.ok(Array.isArray(t.dependency_boundary) && t.dependency_boundary.length > 0, `${t.to}: its dependency boundary (${show(t)})`);
          assert.ok(String(t.to).startsWith('.surety/checks/'), `${t.to}: the copy under the protected root`);
        }
      }
      const toolchain = rows(home, `SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = 'check_correction_unclassifiable' AND "status" = 'consumed'`, project);
      assert.ok(toolchain.some((d) => json(d.answer)?.actor === 'human' && json(d.answer)?.option === 'approve'), 'the toolchain proposal approved by the owner');
    });
  });

  test("(e) conformance: no stage_build in phase 1; c-1's application source A; its checks engine-run; the gate as the checks decide", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M444 (e)', async () => {
      await upTo(ctx, 'm5r_conformance');
      const c = stepValue(ctx, 'm5r_conformance');
      const a = stepValue(ctx, 'm5r_adopt');
      assert.equal(c.builds, 0, 'no stage_build work in the conformance phase');
      const st = c.stages.find((s) => s.conformance === 1);
      assert.equal(st?.source_revision, a.adoption.pinned_revision, `the conformance stage bound to A (${show(st)})`);
      const results = rows(homeOf(ctx), 'SELECT * FROM "check_results" WHERE "project" = ?', a.project);
      assert.ok(results.length > 0 && results.every((r) => r.execution !== null && r.runner_id !== 'test_fixture'), 'every check result an engine execution');
      // B12: blocked and visible when a confirmed requirement fails; recorded either way.
      assert.ok(['conformed', 'blocked'].includes(c.value.state) || c.value.plan, `the conformance stage's state as the checks decided (${show(c.value)})`);
    });
  });

  test("(f) Sean's deploy of c-1: alpha_deployed, the pending requirements shown; the replan created only after alpha_complete", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M444 (f)', async () => {
      await upTo(ctx, 'm5r_replan');
      const d = stepValue(ctx, 'm5r_deploy');
      assert.equal(d.progress, 'alpha_deployed', 'c-1 alpha_deployed');
      assert.equal(d.alpha_complete?.outcome, 'satisfied', 'alpha_complete satisfied');
      const r = stepValue(ctx, 'm5r_replan');
      const complete = r.alpha_complete.find((e) => e.outcome === 'satisfied');
      assert.ok(complete && r.replans.every((w) => w.created_at >= complete.created_at), `every replan created after alpha_complete (${show(r)})`);
    });
  });

  test('(g) one phase-2 stage built by a real Builder and verified', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M444 (g)', async () => {
      await upTo(ctx, 'm5r_phase2');
      const p = stepValue(ctx, 'm5r_phase2');
      assert.ok(p.stages.length >= 1 && p.stages.every((s) => s.status === 'verified'), `phase 2 verified (${show(p.stages)})`);
      assert.ok(p.builds.length >= 1, 'built by a Builder');
    });
  });

  test('(h) the teardown applied, nothing left; the claims and confirmations kept; the token absent; the run\'s scale stated as small', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M444 (h)', async () => {
      await upTo(ctx, 'm5r_phase2');
      const t = stepValue(ctx, 'm5r_teardown');
      assert.equal(t.applied, true, `the teardown applied (${show(t)})`);
      assert.deepEqual(t.left, { units: [], cgroups: [], run_files: [] }, "nothing of the run home's prefix left");
      assert.deepEqual(t.journal_search.filter((j) => j.hits !== 0).map((j) => j.unit), [], 'the token in no journal output');
      const r = await m5rRecords(ctx);
      assert.equal(r.pace_status, 200, 'the pace read answered and pace-M444.json written');
      assert.equal(r.token.hits, 0, 'the credential in no file of the run directory and no git object');
      assert.deepEqual(r.results.filter((x) => x.execution === null || x.runner_id === 'test_fixture').map((x) => x.id), [], 'no check result by a fixture');
    });
  });
});
