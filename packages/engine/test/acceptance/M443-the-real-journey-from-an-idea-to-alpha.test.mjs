// M443, the real journey from an idea to Alpha (M5 slice 38; REAL LANE,
// manifest `real`). M5 plan §3.8 M443; D6-J02; D6 §1; E139 items 6 and 7
// (Q6, Q7); BS5 §12; SEAM.md §456. PAID, ONLY BY SEAN'S COMMAND (the
// driver's under his delegation, E144 item 2), on his subscription token,
// never in `npm test` or a slice, and run ALONE with `node --test` after
// `npm run build`, never with `run-tests.mjs --lane real`. Sean's steps:
// docs/acceptance/reports/M5-real-lane/README.md.
//
// Claude Code on Sean's subscription token; Opus for the sessions, Sonnet
// for the one-shots; T2, two phases of two stages, one specification change,
// `autonomy: phase`, `alpha_deploy: on_phase_complete`. The steps
// (harness/real/m5-lane.mjs, M443_STEPS): the two attempts and their
// activation; the project created with its idea; Vision (skippable,
// recorded); Sean's Spec Writer and Architect sessions and approvals; phase
// 1 by real roles; the change; Sean's qualify-adapter; phase 2; Alpha
// requested by the engine under policy, deployed, verified; the teardown in
// the deployment's `finally`.
//   (a) `session_qualified` true from the continuation canary; both entries
//       active (Opus, Sonnet);
//   (b) each session's turns metered (a ledger row each); each product
//       parsed and approved by Sean's answer (or the driver's on his
//       instruction, recorded as such);
//   (c) phase 1: `check_authoring`'s proposal approved by Sean; every check
//       result an engine execution; both stages verified; the phase
//       complete; the replan registered;
//   (d) the change: the impact shown, approved, its invalidation and its
//       correction done (spec version 2);
//   (e) phase 2 as (c);
//   (f) Sean's qualify-adapter, the engine's request under policy,
//       `alpha_authorize` satisfied, `verified`, `alpha_deployed` on a real
//       unit of the run home's prefix;
//   (g) the teardown applied, nothing of the prefix left; `pace.json`
//       recorded; no check result by a fixture; the token in no file of the
//       run directory, no git object, no unit property, no journal output.
//
// The dress rehearsal (SURETY_REAL_REHEARSAL=1, the fake claude, SEAM.md
// §§171, 456): the package-driven fakes play every role from its package;
// it is never evidence, and it must pass on the revision run before any paid
// run (BS5 §12).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { REAL_TEST_TIMEOUT_MS, judged, readObserved, realPreflight, stepValue } from './harness/real/lane.mjs';
import {
  CONFIRM_PHRASE_M443,
  M443_STEPS,
  MODELS,
  checkHome,
  homeOf,
  m5Activation,
  m5Attempts,
  m5aAlpha,
  m5aArchitecture,
  m5aChange,
  m5aCreate,
  m5aPhase1,
  m5aPhase2,
  m5aQualify,
  m5aRecords,
  m5aSpec,
  m5aVision,
  showCost,
} from './harness/real/m5-lane.mjs';
import { tallyContent } from './harness/real/rehearsal-content.mjs';
import { withStore } from './harness/store.mjs';
import { trustEntries } from './harness/trust.mjs';

const preflight = () => {
  const ctx = realPreflight({ confirm: CONFIRM_PHRASE_M443, order: M443_STEPS });
  checkHome(ctx);
  showCost(ctx, 'M443');
  return ctx;
};
const rows = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).all(...p));
const show = (v) => JSON.stringify(v)?.slice(0, 2000);
// A phase's stages as the engine keeps them across an early replacement
// (D6 §5.7; E148 item 3): kept stages stay on their own generation's plan
// row, so every plan of the phase is read, and a cancelled stage is not the
// phase's.
const stagesOfPhase = (home, project, phase) =>
  rows(home, `SELECT s."number", s."status" FROM "stages" s JOIN "phase_plans" p ON p."id" = s."phase_plan" WHERE p."project" = ? AND p."phase_number" = ? AND s."status" <> 'cancelled' ORDER BY s."number"`, project, phase);

// The journey's steps in order, each run at most once per run directory, up to `last`.
async function upTo(ctx, last) {
  const steps = [
    ['m5_attempt_sonnet', () => m5Attempts(ctx, 'M443')],
    ['m5_activation', () => m5Activation(ctx, 'M443', tallyContent())],
    ['m5a_create', () => m5aCreate(ctx)],
    ['m5a_vision', () => m5aVision(ctx)],
    ['m5a_spec', () => m5aSpec(ctx)],
    ['m5a_architecture', () => m5aArchitecture(ctx)],
    ['m5a_phase1', () => m5aPhase1(ctx)],
    ['m5a_change', () => m5aChange(ctx)],
    ['m5a_qualify', () => m5aQualify(ctx)],
    ['m5a_phase2', () => m5aPhase2(ctx)],
    ['m5a_alpha', () => m5aAlpha(ctx)],
  ];
  for (const [name, run] of steps) {
    await run();
    if (name === last) return;
  }
}

// A read of the run home's store (read only; no engine started for it).
const store = async (ctx, fn) => fn(homeOf(ctx));

describe('M443 the real journey from an idea to Alpha (real lane, paid)', () => {
  test('(a) the attempts: session_qualified true from the continuation canary; the Opus and Sonnet entries active', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M443 (a)', async () => {
      await upTo(ctx, 'm5_activation');
      const act = stepValue(ctx, 'm5_activation');
      await store(ctx, (home) => {
        const entries = trustEntries(home);
        const opus = entries.find((e) => e.id === act.opus?.entry);
        const sonnet = entries.find((e) => e.id === act.sonnet?.entry);
        assert.deepEqual([opus?.status, opus?.model, Boolean(opus?.session_qualified)], ['active', MODELS.sessions, true], `the Opus entry active and session_qualified (${show(opus)})`);
        assert.deepEqual([sonnet?.status, sonnet?.model], ['active', MODELS.one_shots], `the Sonnet entry active (${show(sonnet)})`);
        if (!ctx.rehearsal) {
          const a = stepValue(ctx, 'm5_attempt_opus');
          if (a.path === 'attempt') assert.equal(a.status, 'succeeded', 'the Opus attempt, its continuation canary among its canaries, succeeded');
        }
      });
    });
  });

  test("(b) Sean's sessions: each turn metered with its ledger row; each product parsed and approved by his answer", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M443 (b)', async () => {
      await upTo(ctx, 'm5a_architecture');
      const { project } = stepValue(ctx, 'm5a_create');
      await store(ctx, (home) => {
        const sessions = rows(home, `SELECT "id", "role", "outcome" FROM "runs" WHERE "project" = ? AND "kind" = 'session' ORDER BY "seq"`, project);
        assert.ok(['spec_writer', 'architect'].every((r) => sessions.some((s) => s.role === r)), `a Spec Writer and an Architect session (${show(sessions)})`);
        for (const s of sessions) {
          const turns = rows(home, 'SELECT * FROM "turns" WHERE "run" = ? ORDER BY "number"', s.id);
          const ledger = rows(home, 'SELECT * FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL', s.id);
          assert.ok(turns.length > 0 && ledger.length === turns.length, `session ${s.id} (${s.role}): every turn metered (${turns.length} turns, ${ledger.length} ledger rows)`);
          if (!ctx.rehearsal) assert.ok(ledger.every((l) => l.model_requested === MODELS.sessions), `on ${MODELS.sessions}`);
        }
        const answered = (kind) => rows(home, `SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = ? AND "status" = 'consumed'`, project, kind).map((d) => JSON.parse(d.answer ?? 'null'));
        for (const kind of ['spec_approval', 'architecture_approval', 'plan_approval']) {
          const a = answered(kind);
          assert.ok(a.some((x) => x?.option === 'approve' && x?.actor === 'human'), `${kind} answered approve by the owner (${show(a)})`);
        }
        assert.ok(rows(home, 'SELECT * FROM "spec_revisions" WHERE "project" = ?', project).length >= 1, 'the specification approved (spec_revisions 1)');
      });
    });
  });

  test("(c) phase 1 by real roles: the authoring's proposal approved by Sean, every check result an engine execution, both stages verified, the phase complete, the replan registered", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M443 (c)', async () => {
      await upTo(ctx, 'm5a_phase1');
      const { project } = stepValue(ctx, 'm5a_create');
      const p1 = stepValue(ctx, 'm5a_phase1');
      await store(ctx, (home) => {
        const authoring = rows(home, `SELECT d.* FROM "decisions" d WHERE d."project" = ? AND d."kind" LIKE 'check_correction_%' AND d."status" = 'consumed' ORDER BY rowid`, project);
        assert.ok(authoring.some((d) => JSON.parse(d.answer ?? 'null')?.actor === 'human'), `the toolchain's proposal answered by the owner (${show(authoring.map((d) => [d.kind, d.answer]))})`);
        const results = rows(home, 'SELECT * FROM "check_results" WHERE "project" = ?', project);
        assert.ok(results.length > 0 && results.every((r) => r.execution !== null && r.runner_id !== 'test_fixture'), `every check result an engine execution (${results.length})`);
        const plan1 = rows(home, 'SELECT * FROM "phase_plans" WHERE "id" = ?', p1.value.phase1)[0];
        const stages = stagesOfPhase(home, project, 1);
        assert.ok(stages.length >= 1 && stages.every((s) => s.status === 'verified'), `phase 1's stages verified (${show(stages)})`);
        assert.ok(plan1.completed_at, 'phase 1 complete');
        assert.ok(rows(home, `SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'replan'`, project).length >= 1, 'the replan registered');
      });
    });
  });

  test('(d) the change: the impact shown, approved by Sean, its invalidation and its correction done', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M443 (d)', async () => {
      await upTo(ctx, 'm5a_change');
      const { project } = stepValue(ctx, 'm5a_create');
      await store(ctx, (home) => {
        const change = rows(home, `SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = 'spec_change' AND "status" = 'consumed'`, project);
        assert.ok(change.some((d) => JSON.parse(d.answer ?? 'null')?.option === 'approve'), 'the spec_change decision, its impact as evidence, approved');
        assert.ok(rows(home, 'SELECT * FROM "spec_revisions" WHERE "project" = ? AND "version" = 2', project).length === 1, 'spec version 2');
        const obligations = rows(home, `SELECT * FROM "check_obligations" WHERE "project" = ? AND "reason" = 'spec_changed'`, project);
        assert.ok(obligations.every((o) => o.resolved_at), `every obligation the change recorded resolved (${show(obligations)})`);
      });
    });
  });

  test('(e) phase 2 by real roles: its stages verified, the phase complete, every check result an engine execution', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M443 (e)', async () => {
      await upTo(ctx, 'm5a_phase2');
      const { project } = stepValue(ctx, 'm5a_create');
      await store(ctx, (home) => {
        const plan2 = rows(home, `SELECT * FROM "phase_plans" WHERE "project" = ? AND "phase_number" = 2 AND "active" = 1`, project)[0];
        assert.ok(plan2?.completed_at, `phase 2 complete (${show(plan2)})`);
        const stages = stagesOfPhase(home, project, 2);
        assert.ok(stages.length >= 1 && stages.every((s) => s.status === 'verified'), `phase 2's stages verified (${show(stages)})`);
        const results = rows(home, 'SELECT * FROM "check_results" WHERE "project" = ?', project);
        assert.ok(results.every((r) => r.execution !== null && r.runner_id !== 'test_fixture'), 'every check result an engine execution');
      });
    });
  });

  test("(f) Sean's qualify-adapter; the engine's request under policy; alpha_authorize satisfied; verified; alpha_deployed on a real unit of the run home's prefix", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M443 (f)', async () => {
      await upTo(ctx, 'm5a_alpha');
      const q = stepValue(ctx, 'm5a_qualify');
      assert.equal(q.row?.status, 'current', `the adapter qualified by ${q.by} (${show(q.row)})`);
      const a = stepValue(ctx, 'm5a_alpha');
      assert.equal(a.candidate.progress, 'alpha_deployed', 'alpha_deployed');
      assert.ok(a.requests.some((r) => r.requested_by === 'policy'), `requested by the engine under policy (${show(a.requests)})`);
      assert.equal(a.alpha_authorize?.outcome, 'satisfied', `alpha_authorize satisfied (${show(a.alpha_authorize)})`);
      assert.equal(a.alpha_complete?.outcome, 'satisfied', 'alpha_complete satisfied: verified');
      assert.ok(a.host.length > 0 && a.host.every((h) => h.props?.ActiveState === 'active'), `the service on a real unit of the prefix, active while read (${show(a.host)})`);
      assert.ok(a.host.every((h) => h.token_hits === 0), 'the token in no unit property');
    });
  });

  test('(g) the teardown applied, nothing of the prefix left; pace.json recorded; no check result by a fixture; the token in no file, git object or journal output', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M443 (g)', async () => {
      await upTo(ctx, 'm5a_alpha');
      const t = stepValue(ctx, 'm5a_teardown');
      assert.equal(t.applied, true, `the teardown applied (${show(t)})`);
      assert.deepEqual(t.left, { units: [], cgroups: [], run_files: [] }, 'nothing of the run home\'s prefix left');
      assert.deepEqual(t.journal_search.filter((j) => j.hits !== 0).map((j) => j.unit), [], 'the token in no journal output');
      const r = await m5aRecords(ctx);
      assert.equal(r.pace_status, 200, 'the pace read answered and pace-M443.json written');
      assert.deepEqual(r.results.filter((x) => x.execution === null || x.runner_id === 'test_fixture').map((x) => x.id), [], 'no check result by a fixture');
      assert.equal(r.token.hits, 0, `the ${ctx.authMode} credential in no file of the run directory and no git object`);
      assert.ok(readObserved(ctx, 'M443').records, 'the records kept for the report');
    });
  });
});
