// The pace read (D6 §7.6; N01; SEAM.md §355; M441 pins each figure's
// derivation in slice 37). `GET /v1/projects/:p/pace`: a projection of rows
// that exist, never a second state. Every leaf is a value or
// `{"unknown": "<reason>"}`: a figure whose observation was not recorded
// when it occurred is unknown, never recomputed from the present and never
// a measured zero. Nothing here writes, evaluates or probes.

import type { Database } from 'better-sqlite3';

import { notFound } from '../store/transitions/common.js';
import { projectOptions } from '../store/transitions/settings.js';
import { memAvailable } from '../store/transitions/envelope.js';
import type { Tx } from '../store/transitions/tx.js';

type Unknown = { unknown: string };
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
  return Math.max(0, (y - x) / 1000);
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

export function paceView(db: Database, args: { project: string }) {
  const project = db.prepare('SELECT "id", "created_at" FROM "projects" WHERE "id" = ?').get(args.project) as { id: string; created_at: string } | undefined;
  if (!project) throw notFound('project', args.project);
  const p = project.id;
  const decisions = db.prepare('SELECT "id", "kind", "raised_at", "consumed_at", "status", "answer", "blocked_while_open" FROM "decisions" WHERE "project" = ? ORDER BY "seq"').all(p) as DecisionRow[];
  const answeredAt = (d: DecisionRow): string | null => json<{ at?: string } | null>(d.answer, null)?.at ?? d.consumed_at;
  // The decisions a person answered (the routed ones), with their open time.
  const routed = decisions
    .filter((d) => json<{ actor?: string } | null>(d.answer, null)?.actor === 'human')
    .map((d) => ({ id: d.id, kind: d.kind, open_seconds: between(d.raised_at, answeredAt(d), ['the decision raised', 'its answer']) }));
  const alpha = firstEvent(db, 'candidate.advanced', p, (pl) => pl.to === 'alpha_deployed');
  const phaseRows = db.prepare(`SELECT * FROM "phase_plans" WHERE "project" = ? ORDER BY "phase_number", "generation"`).all(p) as Record<string, unknown>[];

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

  const phases = phaseRows.map((r) => ({
    phase: r.phase_number as number,
    plan: r.id as string,
    generation: r.generation as number,
    routing: (r.routing as string | null) ?? unknown('the plan records no routing'),
    published_to_completed: between(r.published_at as string | null, r.completed_at as string | null, ['the plan published', 'the phase completed']),
    published_to_authoring_ready: between(r.published_at as string | null, r.authoring_ready_at as string | null, ['the plan published', 'authoring readiness']),
    stages: (db.prepare('SELECT COUNT(*) AS n FROM "stages" WHERE "phase_plan" = ?').get(r.id) as { n: number }).n,
  }));

  const stages = (db.prepare(`SELECT s."id", s."number", s."status", s."work_item", s."created_at", p."phase_number" FROM "stages" s JOIN "phase_plans" p ON p."id" = s."phase_plan" WHERE s."project" = ? ORDER BY p."phase_number", s."number", s.rowid`).all(p) as {
    id: string;
    number: number;
    status: string;
    work_item: string | null;
    created_at: string;
    phase_number: number;
  }[]).map((s) => {
    // The human wait: the union of the open intervals of the decisions that
    // blocked the stage's work (D6 §7.6); none blocked it, a measured zero.
    const blocking = decisions.filter((d) => s.work_item !== null && json<string[]>(d.blocked_while_open, []).includes(s.work_item));
    const intervals: [number, number][] = [];
    let open: string | null = null;
    for (const d of blocking) {
      const a = ms(d.raised_at);
      const b = ms(answeredAt(d));
      if (a === null) open = 'a blocking decision\'s raising was not recorded';
      else if (b === null) open = d.status === 'open' ? null : 'a blocking decision\'s answer was not recorded';
      else intervals.push([a, b]);
    }
    const stillOpen = blocking.some((d) => d.status === 'open');
    const runs = s.work_item === null ? [] : (db.prepare('SELECT "role" FROM "runs" WHERE "work_item" = ?').all(s.work_item) as { role: string }[]);
    const integrated = firstEvent(db, 'work.integrated', p, (_pl, sub) => sub.work_item === s.work_item);
    return {
      id: s.id,
      number: s.number,
      phase: s.phase_number,
      status: s.status,
      human_wait: open !== null ? unknown(open) : stillOpen ? unknown('a decision that blocks the stage is still open') : union(intervals),
      created_to_integrated: between(s.created_at, integrated, ['the stage created', 'its integration']),
      builder_runs: runs.filter((r) => r.role === 'builder').length,
    };
  });

  const runs = (db.prepare('SELECT r."id", r."role", r."kind", r."created_at", r."started_at", r."finished_at", r."outcome", r."reason_class", w."kind" AS "work_kind" FROM "runs" r LEFT JOIN "work_items" w ON w."id" = r."work_item" WHERE r."project" = ? ORDER BY r."seq"').all(p) as Record<string, string | null>[]).map((r) => ({
    id: r.id as string,
    role: r.role as string,
    work_kind: r.work_kind ?? (r.kind as string),
    wait: between(r.created_at, r.started_at, ['the run created', 'its launch']),
    elapsed: between(r.started_at, r.finished_at, ['its launch', 'its terminal observation']),
    outcome: r.outcome ?? unknown('the run has not ended'),
    reason_class: r.reason_class ?? unknown('the run has not ended'),
  }));

  const domains = (db.prepare('SELECT "id", "profile", "status" FROM "execution_domains" WHERE "project" = ? ORDER BY rowid').all(p) as { id: string; profile: string; status: string }[]).map((d) => ({
    id: d.id,
    profile: d.profile,
    status: d.status,
    memory_peak: unknown('memory.peak is not recorded at termination in this engine (slice 37)'),
  }));

  const host = db.prepare('SELECT * FROM "host_observations" WHERE "project" = ? ORDER BY "created_at" DESC, rowid DESC LIMIT 1').get(p) as
    | { created_at: string; incarnation: string; engine_version: string; autonomy: string; settings: string; mem_available: number | null }
    | undefined;
  const settings = host ? json<Record<string, number>>(host.settings, {}) : {};
  const hostSection = host
    ? {
        observed_at: host.created_at,
        incarnation: host.incarnation,
        engine_version: host.engine_version,
        autonomy: host.autonomy,
        tick_interval: settings.tick_interval ?? unknown('not recorded'),
        domain_memory_max: settings.domain_memory_max ?? unknown('not recorded'),
        max_concurrent_domains: settings.max_concurrent_domains ?? unknown('not recorded'),
        mem_available: host.mem_available ?? unknown('MemAvailable could not be read then'),
        peak_domains: unknown('the scheduler does not record the peak number of domains at once (slice 37)'),
      }
    : { autonomy: unknown('no host observation was recorded for the project'), observed_at: unknown('no host observation was recorded for the project') };

  return { project: projectSection, sessions, phases, stages, runs, domains, host: hostSection };
}

// The host as it is at this engine start, recorded once per project and
// incarnation (D6 §7.6, A.3).
export function observeHost(tx: Tx, args: { project: string; incarnation: string; engine_version: string; settings: Record<string, number> }): boolean {
  const exists = tx.db.prepare('SELECT 1 FROM "host_observations" WHERE "project" = ? AND "incarnation" = ?').get(args.project, args.incarnation);
  if (exists) return false;
  const settings = Object.fromEntries(Object.entries(args.settings ?? {}).filter(([, v]) => typeof v === 'number'));
  tx.db
    .prepare('INSERT INTO "host_observations" ("id", "created_at", "project", "incarnation", "engine_version", "autonomy", "settings", "mem_available") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tx.newId('hobs_'), tx.at, args.project, args.incarnation, args.engine_version, projectOptions(tx.db, args.project).autonomy ?? 'phase', JSON.stringify(settings), memAvailable());
  return true;
}
