// M519, the real run first: design before build and at Alpha, one target
// (M6 slice 46; REAL LANE, manifest `real`). M6 plan §3.8 M519; D7
// Appendix C M519, §1, §13; BS6 §12, §4.1 rules 21 to 26; E156 Q4 to Q6;
// SEAM.md §§541 to 543. PAID, ONLY BY SEAN'S COMMAND (the driver's under his
// standing delegation, E144 item 2), on his subscription token, never in
// `npm test` or a slice, and run ALONE with `node --test` after `npm run
// build`, never with `run-tests.mjs --lane real`. Sean's steps:
// docs/acceptance/reports/M6-real-lane/README.md.
//
// Claude Code on Sean's subscription token; Opus for the Spec Writer,
// Architect and Designer sessions, Sonnet for the one-shots; V1's visual
// brief (`~/surety-m5-physics-idea-visual.md`, SURETY_M519_BRIEF) with
// `**Targets:** web` in the specification; `design: both`, T2, `autonomy:
// phase`, `alpha_deploy: on_phase_complete`, a day limit of 40 USD. The steps
// (harness/real/m6-lane.mjs, M519_STEPS): the attempts and activation; the
// project; Sean's (or the driver's, on his recorded instruction) Spec
// Writer and Architect sessions; qualify-adapter; the design (design_due,
// the Designer session, the preview through the relay, the batched
// approval, the criteria's checks applied); the build; Alpha under policy;
// the review at Alpha and its confirmation; the teardown in `finally`.
//   (a) `session_qualified` true from the continuation canary; both entries
//       active (Opus, Sonnet);
//   (b) each session's turns metered (a ledger row each), the Designer's
//       among them; the Designer's design passing its check; the preview
//       deployed, opened through the relay and torn down;
//   (c) the batched approval (design_approval and its spec_change, one
//       batch_key) recorded with its actor and, if the driver's, the
//       instruction's words;
//   (d) the UI stage held `design_pending` while the API stage built;
//       released after the correction's application (`design.ready`); every
//       check result an engine execution;
//   (e) `qualify-adapter`; Alpha requested under policy, `alpha_deployed` on
//       a real unit of the run home's prefix;
//   (f) `design_verdicts` answered; the web human test carrying the
//       confirmed verdict;
//   (g) the teardown applied, nothing left; `pace.json` with the Designer's
//       figures and the preview's peak; the token in no file of the run
//       directory, git object, unit property, journal output or transcript
//       record;
//   (h) no step judged passed with a question raised before its end still
//       open (but those it hands over, recorded), or with nothing runnable,
//       in flight or asked (BS6 §4.1 rule 25); nor with a design-held stage
//       accounted for by nothing, nor ending in an intentional wait (a
//       deferral, a Designer session open on a held stage), which is
//       recorded `waiting`, never `done` (rule 25 as amended, E162 item 1;
//       SEAM.md §547);
//   (i) every owner act with its performer recorded (Sean's own entry, or
//       the driver's with Sean's words), evidence beyond the store's `human`
//       actor; an act with neither reported `unknown`, and failing here;
//   (j) each defect the run found recorded (finding.mjs) with the step it
//       stopped and whether a driver workaround passed it; a step passed
//       only by a workaround recorded as not passed.
//
// The dress rehearsal (SURETY_REAL_REHEARSAL=1, the fake claude): the
// package-driven fakes, the Designer's among them, play every role from its
// package (BS6 §12; M537); the harness acts for the owner and records itself
// as the performer `rehearsal`; never evidence. When every case of it
// passes, it writes `rehearsal-passed.json` with the revision, which the paid
// run reads (SURETY_M519_REHEARSAL_DIR) before it starts.

import { describe, test } from 'node:test';

import { REAL_TEST_TIMEOUT_MS, judged, readObserved, stepValue } from './harness/real/lane.mjs';
import {
  M519_JOURNEY_STEPS,
  MODELS,
  assert,
  bindingsOf,
  designRevisionsOf,
  findingsOf,
  homeOfRun,
  m6Preflight,
  m6Records,
  markRehearsalPassed,
  previewsOf,
  readActs,
  relayEvents,
  stepVerdicts,
  upTo,
} from './harness/real/m6-lane.mjs';
import { withStore } from './harness/store.mjs';
import { trustEntries } from './harness/trust.mjs';

const ROW = 'M519';
const preflight = () => m6Preflight(ROW);
const rows = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).all(...p));
const json = (t) => (t === null || t === undefined ? t : typeof t === 'string' ? JSON.parse(t) : t);
const show = (v) => JSON.stringify(v)?.slice(0, 2000);
const store = async (ctx, fn) => fn(homeOfRun(ctx));
const projectOf = (ctx) => stepValue(ctx, 'm6w_create').project;
// Every case's outcome, so that the rehearsal is marked passed only when all passed.
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
const passedResult = (r) => r.exit_status === 0 && r.execution_established === 1 && r.signaled === 0 && r.deadline_hit === 0;

describe('M519 the real run: design before build and at Alpha, one target (real lane, paid)', () => {
  test('(a) the attempts: session_qualified true from the continuation canary; the Opus and Sonnet entries active', { timeout: REAL_TEST_TIMEOUT_MS }, kase('a', async () => {
    const ctx = preflight();
    await judged(ctx, 'M519 (a)', async () => {
      await upTo(ctx, ROW, 'm6_activation');
      const act = stepValue(ctx, 'm6_activation');
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
  }));

  test("(b) the sessions metered, the Designer's among them; the design passing its check; the preview deployed, opened through the relay and torn down", { timeout: REAL_TEST_TIMEOUT_MS }, kase('b', async () => {
    const ctx = preflight();
    await judged(ctx, 'M519 (b)', async () => {
      await upTo(ctx, ROW, 'm6w_design');
      const project = projectOf(ctx);
      await store(ctx, (home) => {
        const sessions = rows(home, `SELECT "id", "role", "outcome", "model_requested" FROM "runs" WHERE "project" = ? AND "kind" = 'session' ORDER BY "seq"`, project);
        assert.ok(['spec_writer', 'architect', 'designer'].every((r) => sessions.some((s) => s.role === r)), `a Spec Writer, an Architect and a Designer session (${show(sessions)})`);
        for (const s of sessions) {
          const turns = rows(home, 'SELECT * FROM "turns" WHERE "run" = ? ORDER BY "number"', s.id);
          const ledger = rows(home, 'SELECT * FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL', s.id);
          assert.ok(turns.length > 0 && ledger.length === turns.length, `session ${s.id} (${s.role}): every turn metered (${turns.length} turns, ${ledger.length} ledger rows)`);
          if (!ctx.rehearsal) assert.ok(ledger.every((l) => l.model_requested === MODELS.sessions), `${s.role} on ${MODELS.sessions}`);
        }
        const ready = designRevisionsOf(home, project).filter((r) => r.status === 'approved' && r.ready_at).at(-1);
        assert.ok(ready, `an approved design, ready (${show(designRevisionsOf(home, project).map((r) => [r.id, r.status, r.ready_at]))})`);
        const check = rows(home, 'SELECT * FROM "design_checks" WHERE "id" = ?', ready.design_check)[0];
        assert.equal(check?.outcome, 'passed', `the approved design passed its design check (${show(check)})`);
        const previews = previewsOf(home, project);
        assert.ok(previews.some((p) => p.deployed_at), `a preview deployed (${show(previews)})`);
        assert.ok(previews.every((p) => ['torn_down', 'failed'].includes(p.status)), 'every preview torn down');
        assert.ok(relayEvents(home, project).some((e) => e.type === 'environment.relay_opened'), 'the preview opened through the relay');
        assert.equal(previews.find((p) => p.deployed_at)?.mockups?.every((m) => m.target === 'web' && m.preview_capability === 'native'), true, 'one target: every mockup web, served natively');
      });
    });
  }));

  test("(c) the batched approval: design_approval and its spec_change under one batch_key, recorded with the actor and its performer", { timeout: REAL_TEST_TIMEOUT_MS }, kase('c', async () => {
    const ctx = preflight();
    await judged(ctx, 'M519 (c)', async () => {
      await upTo(ctx, ROW, 'm6w_design');
      const project = projectOf(ctx);
      await store(ctx, (home) => {
        const approvals = humanAnswers(home, project, 'design_approval').filter((d) => d.answer?.option === 'approve');
        assert.ok(approvals.length >= 1, `design_approval answered approve (${show(approvals.map((d) => d.answer))})`);
        const batch = approvals.at(-1).batch_key;
        const change = humanAnswers(home, project, 'spec_change').find((d) => d.batch_key === batch);
        assert.ok(batch && change?.answer?.option === 'approve', `its spec_change, in the same batch, approved (${show(change)})`);
        for (const d of [approvals.at(-1), change]) assert.equal(d.answer?.actor, 'human', `${d.kind} answered through the owner's route`);
      });
      const act = readActs(ctx, ROW).find((a) => a.act === 'combined_approval');
      assert.ok(act, 'the combined approval is in the per-act record');
      if (ctx.rehearsal) assert.equal(act.performer, 'rehearsal');
      else {
        assert.ok(['sean', 'driver'].includes(act.performer), `its performer recorded (${show(act)})`);
        if (act.performer === 'driver') assert.ok(act.evidence?.instruction, "the driver's act carries Sean's instruction, verbatim");
      }
    });
  }));

  test('(d) the build: the UI stage held design_pending while the API stage built, released after design.ready; every check result an engine execution', { timeout: REAL_TEST_TIMEOUT_MS }, kase('d', async () => {
    const ctx = preflight();
    await judged(ctx, 'M519 (d)', async () => {
      await upTo(ctx, ROW, 'm6w_build');
      const project = projectOf(ctx);
      await store(ctx, (home) => {
        const items = rows(home, `SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'stage_build' ORDER BY "seq"`, project).map((w) => ({ ...w, subject: json(w.subject), held_intervals: json(w.held_intervals) ?? [] }));
        const ui = items.filter((w) => w.held_intervals.some((h) => h.reason === 'design_pending'));
        const api = items.filter((w) => !ui.includes(w));
        assert.ok(ui.length >= 1 && api.length >= 1, `a UI stage held design_pending and a backend stage never held on design (${show(items.map((w) => [w.id, w.held_intervals]))})`);
        const seqOf = (type, item) => rows(home, `SELECT "seq" FROM "events" WHERE "type" = ? AND "subject" LIKE ? ORDER BY "seq"`, type, `%${item}%`).map((e) => e.seq);
        const released = Math.max(...ui.flatMap((w) => seqOf('work.hold_ended', w.id)));
        const apiIntegrated = Math.min(...api.flatMap((w) => seqOf('work.integrated', w.id)));
        assert.ok(apiIntegrated < released, `the API stage integrated (seq ${apiIntegrated}) while the UI stage was held (released at seq ${released})`);
        const ready = rows(home, `SELECT "seq" FROM "events" WHERE "type" = 'design.ready' ORDER BY "seq"`).map((e) => e.seq);
        assert.ok(ready.length > 0 && ready[0] <= released, `released only after design.ready (${show(ready)}, released ${released})`);
        assert.ok(api.every((w) => !w.held_intervals.some((h) => ['design_pending', 'design_stale'].includes(h.reason))), 'the backend stage untouched by design');
        const results = rows(home, 'SELECT * FROM "check_results" WHERE "project" = ?', project);
        assert.ok(results.length > 0 && results.every((r) => r.runner_id !== 'test_fixture' && r.execution_established === 1), `every check result an engine execution (${results.length})`);
        assert.ok(bindingsOf(home, project).length >= 1, 'the UI Builder bound the effective files it placed');
      });
    });
  }));

  test("(e) qualify-adapter; Alpha requested under policy, alpha_authorize satisfied, verified, alpha_deployed on a real unit of the run home's prefix", { timeout: REAL_TEST_TIMEOUT_MS }, kase('e', async () => {
    const ctx = preflight();
    await judged(ctx, 'M519 (e)', async () => {
      await upTo(ctx, ROW, 'm6w_alpha');
      const q = stepValue(ctx, 'm6w_qualify');
      assert.equal(q.row?.status, 'current', `the adapter qualified by ${q.by} (${show(q.row)})`);
      const a = stepValue(ctx, 'm6w_alpha');
      assert.equal(a.candidate.progress, 'alpha_deployed', 'alpha_deployed');
      assert.ok(a.requests.some((r) => r.requested_by === 'policy'), `requested by the engine under policy (${show(a.requests)})`);
      assert.equal(a.alpha_authorize?.outcome, 'satisfied', 'alpha_authorize satisfied');
      assert.equal(a.alpha_complete?.outcome, 'satisfied', 'alpha_complete satisfied: verified');
      assert.ok(a.host.length > 0 && a.host.some((h) => h.props?.ActiveState === 'active'), `the service on a real unit of the prefix, active while read (${show(a.host)})`);
      assert.ok(a.host.every((h) => h.token_hits === 0), 'the token in no unit property');
    });
  }));

  test('(f) the review at Alpha: design_verdicts answered by the owner; the web human test carrying the confirmed verdict', { timeout: REAL_TEST_TIMEOUT_MS }, kase('f', async () => {
    const ctx = preflight();
    await judged(ctx, 'M519 (f)', async () => {
      await upTo(ctx, ROW, 'm6w_review');
      const r = stepValue(ctx, 'm6w_review');
      assert.ok(r.review.confirmation_decision, `the review's verdicts confirmed by design_verdicts (${show(r.review)})`);
      const project = projectOf(ctx);
      await store(ctx, (home) => {
        const v = humanAnswers(home, project, 'design_verdicts').find((d) => d.id === r.review.confirmation_decision);
        assert.equal(v?.answer?.option, 'confirm', `answered confirm through the owner's route (${show(v?.answer)})`);
      });
      const web = (r.human_tests ?? []).find((h) => h.target === 'web');
      assert.ok(web && (web.evidence ?? []).length > 0, `the web human test carries the confirmed verdict (${show(r.human_tests)})`);
    });
  }));

  test("(g) the teardown applied, nothing of the prefix left; pace.json with the Designer's figures and the preview's peak; the token in no file, git object, unit property, journal output or transcript record", { timeout: REAL_TEST_TIMEOUT_MS }, kase('g', async () => {
    const ctx = preflight();
    await judged(ctx, 'M519 (g)', async () => {
      await upTo(ctx, ROW, 'm6w_review');
      const t = stepValue(ctx, 'm6w_teardown');
      assert.equal(t.applied, true, `the teardown applied (${show(t)})`);
      assert.deepEqual(t.left, { units: [], cgroups: [], run_files: [] }, "nothing of the run home's prefix left");
      assert.deepEqual(t.journal_search.filter((j) => j.hits !== 0).map((j) => j.unit), [], 'the token in no journal output');
      const r = await m6Records(ctx, ROW);
      assert.equal(r.pace_status, 200, 'the pace read answered and pace-M519.json written');
      const d = r.design_pace;
      assert.ok(d && Array.isArray(d.designer_sessions) && d.designer_sessions.length >= 1, `the pace read's Designer figures (${show(d)})`);
      assert.ok(Array.isArray(d.previews) && d.previews.length >= 1 && d.previews.every((p) => 'memory_peak' in p), "the preview's memory.peak (a value or unknown)");
      assert.equal(r.token.hits, 0, `the ${ctx.authMode} credential in no file of the run directory and no git object`);
      assert.equal(r.transcript_token_hits, 0, 'the credential in no session transcript record');
      assert.deepEqual(r.left, [], 'no unit of the prefix loaded');
      assert.ok(readObserved(ctx, ROW).records, 'the records kept for the report');
    });
  }));

  test('(h) every step: none judged passed with a question raised before its end still open, or with nothing runnable, in flight or asked (rule 25)', { timeout: REAL_TEST_TIMEOUT_MS }, kase('h', async () => {
    const ctx = preflight();
    await judged(ctx, 'M519 (h)', async () => {
      await upTo(ctx, ROW, 'm6w_review');
      for (const s of ['m6w_spec', 'm6w_architecture', 'm6w_design', 'm6w_alpha', 'm6w_review']) {
        const v = stepValue(ctx, s);
        assert.ok(v.rule_25, `${s}: its end judged by rule 25 (${show(v)})`);
        const handed = v.rule_25.handed_over.map((d) => d.kind);
        if (s === 'm6w_review') assert.deepEqual(handed, [], 'the review leaves no question open');
        if (s === 'm6w_design') assert.ok(!handed.some((k) => ['design_due', 'design_approval', 'spec_change', 'design_verdicts'].includes(k)), `the design step leaves no design question open (${show(handed)})`);
      }
      await store(ctx, (home) => {
        const open = rows(home, `SELECT "id", "kind" FROM "decisions" WHERE "project" = ? AND "status" = 'open'`, projectOf(ctx));
        assert.deepEqual(open, [], 'at the end, no question open');
      });
    });
  }));

  test("(i) every owner act: its performer (Sean or the driver) with evidence beyond the store's human actor; none unknown", { timeout: REAL_TEST_TIMEOUT_MS }, kase('i', async () => {
    const ctx = preflight();
    await judged(ctx, 'M519 (i)', async () => {
      await upTo(ctx, ROW, 'm6w_review');
      const acts = readActs(ctx, ROW);
      const recorded = new Set(acts.flatMap((a) => (a.items ?? []).map((i) => i.decision).filter(Boolean)));
      await store(ctx, (home) => {
        const human = rows(home, `SELECT "id", "kind", "answer" FROM "decisions" WHERE "project" = ? AND "status" = 'consumed'`, projectOf(ctx)).filter((d) => json(d.answer)?.actor === 'human');
        assert.deepEqual(human.filter((d) => !recorded.has(d.id)).map((d) => `${d.kind} ${d.id}`), [], 'every decision the store records as the owner\'s is in the per-act record');
      });
      for (const want of ['spec_session', 'architect_session', 'designer_feedback', 'preview_inspection', 'combined_approval', 'review_session', 'review_confirmation']) assert.ok(acts.some((a) => a.act === want), `the act ${want} recorded (${show(acts.map((a) => a.act))})`);
      if (ctx.rehearsal) assert.deepEqual([...new Set(acts.map((a) => a.performer))], ['rehearsal'], 'under the rehearsal every act is the rehearsal\'s, never Sean\'s');
      else {
        const unknown = acts.filter((a) => !['sean', 'driver'].includes(a.performer));
        assert.deepEqual(unknown.map((a) => `${a.step} ${a.act}: ${a.performer}`), [], 'no act without its performer\'s record (owner-act.mjs or driver-act.mjs)');
        for (const a of acts) {
          if (a.performer === 'sean') assert.ok(a.evidence?.owner_entry?.words, `${a.act}: Sean's own words`);
          if (a.performer === 'driver') assert.ok(a.evidence?.instruction, `${a.act}: Sean's instruction, quoted`);
        }
      }
    });
  }));

  test('(j) the findings: each defect with its step and its workaround; no step passed only by a workaround', { timeout: REAL_TEST_TIMEOUT_MS }, kase('j', async () => {
    const ctx = preflight();
    await judged(ctx, 'M519 (j)', async () => {
      await upTo(ctx, ROW, 'm6w_review');
      const findings = findingsOf(ctx.runDir);
      for (const f of findings) assert.ok(M519_JOURNEY_STEPS.includes(f.step) && f.what, `finding ${f.id} names its step and the defect (${show(f)})`);
      const verdicts = stepVerdicts(ctx.runDir, M519_JOURNEY_STEPS);
      const onlyByWorkaround = verdicts.filter((v) => v.status === 'done' && v.workaround);
      assert.deepEqual(onlyByWorkaround.map((v) => `${v.step} (${v.workaround.finding}: ${v.workaround.what})`), [], 'a step passed only by a workaround is not passed (E156 Q5): fix it on main and rerun the step');
      assert.deepEqual(verdicts.filter((v) => !v.passed).map((v) => `${v.step} ${v.status}`), [], 'every step of the journey passed');
      const failed = outcomes.filter((o) => !o.ok).map((o) => o.label);
      if (ctx.rehearsal && failed.length === 0) markRehearsalPassed(ctx, ROW);
    });
  }));
});
