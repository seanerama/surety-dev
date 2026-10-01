// Read-only queries. Reads never write and never call out of the store.

import type { Database } from 'better-sqlite3';

import { projectPolicyDefaults } from '../config/project-policy.js';
import { projectNotFound } from './transitions/project.js';

// The project's effective ungoverned policy. No policy revision can exist yet
// (valid changes need the journaled git path), so the effective values are
// the schema defaults and the revision is null.
export function projectPolicy(db: Database, project: string) {
  const row = db.prepare('SELECT "id" FROM "projects" WHERE "id" = ?').get(project);
  if (!row) throw projectNotFound(project);
  return { effective: projectPolicyDefaults(), revision: null };
}
