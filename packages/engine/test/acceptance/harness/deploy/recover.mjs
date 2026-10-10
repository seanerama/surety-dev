// Kills, restarts, reconcile reads, decisions on operations, invariants and
// a restored store, for the M4 slice-26 rows, "crash and recover" (M320 to
// M325; SEAM.md §§273 to 280). Used by the kernel-lane files on the
// scripted deployment adapter (SEAM.md §247) and by the sandbox-lane files
// beside harness/deploy/host.mjs.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §274). The only process anything here
// signals is the test's own engine child, in one of two ways, each fail-closed:
//   - `killAt` arms a barrier with the action `kill`: the engine sends
//     SIGKILL to itself at that point (SEAM.md §18). The test signals nothing.
//   - `killOwnEngine` calls `fx.engine.kill()`, which sends SIGKILL through
//     the ChildProcess handle the harness spawned (harness/engine.mjs), never
//     to a pid read from anywhere else. It first checks that the handle's
//     pid is a live process whose /proc/<pid>/cmdline names this test's own
//     SURETY_HOME, and refuses otherwise.
// No kill(-1), no process group, no pid from a file, a listing or the store.
// Nothing here touches a unit; host.mjs's acts (exact names after the
// containment read) are the only ones the sandbox files use.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { backup, restore } from '../backup.mjs';
import { CODES, answer, decision, decisionsOn } from '../decisions.mjs';
import { requestTick, tick, tickUntil } from '../runs.mjs';
import { withStore } from '../store.mjs';
import { adapterState, armBarrier, attemptsOf, environmentLeases, operationsOf, operationsRead, releaseBarrier, setTarget } from './kernel.mjs';

const json = (text) => (text === null || text === undefined ? text : typeof text === 'string' ? JSON.parse(text) : text);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- kills (SEAM.md §274) ---------------------------------------------------------------------

// The engine killed at a barrier by itself (the barrier's `kill`), ticks
// asked for until it has exited. Returns the dead engine.
export async function killAt(fx, project, name, { timeoutMs = 120_000 } = {}) {
  await armBarrier(fx.engine, name, 'kill');
  const dying = fx.engine;
  const until = Date.now() + timeoutMs;
  while (dying.isRunning()) {
    if (Date.now() > until) assert.fail(`the engine did not reach ${name} (and kill itself) within ${timeoutMs} ms`);
    try {
      await requestTick(dying, project);
    } catch {
      // it died meanwhile
    }
    await Promise.race([dying.exited, sleep(1000)]);
  }
  await dying.exited;
  return dying;
}

// SIGKILL to the test's own engine child, by the handle the harness spawned,
// after reading from /proc that it is that engine of this test's home.
export async function killOwnEngine(fx) {
  const engine = fx.engine;
  assert.ok(engine && engine.isRunning(), 'the engine to kill is running');
  const pid = engine.pid;
  assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid, `the engine child's pid is a host pid of its own (${pid})`);
  assert.equal(engine.proc.child.pid, pid, 'the pid is the ChildProcess handle the harness spawned');
  let cmdline;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  } catch (err) {
    assert.fail(`the engine child's /proc/${pid}/cmdline cannot be read (${err.code}): nothing is signalled`);
  }
  let environ;
  try {
    environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  } catch (err) {
    assert.fail(`the engine child's /proc/${pid}/environ cannot be read (${err.code}): nothing is signalled`);
  }
  assert.ok(cmdline.includes('serve'), `pid ${pid} is a surety engine (${cmdline.join(' ')})`);
  assert.ok(environ.includes(`SURETY_HOME=${fx.home}`), `pid ${pid} is this test's engine (SURETY_HOME=${fx.home}); nothing is signalled otherwise`);
  await engine.kill();
  assert.equal(engine.isRunning(), false, 'the engine child has exited');
}

// ---- barriers (SEAM.md §§18, 125, 274) --------------------------------------------------------

export const barriersOf = async (engine) => (await engine.get('/v1/harness/barriers')).body?.barriers ?? [];

export async function waitingAt(engine, name, { timeoutMs = 120_000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if ((await barriersOf(engine)).some((b) => b.name === name && b.state === 'waiting')) return;
    if (Date.now() > until) assert.fail(`nothing waited at ${name} within ${timeoutMs} ms`);
    await sleep(250);
  }
}

export { armBarrier, releaseBarrier };

// ---- the scripted target, at an effect's receipt (SEAM.md §§247, 251) ----------------------------

// Pause at `deploy.receipt_recorded`, run `start` (a request), wait there,
// set the target with `change(target)`, release. Returns the newest
// operation of `kind`.
export async function atReceipt(ctx, kind, start, change) {
  const { fx, project, env } = ctx;
  await armBarrier(fx.engine, 'deploy.receipt_recorded', 'pause');
  await start();
  for (let i = 0; i < 20; i++) {
    if ((await barriersOf(fx.engine)).some((b) => b.name === 'deploy.receipt_recorded' && b.state === 'waiting')) break;
    await requestTick(fx.engine, project);
    await sleep(500);
  }
  await waitingAt(fx.engine, 'deploy.receipt_recorded', { timeoutMs: 30_000 });
  const op = operationsOf(fx.home, project, kind).at(-1);
  const { target } = await adapterState(fx.engine, env.id);
  await setTarget(fx.engine, env.id, change({ complete: target.complete, units: target.units, resources: target.resources ?? [] }));
  await releaseBarrier(fx.engine, 'deploy.receipt_recorded');
  return op;
}

// A scripted unit of generation `n` of the environment (SEAM.md §247).
export const scriptedUnit = (name, generation, over = {}) => ({
  name,
  state: 'active',
  invocation_id: `${generation}`.padStart(2, '0').repeat(16).slice(0, 32),
  cgroup: `/user.slice/app.slice/${name}`,
  pending_job: false,
  generation,
  instance: { pid: 900000 + generation, start_time: 1000 + generation },
  init: { pid: 800000 + generation, start_time: 1000 + generation },
  tree: `sha256:${'0'.repeat(64)}`,
  ...over,
});

// ---- reconcile reads (SEAM.md §275) ---------------------------------------------------------

export const readsOf = (attempt) => (attempt?.reconciliation_reads ?? []).map((r) => r.result);
export const inventoryOf = (read) => (read?.read?.inventory ?? []).map((e) => e.resource);

// The attempt `n` (1-based) of an operation once `done(attempt)` holds.
export const attemptWhen = (ctx, op, n, done, what) =>
  tickUntil(
    ctx.fx.engine,
    ctx.project,
    () => {
      const a = attemptsOf(ctx.fx.home, op)[n - 1];
      return a && done(a) ? a : undefined;
    },
    { max: 24, what },
  );

export const firstRead = (ctx, op, what = 'the attempt\'s first reconcile read') => attemptWhen(ctx, op, 1, (a) => a.reconciliation_reads.length > 0, what);

// ---- the lease (SEAM.md §250) -----------------------------------------------------------------

export const leaseHeld = (home, environment) => environmentLeases(home, environment).some((l) => l.released_at === null);

// ---- decisions on an operation (SEAM.md §276) -----------------------------------------------

export const openOn = (home, kind, operation) => decisionsOn(home, kind, operation).filter((d) => d.status === 'open');

export async function openDecisionOn(ctx, kind, operation, { max = 16 } = {}) {
  return tickUntil(ctx.fx.engine, ctx.project, () => openOn(ctx.fx.home, kind, operation)[0], { max, what: `an open ${kind} decision about ${operation}` });
}

export const optionKeys = (row) => (row?.options ?? []).map((o) => o.key).sort();

// Answer an open decision with `option`; the decision consumed with it.
export async function answerOn(ctx, row, option) {
  const res = await answer(ctx.fx.engine, ctx.project, row, option);
  assert.equal(res.status, 200, `answer ${row.kind} ${row.id} with ${option} (SEAM.md §276) (body: ${res.text})`);
  const after = decision(ctx.fx.home, row.id);
  assert.deepEqual([after.status, after.answer?.option], ['consumed', option], `the ${row.kind} decision is consumed with ${option}`);
  return after;
}

export { CODES };

// ---- the invariants of D4 §4.3 (M321 (f)) ------------------------------------------------------

const TERMINAL = ['succeeded', 'reconciled_succeeded', 'failed', 'reconciled_absent'];
const UNIT = /surety-[0-9a-f]{12}-env_[0-9A-HJKMNP-TV-Z]{26}-g[1-9][0-9]*\.service/g;

// After a kill and recovery (D4 §4.3; D1 §16.2): no generation used twice;
// no unit started twice (no two applying effect calls create one name); no
// attempt lost or left started: every attempt terminal, or ambiguous or
// partial with an open decision on its operation; every operation's journal
// numbered from 1 without a gap and opened by `intended`; at most one
// deploy operation per authorization.
export async function assertInvariants(ctx) {
  const { fx, project, env } = ctx;
  const ops = [...operationsOf(fx.home, project, 'deploy'), ...operationsOf(fx.home, project, 'teardown')].filter((o) => o.target?.environment === env.id);
  const attempts = ops.flatMap((o) => attemptsOf(fx.home, o.id).map((a) => ({ ...a, op: o })));
  const generations = attempts.map((a) => a.deployment_generation).filter((g) => g !== null && g !== undefined);
  assert.equal(new Set(generations).size, generations.length, `no generation is used twice (${JSON.stringify(generations)})`);
  const state = await adapterState(fx.engine, env.id);
  const created = state.calls.filter((c) => c.call === 'deploy' && c.capability).flatMap((c) => c.capability.create_units ?? []);
  assert.equal(new Set(created).size, created.length, `no unit is started twice: no two deploy calls create one name (${JSON.stringify(created)})`);
  for (const a of attempts) {
    if (TERMINAL.includes(a.status)) continue;
    assert.ok(['ambiguous', 'reconciled_partial'].includes(a.status), `attempt ${a.attempt_number} of ${a.op.id} is terminal or ambiguous, never left ${a.status}`);
    const open = [...openOn(fx.home, 'blocker', a.op.id), ...openOn(fx.home, 'rollout_partial', a.op.id)];
    assert.ok(open.length > 0, `the ${a.status} attempt ${a.attempt_number} of ${a.op.id} has an open decision on its operation`);
  }
  const read = await operationsRead(fx.engine, project);
  for (const o of ops) {
    const journal = read.find((r) => r.id === o.id)?.journal ?? [];
    assert.deepEqual(journal.map((e) => e.seq), journal.map((_, i) => i + 1), `${o.id}'s journal is numbered from 1 without a gap`);
    assert.equal(journal[0]?.event_kind, 'intended', `${o.id}'s journal opens with intended`);
  }
  const deploys = ops.filter((o) => o.kind === 'deploy').map((o) => o.finalizer_inputs?.authorization);
  assert.equal(new Set(deploys).size, deploys.length, 'no duplicate deployment: one deploy operation per authorization');
}

// Every exact unit name a JSON value mentions.
export const unitsNamedIn = (value) => [...new Set(JSON.stringify(value ?? null).match(UNIT) ?? [])].sort();

// ---- the clock across a restart (SEAM.md §274) --------------------------------------------------

export const CLOCK_OFFSET = '--harness-clock-offset';

// ---- a store restored from a backup (SEAM.md §278) ---------------------------------------------

// `surety store backup` of a stopped engine's home. Returns its directory.
export function backupNow(fx) {
  assert.equal(fx.engine?.isRunning?.() ?? false, false, 'a backup is taken while no engine holds the home');
  const made = backup(fx.home);
  assert.equal(made.label ?? made.manifest?.label, 'complete', `the backup is complete (${JSON.stringify(made).slice(0, 300)})`);
  return made.dir ?? made.backup;
}

// The home's store moved aside into the test's own root (nothing deleted),
// then `surety store restore --from <dir> --bind <project>=<repo>` into the
// same home, which now has no store (SEAM.md §59).
export function restoreInPlace(fx, from, bindings) {
  assert.equal(fx.engine?.isRunning?.() ?? false, false, 'a restore runs while no engine holds the home');
  const aside = join(fx.root, `store-aside-${Date.now()}`);
  mkdirSync(aside, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const file = join(fx.home, `store.db${suffix}`);
    if (existsSync(file)) renameSync(file, join(aside, `store.db${suffix}`));
  }
  const done = restore(fx.home, from, bindings);
  assert.equal(done.status, 0, `surety store restore exits 0 (stderr: ${done.stderr})`);
  return aside;
}

// A write to a stopped engine's store (SEAM.md §19's practice), for a store
// whose restored rows the test makes disagree with the host.
export function storeWrite(fx, fn) {
  assert.equal(fx.engine?.isRunning?.() ?? false, false, 'the store is written only while no engine holds the home');
  return withStore(fx.home, fn, { readonly: false });
}

export { json, sleep, tick };
