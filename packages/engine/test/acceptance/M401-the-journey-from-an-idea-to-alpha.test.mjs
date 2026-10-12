// M401, the journey from an idea to Alpha on the scripted backend (slice
// 31b; project lane, run with `npm test` like the sandbox lane, E92 item 2
// (1)). M5 plan §3.1 M401; D6-J01; D6 §1 whole; E40; BS5 §3, §4.1 rules 12,
// 13, 20; SEAM.md §§350 to 356.
//
// The reference project "Tally" (§342), T2, on real `role` and `check`
// domains (D2's launcher and init running the scripted role program), the
// check runner qualified by its own self-test, the adapter by `surety
// qualify-adapter` in the test's home, the real `local_service` adapter in a
// transient user unit; `autonomy: phase`, `alpha_deploy: on_phase_complete`,
// `classifier_authority: authoritative` (the ruling), the first phase's
// `check_commands` the one human act within the build (Q9). The harness
// answers every human act of D6 §1 through the owner's production routes and
// installs nothing by fixture: no plan, candidate, phase check, readiness or
// authorization (rule 20). The run caps stay as built (the ruling): (f)
// records the serial path.
//
// Made once in the `before` hook; each case reads one clause of the row.
//
// SAFETY (BS5 §4.1; E64; SEAM.md §§257, 356). The only unit is the one the
// engine creates under this test's home's prefix; the test acts on no unit
// and signals nothing. The service has no act and no secret. The
// environment is ended in `finally` (`endEnvironment`, the engine's own
// teardown waited for); the file ends with `operatorGuard`; every engine
// start carries the real-adapter switch and the runner self-test.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { waitSelfTest } from './harness/checks/execution.mjs';
import { runningClassifier, setEngineConfig } from './harness/checks/classifier.mjs';
import { RUNTIME, candidateRow, configContent, configure, unitPrefix } from './harness/deploy/kernel.mjs';
import { cgroupsNamed, endEnvironment, operatorGuard, realAdapterStarts, serviceOf, unitShow, unitsOfHome } from './harness/deploy/host.mjs';
import { qualifyByCommand } from './harness/deploy/qualify.mjs';
import { freePort } from './harness/engine.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { consume, decision } from './harness/decisions.mjs';
import {
  alphaDeployed,
  authoringReady,
  architectSession,
  authorizationsOfProject,
  candidatesOfProject,
  changeRequest,
  checkRows,
  createWithIdea,
  deploymentRequests,
  evaluationsOfKind,
  eventsAbout,
  executionsOf,
  journeyContext,
  journeyScripts,
  ledgerOf,
  modulesOf,
  nextPhasePublished,
  obligationsOf,
  paceLeaves,
  phaseCompleted,
  planChecks,
  planOfPhase,
  projectRow,
  protectedVersionsOf,
  readPace,
  readSpec,
  requirementsOf,
  resultsOf,
  runsOfProject,
  signoffsOfProject,
  specRevisions,
  specSession,
  stagesOfPlan,
  visionSession,
  waitPublished,
  workOf,
} from './harness/journey/drive.mjs';
import { SPEC_DEFECT } from './harness/journey/reference.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { ledgerRowsOf, turnRows } from './harness/sessions.mjs';
import { tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

const operationsOf = (home, project, kind) => withStore(home, (db) => db.prepare('SELECT * FROM "operations" WHERE "project" = ? AND "kind" = ? ORDER BY "seq"').all(project, kind));
const domainRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(id));

describe('M401 the journey from an idea to Alpha on the scripted backend, on a real unit', () => {
  const shared = sharedFixture();
  let guard;
  let J;
  before(async () => {
    guard = operatorGuard();
    // The sandbox lane's engine on the real adapter, the runner self-tested at every start, the classifier authoritative.
    const fx = realAdapterStarts(await sandboxEngine(shared.context, { start: false }));
    guard.track(fx);
    const inner = fx.start;
    fx.start = (opts = {}) => inner({ ...opts, args: [...(opts.args ?? []), '--harness-runner-self-test', 'run'] });
    await fx.start();
    await waitSelfTest(fx);
    const version = await runningClassifier(fx.engine);
    setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version } });
    await fx.engine.kill();
    await fx.start();
    await waitSelfTest(fx);
    journeyScripts(fx);
    J = { fx };
    try {
      // 1. The project, created with the idea.
      const p = await createWithIdea(fx, { tier: 'T2', policy: { autonomy: 'phase', alpha_deploy: 'on_phase_complete', deploy_auto_retries_max: 0, service_memory_max: 67108864, identity_observation_every: 1 } });
      const ctx = journeyContext(fx, p, { lane: 'project', tier: 'T2' });
      Object.assign(J, { p, ctx });
      J.created = { row: projectRow(fx.home, p.id), events: eventsAbout(fx.home, 'project.created', p.id) };
      // 2. Vision. 3. The Spec Writer, a defective save then the whole. 4. The Architect.
      J.vision = await visionSession(fx, p.id);
      J.spec = await specSession(fx, p.id);
      J.beforeAnswer = await (async () => {
        const arch = await architectSession(fx, p.id, p.repo, { answer: 'none' });
        const snapshot = { plans: planOfPhase(fx.home, p.id, 1).length, work: workOf(fx.home, p.id).length, baseline: projectRow(fx.home, p.id).baseline_state };
        return { arch, snapshot };
      })();
      for (const kind of ['architecture_approval', 'plan_approval']) await consume(fx, p.id, decision(fx.home, J.beforeAnswer.arch.decisions[kind].id), 'approve');
      J.plan = await waitPublished(fx, p.id);
      // 12 (early): the owner configures alpha and qualifies the adapter by command, any time before the request (D6 §1 step 12).
      const cli = qualifyByCommand(fx);
      assert.equal(cli.status, 0, `surety qualify-adapter local_service exits 0 in the test's home (stdout ${cli.stdout.slice(0, 400)}; stderr ${cli.stderr.slice(0, 400)})`);
      J.qualification = cli.body;
      const content = configContent({ adapter_version: cli.body.adapter_version, port: await freePort(), start: [RUNTIME.path, 'server.mjs'] });
      const configured = await configure(fx.engine, p.id, 'alpha', content);
      J.env = { ...configured.environment, name: 'alpha', config: configured.config, content };
      // 5 to 8: phase 1, under `phase`, the toolchain proposal the one routed act.
      J.authoring = { ready: await authoringReady(fx, ctx, 1, { max: 60 }) };
      J.phase1 = await phaseCompleted(fx, ctx, 1, { max: 240 });
      J.afterPhase1 = { candidates: candidatesOfProject(fx.home, p.id), requests: deploymentRequests(fx.home, p.id) };
      // 9. The replan publishes phase 2 by computed routing.
      J.phase2Plan = await nextPhasePublished(fx, ctx, 2, { max: 60 });
      // 11. CR-1 between the phases.
      J.resultsBeforeChange = resultsOf(fx.home, p.id);
      J.change = await changeRequest(fx, ctx);
      // 10. Phase 2. 12. Alpha under policy.
      J.phase2 = await phaseCompleted(fx, ctx, 2, { max: 300 });
      J.deployed = await alphaDeployed(fx, ctx, { max: 120 });
      // (j) a further tick creates no second request.
      await tick(fx.engine, p.id, { rounds: 1, timeoutMs: 180_000 });
      J.requestsAfterTick = deploymentRequests(fx.home, p.id);
      const op = operationsOf(fx.home, p.id, 'deploy').at(-1);
      J.svc = op ? serviceOf(ctx, J.env, op) : null;
      J.unitShow = J.svc?.unit ? unitShow(J.svc.unit, ['LoadState', 'ActiveState', 'MainPID']) : null;
      J.pace = await readPace(fx, p.id);
    } finally {
      if (J.env) {
        J.ended = await endEnvironment({ fx, project: J.p?.id, envs: {} }, J.env);
        J.afterTeardown = {
          units: unitsOfHome(fx.home).filter((u) => u.unit.startsWith(unitPrefix(fx.home, J.env.id))),
          cgroups: cgroupsNamed(unitPrefix(fx.home, J.env.id)),
          runFiles: (() => {
            try {
              return readdirSync(join(fx.home, 'run'), { recursive: true }).filter((n) => String(n).includes(J.env.id));
            } catch {
              return [];
            }
          })(),
        };
      }
    }
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a) surety project create --idea: project.created, .surety/idea.md version 1, baseline idea', () => {
    assert.equal(J.created.events.length, 1);
    assert.deepEqual([J.created.row.idea_version, J.created.row.baseline_state], [1, 'idea']);
  });

  test('(b) the Vision session: one session run with two turns, each a ledger row, each settled before the next; idea_version 2', () => {
    const { fx, p, vision } = J;
    const turns = turnRows(fx.home, vision.run.id);
    assert.equal(turns.length, 2, 'two turns');
    assert.ok(turns.every((t) => t.settled_at), 'each settled');
    assert.ok(turns[0].settled_at <= turns[1].settled_at, 'the first settled before the second');
    assert.equal(vision.turns[0].read.run.session_state, 'open_idle', 'and the session was idle between them');
    assert.equal(ledgerRowsOf(fx.home, p.id, vision.run.id).length, 2, 'a ledger row per turn');
    assert.equal(projectRow(fx.home, p.id).idea_version, 2);
    const run = runsOfProject(fx.home, p.id).find((r) => r.id === vision.run.id);
    assert.deepEqual([run.kind, run.state, run.outcome], ['session', 'ended', 'completed']);
  });

  test('(c) the Spec Writer session: the parse finding at the first save names R2.2, the second save is clean; spec_revisions 1 with its digest, requirements with criteria text, modules, environments by name, spec_ready', () => {
    const { fx, p, spec } = J;
    assert.ok(spec.saves[0].findings?.some((f) => f.code === 'spec_criterion_mismatch' && JSON.stringify(f).includes(SPEC_DEFECT.criterion)), `the first save names ${SPEC_DEFECT.criterion} (${JSON.stringify(spec.saves[0].findings)})`);
    assert.deepEqual(spec.saves[1].findings ?? [], [], 'the second save has no finding');
    const [rev] = specRevisions(fx.home, p.id);
    assert.deepEqual([rev.version, /^[0-9a-f]{64}$/.test(rev.semantic_digest ?? '')], [1, true]);
    const reqs = requirementsOf(fx.home, p.id);
    assert.deepEqual(reqs.map((r) => r.key), ['R1', 'R2', 'R3', 'R4']);
    assert.ok(reqs.every((r) => Array.isArray(r.criteria) && r.criteria.every((c) => typeof c === 'object' ? typeof c.text === 'string' : typeof c === 'string')), 'criteria with text');
    assert.deepEqual(modulesOf(fx.home, p.id).map((m) => m.name).sort(), ['lib', 'service']);
    assert.ok(eventsAbout(fx.home, 'baseline.spec_approved', p.id).length >= 1);
  });

  test('(d) the Architect session: before the answer no baseline, stage or work exists though the saves are committed; after both rows one publication with two stages depending on the stage-code milestone and authoring readiness; developing', () => {
    const { fx, p, beforeAnswer, plan } = J;
    assert.deepEqual([beforeAnswer.snapshot.plans, beforeAnswer.snapshot.work, beforeAnswer.snapshot.baseline], [0, 0, 'spec_ready'], 'nothing before the answer');
    assert.equal(planChecks(fx.home, p.id).some((c) => c.outcome === 'passed' && c.bundle === beforeAnswer.arch.decisions.architecture_approval.manifest.bundle), true, 'the check ran against the prospective bundle');
    assert.deepEqual([plan.phase_number, plan.generation, Boolean(plan.active)], [1, 1, true]);
    const stages = stagesOfPlan(fx.home, plan.id);
    assert.equal(stages.length, 2);
    const builds = workOf(fx.home, p.id, 'stage_build').filter((w) => stages.some((s) => s.id === w.subject?.stage));
    assert.equal(builds.length, 2);
    assert.ok(builds.every((w) => JSON.stringify(w.depends_on).includes('authoring_ready')), 'each depends on the authoring readiness');
    assert.ok(builds.some((w) => JSON.stringify(w.depends_on).includes('stage_code')), 'stage 2 on stage 1\'s code');
    assert.equal(eventsAbout(fx.home, 'plan.published', p.id).length >= 1, true);
  });

  test('(e) phase 1\'s check authoring: the proposal unclassifiable (check_commands), approved by the harness as the human; no Builder launched before the application; the checks exist in the effective version before any build', () => {
    const { fx, p, ctx, authoring } = J;
    const toolchain = ctx.humanActs.filter((h) => h.kind === 'check_correction_unclassifiable');
    assert.equal(toolchain.length, 1, `one toolchain decision answered by the harness (${JSON.stringify(ctx.humanActs)})`);
    assert.ok(authoring.ready.authoring_ready_at, 'authoring_ready_at set');
    const readyAt = Date.parse(authoring.ready.authoring_ready_at);
    const builders = fx.scripted.launches({ work_kind: 'stage_build' });
    assert.ok(builders.length >= 2, 'the Builders launched afterwards');
    assert.deepEqual(builders.filter((l) => Date.parse(l.at) < readyAt).map((l) => l.at), [], `no Builder launched before the application (readiness at ${authoring.ready.authoring_ready_at})`);
    const authoringRun = runsOfProject(fx.home, p.id).find((r) => r.role === 'verifier' && workOf(fx.home, p.id, 'check_authoring').some((w) => w.id === r.work_item));
    assert.ok(authoringRun?.finished_at && Date.parse(authoringRun.finished_at) <= readyAt, 'the Verifier\'s authoring run ended before the readiness');
    const versions = protectedVersionsOf(fx.home, p.id);
    const effectiveAtReadiness = versions.find((v) => v.id === authoring.ready.authoring_ready_by) ?? versions.find((v) => v.change_kind === 'unclassifiable');
    assert.ok(effectiveAtReadiness, 'readiness names the applied protected version');
    const results = resultsOf(fx.home, p.id);
    const firstBuilder = Date.parse(builders[0].at);
    assert.equal(results.filter((r) => Date.parse(r.created_at) < firstBuilder).length, 0, 'no check result before the first Builder: the checks exist, and nothing has run them (D3 registers at a nomination)');
    const keys = checkRows(fx.home, p.id).filter((c) => c.protected_version === effectiveAtReadiness.id).map((c) => c.key).sort();
    assert.deepEqual(keys, ['accept-r1', 'accept-r2', 'integration', 'lint', 'operation', 'smoke'], 'the checks exist in the effective version at readiness');
  });

  test('(f) stages 1 and 2: each integrated then verified through engine-run checks in check domains, a Verifier and a Reviewer run, no decision raised but the routed; the serial path recorded (the run caps as built)', () => {
    const { fx, p, plan } = J;
    const stages = stagesOfPlan(fx.home, plan.id);
    assert.deepEqual(stages.map((s) => s.status), ['verified', 'verified']);
    const runs = runsOfProject(fx.home, p.id).filter((r) => r.kind !== 'session');
    const kinds = (kind) => runs.filter((r) => r.work_kind === kind || r.role === kind);
    assert.ok(kinds('verifier').length >= 2 && kinds('reviewer').length >= 2, `Verifier and Reviewer runs per stage (${JSON.stringify(runs.map((r) => r.role))})`);
    for (const c of J.afterPhase1.candidates) {
      const xs = executionsOf(fx.home, c.id).filter((x) => x.status === 'recorded');
      assert.ok(xs.length > 0, `candidate ${c.seq} has engine-run checks`);
      for (const x of xs) {
        const d = domainRow(fx.home, x.domain);
        assert.equal(d?.check_execution, x.id, `${x.key} ran in a check domain of its own`);
      }
    }
    const results = resultsOf(fx.home, p.id);
    assert.ok(results.every((r) => r.runner_qualification), 'every result names the self-tested runner, none a fixture');
    // The path: the run caps as built admit one role run at a time, so the stage-2 Builder started after stage 1's Verifier ended.
    const overlapping = runs.filter((a) => runs.some((b) => b.id !== a.id && a.started_at && b.started_at && a.finished_at && b.started_at < a.finished_at && b.started_at >= a.started_at));
    J.path = overlapping.length === 0 ? 'serial' : 'pipelined';
    console.log(`# note: M401 (f) path: ${J.path} (the run caps as built; two runs at once is slice 37's)`);
    assert.ok(['serial', 'pipelined'].includes(J.path));
  });

  test('(g) phase 1 complete: completed_at and completion_binding, phase_verification with a phase sign-off bound to the candidate, protected version, spec revision and generation, baseline.phase_complete once, one replan, phase 2 published approved_by engine:plan_check with changes_* empty and no human act', () => {
    const { fx, p, ctx, phase1, phase2Plan } = J;
    assert.ok(phase1.completed_at && phase1.completion_binding);
    const signoff = signoffsOfProject(fx.home, p.id).find((s) => s.scope === 'phase' && s.candidate === phase1.completion_binding.candidate);
    assert.ok(signoff, 'the phase sign-off on the bound candidate');
    assert.deepEqual([signoff.binding?.protected_version, signoff.binding?.spec_revision, signoff.binding?.plan_generation], [phase1.completion_binding.protected_version, phase1.completion_binding.spec_revision, phase1.completion_binding.generation]);
    assert.equal(eventsAbout(fx.home, 'baseline.phase_complete', p.id).filter((e) => e.subject?.phase_plan === phase1.id).length, 1);
    const replan = workOf(fx.home, p.id, 'replan').filter((w) => w.trigger_source === 'phase_complete');
    assert.equal(replan.length, 1, 'one replan from the completion');
    assert.deepEqual([phase2Plan.approved_by, phase2Plan.routing], ['engine:plan_check', 'registered'], `published by computed routing (${JSON.stringify(phase2Plan)})`);
    const check = planChecks(fx.home, p.id).find((c) => c.plan === phase2Plan.id || c.bundle === phase2Plan.bundle);
    assert.ok(check, 'its plan check');
    assert.deepEqual([check.changes_architecture?.changed, check.changes_adrs?.added, check.changes_adrs?.changed, check.changes_adrs?.deleted, check.changes_roadmap?.assignments], [false, [], [], [], []], `changes_* all empty (${JSON.stringify(check)})`);
    const acts = ctx.humanActs.filter((h) => h.kind !== 'check_correction_unclassifiable' && h.kind !== 'spec_change' && h.kind !== 'spec_change_request');
    assert.deepEqual(acts, [], `no human act in the phase boundary (${JSON.stringify(ctx.humanActs)})`);
  });

  test('(h) the spec change between the phases: version 2, spec_evidence_generation 2, the listed results invalidated spec_changed with obligations recorded, check_correction and replan done, every gate afterwards on version 2', () => {
    const { fx, p, change } = J;
    const [v1, v2] = specRevisions(fx.home, p.id);
    assert.ok(v2 && v2.supersedes === v1.id, 'version 2 supersedes 1');
    assert.equal(projectRow(fx.home, p.id).spec_evidence_generation, 2);
    const invalidated = resultsOf(fx.home, p.id).filter((r) => r.invalidated_reason === 'spec_changed');
    assert.ok(invalidated.length > 0, 'accept-r2\'s results invalidated spec_changed');
    const obligations = obligationsOf(fx.home, p.id);
    assert.ok(obligations.some((o) => o.reason === 'spec_changed' && o.generation === 2 && (o.criteria ?? []).includes('R2.1')), `an obligation for the check covering R2.1 (${JSON.stringify(obligations)})`);
    const correction = workOf(fx.home, p.id, 'check_correction');
    assert.ok(correction.some((w) => w.status === 'complete'), 'check_correction done');
    const replans = workOf(fx.home, p.id, 'replan').filter((w) => w.trigger_source === 'spec_change');
    assert.ok(replans.some((w) => w.status === 'complete'), 'the replan the change registered is done');
    const later = candidatesOfProject(fx.home, p.id).filter((c) => Date.parse(c.nominated_at) > Date.parse(change.approved.approved_at));
    assert.ok(later.length > 0 && later.every((c) => c.spec_revision === v2.id), 'every later candidate is on version 2');
    assert.ok(obligations.filter((o) => o.reason === 'spec_changed').every((o) => o.resolved_at), 'every spec_changed obligation resolved before the end');
  });

  test('(i) phase 2 as (f) and (g), without a next phase', () => {
    const { fx, p, phase2 } = J;
    assert.ok(phase2.completed_at && phase2.completion_binding);
    assert.deepEqual(stagesOfPlan(fx.home, phase2.id).map((s) => s.status), ['verified', 'verified']);
    assert.equal(workOf(fx.home, p.id, 'replan').filter((w) => w.trigger_source === 'phase_complete' && w.trigger_id === phase2.id).length, 0, 'no replan after the last phase');
    assert.ok(evaluationsOfKind(fx.home, p.id, 'phase').some((e) => e.candidate === phase2.completion_binding.candidate && e.outcome === 'satisfied'));
  });

  test('(j) the engine\'s request under policy through requestDeployment after the last phase: one row requested_by policy with its key, the seal and the authorization before the deploy work, none before the request; alpha_authorize over the whole set; alpha_complete; alpha_deployed on a real unit read by exact name; no second request', () => {
    const { fx, p, phase2, deployed, afterPhase1 } = J;
    assert.deepEqual(afterPhase1.requests.filter((r) => r.requested_by === 'policy' && r.request_key?.completion_binding?.candidate === phase2.completion_binding.candidate), [], 'no request for the last phase before it completed');
    const requests = deploymentRequests(fx.home, p.id).filter((r) => r.requested_by === 'policy');
    const last = requests.find((r) => r.request_key?.candidate === deployed.id);
    assert.ok(last, `the policy requested the final candidate (${JSON.stringify(requests)})`);
    assert.deepEqual(last.request_key.completion_binding, phase2.completion_binding);
    assert.equal(requests.filter((r) => JSON.stringify(r.request_key) === JSON.stringify(last.request_key)).length, 1, 'one request for the key');
    assert.equal(J.requestsAfterTick.length, deploymentRequests(fx.home, p.id).length, 'a further tick created no request');
    assert.equal(J.requestsAfterTick.filter((r) => r.requested_by === 'policy' && JSON.stringify(r.request_key) === JSON.stringify(last.request_key)).length, 1, 'still one for the key after a further tick');
    const auth = authorizationsOfProject(fx.home, p.id).find((a) => a.id === last.authorization);
    assert.ok(auth && ['issued', 'consumed'].includes(auth.status));
    const work = workOf(fx.home, p.id, 'deploy').filter((w) => w.subject?.authorization === auth.id);
    assert.equal(work.length, 1, 'one deploy work item for the derived authorization');
    assert.equal(deployed.progress, 'alpha_deployed');
    assert.ok(J.svc?.unit && J.svc.unit.startsWith(unitPrefix(fx.home, J.env.id)), `the unit under this home's prefix (${J.svc?.unit})`);
    assert.deepEqual([J.unitShow?.LoadState, J.unitShow?.ActiveState], ['loaded', 'active'], `read from the host by exact name while it ran (${JSON.stringify(J.unitShow)})`);
  });

  test('(k) the pace read: every §7.6 figure present or unknown with its reason; human wait a measured zero in the stages, the routed decisions\' open time at the project', () => {
    const { pace } = J;
    for (const key of ['project', 'sessions', 'phases', 'stages', 'runs', 'domains', 'host']) assert.ok(key in pace, `the read has ${key} (${Object.keys(pace).join(', ')})`);
    const leaves = paceLeaves(pace);
    for (const [path, value] of leaves) {
      const ok = typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' || (value && typeof value === 'object' && typeof value.unknown === 'string');
      assert.ok(ok, `${path}: a figure is a value or {unknown: <reason>}, never null (${JSON.stringify(value)})`);
    }
    for (const s of pace.stages) assert.equal(s.human_wait, 0, `stage ${s.number ?? s.id}: human wait a measured zero under phase (${JSON.stringify(s.human_wait)})`);
    assert.ok(Array.isArray(pace.project.decisions) && pace.project.decisions.some((d) => d.kind === 'check_correction_unclassifiable' && d.open_seconds > 0), `the routed decisions' open time (${JSON.stringify(pace.project.decisions)})`);
    assert.ok(typeof pace.project.created_to_alpha_deployed === 'number');
    assert.equal(pace.host.autonomy, 'phase');
  });

  test('(l) the teardown applied; nothing of the prefix left; no check result from a fixture; no decision answered by a role', () => {
    const { fx, p } = J;
    assert.deepEqual(J.afterTeardown.units, [], 'no unit of the prefix');
    assert.deepEqual(J.afterTeardown.cgroups, [], 'no cgroup of the prefix');
    assert.deepEqual(J.afterTeardown.runFiles, [], 'no runtime file of the environment');
    assert.ok(resultsOf(fx.home, p.id).every((r) => r.runner_qualification && !String(r.runner_qualification).includes('fixture')), 'no check result from a fixture');
    const answered = withStore(fx.home, (db) => db.prepare('SELECT "answer" FROM "decisions" WHERE "project" = ? AND "status" = ?').all(p.id, 'consumed')).map((r) => JSON.parse(r.answer ?? '{}'));
    assert.ok(answered.every((a) => (a.actor ?? 'human') === 'human'), 'every answer the human\'s (the harness as the owner)');
  });
});
