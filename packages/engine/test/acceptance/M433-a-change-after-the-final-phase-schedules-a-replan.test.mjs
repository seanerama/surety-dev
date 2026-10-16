// M433 (d) as E153 item 1 amends it (Sean, 2026-10-16; D6 §4.5; D7 G7, Q6;
// kernel lane; SEAM §471). "An approved specification change that creates
// implementation obligations when every phase of the roadmap is complete
// schedules an Architect replan; the delivery phase it proposes follows the
// existing roadmap and plan approval rules (D6 §5), then ordinary building,
// verification and deployment." Written before the engine change (tests
// first); M433 (d)'s "replan registered when the current or a later phase is
// touched and not otherwise" gains this exception.
//
// The reference project in its one-phase form (R1, R2; `journeyProject`
// `onePhase`) is carried by its own path to phase 1's completion, so the
// build is complete; the scenario is `harness/journey/final153.mjs`'s.
//   (a) a change rewording R1.1 so that the built `sum` no longer meets it:
//       the correction applied, the corrected checks fail on the last
//       candidate; exactly one `replan` from the change (an Architect
//       one-shot) proposing a delivery phase (a roadmap revision moving R1
//       into a new phase 2, with one stage); the plan routed to
//       `plan_approval` and approved by the owner; phase 2 authored, built,
//       verified and complete; with `alpha_deploy` `on_phase_complete` the
//       newest candidate `alpha_deployed` through the policy's request;
//   (b) repeated ticks and an engine restart after the approval: no second
//       replan (one per change request and roadmap generation), and none
//       from phase 2's completion either;
//   (c) phase 1 keeps its history: its plan row (completion binding,
//       generation, status), its stages, its phase sign-off, its satisfied
//       phase evaluation and its one `baseline.phase_complete`, unchanged
//       after the replan and the delivery phase;
//   (d) a proposal that cannot be built: the replan's plan refused by the
//       plan check, and its repair refused too; or the replan's run failing
//       each time: an open owner question (`blocker`) on the replan item
//       naming the cause, never a silent stall;
//   (e) no implementation impact: a text-only change (R2's criteria
//       reordered), and a change whose obligations the corrections discharge
//       with the existing code passing (fresh results of the corrected checks
//       on the last candidate, under the corrected protected version): no
//       replan, no roadmap revision, no phase beyond 1, no stage.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { tick, waitForIdle } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import {
  ROUTED_KINDS,
  alphaDeployed,
  alphaReady,
  blockers,
  candidatesOfProject,
  deploymentRequests,
  eventsAbout,
  obligationsOf,
  openDecisions,
  phaseCompleted,
  phasePlansOf,
  planChecks,
  planOfPhase,
  pump,
  requirementsOf,
  roadmapRevisions,
  runsOfProject,
  specRevisions,
  stagesOfPlan,
  workOf,
} from './harness/journey/drive.mjs';
import { journeyProject, postChange } from './harness/journey/review31b.mjs';
import {
  CORRECTED_KEYS,
  DELIVERY_STAGE,
  INTEGRATION_LIB_STRINGS_TEST,
  INTEGRATION_LIB_TYPED_TEST,
  SPEC_V2_REORDERED,
  SPEC_V2_STRINGS,
  SPEC_V2_TYPED,
  SUM_STRINGS_TEST,
  SUM_TYPED_TEST,
  allReplans,
  beyondPhaseOne,
  changeReplans,
  correctionOf,
  exitsFor,
  latestCandidate,
  phaseOneHistory,
  scriptsAfterPhaseOne,
  unbuildableReplan,
} from './harness/journey/final153.mjs';
import { script } from './harness/scripted.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const R1_CHANGE = [{ key: 'R1', kind: 'criteria_changed', reason: 'E153: R1.1 changed' }];
const STRINGS_CORRECTION = correctionOf(SUM_STRINGS_TEST, INTEGRATION_LIB_STRINGS_TEST, 'R1.1 now asks for numeric strings: accept-r1 and integration-lib read them.');
const TYPED_CORRECTION = correctionOf(SUM_TYPED_TEST, INTEGRATION_LIB_TYPED_TEST, 'R1.1 now names the type: accept-r1 and integration-lib read it.');

// The last candidate's results of the corrected checks under the protected
// version the correction made effective (fresh evidence under the new
// generation, D6 §4.5), once both are recorded: {key: exit_status}.
function correctedResults(home, project) {
  const last = latestCandidate(home, project);
  if (!last) return null;
  const resolved = obligationsOf(home, project).filter((o) => o.reason === 'spec_changed');
  if (resolved.length === 0 || resolved.some((o) => !o.resolved_at)) return null;
  const versions = new Set(resolved.map((o) => o.resolved_by));
  const out = {};
  for (const r of rows(home, 'SELECT c."key", r."exit_status", r."protected_version" FROM "check_results" r JOIN "checks" c ON c."id" = r."check" WHERE r."candidate" = ? ORDER BY r."execution_seq"', last.id)) {
    if (CORRECTED_KEYS.includes(r.key) && versions.has(r.protected_version)) out[r.key] = r.exit_status;
  }
  return CORRECTED_KEYS.every((k) => k in out) ? out : null;
}

// What holds the project, for a failure's message.
const stateOf = (home, project) => ({
  replans: allReplans(home, project).map((w) => [w.trigger_source, w.trigger_id, w.status]),
  plans: phasePlansOf(home, project).map((x) => [x.phase_number, x.status, x.published_at ? 'published' : null, x.completed_at ? 'completed' : null]),
  roadmaps: roadmapRevisions(home, project).map((r) => r.version),
  open: openDecisions(home, project).map((d) => [d.kind, d.subject_id]),
  holds: blockers(home, project),
});

// The one-phase project at phase 1's completion, the scenario's scripts in
// place, the change posted and approved (version 2). `alpha`: alpha
// configured before phase 1 completes under `on_phase_complete`, and phase
// 1's candidate deployed first. Returns {fx, p, ctx, request, old, exits, history}.
async function changedAfterTheLastPhase(t, { spec, changes = R1_CHANGE, correction, replan, failsBefore, alpha = false, policy = {} }) {
  const { fx, p, ctx } = await journeyProject(t, { onePhase: true, policy: { ...(alpha ? { alpha_deploy: 'on_phase_complete', deploy_auto_retries_max: 0 } : {}), ...policy } });
  if (alpha) await alphaReady(fx, ctx, { answers: [{ result: 'issued', apply: true }, { result: 'issued', apply: true }] });
  await phaseCompleted(fx, ctx, 1);
  if (alpha) await alphaDeployed(fx, ctx);
  await waitForIdle(fx.home, p.id);
  // The build is complete: one phase in the roadmap, completed.
  assert.deepEqual(phasePlansOf(fx.home, p.id).map((x) => [x.phase_number, x.status]), [[1, 'completed']], 'the fixture is live: every phase of the roadmap is complete');
  assert.deepEqual(allReplans(fx.home, p.id), [], 'the fixture is live: phase 1\'s completion registered no replan (no next phase, M406 (b))');
  const history = phaseOneHistory(fx.home, p.id);
  const old = new Set(candidatesOfProject(fx.home, p.id).map((c) => c.id));
  const exits = exitsFor(old, { failsBefore });
  scriptsAfterPhaseOne(fx, { spec, changes, correction: correction ?? script.complete(), ...(replan ? { replan } : {}) });
  await postChange(fx, ctx, 'The owner\'s change after the last phase.');
  await pump(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'spec version 2 approved', max: 60, exits });
  const request = rows(fx.home, 'SELECT * FROM "spec_change_requests" WHERE "project" = ? ORDER BY "seq"', p.id).at(-1);
  assert.equal(request?.status, 'approved', 'the fixture is live: the change is approved');
  return { fx, p, ctx, request, old, exits, history };
}

// Pumps (answering the routed kinds but `plan_approval`) until the change's
// replan exists, or until the corrected checks' fresh results are recorded
// on the last candidate and `quiet` more rounds have passed with none.
async function untilReplanOrQuiet(fx, ctx, request, exits, { quiet = 15 } = {}) {
  let after = 0;
  ctx.answerKinds = ROUTED_KINDS.filter((k) => k !== 'plan_approval');
  return pump(
    fx,
    ctx,
    () => {
      const items = changeReplans(fx.home, ctx.project, request.id);
      if (items.length > 0) return { items };
      if (correctedResults(fx.home, ctx.project) !== null && ++after > quiet) return { items: [] };
      return undefined;
    },
    { what: 'the change\'s replan, or the corrected checks recorded and the project quiet', max: 120, exits },
  );
}

describe('M433 (d), E153 item 1: an approved change with an implementation obligation after the last phase schedules one replan, whose delivery phase is built and deployed (shared)', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    Object.assign(J, await changedAfterTheLastPhase(shared.context, { spec: SPEC_V2_STRINGS, correction: STRINGS_CORRECTION, failsBefore: true, alpha: true }));
    J.found = await untilReplanOrQuiet(J.fx, J.ctx, J.request, J.exits);
  });
  after(shared.cleanup);

  test('(a) the corrected checks fail on the last candidate; exactly one replan, from the change, an Architect one-shot', async () => {
    const { fx, p, request } = J;
    const fresh = correctedResults(fx.home, p.id);
    assert.ok(fresh === null || CORRECTED_KEYS.every((k) => fresh[k] !== 0), `the fixture is live: the corrected checks did not pass on the last candidate (${JSON.stringify(fresh)})`);
    const items = changeReplans(fx.home, p.id, request.id);
    assert.equal(items.length, 1, `exactly one replan from the change (trigger spec_change, ${request.id}) though every phase is complete (state ${JSON.stringify(stateOf(fx.home, p.id))})`);
    assert.equal(allReplans(fx.home, p.id).length, 1, 'and no other replan');
    const item = items[0];
    assert.equal(item.trigger_generation, 1);
    assert.ok(JSON.stringify(item.trigger_evidence ?? item.subject ?? null).includes(request.id), `its evidence names the request (${JSON.stringify([item.subject, item.trigger_evidence])})`);
    await pump(fx, J.ctx, () => runsOfProject(fx.home, p.id).find((r) => r.work_item === item.id && r.state === 'ended'), { what: 'the replan\'s run to end', max: 30, exits: J.exits });
    const run = runsOfProject(fx.home, p.id).find((r) => r.work_item === item.id);
    assert.equal(run.role, 'architect', 'the replan is an Architect run');
    assert.equal(run.kind, 'one_shot', 'a one-shot, not a session');
  });

  test('(b) repeated ticks and a restart after the approval: still one replan for the change, and no other', async () => {
    const { fx, p, request } = J;
    await tick(fx.engine, p.id, { rounds: 3 });
    await waitForIdle(fx.home, p.id);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    await waitForIdle(fx.home, p.id);
    assert.equal(changeReplans(fx.home, p.id, request.id).length, 1, `one replan for the change and roadmap generation after ticks and a restart (state ${JSON.stringify(stateOf(fx.home, p.id))})`);
    assert.equal(allReplans(fx.home, p.id).length, 1, 'no second replan of any trigger');
  });

  test('(a) the delivery phase through the existing rules: plan_approval with the roadmap revision, approved; phase 2 authored, built, verified, complete; Alpha by the policy\'s request', async () => {
    const { fx, p, ctx } = J;
    ctx.answerKinds = ROUTED_KINDS.filter((k) => k !== 'plan_approval');
    const approval = await pump(fx, ctx, () => openDecisions(fx.home, p.id).find((d) => d.kind === 'plan_approval'), { what: 'the delivery phase\'s plan_approval', max: 40, exits: J.exits });
    // Routed to the owner: the proposal revises the roadmap (D6 §5.4).
    const check = planChecks(fx.home, p.id).at(-1);
    assert.equal(check?.outcome, 'passed', `the plan check passed (${JSON.stringify(check?.reasons)})`);
    assert.deepEqual(check.changes_roadmap?.phases_added, [2], 'the diff adds phase 2');
    assert.ok((check.changes_roadmap?.assignments ?? []).includes('R1'), `and moves R1 (${JSON.stringify(check.changes_roadmap)})`);
    ctx.answerKinds = ROUTED_KINDS;
    void approval;
    const published = await pump(fx, ctx, () => planOfPhase(fx.home, p.id, 2).find((x) => x.published_at), { what: 'phase 2 published', max: 20, exits: J.exits });
    assert.equal(published.approved_by, 'human', 'published on the owner\'s approval');
    assert.deepEqual(roadmapRevisions(fx.home, p.id).map((r) => r.version), [1, 2], 'roadmap version 2 published');
    assert.equal(requirementsOf(fx.home, p.id).find((r) => r.key === 'R1')?.assigned_phase, 2, 'R1 is in the delivery phase');
    const stages = stagesOfPlan(fx.home, published.id);
    assert.deepEqual(stages.map((s) => s.number), [DELIVERY_STAGE.number], 'one delivery stage');
    J.phase2 = await phaseCompleted(fx, ctx, 2, { exits: J.exits });
    assert.ok(J.phase2.authoring_ready_at, 'phase 2 was authored before it built');
    assert.deepEqual(stagesOfPlan(fx.home, published.id).map((s) => s.status), ['verified'], 'the delivery stage verified');
    assert.equal(eventsAbout(fx.home, 'baseline.phase_complete', p.id).length, 2, 'phase 2 complete: a second baseline.phase_complete');
    const deployed = await alphaDeployed(fx, ctx, { newest: true, exits: J.exits });
    assert.equal(deployed.id, J.phase2.completion_binding?.candidate, 'the newest candidate, phase 2\'s, alpha_deployed');
    const requests = deploymentRequests(fx.home, p.id).filter((r) => r.requested_by === 'policy');
    assert.ok(requests.some((r) => r.request_key?.candidate === deployed.id), `through the policy's request (${JSON.stringify(requests.map((r) => [r.requested_by, r.request_key?.candidate]))})`);
    await tick(fx.engine, p.id, { rounds: 3 });
    await waitForIdle(fx.home, p.id);
    assert.equal(allReplans(fx.home, p.id).length, 1, '(b) phase 2\'s completion, the last phase, registers no replan');
  });

  test('(c) phase 1 keeps its history after the replan and the delivery phase', () => {
    const { fx, p } = J;
    assert.ok(J.phase2?.completed_at, 'the fixture is live: the delivery phase completed');
    const now = phaseOneHistory(fx.home, p.id);
    assert.deepEqual(now.plan, J.history.plan, 'phase 1\'s plan row: completion binding, generation, status, publication unchanged');
    assert.deepEqual(now.stages, J.history.stages, 'its stages: status and integrated revision unchanged');
    assert.deepEqual(now.signoffs, J.history.signoffs, 'its phase sign-off unchanged, and no other on its candidate');
    assert.deepEqual(now.phaseEvaluations, J.history.phaseEvaluations, 'its phase evaluations on its bound candidate unchanged');
    assert.deepEqual(now.completions, J.history.completions, 'its one baseline.phase_complete');
  });
});

describe('M433 (d), E153 item 1 (d): a proposal that cannot be built raises an owner question naming the cause', () => {
  test('the replan\'s plan refused by the plan check, and its repair too: the replan item parks with an open blocker naming the refusal', async (t) => {
    const { fx, p, ctx, request, exits } = await changedAfterTheLastPhase(t, { spec: SPEC_V2_STRINGS, correction: STRINGS_CORRECTION, failsBefore: true, replan: [unbuildableReplan(), unbuildableReplan(), unbuildableReplan()] });
    const found = await untilReplanOrQuiet(fx, ctx, request, exits);
    assert.equal(found.items.length, 1, `the change registered its replan (state ${JSON.stringify(stateOf(fx.home, p.id))})`);
    const item = found.items[0];
    const blocker = await pump(fx, ctx, () => openDecisions(fx.home, p.id).find((d) => d.kind === 'blocker' && d.subject_id === item.id), { what: 'an owner question on the refused replan', max: 40, exits }).catch((err) => {
      throw new Error(`${err.message}; state ${JSON.stringify(stateOf(fx.home, p.id))}`);
    });
    assert.match(blocker.question ?? '', /PLAN_MODULE_OUTSIDE_PHASE/, `the question names the plan check's refusal (${blocker.question})`);
    assert.ok(blocker.options.some((o) => o.key === 'retry'), `and is actionable (${JSON.stringify(blocker.options.map((o) => o.key))})`);
    assert.deepEqual(beyondPhaseOne(fx.home, p.id).stages, [], 'no stage registered from the refused proposal');
  });

  test('the replan\'s run failing each time: the replan item parks with an open blocker naming the failure', async (t) => {
    const { fx, p, ctx, request, exits } = await changedAfterTheLastPhase(t, { spec: SPEC_V2_STRINGS, correction: STRINGS_CORRECTION, failsBefore: true, replan: script.crash() });
    const found = await untilReplanOrQuiet(fx, ctx, request, exits);
    assert.equal(found.items.length, 1, `the change registered its replan (state ${JSON.stringify(stateOf(fx.home, p.id))})`);
    const item = found.items[0];
    const blocker = await pump(fx, ctx, () => openDecisions(fx.home, p.id).find((d) => d.kind === 'blocker' && d.subject_id === item.id), { what: 'an owner question on the failing replan', max: 40, exits }).catch((err) => {
      throw new Error(`${err.message}; state ${JSON.stringify(stateOf(fx.home, p.id))}`);
    });
    const failed = runsOfProject(fx.home, p.id).filter((r) => r.work_item === item.id && r.state === 'ended');
    assert.ok(failed.length > 0 && failed.every((r) => r.outcome !== 'completed'), `the replan's runs failed (${JSON.stringify(failed.map((r) => [r.outcome, r.reason_class]))})`);
    assert.match(blocker.question ?? '', /replan/, `the question names the replan item (${blocker.question})`);
    assert.match(blocker.question ?? '', /repair|failed|crash|exit/i, `and the failure (${blocker.question})`);
    assert.ok(blocker.options.some((o) => o.key === 'retry'), `and is actionable (${JSON.stringify(blocker.options.map((o) => o.key))})`);
  });
});

describe('M433 (d), E153 item 1 (e): a change with no implementation impact after the last phase creates no replan and no build phase', () => {
  test('a text-only change (R2\'s criteria reordered): no obligation, no replan, no roadmap revision, no phase beyond 1, no stage', async (t) => {
    const { fx, p, ctx, request, exits } = await changedAfterTheLastPhase(t, { spec: SPEC_V2_REORDERED, changes: [{ key: 'R2', kind: 'criteria_changed', reason: 'reordered' }], failsBefore: false });
    assert.deepEqual(obligationsOf(fx.home, p.id).filter((o) => o.request === request.id), [], 'the fixture is live: the change records no obligation');
    for (let i = 0; i < 15; i++) await pump(fx, ctx, () => false, { max: 1, exits }).catch(() => null);
    assert.deepEqual(allReplans(fx.home, p.id), [], 'no replan');
    assert.deepEqual(beyondPhaseOne(fx.home, p.id), { plans: [], stages: [], roadmaps: [1] }, 'no roadmap revision, no plan beyond phase 1, no stage');
    assert.deepEqual(workOf(fx.home, p.id, 'stage_build').length, 2, 'no stage_build beyond phase 1\'s two');
  });

  test('a change whose obligations the correction discharges, the existing code passing the corrected checks on the last candidate: no replan, no build phase', async (t) => {
    const { fx, p, ctx, request, exits } = await changedAfterTheLastPhase(t, { spec: SPEC_V2_TYPED, correction: TYPED_CORRECTION, failsBefore: false });
    const found = await untilReplanOrQuiet(fx, ctx, request, exits);
    const fresh = correctedResults(fx.home, p.id);
    assert.deepEqual(fresh, Object.fromEntries(CORRECTED_KEYS.map((k) => [k, 0])), `the corrected checks passed on the last candidate under the corrected version (fresh evidence) (${JSON.stringify(fresh)})`);
    assert.deepEqual(found.items, [], 'no replan from the change');
    assert.deepEqual(allReplans(fx.home, p.id), [], 'no replan at all');
    assert.deepEqual(beyondPhaseOne(fx.home, p.id), { plans: [], stages: [], roadmaps: [1] }, 'no roadmap revision, no plan beyond phase 1, no stage');
    assert.deepEqual(workOf(fx.home, p.id, 'stage_build').length, 2, 'no stage_build beyond phase 1\'s two');
  });
});
