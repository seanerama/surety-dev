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

// What the mount plan's validation needs before a launch (D2 §2.3): the
// project's widened read paths, and the locations no widening may reach that
// the store knows of.
export function mountContext(db: Database, args: { project: string }) {
  const col = (sql: string) => (db.prepare(sql).all() as { p: string }[]).map((r) => r.p);
  return {
    paths: projectOptions(db, args.project).sandbox_read_paths,
    context: {
      repositories: col('SELECT DISTINCT "dev_repo_path" AS p FROM "projects"'),
      workspaces: col(`SELECT "path" AS p FROM "workspaces" WHERE "disposition" <> 'discarded'`),
      checkouts: col('SELECT "path" AS p FROM "managed_checkouts"'),
    },
  };
}
