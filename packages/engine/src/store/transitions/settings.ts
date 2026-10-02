// The engine settings the transition functions use (lease TTL, decision
// targets), handed to the store worker when it opens the store. They are the
// values read once at startup (E22 item 1); the project settings are each
// project's effective policy.

import type { Database } from 'better-sqlite3';

import { projectPolicyDefaults } from '../../config/project-policy.js';

export interface EngineSettings {
  lease_ttl: number;
  git_deadline: number;
  decision_targets: Record<string, number | null>;
}

let settings: EngineSettings | null = null;

export function setEngineSettings(value: EngineSettings): void {
  settings = value;
}

export function engineSettings(): EngineSettings {
  if (!settings) throw new Error('engine settings were not handed to the store');
  return settings;
}

// A project's effective ungoverned policy (E23 item 3; SEAM.md §27): the
// policy revision the engine has recorded, over the schema defaults; with no
// revision recorded, the defaults. A file in the repository the engine never
// recorded is never effective.
export function projectPolicy(db: Database, project: string): Record<string, number> {
  const row = db
    .prepare('SELECT r."effective" FROM "projects" p JOIN "policy_revisions" r ON r."id" = p."policy_revision" WHERE p."id" = ?')
    .get(project) as { effective: string } | undefined;
  const defaults = projectPolicyDefaults();
  if (!row) return defaults;
  const recorded = JSON.parse(row.effective) as Record<string, number>;
  const out: Record<string, number> = { ...defaults };
  for (const key of Object.keys(defaults)) if (typeof recorded[key] === 'number') out[key] = recorded[key]!;
  return out;
}

// The revision number of the project's recorded policy, or null.
export function policyRevision(db: Database, project: string): number | null {
  const row = db.prepare('SELECT r."revision" FROM "projects" p JOIN "policy_revisions" r ON r."id" = p."policy_revision" WHERE p."id" = ?').get(project) as
    | { revision: number }
    | undefined;
  return row?.revision ?? null;
}
