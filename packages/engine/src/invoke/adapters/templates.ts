// The adapters' fixed invocation templates (D2 §§1.2, 4.5, 4.6; build spec
// §5 "Templates"; E74 item 1): the text a trust entry records, and the
// argument array and fixed environment it renders to. Every argument is
// engine-authored fixed text or a path inside the sandbox; task content never
// reaches one (D1 §17 item 3). A change here is a template version change,
// which revokes entries (D2 §7.3). Rendering starts nothing: the choke point
// spawns.
//
// One template per backend and authentication mode (E74 item 1, Sean): for
// Claude Code, `api_key` (D2 §4.5's, under `--bare`) and `subscription_token`
// (without `--bare`, which never reads an OAuth token). An attempt and an
// entry record the mode, and a dispatch uses the template and the secret of
// its entry's mode, never the other's.

import { createHash } from 'node:crypto';

import { CODEX_MODEL_CATALOG_PATH, CODEX_MODEL_CATALOG_SHA256, CODEX_MODEL_CATALOG_TEXT } from './codex-catalog.js';

export type AuthMode = 'api_key' | 'subscription_token';
export const AUTH_MODES: readonly AuthMode[] = ['api_key', 'subscription_token'];

export interface Template {
  version: string;
  text: string;
  authMode: AuthMode;
  // The secret reference the credential is resolved by (D2 §2.5; SEAM.md
  // §116), '' for a backend that takes none.
  keyRef: string;
  // The environment variable the credential is delivered in.
  keyVariable: string;
  // Further variables the same credential is delivered in, where which one
  // the backend reads is not established; the canary records which was
  // used. No template has one now (Codex's codex-exec-4, -5 and -6 deliver its
  // key in CODEX_API_KEY alone, K3 of 2026-10-28).
  keyAliases?: readonly string[];
  // The fixed variables the template sets beside the credential.
  env: Readonly<Record<string, string>>;
  // The flags by which the backend is asked to keep nothing between runs
  // (D2 §4.3); what it writes despite them is recorded by the canaries.
  persistenceFlags: string[];
  // The names `--tools` gives the backend: the inventory a qualified entry
  // may show, and no other (E74 item 3; the slice-14 review's S2).
  tools: readonly string[];
  // The provider session id the engine assigns before launch (D2 §1.7),
  // when the template passes one; recorded on the receipt.
  sessionIdOf?: (invocation: string) => string;
  // What the engine writes on the backend's standard input, when the
  // template fixes it (Codex: the fixed prompt); otherwise the scripted
  // protocol's request line, which a real backend's template does not read.
  stdin?: string;
  // Files the role domain must carry for the backend (C2g): each at its
  // path under /surety/context (read-only to the agent), with this exact
  // content, written by the domain's preparation beside the context
  // package (sandbox/prepare.ts, writeTemplateFiles). Part of the
  // template: its text names each file's SHA-256, so a changed file is a
  // new template version. The Claude templates name none.
  files?: readonly TemplateFile[];
  render(args: { model: string; invocation: string }): string[];
}

export interface TemplateFile {
  path: string;
  content: string;
}

// The fixed prompt (D2 §1.2): it points at the context package and never
// begins with "-".
export const PROMPT = 'Read /surety/context/prompt.md and do what it asks. Write your result to /surety/out/result.json.';

// The tools a role is given (D2 §4.5, `--tools`): the built-in ones; the
// delegation and scheduling tools are denied by name.
export const CLAUDE_ROLE_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'] as const;
const ROLE_TOOLS = CLAUDE_ROLE_TOOLS.join(',');

// Claude Code's documented switches against updating itself and against
// nonessential traffic (telemetry, error reporting, update checks), set in
// the backend's environment for canaries and project runs alike (E74 item
// 3; code.claude.com/docs env-vars: DISABLE_AUTOUPDATER, DISABLE_UPDATES,
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).
export const CLAUDE_QUIET_ENV: Readonly<Record<string, string>> = Object.freeze({ DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });

// Claude Code's `--session-id`, derived from the invocation id (D2 §1.7): a
// UUID in RFC 4122 form, the same for the same invocation.
export function sessionId(invocation: string): string {
  const h = createHash('sha256').update(`surety-session:${invocation}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const envText = (keyVariable: string, env: Readonly<Record<string, string>>) => `(environment: ${keyVariable}=<credential> ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')})`;

const claudeTail = (model: string, invocation: string) => [
  '--output-format',
  'stream-json',
  '--verbose',
  '--model',
  model,
  '--tools',
  ROLE_TOOLS,
  '--disallowed-tools',
  'Agent',
  'Task',
  'ScheduleWakeup',
  'Workflow',
  '--permission-mode',
  'bypassPermissions',
  '--no-session-persistence',
  '--session-id',
  sessionId(invocation),
  PROMPT,
];
const CLAUDE_TAIL_TEXT = '--output-format stream-json --verbose --model <m> --tools <role tools> --disallowed-tools Agent Task ScheduleWakeup Workflow --permission-mode bypassPermissions --no-session-persistence --session-id <uuid> <prompt>';

// D2 §4.5, Claude Code, by API key: `--bare` takes Anthropic authentication
// strictly from ANTHROPIC_API_KEY or an apiKeyHelper (`claude --help`).
const CLAUDE_API_KEY: Template = {
  version: 'claude-one-shot-2',
  text: `claude --bare -p ${CLAUDE_TAIL_TEXT} ${envText('ANTHROPIC_API_KEY', CLAUDE_QUIET_ENV)}`,
  authMode: 'api_key',
  keyRef: 'backend/claude/api_key',
  keyVariable: 'ANTHROPIC_API_KEY',
  env: CLAUDE_QUIET_ENV,
  persistenceFlags: ['--no-session-persistence'],
  tools: CLAUDE_ROLE_TOOLS,
  sessionIdOf: sessionId,
  render: ({ model, invocation }) => ['--bare', '-p', ...claudeTail(model, invocation)],
};

// E74 item 1, Claude Code on a subscription token. `--bare` "does not read
// CLAUDE_CODE_OAUTH_TOKEN" (code.claude.com/docs/en/authentication,
// "Generate a long-lived token"), so this template runs without it, and the
// token is delivered as that page says: "set it as the
// CLAUDE_CODE_OAUTH_TOKEN environment variable". What `--bare` switched off
// is switched off by documented flags instead: `--safe-mode` (CLAUDE.md,
// skills, plugins, hooks, MCP servers, custom commands and agents, workflows
// and auto memory do not load; "Authentication, model selection, built-in
// tools, and permissions work normally"); `--setting-sources user`, so the
// workspace's own `.claude/settings*.json` (its `env` block, hooks and
// apiKeyHelper, which would outrank the token) is never read, the user
// settings being the volatile home's, empty; `--strict-mcp-config` with no
// `--mcp-config`, so no `.mcp.json` server connects. What still loads is the
// positive canary's to establish and record.
const CLAUDE_SUBSCRIPTION: Template = {
  version: 'claude-subscription-1',
  text: `claude -p --safe-mode --setting-sources user --strict-mcp-config ${CLAUDE_TAIL_TEXT} ${envText('CLAUDE_CODE_OAUTH_TOKEN', CLAUDE_QUIET_ENV)}`,
  authMode: 'subscription_token',
  keyRef: 'backend/claude/subscription_token',
  keyVariable: 'CLAUDE_CODE_OAUTH_TOKEN',
  env: CLAUDE_QUIET_ENV,
  persistenceFlags: ['--no-session-persistence'],
  tools: CLAUDE_ROLE_TOOLS,
  sessionIdOf: sessionId,
  render: ({ model, invocation }) => ['-p', '--safe-mode', '--setting-sources', 'user', '--strict-mcp-config', ...claudeTail(model, invocation)],
};

// D2 §4.6, Codex CLI 0.160.0 (as installed and pinned by copy; the flags
// below are each in that version's `codex exec --help`, saved by the
// 2026-10-27 assessment, and the `-c` keys in the Codex configuration
// reference read the same day). Version 4 (C1, C2b and C2c of Codex
// support; the assessment's G3, G4, G5, G11; the owner's decisions K3 and
// K6a of 2026-10-28; each `--disable` name accepted by the 0.160.0 binary's
// `features list`, checked 2026-10-28):
//   - the prompt: `-` makes standard input the whole prompt (`codex exec
//     --help`: "if `-` is used, instructions are read from stdin"), and the
//     engine writes exactly the fixed prompt there (`stdin` below), which
//     names /surety/context/prompt.md and /surety/out/result.json. Never the
//     scripted protocol's request line, and never task text in an argument
//     (D1 §17 item 3). (A prompt argument with stdin piped would append stdin
//     as a `<stdin>` block, so the argument form is not used.)
//   - the credential (version 4, K3 of the owner's decisions of 2026-10-28):
//     the one held key in `CODEX_API_KEY` alone. By the source at tag
//     rust-v0.160.0 (the driver's report codex-features-source.md, batch
//     2026-10-28/codex-decisions), `exec` authenticates with CODEX_API_KEY,
//     which wins over every other method (login/src/auth/manager.rs:
//     1499-1505), and does not read OPENAI_API_KEY for model requests (the
//     built-in OpenAI provider has no env_key, model-provider-info/src/
//     lib.rs:520-525; its readers are the TUI's voice mode, onboarding and
//     presence telemetry). Delivering it in OPENAI_API_KEY as well would only
//     put a second copy of the secret into the environment every child shell
//     command inherits, so version 4 does not.
//   - what it writes: `--ephemeral` (no session files), CODEX_HOME in the
//     volatile home, credentials in memory only
//     (`cli_auth_credentials_store="ephemeral"`), no history; the last
//     message to /surety/out/last-message.txt (transcript evidence only,
//     D2 §4.6); the result is /surety/out/result.json, written by the agent
//     as the prompt asks (D2 §1.4).
//   - off: the provider-side web search (it would fetch outside Surety's
//     egress proxy), update checks, analytics, feedback, the OpenTelemetry
//     exporters (metrics default `statsig`), sub-agents (`agents.enabled`,
//     feature `multi_agent`), goals (automatic continuation), hooks, apps and
//     memories; approvals never prompt (Surety's sandbox is the sandbox).
//     `forced_login_method="api"`: an API key only, never a ChatGPT login.
//     `features.unified_exec` cannot be switched off (the reference: user
//     opt-outs are ignored); what it runs stays in the domain (D2 §4.4).
//   - also off (C2b, 2026-10-28): every other feature 0.160.0's own
//     `codex features list` reports on (`true`) that is a delegation,
//     scheduling or background feature, or reaches beyond the domain's own
//     tools (D2 §4.6, D2-T13): the shared daemon's auto-start, worktrees,
//     the guardian reviewer, local automations, the browser and computer
//     tools, plugins and their remote and sharing parts, skills' MCP
//     installs, the code-mode host (a companion process), tool suggestions,
//     workspace dependencies, the app's updates. The classification of every
//     feature that list names is adapters/codex-features.ts's, and the
//     attempt judges its own inventory against this list.
//   - no `--skip-git-repo-check` (C2b): D2 §4.6 does not pass it, "so a
//     broken git view fails visibly"; the fixture project and every run's
//     workspace are git checkouts the engine makes.
//   - also off (version 4, K6a of the owner's decisions of 2026-10-28; each
//     read from the source at tag rust-v0.160.0, report as above; none is of
//     the family, each is hardening):
//       unbounded_connection_retries: keeps a turn alive forever on a
//         connection failure (core/src/responses_retry.rs:22-23, 92-116), so
//         a refused egress would hang to the deadline instead of failing.
//       system_proxy_fallback: retries bootstrap requests through
//         HTTPS_PROXY/HTTP_PROXY/ALL_PROXY (backend-client/src/client.rs:
//         343-360); off, fail closed.
//       image_generation: calls images/generations through the provider and
//         writes PNGs under CODEX_HOME (codex-api/src/endpoint/images.rs:68,
//         81); not exposed under an API key, off to fail closed.
//       unified_exec_tty: the PTY mode of the command tool, whose children
//         get no parent-death signal (utils/pty/src/spawn_helper_main.rs:
//         69-73).
//       sleep_tool: `clock.sleep`, which blocks the turn for up to 12 h
//         (core/src/tools/handlers/sleep.rs:28, 96-133); a stall buys
//         nothing.
//       shell_snapshot: writes the shell's exported environment, so the key,
//         into $CODEX_HOME/shell_snapshots/ (shell-command/src/
//         shell_snapshot_capture.rs:160-178; core/src/shell_snapshot.rs:
//         105-107); a copy of the secret on disk while it lives.
// Version 4 differs from version 3 by those two changes alone.
//
// Version 5 (C2g of Codex support, 2026-10-28; the driver's K12 source
// report, option B, pending the owner's choice):
//   - the model catalog: `-c model_catalog_json=/surety/context/
//     model-catalog.json`, a catalog of our own (adapters/codex-catalog.ts)
//     holding gpt-6.1-sol's bundled entry with "tool_mode": "direct". In
//     0.160.0 the execution-tool mode comes from the model's catalog
//     metadata (core/src/tools/mod.rs:75-85), and the bundled catalog sets
//     gpt-6.1-sol's to "code_mode_only", which hides every direct tool and
//     needs the code-mode host, the companion process this template
//     disables (code_mode_host above): attempt #2 on MAIN ended with no
//     command and no file change. When set it is the only catalog
//     (model-provider/src/provider.rs:426-431). `model_catalog_json` is a
//     known top-level key (config/src/config_toml.rs:400), so
//     `--strict-config` accepts it; `exec --help` cannot show that, and
//     `exec` was not run: the real binary's `features list` was, which
//     loads and validates the catalog (codex-catalog.ts). The domain
//     carries the file (`files` below); the template's text names its
//     SHA-256, so a changed catalog is a new template version. The -c is
//     not among CODEX_CONFIG_OVERRIDES: the static checks' `features list`
//     runs on the host, where the file is not, and that list shows no
//     catalog metadata (codex-features.ts).
//   - `--disable code_mode --disable code_mode_only`: belt and braces,
//     harmless. The flags are only the fallback for a model whose catalog
//     sets no tool_mode (tools/mod.rs:76), so they are ineffective for
//     gpt-6.1-sol with its catalog; they keep the fallback Direct for a
//     model that sets none, or whose tool_mode string Codex does not read
//     (protocol/src/openai_models.rs:352-361 reads an unknown one as none).
// Version 5 differs from version 4 by those two changes alone.
//
// Version 6 (C2h of Codex support, 2026-10-30; the owner: "Use
// gpt-6.1-terra for Codex runs going forward"): the model catalog holds
// gpt-6.1-terra's own entry beside gpt-6.1-sol's, Terra's taken verbatim
// from models-manager/models.json at tag rust-v0.166.0 with "tool_mode":
// "direct" (adapters/codex-catalog.ts; 0.160.0's bundled catalog has no
// Terra). The catalog's SHA-256, which the text names, changes with it;
// the arguments, the flags and CODEX_TEMPLATE_CLI_VERSION do not. Version 6
// differs from version 5 by that alone.
export const CODEX_DISABLED_FEATURES = [
  'multi_agent',
  'goals',
  'hooks',
  'apps',
  'memories',
  'daemon_auto_start',
  'worktrees',
  'guardian_approval',
  'in_app_local_automation',
  'in_app_browser',
  'in_app_updates',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'plugins',
  'plugin_sharing',
  'remote_plugin',
  'skill_mcp_dependency_install',
  'code_mode_host',
  'tool_suggest',
  'workspace_dependencies',
  // Version 4 (K6a): hardening, not the family.
  'unbounded_connection_retries',
  'system_proxy_fallback',
  'image_generation',
  'unified_exec_tty',
  'sleep_tool',
  'shell_snapshot',
  // Version 5 (C2g): hardening, not the family; belt and braces.
  'code_mode',
  'code_mode_only',
] as const;
export const CODEX_CONFIG_OVERRIDES = [
  'web_search="disabled"',
  'tools.web_search=false',
  'check_for_update_on_startup=false',
  'analytics.enabled=false',
  'feedback.enabled=false',
  'otel.metrics_exporter="none"',
  'otel.exporter="none"',
  'otel.trace_exporter="none"',
  'agents.enabled=false',
  'history.persistence="none"',
  'cli_auth_credentials_store="ephemeral"',
  'forced_login_method="api"',
] as const;
// Codex's own home in the volatile home (D2 §4.6), set explicitly.
export const CODEX_ENV: Readonly<Record<string, string>> = Object.freeze({ CODEX_HOME: '/surety/home/.codex' });
// The Codex CLI version this template was written and checked against.
export const CODEX_TEMPLATE_CLI_VERSION = '0.160.0';

const codexArgs = (model: string): string[] => [
  'exec',
  '--json',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--strict-config',
  ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
  ...CODEX_CONFIG_OVERRIDES.flatMap((c) => ['-c', c]),
  // Version 5 (C2g): the model catalog the domain carries.
  '-c',
  `model_catalog_json=${CODEX_MODEL_CATALOG_PATH}`,
  '--dangerously-bypass-approvals-and-sandbox',
  '-C',
  '/surety/workspace',
  '-m',
  model,
  '-o',
  '/surety/out/last-message.txt',
  '-',
];

const CODEX_API_KEY: Template = {
  version: 'codex-exec-6',
  text:
    `codex exec ${codexArgs('<m>').slice(1).join(' ')} ` +
    `(standard input: the fixed prompt) (environment: CODEX_API_KEY=<credential> ${Object.entries(CODEX_ENV).map(([k, v]) => `${k}=${v}`).join(' ')}) ` +
    `(file: ${CODEX_MODEL_CATALOG_PATH} sha256:${CODEX_MODEL_CATALOG_SHA256}) (Codex CLI ${CODEX_TEMPLATE_CLI_VERSION})`,
  authMode: 'api_key',
  keyRef: 'backend/codex/api_key',
  keyVariable: 'CODEX_API_KEY',
  env: CODEX_ENV,
  persistenceFlags: ['--ephemeral'],
  tools: [],
  stdin: `${PROMPT}\n`,
  files: [{ path: CODEX_MODEL_CATALOG_PATH, content: CODEX_MODEL_CATALOG_TEXT }],
  render: ({ model }) => codexArgs(model),
};

// Each backend's templates by mode; the `api_key` one is the default.
const BY_MODE: Readonly<Record<string, Partial<Record<AuthMode, Template>>>> = {
  claude: { api_key: CLAUDE_API_KEY, subscription_token: CLAUDE_SUBSCRIPTION },
  codex: { api_key: CODEX_API_KEY },
};

// The default (api_key) template of each backend, as D2 named them.
export const TEMPLATES: Readonly<Record<string, Template>> = { claude: CLAUDE_API_KEY, codex: CODEX_API_KEY };

export const keyVariable = (backend: string, authMode: string = 'api_key'): string =>
  BY_MODE[backend]?.[authMode as AuthMode]?.keyVariable ?? `${backend.toUpperCase()}_API_KEY`;

// Every variable a backend's credential is delivered in, in a mode: the
// template's own and its aliases.
export const keyVariables = (backend: string, authMode: string = 'api_key'): string[] => {
  const t = BY_MODE[backend]?.[authMode as AuthMode];
  return t === undefined ? [keyVariable(backend, authMode)] : [t.keyVariable, ...(t.keyAliases ?? [])].filter((v) => v !== '');
};

// The environment a template gives its backend beside the constructed one:
// its fixed variables and the credential in each of its variables.
export function templateEnv(t: Template, key: string | null): Record<string, string> {
  const env: Record<string, string> = { ...t.env };
  if (key !== null && t.keyVariable !== '') for (const v of [t.keyVariable, ...(t.keyAliases ?? [])]) env[v] = key;
  return env;
}

// The secret reference of a backend's credential in a mode.
export const credentialRef = (backend: string, authMode: string = 'api_key'): string => BY_MODE[backend]?.[authMode as AuthMode]?.keyRef ?? `backend/${backend}/api_key`;

// The scripted backend as a qualifiable one, in the engine's test mode only
// (SEAM.md §148): its binary is started with no arguments and reads the
// scripted protocol's request on its standard input; no key; nothing kept.
export const SCRIPTED_TEMPLATE: Template = {
  version: 'scripted-1',
  text: '<binary> (the scripted protocol on standard input)',
  authMode: 'api_key',
  keyRef: '',
  keyVariable: '',
  env: {},
  persistenceFlags: [],
  tools: [],
  render: () => [],
};

// ---- the workspace assistant's template (the assistant design §3) ----------------------
//
// A trust entry binds one template. The project roles' gives Read, Edit,
// Write, Bash, Glob and Grep, which the workspace assistant must not have, so
// the assistant runs on a template of its own, qualified by an attempt of its
// own: the backend's one-shot form with `--tools Read,Write`, the same denied
// delegation and scheduling tools, the same fixed prompt, and a mount plan
// with no repository (/surety/context read-only and /surety/out; prepare.ts).
// Its versions are distinct from every role template's, which is how an
// entry or an attempt is known to be the assistant's: project roles never
// resolve an assistant entry, and the assistant never resolves a role's.
export type TemplatePurpose = 'role' | 'assistant';
export const ASSISTANT_TOOLS = ['Read', 'Write'] as const;

const claudeAssistantTail = (model: string, invocation: string) => [
  '--output-format',
  'stream-json',
  '--verbose',
  '--model',
  model,
  '--tools',
  ASSISTANT_TOOLS.join(','),
  '--disallowed-tools',
  'Agent',
  'Task',
  'ScheduleWakeup',
  'Workflow',
  '--permission-mode',
  'bypassPermissions',
  '--no-session-persistence',
  '--session-id',
  sessionId(invocation),
  PROMPT,
];
const CLAUDE_ASSISTANT_TAIL_TEXT = CLAUDE_TAIL_TEXT.replace('<role tools>', 'Read,Write');

const CLAUDE_ASSISTANT_API_KEY: Template = {
  ...CLAUDE_API_KEY,
  version: 'claude-assistant-1',
  text: `claude --bare -p ${CLAUDE_ASSISTANT_TAIL_TEXT} ${envText('ANTHROPIC_API_KEY', CLAUDE_QUIET_ENV)} (the workspace assistant: no repository)`,
  tools: ASSISTANT_TOOLS,
  render: ({ model, invocation }) => ['--bare', '-p', ...claudeAssistantTail(model, invocation)],
};
const CLAUDE_ASSISTANT_SUBSCRIPTION: Template = {
  ...CLAUDE_SUBSCRIPTION,
  version: 'claude-assistant-subscription-1',
  text: `claude -p --safe-mode --setting-sources user --strict-mcp-config ${CLAUDE_ASSISTANT_TAIL_TEXT} ${envText('CLAUDE_CODE_OAUTH_TOKEN', CLAUDE_QUIET_ENV)} (the workspace assistant: no repository)`,
  tools: ASSISTANT_TOOLS,
  render: ({ model, invocation }) => ['-p', '--safe-mode', '--setting-sources', 'user', '--strict-mcp-config', ...claudeAssistantTail(model, invocation)],
};

const ASSISTANT_BY_MODE: Readonly<Record<string, Partial<Record<AuthMode, Template>>>> = {
  claude: { api_key: CLAUDE_ASSISTANT_API_KEY, subscription_token: CLAUDE_ASSISTANT_SUBSCRIPTION },
};

// The scripted backend's assistant form, in the test mode only: the scripted
// protocol on standard input, its own version.
export const SCRIPTED_ASSISTANT_TEMPLATE: Template = {
  ...SCRIPTED_TEMPLATE,
  version: 'scripted-assistant-1',
  text: '<binary> (the scripted protocol on standard input; the workspace assistant: no repository)',
};

const ASSISTANT_VERSIONS: ReadonlySet<string> = new Set([CLAUDE_ASSISTANT_API_KEY.version, CLAUDE_ASSISTANT_SUBSCRIPTION.version, SCRIPTED_ASSISTANT_TEMPLATE.version]);

// What a template version (an entry's or an attempt's) is for.
export const purposeOfTemplateVersion = (version: string): TemplatePurpose => (ASSISTANT_VERSIONS.has(version) ? 'assistant' : 'role');

// The template of a backend this engine has an adapter for, in an
// authentication mode (default `api_key`), with its version as this start
// has it (the test mode may set another; SEAM.md §150). `scripted` only
// where the caller allows it. undefined where the backend has no template
// for the mode. `purpose` `assistant`: the workspace assistant's template
// (the test mode's version override is a role template's only).
export function templateOf(
  backend: string,
  opts: { scripted?: boolean; versions?: Record<string, string> | null; authMode?: string | null; purpose?: TemplatePurpose } = {},
): Template | undefined {
  const mode = (opts.authMode ?? 'api_key') as AuthMode;
  if (opts.purpose === 'assistant') {
    return ASSISTANT_BY_MODE[backend]?.[mode] ?? (opts.scripted && backend === 'scripted' && mode === 'api_key' ? SCRIPTED_ASSISTANT_TEMPLATE : undefined);
  }
  const t = BY_MODE[backend]?.[mode] ?? (opts.scripted && backend === 'scripted' && mode === 'api_key' ? SCRIPTED_TEMPLATE : undefined);
  if (!t) return undefined;
  const v = opts.versions?.[backend];
  return v === undefined ? t : { ...t, version: v };
}
