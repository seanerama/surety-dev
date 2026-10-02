// What the store must show about runs, as assertions over an open connection
// (SEAM.md §16; D1 §§4.5, 16.2; ../contract/run-lifecycle.json). A crash or
// interruption test asserts identities, counts and dispositions, not a state
// label (Plan §2), so these read every row a run owns. They take a database
// handle: the harness self-check of slices 1 to 3 ran each of them against a
// witness store and against mutants of it (it is deleted since; SEAM.md §21).

import assert from 'node:assert/strict';

import { LIFECYCLE, assertRunPathLegal, assertWorkPathLegal, outcomeSpec, roleOf } from './transitions.mjs';

const all = (db, sql, ...params) => db.prepare(sql).all(...params);
const one = (db, sql, ...params) => db.prepare(sql).get(...params);
const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

export const eventsAbout = (db, key, id, typeLike = '%') =>
  all(db, `SELECT * FROM "events" WHERE "type" LIKE ? AND json_extract("subject", '$.${key}') = ? ORDER BY "seq"`, typeLike, id).map((e) => ({
    ...e,
    subject: json(e.subject),
    payload: json(e.payload),
  }));

// Every row a run owns.
export function runFacts(db, runId) {
  const run = one(db, 'SELECT * FROM "runs" WHERE "id" = ?', runId);
  assert.ok(run, `run ${runId} exists`);
  const domains = all(db, 'SELECT * FROM "execution_domains" WHERE "run" = ? ORDER BY "id"', runId);
  const receipts = all(db, 'SELECT * FROM "invocation_receipts" WHERE "run" = ? ORDER BY "id"', runId).map((receipt) => ({
    ...receipt,
    statuses: all(db, 'SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ? ORDER BY "seq"', receipt.id).map((r) => r.status),
    usage: all(db, 'SELECT * FROM "usage_observations" WHERE "invocation" = ? ORDER BY "seq"', receipt.id),
    ledger: all(db, 'SELECT * FROM "ledger_rows" WHERE "invocation" = ? ORDER BY "id"', receipt.id),
  }));
  return {
    run,
    work: one(db, 'SELECT * FROM "work_items" WHERE "id" = ?', run.work_item),
    domains,
    ownership: domains.flatMap((d) => all(db, 'SELECT * FROM "process_ownership" WHERE "domain" = ?', d.id)),
    receipts,
    leases: all(db, 'SELECT * FROM "leases" WHERE "resource_id" = ? ORDER BY "id"', runId),
    grants: all(db, 'SELECT * FROM "capability_grants" WHERE "run" = ?', runId),
    workspaces: all(db, 'SELECT * FROM "workspaces" WHERE "run" = ?', runId),
    decisions: all(db, `SELECT * FROM "decisions" WHERE "subject_type" = 'run' AND "subject_id" = ? ORDER BY "id"`, runId),
  };
}

// The states a run went through, read from its events (D1 §4.1).
export function runPath(db, runId) {
  const map = LIFECYCLE.run.event_state;
  return eventsAbout(db, 'run', runId, 'run.%')
    .filter((e) => e.type in map)
    .map((e) => map[e.type]);
}

// The statuses a work item went through, read from its work.* events. Each
// event's `from` must be the status the previous one left it in. One event
// is not a step: the work.resumed of a Resume that only lifts a dispatch
// hold, whose `from` and `to` are both the status the item keeps (SEAM.md §15).
export function workPath(db, workItem) {
  const events = eventsAbout(db, 'work_item', workItem, 'work.%');
  assert.ok(events.length > 0, `work item ${workItem} has work.* events`);
  assert.equal(events[0].type, 'work.created', `the first work event of ${workItem}`);
  const path = [events[0].payload.to];
  for (const e of events.slice(1)) {
    assert.equal(e.payload.from, path.at(-1), `${e.type} (seq ${e.seq}) of ${workItem} starts where the previous event ended; path so far ${path.join(' → ')}`);
    if (e.type === 'work.resumed' && e.payload.to === e.payload.from) continue;
    path.push(e.payload.to);
  }
  return path;
}

// The item's whole history is legal for its kind and ends at its row's status.
export function assertWorkHistory(db, workItem) {
  const row = one(db, 'SELECT * FROM "work_items" WHERE "id" = ?', workItem);
  assert.ok(row, `work item ${workItem} exists`);
  const path = workPath(db, workItem);
  assert.equal(path.at(-1), row.status, `the events of ${workItem} end at its row's status; path ${path.join(' → ')}`);
  assertWorkPathLegal(row.kind, path, `work item ${workItem}`);
  return path;
}

const TERMINAL_OBSERVATIONS = ['ended', 'unknown'];

// One receipt of a run that has ended (D1 §4.5 step 5, §13.1). Either the
// invocation was never launched: it is recorded `refused` once and has no
// ledger row. Or it was launched, or whether it was cannot be established: it
// has exactly one terminal observation (`ended` or `unknown`), which is the
// last, and is charged exactly once. Returns true for the second form.
function assertReceiptFinal(receipt, run, what) {
  const s = receipt.statuses;
  const seen = s.join(', ') || 'no observation';
  const terminal = s.filter((x) => TERMINAL_OBSERVATIONS.includes(x)).length;
  const refused = s.filter((x) => x === 'refused').length;
  const originals = receipt.ledger.filter((row) => row.corrects === null);
  if (terminal === 0 && !s.includes('launched')) {
    assert.equal(refused, 1, `${what}: an invocation that was never launched is recorded refused once, observed ${seen}`);
    assert.equal(receipt.ledger.length, 0, `${what}: no ledger row for an invocation that was never launched`);
    return false;
  }
  assert.equal(terminal, 1, `${what}: exactly one terminal status observation, observed ${seen}`);
  assert.ok(TERMINAL_OBSERVATIONS.includes(s.at(-1)), `${what}: the terminal observation is the last one, observed ${seen}`);
  assert.equal(refused, 0, `${what}: an invocation is not both refused and ended, observed ${seen}`);
  assert.equal(originals.length, 1, `${what}: exactly one original ledger row`);
  assert.equal(originals[0].run, run.id, `${what}: the ledger row names the run`);
  assert.equal(originals[0].role, run.role, `${what}: the ledger row names the role`);
  if (receipt.usage.length === 0) {
    const row = originals[0];
    assert.deepEqual(
      { billable_in: row.billable_in, cached_in: row.cached_in, out: row.out, usage_complete: row.usage_complete, cost_status: row.cost_status },
      { billable_in: null, cached_in: null, out: null, usage_complete: 0, cost_status: 'unknown' },
      `${what}: usage that was never observed is unknown, not zero`,
    );
  }
  return true;
}

// A run that has ended (SEAM.md §16 "A run that has ended"). `expect` may give
// outcome, reason_class, workspace (a disposition), launched (true: at least
// one invocation is recorded as ended or unknown and charged; false: every
// invocation is recorded refused) and recovery (an incarnation
// id: ended by that incarnation's startup recovery; false: not by recovery).
export function assertEndedRun(db, runId, expect = {}) {
  const f = runFacts(db, runId);
  const { run } = f;
  const what = `run ${runId}`;
  assert.equal(run.state, 'ended', `${what}: state`);
  assert.ok(run.outcome, `${what}: an ended run has an outcome`);
  if (expect.outcome !== undefined) assert.equal(run.outcome, expect.outcome, `${what}: outcome`);
  const spec = outcomeSpec(run.outcome);
  assert.ok(spec.reason_class.includes(run.reason_class), `${what}: reason class ${run.reason_class} does not belong to outcome ${run.outcome}`);
  if (expect.reason_class !== undefined) assert.equal(run.reason_class, expect.reason_class, `${what}: reason class`);
  assert.ok(run.finished_at, `${what}: finished_at is set`);
  assert.equal(run.quarantined, 0, `${what}: an ended run is not quarantined`);

  for (const d of f.domains) {
    assert.ok(LIFECYCLE.domain.terminal.includes(d.status), `${what}: domain ${d.id} is terminated (it is ${d.status})`);
    assert.equal(eventsAbout(db, 'domain', d.id, 'domain.terminated').length, 1, `${what}: exactly one domain.terminated event for ${d.id}`);
  }
  for (const o of f.ownership) assert.ok(o.termination_confirmed_at, `${what}: ownership ${o.id} records when termination was confirmed`);

  const held = f.leases.filter((l) => l.released_at === null);
  assert.deepEqual(held.map((l) => `${l.resource_kind}:${l.id}`), [], `${what}: no unreleased lease names an ended run`);
  for (const g of f.grants) assert.ok(g.revoked_at, `${what}: grant ${g.id} is revoked`);

  const disposition = expect.workspace ?? spec.workspace;
  for (const w of f.workspaces) {
    if (disposition !== null && disposition !== undefined) assert.equal(w.disposition, disposition, `${what}: workspace ${w.id} disposition`);
    assert.notEqual(w.disposition, 'active', `${what}: the workspace of an ended run is not active`);
    if (w.disposition === 'discarded') assert.ok(w.disposed_at, `${what}: a discarded workspace records when`);
  }

  let launches = 0;
  for (const receipt of f.receipts) if (assertReceiptFinal(receipt, run, `${what}, invocation ${receipt.id}`)) launches++;
  if (expect.launched === true) assert.ok(launches >= 1, `${what}: an invocation that was launched is recorded as ended or unknown, and charged`);
  if (expect.launched === false) assert.equal(launches, 0, `${what}: no invocation is recorded as launched`);

  const ended = eventsAbout(db, 'run', runId, 'run.ended');
  assert.equal(ended.length, 1, `${what}: exactly one run.ended event`);
  assert.equal(ended[0].payload.outcome, run.outcome, `${what}: run.ended names the outcome`);
  if (expect.recovery === false) assert.ok(ended[0].payload.recovery === undefined || ended[0].payload.recovery === null, `${what}: not ended by recovery`);
  else if (expect.recovery !== undefined) {
    assert.equal(ended[0].payload.recovery?.incarnation, expect.recovery, `${what}: run.ended records the recovering incarnation`);
  }
  const path = runPath(db, runId);
  assertRunPathLegal(path, what);
  assert.equal(path.at(-1), 'ended', `${what}: its events end at ended; path ${path.join(' → ')}`);
  return f;
}

// A run whose termination has not been established (SEAM.md §16
// "Quarantine"). `expect.outcome` pins the recorded outcome; `expect.blocker`
// is 'open' (default) or 'any' (it may have been acknowledged).
export function assertQuarantinedRun(db, runId, expect = {}) {
  const f = runFacts(db, runId);
  const { run } = f;
  const what = `quarantined run ${runId}`;
  assert.equal(run.state, 'finalizing', `${what}: state`);
  assert.equal(run.quarantined, 1, `${what}: quarantined flag`);
  assert.ok(run.outcome, `${what}: the outcome was recorded on entering finalizing`);
  if (expect.outcome !== undefined) assert.equal(run.outcome, expect.outcome, `${what}: outcome`);
  const quarantined = f.domains.filter((d) => d.status === 'quarantined');
  assert.ok(quarantined.length >= 1, `${what}: at least one domain is quarantined, observed ${f.domains.map((d) => d.status).join(', ') || 'no domain'}`);
  for (const d of quarantined) {
    assert.ok(eventsAbout(db, 'domain', d.id, 'domain.quarantined').length >= 1, `${what}: domain.quarantined event for ${d.id}`);
    assert.equal(eventsAbout(db, 'domain', d.id, 'domain.terminated').length, 0, `${what}: no domain.terminated event for ${d.id}`);
  }
  for (const w of f.workspaces) assert.equal(w.disposition, 'quarantined', `${what}: workspace ${w.id} disposition`);
  const held = f.leases.filter((l) => l.released_at === null);
  assert.deepEqual(held.map((l) => l.resource_kind), ['quarantine'], `${what}: the only unreleased lease naming the run is its quarantine reservation`);
  const blockers = f.decisions.filter((d) => d.kind === 'blocker');
  assert.ok(blockers.length >= 1, `${what}: a blocker decision names the run`);
  if ((expect.blocker ?? 'open') === 'open') assert.ok(blockers.some((d) => d.status === 'open'), `${what}: its blocker is open`);
  assert.ok(eventsAbout(db, 'run', runId, 'run.quarantined').length >= 1, `${what}: run.quarantined event`);
  assert.ok(eventsAbout(db, 'run', runId, 'engine.quarantine').length >= 1, `${what}: engine.quarantine event`);
  assert.equal(eventsAbout(db, 'run', runId, 'run.ended').length, 0, `${what}: no run.ended event`);
  assert.notEqual(f.work.status, 'complete', `${what}: its work item is not complete`);
  return f;
}

// What a dispatch has written (SEAM.md §16). `phase` is 'before_spawn' or
// 'launched'. `expect` may give incarnation, base (a commit id) and
// deadline_s (the role's deadline setting).
export function assertDispatched(db, runId, phase, expect = {}) {
  const f = runFacts(db, runId);
  const { run, work } = f;
  const what = `run ${runId} (${phase})`;
  const launched = phase === 'launched';
  assert.equal(run.kind, 'one_shot', `${what}: kind`);
  assert.equal(run.backend, 'scripted', `${what}: backend`);
  assert.equal(run.state, launched ? 'executing' : 'claimed', `${what}: state`);
  assert.equal(run.outcome, null, `${what}: no outcome yet`);
  const role = roleOf(work.kind);
  if (role !== null) assert.equal(run.role, role, `${what}: role of a ${work.kind} run`);
  assert.equal(work.status, launched ? 'executing' : 'claimed', `${what}: work item status`);
  if (expect.base !== undefined) assert.equal(run.base_revision, expect.base, `${what}: base revision`);
  if (expect.deadline_s !== undefined) {
    const span = (Date.parse(run.deadline_at) - Date.parse(run.created_at)) / 1000;
    assert.ok(Math.abs(span - expect.deadline_s) <= 5, `${what}: deadline is ${expect.deadline_s} s after creation, observed ${span} s`);
  }

  const held = f.leases.filter((l) => l.released_at === null);
  assert.deepEqual(held.map((l) => l.resource_kind), ['run'], `${what}: one unreleased run lease`);
  assert.equal(held[0].closing, 0, `${what}: the lease is not closing`);
  if (expect.incarnation !== undefined) assert.equal(held[0].owner_incarnation, expect.incarnation, `${what}: lease owner`);
  assert.equal(f.grants.length, 1, `${what}: one grant`);
  assert.equal(f.grants[0].revoked_at, null, `${what}: the grant is live`);
  assert.equal(run.grant, f.grants[0].id, `${what}: runs.grant`);

  assert.equal(f.receipts.length, 1, `${what}: one invocation receipt`);
  assert.equal(f.receipts[0].turn, null, `${what}: a one-shot receipt has no turn`);
  assert.deepEqual(f.receipts[0].statuses, launched ? ['dispatch_started', 'launched'] : ['dispatch_started'], `${what}: status observations`);
  assert.equal(f.receipts[0].ledger.length, 0, `${what}: no ledger row before the run ends`);

  assert.equal(f.domains.length, 1, `${what}: one execution domain`);
  assert.equal(f.domains[0].status, launched ? 'launched' : 'allocated', `${what}: domain status`);
  assert.equal(f.domains[0].invocation, f.receipts[0].id, `${what}: the domain names the invocation`);
  assert.equal(f.ownership.length, 1, `${what}: one ownership row`);
  const own = f.ownership[0];
  assert.equal(own.invocation, f.receipts[0].id, `${what}: ownership names the invocation`);
  if (launched) {
    assert.ok(Number.isInteger(own.pid) && own.pid > 1, `${what}: ownership pid`);
    assert.equal(own.pgid, own.pid, `${what}: the child leads its own process group`);
    assert.match(String(own.pid_start_time), /^\d+$/, `${what}: ownership start time`);
  } else {
    assert.equal(own.pid, null, `${what}: ownership is written with pid null before the spawn`);
  }
  assert.equal(own.termination_confirmed_at, null, `${what}: termination not yet confirmed`);

  assert.equal(f.workspaces.length, 1, `${what}: one workspace`);
  const ws = f.workspaces[0];
  assert.equal(run.workspace, ws.id, `${what}: runs.workspace`);
  assert.equal(ws.disposition, 'active', `${what}: workspace disposition`);
  assert.equal(ws.base_revision, run.base_revision, `${what}: workspace base`);
  assert.equal(ws.current_base, run.base_revision, `${what}: workspace current base`);
  return f;
}

// D1 §16.2, as the store shows it once recovery is complete and before any
// new dispatch: no reusable execution authority, no live grant, every run
// ended or quarantined, every workspace retained, quarantined or discarded.
export function assertRecoveredStore(db) {
  const runs = all(db, 'SELECT * FROM "runs"');
  for (const run of runs) {
    assert.ok(run.state === 'ended' || (run.state === 'finalizing' && run.quarantined === 1), `run ${run.id} is ${run.state}: after recovery every run is ended or quarantined`);
  }
  // No reusable execution authority: what may still be held is a reservation.
  const held = all(db, 'SELECT * FROM "leases" WHERE "released_at" IS NULL');
  for (const lease of held) {
    assert.ok(!LIFECYCLE.lease.execution_authority.includes(lease.resource_kind), `lease ${lease.id} (${lease.resource_kind}) is unreleased: only quarantine reservations survive recovery`);
  }
  const live = all(db, 'SELECT * FROM "capability_grants" WHERE "revoked_at" IS NULL');
  assert.deepEqual(live.map((g) => g.id), [], 'no grant is live after recovery');
  for (const w of all(db, 'SELECT * FROM "workspaces"')) assert.notEqual(w.disposition, 'active', `workspace ${w.id} is still active after recovery`);
  for (const d of all(db, 'SELECT * FROM "execution_domains"')) {
    assert.ok([...LIFECYCLE.domain.terminal, 'quarantined'].includes(d.status), `domain ${d.id} is ${d.status} after recovery`);
  }
  return runs;
}

// Run intervals from the event log: for each run, the seq of its run.created
// and of its run.ended (null while it has not ended).
export function runIntervals(db) {
  const intervals = new Map();
  for (const e of all(db, `SELECT "seq", "type", "subject" FROM "events" WHERE "type" IN ('run.created', 'run.ended') ORDER BY "seq"`)) {
    const subject = json(e.subject);
    if (e.type === 'run.created') intervals.set(subject.run, { run: subject.run, project: subject.project, created: e.seq, ended: null });
    else if (intervals.has(subject.run)) intervals.get(subject.run).ended = e.seq;
  }
  return [...intervals.values()];
}

// The most runs that existed and had not ended at one time, engine-wide or
// for one project.
export function maxConcurrentRuns(db, { project } = {}) {
  const points = [];
  for (const i of runIntervals(db)) {
    if (project !== undefined && i.project !== project) continue;
    points.push([i.created, 1]);
    if (i.ended !== null) points.push([i.ended, -1]);
  }
  points.sort((a, b) => a[0] - b[0]);
  let now = 0;
  let max = 0;
  for (const [, delta] of points) {
    now += delta;
    max = Math.max(max, now);
  }
  return max;
}

// One active run per project (E18, D1 §19.3): no run of a project is created
// while another run of that project has not ended.
export function assertOneRunAtATime(db, project) {
  assert.ok(maxConcurrentRuns(db, { project }) <= 1, `project ${project} had more than one run that had not ended at the same time: ${JSON.stringify(runIntervals(db).filter((i) => i.project === project))}`);
}
