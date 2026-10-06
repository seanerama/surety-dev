// M129, the result is read after termination with closure; links are never
// followed (M2 slice 13 part 1, sandbox lane). M2 plan §3.6 M129; D2 §1.4,
// §3.2, K4, A.6 P18 (D2-A05, D2-A06); AR A05, A06, P18; E65 item 7; SEAM.md
// §§126, 143, 144.
//
// The role's result is /surety/out/result.json on the domain's volatile
// filesystem, and the engine reads it only once the domain is terminated:
// a descendant that goes on rewriting the file after the role has exited
// is killed with the domain, and what is collected is the file as it was
// then, never an earlier version. A launcher held before placement when the
// deadline passes leaves nothing to collect. The file as a link to a FIFO
// the test holds on the host, as a FIFO, as a link to /dev/zero, and one
// byte over result_max_bytes is each refused without following, opening or
// reading past the bound, within collect_deadline; the host FIFO never has
// a reader. A regular result in the next run is accepted.
//
// SAFETY (E64 item 2; SEAM.md §§141, 144): every shape of the result file
// and the rewriting descendant is a guarded action, released only after the
// host has read that the role is contained; each touches only
// /surety/out/result.json, inside the sandbox. Nothing here exhausts
// anything. The host FIFO lives in a short directory of the test's own
// under /tmp and is removed with the test.
//
// Every case is expected to fail on the engine these tests were written
// against (main at 6641172: the slice-12 engine reads the stdout result line
// while the role runs; COVERAGE.md, "M2 slice 13 (part 1)").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { releaseBarrier } from './harness/engine.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { armBarrier, changePolicy } from './harness/journal.mjs';
import { addProject, addWork, advanceClockInSteps, assertRunEnded, requestTick, run as runRow, stopRun, waitForRun, waitForRunState, waitForWork } from './harness/runs.mjs';
import { cgroupExists, populated, procsOf } from './harness/sandbox/cgroup.mjs';
import { assertEngineInScope, domainOf, eventsOf, firstSeq, receiptOf, sandboxEngine, terminalObservation } from './harness/sandbox/lane.mjs';
import { hostProcess } from './harness/sandbox/procs.mjs';
import { collectionOf, fifoWatch, recordJson, runRecords } from './harness/sandbox/result.mjs';
import { armedRole } from './harness/sandbox/view.mjs';
import { VALID_RESULT, resultFileOf, script, step } from './harness/scripted.mjs';

const RESULT_MAX = CONTRACT.engine.result_max_bytes.min;
const COLLECT_DEADLINE = CONTRACT.engine.collect_deadline.min;
const VERIFIER_DEADLINE = CONTRACT.project.deadline_verifier.default;
const LEASE_TTL = CONTRACT.engine.lease_ttl.max;
const CLOCK = { stepSeconds: Math.floor(LEASE_TTL / 2), pauseMs: 1200 };

// A git project whose failed item parks at once, so that a failed run's
// item is not dispatched again ahead of the next case's (SEAM.md §15,
// "Counters and parking").
async function parkingProject(fx) {
  const project = (await addGitProject(fx)).id;
  await changePolicy(fx.engine, project, { repair_attempts_max: 0 });
  return project;
}

// From now until the run ends, when (monotonic) the test first saw
// domain.terminated for the domain and the run ended.
function watchEnd(fx, runId, domainId) {
  const seen = { terminatedAt: null, endedAt: null };
  const done = (async () => {
    const began = performance.now();
    while (performance.now() - began < 120_000) {
      if (seen.terminatedAt === null && eventsOf(fx.home, 'domain', domainId, 'domain.terminated').length > 0) seen.terminatedAt = performance.now();
      if (runRow(fx.home, runId)?.state === 'ended') {
        seen.endedAt = performance.now();
        return seen;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return seen;
  })();
  return done;
}

// What every refused shape of P18 must show once its run has ended.
async function assertRefusedShape(fx, project, armed, ends, { reason, what }) {
  const seen = await ends;
  assert.ok(seen.endedAt !== null, `${what}: the run ended`);
  assertRunEnded(fx.home, armed.run.id, { outcome: 'failed', reason_class: 'invalid_result', launched: true, recovery: false });
  const terminal = terminalObservation(fx.home, receiptOf(fx.home, armed.run.id).id);
  assert.equal(terminal.exit_class, 'clean', `${what}: the role exited 0 with its terminal success event, so only the file is wrong (${JSON.stringify(terminal)})`);
  const c = await collectionOf(fx, project, armed.run.id);
  assert.deepEqual([c.outcome, c.reason], ['invalid', reason], `${what}: result_collection says the file is invalid, ${reason} (${JSON.stringify(c)})`);
  assert.equal(runRow(fx.home, armed.run.id).result, null, `${what}: the run has no result`);
  assert.deepEqual(runRecords(fx.home, armed.run.id, 'result'), [], `${what}: no result record`);
  assert.ok(seen.terminatedAt !== null, `${what}: the test saw domain.terminated before the run ended`);
  assert.ok(
    seen.endedAt - seen.terminatedAt <= COLLECT_DEADLINE * 1000,
    `${what}: refused within collect_deadline (${COLLECT_DEADLINE} s) of termination: the run ended ${Math.round(seen.endedAt - seen.terminatedAt)} ms after the test saw domain.terminated`,
  );
  return c;
}

describe('M129 the result is read after termination with closure; links are never followed', () => {
  test('(a) a role writes a valid result and exits 0 while a descendant rewrites the file every 100 ms: domain.terminated precedes run.validating, and the result record holds the file as it was when populated 0 was read (the last marker logged before the kill, or the one after, never an earlier one)', async (t) => {
    const fx = await sandboxEngine(t, { config: { terminate_grace: 3, kill_grace: 2 } });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    // The role writes its own valid result first, then starts the
    // descendant, lets it rewrite the file for half a second, sends its
    // terminal success event and exits 0: whatever the file holds when the
    // domain is killed is one of the descendant's markers.
    const armed = await armedRole(fx, project, item, {
      before: [step.resultFile()],
      acts: (act) => [act.resultShape('rewriter', { every_ms: 100, on_term: 'ignore' })],
      after: [step.sleep(500), step.resultEvent()],
      result: false,
    });
    const ended = await armed.release();
    const shaped = armed.probe('result_shape');
    assert.equal(shaped.ready, true, `the fixture is live: the descendant rewrote the file before the role went on (${JSON.stringify(shaped)})`);
    assert.equal(resultFileOf(fx.scripted, armed.launch.invocation)?.outcome, 'written', 'the fixture is live: the role wrote its own valid result first');

    const log = fx.scripted.log().filter((e) => e.invocation === armed.launch.invocation);
    const exit = log.find((e) => e.event === 'exit' && e.pid === armed.launch.pid);
    assert.equal(exit?.code, 0, 'the role exited 0');
    const markers = log.filter((e) => e.event === 'rewrite').map((e) => e.n);
    // Whether the descendant outlives the role's exit is the engine's (the
    // domain init may leave with the backend and end the pid namespace); the
    // case pins what is collected, not that window (COVERAGE.md, "M2 slice 13 (part 1)").
    assert.ok(markers.length >= 3, `the fixture is live: the descendant rewrote the file while the role ran (${markers.length} rewrites logged)`);
    const last = Math.max(...markers);

    assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], `the run completes on the file it collected (${ended.reason_text})`);
    const terminated = firstSeq(fx.home, 'domain', armed.domain.id, 'domain.terminated');
    const validating = firstSeq(fx.home, 'run', armed.run.id, 'run.validating');
    assert.ok(terminated !== null && validating !== null, `domain.terminated (${terminated}) and run.validating (${validating}) were both written`);
    assert.ok(terminated < validating, `domain.terminated (seq ${terminated}) precedes run.validating (seq ${validating}): the result is recorded only after termination`);

    const resultId = runRow(fx.home, armed.run.id).result;
    assert.ok(resultId, 'the run names its result record');
    const value = recordJson(fx.home, resultId);
    const m = /^marker (\d+)$/.exec(value?.summary ?? '');
    assert.ok(m, `the result is the descendant's last rewrite, not the role's own result or the stdout line (summary ${JSON.stringify(value?.summary)})`);
    const marker = Number(m[1]);
    assert.ok(marker === last || marker === last + 1, `the record holds marker ${marker}: the last marker logged before the kill is ${last}, so it must be ${last} or ${last + 1}, never an earlier one`);

    const terminal = terminalObservation(fx.home, receiptOf(fx.home, armed.run.id).id);
    assert.equal(terminal.exit_class, 'clean', `the role's exit is clean (${JSON.stringify(terminal)})`);
    const c = await collectionOf(fx, project, armed.run.id);
    assert.deepEqual(
      [c.outcome, c.reason, c.bytes_read],
      ['accepted', null, Buffer.byteLength(JSON.stringify({ status: 'completed', summary: `marker ${marker}` }))],
      `result_collection: accepted, the whole file read (${JSON.stringify(c)})`,
    );
  });

  test('(b) a launcher paused before placement when the deadline passes: the launcher\'s exit is awaited before termination, nothing is collected, result null, the run timed_out', async (t) => {
    const fx = await sandboxEngine(t, { config: { lease_ttl: LEASE_TTL, terminate_grace: 3, kill_grace: 2 } });
    const scope = await assertEngineInScope(fx);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.complete()]);
    await armBarrier(fx.engine, 'launcher.before_placement', 'pause');
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:launcher.before_placement');
    const run = await waitForRun(fx.home, item);
    const domain = domainOf(fx.home, run.id);
    assert.equal(populated(domain.cgroup_path), 0, 'the fixture is live: the domain is not populated at the barrier');
    const launcher = procsOf(scope.supervisor).find((p) => p !== fx.engine.pid && /node$/.test(hostProcess(p)?.cmdline[0] ?? ''));
    assert.ok(launcher, `the paused launcher is found in the supervisor leaf (members: ${procsOf(scope.supervisor).join(', ')})`);
    await armBarrier(fx.engine, 'boundary.before_terminated', 'pause');

    await advanceClockInSteps(fx.engine, VERIFIER_DEADLINE + 5, CLOCK);
    await fx.engine.waitUntil('barrier:boundary.before_terminated', { timeoutMs: 60_000 });
    assert.equal(hostProcess(launcher), null, 'host-read at boundary.before_terminated: the launcher\'s exit was awaited before termination is recorded');
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.terminated'), [], 'terminated is not yet recorded');
    await releaseBarrier(fx.engine, 'boundary.before_terminated');

    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 60_000 });
    assertRunEnded(fx.home, run.id, { outcome: 'timed_out', reason_class: 'deadline', launched: false, recovery: false });
    assert.deepEqual(fx.scripted.launches({ run: run.id }), [], 'no role was launched');
    assert.equal(runRow(fx.home, run.id).result, null, 'result null');
    assert.deepEqual(runRecords(fx.home, run.id).filter((r) => ['result', 'unaccepted_result', 'provider_files'].includes(r.kind)), [], 'nothing is collected');
    const c = await collectionOf(fx, project, run.id);
    assert.deepEqual([c.outcome, c.reason, c.bytes_read], ['not_collected', null, null], `result_collection: not collected, there being no volatile filesystem to look in (${JSON.stringify(c)})`);
    assert.equal(cgroupExists(domain.cgroup_path), false, 'the domain is removed');
    await waitForWork(fx.home, item, 'parked');
  });

  test('(c) P18: result.json as a link to a host FIFO the test watches, as a FIFO, as a link to /dev/zero, and one byte over result_max_bytes: each invalid_result within collect_deadline, never followed, opened or read past the bound; the host FIFO never had a reader (ENXIO on every non-blocking open)', async (t) => {
    const fx = await sandboxEngine(t, { config: { result_max_bytes: RESULT_MAX, collect_deadline: COLLECT_DEADLINE } });
    const project = await parkingProject(fx);

    // A link to the host FIFO, watched from before the dispatch until a
    // second after the run ended.
    const fifo = fifoWatch(t);
    const linkItem = await addWork(fx.engine, project, 'verification');
    const linked = await armedRole(fx, project, linkItem, { acts: (act) => [act.resultShape('host_fifo_link', { target: fifo.path })], result: false, after: [step.resultEvent()] });
    const linkEnds = watchEnd(fx, linked.run.id, linked.domain.id);
    await linked.release();
    await new Promise((r) => setTimeout(r, 1000));
    const tally = fifo.stop();
    const linkShape = linked.probe('result_shape');
    assert.deepEqual([linkShape.outcome, linkShape.type, linkShape.target], ['shaped', 'symlink', fifo.path], `the fixture is live: result.json is a link to the host FIFO (${JSON.stringify(linkShape)})`);
    const viaLink = await assertRefusedShape(fx, project, linked, linkEnds, { reason: 'link', what: 'a link to a host FIFO' });
    assert.equal(viaLink.bytes_read, 0, 'nothing was read through the link');
    assert.ok(tally.polls >= 20, `the watch ran throughout (${tally.polls} polls)`);
    assert.deepEqual(tally.other, [], `every poll failed for want of a reader, and for no other reason (${JSON.stringify(tally.other)})`);
    assert.equal(tally.opened, 0, `the host FIFO never had a reader: ${tally.opened} of ${tally.polls} non-blocking opens for writing succeeded`);
    assert.equal(tally.enxio, tally.polls, `ENXIO on every poll (${tally.enxio} of ${tally.polls})`);

    // A FIFO at the path itself.
    const fifoItem = await addWork(fx.engine, project, 'verification');
    const fifoRole = await armedRole(fx, project, fifoItem, { acts: (act) => [act.resultShape('fifo')], result: false, after: [step.resultEvent()] });
    const fifoEnds = watchEnd(fx, fifoRole.run.id, fifoRole.domain.id);
    await fifoRole.release();
    const fifoShape = fifoRole.probe('result_shape');
    assert.deepEqual([fifoShape.outcome, fifoShape.type], ['shaped', 'fifo'], `the fixture is live: result.json is a FIFO (${JSON.stringify(fifoShape)})`);
    const viaFifo = await assertRefusedShape(fx, project, fifoRole, fifoEnds, { reason: 'fifo', what: 'a FIFO' });
    assert.equal(viaFifo.bytes_read, 0, 'nothing was read from the FIFO');

    // A link to a device.
    const devItem = await addWork(fx.engine, project, 'verification');
    const devRole = await armedRole(fx, project, devItem, { acts: (act) => [act.resultShape('device_link')], result: false, after: [step.resultEvent()] });
    const devEnds = watchEnd(fx, devRole.run.id, devRole.domain.id);
    await devRole.release();
    const devShape = devRole.probe('result_shape');
    assert.deepEqual([devShape.outcome, devShape.type, devShape.target], ['shaped', 'symlink', '/dev/zero'], `the fixture is live: result.json is a link to /dev/zero (${JSON.stringify(devShape)})`);
    const viaDev = await assertRefusedShape(fx, project, devRole, devEnds, { reason: 'link', what: 'a link to /dev/zero' });
    assert.equal(viaDev.bytes_read, 0, 'zero bytes read from the device');

    // One byte over the bound.
    const bigItem = await addWork(fx.engine, project, 'verification');
    const bigRole = await armedRole(fx, project, bigItem, { acts: (act) => [act.resultShape('oversize', { bytes: RESULT_MAX + 1 })], result: false, after: [step.resultEvent()] });
    const bigEnds = watchEnd(fx, bigRole.run.id, bigRole.domain.id);
    await bigRole.release();
    const bigShape = bigRole.probe('result_shape');
    assert.deepEqual([bigShape.outcome, bigShape.type, bigShape.size], ['shaped', 'file', RESULT_MAX + 1], `the fixture is live: result.json is a regular, well-formed file one byte over result_max_bytes (${JSON.stringify(bigShape)})`);
    const viaBig = await assertRefusedShape(fx, project, bigRole, bigEnds, { reason: 'oversize', what: 'an oversize file' });
    assert.ok(viaBig.bytes_read <= RESULT_MAX, `nothing past result_max_bytes (${RESULT_MAX}) was read (bytes_read ${viaBig.bytes_read})`);
  });

  test('(d) after a refused result, a regular result in the next run is accepted: completed, the result record the file\'s value', async (t) => {
    const fx = await sandboxEngine(t, { config: { result_max_bytes: RESULT_MAX, collect_deadline: COLLECT_DEADLINE } });
    const project = await parkingProject(fx);
    const refusedItem = await addWork(fx.engine, project, 'verification');
    const refused = await armedRole(fx, project, refusedItem, { acts: (act) => [act.resultShape('device_link')], result: false, after: [step.resultEvent()] });
    const first = await refused.release();
    assert.deepEqual([first.outcome, first.reason_class], ['failed', 'invalid_result'], `the fixture is live: the first run's result is refused (${first.reason_text})`);

    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.complete()]);
    await requestTick(fx.engine, project);
    const run = await waitForRun(fx.home, item, { state: 'ended', timeoutMs: 60_000 });
    assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', launched: true, recovery: false });
    const [launch] = fx.scripted.launches({ run: run.id });
    const written = resultFileOf(fx.scripted, launch.invocation);
    assert.equal(written?.outcome, 'written', `the fixture is live: the role wrote its result file (${JSON.stringify(written)})`);
    const c = await collectionOf(fx, project, run.id);
    assert.deepEqual([c.outcome, c.reason, c.bytes_read], ['accepted', null, written.bytes], `result_collection: accepted, the whole file read (${JSON.stringify(c)})`);
    assert.deepEqual(recordJson(fx.home, runRow(fx.home, run.id).result), VALID_RESULT, 'the result record is the file\'s value');
  });

  // Q13 (Sean's fourth attempt; the M2 report's section 21, question 13):
  // the hands-on script's Stop reached a Builder that had already exited
  // clean with its result, held at boundary.before_terminated; the engine
  // recorded it stopped / human_stop, its result unaccepted, its usage
  // incomplete. D2 §1.6: a cancellation's cause keeps the outcome only when
  // the engine began cancelling before the exit (engine_signaled); SEAM.md
  // §143: a clean exit with an accepted file is the run's result, completed.
  test('Q13: a role exits clean with its result; a Stop confirmed after the exit and before the engine records the termination does not turn it into a stop: the run is completed with its result accepted, exit class clean, no unaccepted_result', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.complete()]);
    await armBarrier(fx.engine, 'boundary.before_terminated', 'pause');
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:boundary.before_terminated', { timeoutMs: 60_000 });
    const run = await waitForRun(fx.home, item);
    const domain = domainOf(fx.home, run.id);
    assert.equal(populated(domain.cgroup_path), 0, 'the fixture is live: the role has exited, the domain empty, before the Stop');
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.terminated'), [], 'the fixture is live: termination is not yet recorded');
    assert.equal(runRow(fx.home, run.id).state, 'executing', 'the fixture is live: the run is still executing when the Stop arrives');

    await stopRun(fx.engine, project, run.id);
    await releaseBarrier(fx.engine, 'boundary.before_terminated');
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 60_000 });

    const ended = runRow(fx.home, run.id);
    assert.equal(terminalObservation(fx.home, receiptOf(fx.home, run.id).id)?.exit_class, 'clean', 'exit class clean: the engine signalled nothing before the exit');
    assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], `a Stop after a clean exit does not override the exit's outcome (D2 §1.6; SEAM.md §143): ${JSON.stringify({ outcome: ended.outcome, reason_class: ended.reason_class, reason_text: ended.reason_text })}`);
    assert.notEqual(ended.result, null, 'the result is accepted as the run\'s result');
    const kinds = runRecords(fx.home, run.id).map((r) => r.kind);
    assert.ok(kinds.includes('result') && !kinds.includes('unaccepted_result'), `a result record, and no unaccepted_result (${JSON.stringify(kinds)})`);
  });
});
