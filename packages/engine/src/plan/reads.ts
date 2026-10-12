// The reads of D6 A.8 (SEAM.md §346): `GET /v1/projects/:p/spec` (the
// approved versions, the requirements with their criteria, the modules and
// the environments by name) and `GET …/plan` (the roadmap, the active plan
// with its stages, the proposals and the plan checks). Reads: nothing here
// writes, evaluates or probes. A proposal is a bundle a close recorded, or a
// checkpoint's plan file no bundle carries yet (reading 2: `proposed` is a
// listing, never a `phase_plans` row).

import type { Database } from 'better-sqlite3';

import { notFound } from '../store/transitions/common.js';

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
  const versions = db.prepare('SELECT "version", "git_blob", "semantic_digest", "approved_by", "approved_at" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version"').all(args.project);
  const requirements = (
    db
      .prepare('SELECT "key", "text", "criteria", "criteria_text", "sensitive_areas", "assigned_phase", "status", "human_test", "withdrawn_at" FROM "requirements" WHERE "project" = ? ORDER BY "key"')
      .all(args.project) as Record<string, unknown>[]
  ).map((r) => ({
    key: r.key,
    text: r.text,
    // The criteria with their text where the approved specification gave it.
    criteria: r.criteria_text !== null ? json<{ id: string; text: string }[]>(r.criteria_text, []) : json<string[]>(r.criteria, []).map((id) => ({ id, text: null })),
    sensitive_areas: json<string[]>(r.sensitive_areas, []),
    assigned_phase: r.assigned_phase,
    status: r.status,
    human_test: r.human_test === 1,
    withdrawn: r.withdrawn_at !== null,
  }));
  const modules = (db.prepare('SELECT "name", "paths", "sensitive_areas", "tier_override" FROM "modules" WHERE "project" = ? ORDER BY "name"').all(args.project) as Record<string, unknown>[]).map((m) => ({
    name: m.name,
    paths: json<string[]>(m.paths, []),
    sensitive_areas: json<string[]>(m.sensitive_areas, []),
    tier_override: m.tier_override,
  }));
  const environments = db.prepare('SELECT "name", "adapter" FROM "environments" WHERE "project" = ? ORDER BY "name"').all(args.project);
  return { versions, requirements, modules, environments, change_requests: [] };
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
  const proposals: { bundle: string | null; phase: number | null; status: string; run?: string | null; path?: string }[] = (
    db.prepare('SELECT "id", "phase_number", "status", "run" FROM "plan_bundles" WHERE "project" = ? ORDER BY "created_at"').all(args.project) as { id: string; phase_number: number | null; status: string; run: string | null }[]
  ).map((b) => ({ bundle: b.id, phase: b.phase_number, status: b.status, run: b.run }));
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
  return { roadmap: road ? { version: road.version, phases: json<unknown>(road.phases, []) } : null, plan, proposals, checks };
}
