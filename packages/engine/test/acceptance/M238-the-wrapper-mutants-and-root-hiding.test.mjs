// M238, the protective wrapper and the root-hiding case (M3 slice 22;
// project lane, run with `npm test`, E92 item 2 (1)). M3 plan §3.8 M238;
// D3-J02, D3-J05; Astra's T18, T03 and B02; D3 §6 classes B and C, §3.1,
// Appendix B; SEAM.md §§213, 236.
//
// The reference project (`harness/project/reference.mjs`, `m238Project`):
// its acceptance check `guarded` runs the candidate's code as a child of a
// protected node:test file, under the protective wrapper; `srctests`, the
// retained check, runs the Builder's own tests under src/ through the same
// wrapper; `bare` runs those tests with a bare `node --test`. A Builder
// builds the correct project first (the control: every check passes), then
// each mutant as a fix of its own, each a candidate of its own:
// (a) a skipped test, an empty run (no test file; a test file that runs no
//     test), a premature success summary (each
//     against `srctests`), a swallowed child failure and candidate code
//     calling process.exit(0) (each against `guarded`): each `failed`, by
//     the exit status of the wrapper's own judgment, as the gate reads it.
// (b) the bare definition on the skipped run, the empty run and the test
//     file that runs no test: `passed`, the
//     vacuous pass of D3 §6 class B, shown here as a LIMITATION, never as
//     evidence of guarded execution; the gate stays unsatisfied beside it.
// (c) a candidate whose src/ holds a failing test of the Builder's:
//     `srctests` failed with the runner's own status; then a Verifier's
//     proposal adding src/ as a protected root (which would hide that
//     source from the retained check): `unclassifiable`, root_layout_changed,
//     awaiting the human; a Reviewer's approval of it applies nothing.
//
// Lanes: the real `check` profile and boundary on this host, Node's own test
// runner from the engine's installation, scripted roles, no model. The runner
// is qualified by the harness fixture (SEAM.md §181), as M223 is.
//
// SAFETY: every mutant runs only inside a check domain, through the engine
// (the brief's rule): the test writes them as a Builder's files and never
// runs them on the host. What they do is add, skip or print, and end their
// own process with a status; none signals, detaches or writes outside its
// overlay, which is discarded.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { decisionsOn } from './harness/decisions.mjs';
import { effectiveVersion, sharedFixture, stageGate } from './harness/gates.mjs';
import { addItem, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { refOid } from './harness/repos.mjs';
import { runsOf, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { BUILDER_TEST, BUILDER_TEST_PATH, FAILING_SOURCE_TEST, MUTANTS, SUM, SUM_PATH, m238Governed, m238Project } from './harness/project/reference.mjs';
import { checkProject, installIndexedPlan, outputText, qualifyRunnerByFixture, resultRow, waitRecorded } from './harness/checks/fixtures.mjs';
import { assertClassification, engineClassification, proposalRow, reviewerApproval, runningClassifier, verifierProposal, writeGov } from './harness/checks/classifier.mjs';

const KEYS = ['guarded', 'srctests', 'bare'];
const LIMITATION = 'LIMITATION (D3 §6 class B): a bare node --test passes vacuously; this is never evidence of guarded execution';

// The Builder's steps for a set of files ({path: content | null}).
const writes = (files) => Object.entries(files).map(([path, content]) => (content === null ? step.delete(path) : step.write(path, content)));

// One candidate built by `item` with `files`; its checks recorded; its stage gate read.
async function candidateOf(fx, ctx, item, files, count, what) {
  fx.scripted.script(item, [roleThat(writes(files), { nominate: true })]);
  await tickUntil(fx.engine, ctx.project.id, () => runsOf(fx.home, item)[0]?.state === 'ended', { what: `${what}: the Builder's run` });
  const run = runsOf(fx.home, item)[0];
  assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none'], `${what}: the Builder's run was accepted (${run.reason_text})`);
  const candidate = (await waitForCandidates(fx, ctx.project.id, count))[count - 1];
  const recorded = await waitRecorded(fx, ctx.project.id, candidate.id, KEYS, { what: `${what}: its checks to be recorded` });
  const gate = await stageGate(fx, ctx, candidate);
  const out = {};
  for (const key of KEYS) {
    const x = recorded[key];
    const row = resultRow(fx.home, x.result);
    out[key] = { execution: x, row, output: outputText(fx.home, row), state: gate.check_states?.[x.check] ?? null };
  }
  return { candidate, gate, checks: out };
}

const shown = (c) => `exit ${c.row.exit_status}, state ${c.state}; output: ${JSON.stringify(c.output.slice(-900))}`;

async function journey(t) {
  const fx = await sandboxEngine(t, { config: { terminate_grace: 3, kill_grace: 2 } });
  await qualifyRunnerByFixture(fx.engine);
  const project = await checkProject(fx, { files: m238Project(), tier: 'T1' });
  // Every mutant's candidate fails a required check while its item is verifying; this row is about
  // the checks, not the repair (D3 §2.10; objection 030): at repair_attempts_max 0, set before the
  // build, no item is sent back and every candidate holds the commit its Builder made.
  await changePolicy(fx.engine, project.id, { repair_attempts_max: 0 });
  const plan = await installIndexedPlan(fx.engine, project.id, { index: [{ key: 'R1', criteria: ['R1.1'] }], stages: [{ number: 1, goal: 'sum', implements: ['R1'] }] });
  const ctx = { project, stage: plan.stages[0].id };
  let count = 0;
  const control = await candidateOf(fx, ctx, plan.stages[0].work_item, { [SUM_PATH]: SUM, [BUILDER_TEST_PATH]: BUILDER_TEST }, ++count, 'the correct project');
  const mutants = {};
  for (const [name, m] of Object.entries(MUTANTS)) {
    // Each mutant from the correct project: undo the previous one's files first.
    const files = { [SUM_PATH]: SUM, [BUILDER_TEST_PATH]: BUILDER_TEST, ...m.files };
    mutants[name] = await candidateOf(fx, ctx, await addItem(fx, project.id, 'fix'), files, ++count, `the mutant ${name}`);
  }
  const hiding = await candidateOf(fx, ctx, await addItem(fx, project.id, 'fix'), { [SUM_PATH]: SUM, [BUILDER_TEST_PATH]: FAILING_SOURCE_TEST }, ++count, 'a failing test under src/');

  // (c) The Verifier proposes src/ as a protected root, the governed file changed in that alone.
  const versionBefore = effectiveVersion(fx.home, project.id).id;
  const headBefore = refOid(project.repo.path, project.repo.ref);
  const governed = m238Governed();
  const proposal = await verifierProposal(fx, project, [writeGov({ ...governed, protected_paths: [...governed.protected_paths, 'src/'] })]);
  const classified = await engineClassification(fx, project.id, proposal);
  const running = await runningClassifier(fx.engine);
  const review = await reviewerApproval(fx, project.id, proposal);
  await runToEnd(fx, project.id, review, { timeoutMs: 120_000 });
  // Ticks after the Reviewer's approval, in which an application would begin if one could.
  for (let i = 0; i < 3; i++) await fx.engine.post(`/v1/projects/${project.id}/tick`, {});
  await new Promise((r) => setTimeout(r, 1500));
  return {
    fx,
    project,
    control,
    mutants,
    hiding,
    root: { proposal, classified, running, review: runsOf(fx.home, review)[0], after: proposalRow(fx.home, project.id, proposal.id), versionBefore, versionAfter: effectiveVersion(fx.home, project.id).id, headBefore, headAfter: refOid(project.repo.path, project.repo.ref) },
  };
}

describe('M238 the protective wrapper and the root-hiding case (project lane)', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    J = await journey(shared.context);
  });
  after(() => shared.cleanup());

  test('the control: on the correct project every check passes, the guarded one by the protected test of the candidate run as a child', () => {
    for (const key of KEYS) {
      const c = J.control.checks[key];
      assert.deepEqual([c.row.execution_established, c.row.exit_status, c.state], [1, 0, 'passed'], `${key} passed on the correct project (${shown(c)})`);
    }
    assert.match(J.control.checks.guarded.output, /^ok 1 - R1\.1: sum adds, the candidate run as a child/m, "the fixture is live: Node's runner ran the protected test");
    assert.match(J.control.checks.srctests.output, /^ok 1 - the Builder's test: sum adds/m, "the fixture is live: the retained check ran the Builder's test under src/");
    assert.equal(J.control.gate.outcome, 'satisfied', `the stage gate is satisfied on the correct project (${JSON.stringify(J.control.gate.reasons)})`);
  });

  for (const [name, m] of Object.entries(MUTANTS)) {
    test(`(a) ${m.what}: ${m.target} failed, exit ${m.code}`, () => {
      const got = J.mutants[name];
      const c = got.checks[m.target];
      assert.deepEqual([c.row.execution_established, c.row.deadline_hit, c.row.signaled], [1, 0, 0], `${name}: the ${m.target} execution was established and ended by itself (${shown(c)})`);
      assert.equal(c.row.exit_status, m.code, `${name}: ${m.target} exited ${m.code} (${shown(c)})`);
      assert.equal(c.state, 'failed', `${name}: the gate reads ${m.target} failed (${shown(c)})`);
      assert.notEqual(got.gate.outcome, 'satisfied', `${name}: the stage gate is not satisfied on the mutant`);
    });
  }

  test('(a) each mutant is live: it does what its name says inside the check (the runner\'s own report shows it)', () => {
    const out = (name, key) => J.mutants[name].checks[key].output;
    assert.match(out('skipped', 'srctests'), /^# skipped 1$/m, 'skipped: the runner counted a skipped test');
    assert.match(out('empty', 'srctests'), /^# tests 0$/m, 'empty: the runner counted no test');
    assert.match(out('emptyFile', 'srctests'), /^ok 1 - src\/sum\.test\.mjs$/m, 'emptyFile: the runner reported the test file that ran no test as one passing test');
    assert.match(out('emptyFile', 'srctests'), /^wrapper: a test file ran no test of its own: src\/sum\.test\.mjs$/m, "emptyFile: and the wrapper's rule for it is what failed the check");
    const premature = out('premature', 'srctests');
    const passes = [...premature.matchAll(/^# pass (\d+)$/gm)];
    const skips = [...premature.matchAll(/^# skipped (\d+)$/gm)];
    assert.ok(passes.length >= 2 && passes[0][1] === '1', `premature: a forged "# pass 1" summary line reached the runner's report first (${JSON.stringify(premature.slice(0, 1500))})`);
    assert.ok(passes.at(-1)[1] === '0' && skips.at(-1)?.[1] === '1' && passes[0].index < passes.at(-1).index, `premature: the runner's own summary, after it, counts no pass and one skipped test (${JSON.stringify(premature.slice(-900))})`);
    assert.match(out('childFailure', 'guarded'), /a failed child is never swallowed/, "childFailure: the protected test's assertion on the child's exit is what failed");
    assert.match(out('exitZero', 'guarded'), /^not ok 1 - R1\.1: sum adds, the candidate run as a child/m, 'exitZero: the protected test failed although the candidate ended its own process with 0');
  });

  test(`(b) ${LIMITATION}: on the skipped run, the empty run and the test file that runs no test, the bare definition passed while the wrapped one failed, and the gate is not satisfied`, () => {
    for (const name of ['skipped', 'empty', 'emptyFile']) {
      const bare = J.mutants[name].checks.bare;
      const wrapped = J.mutants[name].checks.srctests;
      assert.deepEqual([bare.row.execution_established, bare.row.exit_status, bare.state], [1, 0, 'passed'], `${name}: bare node --test exited 0 on a broken sum, the vacuous pass shown (${shown(bare)})`);
      assert.equal(wrapped.state, 'failed', `${name}: the wrapped definition of the same tests failed`);
      assert.notEqual(J.mutants[name].gate.outcome, 'satisfied', `${name}: the vacuous pass satisfied nothing (${JSON.stringify(J.mutants[name].gate.reasons)})`);
    }
  });

  test("(c) the retained check discovering the Builder's tests under src/ fails on a failing source test, with the runner's own status", () => {
    const c = J.hiding.checks.srctests;
    assert.deepEqual([c.row.execution_established, c.row.exit_status, c.state], [1, 1, 'failed'], `srctests failed, exit 1 (${shown(c)})`);
    assert.match(c.output, /^not ok 1 - the Builder's test: sum of two and two is five/m, 'the failing source test is what failed it');
    assert.equal(J.hiding.checks.guarded.state, 'passed', 'the source itself is right: the guarded acceptance check passed');
  });

  test('(c) a proposal adding src/ as a protected root is unclassifiable (root_layout_changed), awaits the human, and a Reviewer\'s approval applies nothing', () => {
    const R = J.root;
    assertClassification(R.classified, { kind: 'unclassifiable', contains: ['root_layout_changed'] }, { label: 'src/ added as a root', running: R.running });
    const open = decisionsOn(J.fx.home, 'check_correction_unclassifiable', R.proposal.id).filter((d) => d.status === 'open');
    assert.equal(open.length, 1, 'the human\'s check_correction_unclassifiable decision about it is open');
    assert.deepEqual([R.review.outcome, R.review.reason_class], ['completed', 'none'], `the Reviewer's run approving it was accepted (${R.review.reason_text})`);
    assert.equal(R.after.status, 'awaiting_human', `after the Reviewer's approval the proposal still awaits the human (it is ${R.after.status})`);
    assert.deepEqual([R.after.approver, R.after.approver_authority], [null, null], 'no approval was recorded on it');
    assert.equal(R.versionAfter, R.versionBefore, 'the effective protected version is unchanged');
    assert.equal(R.headAfter, R.headBefore, 'the integration branch did not move');
  });
});
