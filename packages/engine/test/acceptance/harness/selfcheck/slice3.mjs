// Slice-3 part of the harness self-check (see run.mjs). As in slice2.mjs,
// each helper with logic is run against something that exists:
//
//  10. the run-end fault matrix (../endings.mjs): the cells generated from the
//      contract table, the facts taken from a store, and the expectations
//      checked on them, against witness stores and one mutant per fact;
//  11. the role program's slice-3 steps (../scripted/child.mjs), launched for
//      real: file steps, git, a long line, a descendant that chatters, and an
//      exit that drops nothing however slowly its output is read;
//  12. the repository fixtures and readers (../repos.mjs) against real git:
//      topologies, plumbing commits, what a checkout and a repository hold,
//      the independent snapshot tree, the planted programs (each shown to be
//      run by ordinary git), an unreadable repository, held git calls;
//  13. the journal and registry reads (../journal.mjs) against witness stores,
//      and the contract tables they are generated from.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { ENDINGS, RUN_END_FAULTS, STAGES, VOLATILE_EVENTS, assertEndingExpectations, matrixCells, projectFacts } from '../endings.mjs';
import { waitFor } from '../engine.mjs';
import { git as plainGit } from '../git.mjs';
import { isoNow, newId } from '../ids.mjs';
import { JOURNAL, VALIDATION, assertOrdinaryCourse, journalBarrier, journalBarriers, operationsOf, outOfBand, registryOf, revisionsOf } from '../journal.mjs';
import {
  ALL_HOOKS,
  HOSTILE_IDENTITIES,
  addLinkedWorktree,
  changedPaths,
  checkoutState,
  commitOnRef,
  fileAt,
  gitQuiet,
  holdGit,
  hostileEnvironment,
  isAncestor,
  listTree,
  makeProjectRepo,
  makeUnreadable,
  parentsOf,
  plantAllHooks,
  plantConfiguredPrograms,
  plantFilter,
  readEvidence,
  refOid,
  refsContaining,
  refsOf,
  repoFingerprint,
  snapshotTree,
  trailersOf,
  treeOf,
} from '../repos.mjs';
import { WORK, roleOf } from '../transitions.mjs';
import { RESULT_LINE, Scripted, step } from '../scripted.mjs';
import { emit, witnessRun } from './witness-state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WITNESS = readFileSync(join(here, 'witness-schema.sql'), 'utf8') + readFileSync(join(here, 'witness-slice2.sql'), 'utf8');
const WITNESS3 = `${WITNESS}ALTER TABLE projects ADD COLUMN tier TEXT; ALTER TABLE projects ADD COLUMN dev_repo_path TEXT; ALTER TABLE projects ADD COLUMN integration_branch TEXT;${readFileSync(join(here, 'witness-slice3.sql'), 'utf8')}`;

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

  // ---- 12. repository fixtures and readers -----------------------------------------------

  let repos = 0;
  const repoDir = (label) => join(mkdtempSync(join(work, `s3-repo-${++repos}-`)), label);

  await check('repos: the three topologies leave the integration branch detached from, beside, or in the developer\'s work tree', () => {
    const detached = makeProjectRepo(repoDir('detached'), { files: { 'src/a.txt': 'a\n' } });
    assert.deepEqual([checkoutState(detached.path).branch, checkoutState(detached.path).head, refOid(detached.path, 'refs/heads/main')], [null, detached.head, detached.head]);
    assert.equal(detached.ref, 'refs/heads/main');
    assert.deepEqual(Object.keys(listTree(detached.path, detached.head)).sort(), ['README.md', 'src/a.txt']);
    const other = makeProjectRepo(repoDir('other'), { primary: 'other' });
    assert.equal(checkoutState(other.path).branch, 'refs/heads/dev/work');
    const integration = makeProjectRepo(repoDir('integration'), { primary: 'integration', branch: 'trunk' });
    assert.equal(checkoutState(integration.path).branch, 'refs/heads/trunk');
    assert.throws(() => makeProjectRepo(repoDir('bad'), { primary: 'nonsense' }), /unknown primary checkout/);
    // Linked worktrees: detached, on a new branch, on an existing branch.
    const linkedDetached = addLinkedWorktree(detached.path, repoDir('ld'));
    const onNew = addLinkedWorktree(detached.path, repoDir('ln'), { branch: 'feature/x' });
    const onMain = addLinkedWorktree(detached.path, repoDir('lm'), { branch: 'main' });
    assert.deepEqual([checkoutState(linkedDetached).branch, checkoutState(onNew).branch, checkoutState(onMain).branch], [null, 'refs/heads/feature/x', 'refs/heads/main']);
  });

  await check('repos: a plumbing commit moves a ref without touching any checkout, and the readers see exactly what it changed', () => {
    const repo = makeProjectRepo(repoDir('plumbing'), { primary: 'integration', files: { 'keep.txt': 'keep\n' } });
    const before = checkoutState(repo.path);
    const sha = commitOnRef(repo.path, 'refs/heads/main', { 'new/file.txt': 'new\n', 'README.md': '# changed\n' }, { message: 'a commit\n\nSurety-Run: run_X\nSurety-Role: builder\n' });
    assert.equal(refOid(repo.path, 'refs/heads/main'), sha);
    assert.deepEqual(parentsOf(repo.path, sha), [repo.head]);
    assert.deepEqual(changedPaths(repo.path, repo.head, sha), { 'new/file.txt': 'A', 'README.md': 'M' });
    assert.equal(fileAt(repo.path, sha, 'new/file.txt'), 'new\n');
    assert.equal(treeOf(repo.path, sha), gitQuiet(repo.path, ['rev-parse', `${sha}^{tree}`]));
    assert.deepEqual(trailersOf(repo.path, sha), { 'Surety-Run': ['run_X'], 'Surety-Role': ['builder'] });
    assert.ok(isAncestor(repo.path, repo.head, sha) && !isAncestor(repo.path, sha, repo.head));
    assert.deepEqual(refsContaining(repo.path, sha), ['refs/heads/main']);
    const after = checkoutState(repo.path);
    assert.deepEqual([after.files, after.index, after.branch], [before.files, before.index, before.branch], 'the work tree, the index and the files are untouched');
    // The branch moved under a checkout of it, so the checkout now differs from its HEAD:
    // what build spec §6 correction 6 is about, and why checkoutState reports `staged`.
    assert.equal(after.head, sha);
    assert.notEqual(after.staged, before.staged, 'a checkout whose branch was moved under it looks dirty');
    // A commit with no ref, and one on a new ref with an explicit parent.
    const loose = commitOnRef(repo.path, null, { 'x.txt': 'x\n' }, { parent: repo.head });
    assert.deepEqual(refsContaining(repo.path, loose), []);
    assert.equal(refOid(repo.path, 'refs/heads/no-such'), null);
    assert.deepEqual(refsOf(repo.path), { 'refs/heads/main': sha });
    // A duplicated trailer is reported twice.
    const forged = commitOnRef(repo.path, null, {}, { parent: sha, message: 's\n\nSurety-Run: a\nSurety-Run: b\n' });
    assert.deepEqual(trailersOf(repo.path, forged)['Surety-Run'], ['a', 'b']);
  });

  await check('repos: checkoutState and repoFingerprint change with what they are meant to see, and with nothing else', () => {
    const repo = makeProjectRepo(repoDir('state'), { primary: 'integration', files: { 'a.txt': 'a\n' } });
    const clean = checkoutState(repo.path);
    const print = repoFingerprint(repo.path);
    assert.deepEqual(checkoutState(repo.path), clean, 'reading it twice changes nothing');
    writeFileSync(join(repo.path, 'a.txt'), 'edited\n');
    const edited = checkoutState(repo.path);
    assert.notDeepEqual(edited.files, clean.files);
    assert.deepEqual([edited.head, edited.index, edited.staged], [clean.head, clean.index, ''], 'an unstaged edit changes the files and nothing else');
    gitQuiet(repo.path, ['add', 'a.txt']);
    assert.equal(checkoutState(repo.path).staged, 'M\ta.txt');
    assert.notEqual(checkoutState(repo.path).index, clean.index);
    writeFileSync(join(repo.path, 'untracked.txt'), 'u\n');
    symlinkSync('a.txt', join(repo.path, 'link'));
    assert.deepEqual([checkoutState(repo.path).files.link, 'untracked.txt' in checkoutState(repo.path).files], ['link a.txt', true]);
    assert.deepEqual(repoFingerprint(repo.path), print, 'none of that is a change to the repository: its refs, worktrees, configuration and hooks');
    gitQuiet(repo.path, ['config', 'x.y', 'z']);
    assert.notEqual(repoFingerprint(repo.path).config, print.config);
    writeFileSync(join(repo.path, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
    assert.notDeepEqual(repoFingerprint(repo.path).hooks, print.hooks);
    gitQuiet(repo.path, ['update-ref', 'refs/heads/other', clean.head]);
    assert.notDeepEqual(repoFingerprint(repo.path).refs, print.refs);
  });

  await check('repos: the snapshot tree is what add -A takes from the work tree, started from the base, and leaves the real index alone', () => {
    const repo = makeProjectRepo(repoDir('snapshot'), { files: { 'gone.txt': 'x\n', 'stay.txt': 's\n', '.gitignore': 'ignored/\n' } });
    const ws = addLinkedWorktree(repo.path, repoDir('ws'));
    assert.equal(snapshotTree(ws, repo.head), treeOf(repo.path, repo.head), 'an untouched workspace snapshots to its base tree');
    writeFileSync(join(ws, 'new.txt'), 'n\n');
    rmSync(join(ws, 'gone.txt'));
    mkdirSync(join(ws, 'ignored'));
    writeFileSync(join(ws, 'ignored', 'scratch.txt'), 'i\n');
    symlinkSync('stay.txt', join(ws, 'link'));
    const before = checkoutState(ws);
    const tree = snapshotTree(ws, repo.head);
    const entries = listTree(repo.path, tree);
    assert.deepEqual(Object.keys(entries).sort(), ['.gitignore', 'README.md', 'link', 'new.txt', 'stay.txt'], 'new and deleted files and links are taken; ignored ones are not');
    assert.match(entries.link, /^120000 blob /);
    assert.deepEqual(changedPaths(repo.path, repo.head, tree), { 'gone.txt': 'D', link: 'A', 'new.txt': 'A' });
    assert.deepEqual({ index: checkoutState(ws).index, staged: checkoutState(ws).staged, head: checkoutState(ws).head }, { index: before.index, staged: before.staged, head: before.head }, "the workspace's own index and HEAD are not touched");
    assert.equal(snapshotTree(ws, repo.head), tree, 'the same content gives the same tree');
    // A staged change in the real index does not leak into the snapshot's own index.
    writeFileSync(join(ws, 'staged-only.txt'), 's\n');
    gitQuiet(ws, ['add', 'staged-only.txt']);
    rmSync(join(ws, 'staged-only.txt'));
    assert.equal(snapshotTree(ws, repo.head), tree, 'what is staged and no longer in the work tree is not in the snapshot');
  });

  await check('repos: the planted hooks, filter and configured programs are run by ordinary git, and the quiet reader runs none of them', () => {
    const repo = makeProjectRepo(repoDir('planted'));
    const dir = join(repo.path, '..', 'planted');
    const evidence = join(dir, 'evidence.txt');
    mkdirSync(dir, { recursive: true });
    plantAllHooks(repo.path, evidence);
    assert.equal(ALL_HOOKS.length, new Set(ALL_HOOKS).size);
    plainGit(repo.path, ['update-ref', 'refs/heads/probe', 'HEAD']);
    assert.match(readEvidence(evidence), /hook reference-transaction ran/);
    rmSync(evidence);
    gitQuiet(repo.path, ['update-ref', 'refs/heads/probe2', 'HEAD']);
    assert.equal(readEvidence(evidence), null, 'gitQuiet runs no hook');

    const filter = plantFilter(repo.path, 'refs/heads/main', evidence, { dir });
    assert.deepEqual(Object.keys(changedPaths(repo.path, repo.head, filter.commit)).sort(), ['.gitattributes', 'data/seed.dat']);
    const probe = repoDir('probe');
    plainGit(repo.path, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '--detach', probe, 'main']);
    assert.match(readEvidence(evidence), /filter smudge ran/);
    rmSync(evidence);
    writeFileSync(join(probe, 'data', 'new.dat'), 'n\n');
    const tree = snapshotTree(probe, filter.commit);
    assert.equal(readEvidence(evidence), null, 'the independent snapshot runs no filter');
    assert.ok('data/new.dat' in listTree(repo.path, tree));
    plainGit(probe, ['-c', 'core.hooksPath=/dev/null', 'add', '-A']);
    assert.match(readEvidence(evidence), /filter clean ran/, 'while an ordinary add does');
    rmSync(evidence);

    plantConfiguredPrograms(repo.path, evidence, { dir });
    const second = commitOnRef(repo.path, null, { 'README.md': 'changed\n' }, { parent: repo.head });
    assert.equal(readEvidence(evidence), null, 'a plumbing commit runs no signing program');
    plainGit(repo.path, ['-c', 'core.hooksPath=/dev/null', 'diff', repo.head, second]);
    assert.match(readEvidence(evidence), /diff\.external ran/);
  });

  await check('repos: the hostile environment names another repository, other identities and programs that leave evidence', () => {
    const decoy = makeProjectRepo(repoDir('decoy'));
    const dir = join(decoy.path, '..', 'hostile');
    const evidence = join(dir, 'evidence.txt');
    const env = hostileEnvironment({ decoy: decoy.path, dir, evidence });
    assert.equal(env.GIT_DIR, join(decoy.path, '.git'));
    for (const key of ['GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_EDITOR', 'EDITOR', 'VISUAL', 'GIT_EXTERNAL_DIFF', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GH_REPO', 'GH_TOKEN']) assert.ok(typeof env[key] === 'string' && env[key].length > 0, key);
    assert.ok(HOSTILE_IDENTITIES.some((name) => env.GIT_AUTHOR_NAME.includes(name)) && HOSTILE_IDENTITIES.some((name) => env.GIT_COMMITTER_EMAIL.includes(name)));
    // It is live: a git command that inherits it lands in the decoy and runs the ambient hook.
    const other = makeProjectRepo(repoDir('target'));
    execFileSync('git', ['update-ref', 'refs/heads/ambient-wrote-here', decoy.head], { cwd: other.path, env: { PATH: process.env.PATH, HOME: dir, ...env, GIT_EXEC_PATH: undefined } });
    assert.ok(Object.keys(refsOf(decoy.path)).some((ref) => ref.includes('ambient-wrote-here')), 'a git that inherits the environment writes into the decoy, not into the directory it runs in');
    assert.deepEqual(Object.keys(refsOf(other.path)), ['refs/heads/main']);
    assert.match(readEvidence(evidence), /ambient hook reference-transaction ran/);
    execFileSync(env.GIT_EDITOR, [], { input: '' });
    assert.match(readEvidence(evidence), /GIT_EDITOR ran/);
  });

  await check('repos: an unreadable repository cannot be read by git until access is restored, and held git calls wait until they are let go', async () => {
    const repo = makeProjectRepo(repoDir('unreadable'));
    const restore = makeUnreadable(repo.path);
    assert.throws(() => gitQuiet(repo.path, ['rev-parse', 'HEAD']));
    restore();
    assert.equal(gitQuiet(repo.path, ['rev-parse', 'HEAD']), repo.head);

    const letGo = holdGit(repo.path);
    const held = spawn('git', ['--git-dir', join(repo.path, '.git'), 'rev-parse', 'refs/heads/main'], { env: { PATH: process.env.PATH, HOME: repo.path }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    held.stdout.on('data', (c) => (out += c));
    const exited = new Promise((resolve) => held.once('exit', (code, signal) => resolve({ code, signal })));
    assert.equal(await Promise.race([exited, sleep(1500).then(() => 'held')]), 'held', 'a git call on a held repository waits');
    letGo();
    assert.deepEqual(await exited, { code: 0, signal: null }, 'a call that is still waiting is given the configuration and goes on');
    assert.equal(out.trim(), repo.head);
    letGo(); // a second call does nothing
    assert.equal(gitQuiet(repo.path, ['rev-parse', 'HEAD']), repo.head, 'and the configuration is back');
    // A held call that was killed meanwhile leaves nothing to let go of.
    const again = holdGit(repo.path);
    const doomed = spawn('git', ['--git-dir', join(repo.path, '.git'), 'rev-parse', 'HEAD'], { env: { PATH: process.env.PATH, HOME: repo.path }, stdio: 'ignore' });
    await sleep(300);
    doomed.kill('SIGKILL');
    await new Promise((resolve) => doomed.once('exit', resolve));
    again();
    assert.equal(gitQuiet(repo.path, ['rev-parse', 'HEAD']), repo.head);
  });

  // ---- 13. journal and registry reads ---------------------------------------------------

  await check('contract: the journal table names four kinds and five boundaries, and the barrier names follow from them', () => {
    assert.deepEqual(Object.keys(JOURNAL.kinds).sort(), ['commit_tree', 'ref_update', 'worktree_add', 'worktree_remove']);
    assert.deepEqual(Object.keys(JOURNAL.boundaries), ['intent_committed', 'effect_applied', 'receipt_committed', 'probe_confirmed', 'finalizer_committed']);
    assert.equal(journalBarriers().length, 20);
    assert.equal(new Set(journalBarriers()).size, 20);
    assert.equal(journalBarrier('ref_update', 'intent_committed'), 'journal.ref_update.intent_committed');
    assert.ok(journalBarriers().every((name) => /^journal\.[a-z_]+\.[a-z_]+$/.test(name)));
    assert.throws(() => journalBarrier('push', 'intent_committed'), /no journal kind/);
    assert.throws(() => journalBarrier('ref_update', 'half_way'), /no journal boundary/);
    assert.deepEqual(JOURNAL.ordinary_events, ['intended', 'applied', 'confirmed', 'finalized']);
  });

  await check('contract: the validation table agrees with the work-item table on who runs what, and its examples obey its own rules', () => {
    for (const [role, spec] of Object.entries(VALIDATION.roles)) {
      for (const kind of spec.kinds) {
        assert.equal(roleOf(kind), role, `${kind} is a ${role}'s kind in both tables`);
        assert.ok(WORK.kinds[kind].path.includes('integrating'), `${kind} integrates`);
      }
    }
    const builder = VALIDATION.roles.builder;
    assert.ok(builder.permitted.every((path) => !path.startsWith('.surety/')) && builder.prohibited.every((path) => path.startsWith('.surety/')));
    const architect = VALIDATION.roles.architect;
    const allowed = (path) => architect.permitted_prefixes.some((prefix) => path.startsWith(prefix));
    assert.ok(architect.permitted.every(allowed) && !architect.prohibited.some(allowed));
    assert.ok(!architect.permitted.some((path) => path.startsWith('.surety/phases/')), 'no plan example: its format is row M26');
    assert.ok(builder.prohibited.includes(VALIDATION.identity_file) && builder.prohibited.some((path) => path.startsWith(VALIDATION.protected_roots[0])));
    assert.deepEqual([VALIDATION.reason_class.in_the_diff, VALIDATION.reason_class.outside_the_diff], ['diff_violation', 'ref_violation']);
    assert.equal(new Set(VALIDATION.metadata.cases.map((c) => c.key)).size, VALIDATION.metadata.cases.length);
    assert.equal(new Set(VALIDATION.diff.cases.map((c) => c.key)).size, VALIDATION.diff.cases.length);
    assert.equal(new Set(VALIDATION.literal_names.names).size, VALIDATION.literal_names.names.length);
    assert.ok(VALIDATION.literal_names.names.every((name) => !name.includes('\0') && !name.startsWith('/') && !name.split('/').includes('..')));
  });

  await check('journal reads: operations come with their events in order, filtered by run and kind, and an ordinary course is told from any other', () => {
    const home = mkdtempSync(join(work, 's3-home-'));
    const db = new Database(join(home, 'store.db'));
    db.exec(WITNESS3);
    const project = newId('proj_');
    db.prepare('INSERT INTO projects (id, created_at, name) VALUES (?, ?, ?)').run(project, isoNow(), 'selfcheck');
    const operation = (seq, kind, journalKind, status, events, payload) => {
      const id = newId('op_');
      db.prepare(
        `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, deadline_at, finalized_at) VALUES (?, ?, ?, ?, ?, '{}', '{}', ?, 1, ?, ?, ?)`,
      ).run(id, isoNow(), project, seq, kind, `key-${seq}`, status, isoNow(), status === 'succeeded' ? isoNow() : null);
      // Inserted out of order: the reads sort by seq.
      [...events.entries()].reverse().forEach(([i, eventKind]) =>
        db
          .prepare('INSERT INTO git_journal_events (id, created_at, project, operation, seq, journal_kind, event_kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(newId('gje_'), isoNow(), project, id, i + 1, journalKind, eventKind, JSON.stringify(payload)),
      );
      return id;
    };
    const commit = operation(2, 'git_commit', 'commit_tree', 'succeeded', JOURNAL.ordinary_events, { repo: 'r', tree: 't', run: 'run_A' });
    const move = operation(3, 'git_ref_update', 'ref_update', 'failed', ['intended', 'failed'], { repo: 'r', ref: 'refs/heads/main', run: 'run_A' });
    const add = operation(1, 'git_worktree', 'worktree_add', 'ambiguous', ['intended', 'ambiguous'], { repo: 'r', run: 'run_B' });
    db.close();
    assert.deepEqual(operationsOf(home, { project }).map((op) => op.id), [add, commit, move], 'in the order of their seq');
    assert.deepEqual(operationsOf(home, { run: 'run_A' }).map((op) => op.journal_kind), ['commit_tree', 'ref_update']);
    const [found] = operationsOf(home, { run: 'run_A', journalKind: 'commit_tree' });
    assert.deepEqual([found.id, found.status, found.finalized, found.state, found.events.map((e) => e.kind)], [commit, 'succeeded', true, 'finalized', JOURNAL.ordinary_events]);
    assert.equal(found.events[0].payload.tree, 't');
    assertOrdinaryCourse(found, 'the commit');
    const [refused] = operationsOf(home, { journalKind: 'ref_update' });
    assert.deepEqual([refused.state, refused.finalized], ['failed', false]);
    assert.throws(() => assertOrdinaryCourse(refused, 'the refused update'), /the journal's events/);
    assert.throws(() => assertOrdinaryCourse(operationsOf(home, { kind: 'git_worktree' })[0], 'the ambiguous add'), /the journal's events/);
    assert.throws(() => assertOrdinaryCourse({ ...found, kind: 'git_ref_update' }, 'a commit journal on the wrong operation kind'), /belongs to a git_commit operation/);
    assert.throws(() => assertOrdinaryCourse({ ...found, finalized: false }, 'not finalized'), /finalized/);
    assert.throws(() => assertOrdinaryCourse(undefined, 'missing'), /exists/);
    assert.deepEqual(operationsOf(home, { run: 'run_none' }), []);
  });

  await check('registry reads: the registry by ref, revisions by run, and an observation with its decision and the options it offers', () => {
    const home = mkdtempSync(join(work, 's3-home-'));
    const db = new Database(join(home, 'store.db'));
    db.exec(WITNESS3);
    const project = newId('proj_');
    db.prepare('INSERT INTO projects (id, created_at, name) VALUES (?, ?, ?)').run(project, isoNow(), 'selfcheck');
    const ref = newId('ref_');
    db.prepare('INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES (?, ?, ?, ?, ?, ?, 0)').run(ref, isoNow(), project, 'refs/heads/main', 'integration', 'a'.repeat(40));
    db.prepare('INSERT INTO revisions (id, created_at, project, sha, parent_sha, kind, created_by_run, recorded_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)').run(newId('rev_'), isoNow(), project, 'b'.repeat(40), 'out_of_band', isoNow());
    const decision = newId('dec_');
    db.prepare(
      `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status)
       VALUES (?, ?, ?, 1, 'out_of_band_change', 'out_of_band_change', 'oob_1', 1, 's', 'q?', ?, '{}', 1, 'h', '[]', '{}', ?, 'open')`,
    ).run(decision, isoNow(), project, JSON.stringify([{ key: 'discard' }, { key: 'adopt' }]), isoNow());
    db.prepare(`INSERT INTO out_of_band_changes (id, created_at, project, subject_kind, ref, checkout, expected, found, detected_at, disposition, decision) VALUES ('oob_1', ?, ?, 'ref', ?, NULL, ?, NULL, ?, NULL, ?)`).run(isoNow(), project, ref, 'a'.repeat(40), isoNow(), decision);
    db.close();
    assert.deepEqual(registryOf(home, project), { 'refs/heads/main': { kind: 'integration', expected_oid: 'a'.repeat(40), immutable: 0 } });
    assert.deepEqual(revisionsOf(home, { project }).map((r) => [r.kind, r.created_by_run]), [['out_of_band', null]]);
    assert.deepEqual(revisionsOf(home, { run: 'run_none' }), []);
    const [o] = outOfBand(home, project);
    assert.deepEqual(
      { subject_kind: o.subject_kind, ref_name: o.ref_name, checkout_path: o.checkout_path, expected: o.expected, found: o.found, disposition: o.disposition, options: o.decision.options, status: o.decision.status, subject_id: o.decision.subject_id },
      { subject_kind: 'ref', ref_name: 'refs/heads/main', checkout_path: null, expected: 'a'.repeat(40), found: null, disposition: null, options: ['adopt', 'discard'], status: 'open', subject_id: 'oob_1' },
    );
    assert.deepEqual(outOfBand(home, newId('proj_')), []);
  });

}
