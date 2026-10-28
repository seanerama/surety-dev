// The Codex attempt's feature inventory (D2 §4.6, row D2-T13; C2b of Codex
// support, 2026-10-28): `codex features list`, run by the attempt's static
// checks with the same constructed environment as `--version` and `--help`
// (invoke/static.ts), recorded on the attempt (its text and SHA-256), and
// judged here against the template. Each line of that list is a feature's
// name, its stage and its effective state (`true` or `false`), as 0.160.0
// prints it in an empty CODEX_HOME:
//
//   multi_agent                              stable             true
//   memories                                 stable             false
//
// Every feature the list names is classified below, by the 0.160.0 list
// saved on 2026-10-28. The family D2 §4.6 names, "delegation, scheduling or
// background", is read as the template's own list read it (sub-agents,
// goals, hooks, apps, memories, web search): a feature that delegates work
// to another agent or model, schedules or continues work, runs or keeps a
// process or service beyond the backend's one run, or reaches beyond the
// domain's own tools (connectors, plugins, a browser or the desktop). A
// feature whose name does not establish what it does is put in the family
// (fail closed). The classification is by name, against the list and the
// configuration reference; no feature's behaviour was observed.
//
// The judgement: a feature of the family passes when the template disables
// it (`--disable <feature>`, or a `-c` override the template passes that
// covers it) or the inventory reports it off (`false`: the template enables
// nothing, and `--ignore-user-config` and a volatile CODEX_HOME leave no
// configuration that could). One the template leaves on fails the attempt
// as delegation_unverified, named; so does a feature the table does not
// know (a new feature is reported and fails until the template is extended),
// a line that is not a feature, and an inventory that names nothing or not
// `multi_agent` (which D2 §4.6 requires the template to disable). Features
// outside the family are recorded only.

import { CODEX_CONFIG_OVERRIDES, CODEX_DISABLED_FEATURES } from './templates.js';

// The arguments the static checks run for the inventory.
export const CODEX_FEATURES_ARGS: readonly string[] = ['features', 'list'];

type Group = { family: boolean; basis: string; names: readonly string[] };

// Every feature `codex features list` names at 0.160.0.
const GROUPS: readonly Group[] = [
  { family: true, basis: 'sub-agents and their messaging (delegation)', names: ['agent_message_board', 'multi_agent', 'multi_agent_mode', 'multi_agent_v2', 'enable_fanout', 'send_async_message', 'send_message_to_user_async', 'defer_mailbox_preemption'] },
  { family: true, basis: 'goals and automations (scheduling or continuation)', names: ['goals', 'in_app_local_automation'] },
  {
    family: true,
    basis: 'a daemon, executor, companion process or background task beyond the one run (background)',
    names: ['daemon_auto_start', 'background_paginated_rollout_migration', 'deferred_executor', 'executor_capability_discovery', 'code_mode_host', 'code_mode_prewarm', 'remote_control', 'in_app_updates', 'chronicle'],
  },
  { family: true, basis: 'work in a checkout of its own (delegation)', names: ['worktrees'] },
  { family: true, basis: 'the guardian, a second model reviewing approvals (delegation)', names: ['guardian_approval', 'guardianv2', 'guardian_ext'] },
  { family: true, basis: 'hooks (commands run on events)', names: ['hooks', 'plugin_hooks'] },
  { family: true, basis: 'memories (carried between runs)', names: ['memories', 'external_agent_memory_import'] },
  {
    family: true,
    basis: 'apps, plugins and connectors (reach beyond the domain)',
    names: ['apps', 'apps_mcp_path_override', 'enable_mcp_apps', 'codex_apps_mcp_2026_07_28', 'plugins', 'plugin_sharing', 'remote_plugin', 'recommended_plugins', 'skill_mcp_dependency_install', 'tool_suggest'],
  },
  { family: true, basis: 'web search (fetches outside the egress proxy)', names: ['standalone_web_search', 'web_search_cached', 'web_search_request'] },
  { family: true, basis: 'a browser or the desktop (reach beyond the domain)', names: ['browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'in_app_browser'] },
  { family: true, basis: 'what it does is not established from its name (fail closed)', names: ['workspace_dependencies', 'psp', 'prefer_mxc', 'use_xaa', 'artifact'] },
  {
    family: false,
    basis: "the command tool and the shell: what it runs stays in the domain and ends with it (D2 §4.4)",
    names: ['unified_exec', 'unified_exec_tty', 'unified_exec_zsh_fork', 'shell_tool', 'shell_snapshot', 'shell_snapshot_v2', 'shell_zsh_fork', 'powershell_shell_version', 'sleep_tool', 'write_stdin_approval', 'exec_permission_approvals', 'request_permissions_tool', 'request_rule', 'code_mode', 'code_mode_buffered_exec', 'code_mode_interrupt', 'code_mode_only', 'js_repl', 'js_repl_tools_only'],
  },
  { family: false, basis: 'file edits in the workspace', names: ['apply_patch_freeform', 'apply_patch_preserve_line_endings', 'apply_patch_streaming_events', 'cwd_relative_turn_diffs', 'undo', 'codex_git_commit'] },
  {
    family: false,
    basis: "the model's turn, its context and its transcript",
    names: [
      'api_key_model_discovery', 'compaction_image_budget', 'concurrent_reasoning_summaries', 'content_item_kinds', 'context_management', 'current_time_reminder', 'deferred_tool_world_state',
      'executed_tool_call_metadata', 'fast_mode', 'image_detail_original', 'image_generation', 'image_resize_notice', 'item_ids', 'mentions_v2', 'personality', 'reasoning_effort_override',
      'remote_compaction_v2', 'remote_models', 'resize_all_images', 'retain_client_developer_messages', 'rollout_budget', 'step_model_switching', 'token_budget', 'transcript_v2', 'unified_image_budget',
      'view_image', 'enable_request_compression', 'responses_websockets', 'responses_websockets_v2', 'local_thread_store_compression', 'local_thread_store_shared_compression', 'sqlite',
      'omit_app_server_notification_media', 'unavailable_dummy_tools', 'default_mode_request_user_input', 'collaboration_modes', 'steer', 'instant_interrupt', 'search_tool', 'tool_search',
      'tool_search_always_defer_mcp_tools',
    ],
  },
  {
    family: false,
    basis: "details of the guardian, which guardian_approval switches",
    names: ['guardian_conversation_history_tools', 'guardian_enhanced_node_repl_transcripts', 'guardian_node_repl_transcript_images', 'guardian_reuse_parent_compaction', 'guardian_root_handoff_context', 'guardianv2.thread_context'],
  },
  { family: false, basis: 'MCP mechanics: the template configures no MCP server (--ignore-user-config, a volatile CODEX_HOME)', names: ['mcp_2026_07_28', 'mcp_oauth_refresh_coordination', 'non_prefixed_mcp_tool_names', 'tool_call_mcp_elicitation', 'auth_elicitation'] },
  { family: false, basis: 'local skills', names: ['skill_search', 'skip_host_skill_discovery', 'skill_env_var_dependency_prompt'] },
  { family: false, basis: "Codex's own sandbox and the platform (Codex's sandbox is bypassed; D2 §4.6, Q5)", names: ['elevated_windows_sandbox', 'experimental_windows_sandbox', 'windows_sandbox_service', 'use_legacy_landlock', 'use_linux_sandbox_bwrap', 'prevent_idle_sleep', 'nonfatal_clock_read_errors'] },
  { family: false, basis: 'network, proxy and authentication handling', names: ['network_proxy', 'respect_system_proxy', 'system_proxy_fallback', 'unbounded_connection_retries', 'secret_auth_storage', 'use_agent_identity', 'bedrock_setup_wizard', 'external_migration'] },
  { family: false, basis: 'the interactive app and terminal, and telemetry (the template turns analytics and the exporters off)', names: ['in_app_chat', 'in_app_dictation', 'realtime_conversation', 'terminal_resize_reflow', 'terminal_visualization_instructions', 'tui_app_server', 'workspace_owner_usage_nudge', 'runtime_metrics', 'analytics_plan_history'] },
];

export const CODEX_FEATURE_CLASSES: ReadonlyMap<string, { family: boolean; basis: string }> = new Map(GROUPS.flatMap((g) => g.names.map((n) => [n, { family: g.family, basis: g.basis }] as const)));

// The features a `-c` override the template passes also switches off.
const OVERRIDE_COVERS: Readonly<Record<string, readonly string[]>> = {
  'agents.enabled=false': ['multi_agent', 'multi_agent_v2', 'multi_agent_mode'],
  'web_search="disabled"': ['standalone_web_search', 'web_search_cached', 'web_search_request'],
};

// What the template switches off of the features: its `--disable`s and what
// its overrides cover.
export function codexTemplateDisables(disabled: readonly string[] = CODEX_DISABLED_FEATURES, overrides: readonly string[] = CODEX_CONFIG_OVERRIDES): Set<string> {
  return new Set([...disabled, ...overrides.flatMap((o) => OVERRIDE_COVERS[o] ?? [])]);
}

export interface CodexFeature {
  name: string;
  stage: string;
  enabled: boolean;
}

export interface CodexFeatureJudgement {
  verified: boolean;
  sha256: string | null;
  features: number;
  // The family's features the template disables (configured, not observed).
  disabled_by_template: string[];
  // The family's features the inventory reports off.
  unavailable: string[];
  // The family's features on and not disabled: each fails the attempt.
  left_enabled: string[];
  // Features the table does not know: each fails the attempt.
  unknown: CodexFeature[];
  // Features outside the family the inventory reports on (recorded only).
  outside_family_enabled: string[];
  unparsed: string[];
  reasons: string[];
}

const LINE = /^(\S+)\s+(\S.*?)\s+(true|false)$/;

export function parseCodexFeatures(text: string): { features: CodexFeature[]; unparsed: string[] } {
  const features: CodexFeature[] = [];
  const unparsed: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const m = LINE.exec(line);
    if (m === null) unparsed.push(line.slice(0, 200));
    else features.push({ name: m[1]!, stage: m[2]!.trim(), enabled: m[3] === 'true' });
  }
  return { features, unparsed };
}

// The attempt's inventory judged against the template (null: none recorded).
export function judgeCodexFeatures(inventory: { text: string; sha256: string } | null, disables: ReadonlySet<string> = codexTemplateDisables()): CodexFeatureJudgement {
  const out: CodexFeatureJudgement = { verified: false, sha256: inventory?.sha256 ?? null, features: 0, disabled_by_template: [], unavailable: [], left_enabled: [], unknown: [], outside_family_enabled: [], unparsed: [], reasons: [] };
  if (inventory === null) {
    out.reasons.push('the attempt recorded no `codex features list` inventory');
    return out;
  }
  const { features, unparsed } = parseCodexFeatures(inventory.text);
  out.features = features.length;
  out.unparsed = unparsed.slice(0, 32);
  for (const f of features) {
    const c = CODEX_FEATURE_CLASSES.get(f.name);
    if (c === undefined) out.unknown.push(f);
    else if (!c.family) {
      if (f.enabled) out.outside_family_enabled.push(f.name);
    } else if (disables.has(f.name)) out.disabled_by_template.push(f.name);
    else if (!f.enabled) out.unavailable.push(f.name);
    else out.left_enabled.push(f.name);
  }
  if (features.length === 0) out.reasons.push('the inventory names no feature');
  else if (!features.some((f) => f.name === 'multi_agent')) out.reasons.push('the inventory does not name multi_agent, which D2 §4.6 requires the template to disable');
  if (unparsed.length > 0) out.reasons.push(`${unparsed.length} line(s) of the inventory are not a feature, its stage and its state: ${unparsed.slice(0, 3).map((l) => JSON.stringify(l)).join(', ')}`);
  for (const n of out.left_enabled) out.reasons.push(`${n} is on in the inventory (${CODEX_FEATURE_CLASSES.get(n)!.basis}) and the template does not disable it`);
  for (const f of out.unknown) out.reasons.push(`${f.name} (${f.stage}, ${f.enabled ? 'on' : 'off'}) is a feature this engine does not know: it is not shown disabled or unavailable`);
  out.verified = out.reasons.length === 0;
  return out;
}
