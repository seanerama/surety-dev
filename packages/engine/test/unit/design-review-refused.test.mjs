// Developer tests for H5 (E171 item 5; SEAM.md §552): a review-mode Designer
// session ending without a recorded review has each unrecorded
// `reviews/review-<n>.json` of the head moved to
// `reviews/refused/<run>-review-<n>.json`, the same blob, by one engine
// intent commit, before the session closes; a failure of the move leaves the
// session open. The design check and the recording skip `reviews/refused/`,
// and a Designer save writing there is a diff violation. Against scratch
// repositories, a scratch store and stand-ins for the runtime and journal;
// nothing runs.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { validateDiff } = await import(join(dist, 'git', 'snapshot.js'));
const { treeWith } = await import(join(dist, 'projects', 'commands.js'));
const { refusedMoves, finalizeReviewRefused, intendReviewRefused } = await import(join(dist, 'design', 'review-refused.js'));
const { moveRefusedReviews } = await import(join(dist, 'design', 'review-driver.js'));
const { checkDesign } = await import(join(dist, 'design', 'check.js'));
const { SessionDriver } = await import(join(dist, 'sessions', 'driver.js'));
const { EVENT_TYPES } = await import(join(dist, 'store', 'transitions', 'event-types.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { default: Database } = await import('better-sqlite3');

const R = '.surety/design/reviews/';
const RUN = 'run_01H5TESTRUN';

function scratchRepo(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-h5-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  const g = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'one');
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 20, home: dir, incarnation: 'inc_unit' });
  const lsTree = (rev) => Object.fromEntries(g('ls-tree', '-r', rev).split('\n').filter(Boolean).map((l) => [l.split('\t')[1], l.split('\t')[0].split(' ')[2]]));
  return { dir, repo, g, head: g('rev-parse', 'HEAD'), lsTree };
}

const FILES = {
  'a.txt': 'a\n',
  [`${R}review-1.json`]: '{"recorded":1}\n',
  [`${R}review-2.json`]: '{"unrecorded":2}\n',
  [`${R}review-10.json`]: '{"unrecorded":10}\n',
  [`${R}notes.json`]: '{"not":"a review file"}\n',
  [`${R}refused/run_old-review-3.json`]: '{"refused":3}\n',
};

test('refusedMoves: each unrecorded review-<n>.json directly under reviews/, to refused/<run>-review-<n>.json, its blob and mode kept', () => {
  const e = (path, oid, type = 'blob', mode = '100644') => ({ path, oid, type, mode });
  const moves = refusedMoves(
    [e(`${R}review-2.json`, 'b2'), e(`${R}review-1.json`, 'b1'), e(`${R}refused/run_old-review-3.json`, 'b3'), e(`${R}notes.json`, 'bn'), e(`${R}review-x.json`, 'bx'), e(`${R}sub/review-4.json`, 'b4'), e(`${R}review-5.json`, 'b5', 'tree'), e('.surety/design/screens.json', 'bs')],
    ['b1'],
    RUN,
  );
  assert.deepEqual(moves, [{ from: `${R}review-2.json`, to: `${R}refused/${RUN}-review-2.json`, blob: 'b2', mode: '100644' }]);
  assert.deepEqual(refusedMoves([e(`${R}review-1.json`, 'b1')], ['b1'], RUN), [], 'a recorded review is never moved');
});

test('treeWith: a path removed and an existing blob placed at a new path (a move keeps its blob)', async (t) => {
  const { repo, dir, head, lsTree, g } = scratchRepo(t, FILES);
  const before = lsTree(head);
  const tree = await treeWith(repo, head, { [`${R}review-2.json`]: null, [`${R}refused/x-review-2.json`]: { oid: before[`${R}review-2.json`], mode: '100644' } }, dir);
  assert.ok(tree);
  const after = Object.fromEntries(g('ls-tree', '-r', tree).split('\n').map((l) => [l.split('\t')[1], l.split('\t')[0].split(' ')[2]]));
  assert.equal(after[`${R}review-2.json`], undefined);
  assert.equal(after[`${R}refused/x-review-2.json`], before[`${R}review-2.json`]);
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before).filter((p) => p !== `${R}review-2.json`), `${R}refused/x-review-2.json`].sort(), 'nothing else changed');
});

test('the design check skips reviews/refused/: a file there is history, never checked', () => {
  const ctx = { inventory: null, externalHosts: [], approved: [] };
  const bad = Buffer.from('not json');
  const named = (files) => checkDesign({ files: new Map(files) }, ctx).reasons.filter((r) => JSON.stringify(r).includes('reviews/'));
  assert.ok(named([['reviews/review-9.json', bad]]).length > 0, 'the control: an invalid review file in active review is refused');
  assert.deepEqual(named([['reviews/refused/run_a-review-9.json', bad]]), [], 'the same bytes under reviews/refused/ give no reason');
});

test('a Designer save writing under reviews/refused/, adding, changing or deleting, is a diff violation; its own review file is not', async (t) => {
  const { repo, head, g } = scratchRepo(t, FILES);
  const caps = { files: 100, bytes: 1 << 20, fileBytes: 1 << 20 };
  const mk = (edit) => {
    g('read-tree', head);
    edit();
    return g('write-tree');
  };
  const blob = (text) => execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: text, encoding: 'utf8' }).trim();
  const add = (path, text) => g('update-index', '--add', '--cacheinfo', `100644,${blob(text)},${path}`);
  const judge = async (tree) => (await validateDiff(repo, head, tree, 'designer', caps, ['.surety/checks/'])).violation;
  for (const [what, tree] of [
    ['an added file', mk(() => add(`${R}refused/planted-review-1.json`, '{}'))],
    ['a changed file', mk(() => add(`${R}refused/run_old-review-3.json`, '{"edited":1}'))],
    ['a deleted file', mk(() => g('update-index', '--force-remove', `${R}refused/run_old-review-3.json`))],
  ]) {
    const v = await judge(tree);
    assert.equal(v?.klass, 'diff_violation', `${what}: refused (${JSON.stringify(v)})`);
    assert.match(v.text, /reviews\/refused\//, what);
  }
  assert.equal((await judge(mk(() => add(`${R}review-11.json`, '{}')))) ?? null, null, 'a review file of its own is the Designer\'s');
  // A builder is refused there as anywhere under .surety/, by its own rule.
  assert.equal((await validateDiff(repo, head, mk(() => add(`${R}refused/b.json`, '{}')), 'builder', caps, ['.surety/checks/'])).violation?.klass, 'diff_violation');
});

// Stand-ins: the runtime's reads and the journal, the git work real.
function standIns(repo, scratch, { head, recorded, intend, drive }) {
  const calls = { intend: [], withProject: 0 };
  const rt = {
    scratch,
    setting: () => 60,
    read: async (name) => {
      if (name === 'design.repo_facts') return { repo, head };
      if (name === 'design.review_facts') return { design_revision: null, alpha_review: false, recorded };
      throw new Error(`unexpected read ${name}`);
    },
  };
  const journal = {
    withProject: async (_p, fn) => {
      calls.withProject++;
      return fn();
    },
    intend: async (name, args, kind) => {
      calls.intend.push({ name, args, kind });
      return intend(args);
    },
    drive: async (op) => drive(op),
  };
  return { rt, journal, calls };
}

test('moveRefusedReviews: one intent commit on the head moving each unrecorded review file, the same blobs, naming the run; nothing else changed', async (t) => {
  const { repo, dir, head, lsTree, g } = scratchRepo(t, FILES);
  const before = lsTree(head);
  const { rt, journal, calls } = standIns(repo, dir, {
    head,
    recorded: [before[`${R}review-1.json`]],
    intend: () => ({ operation: 'op_commit' }),
    drive: (op) => (op === 'op_commit' ? { end: 'finalized', receipts: { follow: 'op_ref' } } : { end: 'finalized', receipts: {} }),
  });
  const out = await moveRefusedReviews(rt, journal, 'proj_x', RUN);
  assert.deepEqual(out.moved.map((m) => [m.from, m.to, m.blob]), [
    [`${R}review-10.json`, `${R}refused/${RUN}-review-10.json`, before[`${R}review-10.json`]],
    [`${R}review-2.json`, `${R}refused/${RUN}-review-2.json`, before[`${R}review-2.json`]],
  ]);
  assert.equal(calls.intend.length, 1, 'one intent');
  const { name, args, kind } = calls.intend[0];
  assert.deepEqual([name, kind, args.head, args.run, args.project], ['design.intend_review_refused', 'commit_tree', head, RUN, 'proj_x']);
  assert.equal(out.revision, args.commit.sha);
  // The commit the intent freezes: its tree and its message.
  const after = Object.fromEntries(g('ls-tree', '-r', args.commit.tree).split('\n').map((l) => [l.split('\t')[1], l.split('\t')[0].split(' ')[2]]));
  const expected = { ...before };
  for (const n of [2, 10]) {
    delete expected[`${R}review-${n}.json`];
    expected[`${R}refused/${RUN}-review-${n}.json`] = before[`${R}review-${n}.json`];
  }
  assert.deepEqual(after, expected, 'the moves and nothing else: the recorded review, the other file and the earlier refused file untouched');
  assert.match(args.commit.content, new RegExp(`^parent ${head}$`, 'm'));
  assert.match(args.commit.content, /^Surety-Kind: intent$/m);
  assert.ok(args.commit.content.includes(RUN), 'the message names the run');
});

test('moveRefusedReviews: nothing to move commits nothing; a moved head, a commit not finalized, or an unreadable head throws (the caller keeps the session open)', async (t) => {
  const { repo, dir, head, lsTree } = scratchRepo(t, { 'a.txt': 'a\n', [`${R}review-1.json`]: '{}\n' });
  const recorded = [lsTree(head)[`${R}review-1.json`]];
  const done = (op) => (op === 'op_commit' ? { end: 'finalized', receipts: { follow: 'op_ref' } } : { end: 'finalized', receipts: {} });
  const none = standIns(repo, dir, { head, recorded, intend: () => ({ operation: 'op_commit' }), drive: done });
  assert.deepEqual(await moveRefusedReviews(none.rt, none.journal, 'p', RUN), { moved: [], revision: null });
  assert.equal(none.calls.intend.length, 0, 'no intent when nothing is unrecorded (the Designer removed it, or none was written)');
  const fenced = standIns(repo, dir, { head, recorded: [], intend: () => ({ fenced: true }), drive: done });
  await assert.rejects(moveRefusedReviews(fenced.rt, fenced.journal, 'p', RUN), (e) => e.code === 'integration_conflict');
  const failed = standIns(repo, dir, { head, recorded: [], intend: () => ({ operation: 'op_commit' }), drive: (op) => (op === 'op_commit' ? { end: 'finalized', receipts: { follow: 'op_ref' } } : { end: 'failed', receipts: {} }) });
  await assert.rejects(moveRefusedReviews(failed.rt, failed.journal, 'p', RUN), /did not finalize/);
  const unreadable = standIns(repo, dir, { head: 'f'.repeat(40), recorded: [], intend: () => ({ operation: 'op_commit' }), drive: done });
  await assert.rejects(moveRefusedReviews(unreadable.rt, unreadable.journal, 'p', RUN), /unknown/);
});

function scratchStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-h5-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(dist, '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, domain_memory_max: 8 * 1024 ** 3, max_concurrent_domains: 8 });
  db.prepare(`INSERT INTO "projects" ("id", "created_at", "name", "tier", "dev_repo_path", "integration_branch", "baseline_state", "registration_state", "management") VALUES ('proj_h5', ?, 'pantry', 'T2', '/nowhere', 'main', 'spec_ready', 'registered', 'x')`).run(new Date().toISOString());
  return db;
}

test('design.review_refused: a registered event type; one per file moved, naming the run, both paths and the blob', (t) => {
  assert.ok(EVENT_TYPES.includes('design.review_refused'));
  const db = scratchStore(t);
  const moves = [
    { from: `${R}review-2.json`, to: `${R}refused/${RUN}-review-2.json`, blob: 'a'.repeat(40), mode: '100644' },
    { from: `${R}review-3.json`, to: `${R}refused/${RUN}-review-3.json`, blob: 'b'.repeat(40), mode: '100644' },
  ];
  transact(db, ENGINE_ACTOR, (tx) => finalizeReviewRefused(tx, { id: 'op_x', project: 'proj_h5' }, { purpose: 'design_review_refused', ref: 'refs/heads/main', ref_kind: 'integration', new_oid: 'c'.repeat(40), project: 'proj_h5', run: RUN, moves }));
  const events = db.prepare(`SELECT "subject", "payload" FROM "events" WHERE "type" = 'design.review_refused' ORDER BY "seq"`).all().map((e) => ({ subject: JSON.parse(e.subject), payload: JSON.parse(e.payload) }));
  assert.equal(events.length, 2);
  for (const [i, m] of moves.entries()) {
    assert.equal(events[i].subject.project, 'proj_h5');
    assert.deepEqual([events[i].payload.run, events[i].payload.path, events[i].payload.blob, events[i].payload.moved_to], [RUN, m.from, m.blob, m.to]);
  }
});

test('intendReviewRefused is fenced when the integration head is not the one the move was prepared on', (t) => {
  const db = scratchStore(t);
  const made = transact(db, ENGINE_ACTOR, (tx) => intendReviewRefused(tx, { project: 'proj_h5', repo: '/nowhere', run: RUN, head: 'd'.repeat(40), commit: { sha: 'e'.repeat(40), tree: 'f'.repeat(40), content: '' }, moves: [], deadlineSeconds: 60 }));
  assert.deepEqual(made, { fenced: true });
});

// The driver's close, its save and store steps stood in for: the move runs
// before the session's close, and a failure of the move leaves it open.
function driverWith({ mode = 'review', role = 'designer', move }) {
  const engineCalls = [];
  const ended = [];
  const facts = { project: 'p', run: RUN, role, repo: '/nowhere', head: 'h', base_revision: 'h', branch: 'main' };
  const rt = {
    engine: async (name) => {
      engineCalls.push(name);
      if (name === 'session.close_facts') return facts;
      if (name === 'session.close') return { decisions: [] };
      return {};
    },
    read: async (name) => {
      if (name === 'design.session_mode') return mode;
      if (name === 'session.view') return { run: { id: RUN } };
      if (name === 'session.admission_read') return { idle: true, idle_generation: 1 };
      if (name === 'design.repo_facts') return move();
      throw new Error(`unexpected read ${name}`);
    },
  };
  const journal = { withProject: async (_p, fn) => fn() };
  const ender = { endRun: async (run) => ended.push(run) };
  const driver = new SessionDriver(rt, journal, null, ender);
  driver.save = async () => ({ saved: false, revision: null, idle_generation: 1, findings: [] });
  return { driver, engineCalls, ended };
}

test('close with refuse: a failure of the move leaves the session open (no session.close, no end); the move made, it closes', async () => {
  const failing = driverWith({ move: () => Promise.reject(new Error('the repository could not be read')) });
  await assert.rejects(failing.driver.close('p', RUN, { refuse: true }), /could not be read/);
  assert.ok(!failing.engineCalls.includes('session.close'), `the session's close never reached (${failing.engineCalls})`);
  assert.deepEqual(failing.ended, [], 'the run not ended');
  const ok = driverWith({ move: async () => ({ repo: '/nowhere', head: null }) });
  const out = await ok.driver.close('p', RUN, { refuse: true });
  assert.deepEqual(out.decisions, []);
  assert.ok(ok.engineCalls.includes('session.close'));
  assert.deepEqual(ok.ended, [RUN]);
  // Not a review-mode session: no move is attempted.
  const design = driverWith({ mode: null, move: () => Promise.reject(new Error('never read')) });
  await design.driver.close('p', RUN, { refuse: true });
  assert.deepEqual(design.ended, [RUN]);
});

test('closeByProtocol: a review-mode session raising nothing moves first; a failure of the move leaves it open for the next tick', async () => {
  const failing = driverWith({ move: () => Promise.reject(new Error('the repository could not be read')) });
  await assert.rejects(failing.driver.closeByProtocol('p', RUN, 'idle_timeout'), /could not be read/);
  assert.ok(!failing.engineCalls.includes('session.close'));
  assert.deepEqual(failing.ended, []);
  const ok = driverWith({ move: async () => ({ repo: '/nowhere', head: null }) });
  assert.equal(await ok.driver.closeByProtocol('p', RUN, 'budget_exhausted'), true);
  assert.deepEqual(ok.ended, [RUN]);
});
