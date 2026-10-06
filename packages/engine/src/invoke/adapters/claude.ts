// The Claude Code adapter's stream parsing (D2 §§1.1, 1.5, 1.6, 4.2, 4.5,
// 7.2): the backend's standard output under `-p --output-format stream-json
// --verbose` turned into the engine's internal callbacks, and what the
// qualification canaries need to know of it. Rendering the template is
// `templates.ts`; collection is `collect.ts`; nothing here starts a process.
//
// Where the shapes come from. Nothing here was learned by running Claude Code
// against a model (none may be, outside an attempt Sean approves). The event
// shapes are those the official documentation gives for Claude Code's
// stream-json output and its Agent SDK message types (code.claude.com/docs:
// "Run Claude Code programmatically", "Agent SDK reference - TypeScript",
// "Track cost and usage"), read for Claude Code 2.1.289:
//   - `system`/`init`: `tools` (string[]), `model`, `permissionMode`,
//     `apiKeySource` ("ANTHROPIC_API_KEY" when the key in that variable is in
//     use, "none" when no key is), `claude_code_version`, `session_id`;
//   - `assistant`: `message` is an API message with `id`, `model`, `usage`
//     (`input_tokens`, `cache_creation_input_tokens`,
//     `cache_read_input_tokens`, `output_tokens`) and `content` blocks
//     (`tool_use` with `id`, `name`, `input`); `parent_tool_use_id` names the
//     spawning call for a subagent's messages; `error` names an API failure
//     (`authentication_failed`, `billing_error`, `rate_limit`, ...). Several
//     messages of one API response share its `id` and usage: counted once.
//     The per-message `output_tokens` is a placeholder taken at
//     `message_start`, so a per-call observation carries input and cache
//     tokens only;
//   - `user`: `message.content` blocks (`tool_result` with `tool_use_id`,
//     `is_error`);
//   - `system`/`permission_denied` (`tool_name`, `tool_use_id`), best-effort;
//     the result's `permission_denials` is the authoritative list;
//   - `system`/`api_retry` (`attempt`, `error_status`, `error`);
//   - `result`: `subtype` ("success", or "error_max_turns",
//     "error_during_execution", "error_max_budget_usd",
//     "error_max_structured_output_retries"), `is_error`, `num_turns`,
//     `total_cost_usd` (cumulative, covering every model call of the
//     process, a client-side figure), `usage` (main loop only), `modelUsage`
//     (per model, every call: `inputTokens`, `outputTokens`,
//     `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`),
//     `permission_denials`, `api_error_status`, `errors`, `terminal_reason`,
//     `stop_reason`, `result` (the final text). A startup failure's result
//     carries zeroed totals.
// Every field is read defensively: a field that is absent or of another type
// is unknown (null), never zero, never success. Whether 2.1.288 or 2.1.289
// emits each as documented is what the positive canary establishes (D2
// §4.5); this module records what it saw so that the canary can say so.
//
// Everything the stream carries is role output: kept here bounded, and
// redacted by the caller before it reaches a record (D2 §2.5; E37 item 2).

// The tools of D2 §4.5's denied list and the documented tools that delegate,
// schedule or run in the background (code.claude.com/docs tools reference at
// 2.1.289). `Task` is the name CH §3.7 recorded at 2.1.281; the reference no
// longer lists it, and it is kept so that an inventory naming it is caught.
export const CLAUDE_DELEGATION_TOOLS: Readonly<Record<string, 'delegation' | 'scheduling' | 'background'>> = {
  Agent: 'delegation',
  Task: 'delegation',
  Workflow: 'delegation',
  SendMessage: 'delegation',
  ScheduleWakeup: 'scheduling',
  CronCreate: 'scheduling',
  RemoteTrigger: 'scheduling',
  Monitor: 'background',
};

// The names the template's `--disallowed-tools` denies (D2 §4.5).
export const CLAUDE_TEMPLATE_DENIED = ['Agent', 'Task', 'ScheduleWakeup', 'Workflow'];

// Bounds on what the summary keeps of a stream (the transcript keeps the
// stream itself, redacted).
const MAX_TOOL_USES = 512;
const MAX_LIST = 64;
const MAX_TEXT = 2048;

export interface ClaudeUsageObservation {
  semantics: 'delta' | 'cumulative';
  raw: Record<string, unknown>;
}

export interface ClaudeInit {
  tools: string[] | null;
  model: string | null;
  permission_mode: string | null;
  api_key_source: string | null;
  version: string | null;
  session_id: string | null;
  mcp_servers: string[] | null;
}

export interface ClaudeResult {
  subtype: string | null;
  is_error: boolean | null;
  num_turns: number | null;
  stop_reason: string | null;
  terminal_reason: string | null;
  api_error_status: number | null;
  errors: string[];
  text: string | null;
  total_cost_usd: number | null;
  usage_present: boolean;
  models: string[];
}

export interface ClaudeToolUse {
  id: string | null;
  name: string;
  subagent: boolean;
  background: boolean;
}

export interface ClaudeStreamSummary {
  lines: number;
  unparsed: number;
  types: Record<string, number>;
  init: ClaudeInit | null;
  inits: number;
  assistant_messages: number;
  usage_steps: number;
  tool_uses: ClaudeToolUse[];
  tool_uses_truncated: boolean;
  tool_results: { tool_use_id: string; is_error: boolean | null }[];
  denials: { tool_name: string; tool_use_id: string | null; source: 'event' | 'result' }[];
  assistant_errors: string[];
  api_retries: { error: string | null; status: number | null }[];
  result: ClaudeResult | null;
  results: number;
  // Lines that broke the stream's protocol (a second terminal event): each
  // is ignored, and the run cannot be clean (E74 item 3).
  protocol_errors: string[];
  // The per-call usage counted until the bound on message ids was reached;
  // beyond it only the terminal totals count.
  usage_ids_truncated: boolean;
  // A model fallback (E86 item 3): each `system/model_refusal_fallback`
  // event, and every model the stream names (an assistant message's model,
  // `<synthetic>` aside; the result's modelUsage keys).
  fallbacks: { original_model: string | null; fallback_model: string | null; trigger: string | null; scope: string | null; category: string | null }[];
  models_seen: string[];
}

export interface ClaudeLine {
  usage: ClaudeUsageObservation[];
  // The terminal event this line is, if it is one: `success` only for a
  // `result` whose subtype is "success" and whose is_error is false.
  terminal: 'success' | 'failure' | null;
  // A protocol error this line made, if it made one.
  protocolError: string | null;
}

// The most message ids the adapter remembers (E74 item 3): a stream with
// more stops reporting per-call usage, which the terminal totals replace.
const MAX_MESSAGE_IDS = 10_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown, max = 256): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]).slice(0, 256).map((x) => x.slice(0, 256)) : null);

export class ClaudeStream {
  private readonly s: ClaudeStreamSummary = {
    lines: 0,
    unparsed: 0,
    types: {},
    init: null,
    inits: 0,
    assistant_messages: 0,
    usage_steps: 0,
    tool_uses: [],
    tool_uses_truncated: false,
    tool_results: [],
    denials: [],
    assistant_errors: [],
    api_retries: [],
    result: null,
    results: 0,
    protocol_errors: [],
    usage_ids_truncated: false,
    fallbacks: [],
    models_seen: [],
  };
  private readonly seen = new Set<string>();

  // How the cost the stream reports is recorded (E74 item 1): `reported` for
  // the API-key mode (D2 §4.5); for the subscription mode an estimate, the
  // figure being Claude Code's own client-side reckoning, never a bill.
  constructor(private readonly opts: { costAs?: 'reported' | 'estimated' } = {}) {}

  // Whether a line only reports usage, so that it may be acted on while an
  // expired lease waits for its challenge (D2 §3.5; choke.ts): an assistant
  // message. A result is the terminal event and waits.
  static usageOnly(line: string): boolean {
    try {
      const m = JSON.parse(line) as unknown;
      return isObject(m) && m.type === 'assistant';
    } catch {
      return false;
    }
  }

  feed(line: string): ClaudeLine {
    const out: ClaudeLine = { usage: [], terminal: null, protocolError: null };
    if (line.trim() === '') return out;
    this.s.lines++;
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      this.s.unparsed++;
      return out;
    }
    if (!isObject(m)) {
      this.s.unparsed++;
      return out;
    }
    const type = typeof m.type === 'string' ? m.type.slice(0, 64) : '?';
    const key = typeof m.subtype === 'string' ? `${type}/${m.subtype.slice(0, 64)}` : type;
    if (Object.keys(this.s.types).length < MAX_LIST || key in this.s.types) this.s.types[key] = (this.s.types[key] ?? 0) + 1;
    if (type === 'system') this.system(m);
    else if (type === 'assistant') this.assistant(m, out);
    else if (type === 'user') this.user(m);
    else if (type === 'result') this.result(m, out);
    return out;
  }

  summary(): ClaudeStreamSummary {
    return structuredClone(this.s);
  }

  private system(m: Record<string, unknown>): void {
    if (m.subtype === 'init') {
      this.s.inits++;
      const servers = Array.isArray(m.mcp_servers) ? m.mcp_servers.filter(isObject).map((x) => str(x.name) ?? '?').slice(0, MAX_LIST) : null;
      this.s.init = {
        tools: strings(m.tools),
        model: str(m.model),
        permission_mode: str(m.permissionMode),
        api_key_source: str(m.apiKeySource),
        version: str(m.claude_code_version),
        session_id: str(m.session_id),
        mcp_servers: servers,
      };
    } else if (m.subtype === 'permission_denied') {
      const name = str(m.tool_name);
      if (name !== null) this.deny(name, str(m.tool_use_id), 'event');
    } else if (m.subtype === 'api_retry') {
      if (this.s.api_retries.length < MAX_LIST) this.s.api_retries.push({ error: str(m.error, 64), status: count(m.error_status) });
    } else if (m.subtype === 'model_refusal_fallback') {
      if (this.s.fallbacks.length < MAX_LIST) {
        this.s.fallbacks.push({ original_model: str(m.original_model), fallback_model: str(m.fallback_model), trigger: str(m.trigger, 64), scope: str(m.scope, 64), category: str(m.api_refusal_category, 64) });
      }
      this.model(str(m.fallback_model));
    }
  }

  private model(name: string | null): void {
    if (name === null || name === '<synthetic>' || name === '' || this.s.models_seen.includes(name) || this.s.models_seen.length >= MAX_LIST) return;
    this.s.models_seen.push(name);
  }

  private deny(tool_name: string, tool_use_id: string | null, source: 'event' | 'result'): void {
    if (this.s.denials.some((d) => d.tool_name === tool_name && d.tool_use_id === tool_use_id && d.tool_use_id !== null)) return;
    if (this.s.denials.length < MAX_TOOL_USES) this.s.denials.push({ tool_name, tool_use_id, source });
  }

  private assistant(m: Record<string, unknown>, out: ClaudeLine): void {
    this.s.assistant_messages++;
    const error = str(m.error, 64);
    if (error !== null && this.s.assistant_errors.length < MAX_LIST) this.s.assistant_errors.push(error);
    const msg = isObject(m.message) ? m.message : null;
    if (msg === null) return;
    this.model(str(msg.model));
    const subagent = typeof m.parent_tool_use_id === 'string';
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!isObject(block) || block.type !== 'tool_use') continue;
        const name = str(block.name);
        if (name === null) continue;
        if (this.s.tool_uses.length >= MAX_TOOL_USES) {
          this.s.tool_uses_truncated = true;
          continue;
        }
        const input = isObject(block.input) ? block.input : {};
        this.s.tool_uses.push({ id: str(block.id), name, subagent, background: input.run_in_background === true });
      }
    }
    // The per-call usage (D2 §1.5): once per API response, by its id. Its
    // output count is the one Claude Code had at the response's start (the
    // documentation calls it a placeholder): kept as observed, a lower bound
    // the terminal totals replace, so that a run's output is never read as
    // nothing while it runs (E74 item 3; SEAM.md §167 S1 (b)). A message
    // with no id cannot be told from another of its response, so it is not
    // counted at all (its tokens reach the terminal totals).
    // A message carrying an API error is Claude Code's own, made without a
    // model response: its usage is no measurement and is not counted.
    if (error !== null) return;
    const id = str(msg.id);
    const usage = isObject(msg.usage) ? msg.usage : null;
    if (id === null || usage === null || this.seen.has(id)) return;
    if (this.seen.size >= MAX_MESSAGE_IDS) {
      this.s.usage_ids_truncated = true;
      return;
    }
    this.seen.add(id);
    const raw: Record<string, unknown> = {};
    for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'] as const) {
      const v = count(usage[k]);
      if (v !== null) raw[k] = v;
    }
    if (Object.keys(raw).length === 0) return;
    const model = str(msg.model);
    if (model !== null) raw.model = model;
    this.s.usage_steps++;
    out.usage.push({ semantics: 'delta', raw });
  }

  private user(m: Record<string, unknown>): void {
    const msg = isObject(m.message) ? m.message : null;
    if (msg === null || !Array.isArray(msg.content)) return;
    for (const block of msg.content) {
      if (!isObject(block) || block.type !== 'tool_result') continue;
      const id = str(block.tool_use_id);
      if (id === null || this.s.tool_results.length >= MAX_TOOL_USES) continue;
      this.s.tool_results.push({ tool_use_id: id, is_error: typeof block.is_error === 'boolean' ? block.is_error : null });
    }
  }

  private result(m: Record<string, unknown>, out: ClaudeLine): void {
    this.s.results++;
    // The first terminal event wins; a second is a protocol error, ignored
    // with its usage, and the run cannot be clean (E74 item 3).
    if (this.s.results > 1) {
      out.protocolError = `a second terminal result event (number ${this.s.results}) after the first`;
      if (this.s.protocol_errors.length < MAX_LIST) this.s.protocol_errors.push(out.protocolError);
      return;
    }
    const subtype = str(m.subtype, 64);
    const isError = typeof m.is_error === 'boolean' ? m.is_error : null;
    const success = subtype === 'success' && isError === false;
    out.terminal = success ? 'success' : 'failure';
    if (Array.isArray(m.permission_denials)) {
      for (const d of m.permission_denials) {
        if (!isObject(d)) continue;
        const name = str(d.tool_name);
        if (name !== null) this.deny(name, str(d.tool_use_id), 'result');
      }
    }
    const totals = resultTotals(m);
    for (const name of totals?.models ?? []) this.model(name);
    const cost = count(m.total_cost_usd);
    this.s.result = {
      subtype,
      is_error: isError,
      num_turns: count(m.num_turns),
      stop_reason: str(m.stop_reason, 64),
      terminal_reason: str(m.terminal_reason, 64),
      api_error_status: count(m.api_error_status),
      errors: (strings(m.errors) ?? []).slice(0, 16).map((e) => e.slice(0, MAX_TEXT)),
      text: str(m.result, MAX_TEXT),
      total_cost_usd: cost,
      usage_present: totals !== null,
      models: totals?.models ?? [],
    };
    // The invocation's usage as the backend totals it (D2 §1.5): cumulative,
    // so that it replaces the per-call increments in the fold, count by
    // count; only the counts it gives are written, so an unknown one never
    // replaces a count observed per call (the slice-14 review's S1). The
    // usage is final only when every count is known. A failure whose totals
    // are all zero is a result written before or without any model call (a
    // startup failure's zeroed totals): those zeros are not a measurement,
    // so nothing of it is recorded as usage and its cost is not reported.
    const zeroed = totals !== null && TOKEN_KEYS.every((k) => totals.tokens[k] === 0) && (cost === null || cost === 0);
    if (totals === null || (!success && zeroed)) {
      out.usage.push({ semantics: 'cumulative', raw: { usage_final: false, usage_scope: totals === null ? 'absent' : 'zeroed_failure' } });
      return;
    }
    const known = Object.fromEntries(TOKEN_KEYS.filter((k) => totals.tokens[k] !== null).map((k) => [k, totals.tokens[k]]));
    const complete = TOKEN_KEYS.every((k) => totals.tokens[k] !== null);
    const raw: Record<string, unknown> = { ...known, usage_final: complete, usage_scope: totals.scope };
    if (cost !== null) raw[this.opts.costAs === 'estimated' ? 'total_cost_usd_estimate' : 'total_cost_usd'] = cost;
    if (totals.models.length > 0) raw.model = totals.models.join(',');
    // Each model's own counts and cost as the backend reported them (E86
    // item 3: a fallback's usage is charged as observed, per model).
    const perModel = isObject(m.modelUsage) ? m.modelUsage : null;
    if (totals.models.length > 1 && perModel !== null) {
      raw.model_usage = Object.fromEntries(
        totals.models.map((name) => {
          const u = isObject(perModel[name]) ? (perModel[name] as Record<string, unknown>) : {};
          return [name, { input_tokens: count(u.inputTokens), cache_creation_input_tokens: count(u.cacheCreationInputTokens), cache_read_input_tokens: count(u.cacheReadInputTokens), output_tokens: count(u.outputTokens), cost_usd: count(u.costUSD) }];
        }),
      );
    }
    out.usage.push({ semantics: 'cumulative', raw });
  }
}

const TOKEN_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'] as const;
type TokenKey = (typeof TOKEN_KEYS)[number];

// The result's totals: from `modelUsage` (every model call of the process)
// where it is given, else from `usage` (the main loop only); a count either
// lacks is null.
function resultTotals(m: Record<string, unknown>): { tokens: Record<TokenKey, number | null>; models: string[]; scope: 'all_models' | 'main_loop' } | null {
  if (isObject(m.modelUsage) && Object.keys(m.modelUsage).length > 0) {
    const models = Object.keys(m.modelUsage).sort().slice(0, 16);
    const fields: Record<TokenKey, string> = { input_tokens: 'inputTokens', cache_creation_input_tokens: 'cacheCreationInputTokens', cache_read_input_tokens: 'cacheReadInputTokens', output_tokens: 'outputTokens' };
    const tokens = {} as Record<TokenKey, number | null>;
    for (const k of TOKEN_KEYS) {
      let sum: number | null = 0;
      for (const model of Object.values(m.modelUsage)) {
        const v = isObject(model) ? count(model[fields[k]]) : null;
        sum = sum === null || v === null ? null : sum + v;
      }
      tokens[k] = sum;
    }
    return { tokens, models, scope: 'all_models' };
  }
  if (isObject(m.usage)) {
    const u = m.usage;
    const tokens = Object.fromEntries(TOKEN_KEYS.map((k) => [k, count(u[k])])) as Record<TokenKey, number | null>;
    return { tokens, models: [], scope: 'main_loop' };
  }
  return null;
}

// A model fallback (E86 item 3, provisional): the stream shows a model other
// than the entry's, by a `model_refusal_fallback` event or by a model it
// named; null where it shows none. Its text names the fallback.
export function claudeModelFallback(s: ClaudeStreamSummary | null, entryModel: string): { text: string; fallbacks: ClaudeStreamSummary['fallbacks']; models: string[] } | null {
  if (s === null) return null;
  const others = s.models_seen.filter((m) => m !== entryModel);
  if (s.fallbacks.length === 0 && others.length === 0) return null;
  const f = s.fallbacks[0];
  const text = f
    ? `model_fallback: ${f.original_model ?? entryModel} -> ${f.fallback_model ?? others[0] ?? 'another model'} (${f.trigger ?? 'unknown trigger'}${f.category ? `, ${f.category}` : ''}${f.scope ? `, scope ${f.scope}` : ''})`
    : `model_fallback: ${entryModel} -> ${others.join(', ')} (named in the stream)`;
  return { text: text.slice(0, 300), fallbacks: s.fallbacks, models: s.models_seen };
}

// ---- what a canary makes of a stream (D2 §7.2) ------------------------------------

// Whether the stream shows that the backend could not authenticate: the API
// rejected the key (an assistant message or a retry naming
// `authentication_failed`, a result whose API error status is 401), or the
// backend ran with no key at all (`apiKeySource` "none" under `--bare`,
// which takes Anthropic authentication only from ANTHROPIC_API_KEY or an
// apiKeyHelper, and the template passes no helper).
export function claudeAuthFailure(s: ClaudeStreamSummary, authMode: string = 'api_key'): string | null {
  if (s.assistant_errors.includes('authentication_failed')) return 'an assistant message carried error authentication_failed';
  if (s.api_retries.some((r) => r.error === 'authentication_failed')) return 'an api_retry event carried error authentication_failed';
  if (s.result?.api_error_status === 401) return 'the result carried api_error_status 401';
  // `apiKeySource` "none" means the session authenticates other than by an
  // API key (code.claude.com/docs, ApiKeySource): no key under the API-key
  // mode; the expected value under the subscription token.
  if (authMode === 'api_key' && s.init?.api_key_source === 'none') return 'the init event reported apiKeySource "none": no API key reached the backend';
  if (authMode === 'subscription_token' && s.init !== null && s.init.api_key_source !== null && s.init.api_key_source !== 'none') {
    return `the init event reported apiKeySource "${s.init.api_key_source}": a key, not the subscription token, was in use`;
  }
  return null;
}

// Whether the backend was authenticated and answered: an assistant message
// carrying no API error, and no sign of an authentication failure.
export function claudeAnswered(s: ClaudeStreamSummary, authMode: string = 'api_key'): boolean {
  return claudeAuthFailure(s, authMode) === null && s.assistant_messages > s.assistant_errors.length;
}

// What the canaries established about the credential's delivery (D2 §2.5,
// §4.5; E74 item 1), in the mode's variable:
//   - `api_key`: init.apiKeySource is "ANTHROPIC_API_KEY" and the model
//     answered;
//   - `subscription_token`: the model answered while init.apiKeySource was
//     "none" (no API key in use) and CLAUDE_CODE_OAUTH_TOKEN was the only
//     credential the backend was given (the engine passes no other; the
//     volatile home holds no login; `--setting-sources user` reads no
//     workspace apiKeyHelper): by elimination, the token. The stream names no
//     OAuth source of its own, so `basis` says it is an elimination.
// null where the stream did not say.
export function claudeKeyDelivery(s: ClaudeStreamSummary, authMode: string = 'api_key'): { variable: string; api_key_source: string | null; established: boolean | null; basis: string } {
  const source = s.init?.api_key_source ?? null;
  if (authMode === 'subscription_token') {
    const variable = 'CLAUDE_CODE_OAUTH_TOKEN';
    if (source === 'none' && claudeAnswered(s, authMode)) {
      return { variable, api_key_source: source, established: true, basis: 'the model answered with init.apiKeySource "none", and CLAUDE_CODE_OAUTH_TOKEN was the only credential the engine gave the backend (by elimination)' };
    }
    if (source !== null && source !== 'none') return { variable, api_key_source: source, established: false, basis: `init.apiKeySource is ${source}: a key was in use, not the token` };
    return { variable, api_key_source: source, established: null, basis: source === null ? 'the stream carried no init.apiKeySource' : 'the model did not answer' };
  }
  if (source === 'ANTHROPIC_API_KEY' && claudeAnswered(s, authMode)) return { variable: 'ANTHROPIC_API_KEY', api_key_source: source, established: true, basis: 'init.apiKeySource is ANTHROPIC_API_KEY and the model answered' };
  if (source !== null && source !== 'ANTHROPIC_API_KEY') return { variable: 'ANTHROPIC_API_KEY', api_key_source: source, established: false, basis: `init.apiKeySource is ${source}` };
  return { variable: 'ANTHROPIC_API_KEY', api_key_source: source, established: null, basis: source === null ? 'the stream carried no init.apiKeySource' : 'the model did not answer' };
}

// The structured provider error a failed canary keeps (D2 §7.2, N04): what
// the stream said of the failure, bounded. The caller redacts it before it
// is recorded.
export function claudeProviderError(s: ClaudeStreamSummary, authMode: string = 'api_key'): Record<string, unknown> {
  return {
    auth_mode: authMode,
    auth_failure: claudeAuthFailure(s, authMode),
    protocol_errors: s.protocol_errors,
    assistant_errors: s.assistant_errors,
    api_retries: s.api_retries,
    init: s.init === null ? null : { api_key_source: s.init.api_key_source, model: s.init.model, version: s.init.version, permission_mode: s.init.permission_mode },
    result: s.result,
    lines: s.lines,
    unparsed: s.unparsed,
    types: s.types,
  };
}

// The host's samples of the domain's processes while a canary ran (D2 §7.2;
// M136 (c): no second backend process ever appears in `cgroup.procs`).
export interface BackendSampling {
  samples: number;
  max_backend: number;
  max_members: number;
  unclassified: number;
  // The command lines of the members running the backend's binary, distinct,
  // bounded: what a second one was, if one appeared.
  backend_cmdlines: string[];
  // Distinct members seen running the binary as forks not yet exec'd and
  // younger than 1 s: not backends, not counted in max_backend (SEAM.md §172).
  transient_backend: number;
}

export interface ClaudeCapabilities {
  tools: string[];
  inventory: boolean;
  denied: string[];
  features_disabled: string[];
  delegation_verified: boolean;
  basis: 'inventory' | 'test' | null;
  present: string[];
  attempts: { name: string; tool_use_id: string | null; outcome: 'denied' | 'error' | 'ran' | 'unknown' }[];
  // Bash asked to run in the background (`run_in_background`): recorded,
  // not a failure; it stays inside the domain and dies with it (D2 §4.4),
  // and is listed as not claimed, class C (E74 item 3).
  background_bash: { count: number; class: 'C'; note: string };
  // Names in the inventory beyond the template's `--tools` (the slice-14
  // review's S2): any one makes the surface unverified.
  beyond_template: string[];
  sampling: BackendSampling | null;
  reasons: string[];
}

// The effective tool surface and the absence of delegation, scheduling and
// background work (D2 §§4.1, 4.5, 7.2; Appendix B T13): from the init
// events' tool inventory where the stream gave one, otherwise from the
// executable test (the containment canary instructs the agent to try each
// such tool), and in either case no such tool use that ran, and no second
// backend process in the domain on any host sample. No inventory and no
// test is never a pass.
// The inventory must be a subset of what the template's `--tools` gives
// (`allowed`), so a tool nobody asked for (Skill, TaskCreate, WebFetch, ...)
// is never passed because it is not on a list of known delegation names
// (the slice-14 review's S2). The host's samples must have seen the backend
// itself at least once: a sampler that never identified it establishes
// nothing.
export function claudeCapabilities(summaries: ClaudeStreamSummary[], sampling: BackendSampling | null, allowed: readonly string[]): ClaudeCapabilities {
  const reasons: string[] = [];
  const inits = summaries.map((s) => s.init).filter((i): i is ClaudeInit => i !== null);
  const inventories = inits.map((i) => i.tools).filter((t): t is string[] => t !== null);
  const inventory = inventories.length > 0;
  const tools = [...new Set(inventories.flat())].sort();
  const names = Object.keys(CLAUDE_DELEGATION_TOOLS);
  const present = names.filter((n) => tools.includes(n));
  const attempts: ClaudeCapabilities['attempts'] = [];
  let backgroundBash = 0;
  const deniedSeen = new Set<string>();
  for (const s of summaries) {
    for (const d of s.denials) deniedSeen.add(d.tool_name);
    for (const u of s.tool_uses) {
      if (u.name === 'Bash' && u.background) backgroundBash++;
      if (!names.includes(u.name)) continue;
      const denied = s.denials.some((d) => d.tool_use_id !== null && d.tool_use_id === u.id);
      const r = s.tool_results.find((x) => x.tool_use_id === u.id);
      attempts.push({ name: u.name, tool_use_id: u.id, outcome: denied ? 'denied' : r === undefined || r.is_error === null ? 'unknown' : r.is_error ? 'error' : 'ran' });
    }
  }
  let verified = true;
  for (const a of attempts) {
    if (a.outcome === 'ran') {
      verified = false;
      reasons.push(`${a.name} was used and ran`);
    } else if (a.outcome === 'unknown') {
      verified = false;
      reasons.push(`${a.name} was used and its outcome was not seen`);
    }
  }
  let basis: ClaudeCapabilities['basis'] = null;
  const beyond = tools.filter((t) => !allowed.includes(t));
  if (inventory) {
    basis = 'inventory';
    if (beyond.length > 0) {
      verified = false;
      reasons.push(`the tool inventory offers ${beyond.join(', ')}, beyond the template's --tools (${allowed.join(', ')})`);
    }
    for (const p of present) {
      // Listed, so available, unless every use of it was seen refused.
      const uses = attempts.filter((a) => a.name === p);
      if (uses.length === 0 || uses.some((a) => a.outcome !== 'denied' && a.outcome !== 'error')) {
        verified = false;
        reasons.push(`${p} is in the tool inventory and was not shown unavailable`);
      }
    }
  } else {
    const tried = (kind: string) => attempts.some((a) => CLAUDE_DELEGATION_TOOLS[a.name] === kind);
    if (tried('delegation') && tried('scheduling')) basis = 'test';
    else {
      verified = false;
      reasons.push('no tool inventory, and no executable test both delegated and scheduled (delegation_unverified)');
    }
  }
  if (sampling === null || sampling.samples === 0) {
    verified = false;
    reasons.push('no host sample of the domain was read');
  } else if (sampling.max_backend < 1) {
    verified = false;
    reasons.push(`the host's ${sampling.samples} sample(s) never identified the backend in its domain, so they establish nothing`);
  } else if (sampling.max_backend > 1) {
    verified = false;
    reasons.push(`a second backend process appeared in the domain (at most ${sampling.max_backend} at once)`);
  }
  return {
    tools,
    inventory,
    denied: [...new Set([...CLAUDE_TEMPLATE_DENIED, ...[...deniedSeen].filter((n) => names.includes(n))])].sort(),
    features_disabled: inventory ? names.filter((n) => !tools.includes(n)).sort() : [],
    delegation_verified: verified,
    basis,
    present,
    attempts,
    background_bash: { count: backgroundBash, class: 'C', note: 'Bash run in the background under --tools Bash is recorded, not refused: it stays in the domain and ends with it' },
    beyond_template: beyond,
    sampling,
    reasons,
  };
}
