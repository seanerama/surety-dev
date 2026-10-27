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
  // D6 K2, B09 (M5 slice 37): the engine's volatile and task bounds, part of
  // a role profile's qualification identity; the harness's profile maxima
  // for this start (`--harness-profile-maxima`, SEAM.md §427).
  domain_writable_bytes?: number;
  domain_writable_inodes?: number;
  domain_tasks_max?: number;
  profile_maxima?: { role?: number; check?: number } | null;
  // The workspace assistant's block (config.json `workspace_assistant`; the
  // assistant design §1.2), null when absent.
  workspace_assistant?: import('../../config/engine-config.js').AssistantConfig | null;
}

let settings: EngineSettings | null = null;

export function setEngineSettings(value: EngineSettings): void {
  settings = value;
}

export function engineSettings(): EngineSettings {
  if (!settings) throw new Error('engine settings were not handed to the store');
  return settings;
}

// D6 K2, A.7 (the driver's ruling Q1, slice 37): the memory maximum a
// project's `role` or `check` domain is admitted at: min(the project's value
// or its default, the engine's `domain_memory_max`); the harness's profile
// maxima, where given, stand for it at this start.
export function effectiveProfileMax(db: Database, project: string, profile: 'role' | 'check'): number {
  const s = settings;
  const override = s?.profile_maxima?.[profile];
  if (override !== undefined) return override;
  const value = projectPolicy(db, project)[`${profile}_memory_max`]!;
  const ceiling = s?.domain_memory_max;
  return ceiling === undefined ? value : Math.min(value, ceiling);
}

// A design preview's effective memory maximum (D7 A.7): the project's
// `preview_memory_max` under the engine's `domain_memory_max`, as a profile's
// maximum is (E158 item 4).
export function effectivePreviewMax(db: Database, project: string): number {
  const value = projectPolicy(db, project).preview_memory_max!;
  const ceiling = settings?.domain_memory_max;
  return ceiling === undefined ? value : Math.min(value, ceiling);
}

// The engine's effective default maximum of a profile, for no project: the
// schema default under the ceiling (a qualification attempt's, the runner's).
export function defaultProfileMax(profile: 'role' | 'check'): number {
  const s = settings;
  const override = s?.profile_maxima?.[profile];
  if (override !== undefined) return override;
  const value = projectPolicyDefaults()[`${profile}_memory_max`]!;
  const ceiling = s?.domain_memory_max;
  return ceiling === undefined ? value : Math.min(value, ceiling);
}

// The role maximum a qualification attempt qualifies (D6-X09; SEAM.md
// §432): the profile it recorded, else the engine's default.
export function attemptProfileMax(db: Database, attempt: string): number {
  const row = db.prepare('SELECT "profile" FROM "qualification_attempts" WHERE "id" = ?').get(attempt) as { profile: string | null } | undefined;
  try {
    const p = row?.profile ? (JSON.parse(row.profile) as { memory_max?: unknown }) : null;
    // Under the ceiling, as every profile is (the slice-37 review's N4).
    const ceiling = settings?.domain_memory_max;
    if (p && Number.isSafeInteger(p.memory_max) && (p.memory_max as number) > 0) return ceiling === undefined ? (p.memory_max as number) : Math.min(p.memory_max as number, ceiling);
  } catch {
    // an unreadable profile is the default's
  }
  return defaultProfileMax('role');
}

// The role profile a dispatch is qualified for (D6 §2.6, B09): its memory
// maximum and the engine's volatile and task bounds.
export interface RoleProfile {
  memory_max: number;
  writable_bytes: number | null;
  writable_inodes: number | null;
  tasks_max: number | null;
}
export function roleProfileOf(memoryMax: number): RoleProfile {
  const s = settings;
  return { memory_max: memoryMax, writable_bytes: s?.domain_writable_bytes ?? null, writable_inodes: s?.domain_writable_inodes ?? null, tasks_max: s?.domain_tasks_max ?? null };
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
  // Absent where unconfigured: outside the test mode no backend is a default.
  backend_builder?: string;
  backend_verifier?: string;
  backend_reviewer?: string;
  backend_architect?: string;
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
