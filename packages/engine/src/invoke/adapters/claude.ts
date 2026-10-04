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
}

export interface ClaudeLine {
  usage: ClaudeUsageObservation[];
  // The terminal event this line is, if it is one: `success` only for a
  // `result` whose subtype is "success" and whose is_error is false.
  terminal: 'success' | 'failure' | null;
}

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
  };
  private readonly seen = new Set<string>();

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
    const out: ClaudeLine = { usage: [], terminal: null };
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
    }
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
    // The per-call usage (D2 §1.5): once per API response, by its id; input
    // and cache tokens only, the output count being a placeholder here. A
    // message with no id cannot be told from another of its response, so it
    // is not counted at all (its tokens reach the terminal totals).
    const id = str(msg.id);
    const usage = isObject(msg.usage) ? msg.usage : null;
    if (id === null || usage === null || this.seen.has(id)) return;
    this.seen.add(id);
    const raw: Record<string, unknown> = {};
    for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
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
    // so that it replaces the per-call increments in the fold. A failure
    // whose totals are all zero is a result written before or without any
    // model call (a startup failure's zeroed totals): those zeros are not a
    // measurement, so its usage stays unknown and its cost is not reported.
    const zeroed = totals !== null && TOKEN_KEYS.every((k) => totals.tokens[k] === 0) && (cost === null || cost === 0);
    if (totals === null || (!success && zeroed)) {
      out.usage.push({ semantics: 'cumulative', raw: { ...Object.fromEntries(TOKEN_KEYS.map((k) => [k, null])), usage_final: false, usage_scope: totals === null ? 'absent' : 'zeroed_failure' } });
      return;
    }
    const raw: Record<string, unknown> = { ...totals.tokens, usage_final: true, usage_scope: totals.scope };
    if (cost !== null) raw.total_cost_usd = cost;
    if (totals.models.length > 0) raw.model = totals.models.join(',');
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

// ---- what a canary makes of a stream (D2 §7.2) ------------------------------------

// Whether the stream shows that the backend could not authenticate: the API
// rejected the key (an assistant message or a retry naming
// `authentication_failed`, a result whose API error status is 401), or the
// backend ran with no key at all (`apiKeySource` "none" under `--bare`,
// which takes Anthropic authentication only from ANTHROPIC_API_KEY or an
// apiKeyHelper, and the template passes no helper).
export function claudeAuthFailure(s: ClaudeStreamSummary): string | null {
  if (s.assistant_errors.includes('authentication_failed')) return 'an assistant message carried error authentication_failed';
  if (s.api_retries.some((r) => r.error === 'authentication_failed')) return 'an api_retry event carried error authentication_failed';
  if (s.result?.api_error_status === 401) return 'the result carried api_error_status 401';
  if (s.init?.api_key_source === 'none') return 'the init event reported apiKeySource "none": no API key reached the backend';
  return null;
}

// Whether the backend was authenticated and answered: an assistant message
// carrying no API error, and no sign of an authentication failure.
export function claudeAnswered(s: ClaudeStreamSummary): boolean {
  return claudeAuthFailure(s) === null && s.assistant_messages > s.assistant_errors.length;
}

// What the canaries established about key delivery (D2 §2.5, §4.5): the
// variable the template names, and whether the stream showed the key in it
// in use. Null where the stream did not say.
export function claudeKeyDelivery(s: ClaudeStreamSummary): { variable: string; api_key_source: string | null; established: boolean | null; basis: string } {
  const source = s.init?.api_key_source ?? null;
  if (source === 'ANTHROPIC_API_KEY' && claudeAnswered(s)) return { variable: 'ANTHROPIC_API_KEY', api_key_source: source, established: true, basis: 'init.apiKeySource is ANTHROPIC_API_KEY and the model answered' };
  if (source !== null && source !== 'ANTHROPIC_API_KEY') return { variable: 'ANTHROPIC_API_KEY', api_key_source: source, established: false, basis: `init.apiKeySource is ${source}` };
  return { variable: 'ANTHROPIC_API_KEY', api_key_source: source, established: null, basis: source === null ? 'the stream carried no init.apiKeySource' : 'the model did not answer' };
}

// The structured provider error a failed canary keeps (D2 §7.2, N04): what
// the stream said of the failure, bounded. The caller redacts it before it
// is recorded.
export function claudeProviderError(s: ClaudeStreamSummary): Record<string, unknown> {
  return {
    auth_failure: claudeAuthFailure(s),
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
  background_bash: number;
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
export function claudeCapabilities(summaries: ClaudeStreamSummary[], sampling: BackendSampling | null): ClaudeCapabilities {
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
  if (inventory) {
    basis = 'inventory';
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
  if (backgroundBash > 0) reasons.push(`Bash was asked to run in the background ${backgroundBash} time(s); recorded, judged by the host samples`);
  if (sampling === null || sampling.samples === 0) {
    verified = false;
    reasons.push('no host sample of the domain was read');
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
    background_bash: backgroundBash,
    sampling,
    reasons,
  };
}
