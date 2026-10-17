// M535, the real run second: the M6 journey, a web design, a labelled
// mobile simulation and a held logo (M6 slice 46; REAL LANE, manifest
// `real`). M6 plan §3.8 M535; D7 Appendix C M535, §1 "The next proof"; BS6
// §12, §4.1 rules 21 to 26; E156 Q5, Q6; SEAM.md §§541 to 543. PAID, ONLY BY
// SEAN'S COMMAND (the driver's under his standing delegation, E144 item 2),
// on his subscription token, never in `npm test` or a slice, and run ALONE
// with `node --test` after `npm run build`, never with `run-tests.mjs --lane
// real`. It refuses to start before M519's defects are resolved and its own
// rehearsal has passed on the revision it runs (E156 Q5; (k)). Sean's steps:
// docs/acceptance/reports/M6-real-lane/README.md.
//
// As M519's setting, from the purpose-written brief
// (docs/acceptance/reports/M6-real-lane/m535-brief.md, SURETY_M535_BRIEF):
// `**Targets:** web, android` (`html_css`, `react_native`),
// `**Cross-platform:** yes`, `design: both`, a day limit of 50 USD. SEAN
// PERFORMS FOUR ACTS HIMSELF (E156 Q6): the Designer feedback (his own turns
// in the Designer session), the preview inspection (the relay, the web
// mockup and the android simulation in his own browser), the combined
// approval (the logo held) and the review's confirmation; each evidenced by
// his own entry (owner-act.mjs, his terminal). The driver may perform the
// others under recorded instructions (driver-act.mjs).
//   (a) the sessions: each turn metered; the Designer's design passing its
//       check; the preview deployed, opened through the relay, torn down;
//   (b) the preview: the web mockup served bare, the android mockup inside
//       the engine's labelled frame (the runner's own read through its own
//       relay, never Sean's inspection); SIMULATIONS.txt on export naming
//       the android mockup;
//   (c) the first approval with the logo held: the effective logo the
//       placeholder (or an earlier approved file);
//   (d) the UI stages: each Builder package holding the effective logo by
//       digest, never the held one, and each check reading the logo on the
//       effective slot@version, never the held one; bindings recorded;
//   (e) the held logo approved by an asset-only approval: the effective
//       version moved; one `asset_updated` item from the bindings;
//   (f) its integration: `asset_version_changed` obligations resolved; the
//       parity checks passing with the new slot@version on their results;
//   (g) `alpha_deployed`;
//   (h) the review: the web screens reviewed from the engine's
//       observations; android `not_observed` `no_native_runtime`, its human
//       test pending;
//   (i) as M519 (g): teardown, records, pace, the token nowhere;
//   (j) as M519 (h): rule 25 at every step's end;
//   (k) its start: refused unless M519's state.json records every step
//       passed with none passed only by a workaround, each M519 finding
//       resolved by a fix commit this revision contains (or none found), and
//       M535's dress rehearsal recorded passed on this revision;
//   (l) the owner's acts: the four central acts performed by Sean, each with
//       his own entry (and for the preview the relay's record, here its
//       openings and closings, since neither the relay nor the preview
//       server records the requests it serves); every other act's performer
//       as M519 (i); an API actor `human` alone never counted as Sean's.
//
// The dress rehearsal (SURETY_REAL_REHEARSAL=1): the package-driven fakes
// play every role from its package, the Designer's among them; the harness
// acts for the owner, supplies the held slot's file by `surety design asset
// add`, and records itself as the performer `rehearsal` (so (l) there shows
// that no act is Sean's); never evidence. When every case passes it writes
// `rehearsal-passed.json`, read by the paid run (SURETY_M535_REHEARSAL_DIR).

import { describe, test } from 'node:test';

import { REAL_TEST_TIMEOUT_MS, judged, readObserved, stepValue } from './harness/real/lane.mjs';
import {
  CENTRAL_ACTS,
  M519_JOURNEY_STEPS,
  MODELS,
  assert,
  bindingsOf,
  designRevisionsOf,
  homeOfRun,
  m6Preflight,
  m6Records,
  markRehearsalPassed,
  previewsOf,
  readActs,
  relayEvents,
  upTo,
} from './harness/real/m6-lane.mjs';
import { withStore } from './harness/store.mjs';

const ROW = 'M535';
const preflight = () => m6Preflight(ROW);
const rows = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).all(...p));
const json = (t) => (t === null || t === undefined ? t : typeof t === 'string' ? JSON.parse(t) : t);
const show = (v) => JSON.stringify(v)?.slice(0, 2000);
const store = async (ctx, fn) => fn(homeOfRun(ctx));
const projectOf = (ctx) => stepValue(ctx, 'm6x_create').project;
const outcomes = [];
const kase = (label, fn) => async () => {
  try {
    await fn();
    outcomes.push({ label, ok: true });
  } catch (err) {
    outcomes.push({ label, ok: false });
    throw err;
  }
};
const humanAnswers = (home, project, kind) => rows(home, `SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = ? AND "status" = 'consumed' ORDER BY rowid`, project, kind).map((d) => ({ ...d, answer: json(d.answer) }));
const passedResult = (r) => r.exit_status === 0 && r.execution_established === 1 && r.signaled === 0 && r.deadline_hit === 0 && !r.invalidated_at;

describe('M535 the real run: web, a labelled android simulation and a held logo (real lane, paid)', () => {
  test('(k) its start: M519 passed with no workaround carried forward, its findings resolved on this revision, M535\'s rehearsal passed on this revision', { timeout: REAL_TEST_TIMEOUT_MS }, kase('k', async () => {
    // The preflight refuses, before anything starts, when the condition does not hold (m6-lane.mjs startCondition).
    const ctx = preflight();
    await judged(ctx, 'M535 (k)', async () => {
      const sc = readObserved(ctx, ROW).start_condition;
      assert.ok(sc?.revision, `the start condition recorded with the revision (${show(sc)})`);
      if (ctx.rehearsal) {
        assert.match(String(sc.m519), /not applied: a rehearsal/, 'under the rehearsal the M519 part is not applied, and said so');
        return;
      }
      assert.equal(sc.rehearsal_record?.revision, sc.revision, "M535's rehearsal passed on this revision");
      assert.deepEqual(sc.m519.steps.filter((v) => !v.passed).map((v) => v.step), [], 'every M519 step passed, none only by a workaround');
      assert.deepEqual(sc.m519.steps.map((v) => v.step), [...M519_JOURNEY_STEPS], 'every M519 journey step read');
      assert.deepEqual(sc.m519.findings.filter((f) => !f.resolved).map((f) => f.id), [], 'every M519 finding resolved by a fix commit');
    });
  }));

  test("(a) the sessions metered, the Designer's among them; the design passing its check; the preview deployed, opened through the relay and torn down", { timeout: REAL_TEST_TIMEOUT_MS }, kase('a', async () => {
    const ctx = preflight();
    await judged(ctx, 'M535 (a)', async () => {
      await upTo(ctx, ROW, 'm6x_design');
      const project = projectOf(ctx);
      await store(ctx, (home) => {
        const sessions = rows(home, `SELECT "id", "role" FROM "runs" WHERE "project" = ? AND "kind" = 'session' ORDER BY "seq"`, project);
        assert.ok(['spec_writer', 'architect', 'designer'].every((r) => sessions.some((s) => s.role === r)), `a Spec Writer, an Architect and a Designer session (${show(sessions)})`);
        for (const s of sessions) {
          const turns = rows(home, 'SELECT * FROM "turns" WHERE "run" = ? ORDER BY "number"', s.id);
          const ledger = rows(home, 'SELECT * FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL', s.id);
          assert.ok(turns.length > 0 && ledger.length === turns.length, `session ${s.id} (${s.role}): every turn metered (${turns.length} turns, ${ledger.length} ledger rows)`);
          if (!ctx.rehearsal) assert.ok(ledger.every((l) => l.model_requested === MODELS.sessions), `${s.role} on ${MODELS.sessions}`);
        }
        const ready = designRevisionsOf(home, project).filter((r) => r.status === 'approved' && r.ready_at).at(-1);
        assert.ok(ready, 'an approved design, ready');
        assert.equal(rows(home, 'SELECT "outcome" FROM "design_checks" WHERE "id" = ?', ready.design_check)[0]?.outcome, 'passed', 'its design check passed');
        const previews = previewsOf(home, project);
        assert.ok(previews.some((p) => p.deployed_at) && previews.every((p) => ['torn_down', 'failed'].includes(p.status)), `a preview deployed and every preview torn down (${show(previews)})`);
        assert.ok(relayEvents(home, project).some((e) => e.type === 'environment.relay_opened'), 'the preview opened through the relay');
      });
    });
  }));

  test("(b) the preview: the web mockup served bare, the android mockup inside the engine's labelled frame; SIMULATIONS.txt on export", { timeout: REAL_TEST_TIMEOUT_MS }, kase('b', async () => {
    const ctx = preflight();
    await judged(ctx, 'M535 (b)', async () => {
      await upTo(ctx, ROW, 'm6x_design');
      const r = stepValue(ctx, 'm6x_design').readback;
      assert.ok(r?.mockups?.length > 0, `the runner read the served mockups (${show(r)})`);
      const web = r.mockups.filter((m) => m.target === 'web');
      const android = r.mockups.filter((m) => m.target === 'android');
      assert.ok(web.length > 0 && web.every((m) => m.status === 200 && m.preview_capability === 'native' && !m.framed), `the web mockup served bare, natively (${show(web)})`);
      assert.ok(android.length > 0 && android.every((m) => m.status === 200 && m.preview_capability === 'simulated' && m.framed && m.sandbox), `every android mockup answered with the engine's labelled frame around a sandboxed iframe (${show(android)})`);
      assert.ok(r.simulations && android.every((m) => r.simulations.includes(m.path)) && web.every((m) => !r.simulations.includes(m.path)), `SIMULATIONS.txt names every android mockup and no web one (${show(r.simulations)})`);
      assert.equal(r.relay_close?.status, 0, "the runner's relay closed by the runner");
    });
  }));

  test('(c) the first approval with the logo held: the effective logo the placeholder (or an earlier approved file)', { timeout: REAL_TEST_TIMEOUT_MS }, kase('c', async () => {
    const ctx = preflight();
    await judged(ctx, 'M535 (c)', async () => {
      await upTo(ctx, ROW, 'm6x_design');
      const d = stepValue(ctx, 'm6x_design');
      const project = projectOf(ctx);
      await store(ctx, (home) => {
        const first = humanAnswers(home, project, 'design_approval').find((x) => x.answer?.option === 'approve');
        assert.ok(first, `the first design_approval answered approve through the owner's route (${show(humanAnswers(home, project, 'design_approval').map((x) => x.answer))})`);
        if (Array.isArray(first.answer?.assets_held)) assert.deepEqual(first.answer.assets_held, ['logo'], 'its answer holds the logo');
      });
      assert.deepEqual(d.ready.assets_held, ['logo'], 'the approved revision records the held slot');
      const logo = d.effective.filter((e) => e.slot === 'logo');
      assert.ok(logo.length > 0 && logo.every((e) => e.source === 'placeholder'), `the effective logo the placeholder (${show(logo)})`);
      const held = d.held.flatMap((a) => (a.variants ?? []).map((v) => v.digest)).filter(Boolean);
      assert.ok(held.length > 0 && logo.every((e) => !held.includes(e.digest)), 'never the held proposal');
    });
  }));

  test("(d) the UI stages: each Builder package holding the effective logo by digest and never the held one; each check reading the effective slot@version; bindings recorded", { timeout: REAL_TEST_TIMEOUT_MS }, kase('d', async () => {
    const ctx = preflight();
    await judged(ctx, 'M535 (d)', async () => {
      await upTo(ctx, ROW, 'm6x_build');
      const d = stepValue(ctx, 'm6x_design');
      const b = stepValue(ctx, 'm6x_build');
      const effective = new Map(d.effective.filter((e) => e.slot === 'logo').map((e) => [e.variant, e]));
      const held = new Set(d.held.flatMap((a) => (a.variants ?? []).map((v) => v.digest)).filter(Boolean));
      const heldVersions = new Set(d.held.map((a) => a.slot_version));
      assert.ok(b.carried.length >= 2, `both UI Builders' packages recorded what they carried (${show(b.carried)})`);
      for (const c of b.carried) for (const e of c.effective.filter((x) => x.slot === 'logo')) {
        assert.equal(e.digest, effective.get(e.variant)?.digest, `run ${c.run}: logo/${e.variant} by digest the effective file`);
        assert.ok(!held.has(e.digest), `run ${c.run}: never the held proposal`);
      }
      for (const x of b.executions) for (const a of (x.asset_inputs ?? []).filter((i) => i.slot === 'logo')) assert.ok(!heldVersions.has(a.slot_version) && a.slot_version === effective.get(a.variant)?.slot_version, `check ${x.key}: the effective slot@version, never the held one (${show(a)})`);
      const targets = new Set(b.bindings.filter((x) => x.slot === 'logo').map((x) => x.target));
      assert.ok(targets.has('web') && targets.has('android'), `bindings recorded for both targets (${show(b.bindings)})`);
    });
  }));

  test('(e) the held logo approved by an asset-only approval: the effective version moved; one asset_updated item from the bindings', { timeout: REAL_TEST_TIMEOUT_MS }, kase('e', async () => {
    const ctx = preflight();
    await judged(ctx, 'M535 (e)', async () => {
      await upTo(ctx, ROW, 'm6x_asset');
      const a = stepValue(ctx, 'm6x_asset');
      assert.ok(a.revisions.some((r) => r.scope === 'asset_only' && r.status === 'approved'), `an asset-only revision approved (${show(a.revisions)})`);
      assert.equal(a.after.source, 'approved', 'the effective logo now approved');
      assert.ok(a.after.slot_version > (a.before?.slot_version ?? 0), `its slot@version moved (${show([a.before, a.after])})`);
      assert.equal(a.fixes.length, 1, `one asset_updated item (${show(a.fixes)})`);
      const project = projectOf(ctx);
      await store(ctx, (home) => {
        const bound = bindingsOf(home, project).filter((x) => x.slot === 'logo' && x.source_slot_version === a.before?.slot_version).map((x) => x.path).sort();
        const named = (a.fixes[0].subject?.bindings ?? []).map((x) => x.path).sort();
        assert.deepEqual(named, bound, 'the item names every recorded binding of the slot');
      });
    });
  }));

  test('(f) its integration: asset_version_changed obligations resolved; the parity checks passing with the new slot@version on their results', { timeout: REAL_TEST_TIMEOUT_MS }, kase('f', async () => {
    const ctx = preflight();
    await judged(ctx, 'M535 (f)', async () => {
      await upTo(ctx, ROW, 'm6x_asset');
      const a = stepValue(ctx, 'm6x_asset');
      assert.ok(a.fixes.every((w) => w.status === 'complete'), 'the asset_updated work integrated');
      assert.ok(a.obligations.length > 0 && a.obligations.every((o) => o.resolved_at), `asset_version_changed obligations, resolved (${show(a.obligations)})`);
      assert.ok(a.parity.length > 0 && a.parity.every((r) => r.exit_status === 0 && r.asset_inputs.some((i) => i.slot === 'logo' && i.slot_version === a.after.slot_version)), `parity passing on logo@${a.after.slot_version} (${show(a.parity)})`);
      const project = projectOf(ctx);
      await store(ctx, (home) => {
        const results = rows(home, 'SELECT * FROM "check_results" WHERE "project" = ? AND "asset_inputs" IS NOT NULL', project).map((r) => ({ ...r, asset_inputs: json(r.asset_inputs) }));
        const old = results.filter((r) => r.asset_inputs.some((i) => i.slot === 'logo' && i.slot_version === a.before?.slot_version));
        assert.ok(old.every((r) => !r.asset_inputs.some((i) => i.slot_version === a.after.slot_version)), 'an earlier result names only the version it compared');
        const onNew = results.filter((r) => r.asset_inputs.some((i) => i.slot === 'logo' && i.slot_version === a.after.slot_version));
        assert.ok(onNew.length > 0 && onNew.every(passedResult), 'every result on the new version passed, an engine execution');
      });
    });
  }));

  test('(g) alpha_deployed under policy', { timeout: REAL_TEST_TIMEOUT_MS }, kase('g', async () => {
    const ctx = preflight();
    await judged(ctx, 'M535 (g)', async () => {
      await upTo(ctx, ROW, 'm6x_alpha');
      const a = stepValue(ctx, 'm6x_alpha');
      assert.equal(a.candidate.progress, 'alpha_deployed', 'alpha_deployed');
      assert.ok(a.requests.some((r) => r.requested_by === 'policy'), `requested under policy (${show(a.requests)})`);
      assert.equal(a.alpha_complete?.outcome, 'satisfied', 'verified');
      assert.ok(a.host.every((h) => h.token_hits === 0), 'the token in no unit property');
    });
  }));

  test("(h) the review: web screens from the engine's observations; android not_observed no_native_runtime, its human test pending", { timeout: REAL_TEST_TIMEOUT_MS }, kase('h', async () => {
    const ctx = preflight();
    await judged(ctx, 'M535 (h)', async () => {
      await upTo(ctx, ROW, 'm6x_review');
      const r = stepValue(ctx, 'm6x_review');
      const verdicts = r.review.verdicts ?? [];
      const web = verdicts.filter((v) => v.target === 'web');
      const android = verdicts.filter((v) => v.target === 'android');
      const observed = new Set(r.evidence.filter((e) => e.provenance === 'engine_observed').map((e) => e.id));
      assert.ok(web.length > 0 && web.every((v) => (v.evidence ?? []).some((e) => observed.has(e))), `each web verdict rests on an engine observation (${show(web)})`);
      assert.ok(android.length > 0 && android.every((v) => v.verdict === 'not_observed' && v.not_observed_reason === 'no_native_runtime'), `android not_observed, no_native_runtime (${show(android)})`);
      const ht = (r.human_tests ?? []).find((h) => h.target === 'android');
      assert.equal(ht?.status, 'pending', `the android human test pending (${show(ht)})`);
    });
  }));

  test('(i) the teardown applied, nothing left; pace.json with the Designer\'s figures and the preview\'s peak; the token nowhere', { timeout: REAL_TEST_TIMEOUT_MS }, kase('i', async () => {
    const ctx = preflight();
    await judged(ctx, 'M535 (i)', async () => {
      await upTo(ctx, ROW, 'm6x_review');
      const t = stepValue(ctx, 'm6x_teardown');
      assert.equal(t.applied, true, `the teardown applied (${show(t)})`);
      assert.deepEqual(t.left, { units: [], cgroups: [], run_files: [] }, "nothing of the run home's prefix left");
      assert.deepEqual(t.journal_search.filter((j) => j.hits !== 0).map((j) => j.unit), [], 'the token in no journal output');
      const r = await m6Records(ctx, ROW);
      assert.equal(r.pace_status, 200, 'the pace read answered and pace-M535.json written');
      assert.ok(Array.isArray(r.design_pace?.designer_sessions) && r.design_pace.designer_sessions.length >= 1, `the Designer's figures (${show(r.design_pace)})`);
      assert.ok(Array.isArray(r.design_pace?.previews) && r.design_pace.previews.every((p) => 'memory_peak' in p), "the preview's memory.peak (a value or unknown)");
      assert.ok(Array.isArray(r.design_pace?.asset_approvals) && r.design_pace.asset_approvals.length >= 1, 'the asset approval to integration figure');
      assert.equal(r.token.hits, 0, 'the credential in no file of the run directory and no git object');
      assert.equal(r.transcript_token_hits, 0, 'the credential in no session transcript record');
      assert.deepEqual(r.left, [], 'no unit of the prefix loaded');
    });
  }));

  test('(j) every step: none judged passed with a question raised before its end still open, or with nothing runnable, in flight or asked (rule 25)', { timeout: REAL_TEST_TIMEOUT_MS }, kase('j', async () => {
    const ctx = preflight();
    await judged(ctx, 'M535 (j)', async () => {
      await upTo(ctx, ROW, 'm6x_review');
      for (const s of ['m6x_spec', 'm6x_architecture', 'm6x_design', 'm6x_alpha', 'm6x_review']) {
        const v = stepValue(ctx, s);
        assert.ok(v.rule_25, `${s}: its end judged by rule 25 (${show(v)})`);
        if (s === 'm6x_design') assert.ok(!v.rule_25.handed_over.some((d) => ['design_due', 'design_approval', 'spec_change'].includes(d.kind)), 'the design step leaves no design question open');
        if (s === 'm6x_review') assert.deepEqual(v.rule_25.handed_over, [], 'the review leaves no question open');
      }
      await store(ctx, (home) => assert.deepEqual(rows(home, `SELECT "id", "kind" FROM "decisions" WHERE "project" = ? AND "status" = 'open'`, projectOf(ctx)), [], 'at the end, no question open'));
    });
  }));

  test("(l) the owner's acts: the four central acts performed by Sean with his own entries; every other act's performer recorded; the store's human actor alone never counted", { timeout: REAL_TEST_TIMEOUT_MS }, kase('l', async () => {
    const ctx = preflight();
    await judged(ctx, 'M535 (l)', async () => {
      await upTo(ctx, ROW, 'm6x_review');
      const acts = readActs(ctx, ROW);
      for (const c of CENTRAL_ACTS) assert.ok(acts.some((a) => a.act === c), `the central act ${c} recorded (${show(acts.map((a) => a.act))})`);
      const recorded = new Set(acts.flatMap((a) => (a.items ?? []).map((i) => i.decision).filter(Boolean)));
      await store(ctx, (home) => {
        const human = rows(home, `SELECT "id", "kind", "answer" FROM "decisions" WHERE "project" = ? AND "status" = 'consumed'`, projectOf(ctx)).filter((d) => json(d.answer)?.actor === 'human');
        assert.deepEqual(human.filter((d) => !recorded.has(d.id)).map((d) => `${d.kind} ${d.id}`), [], 'every owner decision in the per-act record');
      });
      // A performer is derived from the entries alone: an act with the store's actor and no entry is never Sean's.
      for (const a of acts) if (a.performer === 'sean') assert.ok(a.evidence?.owner_entry?.entered_via === 'owner-act.mjs' && a.evidence.owner_entry.tty === true && a.evidence.owner_entry.words, `${a.act}: Sean's own entry, typed in his terminal`);
      if (ctx.rehearsal) {
        assert.deepEqual([...new Set(acts.map((a) => a.performer))], ['rehearsal'], 'under the rehearsal no act is Sean\'s: every one the rehearsal\'s');
      } else {
        for (const c of CENTRAL_ACTS) {
          const a = acts.find((x) => x.act === c);
          assert.equal(a.performer, 'sean', `${c} performed by Sean (${show(a)})`);
        }
        const preview = acts.find((a) => a.act === 'preview_inspection');
        assert.ok(Array.isArray(preview.evidence?.relay) && preview.evidence.relay.some((e) => e.type === 'environment.relay_opened'), 'the preview inspection with the relay\'s record of its opening');
        assert.ok(preview.evidence?.relay_requests, 'and what the relay records of the paths served (here: unknown, with why)');
        const others = acts.filter((a) => !CENTRAL_ACTS.includes(a.act));
        assert.deepEqual(others.filter((a) => !['sean', 'driver'].includes(a.performer)).map((a) => `${a.step} ${a.act}`), [], 'every other act with its performer\'s record');
        for (const a of others.filter((x) => x.performer === 'driver')) assert.ok(a.evidence?.instruction, `${a.act}: Sean's instruction, quoted`);
      }
      const failed = outcomes.filter((o) => !o.ok).map((o) => o.label);
      if (ctx.rehearsal && failed.length === 0) markRehearsalPassed(ctx, ROW);
    });
  }));
});
