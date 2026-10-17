// The pace read (D6 §7.6; N01; SEAM.md §355; M441 pins each figure's
// derivation in slice 37). `GET /v1/projects/:p/pace`: a projection of rows
// that exist, never a second state. Every leaf is a value or
// `{"unknown": "<reason>"}`: a figure whose observation was not recorded
// when it occurred is unknown, never recomputed from the present and never
// a measured zero. Nothing here writes, evaluates or probes.

import { activeStages } from './active.js';
import type { Database } from 'better-sqlite3';

import { notFound } from '../store/transitions/common.js';
import { effectiveProfileMax, engineSettings, projectOptions } from '../store/transitions/settings.js';
import { currentHostQualification, resolveBackend } from '../store/transitions/trust.js';
import { memAvailable } from '../store/transitions/envelope.js';
import type { Tx } from '../store/transitions/tx.js';
import type { EngineRevision } from '../revision.js';

type Unknown = { unknown: string; detail?: string };
type Figure<T> = T | Unknown;

const unknown = (reason: string): Unknown => ({ unknown: reason });
const ms = (t: string | null | undefined): number | null => {
  if (typeof t !== 'string') return null;
  const v = Date.parse(t);
  return Number.isNaN(v) ? null : v;
};
// Seconds from `a` to `b`, or unknown naming the endpoint not recorded.
function between(a: string | null | undefined, b: string | null | undefined, what: [string, string]): Figure<number> {
  const x = ms(a);
  const y = ms(b);
  if (x === null) return unknown(`${what[0]} was not recorded`);
  if (y === null) return unknown(`${what[1]} was not recorded`);
  // An interval that runs backwards is not a measured zero (the 31b review's
  // M6): the host's clock stepped back between the two (E148). Named so,
  // with what the two wall times were (the driver's ruling, slice 37).
  if (y < x) return { unknown: 'clock_stepped_back', detail: `${what[1]} (${b}) has a wall time before ${what[0]} (${a})` };
  return (y - x) / 1000;
}
const json = <T>(text: unknown, fallback: T): T => {
  try {
    return typeof text === 'string' ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

function firstEvent(db: Database, type: string, project: string, where?: (payload: Record<string, unknown>, subject: Record<string, unknown>) => boolean): string | null {
  const rows = db.prepare(`SELECT "created_at", "subject", "payload" FROM "events" WHERE "type" = ? AND json_extract("subject", '$.project') = ? ORDER BY "seq"`).all(type, project) as {
    created_at: string;
    subject: string;
    payload: string | null;
  }[];
  for (const r of rows) if (!where || where(json(r.payload, {}), json(r.subject, {}))) return r.created_at;
  return null;
}

// The union of intervals, in seconds (overlaps counted once).
function union(intervals: [number, number][]): number {
  const sorted = intervals.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of sorted) {
    if (cur === null || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total / 1000;
}

interface DecisionRow {
  id: string;
  kind: string;
  raised_at: string;
  consumed_at: string | null;
  status: string;
  answer: string | null;
  blocked_while_open: string;
}

const HOLD_REASONS = ['resource_envelope', 'chain_boundary', 'depends_on', 'authoring_readiness', 'open_decision', 'session_busy'] as const;

// The work items a decision's `blocked_while_open` names; null when it
// cannot be read (never "blocks nothing").
function blockedItems(d: DecisionRow): string[] | null {
  const v = json<unknown>(d.blocked_while_open, undefined);
  if (v === undefined) return null;
  const items = v !== null && typeof v === 'object' && !Array.isArray(v) ? ((v as { work_items?: unknown }).work_items ?? []) : v;
  return Array.isArray(items) ? (items as string[]) : null;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

// A session's model per turn (M542 (b)), given only where its turns
// observed different models (or one observed none): every turn of the run,
// in order, with the model its ledger rows recorded or unknown.
function turnModels(db: Database, run: string): { models_by_turn?: { turn: string; model: Figure<string> }[] } {
  const turns = db.prepare('SELECT "id" FROM "turns" WHERE "run" = ? ORDER BY "number", rowid').all(run) as { id: string }[];
  if (turns.length < 2) return {};
  const per = turns.map((t) => {
    const rows = db.prepare('SELECT "model_observed" FROM "ledger_rows" WHERE "turn" = ? AND "model_observed" IS NOT NULL ORDER BY rowid').all(t.id) as { model_observed: string }[];
    const models = [...new Set(rows.flatMap((r) => r.model_observed.split(',').map((m) => m.trim()).filter((m) => m.length > 0)))];
    return { turn: t.id, model: models.length === 0 ? unknown('no invocation of the turn recorded an observed model') : models.join(',') };
  });
  const distinct = new Set(per.map((p) => (typeof p.model === 'string' ? p.model : '\u0000unknown')));
  return distinct.size > 1 ? { models_by_turn: per } : {};
}

export function paceView(db: Database, args: { project: string }) {
  const project = db.prepare('SELECT "id", "created_at" FROM "projects" WHERE "id" = ?').get(args.project) as { id: string; created_at: string } | undefined;
  if (!project) throw notFound('project', args.project);
  const p = project.id;
  const decisions = db.prepare('SELECT "id", "kind", "raised_at", "consumed_at", "status", "answer", "blocked_while_open" FROM "decisions" WHERE "project" = ? ORDER BY "seq"').all(p) as DecisionRow[];
  const answeredAt = (d: DecisionRow): string | null => json<{ at?: string } | null>(d.answer, null)?.at ?? d.consumed_at;
  // When a decision stopped holding anything: its answer, or, invalidated,
  // the event that recorded it (the slice-37 review's N5: an invalidated
  // blocker's wait ends there, it is not unknown for good).
  const closedAt = (d: DecisionRow): string | null => {
    if (d.status !== 'invalidated') return answeredAt(d);
    const e = db.prepare(`SELECT "created_at" FROM "events" WHERE "type" = 'decision.invalidated' AND json_extract("subject", '$.decision') = ? ORDER BY "seq" LIMIT 1`).get(d.id) as { created_at: string } | undefined;
    return e?.created_at ?? null;
  };
  // The decisions a person answered (the routed ones), with their open time.
  const routed = decisions
    .filter((d) => json<{ actor?: string } | null>(d.answer, null)?.actor === 'human')
    .map((d) => ({ id: d.id, kind: d.kind, open_seconds: between(d.raised_at, answeredAt(d), ['the decision raised', 'its answer']) }));
  const alpha = firstEvent(db, 'candidate.advanced', p, (pl) => pl.to === 'alpha_deployed');
  const phaseRows = db.prepare(`SELECT * FROM "phase_plans" WHERE "project" = ? ORDER BY "phase_number", "generation"`).all(p) as Record<string, unknown>[];

  // Every event of the project the read needs, in insertion order (never by
  // a wall-clock timestamp: the host's clock steps back).
  const events = db
    .prepare(
      `SELECT "seq", "type", "at", "subject", "payload" FROM "events"
       WHERE "type" IN ('work.dependency_met', 'work.integrated', 'work.created', 'work.complete') AND json_extract("subject", '$.project') = ? ORDER BY "seq"`,
    )
    .all(p) as { seq: number; type: string; at: string; subject: string; payload: string | null }[];
  const ev = events.map((e) => ({ ...e, subject: json<Record<string, unknown>>(e.subject, {}), payload: json<Record<string, unknown>>(e.payload, {}) }));
  const firstOf = (type: string, item: string | null) => (item === null ? undefined : ev.find((e) => e.type === type && e.subject.work_item === item));

  // ---- the host observations (D6 §7.6, A.3) ----------------------------------------------
  const hostRows = db.prepare('SELECT * FROM "host_observations" WHERE "project" = ? ORDER BY rowid').all(p) as {
    id: string;
    created_at: string;
    incarnation: string;
    engine_version: string;
    engine_revision?: string | null;
    engine_revision_unknown?: string | null;
    autonomy: string | null;
    settings: string;
    mem_available: number | null;
    trigger: string | null;
    host_qualification: string | null;
    backend_entry: string | null;
    peak_domains: number | null;
  }[];
  const hostOf = (h: (typeof hostRows)[number]) => {
    const settings = json<Record<string, number>>(h.settings, {});
    const setting = (k: string) => (typeof settings[k] === 'number' ? settings[k]! : unknown(`${k} was not recorded then`));
    return {
      id: h.id,
      trigger: h.trigger ?? unknown('the observation predates its trigger'),
      observed_at: h.created_at,
      incarnation: h.incarnation,
      engine_version: h.engine_version,
      // The source revision the engine was started from (M544), beside the
      // package version, which is not a revision.
      engine_revision: h.engine_revision ?? unknown(h.engine_revision_unknown ?? 'the revision was not recorded then (an observation from before the engine recorded it)'),
      host_qualification: h.host_qualification ?? unknown('no host qualification was in force then'),
      backend_entry: json<Record<string, unknown> | null>(h.backend_entry, null) ?? unknown('no active trust entry served the project then (the scripted backend, or none)'),
      autonomy: h.autonomy ?? unknown('the policy recorded no autonomy then'),
      tick_interval: setting('tick_interval'),
      domain_memory_max: setting('domain_memory_max'),
      role_memory_max: setting('role_memory_max'),
      check_memory_max: setting('check_memory_max'),
      max_concurrent_domains: setting('max_concurrent_domains'),
      mem_available: h.mem_available ?? unknown('MemAvailable could not be read then'),
      peak_domains: h.peak_domains ?? unknown('the peak number of domains was not recorded then'),
    };
  };
  const hosts = hostRows.map(hostOf);
  const hostByIncarnation = new Map(hostRows.map((h) => [h.incarnation, h.id]));
  const none = unknown('no host observation was recorded for the project');
  const latest = hosts.at(-1);
  const hostSection = latest ?? {
    id: none,
    trigger: none,
    observed_at: none,
    incarnation: none,
    engine_version: none,
    engine_revision: none,
    host_qualification: none,
    backend_entry: none,
    autonomy: none,
    tick_interval: none,
    domain_memory_max: none,
    role_memory_max: none,
    check_memory_max: none,
    max_concurrent_domains: none,
    mem_available: none,
    peak_domains: none,
  };

  // ---- runs (D6 §7.6 per run; N01) ---------------------------------------------------------
  const runRows = db
    .prepare(
      `SELECT r."id", r."role", r."kind", r."work_item", r."created_at", r."started_at", r."finished_at", r."outcome", r."reason_class", r."model_observed", w."kind" AS "work_kind"
       FROM "runs" r LEFT JOIN "work_items" w ON w."id" = r."work_item" WHERE r."project" = ? ORDER BY r."seq"`,
    )
    .all(p) as Record<string, string | null>[];
  const ordinal = new Map<string, number>();
  const runs = runRows.map((r) => {
    const id = r.id as string;
    const lease = db.prepare(`SELECT "owner_incarnation", "acquired_at" FROM "leases" WHERE "resource_kind" = 'run' AND "resource_id" = ? ORDER BY rowid LIMIT 1`).get(id) as
      | { owner_incarnation: string; acquired_at: string }
      | undefined;
    const receipts = (db.prepare('SELECT "id" FROM "invocation_receipts" WHERE "run" = ? ORDER BY rowid').all(id) as { id: string }[]).map((x) => x.id);
    const obs = receipts.length === 0 ? [] : (db.prepare(`SELECT "status", "at", "invocation", "seq", "incarnation" FROM "invocation_status_observations" WHERE "invocation" IN (${receipts.map(() => '?').join(', ')}) ORDER BY rowid`).all(...receipts) as { status: string; at: string; invocation: string; seq: number; incarnation: string | null }[]);
    const launched = obs.find((o) => o.status === 'launched') ?? null;
    const terminal = launched ? (obs.find((o) => o.invocation === launched.invocation && o.seq > launched.seq && (o.status === 'ended' || o.status === 'unknown')) ?? null) : null;
    // A terminal observation another incarnation recorded than the launch's
    // (a restart between them): unknown, bounded by the observations that
    // exist, never a measured value (the driver's ruling 5, slice 37).
    const interrupted = launched !== null && terminal !== null && launched.incarnation !== null && terminal.incarnation !== null && launched.incarnation !== terminal.incarnation;
    let invocationElapsed: Figure<number> | { unknown: string; bounded_by: unknown };
    if (launched === null) invocationElapsed = unknown('the run has no launched observation');
    else if (terminal === null) invocationElapsed = unknown('the run has no terminal observation after its launch');
    else if (interrupted) {
      const bound = between(launched.at, terminal.at, ['its launch', 'the observation that ended it']);
      invocationElapsed = { unknown: 'the engine restarted between the launch and the terminal observation', bounded_by: typeof bound === 'number' ? { at_most_seconds: bound } : bound };
    } else invocationElapsed = between(launched.at, terminal.at, ['its launch', 'its terminal observation']);
    const ledger = db.prepare('SELECT "billable_in", "cached_in", "out", "cost_status", "cost_usd" FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL ORDER BY rowid').all(id) as {
      billable_in: number | null;
      cached_in: number | null;
      out: number | null;
      cost_status: string;
      cost_usd: number | null;
    }[];
    const tokens = (col: 'billable_in' | 'cached_in' | 'out') =>
      ledger.length === 0 ? unknown('the run has no ledger row') : ledger.some((l) => l[col] === null) ? unknown(`a ledger row of the run has no ${col}`) : sum(ledger.map((l) => l[col] as number));
    const statuses = [...new Set(ledger.map((l) => l.cost_status))];
    const workItem = r.work_item ?? null;
    const n = !workItem ? 0 : (ordinal.get(workItem) ?? 0);
    if (workItem) ordinal.set(workItem, n + 1);
    const dom = db.prepare('SELECT "id", "memory_peak", "memory_max", "peak_recorded_at" FROM "execution_domains" WHERE "run" = ? ORDER BY rowid LIMIT 1').get(id) as
      | { id: string; memory_peak: number | null; memory_max: number | null; peak_recorded_at: string | null }
      | undefined;
    return {
      id,
      role: r.role as string,
      work_kind: r.work_kind ?? (r.kind as string),
      created_at: r.created_at as string,
      claimed_at: lease?.acquired_at ?? unknown('the run has no run lease recorded'),
      launched_at: launched?.at ?? unknown('the run has no launched observation'),
      finished_at: r.finished_at ?? unknown('the run has not ended'),
      wait: between(r.created_at, launched?.at, ['the run created', 'its launch']),
      invocation_elapsed: invocationElapsed,
      end_protocol: terminal === null ? unknown('the run has no terminal observation') : between(terminal.at, r.finished_at, ['its terminal observation', 'its end']),
      // Kept from slice 31's read: launch to end as recorded.
      elapsed: between(r.started_at, r.finished_at, ['its launch', 'its terminal observation']),
      tokens: { billable: tokens('billable_in'), cached: tokens('cached_in'), output: tokens('out') },
      cost: {
        usd: ledger.length === 0 ? unknown('the run has no ledger row') : ledger.some((l) => l.cost_usd === null) ? unknown('a ledger row of the run has no cost') : sum(ledger.map((l) => l.cost_usd as number)),
        status: statuses.length === 1 ? statuses[0]! : statuses.length === 0 ? unknown('the run has no ledger row') : statuses.join(','),
      },
      // The model the run observed, as its ledger rows recorded it (M542):
      // unknown with its reason, never the requested model in its place.
      model: r.model_observed ?? unknown(ledger.length === 0 ? 'the run has no ledger row' : 'no invocation of the run recorded an observed model'),
      // A session's turns, where what they observed differs (M542 (b)):
      // each turn's model, or unknown for a turn that observed none.
      ...turnModels(db, id),
      outcome: r.outcome ?? unknown('the run has not ended'),
      reason_class: r.reason_class ?? unknown('the run has not ended'),
      repair_ordinal: n,
      host_observation: (lease ? hostByIncarnation.get(lease.owner_incarnation) : undefined) ?? unknown("no host observation was recorded for the run's incarnation"),
      // The backend entry the run ran on, as its first receipt recorded it
      // (the slice-37 review's M10), never the host observation's latest.
      backend_entry: (() => {
        const e = receipts.length === 0 ? undefined : (db.prepare('SELECT t."id", t."binary_sha256", t."model" FROM "invocation_receipts" i JOIN "trust_entries" t ON t."id" = i."trust_entry" WHERE i."id" = ?').get(receipts[0]) as { id: string; binary_sha256: string; model: string } | undefined);
        return e ?? unknown('no trust entry served the run (the scripted backend, or none)');
      })(),
      domain: dom
        ? {
            id: dom.id,
            memory_peak: dom.memory_peak ?? unknown(dom.peak_recorded_at === null ? 'the peak has not been read' : 'memory.peak could not be read before the domain was removed'),
            memory_max: dom.memory_max ?? unknown('the maximum was not recorded at admission'),
          }
        : unknown('the run had no domain'),
      // Every domain of the run, a session's one per turn (the slice-37
      // review's N8), in the order they were made.
      domains: (db.prepare('SELECT "id", "memory_peak", "memory_max", "peak_recorded_at" FROM "execution_domains" WHERE "run" = ? ORDER BY rowid').all(id) as { id: string; memory_peak: number | null; memory_max: number | null; peak_recorded_at: string | null }[]).map((d) => ({
        id: d.id,
        memory_peak: d.memory_peak ?? unknown(d.peak_recorded_at === null ? 'the peak has not been read' : 'memory.peak could not be read before the domain was removed'),
        memory_max: d.memory_max ?? unknown('the maximum was not recorded at admission'),
      })),
    };
  });

  const projectSection = {
    id: p,
    created_at: project.created_at,
    created_to_spec_approved: between(project.created_at, firstEvent(db, 'baseline.spec_approved', p), ['the project created', 'the specification approved']),
    created_to_architecture_approved: between(project.created_at, firstEvent(db, 'baseline.architecture_approved', p), ['the project created', 'the architecture approved']),
    created_to_phase_complete: phaseRows
      .filter((r) => r.completed_at !== null)
      .map((r) => ({ phase: r.phase_number as number, seconds: between(project.created_at, r.completed_at as string, ['the project created', 'the phase completed']) })),
    created_to_alpha_deployed: between(project.created_at, alpha, ['the project created', 'a candidate alpha_deployed']),
    decisions: routed,
    sessions: (() => {
      const rows = db.prepare(`SELECT "id", "created_at", "started_at", "finished_at" FROM "runs" WHERE "project" = ? AND "kind" = 'session' ORDER BY "seq"`).all(p) as Record<string, string | null>[];
      const turns = (db.prepare(`SELECT COUNT(*) AS n FROM "turns" t JOIN "runs" r ON r."id" = t."run" WHERE r."project" = ?`).get(p) as { n: number }).n;
      const secs = rows.map((r) => between(r.started_at ?? r.created_at, r.finished_at, ['the session started', 'the session ended']));
      const ids = new Set(rows.map((r) => r.id as string));
      const of = runs.filter((r) => ids.has(r.id));
      const tok = (k: 'billable' | 'cached' | 'output') => (of.some((r) => typeof r.tokens[k] !== 'number') ? unknown(`a session's ${k} tokens are unknown`) : sum(of.map((r) => r.tokens[k] as number)));
      return {
        count: rows.length,
        turns,
        // The sessions' time as measured: a session whose interval is not
        // (still open, an endpoint unrecorded, or recorded backwards by a
        // clock that stepped back) is left out of the sum and counted apart,
        // never taken as zero.
        seconds: sum(secs.filter((x): x is number => typeof x === 'number')),
        seconds_unmeasured: secs.filter((x) => typeof x !== 'number').length,
        tokens: { billable: tok('billable'), cached: tok('cached'), output: tok('output') },
      };
    })(),
    // Idle time by hold reason (N01): the elapsed time of the closed hold
    // intervals, never a count of ticks; an interval still open is not
    // counted (its end was not observed) and is shown apart.
    // A reason with no closed interval recorded is unknown, never 0, and
    // so is one with an interval whose time cannot be measured (the
    // slice-37 review's N6).
    idle: (() => {
      const sums: Record<string, number> = {};
      const unmeasured = new Set<string>();
      for (const w of db.prepare('SELECT "held_intervals" FROM "work_items" WHERE "project" = ? AND "held_intervals" IS NOT NULL').all(p) as { held_intervals: string }[]) {
        for (const h of json<{ from: string; to?: string; reason: string }[]>(w.held_intervals, [])) {
          if (h.to === undefined || !(HOLD_REASONS as readonly string[]).includes(h.reason)) continue;
          const x = between(h.from, h.to, ['the hold began', 'it ended']);
          if (typeof x === 'number') sums[h.reason] = (sums[h.reason] ?? 0) + x;
          else unmeasured.add(h.reason);
        }
      }
      return Object.fromEntries(
        HOLD_REASONS.map((r) => [
          r,
          unmeasured.has(r) ? unknown(`a ${r} hold interval has no measurable time`) : r in sums ? sums[r]! : unknown(`no closed ${r} hold interval was recorded`),
        ]),
      );
    })(),
    idle_open: (() => {
      const out: Record<string, number> = Object.fromEntries(HOLD_REASONS.map((r) => [r, 0]));
      for (const w of db.prepare('SELECT "held_intervals" FROM "work_items" WHERE "project" = ? AND "held_intervals" IS NOT NULL').all(p) as { held_intervals: string }[]) {
        for (const h of json<{ from: string; to?: string; reason: string }[]>(w.held_intervals, [])) if (h.to === undefined && h.reason in out) out[h.reason]! += 1;
      }
      return out;
    })(),
  };

  const sessions = (db.prepare(`SELECT "id", "role", "created_at", "started_at", "finished_at", "outcome" FROM "runs" WHERE "project" = ? AND "kind" = 'session' ORDER BY "seq"`).all(p) as Record<string, string | null>[]).map((r) => {
    const turns = db.prepare('SELECT COUNT(*) AS n FROM "turns" WHERE "run" = ?').get(r.id) as { n: number };
    return {
      run: r.id as string,
      role: r.role as string,
      turns: turns.n,
      seconds: between(r.started_at ?? r.created_at, r.finished_at, ['the session started', 'the session ended']),
      outcome: r.outcome ?? unknown('the session has not ended'),
    };
  });

  const runsOfItems = (items: string[]) => runs.filter((r) => items.includes((runRows.find((x) => x.id === r.id)?.work_item as string | null) ?? ''));
  const runSeconds = (rs: typeof runs): Figure<number> => {
    if (rs.length === 0) return unknown('no run');
    const xs = rs.map((r) => between(r.created_at, typeof r.finished_at === 'string' ? r.finished_at : null, ['the run created', 'its end']));
    return xs.some((x) => typeof x !== 'number') ? unknown('a run has not ended, or its times were not recorded') : sum(xs as number[]);
  };
  const itemsOf = (kind: string, field: string, value: string) =>
    (db.prepare(`SELECT "id" FROM "work_items" WHERE "project" = ? AND "kind" = ? AND json_extract("subject", '$.' || ?) = ? ORDER BY "seq"`).all(p, kind, field, value) as { id: string }[]).map((w) => w.id);

  const phases = phaseRows.map((r) => {
    const plan = r.id as string;
    // The plan's authoring: its own items, and those of the generations an
    // early replacement replaced, whose readiness it inherits (D6 §5.7).
    const generations = (db
      .prepare(`WITH RECURSIVE "gen"("id") AS (SELECT ? UNION SELECT p."id" FROM "phase_plans" p JOIN "gen" g ON p."replaced_by" = g."id") SELECT "id" FROM "gen"`)
      .all(plan) as { id: string }[]).map((g) => g.id);
    const authoring = [...new Set(generations.flatMap((g) => itemsOf('check_authoring', 'phase_plan', g)))];
    const authoringRuns = runsOfItems(authoring);
    const proposal = authoring.length === 0
      ? undefined
      : (db
          .prepare(
            `SELECT p."classified_change_kind" FROM "protected_proposals" p JOIN "runs" x ON x."id" = p."run" WHERE x."work_item" IN (${authoring.map(() => '?').join(', ')}) ORDER BY p."seq" LIMIT 1`,
          )
          .get(...authoring) as { classified_change_kind: string | null } | undefined);
    const verification = runsOfItems(itemsOf('phase_verification', 'phase_plan', plan));
    const replanItems = (db.prepare(`SELECT "id" FROM "work_items" WHERE "project" = ? AND "kind" = 'replan' AND "trigger_source" = 'phase_complete' AND "trigger_id" = ? ORDER BY "seq"`).all(p, plan) as { id: string }[]).map((w) => w.id);
    const next = phaseRows.find((x) => (x.phase_number as number) === (r.phase_number as number) + 1 && x.status !== 'stale');
    return {
      phase: r.phase_number as number,
      plan,
      generation: r.generation as number,
      routing: (r.routing as string | null) ?? unknown('the plan records no routing'),
      published_to_completed: between(r.published_at as string | null, r.completed_at as string | null, ['the plan published', 'the phase completed']),
      published_to_authoring_ready: between(r.published_at as string | null, r.authoring_ready_at as string | null, ['the plan published', 'authoring readiness']),
      authoring_seconds: authoringRuns.length === 0 ? unknown('no check authoring ran for the plan') : runSeconds(authoringRuns),
      proposal_class: proposal?.classified_change_kind ?? unknown('no classified authoring proposal for the plan'),
      authoring_ready: (r.authoring_ready_at as string | null) ?? unknown('the phase is not ready for its Builders'),
      phase_verification: verification.length === 0 ? unknown('no phase verification ran for the plan') : runSeconds(verification),
      replan:
        replanItems.length === 0
          ? unknown('no replan followed the phase')
          : { seconds: runSeconds(runsOfItems(replanItems)), routing: (next?.routing as string | null | undefined) ?? unknown('no plan of the next phase records its routing') },
      // The generation's active stages (D6 §5.7; the review's M1).
      stages: activeStages(db, plan).length,
    };
  });

  const stages = (db.prepare(`SELECT s."id", s."number", s."status", s."work_item", s."created_at", s."integrated_revision", p."phase_number" FROM "stages" s JOIN "phase_plans" p ON p."id" = s."phase_plan" WHERE s."project" = ? ORDER BY p."phase_number", s."number", s.rowid`).all(p) as {
    id: string;
    number: number;
    status: string;
    work_item: string | null;
    created_at: string;
    integrated_revision: string | null;
    phase_number: number;
  }[]).map((s) => {
    // The stage's items: its stage_build and every item whose subject names it.
    const items = [...new Set([...(s.work_item ? [s.work_item] : []), ...(db.prepare(`SELECT "id" FROM "work_items" WHERE "project" = ? AND json_extract("subject", '$.stage') = ?`).all(p, s.id) as { id: string }[]).map((w) => w.id)])];
    const integrated = firstOf('work.integrated', s.work_item)?.at ?? null;
    const met = s.work_item === null ? undefined : ev.find((e) => e.type === 'work.dependency_met' && e.subject.work_item === s.work_item);
    const deps = s.work_item === null ? [] : json<unknown[]>((db.prepare('SELECT "depends_on" FROM "work_items" WHERE "id" = ?').get(s.work_item) as { depends_on: string | null } | undefined)?.depends_on ?? null, []);
    const hasMilestones = deps.some((d) => typeof d === 'object' && d !== null);
    const eligibleAt = met?.at ?? (hasMilestones ? null : (firstOf('work.created', s.work_item)?.at ?? null));
    const verifiedAt = s.status === 'verified' ? (firstOf('work.complete', s.work_item)?.at ?? null) : null;
    const evaluations = db.prepare(`SELECT "candidate", "created_at" FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" = 'stage' AND "stage" = ? ORDER BY rowid`).all(p, s.id) as { candidate: string; created_at: string }[];
    const candidates = [...new Set(evaluations.map((e) => e.candidate))];
    const onCandidates = (kind: string) => candidates.flatMap((c) => itemsOf(kind, 'candidate', c));
    // The stage's lineage (the slice-37 review's M9): the verification and
    // review items on its candidates, and the fixes of the findings raised on
    // them, which carry no subject.stage, so their waits are the stage's.
    const fixesOfFindings =
      candidates.length === 0
        ? []
        : (db
            .prepare(
              `SELECT w."id" FROM "work_items" w WHERE w."project" = ? AND w."kind" = 'fix'
                 AND json_extract(w."subject", '$.finding') IN (SELECT f."id" FROM "findings" f WHERE f."candidate" IN (${candidates.map(() => '?').join(', ')}))`,
            )
            .all(p, ...candidates) as { id: string }[]).map((w) => w.id);
    for (const i of [...onCandidates('verification'), ...onCandidates('review'), ...fixesOfFindings]) if (!items.includes(i)) items.push(i);
    const fixItems = [...new Set([...items.filter((i) => (db.prepare('SELECT "kind" FROM "work_items" WHERE "id" = ?').get(i) as { kind: string }).kind === 'fix')])];
    const checks = candidates.length === 0 ? [] : (db.prepare(`SELECT "started_at", "finished_at", "status" FROM "check_executions" WHERE "candidate" IN (${candidates.map(() => '?').join(', ')}) AND "status" = 'recorded'`).all(...candidates) as { started_at: string | null; finished_at: string | null }[]);
    const checkSecs = checks.map((x) => between(x.started_at, x.finished_at, ['the check started', 'it finished']));
    const findings: Record<string, number> = {};
    if (candidates.length > 0) {
      for (const f of db.prepare(`SELECT "effective_severity" AS "severity" FROM "findings" WHERE "candidate" IN (${candidates.map(() => '?').join(', ')})`).all(...candidates) as { severity: string }[]) findings[f.severity] = (findings[f.severity] ?? 0) + 1;
    }
    // The human wait (D6 §7.6; D6-M02): the union of the open intervals of
    // the decisions that blocked the stage's items, within the stage's
    // lifetime (registration to verified), overlaps once; decision-hours
    // their whole open time summed. A blocked work list that cannot be read,
    // or a blocking decision still open, makes both unknown.
    let why: string | null = null;
    const blocking = decisions.filter((d) => {
      const blocked = blockedItems(d);
      if (blocked === null) {
        why = "a decision's blocked work could not be read";
        return false;
      }
      return blocked.some((i) => items.includes(i));
    });
    if (blocking.some((d) => d.status === 'open')) why = 'a decision that blocks the stage is still open';
    const lo = ms(s.created_at);
    const hi = verifiedAt !== null ? ms(verifiedAt) : null;
    const inside: [number, number][] = [];
    let hours = 0;
    for (const d of blocking) {
      if (d.status === 'open') continue;
      const a = ms(d.raised_at);
      const b = ms(closedAt(d));
      if (a === null || b === null || b < a) {
        why = "a blocking decision's raising or its answer (or invalidation) was not recorded";
        continue;
      }
      hours += (b - a) / 3_600_000;
      const from = lo === null ? a : Math.max(a, lo);
      const to = hi === null ? b : Math.min(b, hi);
      if (to > from) inside.push([from, to]);
    }
    const runsOf = (ids: string[]) => runRows.filter((r) => r.work_item !== null && ids.includes(r.work_item as string));
    return {
      id: s.id,
      number: s.number,
      phase: s.phase_number,
      status: s.status,
      eligible_to_integrated: eligibleAt === null ? unknown('the stage was never recorded eligible (work.dependency_met)') : between(eligibleAt, integrated, ['its eligibility', 'its integration']),
      integrated_to_first_evaluation: between(integrated, evaluations[0]?.created_at ?? null, ['its integration', 'its first stage evaluation']),
      to_verified: between(integrated, verifiedAt, ['its integration', 'its verification']),
      created_to_integrated: between(s.created_at, integrated, ['the stage created', 'its integration']),
      runs: {
        builder: runsOf(s.work_item ? [s.work_item] : []).filter((r) => r.role === 'builder').length,
        verifier: runsOf(onCandidates('verification')).length,
        reviewer: runsOf(onCandidates('review')).length,
        fix: runsOf(fixItems).length,
      },
      builder_runs: runsOf(s.work_item ? [s.work_item] : []).filter((r) => r.role === 'builder').length,
      checks: { count: checks.length, seconds: checkSecs.some((x) => typeof x !== 'number') ? unknown('a check execution has no recorded start or finish') : sum(checkSecs as number[]) },
      repairs: s.work_item === null ? 0 : ((db.prepare('SELECT "repair_attempts" FROM "work_items" WHERE "id" = ?').get(s.work_item) as { repair_attempts: number } | undefined)?.repair_attempts ?? 0),
      findings,
      human_wait: why !== null ? unknown(why) : union(inside),
      decision_hours: why !== null ? unknown(why) : hours,
    };
  });

  const domains = (db.prepare('SELECT "id", "run", "profile", "status", "memory_peak", "memory_max", "peak_recorded_at" FROM "execution_domains" WHERE "project" = ? ORDER BY rowid').all(p) as {
    id: string;
    run: string | null;
    profile: string;
    status: string;
    memory_peak: number | null;
    memory_max: number | null;
    peak_recorded_at: string | null;
  }[]).map((d) => ({
    id: d.id,
    run: d.run ?? unknown('a domain of no run (a check or a service)'),
    profile: d.profile,
    status: d.status,
    memory_peak: d.memory_peak ?? unknown(d.peak_recorded_at === null ? 'the peak has not been read' : 'memory.peak could not be read before the domain was removed'),
    memory_max: d.memory_max ?? unknown('the maximum was not recorded at admission'),
  }));

  // The human tests the owner accepted for requirements no check can
  // establish (TPL §4): owed, never verified; recording their results is
  // for after M5 (the driver's ruling on the real M443 run's phase 2).
  const humanTests = (
    db
      .prepare(`SELECT "key", "assigned_phase" FROM "requirements" WHERE "project" = ? AND "human_test" = 1 AND ("criteria" IS NULL OR "criteria" = '[]') AND "withdrawn_at" IS NULL ORDER BY "key"`)
      .all(p) as { key: string; assigned_phase: number | null }[]
  ).map((r) => ({ requirement: r.key, phase: r.assigned_phase, status: 'owed' as const }));

  return {
    labels: { invocation_elapsed: 'invocation elapsed time' },
    project: projectSection,
    human_tests: humanTests,
    sessions,
    phases,
    stages,
    runs,
    domains,
    host: hostSection,
    hosts,
  };
}

// The host as it is at this engine start, recorded once per project and
// incarnation (D6 §7.6, A.3): `project_start` at the project's first
// observation, `engine_start` at each later incarnation's.
export function observeHost(tx: Tx, args: { project: string; incarnation: string; engine_version: string; engine_revision?: EngineRevision | null; settings: Record<string, number>; scripted?: string | null }): boolean {
  const resolved = resolveBackend(tx.db, { project: args.project, role: 'builder', scripted: args.scripted ?? null });
  const entry = resolved.kind === 'entry' ? { id: resolved.entry.id, binary_sha256: resolved.entry.binary_sha256, model: resolved.entry.model } : null;
  const exists = tx.db.prepare('SELECT "id", "backend_entry" FROM "host_observations" WHERE "project" = ? AND "incarnation" = ?').get(args.project, args.incarnation) as { id: string; backend_entry: string | null } | undefined;
  if (exists) {
    // The observation is what the host was at the start: a backend entry
    // activated later is not written over it; each run reports the entry it
    // ran on from its own receipt (the slice-37 review's M10). An
    // observation made with no entry takes the first one this incarnation
    // serves the project with.
    if (entry !== null && exists.backend_entry === null) tx.db.prepare('UPDATE "host_observations" SET "backend_entry" = ? WHERE "id" = ?').run(JSON.stringify(entry), exists.id);
    return false;
  }
  const earlier = tx.db.prepare('SELECT 1 FROM "host_observations" WHERE "project" = ? LIMIT 1').get(args.project);
  const revision = args.engine_revision ?? null;
  const settings: Record<string, number> = Object.fromEntries(Object.entries(args.settings ?? {}).filter(([, v]) => typeof v === 'number'));
  settings.role_memory_max = effectiveProfileMax(tx.db, args.project, 'role');
  settings.check_memory_max = effectiveProfileMax(tx.db, args.project, 'check');
  const liveNow = (tx.db.prepare(`SELECT COUNT(*) AS n FROM "execution_domains" WHERE "status" <> 'terminated' AND "profile" <> 'service'`).get() as { n: number }).n;
  // The peak is the engine's, over the incarnation: a project observed
  // later in it starts from the peak the incarnation's earlier
  // observations hold (the slice-37 review's N7).
  const earlierPeak = (tx.db.prepare('SELECT MAX("peak_domains") AS m FROM "host_observations" WHERE "incarnation" = ?').get(args.incarnation) as { m: number | null }).m;
  const live = Math.max(liveNow, earlierPeak ?? 0);
  const id = tx.newId('hobs_');
  tx.db
    .prepare(
      'INSERT INTO "host_observations" ("id", "created_at", "project", "incarnation", "engine_version", "engine_revision", "engine_revision_unknown", "autonomy", "settings", "mem_available", "trigger", "host_qualification", "backend_entry", "peak_domains") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      tx.at,
      args.project,
      args.incarnation,
      args.engine_version,
      // The revision this engine was started from (M544), or why it is
      // unknown; a caller that did not say is unknown too, never a guess.
      revision && 'revision' in revision ? revision.revision : null,
      revision && 'revision' in revision ? null : (revision?.unknown ?? 'the engine did not report its revision'),
      (projectOptions(tx.db, args.project) as { autonomy?: string }).autonomy ?? null,
      JSON.stringify(settings),
      memAvailable(),
      earlier ? 'engine_start' : 'project_start',
      currentHostQualification(tx.db)?.id ?? null,
      entry === null ? null : JSON.stringify(entry),
      live,
    );
  tx.emit('host.observed', { project: args.project, host_observation: id }, { trigger: earlier ? 'engine_start' : 'project_start' });
  return true;
}

// The peak number of domains running at once (D6 §7.6, A.3), as admission
// sees it: raised on every observation of this incarnation when a domain is
// admitted.
export function notePeakDomains(tx: Tx): void {
  const incarnation = engineSettings().incarnation;
  if (!incarnation) return;
  const live = (tx.db.prepare(`SELECT COUNT(*) AS n FROM "execution_domains" WHERE "status" <> 'terminated' AND "profile" <> 'service'`).get() as { n: number }).n;
  tx.db.prepare('UPDATE "host_observations" SET "peak_domains" = ? WHERE "incarnation" = ? AND ("peak_domains" IS NULL OR "peak_domains" < ?)').run(live, incarnation, live);
}
