// The closed configuration (D1 A.8, A.9; build spec §6 correction 20; E18;
// RN R2, R4). Durations are integer seconds unless the unit says otherwise.

export interface NumberSpec {
  default: number;
  min: number;
  max: number;
  integer: boolean;
}

const int = (def: number, min: number, max: number): NumberSpec => ({ default: def, min, max, integer: true });

export const BODY_CAP = 1_048_576;
export const UPLOAD_CAP = 8_388_608;
export const DEFAULT_API_PORT = 7227;

// Numeric engine keys. api_authority, body_cap, upload_cap and
// decision_targets have their own rules (engine-config.ts).
export const ENGINE_NUMBERS: Record<string, NumberSpec> = {
  tick_interval: int(30, 5, 600),
  tick_budget: int(20, 5, 300),
  tick_step_budget: int(5, 1, 60),
  lease_ttl: int(90, 30, 600),
  terminate_grace: int(10, 1, 60),
  kill_grace: int(5, 1, 30),
  api_latency_bound: int(250, 50, 2000), // milliseconds
  request_body_deadline: int(10, 1, 60),
  backup_keep: int(14, 1, 365),
  max_concurrent_runs: int(2, 1, 8),
  api_port: int(DEFAULT_API_PORT, 1024, 65535),
  git_deadline: int(60, 1, 600),
  git_deadline_long: int(600, 60, 3600),
  git_output_cap: int(8_388_608, 65_536, 268_435_456),
};

export const ENGINE_FIXED: Record<string, number> = { body_cap: BODY_CAP, upload_cap: UPLOAD_CAP };

// The order in which keys are validated and reported. api_port precedes
// api_authority because the authority is checked against the port.
export const ENGINE_KEYS = [
  'tick_interval',
  'tick_budget',
  'tick_step_budget',
  'lease_ttl',
  'terminate_grace',
  'kill_grace',
  'api_latency_bound',
  'request_body_deadline',
  'body_cap',
  'upload_cap',
  'backup_keep',
  'max_concurrent_runs',
  'api_port',
  'api_authority',
  'git_deadline',
  'git_deadline_long',
  'git_output_cap',
  'decision_targets',
] as const;

export type EngineKey = (typeof ENGINE_KEYS)[number];

// DecisionKind: D1 A.2 plus the two kinds RN R4 adds.
export const DECISION_KINDS = [
  'idea_accept',
  'spec_approval',
  'spec_change',
  'architecture_approval',
  'plan_approval',
  'check_correction_loosening',
  'check_correction_unclassifiable',
  'finding_disposition',
  'severity_lower',
  'blocker',
  'out_of_band_change',
  'rollout_partial',
  'publication_first_visibility',
  'publication_subsequent',
  'allowlist_widening',
  'go_live',
  'management_opt_in',
  'triage',
  'adoption_mode',
  'requirement_confirm',
  'stop_confirm',
  'abandon_confirm',
  'retire',
  'reactivate',
  'policy_widening',
  'finding_applicability_exclusion',
  'check_correction_tightening',
] as const;

export const DECISION_TARGET_RANGE = { min: 300, max: 2_592_000 };
export const DECISION_KINDS_WITHOUT_TARGET = new Set(['stop_confirm', 'abandon_confirm']);

// Effective default targets of the eleven decision kinds M1 enables (build
// spec §3). null = no target (A.8 "none").
export const DECISION_TARGET_DEFAULTS: Record<string, number | null> = {
  blocker: 14_400,
  out_of_band_change: 14_400,
  stop_confirm: null,
  abandon_confirm: null,
  policy_widening: 172_800,
  finding_disposition: 86_400,
  severity_lower: 86_400,
  finding_applicability_exclusion: 86_400,
  check_correction_tightening: 86_400,
  check_correction_loosening: 86_400,
  check_correction_unclassifiable: 86_400,
};

// Ungoverned project keys, held in .surety/policy.json (RN R2). Project
// concurrency is exactly 1 through M3 (E18).
export const PROJECT_POLICY: Record<string, NumberSpec> = {
  max_concurrent_runs: int(1, 1, 1),
  max_chained_roles: int(1, 1, 6),
  preflight_refusals_max: int(3, 1, 10),
  repair_attempts_max: int(3, 0, 10),
  no_progress_max: int(2, 1, 5),
  deadline_builder: int(2700, 300, 10_800),
  deadline_verifier: int(1800, 300, 10_800),
  deadline_reviewer: int(1200, 300, 10_800),
  deadline_architect: int(1800, 300, 10_800),
  session_idle_timeout: int(1200, 60, 7200),
  record_retention_days: int(90, 7, 3650),
  observation_cadence: int(30, 10, 3600),
  observation_freshness_bound: int(90, 30, 86_400),
  budget_run_billable_tokens: int(1_500_000, 10_000, 50_000_000),
  budget_day_verified_usd: { default: 40, min: 0, max: 10_000, integer: false },
  budget_day_unknown_tokens: int(2_000_000, 0, 100_000_000),
  snapshot_max_files: int(5000, 1, 100_000),
  snapshot_max_bytes: int(104_857_600, 1_048_576, 1_073_741_824),
  snapshot_max_file_bytes: int(10_485_760, 1024, 1_073_741_824),
};

// A JSON number of the right kind inside its range. null, strings and
// booleans are never coerced.
export function numberInSpec(value: unknown, spec: NumberSpec): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (spec.integer && !Number.isInteger(value)) return false;
  return value >= spec.min && value <= spec.max;
}
