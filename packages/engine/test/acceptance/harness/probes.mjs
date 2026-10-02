// The probe and crash rows of the journal (rows M29 to M33; SEAM.md §§45, 46;
// ../contract/journal.json `durable`, `recovery`, `probe`).
//
// One scenario per journal kind brings one operation of that kind under way:
// the workspace of a dispatch (worktree_add), the commit of a Builder's run
// (commit_tree), its integration (ref_update), the discarding of an abandoned
// run's workspace (worktree_remove). The engine is killed at a barrier, the
// store is reopened and real git inspected, git is put by hand into the state
// a probe outcome names, and the engine is started again: what recovery then
// makes of the operation is compared with what the contract table says that
// outcome must lead to. Nothing here asks the engine what is legal.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { releaseBarrier, waitFor, within } from './engine.mjs';
import { assertRefused } from './fixtures.mjs';
import { addGitProject, addItem, roleThat } from './gitruns.mjs';
import { assertWorkHistory, eventsAbout } from './invariants.mjs';
import {
  JOURNAL,
  PROBE,
  assertCommitted,
  assertOperation,
  assertOperations,
  journalBarrier,
  operationDetail,
  operationDetails,
  outOfBand,
  probeFlag,
  receiptSnapshot,
  registryOf,
  revisionsOf,
} from './journal.mjs';
import {
  addLinkedWorktree,
  addWorktreeByHand,
  changedPaths,
  commitOnRef,
  commitsNaming,
  deleteLooseObject,
  foreignDirectory,
  gitQuiet,
  holdGit,
  makePartUnreadable,
  makeUnreadable,
  parentsOf,
  refOid,
  refsOf,
  removeWorktreeByHand,
  removeWorktreeDirectory,
  snapshotTree,
  treeOf,
  worktreeList,
  workspaceState,
} from './repos.mjs';
import {
  addWork,
  answerDecision,
  assertRunEnded,
  countOf,
  decisionsAbout,
  getRow,
  requestTick,
  resolvedPath,
  resumeWork,
  run as runRow,
  runsOf,
  scriptedEngine,
  tick,
  tickUntil,
  waitForRun,
  workItem,
} from './runs.mjs';
import { script, step } from './scripted.mjs';
import { withStore } from './store.mjs';

export const KINDS = Object.keys(JOURNAL.kinds);
export const BOUNDARIES = Object.keys(JOURNAL.boundaries);
export const OUTCOMES = PROBE.outcomes;
export const STATES = PROBE.durable_states.states;

// What the role of launch n writes: one new source file each, so that a
// commit says which launch made it.
export const EDITS = [
  { path: 'src/app.js', content: 'export const answer = 42;\n' },
  { path: 'src/second.js', content: 'export const second = 2;\n' },
  { path: 'src/third.js', content: 'export const third = 3;\n' },
];
const editOf = (n) => step.write(EDITS[n].path, EDITS[n].content);

// How long an engine that was told to kill itself at a barrier is given to
// reach it. An engine that does not know the barrier never gets there.
const KILL_WAIT_MS = 20_000;

// The boundary the engine is killed at to leave an operation in a durable
// state. A commit's identity is the engine's own (its message, its dates), so
// a test cannot make the commit by hand: for `commit_tree` the `intended`
// state is reached after the effect, at `effect_applied`, where the journal
// still holds only the intent, and the other outcomes are made by taking away
// from what the engine made.
export const REACH = {
  ref_update: { intended: 'intent_committed', applied: 'receipt_committed' },
  commit_tree: { intended: 'effect_applied', applied: 'receipt_committed' },
  worktree_add: { intended: 'intent_committed', applied: 'receipt_committed' },
  worktree_remove: { intended: 'intent_committed', applied: 'receipt_committed' },
};

// One case per kind, durable state and outcome, in the table's order.
export function probeCells(kind) {
  if (!(kind in PROBE.kinds)) throw new Error(`no probe table for ${kind}`);
  const cells = [];
  for (const state of STATES) {
    for (const outcome of OUTCOMES) {
      const spec = PROBE.kinds[kind][outcome];
      cells.push({ kind, state, outcome, way: spec.leads_to, means: spec.means, fixture: spec.fixture, title: probeTitle(kind, state, outcome) });
    }
  }
  return cells;
}
const WAY_TEXT = {
  finalize: 'it is confirmed and finalized without the effect being repeated',
  retry: 'it is reconciled absent and retried once, as a new attempt of the same operation',
  complete: 'it is reconciled partial and its bounded remainder completed, as a new attempt of the same operation',
  withdraw: 'it is reconciled and the operation withdrawn: nothing is added for a run that is over, and no residue is left',
  block: 'it blocks, and nothing is retried, finalized or overwritten',
};
export function probeTitle(kind, state, outcome) {
  const spec = PROBE.kinds[kind][outcome];
  return `${kind}, journal ${state}, effect found ${outcome} (${spec.fixture}): ${WAY_TEXT[spec.leads_to]}`;
}
// The way on after a kill at a boundary: what the probe finds of the effect
// there decides it; a confirmed or finalized operation is never probed.
export function crashWay(kind, boundary) {
  const spec = JOURNAL.durable[boundary];
  return ['intent_committed', 'effect_applied', 'receipt_committed'].includes(boundary) ? PROBE.kinds[kind][spec.effect].leads_to : 'finalize';
}
export const crashTitle = (kind, boundary) =>
  crashWay(kind, boundary) === 'withdraw'
    ? `${kind}, killed at ${boundary}: recovery withdraws the operation, adding nothing for a run that is over, and a second restart changes nothing`
    : `${kind}, killed at ${boundary}: recovery finalizes the operation once, with the same receipts after a second restart`;

// ---- the scenarios ---------------------------------------------------------------

// A project whose first run brings an operation of `kind` under way, in an
// engine started with `barriers`. Returns the context without waiting for
// anything: {fx, project, item, kind}.
export async function staged(t, kind, { barriers = [], config = {} } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`no journal kind ${kind}`);
  const fx = await scriptedEngine(t, { barriers, config });
  const project = await addGitProject(fx);
  // The developer's own worktree, detached: the supported topology, and the
  // repository then has worktree metadata before the engine adds any.
  addLinkedWorktree(project.repo.path, join(fx.root, 'developer-detached'), { at: project.base });
  const item = await addItem(fx, project.id, 'fix');
  const usage = step.usage({ input_tokens: 3 });
  const first = kind === 'worktree_remove' ? script.hold('gate', { before: [editOf(0), usage] }) : roleThat([editOf(0), usage]);
  fx.scripted.script(item, [first, roleThat([editOf(1)]), roleThat([editOf(2)])]);
  fx.scripted.defaultScript(script.complete());
  return { fx, project, item, kind, repo: project.repo.path };
}

// Cause the operation: a tick dispatches the item; for a removal the run is
// then abandoned once its role is running. The engine may die before it
// answers, so no response is required.
export async function trigger(ctx) {
  const { fx, project, item, kind } = ctx;
  const engine = fx.engine;
  await requestTick(engine, project.id).catch(() => {});
  if (kind !== 'worktree_remove') return;
  await fx.scripted.waitForHolding({ work_item: item });
  const run = await waitForRun(fx.home, item, { state: 'executing' });
  const path = `/v1/projects/${project.id}/runs/${run.id}/abandon`;
  const first = await engine.post(path, {});
  assertRefused(first, 409, 'confirm_required', 'Abandon without a preview hash');
  await engine.post(path, { preview_hash: first.body.subject.preview_hash }).catch(() => {});
}

// What the dead (or paused) engine left of the operation, read from the
// reopened store and from git.
export function observe(ctx) {
  const { fx, project, item, kind } = ctx;
  const [run] = runsOf(fx.home, item);
  assert.ok(run, 'the item has a run');
  const ops = operationDetails(fx.home, { run: run.id, journalKind: kind });
  assert.equal(ops.length, 1, `exactly one ${kind} operation names the run (found ${ops.length})`);
  ctx.run = run;
  ctx.op = ops[0];
  ctx.workspace = join(fx.home, 'workspaces', run.id);
  if (kind === 'ref_update') ctx.target = { ref: ctx.op.payload.ref, old: ctx.op.payload.old_oid, new: ctx.op.payload.new_oid };
  if (kind === 'commit_tree') {
    const made = commitsNaming(project.repo.path, `Surety-Run: ${run.id}`);
    assert.ok(made.length <= 1, `at most one commit was made for the run (found ${made.join(', ')})`);
    ctx.sha = made[0] ?? null;
    ctx.keep = ctx.sha === null ? [] : keepRefsAt(project.repo.path, ctx.sha);
  }
  return ctx;
}
const keepRefsAt = (repo, sha) =>
  Object.entries(refsOf(repo))
    .filter(([ref, oid]) => ref.startsWith('refs/surety/keep/') && oid === sha)
    .map(([ref]) => ref);

// The scenario in an engine that kills itself at one boundary of the kind's
// journal. Returns the context once the engine is dead.
export async function killedAt(t, kind, boundary, opts = {}) {
  const barrier = journalBarrier(kind, boundary);
  const ctx = await staged(t, kind, { ...opts, barriers: [`${barrier}=kill`] });
  const dead = ctx.fx.engine;
  await trigger(ctx);
  const status = await within(dead.exited, KILL_WAIT_MS);
  assert.deepEqual(status, { code: null, signal: 'SIGKILL' }, `the engine kills itself at ${barrier} (after ${KILL_WAIT_MS} ms it had ${status === null ? 'not exited' : `exited with ${JSON.stringify(status)}`})`);
  ctx.boundary = boundary;
  observe(ctx);
  assert.notEqual(ctx.run.state, 'ended', 'the run had not ended when the engine died');
  return ctx;
}

// What a look at git, with a test's own eyes, finds of the operation's
// effect: 'absent', 'applied', or a description of anything else.
export function effectOf(ctx) {
  const { kind, repo } = ctx;
  if (kind === 'ref_update') {
    const at = refOid(repo, ctx.target.ref);
    return at === ctx.target.new ? 'applied' : at === ctx.target.old ? 'absent' : `the ref is at ${at}`;
  }
  if (kind === 'commit_tree') {
    const made = commitsNaming(repo, `Surety-Run: ${ctx.run.id}`);
    if (made.length === 0) return 'absent';
    return made.length === 1 && keepRefsAt(repo, made[0]).length >= 1 ? 'applied' : `commits ${made.join(', ')}, keep refs ${made.map((sha) => keepRefsAt(repo, sha).join('+') || 'none').join(', ')}`;
  }
  const state = workspaceState(repo, ctx.workspace, kind === 'worktree_add' ? ctx.project.base : undefined);
  if (kind === 'worktree_add') return state === 'complete' ? 'applied' : state;
  return state === 'absent' ? 'applied' : state === 'complete' ? 'absent' : state;
}

// Are the receipts the kind's finalizer writes there (contract `finalizers`)?
export function receiptsWritten(ctx) {
  const { fx, kind, run, project } = ctx;
  return withStore(fx.home, (db) => {
    const ws = db.prepare('SELECT * FROM "workspaces" WHERE "run" = ?').get(run.id);
    if (kind === 'worktree_add') return ws !== undefined;
    if (kind === 'worktree_remove') return ws !== undefined && ws.disposition === 'discarded';
    if (kind === 'commit_tree') return db.prepare('SELECT COUNT(*) AS n FROM "revisions" WHERE "created_by_run" = ?').get(run.id).n > 0;
    const registered = db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(project.id, ctx.target.ref);
    const work = db.prepare('SELECT "status" FROM "work_items" WHERE "id" = ?').get(ctx.item);
    return registered?.expected_oid === ctx.target.new && work.status === 'integrated';
  });
}

// What a store reopened after a kill at the boundary must show, and what git
// must hold (contract `durable`). The finalizer's receipts are there exactly
// when the journal says `finalized`: they commit with it, atomically.
export function assertDurable(ctx) {
  const spec = JOURNAL.durable[ctx.boundary];
  const what = `${ctx.kind} killed at ${ctx.boundary}`;
  const kinds = ctx.op.events.map((e) => e.kind);
  if (spec.exact) assert.deepEqual(kinds, spec.events, `${what}: the journal's durable events`);
  else assert.deepEqual(kinds.slice(0, spec.events.length), spec.events, `${what}: the journal's durable events begin with these (events: ${kinds.join(', ')})`);
  assertOperation(ctx.op, what);
  assert.equal(effectOf(ctx), spec.effect, `${what}: what git holds of the effect`);
  if ('finalized' in spec) assert.equal(ctx.op.finalized, spec.finalized, `${what}: finalized`);
  assert.equal(receiptsWritten(ctx), ctx.op.finalized, `${what}: the finalizer's receipts are there exactly when the journal is finalized`);
}

// ---- outcomes built by hand ------------------------------------------------------

const present = (ctx) => {
  if (workspaceState(ctx.repo, ctx.workspace) !== 'complete') {
    removeWorktreeByHand(ctx.repo, ctx.workspace);
    addWorktreeByHand(ctx.repo, ctx.workspace, ctx.project.base);
  }
};
const gone = (ctx) => removeWorktreeByHand(ctx.repo, ctx.workspace);
const unreadable = (ctx, undo) => {
  ctx.fx.beforeCleanup.push(undo);
  return { undo };
};

// Put git into the state the outcome names for the operation, by hand
// (contract `probe.kinds.<kind>.<outcome>.fixture`). Returns {args, undo}:
// `args` are flags the next start of the engine needs; `undo` restores
// readability. The arrangement is checked at once with a test-side look.
export function arrange(ctx, outcome) {
  const { kind, repo } = ctx;
  let made = {};
  if (kind === 'ref_update') {
    const { ref, old, new: sha } = ctx.target;
    if (outcome === 'absent') gitQuiet(repo, ['update-ref', ref, old]);
    else if (outcome === 'applied') gitQuiet(repo, ['update-ref', ref, sha]);
    else if (outcome === 'conflicting') {
      ctx.third = commitOnRef(repo, null, { 'developer.txt': 'moved here by someone else\n' }, { parent: old, message: 'developer: a third commit' });
      gitQuiet(repo, ['update-ref', ref, ctx.third]);
    } else if (outcome === 'unknown') made = unreadable(ctx, makeUnreadable(repo));
    // A single ref cannot be partially written: the partial result is claimed, with no remaining effect declared.
    else if (outcome === 'partial') made = { args: probeFlag('ref_update', 'partial') };
  } else if (kind === 'commit_tree') {
    assert.ok(ctx.sha, 'the commit exists: the outcomes of a commit are made from what the engine made');
    assert.ok(ctx.keep.length >= 1, 'and it is published under a keep ref');
    if (outcome === 'applied') assert.equal(effectOf(ctx), 'applied');
    else if (outcome === 'partial') for (const ref of ctx.keep) gitQuiet(repo, ['update-ref', '-d', ref]);
    else if (outcome === 'absent') {
      for (const ref of ctx.keep) gitQuiet(repo, ['update-ref', '-d', ref]);
      deleteLooseObject(repo, ctx.sha);
    } else if (outcome === 'conflicting') {
      ctx.other = ctx.project.base;
      for (const ref of ctx.keep) gitQuiet(repo, ['update-ref', ref, ctx.other]);
    } else if (outcome === 'unknown') made = unreadable(ctx, makePartUnreadable(repo, 'objects'));
  } else {
    // worktree_add: absent = no artifacts, applied = a complete worktree.
    // worktree_remove: absent = the worktree still there, applied = nothing left.
    const there = kind === 'worktree_add' ? 'applied' : 'absent';
    const notThere = kind === 'worktree_add' ? 'absent' : 'applied';
    if (outcome === there) present(ctx);
    else if (outcome === notThere) gone(ctx);
    else if (outcome === 'partial') {
      present(ctx);
      removeWorktreeDirectory(repo, ctx.workspace);
    } else if (outcome === 'conflicting') {
      gone(ctx);
      ctx.foreign = foreignDirectory(ctx.workspace);
    } else if (outcome === 'unknown') made = unreadable(ctx, makePartUnreadable(repo, 'worktrees'));
  }
  // The fixture is live: a test-side look finds what the outcome names.
  if (outcome === 'absent' || outcome === 'applied') assert.equal(effectOf(ctx), outcome, `the fixture for ${kind} ${outcome}`);
  else if (outcome === 'partial' && kind === 'commit_tree') assert.deepEqual([commitsNaming(repo, `Surety-Run: ${ctx.run.id}`), keepRefsAt(repo, ctx.sha)], [[ctx.sha], []], 'the fixture: the commit without its keep ref');
  else if (outcome === 'partial' && kind !== 'ref_update') assert.equal(workspaceState(repo, ctx.workspace), 'metadata_only', 'the fixture: the metadata without the directory');
  else if (outcome === 'conflicting' && kind !== 'ref_update' && kind !== 'commit_tree') assert.equal(workspaceState(repo, ctx.workspace), 'foreign', 'the fixture: something foreign at the owned path');
  return { args: [], undo: () => {}, ...made };
}

// Bring one operation of `kind` to a durable journal state, with the engine
// stopped (contract `probe.durable_states`). `intended` and `applied` are
// what a kill at a barrier leaves. `ambiguous` is what a restart leaves when
// its probe can only find `unknown`: the engine is then killed again.
export async function reach(t, kind, state, opts = {}) {
  if (!STATES.includes(state)) throw new Error(`no durable state ${state}`);
  if (state !== 'ambiguous') {
    const ctx = await killedAt(t, kind, REACH[kind][state], opts);
    assert.equal(ctx.op.state, state, `the fixture: the journal is ${state} (events: ${ctx.op.events.map((e) => e.kind).join(', ')})`);
    ctx.state = state;
    return ctx;
  }
  const ctx = await killedAt(t, kind, REACH[kind].intended, opts);
  const { undo } = arrange(ctx, 'unknown');
  const engine = await ctx.fx.start();
  const blocked = operationDetail(ctx.fx.home, ctx.op.id);
  assert.deepEqual([blocked.state, blocked.status, blocked.finalized], ['ambiguous', 'ambiguous', false], 'the fixture: a restart whose probe finds unknown leaves the operation ambiguous');
  await engine.kill();
  undo();
  ctx.op = blocked;
  ctx.state = 'ambiguous';
  ctx.run = runRow(ctx.fx.home, ctx.run.id);
  return ctx;
}

// ---- what recovery must have made of the operation -------------------------------

const openBlockers = (op) => op.blockers.filter((d) => d.status === 'open');

// The way on that the contract table names for the outcome (`dispositions`),
// read off the operation. `before` is the operation as the dead engine left it.
export function assertWay(ctx, before, way, outcome) {
  const spec = PROBE.dispositions[way];
  const what = `${ctx.kind}, journal ${before.state}, effect ${outcome}: ${way}`;
  const op = operationDetail(ctx.fx.home, ctx.op.id);
  assertOperation(op, what);
  assert.equal(op.id, before.id);
  assert.equal(op.idempotency_key, before.idempotency_key, `${what}: the operation keeps its logical identity`);
  assert.deepEqual([op.state, op.status, op.finalized], [spec.journal, spec.operation, spec.finalized], `${what}: journal state, operation status, finalized (events: ${op.events.map((e) => e.kind).join(', ')}; attempts: ${op.attempts.map((a) => a.status).join(', ') || 'none'})`);
  const had = before.attempts.length;
  if (had === 0) {
    // The engine died before it had issued the first attempt. An effect found
    // applied needs no attempt, and none that succeeded: nothing was executed.
    // An effect to be made is made by the first attempt, admitted once.
    const allowed = { finalize: [[], ['reconciled_succeeded']], retry: [['succeeded']], complete: [['succeeded'], ['reconciled_partial', 'succeeded']], withdraw: [[], ['reconciled_absent'], ['reconciled_partial']], block: [[], ['ambiguous']] }[way];
    const statuses = op.attempts.map((a) => a.status);
    assert.ok(
      allowed.some((list) => JSON.stringify(list) === JSON.stringify(statuses)),
      `${what}: no attempt had been issued when the engine died; afterwards the attempts are ${allowed.map((list) => `[${list.join(', ')}]`).join(' or ')} (they are [${statuses.join(', ')}])`,
    );
  } else {
    assert.equal(op.attempts.length, had + spec.new_attempts, `${what}: ${spec.new_attempts} new attempt(s) (attempts: ${op.attempts.map((a) => a.status).join(', ')})`);
    const reconciled = op.attempts[had - 1];
    assert.ok(spec.reconciled_attempt.includes(reconciled.status), `${what}: the attempt that was in flight is ${spec.reconciled_attempt.join(' or ')} (it is ${reconciled.status})`);
    if (reconciled.status !== 'succeeded') {
      assert.equal(reconciled.reads.at(-1)?.result, outcome, `${what}: the attempt records what the probe found (reads: ${JSON.stringify(reconciled.reads)})`);
    }
    if (spec.new_attempts > 0) assert.equal(op.attempts.at(-1).status, 'succeeded', `${what}: the new attempt succeeded`);
  }
  assert.equal(openBlockers(op).length, spec.blocker ? 1 : 0, `${what}: open blockers that name the operation`);
  if (spec.blocker) {
    const [blocker] = openBlockers(op);
    assert.ok(typeof blocker.question === 'string' && blocker.question.length > 0, `${what}: the blocker says what is wrong`);
  }
  return op;
}

const unreconciledObservations = (ctx) => outOfBand(ctx.fx.home, ctx.project.id).filter((o) => o.disposition === null && o.decision?.status === 'open');
const recoveredBy = (ctx) => withStore(ctx.fx.home, (db) => eventsAbout(db, 'run', ctx.run.id, 'run.ended')[0]?.payload.recovery?.incarnation ?? null);

// The operation went through and its finalizer ran: what that leaves, kind by
// kind, of identities, files and refs, effect and launch counts, evidence and
// disposition (Plan §2).
export function assertSettled(ctx) {
  const { fx, project, item, kind, repo } = ctx;
  const home = fx.home;
  const what = `${kind} recovered`;
  const op = assertOperation(operationDetail(home, ctx.op.id), what);
  assert.deepEqual([op.state, op.status, op.finalized], ['finalized', 'succeeded', true], `${what}: the operation is finalized (events: ${op.events.map((e) => e.kind).join(', ')})`);
  assertOperations(home, { project: project.id });
  const run = runRow(home, ctx.run.id);
  const branch = project.repo.ref;
  assert.equal(effectOf(ctx), 'applied', `${what}: what git holds of the effect`);
  assert.deepEqual(unreconciledObservations(ctx), [], `${what}: the engine's own effect is not reported out of band`);
  assert.ok(typeof recoveredBy(ctx) === 'string', `${what}: the run was ended by a startup recovery, and its run.ended says so`);
  assert.equal(runsOf(home, item).length, 1, `${what}: recovery launched no replacement run`);

  if (kind === 'ref_update') {
    const sha = ctx.target.new;
    assert.equal(refOid(repo, branch), sha, `${what}: the integration branch is at the run's commit`);
    assert.equal(registryOf(home, project.id)[branch].expected_oid, sha, `${what}: and the registry expects it there`);
    assert.deepEqual(commitsNaming(repo, `Surety-Run: ${run.id}`), [sha], `${what}: one commit was made for the run, the one integrated`);
    assert.deepEqual(parentsOf(repo, sha), [project.base]);
    assert.deepEqual(changedPaths(repo, project.base, sha), { [EDITS[0].path]: 'A' }, `${what}: the branch holds exactly what the role wrote`);
    assert.deepEqual(revisionsOf(home, { run: run.id }).map((r) => [r.sha, r.kind]), [[sha, 'engine_commit']]);
    assertRunEnded(home, run.id, { outcome: 'recovered', reason_class: 'recovered', workspace: 'retained', launched: true });
    const path = withStore(home, (db) => assertWorkHistory(db, item));
    assert.deepEqual(path.slice(-3), ['executing', 'integrating', 'integrated'], `${what}: the work item is integrated, by the finalizer (path ${path.join(' → ')})`);
    assert.equal(withStore(home, (db) => eventsAbout(db, 'work_item', item, 'work.integrated').length), 1, `${what}: integrated once`);
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1, `${what}: the role was launched once`);
  } else if (kind === 'commit_tree') {
    const made = commitsNaming(repo, `Surety-Run: ${run.id}`);
    assert.equal(made.length, 1, `${what}: exactly one commit object names the run (found ${made.join(', ')})`);
    const [sha] = made;
    if (ctx.sha) assert.equal(sha, ctx.sha, `${what}: it is the commit the first attempt made: its identity is stable across a retry, and it was not made again as another commit`);
    const ws = getRow(home, 'workspaces', run.workspace);
    assert.deepEqual(parentsOf(repo, sha), [project.base]);
    assert.deepEqual([treeOf(repo, sha), ws.snapshot_tree], [snapshotTree(ws.path, project.base), snapshotTree(ws.path, project.base)], `${what}: the commit's tree and the recorded snapshot are the tree of what the role left`);
    assert.deepEqual(revisionsOf(home, { run: run.id }).map((r) => [r.sha, r.kind, r.parent_sha]), [[sha, 'engine_commit', project.base]], `${what}: one revision records it`);
    const registry = registryOf(home, project.id);
    const kept = Object.entries(registry).filter(([, row]) => row.kind === 'keep' && row.expected_oid === sha).map(([ref]) => ref);
    assert.ok(kept.length >= 1 && kept.every((ref) => refOid(repo, ref) === sha), `${what}: the commit is reachable from a registered keep ref that is where the registry expects it (keep refs: ${kept.join(', ') || 'none'})`);
    assert.equal(refOid(repo, branch), project.base, `${what}: nothing was integrated by the recovery`);
    assert.equal(registry[branch].expected_oid, project.base);
    assert.deepEqual(operationDetails(home, { run: run.id, journalKind: 'ref_update' }), [], `${what}: no ref update was journaled for the run`);
    assertRunEnded(home, run.id, { outcome: 'recovered', reason_class: 'recovered', workspace: 'retained', launched: true });
    assert.equal(workItem(home, item).status, 'held', `${what}: the work is held`);
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1);
  } else if (kind === 'worktree_add') {
    const rows = withStore(home, (db) => db.prepare('SELECT * FROM "workspaces" WHERE "run" = ?').all(run.id));
    assert.equal(rows.length, 1, `${what}: the complete worktree is adopted once: one workspaces row for the run`);
    assert.deepEqual([resolvedPath(rows[0].path), rows[0].base_revision, rows[0].disposition, run.workspace], [resolvedPath(ctx.workspace), project.base, 'retained', rows[0].id], `${what}: the workspace's path, base and disposition, and runs.workspace`);
    assert.equal(worktreeList(repo).filter((w) => resolvedPath(w.path) === resolvedPath(ctx.workspace)).length, 1, `${what}: the repository lists the worktree once`);
    assert.equal(countOf(home, 'managed_checkouts', '"owner_run" = ? AND "kind" = ?', run.id, 'run_workspace'), 1, `${what}: it is a managed checkout of the run`);
    assertRunEnded(home, run.id, { outcome: 'recovered', reason_class: 'recovered', workspace: 'retained' });
    assert.equal(workItem(home, item).status, 'held', `${what}: the work is held`);
    assert.equal(fx.scripted.launches({ work_item: item }).length, 0, `${what}: no role was launched`);
  } else {
    const ws = getRow(home, 'workspaces', run.workspace);
    assert.deepEqual([ws.disposition, ws.disposed_at !== null], ['discarded', true], `${what}: the workspace is discarded`);
    assert.equal(operationDetails(home, { run: run.id, journalKind: 'worktree_remove' }).length, 1, `${what}: one removal operation, whatever it took`);
    assertRunEnded(home, run.id, { outcome: 'abandoned', reason_class: 'human_abandon', workspace: 'discarded', launched: true });
    const work = workItem(home, item);
    assert.deepEqual([work.status, work.dispatch_hold], ['eligible', 1], `${what}: the work is back at its prior status under a dispatch hold`);
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1);
  }
  withStore(home, (db) => assertWorkHistory(db, item));
  return op;
}

// The operation was withdrawn (worktree_add): nothing was added for a run that
// is over, no residue is left, and nothing was recorded as a workspace.
export function assertWithdrawn(ctx) {
  const { fx, project, item, kind, repo } = ctx;
  const home = fx.home;
  const what = `${kind} withdrawn`;
  const op = assertOperation(operationDetail(home, ctx.op.id), what);
  assert.deepEqual([op.state, op.status, op.finalized], ['failed', 'failed', false], `${what}: the operation is failed and never finalized (events: ${op.events.map((e) => e.kind).join(', ')})`);
  assertOperations(home, { project: project.id });
  assert.equal(workspaceState(repo, ctx.workspace), 'absent', `${what}: nothing is at the owned path and the repository has no metadata for it`);
  assert.deepEqual(worktreeList(repo).filter((w) => resolvedPath(w.path) === resolvedPath(ctx.workspace)), [], `${what}: the repository lists no worktree there`);
  assert.equal(countOf(home, 'workspaces', '"run" = ?', ctx.run.id), 0, `${what}: no workspace was recorded`);
  assert.equal(runRow(home, ctx.run.id).workspace, null);
  assert.deepEqual(unreconciledObservations(ctx), []);
  assertRunEnded(home, ctx.run.id, { outcome: 'recovered', reason_class: 'recovered' });
  assert.equal(workItem(home, item).status, 'held', `${what}: the work is held`);
  assert.deepEqual([runsOf(home, item).length, fx.scripted.launches({ work_item: item }).length], [1, 0], `${what}: no replacement run, and no role was launched`);
  withStore(home, (db) => assertWorkHistory(db, item));
  return op;
}

// The operation is blocked: nothing was retried, completed, finalized or
// overwritten; what the probe found is as it was found; nothing of the
// project is dispatched; the engine is in full mode; and none of it changes
// over further ticks.
export async function assertBlocked(ctx, before, outcome) {
  const { fx, project, item, kind, repo } = ctx;
  const home = fx.home;
  const what = `${kind} blocked on ${outcome}`;
  assert.equal((await fx.engine.engineInfo()).mode, 'full', `${what}: a blocked operation does not keep the engine restricted`);
  const op = assertWay(ctx, before, 'block', outcome);
  const look = () => ({
    op: (({ events, attempts, status, finalized }) => ({ events: events.map((e) => e.kind), attempts: attempts.map((a) => a.status), status, finalized }))(operationDetail(home, op.id)),
    blockers: openBlockers(operationDetail(home, op.id)).map((d) => d.id),
    receipts: receiptsWritten(ctx),
    refs: outcome === 'unknown' ? null : refsOf(repo),
    foreign: ctx.foreign ? (existsSync(ctx.foreign.file) ? readFileSync(ctx.foreign.file, 'utf8') : null) : undefined,
    run: [runRow(home, ctx.run.id).state, runRow(home, ctx.run.id).outcome],
    work: workItem(home, item).status,
    runs: countOf(home, 'runs', '"project" = ?', project.id),
  });
  const first = look();
  assert.equal(first.receipts, false, `${what}: no finalizer receipt was written`);
  if (ctx.foreign) assert.equal(first.foreign, ctx.foreign.content, `${what}: what is at the owned path and is not the engine's was left alone`);
  if (kind === 'ref_update') {
    assert.equal(registryOf(home, project.id)[ctx.target.ref].expected_oid, ctx.target.old, `${what}: the registry expects the commit the branch was at`);
    assert.equal(first.work, 'integrating', `${what}: the work item waits for its integration: it is neither integrated nor held`);
    if (outcome === 'conflicting') assert.equal(refOid(repo, ctx.target.ref), ctx.third, `${what}: the unexpected head was not overwritten`);
  } else if (kind === 'commit_tree') {
    assert.deepEqual(revisionsOf(home, { run: ctx.run.id }), [], `${what}: no revision records the commit`);
    if (outcome === 'conflicting') assert.ok(ctx.keep.every((ref) => refOid(repo, ref) === ctx.other), `${what}: the keep ref was not overwritten`);
  } else if (kind === 'worktree_add') {
    assert.equal(countOf(home, 'workspaces', '"run" = ?', ctx.run.id), 0, `${what}: no workspace was recorded`);
  } else {
    assert.deepEqual(first.run, ['finalizing', 'abandoned'], `${what}: the abandoned run is not ended while its workspace cannot be discarded`);
    assert.notEqual(getRow(home, 'workspaces', ctx.run.workspace).disposition, 'discarded', `${what}: the workspace is not recorded discarded`);
    assert.notEqual(first.work, 'eligible', `${what}: the work is not released before the run has ended`);
  }
  if (kind !== 'worktree_remove') assert.deepEqual(first.run, ['ended', 'recovered'], `${what}: the run was ended by the recovery`);

  // Nothing of the project is dispatched while its journal has a blocked operation.
  const waiting = await addWork(fx.engine, project.id, 'verification');
  for (let i = 0; i < 2; i++) await tick(fx.engine, project.id);
  assert.equal(runsOf(home, waiting).length, 0, `${what}: nothing of the project is dispatched`);
  assert.deepEqual(look(), { ...first, runs: first.runs }, `${what}: further ticks change nothing: no new event, attempt or blocker`);
  ctx.waiting = waiting;
  return op;
}

// Remove what blocked the operation, the way an operator would, so that the
// next probe finds something it can go on from. `underlying` is what git held
// of the effect before the blocking state was arranged. Returns the outcome
// the next probe finds.
export async function unblock(ctx, outcome, arrangement, underlying) {
  const { fx, project, kind, repo } = ctx;
  let next = underlying;
  if (outcome === 'unknown') arrangement.undo();
  else if (outcome === 'conflicting') next = { ref_update: 'absent', commit_tree: 'partial', worktree_add: 'absent', worktree_remove: 'applied' }[kind];
  if (outcome === 'conflicting' && kind === 'ref_update') {
    // The moved branch is an out-of-band change; discarding it puts the branch back where the operation expects it.
    const observed = unreconciledObservations(ctx).filter((o) => o.subject_kind === 'ref' && o.ref_name === ctx.target.ref);
    assert.equal(observed.length, 1, 'the conflicting head is observed out of band, once');
    assert.equal(observed[0].found, ctx.third);
    await answerDecision(fx.engine, project.id, observed[0].decision.id, 'discard');
  } else if (outcome === 'conflicting' && kind === 'commit_tree') for (const ref of ctx.keep) gitQuiet(repo, ['update-ref', '-d', ref]);
  else if (outcome === 'conflicting') {
    gitQuiet(repo, ['worktree', 'prune']);
    removeWorktreeByHand(repo, ctx.workspace);
  }
  else if (outcome === 'partial' && kind === 'ref_update') {
    // The partial result was claimed for as long as that engine ran: one started without the claim probes what git holds.
    await fx.engine.kill();
    await fx.start();
  }
  return next;
}

// After a blocked operation was unblocked: a tick takes it up, it goes the
// way the outcome now found leads to, and its blocker is closed.
export async function assertUnblocked(ctx, way) {
  const { fx, project } = ctx;
  await tick(fx.engine, project.id);
  const op = operationDetail(fx.home, ctx.op.id);
  assert.equal(op.state, PROBE.dispositions[way].journal, `once what blocked it is gone, the next tick takes the operation on (${way}; events: ${op.events.map((e) => e.kind).join(', ')})`);
  assert.deepEqual(openBlockers(op), [], 'and its blocker is closed');
  assert.ok(op.blockers.length >= 1 && op.blockers.every((d) => d.status !== 'open'));
}

// The project goes on (Plan §5: a recovery test includes its successful
// continuation). For work that is held or on dispatch hold, an explicit
// Resume gives it a new run, which is committed and integrated; for work that
// was integrated, the project's next item runs.
export async function assertGoesOn(ctx) {
  const { fx, project, item, kind } = ctx;
  const home = fx.home;
  const complete = (work) => tickUntil(fx.engine, project.id, () => workItem(home, work).status === 'complete', { max: 6, what: `the project's next item ${work} to be complete` });
  if (kind === 'ref_update') {
    await complete(ctx.waiting ?? (await addWork(fx.engine, project.id, 'verification')));
    return;
  }
  const launches = fx.scripted.launches({ work_item: item }).length;
  await resumeWork(fx.engine, project.id, item);
  // Which of the project's eligible items a tick takes first is the scheduler's: tick until this one has run.
  const second = await tickUntil(fx.engine, project.id, () => (runsOf(home, item)[1]?.state === 'ended' ? runsOf(home, item)[1] : undefined), { max: 6, what: 'the resumed work to have run' });
  assertCommitted(fx, second.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [EDITS[launches].path]: 'A' } });
  assert.equal(fx.scripted.launches({ work_item: item }).length, launches + 1, 'exactly one more launch of the work');
  if (ctx.waiting) await complete(ctx.waiting);
  assertOperations(home, { project: project.id });
}

// ---- the two generated cases -----------------------------------------------------

// One cell of the probe matrix (rows M29 to M32).
export async function probeCase(t, cell) {
  const { kind, state, outcome, way } = cell;
  const ctx = await reach(t, kind, state);
  const before = ctx.op;
  const underlying = effectOf(ctx);
  assert.ok(['absent', 'applied'].includes(underlying), `the fixture: git holds nothing or all of the effect (${underlying})`);
  const arrangement = arrange(ctx, outcome);
  await ctx.fx.start({ args: arrangement.args });
  let went = way;
  if (way === 'block') {
    await assertBlocked(ctx, before, outcome);
    went = PROBE.kinds[kind][await unblock(ctx, outcome, arrangement, underlying)].leads_to;
    await assertUnblocked(ctx, went);
  } else assertWay(ctx, before, way, outcome);
  if (went === 'withdraw') assertWithdrawn(ctx);
  else assertSettled(ctx);
  await assertGoesOn(ctx);
}

// One cell of the crash matrix (row M33): killed at a boundary, recovered,
// and recovered again.
export async function crashCase(t, kind, boundary) {
  const ctx = await killedAt(t, kind, boundary);
  assertDurable(ctx);
  const before = ctx.op;
  const spec = JOURNAL.durable[boundary];
  const way = crashWay(kind, boundary);
  const settled = () => (way === 'withdraw' ? assertWithdrawn(ctx) : assertSettled(ctx));
  await ctx.fx.start();
  if (before.state === 'intended' || before.state === 'applied') {
    // The probe finds what the kill left: nothing of the effect, or all of it.
    assertWay(ctx, before, way, spec.effect);
  } else {
    // A confirmed operation runs only its finalizer; a finalized one nothing (contract `recovery.visits`).
    const op = assertOperation(operationDetail(ctx.fx.home, before.id));
    assert.deepEqual(op.attempts.map((a) => [a.attempt_number, a.status]), before.attempts.map((a) => [a.attempt_number, a.status]), `a ${before.state} operation's effect is never attempted again`);
    assert.deepEqual(op.events.slice(0, before.events.length).map((e) => e.kind), before.events.map((e) => e.kind), 'and its journal goes on from where it was');
  }
  settled();

  // The finalizer and the recovery are repeated: a second restart, and ticks, change no receipt.
  const receipts = receiptSnapshot(ctx.fx.home, ctx.project.id);
  await ctx.fx.engine.kill();
  const again = await ctx.fx.start();
  for (let i = 0; i < 2; i++) await tick(again, ctx.project.id);
  assert.deepEqual(receiptSnapshot(ctx.fx.home, ctx.project.id), receipts, 'after a second restart every receipt has the identity and content it had: nothing was written again');
  settled();
  await assertGoesOn(ctx);
}

// A dispatch whose `git worktree add` is held open past its deadline: the
// engine kills the command, and the operation is ambiguous (SEAM.md §34).
// Returns {fx, project, item, run, op, letGo} once the journal says so;
// `letGo` lets the repository's git calls go on.
export async function ambiguousWorktreeAdd(t, { gitDeadline = 2, config = {} } = {}) {
  const fx = await scriptedEngine(t, { config: { git_deadline: gitDeadline, ...config }, barriers: ['dispatch.receipt_committed=pause'] });
  const project = await addGitProject(fx);
  const item = await addItem(fx, project.id, 'fix');
  fx.scripted.script(item, [roleThat([editOf(0)]), roleThat([editOf(1)])]);
  fx.scripted.defaultScript(script.complete());
  await requestTick(fx.engine, project.id);
  await fx.engine.waitUntil('barrier:dispatch.receipt_committed');
  const run = await waitForRun(fx.home, item, { state: 'claimed' });
  // From here every git command on this repository waits: its configuration is a pipe nobody writes to.
  const letGo = holdGit(project.repo.path);
  fx.beforeCleanup.push(letGo);
  await releaseBarrier(fx.engine, 'dispatch.receipt_committed');
  const op = await waitFor(
    () => {
      const [found] = operationDetails(fx.home, { run: run.id, journalKind: 'worktree_add' });
      return found && found.events.some((e) => e.kind === 'ambiguous') ? found : undefined;
    },
    { timeoutMs: (gitDeadline + 15) * 1000, what: 'the held worktree add to be killed at its deadline and marked ambiguous' },
  );
  return { fx, project, item, run, op, letGo, kind: 'worktree_add', repo: project.repo.path, workspace: join(fx.home, 'workspaces', run.id) };
}

export { decisionsAbout };
