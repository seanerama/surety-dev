// The engine settings the transition functions use (lease TTL, decision
// targets), handed to the store worker when it opens the store. They are the
// values read once at startup (E22 item 1); the project settings are each
// project's effective policy.

import type { Database } from 'better-sqlite3';

import type { AuthoritySetting } from '../../checks/classify.js';

import { type Policy, effectiveOf, projectPolicyDefaults } from '../../config/project-policy.js';

export interface EngineSettings {
  lease_ttl: number;
  git_deadline: number;
  decision_targets: Record<string, number | null>;
  // D2 §2.6: the bootstrap exception is in force.
  ui_bootstrap?: boolean;
  // D3 A.7's engine keys (checks/limits.ts).
  checks?: Record<string, number>;
  // D3 A.7, §3.3: the configured `classifier_authority` (SEAM.md §217).
  classifier_authority?: AuthoritySetting;
  // The running incarnation, set when the store is opened.
  incarnation?: string;
  // D6 A.7 (M5 slice 33).
  turn_max_bytes?: number;
  domain_memory_max?: number;
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

// Every ungoverned key of a project's effective policy, the typed options of
// D2 A.7 among them, over the schema defaults.
export function projectEffective(db: Database, project: string): Policy {
  const row = db
    .prepare('SELECT r."effective" FROM "projects" p JOIN "policy_revisions" r ON r."id" = p."policy_revision" WHERE p."id" = ?')
    .get(project) as { effective: string } | undefined;
  return effectiveOf(row ? (JSON.parse(row.effective) as Record<string, unknown>) : null);
}

export interface ProjectOptions {
  budget_run_boundary: string;
  budget_hard_maximum: boolean;
  egress_allow_extra: string[];
  sandbox_read_paths: string[];
  backend_builder: string;
  backend_verifier: string;
  backend_reviewer: string;
  backend_architect: string;
  autonomy: 'step' | 'stage' | 'phase';
  alpha_deploy: 'manual' | 'on_phase_complete';
  // D6 §5.2, A.7: the stage count a phase plan is expected to have.
  phase_size: { min: number; max: number };
  backend_mode: string;
}

export function projectOptions(db: Database, project: string): ProjectOptions {
  return projectEffective(db, project) as unknown as ProjectOptions;
}

// The revision number of the project's recorded policy, or null.
export function policyRevision(db: Database, project: string): number | null {
  const row = db.prepare('SELECT r."revision" FROM "projects" p JOIN "policy_revisions" r ON r."id" = p."policy_revision" WHERE p."id" = ?').get(project) as
    | { revision: number }
    | undefined;
  return row?.revision ?? null;
}

// The model a role requests (D6 A.7, E139 Q6): its `model_<role>` key, or
// null for a role without one.
export function roleModel(db: Database, project: string, role: string): string | null {
  const v = (projectEffective(db, project) as Record<string, unknown>)[`model_${role}`];
  return typeof v === 'string' && v !== '' ? v : null;
}
