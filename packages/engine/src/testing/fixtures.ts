// Fixture installation (build spec §8, SEAM.md §7): test setup the engine
// accepts only in harness mode, labelled as such. Like all code outside the
// migration runner, it writes the store only through a transition function
// (SEAM.md §5).

import { isAbsolute } from 'node:path';

import type { Database } from 'better-sqlite3';

import { Refusal } from '../refusal.js';
import { createProject } from '../store/transitions/project.js';
import { type Actor, transact } from '../store/transitions/tx.js';

// The label on the project.created event of a fixture project (SEAM.md §10).
const FIXTURE_LABEL = { test_fixture: true } as const;

const FIXTURE_FIELDS = ['name', 'tier', 'dev_repo_path', 'integration_branch'] as const;

// POST /v1/harness/fixtures/project: a registered project on an existing
// repository.
export function installFixtureProject(db: Database, actor: Actor, body: unknown): { project: { id: string } } {
  const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!(FIXTURE_FIELDS as readonly string[]).includes(key)) {
      throw new Refusal(400, 'unknown_field', `"${key}" is not a fixture project field.`, `Send only ${FIXTURE_FIELDS.join(', ')}.`, { field: key });
    }
  }
  const invalid = (field: string, why: string) => new Refusal(400, 'invalid_value', `"${field}" ${why}.`, 'Correct the fixture request.', { field });
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

  const id = transact(db, actor, (tx) => createProject(tx, { name, tier, dev_repo_path: repo, integration_branch: branch }, FIXTURE_LABEL));
  return { project: { id } };
}
