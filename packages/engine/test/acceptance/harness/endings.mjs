// The run-end fault matrix (E28 item 1; SEAM.md §24; ../contract/run-end-faults.json).
// Every step of ending a run is repeatable: a step repeated after a partial
// failure writes the same facts it would have written the first time. This
// module brings a run to each of the ways a run can end in slice 2, with or
// without a one-shot fault armed on one store transaction of that ending,
// and reduces what the store, the repository and the file system then hold
// to facts that carry no id and no timestamp, so that the faulted ending can
// be compared with the unfaulted one.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { armFault, releaseBarrier, waitFor } from './engine.mjs';
import { CONTRACT, assertRefused } from './fixtures.mjs';
import { git } from './git.mjs';
import { hasIdForm } from './ids.mjs';
import { runPath, workPath } from './invariants.mjs';
import {
  addProject,
  addWork,
  advanceClock,
  advanceClockInSteps,
  requestTick,
  resolvedPath,
  run as runRow,
  runsOf,
  scriptedEngine,
  tick,
  tickUntil,
  waitForIdle,
  waitForRun,
  workItem,
} from './runs.mjs';
import { BOUNDARY, script, step } from './scripted.mjs';
import { withStore } from './store.mjs';

export const RUN_END_FAULTS = JSON.parse(readFileSync(new URL('../contract/run-end-faults.json', import.meta.url), 'utf8'));
export const ENDINGS = RUN_END_FAULTS.endings;
export const STAGES = ['before_end', 'quarantined'];

// One cell of the matrix per ending and fault, in the table's order.
export function matrixCells(table = RUN_END_FAULTS) {
  const cells = [];
  for (const [ending, spec] of Object.entries(table.endings)) {
    for (const fault of spec.faults) cells.push({ ending, title: spec.title, fault: { stage: 'before_end', ...fault } });
  }
  return cells;
}

// ---- facts ---------------------------------------------------------------------

const all = (db, sql, ...p) => db.prepare(sql).all(...p);
const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

// Event types whose number says nothing about what an ending wrote: how often
// a role's heartbeat renewed a lease, how many ticks the test asked for, and
// how many requests it sent (a command refused with a store error is sent again).
export const VOLATILE_EVENTS = ['run.heartbeat', 'engine.tick', 'api.act'];

// What a project's store holds, with nothing in it that differs between two
// executions of the same history: no id, no timestamp, no path. Rows are in
// their creation order (`seq`), and a row names another by its position in
// that order. `disk(workspaceRow)` returns {exists, registered} for a
// workspace: whether its directory is there and whether the repository still
// lists it as a worktree.
export function projectFacts(db, project, disk) {
  const items = all(db, 'SELECT * FROM "work_items" WHERE "project" = ? ORDER BY "seq"', project);
  const runs = all(db, 'SELECT * FROM "runs" WHERE "project" = ? ORDER BY "seq"', project);
  const itemIndex = new Map(items.map((w, i) => [w.id, i]));
  const runIndex = new Map(runs.map((r, i) => [r.id, i]));
  const decisionsAbout = (id) =>
    all(db, 'SELECT * FROM "decisions" WHERE "subject_id" = ? ORDER BY "seq"', id).map((d) => ({ kind: d.kind, status: d.status, option: json(d.answer)?.option ?? null }));

  const work = items.map((w) => ({
    kind: w.kind,
    status: w.status,
    repair_attempts: w.repair_attempts,
    preflight_refusals: w.preflight_refusals,
    no_progress_count: w.no_progress_count,
    dispatch_hold: w.dispatch_hold,
    blocker: json(w.blocker)?.reason ?? null,
    path: workPath(db, w.id),
    decisions: decisionsAbout(w.id),
  }));

  const runFacts = runs.map((r) => {
    const domains = all(db, 'SELECT * FROM "execution_domains" WHERE "run" = ? ORDER BY "id"', r.id);
    const eventCount = (key, id, type) =>
      db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" = ? AND json_extract("subject", '$.${key}') = ?`).get(type, id).n;
    const operations = all(
      db,
      `SELECT o.* FROM "operations" o WHERE EXISTS (
         SELECT 1 FROM "git_journal_events" e WHERE e."operation" = o."id" AND json_extract(e."payload", '$.run') = ?)
       ORDER BY o."seq"`,
      r.id,
    );
    return {
      work: itemIndex.get(r.work_item),
      role: r.role,
      kind: r.kind,
      state: r.state,
      outcome: r.outcome,
      reason_class: r.reason_class,
      quarantined: r.quarantined,
      finished: r.finished_at !== null,
      parent: r.parent_run === null ? null : runIndex.get(r.parent_run),
      path: runPath(db, r.id),
      ended_events: eventCount('run', r.id, 'run.ended'),
      leases: all(db, 'SELECT * FROM "leases" WHERE "resource_id" = ? ORDER BY "id"', r.id)
        .map((l) => `${l.resource_kind} ${l.released_at === null ? 'unreleased' : 'released'}`)
        .sort(),
      grants: all(db, 'SELECT * FROM "capability_grants" WHERE "run" = ? ORDER BY "id"', r.id).map((g) => (g.revoked_at === null ? 'live' : 'revoked')),
      domains: domains.map((d) => ({
        status: d.status,
        termination_confirmed: all(db, 'SELECT * FROM "process_ownership" WHERE "domain" = ?', d.id).every((o) => o.termination_confirmed_at !== null),
        terminated_events: eventCount('domain', d.id, 'domain.terminated'),
        quarantined_events: eventCount('domain', d.id, 'domain.quarantined'),
      })),
      workspaces: all(db, 'SELECT * FROM "workspaces" WHERE "run" = ? ORDER BY "id"', r.id).map((w) => ({
        disposition: w.disposition,
        disposed: w.disposed_at !== null,
        ...disk(w),
      })),
      receipts: all(db, 'SELECT * FROM "invocation_receipts" WHERE "run" = ? ORDER BY "id"', r.id).map((receipt) => ({
        statuses: all(db, 'SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ? ORDER BY "seq"', receipt.id).map((s) => s.status),
        usage: all(db, 'SELECT "semantics", "raw" FROM "usage_observations" WHERE "invocation" = ? ORDER BY "seq"', receipt.id).map((u) => `${u.semantics} ${u.raw}`),
        ledger: all(db, 'SELECT * FROM "ledger_rows" WHERE "invocation" = ? ORDER BY "id"', receipt.id).map((row) => ({
          original: row.corrects === null,
          names_run: row.run === r.id,
          role: row.role,
          billable_in: row.billable_in,
          cached_in: row.cached_in,
          out: row.out,
          usage_complete: row.usage_complete,
          cost_status: row.cost_status,
        })),
      })),
      operations: operations.map((o) => {
        const events = all(db, 'SELECT "journal_kind", "event_kind" FROM "git_journal_events" WHERE "operation" = ? ORDER BY "seq"', o.id);
        return { kind: o.kind, journal_kind: events[0]?.journal_kind ?? null, status: o.status, finalized: o.finalized_at !== null, journal_state: events.at(-1)?.event_kind ?? null };
      }),
      decisions: decisionsAbout(r.id),
    };
  });

  const events = {};
  for (const row of all(db, 'SELECT "type", COUNT(*) AS n FROM "events" GROUP BY "type" ORDER BY "type"')) {
    if (!VOLATILE_EVENTS.includes(row.type)) events[row.type] = row.n;
  }
  return { work, runs: runFacts, events };
}

const worktreesOf = (repo) =>
  git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolvedPath(line.slice('worktree '.length)));

// projectFacts of a live fixture, with the workspaces looked at on disk and in git.
export function factsOf(fx, project) {
  const repo = withStore(fx.home, (db) => db.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(project).dev_repo_path);
  const registered = worktreesOf(repo);
  const disk = (w) => ({ exists: existsSync(w.path) && statSync(w.path).isDirectory(), registered: registered.includes(resolvedPath(w.path)) });
  return withStore(fx.home, (db) => projectFacts(db, project, disk));
}

// What the contract table says the ending leaves, whatever was armed. `facts`
// is projectFacts once the project has gone on; the ending's own run is the
// first run of the first work item.
export function assertEndingExpectations(facts, spec, what) {
  const { expect } = spec;
  const run = facts.runs[0];
  assert.equal(run.work, 0, `${what}: the first run is the run of the first work item`);
  assert.deepEqual(
    { state: run.state, outcome: run.outcome, reason_class: run.reason_class, quarantined: run.quarantined, finished: run.finished },
    { state: 'ended', outcome: expect.outcome, reason_class: expect.reason_class, quarantined: 0, finished: true },
    `${what}: the run's end`,
  );
  assert.equal(run.ended_events, 1, `${what}: exactly one run.ended event`);
  assert.equal(run.path.at(-1), 'ended', `${what}: the run's events end at ended (path ${run.path.join(' → ')})`);
  assert.deepEqual(run.leases.filter((l) => l.endsWith('unreleased')), [], `${what}: no lease naming the run is unreleased`);
  assert.ok(run.leases.includes('run released'), `${what}: the run lease is released (leases: ${run.leases.join(', ')})`);
  assert.deepEqual(run.grants, ['revoked'], `${what}: the run's grant is revoked`);
  assert.ok(run.domains.length >= 1, `${what}: the run has a domain`);
  for (const d of run.domains) {
    assert.deepEqual({ status: d.status, termination_confirmed: d.termination_confirmed, terminated_events: d.terminated_events }, { status: 'terminated', termination_confirmed: true, terminated_events: 1 }, `${what}: every domain is terminated, once`);
  }
  if (expect.workspace !== null) {
    assert.equal(run.workspaces.length, 1, `${what}: one workspace`);
    const ws = run.workspaces[0];
    const gone = expect.workspace === 'discarded';
    assert.deepEqual(
      { disposition: ws.disposition, disposed: ws.disposed, exists: ws.exists, registered: ws.registered },
      { disposition: expect.workspace, disposed: gone, exists: !gone, registered: !gone },
      `${what}: the workspace's disposition, on disk and in the repository`,
    );
  }
  assert.equal(run.receipts.length, 1, `${what}: one invocation receipt`);
  const receipt = run.receipts[0];
  if (expect.launched) {
    assert.ok(['ended', 'unknown'].includes(receipt.statuses.at(-1)) && !receipt.statuses.includes('refused'), `${what}: a launched invocation ends with one terminal observation (observed ${receipt.statuses.join(', ')})`);
    assert.equal(receipt.statuses.filter((s) => ['ended', 'unknown'].includes(s)).length, 1, `${what}: exactly one terminal observation (observed ${receipt.statuses.join(', ')})`);
    assert.equal(receipt.ledger.filter((row) => row.original).length, 1, `${what}: exactly one original ledger row`);
    assert.ok(receipt.ledger.every((row) => row.names_run), `${what}: the ledger row names the run`);
  } else {
    assert.deepEqual(
      { refused: receipt.statuses.filter((s) => s === 'refused').length, launched: receipt.statuses.includes('launched'), terminal: receipt.statuses.filter((s) => ['ended', 'unknown'].includes(s)).length, ledger: receipt.ledger.length },
      { refused: 1, launched: false, terminal: 0, ledger: 0 },
      `${what}: an invocation that was never launched is recorded refused once and is not charged (observed ${receipt.statuses.join(', ')}; ${receipt.ledger.length} ledger row(s))`,
    );
  }
  const item = facts.work[0];
  assert.deepEqual(
    { status: item.status, repair_attempts: item.repair_attempts, preflight_refusals: item.preflight_refusals, dispatch_hold: item.dispatch_hold, blocker: item.blocker, runs: facts.runs.filter((r) => r.work === 0).length },
    expect.work,
    `${what}: the work item once the project has gone on`,
  );
  assert.equal(facts.work[1]?.status, spec.next, `${what}: the project's next item`);
  for (const r of facts.runs) assert.equal(r.state, 'ended', `${what}: every run of the project has ended`);
}

// ---- drivers -------------------------------------------------------------------

const TTL = CONTRACT.engine.lease_ttl.min;
const LONG_TTL = CONTRACT.engine.lease_ttl.max;
const REVIEW_DEADLINE = CONTRACT.project.deadline_reviewer.default;

// Stop and Abandon are two requests (SEAM.md §17). The first raises the
// confirmation; the fault is armed between the two. If the fault lands in the
// transaction of the second request, that request is refused with a store
// error and has changed nothing (SEAM.md §6): the operator sends it again.
async function confirmWithFault(ctx, command, arm) {
  const { fx, project } = ctx;
  const path = `/v1/projects/${project}/runs/${ctx.run}/${command}`;
  const first = await fx.engine.post(path, {});
  assertRefused(first, 409, 'confirm_required', `${command} without a preview hash`);
  const { decision, preview_hash: previewHash } = first.body.subject ?? {};
  assert.ok(hasIdForm(decision, 'dec_') && typeof previewHash === 'string', `confirm_required names its decision and preview hash: ${first.text}`);
  await arm('before_end', ctx);
  let second = await fx.engine.post(path, { preview_hash: previewHash });
  if (second.status === 500) {
    assertRefused(second, 500, 'store_error', `${command} whose transaction failed`);
    const row = runRow(fx.home, ctx.run);
    assert.equal(row.outcome, null, `a ${command} refused with a store error has changed nothing: the run has no outcome (it is ${row.state}, ${row.outcome})`);
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT "status" FROM "decisions" WHERE "id" = ?').get(decision).status), 'open', `and its confirmation is still open`);
    second = await fx.engine.post(path, { preview_hash: previewHash });
  }
  assert.equal(second.status, 200, `${command} with the preview hash (body: ${second.text})`);
}

// A verification item whose role reports usage and then waits at a hold.
async function heldRole(t, { config = {}, kind = 'verification', nextKind = 'review', role } = {}) {
  const fx = await scriptedEngine(t, { config: { lease_ttl: TTL, ...config } });
  const project = (await addProject(fx)).id;
  const item = await addWork(fx.engine, project, kind);
  fx.scripted.script(item, [role ?? script.hold('gate', { before: [step.usage({ input_tokens: 7 })] }), script.complete()]);
  fx.scripted.defaultScript(script.complete());
  await tick(fx.engine, project);
  await fx.scripted.waitForHolding({ work_item: item });
  const first = await waitForRun(fx.home, item, { state: 'executing' });
  return { fx, project, item, nextKind, run: first.id, ttl: config.lease_ttl ?? TTL };
}

// A verification item whose launch waits at the barrier before the spawn.
async function claimedRun(t) {
  const fx = await scriptedEngine(t, { config: { lease_ttl: TTL }, barriers: ['launch.before_spawn=pause'] });
  const project = (await addProject(fx)).id;
  const item = await addWork(fx.engine, project, 'verification');
  fx.scripted.defaultScript(script.complete());
  await requestTick(fx.engine, project);
  await fx.engine.waitUntil('barrier:launch.before_spawn');
  const first = await waitForRun(fx.home, item, { state: 'claimed' });
  return { fx, project, item, nextKind: 'review', run: first.id, ttl: TTL };
}

// Each driver brings one run to the point where its end begins, calls
// `arm(stage, ctx)` at the stages the contract table names, causes the end,
// and returns. It does not wait for the end: runEnding does.
const DRIVERS = {
  async role_completes(t, arm) {
    const ctx = await heldRole(t, { role: script.holdThenComplete('gate', [step.usage({ input_tokens: 7 })]) });
    await arm('before_end', ctx);
    ctx.fx.scripted.release(ctx.item);
    return ctx;
  },

  async invalid_result(t, arm) {
    const ctx = await heldRole(t, { role: { steps: [step.usage({ input_tokens: 7 }), step.hold('gate'), step.result({ verdict: 'not a result the schema knows' })] } });
    await arm('before_end', ctx);
    ctx.fx.scripted.release(ctx.item);
    return ctx;
  },

  async preflight_refused(t, arm) {
    // No scripted directory: no backend is qualified, and every dispatch is refused before launch.
    const fx = await scriptedEngine(t, { config: { lease_ttl: TTL }, start: false });
    await fx.start({ withScripted: false });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const ctx = { fx, project, item, nextKind: 'review', run: null, ttl: TTL };
    await arm('before_end', ctx);
    await requestTick(fx.engine, project);
    ctx.run = (await waitForRun(fx.home, item)).id;
    return ctx;
  },

  async deadline(t, arm) {
    const ctx = await heldRole(t, { config: { lease_ttl: LONG_TTL }, kind: 'review', nextKind: 'verification', role: script.hold('gate', { before: [step.usage({ input_tokens: 7 })], heartbeat_ms: 250 }) });
    await arm('before_end', ctx);
    // Past the deadline in steps shorter than lease_ttl, with real time for heartbeats between them.
    await advanceClockInSteps(ctx.fx.engine, REVIEW_DEADLINE, { stepSeconds: LONG_TTL - 10, pauseMs: 1200 });
    await advanceClock(ctx.fx.engine, 5);
    return ctx;
  },

  async stop_claimed(t, arm) {
    const ctx = await claimedRun(t);
    await confirmWithFault(ctx, 'stop', arm);
    await releaseBarrier(ctx.fx.engine, 'launch.before_spawn');
    return ctx;
  },

  async stop_executing(t, arm) {
    const ctx = await heldRole(t);
    await confirmWithFault(ctx, 'stop', arm);
    return ctx;
  },

  async abandon_claimed(t, arm) {
    const ctx = await claimedRun(t);
    await confirmWithFault(ctx, 'abandon', arm);
    await releaseBarrier(ctx.fx.engine, 'launch.before_spawn');
    return ctx;
  },

  async abandon_executing(t, arm) {
    const ctx = await heldRole(t);
    await confirmWithFault(ctx, 'abandon', arm);
    return ctx;
  },

  async lease_expiry(t, arm) {
    const ctx = await heldRole(t, { role: script.hold('gate', { before: [step.usage({ input_tokens: 7 })], heartbeat_ms: 250 }) });
    await arm('before_end', ctx);
    // One jump past the lease's whole lifetime: nothing can have renewed it in between.
    await advanceClock(ctx.fx.engine, TTL + 5);
    await tick(ctx.fx.engine, ctx.project);
    return ctx;
  },

  async quarantine_cleared(t, arm) {
    const ctx = await heldRole(t, { config: { terminate_grace: 1, kill_grace: 1 } });
    const { fx } = ctx;
    const domain = withStore(fx.home, (db) => db.prepare('SELECT "id" FROM "execution_domains" WHERE "run" = ?').get(ctx.run).id);
    // The boundary cannot read the domain: a stopped run is quarantined at that report.
    fx.scripted.boundary({ domains: { [domain]: BOUNDARY.unknown } });
    await confirmWithFault(ctx, 'stop', arm);
    await settle(ctx, () => runRow(fx.home, ctx.run).quarantined === 1, 'be quarantined');
    // The role was signalled; give it its grace to go before the boundary is read again.
    await sleep(1500);
    await arm('quarantined', ctx);
    fx.scripted.boundary({ domains: { [domain]: BOUNDARY.terminated } });
    await tick(fx.engine, ctx.project);
    return ctx;
  },
};

// Wait for the run to get somewhere, as the contract table's `retry` says:
// the engine retries a failed step itself, so first only wait. If that is
// not enough, give it bounded help that never restarts it: the clock moved
// by less than lease_ttl, a tick, and the wait again.
export async function settle(ctx, reached, what) {
  const { fx, project } = ctx;
  const { wait_ms: waitMs, rounds } = RUN_END_FAULTS.retry;
  const quiet = () => waitFor(reached, { timeoutMs: waitMs, what }).catch(() => {});
  await quiet();
  const stepSeconds = Math.floor((ctx.ttl * 2) / 3);
  for (let round = 0; round < rounds && !reached(); round++) {
    await advanceClock(fx.engine, stepSeconds);
    await tick(fx.engine, project);
    await quiet();
  }
  if (reached()) return;
  const row = runRow(fx.home, ctx.run);
  const leases = withStore(fx.home, (db) => db.prepare('SELECT * FROM "leases" WHERE "resource_id" = ?').all(ctx.run))
    .map((l) => `${l.resource_kind} ${l.released_at === null ? `unreleased, closing ${l.closing}, expires ${l.expires_at}` : 'released'}`)
    .join('; ');
  assert.fail(
    `run ${ctx.run} did not ${what}: after ${waitMs} ms and then ${rounds} rounds, each moving the clock ${stepSeconds} s (lease_ttl ${ctx.ttl} s), running two ticks and waiting ${waitMs} ms, ` +
      `it is ${row.state}, outcome ${row.outcome} / ${row.reason_class}, quarantined ${row.quarantined}; leases: ${leases || 'none'}. Nothing but a restart would end it.`,
  );
}

// Bring a run to the ending `name` and let the project go on. With `fault`
// (a cell's fault: {event_type, stage}) a one-shot before_event fault is
// armed at its stage. Returns the project's facts and, for each stage, the
// event types written after that stage's arming point (`written`), which is
// what shows that a fault armed there names a transaction on the path.
export async function runEnding(t, name, { fault = null } = {}) {
  const spec = ENDINGS[name];
  assert.ok(spec && DRIVERS[name], `the contract table and the drivers both know the ending ${name}`);
  const armedAt = {};
  const arm = async (stage, ctx) => {
    assert.ok(STAGES.includes(stage), `stage ${stage}`);
    armedAt[stage] = withStore(ctx.fx.home, (db) => db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get().n);
    if (fault && fault.stage === stage) await armFault(ctx.fx.engine, { point: 'before_event', event_type: fault.event_type });
  };
  const ctx = await DRIVERS[name](t, arm);
  const { fx, project } = ctx;
  if (fault) assert.ok(fault.stage in armedAt, `the ending ${name} has the stage ${fault.stage} at which the fault is armed`);

  await settle(ctx, () => runRow(fx.home, ctx.run).state === 'ended', 'end');
  // The work item gets where this ending leaves it (a repair, further
  // refusals). Only then does the project's next item arrive: which of two
  // eligible items a scheduler takes first is not what the matrix is about,
  // and with one item at a time the order of the project's runs is fixed.
  const { work } = spec.expect;
  const settled = () => workItem(fx.home, ctx.item).status === work.status && runsOf(fx.home, ctx.item).length >= work.runs;
  await tickUntil(fx.engine, project, settled, { max: 8, what: `the work item to be ${work.status} after ${work.runs} run(s)` });
  const next = await addWork(fx.engine, project, ctx.nextKind);
  await tickUntil(fx.engine, project, () => workItem(fx.home, next).status === spec.next, { max: 8, what: `the project's next item to be ${spec.next}` });
  await waitForIdle(fx.home, project);

  const written = {};
  for (const [stage, seq] of Object.entries(armedAt)) {
    written[stage] = withStore(fx.home, (db) => db.prepare('SELECT DISTINCT "type" FROM "events" WHERE "seq" > ?').all(seq).map((e) => e.type));
  }
  return { facts: factsOf(fx, project), written, ctx };
}

// The unfaulted ending, run once per ending and test file: the reference
// every cell of that ending is compared with. A reference that could not be
// produced fails every cell that asks for it.
const references = new Map();
export function reference(name) {
  if (!references.has(name)) {
    const cleanup = [];
    const scope = { after: (fn) => cleanup.push(fn) };
    references.set(
      name,
      (async () => {
        try {
          const { facts, written } = await runEnding(scope, name);
          assertEndingExpectations(facts, ENDINGS[name], `${name}, no fault`);
          return { facts, written };
        } finally {
          for (const fn of cleanup.reverse()) await fn();
        }
      })(),
    );
    references.get(name).catch(() => {});
  }
  return references.get(name);
}

// One cell: the ending with the fault armed reaches the facts of the ending
// without it.
export async function assertCell(t, cell) {
  const spec = ENDINGS[cell.ending];
  let ref;
  try {
    ref = await reference(cell.ending);
  } catch (err) {
    throw new Error(`the unfaulted reference for "${spec.title}" could not be produced, so no cell of this ending can be judged: ${err.message}`, { cause: err });
  }
  assert.ok(
    ref.written[cell.fault.stage]?.includes(cell.fault.event_type),
    `the unfaulted ending "${spec.title}" writes no ${cell.fault.event_type} event after the point where the fault is armed (${cell.fault.stage}), so the fault would name no transaction on its path. ` +
      `It writes: ${(ref.written[cell.fault.stage] ?? []).join(', ') || 'nothing'}`,
  );
  const what = `${spec.title}; ${cell.fault.what} fails once`;
  const { facts } = await runEnding(t, cell.ending, { fault: cell.fault });
  assertEndingExpectations(facts, spec, what);
  assert.deepEqual(facts, ref.facts, `${what}: the final durable facts differ from those of the same ending with no fault`);
}
