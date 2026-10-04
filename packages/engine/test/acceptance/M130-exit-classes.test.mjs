// M130, exit class and domain observation are separate, total facts (M2
// slice 13 part 1, sandbox lane). M2 plan §3.6 M130; D2 §1.4, §1.6, §3.4,
// K4, A.2, A.3 (D2-A07 to D2-A09, D2-B04); E27 item 7; E58 item 7; E69; AR
// N02; SEAM.md §§126, 128, 143 to 145.
//
// A role ending each way gets one exit class, chosen by D2 §1.6's
// precedence, on its terminal observation, with every contributing fact in
// exit_evidence: a clean exit with the terminal success event and a valid
// result completes; a result without the event, or a nonzero status, is an
// error exit (invalid_result with a well-formed result, infra_error
// without); a Stop is engine_signaled, keeps the Stop's outcome, and the
// result present is published as an unaccepted_result, never the run's; a
// SIGKILL from the role's own descendant is a foreign signal; a pids.max
// hit the role survives is recorded and fails nothing; a lost exit report
// is unknown and never completes; an unknown termination collects nothing.
// The run read shows the exit class and the domain observation, apart.
//
// Cases (f) and (g), the OOM cases, run on the exhaustion host only (E69);
// here they fail with that message, never skip.
//
// SAFETY (E64 item 2; SEAM.md §§141, 144): the descendant's SIGKILL of the
// role and the spawns until refused are guarded actions, released only
// after the host has read that the role is contained; the kill names only
// the killer's own parent, and at most eight `sleep` processes are spawned
// against a pids.max the test lowered on the domain alone. Nothing here
// exhausts anything.
//
// Every case is expected to fail on the engine these tests were written
// against (main at 6641172; COVERAGE.md, "M2 slice 13 (part 1)").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { armFault, clearFaults } from './harness/engine.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { addProject, addWork, assertRunEnded, requestTick, run as runRow, stopRun, waitForQuarantine, waitForRun, waitForRunState, waitForWork } from './harness/runs.mjs';
import { counterOf, pidsCurrent, setPidsMax } from './harness/sandbox/cgroup.mjs';
import { domainOf, domainRow, receiptOf, roleHolding, sandboxEngine, terminalObservation } from './harness/sandbox/lane.mjs';
import { assertReadShowsExit, collectionOf, recordJson, runRecords, unacceptedOf } from './harness/sandbox/result.mjs';
import { armedRole } from './harness/sandbox/view.mjs';
import { VALID_RESULT, resultFileOf, script, step } from './harness/scripted.mjs';

const GRACE = { terminate_grace: 3, kill_grace: 2 };
const COLLECTED = ['result', 'unaccepted_result', 'provider_files'];
const EXHAUSTION_HOST_ONLY = 'M130 (f)/(g) run on the exhaustion host only (E69); written in slice 13 part 3';

// A git project whose failed item parks at once (SEAM.md §15), so that a
// failed run's item is not dispatched again behind the case's back.
async function parkingProject(fx) {
  const project = (await addGitProject(fx)).id;
  await changePolicy(fx.engine, project, { repair_attempts_max: 0 });
  return project;
}

// Dispatch one item with this script and wait for its run to end.
async function runToEnd(fx, project, item, oneScript) {
  fx.scripted.script(item, [oneScript]);
  await requestTick(fx.engine, project);
  const run = await waitForRun(fx.home, item, { state: 'ended', timeoutMs: 60_000 });
  const [launch] = fx.scripted.launches({ run: run.id });
  assert.ok(launch, `the fixture is live: the role of run ${run.id} was launched`);
  return { run, launch, terminal: terminalObservation(fx.home, receiptOf(fx.home, run.id).id) };
}

const evidenceOf = (terminal) => {
  assert.ok(terminal, 'the invocation has its terminal observation');
  const e = terminal.exit_evidence;
  assert.ok(e && typeof e === 'object', `the terminal observation has exit_evidence (${JSON.stringify(terminal)})`);
  for (const key of ['status', 'signal', 'signal_by_engine', 'terminal_event', 'resource_events']) assert.ok(key in e, `exit_evidence has ${key} (${JSON.stringify(e)})`);
  const r = e.resource_events;
  assert.ok(r && typeof r === 'object' && 'oom_kill' in r && 'pids_max' in r, `exit_evidence.resource_events has oom_kill and pids_max, each a count or null where unread, never {} (SEAM.md §145; ${JSON.stringify(r)})`);
  for (const k of ['oom_kill', 'pids_max']) assert.ok(r[k] === null || (Number.isInteger(r[k]) && r[k] >= 0), `resource_events.${k} is a count or null (${JSON.stringify(r[k])})`);
  return e;
};

describe('M130 exit class and domain observation are separate, total facts', () => {
  test('(a) exit 0, the terminal success event, a valid result: clean, completed, the result record the file\'s value', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, launch, terminal } = await runToEnd(fx, project, item, script.complete());
    assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', launched: true, recovery: false });
    assert.equal(terminal.exit_class, 'clean', `exit class (${JSON.stringify(terminal)})`);
    const e = evidenceOf(terminal);
    assert.deepEqual([e.status, e.signal_by_engine, e.terminal_event], [0, false, 'result'], `exit_evidence: status 0, no signal by the engine, the terminal success event (${JSON.stringify(e)})`);
    const c = await collectionOf(fx, project, run.id);
    assert.deepEqual([c.outcome, c.reason, c.bytes_read], ['accepted', null, resultFileOf(fx.scripted, launch.invocation)?.bytes], `result_collection (${JSON.stringify(c)})`);
    assert.deepEqual(recordJson(fx.home, runRow(fx.home, run.id).result), VALID_RESULT, 'the result record is the file\'s value');
  });

  test('(b) exit 0 with a well-formed result file and no terminal success event: error_exit, failed / invalid_result, the run\'s result null', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const project = await parkingProject(fx);
    const item = await addWork(fx.engine, project, 'verification');
    const { run, launch, terminal } = await runToEnd(fx, project, item, { steps: [step.resultFile()] });
    assert.equal(resultFileOf(fx.scripted, launch.invocation)?.outcome, 'written', 'the fixture is live: the role wrote its result file');
    assertRunEnded(fx.home, run.id, { outcome: 'failed', reason_class: 'invalid_result', launched: true, recovery: false });
    assert.equal(terminal.exit_class, 'error_exit', `no terminal success event: never clean (${JSON.stringify(terminal)})`);
    const e = evidenceOf(terminal);
    assert.deepEqual([e.status, e.signal_by_engine, e.terminal_event], [0, false, null], `exit_evidence: status 0, no terminal event (${JSON.stringify(e)})`);
    const c = await collectionOf(fx, project, run.id);
    assert.equal(c.outcome, 'accepted', `the file itself is well-formed: result_collection accepted (${JSON.stringify(c)})`);
    assert.equal(runRow(fx.home, run.id).result, null, 'but it is not the run\'s result');
    assert.deepEqual(runRecords(fx.home, run.id, 'result'), [], 'no result record');
  });

  test('(c) exit 1 with a well-formed result: error_exit, invalid_result; exit 1 without one (the event, no file): error_exit, infra_error, result_collection missing', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const project = await parkingProject(fx);

    const withItem = await addWork(fx.engine, project, 'verification');
    const withResult = await runToEnd(fx, project, withItem, { steps: [step.resultFile(), step.exit(1)] });
    assertRunEnded(fx.home, withResult.run.id, { outcome: 'failed', reason_class: 'invalid_result', launched: true, recovery: false });
    assert.equal(withResult.terminal.exit_class, 'error_exit', `with a result: error_exit (${JSON.stringify(withResult.terminal)})`);
    assert.equal(evidenceOf(withResult.terminal).status, 1, 'with a result: status 1');
    assert.equal((await collectionOf(fx, project, withResult.run.id)).outcome, 'accepted', 'with a result: the file is well-formed');
    assert.equal(runRow(fx.home, withResult.run.id).result, null, 'with a result: not the run\'s result');

    const withoutItem = await addWork(fx.engine, project, 'verification');
    const without = await runToEnd(fx, project, withoutItem, { steps: [step.resultEvent(), step.exit(1)] });
    assertRunEnded(fx.home, without.run.id, { outcome: 'failed', reason_class: 'infra_error', launched: true, recovery: false });
    assert.equal(without.terminal.exit_class, 'error_exit', `without a result: error_exit, the terminal event notwithstanding (${JSON.stringify(without.terminal)})`);
    const e = evidenceOf(without.terminal);
    assert.deepEqual([e.status, e.terminal_event], [1, 'result'], `without a result: status 1, the event read (${JSON.stringify(e)})`);
    const c = await collectionOf(fx, project, without.run.id);
    assert.deepEqual([c.outcome, c.reason, c.bytes_read], ['missing', null, 0], `without a result: result_collection missing, nothing read (${JSON.stringify(c)})`);
  });

  test('(d) Stop while running with a result file present: engine_signaled, stopped / human_stop, signal_by_engine true; the result published as an unaccepted_result after the screen, the run\'s result null', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, launch } = await roleHolding(fx, project, item, { before: [step.resultFile()], on_term: 'exit' });
    const written = resultFileOf(fx.scripted, launch.invocation);
    assert.equal(written?.outcome, 'written', 'the fixture is live: the result file is present while the role runs');
    await stopRun(fx.engine, project, run.id);
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 40_000 });
    assertRunEnded(fx.home, run.id, { outcome: 'stopped', reason_class: 'human_stop', launched: true, recovery: false });
    const terminal = terminalObservation(fx.home, receiptOf(fx.home, run.id).id);
    assert.equal(terminal.exit_class, 'engine_signaled', `exit class (${JSON.stringify(terminal)})`);
    assert.equal(evidenceOf(terminal).signal_by_engine, true, 'signal_by_engine');
    const c = await collectionOf(fx, project, run.id);
    assert.deepEqual([c.outcome, c.bytes_read], ['accepted', written.bytes], `the file was collected whole after termination (${JSON.stringify(c)})`);
    assert.equal(runRow(fx.home, run.id).result, null, 'the run\'s result is null');
    assert.deepEqual(runRecords(fx.home, run.id, 'result'), [], 'no result record');
    const unaccepted = unacceptedOf(fx.home, run.id, project);
    assert.deepEqual(unaccepted.value, VALID_RESULT, 'the unaccepted_result record holds what the role wrote');
  });

  test('(e) the role killed by its own descendant\'s SIGKILL: foreign_signal, failed / infra_error naming the class', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const project = await parkingProject(fx);
    const item = await addWork(fx.engine, project, 'verification');
    const armed = await armedRole(fx, project, item, { acts: (act) => [act.killParent({ delay_ms: 300 })], result: false });
    const ended = await armed.release();
    const spawned = armed.probe('kill_parent');
    assert.equal(spawned.outcome, 'spawned', `the fixture is live: the killer was started (${JSON.stringify(spawned)})`);
    const killer = fx.scripted.eventsOfInvocation(armed.launch.invocation, 'killer');
    assert.deepEqual(killer.map((k) => k.sent), [true], `the fixture is live: the descendant sent SIGKILL to the role (${JSON.stringify(killer)})`);
    assert.deepEqual(fx.scripted.eventsOfInvocation(armed.launch.invocation, 'kill_parent_survived'), [], 'the role did not survive it');
    assertRunEnded(fx.home, armed.run.id, { outcome: 'failed', reason_class: 'infra_error', launched: true, recovery: false });
    const terminal = terminalObservation(fx.home, receiptOf(fx.home, armed.run.id).id);
    assert.equal(terminal.exit_class, 'foreign_signal', `exit class (${JSON.stringify(terminal)})`);
    const e = evidenceOf(terminal);
    assert.deepEqual([e.status, e.signal, e.signal_by_engine], [null, 9, false], `exit_evidence: no status, signal 9, not the engine's (${JSON.stringify(e)})`);
    assert.match(ended.reason_text ?? '', /foreign_signal/, `the run's reason names the class (${ended.reason_text})`);
  });

  test(`(f) OOM at memory.max: resource_limit, oom_kill recorded, failed / infra_error [${EXHAUSTION_HOST_ONLY}]`, () => {
    assert.fail(EXHAUSTION_HOST_ONLY);
  });

  test(`(g) a Stop confirmed, then the role allocates to OOM before TERM lands: engine_signaled keeps stopped, oom_kill recorded [${EXHAUSTION_HOST_ONLY}]`, () => {
    assert.fail(EXHAUSTION_HOST_ONLY);
  });

  test('(h) pids.max hit, then exit 0 with a result: clean, completed, pids_max recorded; not failed', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const armed = await armedRole(fx, project, item, { acts: (act) => [act.spawnUntilRefused({ max: 6, seconds: 60 })], after: [step.hold('after_spawn')] });
    // While the role holds, contained (armedRole has read that from the
    // host): the domain's pids.max lowered to two above what it holds now.
    const dir = armed.domain.cgroup_path;
    const current = pidsCurrent(dir);
    setPidsMax(dir, current + 2);
    fx.scripted.release(item, 'armed');
    await fx.scripted.waitForHolding({ work_item: item }, 'after_spawn', { timeoutMs: 30_000 });
    const spawn = armed.probe('spawn_until_refused');
    assert.equal(spawn.outcome, 'refused', `the fixture is live: a spawn was refused at the lowered limit (${JSON.stringify(spawn)})`);
    const hostRead = counterOf(dir, 'pids.events', 'max');
    assert.ok(hostRead >= 1, `host-read: the domain's pids.events max rose (${hostRead})`);
    fx.scripted.release(item, 'after_spawn');
    const ended = await waitForRunState(fx.home, armed.run.id, 'ended', { timeoutMs: 60_000 });

    assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], `a limit the role survived fails nothing (${ended.reason_text})`);
    const terminal = terminalObservation(fx.home, receiptOf(fx.home, armed.run.id).id);
    assert.equal(terminal.exit_class, 'clean', `exit class (${JSON.stringify(terminal)})`);
    const e = evidenceOf(terminal);
    assert.ok(e.resource_events.pids_max >= hostRead, `exit_evidence records the pids_max rise (${JSON.stringify(e.resource_events)}; host-read ${hostRead})`);
    const row = domainRow(fx.home, armed.domain.id);
    assert.ok(row.resource_events?.pids_max >= hostRead, `execution_domains.resource_events records it too (${JSON.stringify(row.resource_events)})`);
  });

  test('(i) init_report_lost with termination established: unknown, the redacted unaccepted output collected, failed / infra_error, never completed', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const project = await parkingProject(fx);
    const item = await addWork(fx.engine, project, 'verification');
    await armFault(fx.engine, { point: 'init_report_lost' });
    const { run, launch, terminal } = await runToEnd(fx, project, item, script.complete());
    assert.equal(resultFileOf(fx.scripted, launch.invocation)?.outcome, 'written', 'the fixture is live: the role wrote its result');
    assertRunEnded(fx.home, run.id, { outcome: 'failed', reason_class: 'infra_error', recovery: false });
    assert.equal(terminal.exit_class, 'unknown', `no exit report reached the engine (${JSON.stringify(terminal)})`);
    assert.equal(evidenceOf(terminal).status, null, 'no status was reported');
    assert.equal(runRow(fx.home, run.id).result, null, 'the run\'s result is null');
    const unaccepted = unacceptedOf(fx.home, run.id, project);
    assert.deepEqual(unaccepted.value, VALID_RESULT, 'the unaccepted output is collected');
    const shown = (await collectionOf(fx, project, run.id)).shown;
    assertReadShowsExit(shown, terminal, domainRow(fx.home, domainOf(fx.home, run.id).id), '(i)');
    assert.deepEqual([shown.exit_class, shown.domain_observation], ['unknown', 'terminated'], '(i): an unknown exit on a terminated domain: two facts');
  });

  test('(j) unknown termination (manager_unreachable, as M115): nothing collected, result_collection not_collected, the run read showing no exit class and the domain unknown', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, launch } = await roleHolding(fx, project, item, { before: [step.resultFile()], on_term: 'exit' });
    assert.equal(resultFileOf(fx.scripted, launch.invocation)?.outcome, 'written', 'the fixture is live: a result file is present');
    await armFault(fx.engine, { point: 'manager_unreachable', times: 1_000_000 });
    t.after(() => clearFaults(fx.engine).catch(() => {}));
    await stopRun(fx.engine, project, run.id);
    await waitForQuarantine(fx.home, run.id, { timeoutMs: 30_000 });
    assert.deepEqual(runRecords(fx.home, run.id).filter((r) => COLLECTED.includes(r.kind)).map((r) => r.kind), [], 'nothing is collected from an unknown domain');
    assert.equal(runRow(fx.home, run.id).result, null);
    const c = await collectionOf(fx, project, run.id);
    assert.deepEqual([c.outcome, c.reason, c.bytes_read], ['not_collected', null, null], `result_collection (${JSON.stringify(c)})`);
    const domain = domainRow(fx.home, domainOf(fx.home, run.id).id);
    assertReadShowsExit(c.shown, terminalObservation(fx.home, receiptOf(fx.home, run.id).id), domain, '(j)');
    assert.deepEqual([c.shown.exit_class, c.shown.domain_observation], [null, 'unknown'], '(j): no exit class while termination is unknown; the domain unknown');
  });

  test('(k) the run read shows the exit class and the domain observation, both, as the store has them', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run } = await roleHolding(fx, project, item, { on_term: 'exit' });
    await stopRun(fx.engine, project, run.id);
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 40_000 });
    const terminal = terminalObservation(fx.home, receiptOf(fx.home, run.id).id);
    const domain = domainRow(fx.home, domainOf(fx.home, run.id).id);
    const shown = (await collectionOf(fx, project, run.id)).shown;
    assertReadShowsExit(shown, terminal, domain, '(k)');
    assert.deepEqual([shown.exit_class, shown.domain_observation], ['engine_signaled', 'terminated'], '(k): a Stop: engine_signaled, the domain terminated');
    await waitForWork(fx.home, item, 'held');
  });
});
