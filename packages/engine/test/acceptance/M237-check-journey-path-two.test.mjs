// M237, the check journey, path two (M3 slice 21; sandbox lane). M3 plan
// §3.7 M237; D3 §§2.10, 2.11; E40; T20; SEAM.md §§177 to 183, 228 to 231.
//
// M201's project: T1, one stage, R1 with criteria R1.1 and R1.2; a governed
// file naming the test-owned check program; an acceptance check `accept`
// covering both criteria (the candidate's src/app.js must equal the
// protected .surety/checks/expect/app.js) and a smoke check. Every check
// result is the engine's own execution in a real `check` domain.
//
//   (a) The stage's Builder writes a wrong src/app.js and asks for the
//       nomination; the acceptance check exits 1 on that candidate, so the
//       engine sends the stage_build back once, with the failed check's
//       output in the repair run's context package.
//   (b) The repair run writes the right src/app.js and asks for the
//       nomination: the repaired candidate's checks run and pass in their
//       domains.
//   (c) The repaired candidate's Verifier reports a Critical finding naming
//       criterion R1.2 and the acceptance check (its result schema offers the
//       index's criteria); a Reviewer dispositions it `fix`; the fix's
//       Builder builds the fix's candidate; there the acceptance check passes
//       by an execution registered after the disposition; the finding is
//       resolved, and the stage and Alpha gates are satisfied on
//       engine-observed results only.
//
// One journey, made once in the `before` hook (M01's and M201's form); each
// case reads one clause of the row from it. The runner is qualified by the
// harness fixture (SEAM.md §181), as the sandbox files of slices 15 to 20.
//
// SAFETY: the check program (harness/checks/program.mjs) runs in its
// benign modes only (`expect`, `exit`, `--say`): it reads two files, writes
// its output and exits. It signals nothing, starts nothing and writes no
// file. No guarded mode is used, so nothing is released into an action.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { consume, openDecision } from './harness/decisions.mjs';
import { alphaTarget, authorizationsOf, reasonSubjects, sharedFixture, stageGate } from './harness/gates.mjs';
import { PERMITTED_EDIT, roleThat, waitForCandidates } from './harness/gitruns.mjs';
import { eventsOfType, workItemsOf } from './harness/journal.mjs';
import { addWork, pauseProject, resumeProject, runsOf, tickUntil } from './harness/runs.mjs';
import { registerDetector, waitForPostScan } from './harness/records.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import {
  GOVERNED_FILE,
  acceptance,
  checkProject,
  defPath,
  domainOfExecution,
  executionsOf,
  installCheckProgram,
  installIndexedPlan,
  outputText,
  qualifyRunnerByFixture,
  resultRow,
  resultsOfProject,
  sandboxGoverned,
  smoke,
  waitRecorded,
} from './harness/checks/fixtures.mjs';
import { findingRow, itemRow, registrationsBy, repairsOf } from './harness/checks/repair.mjs';

const EXPECT = '.surety/checks/expect/app.js';
const BROKEN = 'export const answer = 41;\n';
const MARK = 'M237-ACCEPT';
const KEYS = ['accept', 'smoke'];
const FIX_EDIT = Object.freeze({ path: 'src/session.js', content: 'export const expiresSessions = true;\n' });
const FINDING = Object.freeze({ category: 'security', severity: 'critical', message: 'M237: the login accepts an expired session', check: 'accept', criterion: 'R1.2' });

const ended = (fx, project, item, n, what) =>
  tickUntil(fx.engine, project, () => (runsOf(fx.home, item)[n]?.state === 'ended' ? runsOf(fx.home, item)[n] : undefined), { what });

// The dump of a launch's context package (SEAM.md §139) as {manifest, files}.
function packageOf(fx, item, n, what) {
  const launch = fx.scripted.launches({ work_item: item })[n];
  assert.ok(launch?.invocation, `${what} was launched`);
  const [dump] = fx.scripted.probes(launch.invocation, 'context_dump');
  assert.equal(dump?.outcome, 'dumped', `${what} read its context package (${dump?.error})`);
  const manifest = JSON.parse(dump.files.find((f) => f.name === 'manifest.json').text);
  return { manifest, files: dump.files };
}

async function journey(t) {
  const fx = await sandboxEngine(t);
  const prog = installCheckProgram(fx.root);
  const files = {
    [GOVERNED_FILE]: sandboxGoverned(prog),
    [EXPECT]: PERMITTED_EDIT.content,
    [defPath('accept')]: acceptance('accept', ['R1.1', 'R1.2'], { command: ['probe', '--say', MARK, 'expect', PERMITTED_EDIT.path, EXPECT], inputs: [EXPECT], timeout: 300 }),
    [defPath('smoke')]: smoke('smoke', { command: ['probe', 'exit', '0'], inputs: [EXPECT], timeout: 300 }),
  };
  const project = await checkProject(fx, { files, tier: 'T1' });
  const hostQualification = await qualifyRunnerByFixture(fx.engine);
  const plan = await installIndexedPlan(fx.engine, project.id, { index: [{ key: 'R1', criteria: ['R1.1', 'R1.2'] }], stages: [{ number: 1, goal: 'the first stage', implements: ['R1'] }] });
  const [stage] = plan.stages;
  const item = stage.work_item;
  const letThrough = async (work) => consume(fx, project.id, await openDecision(fx, project.id, 'blocker', work), 'continue');

  // (a) The first build is wrong; the repair run dumps its package and writes the right file.
  fx.scripted.script(item, [
    roleThat([step.write(PERMITTED_EDIT.path, BROKEN)], { nominate: true }),
    roleThat([step.probe('context_dump'), step.write(PERMITTED_EDIT.path, PERMITTED_EDIT.content)], { nominate: true }),
  ]);
  const first = await ended(fx, project.id, item, 0, "the stage's first Builder run");
  assert.deepEqual([first.outcome, first.reason_class], ['completed', 'none'], `the first Builder run was accepted (${first.reason_text})`);
  const [c1] = await waitForCandidates(fx, project.id);
  const c1Recorded = await waitRecorded(fx, project.id, c1.id, KEYS, { what: "the first candidate's checks to be recorded" });
  const afterFailure = itemRow(fx.home, item);
  const repairs = repairsOf(fx.home, item);

  // (b) The repair run, and the repaired candidate's checks.
  await ended(fx, project.id, item, 1, "the stage's repair run");
  const c2 = (await waitForCandidates(fx, project.id, 2))[1];
  const c2Recorded = await waitRecorded(fx, project.id, c2.id, KEYS, { what: "the repaired candidate's checks to be recorded" });
  const repairPackage = packageOf(fx, item, 1, 'the repair run');

  // (c) The repaired candidate's Verifier reports the finding; a Reviewer dispositions it fix.
  const verification = workItemsOf(fx.home, project.id).find((w) => w.kind === 'verification' && w.subject?.candidate === c2.id);
  assert.ok(verification, "the nomination registered the repaired candidate's verification");
  fx.scripted.script(verification.id, [roleThat([step.probe('context_dump')], { findings: [FINDING] })]);
  await letThrough(verification.id);
  const vRun = await ended(fx, project.id, verification.id, 0, "the Verifier's run");
  assert.deepEqual([vRun.outcome, vRun.reason_class], ['completed', 'none'], `the Verifier's run was accepted (${vRun.reason_text})`);
  const verifierPackage = packageOf(fx, verification.id, 0, "the Verifier's run");
  const found = withStore(fx.home, (db) => db.prepare('SELECT * FROM "findings" WHERE "project" = ? AND "message" = ?').get(project.id, FINDING.message));
  assert.ok(found, 'the finding is recorded');
  const blockedOnC2 = await stageGate(fx, { project, candidate: c2, stage: stage.id });

  const reviewItem = await addWork(fx.engine, project.id, 'review', { subject: { candidate: c2.id } });
  fx.scripted.script(reviewItem, [roleThat([], { dispositions: [{ finding: found.id, disposition: 'fix' }] })]);
  await ended(fx, project.id, reviewItem, 0, "the Reviewer's run");
  const dispositioned = findingRow(fx.home, found.id);
  const fix = workItemsOf(fx.home, project.id).find((w) => w.kind === 'fix' && w.subject?.finding === found.id);
  assert.ok(fix, 'the engine registered the fix (E43)');
  fx.scripted.script(fix.id, [roleThat([step.write(FIX_EDIT.path, FIX_EDIT.content)], { nominate: true })]);
  await letThrough(fix.id);
  await ended(fx, project.id, fix.id, 0, "the fix's Builder run");
  const c3 = (await waitForCandidates(fx, project.id, 3))[2];
  const c3Recorded = await waitRecorded(fx, project.id, c3.id, KEYS, { what: "the fix candidate's checks to be recorded" });
  const ctx3 = { project, candidate: c3, stage: stage.id };
  const stageEval = await stageGate(fx, ctx3);
  const alpha = await alphaTarget(fx, ctx3);
  const alphaEval = await alpha.evaluate();

  return { fx, project, hostQualification, item, c1, c1Recorded, afterFailure, repairs, c2, c2Recorded, repairPackage, verifierPackage, found, blockedOnC2, dispositioned, fix, c3, c3Recorded, stageEval, alpha, alphaEval };
}

describe('M237 the check journey, path two', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    J = await journey(shared.context);
  });
  after(() => shared.cleanup());

  test("(a) the Builder's candidate fails the acceptance check: the stage_build is sent back once, with the check's output in the repair run's context", () => {
    const failed = resultRow(J.fx.home, J.c1Recorded.accept.result);
    assert.deepEqual([failed.execution_established, failed.exit_status], [1, 1], 'the acceptance check ran and exited 1 on the first candidate');
    assert.match(outputText(J.fx.home, failed), /differs from/, 'its output record holds what it wrote');
    assert.deepEqual([J.afterFailure.repair_attempts, J.repairs.length], [1, 1], 'sent back once: repair_attempts 1, one verifying → eligible step');
    assert.equal(J.afterFailure.check_repair?.candidate, J.c1.id, 'the repair names the first candidate');

    const entries = J.repairPackage.manifest.files.filter((f) => f.kind === 'check_output');
    assert.deepEqual(entries.map((f) => f.source), [failed.output], `the repair run's package lists the failed check's output record, and only it (SEAM.md §229) (manifest ${JSON.stringify(J.repairPackage.manifest.files)})`);
    const text = J.repairPackage.files.find((f) => f.name === entries[0].path)?.text ?? '';
    assert.ok(text.includes(MARK) && /differs from/.test(text), `that file holds the check's output (${JSON.stringify(text.slice(0, 300))})`);
  });

  test("(b) the repaired candidate's checks run and pass in their check domains", () => {
    for (const key of ['accept', 'smoke']) {
      const x = J.c2Recorded[key];
      const r = resultRow(J.fx.home, x.result);
      assert.deepEqual([r.execution, r.execution_established, r.exit_status, r.signaled, r.deadline_hit], [x.id, 1, 0, 0, 0], `${key}: established, exit 0`);
      const domain = domainOfExecution(J.fx.home, x);
      assert.deepEqual([domain?.profile, domain?.check_execution, domain?.run], ['check', x.id, null], `${key}: in a check domain of its own execution`);
    }
  });

  test('(c) the finding names R1.2 and the acceptance check; the check passes on the fix\'s candidate by an execution registered after the disposition; the finding is resolved; both gates are satisfied on engine-observed results only', () => {
    // The Verifier was offered the index's criteria (D3 §2.11).
    const schemaEntry = J.verifierPackage.manifest.files.find((f) => f.kind === 'result_schema');
    const schema = JSON.parse(J.verifierPackage.files.find((f) => f.name === schemaEntry?.path)?.text ?? 'null');
    const offered = schema?.properties?.findings?.items?.properties?.criterion?.enum;
    assert.deepEqual(Array.isArray(offered) ? [...offered].sort() : offered, ['R1.1', 'R1.2'], `the Verifier's result schema gives a finding's criterion as an enum of the index's criteria (${JSON.stringify(schema?.properties?.findings?.items?.properties?.criterion)})`);
    assert.deepEqual([J.found.criterion, J.found.check, J.found.effective_severity], ['R1.2', 'accept', 'critical'], 'the finding is stored with its criterion and check');
    assert.ok(reasonSubjects(J.blockedOnC2, 'FINDING_BLOCKING').includes(J.found.id), 'it blocks the repaired candidate');

    const accept = J.c3Recorded.accept;
    assert.ok(accept.execution_seq > J.dispositioned.disposition_seq, "the fix candidate's acceptance execution was registered after the disposition");
    assert.equal(registrationsBy(J.fx.home, J.c3.id).accept?.id, accept.id, "it is the fix candidate's nomination registration");
    const row = findingRow(J.fx.home, J.found.id);
    assert.equal(row.status, 'resolved', 'the finding is resolved');
    assert.equal(row.resolution_verification?.check_result, accept.result, 'by that execution\'s result');
    assert.equal(itemRow(J.fx.home, J.fix.id).status, 'complete', 'the fix is complete');

    for (const [what, evaluation] of [['stage', J.stageEval], ['alpha_authorize', J.alphaEval]]) assert.deepEqual([evaluation.outcome, evaluation.reasons], ['satisfied', []], `${what}: satisfied on the fix's candidate`);
    assert.equal(authorizationsOf(J.fx.home, J.c3.id).find((a) => a.id === J.alpha.authorization.id)?.status, 'issued', 'the Alpha authorization was issued');
    assert.equal(itemRow(J.fx.home, J.item).status, 'complete', "the stage's work completed on the fix's candidate");

    const results = resultsOfProject(J.fx.home, J.project.id);
    assert.equal(results.length, 6, 'three candidates, two checks each');
    for (const r of results) {
      const x = executionsOf(J.fx.home, r.candidate).find((e) => e.id === r.execution);
      assert.ok(x, `result ${r.id} is an engine execution of its candidate`);
      assert.equal(domainOfExecution(J.fx.home, x)?.profile, 'check', `result ${r.id} came from a check domain`);
      assert.equal(r.runner_qualification, J.hostQualification, `result ${r.id} is bound to the host qualification at launch`);
    }
    assert.deepEqual(eventsOfType(J.fx.home, 'check.result').filter((e) => e.payload?.test_fixture === true), [], 'no check result came from a fixture');
  });
});

// The slice-21 review's leak (the quarantined record): a failed repair
// check's output record that a detector flags after it was written
// (post_scan 'hit', M64's later detector) is served by no route (E42 item 1),
// so it never reaches a role's sandbox. The project is paused once the first
// candidate exists, so no run is dispatched while the check runs (checks run
// while a project is paused; only runs wait), the repair is taken, and the
// detector flags the record; then the repair run is let through and dumps
// its package.
const FLAG = 'M237-FLAGGED-5e1c9a';

describe('M237 a flagged check output never reaches the repair package', () => {
  test("the failed check's output record, flagged by a later detector before the repair run is dispatched: not copied into the Builder's repair package, treated as missing, no line of it in the package", async (t) => {
    const fx = await sandboxEngine(t);
    const prog = installCheckProgram(fx.root);
    const files = {
      [GOVERNED_FILE]: sandboxGoverned(prog),
      [EXPECT]: PERMITTED_EDIT.content,
      [defPath('accept')]: acceptance('accept', ['R1.1'], { command: ['probe', '--say', FLAG, 'expect', PERMITTED_EDIT.path, EXPECT], inputs: [EXPECT], timeout: 300 }),
      [defPath('smoke')]: smoke('smoke', { command: ['probe', 'exit', '0'], inputs: [EXPECT], timeout: 300 }),
    };
    const project = await checkProject(fx, { files, tier: 'T1' });
    await qualifyRunnerByFixture(fx.engine);
    const plan = await installIndexedPlan(fx.engine, project.id, { index: [{ key: 'R1', criteria: ['R1.1'] }], stages: [{ number: 1, goal: 'the first stage', implements: ['R1'] }] });
    const item = plan.stages[0].work_item;
    fx.scripted.script(item, [roleThat([step.write(PERMITTED_EDIT.path, BROKEN)], { nominate: true }), roleThat([step.probe('context_dump'), step.write(PERMITTED_EDIT.path, PERMITTED_EDIT.content)])]);
    const first = await ended(fx, project.id, item, 0, "the stage's first Builder run");
    assert.deepEqual([first.outcome, first.reason_class], ['completed', 'none'], `the first Builder run was accepted (${first.reason_text})`);
    const [c1] = await waitForCandidates(fx, project.id);
    await pauseProject(fx.engine, project.id);
    assert.equal(runsOf(fx.home, item).length, 1, 'the fixture is live: no repair run was dispatched before the pause');

    const recorded = await waitRecorded(fx, project.id, c1.id, KEYS, { what: "the first candidate's checks to be recorded" });
    const failed = resultRow(fx.home, recorded.accept.result);
    assert.deepEqual([failed.execution_established, failed.exit_status], [1, 1], 'the fixture is live: the acceptance check ran and exited 1');
    const text = outputText(fx.home, failed);
    assert.ok(text.includes(FLAG) && /differs from/.test(text), `the fixture is live: its output record holds what it wrote (${JSON.stringify(text)})`);
    const row = itemRow(fx.home, item);
    assert.deepEqual([row.status, row.repair_attempts, runsOf(fx.home, item).length], ['eligible', 1, 1], 'the fixture is live: the repair is taken, its run not yet dispatched');

    await registerDetector(fx.engine, 'm237-flag', FLAG);
    await waitForPostScan(fx.home, failed.output, 'hit');

    await resumeProject(fx.engine, project.id);
    await ended(fx, project.id, item, 1, "the stage's repair run");
    const { manifest, files: dumped } = packageOf(fx, item, 1, 'the repair run');
    const lines = text.split('\n').filter((l) => l.length > 0);
    for (const f of dumped) {
      const body = f.text ?? '';
      for (const line of lines) assert.ok(!body.includes(line), `no package file holds a line of the flagged record: ${f.name} holds ${JSON.stringify(line)}`);
    }
    // Treated as missing: the run is still told the check failed (one check_output entry naming the record, SEAM.md §229),
    // as for a record whose bytes are gone, but the file holds none of it.
    const entries = manifest.files.filter((e) => e.kind === 'check_output');
    assert.deepEqual(entries.map((e) => e.source), [failed.output], `the package names the failed check's output record once (manifest ${JSON.stringify(manifest.files)})`);
    const body = dumped.find((f) => f.name === entries[0].path)?.text ?? '';
    assert.ok(!body.includes(FLAG), `the check_output file does not hold the flagged record (${JSON.stringify(body.slice(0, 200))})`);
  });
});
