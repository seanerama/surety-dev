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

// Numeric engine keys. api_authority, body_cap, upload_cap, decision_targets
// and the boolean keys have their own rules (engine-config.ts).
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
  // D2 A.7, bytes in bytes (SEAM.md §115).
  max_concurrent_domains: int(2, 1, 8),
  host_reserve_memory: int(2_147_483_648, 536_870_912, 68_719_476_736),
  host_reserve_disk: int(5_368_709_120, 1_073_741_824, 1_099_511_627_776),
  domain_memory_max: int(8_589_934_592, 536_870_912, 68_719_476_736),
  domain_tasks_max: int(1024, 64, 16_384),
  domain_writable_bytes: int(4_294_967_296, 67_108_864, 34_359_738_368),
  domain_writable_inodes: int(200_000, 1000, 2_000_000),
  result_max_bytes: int(1_048_576, 65_536, 16_777_216),
  provider_files_max_bytes: int(67_108_864, 1_048_576, 1_073_741_824),
  collect_entries_max: int(10_000, 100, 1_000_000),
  collect_deadline: int(60, 5, 600),
  stream_line_max_bytes: int(1_048_576, 65_536, 16_777_216),
  stream_queue_max_bytes: int(8_388_608, 1_048_576, 67_108_864),
  egress_resolve_timeout: int(5, 1, 30),
  egress_connect_timeout: int(10, 1, 60),
  egress_tunnel_max_seconds: int(1800, 60, 10_800),
  egress_tunnels_max: int(16, 1, 128),
  egress_buffer_max_bytes: int(1_048_576, 65_536, 16_777_216),
  egress_log_max_bytes: int(4_194_304, 262_144, 67_108_864),
  pause_challenge_timeout: int(5, 1, 30),
};

export const ENGINE_FIXED: Record<string, number> = { body_cap: BODY_CAP, upload_cap: UPLOAD_CAP };

// Boolean engine keys and their defaults (D2 A.7).
export const ENGINE_BOOLEANS: Record<string, boolean> = { ui_bootstrap: false };

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
  // D2 §2.6, K3: the token bootstrap route answers only when this is true.
  'ui_bootstrap',
  // D2 A.7.
  'max_concurrent_domains',
  'host_reserve_memory',
  'host_reserve_disk',
  'domain_memory_max',
  'domain_tasks_max',
  'domain_writable_bytes',
  'domain_writable_inodes',
  'result_max_bytes',
  'provider_files_max_bytes',
  'collect_entries_max',
  'collect_deadline',
  'stream_line_max_bytes',
  'stream_queue_max_bytes',
  'egress_resolve_timeout',
  'egress_connect_timeout',
  'egress_tunnel_max_seconds',
  'egress_tunnels_max',
  'egress_buffer_max_bytes',
  'egress_log_max_bytes',
  'pause_challenge_timeout',
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
  // D2 A.2, A.7.
  'qualification_approval',
  'trust_activation',
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
  // D2 A.7: default target 2 d.
  qualification_approval: 172_800,
  trust_activation: 172_800,
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

// The finer a budget boundary, the earlier in this list (D2 A.2
// BudgetBoundary; §4.2): a model turn is finer than a user turn, which is
// finer than the whole invocation.
export const BUDGET_BOUNDARIES = ['model_turn', 'user_turn', 'invocation'] as const;
export type BudgetBoundary = (typeof BUDGET_BOUNDARIES)[number];

export const TRUST_MODES = ['one_shot_headless', 'session_headless'] as const;

// The backends a role may be dispatched to: the scripted one (harness mode
// only) and those the engine has an adapter for (D2 §4.5, §4.6).
export const BACKEND_NAMES = ['scripted', 'claude', 'codex'] as const;

// Ungoverned project keys that are not numbers (D2 A.7). `widening` says when
// a change of the key widens what the engine may do unasked: `added` when it
// adds an element the effective value lacks, `coarser` when it names a
// coarser budget boundary, `never` when no change does.
export interface OptionSpec {
  type: 'enum' | 'boolean' | 'host_names' | 'absolute_paths';
  default: unknown;
  values?: readonly string[];
  widening: 'added' | 'coarser' | 'never';
}

export const PROJECT_OPTIONS: Record<string, OptionSpec> = {
  // What policy requires the engine to stop at (D2 §4.2, K6).
  budget_run_boundary: { type: 'enum', values: BUDGET_BOUNDARIES, default: 'invocation', widening: 'coarser' },
  // A declared hard spending maximum: refused, no M2 mechanism enforces one
  // (D2 §4.2; E58 item 6). Only false is accepted.
  budget_hard_maximum: { type: 'boolean', default: false, widening: 'never' },
  // Widenings (D2 §§2.3, 2.4).
  egress_allow_extra: { type: 'host_names', default: [], widening: 'added' },
  sandbox_read_paths: { type: 'absolute_paths', default: [], widening: 'added' },
  // The backend each role is dispatched to, among the active trust entries,
  // and the mode (D2 §4.1; SEAM.md §115). `scripted` exists only in harness
  // mode.
  backend_builder: { type: 'enum', values: BACKEND_NAMES, default: 'scripted', widening: 'never' },
  backend_verifier: { type: 'enum', values: BACKEND_NAMES, default: 'scripted', widening: 'never' },
  backend_reviewer: { type: 'enum', values: BACKEND_NAMES, default: 'scripted', widening: 'never' },
  backend_architect: { type: 'enum', values: BACKEND_NAMES, default: 'scripted', widening: 'never' },
  backend_mode: { type: 'enum', values: TRUST_MODES, default: 'one_shot_headless', widening: 'never' },
};

// A JSON number of the right kind inside its range. null, strings and
// booleans are never coerced.
export function numberInSpec(value: unknown, spec: NumberSpec): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (spec.integer && !Number.isInteger(value)) return false;
  return value >= spec.min && value <= spec.max;
}
