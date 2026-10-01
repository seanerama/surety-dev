// Project transitions: the harness fixture installer, pause and resume (D1
// §8.4, §11.4), and the project policy command, whose valid changes commit
// through the journaled git path that slice 3 builds.

import { isAbsolute } from 'node:path';

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

const FIXTURE_FIELDS = ['name', 'tier', 'dev_repo_path', 'integration_branch'] as const;

// Harness only (SEAM.md §7): a registered project on an existing repository,
// labelled as test setup on its project.created event.
export function installFixtureProject(tx: Tx, body: unknown): { project: { id: string } } {
  const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!(FIXTURE_FIELDS as readonly string[]).includes(key)) {
      throw new Refusal(400, 'unknown_field', `"${key}" is not a fixture project field.`, `Send only ${FIXTURE_FIELDS.join(', ')}.`, { field: key });
    }
  }
  const invalid = (field: string, why: string) =>
    new Refusal(400, 'invalid_value', `"${field}" ${why}.`, 'Correct the fixture request.', { field });
  const str = (field: string) => {
    const v = b[field];
    if (typeof v !== 'string' || v.length === 0) throw invalid(field, 'must be a non-empty string');
    return v;
  };
  const name = str('name');
  const tier = str('tier');
  if (!['T1', 'T2', 'T3'].includes(tier)) throw invalid('tier', 'must be T1, T2 or T3');
  const repo = str('dev_repo_path');
  if (!isAbsolute(repo)) throw invalid('dev_repo_path', 'must be an absolute path');
  const branch = str('integration_branch');

  const id = newId('proj_');
  const management = { mode: 'live', health: 'unknown', triage_policy: 'manual' };
  tx.db
    .prepare(
      `INSERT INTO "projects" ("id", "created_at", "name", "tier", "dev_repo_path", "integration_branch",
         "baseline_state", "registration_state", "management", "paused", "seq_counters")
       VALUES (?, ?, ?, ?, ?, ?, 'idea', 'registered', ?, 0, '{}')`,
    )
    .run(id, tx.at, name, tier, repo, branch, JSON.stringify(management));
  tx.emit('project.created', { project: id }, { test_fixture: true, name, tier, dev_repo_path: repo, integration_branch: branch });
  return { project: { id } };
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
