// M201, the check journey, path one (M3 slice 15, the walking check; sandbox
// lane). M3 plan §3.1 M201; D3 §§1.3, 1.4, 2.1 to 2.6, 4.2, 4.3; L1, L2; E40;
// SEAM.md §§177 to 185.
//
// A temporary project at T1 with one stage and one requirement, R1, with two
// criteria. Its governed file names the test-owned check program; two
// definitions: an acceptance check covering R1.1 and R1.2, and a smoke
// check, each with its inputs declared. A scripted Builder builds the stage
// and asks for the nomination; the engine registers the checks, builds the
// check tree, runs each check in a real `check` domain, records what it
// observed, and the stage and Alpha gates are judged on those results alone.
// A second candidate, whose source makes the acceptance check exit 1, is
// judged the same way. Every check result of the journey is the engine's.
//
// The runner is qualified by the harness-only runner qualification fixture
// (E92 item 2; SEAM.md §181). Case (f), the same journey with no fixture and
// `check_runner` qualified by the self-test, is slice 18's (COVERAGE.md).
//
// One journey, read by the cases (M01's form): it is made once in the
// `before` hook, and a failure there fails every case.
//
// SAFETY: the check program (harness/checks/program.mjs) is benign: it
// reads its workspace, waits for a release file, writes its output and
// exits with a status. It signals nothing and writes no file.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sha256Hex } from './harness/engine.mjs';
import { alphaTarget, authorizationsOf, reasonSubjects, sharedFixture, stageGate } from './harness/gates.mjs';
import { PERMITTED_EDIT, addItem, permittedEdit, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { readGate } from './harness/reads.mjs';
import { runsOf, tickUntil } from './harness/runs.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { step } from './harness/scripted.mjs';
import {
  GOVERNED_FILE,
  acceptance,
  checkProject,
  checktreeEntries,
  defPath,
  domainOfExecution,
  entryByKey,
  executionsOf,
  fileHolding,
  gateCheckEntries,
  heldExecution,
  holdArgs,
  hostQualificationRow,
  installCheckProgram,
  installIndexedPlan,
  listExecutions,
  machineId,
  outputText,
  programReport,
  qualifyRunnerByFixture,
  release,
  resultRow,
  resultsOfProject,
  sandboxGoverned,
  smoke,
  waitRecorded,
} from './harness/checks/fixtures.mjs';

const EXPECT = '.surety/checks/expect/app.js';
const BROKEN = 'export const answer = 41;\n';
const KEYS = ['accept', 'smoke'];

async function journey(t) {
  const fx = await sandboxEngine(t);
  const prog = installCheckProgram(fx.root);
  const files = {
    [GOVERNED_FILE]: sandboxGoverned(prog),
    [EXPECT]: PERMITTED_EDIT.content,
    [defPath('accept')]: acceptance('accept', ['R1.1', 'R1.2'], {
      command: ['probe', '--report', '--digest', PERMITTED_EDIT.path, '--digest', EXPECT, ...holdArgs(prog, 'accept'), 'expect', PERMITTED_EDIT.path, EXPECT],
      inputs: [EXPECT],
      timeout: 300,
    }),
    [defPath('smoke')]: smoke('smoke', { command: ['probe', '--report', ...holdArgs(prog, 'smoke'), 'exit', '0'], inputs: [EXPECT], timeout: 300 }),
  };
  const project = await checkProject(fx, { files, tier: 'T1' });
  const hostQualification = await qualifyRunnerByFixture(fx.engine);
  const plan = await installIndexedPlan(fx.engine, project.id, {
    index: [{ key: 'R1', criteria: ['R1.1', 'R1.2'] }],
    stages: [{ number: 1, goal: 'the first stage', implements: ['R1'] }],
  });
  const [stage] = plan.stages;

  // (a) The Builder builds the stage and asks for the nomination.
  fx.scripted.script(stage.work_item, [roleThat([permittedEdit()], { nominate: true })]);
  const build = await runToEnd(fx, project.id, stage.work_item);
  assert.deepEqual([build.outcome, build.reason_class], ['completed', 'none'], `the Builder's run was accepted (${build.reason_text})`);
  const [candidate] = await waitForCandidates(fx, project.id);

  // (b) Each check runs in its domain and holds there; the test reads the domain and the check tree from the host, then releases it.
  const held = {};
  const trees = {};
  const pending = { accept: 'accept', smoke: 'smoke' };
  while (Object.keys(pending).length > 0) {
    const h = await heldExecution(fx, project.id, candidate.id, pending);
    held[h.key] = h;
    trees[h.key] = checktreeEntries(fx.home);
    delete pending[h.key];
    release(prog, h.key);
  }
  const recorded = await waitRecorded(fx, project.id, candidate.id, KEYS);
  const registeredAtNomination = executionsOf(fx.home, candidate.id);
  const route = await listExecutions(fx.engine, project.id, candidate.id);

  // (c) The gates.
  const ctx = { project, candidate, stage: stage.id };
  const stageEval = await stageGate(fx, ctx);
  const alpha = await alphaTarget(fx, ctx);
  const alphaEval = await alpha.evaluate();
  const stageRead = await readGate(fx.engine, project.id, candidate.id, 'stage');
  const alphaRead = await readGate(fx.engine, project.id, candidate.id, 'alpha_authorize');

  // (d) A second candidate whose source makes the acceptance check exit 1.
  const fix = await addItem(fx, project.id, 'fix');
  fx.scripted.script(fix, [roleThat([step.write(PERMITTED_EDIT.path, BROKEN)], { nominate: true })]);
  await tickUntil(fx.engine, project.id, () => runsOf(fx.home, fix)[0]?.state === 'ended', { what: 'the fix to be built' });
  const second = (await waitForCandidates(fx, project.id, 2)).at(-1);
  const secondRecorded = await waitRecorded(fx, project.id, second.id, KEYS, { what: "the second candidate's checks to be recorded" });
  const ctx2 = { project, candidate: second, stage: stage.id };
  const secondStage = await stageGate(fx, ctx2);
  const secondAlpha = await alphaTarget(fx, ctx2, second, { environment: alpha.environment });
  const secondAlphaEval = await secondAlpha.evaluate();

  return { fx, prog, project, hostQualification, stage, candidate, held, trees, recorded, registeredAtNomination, route, stageEval, alphaEval, alpha, stageRead, alphaRead, second, secondRecorded, secondStage, secondAlpha, secondAlphaEval };
}

describe('M201 the check journey, path one', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    J = await journey(shared.context);
  });
  after(() => shared.cleanup());

  test('(a) at the nomination each required check is registered once, by the nomination trigger, with check.registered', () => {
    const regs = J.registeredAtNomination.filter((x) => x.trigger?.source === 'nomination');
    assert.deepEqual(regs.map((x) => x.key).sort(), KEYS, `one nomination registration per required check (registrations: ${JSON.stringify(J.registeredAtNomination.map((x) => [x.key, x.trigger]))})`);
    assert.deepEqual(J.registeredAtNomination.map((x) => x.key).sort(), KEYS, 'and no other registration of the candidate');
    const events = eventsOfType(J.fx.home, 'check.registered').filter((e) => e.subject?.candidate === J.candidate.id);
    for (const x of regs) {
      assert.equal(events.filter((e) => e.subject?.check_execution === x.id).length, 1, `one check.registered names the execution of ${x.key}`);
      assert.equal(x.candidate, J.candidate.id);
      assert.equal(x.source_revision, J.candidate.revision, `the ${x.key} execution binds the candidate's revision`);
      assert.equal(x.runner_class, 'direct');
    }
    assert.deepEqual(
      J.route.map((e) => [e.id, e.key, e.trigger?.source]),
      J.registeredAtNomination.map((x) => [x.id, x.key, 'nomination']),
      "the candidate's check executions route lists the same executions, in sequence, with their trigger",
    );
  });

  test("(b) each check ran in its own check domain (host-read cgroup.procs); its tree has the candidate's files and the protected inputs and no .git; one established result each, exit 0, with its output record", () => {
    const appDigest = sha256Hex(PERMITTED_EDIT.content);
    for (const key of KEYS) {
      const { execution, domain, member } = J.held[key];
      assert.equal(domain.profile, 'check', `${key}: its domain is of profile check`);
      assert.equal(domain.check_execution, execution.id, `${key}: the domain belongs to the check execution (L1)`);
      assert.equal(domain.run, null, `${key}: and to no run`);
      assert.equal(domain.launch_binding?.check_execution, execution.id, `${key}: the launch binding names the check execution (L1)`);
      assert.ok(member.pid > 1, `${key}: host-read, the check program (host pid ${member.pid}) was a member of ${domain.cgroup_path}/cgroup.procs while it ran`);
      assert.ok(member.nspid.length >= 2, `${key}: host-read, in a pid namespace of its own`);
      const tree = J.trees[key];
      assert.deepEqual(tree.filter((e) => e.name === '.git').map((e) => e.path), [], `${key}: host-read, nothing named .git anywhere under checktrees/`);
      assert.ok(fileHolding(tree, PERMITTED_EDIT.content), `${key}: host-read, a check tree holds the candidate's ${PERMITTED_EDIT.path}`);

      const x = J.recorded[key];
      const result = resultRow(J.fx.home, x.result);
      assert.ok(result, `${key}: the execution names its result`);
      assert.deepEqual(
        [result.execution, result.execution_established, result.exit_status, result.signaled, result.deadline_hit, result.candidate],
        [x.id, 1, 0, 0, 0, J.candidate.id],
        `${key}: one established result, exit 0, not signaled, no deadline, naming its execution`,
      );
      assert.match(result.runner_id, new RegExp(`^direct@${machineId()}/[0-9a-f]{8,}$`), `${key}: runner_id is direct@<host id>/<profile fingerprint prefix> (D3 §2.8)`);
      const report = programReport(outputText(J.fx.home, result));
      assert.equal(report.cwd, '/surety/workspace', `${key}: the program ran in /surety/workspace`);
      assert.equal(report.git_present, false, `${key}: the program saw no .git`);
      const paths = new Map(report.entries.map((e) => [e.path, e.type]));
      for (const path of ['README.md', PERMITTED_EDIT.path, EXPECT]) assert.equal(paths.get(path), 'file', `${key}: the program saw ${path} as a file`);
      if (key === 'accept') {
        assert.equal(report.digests[PERMITTED_EDIT.path], appDigest, "the candidate's source as the candidate has it");
        assert.equal(report.digests[EXPECT], appDigest, 'the protected input as the effective version has it');
      }
    }
    assert.equal(resultsOfProject(J.fx.home, J.project.id).filter((r) => r.candidate === J.candidate.id).length, 2, 'one result per check of the candidate');
  });

  test('(c) the stage gate and alpha_authorize are satisfied with every check passed; their deciding results are those executions, named on the gate read', () => {
    for (const [what, evaluation, read] of [['stage', J.stageEval, J.stageRead], ['alpha_authorize', J.alphaEval, J.alphaRead]]) {
      assert.deepEqual([evaluation.outcome, evaluation.reasons], ['satisfied', []], `${what}: satisfied, no reason`);
      assert.deepEqual(Object.values(evaluation.check_states).sort(), ['passed', 'passed'], `${what}: both checks passed`);
      const entries = gateCheckEntries(read.evaluation);
      for (const key of KEYS) {
        const entry = entryByKey(entries, key);
        assert.ok(entry, `${what}: the gate read names ${key}`);
        assert.deepEqual([entry.state, entry.deciding?.execution, entry.deciding?.result], ['passed', J.recorded[key].id, J.recorded[key].result], `${what}: ${key}'s deciding result is the engine's execution`);
      }
    }
    assert.equal(authorizationsOf(J.fx.home, J.candidate.id).find((a) => a.id === J.alpha.authorization.id)?.status, 'issued', 'the Alpha authorization was issued');
  });

  test('(d) a candidate whose source makes the acceptance check exit 1: failed, CHECK_NOT_PASSED, its output record present, no authorization issued', () => {
    const acceptX = J.secondRecorded.accept;
    const result = resultRow(J.fx.home, acceptX.result);
    assert.deepEqual([result.execution, result.execution_established, result.exit_status, result.signaled], [acceptX.id, 1, 1, 0], 'the acceptance check is established and exited 1');
    assert.match(outputText(J.fx.home, result), /differs from/, 'its output record holds what it wrote');
    assert.equal(resultRow(J.fx.home, J.secondRecorded.smoke.result).exit_status, 0, 'control: the smoke check passed on it');
    assert.equal(J.secondStage.outcome, 'not_satisfied');
    assert.equal(J.secondStage.check_states[acceptX.check], 'failed', 'the acceptance check is failed');
    assert.deepEqual(reasonSubjects(J.secondStage, 'CHECK_NOT_PASSED'), [acceptX.check], 'CHECK_NOT_PASSED names the acceptance check');
    assert.equal(J.secondAlphaEval.outcome, 'not_satisfied', 'Alpha is not satisfied');
    assert.equal(authorizationsOf(J.fx.home, J.second.id).find((a) => a.id === J.secondAlpha.authorization.id)?.status, 'proposed', "no authorization was issued for the second candidate");
  });

  test("(e) provenance: every check result of the journey is an engine execution in a check domain; none came from the fixture route or a role", () => {
    const results = resultsOfProject(J.fx.home, J.project.id);
    assert.equal(results.length, 4, 'two candidates, two checks each');
    for (const r of results) {
      assert.ok(r.execution, `result ${r.id} names its execution`);
      const x = executionsOf(J.fx.home, r.candidate).find((e) => e.id === r.execution);
      assert.ok(x, `result ${r.id}'s execution is the candidate's`);
      assert.equal(x.result, r.id, 'and names it back');
      const domain = domainOfExecution(J.fx.home, x);
      assert.deepEqual([domain?.profile, domain?.check_execution], ['check', x.id], `result ${r.id} came from a check domain of its execution`);
      assert.equal(r.runner_qualification, J.hostQualification, 'it is bound to the host qualification in force at launch');
    }
    const labelled = eventsOfType(J.fx.home, 'check.result').filter((e) => e.payload?.test_fixture === true);
    assert.deepEqual(labelled, [], 'no check.result event is a fixture\'s');
    const qualification = hostQualificationRow(J.fx.home, J.hostQualification);
    assert.equal(qualification.check_runner?.test_fixture, true, "the qualification the results are bound to says its runner qualification is the harness fixture's (not a self-test)");
  });
});
