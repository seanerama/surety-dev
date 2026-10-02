// Fixture installation (build spec §8, SEAM.md §§7, 15): test setup the
// engine accepts only in harness mode, labelled as such. Like all code outside
// the migration runner, it writes the store only through transition functions
// (SEAM.md §5): the ones production uses, called with the fixture label.

import { isAbsolute } from 'node:path';

import type { Database } from 'better-sqlite3';

import { Refusal } from '../refusal.js';
import { createProject } from '../store/transitions/project.js';
import type { Baseline } from '../store/transitions/repo.js';
import { allocateReceipt } from '../store/transitions/runs.js';
import { type Actor, transact } from '../store/transitions/tx.js';
import { applyWorkTransition, observeTrigger, registerPlan } from '../store/transitions/work.js';

// The label on every event a fixture causes (SEAM.md §10, §15).
const FIXTURE_LABEL = { test_fixture: true } as const;

const FIXTURE_FIELDS = ['name', 'tier', 'dev_repo_path', 'integration_branch'] as const;

const invalid = (field: string, why: string) => new Refusal(400, 'invalid_value', `"${field}" ${why}.`, 'Correct the fixture request.', { field });

function objectBody(body: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!fields.includes(key)) throw new Refusal(400, 'unknown_field', `"${key}" is not a field of this fixture.`, `Send only ${fields.join(', ')}.`, { field: key });
  }
  return b;
}

const str = (b: Record<string, unknown>, field: string) => {
  const v = b[field];
  if (typeof v !== 'string' || v.length === 0) throw invalid(field, 'must be a non-empty string');
  return v;
};

const positiveInt = (b: Record<string, unknown>, field: string) => {
  const v = b[field];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw invalid(field, 'must be a positive integer');
  return v;
};

export interface ProjectBody {
  name: string;
  tier: string;
  dev_repo_path: string;
  integration_branch: string;
}

export function parseProjectBody(body: unknown): ProjectBody {
  const b = objectBody(body, FIXTURE_FIELDS);
  const name = str(b, 'name');
  const tier = str(b, 'tier');
  if (!['T1', 'T2', 'T3'].includes(tier)) throw invalid('tier', 'must be T1, T2 or T3');
  const repo = str(b, 'dev_repo_path');
  if (!isAbsolute(repo)) throw invalid('dev_repo_path', 'must be an absolute path');
  const branch = str(b, 'integration_branch');
  return { name, tier, dev_repo_path: repo, integration_branch: branch };
}

// POST /v1/harness/fixtures/project: a registered project on an existing
// repository, its integration branch registered at the commit it is at, and
// the developer's checkouts of that branch managed (SEAM.md §25).
export function installFixtureProject(
  db: Database,
  actor: Actor,
  args: { body: ProjectBody; head: string; checkouts: { path: string; baseline: Baseline }[] },
): { project: { id: string } } {
  const id = transact(db, actor, (tx) => createProject(tx, { ...args.body, head: args.head, checkouts: args.checkouts }, FIXTURE_LABEL));
  return { project: { id } };
}

const TRIGGER_FIELDS = ['project', 'kind', 'trigger_source', 'trigger_id', 'trigger_generation', 'subject', 'depends_on'] as const;

// POST /v1/harness/fixtures/trigger: the engine observes a trigger (D1 §8.2)
// through its own transition.
export function installFixtureTrigger(db: Database, actor: Actor, body: unknown): { work_item: { id: string }; created: boolean } {
  const b = objectBody(body, TRIGGER_FIELDS);
  const subject = b.subject ?? {};
  if (typeof subject !== 'object' || subject === null || Array.isArray(subject)) throw invalid('subject', 'must be an object');
  const dependsOn = b.depends_on ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string')) throw invalid('depends_on', 'must be an array of work item ids');
  const input = {
    project: str(b, 'project'),
    kind: b.kind,
    trigger_source: str(b, 'trigger_source'),
    trigger_id: str(b, 'trigger_id'),
    trigger_generation: positiveInt(b, 'trigger_generation'),
    subject: subject as Record<string, unknown>,
    depends_on: dependsOn as string[],
  };
  return transact(db, actor, (tx) => observeTrigger(tx, input, FIXTURE_LABEL));
}

export function parsePlanBody(body: unknown): { project: string; stages: { number: number; goal: string }[] } {
  const b = objectBody(body, ['project', 'stages']);
  const project = str(b, 'project');
  if (!Array.isArray(b.stages) || b.stages.length === 0) throw invalid('stages', 'must be a non-empty array');
  const stages = b.stages.map((s: unknown, i: number) => {
    const st = objectBody(s, ['number', 'goal']);
    if (typeof st.goal !== 'string' || st.goal.length === 0) throw invalid(`stages[${i}].goal`, 'must be a non-empty string');
    return { number: positiveInt(st, 'number'), goal: st.goal };
  });
  return { project, stages };
}

// POST /v1/harness/fixtures/plan: an approved phase plan with its stages and
// their stage_build work, registered by the engine's own plan transition.
export function installFixturePlan(db: Database, actor: Actor, args: { project: string; baseRevision: string; stages: { number: number; goal: string }[] }) {
  return transact(db, actor, (tx) => registerPlan(tx, { ...args, approvedBy: 'test fixture' }, FIXTURE_LABEL));
}

// POST /v1/harness/work/:w/transition: the engine's work-item transition
// function, applied directly.
export function applyFixtureTransition(db: Database, actor: Actor, args: { workItem: string; body: unknown }) {
  const b = objectBody(args.body, ['to']);
  return transact(db, actor, (tx) => applyWorkTransition(tx, { workItem: args.workItem, to: b.to }));
}

// POST /v1/harness/allocate: the scheduler's own receipt allocation.
export function allocateFixtureReceipt(db: Database, actor: Actor, body: unknown): { invocation: string } {
  const b = objectBody(body, ['run']);
  const run = str(b, 'run');
  return { invocation: transact(db, actor, (tx) => allocateReceipt(tx, run)) };
}

export function projectRepo(db: Database, project: string): { repo: string; branch: string } | null {
  const row = db.prepare('SELECT "dev_repo_path", "integration_branch" FROM "projects" WHERE "id" = ?').get(project) as
    | { dev_repo_path: string; integration_branch: string }
    | undefined;
  return row ? { repo: row.dev_repo_path, branch: row.integration_branch } : null;
}
