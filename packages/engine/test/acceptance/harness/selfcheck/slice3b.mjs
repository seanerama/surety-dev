// The part of the harness self-check for slice 3's second Verifier session
// (see run.mjs). As in slice2.mjs and slice3.mjs, each helper with logic is
// run against something that exists:
//
//  14. the journal's contract tables (../../contract/journal.json): the
//      transition table, the probe table, the attempt table and the derivation
//      of an operation's status, checked for the properties the rows rely on,
//      and the case lists generated from them (../probes.mjs);
//  15. the git states the probe rows build by hand (../repos.mjs, ../probes.mjs
//      `arrange` and `effectOf`), against real git: what each helper says of a
//      state is what git itself says of it;
//  16. the reads of operations, attempts and the state projection
//      (../journal.mjs), against witness stores and one mutant per assertion;
//  17. the git facts of the run-end fault matrix and the expectations checked
//      on them (../endings.mjs), against a real repository and a witness store.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { ENDINGS, assertIntegrationExpectations, gitFacts, matrixCells, throughIntegration } from '../endings.mjs';
import { waitFor } from '../engine.mjs';
import { gitEnv } from '../git.mjs';
import { isoNow, newId } from '../ids.mjs';
import {
  ATTEMPTS,
  JOURNAL,
  PROBE,
  assertJournalPath,
  assertOperation,
  assertOperations,
  derivedStatus,
  journalBarriers,
  operationDetail,
  operationDetails,
  probeFlag,
  receiptSnapshot,
  recoveryBarrier,
} from '../journal.mjs';
import { BOUNDARIES, KINDS, OUTCOMES, REACH, STATES, arrange, crashTitle, crashWay, effectOf, otherFormCells, probeCells } from '../probes.mjs';
import {
  addLinkedWorktree,
  addWorktreeByHand,
  addWorktreeUnfinished,
  commitOnRef,
  commitsNaming,
  deleteLooseObject,
  foreignDirectory,
  gitProcessesNaming,
  gitQuiet,
  holdGit,
  makePartUnreadable,
  makeProjectRepo,
  objectExists,
  parentsOf,
  removeWorktreeByHand,
  removeWorktreeDirectory,
  removeWorktreeMetadata,
  workspaceState,
  worktreeList,
  worktreeMetadata,
} from '../repos.mjs';
import { seedAttempt } from '../seed.mjs';
import { emit } from './witness-state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sql = (name) => readFileSync(join(here, name), 'utf8');
// The stages table as the witness engine creates it.
const STAGES_TABLE = `CREATE TABLE stages (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, project TEXT NOT NULL, phase_plan TEXT NOT NULL, number INTEGER NOT NULL,
  goal TEXT NOT NULL, modules TEXT NOT NULL, requirement_ids TEXT NOT NULL, implements TEXT NOT NULL, status TEXT NOT NULL, integrated_revision TEXT, work_item TEXT);`;
const WITNESS3B = `${sql('witness-schema.sql')}${sql('witness-slice2.sql')}ALTER TABLE projects ADD COLUMN tier TEXT; ALTER TABLE projects ADD COLUMN dev_repo_path TEXT; ALTER TABLE projects ADD COLUMN integration_branch TEXT;${sql('witness-slice3.sql')}${sql('witness-slice3b.sql')}${STAGES_TABLE}`;

// The statuses an operation can have (D1 A.5).
const OPERATION_STATUSES = ['intended', 'in_progress', 'succeeded', 'failed', 'partial', 'ambiguous', 'superseded'];

export async function slice3bChecks(check, work) {
  // ---- 14. the journal's contract tables -------------------------------------------

  await check('contract: the journal transition table is closed over its states, has no way out of a terminal state, and carries correction 14', () => {
    const { edges } = JOURNAL.transitions;
    assert.deepEqual(JOURNAL.states, ['intended', 'applied', 'confirmed', 'failed', 'ambiguous', 'finalized']);
    assert.deepEqual(JOURNAL.terminal, ['finalized', 'failed']);
    for (const edge of edges) {
      assert.ok(JOURNAL.states.includes(edge.from) && JOURNAL.states.includes(edge.to), `${edge.from} → ${edge.to}`);
      assert.notEqual(edge.from, edge.to, 'no state follows itself');
      assert.ok(!JOURNAL.terminal.includes(edge.from), `nothing follows ${edge.from}`);
      assert.ok(typeof edge.by === 'string' && edge.by.length > 0);
    }
    assert.equal(new Set(edges.map((e) => `${e.from}>${e.to}`)).size, edges.length, 'no edge twice');
    // Correction 14: an ambiguous operation can become applied or failed, and nothing else.
    assert.deepEqual(edges.filter((e) => e.from === 'ambiguous').map((e) => e.to).sort(), ['applied', 'failed']);
    assert.ok(edges.filter((e) => e.from === 'ambiguous').every((e) => e.correction === 14));
    // Every state but the first can be reached, and `finalized` only from `confirmed`.
    for (const state of JOURNAL.states.slice(1)) assert.ok(edges.some((e) => e.to === state), `${state} is reachable`);
    assert.deepEqual(edges.filter((e) => e.to === 'finalized').map((e) => e.from), ['confirmed']);
    assert.deepEqual(edges.filter((e) => e.to === 'confirmed').map((e) => e.from), ['applied'], 'only a recorded receipt is confirmed');
    // Recovery says what it does with an operation in every state.
    assert.deepEqual(Object.keys(JOURNAL.recovery.visits).sort(), [...JOURNAL.states].sort());
    for (const state of STATES) assert.equal(JOURNAL.recovery.visits[state], 'probe', `${state} is probed`);
    assert.match(JOURNAL.recovery.visits.confirmed, /^finalizer only/);
  });

  await check('contract: the ordinary course and what is durable at each boundary are legal paths, and assertJournalPath tells a legal path from any other', () => {
    assertJournalPath(JOURNAL.ordinary_events);
    const durable = Object.entries(JOURNAL.durable).filter(([key]) => !key.startsWith('$'));
    assert.deepEqual(durable.map(([key]) => key), BOUNDARIES, 'one entry per boundary, in order');
    for (const [boundary, spec] of durable) {
      assertJournalPath(spec.events, boundary);
      assert.ok(['absent', 'applied'].includes(spec.effect));
      assert.deepEqual(spec.events, JOURNAL.ordinary_events.slice(0, spec.events.length), `${boundary}: a prefix of the ordinary course`);
    }
    assert.equal(JOURNAL.durable.intent_committed.effect, 'absent');
    assert.ok(BOUNDARIES.slice(1).every((b) => JOURNAL.durable[b].effect === 'applied'));
    assert.equal(JOURNAL.durable.probe_confirmed.exact, false, 'the confirmation may commit together with the finalizer');
    for (const legal of [['intended'], ['intended', 'failed'], ['intended', 'ambiguous', 'applied', 'confirmed', 'finalized'], ['intended', 'applied', 'ambiguous', 'failed'], ['intended', 'ambiguous', 'failed']]) assertJournalPath(legal);
    const illegal = [
      [['applied', 'confirmed'], /starts with its intent/],
      [[], /has events/],
      [['intended', 'confirmed'], /intended → confirmed is not a legal journal transition/],
      [['intended', 'applied', 'finalized'], /applied → finalized/],
      [['intended', 'applied', 'applied'], /applied → applied/],
      [['intended', 'failed', 'applied'], /failed → applied/],
      [['intended', 'applied', 'confirmed', 'finalized', 'finalized'], /finalized → finalized/],
      [['intended', 'ambiguous', 'confirmed'], /ambiguous → confirmed/],
      [['intended', 'ambiguous', 'ambiguous'], /ambiguous → ambiguous/],
      [['intended', 'applied', 'confirmed', 'ambiguous'], /confirmed → ambiguous/],
    ];
    for (const [kinds, message] of illegal) assert.throws(() => assertJournalPath(kinds), message, kinds.join(', '));
    // Without correction 14 a recovered operation's journal is refused.
    const before14 = { edges: JOURNAL.transitions.edges.filter((e) => e.correction !== 14) };
    assert.throws(() => assertJournalPath(['intended', 'ambiguous', 'applied'], 'journal', before14), /ambiguous → applied/);
  });

  await check('contract: the probe table gives every kind and outcome one way on, and never lets a conflicting or unknown effect proceed', () => {
    assert.deepEqual(OUTCOMES, ['absent', 'applied', 'partial', 'conflicting', 'unknown']);
    assert.deepEqual(STATES, ['intended', 'applied', 'ambiguous']);
    assert.deepEqual(Object.keys(PROBE.kinds).sort(), [...KINDS].sort());
    assert.deepEqual(Object.keys(PROBE.dispositions).sort(), ['block', 'complete', 'finalize', 'retry', 'withdraw']);
    for (const kind of KINDS) {
      assert.deepEqual(Object.keys(PROBE.kinds[kind]).filter((key) => !key.startsWith('$')), OUTCOMES, `${kind}: the five outcomes, in order`);
      for (const outcome of OUTCOMES) {
        const spec = PROBE.kinds[kind][outcome];
        assert.ok(spec.leads_to in PROBE.dispositions, `${kind} ${outcome}: ${spec.leads_to}`);
        assert.ok(typeof spec.means === 'string' && spec.means.length > 0 && typeof spec.fixture === 'string' && spec.fixture.length > 0);
      }
      assert.equal(PROBE.kinds[kind].applied.leads_to, 'finalize', `${kind}: an effect found applied is never repeated`);
      assert.equal(PROBE.kinds[kind].conflicting.leads_to, 'block', `${kind}: conflicting blocks`);
      assert.equal(PROBE.kinds[kind].unknown.leads_to, 'block', `${kind}: unknown blocks`);
      assert.ok(['retry', 'withdraw'].includes(PROBE.kinds[kind].absent.leads_to), `${kind}: absent is retried or withdrawn, never finalized`);
      assert.ok(['complete', 'withdraw', 'block'].includes(PROBE.kinds[kind].partial.leads_to), `${kind}: partial is never finalized as it is, nor retried from the start`);
    }
    assert.equal(PROBE.kinds.ref_update.partial.leads_to, 'block', 'Plan M29: an unexplained partial result of a single-ref swap blocks');
    for (const [way, spec] of Object.entries(PROBE.dispositions)) {
      assert.ok(JOURNAL.states.includes(spec.journal) && OPERATION_STATUSES.includes(spec.operation), way);
      assert.equal(spec.finalized, spec.journal === 'finalized', `${way}: finalized exactly when the journal is`);
      assert.ok(spec.reconciled_attempt.every((s) => ATTEMPTS.statuses.includes(s)), way);
      assert.equal(spec.new_attempts, ['retry', 'complete'].includes(way) ? 1 : 0, `${way}: new attempts`);
      assert.equal(spec.blocker, way === 'block', `${way}: a blocker exactly when it blocks`);
      // A new attempt is admitted only after the attempt statuses the admission rule names.
      if (spec.new_attempts > 0) assert.ok(spec.reconciled_attempt.every((s) => ATTEMPTS.admission.after.includes(s)), way);
    }
    assert.deepEqual([PROBE.dispositions.block.journal, PROBE.dispositions.block.operation, PROBE.dispositions.block.reconciled_attempt], ['ambiguous', 'ambiguous', ['ambiguous']]);
  });

  await check('probe and crash cases: one case per kind, durable state and outcome, and one per kind and boundary, each with a title of its own', () => {
    const titles = [];
    for (const kind of KINDS) {
      const cells = probeCells(kind);
      assert.equal(cells.length, STATES.length * OUTCOMES.length);
      assert.deepEqual([...new Set(cells.map((c) => c.state))], STATES);
      for (const state of STATES) assert.deepEqual(cells.filter((c) => c.state === state).map((c) => c.outcome), OUTCOMES, `${kind} ${state}: the five outcomes`);
      for (const c of cells) {
        assert.equal(c.way, PROBE.kinds[kind][c.outcome].leads_to);
        assert.ok(c.title.startsWith(`${kind}, journal ${c.state}, effect found ${c.outcome} (`), c.title);
        titles.push(c.title);
      }
      assert.deepEqual(Object.keys(REACH[kind]), ['intended', 'applied'], `${kind}: how the two states a kill leaves are reached`);
      for (const boundary of Object.values(REACH[kind])) assert.ok(BOUNDARIES.includes(boundary));
      assert.equal(JOURNAL.durable[REACH[kind].applied].events.at(-1), 'applied');
      assert.equal(JOURNAL.durable[REACH[kind].intended].events.at(-1), 'intended');
    }
    assert.equal(titles.length, 60);
    // The further forms of an outcome: one case per durable state, the same way on, a title of its own.
    for (const kind of KINDS) {
      const others = otherFormCells(kind);
      assert.equal(others.length, kind === 'worktree_add' ? STATES.length : 0, `${kind}: other forms`);
      for (const c of others) {
        assert.deepEqual([c.outcome, c.form, c.way], ['partial', 'unfinished_checkout', PROBE.kinds[kind].partial.leads_to]);
        titles.push(c.title);
      }
    }
    assert.equal(new Set(titles).size, 63, 'no probe title twice');
    assert.throws(() => probeCells('push'), /no probe table/);
    assert.throws(() => otherFormCells('push'), /no probe table/);
    const crashes = KINDS.flatMap((kind) => BOUNDARIES.map((boundary) => crashTitle(kind, boundary)));
    assert.equal(new Set(crashes).size, 20, 'no crash title twice');
    for (const kind of KINDS) {
      // Killed with the effect absent, the probe's `absent` decides; once the effect is there, it is finalized.
      assert.equal(crashWay(kind, 'intent_committed'), PROBE.kinds[kind].absent.leads_to);
      for (const boundary of BOUNDARIES.slice(1)) assert.equal(crashWay(kind, boundary), 'finalize', `${kind} ${boundary}`);
      assert.match(crashTitle(kind, 'finalizer_committed'), /finalizes the operation once/);
    }
    assert.match(crashTitle('worktree_add', 'intent_committed'), /withdraws the operation/);
    assert.match(crashTitle('ref_update', 'intent_committed'), /finalizes the operation once/);
  });

  await check('contract: the recovery barrier and the probe flag are named from the table and refuse anything it does not hold', () => {
    assert.deepEqual(Object.keys(JOURNAL.recovery_boundaries).filter((k) => !k.startsWith('$')), ['reconciled']);
    assert.equal(recoveryBarrier('ref_update'), 'journal.ref_update.reconciled');
    assert.ok(!journalBarriers().includes(recoveryBarrier('ref_update')), 'it is not one of the twenty ordinary barriers');
    assert.throws(() => recoveryBarrier('push'), /no journal kind/);
    assert.throws(() => recoveryBarrier('ref_update', 'intent_committed'), /no recovery boundary/);
    assert.deepEqual(probeFlag('worktree_add', 'unknown'), ['--harness-probe', 'worktree_add=unknown']);
    assert.throws(() => probeFlag('push', 'unknown'), /no journal kind/);
    assert.throws(() => probeFlag('ref_update', 'maybe'), /no probe outcome/);
  });

  await check('contract: the attempt table is closed, admits a further attempt only after a positive reconciliation, and derives a status for every combination', () => {
    assert.deepEqual(ATTEMPTS.statuses, ['started', 'succeeded', 'failed', 'ambiguous', 'reconciled_succeeded', 'reconciled_absent', 'reconciled_partial']);
    for (const [from, to] of ATTEMPTS.edges) {
      assert.ok(ATTEMPTS.statuses.includes(from) && ATTEMPTS.statuses.includes(to) && from !== to, `${from} → ${to}`);
      assert.ok(!['succeeded', 'reconciled_succeeded', 'reconciled_absent', 'reconciled_partial'].includes(from), `nothing follows ${from}`);
      if (from !== 'started') assert.ok(to.startsWith('reconciled_'), `${from} changes only by reconciliation`);
    }
    assert.deepEqual(ATTEMPTS.admission.after, ['reconciled_absent', 'reconciled_partial'], 'correction 16: never after failed, ambiguous or unknown');
    // Totality: every latest attempt, journal state and successor flag has a status, and a known one.
    const seen = new Set();
    for (const latest of [null, ...ATTEMPTS.statuses]) {
      for (const state of JOURNAL.states) {
        for (const successor of [false, true]) {
          const status = derivedStatus({ attempts: latest === null ? [] : [{ status: latest }], state, successor });
          assert.ok(OPERATION_STATUSES.includes(status), `${latest}, ${state}, ${successor}: ${status}`);
          seen.add(status);
        }
      }
    }
    assert.deepEqual([...seen].sort(), [...OPERATION_STATUSES].sort(), 'every operation status is derived from something');
    const derive = (latest, state, successor = false) => derivedStatus({ attempts: latest.map((status) => ({ status })), state, successor });
    // D1 A.5 and correction 16, case by case.
    assert.equal(derive([], 'intended'), 'intended');
    assert.equal(derive(['started'], 'intended'), 'in_progress');
    assert.equal(derive(['succeeded'], 'confirmed'), 'succeeded');
    assert.equal(derive(['reconciled_succeeded'], 'finalized'), 'succeeded');
    assert.equal(derive(['failed'], 'failed'), 'failed');
    assert.equal(derive(['ambiguous'], 'ambiguous'), 'ambiguous');
    assert.equal(derive(['reconciled_partial'], 'ambiguous'), 'partial');
    assert.equal(derive(['reconciled_absent'], 'ambiguous'), 'intended', 'the interval before an allowed retry');
    assert.equal(derive(['reconciled_absent'], 'failed'), 'failed', 'reconciled absent with no further attempt permitted');
    assert.equal(derive(['reconciled_absent', 'started'], 'ambiguous'), 'in_progress', 'the latest attempt decides');
    assert.equal(derive(['reconciled_absent', 'succeeded'], 'finalized'), 'succeeded');
    assert.equal(derive([], 'ambiguous'), 'ambiguous');
    assert.equal(derive([], 'finalized'), 'succeeded');
    // Superseded only with a linked successor, and never for an operation that succeeded.
    assert.equal(derive(['failed'], 'failed', true), 'superseded');
    assert.equal(derive(['succeeded'], 'finalized', true), 'succeeded');
    for (const latest of ATTEMPTS.statuses) for (const state of JOURNAL.states) assert.notEqual(derive([latest], state, false), 'superseded', `${latest}, ${state}: no successor, not superseded`);
    // What never completes work is every status but success.
    assert.deepEqual([...ATTEMPTS.never_completes_work].sort(), OPERATION_STATUSES.filter((s) => s !== 'succeeded').sort());
    assert.throws(() => derivedStatus({ attempts: [{ status: 'reconciled_absent' }], state: 'ambiguous', successor: false }, ATTEMPTS.derivation.rules.slice(0, -1)), /gives no status/);
  });

  await check('contract: every journal kind has its finalizer receipts, and an integration ending names the operations and commits it leaves', () => {
    assert.deepEqual(Object.keys(JOURNAL.finalizers).filter((key) => !key.startsWith('$')).sort(), [...KINDS].sort());
    assert.deepEqual(Object.keys(JOURNAL.finalizers.ref_update), ['every', 'integration', 'nomination', 'bootstrap']);
    const integration = Object.entries(ENDINGS).filter(([, spec]) => throughIntegration(spec));
    assert.deepEqual(integration.map(([name]) => name).sort(), ['abandon_integrating', 'checkpoint', 'integrates', 'integration_conflict', 'stop_integrating']);
    for (const [name, spec] of integration) {
      assert.ok(Array.isArray(spec.expect.operations) && spec.expect.operations.length >= 2, name);
      for (const [kind, status] of spec.expect.operations) assert.ok(KINDS.includes(kind) && OPERATION_STATUSES.includes(status), `${name}: ${kind} ${status}`);
      assert.equal(spec.expect.operations[0][0], 'worktree_add', `${name}: a run begins with its workspace`);
      assert.ok(Number.isInteger(spec.expect.commits) && spec.expect.commits >= 0, name);
      assert.equal(spec.expect.launched, true, name);
    }
    assert.ok(Object.values(ENDINGS).filter((spec) => !throughIntegration(spec)).every((spec) => !('operations' in spec.expect)), 'the earlier endings are as they were');
    // A stage `committed` is armed only in an ending through integration.
    assert.ok(matrixCells().filter((c) => c.fault.stage === 'committed').every((c) => throughIntegration(ENDINGS[c.ending])));
    assert.ok(matrixCells().some((c) => c.fault.stage === 'committed'));
    assert.equal(matrixCells().filter((c) => throughIntegration(ENDINGS[c.ending])).length, 61);
  });

  // ---- 15. git states built by hand, against real git --------------------------------

  let r = 0;
  const repoAt = (opts) => makeProjectRepo(join(mkdtempSync(join(work, 's3b-repo-')), `repo-${++r}`), opts);
  // Real git, asked directly, with nothing of the harness's readers in between.
  const real = (repo, args) => execFileSync('git', ['-C', repo, ...args], { env: gitEnv(repo), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const realFails = (repo, args) => {
    try {
      real(repo, args);
      return false;
    } catch {
      return true;
    }
  };
  const listed = (repo, path) => real(repo, ['worktree', 'list', '--porcelain']).split('\n').includes(`worktree ${path}`);

  await check('repos: commits are found by their message whether or not a ref holds them, and a loose object that is deleted is gone for git', () => {
    const repo = repoAt();
    const named = commitOnRef(repo.path, null, { 'a.txt': 'a\n' }, { parent: repo.head, message: 'surety: a run\n\nSurety-Run: run_SELFCHECK' });
    const other = commitOnRef(repo.path, null, { 'b.txt': 'b\n' }, { parent: repo.head, message: 'surety: another\n\nSurety-Run: run_OTHER' });
    assert.equal(real(repo.path, ['for-each-ref', '--contains', named]), '', 'no ref holds the commit');
    assert.deepEqual(commitsNaming(repo.path, 'Surety-Run: run_SELFCHECK'), [named]);
    assert.deepEqual(commitsNaming(repo.path, 'Surety-Run: run_').sort(), [named, other].sort());
    assert.deepEqual(commitsNaming(repo.path, 'Surety-Run: run_NONE'), []);
    assert.deepEqual(commitsNaming(repo.path, 'fixture: initial commit'), [repo.head], 'a reachable commit is found too');
    assert.equal(objectExists(repo.path, named), true);
    deleteLooseObject(repo.path, named);
    assert.equal(objectExists(repo.path, named), false);
    assert.ok(realFails(repo.path, ['cat-file', '-e', named]), 'real git no longer has the object');
    assert.deepEqual(commitsNaming(repo.path, 'Surety-Run: run_SELFCHECK'), []);
    assert.equal(objectExists(repo.path, other), true, 'and nothing else went with it');
    assert.throws(() => deleteLooseObject(repo.path, named), /not a loose object/);
    // A packed object is not removed by deleting a file: the helper says so instead of pretending.
    real(repo.path, ['repack', '-a', '-d', '-q']);
    assert.throws(() => deleteLooseObject(repo.path, repo.head), /not a loose object/);
    assert.equal(objectExists(repo.path, repo.head), true);
  });

  await check('repos: a part of a repository made unreadable cannot be read by git until access is restored', () => {
    const repo = repoAt();
    const linked = addLinkedWorktree(repo.path, join(repo.path, '..', 'linked'), { at: repo.head });
    assert.ok(listed(repo.path, linked));
    if (process.getuid() !== 0) {
      const restoreObjects = makePartUnreadable(repo.path, 'objects');
      assert.ok(realFails(repo.path, ['cat-file', '-e', repo.head]), 'git cannot read an object');
      assert.equal(objectExists(repo.path, repo.head), false);
      restoreObjects();
      restoreObjects();
      assert.equal(real(repo.path, ['cat-file', '-t', repo.head]), 'commit');
      const restoreWorktrees = makePartUnreadable(repo.path, 'worktrees');
      // Real git does not fail here: it lists no linked worktree, as if there were none. A probe must not take that for absence.
      assert.ok(realFails(repo.path, ['worktree', 'list', '--porcelain']) || !listed(repo.path, linked), 'git cannot see the linked worktree');
      assert.throws(() => worktreeMetadata(repo.path, linked), /EACCES/);
      restoreWorktrees();
      restoreWorktrees();
      assert.ok(listed(repo.path, linked));
      assert.ok(worktreeMetadata(repo.path, linked) !== null);
    } else {
      const restore = makePartUnreadable(repo.path, 'objects');
      assert.ok(realFails(repo.path, ['rev-parse', 'HEAD']));
      restore();
      assert.equal(real(repo.path, ['rev-parse', 'HEAD']), repo.head);
    }
    assert.throws(() => makePartUnreadable(repo.path, 'refs'), /unknown part/);
    assert.throws(() => makePartUnreadable(repoAt().path, 'worktrees'), /nothing to make unreadable/);
  });

  await check('repos: workspaceState names what real git holds for a path, in every state the probe rows build', () => {
    const repo = repoAt({ files: { 'src/app.js': 'export const answer = 1;\n' } });
    const dir = join(repo.path, '..', 'ws');
    // What real git says it would prune: the entries whose directory is gone.
    const prunable = () => real(repo.path, ['worktree', 'list', '--porcelain']).split('\n').some((line) => line.startsWith('prunable'));
    assert.equal(workspaceState(repo.path, dir, repo.head), 'absent');
    assert.equal(worktreeMetadata(repo.path, dir), null);

    addWorktreeByHand(repo.path, dir, repo.head);
    assert.equal(workspaceState(repo.path, dir, repo.head), 'complete');
    assert.equal(workspaceState(repo.path, dir), 'complete');
    assert.ok(listed(repo.path, dir) && !prunable(), 'git lists it and would prune nothing');
    assert.equal(real(dir, ['rev-parse', 'HEAD']), repo.head);
    assert.ok(realFails(dir, ['symbolic-ref', '-q', 'HEAD']), 'detached');
    assert.equal(worktreeList(repo.path).length, real(repo.path, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length);
    assert.deepEqual(worktreeList(repo.path).find((w) => w.path === dir), { path: dir, head: repo.head, branch: null, prunable: false });
    // A role's own, untracked file leaves it complete; a tracked file missing or changed does not.
    writeFileSync(join(dir, 'untracked.txt'), 'a role wrote this\n');
    assert.equal(workspaceState(repo.path, dir, repo.head), 'complete');
    rmSync(join(dir, 'src', 'app.js'));
    assert.equal(workspaceState(repo.path, dir, repo.head), 'incomplete', 'a tracked file missing: the checkout was not finished');
    assert.equal(workspaceState(repo.path, dir), 'complete', 'without a base the content is not looked at (a role may have edited it)');
    real(dir, ['checkout', '-q', '--', 'src/app.js']);
    // At another commit than the base.
    const other = commitOnRef(repo.path, null, { 'c.txt': 'c\n' }, { parent: repo.head });
    assert.equal(workspaceState(repo.path, dir, other), 'incomplete');
    // What a `worktree add` cut short before its checkout leaves: listed, at the base, and nothing checked out.
    const unfinished = join(repo.path, '..', 'ws-unfinished');
    addWorktreeUnfinished(repo.path, unfinished, repo.head);
    assert.ok(listed(repo.path, unfinished) && !prunable(), 'git lists it as a worktree like any other');
    assert.equal(real(unfinished, ['rev-parse', 'HEAD']), repo.head);
    assert.ok(existsSync(join(unfinished, '.git')) && !existsSync(join(unfinished, 'README.md')) && !existsSync(join(unfinished, 'src')), 'its directory holds the link and no tracked file');
    assert.notEqual(real(unfinished, ['status', '--porcelain', '--untracked-files=no']), '', 'git reports every tracked file missing');
    assert.equal(workspaceState(repo.path, unfinished, repo.head), 'incomplete');
    removeWorktreeByHand(repo.path, unfinished);
    assert.equal(workspaceState(repo.path, unfinished), 'absent');

    removeWorktreeDirectory(repo.path, dir);
    assert.equal(workspaceState(repo.path, dir, repo.head), 'metadata_only');
    assert.ok(!existsSync(dir) && prunable(), 'git would prune the entry: its directory is gone');
    assert.ok(worktreeList(repo.path).find((w) => w.path === dir).prunable);
    removeWorktreeByHand(repo.path, dir);
    assert.equal(workspaceState(repo.path, dir, repo.head), 'absent');
    assert.ok(!listed(repo.path, dir) && !prunable());
    assert.throws(() => removeWorktreeDirectory(repo.path, dir), /no worktree metadata/);
    assert.throws(() => removeWorktreeMetadata(repo.path, dir), /no worktree metadata/);

    addWorktreeByHand(repo.path, dir, repo.head);
    removeWorktreeMetadata(repo.path, dir);
    assert.equal(workspaceState(repo.path, dir, repo.head), 'directory_only');
    assert.ok(existsSync(join(dir, '.git')) && !listed(repo.path, dir), 'the directory with its link is there, and git lists no worktree for it');
    assert.ok(realFails(dir, ['rev-parse', 'HEAD']), 'git cannot use the directory');
    removeWorktreeByHand(repo.path, dir);
    assert.equal(workspaceState(repo.path, dir), 'absent');

    const planted = foreignDirectory(dir);
    assert.equal(workspaceState(repo.path, dir, repo.head), 'foreign');
    assert.equal(readFileSync(planted.file, 'utf8'), planted.content);
    assert.ok(!listed(repo.path, dir));
    rmSync(dir, { recursive: true });
    writeFileSync(dir, 'a file where a workspace would be\n');
    assert.equal(workspaceState(repo.path, dir), 'foreign');
    rmSync(dir);
    symlinkSync(repo.path, dir);
    assert.equal(workspaceState(repo.path, dir), 'foreign', 'a link is not followed');
    rmSync(dir);
    // Another repository's worktree at the path is not this repository's.
    const stranger = repoAt();
    addWorktreeByHand(stranger.path, dir, stranger.head);
    assert.equal(workspaceState(repo.path, dir), 'foreign');
    assert.equal(workspaceState(stranger.path, dir, stranger.head), 'complete');
    removeWorktreeByHand(stranger.path, dir);

    // A worktree on a branch is not the detached workspace the engine makes.
    addLinkedWorktree(repo.path, dir, { branch: 'topic', at: repo.head });
    assert.equal(workspaceState(repo.path, dir, repo.head), 'incomplete');
    removeWorktreeByHand(repo.path, dir);
    assert.equal(workspaceState(repo.path, dir), 'absent');
  });

  await check('repos: git processes are found by what their command line names, and a held call that is let go finishes, every time', async () => {
    const repo = repoAt();
    for (let round = 0; round < 12; round++) {
      const dir = join(repo.path, '..', `held-selfcheck-${round}`);
      const letGo = holdGit(repo.path);
      const child = spawn('git', ['-C', repo.path, 'worktree', 'add', '-q', '--detach', dir, repo.head], { env: gitEnv(repo.path), stdio: 'ignore' });
      const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
      try {
        await waitFor(() => gitProcessesNaming(dir).length === 1, { timeoutMs: 10_000, what: 'the held git call is running' });
        assert.deepEqual(gitProcessesNaming(dir).map((p) => p.pid), [child.pid]);
        assert.deepEqual(gitProcessesNaming(`${dir}-none`), []);
        await sleep(100);
        assert.equal(child.exitCode, null, 'it waits while the repository is held');
        assert.equal(existsSync(dir), false, 'and has made nothing');
        letGo();
        const status = await Promise.race([exited, sleep(15_000).then(() => 'still running 15 s after it was let go')]);
        assert.deepEqual(status, { code: 0, signal: null }, `round ${round}`);
      } finally {
        letGo();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      assert.equal(workspaceState(repo.path, dir, repo.head), 'complete', 'the call it held then did its work');
      assert.deepEqual(gitProcessesNaming(dir), []);
      assert.equal(real(repo.path, ['config', '--get', 'core.bare']), 'false', 'the configuration is a file again');
    }
  });

  // A context as ../probes.mjs `observe` builds it, over a real repository and no engine.
  const fakeContext = (kind) => {
    const repo = repoAt({ files: { 'src/app.js': 'export const answer = 1;\n' } });
    // The developer's worktree: the repository has worktree metadata of its own, as in the tests.
    addLinkedWorktree(repo.path, join(repo.path, '..', 'developer'), { at: repo.head });
    const run = { id: newId('run_') };
    const ctx = { kind, repo: repo.path, project: { base: repo.head, repo }, run, workspace: join(repo.path, '..', 'workspaces', run.id), fx: { beforeCleanup: [] } };
    mkdirSync(join(repo.path, '..', 'workspaces'));
    if (kind === 'ref_update') {
      const made = commitOnRef(repo.path, null, { 'src/app.js': 'export const answer = 42;\n' }, { parent: repo.head, message: 'surety: a run' });
      ctx.target = { ref: repo.ref, old: repo.head, new: made };
    }
    if (kind === 'commit_tree') {
      ctx.sha = commitOnRef(repo.path, null, { 'src/app.js': 'export const answer = 42;\n' }, { parent: repo.head, message: `surety: a run\n\nSurety-Run: ${run.id}` });
      ctx.keep = [`refs/surety/keep/${run.id}`];
      gitQuiet(repo.path, ['update-ref', ctx.keep[0], ctx.sha]);
    }
    return ctx;
  };

  await check('probe fixtures: for a ref update, each arranged outcome is what real git then holds', () => {
    for (const outcome of OUTCOMES) {
      const ctx = fakeContext('ref_update');
      const { ref, old, new: sha } = ctx.target;
      const made = arrange(ctx, outcome);
      if (outcome === 'absent') assert.deepEqual([real(ctx.repo, ['rev-parse', ref]), effectOf(ctx)], [old, 'absent']);
      if (outcome === 'applied') assert.deepEqual([real(ctx.repo, ['rev-parse', ref]), effectOf(ctx)], [sha, 'applied']);
      if (outcome === 'conflicting') {
        const at = real(ctx.repo, ['rev-parse', ref]);
        assert.ok(at !== old && at !== sha && at === ctx.third, 'the ref is at a third commit');
        assert.deepEqual(parentsOf(ctx.repo, at), [old]);
        assert.match(effectOf(ctx), /^the ref is at /);
      }
      if (outcome === 'unknown') {
        assert.ok(realFails(ctx.repo, ['rev-parse', ref]), 'git cannot read the ref');
        assert.equal(ctx.fx.beforeCleanup.length, 1, 'access is restored at cleanup whatever the test does');
        made.undo();
        assert.equal(real(ctx.repo, ['rev-parse', ref]), old);
      }
      if (outcome === 'partial') {
        assert.deepEqual(made.args, ['--harness-probe', 'ref_update=partial'], 'git cannot hold it: the probe is told to claim it');
        assert.equal(real(ctx.repo, ['rev-parse', ref]), old, 'and git is left as it was');
      } else assert.deepEqual(made.args, []);
    }
  });

  await check('probe fixtures: for a commit, each arranged outcome is what real git then holds', () => {
    for (const outcome of OUTCOMES) {
      const ctx = fakeContext('commit_tree');
      const [keep] = ctx.keep;
      assert.equal(effectOf(ctx), 'applied', 'as the effect left it');
      const made = arrange(ctx, outcome);
      assert.deepEqual(made.args, []);
      const has = () => !realFails(ctx.repo, ['cat-file', '-e', `${ctx.sha}^{commit}`]);
      const keepAt = () => (realFails(ctx.repo, ['rev-parse', '--verify', '-q', keep]) ? null : real(ctx.repo, ['rev-parse', '--verify', '-q', keep]));
      if (outcome === 'applied') assert.deepEqual([has(), keepAt(), effectOf(ctx)], [true, ctx.sha, 'applied']);
      if (outcome === 'absent') assert.deepEqual([has(), keepAt(), effectOf(ctx)], [false, null, 'absent']);
      if (outcome === 'partial') {
        assert.deepEqual([has(), keepAt()], [true, null], 'the object without its keep ref');
        assert.match(effectOf(ctx), /keep refs none/);
      }
      if (outcome === 'conflicting') {
        assert.deepEqual([has(), keepAt()], [true, ctx.project.base], 'the keep ref at another commit');
        assert.match(effectOf(ctx), /keep refs none/);
      }
      if (outcome === 'unknown') {
        assert.ok(realFails(ctx.repo, ['cat-file', '-e', ctx.sha]), 'git cannot read the object');
        made.undo();
        made.undo();
        assert.deepEqual([has(), keepAt(), effectOf(ctx)], [true, ctx.sha, 'applied']);
      }
    }
  });

  for (const kind of ['worktree_add', 'worktree_remove']) {
    await check(`probe fixtures: for ${kind}, each arranged outcome is what real git then holds`, () => {
      const there = kind === 'worktree_add' ? 'applied' : 'absent';
      const notThere = kind === 'worktree_add' ? 'absent' : 'applied';
      for (const start of ['nothing', 'worktree']) {
        for (const outcome of OUTCOMES) {
          const ctx = fakeContext(kind);
          if (start === 'worktree') addWorktreeByHand(ctx.repo, ctx.workspace, ctx.project.base);
          const made = arrange(ctx, outcome);
          assert.deepEqual(made.args, []);
          const what = `${kind} ${outcome} from ${start}`;
          if (outcome === there) {
            assert.ok(listed(ctx.repo, ctx.workspace) && real(ctx.workspace, ['rev-parse', 'HEAD']) === ctx.project.base, what);
            assert.equal(real(ctx.workspace, ['status', '--porcelain']), '', what);
            assert.equal(effectOf(ctx), there, what);
          }
          if (outcome === notThere) {
            assert.ok(!listed(ctx.repo, ctx.workspace) && !existsSync(ctx.workspace), what);
            assert.equal(effectOf(ctx), notThere, what);
          }
          if (outcome === 'partial') {
            assert.ok(listed(ctx.repo, ctx.workspace) && !existsSync(ctx.workspace), `${what}: git still lists a worktree whose directory is gone`);
            assert.equal(effectOf(ctx), 'metadata_only', what);
          }
          if (outcome === 'conflicting') {
            assert.ok(!listed(ctx.repo, ctx.workspace) && existsSync(ctx.foreign.file) && !existsSync(join(ctx.workspace, '.git')), what);
            assert.equal(effectOf(ctx), 'foreign', what);
          }
          if (outcome === 'unknown' && process.getuid() !== 0) {
            assert.ok(!listed(ctx.repo, ctx.workspace) || realFails(ctx.repo, ['worktree', 'list']), `${what}: git cannot see the repository's worktrees`);
            assert.equal(ctx.fx.beforeCleanup.length, 1);
            made.undo();
            assert.equal(listed(ctx.repo, ctx.workspace), start === 'worktree', `${what}: restored, the repository is as it was`);
          } else if (outcome === 'unknown') made.undo();
        }
        if (kind === 'worktree_add') {
          // The second form of `partial`: the checkout not finished.
          const ctx = fakeContext(kind);
          if (start === 'worktree') addWorktreeByHand(ctx.repo, ctx.workspace, ctx.project.base);
          assert.deepEqual(arrange(ctx, 'partial', 'unfinished_checkout').args, []);
          assert.ok(listed(ctx.repo, ctx.workspace) && real(ctx.workspace, ['rev-parse', 'HEAD']) === ctx.project.base, 'git lists the worktree at the base');
          assert.ok(!existsSync(join(ctx.workspace, 'README.md')) && real(ctx.workspace, ['status', '--porcelain', '--untracked-files=no']) !== '', 'and nothing is checked out in it');
          assert.equal(effectOf(ctx), 'incomplete');
        } else assert.throws(() => arrange(fakeContext(kind), 'partial', 'unfinished_checkout'), /no form unfinished_checkout/);
      }
    });
  }

  // ---- 16. operations, attempts and the state projection ------------------------------

  const scratch = () => {
    const home = mkdtempSync(join(work, 's3b-home-'));
    const db = new Database(join(home, 'store.db'));
    db.pragma('foreign_keys = ON');
    db.exec(WITNESS3B);
    const project = newId('proj_');
    db.prepare('INSERT INTO projects (id, created_at, name) VALUES (?, ?, ?)').run(project, isoNow(), 'selfcheck');
    return { home, db, project };
  };
  let opSeq = 0;
  // An operation as the engine would have written it: its journal events, its
  // state projection, its attempts and its events in the log. `tweak` builds
  // one defect in.
  const writeOperation = (db, project, { journalKind = 'ref_update', events = JOURNAL.ordinary_events, attempts = [['succeeded']], status = 'succeeded', run = 'run_A', linkedPrior = null, tweak = {} } = {}) => {
    const id = newId('op_');
    const finalized = tweak.finalizedAt !== undefined ? tweak.finalizedAt : events.at(-1) === 'finalized';
    db.prepare(
      `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, linked_prior, deadline_at, finalized_at) VALUES (?, ?, ?, ?, ?, '{}', '{}', ?, 1, ?, ?, ?, ?)`,
    ).run(id, isoNow(), project, ++opSeq, tweak.kind ?? JOURNAL.kinds[journalKind].operation_kind, `key-${opSeq}`, status, linkedPrior, isoNow(), finalized ? isoNow() : null);
    events.forEach((eventKind, i) => {
      const seq = tweak.seqGap && i === events.length - 1 ? i + 2 : i + 1;
      db.prepare('INSERT INTO git_journal_events (id, created_at, project, operation, seq, journal_kind, event_kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        newId('gje_'), isoNow(), project, id, seq, tweak.mixedKinds && i === 1 ? 'commit_tree' : journalKind, eventKind, JSON.stringify({ repo: 'r', run }),
      );
      if (eventKind !== 'failed' && !(tweak.unlogged === eventKind)) emit(db, `git.journal_${eventKind}`, { operation: id, project });
      if (tweak.loggedTwice === eventKind) emit(db, `git.journal_${eventKind}`, { operation: id, project });
    });
    if (tweak.projection !== 'none') {
      const lag = tweak.projection === 'lags' ? 1 : 0;
      db.prepare('INSERT INTO git_journal_state (id, created_at, project, operation, journal_kind, state, last_event_seq) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        newId('gjs_'), isoNow(), project, id, journalKind, events.at(-1 - lag), events.length - lag,
      );
    }
    attempts.forEach(([attemptStatus, reads], i) => {
      const row = seedAttempt(db, project, id, tweak.attemptGap && i > 0 ? i + 2 : i + 1, attemptStatus);
      if (reads) db.prepare('UPDATE operation_attempts SET reconciliation_reads = ? WHERE id = ?').run(JSON.stringify(reads), row.id);
    });
    return id;
  };
  const READ = (result) => [{ at: isoNow(), result }];
  // Histories an engine that follows the tables leaves.
  const SOUND = {
    'the ordinary course': {},
    'intended, nothing issued yet': { events: ['intended'], attempts: [], status: 'intended' },
    'in flight': { events: ['intended'], attempts: [['started']], status: 'in_progress' },
    'refused before anything was applied': { events: ['intended', 'failed'], attempts: [['failed']], status: 'failed' },
    'blocked': { events: ['intended', 'ambiguous'], attempts: [['ambiguous', READ('unknown')]], status: 'ambiguous' },
    'blocked with no attempt': { events: ['intended', 'ambiguous'], attempts: [], status: 'ambiguous' },
    'found applied by recovery': { events: ['intended', 'applied', 'confirmed', 'finalized'], attempts: [['reconciled_succeeded', READ('applied')]] },
    'found applied before any attempt': { events: ['intended', 'applied', 'confirmed', 'finalized'], attempts: [] },
    'reconciled absent, before the retry': { events: ['intended', 'ambiguous'], attempts: [['reconciled_absent', READ('absent')]], status: 'intended' },
    'retried after reconciled absence': { events: ['intended', 'ambiguous', 'applied', 'confirmed', 'finalized'], attempts: [['reconciled_absent', READ('absent')], ['succeeded']] },
    'reconciled partial, before its completion': { events: ['intended', 'ambiguous'], attempts: [['reconciled_partial', READ('partial')]], status: 'partial' },
    'completed after reconciled partial': { journalKind: 'worktree_remove', events: ['intended', 'ambiguous', 'applied', 'confirmed', 'finalized'], attempts: [['reconciled_partial', READ('partial')], ['succeeded']] },
    'withdrawn': { journalKind: 'worktree_add', events: ['intended', 'failed'], attempts: [['reconciled_absent', READ('absent')]], status: 'failed' },
    'blocked, then found applied': { events: ['intended', 'ambiguous', 'applied', 'confirmed', 'finalized'], attempts: [['reconciled_succeeded', [...READ('unknown'), ...READ('applied')]]] },
  };
  await check('operation reads: histories that follow the tables pass assertOperation, with their events in the log', () => {
    const { home, db, project } = scratch();
    const ids = Object.entries(SOUND).map(([name, spec]) => [name, writeOperation(db, project, spec)]);
    db.close();
    for (const [name, id] of ids) {
      const op = operationDetail(home, id);
      assertOperation(op, name);
      assert.equal(op.status, SOUND[name].status ?? 'succeeded', name);
      assert.equal(op.journal_kind, SOUND[name].journalKind ?? 'ref_update');
      assert.deepEqual(op.events.map((e) => e.kind), SOUND[name].events ?? JOURNAL.ordinary_events);
      assert.deepEqual(op.attempts.map((a) => a.status), (SOUND[name].attempts ?? [['succeeded']]).map(([s]) => s));
    }
    assert.equal(assertOperations(home, { project }).length, ids.length);
    assert.deepEqual(operationDetail(home, ids.find(([name]) => name === 'blocked, then found applied')[1]).attempts[0].reads.map((x) => x.result), ['unknown', 'applied']);
  });

  const UNSOUND = [
    ['a journal that skips the receipt', { events: ['intended', 'confirmed', 'finalized'] }, /intended → confirmed is not a legal journal transition/],
    ['a journal that goes on after it is finalized', { events: [...JOURNAL.ordinary_events, 'applied'], status: 'succeeded', tweak: { finalizedAt: true } }, /finalized → applied/],
    ['a journal with a gap in its numbering', { tweak: { seqGap: true } }, /numbered from 1 without a gap/],
    ['events of two journal kinds', { tweak: { mixedKinds: true } }, /every event carries the operation's journal kind/],
    ['a journal on an operation of another kind', { tweak: { kind: 'git_commit' } }, /belongs to a git_ref_update operation/],
    ['no state projection', { tweak: { projection: 'none' } }, /the state projection is one row/],
    ['a state projection that lags the journal', { tweak: { projection: 'lags' } }, /the state projection is one row/],
    ['attempt numbers with a gap', { events: ['intended', 'ambiguous', 'applied', 'confirmed', 'finalized'], attempts: [['reconciled_absent', READ('absent')], ['succeeded']], tweak: { attemptGap: true } }, /attempts are numbered from 1 without a gap/],
    ['a retry after a failed attempt', { attempts: [['failed'], ['succeeded']] }, /admitted after attempt 1 was failed/],
    ['a retry after an ambiguous attempt', { attempts: [['ambiguous'], ['succeeded']] }, /admitted after attempt 1 was ambiguous/],
    ['a retry while the first attempt is in flight', { attempts: [['started'], ['succeeded']] }, /admitted after attempt 1 was started/],
    ['a second attempt after a success', { attempts: [['succeeded'], ['succeeded']] }, /admitted after attempt 1 was succeeded/],
    ['a retry after the effect was found applied', { attempts: [['reconciled_succeeded', READ('applied')], ['succeeded']] }, /admitted after attempt 1 was reconciled_succeeded/],
    ['an attempt status nobody knows', { events: ['intended'], attempts: [['done']], status: 'in_progress' }, /has a known status \(done\)/],
    ['a reconciled attempt with no read recorded', { events: ['intended', 'ambiguous'], attempts: [['reconciled_absent']], status: 'intended' }, /records what the probe found/],
    ['a reconciled attempt whose read names no outcome', { events: ['intended', 'ambiguous'], attempts: [['reconciled_absent', READ('gone')]], status: 'intended' }, /records what the probe found/],
    ['succeeded while its attempt is ambiguous', { events: ['intended', 'ambiguous'], attempts: [['ambiguous']], status: 'succeeded' }, /its status is the one its latest attempt \(ambiguous\)/],
    ['failed while its retry is allowed', { events: ['intended', 'ambiguous'], attempts: [['reconciled_absent', READ('absent')]], status: 'failed' }, /its status is the one/],
    ['in progress with no attempt', { events: ['intended'], attempts: [], status: 'in_progress' }, /its status is the one its latest attempt \(none\)/],
    ['superseded with no successor', { events: ['intended', 'failed'], attempts: [['failed']], status: 'superseded' }, /its status is the one/],
    ['finalized_at set before the journal is finalized', { events: ['intended', 'applied', 'confirmed'], tweak: { finalizedAt: true } }, /finalized_at is set exactly when the journal is finalized/],
    ['a finalized journal with no finalized_at', { tweak: { finalizedAt: false } }, /finalized_at is set exactly when the journal is finalized/],
  ];
  for (const [name, spec, message] of UNSOUND) {
    await check(`operation reads mutant fails: ${name}`, () => {
      const { home, db, project } = scratch();
      const id = writeOperation(db, project, spec);
      db.close();
      assert.throws(() => assertOperation(operationDetail(home, id), name), message);
      assert.throws(() => assertOperations(home, { project }), message);
    });
  }
  await check('operation reads mutant fails: an operation that does not exist, and one that is its own successor', () => {
    assert.throws(() => assertOperation(undefined, 'missing'), /exists/);
    const { home, db, project } = scratch();
    const id = writeOperation(db, project, {});
    db.close();
    assert.throws(() => assertOperation({ ...operationDetail(home, id), linked_prior: id }), /not its own successor/);
  });

  await check('operation reads: a successor makes the operation it names superseded, and only then', () => {
    const { home, db, project } = scratch();
    const failed = writeOperation(db, project, { events: ['intended', 'failed'], attempts: [['failed']], status: 'superseded' });
    const again = writeOperation(db, project, { linkedPrior: failed });
    const alone = writeOperation(db, project, { events: ['intended', 'failed'], attempts: [['failed']], status: 'failed', run: 'run_B' });
    db.close();
    assert.deepEqual([operationDetail(home, failed).successor, operationDetail(home, again).successor, operationDetail(home, alone).successor], [true, false, false]);
    assert.equal(operationDetail(home, again).linked_prior, failed);
    assertOperations(home, { project });
    // The same store with the first one left `failed` is refused.
    const second = scratch();
    const stale = writeOperation(second.db, second.project, { events: ['intended', 'failed'], attempts: [['failed']], status: 'failed' });
    writeOperation(second.db, second.project, { linkedPrior: stale });
    second.db.close();
    assert.throws(() => assertOperations(second.home, { project: second.project }), /its status is the one .* successor \(true\)/);
  });

  await check('operation reads: operations are filtered by run and journal kind, and come with the blockers that name them', () => {
    const { home, db, project } = scratch();
    const add = writeOperation(db, project, { journalKind: 'worktree_add', run: 'run_A' });
    const blocked = writeOperation(db, project, { journalKind: 'ref_update', run: 'run_A', events: ['intended', 'ambiguous'], attempts: [['ambiguous', READ('conflicting')]], status: 'ambiguous' });
    const other = writeOperation(db, project, { journalKind: 'worktree_add', run: 'run_B' });
    const decision = (seq, subjectType, subjectId, status) =>
      db
        .prepare(
          `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status)
           VALUES (?, ?, ?, ?, 'blocker', ?, ?, 1, 's', 'q?', '[]', '{}', 1, 'h', '[]', ?, ?, ?)`,
        )
        .run(newId('dec_'), isoNow(), project, seq, subjectType, subjectId, JSON.stringify({ operations: [subjectId] }), isoNow(), status);
    decision(1, 'operation', blocked, 'invalidated');
    decision(2, 'operation', blocked, 'open');
    decision(3, 'work_item', 'wi_X', 'open');
    db.close();
    assert.deepEqual(operationDetails(home, { project }).map((op) => op.id), [add, blocked, other], 'oldest first');
    assert.deepEqual(operationDetails(home, { project, run: 'run_A' }).map((op) => op.id), [add, blocked]);
    assert.deepEqual(operationDetails(home, { project, journalKind: 'worktree_add' }).map((op) => op.id), [add, other]);
    assert.deepEqual(operationDetails(home, { project, run: 'run_B', journalKind: 'ref_update' }), []);
    assert.deepEqual(operationDetails(home, { project: newId('proj_') }), []);
    const op = operationDetail(home, blocked);
    assert.deepEqual(op.blockers.map((d) => d.status), ['invalidated', 'open'], 'only the blocker decisions whose subject is the operation');
    assert.deepEqual(op.blockers[1].blocked_while_open, { operations: [blocked] });
    assert.deepEqual(operationDetail(home, add).blockers, []);
    assert.deepEqual([op.payload.run, op.state, op.finalized, op.projection], ['run_A', 'ambiguous', false, [{ journal_kind: 'ref_update', state: 'ambiguous', last_event_seq: 2 }]]);
  });

  await check('operation reads: the event log must hold one journal event for each journal row but `failed`, in order', () => {
    for (const [tweak, sound] of [[{}, true], [{ unlogged: 'applied' }, false], [{ loggedTwice: 'confirmed' }, false], [{ unlogged: 'intended' }, false]]) {
      const { home, db, project } = scratch();
      writeOperation(db, project, { tweak });
      writeOperation(db, project, { events: ['intended', 'failed'], attempts: [['failed']], status: 'failed' });
      db.close();
      if (sound) assertOperations(home, { project });
      else assert.throws(() => assertOperations(home, { project }), /the event log holds one git\.journal_\* event for each of its journal events, in order/, JSON.stringify(tweak));
    }
  });

  await check('store: a second attempt with the number of an existing one is refused by the witness schema', () => {
    const { db, project } = scratch();
    const id = writeOperation(db, project, { events: ['intended'], attempts: [['started']], status: 'in_progress' });
    assert.throws(() => seedAttempt(db, project, id, 1, 'started'), /UNIQUE/);
    seedAttempt(db, project, id, 2, 'started');
    db.close();
  });

  await check('receipt snapshot: the same store reads the same, and a row written or rewritten by a finalizer run again makes it differ', () => {
    const { home, db, project } = scratch();
    const id = writeOperation(db, project, {});
    db.prepare(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, ?, 'refs/heads/main', NULL, 1)`).run(isoNow(), project);
    db.prepare(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_1', ?, ?, 1, 'rev_1', 'lin_1', ?, 'engine_cadence', 'nominated')`).run(isoNow(), project, isoNow());
    db.prepare(`INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES ('ref_1', ?, ?, 'refs/heads/main', 'integration', ?, 0)`).run(isoNow(), project, 'a'.repeat(40));
    db.close();
    const before = receiptSnapshot(home, project);
    assert.deepEqual(receiptSnapshot(home, project), before);
    assert.deepEqual([before.operations.length, before.journal.length, before.projection.length, before.attempts.length, before.candidates.length, before.lineages.length, before.registry.length], [1, 4, 1, 1, 1, 1, 1]);
    const changes = [
      ['a journal event appended', (d) => d.prepare(`INSERT INTO git_journal_events (id, created_at, project, operation, seq, journal_kind, event_kind, payload) VALUES ('gje_x', ?, ?, ?, 5, 'ref_update', 'finalized', '{}')`).run(isoNow(), project, id)],
      ['an attempt added', (d) => seedAttempt(d, project, id, 2, 'started')],
      ['the registry moved', (d) => d.prepare(`UPDATE ref_registry SET expected_oid = ? WHERE project = ?`).run('b'.repeat(40), project)],
      ['a second candidate', (d) => d.prepare(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_2', ?, ?, 2, 'rev_1', 'lin_1', ?, 'engine_cadence', 'nominated')`).run(isoNow(), project, isoNow())],
      ['the candidate written again under a new id', (d) => d.prepare(`UPDATE candidates SET id = 'cand_9' WHERE id = 'cand_1'`).run()],
      ['a lineage closed', (d) => d.prepare(`UPDATE lineages SET open = 0 WHERE project = ?`).run(project)],
      ['the operation finalized again, later', (d) => d.prepare(`UPDATE operations SET finalized_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`).run(id)],
      ['the projection moved', (d) => d.prepare(`UPDATE git_journal_state SET last_event_seq = 9 WHERE operation = ?`).run(id)],
      ['a work event written again', (d) => emit(d, 'work.advanced', { work_item: 'wi_X', project }, { from: 'integrating', to: 'integrated' })],
    ];
    for (const [name, change] of changes) {
      const again = new Database(join(home, 'store.db'));
      again.exec('SAVEPOINT s');
      change(again);
      again.exec('RELEASE s');
      again.close();
      assert.notDeepEqual(receiptSnapshot(home, project), before, name);
    }
    assert.deepEqual(receiptSnapshot(home, newId('proj_')).operations, [], 'another project has none of it');
  });

  // ---- 17. the fault matrix through integration ---------------------------------------

  const integrated = ({ move = true, registryAt, observed = 0, projection = true } = {}) => {
    const { home, db } = scratch();
    const repo = repoAt({ files: { 'src/app.js': 'export const answer = 1;\n' } });
    const project = { id: newId('proj_'), repo: { path: repo.path, ref: repo.ref }, base: repo.head };
    db.prepare('INSERT INTO projects (id, created_at, name, dev_repo_path) VALUES (?, ?, ?, ?)').run(project.id, isoNow(), 'git-selfcheck', repo.path);
    const sha = commitOnRef(repo.path, move ? repo.ref : null, { 'src/app.js': 'export const answer = 42;\n' }, { parent: repo.head, message: 'surety: a run' });
    db.prepare(`INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES (?, ?, ?, ?, 'integration', ?, 0)`).run(newId('ref_'), isoNow(), project.id, repo.ref, registryAt ?? (move ? sha : repo.head));
    db.prepare(`INSERT INTO revisions (id, created_at, project, sha, parent_sha, kind, created_by_run, recorded_at) VALUES (?, ?, ?, ?, ?, 'stage_commit', NULL, ?)`).run(newId('rev_'), isoNow(), project.id, sha, repo.head, isoNow());
    const ids = [
      writeOperation(db, project.id, { journalKind: 'worktree_add' }),
      writeOperation(db, project.id, { journalKind: 'commit_tree' }),
      writeOperation(db, project.id, move ? { journalKind: 'ref_update', tweak: { projection: projection ? undefined : 'none' } } : { journalKind: 'ref_update', events: ['intended', 'failed'], attempts: [['failed']], status: 'failed' }),
    ];
    if (observed > 0) {
      db.prepare(
        `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status)
         VALUES ('dec_oob', ?, ?, 1, 'out_of_band_change', 'out_of_band_change', 'oob_1', 1, 's', 'q?', '[]', '{}', 1, 'h', '[]', '{}', ?, 'open')`,
      ).run(isoNow(), project.id, isoNow());
      db.prepare(`INSERT INTO out_of_band_changes (id, created_at, project, subject_kind, ref, checkout, expected, found, detected_at, disposition, decision) VALUES ('oob_1', ?, ?, 'ref', NULL, NULL, ?, NULL, ?, NULL, 'dec_oob')`).run(isoNow(), project.id, repo.head, isoNow());
    }
    db.close();
    const git = gitFacts({ home }, project);
    // The run's operations as ../endings.mjs `projectFacts` lists them for the ending's own run.
    const operations = ids.map((id) => operationDetail(home, id)).map((op) => ({ journal_kind: op.journal_kind, status: op.status }));
    return { facts: { runs: [{ operations }], git }, sha, repo };
  };

  await check('matrix git facts: what the repository and the journal hold, with no id, commit id or timestamp in it', () => {
    const a = integrated();
    const b = integrated();
    assert.deepEqual(a.facts.git, b.facts.git, 'two repositories with the same history give the same facts');
    const text = JSON.stringify(a.facts.git);
    assert.ok(!/[0-9a-f]{40}/.test(text) && !/\d{4}-\d{2}-\d{2}T/.test(text) && !/op_[0-9A-Z]{26}/.test(text), text);
    assert.equal(a.facts.git.commits, Number(execFileSync('git', ['-C', a.repo.path, 'rev-list', '--count', `${a.repo.head}..${a.repo.ref}`], { env: gitEnv(a.repo.path), encoding: 'utf8' })));
    assert.deepEqual([a.facts.git.commits, Object.keys(a.facts.git.changed), a.facts.git.registry, a.facts.git.out_of_band], [1, ['src/app.js'], ['integration mutable as expected'], 0]);
    assert.deepEqual(a.facts.git.operations.map((op) => [op.journal.at(-1), op.projection, op.attempts, op.status]), [
      ['worktree_add finalized', ['finalized 4'], ['succeeded'], 'succeeded'],
      ['commit_tree finalized', ['finalized 4'], ['succeeded'], 'succeeded'],
      ['ref_update finalized', ['finalized 4'], ['succeeded'], 'succeeded'],
    ]);
    const refused = integrated({ move: false });
    assert.deepEqual([refused.facts.git.commits, refused.facts.git.changed, refused.facts.git.registry], [0, {}, ['integration mutable as expected']]);
    assert.notDeepEqual(refused.facts.git, a.facts.git);
  });

  await check('matrix expectations: what the table says of "integrates" passes for an integrated run, and each departure from it fails', () => {
    const spec = ENDINGS.integrates;
    assertIntegrationExpectations(integrated().facts, spec, 'witness');
    assert.throws(() => assertIntegrationExpectations(integrated({ move: false }).facts, spec, 'witness'), /the run's journaled operations and their statuses/);
    const noCommit = integrated();
    noCommit.facts.git.commits = 0;
    assert.throws(() => assertIntegrationExpectations(noCommit.facts, spec, 'witness'), /the commits the integration branch gained/);
    assert.throws(() => assertIntegrationExpectations(integrated({ registryAt: 'c'.repeat(40) }).facts, spec, 'witness'), /every registered ref is where the registry expects it/);
    assert.throws(() => assertIntegrationExpectations(integrated({ observed: 1 }).facts, spec, 'witness'), /nothing was observed out of band/);
    assert.throws(() => assertIntegrationExpectations(integrated({ projection: false }).facts, spec, 'witness'), /each operation has one state projection/);
    const extra = integrated();
    extra.facts.runs[0].operations.push({ journal_kind: 'ref_update', status: 'succeeded' });
    assert.throws(() => assertIntegrationExpectations(extra.facts, spec, 'witness'), /the run's journaled operations and their statuses/);
    // The stop ending expects the refused update and no commit.
    const stopped = { ...ENDINGS.stop_integrating };
    assertIntegrationExpectations(integrated({ move: false }).facts, stopped, 'witness');
    assert.throws(() => assertIntegrationExpectations(integrated().facts, stopped, 'witness'), /the run's journaled operations and their statuses/);
  });
}
