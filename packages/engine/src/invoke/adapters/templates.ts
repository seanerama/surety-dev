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
  render(args: { model: string; invocation: string }): string[];
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

// D2 §4.6, Codex CLI 0.159.2: the prompt on standard input.
const CODEX_API_KEY: Template = {
  version: 'codex-exec-1',
  text:
    'codex exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config --disable multi_agent --dangerously-bypass-approvals-and-sandbox ' +
    '-C /surety/workspace -m <m> -o /surety/out/last-message.txt -',
  authMode: 'api_key',
  keyRef: 'backend/codex/api_key',
  keyVariable: 'OPENAI_API_KEY',
  env: {},
  persistenceFlags: ['--ephemeral'],
  tools: [],
  render: ({ model }) => [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--disable',
    'multi_agent',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C',
    '/surety/workspace',
    '-m',
    model,
    '-o',
    '/surety/out/last-message.txt',
    '-',
  ],
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

// The template of a backend this engine has an adapter for, in an
// authentication mode (default `api_key`), with its version as this start
// has it (the test mode may set another; SEAM.md §150). `scripted` only
// where the caller allows it. undefined where the backend has no template
// for the mode.
export function templateOf(backend: string, opts: { scripted?: boolean; versions?: Record<string, string> | null; authMode?: string | null } = {}): Template | undefined {
  const mode = (opts.authMode ?? 'api_key') as AuthMode;
  const t = BY_MODE[backend]?.[mode] ?? (opts.scripted && backend === 'scripted' && mode === 'api_key' ? SCRIPTED_TEMPLATE : undefined);
  if (!t) return undefined;
  const v = opts.versions?.[backend];
  return v === undefined ? t : { ...t, version: v };
}
