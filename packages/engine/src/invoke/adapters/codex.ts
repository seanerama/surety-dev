// The Codex CLI adapter's stream parsing (D2 §§1.1, 1.5, 1.6, 1.7, 4.6; C1 of
// Codex support, 2026-10-27): the backend's standard output under `codex exec
// --json` turned into the engine's internal callbacks, and a summary of what
// the stream showed for the qualification canaries (judged in C2). Rendering
// the template is `templates.ts`; collection is `collect.ts`; nothing here
// starts a process.
//
// Where the shapes come from. Nothing here was learned by running Codex
// against a model (none may be, outside an attempt Sean approves). The
// shapes are those OpenAI's "Non-interactive mode" page gives for
// `codex exec --json` (learn.chatgpt.com/docs/non-interactive-mode, read
// 2026-10-27) for Codex CLI 0.160.0, one JSON object per line:
//   - `thread.started`: `thread_id`, the provider's id of the run's thread
//     (D2 §1.7: Codex's id is read from the stream, the engine assigns none);
//   - `turn.started`;
//   - `item.started` / `item.updated` / `item.completed`: `item` with `id`,
//     `type` (`agent_message` with `text`, `reasoning`, `command_execution`
//     with `command` and `status`, `file_change`, `mcp_tool_call`,
//     `web_search`, `todo_list`, `error` with `message`), and `status`;
//   - `turn.completed`: `usage` with `input_tokens`, `cached_input_tokens`,
//     `output_tokens`, `reasoning_output_tokens`;
//   - `turn.failed`: `error` with `message`;
//   - `error`: `message`.
// The page documents no exit codes and no cost: the stream carries token
// counts only, so a Codex run's cost is unknown unless a price table prices
// it (none yet: C2). How the counts relate is the Responses API's usage, an
// assumption the positive canary must establish: `input_tokens` includes
// `cached_input_tokens`; `output_tokens` includes `reasoning_output_tokens`.
// Every field is read defensively: a field that is absent or of another type
// is unknown (null), never zero, never success.
//
// `codex exec` runs one turn. Its `turn.completed` (success) or
// `turn.failed` (failure) is the terminal event; the first wins, and a
// second is a protocol error, ignored with what it carried, so that the run
// cannot be clean (E74 item 3). A top-level `error` is recorded and is not
// terminal: a run that ends without a terminal event is never clean.
//
// Everything the stream carries is role output: kept here bounded, and
// redacted by the caller before it reaches a record (D2 §2.5; E37 item 2).

import type { BackendSampling, ClaudeStream } from './claude.js';
import { sameModel } from './model.js';

// The item types that act beyond the domain or delegate (D2 §§4.1, 4.6):
// a provider-side web search never passes Surety's egress proxy; an MCP
// tool call reaches a server the engine did not start; a collaboration call
// is a sub-agent. Any one seen makes the tool surface unverified (C2).
export const CODEX_BEYOND_DOMAIN_ITEMS: Readonly<Record<string, 'provider_tool' | 'external_tool' | 'delegation'>> = {
  web_search: 'provider_tool',
  mcp_tool_call: 'external_tool',
  collab_tool_call: 'delegation',
};

// The programs beside `codex` in its release that act as a second agent
// process (the assessment's G10: 0.160.0's standalone release ships
// `bin/codex-code-mode-host` next to `bin/codex`). The host's sampler
// counts a member running one as a second backend (C2): its own executable
// is another file, so the qualified binary's identity does not catch it.
export const CODEX_COMPANION_PROCESSES: readonly string[] = ['codex-code-mode-host'];

const MAX_LIST = 64;
const MAX_ITEMS = 512;
const MAX_TEXT = 2048;

export interface CodexUsageObservation {
  semantics: 'delta' | 'cumulative';
  raw: Record<string, unknown>;
}

export interface CodexLine {
  usage: CodexUsageObservation[];
  terminal: 'success' | 'failure' | null;
  protocolError: string | null;
}

export type CodexFailureClass = 'auth_failed' | 'usage_limit' | 'provider_error';

export interface CodexStreamSummary {
  backend: 'codex';
  lines: number;
  unparsed: number;
  types: Record<string, number>;
  // The provider's thread id (D2 §1.7), the first `thread.started`'s; null
  // where none was seen.
  thread_id: string | null;
  threads: number;
  turns_started: number;
  items: { id: string | null; type: string; status: string | null }[];
  items_truncated: boolean;
  item_types: Record<string, number>;
  // Items of the kinds in CODEX_BEYOND_DOMAIN_ITEMS, as seen.
  beyond_domain: { id: string | null; type: string; kind: string }[];
  // The last agent message's text, bounded.
  agent_message: string | null;
  // Every model a top-level event named, distinct, bounded (C2's model
  // check). The non-interactive page documents none: empty is "the model
  // was not reported", never "the requested model answered".
  models_seen: string[];
  // Top-level `error` events' and `error` items' messages, bounded.
  errors: string[];
  terminal: { type: 'turn.completed' | 'turn.failed'; error: string | null; usage_present: boolean } | null;
  terminals: number;
  usage: { input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null; reasoning_output_tokens: number | null } | null;
  protocol_errors: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown, max = 256): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

// The message of an `error` object or event, bounded; null where none.
const messageOf = (v: unknown): string | null => (isObject(v) ? str(v.message, MAX_TEXT) : str(v, MAX_TEXT));

export class CodexStream {
  readonly backend = 'codex' as const;
  private readonly s: CodexStreamSummary = {
    backend: 'codex',
    lines: 0,
    unparsed: 0,
    types: {},
    thread_id: null,
    threads: 0,
    turns_started: 0,
    items: [],
    items_truncated: false,
    item_types: {},
    beyond_domain: [],
    agent_message: null,
    models_seen: [],
    errors: [],
    terminal: null,
    terminals: 0,
    usage: null,
    protocol_errors: [],
  };
  private readonly itemIndex = new Map<string, number>();

  // Codex's stream has no line that only reports usage: its usage is on the
  // terminal event, which waits for a pending lease challenge (choke.ts).
  usageOnly(_line: string): boolean {
    return false;
  }

  feed(line: string): CodexLine {
    const out: CodexLine = { usage: [], terminal: null, protocolError: null };
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
    if (Object.keys(this.s.types).length < MAX_LIST || type in this.s.types) this.s.types[type] = (this.s.types[type] ?? 0) + 1;
    const model = str(m.model, 128);
    if (model !== null && model !== '' && !this.s.models_seen.includes(model) && this.s.models_seen.length < MAX_LIST) this.s.models_seen.push(model);
    if (type === 'thread.started') {
      this.s.threads++;
      if (this.s.thread_id === null) this.s.thread_id = str(m.thread_id);
    } else if (type === 'turn.started') this.s.turns_started++;
    else if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') this.item(m.item);
    else if (type === 'error') this.error(messageOf(m));
    else if (type === 'turn.completed' || type === 'turn.failed') this.terminalEvent(type, m, out);
    return out;
  }

  summary(): CodexStreamSummary {
    return structuredClone(this.s);
  }

  private error(message: string | null): void {
    if (message !== null && this.s.errors.length < MAX_LIST) this.s.errors.push(message);
  }

  private item(v: unknown): void {
    if (!isObject(v)) return;
    const type = str(v.type, 64);
    if (type === null) return;
    const id = str(v.id);
    const status = str(v.status, 64);
    if (type === 'agent_message') {
      const text = str(v.text, MAX_TEXT);
      if (text !== null) this.s.agent_message = text;
    }
    if (type === 'error') this.error(messageOf(v));
    const known = id === null ? undefined : this.itemIndex.get(id);
    if (known !== undefined) {
      const it = this.s.items[known]!;
      if (status !== null) it.status = status;
      return;
    }
    if (Object.keys(this.s.item_types).length < MAX_LIST || type in this.s.item_types) this.s.item_types[type] = (this.s.item_types[type] ?? 0) + 1;
    const kind = CODEX_BEYOND_DOMAIN_ITEMS[type];
    if (kind !== undefined && this.s.beyond_domain.length < MAX_LIST) this.s.beyond_domain.push({ id, type, kind });
    if (this.s.items.length >= MAX_ITEMS) {
      this.s.items_truncated = true;
      return;
    }
    if (id !== null) this.itemIndex.set(id, this.s.items.length);
    this.s.items.push({ id, type, status });
  }

  private terminalEvent(type: 'turn.completed' | 'turn.failed', m: Record<string, unknown>, out: CodexLine): void {
    this.s.terminals++;
    if (this.s.terminals > 1) {
      out.protocolError = `a second terminal event (${type}, number ${this.s.terminals}) after the first`;
      if (this.s.protocol_errors.length < MAX_LIST) this.s.protocol_errors.push(out.protocolError);
      return;
    }
    const success = type === 'turn.completed';
    out.terminal = success ? 'success' : 'failure';
    const u = isObject(m.usage) ? m.usage : null;
    const error = success ? null : messageOf(m.error);
    this.s.terminal = { type, error, usage_present: u !== null };
    // The invocation's usage as Codex totals it at the end of its one turn:
    // cumulative, so that it replaces anything before it in the fold. Only
    // the counts it gives are written; it is final only when the three the
    // ledger needs are all known. No usage at all is recorded as absent,
    // never as zero.
    // The model, where the stream named exactly one (the ledger prices only
    // the one model an invocation used).
    const thread = { ...(this.s.thread_id === null ? {} : { thread_id: this.s.thread_id }), ...(this.s.models_seen.length === 1 ? { model: this.s.models_seen[0] } : {}) };
    if (u === null) {
      out.usage.push({ semantics: 'cumulative', raw: { usage_final: false, usage_scope: 'absent', ...thread } });
      return;
    }
    const usage = {
      input_tokens: count(u.input_tokens),
      cached_input_tokens: count(u.cached_input_tokens),
      output_tokens: count(u.output_tokens),
      reasoning_output_tokens: count(u.reasoning_output_tokens),
    };
    this.s.usage = usage;
    const known = Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== null));
    const complete = usage.input_tokens !== null && usage.cached_input_tokens !== null && usage.output_tokens !== null;
    out.usage.push({ semantics: 'cumulative', raw: { ...known, usage_final: complete, usage_scope: 'turn', ...thread } });
  }
}

// The failure the stream names, by the provider's own words (the
// non-interactive page documents no codes): an authentication failure (a
// 401, an invalid or missing key), a usage or rate limit (a 429, a quota),
// or another provider error; null where the stream names none. For C2's
// canary judgement and the run's reason text.
export function codexFailure(s: CodexStreamSummary): { class: CodexFailureClass; message: string } | null {
  const said = [s.terminal?.error ?? null, ...s.errors].filter((x): x is string => x !== null);
  if (said.length === 0) return s.terminal?.type === 'turn.failed' ? { class: 'provider_error', message: 'turn.failed without a message' } : null;
  const auth = said.find((t) => /\b401\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|missing (an )?api key|no api key|authentication/i.test(t));
  if (auth !== undefined) return { class: 'auth_failed', message: auth };
  const limit = said.find((t) => /\b429\b|usage limit|rate limit|insufficient_quota|quota/i.test(t));
  if (limit !== undefined) return { class: 'usage_limit', message: limit };
  return s.terminal?.type === 'turn.failed' ? { class: 'provider_error', message: said[0]! } : null;
}

// The adapter that reads a real backend's stream (D2 §1.1), by backend:
// Claude Code's or Codex's; the scripted protocol (null) for any other.
export type AdapterStream = ClaudeStream | CodexStream;


// ---- what a canary makes of a Codex stream (D2 §7.2; C2 of Codex support) ----------
//
// Codex's stream carries no init event, no key source and no tool inventory
// (the non-interactive page; C1). So each judgement below says what it
// rests on, and an absence it cannot see past is never a pass.

// The authentication failure the stream names (a 401, an invalid or missing
// key), in the provider's words; null where it names none.
export function codexAuthFailure(s: CodexStreamSummary): string | null {
  const f = codexFailure(s);
  return f !== null && f.class === 'auth_failed' ? f.message : null;
}

// Whether the backend was authenticated and answering: no authentication
// failure, and at least one item of the model's own (anything but an
// `error` item) in the stream. For the cancellation canary, killed before
// its turn ends.
export function codexAnswered(s: CodexStreamSummary): boolean {
  return codexAuthFailure(s) === null && s.items.some((i) => i.type !== 'error');
}

// What the stream established about the credential's delivery (D2 §§2.5,
// 4.5; E74 item 3). The engine gives the one held key in both variables the
// template names (CODEX_API_KEY and OPENAI_API_KEY), writes no credential
// file, and the volatile CODEX_HOME holds no login
// (`forced_login_method="api"`, `cli_auth_credentials_store="ephemeral"`).
// So a turn that completed with an agent message and no failure in the
// stream authenticated with that key, by elimination; which of the two
// variables Codex read is not established (the stream does not say), and
// `variable` stays null.
export function codexKeyDelivery(s: CodexStreamSummary, variables: readonly string[]): { variable: null; variables: string[]; established: boolean | null; basis: string } {
  const auth = codexAuthFailure(s);
  const vars = [...variables];
  if (auth !== null) return { variable: null, variables: vars, established: false, basis: `the stream reports an authentication failure: ${auth.slice(0, 240)}` };
  const failed = codexFailure(s);
  if (s.terminal?.type === 'turn.completed' && s.agent_message !== null && failed === null) {
    return {
      variable: null,
      variables: vars,
      established: true,
      basis: `the turn completed (turn.completed) with an agent message and no failure in the stream, and the key in ${vars.join(' and ')} was the only credential the engine gave the backend (by elimination; which of them Codex read is not established)`,
    };
  }
  return {
    variable: null,
    variables: vars,
    established: null,
    basis: s.terminal === null ? 'the stream carried no terminal event' : s.terminal.type === 'turn.failed' ? `the turn failed${failed ? ` (${failed.class})` : ''}` : 'the turn completed with no agent message',
  };
}

// The model the stream reported against the one requested: `not_reported`
// where it named none (never a pass as "verified"), `other` where it named
// another.
export function codexModelReport(s: CodexStreamSummary | null, requested: string): { requested: string; reported: string[]; status: 'same' | 'other' | 'not_reported'; text: string } {
  const reported = s?.models_seen ?? [];
  if (reported.length === 0) return { requested, reported, status: 'not_reported', text: 'model not reported: the stream named no model, so the model that answered is not established' };
  const others = reported.filter((m) => !sameModel(requested, m));
  return others.length > 0
    ? { requested, reported, status: 'other', text: `model_fallback: ${requested} -> ${others.join(', ')} (named in the stream)`.slice(0, 300) }
    : { requested, reported, status: 'same', text: `the stream named ${reported.join(', ')}` };
}

// A model fallback: the stream named a model other than the entry's; null
// where it named none or only the entry's.
export function codexModelFallback(s: CodexStreamSummary | null, requested: string): { text: string; models: string[] } | null {
  const r = codexModelReport(s, requested);
  return r.status === 'other' ? { text: r.text, models: r.reported } : null;
}

// The structured provider error a failed canary keeps (D2 §7.2, N04),
// bounded; the caller redacts it before it is recorded.
export function codexProviderError(s: CodexStreamSummary, authMode: string = 'api_key'): Record<string, unknown> {
  return {
    auth_mode: authMode,
    failure: codexFailure(s),
    terminal: s.terminal,
    errors: s.errors,
    protocol_errors: s.protocol_errors,
    thread_id: s.thread_id,
    lines: s.lines,
    unparsed: s.unparsed,
    types: s.types,
  };
}

export interface CodexCapabilities {
  // Codex's stream gives no tool inventory: nothing is claimed.
  tools: string[];
  inventory: false;
  denied: string[];
  features_disabled: string[];
  delegation_verified: boolean;
  basis: 'stream_and_host' | null;
  // What the template asks to be off (configured, not observed).
  template_disabled: string[];
  beyond_domain: { canary: number; id: string | null; type: string; kind: string }[];
  sampling: BackendSampling | null;
  reasons: string[];
}

// The absence of work beyond the domain (D2 §§4.1, 4.5, 4.6, 7.2), as far as
// Codex lets it be seen: every canary's stream read whole (none missing,
// none truncated) and none showing an item that reaches outside the sandbox
// or delegates (CODEX_BEYOND_DOMAIN_ITEMS), and the host's samples of the
// domains identifying the backend and never a second one (a second `codex`
// or a companion process, CODEX_COMPANION_PROCESSES). The template disables
// web search, sub-agents and the other features (`template_disabled`);
// that is configuration, recorded, and claims nothing. No tool inventory
// exists to list, so `tools`, `denied` and `features_disabled` claim
// nothing either.
export function codexCapabilities(streams: (CodexStreamSummary | null)[], sampling: BackendSampling | null, templateDisabled: readonly string[]): CodexCapabilities {
  const reasons: string[] = [];
  const beyond: CodexCapabilities['beyond_domain'] = [];
  streams.forEach((s, i) => {
    if (s === null) {
      reasons.push(`canary ${i + 1}'s stream was not read`);
      return;
    }
    if (s.items_truncated) reasons.push(`canary ${i + 1}'s stream had more items than were kept, so an item beyond the domain could be among them`);
    for (const b of s.beyond_domain) beyond.push({ canary: i + 1, ...b });
  });
  if (streams.length === 0) reasons.push('no canary stream was read');
  if (beyond.length > 0) reasons.push(`the stream shows ${[...new Set(beyond.map((b) => b.type))].join(', ')}, which acts beyond the domain or delegates`);
  if (sampling === null || sampling.samples === 0) reasons.push('no host sample of the domain was read');
  else if (sampling.max_backend < 1) reasons.push(`the host's ${sampling.samples} sample(s) never identified the backend in its domain, so they establish nothing`);
  else if (sampling.max_backend > 1) reasons.push(`a second backend process appeared in the domain (at most ${sampling.max_backend} at once)`);
  const verified = reasons.length === 0;
  return {
    tools: [],
    inventory: false,
    denied: [],
    features_disabled: [],
    delegation_verified: verified,
    basis: verified ? 'stream_and_host' : null,
    template_disabled: [...templateDisabled],
    beyond_domain: beyond.slice(0, MAX_LIST),
    sampling,
    reasons,
  };
}
