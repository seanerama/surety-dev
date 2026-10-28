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
// domain's own tools (connectors, plugins, a browser or the desktop).
//
// The basis (C2c of Codex support; the owner's decision K6 of 2026-10-28):
// the Codex CLI's source at tag rust-v0.160.0, as the driver's source
// reading reports it (surety-evidence/batch-2026-10-28/codex-decisions/
// codex-features-source.md). Each group's basis states what the source
// shows the feature does, with its citation, paths relative to the
// repository's codex-rs/ ("features lib.rs doc N" is the Feature enum's doc
// comment, "spec N" its FEATURES entry). Where that reading established
// nothing, the basis says so: a feature with no reader in the source is in
// the family (fail closed), and the features off at this tag that the
// reading did not trace keep a classification by name, which their basis
// states. No feature's behaviour was observed in a run.
//
// The inventory is observed under the template's own feature
// configuration (C2d of Codex support; the owner's question of 2026-10-28:
// what proves the settings the template requires off are off): the static
// checks run `codex <every --disable of the template> <every -c override
// of the template> features list` (CODEX_FEATURES_ARGS, derived from the
// template's own constants so the two cannot drift), and the attempt
// records that argument list beside the text and its SHA-256 (migration
// 0043). So the list shows each feature's effective state with the
// template's flags applied, and a `--disable` the binary accepts but does
// not honour shows `true`.
//
// Three classes: the family; outside the family; and hardening (outside
// the family, disabled by the template all the same: version 4, K6a).
//
// The judgement:
//   - every feature the template `--disable`s, family or hardening, must
//     read `false` in the observed list; it is then reported in
//     `disabled_by_template` (observed off). One that reads `true` is not
//     honoured, named in `not_honoured`, and fails the attempt before any
//     canary: a family feature as delegation_unverified, a hardening one as
//     unsupported_flag (D2 A.2: a flag the backend does not support; here
//     accepted without effect). One the list does not name is not observed
//     off and fails the same way.
//   - a family feature covered only by a `-c` override (web search's three
//     names, governed by the top-level `web_search` key, not by their
//     feature flags; and the two sub-agent names `agents.enabled=false`
//     covers beside the `--disable`d multi_agent) is not proven off by its
//     row in the list, since the override acts on another key: it is
//     reported in `disabled_by_template` and in `configured_only`, its
//     basis the template's configuration, as before C2d.
//   - any other family feature passes when the list reports it off
//     (`false`; `unavailable`), and one on fails as delegation_unverified,
//     named (`left_enabled`); so does a feature the table does not know (a
//     new feature is reported and fails until the template is extended), a
//     line that is not a feature, an inventory that names nothing or not
//     `multi_agent` (which D2 §4.6 requires the template to disable), and
//     an inventory not run with exactly CODEX_FEATURES_ARGS (none recorded,
//     or others: then it was not observed under the template's flags).
//   - a feature outside the family that the template does not disable is
//     recorded only (`outside_family_enabled` when on).
// `--ignore-user-config` and a volatile CODEX_HOME leave no configuration
// that could switch anything on in a run; the static checks' CODEX_HOME is
// a fresh empty directory (invoke/static.ts).

import { CODEX_CONFIG_OVERRIDES, CODEX_DISABLED_FEATURES } from './templates.js';

// The arguments the static checks run for the inventory (C2d): the
// template's own `--disable`s and `-c` overrides, then `features list`,
// last. The template's `--ignore-user-config` and `--strict-config` are not
// passed: the 0.160.0 binary rejects both in front of `features list`
// (checked 2026-10-28 in an empty CODEX_HOME: `--ignore-user-config` exit 2,
// "unexpected argument '--ignore-user-config' found"; `--strict-config` exit
// 1, "`--strict-config` is not supported for `codex features`"). With every
// `--disable` and `-c` it exits 0 and prints its 154 rows, each `--disable`d
// feature `false` (saved as test/unit/fixtures/codex/
// features-0.160.0-template.txt). The static checks' CODEX_HOME is a fresh
// empty directory, so there is no user configuration to ignore.
export const CODEX_FEATURES_ARGS: readonly string[] = Object.freeze([
  ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
  ...CODEX_CONFIG_OVERRIDES.flatMap((c) => ['-c', c]),
  'features',
  'list',
]);

type Group = { family: boolean; hardening?: true; basis: string; names: readonly string[] };

// Not traced in the source by the 2026-10-28 reading: off (`false`) in the
// 0.160.0 inventory, classified by name, recorded only if ever on.
const BY_NAME = '; by name only: off at this tag and not traced in the source (codex-features-source.md), recorded only if on';

// Every feature `codex features list` names at 0.160.0.
const GROUPS: readonly Group[] = [
  // ---- the family (delegation, scheduling, background, reach beyond the domain) ----
  {
    family: true,
    basis: 'sub-agents (delegation): multi_agent enables the collab tools (features lib.rs doc 205-206, spec 1330-1334), multi_agent_v2 registers the spawn and wait tools (core/src/tools/spec_plan.rs:720-723)',
    names: ['multi_agent', 'multi_agent_v2'],
  },
  {
    family: true,
    basis: 'messaging inside an agent tree (delegation), acting only with multi_agent_v2, which the template switches off: agent_message_board (doc 214-215; core/src/agent_message_board.rs:44-52), defer_mailbox_preemption (doc 209-211; core/src/session/turn.rs:2783-2794)',
    names: ['agent_message_board', 'defer_mailbox_preemption'],
  },
  {
    family: true,
    basis: 'asynchronous messages to the user outside the turn (doc 324-325; core/src/tools/spec_plan.rs:1205-1214): not a sub-agent, kept in the family to fail closed',
    names: ['send_message_to_user_async'],
  },
  {
    family: true,
    basis: 'the guardian, a separate review session of a second model judging approvals (delegation): doc 326-327, 341-342; core/src/guardian/decision.rs:111; core/src/session/step_activation.rs:143',
    names: ['guardian_approval', 'guardianv2'],
  },
  {
    family: true,
    basis: 'scheduling or continuation: goals persists thread goals and continues them automatically (doc 345-346; exec/src/lib.rs:1063); in_app_local_automation runs the desktop\'s local automations (doc 268-271)',
    names: ['goals', 'in_app_local_automation'],
  },
  {
    family: true,
    basis: 'a daemon, host process or background task beyond the one run (background): daemon_auto_start (doc 112-113), code_mode_host (doc 124-125, a standalone host process), code_mode_prewarm (core/src/session/startup_prewarm.rs:233-241), background_paginated_rollout_migration (doc 189-190; core/src/thread_manager.rs:456-480)',
    names: ['daemon_auto_start', 'code_mode_host', 'code_mode_prewarm', 'background_paginated_rollout_migration'],
  },
  {
    family: true,
    basis: 'work in a checkout of its own, persisted outside the workspace: managed worktrees under $CODEX_HOME/worktrees (doc 199-200; worktree/src/settings.rs:44,51; exec/src/lib.rs:301-302)',
    names: ['worktrees'],
  },
  { family: true, basis: 'hooks: commands run on lifecycle events, loaded from hooks.json (doc 107-108)', names: ['hooks'] },
  {
    family: true,
    basis: 'memories carried between runs: startup memory extraction and file-backed consolidation (doc 180-181); import of external agents\' memory (doc 182-183; app-server/src/external_agent_migration/processor.rs:373)',
    names: ['memories', 'external_agent_memory_import'],
  },
  {
    family: true,
    basis: 'apps, plugins, connectors and their installs (reach beyond the domain): apps (doc 220-221; features lib.rs:527-529), codex_apps_mcp_2026_07_28 (doc 228-229; core/src/config/mod.rs:1861-1865), plugins (doc 248-249), plugin_sharing (doc 294-295), remote_plugin (doc 292-293), recommended_plugins (stable, default off; needs apps and plugins, features lib.rs:531-535), skill_mcp_dependency_install (doc 312-313), tool_suggest (doc 244-245; core/src/tools/spec_plan.rs:1253-1267), executor_capability_discovery (plugin and skill manifests by an exec-server RPC, doc 250-251; core/src/session/mcp.rs:447)',
    names: ['apps', 'codex_apps_mcp_2026_07_28', 'plugins', 'plugin_sharing', 'remote_plugin', 'recommended_plugins', 'skill_mcp_dependency_install', 'tool_suggest', 'executor_capability_discovery'],
  },
  {
    family: true,
    basis: 'routing or authorizing requests beyond the model provider: psp adds the routing cookie oai-chat-psp to first-party ChatGPT requests (doc 222-223; core/src/config/mod.rs:1708-1709); use_xaa authorizes configured MCP resources by an enterprise refresh token (doc 232-233; core/src/config/mod.rs:1775,1825)',
    names: ['psp', 'use_xaa'],
  },
  {
    family: true,
    basis:
      'web search, a hosted tool the provider runs behind api.openai.com (core/src/tools/hosted_spec.rs:32-33), which the egress allow-list cannot stop. Its mode is the top-level `web_search` key (core/src/config/mod.rs:2683-2694): `--disable web_search_cached` and `--disable web_search_request` do not switch it off (legacy flags, read only where the key is unset), so the control is the template\'s `-c web_search="disabled"` (with `-c tools.web_search=false`), which covers these; standalone_web_search is the extension-backed tool (doc 163-164; core/src/tools/spec_plan.rs:1489-1491)',
    names: ['standalone_web_search', 'web_search_cached', 'web_search_request'],
  },
  {
    family: true,
    basis: 'a browser, the computer or the desktop app\'s updates (reach beyond the domain): requirements-only desktop gates, not reached by exec (features lib.rs doc 256-259, 272-291)',
    names: ['browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'in_app_updates'],
  },
  {
    family: true,
    basis: 'removed at this tag, a no-op: nothing reads it, or apply_map drops it (features lib.rs:596-632); what it was is delegation, remote control, hooks or apps (multi_agent_mode doc 216-217, enable_fanout doc 218-219, send_async_message doc 322-323, remote_control doc 427-428, guardian_ext doc 343-344, plugin_hooks doc 254-255, apps_mcp_path_override doc 234-235), so it stays in the family and fails closed if a later version revives it',
    names: ['multi_agent_mode', 'enable_fanout', 'send_async_message', 'remote_control', 'guardian_ext', 'plugin_hooks', 'apps_mcp_path_override'],
  },
  {
    family: true,
    basis: 'no reader in codex-rs at this tag; behaviour unestablished; fail closed (workspace_dependencies: doc 385-386 and the config schema only; artifact: the config schema only, config/src/schema.rs:50; chronicle: a legacy alias only, features/src/legacy.rs:44-46; enable_mcp_apps: doc 224-225 only)',
    names: ['workspace_dependencies', 'artifact', 'chronicle', 'enable_mcp_apps'],
  },

  // ---- hardening: not the family, disabled by the template (version 4, K6a) ----
  { family: false, hardening: true, basis: 'hardening, not the family: keeps a turn alive forever on a connection failure (core/src/responses_retry.rs:22-23, 92-116), so a refused egress would hang to the deadline', names: ['unbounded_connection_retries'] },
  { family: false, hardening: true, basis: 'hardening, not the family: retries bootstrap requests through HTTPS_PROXY, HTTP_PROXY or ALL_PROXY (backend-client/src/client.rs:343-360)', names: ['system_proxy_fallback'] },
  { family: false, hardening: true, basis: 'hardening, not the family: calls images/generations through the provider and writes PNGs under CODEX_HOME (codex-api/src/endpoint/images.rs:68,81); not exposed under an API key', names: ['image_generation'] },
  { family: false, hardening: true, basis: 'hardening, not the family: the command tool\'s PTY mode, whose children get no parent-death signal (utils/pty/src/spawn_helper_main.rs:69-73)', names: ['unified_exec_tty'] },
  { family: false, hardening: true, basis: 'hardening, not the family: clock.sleep blocks the current turn for 1 ms to 12 h and schedules nothing (core/src/tools/handlers/sleep.rs:28, 96-133)', names: ['sleep_tool'] },
  { family: false, hardening: true, basis: 'hardening, not the family: writes the shell\'s exported environment, so the key, under $CODEX_HOME/shell_snapshots/ (shell-command/src/shell_snapshot_capture.rs:160-178; core/src/shell_snapshot.rs:105-107)', names: ['shell_snapshot'] },

  // ---- outside the family, read from the source ----
  {
    family: false,
    basis:
      'the command tool, not delegation: it cannot be disabled (core/src/config/managed_features.rs:157-165); a command can outlive its tool call and the turn and is ended at session shutdown (core/src/session/handlers.rs:307-310); what it runs is in the domain and ends with it (D2 §4.4: each turn a cgroup domain terminated with closure)',
    names: ['unified_exec'],
  },
  {
    family: false,
    basis: 'the model turn\'s own mechanics, run inside the domain or sent to the model API only: shell_tool (doc 101-102; core/src/tools/spec_plan.rs:1079-1117), view_image (doc 103-104; spec_plan.rs:1283-1295), write_stdin_approval (doc 154-155; core/src/unified_exec/stdin_approval.rs:180-194), fast_mode (sends a service tier only when one is configured, and none is: core/src/session/mod.rs:1081-1097), compaction_image_budget (doc 379-380; core/src/compact_remote_v2.rs:316), content_item_kinds (doc 116-117; core/src/session/session.rs:1740), enable_request_compression (doc 193-194; session.rs:1742), skill_search (shadow-mode metrics, reaching the network only through the analytics exporter the template switches off: ext/skills/src/extension.rs:421-438)',
    names: ['shell_tool', 'view_image', 'write_stdin_approval', 'fast_mode', 'compaction_image_budget', 'content_item_kinds', 'enable_request_compression', 'skill_search'],
  },
  {
    family: false,
    basis: 'startup ordering, not scheduling: turns may start while executors start, with a wait_for_environment tool (doc 174-175; core/src/tools/spec_plan.rs:1157-1167; core/src/session/session.rs:1441)',
    names: ['deferred_executor'],
  },
  {
    family: false,
    basis: 'inert here: it acts only with MCP servers, the guardian or the zsh-fork shell, none of which runs (no MCP server configured, approvals bypassed, the guardian off): auth_elicitation (core/src/config/mod.rs:1866-1872; core/src/mcp_tool_call.rs:767-785), tool_call_mcp_elicitation (doc 359-360; mcp_tool_call.rs:1620-1629), guardian_reuse_parent_compaction (doc 330-332; core/src/guardian/review_session_context.rs:27), unified_exec_zsh_fork (removed, read at tools/src/tool_config.rs:51 only with shell_zsh_fork, which is off: spec 1002-1006)',
    names: ['auth_elicitation', 'tool_call_mcp_elicitation', 'guardian_reuse_parent_compaction', 'unified_exec_zsh_fork'],
  },
  {
    family: false,
    basis: 'the TUI or the desktop app only, no reader in exec: in_app_chat (doc 260-263), in_app_dictation (doc 264-267), mentions_v2 (doc 318-319), realtime_conversation (doc 373-374; tui/src/chatwidget/realtime.rs:291)',
    names: ['in_app_chat', 'in_app_dictation', 'mentions_v2', 'realtime_conversation'],
  },
  {
    family: false,
    basis: 'removed (or, transcript_v2, deprecated) at this tag, a no-op: nothing reads it, or apply_map drops it (features lib.rs:596-632, 653-656); sqlite\'s database opens regardless (exec/src/lib.rs:697)',
    names: [
      'sqlite', 'steer', 'collaboration_modes', 'item_ids', 'resize_all_images', 'terminal_resize_reflow', 'tui_app_server', 'tool_search_always_defer_mcp_tools',
      'js_repl', 'js_repl_tools_only', 'remote_compaction_v2', 'apply_patch_freeform', 'tool_search', 'image_detail_original', 'personality', 'undo', 'skill_env_var_dependency_prompt', 'transcript_v2',
    ],
  },
  { family: false, basis: 'Windows only: prefers the native Windows sandbox (doc 409-410; core/src/config/mod.rs:3515)', names: ['prefer_mxc'] },

  // ---- outside the family, by name only ----
  {
    family: false,
    basis: `the command tool's variants and approvals: what they run stays in the domain and ends with it (D2 §4.4)${BY_NAME}`,
    names: ['shell_snapshot_v2', 'shell_zsh_fork', 'powershell_shell_version', 'exec_permission_approvals', 'request_permissions_tool', 'request_rule', 'code_mode', 'code_mode_buffered_exec', 'code_mode_interrupt', 'code_mode_only'],
  },
  { family: false, basis: `file edits in the workspace${BY_NAME}`, names: ['apply_patch_preserve_line_endings', 'apply_patch_streaming_events', 'cwd_relative_turn_diffs', 'codex_git_commit'] },
  {
    family: false,
    basis: `the model's turn, its context and its transcript${BY_NAME}`,
    names: [
      'api_key_model_discovery', 'concurrent_reasoning_summaries', 'context_management', 'current_time_reminder', 'deferred_tool_world_state', 'executed_tool_call_metadata', 'image_resize_notice',
      'reasoning_effort_override', 'remote_models', 'retain_client_developer_messages', 'rollout_budget', 'step_model_switching', 'token_budget', 'unified_image_budget', 'responses_websockets',
      'responses_websockets_v2', 'local_thread_store_compression', 'local_thread_store_shared_compression', 'omit_app_server_notification_media', 'unavailable_dummy_tools',
      'default_mode_request_user_input', 'instant_interrupt', 'search_tool',
    ],
  },
  {
    family: false,
    basis: `details of the guardian, which guardian_approval switches${BY_NAME}`,
    names: ['guardian_conversation_history_tools', 'guardian_enhanced_node_repl_transcripts', 'guardian_node_repl_transcript_images', 'guardian_root_handoff_context', 'guardianv2.thread_context'],
  },
  { family: false, basis: `MCP mechanics: the template configures no MCP server (--ignore-user-config, a volatile CODEX_HOME)${BY_NAME}`, names: ['mcp_2026_07_28', 'mcp_oauth_refresh_coordination', 'non_prefixed_mcp_tool_names'] },
  { family: false, basis: `local skills${BY_NAME}`, names: ['skip_host_skill_discovery'] },
  {
    family: false,
    basis: `Codex's own sandbox and the platform (Codex's sandbox is bypassed; D2 §4.6, Q5)${BY_NAME}`,
    names: ['elevated_windows_sandbox', 'experimental_windows_sandbox', 'windows_sandbox_service', 'use_legacy_landlock', 'use_linux_sandbox_bwrap', 'prevent_idle_sleep', 'nonfatal_clock_read_errors'],
  },
  { family: false, basis: `network, proxy and authentication handling${BY_NAME}`, names: ['network_proxy', 'respect_system_proxy', 'secret_auth_storage', 'use_agent_identity', 'bedrock_setup_wizard', 'external_migration'] },
  {
    family: false,
    basis: `the interactive app and terminal, and telemetry (the template turns analytics and the exporters off)${BY_NAME}`,
    names: ['terminal_visualization_instructions', 'workspace_owner_usage_nudge', 'runtime_metrics', 'analytics_plan_history'],
  },
];

export const CODEX_FEATURE_CLASSES: ReadonlyMap<string, { family: boolean; hardening: boolean; basis: string }> = new Map(
  GROUPS.flatMap((g) => g.names.map((n) => [n, { family: g.family, hardening: g.hardening === true, basis: g.basis }] as const)),
);

// The features a `-c` override the template passes also switches off. Web
// search is governed by the top-level `web_search` key, not by its two
// legacy `--disable` flags (core/src/config/mod.rs:2683-2694; the web
// search group's basis above), so `web_search="disabled"` is what covers
// them; `agents.enabled=false` covers the sub-agent features.
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
  // The arguments the inventory was run with, as the attempt recorded them
  // (C2d); null where none were recorded.
  args: string[] | null;
  features: number;
  // The features the template disables: each `--disable`d one observed
  // `false` in the inventory run under the template's flags, and the family
  // features a `-c` override alone covers (`configured_only`).
  disabled_by_template: string[];
  // Of those, the ones the list cannot show (web search's names, governed
  // by the top-level key): their basis is the template's configuration.
  configured_only: string[];
  // Features the template `--disable`s that the observed list reports on,
  // or does not name: the flag was not honoured. Each fails the attempt.
  not_honoured: string[];
  // The family's features the inventory reports off.
  unavailable: string[];
  // The family's features on and not disabled: each fails the attempt.
  left_enabled: string[];
  // Features the table does not know: each fails the attempt.
  unknown: CodexFeature[];
  // Features outside the family the inventory reports on and the template
  // does not disable, a hardening feature among them (recorded only).
  outside_family_enabled: string[];
  unparsed: string[];
  reasons: string[];
  // The class the attempt fails with when not verified: unsupported_flag
  // when the only failures are hardening features not honoured, otherwise
  // delegation_unverified; null when verified.
  failure_class: 'delegation_unverified' | 'unsupported_flag' | null;
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

// The attempt's inventory judged against the template (null: none
// recorded). `flags` are the template's `--disable`s, each required off in
// the observed list; `disables` adds what its `-c` overrides cover.
export function judgeCodexFeatures(
  inventory: { text: string; sha256: string; args?: readonly string[] | null } | null,
  disables: ReadonlySet<string> = codexTemplateDisables(),
  flags: readonly string[] = CODEX_DISABLED_FEATURES,
  expectedArgs: readonly string[] = CODEX_FEATURES_ARGS,
): CodexFeatureJudgement {
  const out: CodexFeatureJudgement = {
    verified: false,
    sha256: inventory?.sha256 ?? null,
    args: inventory?.args == null ? null : [...inventory.args],
    features: 0,
    disabled_by_template: [],
    configured_only: [],
    not_honoured: [],
    unavailable: [],
    left_enabled: [],
    unknown: [],
    outside_family_enabled: [],
    unparsed: [],
    reasons: [],
    failure_class: 'delegation_unverified',
  };
  if (inventory === null) {
    out.reasons.push('the attempt recorded no `codex features list` inventory');
    return out;
  }
  // Reasons that are a delegation failure; a hardening flag not honoured is
  // counted apart.
  let hardeningOnly = 0;
  if (out.args === null) out.reasons.push("the attempt recorded no arguments for its inventory, so it is not known to have run under the template's flags");
  else if (out.args.length !== expectedArgs.length || out.args.some((a, i) => a !== expectedArgs[i])) out.reasons.push(`the inventory was run with other arguments than the template's flags (\`${out.args.join(' ').slice(0, 300)}\`), so it was not observed under them`);
  const { features, unparsed } = parseCodexFeatures(inventory.text);
  out.features = features.length;
  out.unparsed = unparsed.slice(0, 32);
  const flagged = new Set(flags);
  for (const f of features) {
    const c = CODEX_FEATURE_CLASSES.get(f.name);
    if (c === undefined) out.unknown.push(f);
    else if (flagged.has(f.name)) {
      // A `--disable`d feature, family or hardening: observed off, or not
      // honoured.
      if (f.enabled) out.not_honoured.push(f.name);
      else out.disabled_by_template.push(f.name);
    } else if (!c.family) {
      if (f.enabled) out.outside_family_enabled.push(f.name);
    } else if (disables.has(f.name)) {
      // Covered by a `-c` override only: configured, not observable here.
      out.disabled_by_template.push(f.name);
      out.configured_only.push(f.name);
    } else if (!f.enabled) out.unavailable.push(f.name);
    else out.left_enabled.push(f.name);
  }
  const named = new Set(features.map((f) => f.name));
  if (features.length === 0) out.reasons.push('the inventory names no feature');
  else if (!named.has('multi_agent')) out.reasons.push('the inventory does not name multi_agent, which D2 §4.6 requires the template to disable');
  if (unparsed.length > 0) out.reasons.push(`${unparsed.length} line(s) of the inventory are not a feature, its stage and its state: ${unparsed.slice(0, 3).map((l) => JSON.stringify(l)).join(', ')}`);
  for (const n of out.not_honoured) {
    out.reasons.push(`${n} is disabled by the template (--disable ${n}) but the inventory run under the template's flags reports it on: the flag was not honoured`);
    if (CODEX_FEATURE_CLASSES.get(n)?.hardening === true) hardeningOnly++;
  }
  // A `--disable`d name the list does not name is not observed off (the
  // 0.160.0 binary refuses an unknown name, so this is a changed binary).
  if (features.length > 0) {
    for (const n of flags) {
      if (named.has(n)) continue;
      out.not_honoured.push(n);
      out.reasons.push(`${n} is disabled by the template (--disable ${n}) but the inventory run under the template's flags does not name it: it is not observed off`);
      if (CODEX_FEATURE_CLASSES.get(n)?.hardening === true) hardeningOnly++;
    }
  }
  for (const n of out.left_enabled) out.reasons.push(`${n} is on in the inventory (${CODEX_FEATURE_CLASSES.get(n)!.basis}) and the template does not disable it`);
  for (const f of out.unknown) out.reasons.push(`${f.name} (${f.stage}, ${f.enabled ? 'on' : 'off'}) is a feature this engine does not know: it is not shown disabled or unavailable`);
  out.verified = out.reasons.length === 0;
  out.failure_class = out.verified ? null : hardeningOnly === out.reasons.length ? 'unsupported_flag' : 'delegation_unverified';
  return out;
}
