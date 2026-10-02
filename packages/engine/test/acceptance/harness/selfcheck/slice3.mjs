// Slice-3 part of the harness self-check (see run.mjs). As in slice2.mjs,
// each helper with logic is run against something that exists:
//
//  10. the run-end fault matrix (../endings.mjs): the cells generated from the
//      contract table, the facts taken from a store, and the expectations
//      checked on them, against witness stores and one mutant per fact;
//  11. the role program's slice-3 steps (../scripted/child.mjs), launched for
//      real: file steps, git, a long line, a descendant that chatters, and an
//      exit that drops nothing however slowly its output is read.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { ENDINGS, RUN_END_FAULTS, STAGES, VOLATILE_EVENTS, assertEndingExpectations, matrixCells, projectFacts } from '../endings.mjs';
import { waitFor } from '../engine.mjs';
import { isoNow, newId } from '../ids.mjs';
import { RESULT_LINE, Scripted, step } from '../scripted.mjs';
import { emit, witnessRun } from './witness-state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WITNESS = readFileSync(join(here, 'witness-schema.sql'), 'utf8') + readFileSync(join(here, 'witness-slice2.sql'), 'utf8');

export async function slice3Checks(check, work) {
  let n = 0;
  const withStore = (fn) => {
    const db = new Database(join(work, `s3-store-${++n}.db`));
    db.pragma('foreign_keys = ON');
    db.exec(WITNESS);
    const project = newId('proj_');
    db.prepare('INSERT INTO projects (id, created_at, name) VALUES (?, ?, ?)').run(project, isoNow(), 'selfcheck');
    try {
      return fn(db, project);
    } finally {
      db.close();
    }
  };

  // ---- 10. the run-end fault matrix -------------------------------------------------

  await check('matrix: one cell per ending and transaction, each naming its event and stage', () => {
    const cells = matrixCells();
    assert.equal(cells.length, Object.values(ENDINGS).reduce((sum, e) => sum + e.faults.length, 0));
    assert.equal(new Set(cells.map((c) => `${c.ending}|${c.fault.stage}|${c.fault.event_type}`)).size, cells.length, 'no cell twice');
    assert.deepEqual(Object.keys(ENDINGS).sort(), [
      'abandon_claimed',
      'abandon_executing',
      'deadline',
      'invalid_result',
      'lease_expiry',
      'preflight_refused',
      'quarantine_cleared',
      'role_completes',
      'stop_claimed',
      'stop_executing',
    ]);
    for (const cell of cells) {
      assert.ok(STAGES.includes(cell.fault.stage), `${cell.ending}: stage ${cell.fault.stage}`);
      assert.match(cell.fault.event_type, /^[a-z_]+\.[a-z_]+$/);
      assert.ok(typeof cell.fault.what === 'string' && cell.fault.what.startsWith('the transaction that '), `${cell.ending}: ${cell.fault.what}`);
      assert.ok(!VOLATILE_EVENTS.includes(cell.fault.event_type), 'a cell never names an event the comparison leaves out');
    }
    // A fault with no stage is armed before the end; only the quarantine ending has a second stage.
    assert.ok(cells.filter((c) => c.fault.stage === 'quarantined').every((c) => c.ending === 'quarantine_cleared'));
    assert.ok(cells.some((c) => c.ending === 'quarantine_cleared' && c.fault.stage === 'quarantined' && c.fault.event_type === 'run.ended'));
    // The two cells the final slice-2 review named are in the table.
    assert.ok(cells.some((c) => c.ending === 'abandon_executing' && c.fault.event_type === 'git.journal_applied'));
    assert.ok(cells.some((c) => c.ending === 'stop_claimed' && c.fault.event_type === 'run.ended'));
    const mutated = { endings: { only: { title: 't', faults: [{ event_type: 'run.ended', what: 'x' }, { event_type: 'run.ended', stage: 'quarantined', what: 'y' }] } } };
    assert.deepEqual(matrixCells(mutated).map((c) => c.fault.stage), ['before_end', 'quarantined'], 'the default stage is before_end');
    assert.ok(RUN_END_FAULTS.retry.rounds >= 2 && RUN_END_FAULTS.retry.wait_ms >= 1000);
  });

  // A store holding the history of one ending: the ending's own run and the
  // project's next item, both ended, as witness-state.mjs writes them.
  const onDisk = { exists: true, registered: true };
  const history = (db, project, tweak = {}, opts = {}) => {
    const first = witnessRun(db, project, 'ended', { tweak, ...opts });
    const next = witnessRun(db, project, 'ended', { kind: 'review' });
    return { first, next };
  };
  const factsOfHistory = (tweak, opts, disk = () => onDisk) =>
    withStore((db, project) => {
      history(db, project, tweak, opts);
      return projectFacts(db, project, disk);
    });

  await check('matrix facts: two stores with the same history give the same facts, whatever their ids and timestamps', () => {
    const a = factsOfHistory();
    const b = factsOfHistory();
    assert.deepEqual(a, b);
    const text = JSON.stringify(a);
    for (const prefix of ['run_', 'wi_', 'inv_', 'dom_', 'lease_', 'grant_', 'ws_', 'op_', 'dec_']) assert.ok(!new RegExp(`"${prefix}[0-9A-Z]{26}"`).test(text), `no ${prefix} id in the facts`);
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), 'no timestamp in the facts');
    assert.equal(a.runs.length, 2);
    assert.deepEqual(a.runs.map((r) => r.work), [0, 1], 'a run names its work item by position');
    assert.deepEqual(a.work.map((w) => w.path), [['eligible', 'claimed', 'executing', 'complete'], ['eligible', 'claimed', 'executing', 'complete']]);
    assert.deepEqual(a.runs[0].receipts[0].statuses, ['dispatch_started', 'launched', 'ended']);
    assert.equal(a.events['run.ended'], 2);
  });

  await check('matrix facts: events that say nothing about an ending are left out, every other event counts', () => {
    const base = factsOfHistory();
    const noisy = withStore((db, project) => {
      const { first } = history(db, project);
      for (const type of VOLATILE_EVENTS) for (let i = 0; i < 3; i++) emit(db, type, { run: first.run, project });
      return projectFacts(db, project, () => onDisk);
    });
    assert.deepEqual(noisy, base, 'heartbeats, ticks and audit events do not change the facts');
    const extra = withStore((db, project) => {
      const { first } = history(db, project);
      emit(db, 'invocation.status', { run: first.run, project });
      return projectFacts(db, project, () => onDisk);
    });
    assert.notDeepEqual(extra, base, 'one more event of any other type does');
  });

  const FACT_MUTANTS = [
    ['a grant left live', { grantLive: true }],
    ['a lease left unreleased', { leaseHeld: true }],
    ['a second terminal observation', { twoTerminal: true }],
    ['no ledger row', { noLedger: true }],
    ['a ledger row that reports zero for unknown usage', { zeroedUsage: true }],
    ['a second run.ended event', { twoEndedEvents: true }],
    ['a second domain.terminated event', { twoDomainEvents: true }],
    ['termination not confirmed on the ownership row', { noConfirmedAt: true }],
    ['a workspace recorded as discarded', { workspaceDiscarded: true }],
    ['another reason class', { wrongReason: true }],
    ['a quarantine reservation left behind', { reservationHeld: true }],
  ];
  for (const [name, tweak] of FACT_MUTANTS) {
    await check(`matrix facts mutant differs: ${name}`, () => {
      assert.notDeepEqual(factsOfHistory(tweak), factsOfHistory(), 'the facts of a store with this defect equal those of a store without it');
    });
  }
  await check('matrix facts mutant differs: a workspace gone from disk, or no longer a worktree', () => {
    assert.notDeepEqual(factsOfHistory({}, {}, () => ({ exists: false, registered: true })), factsOfHistory());
    assert.notDeepEqual(factsOfHistory({}, {}, () => ({ exists: true, registered: false })), factsOfHistory());
  });
  await check('matrix facts mutant differs: an operation of the run with another status, or one more operation', () => {
    const withOperation = (status, count = 1) =>
      withStore((db, project) => {
        const { first } = history(db, project);
        for (let i = 0; i < count; i++) {
          const op = newId('op_');
          db.prepare(
            `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, deadline_at, finalized_at) VALUES (?, ?, ?, ?, 'git_worktree', '{}', '{}', ?, 1, ?, ?, ?)`,
          ).run(op, isoNow(), project, i + 1, `key-${i}`, status, isoNow(), status === 'succeeded' ? isoNow() : null);
          const kinds = status === 'succeeded' ? ['intended', 'applied', 'confirmed', 'finalized'] : ['intended'];
          kinds.forEach((eventKind, seq) =>
            db
              .prepare(`INSERT INTO git_journal_events (id, created_at, project, operation, seq, journal_kind, event_kind, payload) VALUES (?, ?, ?, ?, ?, 'worktree_remove', ?, ?)`)
              .run(newId('gje_'), isoNow(), project, op, seq + 1, eventKind, JSON.stringify({ repo: 'dev', run: first.run })),
          );
        }
        return projectFacts(db, project, () => onDisk);
      });
    const settled = withOperation('succeeded');
    assert.deepEqual(settled.runs[0].operations, [{ kind: 'git_worktree', journal_kind: 'worktree_remove', status: 'succeeded', finalized: true, journal_state: 'finalized' }]);
    assert.deepEqual(withOperation('succeeded'), settled);
    assert.notDeepEqual(withOperation('intended'), settled, 'an operation left intended');
    assert.notDeepEqual(withOperation('succeeded', 2), settled, 'a second operation for the same removal');
  });

  await check('matrix expectations: the facts of a completed run pass what the table says of "a role completes"', () => {
    assertEndingExpectations(factsOfHistory(), ENDINGS.role_completes, 'witness');
  });
  const EXPECTATION_MUTANTS = [
    ['another outcome', {}, { outcome: 'failed', reason: 'infra_error' }, /the run's end/],
    ['a grant left live', { grantLive: true }, {}, /grant is revoked/],
    ['a lease left unreleased', { leaseHeld: true }, {}, /no lease naming the run is unreleased/],
    ['a second run.ended event', { twoEndedEvents: true }, {}, /exactly one run\.ended/],
    ['a second terminal observation', { twoTerminal: true }, {}, /terminal observation/],
    ['no ledger row for a launched invocation', { noLedger: true }, {}, /exactly one original ledger row/],
    ['a workspace recorded as discarded', { workspaceDiscarded: true }, {}, /workspace's disposition/],
    ['a domain left launched', { domainStatus: 'launched' }, {}, /every domain is terminated/],
  ];
  for (const [name, tweak, opts, message] of EXPECTATION_MUTANTS) {
    await check(`matrix expectations mutant fails: ${name}`, () => {
      assert.throws(() => assertEndingExpectations(factsOfHistory(tweak, opts), ENDINGS.role_completes, 'witness'), message);
    });
  }
  await check('matrix expectations mutant fails: a work item with another status, counter or number of runs', () => {
    for (const [field, value] of [['status', 'executing'], ['repair_attempts', 1], ['preflight_refusals', 1], ['dispatch_hold', 1], ['blocker', 'deadline']]) {
      const facts = factsOfHistory();
      facts.work[0][field] = value;
      assert.throws(() => assertEndingExpectations(facts, ENDINGS.role_completes, 'witness'), /the work item once the project has gone on/, field);
    }
    const twice = withStore((db, project) => {
      history(db, project);
      const facts = projectFacts(db, project, () => onDisk);
      facts.runs.push({ ...facts.runs[0] }); // a second run of the first item
      return facts;
    });
    assert.throws(() => assertEndingExpectations(twice, ENDINGS.role_completes, 'witness'), /the work item once the project has gone on/);
  });
  await check('matrix expectations: a never-launched invocation must be recorded refused once and not charged', () => {
    const refused = factsOfHistory({}, { outcome: 'stopped', reason: 'human_stop', launched: false });
    const spec = { ...ENDINGS.stop_claimed, expect: { ...ENDINGS.stop_claimed.expect, work: { ...ENDINGS.stop_claimed.expect.work, status: 'complete' } } };
    assertEndingExpectations(refused, spec, 'witness');
    // What the slice-2 engine wrote after a failed run.ended: an unknown end and a charge, for an invocation that never ran.
    const charged = factsOfHistory({ statuses: ['dispatch_started', 'unknown'], ledgerEarly: true }, { outcome: 'stopped', reason: 'human_stop', launched: false });
    assert.throws(() => assertEndingExpectations(charged, spec, 'witness'), /never launched is recorded refused once and is not charged/);
    assert.throws(() => assertEndingExpectations(factsOfHistory({ chargedRefusal: true }, { outcome: 'stopped', reason: 'human_stop', launched: false }), spec, 'witness'), /never launched/);
  });
  await check('matrix expectations: the next item of the project must have got where the table says', () => {
    const facts = factsOfHistory();
    facts.work[1].status = 'eligible';
    assert.throws(() => assertEndingExpectations(facts, ENDINGS.role_completes, 'witness'), /next item/);
  });

  // ---- 11. the role program's slice-3 steps -------------------------------------------

  const REQUEST = { invocation: 'inv_X', domain: 'dom_X', run: 'run_X', project: 'proj_X', work_item: 'wi_X', work_kind: 'stage_build', role: 'builder', workspace: '' };
  // Launch child.mjs as the engine does. `read` false leaves its stdout unread until `startReading()` is called.
  function launch(scripted, cwd, { read = true } = {}) {
    const child = spawn(process.execPath, [join(scripted.dir, 'child.mjs')], {
      cwd,
      detached: true,
      env: { PATH: process.env.PATH, SURETY_DOMAIN: REQUEST.domain, SURETY_INVOCATION: REQUEST.invocation },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const out = { bytes: 0, tail: '' };
    const onData = (c) => {
      out.bytes += c.length;
      out.tail = (out.tail + c.toString('latin1')).slice(-400);
    };
    const startReading = () => child.stdout.on('data', onData);
    if (read) startReading();
    child.stdin.end(`${JSON.stringify({ ...REQUEST, workspace: cwd })}\n`);
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    return { child, out, exited, startReading };
  }
  const scriptedDir = (label) => {
    const root = mkdtempSync(join(work, `s3-scripted-${label}-`));
    const ws = join(root, 'ws');
    mkdirSync(ws);
    return { scripted: new Scripted(join(root, 'dir')), ws, root };
  };

  await check('scripted child: file steps write, fill, delete, rename and link, inside the workspace and outside it', async () => {
    const { scripted, ws, root } = scriptedDir('files');
    writeFileSync(join(ws, 'old.txt'), 'old');
    writeFileSync(join(ws, 'doomed.txt'), 'x');
    mkdirSync(join(ws, 'dir'));
    writeFileSync(join(ws, 'dir', 'inner.txt'), 'x');
    const outside = join(root, 'outside.txt');
    scripted.script('wi_X', [
      {
        steps: [
          step.write('src/new.txt', 'new'),
          step.writeFill('big.bin', 3000),
          step.delete('doomed.txt'),
          step.delete('dir'),
          step.rename('old.txt', 'moved/renamed.txt'),
          step.symlink('link-out', '../outside.txt'),
          step.symlink('nested/link-in', '../src/new.txt'),
          step.write(outside, 'written through an absolute path'),
          step.result(),
        ],
      },
    ]);
    const run = launch(scripted, ws);
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    assert.equal(readFileSync(join(ws, 'src', 'new.txt'), 'utf8'), 'new');
    assert.equal(statSync(join(ws, 'big.bin')).size, 3000);
    assert.ok(!existsSync(join(ws, 'doomed.txt')) && !existsSync(join(ws, 'dir')), 'a file and a whole directory are deleted');
    assert.ok(!existsSync(join(ws, 'old.txt')));
    assert.equal(readFileSync(join(ws, 'moved', 'renamed.txt'), 'utf8'), 'old');
    assert.ok(lstatSync(join(ws, 'link-out')).isSymbolicLink());
    assert.equal(readlinkSync(join(ws, 'link-out')), '../outside.txt', 'a link target is written as given');
    assert.equal(readFileSync(join(ws, 'nested', 'link-in'), 'utf8'), 'new');
    assert.equal(readFileSync(outside, 'utf8'), 'written through an absolute path', 'an absolute path reaches outside the workspace');
    assert.ok(run.out.tail.includes(RESULT_LINE));
  });

  await check('scripted child: a git step runs git in the workspace, logs its outcome and never stops the script', async () => {
    const { scripted, ws } = scriptedDir('git');
    execFileSync('git', ['init', '-q', '-b', 'main', ws], { env: { PATH: process.env.PATH, HOME: ws, GIT_CONFIG_NOSYSTEM: '1' } });
    writeFileSync(join(ws, 'a.txt'), 'a');
    scripted.script('wi_X', [{ steps: [step.git('add', 'a.txt'), step.git('config', 'surety.test', 'set-by-role'), step.git('no-such-command'), step.result()] }]);
    const run = launch(scripted, ws);
    assert.deepEqual(await run.exited, { code: 0, signal: null }, 'a failing git step does not stop the script');
    const env = { PATH: process.env.PATH, HOME: ws, GIT_CONFIG_NOSYSTEM: '1' };
    assert.equal(execFileSync('git', ['-C', ws, 'ls-files'], { env, encoding: 'utf8' }).trim(), 'a.txt', 'git add reached the real index');
    assert.equal(execFileSync('git', ['-C', ws, 'config', 'surety.test'], { env, encoding: 'utf8' }).trim(), 'set-by-role');
    const logged = scripted.log().filter((e) => e.event === 'git');
    assert.deepEqual(logged.map((e) => [e.args[0], e.status === 0]), [['add', true], ['config', true], ['no-such-command', false]]);
    assert.ok(run.out.tail.includes(RESULT_LINE));
  });

  await check('scripted child: nothing it wrote is dropped by its exit, however late its output is read', async () => {
    const { scripted, ws } = scriptedDir('drain');
    const bytes = 6 * 1024 * 1024;
    scripted.script('wi_X', [{ steps: [step.stdoutFill(bytes), step.stdout('\n'), step.result()] }]);
    // The reader does nothing for two seconds: longer than the half second
    // after which the program used to leave whatever was still unwritten.
    const run = launch(scripted, ws, { read: false });
    const [entry] = await scripted.waitForLaunch({ work_item: 'wi_X' });
    await waitFor(() => scripted.eventsOf(entry.pid, 'exit').length === 1, { what: 'the program to reach its exit' });
    await sleep(2000);
    assert.equal(scripted.isLive(entry), true, 'the program has not left while its output is unread');
    run.startReading();
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    await sleep(100);
    assert.equal(run.out.bytes, bytes + 1 + RESULT_LINE.length + 1, 'every byte it wrote arrived');
    assert.ok(run.out.tail.endsWith(`${RESULT_LINE}\n`), 'the result after the long line is the last thing read');
  });

  await check('scripted child: with its reader gone, the program still leaves', async () => {
    const { scripted, ws } = scriptedDir('gone');
    scripted.script('wi_X', [{ steps: [step.stdoutFill(4 * 1024 * 1024), step.result()] }]);
    const run = launch(scripted, ws, { read: false });
    const [entry] = await scripted.waitForLaunch({ work_item: 'wi_X' });
    await waitFor(() => scripted.eventsOf(entry.pid, 'exit').length === 1, { what: 'the program to reach its exit' });
    run.child.stdout.destroy(); // the engine stops reading and closes its end
    const status = await Promise.race([run.exited, sleep(5000).then(() => null)]);
    assert.ok(status !== null, 'a program whose output can no longer be written leaves instead of waiting for ever');
  });

  await check('scripted child: a descendant with chatter_ms keeps writing lines that are no protocol lines', async () => {
    const { scripted, ws } = scriptedDir('chatter');
    scripted.script('wi_X', [{ steps: [step.result(), step.descendant({ holds_stdout: true, on_term: 'exit', chatter_ms: 50 })] }]);
    const run = launch(scripted, ws);
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    const [descendant] = scripted.descendants();
    assert.ok(descendant && scripted.isLive(descendant), 'the descendant outlives the role');
    const before = run.out.bytes;
    await sleep(400);
    assert.ok(run.out.bytes > before, 'it goes on writing after the role has exited');
    assert.ok(run.out.tail.includes('descendant chatter\n'));
    assert.throws(() => JSON.parse('descendant chatter'), 'its lines are not protocol lines');
    process.kill(descendant.pid, 'SIGTERM');
    await waitFor(() => !scripted.isLive(descendant), { timeoutMs: 5000, what: 'the descendant to end on SIGTERM' });
  });
}
