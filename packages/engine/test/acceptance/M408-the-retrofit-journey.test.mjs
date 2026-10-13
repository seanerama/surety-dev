// M408, the retrofit journey on the scripted backend (slice 32; project
// lane, run with `npm test` like the sandbox lane). M5 plan §3.2 M408 (a) to
// (h); D6-J03; D6 §8.1 steps 1 to 7, §8.3; E6; E40; B10 to B13; E141 item 4
// (the README's false claim answered `defect`); BS5 §3, §4.1 rules 12, 13,
// 20; SEAM.md §§376 to 386. Case (i) is its own file,
// `M408-a-confirmed-requirement-that-fails-blocks-conformance` (the driver's
// ruling: split, SEAM.md §357's way).
//
// The adopted fixture "Sums" (`harness/retrofit/repo.mjs`): its own tests
// importing an assertion helper, a README with one false claim, a tag, a CI
// file, no Surety records. `full` mode, T1, `alpha_deploy: manual`, scripted
// roles in real `role` and `check` domains, the check runner self-tested at
// every start, `classifier_authority` authoritative. The harness answers
// every human act of §8.1 through the owner's production routes and commands
// and installs nothing by fixture: the adoption (`surety project adopt`), the
// mode, the spec approval with the four confirmations (R4 `defect`), the
// architecture and conformance plan, the toolchain proposal, and the deploy
// (`surety deploy`), which under `manual` opens the Alpha barrier.
//
// SAFETY (BS5 §4.1; E64; SEAM.md §§257, 356). The only units are the engine's
// own and the Alpha service's under the test home's prefix, ended by the
// engine's teardown in `after`; the test signals nothing but its own engine;
// the file ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { operatorGuard } from './harness/deploy/host.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { answer, decisionsOfKind } from './harness/decisions.mjs';
import {
  authoringReady,
  candidatesOfProject,
  checkRows,
  environmentsOf,
  eventsAbout,
  evaluationsOfKind,
  journeyContext,
  nextPhasePublished,
  phaseCompleted,
  planOfPhase,
  projectRow,
  proposalsOf,
  requirementsOf,
  resultsOf,
  specRevisions,
  stagesOfPlan,
  workOf,
} from './harness/journey/drive.mjs';
import { alphaByCommand, endJourney, journeyEngine } from './harness/journey/project.mjs';
import { gitQuiet, parentsOf } from './harness/repos.mjs';
import { ADOPTED, KEYS, REQUIREMENTS } from './harness/retrofit/products.mjs';
import { CI_ENVIRONMENT, RELEASE_TAG, refOid } from './harness/retrofit/repo.mjs';
import {
  FULL_ANSWERS,
  adoptByCommand,
  adoptedRepo,
  adoptionModeRows,
  adoptionOf,
  chooseMode,
  confirmAndApprove,
  conformanceStages,
  pump,
  releasesOf,
  retrofitArchitectSession,
  retrofitScripts,
  retrofitSpecSession,
  specClaimsOf,
  suretyCommand,
} from './harness/retrofit/drive.mjs';
import { waitFor } from './harness/engine.mjs';

const projection = (repo, rev) =>
  gitQuiet(repo, ['ls-tree', '-r', rev])
    .split('\n')
    .filter((l) => l && !l.split('\t')[1].startsWith('.surety/'))
    .sort();

describe('M408 the retrofit journey on the project lane', () => {
  const shared = sharedFixture();
  let guard;
  let J;
  before(async () => {
    guard = operatorGuard();
    const fx = await journeyEngine(shared.context, guard, { lane: 'project' });
    retrofitScripts(fx);
    J = { fx };
    // (a) the adoption by command, the mode.
    const repo = adoptedRepo(fx);
    J.repo = repo;
    J.A = refOid(repo.path, repo.ref);
    J.adopt = adoptByCommand(fx, { repo });
    assert.equal(J.adopt.status, 0, `surety project adopt exits 0 (stdout ${J.adopt.stdout.slice(0, 400)}; stderr ${J.adopt.stderr.slice(0, 400)})`);
    const id = J.adopt.body?.project?.id;
    assert.match(id ?? '', /^proj_/, 'the answer names the project');
    await waitFor(() => projectRow(fx.home, id)?.registration_state === 'registered', { what: 'the adopted project to be registered' });
    J.p = { id, repo, A: J.A };
    J.created = { row: projectRow(fx.home, id), adoption: adoptionOf(fx.home, id) };
    J.mode = await chooseMode(fx, id, 'full');
    // (b) the retrofit Spec Writer session; approve refused while a row is open.
    J.spec = await retrofitSpecSession(fx, id);
    J.approveEarly = await answer(fx.engine, id, J.spec.approval, 'approve');
    J.confirmations = await confirmAndApprove(fx, id, FULL_ANSWERS);
    // (c) the retrofit Architect session and the conformance plan.
    J.arch = await retrofitArchitectSession(fx, id, repo);
    const ctx = journeyContext(fx, { id, repo }, { lane: 'project', tier: 'T1' });
    J.ctx = ctx;
    // (d) check authoring, the toolchain proposal the owner's.
    J.authoring = await authoringReady(fx, ctx, 1);
    // (e) conformance and (f) the phase.
    J.phase1 = await phaseCompleted(fx, ctx, 1);
    J.replansBeforeAlpha = workOf(fx.home, id, 'replan').length;
    // (f) Alpha of c-1 by the owner's command; the barrier; the replan.
    J.alpha = await alphaByCommand(fx, ctx);
    J.c1 = candidatesOfProject(fx.home, id).find((c) => c.id === J.phase1.completion_binding.candidate);
    J.deploy = suretyCommand(fx, ['deploy', J.c1.id, '--env', 'alpha', '--project', id]);
    assert.equal(J.deploy.status, 0, `surety deploy exits 0 (stdout ${J.deploy.stdout.slice(0, 400)}; stderr ${J.deploy.stderr.slice(0, 400)})`);
    J.deployed = await pump(fx, ctx, () => candidatesOfProject(fx.home, id).find((c) => c.id === J.c1.id && c.progress === 'alpha_deployed'), { what: 'c-1 to be alpha_deployed' });
    J.requirementsAtAlpha = requirementsOf(fx.home, id);
    J.phase2Plan = await nextPhasePublished(fx, ctx, 2);
    // (g) one phase-2 stage by a scripted Builder.
    J.phase2 = await phaseCompleted(fx, ctx, 2);
    // (h) the teardown by the engine.
    J.end = await endJourney(fx, id, J.alpha.env);
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a) surety project adopt: pinned_revision the branch head before the bootstrap, the signals, project.adopted, baseline idea; the tag external_unverified; the CI file\'s environment unknown by name', () => {
    const { fx, p } = J;
    assert.equal(J.created.adoption.pinned_revision, J.A, 'A the branch head');
    const firstAfterA = gitQuiet(J.repo.path, ['rev-list', '--reverse', `${J.A}..${J.repo.ref}`]).split('\n')[0];
    assert.deepEqual(parentsOf(J.repo.path, firstAfterA), [J.A], 'the bootstrap commit sits on A');
    assert.ok(J.created.adoption.signals && typeof J.created.adoption.signals.files === 'number', 'the signals recorded');
    assert.equal(eventsAbout(fx.home, 'project.adopted', p.id).length, 1, 'project.adopted');
    assert.equal(J.created.row.baseline_state, 'idea', 'baseline idea');
    assert.deepEqual(adoptionModeRows(fx.home, p.id).map((d) => [d.status, d.answer?.option]), [['consumed', 'full']], 'adoption_mode answered full');
    assert.deepEqual(releasesOf(fx.home, p.id).map((r) => [r.name, r.state]), [[RELEASE_TAG, 'external_unverified']], 'the tag external_unverified');
    assert.ok(environmentsOf(fx.home, p.id).some((e) => e.name === CI_ENVIRONMENT && e.current_config === null), 'the CI environment unknown by name, never configured');
  });

  test('(b) the retrofit Spec Writer: spec_revisions 1 with Origin per row and spec_claims; one requirement_confirm per produced requirement; R4 defect, pending, phase 2; approve refused until every row was answered', () => {
    const { fx, p } = J;
    assert.equal(specRevisions(fx.home, p.id).length, 1, 'spec_revisions 1');
    const by = Object.fromEntries(requirementsOf(fx.home, p.id).map((r) => [r.key, r]));
    assert.deepEqual(KEYS.map((k) => by[k]?.origin), REQUIREMENTS.map((r) => r.origin), 'origin per row');
    assert.equal(specClaimsOf(fx.home, p.id).length, 4, 'the claims table in spec_claims');
    assert.deepEqual(decisionsOfKind(fx.home, p.id, 'requirement_confirm').map((d) => d.manifest?.key).sort(), [...KEYS], 'one requirement_confirm per produced requirement, whatever its Origin');
    for (const k of ['R1', 'R2', 'R3']) assert.equal(by[k].status !== 'withdrawn', true, `${k} confirmed`);
    assert.deepEqual([Boolean(by.R4.defect), (by.R4.assigned_phase ?? 2) >= 2], [true, true], 'the false claim\'s R4 answered defect, scheduled to phase 2');
    assert.ok(eventsAbout(fx.home, 'requirement.confirmed', p.id).length >= 3, 'requirement.confirmed');
    assert.equal(J.approveEarly.status, 409, `approve refused while rows were open (→ ${J.approveEarly.status} ${J.approveEarly.text})`);
  });

  test('(c) phase 1 one conformance stage implementing the confirmed requirements of phase 1, not the defect; plan.published', () => {
    const { fx, p } = J;
    const [plan] = planOfPhase(fx.home, p.id, 1);
    const stages = stagesOfPlan(fx.home, plan.id);
    assert.equal(stages.length, 1, 'one stage');
    assert.equal(Boolean(stages[0].conformance), true, 'conformance: true');
    assert.deepEqual([...stages[0].implements].sort(), ['R1', 'R2', 'R3'], 'the confirmed set of phase 1, not R4');
    assert.equal(eventsAbout(fx.home, 'plan.published', p.id).length >= 1, true, 'plan.published');
  });

  test('(d) check authoring: adopted_tests with the copy and its boundary under .surety/checks/; the developer check covering no criterion; approved by the harness as the owner', () => {
    const { fx, p, ctx } = J;
    const proposal = proposalsOf(fx.home, p.id).find((r) => r.adopted_tests);
    assert.ok(proposal, 'the authoring proposal lists adopted_tests');
    assert.deepEqual(JSON.parse(proposal.adopted_tests), [ADOPTED], 'the copy and its dependency boundary');
    const suite = checkRows(fx.home, p.id).find((c) => c.key === 'suite');
    assert.equal(suite?.origin, 'developer', 'the developer check');
    assert.ok(ctx.humanActs.some((h) => h.kind === 'check_correction_unclassifiable' && h.option === 'approve'), 'the toolchain proposal approved by the harness as the owner');
  });

  test('(e) the conformance stage with no Builder against A: c-1\'s application source A while the head carries the engine\'s commits; its checks engine-run; the gate satisfied; conformed', () => {
    const { fx, p } = J;
    const [stage] = conformanceStages(fx.home, p.id);
    assert.equal(stage.source_revision, J.A, 'source_bound to A');
    assert.equal(stage.conformance_state, 'conformed', 'conformed');
    assert.deepEqual(workOf(fx.home, p.id, 'stage_build').filter((w) => w.created_at < J.phase1.completed_at), [], 'no stage_build in phase 1');
    assert.notEqual(J.c1.revision, J.A, 'the integration head carries the engine\'s commits');
    assert.deepEqual(projection(J.repo.path, J.c1.revision), projection(J.repo.path, J.A), 'c-1\'s application source is A');
    const results = resultsOf(fx.home, p.id).filter((r) => r.candidate === J.c1.id);
    assert.ok(results.length > 0 && results.every((r) => r.runner_id !== 'test_fixture'), 'its checks engine-run, none a fixture result');
    assert.ok(evaluationsOfKind(fx.home, p.id, 'stage').some((e) => e.candidate === J.c1.id && e.outcome === 'satisfied'), 'the stage gate satisfied on the approved set');
  });

  test('(f) baseline.phase_complete; no replan until alpha_complete; alpha_deployed for c-1 with the defect pending; then phase 2 registered', () => {
    const { fx, p } = J;
    assert.ok(eventsAbout(fx.home, 'baseline.phase_complete', p.id).length >= 1, 'baseline.phase_complete');
    assert.equal(J.replansBeforeAlpha, 0, 'no replan at phase 1\'s completion');
    const alphaComplete = evaluationsOfKind(fx.home, p.id, 'alpha_complete').find((e) => e.candidate === J.c1.id && e.outcome === 'satisfied');
    assert.ok(alphaComplete, 'alpha_complete satisfied for c-1');
    const [replan] = workOf(fx.home, p.id, 'replan');
    assert.ok(replan && replan.created_at >= alphaComplete.created_at, 'the replan created after alpha_complete');
    assert.equal(J.deployed.progress, 'alpha_deployed');
    assert.equal(J.requirementsAtAlpha.find((r) => r.key === 'R4').status, 'pending', 'R4 shown pending at Alpha');
    assert.ok(J.phase2Plan.published_at, 'phase 2 registered');
  });

  test('(g) the phase-2 stage verified, R4 delivered', () => {
    const { fx, p } = J;
    const stages = stagesOfPlan(fx.home, J.phase2Plan.id);
    assert.deepEqual(stages.map((s) => s.status), ['verified'], 'the stage verified');
    assert.equal(requirementsOf(fx.home, p.id).find((r) => r.key === 'R4').status, 'verified', 'R4 delivered and verified');
  });

  test('(h) the teardown applied, nothing of the prefix left; no existing test, CI file or prior result in any scope; no check result from a fixture', () => {
    const { fx, p } = J;
    assert.deepEqual([J.end.units, J.end.cgroups, J.end.runFiles], [[], [], []], `nothing of the prefix left (${JSON.stringify(J.end)})`);
    const text = JSON.stringify(checkRows(fx.home, p.id));
    for (const path of ['test/sum.test.mjs', 'test/helpers/expect.mjs', '.github/workflows/ci.yml']) assert.ok(!text.includes(`"${path}"`), `no check reads ${path}`);
    assert.ok(resultsOf(fx.home, p.id).every((r) => r.runner_id !== 'test_fixture'), 'no check result from a fixture');
  });
});
