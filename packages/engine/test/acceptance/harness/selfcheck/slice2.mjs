// Slice-2 part of the harness self-check (see run.mjs). The engine that these
// helpers will observe does not exist yet, so each helper with logic is run
// here against something that does:
//
//   5. the transition tables and the case generators built on them
//      (../transitions.mjs), with mutants of the table and of a path;
//   6. the store assertions (../invariants.mjs) against witness stores
//      (witness-state.mjs) and against one mutant per defect they must catch;
//   7. the scripted role program (../scripted/child.mjs), launched for real,
//      and the Scripted helper that scripts it and reads its log;
//   8. the HTTP helpers of ../runs.mjs against a stand-in engine.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { freePort, startEngine, waitFor, writeEngineConfig } from '../engine.mjs';
import { isoNow, newId } from '../ids.mjs';
import {
  assertDispatched,
  assertEndedRun,
  assertOneRunAtATime,
  assertQuarantinedRun,
  assertRecoveredStore,
  assertWorkHistory,
  maxConcurrentRuns,
  runIntervals,
  runPath,
  workPath,
} from '../invariants.mjs';
import { addWork, advanceClock, allocate, answerDecision, driveTo, forceTransition, observeTrigger, stopRun, tick } from '../runs.mjs';
import { BOUNDARY, Scripted, VALID_RESULT, lateSuccess, processIsLive, script, step } from '../scripted.mjs';
import {
  WORK,
  assertRunPathLegal,
  assertWorkPathLegal,
  continuationsOf,
  illegalEdgeCases,
  isLegal,
  isLegalDomainEdge,
  legalEdges,
  m1Kinds,
  owningStatuses,
  reachable,
  routeTo,
} from '../transitions.mjs';
import { emit, witnessRun, witnessWork } from './witness-state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WITNESS = readFileSync(join(here, 'witness-schema.sql'), 'utf8') + readFileSync(join(here, 'witness-slice2.sql'), 'utf8');

export async function slice2Checks(check, work) {
  let n = 0;
  const freshStore = () => {
    const db = new Database(join(work, `s2-store-${++n}.db`));
    db.pragma('foreign_keys = ON');
    db.exec(WITNESS);
    const project = newId('proj_');
    db.prepare('INSERT INTO projects (id, created_at, name) VALUES (?, ?, ?)').run(project, isoNow(), 'selfcheck');
    return { db, project };
  };
  const withStore = (fn) => {
    const { db, project } = freshStore();
    try {
      return fn(db, project);
    } finally {
      db.close();
    }
  };

  // ---- 5. transition tables ---------------------------------------------------

  const edge = (kind, from, to, opts) => isLegal(kind, from, to, opts);

  await check('transitions: the seven M1 kinds, their paths and what they can reach', () => {
    assert.deepEqual(m1Kinds().sort(), ['assessment', 'check_correction', 'fix', 'replan', 'review', 'stage_build', 'verification']);
    for (const kind of ['verification', 'review', 'check_correction']) {
      assert.deepEqual(reachable(kind), ['eligible', 'claimed', 'executing', 'complete', 'awaiting_decision', 'held', 'parked', 'cancelled'], kind);
    }
    assert.ok(!reachable('replan').includes('verifying'), 'replan never verifies');
    assert.equal(reachable('stage_build').length, 11);
    assert.deepEqual(reachable('spec_change'), ['eligible', 'complete', 'awaiting_decision', 'cancelled'], 'intent-only work has no run-owning status');
  });

  await check('transitions: correction 11 is in the table', () => {
    // Stop and Abandon from every owning status, integrated and awaiting_decision included.
    assert.deepEqual(owningStatuses('stage_build'), ['claimed', 'executing', 'integrating', 'integrated', 'verifying', 'awaiting_decision']);
    assert.deepEqual(owningStatuses('review'), ['claimed', 'executing', 'awaiting_decision']);
    assert.deepEqual(owningStatuses('spec_change'), []);
    for (const from of owningStatuses('stage_build')) {
      assert.ok(edge('stage_build', from, 'held'), `Stop from ${from}`);
      assert.ok(edge('stage_build', from, 'eligible'), `Abandon from ${from}`);
    }
    // Templates do not bring integration or verification into a kind that has none.
    assert.ok(!edge('review', 'executing', 'integrating'), 'review → integration');
    assert.ok(!edge('review', 'awaiting_decision', 'integrating', { continuation: 'executing' }));
    assert.ok(!edge('replan', 'awaiting_decision', 'verifying', { continuation: 'integrating' }));
    assert.ok(!edge('spec_change', 'awaiting_decision', 'executing', { continuation: 'executing' }), 'intent-only work never enters execution');
    assert.ok(!edge('spec_change', 'awaiting_decision', 'held'));
    // Returning from awaiting_decision restores the stored continuation and no other.
    assert.ok(edge('stage_build', 'awaiting_decision', 'integrating', { continuation: 'integrating' }));
    assert.ok(!edge('stage_build', 'awaiting_decision', 'executing', { continuation: 'integrating' }));
    assert.ok(!edge('stage_build', 'awaiting_decision', 'executing'), 'no stored continuation, no return');
    assert.deepEqual(continuationsOf('stage_build'), ['executing', 'integrating', 'verifying']);
    assert.deepEqual(continuationsOf('review'), ['executing']);
    // Terminal statuses have no exit; nothing skips claimed.
    for (const to of WORK.statuses) {
      assert.ok(!edge('review', 'complete', to) && !edge('review', 'cancelled', to), `terminal → ${to}`);
    }
    assert.ok(!edge('review', 'eligible', 'executing') && !edge('review', 'held', 'executing') && !edge('review', 'parked', 'claimed'));
  });

  await check('transitions: every A.5 common edge is present for a kind that reaches both ends', () => {
    const A5 =
      'claimed→eligible; claimed→parked; executing→eligible; integrating→eligible; verifying→eligible; executing→parked; integrating→parked; verifying→parked; executing→awaiting_decision; integrating→awaiting_decision; verifying→awaiting_decision; claimed→held; executing→held; integrating→held; verifying→held; held→eligible; parked→eligible; eligible→cancelled; claimed→cancelled; executing→cancelled; integrating→cancelled; integrated→cancelled; verifying→cancelled; awaiting_decision→cancelled; held→cancelled; parked→cancelled';
    for (const pair of A5.split('; ')) {
      const [from, to] = pair.split('→');
      assert.ok(edge('stage_build', from, to), `stage_build ${pair}`);
      const reach = reachable('verification');
      assert.equal(edge('verification', from, to), reach.includes(from) && reach.includes(to), `verification ${pair}`);
    }
    assert.equal(legalEdges('stage_build').length, 6 + A5.split('; ').length + 3 + 4, 'path + A.5 common + continue + correction 11 (two stops, two abandons)');
  });

  await check('transitions: generated illegal-edge cases are complete, reachable by legal steps, and disjoint from the legal set', () => {
    for (const kind of m1Kinds()) {
      const cases = illegalEdgeCases(kind);
      const froms = new Set(cases.map((c) => c.from));
      assert.deepEqual([...froms].sort(), [...reachable(kind)].sort(), `${kind}: one group per reachable status`);
      let total = 0;
      for (const c of cases) {
        let at = 'eligible';
        let continuation;
        for (const to of c.route) {
          assert.ok(isLegal(kind, at, to, { continuation }), `${kind}: route step ${at} → ${to}`);
          if (to === 'awaiting_decision') continuation = at;
          at = to;
        }
        assert.equal(at, c.from, `${kind}: the route ends at ${c.from}`);
        assert.equal(continuation, c.continuation, `${kind}: the route stores the continuation the case names`);
        for (const to of c.targets) assert.ok(!isLegal(kind, c.from, to, c), `${kind}: ${c.from} → ${to} is in the illegal set and the legal set`);
        const legalCount = WORK.statuses.filter((to) => to !== c.from && isLegal(kind, c.from, to, c)).length;
        assert.equal(c.targets.length + legalCount, WORK.statuses.length - 1, `${kind}: every other status is either legal or illegal from ${c.from}`);
        total += c.targets.length;
      }
      assert.ok(total >= 50, `${kind}: ${total} illegal edges generated`);
    }
    const review = illegalEdgeCases('review');
    assert.ok(review.find((c) => c.from === 'executing').targets.includes('integrating'), 'review → integration is generated');
    assert.ok(review.find((c) => c.from === 'awaiting_decision').targets.includes('verifying'), 'restoration to a status the kind lacks is generated');
    const build = illegalEdgeCases('stage_build').filter((c) => c.from === 'awaiting_decision');
    assert.deepEqual(build.map((c) => c.continuation), ['executing', 'integrating', 'verifying']);
    assert.ok(build[0].targets.includes('integrating') && build[1].targets.includes('executing'), 'a continuation other than the stored one is generated');
  });

  await check('transitions mutant: a table that lets review integrate changes what is generated and what a path check accepts', () => {
    const mutant = structuredClone(WORK);
    mutant.kinds.review.path = ['eligible', 'claimed', 'executing', 'integrating', 'integrated', 'complete'];
    assert.ok(!illegalEdgeCases('review', mutant).find((c) => c.from === 'executing').targets.includes('integrating'));
    const path = ['eligible', 'claimed', 'executing', 'integrating'];
    assertWorkPathLegal('review', path, 'mutant', mutant);
    assert.throws(() => assertWorkPathLegal('review', path), /executing → integrating is not a legal review transition/);
  });

  await check('transitions: path checks accept legal histories and name the illegal step', () => {
    assertWorkPathLegal('verification', ['eligible', 'claimed', 'executing', 'eligible', 'claimed', 'executing', 'complete']);
    assertWorkPathLegal('verification', ['eligible', 'claimed', 'executing', 'held', 'eligible', 'claimed', 'held', 'cancelled']);
    assertWorkPathLegal('stage_build', ['eligible', 'claimed', 'executing', 'integrating', 'awaiting_decision', 'integrating', 'integrated', 'held']);
    assert.throws(() => assertWorkPathLegal('stage_build', ['eligible', 'claimed', 'executing', 'integrating', 'awaiting_decision', 'executing']), /stored continuation: integrating/);
    assert.throws(() => assertWorkPathLegal('verification', ['eligible', 'executing']), /eligible → executing/);
    assert.throws(() => assertWorkPathLegal('verification', ['eligible', 'claimed', 'executing', 'complete', 'eligible']), /complete → eligible/);
    assert.throws(() => assertWorkPathLegal('verification', ['claimed']), /starts eligible/);
    assert.throws(() => assertWorkPathLegal('verification', []), /no path observed/);
    assertRunPathLegal(['created', 'claimed', 'executing', 'validating', 'finalizing', 'finalizing', 'ended']);
    assertRunPathLegal(['created', 'finalizing', 'ended'], 'recovery from created (correction 12)');
    assertRunPathLegal(['created', 'claimed', 'finalizing', 'ended']);
    assert.throws(() => assertRunPathLegal(['created', 'claimed', 'executing', 'ended']), /executing → ended/);
    assert.throws(() => assertRunPathLegal(['created', 'executing']), /created → executing/);
    assert.throws(() => assertRunPathLegal(['claimed', 'executing']), /starts created/);
    assert.ok(isLegalDomainEdge('quarantined', 'terminated'), 'correction 13');
    assert.ok(!isLegalDomainEdge('terminated', 'launched') && !isLegalDomainEdge('quarantined', 'launched'));
    assert.deepEqual(routeTo('review', 'cancelled'), ['cancelled']);
    assert.deepEqual(routeTo('replan', 'integrated'), ['claimed', 'executing', 'integrating', 'integrated']);
    assert.throws(() => routeTo('review', 'integrating'), /cannot reach/);
  });

  // ---- 6. store assertions -----------------------------------------------------

  const passes = (name, phase, opts, assertion) =>
    check(`witness: ${name}`, () => withStore((db, project) => assertion(db, witnessRun(db, project, phase, opts))));
  const fails = (name, phase, opts, assertion, message) =>
    check(`mutant fails: ${name}`, () =>
      withStore((db, project) => {
        const ids = witnessRun(db, project, phase, opts);
        assert.throws(() => assertion(db, ids), message, 'the assertion passed against a store with the defect it must catch');
      }),
    );

  const ended = (expect = {}) => (db, ids) => assertEndedRun(db, ids.run, expect);
  await passes('an ended, completed run', 'ended', {}, ended({ outcome: 'completed', reason_class: 'none', workspace: 'retained', launched: true, recovery: false }));
  await passes('an ended run with a correction row is still charged once', 'ended', { tweak: { withCorrection: true } }, ended({ launched: true }));
  await passes('a refused run that was never launched', 'ended', { outcome: 'refused', reason: 'preflight_refused', launched: false }, ended({ outcome: 'refused', launched: false }));
  await passes('an abandoned run with a discarded workspace', 'ended', { outcome: 'abandoned', reason: 'human_abandon', tweak: { workspaceDiscarded: true } }, (db, ids) => {
    db.prepare('UPDATE "workspaces" SET "disposed_at" = ? WHERE "id" = ?').run(isoNow(), ids.workspace);
    assertEndedRun(db, ids.run, { outcome: 'abandoned' });
  });
  await passes('a run ended by recovery records the incarnation', 'ended', { outcome: 'recovered', reason: 'recovered', tweak: { recovery: 'inc_X' } }, ended({ outcome: 'recovered', recovery: 'inc_X' }));
  await passes('a launch that could not be established is unknown and charged', 'ended', { outcome: 'recovered', reason: 'recovered', tweak: { statuses: ['dispatch_started', 'unknown'] } }, ended({ launched: true }));

  const ENDED_MUTANTS = [
    ['the run is still finalizing', { state: 'finalizing' }, {}, /state/],
    ['the outcome is not the expected one', {}, { outcome: 'stopped' }, /outcome/],
    ['the reason class does not belong to the outcome', { wrongReason: true }, {}, /reason class human_stop does not belong to outcome completed/],
    ['finished_at is missing', { noFinishedAt: true }, {}, /finished_at/],
    ['the run is still flagged quarantined', { flagged: true }, {}, /not quarantined/],
    ['a domain is still launched', { domainStatus: 'launched' }, {}, /is terminated/],
    ['no domain.terminated event', { noDomainEvent: true }, {}, /exactly one domain\.terminated/],
    ['two domain.terminated events', { twoDomainEvents: true }, {}, /exactly one domain\.terminated/],
    ['termination was never confirmed on the ownership row', { noConfirmedAt: true }, {}, /termination was confirmed/],
    ['the run lease is still held', { leaseHeld: true }, {}, /no unreleased lease/],
    ['a quarantine reservation is still held', { reservationHeld: true }, {}, /no unreleased lease/],
    ['the grant is still live', { grantLive: true }, {}, /is revoked/],
    ['the workspace is still active', { workspaceActive: true }, {}, /disposition/],
    ['the workspace was discarded though the run completed', { workspaceDiscarded: true }, {}, /disposition/],
    ['two terminal status observations', { twoTerminal: true }, {}, /exactly one terminal status observation/],
    ['a launched invocation also recorded refused', { refusedAndEnded: true }, {}, /terminal observation is the last|not both refused and ended/],
    ['no ledger row for a launched invocation', { noLedger: true }, {}, /exactly one original ledger row/],
    ['unknown usage recorded as zero', { zeroedUsage: true }, {}, /unknown, not zero/],
    ['unknown usage recorded as complete', { usageComplete: true }, {}, /unknown, not zero/],
    ['unknown cost recorded as measured zero', { measuredZero: true }, {}, /unknown, not zero/],
    ['no run.ended event', { noEndedEvent: true }, {}, /exactly one run\.ended/],
    ['two run.ended events', { twoEndedEvents: true }, {}, /exactly one run\.ended/],
    ['run.ended names another outcome', { eventOutcome: 'failed' }, {}, /names the outcome/],
    ['the run skipped finalizing', { skipFinalizing: true }, {}, /executing → ended is not a legal run transition/],
    ['ended by recovery when it should not have been', { recovery: 'inc_X' }, { recovery: false }, /not ended by recovery/],
    ['not recorded as ended by recovery', {}, { recovery: 'inc_X' }, /records the recovering incarnation/],
    ['recovered by another incarnation', { recovery: 'inc_Y' }, { recovery: 'inc_X' }, /records the recovering incarnation/],
    ['recorded as never launched though a launch was expected', { statuses: ['dispatch_started', 'refused'], noLedger: true }, { launched: true }, /recorded as ended or unknown, and charged/],
    ['recorded as launched though none was expected', {}, { launched: false }, /no invocation is recorded as launched/],
  ];
  for (const [name, tweak, expect, message] of ENDED_MUTANTS) await fails(`ended run: ${name}`, 'ended', { tweak }, ended(expect), message);
  await fails('ended run: a refused invocation was charged', 'ended', { outcome: 'refused', reason: 'preflight_refused', launched: false, tweak: { chargedRefusal: true } }, ended(), /no ledger row for an invocation that was never launched/);
  await fails('ended run: an invocation with neither refused nor a terminal observation', 'ended', { tweak: { statuses: ['dispatch_started'], noLedger: true } }, ended(), /recorded refused once/);

  const quarantined = (expect = {}) => (db, ids) => assertQuarantinedRun(db, ids.run, expect);
  await passes('a quarantined run', 'quarantined', { outcome: 'stopped', reason: 'human_stop' }, quarantined({ outcome: 'stopped' }));
  await passes('a quarantined run whose blocker was acknowledged', 'quarantined', { outcome: 'stopped', reason: 'human_stop', tweak: { blockerConsumed: true } }, quarantined({ blocker: 'any' }));
  const QUARANTINE_MUTANTS = [
    ['the run has ended', { state: 'ended' }, {}, /state/],
    ['the quarantined flag is not set', { notFlagged: true }, {}, /quarantined flag/],
    ['the recorded outcome changed', {}, { outcome: 'completed' }, /outcome/],
    ['the domain was marked terminated', { domainStatus: 'terminated' }, {}, /at least one domain is quarantined/],
    ['a domain.terminated event exists', { endedEvent: true, noEndedEvent: true }, {}, /no domain\.terminated event/],
    ['the workspace was retained', { workspaceRetained: true }, {}, /disposition/],
    ['the run lease is still execution authority', { runLeaseHeld: true }, {}, /only unreleased lease naming the run is its quarantine reservation/],
    ['there is no quarantine reservation', { noReservation: true }, {}, /only unreleased lease naming the run is its quarantine reservation/],
    ['no blocker decision', { noBlocker: true }, {}, /a blocker decision names the run/],
    ['the blocker is not open', { blockerConsumed: true }, {}, /its blocker is open/],
    ['no quarantine events', { noQuarantineEvents: true }, {}, /domain\.quarantined event/],
    ['a run.ended event exists', { endedEvent: true, noDomainEvent: true }, {}, /no run\.ended event/],
    ['the work item completed', { workComplete: true }, {}, /work item is not complete/],
  ];
  for (const [name, tweak, expect, message] of QUARANTINE_MUTANTS) {
    await fails(`quarantined run: ${name}`, 'quarantined', { outcome: 'stopped', reason: 'human_stop', tweak }, quarantined(expect), message);
  }

  const dispatched = (phase, expect = {}) => (db, ids) => assertDispatched(db, ids.run, phase, { incarnation: ids.incarnation, deadline_s: 3600, ...expect });
  await passes('a run before the spawn', 'before_spawn', {}, dispatched('before_spawn'));
  await passes('a launched run', 'launched', {}, dispatched('launched'));
  const DISPATCH_MUTANTS = [
    ['before_spawn', 'the pid is set before the spawn', { pidBeforeSpawn: true }, {}, /pid null before the spawn/],
    ['before_spawn', 'the lease is already closing', { leaseClosing: true }, {}, /not closing/],
    ['before_spawn', 'the run has another role than its work kind', { wrongRole: true }, {}, /role of a verification run/],
    ['before_spawn', 'the workspace has another base than the run', { workspaceOtherBase: true }, {}, /workspace base/],
    ['before_spawn', 'no dispatch_started observation', { statuses: [] }, {}, /status observations/],
    ['before_spawn', 'a ledger row before the run ended', { ledgerEarly: true }, {}, /no ledger row before the run ends/],
    ['before_spawn', 'the lease belongs to another incarnation', {}, { incarnation: 'inc_OTHER' }, /lease owner/],
    ['before_spawn', 'the deadline is not the role deadline', {}, { deadline_s: 1800 }, /deadline is 1800 s after creation/],
    ['before_spawn', 'the base is not the integration head', {}, { base: 'a'.repeat(40) }, /base revision/],
    ['launched', 'the run never reported started', { state: 'claimed' }, {}, /state/],
    ['launched', 'the child does not lead its own process group', { sharedGroup: true }, {}, /leads its own process group/],
    ['launched', 'the domain is still allocated', { domainStatus: 'allocated' }, {}, /domain status/],
  ];
  for (const [phase, name, tweak, expect, message] of DISPATCH_MUTANTS) await fails(`dispatched run: ${name}`, phase, { tweak }, dispatched(phase, expect), message);

  await check('witness: a recovered store with an ended and a quarantined run', () =>
    withStore((db, project) => {
      witnessRun(db, project, 'ended', { outcome: 'recovered', reason: 'recovered' });
      witnessRun(db, project, 'quarantined', { outcome: 'recovered', reason: 'recovered' });
      assert.equal(assertRecoveredStore(db).length, 2);
    }),
  );
  for (const [name, phase, tweak, message] of [
    ['a run is still executing', 'launched', {}, /after recovery every run is ended or quarantined/],
    ['a run lease is unreleased', 'ended', { leaseHeld: true }, /only quarantine reservations survive recovery/],
    ['a grant is live', 'ended', { grantLive: true }, /no grant is live/],
    ['a workspace is still active', 'ended', { workspaceActive: true }, /still active after recovery/],
    ['a domain is still launched', 'ended', { domainStatus: 'launched' }, /after recovery/],
  ]) {
    await fails(`recovered store: ${name}`, phase, { tweak }, (db) => assertRecoveredStore(db), message);
  }

  await check('work history: paths are rebuilt from events and checked against the table and the row', () =>
    withStore((db, project) => {
      const good = witnessWork(db, project, { kind: 'review', path: ['eligible', 'claimed', 'executing', 'held', 'eligible', 'claimed', 'executing', 'complete'] });
      assert.deepEqual(assertWorkHistory(db, good.id).slice(-2), ['executing', 'complete']);
      const integrates = witnessWork(db, project, { kind: 'review', path: ['eligible', 'claimed', 'executing', 'integrating'] });
      assert.throws(() => assertWorkHistory(db, integrates.id), /executing → integrating is not a legal review transition/);
      const stale = witnessWork(db, project, { kind: 'review', path: ['eligible', 'claimed'], rowStatus: 'executing' });
      assert.throws(() => assertWorkHistory(db, stale.id), /end at its row's status/);
      const gap = witnessWork(db, project, { kind: 'review', path: ['eligible', 'claimed'] });
      emit(db, 'work.advanced', { work_item: gap.id, project }, { from: 'executing', to: 'complete' });
      assert.throws(() => workPath(db, gap.id), /starts where the previous event ended/);
      assert.throws(() => workPath(db, newId('wi_')), /has work\.\* events/);
    }),
  );

  await check('run intervals: concurrency is read from run.created and run.ended in log order', () =>
    withStore((db, project) => {
      const other = newId('proj_');
      const created = (run, p = project) => emit(db, 'run.created', { run, project: p });
      const endedRun = (run, p = project) => emit(db, 'run.ended', { run, project: p }, { outcome: 'completed' });
      created('run_A');
      created('run_B', other);
      endedRun('run_A');
      created('run_C');
      endedRun('run_B', other);
      assert.equal(maxConcurrentRuns(db), 2);
      assert.equal(maxConcurrentRuns(db, { project }), 1);
      assertOneRunAtATime(db, project);
      assert.equal(runIntervals(db).find((i) => i.run === 'run_C').ended, null, 'a run that has not ended stays open');
      created('run_D');
      assert.equal(maxConcurrentRuns(db, { project }), 2, 'run_C never ended, so run_D overlaps it');
      assert.throws(() => assertOneRunAtATime(db, project), /more than one run/);
      assert.equal(maxConcurrentRuns(db), 2);
      assert.deepEqual(runPath(db, 'run_A'), ['created', 'ended']);
    }),
  );

  // ---- 7. the scripted role program ------------------------------------------------

  const REQUEST = { invocation: 'inv_X', domain: 'dom_X', run: 'run_X', project: 'proj_X', work_item: 'wi_X', work_kind: 'verification', role: 'verifier', workspace: '' };

  // Launch child.mjs the way SEAM.md §13 says the engine does.
  function launch(scripted, cwd, request = REQUEST, env = {}) {
    const child = spawn(process.execPath, [join(scripted.dir, 'child.mjs')], {
      cwd,
      detached: true,
      env: { PATH: process.env.PATH, SURETY_DOMAIN: request.domain, SURETY_INVOCATION: request.invocation, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = { lines: [], stderr: '' };
    let buffer = '';
    child.stdout.on('data', (c) => {
      buffer += c;
      const parts = buffer.split('\n');
      buffer = parts.pop();
      for (const line of parts) out.lines.push(JSON.parse(line));
    });
    child.stderr.on('data', (c) => (out.stderr += c));
    child.stdin.end(`${JSON.stringify({ ...request, workspace: cwd })}\n`);
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    return { child, out, exited };
  }
  const scriptedDir = (label) => {
    const root = mkdtempSync(join(work, `scripted-${label}-`));
    const ws = join(root, 'ws');
    mkdirSync(ws);
    return { scripted: new Scripted(join(root, 'dir')), ws };
  };

  await check('scripted child: a scripted launch writes, reports usage and a result, exits 0, and logs what it was', async () => {
    const { scripted, ws } = scriptedDir('complete');
    scripted.script('wi_X', [script.complete([step.write('out/note.txt', 'hello'), step.usage({ input_tokens: 12, output_tokens: 3 })]), script.crash(3)]);
    scripted.defaultScript(script.invalid({ summary: 'no status' }));
    const first = launch(scripted, ws, REQUEST, { SECRET_LIKE: 'value-to-hash' });
    assert.deepEqual(await first.exited, { code: 0, signal: null }, first.out.stderr);
    assert.deepEqual(first.out.lines, [
      { type: 'usage', semantics: 'cumulative', raw: { input_tokens: 12, output_tokens: 3 } },
      { type: 'result', result: VALID_RESULT },
    ]);
    assert.equal(readFileSync(join(ws, 'out', 'note.txt'), 'utf8'), 'hello');
    const [entry] = scripted.launches({ work_item: 'wi_X' });
    assert.equal(entry.pid, first.child.pid);
    assert.equal(entry.pgrp, first.child.pid, 'a detached child leads its own process group');
    assert.match(entry.start_time, /^\d+$/);
    assert.equal(entry.cwd, ws);
    assert.deepEqual([entry.invocation, entry.domain, entry.run, entry.project, entry.role, entry.work_kind], ['inv_X', 'dom_X', 'run_X', 'proj_X', 'verifier', 'verification']);
    assert.deepEqual(entry.env_keys, ['PATH', 'SECRET_LIKE', 'SURETY_DOMAIN', 'SURETY_INVOCATION']);
    const { createHash } = await import('node:crypto');
    assert.ok(entry.env_value_hashes.includes(createHash('sha256').update('value-to-hash').digest('hex')), 'values are hashed');
    assert.ok(!JSON.stringify(entry).includes('value-to-hash'), 'values are not logged');
    assert.deepEqual(entry.argv, []);
    assert.deepEqual([entry.launch_index, entry.script_source], [0, 'work_item']);
    assert.ok(scripted.eventsOf(entry.pid, 'exit').some((e) => e.code === 0));
    assert.equal(scripted.isLive(entry), false);

    // The second launch of the same work item follows its second script; the third has none and falls to the default.
    const second = launch(scripted, ws);
    assert.deepEqual(await second.exited, { code: 3, signal: null });
    assert.deepEqual(second.out.lines, [], 'a crash sends no result');
    const third = launch(scripted, ws);
    assert.deepEqual(await third.exited, { code: 0, signal: null });
    assert.deepEqual(third.out.lines, [{ type: 'result', result: { summary: 'no status' } }]);
    assert.deepEqual(scripted.launches({ work_item: 'wi_X' }).map((e) => [e.launch_index, e.script_source]), [[0, 'work_item'], [1, 'work_item'], [2, 'default']]);
    // Another work item counts its own launches.
    const other = launch(scripted, ws, { ...REQUEST, work_item: 'wi_Y', run: 'run_Y' });
    await other.exited;
    assert.deepEqual(scripted.launches({ run: 'run_Y' }).map((e) => [e.launch_index, e.script_source]), [[0, 'default']]);
  });

  await check('scripted child: a hold waits for its release, heartbeats meanwhile, and then goes on', async () => {
    const { scripted, ws } = scriptedDir('hold');
    scripted.script('wi_X', [script.holdThenComplete('gate', [step.usage({ input_tokens: 1 })])]);
    const run = launch(scripted, ws);
    const entry = await scripted.waitForHolding({ work_item: 'wi_X' }, 'gate');
    assert.equal(entry.pid, run.child.pid);
    assert.equal(scripted.isLive(entry), true);
    await sleep(1300);
    assert.ok(run.out.lines.some((l) => l.type === 'heartbeat'), 'a held role heartbeats');
    assert.ok(!run.out.lines.some((l) => l.type === 'result'), 'nothing completes before the release');
    scripted.release('wi_other', 'gate');
    scripted.release('wi_X', 'other-gate');
    await sleep(200);
    assert.equal(run.child.exitCode, null, 'a release for another key or another hold does not release this one');
    scripted.release('wi_X', 'gate');
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    assert.deepEqual(run.out.lines.at(-1), { type: 'result', result: VALID_RESULT });
  });

  await check('scripted child: with no script it holds until killed, and SIGTERM ends it by default', async () => {
    const { scripted, ws } = scriptedDir('unscripted');
    const run = launch(scripted, ws);
    const entry = await scripted.waitForHolding({ work_item: 'wi_X' }, 'unscripted');
    assert.equal(entry.script_source, 'unscripted');
    run.child.kill('SIGTERM');
    assert.deepEqual(await run.exited, { code: 143, signal: null });
    assert.ok(scripted.eventsOf(entry.pid, 'signal').length === 1);
  });

  await check('scripted child: SIGTERM can be ignored, or answered with a late success', async () => {
    const { scripted, ws } = scriptedDir('term');
    scripted.script('wi_X', [script.hold('gate', { on_term: 'ignore' }), script.hold('gate', { on_term: lateSuccess('exit') }), script.hold('gate', { on_term: lateSuccess('ignore') })]);
    const stubborn = launch(scripted, ws);
    const entry = await scripted.waitForHolding({ work_item: 'wi_X' }, 'gate');
    stubborn.child.kill('SIGTERM');
    await waitFor(() => scripted.eventsOf(entry.pid, 'signal').length === 1, { what: 'the signal to be logged' });
    await sleep(300);
    assert.equal(scripted.isLive(entry), true, 'an ignored SIGTERM leaves the role running');
    assert.deepEqual(scripted.killStrays(), [entry.pid]);
    assert.deepEqual(await stubborn.exited, { code: null, signal: 'SIGKILL' });
    assert.equal(scripted.isLive(entry), false);
    assert.deepEqual(scripted.killStrays(), [], 'nothing left to kill');

    const late = launch(scripted, ws);
    await waitFor(() => scripted.launches({ work_item: 'wi_X' }).length === 2 && scripted.eventsOf(late.child.pid, 'holding').length === 1, { what: 'the second launch to hold' });
    late.child.kill('SIGTERM');
    assert.deepEqual(await late.exited, { code: 0, signal: null });
    assert.deepEqual(late.out.lines.filter((l) => l.type === 'result'), [{ type: 'result', result: VALID_RESULT }], 'the late success is sent after SIGTERM');

    const lingering = launch(scripted, ws);
    await waitFor(() => scripted.eventsOf(lingering.child.pid, 'holding').length === 1, { what: 'the third launch to hold' });
    lingering.child.kill('SIGTERM');
    await waitFor(() => lingering.out.lines.some((l) => l.type === 'result'), { what: 'the late success' });
    await sleep(200);
    assert.equal(lingering.child.exitCode, null, 'it stays after its late success');
    lingering.child.kill('SIGKILL');
    await lingering.exited;
  });

  await check('scripted child: it outlives the reader of its output', async () => {
    const { scripted, ws } = scriptedDir('pipe');
    scripted.script('wi_X', [{ steps: [step.hold('gate', { heartbeat_ms: 50 }), step.result()] }]);
    const run = launch(scripted, ws);
    const entry = await scripted.waitForHolding({ work_item: 'wi_X' }, 'gate');
    run.child.stdout.destroy();
    run.child.stderr.destroy();
    await sleep(600);
    assert.equal(scripted.isLive(entry), true, 'a broken pipe does not end the role');
    scripted.release('all', 'gate');
    assert.deepEqual(await run.exited, { code: 0, signal: null });
  });

  await check('scripted child: no role outlives its test: strays are found before they have logged, and a child exits when its directory is removed', async () => {
    const { scripted, ws } = scriptedDir('strays');
    // Started, and still waiting for its request: nothing in the launch log yet.
    const silent = spawn(process.execPath, [join(scripted.dir, 'child.mjs')], { cwd: ws, detached: true, env: { PATH: process.env.PATH }, stdio: ['pipe', 'ignore', 'ignore'] });
    const gone = new Promise((resolve) => silent.once('exit', (code, signal) => resolve({ code, signal })));
    await waitFor(() => existsSync(`/proc/${silent.pid}/cmdline`) && readFileSync(`/proc/${silent.pid}/cmdline`, 'utf8').includes('child.mjs'), { what: 'the child to start' });
    assert.deepEqual(scripted.launches(), [], 'it has not logged a launch');
    assert.deepEqual(scripted.killStrays(), [silent.pid], 'it is found by its command line');
    assert.deepEqual(await gone, { code: null, signal: 'SIGKILL' });

    const orphan = launch(scripted, ws);
    const entry = await scripted.waitForHolding({ work_item: 'wi_X' }, 'unscripted');
    const { rmSync } = await import('node:fs');
    rmSync(scripted.dir, { recursive: true, force: true });
    assert.deepEqual(await orphan.exited, { code: 0, signal: null }, 'a held child exits once its scripted directory is gone');
    assert.equal(processIsLive(entry.pid, entry.start_time), false);
  });

  await check('scripted helper: boundary instructions are merged, validated and written whole; liveness needs the same start time', async () => {
    const { scripted } = scriptedDir('boundary');
    const file = join(scripted.dir, 'boundary.json');
    assert.equal(existsSync(file), false, 'no file means auto');
    scripted.boundary({ domains: { dom_A: BOUNDARY.unknown } });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { default: 'auto', domains: { dom_A: 'unknown' } });
    scripted.boundary({ default: BOUNDARY.running, domains: { dom_B: BOUNDARY.terminated } });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { default: 'running', domains: { dom_A: 'unknown', dom_B: 'terminated' } });
    assert.throws(() => scripted.boundary({ domains: { dom_C: 'gone' } }), /unknown boundary instruction/);
    assert.equal(existsSync(`${file}.tmp`), false);
    assert.deepEqual(scripted.flag, ['--harness-scripted', scripted.dir]);
    const { procStartTime } = await import('../proc.mjs');
    assert.equal(processIsLive(process.pid, procStartTime(process.pid)), true);
    assert.equal(processIsLive(process.pid, '1'), false, 'a reused pid is not the same process');
    assert.equal(processIsLive(2 ** 22 + 12345, '1'), false);
  });

  // ---- 8. HTTP helpers against a stand-in ------------------------------------------

  await check('run helpers: fixtures, ticks, Stop, answers, clock and allocation send what SEAM.md says', async () => {
    const home = mkdtempSync(join(work, 'home-s2-'));
    const port = await freePort();
    writeEngineConfig(home, { api_port: port });
    const engine = await startEngine({ home, port, cli: join(here, 'fake-engine.mjs'), args: ['--harness-scripted', '/nonexistent'] });
    try {
      const project = 'proj_FAKE';
      const first = await observeTrigger(engine, { project, kind: 'review', id: 't-1' });
      assert.deepEqual([first.status, first.created], [201, true]);
      const again = await observeTrigger(engine, { project, kind: 'review', id: 't-1' });
      assert.deepEqual([again.status, again.created, again.workItem], [200, false, first.workItem]);
      const next = await observeTrigger(engine, { project, kind: 'review', id: 't-1', generation: 2 });
      assert.notEqual(next.workItem, first.workItem);
      assert.equal((await observeTrigger(engine, { project, kind: 'deploy', id: 't-2' })).status, 501);
      const wi = await addWork(engine, project, 'verification', { depends_on: [first.workItem] });
      assert.notEqual(wi, first.workItem);

      await driveTo(engine, wi, ['claimed', 'executing']);
      assert.equal((await forceTransition(engine, wi, 'integrating')).status, 409);
      await assert.rejects(driveTo(engine, wi, ['integrating']), /legal step to integrating/);

      const countTicks = () => {
        const db = new Database(join(home, 'store.db'), { readonly: true });
        try {
          return db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'engine.tick'`).get().n;
        } finally {
          db.close();
        }
      };
      const before = countTicks();
      await tick(engine, [project]);
      assert.ok(countTicks() >= before + 2, 'tick() returns only after two ticks finished, so one of them started after the call');

      const stopped = await stopRun(engine, project, 'run_FAKE');
      assert.match(stopped.decision, /^dec_/);
      await assert.rejects(stopRun(engine, project, 'run_ENDED'), /without a preview hash/);
      await answerDecision(engine, project, stopped.decision, 'acknowledge');
      await assert.rejects(answerDecision(engine, project, stopped.decision, 'retry'), /offers "retry"/);
      assert.match((await advanceClock(engine, 1801)).body.now, /^\d{4}-/);
      assert.equal(await allocate(engine, 'run_FAKE'), await allocate(engine, 'run_FAKE'));
    } finally {
      await engine.kill();
    }
  });
}
