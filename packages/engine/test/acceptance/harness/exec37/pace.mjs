// Helpers for rows M440 (the event-driven tick) and M441 (the pace read) of
// M5 slice 37 (SEAM.md §431). Kernel lane. Durations the tests measure
// are read from the monotonic clock (SEAM.md §333), never from the engine's
// timestamps, and no expectation relies on the order of wall-clock
// timestamps: the workstation's clock steps back about a second every 31 s.
// Store rows are ordered by insertion (`seq`, `rowid`).

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { waitFor } from '../engine.mjs';
import { changePolicy, eventsOfType } from '../journal.mjs';
import { withStore } from '../store.mjs';
import { refOid } from '../repos.mjs';
import { GOVERNED_FILE, KERNEL_COMMANDS, acceptance, checkProject, defPath, governedText, installIndexedPlan, smoke } from '../checks/fixtures.mjs';

export const nowMs = () => performance.now();
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const maxSeq = (home) => withStore(home, (db) => db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get().n);
export const ticksAfter = (home, seq) => eventsOfType(home, 'engine.tick', seq);
export const requestsAfter = (home, seq) => eventsOfType(home, 'scheduler.tick_requested', seq);

// The tick a request asks for follows within `tick_budget` (D6-X07). The
// contract's default is 20 s; the tests use it unless they configure another.
export const TICK_BUDGET_S = 20;

// The first `scheduler.tick_requested` † after `seq` whose `payload.cause`
// is `cause` (and whose subject matches `subject`, when given). Fails naming
// the causes that were seen, if any.
export async function requestedAfter(home, seq, cause, { subject = {}, timeoutMs = 25_000 } = {}) {
  const match = (e) => e.payload?.cause === cause && Object.entries(subject).every(([k, v]) => e.subject?.[k] === v);
  try {
    return await waitFor(() => requestsAfter(home, seq).find(match), { timeoutMs, what: `a scheduler.tick_requested with cause ${cause}` });
  } catch {
    const seen = requestsAfter(home, seq).map((e) => ({ cause: e.payload?.cause, subject: e.subject }));
    assert.fail(`no scheduler.tick_requested † with cause ${cause}${Object.keys(subject).length ? ` about ${JSON.stringify(subject)}` : ''} after event ${seq} (D6 K1, D6-X07: the transition requests a tick); requests seen: ${JSON.stringify(seen)}`);
  }
}

// The first `engine.tick` after `seq`, and how long (monotonic ms since
// `startedMs`) it took to be seen. Fails if none within `timeoutMs`.
export async function tickAfter(home, seq, { startedMs = nowMs(), timeoutMs = TICK_BUDGET_S * 1000 + 5000, what = 'a tick' } = {}) {
  const event = await waitFor(() => ticksAfter(home, seq)[0], { timeoutMs, what: `${what} (an engine.tick after event ${seq})` }).catch(() => undefined);
  assert.ok(event, `${what}: no engine.tick after event ${seq} within ${timeoutMs} ms`);
  return { event, elapsedMs: nowMs() - startedMs };
}

// ---- figures ------------------------------------------------------------------------------------

export const isUnknown = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.unknown === 'string';
export const isFigure = (v) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || isUnknown(v);
export const near = (actual, expected, tolerance) => typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
export const show = (v) => JSON.stringify(v);

// Seconds from `a` to `b` (ISO timestamps the engine wrote), or null when
// either is missing or the interval runs backwards.
export function seconds(a, b) {
  const x = typeof a === 'string' ? Date.parse(a) : NaN;
  const y = typeof b === 'string' ? Date.parse(b) : NaN;
  if (Number.isNaN(x) || Number.isNaN(y) || y < x) return null;
  return (y - x) / 1000;
}

// The figure a pace read must show for an interval the store holds: the
// value, within 1 ms, or `unknown` when the store has no such interval.
export function assertDerived(figure, expected, what) {
  if (expected === null) assert.ok(isUnknown(figure), `${what}: the observation is missing, so the figure is {unknown}, never a value (${show(figure)})`);
  else assert.ok(near(figure, expected, 0.002), `${what}: ${expected} s from the recorded observations, read ${show(figure)}`);
}

// ---- store reads --------------------------------------------------------------------------------

export const rowsOf = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
export const oneOf = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).get(...params));
export const json = (t) => (t === null || t === undefined ? t : JSON.parse(t));

// The status observations of a one-shot run's receipt, in insertion order.
export const statusObservations = (home, run) =>
  rowsOf(home, 'SELECT o.* FROM "invocation_status_observations" o JOIN "invocation_receipts" r ON r."id" = o."invocation" WHERE r."run" = ? ORDER BY o."seq"', run);

// D6 §7.6: launched (the `launched` observation) and the terminal observation
// after it (`ended` or `unknown`), as recorded.
export function launchAndTerminal(home, run) {
  const obs = statusObservations(home, run);
  const launched = obs.find((o) => o.status === 'launched') ?? null;
  const after = launched ? obs.filter((o) => o.seq > launched.seq) : [];
  const terminal = after.find((o) => o.status === 'ended' || o.status === 'unknown') ?? null;
  return { launched, terminal };
}

// Every column named `observed_at` and its value, in every table that has
// one, keyed by table and rowid: what the read must not change.
export function observedAtSnapshot(home) {
  return withStore(home, (db) => {
    const out = {};
    const tables = db.prepare(`SELECT "name" FROM "sqlite_master" WHERE "type" = 'table'`).all().map((r) => r.name);
    for (const table of tables) {
      const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
      if (!cols.includes('observed_at')) continue;
      out[table] = db.prepare(`SELECT rowid AS "r", "observed_at" FROM "${table}" ORDER BY rowid`).all();
    }
    return out;
  });
}

// The hold intervals of a work item † (Q3): `work_items.held_intervals`
// [{from, to?, reason}], and the events `work.hold_began` / `work.hold_ended`.
export const holdIntervals = (home, item) => json(oneOf(home, 'SELECT * FROM "work_items" WHERE "id" = ?', item)?.held_intervals ?? null);
export const holdEvents = (home, item) => ({
  began: eventsOfType(home, 'work.hold_began').filter((e) => e.subject?.work_item === item),
  ended: eventsOfType(home, 'work.hold_ended').filter((e) => e.subject?.work_item === item),
});

// ---- a T1 stage that can be verified (M441 (d)) --------------------------------------------------


// A T1 project whose governed file names KERNEL_COMMANDS, with an acceptance
// check `acc` covering R1.1 and a smoke check `sm`, and a plan whose one
// stage implements R1: a stage the engine can verify once both pass.
export async function verifiableProject(fx, { policy } = {}) {
  const files = { [GOVERNED_FILE]: governedText({ check_commands: KERNEL_COMMANDS }), [defPath('acc')]: acceptance('acc', ['R1.1']), [defPath('sm')]: smoke('sm') };
  const p = await checkProject(fx, { files, tier: 'T1' });
  if (policy !== undefined) {
    await changePolicy(fx.engine, p.id, policy);
    p.base = refOid(p.repo.path, p.repo.ref);
  }
  const plan = await installIndexedPlan(fx.engine, p.id, { index: [{ key: 'R1', criteria: ['R1.1'] }], stages: [{ number: 1, goal: 'the first stage', implements: ['R1'] }] });
  return { ...p, plan, stage: plan.stages[0] };
}
export const VERIFIABLE_KEYS = Object.freeze(['acc', 'sm']);
