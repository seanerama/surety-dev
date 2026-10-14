// Developer tests for which managed checkouts are read, and when (slice 37):
// Sean's ruling of 2026-10-14 ("check at startup only") and the driver's
// ruling on M450's ref_violation. Each tick's integrity step reads the
// registered refs, the integration worktree and the retained workspaces of
// sessions. The retained workspace of an ended work-item run is read at
// startup only, and a tampered one is still observed there. The registered
// refs are read again just before a project's dispatch, so a branch moved by
// hand after the tick's integrity step is seen in that tick (M70). A run's
// snapshot validation never classifies another active run's workspace, nor
// an ended work-item run's. It does compare the integration worktree and an
// ended session's workspace with their current recorded baselines. Real
// git in a scratch repository; a scratch store; a stub runtime that hands
// the engine's operations to the store functions.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { integrityFacts, recordIntegrity, registryFacts } = await import(join(dist, 'store', 'transitions', 'integrity.js'));
const { validatorCheckouts } = await import(join(dist, 'store', 'transitions', 'accept.js'));
const { configureGit, repoContext, worktreeContext } = await import(join(dist, 'git', 'exec.js'));
const { checkoutBaseline } = await import(join(dist, 'git', 'repo.js'));
const { captureMetadata, validateOutside } = await import(join(dist, 'git', 'snapshot.js'));
const { observeIntegrity, registeredRefsMoved } = await import(join(dist, 'git', 'integrity.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-14T00:00:00.000Z';

// A repository with one commit on main (its own checkout is the managed
// integration worktree), an engine home, and a store naming them.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-integ-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  const scratch = join(dir, 'scratch');
  for (const d of [repo, join(home, 'workspaces'), scratch]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  const g = (...args) => execFileSync('git', args, { env, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g('-C', repo, 'add', 'a.txt');
  g('-C', repo, 'commit', '-q', '-m', 'one');
  const head = g('-C', repo, 'rev-parse', 'HEAD');
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 20, home: dir, incarnation: 'inc_unit' });

  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  const sql = (s, ...a) => db.prepare(s).run(...a);
  sql(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T2', ?, 'main', 'spec_ready', 'registered', '{}')`,
    AT,
    repo,
  );
  sql(`INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES ('ref_main', ?, 'prj_1', 'refs/heads/main', 'integration', ?, 0)`, AT, head);
  const fx = { dir, repo, home, scratch, head, db, g, seq: 0 };
  fx.rt = {
    home,
    scratch,
    engine: async (op, a) => {
      if (op === 'integrity.facts') return transact(db, ENGINE_ACTOR, (tx) => integrityFacts(tx, a));
      if (op === 'integrity.record') return transact(db, ENGINE_ACTOR, (tx) => recordIntegrity(tx, a));
      throw new Error(`unexpected engine op ${op}`);
    },
  };
  return fx;
}

async function integrationWorktree(fx) {
  const baseline = await checkoutBaseline(repoContext(fx.repo), fx.scratch);
  fx.db.prepare(`INSERT INTO managed_checkouts (id, created_at, project, kind, path, baseline, owner_run) VALUES ('mco_int', ?, 'prj_1', 'integration_worktree', ?, ?, NULL)`).run(AT, fx.repo, JSON.stringify(baseline));
}

// A run of `kind` in `state` with a detached workspace, recorded as the
// engine records one: a workspace row with its metadata baseline and a
// managed checkout with what the workspace holds as its baseline.
async function runWithWorkspace(fx, id, { kind = 'one_shot', state = 'executing' } = {}) {
  const seq = ++fx.seq;
  const path = join(fx.home, 'workspaces', id);
  fx.g('-C', fx.repo, 'worktree', 'add', '-q', '--detach', path, fx.head);
  const metadata = await captureMetadata(fx.repo, path);
  const baseline = await checkoutBaseline(worktreeContext(fx.repo, metadata.adminDir, path), fx.scratch);
  const sql = (s, ...a) => fx.db.prepare(s).run(...a);
  sql(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
     VALUES (?, ?, 'prj_1', ?, 'verification', '{}', ?, 'test', ?, 1, 0, 0, 0, 0)`,
    `wi_${id}`,
    AT,
    seq,
    state === 'ended' ? 'complete' : 'executing',
    `wi_${id}`,
  );
  sql(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES (?, ?, 'prj_1', ?, ?, ?, ?, ?, 'scripted', '1', 'm', ?, ?, 0)`,
    id,
    AT,
    seq,
    kind === 'session' ? null : `wi_${id}`,
    kind === 'session' ? 'spec_writer' : 'verifier',
    kind,
    state,
    fx.head,
    AT,
  );
  sql(
    `INSERT INTO workspaces (id, created_at, project, run, path, base_revision, current_base, disposition, metadata_baseline) VALUES (?, ?, 'prj_1', ?, ?, ?, ?, ?, ?)`,
    `ws_${id}`,
    AT,
    id,
    path,
    fx.head,
    fx.head,
    state === 'ended' ? 'retained' : 'active',
    JSON.stringify(metadata),
  );
  sql(`INSERT INTO managed_checkouts (id, created_at, project, kind, path, baseline, owner_run) VALUES (?, ?, 'prj_1', 'run_workspace', ?, ?, ?)`, `mco_${id}`, AT, path, JSON.stringify(baseline), id);
  return { id, path, metadata, checkout: `mco_${id}` };
}

// The run's end as the engine records it: ended, its workspace retained, and
// what the role left the checkout's baseline from now on.
async function endRun(fx, ws) {
  const baseline = await checkoutBaseline(worktreeContext(fx.repo, ws.metadata.adminDir, ws.path), fx.scratch);
  fx.db.prepare(`UPDATE runs SET state = 'ended', outcome = 'completed' WHERE id = ?`).run(ws.id);
  fx.db.prepare(`UPDATE workspaces SET disposition = 'retained' WHERE run = ?`).run(ws.id);
  fx.db.prepare(`UPDATE managed_checkouts SET baseline = ? WHERE id = ?`).run(JSON.stringify(baseline), ws.checkout);
}

const observedCheckouts = (fx) => fx.db.prepare(`SELECT checkout FROM out_of_band_changes WHERE subject_kind = 'checkout' AND closed_at IS NULL ORDER BY checkout`).all().map((r) => r.checkout);

test("integrity: a tick reads no ended work-item run's workspace; startup does, and observes one that was tampered with", async (t) => {
  const fx = fixture(t);
  await integrationWorktree(fx);
  const ended = [];
  for (let i = 1; i <= 3; i++) ended.push(await runWithWorkspace(fx, `run_w${i}`, { state: 'ended' }));
  const session = await runWithWorkspace(fx, 'run_s', { kind: 'session', state: 'ended' });

  // What a tick's evaluation reads: observeIntegrity reads exactly
  // facts.checkouts, so N ended work-item workspaces add no git read to it.
  const tick = transact(fx.db, ENGINE_ACTOR, (tx) => integrityFacts(tx, { project: 'prj_1' }));
  assert.deepEqual(tick.checkouts.map((c) => c.id).sort(), ['mco_int', session.checkout].sort(), "a tick: the integration worktree and the ended session's workspace, none of the three ended work-item workspaces");
  const startup = transact(fx.db, ENGINE_ACTOR, (tx) => integrityFacts(tx, { project: 'prj_1', startup: true }));
  assert.deepEqual(startup.checkouts.map((c) => c.id).sort(), ['mco_int', session.checkout, ...ended.map((w) => w.checkout)].sort(), 'startup: every managed checkout');

  // One of them is changed by hand. Ticks do not see it; the next startup does.
  writeFileSync(join(ended[1].path, 'a.txt'), 'changed by hand\n');
  await observeIntegrity(fx.rt, 'prj_1');
  await observeIntegrity(fx.rt, 'prj_1');
  assert.deepEqual(observedCheckouts(fx), [], 'no tick reads it, so none observes it');
  await observeIntegrity(fx.rt, 'prj_1', { startup: true });
  assert.deepEqual(observedCheckouts(fx), [ended[1].checkout], 'the startup evaluation observes the tampered workspace, through the out-of-band route');

  // A session's retained workspace is still read at every tick (D6 §2.4).
  writeFileSync(join(session.path, 'a.txt'), 'changed by hand\n');
  await observeIntegrity(fx.rt, 'prj_1');
  assert.deepEqual(observedCheckouts(fx), [ended[1].checkout, session.checkout].sort(), "a tick observes the ended session's workspace");
});

test('snapshot validation: two concurrent runs of one project, one ending midway through the other; the integration worktree and a session workspace still count', async (t) => {
  const fx = fixture(t);
  await integrationWorktree(fx);
  const a = await runWithWorkspace(fx, 'run_a');
  const b = await runWithWorkspace(fx, 'run_b');
  const session = await runWithWorkspace(fx, 'run_s', { kind: 'session', state: 'ended' });
  const registry = [{ ref: 'refs/heads/main', expected_oid: fx.head }];
  const validate = () =>
    validateOutside({ repo: fx.repo, path: a.path, metadata: a.metadata, registry, moving: {}, others: validatorCheckouts(fx.db, 'prj_1', a.id), scratch: fx.scratch });

  assert.deepEqual(validatorCheckouts(fx.db, 'prj_1', a.id).map((c) => c.path).sort(), [fx.repo, session.path].sort(), "A's validator compares the integration worktree and the ended session's workspace, not B's");

  // B writes its own workspace while A runs: not A's to classify.
  writeFileSync(join(b.path, 'a.txt'), 'b at work\n');
  assert.equal(await validate(), null, "another active run's writes are not a violation of this run");

  // B ends midway through A, with its end's baseline; it is then an ended
  // work-item workspace, read at startup only.
  await endRun(fx, b);
  assert.equal(await validate(), null, 'nor once that run has ended and its baseline is recorded');
  writeFileSync(join(b.path, 'a.txt'), 'after its end\n');
  assert.equal(await validate(), null, "an ended work-item run's workspace is not this run's validator's either");

  // A real change to the integration worktree still fails the run.
  writeFileSync(join(fx.repo, 'a.txt'), 'by hand\n');
  assert.deepEqual(await validate(), { klass: 'ref_violation', text: `the managed checkout ${fx.repo} differs from its baseline` });
  writeFileSync(join(fx.repo, 'a.txt'), 'a\n');
  assert.equal(await validate(), null, 'restored, it passes again');

  // As does a change to an ended session's retained workspace.
  writeFileSync(join(session.path, 'a.txt'), 'by hand\n');
  assert.deepEqual(await validate(), { klass: 'ref_violation', text: `the managed checkout ${session.path} differs from its baseline` });
});

test('the pre-dispatch recheck: a registered ref at its expected commit is not moved; one moved by hand, or deleted, is', async (t) => {
  const fx = fixture(t);
  const rt = { read: async (op, a) => (op === 'integrity.registry' ? registryFacts(fx.db, a) : assert.fail(`unexpected read ${op}`)) };
  assert.equal(await registeredRefsMoved(rt, 'prj_1'), false, 'the branch is where the engine expects it');
  // The integration branch moved by hand, after the tick's integrity step.
  writeFileSync(join(fx.repo, 'stray.txt'), 'moved by hand\n');
  fx.g('-C', fx.repo, 'add', 'stray.txt');
  fx.g('-C', fx.repo, 'commit', '-q', '-m', 'by hand');
  assert.equal(await registeredRefsMoved(rt, 'prj_1'), true, 'a commit made by hand moves it');
  // Once the engine expects the new commit, it is not moved.
  fx.db.prepare(`UPDATE ref_registry SET expected_oid = ? WHERE id = 'ref_main'`).run(fx.g('-C', fx.repo, 'rev-parse', 'HEAD'));
  assert.equal(await registeredRefsMoved(rt, 'prj_1'), false);
  // A registered ref that is gone is moved, never clean.
  fx.db.prepare(`INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES ('ref_gone', ?, 'prj_1', 'refs/surety/gone', 'nomination', ?, 1)`).run(AT, fx.head);
  assert.equal(await registeredRefsMoved(rt, 'prj_1'), true);
});

test("S1: a run's validation reads the registered refs between two reads of what the engine expects; another run's journaled move is no violation, an out-of-band one is", async (t) => {
  const fx = fixture(t);
  const a = await runWithWorkspace(fx, 'run_a');
  // Another run's integration moves main after A's facts were read: the
  // store expects the old head before the ref read and the new one after.
  writeFileSync(join(fx.repo, 'b.txt'), 'b\n');
  fx.g('-C', fx.repo, 'add', 'b.txt');
  fx.g('-C', fx.repo, 'commit', '-q', '-m', 'another run');
  const moved = fx.g('-C', fx.repo, 'rev-parse', 'HEAD');
  const stale = [{ ref: 'refs/heads/main', expected_oid: fx.head }];
  let reads = 0;
  const journaled = async () => (reads++ === 0 ? { registry: stale, moving: {} } : { registry: [{ ref: 'refs/heads/main', expected_oid: moved }], moving: {} });
  assert.equal(await validateOutside({ repo: fx.repo, path: a.path, metadata: a.metadata, registry: stale, moving: {}, others: [], scratch: fx.scratch, refFacts: journaled }), null);
  // In flight: the journal's move names the new head.
  const inFlight = async () => ({ registry: stale, moving: { 'refs/heads/main': [moved] } });
  assert.equal(await validateOutside({ repo: fx.repo, path: a.path, metadata: a.metadata, registry: stale, moving: {}, others: [], scratch: fx.scratch, refFacts: inFlight }), null);
  // Moved by hand: neither read expects it.
  const outOfBand = async () => ({ registry: stale, moving: {} });
  const v = await validateOutside({ repo: fx.repo, path: a.path, metadata: a.metadata, registry: stale, moving: {}, others: [], scratch: fx.scratch, refFacts: outOfBand });
  assert.equal(v?.klass, 'ref_violation');
});
