// Read-only queries. Reads never write and never call out of the store.

import type { Database } from 'better-sqlite3';

import { policyRevision, projectEffective as effectivePolicy, projectOptions } from './transitions/settings.js';
import { projectNotFound } from './transitions/project.js';
import { CHAIN_BOUNDARY, ROLE_OF, dispatchBlocker } from './transitions/runs.js';
import type { WorkRow } from './transitions/work.js';

// The project's effective ungoverned policy: the revision the engine
// recorded over the schema defaults, or the defaults with revision null.
export function projectPolicy(db: Database, project: string) {
  const row = db.prepare('SELECT "id" FROM "projects" WHERE "id" = ?').get(project);
  if (!row) throw projectNotFound(project);
  return { effective: effectivePolicy(db, project), revision: policyRevision(db, project) };
}

// D1 §8.1 step 8 order: verification due, then builds, then replans, then
// the rest; oldest first within each.
const PRIORITY: Record<string, number> = { verification: 0, check_correction: 0, stage_build: 1, fix: 1, replan: 2 };

export interface ProjectCandidates {
  project: string;
  repo: string;
  branch: string;
  items: { id: string; kind: string; role: string; boundary: boolean }[];
}

// Every project with work that could be dispatched now, as far as the store
// alone can tell. The scheduler's prerequisite steps decide the rest, and the
// claim transaction checks it all again.
export function dispatchCandidates(db: Database, args: { maxConcurrentRuns: number }): ProjectCandidates[] {
  const projects = db.prepare('SELECT "id", "dev_repo_path", "integration_branch" FROM "projects" ORDER BY "created_at", "id"').all() as {
    id: string;
    dev_repo_path: string;
    integration_branch: string;
  }[];
  const out: ProjectCandidates[] = [];
  for (const p of projects) {
    let items: ProjectCandidates['items'];
    try {
      items = (db.prepare(`SELECT * FROM "work_items" WHERE "project" = ? AND "status" = 'eligible' ORDER BY "seq"`).all(p.id) as WorkRow[])
        .map((item) => ({ item, blocker: dispatchBlocker(db, item, args.maxConcurrentRuns) }))
        .filter(({ blocker }) => blocker === null || blocker === CHAIN_BOUNDARY)
        .sort((a, b) => (PRIORITY[a.item.kind] ?? 3) - (PRIORITY[b.item.kind] ?? 3) || a.item.seq - b.item.seq)
        .map(({ item, blocker }) => ({ id: item.id, kind: item.kind, role: ROLE_OF[item.kind]!, boundary: blocker === CHAIN_BOUNDARY }));
    } catch {
      // A check that could not read what it needs (a budget, D1 §6.6) has
      // failed: nothing of this project is dispatched on it, and the other
      // projects go on.
      items = [];
    }
    out.push({ project: p.id, repo: p.dev_repo_path, branch: p.integration_branch, items });
  }
  return out;
}

export function projectIds(db: Database): string[] {
  return (db.prepare('SELECT "id" FROM "projects" ORDER BY "created_at", "id"').all() as { id: string }[]).map((r) => r.id);
}

// Runs that are quarantined, for the observation at every tick (SEAM.md §14).
export function quarantinedRuns(db: Database): { id: string; project: string }[] {
  return db.prepare(`SELECT "id", "project" FROM "runs" WHERE "state" = 'finalizing' AND "quarantined" = 1 ORDER BY "created_at"`).all() as {
    id: string;
    project: string;
  }[];
}

// What a run's context package binds (D2 §1.3; F §3.10.8): the work item and
// its subject, the stage it builds with its requirements, phase plan and
// module interfaces, for a Reviewer the candidate and the acceptance content
// it reviews, for a resumed run what the records say of the run it resumes.
// Never a raw user report (E5): the trigger's report is not read here.
export function contextFacts(db: Database, args: { run: string }) {
  const run = db.prepare('SELECT * FROM "runs" WHERE "id" = ?').get(args.run) as Record<string, unknown> | undefined;
  if (!run) return null;
  const item = db.prepare('SELECT "id", "kind", "subject", "project" FROM "work_items" WHERE "id" = ?').get(run.work_item) as { id: string; kind: string; subject: string; project: string };
  const stage = db.prepare('SELECT * FROM "stages" WHERE "id" = ? OR "work_item" = ? ORDER BY "number" LIMIT 1').get(item.subject, item.id) as Record<string, unknown> | undefined;
  const parse = <T>(text: unknown, fallback: T): T => {
    try {
      return typeof text === 'string' ? (JSON.parse(text) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  let requirements: { key: string; text_ref: string; assigned_phase: number | null }[] = [];
  let modules: { name: string; paths: unknown }[] = [];
  let plan: Record<string, unknown> | null = null;
  if (stage) {
    const ids = parse<string[]>(stage.requirement_ids, []);
    requirements = ids
      .map((id) => db.prepare('SELECT "key", "text_ref", "assigned_phase" FROM "requirements" WHERE "project" = ? AND ("id" = ? OR "key" = ?)').get(item.project, id, id) as { key: string; text_ref: string; assigned_phase: number | null } | undefined)
      .filter((r): r is { key: string; text_ref: string; assigned_phase: number | null } => r !== undefined);
    const names = parse<string[]>(stage.modules, []);
    modules = names
      .map((name) => db.prepare('SELECT "name", "paths" FROM "modules" WHERE "project" = ? AND "name" = ?').get(item.project, name) as { name: string; paths: string } | undefined)
      .filter((m): m is { name: string; paths: string } => m !== undefined)
      .map((m) => ({ name: m.name, paths: parse<unknown>(m.paths, []) }));
    const p = db.prepare('SELECT "phase_number", "git_path", "prepared_against_revision" FROM "phase_plans" WHERE "id" = ?').get(stage.phase_plan) as Record<string, unknown> | undefined;
    plan = p ?? null;
  }
  const candidate = db.prepare('SELECT "id", "revision" FROM "candidates" WHERE "id" = ?').get(item.subject) as { id: string; revision: string } | undefined;
  let resumed: { run: string; outcome: unknown; summary: unknown } | null = null;
  if (typeof run.parent_run === 'string') {
    const parent = db.prepare('SELECT "id", "outcome", "result_value" FROM "runs" WHERE "id" = ?').get(run.parent_run) as { id: string; outcome: unknown; result_value: string | null } | undefined;
    if (parent) resumed = { run: parent.id, outcome: parent.outcome, summary: parse<{ summary?: unknown } | null>(parent.result_value, null)?.summary ?? null };
  }
  return {
    run: { id: run.id as string, role: run.role as string, base_revision: run.base_revision as string, content_hash: (run.content_hash as string | null) ?? null },
    work_item: item,
    stage: stage ? { number: stage.number, goal: stage.goal, modules: parse<unknown>(stage.modules, []), requirement_ids: parse<unknown>(stage.requirement_ids, []), implements: parse<unknown>(stage.implements, []) } : null,
    requirements,
    modules,
    phase_plan: plan,
    candidate: candidate ? { id: candidate.id, revision: candidate.revision, acceptance_content_hash: (run.content_hash as string | null) ?? null } : null,
    resumed,
  };
}

// What the mount plan's validation needs before a launch (D2 §2.3): the
// project's widened read paths, and the locations no widening may reach that
// the store knows of.
export function mountContext(db: Database, args: { project: string }) {
  const col = (sql: string) => (db.prepare(sql).all() as { p: string }[]).map((r) => r.p);
  const options = projectOptions(db, args.project);
  // The protected roots of the project's effective version (D1 §7.3; D2
  // §2.3): every role but the Verifier sees them read-only.
  const effective = db
    .prepare(`SELECT "roots", "fingerprint" FROM "protected_versions" WHERE "project" = ? AND "authorized" = 1 AND "effective_from" IS NOT NULL AND "superseded_by" IS NULL`)
    .get(args.project) as { roots: string; fingerprint: string } | undefined;
  return {
    paths: options.sandbox_read_paths,
    egress_allow_extra: options.egress_allow_extra,
    protected: { roots: effective ? (JSON.parse(effective.roots) as string[]) : ['.surety/checks/'], fingerprint: effective?.fingerprint ?? null },
    context: {
      repositories: col('SELECT DISTINCT "dev_repo_path" AS p FROM "projects"'),
      workspaces: col(`SELECT "path" AS p FROM "workspaces" WHERE "disposition" <> 'discarded'`),
      checkouts: col('SELECT "path" AS p FROM "managed_checkouts"'),
    },
  };
}
