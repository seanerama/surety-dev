// Read-only queries. Reads never write and never call out of the store.

import type { Database } from 'better-sqlite3';

import { projectPolicyDefaults } from '../config/project-policy.js';
import { projectNotFound } from './transitions/project.js';
import { ROLE_OF, dispatchBlocker } from './transitions/runs.js';
import type { WorkRow } from './transitions/work.js';

// The project's effective ungoverned policy. No policy revision can exist yet
// (valid changes need the journaled git path), so the effective values are
// the schema defaults and the revision is null.
export function projectPolicy(db: Database, project: string) {
  const row = db.prepare('SELECT "id" FROM "projects" WHERE "id" = ?').get(project);
  if (!row) throw projectNotFound(project);
  return { effective: projectPolicyDefaults(), revision: null };
}

// D1 §8.1 step 8 order: verification due, then builds, then replans, then
// the rest; oldest first within each.
const PRIORITY: Record<string, number> = { verification: 0, check_correction: 0, stage_build: 1, fix: 1, replan: 2 };

export interface ProjectCandidates {
  project: string;
  repo: string;
  branch: string;
  items: { id: string; kind: string; role: string }[];
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
    const items = (db.prepare(`SELECT * FROM "work_items" WHERE "project" = ? AND "status" = 'eligible' ORDER BY "seq"`).all(p.id) as WorkRow[])
      .filter((item) => dispatchBlocker(db, item, args.maxConcurrentRuns) === null)
      .sort((a, b) => (PRIORITY[a.kind] ?? 3) - (PRIORITY[b.kind] ?? 3) || a.seq - b.seq)
      .map((item) => ({ id: item.id, kind: item.kind, role: ROLE_OF[item.kind]! }));
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
