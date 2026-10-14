// M441 (a), (c), (e), the pace read after the journey (M5 slice 37; kernel
// lane). M5 plan §3.7 M441; D6-M01; D6 §7.6, A.3 (`host_observations`,
// `work_items.held`), N01; D1 §11.3, §12.2; BS5 §10; SEAM.md §355 and
// §442 (the read's figures, each from the observation it declares).
//
// The journey (M401's reference project, T2, `autonomy: phase`,
// `alpha_deploy: on_phase_complete`) on the scripted backend, the scripted
// check boundary and the scripted deployment adapter, through the owner's
// routes to `alpha_deployed`, as M401's T1 variant runs it at T1. Then:
//   (a) every §7.6 figure is present, as a value or `{unknown: <reason>}`,
//       and derived from the observation it declares: per run the creation,
//       the `launched` status observation, the terminal observation and the
//       end, with `invocation_elapsed` † (launched to the terminal
//       observation; `labels.invocation_elapsed` † "invocation elapsed
//       time", N01), tokens and cost from the ledger, the model observed, the
//       repair ordinal and the host observation of its incarnation †; per
//       stage eligibility (`work.dependency_met`) to integration, the first
//       evaluation, `verified`, its runs by role, checks, repairs, findings,
//       the human wait and `decision_hours` †; per phase authoring time, the
//       proposal's class, readiness, phase verification and the replan with
//       its routing; per project the sessions and the idle time by hold
//       reason from `work_items.held_intervals` † (Q3), not tick counts;
//   (c) the host block, from `host_observations` recorded at the project's
//       start: engine version, host qualification, backend entry and model,
//       `autonomy`, `tick_interval`, `domain_memory_max`, `role_memory_max`,
//       `check_memory_max`, `max_concurrent_domains`, `MemAvailable` then,
//       the peak number of domains at once; with an active fixture entry for
//       a second project, the entry's id, binary hash and model;
//   (e) the read calls no backend and no adapter, and changes no
//       `observed_at`.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import {
  JOURNEY_POLICY,
  alphaDeployed,
  alphaReady,
  architectSession,
  changeRequest,
  createWithIdea,
  journeyContext,
  journeyScripts,
  nextPhasePublished,
  paceLeaves,
  phaseCompleted,
  phasePlansOf,
  readPace,
  specSession,
  stagesOfProject,
  visionSession,
} from './harness/journey/drive.mjs';
import { adapterState } from './harness/deploy/kernel.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { setEngineConfig, runningClassifier } from './harness/checks/classifier.mjs';
import { StandIn, installTrustEntry, useBackend } from './harness/trust.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { assertDerived, isFigure, isUnknown, json, launchAndTerminal, near, observedAtSnapshot, rowsOf, seconds, show } from './harness/exec37/pace.mjs';

const GIB = 1024 * 1024 * 1024;
const HOLD_REASONS = ['resource_envelope', 'chain_boundary', 'depends_on', 'authoring_readiness', 'open_decision', 'session_busy'];

describe('M441 (a), (c), (e) the pace read after the journey on the kernel lane', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const version = await runningClassifier(fx.engine);
    setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version } });
    await fx.engine.kill();
    await fx.start();
    journeyScripts(fx);
    const p = await createWithIdea(fx, { policy: JOURNEY_POLICY });
    await visionSession(fx, p.id);
    await specSession(fx, p.id);
    await architectSession(fx, p.id, p.repo);
    const ctx = journeyContext(fx, p, { lane: 'kernel', tier: 'T2' });
    const alpha = await alphaReady(fx, ctx);
    await phaseCompleted(fx, ctx, 1);
    await nextPhasePublished(fx, ctx, 2);
    await changeRequest(fx, ctx);
    await phaseCompleted(fx, ctx, 2, { max: 200 });
    const deployed = await alphaDeployed(fx, ctx);
    // (e): what the read touches, before and after two reads.
    const launchesBefore = fx.scripted.launches().length;
    const callsBefore = (await adapterState(fx.engine, alpha.env.id)).calls.length;
    const observedBefore = observedAtSnapshot(fx.home);
    const pace = await readPace(fx, p.id);
    const again = await readPace(fx, p.id);
    const read = {
      launches: fx.scripted.launches().length - launchesBefore,
      calls: (await adapterState(fx.engine, alpha.env.id)).calls.length - callsBefore,
      observedChanged: JSON.stringify(observedAtSnapshot(fx.home)) !== JSON.stringify(observedBefore),
    };
    J = { fx, p, ctx, deployed, pace, again, read };
  });
  after(shared.cleanup);

  test('(a) the read: every leaf a value or {unknown}; the labels; the sections of §7.6', () => {
    const { pace } = J;
    for (const [path, value] of paceLeaves(pace)) assert.ok(isFigure(value), `${path}: a value or {unknown: <reason>}, never null (${show(value)})`);
    assert.equal(pace.labels?.invocation_elapsed, 'invocation elapsed time', `labels.invocation_elapsed † names the Builder's figure as N01 requires (${show(pace.labels)})`);
    assert.equal(J.deployed.progress, 'alpha_deployed', 'the fixture is live: the journey reached alpha_deployed');
  });

  test('(a) per run: created, launched, the terminal observation and the end as recorded; invocation_elapsed from launched to the terminal observation; tokens, cost and model from the ledger and the run; the host observation of its incarnation', () => {
    const { fx, p, pace } = J;
    const runs = rowsOf(fx.home, `SELECT * FROM "runs" WHERE "project" = ? AND "kind" = 'one_shot' ORDER BY "seq"`, p.id);
    assert.ok(runs.length >= 15, `the fixture is live: the journey's one-shot runs (${runs.length})`);
    const [hostRow] = rowsOf(fx.home, 'SELECT * FROM "host_observations" WHERE "project" = ? ORDER BY rowid', p.id);
    for (const r of runs) {
      const f = pace.runs.find((x) => x.id === r.id);
      assert.ok(f, `run ${r.id} is in the read`);
      const what = `run ${r.id} (${f.role}, ${f.work_kind})`;
      assert.equal(f.created_at, r.created_at, `${what}: created_at as recorded`);
      assert.ok(typeof f.claimed_at === 'string' || isUnknown(f.claimed_at), `${what}: claimed_at † a value or unknown (${show(f.claimed_at)})`);
      const { launched, terminal } = launchAndTerminal(fx.home, r.id);
      if (launched) assert.equal(f.launched_at, launched.at, `${what}: launched_at † is the launched status observation`);
      else assert.ok(isUnknown(f.launched_at), `${what}: no launched observation, launched_at unknown (${show(f.launched_at)})`);
      assert.equal(f.finished_at, r.finished_at ?? f.finished_at, `${what}: finished_at as recorded`);
      assertDerived(f.invocation_elapsed, launched && terminal ? seconds(launched.at, terminal.at) : null, `${what}: invocation_elapsed †`);
      assertDerived(f.end_protocol, terminal && r.finished_at ? seconds(terminal.at, r.finished_at) : null, `${what}: end_protocol † (terminal observation to ended)`);
      const ledger = rowsOf(fx.home, 'SELECT * FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL ORDER BY rowid', r.id);
      const sum = (col) => (ledger.length > 0 && ledger.every((l) => l[col] !== null) ? ledger.reduce((n, l) => n + l[col], 0) : null);
      for (const [key, col] of [['billable', 'billable_in'], ['cached', 'cached_in'], ['output', 'out']]) {
        const expected = sum(col);
        if (expected === null) assert.ok(isUnknown(f.tokens?.[key]), `${what}: tokens.${key} † unknown where the ledger has none (${show(f.tokens)})`);
        else assert.equal(f.tokens?.[key], expected, `${what}: tokens.${key} † from the ledger`);
      }
      if (ledger.length === 1) assert.equal(f.cost?.status, ledger[0].cost_status, `${what}: cost.status † from the ledger (${show(f.cost)})`);
      if (r.model_observed) assert.equal(f.model, r.model_observed, `${what}: the model observed`);
      else assert.ok(isUnknown(f.model), `${what}: no model observed, unknown (${show(f.model)})`);
      assert.ok(Number.isInteger(f.repair_ordinal) && f.repair_ordinal >= 0, `${what}: repair_ordinal † (${show(f.repair_ordinal)})`);
      assert.equal(f.host_observation, hostRow?.id, `${what}: host_observation † names the host observation recorded for its incarnation`);
    }
  });

  test('(a) per stage: eligible (work.dependency_met) to integrated, to the first evaluation, to verified; runs by role; checks; repairs; findings; human wait a measured zero and decision_hours zero', () => {
    const { fx, p, pace } = J;
    const stages = stagesOfProject(fx.home, p.id).filter((s) => s.status === 'verified');
    assert.ok(stages.length >= 4, `the fixture is live: four verified stages (${stages.length})`);
    const at = (type, item) => eventsOfType(fx.home, type).find((e) => e.subject?.work_item === item)?.at ?? null;
    for (const s of stages) {
      const f = pace.stages.find((x) => x.id === s.id);
      assert.ok(f, `stage ${s.id} is in the read`);
      const what = `stage ${f.number} of phase ${f.phase}`;
      const met = at('work.dependency_met', s.work_item);
      assert.ok(met, `${what}: work.dependency_met † was recorded when both milestones were met (D6 §7.6)`);
      assertDerived(f.eligible_to_integrated, seconds(met, at('work.integrated', s.work_item)), `${what}: eligible_to_integrated †`);
      assert.ok(typeof f.integrated_to_first_evaluation === 'number', `${what}: integrated_to_first_evaluation † (${show(f.integrated_to_first_evaluation)})`);
      assert.ok(typeof f.to_verified === 'number', `${what}: to_verified † (${show(f.to_verified)})`);
      const builders = rowsOf(fx.home, `SELECT COUNT(*) AS n FROM "runs" WHERE "work_item" = ? AND "role" = 'builder'`, s.work_item)[0].n;
      assert.equal(f.runs?.builder, builders, `${what}: runs.builder † (${show(f.runs)})`);
      for (const role of ['verifier', 'reviewer', 'fix']) assert.ok(Number.isInteger(f.runs?.[role]), `${what}: runs.${role} † (${show(f.runs)})`);
      assert.ok(f.runs.verifier >= 1 && f.runs.reviewer >= 1, `${what}: T2, a Verifier and a Reviewer ran (${show(f.runs)})`);
      assert.ok(Number.isInteger(f.checks?.count) && f.checks.count >= 1, `${what}: checks.count † (${show(f.checks)})`);
      assert.ok(typeof f.checks.seconds === 'number' || isUnknown(f.checks.seconds), `${what}: checks.seconds †`);
      assert.ok(Number.isInteger(f.repairs), `${what}: repairs † (${show(f.repairs)})`);
      assert.ok(f.findings && typeof f.findings === 'object' && Object.values(f.findings).every(Number.isInteger), `${what}: findings by severity † (${show(f.findings)})`);
      assert.equal(f.human_wait, 0, `${what}: under phase with nothing routed to it, a measured zero`);
      assert.equal(f.decision_hours, 0, `${what}: decision_hours † zero`);
    }
  });

  test('(a) per phase: authoring time, the proposal class (phase 1 unclassifiable, phase 2 tightening), readiness, phase verification, the replan with its routing', () => {
    const { fx, p, pace } = J;
    const plans = phasePlansOf(fx.home, p.id).filter((x) => x.active === 1 || x.active === true);
    for (const plan of plans) {
      const f = pace.phases.find((x) => x.plan === plan.id);
      assert.ok(f, `phase ${plan.phase_number} is in the read`);
      assert.ok(typeof f.authoring_seconds === 'number', `phase ${plan.phase_number}: authoring_seconds † (${show(f.authoring_seconds)})`);
      assert.equal(f.authoring_ready, plan.authoring_ready_at, `phase ${plan.phase_number}: authoring_ready † as recorded`);
      assert.ok(typeof f.phase_verification === 'number', `phase ${plan.phase_number}: phase_verification † measured at T2 (${show(f.phase_verification)})`);
    }
    const one = pace.phases.find((x) => x.phase === 1 && plans.some((pl) => pl.id === x.plan));
    const two = pace.phases.find((x) => x.phase === 2 && plans.some((pl) => pl.id === x.plan));
    assert.equal(one?.proposal_class, 'unclassifiable', `phase 1's toolchain proposal (${show(one?.proposal_class)})`);
    assert.equal(two?.proposal_class, 'tightening', `phase 2's authoring (${show(two?.proposal_class)})`);
    assert.equal(one?.replan?.routing, 'registered', `phase 1's replan was routed by computation (${show(one?.replan)})`);
    assert.ok(typeof one?.replan?.seconds === 'number', `its time (${show(one?.replan)})`);
  });

  test('(a) per project: the sessions\' turns, time and tokens; idle time by hold reason from work_items.held_intervals †, authoring readiness among them', () => {
    const { fx, p, pace } = J;
    const turns = rowsOf(fx.home, `SELECT COUNT(*) AS n FROM "turns" t JOIN "runs" r ON r."id" = t."run" WHERE r."project" = ?`, p.id)[0].n;
    assert.equal(pace.project.sessions?.turns, turns, `sessions.turns † (${show(pace.project.sessions)})`);
    assert.ok(typeof pace.project.sessions.seconds === 'number', 'sessions.seconds †');
    assert.ok(isFigure(pace.project.sessions.tokens) || typeof pace.project.sessions.tokens === 'object', 'sessions.tokens †');
    const idle = pace.project.idle;
    assert.ok(idle && typeof idle === 'object', `project.idle † by hold reason (${show(idle)})`);
    const items = rowsOf(fx.home, 'SELECT "id", "held_intervals" FROM "work_items" WHERE "project" = ? ORDER BY "seq"', p.id);
    const expected = {};
    for (const w of items) for (const h of json(w.held_intervals) ?? []) if (h.to) expected[h.reason] = (expected[h.reason] ?? 0) + (seconds(h.from, h.to) ?? 0);
    assert.ok((expected.authoring_readiness ?? 0) > 0, `the fixture is live: stage work waited on authoring readiness (${show(expected)})`);
    // The review's N6 (objection 105; SEAM.md §451): a reason with a closed
    // interval recorded reads the elapsed time of its closed intervals; a
    // reason with none reads `unknown`, never a measured 0.
    for (const reason of HOLD_REASONS) {
      if (reason in expected) assert.ok(typeof idle[reason] === 'number' && near(idle[reason], expected[reason], 0.01), `idle.${reason}: ${expected[reason]} s from the recorded intervals, read ${show(idle[reason])}`);
      else assert.ok(isUnknown(idle[reason]), `idle.${reason}: no closed interval was recorded, so unknown, never 0 (read ${show(idle[reason])})`);
    }
  });

  test('(c) the host block from host_observations recorded at the project\'s start; with an active entry, the entry\'s id, binary hash and model', async () => {
    const { fx, p, pace } = J;
    const [row] = rowsOf(fx.home, 'SELECT * FROM "host_observations" WHERE "project" = ? ORDER BY rowid', p.id);
    assert.ok(row, 'a host observation of the project');
    assert.equal(row.trigger, 'project_start', `recorded at the project's start (trigger † ${show(row.trigger)})`);
    const h = pace.host;
    assert.equal(h.engine_version, row.engine_version);
    assert.equal(h.autonomy, 'phase');
    assert.equal(h.tick_interval, 600, 'the configured tick_interval');
    assert.equal(h.domain_memory_max, 8 * GIB);
    assert.equal(h.role_memory_max, 4 * GIB, `role_memory_max † (${show(h.role_memory_max)})`);
    assert.equal(h.check_memory_max, 2 * GIB, `check_memory_max † (${show(h.check_memory_max)})`);
    assert.equal(h.max_concurrent_domains, 4);
    assert.ok(typeof h.mem_available === 'number', `MemAvailable then (${show(h.mem_available)})`);
    assert.ok(Number.isInteger(h.peak_domains) && h.peak_domains >= 1, `peak_domains as recorded (${show(h.peak_domains)})`);
    assert.ok(isUnknown(h.host_qualification), `the kernel lane has no host qualification: unknown (${show(h.host_qualification)})`);
    assert.ok(isUnknown(h.backend_entry), `the scripted backend has no trust entry: unknown (${show(h.backend_entry)})`);

    // A second project on a real backend name, with an active entry for it.
    const standIn = new StandIn(join(fx.root, 'standin'));
    const model = 'claude-sonnet-4-5';
    const entry = await installTrustEntry(fx.engine, standIn, { status: 'active', model });
    const q = await addGitProject(fx);
    await useBackend(fx.engine, q.id, 'claude');
    await tick(fx.engine, q.id);
    const hq = (await readPace(fx, q.id)).host;
    assert.deepEqual(hq.backend_entry, { id: entry.id, binary_sha256: standIn.sha256, model }, `backend_entry † names the entry, its binary hash and its model (${show(hq.backend_entry)})`);
  });

  test('(e) the read calls no backend and no adapter and changes no observed_at; read twice, the figures are the same', () => {
    const { read, pace, again } = J;
    assert.equal(read.launches, 0, 'no backend invocation');
    assert.equal(read.calls, 0, 'no adapter call');
    assert.equal(read.observedChanged, false, 'no observed_at changed');
    assert.deepEqual(again, pace, 'the same projection twice');
  });
});
