// The runtime clock of a rapid prototype's iteration (DECISIONS item 57; the
// owner's ruling D5 of 2026-11-26: "Accept for recorded engine-blocked and
// explicitly paused intervals. Show total wall time, excluded time and
// reason, and time charged to the limit. Time spent waiting for an ordinary
// owner approval still counts unless the project is explicitly paused";
// migration 0053, `prototype_clock_exclusions`).
//
// The runtime limit (R4) runs from the brief's approval. What it does not
// charge is recorded as intervals, opened and closed in the transactions
// that change the facts, never inferred from a time window afterwards:
//   - parked_on_blocker: the iteration `failed` because one of its work items
//     is parked behind its blocker (prototype/brief.ts syncIterationStatuses;
//     the driver's reading: a parked item's blocker exists because work
//     failed past its repairs, so it is engine-blocked, not an ordinary
//     owner approval; item 53);
//   - paused: the project explicitly paused (project.ts setPaused, the
//     iteration's Stop and resume);
//   - engine_stall: the open plan held by its phase gate with no owner act
//     that clears it (M642's completion_held_by phase_gate_not_satisfied,
//     owner_act null), no run under way, no work eligible and no check
//     execution to end: nothing anyone can do moves the iteration;
//   - provider_refusal: the existing provider-refusal hold (C2k), recorded
//     here too; `provider_hold_ms` is kept for history.
// Overlapping intervals are excluded once (their union). An ordinary owner
// question waiting unanswered on an unpaused project is never excluded.
//
// An iteration recorded before migration 0053 has no recorded intervals
// (`clock_basis` NULL): its clock is served with basis
// `not_recorded_before_0053` and `excluded_seconds` null, never 0; the
// limit check keeps charging it as before (the provider hold's recorded
// length only), plus whatever intervals were recorded for it since.

import { nowMs } from '../../clock.js';
import { phaseGateHold } from '../../plan/reads.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

export type ClockExclusionReason = 'parked_on_blocker' | 'paused' | 'engine_stall' | 'provider_refusal';
export type ClockBasis = 'recorded' | 'not_recorded_before_0053';

export interface ClockIteration {
  id: string;
  project: string;
  created_at?: string;
  approved_at: string | null;
  alpha_at?: string | null;
  ended_at?: string | null;
  clock_basis?: string | null;
  provider_hold_since?: string | null;
  provider_hold_ms?: number;
}

interface ExclusionRow {
  id: string;
  reason: ClockExclusionReason;
  cause_kind: string | null;
  cause_id: string | null;
  from_at: string;
  to_at: string | null;
}

// Whether the iteration's intervals are recorded: `clock_basis` as stored,
// or, for an iteration created once migration 0053 was applied (the column
// is not yet written at creation), recorded too. An iteration that existed
// before the migration is never `recorded`.
export function clockBasisOf(db: Db, it: Pick<ClockIteration, 'id'> & { created_at?: string; clock_basis?: string | null }): ClockBasis {
  const row = it.created_at === undefined || it.clock_basis === undefined
    ? (db.prepare('SELECT "created_at", "clock_basis" FROM "prototype_iterations" WHERE "id" = ?').get(it.id) as { created_at: string; clock_basis: string | null } | undefined)
    : { created_at: it.created_at, clock_basis: it.clock_basis };
  if (!row) return 'not_recorded_before_0053';
  if (row.clock_basis === 'recorded') return 'recorded';
  const applied = (db.prepare('SELECT "applied_at" FROM "schema_migrations" WHERE "seq" = 53').get() as { applied_at: string } | undefined)?.applied_at;
  if (applied === undefined) return 'not_recorded_before_0053';
  return Date.parse(row.created_at) >= Date.parse(applied) ? 'recorded' : 'not_recorded_before_0053';
}

// ---- recording -----------------------------------------------------------------------------

// Opens the iteration's interval for `reason`, once: an interval already open
// for it is kept (the partial unique index allows one). `from` defaults to
// the transaction's time and is never later than it.
export function openExclusion(tx: Tx, args: { project: string; iteration: string; reason: ClockExclusionReason; cause_kind: string | null; cause_id: string | null; from?: string | null }): boolean {
  const open = tx.db.prepare('SELECT 1 FROM "prototype_clock_exclusions" WHERE "iteration" = ? AND "reason" = ? AND "to_at" IS NULL').get(args.iteration, args.reason);
  if (open) return false;
  const at = Date.parse(tx.at);
  const from = args.from && Number.isFinite(Date.parse(args.from)) && Date.parse(args.from) <= at ? args.from : tx.at;
  tx.db
    .prepare(
      `INSERT INTO "prototype_clock_exclusions" ("id", "created_at", "project", "iteration", "reason", "cause_kind", "cause_id", "from_at", "from_seq", "to_at", "to_seq", "seconds")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    )
    .run(tx.newId('pcx_'), tx.at, args.project, args.iteration, args.reason, args.cause_kind, args.cause_id, from, tx.storeOrder());
  return true;
}

// Closes the iteration's open interval for `reason` at the transaction's
// time, recording its length. Returns whether one was open.
export function closeExclusion(tx: Tx, args: { iteration: string; reason: ClockExclusionReason }): boolean {
  const row = tx.db.prepare('SELECT "id", "from_at" FROM "prototype_clock_exclusions" WHERE "iteration" = ? AND "reason" = ? AND "to_at" IS NULL').get(args.iteration, args.reason) as
    | { id: string; from_at: string }
    | undefined;
  if (!row) return false;
  const seconds = Math.max(0, Math.round((Date.parse(tx.at) - Date.parse(row.from_at)) / 1000));
  tx.db.prepare('UPDATE "prototype_clock_exclusions" SET "to_at" = ?, "to_seq" = ?, "seconds" = ? WHERE "id" = ?').run(tx.at, tx.storeOrder(), Number.isFinite(seconds) ? seconds : 0, row.id);
  return true;
}

const isPrototype = (db: Db, project: string): boolean => (db.prepare('SELECT "mode" FROM "projects" WHERE "id" = ?').get(project) as { mode: string } | undefined)?.mode === 'rapid_prototype';
const currentIterationRow = (db: Db, project: string) =>
  db.prepare('SELECT "id", "project", "created_at", "status" FROM "prototype_iterations" WHERE "project" = ? ORDER BY "seq" DESC LIMIT 1').get(project) as
    | { id: string; project: string; created_at: string; status: string }
    | undefined;

// The project was paused or resumed (project.ts setPaused; the iteration's
// resume): the `paused` interval of its current iteration opened, or every
// open `paused` interval of the project closed. An iteration created while
// the project was paused (an Iterate on a stopped predecessor's project) is
// charged nothing for the pause before its creation, and its own part of
// the pause is recorded at the resume.
export function clockPauseChanged(tx: Tx, project: string, paused: boolean): void {
  if (!isPrototype(tx.db, project)) return;
  const it = currentIterationRow(tx.db, project);
  if (paused) {
    if (it) openExclusion(tx, { project, iteration: it.id, reason: 'paused', cause_kind: 'project', cause_id: project });
    return;
  }
  const open = tx.db.prepare(`SELECT "iteration", "from_at" FROM "prototype_clock_exclusions" WHERE "project" = ? AND "reason" = 'paused' AND "to_at" IS NULL ORDER BY rowid`).all(project) as { iteration: string; from_at: string }[];
  for (const o of open) closeExclusion(tx, { iteration: o.iteration, reason: 'paused' });
  if (it && !open.some((o) => o.iteration === it.id) && open.length > 0) {
    const since = open.map((o) => o.from_at).sort()[0]!;
    const from = Date.parse(it.created_at) > Date.parse(since) ? it.created_at : since;
    if (openExclusion(tx, { project, iteration: it.id, reason: 'paused', cause_kind: 'project', cause_id: project, from })) closeExclusion(tx, { iteration: it.id, reason: 'paused' });
  }
}

// At each tick, for the project's current approved iteration as its status
// is synced (prototype/brief.ts syncIterationStatuses): the parked interval
// opened while one of its work items is parked (from when the item's
// blocker was raised) and closed once none is; the stall interval opened
// while the engine is stalled (stallOf) and closed once it is not.
export function syncClockExclusions(tx: Tx, it: { id: string; project: string }, parked: { id: string; blocker: string | null } | null): void {
  if (parked !== null) {
    let raised: string | null = null;
    try {
      const b = JSON.parse(parked.blocker ?? '{}') as { raised_at?: unknown };
      raised = typeof b.raised_at === 'string' ? b.raised_at : null;
    } catch {
      raised = null;
    }
    openExclusion(tx, { project: it.project, iteration: it.id, reason: 'parked_on_blocker', cause_kind: 'work_item', cause_id: parked.id, from: raised });
  } else closeExclusion(tx, { iteration: it.id, reason: 'parked_on_blocker' });
  const stall = parked === null ? stallOf(tx.db, it.project) : null;
  if (stall !== null) openExclusion(tx, { project: it.project, iteration: it.id, reason: 'engine_stall', cause_kind: 'gate_evaluation', cause_id: stall.evaluation, from: stall.since });
  else closeExclusion(tx, { iteration: it.id, reason: 'engine_stall' });
}

// The engine stalled (D5): the project's open plan is held by its phase
// gate, fresh and not satisfied, with no owner act that clears it
// (plan/reads.ts phaseGateHold, M642), and nothing is under way or can be
// dispatched: no run unended, no work eligible, no check execution still
// to end, no decision of the owner open. `since`: when the engine was left
// so, the later of the evaluation and the last run's end. null otherwise.
export function stallOf(db: Db, project: string): { evaluation: string; since: string } | null {
  const plan = db
    .prepare(`SELECT "id", "phase_number", "generation", "check_authoring" FROM "phase_plans" WHERE "project" = ? AND "active" = 1 AND "status" = 'published' AND "completed_at" IS NULL ORDER BY rowid DESC LIMIT 1`)
    .get(project) as { id: string; phase_number: number; generation: number; check_authoring: string | null } | undefined;
  if (!plan) return null;
  let hold: ReturnType<typeof phaseGateHold>;
  try {
    hold = phaseGateHold(db, project, plan);
  } catch {
    return null;
  }
  if (hold === null || hold.owner_act !== null) return null;
  const any = (sql: string): boolean => db.prepare(sql).get(project) !== undefined;
  if (any(`SELECT 1 FROM "runs" WHERE "project" = ? AND "state" <> 'ended' LIMIT 1`)) return null;
  if (any(`SELECT 1 FROM "work_items" WHERE "project" = ? AND "status" IN ('eligible', 'claimed', 'executing', 'integrating', 'integrated', 'verifying') LIMIT 1`)) return null;
  if (any(`SELECT 1 FROM "check_executions" WHERE "project" = ? AND "status" IN ('queued', 'materializing', 'running', 'collecting') LIMIT 1`)) return null;
  if (any(`SELECT 1 FROM "decisions" WHERE "project" = ? AND "status" = 'open' LIMIT 1`)) return null;
  const lastRun = (db.prepare(`SELECT MAX("finished_at") AS "at" FROM "runs" WHERE "project" = ?`).get(project) as { at: string | null }).at;
  const since = lastRun !== null && Date.parse(lastRun) > Date.parse(hold.evaluated_at) ? lastRun : hold.evaluated_at;
  return { evaluation: hold.evaluation, since };
}

// ---- reading ----------------------------------------------------------------------------------

function rowsOf(db: Db, iteration: string): ExclusionRow[] {
  return db.prepare('SELECT "id", "reason", "cause_kind", "cause_id", "from_at", "to_at" FROM "prototype_clock_exclusions" WHERE "iteration" = ? ORDER BY "from_at", rowid').all(iteration) as ExclusionRow[];
}

// The intervals clamped to [fromMs, toMs] (an open one runs to toMs), with
// the length of their union in milliseconds: overlapping intervals are
// excluded once.
function clamped(rows: ExclusionRow[], fromMs: number, toMs: number): { row: ExclusionRow; from: number; to: number }[] {
  const out: { row: ExclusionRow; from: number; to: number }[] = [];
  for (const r of rows) {
    const a = Math.max(Date.parse(r.from_at), fromMs);
    const b = Math.min(r.to_at === null ? toMs : Date.parse(r.to_at), toMs);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) out.push({ row: r, from: a, to: b });
  }
  return out;
}

function unionMs(parts: { from: number; to: number }[]): number {
  const sorted = [...parts].sort((x, y) => x.from - y.from);
  let total = 0;
  let start = -Infinity;
  let end = -Infinity;
  for (const p of sorted) {
    if (p.from > end) {
      if (end > start) total += end - start;
      start = p.from;
      end = p.to;
    } else if (p.to > end) end = p.to;
  }
  if (end > start) total += end - start;
  return total;
}

// The legacy provider hold (C2k), as heldSeconds counted it: each ended
// hold's recorded length and the current hold's to `atMs`, after the
// approval. Only an iteration recorded before 0053 is charged by it.
function legacyHoldMs(it: ClockIteration, atMs: number): number {
  let ms = Math.max(0, it.provider_hold_ms ?? 0);
  if (it.provider_hold_since && it.approved_at !== null) {
    const from = Math.max(Date.parse(it.provider_hold_since), Date.parse(it.approved_at));
    if (Number.isFinite(from) && atMs > from) ms += atMs - from;
  }
  return ms;
}

export interface ChargedTime {
  basis: ClockBasis;
  // Approval to `atMs`, in seconds; null before the approval.
  wall_seconds: number | null;
  // The union of the recorded intervals in that span (recorded basis), or
  // what the limit check does not charge an iteration recorded before 0053.
  excluded_seconds: number;
  charged_seconds: number | null;
  // Of the excluded time, what each reason's intervals cover (before the
  // union; overlapping reasons each count their own).
  by_reason: Partial<Record<ClockExclusionReason, number>>;
}

// What the runtime limit charges the iteration at `atMs` (iterationVerdict).
export function chargedAt(db: Db, it: ClockIteration, atMs: number): ChargedTime {
  const basis = clockBasisOf(db, it);
  if (it.approved_at === null) return { basis, wall_seconds: null, excluded_seconds: 0, charged_seconds: null, by_reason: {} };
  const from = Date.parse(it.approved_at);
  const rows = rowsOf(db, it.id).filter((r) => basis === 'recorded' || r.reason !== 'provider_refusal');
  const parts: { row: ExclusionRow; from: number; to: number }[] = clamped(rows, from, atMs);
  const by: Partial<Record<ClockExclusionReason, number>> = {};
  let extraMs = 0;
  if (basis === 'recorded') {
    // The provider hold as its own columns record it (C2k) is never charged
    // either: the current hold's span joins the union, and an ended hold's
    // length its rows do not account for is added (a hold recorded on the
    // columns alone).
    if (it.provider_hold_since) {
      const span = clamped([{ id: 'provider_hold', reason: 'provider_refusal', cause_kind: null, cause_id: null, from_at: it.provider_hold_since, to_at: null }], from, atMs);
      parts.push(...span);
    }
    const closedRows = parts.filter((p) => p.row.reason === 'provider_refusal' && p.row.to_at !== null).reduce((n, p) => n + (p.to - p.from), 0);
    extraMs = Math.max(0, (it.provider_hold_ms ?? 0) - closedRows);
  }
  for (const p of parts) if (p.row.id !== 'provider_hold' || !parts.some((q) => q !== p && q.row.reason === 'provider_refusal' && q.row.to_at === null)) by[p.row.reason] = (by[p.row.reason] ?? 0) + (p.to - p.from) / 1000;
  if (extraMs > 0) by.provider_refusal = (by.provider_refusal ?? 0) + extraMs / 1000;
  let excludedMs = unionMs(parts) + extraMs;
  if (basis !== 'recorded') {
    const legacy = legacyHoldMs(it, atMs);
    if (legacy > 0) by.provider_refusal = (by.provider_refusal ?? 0) + legacy / 1000;
    excludedMs += legacy;
  }
  const wall = (atMs - from) / 1000;
  return { basis, wall_seconds: wall, excluded_seconds: excludedMs / 1000, charged_seconds: wall - excludedMs / 1000, by_reason: by };
}

// The iteration read's `time.clock` (M639): total wall time from the
// brief's approval to Alpha (or the iteration's end, or now), each excluded
// interval with its reason, span, length and cause, the excluded time (the
// union, once), the time charged to the limit, the limit, and the basis.
// Before the approval: wall, excluded and charged null. An iteration
// recorded before 0053: `excluded_seconds` null (its intervals were not
// recorded, never 0); the intervals recorded since are listed, and
// `charged_seconds` is what the limit check charges.
export function clockOf(db: Db, it: ClockIteration, limitSeconds: number | null, atMs: number = nowMs()) {
  const basis = clockBasisOf(db, it);
  const end = it.alpha_at ?? it.ended_at ?? null;
  const endMs = end !== null && Number.isFinite(Date.parse(end)) ? Math.min(Date.parse(end), atMs) : atMs;
  if (it.approved_at === null) {
    return { wall_seconds: null, excluded: [], excluded_seconds: null, charged_seconds: null, limit_seconds: limitSeconds, basis, from: null, to: null };
  }
  const from = Date.parse(it.approved_at);
  const parts = clamped(rowsOf(db, it.id), from, endMs);
  const charged = chargedAt(db, it, endMs);
  const s = (ms: number) => Math.round(ms / 10) / 100;
  return {
    wall_seconds: s(endMs - from),
    excluded: parts.map((p) => ({
      reason: p.row.reason,
      from: new Date(p.from).toISOString(),
      to: p.row.to_at === null && p.to === endMs ? null : new Date(p.to).toISOString(),
      open: p.row.to_at === null,
      seconds: s(p.to - p.from),
      cause: { kind: p.row.cause_kind, id: p.row.cause_id },
    })),
    excluded_seconds: basis === 'recorded' ? s(charged.excluded_seconds * 1000) : null,
    charged_seconds: charged.charged_seconds === null ? null : s(charged.charged_seconds * 1000),
    limit_seconds: limitSeconds,
    basis,
    from: it.approved_at,
    to: end ?? null,
  };
}
