// The reads of D6 A.8 (SEAM.md §346): `GET /v1/projects/:p/spec` (the
// approved versions, the requirements with their criteria, the modules and
// the environments by name) and `GET …/plan` (the roadmap, the active plan
// with its stages, the proposals and the plan checks). Reads: nothing here
// writes, evaluates or probes. A proposal is a bundle a close recorded, or a
// checkpoint's plan file no bundle carries yet (reading 2: `proposed` is a
// listing, never a `phase_plans` row).

import type { Database } from 'better-sqlite3';

import { notFound } from '../store/transitions/common.js';
import { buildComplete } from './phase.js';
import { alphaBarrier, conformancePhaseComplete, conformanceStateOf } from '../adopt/conformance.js';
import { isAdopted } from '../adopt/records.js';

const json = <T>(text: unknown, fallback: T): T => {
  try {
    return typeof text === 'string' ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

const mustProject = (db: Database, project: string) => {
  if (!db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(project)) throw notFound('project', project);
};

export function specView(db: Database, args: { project: string }) {
  mustProject(db, args.project);
  // A requirement's delivery status (D6-D02; SEAM.md §354; the 31b
  // review's S9 and the ruling on it): `verified` only while a completed
  // phase's stage delivered it and nothing since has taken that away: no
  // specification change approved after that completion changed it, and no
  // obligation on a check of its criteria is open. `pending` only when it is
  // known to be pending; `{unknown: reason}` when a record it rests on
  // cannot be read; `withdrawn` when withdrawn.
  const strict = <T>(text: unknown): T | undefined => {
    if (typeof text !== 'string') return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  };
  let stagesUnread = false;
  const deliveredAt = new Map<string, string>();
  for (const s of db
    .prepare(`SELECT s."implements", p."completed_at" FROM "stages" s JOIN "phase_plans" p ON p."id" = s."phase_plan" WHERE p."project" = ? AND p."active" = 1 AND p."completed_at" IS NOT NULL AND s."cancelled_at" IS NULL`)
    .all(args.project) as { implements: string | null; completed_at: string }[]) {
    const list = strict<unknown>(s.implements);
    if (!Array.isArray(list)) {
      stagesUnread = true;
      continue;
    }
    for (const r of list as string[]) if (!deliveredAt.has(r) || deliveredAt.get(r)! < s.completed_at) deliveredAt.set(r, s.completed_at);
  }
  // Changed since: the keys an approved change's impact names, by when.
  let changesUnread = false;
  const changedAt = new Map<string, string>();
  for (const c of db
    .prepare(`SELECT c."impact_value", r."approved_at" FROM "spec_change_requests" c JOIN "spec_revisions" r ON r."id" = c."approved_revision" WHERE c."project" = ? AND c."status" = 'approved'`)
    .all(args.project) as { impact_value: string | null; approved_at: string }[]) {
    const impact = strict<{ requirements?: { key: string }[] }>(c.impact_value);
    if (!impact || !Array.isArray(impact.requirements)) {
      changesUnread = true;
      continue;
    }
    for (const q of impact.requirements) if (!changedAt.has(q.key) || changedAt.get(q.key)! < c.approved_at) changedAt.set(q.key, c.approved_at);
  }
  let obligationsUnread = false;
  const owedCriteria = new Set<string>();
  for (const o of db.prepare(`SELECT "criteria" FROM "check_obligations" WHERE "project" = ? AND "resolved_at" IS NULL`).all(args.project) as { criteria: string }[]) {
    const list = strict<unknown>(o.criteria);
    if (!Array.isArray(list)) obligationsUnread = true;
    else for (const c of list as string[]) owedCriteria.add(c);
  }
  const ids = new Map((db.prepare('SELECT "id", "key" FROM "requirements" WHERE "project" = ?').all(args.project) as { id: string; key: string }[]).map((r) => [r.key, r.id]));
  const statusOf = (r: Record<string, unknown>): string | { unknown: string } => {
    if (r.withdrawn_at !== null) return 'withdrawn';
    // Scoped mode's criterion-less requirements, visibly pending with their
    // mark, never silently promoted (E6; D6 §8.1 step 2).
    if (r.status === 'descriptive_unverified') return 'descriptive_unverified';
    const key = r.key as string;
    const at = deliveredAt.get(ids.get(key) ?? '') ?? deliveredAt.get(key);
    if (at === undefined) return stagesUnread ? { unknown: "a completed phase's stage could not be read, so whether it delivered this requirement is not known" } : 'pending';
    const changed = changedAt.get(key);
    if (changed !== undefined && changed >= at) return 'pending';
    const criteria = r.criteria === null ? [] : strict<unknown>(r.criteria);
    if (!Array.isArray(criteria)) return { unknown: "the requirement's criteria could not be read" };
    if ((criteria as string[]).some((c) => owedCriteria.has(c))) return 'pending';
    if (changesUnread) return { unknown: "an approved specification change's impact could not be read, so whether it changed this requirement is not known" };
    if (obligationsUnread) return { unknown: "an open obligation's criteria could not be read" };
    return 'verified';
  };
  const versions = db.prepare('SELECT "version", "git_blob", "semantic_digest", "approved_by", "approved_at" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version"').all(args.project);
  const requirements = (
    db
      .prepare('SELECT "key", "text", "criteria", "criteria_text", "sensitive_areas", "assigned_phase", "status", "human_test", "withdrawn_at", "origin", "defect", "reverse_engineered" FROM "requirements" WHERE "project" = ? ORDER BY "key"')
      .all(args.project) as Record<string, unknown>[]
  ).map((r) => ({
    key: r.key,
    text: r.text,
    // The criteria with their text where the approved specification gave it.
    criteria: r.criteria_text !== null ? json<{ id: string; text: string }[]>(r.criteria_text, []) : json<string[]>(r.criteria, []).map((id) => ({ id, text: null })),
    sensitive_areas: json<string[]>(r.sensitive_areas, []),
    assigned_phase: r.assigned_phase,
    status: statusOf(r),
    human_test: r.human_test === 1,
    withdrawn: r.withdrawn_at !== null,
    // K10 (SEAM.md §379): the role's claim, and the engine's marks.
    origin: r.origin,
    defect: r.defect === 1,
    reverse_engineered: r.reverse_engineered === 1,
  }));
  const modules = (db.prepare('SELECT "name", "paths", "sensitive_areas", "tier_override" FROM "modules" WHERE "project" = ? ORDER BY "name"').all(args.project) as Record<string, unknown>[]).map((m) => ({
    name: m.name,
    paths: json<string[]>(m.paths, []),
    sensitive_areas: json<string[]>(m.sensitive_areas, []),
    tier_override: m.tier_override,
  }));
  const environments = db.prepare('SELECT "name", "adapter" FROM "environments" WHERE "project" = ? ORDER BY "name"').all(args.project);
  return { versions, requirements, modules, environments, change_requests: [], ...(isAdopted(db, args.project) ? { conformance: conformanceStateOf(db, args.project) } : {}) };
}

export function planView(db: Database, args: { project: string }) {
  mustProject(db, args.project);
  const road = db.prepare('SELECT "version", "phases" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as { version: number; phases: string } | undefined;
  const p = db.prepare(`SELECT * FROM "phase_plans" WHERE "project" = ? AND "active" = 1 AND "status" IN ('published', 'completed') ORDER BY "created_at" DESC LIMIT 1`).get(args.project) as
    | Record<string, unknown>
    | undefined;
  let plan: Record<string, unknown> | null = null;
  if (p) {
    const stages = (db.prepare('SELECT * FROM "stages" WHERE "phase_plan" = ? ORDER BY "number"').all(p.id) as Record<string, unknown>[]).map((s) => ({
      id: s.id,
      number: s.number,
      goal: s.goal,
      status: s.status,
      depends_on: json<string[]>(s.depends_on, []),
      implements: json<string[]>(s.implements, []),
      validation: json<unknown>(s.validation, null),
      work_item: s.work_item,
    }));
    plan = {
      id: p.id,
      phase_number: p.phase_number,
      generation: p.generation,
      active: p.active === 1,
      approved_by: p.approved_by,
      routing: p.routing,
      published_at: p.published_at,
      authoring_ready_at: p.authoring_ready_at,
      completed_at: p.completed_at,
      completion_binding: json<unknown>(p.completion_binding, null),
      bundle: p.bundle,
      stages,
    };
  }
  const proposals: { bundle: string | null; phase: number | null; status: string; run?: string | null; path?: string; plan_check?: string }[] = (
    db.prepare('SELECT "id", "phase_number", "status", "run" FROM "plan_bundles" WHERE "project" = ? ORDER BY "created_at"').all(args.project) as { id: string; phase_number: number | null; status: string; run: string | null }[]
  ).map((b) => ({ bundle: b.id, phase: b.phase_number, status: b.status, run: b.run }));
  // A replan's plan its check refused (D6 §5.3, §5.6): recorded with no
  // bundle, listed `stale` when its baseline moved under it
  // (PLAN_STALE_BASELINE; M424 (f)), else `refused`; never current.
  for (const c of db
    .prepare(`SELECT "id", "phase_number", "reasons", json_extract("evidence", '$.run') AS "run" FROM "plan_checks" WHERE "project" = ? AND "bundle" IS NULL AND "outcome" = 'refused' ORDER BY "created_at"`)
    .all(args.project) as { id: string; phase_number: number | null; reasons: string; run: string | null }[]) {
    const reasons = json<{ code: string }[]>(c.reasons, []);
    proposals.push({ bundle: null, phase: c.phase_number, status: reasons.some((r) => r.code === 'PLAN_STALE_BASELINE') ? 'stale' : 'refused', run: c.run, plan_check: c.id });
  }
  // A checkpoint's plan no bundle carries: the last save of each session
  // whose notes name a phase plan file, while no plan of that phase is
  // published and no bundle of that session records it.
  const notes = db.prepare(`SELECT "id", "session_notes" FROM "runs" WHERE "project" = ? AND "kind" = 'session' AND "role" = 'architect' AND "session_notes" IS NOT NULL ORDER BY "seq"`).all(args.project) as {
    id: string;
    session_notes: string;
  }[];
  for (const n of notes) {
    if (proposals.some((x) => x.run === n.id)) continue;
    const blobs = json<{ blobs?: Record<string, string> }>(n.session_notes, {}).blobs ?? {};
    for (const path of Object.keys(blobs)) {
      const m = /^\.surety\/phases\/phase-([1-9][0-9]*)\.json$/.exec(path);
      if (!m) continue;
      const phase = Number(m[1]);
      const published = db.prepare(`SELECT 1 FROM "phase_plans" WHERE "project" = ? AND "phase_number" = ? AND "status" IN ('published', 'completed')`).get(args.project, phase);
      if (!published) proposals.push({ bundle: null, phase, status: 'proposed', run: n.id, path });
    }
  }
  const checks = (db.prepare('SELECT * FROM "plan_checks" WHERE "project" = ? ORDER BY "created_at"').all(args.project) as Record<string, unknown>[]).map((c) => ({
    ...c,
    reasons: json<unknown>(c.reasons, []),
    changes_architecture: json<unknown>(c.changes_architecture, null),
    changes_adrs: json<unknown>(c.changes_adrs, null),
    changes_roadmap: json<unknown>(c.changes_roadmap, null),
    obligations: json<unknown>(c.obligations, null),
  }));
  // The requirements with their phase and marks (SEAM.md §379).
  // Their status is the spec read's (delivery from the completed phases).
  const requirements = specView(db, args).requirements.map((r) => ({ key: r.key, status: r.status, reverse_engineered: r.reverse_engineered, defect: r.defect, assigned_phase: r.assigned_phase, origin: r.origin }));
  // An adopted project (D6 §8.1 steps 5, 6; B11): the conformance stage's
  // state with its last gate's reasons, and the Alpha barrier while it holds
  // the change-phase replan.
  let adopted: Record<string, unknown> = {};
  if (isAdopted(db, args.project)) {
    const done = conformancePhaseComplete(db, args.project);
    const barrier = alphaBarrier(db, args.project);
    adopted = {
      conformance: conformanceStateOf(db, args.project),
      alpha_barrier: done === null ? { phase_complete: false, open: false, reasons: [] } : { phase_complete: true, open: barrier.open, candidate: barrier.candidate, reasons: barrier.open ? [] : [{ code: 'CONFORMANCE_ALPHA_PENDING', reason: barrier.reason }] },
    };
  }
  // The build is complete when every phase of the roadmap is (SEAM.md §352).
  return { roadmap: road ? { version: road.version, phases: json<unknown>(road.phases, []) } : null, plan, proposals, checks, build: { complete: buildComplete(db, args.project) }, requirements, ...adopted };
}
