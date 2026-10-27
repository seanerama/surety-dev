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
  api_port: int(DEFAULT_API_PORT, 1024, 65535),
  git_deadline: int(60, 1, 600),
  git_deadline_long: int(600, 60, 3600),
  git_output_cap: int(8_388_608, 65_536, 268_435_456),
  // D2 A.7, bytes in bytes (SEAM.md §115).
  // D6 K2 (E140 N2): 4, was 2; the engine run count is removed (K2).
  max_concurrent_domains: int(4, 1, 8),
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
  // D3 A.7, the check runner (SEAM.md §186).
  check_timeout_max: int(1800, 10, 10_800),
  check_output_max_bytes: int(1_048_576, 65_536, 16_777_216),
  checktree_max_bytes: int(2_147_483_648, 67_108_864, 34_359_738_368),
  checktree_max_entries: int(200_000, 1000, 2_000_000),
  checktrees_max_bytes: int(8_589_934_592, 67_108_864, 137_438_953_472),
  check_infra_retries_max: int(2, 0, 5),
  // D4 A.7, with BS4 §11.3's values (E121 item 3; SEAM.md §252).
  adapter_effect_deadline: int(120, 10, 900),
  adapter_read_deadline: int(10, 1, 120),
  adapter_output_max_bytes: int(1_048_576, 65_536, 16_777_216),
  artifact_max_entries: int(20_000, 100, 200_000),
  artifact_max_bytes: int(268_435_456, 1_048_576, 2_147_483_648),
  artifacts_max_bytes: int(2_147_483_648, 1_048_576, 68_719_476_736),
  artifact_prepare_deadline: int(600, 10, 3600),
  service_link_connect_timeout: int(10, 1, 60),
  service_link_tunnel_max_seconds: int(1800, 60, 10_800),
  service_link_tunnels_max: int(16, 1, 128),
  service_link_buffer_max_bytes: int(1_048_576, 65_536, 16_777_216),
  // D6 A.7 (E140 N4; SEAM.md §377): the size threshold of `adoption_mode`'s
  // recommendation, never the choice.
  adoption_full_max_files: int(2000, 100, 100_000),
  // D6 A.7 (M5 slice 33; objection 077): an owner's turn, at most.
  turn_max_bytes: int(65_536, 4096, 1_048_576),
};

// A numeric engine key that may not be below another's effective value
// (SEAM.md §186: `at_least`).
export const ENGINE_AT_LEAST: Record<string, string> = { checktrees_max_bytes: 'checktree_max_bytes', artifacts_max_bytes: 'artifact_max_bytes' };

export const ENGINE_FIXED: Record<string, number> = { body_cap: BODY_CAP, upload_cap: UPLOAD_CAP };

// Boolean engine keys and their defaults (D2 A.7).
// `isolation_probe_exhaustion` (E69): the host is designated for the
// exhaustion probe P20, which forks to `pids.max`, allocates to `memory.max`
// and fills the volatile filesystem's bounds; off by default, and P20 is then
// `not_exercised`, excused.
export const ENGINE_BOOLEANS: Record<string, boolean> = { ui_bootstrap: false, isolation_probe_exhaustion: false };

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
  // D3 A.7.
  'check_timeout_max',
  'check_output_max_bytes',
  'checktree_max_bytes',
  'checktree_max_entries',
  'checktrees_max_bytes',
  'check_infra_retries_max',
  // D3 A.7, §3.3 (Q5; SEAM.md §217): {mode, version?}.
  'classifier_authority',
  // E69: the host is designated for the exhaustion probe P20.
  'isolation_probe_exhaustion',
  // D4 A.7 (SEAM.md §252).
  'adapter_effect_deadline',
  'adapter_read_deadline',
  'adapter_output_max_bytes',
  'artifact_max_entries',
  'artifact_max_bytes',
  'artifacts_max_bytes',
  'artifact_prepare_deadline',
  'service_link_connect_timeout',
  'service_link_tunnel_max_seconds',
  'service_link_tunnels_max',
  'service_link_buffer_max_bytes',
  // D6 A.7 (M5 slice 32).
  'adoption_full_max_files',
  // D6 A.7 (M5 slice 33).
  'turn_max_bytes',
  // The workspace assistant's usage account and provider (the assistant
  // design of 2026-10-27, Sean's approval of O2(a)): an object, absent by
  // default, every field required when present and none defaulted
  // (engine-config.ts).
  'workspace_assistant',
] as const;

// The `workspace_assistant` block's fields (the assistant design §1.2). Every
// one is required when the block is present; none has a default. The ranges
// are sanity bounds on a value the owner states, never a value the engine
// supplies.
export const ASSISTANT_FIELDS = ['backend', 'model', 'credential_ref', 'day_limit_billable_tokens', 'turn_limit_billable_tokens', 'turn_deadline_seconds'] as const;
export const ASSISTANT_NUMBERS: Readonly<Record<'day_limit_billable_tokens' | 'turn_limit_billable_tokens' | 'turn_deadline_seconds', { min: number; max: number }>> = {
  day_limit_billable_tokens: { min: 1_000, max: 100_000_000 },
  turn_limit_billable_tokens: { min: 1_000, max: 10_000_000 },
  turn_deadline_seconds: { min: 10, max: 3600 },
};
// The owner's recommended explicit configuration (his approval of
// 2026-10-27: "Use Sonnet, 40k tokens per turn and 400k per day as explicit
// initial configuration, not hidden defaults"; the design's 120-second turn
// deadline; O3: the project roles' subscription-token reference). Documented
// in the contract only: the engine never applies it. They are allowances,
// not expected consumption.
export const ASSISTANT_RECOMMENDED = {
  backend: 'claude',
  model: 'sonnet',
  credential_ref: 'backend/claude/subscription_token',
  day_limit_billable_tokens: 400_000,
  turn_limit_billable_tokens: 40_000,
  turn_deadline_seconds: 120,
} as const;

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
  // D7 A.2 (M6): the design's decisions.
  'design_approval',
  'design_due',
  'design_verdicts',
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
  // D4 §4.4 (M4 slice 26): as a blocker's, for the deploy it holds.
  rollout_partial: 14_400,
  // D6 §3.4 (M5 slice 31): the products' approvals, the owner's to answer.
  idea_accept: 172_800,
  spec_approval: 172_800,
  architecture_approval: 172_800,
  plan_approval: 172_800,
  // D6 A.8 (D1 A.8): the specification change, 3 d.
  spec_change: 259_200,
  // D1 A.8 (M5 slice 32; SEAM.md §§377, 379): the adoption's mode and the
  // retrofit confirmations, 2 d each.
  adoption_mode: 172_800,
  requirement_confirm: 172_800,
  // D7 §11, G5 (M6): the design's decisions, 2 d each.
  design_approval: 172_800,
  design_due: 172_800,
  design_verdicts: 172_800,
};

// Ungoverned project keys, held in .surety/policy.json (RN R2). The project
// run count of E18 is removed by D6 K2 (M5 slice 37): no run count caps
// admission at either scope.
export const PROJECT_POLICY: Record<string, NumberSpec> = {
  // D6 K2, A.7 (E140 N1; B09): the per-profile memory maxima, each at most
  // the engine's `domain_memory_max` (checked against the ceiling at the
  // policy route; the effective value is min(this, the ceiling)).
  role_memory_max: int(4_294_967_296, 536_870_912, 68_719_476_736),
  check_memory_max: int(2_147_483_648, 536_870_912, 68_719_476_736),
  // D6 K3 (N02): a bound on inherited chain depth under the autonomy profile,
  // not a budget; default 24 under `phase`.
  max_chained_roles: int(24, 1, 64),
  preflight_refusals_max: int(3, 1, 10),
  repair_attempts_max: int(3, 0, 10),
  no_progress_max: int(2, 1, 5),
  deadline_builder: int(2700, 300, 10_800),
  deadline_verifier: int(1800, 300, 10_800),
  deadline_reviewer: int(1200, 300, 10_800),
  deadline_architect: int(1800, 300, 10_800),
  session_idle_timeout: int(1200, 60, 7200),
  // D6 A.7 (M5 slice 33; objection 077): a session's transcript, at most,
  // and the per-turn deadlines of the two conversational roles without one.
  transcript_max_bytes: int(8_388_608, 1_048_576, 67_108_864),
  deadline_vision: int(1800, 300, 10_800),
  deadline_spec_writer: int(1800, 300, 10_800),
  record_retention_days: int(90, 7, 3650),
  observation_cadence: int(30, 10, 3600),
  observation_freshness_bound: int(90, 30, 86_400),
  budget_run_billable_tokens: int(1_500_000, 10_000, 50_000_000),
  budget_day_verified_usd: { default: 40, min: 0, max: 10_000, integer: false },
  budget_day_unknown_tokens: int(2_000_000, 0, 100_000_000),
  snapshot_max_files: int(5000, 1, 100_000),
  snapshot_max_bytes: int(104_857_600, 1_048_576, 1_073_741_824),
  snapshot_max_file_bytes: int(10_485_760, 1024, 1_073_741_824),
  // D3 A.7: check executions running at once; not a widening.
  max_concurrent_checks: int(1, 1, 8),
  // D4 A.7 (BS4 §11.3; Q6, Q9; SEAM.md §252).
  deploy_orchestration_deadline: int(1800, 300, 10_800),
  deploy_auto_retries_max: int(1, 0, 3),
  identity_observation_every: int(10, 1, 100),
  service_memory_max: int(536_870_912, 67_108_864, 8_589_934_592),
  service_tasks_max: int(128, 16, 4096),
  service_writable_bytes: int(67_108_864, 1_048_576, 1_073_741_824),
  service_writable_inodes: int(4096, 256, 65_536),
  service_log_max_bytes: int(1_048_576, 65_536, 16_777_216),
  // D7 A.7 (M6; E156 Q4: trial values): the Designer's turn deadline and
  // session budget, the design tree's bounds, the preview's memory, its time
  // to live, design_due's longest deferral and the review evidence's bound.
  deadline_designer: int(1800, 300, 10_800),
  designer_session_budget_billable_tokens: int(3_000_000, 250_000, 20_000_000),
  design_tree_max_bytes: int(33_554_432, 1_048_576, 134_217_728),
  design_tree_max_files: int(800, 50, 8000),
  preview_memory_max: int(268_435_456, 67_108_864, 68_719_476_736),
  design_preview_ttl: int(86_400, 3600, 1_209_600),
  design_due_max_defer: int(604_800, 3600, 2_592_000),
  design_review_evidence_max_bytes: int(67_108_864, 1_048_576, 2_147_483_648),
  // D7 A.7's "512 MiB per review" (SEAM.md §522 †): every file of one
  // owner-invoked review together.
  design_review_evidence_max_review_bytes: int(536_870_912, 1_048_576, 17_179_869_184),
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
// The real providers: outside the test mode the only choices a
// `backend_<role>` key offers, and none of them is a default (the owner's
// production-defaults ruling of 2026-10-27): a role's backend is
// unconfigured until a provider is named for it, and the engine never
// substitutes one.
export const REAL_BACKEND_NAMES = ['claude', 'codex'] as const;
// The role each `backend_<role>` key selects the backend of.
export const BACKEND_ROLE_KEYS: Readonly<Record<string, string>> = {
  builder: 'backend_builder',
  verifier: 'backend_verifier',
  reviewer: 'backend_reviewer',
  architect: 'backend_architect',
  vision: 'backend_vision',
  spec_writer: 'backend_spec_writer',
  designer: 'backend_designer',
};

// D6 A.2: the autonomy profile (K3) and the Alpha deploy policy (K9).
export const AUTONOMY_PROFILES = ['step', 'stage', 'phase'] as const;
export type Autonomy = (typeof AUTONOMY_PROFILES)[number];
export const ALPHA_DEPLOY_POLICIES = ['manual', 'on_phase_complete'] as const;
// D7 §2, A.2 DesignPolicy; §5.2 DesignPreviewPolicy (`stack` refused in M6, E156 Q4).
export const DESIGN_POLICIES = ['off', 'before_build', 'at_alpha', 'both'] as const;
export type DesignPolicy = (typeof DESIGN_POLICIES)[number];
export const DESIGN_PREVIEW_POLICIES = ['off', 'static'] as const;
export type AlphaDeployPolicy = (typeof ALPHA_DEPLOY_POLICIES)[number];

// Ungoverned project keys that are not numbers (D2 A.7). `widening` says when
// a change of the key widens what the engine may do unasked: `added` when it
// adds an element the effective value lacks, `coarser` when it names a
// coarser budget boundary, `never` when no change does.
export interface OptionSpec {
  type: 'enum' | 'boolean' | 'host_names' | 'absolute_paths' | 'model' | 'size_range' | 'int_list' | 'subset';
  // `int_list` (D7 A.7 `design_widths`): 1 to `count.max` distinct integers
  // within `range`; `subset` (`design_orientations`): a non-empty subset of
  // `values`, no repeats.
  count?: { min: number; max: number };
  // `size_range` (D6 §5.2, A.7 `phase_size`): `{min, max}`, each an integer
  // within [range.min, range.max], min not above max.
  range?: { min: number; max: number };
  // null: the key has no default and is unconfigured until set (the
  // `backend_<role>` keys outside the test mode).
  default: unknown;
  values?: readonly string[];
  widening: 'added' | 'coarser' | 'later' | 'never';
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
  // mode: these are the production specs, a real provider each and no
  // default (`default: null`: unconfigured, absent from the effective
  // policy); project-policy.ts's projectOptionSpecs() offers `scripted`, as
  // the default, only in the test mode.
  backend_builder: { type: 'enum', values: REAL_BACKEND_NAMES, default: null, widening: 'never' },
  backend_verifier: { type: 'enum', values: REAL_BACKEND_NAMES, default: null, widening: 'never' },
  backend_reviewer: { type: 'enum', values: REAL_BACKEND_NAMES, default: null, widening: 'never' },
  backend_architect: { type: 'enum', values: REAL_BACKEND_NAMES, default: null, widening: 'never' },
  // D6 A.7 (M5 slice 33; SEAM.md §391): the two conversational roles' backends.
  backend_vision: { type: 'enum', values: REAL_BACKEND_NAMES, default: null, widening: 'never' },
  backend_spec_writer: { type: 'enum', values: REAL_BACKEND_NAMES, default: null, widening: 'never' },
  // D6 A.7, E139 Q6: the model each role requests, Claude Code's aliases;
  // Opus for the planners, Sonnet for the roles. Any non-empty model name is
  // accepted until slice 38 (the driver's ruling (c), 2026-10-13).
  model_vision: { type: 'model', default: 'opus', widening: 'never' },
  model_spec_writer: { type: 'model', default: 'opus', widening: 'never' },
  model_architect: { type: 'model', default: 'opus', widening: 'never' },
  model_builder: { type: 'model', default: 'sonnet', widening: 'never' },
  model_verifier: { type: 'model', default: 'sonnet', widening: 'never' },
  model_reviewer: { type: 'model', default: 'sonnet', widening: 'never' },
  // D6 §6.5, K3 (E139 Q3): where the chaining boundary falls; `phase` by default.
  // Sean's decision (2026-10-12): loosening on an existing project (a value
  // later in the list: step → stage → phase) widens what the engine does
  // unasked, and is confirmed by the owner; tightening is free.
  autonomy: { type: 'enum', values: AUTONOMY_PROFILES, default: 'phase', widening: 'later' },
  // D6 §6.8, K9 (E139 Q5): whether the engine requests Alpha at phase completion.
  // Sean's decision (2026-10-12): manual → on_phase_complete widens.
  alpha_deploy: { type: 'enum', values: ALPHA_DEPLOY_POLICIES, default: 'manual', widening: 'later' },
  // D6 §5.2, A.7 (F §3.10.1, §9.2): how many stages a phase plan has. A plan
  // outside it is `uncertain` and goes to the human, never refused outright.
  phase_size: { type: 'size_range', default: { min: 3, max: 5 }, range: { min: 1, max: 12 }, widening: 'never' },
  backend_mode: { type: 'enum', values: TRUST_MODES, default: 'one_shot_headless', widening: 'never' },
  // D7 §2, A.7 (M6): when design happens, target-blind; turning it on is a
  // tightening for undispatched UI stages, so no change of it widens.
  design: { type: 'enum', values: DESIGN_POLICIES, default: 'off', widening: 'never' },
  // D7 §5.2, A.7; E156 Q4: `stack` refused in M6.
  design_preview: { type: 'enum', values: DESIGN_PREVIEW_POLICIES, default: 'static', widening: 'never' },
  design_widths: { type: 'int_list', default: [360, 720, 1280], range: { min: 240, max: 3840 }, count: { min: 1, max: 6 }, widening: 'never' },
  design_orientations: { type: 'subset', values: ['portrait', 'landscape'], default: ['portrait', 'landscape'], widening: 'never' },
  design_external_urls: { type: 'host_names', default: ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'], widening: 'added' },
  // D7 §6.7; Q8: never `alpha`.
  assets_required_for: { type: 'enum', values: ['none', 'beta', 'live'], default: 'live', widening: 'never' },
  backend_designer: { type: 'enum', values: REAL_BACKEND_NAMES, default: null, widening: 'never' },
  model_designer: { type: 'model', default: 'opus', widening: 'never' },
};

// A JSON number of the right kind inside its range. null, strings and
// booleans are never coerced.
export function numberInSpec(value: unknown, spec: NumberSpec): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (spec.integer && !Number.isInteger(value)) return false;
  return value >= spec.min && value <= spec.max;
}
