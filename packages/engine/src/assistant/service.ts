import { ActionStore, actionKind } from './actions.js';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../ids.js';
import { redactText, redactValue, scanBytes } from '../records/redact.js';
import { Refusal } from '../refusal.js';
import type { Actor } from '../store/transitions/tx.js';
import { FAKE_USAGE, LIMITS, type AssistantContext, type AssistantRequest, type Conversation, type AssistantMessage, type Evidence, type AssistantLink, type MessageStatus, type PendingUsage, type TurnRef, type ReadTool, type TurnUsage } from './contract.js';
import { type TurnPackage, boundedConversation } from './turn-package.js';
import { ASSISTANT_WHAT_TO_DO } from './what-to-do.js';

type Obj = Record<string, any>;
export type AssistantRead = (name: string, args: Record<string, unknown>) => Promise<unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const invalid = (reason: string) => new Refusal(400, 'invalid_value', reason, 'Use the documented assistant request fields.');
const identifier = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(s);
function fields(v: unknown, keys: string[]): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('Expected an object.');
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw invalid('Unknown assistant request field.');
  return v as Obj;
}
export function parseRequest(value: unknown): AssistantRequest {
  const b = fields(value, ['intent_id', 'text', 'context']);
  if (!identifier(b.intent_id)) throw invalid('intent_id must be a bounded identifier.');
  if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > LIMITS.max_message_chars) throw invalid('text must contain 1 to 4000 characters.');
  const c = fields(b.context, ['project', 'screen', 'candidate', 'gate']);
  if (c.project !== null && !identifier(c.project)) throw invalid('context.project must be null or a project identifier.');
  if (typeof c.screen !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.screen)) throw invalid('context.screen must be a bounded screen name.');
  for (const k of ['candidate', 'gate']) if (c[k] !== undefined && !identifier(c[k])) throw invalid(`context.${k} must be a bounded identifier.`);
  if ((c.candidate || c.gate) && c.project === null) throw invalid('A candidate or gate requires a bound project.');
  return { intent_id: b.intent_id, text: b.text, context: { project: c.project, screen: c.screen, ...(c.candidate ? { candidate: c.candidate } : {}), ...(c.gate ? { gate: c.gate } : {}) } };
}

// Text is sanitized before persistence, before the provider boundary and again on
// reads. The API token is not necessarily in the engine's held-secret registry.
export function safeValue<T>(value: T, token: string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let s = redactText(v);
      if (token) for (const form of [token, Buffer.from(token).toString('base64'), encodeURIComponent(token)]) {
        s = s.split(form).join('[REDACTED]');
        const decoded = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex,16)));
        if (decoded.includes(form)) s = '[REDACTED: encoded token]';
      }
      if (scanBytes(Buffer.from(s)).hit) return '[REDACTED: secret detector]';
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [String(walk(k)), /^(authorization|token|api_key|secret|password|credential_value)$/i.test(k) ? '[REDACTED]' : walk(x)]));
    return v;
  };
  return walk(redactValue(value)) as T;
}

export class ToolGateway {
  readonly evidence: Evidence[] = [];
  private calls = 0;
  private chars = 0;
  constructor(private readonly read: AssistantRead, private readonly context: AssistantContext, private readonly token: string) {}
  async invoke(tool: ReadTool, name: string, args: Record<string, unknown>, source: string): Promise<Obj> {
    if (!['attention', 'gate'].includes(tool)) throw new Refusal(403, 'assistant_tool_refused', 'Unknown assistant tool.', 'Use a supported read.');
    if (this.context.candidate && args.candidate !== undefined && args.candidate !== this.context.candidate) throw new Refusal(403, 'assistant_scope_refused', 'Candidate differs from the submitted context.', 'Submit a new request for that candidate.');
    const argKeys = name === 'candidate.gate' ? ['project','candidate','kind'] : name.startsWith('candidate.') ? ['project','candidate'] : ['projects.list','decisions.engine'].includes(name) ? [] : ['project'];
    fields(args, argKeys);
    for (const key of argKeys) if (!identifier(args[key])) throw invalid(`Invalid tool argument: ${key}.`);
    const allowed = tool === 'attention' ? ['projects.list', 'project.read', 'decisions.engine', 'decisions.open', 'work.list'] : ['project.read', 'candidate.read', 'candidate.gate', 'candidate.executions'];
    if (!allowed.includes(name)) throw new Refusal(403, 'assistant_tool_refused', 'The assistant cannot use this tool.', 'Use a supported read.');
    if (this.context.project !== null && args.project !== undefined && args.project !== this.context.project) throw new Refusal(403, 'assistant_scope_refused', 'The tool target differs from the submitted context.', 'Submit a new request in the intended app.');
    if (++this.calls > LIMITS.max_tool_calls) throw new Refusal(429, 'assistant_limit', 'The assistant read limit was reached.', 'Choose one app to narrow the question.');
    const scope = { project: typeof args.project === 'string' ? args.project : null, ...(typeof args.candidate === 'string' ? { candidate: args.candidate } : {}) };
    const base = { id: newId('ae_'), tool, scope, source, read_at: new Date().toISOString(), served_at: null, snapshot_seq: null, freshness: null };
    try {
      const data = safeValue(obj(await this.read(name, args)), this.token);
      const size = JSON.stringify(data).length;
      if (this.chars + size > LIMITS.max_evidence_chars) throw new Refusal(429, 'assistant_result_limit', 'The engine read exceeds the assistant evidence limit.', 'Choose one app or a specific gate; no partial read is treated as complete.');
      this.chars += size;
      this.evidence.push({ ...base, served_at: typeof data.served_at === 'string' ? data.served_at : null, snapshot_seq: typeof data.snapshot_seq === 'number' ? data.snapshot_seq : null, freshness: typeof data.freshness === 'string' ? data.freshness : data.evaluation?.stale === true ? 'stale' : null, data });
      return data;
    } catch (e) {
      const error = safeValue(e instanceof Refusal ? e.body() : { code: 'read_failed', reason: 'The engine read failed; its state is unknown.', what_to_do: 'Inspect the ordinary workspace controls.' }, this.token);
      this.evidence.push({ ...base, data: null, error });
      return { error };
    }
  }
}

// Deterministic provider: only the owner message chooses a read. Tool strings
// never become instructions, tool arguments, links or owner authorization.
export async function fakeReply(req: AssistantRequest, gateway: ToolGateway): Promise<{ text: string; links: AssistantLink[] }> {
  const links: AssistantLink[] = [];
  const lines: string[] = [];
  const p = req.context.project;
  const projectLink = (project: string, suffix = '') => `#/w/app/${encodeURIComponent(project)}${suffix}`;
  if (/\bgate\b/i.test(req.text)) {
    if (!p || !req.context.candidate) return { text: 'Choose a candidate in Checks & gates so I can explain the exact evaluation. I cannot infer which candidate you mean from an app name.', links: p ? [{ label: 'Open checks and gates', href: `#/p/${encodeURIComponent(p)}/checks` }] : [] };
    const c = req.context.candidate;
    const base = `/v1/projects/${encodeURIComponent(p)}/candidates/${encodeURIComponent(c)}`;
    const candidate = await gateway.invoke('gate', 'candidate.read', { project: p, candidate: c }, base);
    if (candidate.error) return { text: `Candidate ${c}: ${candidate.error.reason}`, links: [] };
    const gates = obj(candidate.candidate?.gates);
    const kind = req.context.gate ?? (Object.keys(gates).length === 1 ? Object.keys(gates)[0] : undefined);
    if (!kind) return { text: `Candidate ${c} has ${Object.keys(gates).length} recorded gate kinds. Select the gate to explain; I will not assume a latest evaluation.`, links: [{ label: 'Inspect candidate gates', href: `#/p/${encodeURIComponent(p)}/checks/${encodeURIComponent(c)}` }] };
    const gate = await gateway.invoke('gate', 'candidate.gate', { project: p, candidate: c, kind }, `${base}/gates/${encodeURIComponent(kind)}`);
    const checks = await gateway.invoke('gate', 'candidate.executions', { project: p, candidate: c }, `${base}/checks`);
    lines.push(`Candidate ${c} · ${kind}`);
    if (gate.error) lines.push(gate.error.reason);
    else {
      const e = obj(gate.evaluation);
      lines.push(`Recorded outcome: ${e.outcome ?? 'unknown'}${e.stale === true ? ' (stale; this does not establish current readiness)' : ''}.`);
      for (const reason of e.reasons ?? []) lines.push(`Engine reason: ${reason.code}; subjects: ${(reason.subjects ?? []).join(', ') || 'none supplied'}.`);
      for (const [name, state] of Object.entries(obj(e.check_states))) lines.push(`${name}: ${typeof state === 'string' ? state : JSON.stringify(state)}.`);
      for (const m of e.missing_verifications ?? []) lines.push(`Missing verification: ${JSON.stringify(m)}.`);
      if (!(e.reasons ?? []).length && e.outcome !== 'satisfied') lines.push('The engine supplies no further cause; the unblock condition is unknown.');
    }
    if (checks.error) lines.push(`Check results unavailable: ${checks.error.reason}`);
    else for (const x of checks.executions ?? []) lines.push(`Check ${x.check ?? x.key ?? x.id ?? 'unknown'}: ${x.status ?? 'unknown'}${x.not_run_reason ? `; ${JSON.stringify(x.not_run_reason)}` : ''}.`);
    links.push({ label: 'Inspect candidate and gate', href: `#/p/${encodeURIComponent(p)}/checks/${encodeURIComponent(c)}` });
  } else if (/\b(waiting|attention|running|stuck|status|needs?|hold|approval)\b/i.test(req.text)) {
    const engine = await gateway.invoke('attention', 'decisions.engine', {}, '/v1/decisions');
    lines.push('Workspace questions');
    if (engine.error) lines.push(`Unknown: ${engine.error.reason}`);
    else if (!Array.isArray(engine.decisions)) lines.push('The engine did not supply its decision list.');
    else if (!engine.decisions.length) lines.push('No open workspace questions in this read.');
    else for (const d of engine.decisions) { lines.push(`Action needed: ${d.question}`); links.push({ label: 'Review workspace approval', href: `#/engine/d/${encodeURIComponent(d.id)}` }); }
    let projects: Obj[];
    if (p) projects = [{ id: p }];
    else {
      const list = await gateway.invoke('attention', 'projects.list', {}, '/v1/projects');
      if (list.error) { lines.push(`Apps unknown: ${list.error.reason}`); projects = []; }
      else projects = Array.isArray(list.projects) ? list.projects : [];
    }
    // Each app needs three reads; never present an omitted app as all-clear.
    if (projects.length > 4) lines.push(`Showing the first 4 of ${projects.length} apps. Choose an app for its complete attention summary.`);
    for (const row of projects.slice(0, 4)) {
      if (!identifier(row.id)) continue;
      const id = row.id;
      const base = `/v1/projects/${encodeURIComponent(id)}`;
      const detail = await gateway.invoke('attention', 'project.read', { project: id }, base);
      const project = obj(detail.project);
      lines.push(`\n${project.name ?? id}`);
      if (detail.error) lines.push(`Status unknown: ${detail.error.reason}`);
      else lines.push(`Current engine state: ${project.now?.state ?? 'unknown'}. ${project.now?.reason ?? 'The engine gives no reason.'}`);
      const decisions = await gateway.invoke('attention', 'decisions.open', { project: id }, `${base}/decisions`);
      if (decisions.error) lines.push(`Questions unknown: ${decisions.error.reason}`);
      else if (!Array.isArray(decisions.decisions)) lines.push('The engine did not supply this app’s decision list.');
      else if (!decisions.decisions.length) lines.push('No open owner questions in this read.');
      else for (const d of decisions.decisions) { lines.push(`Action needed: ${d.question}`); links.push({ label: `Review ${project.name ?? id} approval`, href: projectLink(id, `/approvals/${encodeURIComponent(d.id)}`) }); }
      const work = await gateway.invoke('attention', 'work.list', { project: id }, `${base}/work`);
      if (work.error) lines.push(`Work unknown: ${work.error.reason}`);
      else for (const w of work.work_items ?? []) if (['held', 'parked', 'awaiting_decision'].includes(w.status) || w.blocker || w.dispatch_hold) lines.push(`Waiting work (${w.status}): ${w.held?.reason ?? w.blocker?.reason ?? w.dispatch_hold?.reason ?? 'The API does not explain the cause.'}`);
      links.push({ label: `Open ${project.name ?? id}`, href: projectLink(id, '/build') });
    }
  } else {
    lines.push('This deterministic demo can answer “What is waiting on me?” and “Explain this gate” from current engine reads. Approvals remain owner actions in the workspace.');
  }
  return { text: lines.join('\n\n'), links };
}


// What the conversation keeps of each real turn beside its messages (never
// served): its invocation and deadline once admitted, and the evidence the
// engine's reads returned before the admission, which its reply is shown
// with. Kept on disk, so a turn that ends after a restart is written as one
// that ends in the incarnation that admitted it.
interface TurnMeta { invocation: string | null; deadline_at: string | null; evidence: Evidence[]; request_id: string | null }
interface StoredConversation extends Conversation { requests: Record<string, string>; turns?: Record<string, TurnMeta> }

// The real path's port (assistant/real.ts): the state from real
// configuration and the turn itself, admitted in the store and run through
// the choke point.
export interface TurnRead {
  invocation: string; conversation: string; intent_id: string; status: string; outcome: string | null; reason: string | null; reason_text: string | null;
  // The incarnation that owns the turn's domain, and the turn's deadline.
  incarnation: string | null; deadline_at: string | null;
  reply: { text: string; cited_evidence: string[]; links: AssistantLink[]; commentary?: boolean } | null;
  usage: Omit<TurnUsage, 'account'> & { account: 'workspace_assistant' } | null;
}
export interface RealAssistantPort {
  state(): Promise<Record<string, unknown>>;
  admit(args: { conversation: string; intent_id: string; pkg: TurnPackage; actor: Actor }): Promise<{ invocation: string; deadline_at: string; backend: string }>;
  turn(args: { invocation: string } | { conversation: string; intent_id: string }): Promise<TurnRead | null>;
  cancel(args: { conversation: string; intent_id: string; actor: Actor }): Promise<{ invocation: string; status: string } | null>;
  onSettled(fn: (invocation: string) => Promise<void>): boolean;
  provider(): { provider: string; model: string };
  incarnation(): string | null;
}

// The answer to a message request, and to each repeat of it: the intent's
// current state (the usability batch's decision 1).
export interface MessageAnswer { conversation: Conversation; message: AssistantMessage | null; turn: TurnRef | null; reply: AssistantMessage | null }

const RETENTION = 'engine-owned; explicit deletion';
const ACTIONS = ['create_app', 'start_planning'];
// A turn whose end is not yet written into its conversation.
const OPEN: readonly MessageStatus[] = ['running', 'unknown'];

const busyRefusal = () => new Refusal(409, 'assistant_busy', 'A response is already running in this conversation.', 'Wait for it to settle; do not replay the request. Its state is on the conversation.');

export class AssistantService {
  private readonly dir: string;
  // The conversations whose message is being admitted now (the owner
  // message written, the reads and the admission under way).
  private readonly busy = new Set<string>();
  private readonly actions: ActionStore;
  private hooked = false;
  // `scriptedProvider`: the in-process deterministic fake, which only the
  // engine's test mode selects and only when config.json has no
  // workspace_assistant block. `real`: the real path, present exactly when
  // the block is (the assistant design §2).
  constructor(home: string, private readonly scriptedProvider: boolean, private readonly read: AssistantRead, private readonly token: string, private readonly real: RealAssistantPort | null = null) { this.dir = join(home, 'assistant'); this.actions = new ActionStore(home, v => safeValue(v, token)); }

  // GET /v1/assistant (the assistant design §2): version 1, `state` and
  // `configured` derived from real configuration on each read.
  async capability(): Promise<Record<string, unknown>> {
    if (this.real) {
      this.hook();
      const body = await this.real.state();
      const configured = body.configured === true;
      return { version: 1, ...body, limits: LIMITS, retention: RETENTION, actions: configured ? ACTIONS : [] };
    }
    if (this.scriptedProvider) {
      return {
        version: 1, state: 'ready', configured: true,
        reason: 'The engine is in its test mode with no workspace_assistant block: the deterministic in-process fake answers, with no model, no provider process and no account.',
        what_to_do: 'Ask "What is waiting on me?" or "Explain this gate".',
        provider: 'fake', model: null, qualification: null, account: null, trust_entry: null,
        limits: LIMITS, retention: RETENTION, actions: ACTIONS,
      };
    }
    return {
      version: 1, state: 'unconfigured', configured: false,
      reason: 'Assistant not configured: config.json has no workspace_assistant block, so no real assistant path is reachable and nothing is charged.',
      what_to_do: 'Continue using the ordinary workspace controls. To enable the assistant, write the whole workspace_assistant block into config.json and restart the engine.',
      provider: 'unconfigured', model: null, qualification: null, account: null, trust_entry: null,
      limits: LIMITS, retention: RETENTION, actions: [],
    };
  }
  private configured() { if (!this.scriptedProvider && !this.real) throw new Refusal(503, 'assistant_not_configured', 'Assistant not configured. Real assistant execution and accounting are not enabled.', 'Continue using the ordinary workspace controls.'); }
  private path(id: string) { if (!/^ac_[A-Z0-9]{26}$/.test(id)) throw invalid('Invalid conversation identifier.'); return join(this.dir, `${id}.json`); }
  private load(id: string): StoredConversation {
    const path = this.path(id);
    if (!existsSync(path)) throw new Refusal(404, 'not_found', 'The assistant conversation does not exist.', 'Open an existing conversation or create one.');
    return safeValue(JSON.parse(readFileSync(path, 'utf8')), this.token) as StoredConversation;
  }
  private save(c: StoredConversation) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = this.path(c.id); const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(safeValue(c, this.token)), { mode: 0o600 });
    const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const dir = openSync(this.dir, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  // The conversation as served: each owner message with its turn (the
  // coordinator's addition of 2026-10-27: a client never builds a route).
  private public(c: StoredConversation): Conversation {
    const { requests: _, turns: __, ...out } = c;
    return { ...out, messages: out.messages.map(m => (m.role === 'user' ? { ...m, turn: this.turnRef(c, m) } : m)) };
  }
  private turnRef(c: StoredConversation, owner: AssistantMessage): TurnRef | null {
    if (!this.real) return { id: null, status: owner.status, deadline_at: null, cancel: null };
    const meta = c.turns?.[owner.intent_id];
    const invocation = owner.invocation ?? meta?.invocation ?? null;
    if (invocation === null) return null;
    return { id: invocation, status: owner.status, deadline_at: meta?.deadline_at ?? null, cancel: owner.status === 'running' ? this.cancelPath(c.id, owner.id) : null };
  }
  list() {
    this.configured();
    const conversations = existsSync(this.dir) ? readdirSync(this.dir).filter(n => /^ac_[A-Z0-9]{26}\.json$/.test(n)).map(n => this.load(n.slice(0, -5))).map(c => ({ id: c.id, created_at: c.created_at, updated_at: c.updated_at, message_count: c.messages.length })).sort((a, b) => b.updated_at.localeCompare(a.updated_at)) : [];
    return { conversations };
  }
  create(body: unknown) {
    this.configured(); fields(body, []);
    if (this.list().conversations.length >= LIMITS.max_conversations) throw new Refusal(429, 'assistant_limit', 'The conversation limit was reached.', 'Delete an old assistant conversation before creating another.');
    const now = new Date().toISOString();
    const c: StoredConversation = { id: newId('ac_'), created_at: now, updated_at: now, messages: [], requests: {}, turns: {} };
    this.save(c); return { conversation: this.public(c) };
  }
  // GET /v1/assistant/conversations/:id: each turn's end written first, so
  // the read is the outcome (the usability batch's decision 1).
  async get(id: string) { this.configured(); await this.reconcile(id); return { conversation: this.public(this.load(id)) }; }
  async delete(id: string) {
    this.configured(); await this.reconcile(id);
    const c = this.load(id);
    if (this.busy.has(id) || c.messages.some(m => m.role === 'user' && OPEN.includes(m.status))) throw new Refusal(409, 'assistant_busy', 'A response is still running.', 'Wait for it to settle before deleting.');
    if (this.actions.list(id).receipts.some(a => ['claimed','partial','unknown'].includes(a.status))) throw new Refusal(409, 'assistant_action_unsettled', 'This conversation has an unresolved action receipt and cannot yet be deleted.', 'Inspect the receipt and current app in the workspace. No action will be replayed.');
    unlinkSync(this.path(id)); return { deleted: id };
  }
  allActions() { this.configured(); return this.actions.list(); }
  listActions(id: string) { this.configured(); this.load(id); return this.actions.list(id); }
  claimAction(id: string, value: unknown, actor: Actor) {
    this.configured(); const c=this.load(id); const intent=obj(value).intent_id;
    const message=c.messages.find(m=>m.role==='user'&&m.intent_id===intent);
    if(!message) throw new Refusal(403,'assistant_authorization_refused','No matching owner message exists.','Submit an explicit action request.');
    return this.actions.claim(id,message,value,actor);
  }
  actionStep(id:string, action:string, value:unknown) { this.configured(); this.load(id); return this.actions.step(id,action,value); }
  actionResult(id:string, action:string, value:unknown) { this.configured(); this.load(id); return this.actions.result(id,action,value); }

  // An owner message's usage before its turn is charged: the configured
  // backend and model, never "unconfigured" while a block exists.
  private pendingUsage(): PendingUsage {
    const p = this.real ? this.real.provider() : null;
    return { account: 'workspace_assistant', provider: p?.provider ?? 'unconfigured', model: p?.model ?? null, cost_status: 'unknown', cost_usd: null, input_tokens: null, output_tokens: null, charged: false };
  }
  private cancelPath(conversation: string, message: string) { return `/v1/assistant/conversations/${encodeURIComponent(conversation)}/messages/${encodeURIComponent(message)}/cancel`; }

  // The intent's current state: 202 while its turn is under way, 200 once
  // its end (or its refusal) is written, or while it is unknown.
  private answer(c: StoredConversation, intent: string): { status: number; body: MessageAnswer } {
    const conversation = this.public(c);
    const owner = conversation.messages.find(m => m.intent_id === intent && m.role === 'user') ?? null;
    const reply = conversation.messages.find(m => m.intent_id === intent && m.role === 'assistant') ?? null;
    return { status: owner?.status === 'running' ? 202 : 200, body: { conversation, message: owner, turn: owner?.turn ?? null, reply } };
  }

  // POST /v1/assistant/conversations/:id/messages. The fake answers at once
  // (200, its reply present); the real path answers 202 at the admission.
  async message(id: string, value: unknown, actor: Actor): Promise<{ status: number; body: MessageAnswer }> {
    this.configured();
    if (this.real) return this.realMessage(id, value, actor);
    const raw = parseRequest(value);
    const fingerprint = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
    const req = safeValue(raw, this.token);
    await this.reconcile(id);
    let c = this.load(id);
    if (c.requests[req.intent_id]) {
      if (c.requests[req.intent_id] !== fingerprint) throw new Refusal(409, 'assistant_intent_conflict', 'This intent identifier already names a different message or context.', 'Use a new intent identifier for a new owner request.');
      return this.answer(c, req.intent_id);
    }
    if (this.busy.has(id)) throw busyRefusal();
    if (c.messages.length + 2 > LIMITS.max_messages) throw new Refusal(429, 'assistant_limit', 'The conversation message limit was reached.', 'Start a new assistant conversation.');
    if (this.busy.size >= 2) throw new Refusal(429, 'assistant_limit', 'The assistant concurrency limit was reached.', 'Wait for a current response to settle.');
    this.busy.add(id);
    try {
      const at = new Date().toISOString();
      const human: AssistantMessage = { id: newId('am_'), intent_id: req.intent_id, role: 'user', text: req.text, context: req.context, created_at: at, status: 'running', evidence: [], links: [], usage: FAKE_USAGE, actor: { kind: 'human', request_id: actor.request_id } };
      c.requests[req.intent_id] = fingerprint; c.messages.push(human); c.updated_at = at; this.save(c);
      const gateway = new ToolGateway(this.read, req.context, this.token);
      let result: { text: string; links: AssistantLink[] }; let status: MessageStatus = 'completed';
      try { result = await fakeReply(req, gateway); }
      catch { result = { text: 'The assistant could not complete this read. Its outcome is unknown; use the workspace to inspect current state.', links: [] }; status = 'failed'; }
      let actions: AssistantMessage['actions'] = [];
      const kind = actionKind(req.text);
      if(kind==='create_app') {
        // This is a draft only. Missing inputs are supplied by an explicit owner
        // form submission; generated text cannot submit that form.
        const match=req.text.match(/(?:app|project)\s+(?:called\s+|named\s+)?([^:]+):\s*([\s\S]+)/i);
        const brief=req.text.match(/(?:app|project)\s*:\s*([\s\S]+)/i);
        actions=[{kind,draft:match?{name:match[1]!.trim(),idea:match[2]!.trim()}:brief?{idea:brief[1]!.trim()}:{}}];
        result={text:'Create a paused app from your brief. Supply the missing name, description, review tier and folder in the form. Creating an app does not start planning.',links:[]};
      } else if(kind==='start_planning' && req.context.project) {
        actions=[{kind,project:req.context.project}];
        result={text:'Start planning uses the saved app description and starts Vision model work through the existing workspace controls. The engine still enforces its approvals and limits.',links:[]};
      }
      const message: AssistantMessage = safeValue({ id: newId('am_'), intent_id: req.intent_id, role: 'assistant', text: result.text, context: req.context, created_at: new Date().toISOString(), status, evidence: gateway.evidence, links: result.links, actions, usage: FAKE_USAGE, actor: { kind: 'assistant', request_id: actor.request_id } }, this.token);
      c = this.load(id); const ownerMessage = c.messages.find(m => m.intent_id === req.intent_id && m.role === 'user'); if (ownerMessage) ownerMessage.status = status; c.messages.push(message); c.updated_at = message.created_at; this.save(c);
      return this.answer(c, req.intent_id);
    } finally { this.busy.delete(id); }
  }

  private hook() {
    if (this.real && !this.hooked) this.hooked = this.real.onSettled(async (invocation) => { await this.recordTurn(invocation); });
  }

  // Every owner message whose turn's end is not yet written, settled from
  // the store (the usability batch's decisions 2 and 3): an ended turn's end
  // written; a turn under way in this incarnation `running`; a turn another
  // incarnation owns, not yet ended by recovery, `unknown`; a message whose
  // admission was never made (the engine stopped between writing it and
  // admitting it: no receipt, nothing charged) `interrupted`. The fake's
  // message whose reply was never written (the engine stopped while it
  // answered) is `interrupted` too. Each write is a load, change and save
  // with no wait between.
  private async reconcile(id: string): Promise<void> {
    const open = this.load(id).messages.filter(m => m.role === 'user' && OPEN.includes(m.status));
    for (const m of open) {
      if (!this.real) {
        if (m.status !== 'running' || this.busy.has(id)) continue;
        this.settleOwner(id, m.intent_id, (owner) => this.interrupt(owner, 'not_completed', 'The engine stopped while the deterministic fake answered; nothing is replayed.', FAKE_USAGE));
        continue;
      }
      // A message whose admission is being made now has no turn yet.
      const admitting = this.busy.has(id);
      let found: TurnRead | null;
      try { found = await this.real.turn({ conversation: id, intent_id: m.intent_id }); }
      catch { continue; }
      const turn = found;
      if (turn === null) {
        if (admitting) continue;
        // Written and never admitted (its refusal is written as such): the
        // engine stopped between writing it and admitting it.
        const c = this.load(id);
        const owner = c.messages.find(x => x.intent_id === m.intent_id && x.role === 'user');
        if (!owner || !OPEN.includes(owner.status) || owner.invocation !== undefined || (c.turns?.[m.intent_id]?.invocation ?? null) !== null) continue;
        this.interrupt(owner, 'not_admitted', 'The engine stopped before this message was admitted: no turn ran and nothing was charged.', this.pendingUsage());
        c.updated_at = new Date().toISOString(); this.save(c);
        continue;
      }
      if (turn.status === 'ended') { this.applyEnd(turn); continue; }
      const current = this.real.incarnation();
      const status: MessageStatus = current !== null && turn.incarnation === current ? 'running' : 'unknown';
      this.settleOwner(id, m.intent_id, (owner) => { if (OPEN.includes(owner.status)) { owner.status = status; owner.invocation = turn.invocation; } });
    }
  }

  // One load, change and save of an owner message.
  private settleOwner(id: string, intent: string, change: (owner: AssistantMessage) => void) {
    let c: StoredConversation;
    try { c = this.load(id); } catch { return; }
    const owner = c.messages.find(m => m.intent_id === intent && m.role === 'user');
    if (!owner) return;
    const before = JSON.stringify(owner);
    change(owner);
    if (JSON.stringify(owner) !== before) { c.updated_at = new Date().toISOString(); this.save(c); }
  }

  private interrupt(owner: AssistantMessage, outcome: string, reason: string, usage: AssistantMessage['usage']) {
    owner.status = 'interrupted';
    owner.error = { code: 'assistant_interrupted', reason, what_to_do: ASSISTANT_WHAT_TO_DO.assistant_interrupted!, outcome };
    owner.usage = usage;
  }

  // A message on the real path (the assistant design §§1.3, 4; the usability
  // batch's decision 1): the reads chosen by the engine, the turn admitted
  // in the store's transaction (with the state's code refused unless ready),
  // and the answer given at the admission, 202, with the turn's identifier
  // and its cancel route. The turn is dispatched by the tick through the
  // choke point, and its end written into the conversation when it comes. A
  // message is never replayed: an intent names one turn.
  private async realMessage(id: string, value: unknown, actor: Actor): Promise<{ status: number; body: MessageAnswer }> {
    const real = this.real!;
    this.hook();
    const raw = parseRequest(value);
    const fingerprint = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
    const req = safeValue(raw, this.token);
    await this.reconcile(id);
    let c = this.load(id);
    if (c.requests[req.intent_id]) {
      if (c.requests[req.intent_id] !== fingerprint) throw new Refusal(409, 'assistant_intent_conflict', 'This intent identifier already names a different message or context.', 'Use a new intent identifier for a new owner request.');
      return this.answer(c, req.intent_id);
    }
    if (this.busy.has(id) || c.messages.some(m => m.role === 'user' && OPEN.includes(m.status))) throw busyRefusal();
    if (c.messages.length + 2 > LIMITS.max_messages) throw new Refusal(429, 'assistant_limit', 'The conversation message limit was reached.', 'Start a new assistant conversation.');
    if (this.busy.size >= 2) throw new Refusal(429, 'assistant_limit', 'The assistant concurrency limit was reached.', 'Wait for a current response to settle.');
    this.busy.add(id);
    try {
      const at = new Date().toISOString();
      const prior = c.messages.map(m => ({ role: m.role, text: m.text, created_at: m.created_at }));
      const human: AssistantMessage = { id: newId('am_'), intent_id: req.intent_id, role: 'user', text: req.text, context: req.context, created_at: at, status: 'running', evidence: [], links: [], usage: this.pendingUsage(), actor: { kind: 'human', request_id: actor.request_id } };
      c.requests[req.intent_id] = fingerprint; c.messages.push(human); c.turns = { ...(c.turns ?? {}), [req.intent_id]: { invocation: null, deadline_at: null, evidence: [], request_id: actor.request_id } }; c.updated_at = at; this.save(c);
      // The engine chooses the reads (O5): the gateway's deterministic
      // routing from the message's screen, candidate and gate context and the
      // two supported question kinds, made now; the model reads only what
      // they returned. Their summary text is never used.
      const gateway = new ToolGateway(this.read, req.context, this.token);
      try { await fakeReply(req, gateway); } catch { /* each failed read is its own error evidence */ }
      c = this.load(id); c.turns![req.intent_id]!.evidence = gateway.evidence; this.save(c);
      const pkg: TurnPackage = { request: { intent_id: req.intent_id, text: req.text, context: req.context }, evidence: gateway.evidence, conversation: boundedConversation(prior) };
      let admitted: { invocation: string; deadline_at: string; backend: string };
      try {
        admitted = await real.admit({ conversation: id, intent_id: req.intent_id, pkg, actor });
      } catch (err) {
        // A refused admission writes no receipt and charges nothing; the
        // owner's message is `refused` with the refusal, and the draft is the
        // console's to keep.
        const r = err instanceof Refusal ? err : new Refusal(503, 'assistant_state_unavailable', 'The admission could not be made; the assistant is not ready.', 'Retry shortly.', {});
        this.settleOwner(id, req.intent_id, (owner) => { owner.status = 'refused'; owner.error = safeValue({ code: r.code, reason: r.reason, what_to_do: r.whatToDo, outcome: 'refused' }, this.token); });
        throw r;
      }
      c = this.load(id);
      const owner = c.messages.find(m => m.intent_id === req.intent_id && m.role === 'user');
      if (owner && owner.invocation === undefined) owner.invocation = admitted.invocation;
      c.turns![req.intent_id] = { ...c.turns![req.intent_id]!, invocation: admitted.invocation, deadline_at: admitted.deadline_at };
      this.save(c);
      return this.answer(c, req.intent_id);
    } finally { this.busy.delete(id); }
  }

  // An ended turn's end, written into its conversation once (the turn's own
  // end and each read call this): the owner message's status, error and
  // charged usage; the reply (or the account of why there is none), except
  // for a turn recovery ended, which is `interrupted` and has none.
  private async recordTurn(invocation: string): Promise<void> {
    const turn = await this.real!.turn({ invocation });
    if (turn === null || turn.status !== 'ended') return;
    this.applyEnd(turn);
  }

  private applyEnd(turn: TurnRead): void {
    let c: StoredConversation;
    try { c = this.load(turn.conversation); } catch { return; }
    const owner = c.messages.find(m => m.intent_id === turn.intent_id && m.role === 'user');
    if (!owner || !OPEN.includes(owner.status)) return;
    if (c.messages.some(m => m.intent_id === turn.intent_id && m.role === 'assistant')) return;
    const meta = c.turns?.[turn.intent_id];
    const usage: AssistantMessage['usage'] = turn.usage === null ? this.pendingUsage() : { ...turn.usage, account: 'workspace_assistant', charged: true };
    owner.invocation = turn.invocation;
    owner.usage = usage;
    const at = new Date().toISOString();
    if (turn.reason === 'recovered' || turn.outcome === 'recovered') {
      this.interrupt(owner, 'recovered', turn.reason_text ?? 'the engine restarted while the turn ran; it is never replayed', usage);
      c.updated_at = at; this.save(c);
      return;
    }
    const completed = turn.outcome === 'completed' && turn.reply !== null;
    const reason = turn.reason ?? 'infra_error';
    const status: MessageStatus = completed ? 'completed'
      : reason === 'assistant_cancelled' || turn.outcome === 'stopped' ? 'stopped'
      : turn.outcome === 'timed_out' ? 'timed_out'
      : turn.outcome === 'refused' ? 'refused'
      : 'failed';
    const error = completed ? undefined : { code: reason, reason: turn.reason_text ?? reason, what_to_do: ASSISTANT_WHAT_TO_DO[reason] ?? ASSISTANT_WHAT_TO_DO.infra_error!, outcome: turn.outcome ?? 'unknown' };
    let actions: AssistantMessage['actions'] = [];
    // Action cards come only from the owner's own message (contract.md,
    // "Action bridge"); the model's text never yields one.
    const kind = actionKind(owner.text);
    if (kind === 'create_app') {
      const match = owner.text.match(/(?:app|project)\s+(?:called\s+|named\s+)?([^:]+):\s*([\s\S]+)/i);
      const brief = owner.text.match(/(?:app|project)\s*:\s*([\s\S]+)/i);
      actions = [{ kind, draft: match ? { name: match[1]!.trim(), idea: match[2]!.trim() } : brief ? { idea: brief[1]!.trim() } : {} }];
    } else if (kind === 'start_planning' && owner.context.project) actions = [{ kind, project: owner.context.project }];
    const message: AssistantMessage = safeValue({
      id: newId('am_'), intent_id: turn.intent_id, role: 'assistant',
      text: completed ? turn.reply!.text : `The assistant did not complete this turn: ${turn.reason_text ?? reason}.`,
      context: owner.context, created_at: at, status,
      evidence: meta?.evidence ?? [], links: completed ? turn.reply!.links : [], actions, usage,
      actor: { kind: 'assistant', request_id: meta?.request_id ?? null }, invocation: turn.invocation,
      ...(completed ? { cited_evidence: turn.reply!.cited_evidence, commentary: turn.reply!.cited_evidence.length === 0 } : { error }),
    } as AssistantMessage, this.token);
    owner.status = status;
    if (error) owner.error = safeValue(error, this.token);
    c.messages.push(message); c.updated_at = at; this.save(c);
  }

  // POST /v1/assistant/conversations/:id/messages/:message/cancel (the
  // assistant design §4; the usability batch's decision 1): the owner's
  // cancel of a turn from its admission until it ends; `stopped`, its usage
  // charged as observed with the allowance (or nothing, if nothing was
  // launched). It never resends the message.
  async cancel(id: string, messageId: string, actor: Actor) {
    this.configured();
    if (!this.real) throw new Refusal(409, 'assistant_cancel_refused', 'Only a real assistant turn can be cancelled; the deterministic fake answers at once.', 'Nothing to cancel.');
    const c = this.load(id);
    const m = c.messages.find(x => x.id === messageId);
    if (!m) throw new Refusal(404, 'not_found', 'The assistant message does not exist.', 'Name an owner message of this conversation.');
    const r = await this.real.cancel({ conversation: id, intent_id: m.intent_id, actor });
    if (r === null) throw new Refusal(404, 'not_found', 'No assistant turn was admitted for this message.', 'Nothing to cancel.');
    return { invocation: r.invocation, status: r.status === 'ended' ? 'ended' : 'cancel_requested' };
  }
}

