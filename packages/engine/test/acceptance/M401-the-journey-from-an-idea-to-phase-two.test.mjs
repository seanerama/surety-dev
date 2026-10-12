// M401, the journey from an idea to Alpha on the scripted backend, part 1 of
// 2: from the idea to phase 2 published (slice 31b; project lane, run with
// `npm test` like the sandbox lane, E92 item 2 (1)). M5 plan §3.1 M401 (a)
// to (g); D6-J01; D6 §1 steps 1 to 9; E40; BS5 §3, §4.1 rules 12, 13, 20;
// SEAM.md §§350 to 357. Part 2 is `M401-the-journey-from-phase-two-to-alpha`.
//
// The reference project "Tally" (§342), T2, on real `role` and `check`
// domains (D2's launcher and init running the scripted role program), the
// check runner qualified by its own self-test at every start; `autonomy:
// phase`, `alpha_deploy: on_phase_complete`, `classifier_authority:
// authoritative` (the ruling), the first phase's `check_commands` the one
// human act within the build (Q9). The harness answers every human act of
// D6 §1 through the owner's production routes and installs nothing by
// fixture: no plan, candidate, phase check, readiness or authorization
// (rule 20). The run caps stay as built (the ruling): (f) records the
// serial path. No environment is configured in this part, so no unit is
// created.
//
// Made once in the `before` hook (`harness/journey/project.mjs`); each case
// reads one clause of the row.
//
// SAFETY (BS5 §4.1; E64; SEAM.md §§257, 356, 357). The test acts on no unit
// and signals nothing but its own engine (the verified kill); the file ends
// with `operatorGuard`; every engine start carries the real-adapter switch
// and the runner self-test.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { operatorGuard } from './harness/deploy/host.mjs';
import { sharedFixture } from './harness/gates.mjs';
import {
  checkRows,
  eventsAbout,
  executionsOf,
  modulesOf,
  planChecks,
  projectRow,
  protectedVersionsOf,
  requirementsOf,
  resultsOf,
  runsOfProject,
  signoffsOfProject,
  specRevisions,
  stagesOfPlan,
  workOf,
} from './harness/journey/drive.mjs';
import { journeyEngine, toPhaseTwoPublished } from './harness/journey/project.mjs';
import { SPEC_DEFECT } from './harness/journey/reference.mjs';
import { ledgerRowsOf, turnRows } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';

const domainRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(id));

describe('M401 the journey from an idea to Alpha, part 1: the idea to phase 2 published, on the project lane', () => {
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
    const acts = ctx.humanActs.filter((h) => h.kind !== 'check_correction_unclassifiable');
    assert.deepEqual(acts, [], `no human act within the build but the toolchain proposal, none at the phase boundary (${JSON.stringify(ctx.humanActs)})`);
  });

});
