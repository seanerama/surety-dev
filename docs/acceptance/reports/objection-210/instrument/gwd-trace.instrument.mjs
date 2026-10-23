// Objection 210's scratch instrument (never committed as an acceptance file):
// the first case of M15-git-write-deadline-in-a-running-engine up to the read
// of the branch update's ambiguity, with an ordering trace written to
// $GWD_OUT/<tag>.json. GWD_ROOT names the checkout whose harness (and so whose
// compiled engine) runs. GWD_MODE:
//   as-is             the case's synchronization, unchanged
//   delayed           as-is, with the test thread pausing GWD_DELAY_MS after
//                     the commit's finalization is read (a test late under load)
//   corrected         the proposed synchronization: `scheduler.tick_running`
//                     armed while the commit's probe holds its tick
//   corrected-delayed corrected, with the same pause
// The assertion read is the case's own, unchanged.
import assert from 'node:assert/strict';
import { copyFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.env.GWD_ROOT;
const MODE = process.env.GWD_MODE ?? 'as-is';
const OUT = process.env.GWD_OUT ?? '/tmp/vgw/out';
const TAG = process.env.GWD_TAG ?? `${MODE}-${process.pid}`;
const DELAY_MS = Number(process.env.GWD_DELAY_MS ?? 3000);
const H = `${ROOT}/packages/engine/test/acceptance/harness`;
const { reachBarrier } = await import(`${H}/decisions.mjs`);
const { releaseBarrier, waitFor } = await import(`${H}/engine.mjs`);
const { addGitProject, addItem, permittedEdit, roleThat } = await import(`${H}/gitruns.mjs`);
const { heldGitWrites } = await import(`${H}/held-writes.mjs`);
const { armBarrier, operationDetails, recoveryBarrier } = await import(`${H}/journal.mjs`);
const { commitsNaming, parentsOf, refsContaining, treeOf } = await import(`${H}/repos.mjs`);
const { requestTick, scriptedEngine, waitForRun } = await import(`${H}/runs.mjs`);
const { withStore } = await import(`${H}/store.mjs`);
const { script } = await import(`${H}/scripted.mjs`);

const GIT_DEADLINE = 2;
const KILL_WAIT_MS = (GIT_DEADLINE + 8) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test(`gwd trace ${MODE} (${ROOT})`, async (t) => {
  const marks = [];
  const mark = (what) => marks.push({ at: new Date().toISOString(), what });
  const writes = heldGitWrites(t);
  const commitReconciled = recoveryBarrier('commit_tree');
  const integrationReconciled = recoveryBarrier('ref_update');
  const fx = await scriptedEngine(t, { env: { ...writes.env, ...(process.env.GWD_TICK_LOG ? { GWD_TICK_LOG: process.env.GWD_TICK_LOG } : {}) }, config: { git_deadline: GIT_DEADLINE }, barriers: [`${commitReconciled}=pause`, `${integrationReconciled}=pause`] });
  const project = await addGitProject(fx);
  const repo = project.repo.path;
  const item = await addItem(fx, project.id, 'fix');
  fx.scripted.script(item, [roleThat([permittedEdit()])]);
  writes.holdCommit();
  writes.holdRefUpdate(project.repo.ref);
  await requestTick(fx.engine, project.id);
  const run = await waitForRun(fx.home, item);
  const opOf = (kind) => operationDetails(fx.home, { project: project.id, run: run.id, journalKind: kind })[0];
  const withEvent = (kind, event) =>
    waitFor(
      () => {
        const op = opOf(kind);
        return op && op.events.some((e) => e.kind === event) ? op : undefined;
      },
      { timeoutMs: 30_000 + KILL_WAIT_MS, what: `the run's ${kind} operation to have a ${event} event` },
    );
  await withEvent('commit_tree', 'ambiguous');
  const later = await addItem(fx, project.id, 'verification');
  fx.scripted.script(later, [script.complete()]);
  await reachBarrier(fx, project.id, commitReconciled);
  mark('commit_reconciled_reached');
  const corrected = MODE.startsWith('corrected');
  const corrected4 = MODE.startsWith('corrected4');
  const corrected2 = MODE.startsWith('corrected2') || MODE.startsWith('corrected3') || corrected4;
  const tickEndsSince = (seq) => withStore(fx.home, (db) => db.prepare(`SELECT "seq", "at" FROM "events" WHERE "type" = 'engine.tick' AND "seq" > ? ORDER BY "seq"`).all(seq));
  const maxSeq = () => withStore(fx.home, (db) => db.prepare('SELECT MAX("seq") AS n FROM "events"').get().n);
  const heldFrom = maxSeq();
  if (corrected2) {
    // The commit's probe holds the tick T_c in its journal step: T_c cannot
    // reach select before the commit's retry is released. Held there from
    // now, with the branch update's intent held where journal steps skip it
    // (an intended operation not yet begun is its caller's).
    await armBarrier(fx.engine, 'scheduler.tick_running', 'pause');
    await armBarrier(fx.engine, 'journal.ref_update.intent_committed', 'pause');
    mark('tick_running_and_intent_armed');
  } else if (corrected) {
    // The proposed synchronization: the tick whose journal step holds the
    // commit's probe is held before select once it has gone on, so no journal
    // step can begin until the branch update's ambiguity has been read.
    await armBarrier(fx.engine, 'scheduler.tick_running', 'pause');
    mark('tick_running_armed');
  }
  writes.release('hash-object');
  await releaseBarrier(fx.engine, commitReconciled);
  mark('commit_reconciled_released');
  const madeCommit = await withEvent('commit_tree', 'finalized');
  mark('commit_finalized_read');
  const named = commitsNaming(repo, `Surety-Run: ${run.id}`);
  assert.equal(named.length, 1);
  treeOf(repo, named[0]);
  parentsOf(repo, named[0]);
  refsContaining(repo, named[0]);
  mark('commit_git_reads_done');
  if (corrected4) {
    if (MODE.endsWith('delayed')) {
      await sleep(DELAY_MS);
      mark(`test_thread_paused_${DELAY_MS}ms`);
    }
    await reachBarrier(fx, project.id, 'journal.ref_update.intent_committed');
    mark('ref_update_intent_held');
    await reachBarrier(fx, project.id, 'scheduler.tick_running');
    mark('tick_running_reached');
  } else if (corrected2) {
    await reachBarrier(fx, project.id, 'scheduler.tick_running');
    mark('tick_running_reached');
    await reachBarrier(fx, project.id, 'journal.ref_update.intent_committed');
    mark('ref_update_intent_held');
    // The precondition, checked rather than assumed: the tick held is the one
    // that probed the commit (no tick has ended since), so no journal step has
    // begun since the branch update was intended.
    const probedAt = opOf('commit_tree').attempts[0]?.reads.at(-1)?.at;
    mark(`commit_probed_at ${probedAt}`);
    const endedAfterProbe = withStore(fx.home, (db) => db.prepare(`SELECT "seq", "at" FROM "events" WHERE "type" = 'engine.tick' AND "at" > ? ORDER BY "seq"`).all(probedAt));
    mark(`ticks_ended_after_commit_probe ${JSON.stringify(endedAfterProbe)}`);
    const ended = tickEndsSince(heldFrom);
    mark(`ticks_ended_since_reached ${JSON.stringify(ended)}`);
    if (corrected4) mark(`ticks_counted_at_hold ${withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" = 'engine.tick'`).get().n)}`);
    if (MODE.startsWith('corrected2')) assert.deepEqual(ended, [], `the scheduler is held in the commit's probe tick: no tick ended since (${JSON.stringify(ended)})`);
  }
  if (MODE === 'inflight2') {
    // Forced, tighter: the branch update's attempt has begun and a tick has
    // ended since (so every tick the case can catch from now begins its
    // journal step with the update in flight or already killed).
    const att = await waitFor(() => opOf('ref_update')?.attempts.find((a) => a.status === 'started'), { timeoutMs: 20_000, intervalMs: 20, what: "the branch update's attempt to begin" });
    mark('ref_update_attempt_in_flight');
    await waitFor(
      async () => {
        const ended = withStore(fx.home, (db) => db.prepare(`SELECT "at" FROM "events" WHERE "type" = 'engine.tick' AND "at" > ? LIMIT 1`).get(att.started_at));
        if (ended) return true;
        await requestTick(fx.engine, project.id);
        return undefined;
      },
      { timeoutMs: 20_000, intervalMs: 20, what: 'a tick to end after the attempt began' },
    );
    mark('tick_ended_after_attempt_start');
  }
  if (MODE === 'inflight') {
    // Forced: the commit's probe tick has ended (past select), and the branch
    // update's one attempt has begun; only then is the barrier armed and a
    // tick requested, whose journal step meets the update in flight.
    await waitFor(() => (tickEndsSince(heldFrom).length > 0 ? true : undefined), { timeoutMs: 20_000, intervalMs: 20, what: "the commit's probe tick to end" });
    mark('commit_tick_ended');
    await waitFor(() => (opOf('ref_update')?.attempts.some((a) => a.status === 'started') ? true : undefined), { timeoutMs: 20_000, intervalMs: 20, what: "the branch update's attempt to begin" });
    mark('ref_update_attempt_in_flight');
  }
  if (MODE.endsWith('delayed')) {
    await sleep(DELAY_MS);
    mark(`test_thread_paused_${DELAY_MS}ms`);
  }
  if (corrected2) {
    await releaseBarrier(fx.engine, 'journal.ref_update.intent_committed');
    mark('ref_update_intent_released');
  } else if (!corrected) {
    await armBarrier(fx.engine, 'scheduler.tick_running', 'pause');
    mark('tick_running_armed');
    await requestTick(fx.engine, project.id);
    mark('tick_requested');
  }
  if (!corrected2) {
    await reachBarrier(fx, project.id, 'scheduler.tick_running');
    mark('tick_running_reached');
  }
  const ambiguousMove = await withEvent('ref_update', 'ambiguous');
  mark('ref_update_ambiguity_read');
  const observed = [ambiguousMove.state, ambiguousMove.status, ambiguousMove.attempts.map((a) => a.status)];
  if (corrected2 && !corrected4) assert.deepEqual(tickEndsSince(heldFrom), [], 'still no tick ended when the ambiguity was read');
  if (corrected4) mark(`ticks_counted_at_read ${withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" = 'engine.tick'`).get().n)}`);

  // The ordering trace, from the store as it stands at the read.
  const trace = withStore(fx.home, (db) => {
    const ops = db.prepare('SELECT "id", "kind", "status", "created_at" FROM "operations" WHERE "project" = ? ORDER BY "seq"').all(project.id);
    const journal = db.prepare('SELECT j."created_at", j."seq", j."journal_kind", j."event_kind", j."operation" FROM "git_journal_events" j WHERE j."project" = ? ORDER BY j."created_at", j."seq"').all(project.id);
    const attempts = db.prepare('SELECT "operation", "attempt_number", "status", "started_at", "finished_at", "timeline", "reconciliation_reads" FROM "operation_attempts" WHERE "project" = ? ORDER BY "started_at"').all(project.id);
    const events = db.prepare(`SELECT "seq", "type", "at", "subject", "payload" FROM "events" ORDER BY "seq"`).all();
    return { ops, journal, attempts, events };
  });
  // The barriers, as the engine holds them at the read.
  const barriers = (await fx.engine.get('/v1/harness/barriers')).body?.barriers ?? [];
  // The engine's own log lines, copied before the fixture removes the home.
  for (const f of readdirSync(fx.home).filter((n) => /\.log$/.test(n))) copyFileSync(join(fx.home, f), join(OUT, `${TAG}.${f}`));
  writeFileSync(join(OUT, `${TAG}.json`), `${JSON.stringify({ root: ROOT, mode: MODE, delay_ms: DELAY_MS, observed, marks, barriers, trace }, null, 1)}\n`);
  // Let the engine go on before the fixture tears down.
  for (const b of ['scheduler.tick_running', integrationReconciled]) await releaseBarrier(fx.engine, b).catch(() => null);
  writes.release('update-ref');
  void madeCommit;
  assert.deepEqual(observed, ['ambiguous', 'ambiguous', ['ambiguous']], 'the branch update is ambiguous: its one attempt was killed at the deadline');
});
