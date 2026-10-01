// Project transitions: creation, pause and resume (D1 §8.4, §11.4), and the
// project policy command, whose valid changes commit through the journaled
// git path that slice 3 builds.

import { validatePolicySubmission } from '../../config/project-policy.js';
import { newId } from '../../ids.js';
import { Refusal } from '../../refusal.js';
import type { Tx } from './tx.js';

export interface ProjectRow {
  id: string;
  paused: number;
}

export function projectNotFound(project: string): Refusal {
  return new Refusal(404, 'not_found', `No project "${project}" is registered with this engine.`, 'Check the project id.', { project });
}

export function getProject(tx: Tx, project: string): ProjectRow {
  const row = tx.db.prepare('SELECT "id", "paused" FROM "projects" WHERE "id" = ?').get(project) as ProjectRow | undefined;
  if (!row) throw projectNotFound(project);
  return row;
}

export interface NewProject {
  name: string;
  tier: string;
  dev_repo_path: string;
  integration_branch: string;
}

// A registered project on an existing repository. `label` is added to the
// payload of its project.created event; the fixture installer labels the
// projects it creates as test setup (SEAM.md §7). Returns the project id.
export function createProject(tx: Tx, project: NewProject, label: Record<string, unknown>): string {
  const id = newId('proj_');
  const management = { mode: 'live', health: 'unknown', triage_policy: 'manual' };
  tx.db
    .prepare(
      `INSERT INTO "projects" ("id", "created_at", "name", "tier", "dev_repo_path", "integration_branch",
         "baseline_state", "registration_state", "management", "paused", "seq_counters")
       VALUES (?, ?, ?, ?, ?, ?, 'idea', 'registered', ?, 0, '{}')`,
    )
    .run(id, tx.at, project.name, project.tier, project.dev_repo_path, project.integration_branch, JSON.stringify(management));
  tx.emit('project.created', { project: id }, { ...label, ...project });
  return id;
}

// Pause sets the flag the scheduler's select step skips on; resume clears it.
// Asking for the state the project is already in changes nothing and emits
// nothing.
export function setPaused(tx: Tx, args: { project: string; paused: boolean }) {
  const row = getProject(tx, args.project);
  const want = args.paused ? 1 : 0;
  if (row.paused !== want) {
    tx.db.prepare('UPDATE "projects" SET "paused" = ? WHERE "id" = ?').run(want, args.project);
    tx.emit(args.paused ? 'project.paused' : 'project.resumed', { project: args.project }, {});
  }
  return { project: { id: args.project, paused: args.paused }, events: tx.events.map(({ seq, type }) => ({ seq, type })) };
}

export function submitPolicy(tx: Tx, args: { project: string; body: unknown }): never {
  getProject(tx, args.project);
  validatePolicySubmission(args.body);
  throw new Refusal(
    501,
    'unsupported',
    'A valid project policy change commits through the journaled git path, which this engine revision does not have yet.',
    'Nothing was changed. Policy changes become available when the git journal is built.',
    { project: args.project },
  );
}
