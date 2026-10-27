import { ActionStore, actionKind } from './actions.js';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../ids.js';
import { redactText, redactValue, scanBytes } from '../records/redact.js';
import { Refusal } from '../refusal.js';
import type { Actor } from '../store/transitions/tx.js';
import { FAKE_USAGE, LIMITS, type AssistantContext, type AssistantRequest, type Conversation, type AssistantMessage, type Evidence, type AssistantLink, type ReadTool } from './contract.js';

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

interface StoredConversation extends Conversation { requests: Record<string, string> }
export class AssistantService {
  private readonly dir: string;
  private readonly busy = new Set<string>();
  private readonly actions: ActionStore;
  constructor(home: string, private readonly scriptedProvider: boolean, private readonly read: AssistantRead, private readonly token: string) { this.dir = join(home, 'assistant'); this.actions = new ActionStore(home, v => safeValue(v, token)); }
  capability() { return { version: 1, provider: this.scriptedProvider ? 'fake' : 'unconfigured', configured: this.scriptedProvider, limits: LIMITS, retention: 'engine-owned; explicit deletion', actions: this.scriptedProvider ? ['create_app', 'start_planning'] : [] }; }
  private configured() { if (!this.scriptedProvider) throw new Refusal(503, 'assistant_not_configured', 'Assistant not configured. Real assistant execution and accounting are not enabled.', 'Continue using the ordinary workspace controls.'); }
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
  private public(c: StoredConversation): Conversation { const { requests: _, ...out } = c; return out; }
  list() {
    this.configured();
    const conversations = existsSync(this.dir) ? readdirSync(this.dir).filter(n => /^ac_[A-Z0-9]{26}\.json$/.test(n)).map(n => this.load(n.slice(0, -5))).map(c => ({ id: c.id, created_at: c.created_at, updated_at: c.updated_at, message_count: c.messages.length })).sort((a, b) => b.updated_at.localeCompare(a.updated_at)) : [];
    return { conversations };
  }
  create(body: unknown) {
    this.configured(); fields(body, []);
    if (this.list().conversations.length >= LIMITS.max_conversations) throw new Refusal(429, 'assistant_limit', 'The conversation limit was reached.', 'Delete an old assistant conversation before creating another.');
    const now = new Date().toISOString();
    const c: StoredConversation = { id: newId('ac_'), created_at: now, updated_at: now, messages: [], requests: {} };
    this.save(c); return { conversation: this.public(c) };
  }
  get(id: string) { this.configured(); return { conversation: this.public(this.load(id)) }; }
  delete(id: string) {
    this.configured(); this.load(id);
    if (this.busy.has(id)) throw new Refusal(409, 'assistant_busy', 'A response is still running.', 'Wait for it to settle before deleting.');
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
  async message(id: string, value: unknown, actor: Actor) {
    this.configured();
    const raw = parseRequest(value);
    const fingerprint = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
    const req = safeValue(raw, this.token);
    let c = this.load(id);
    if (c.requests[req.intent_id]) {
      if (c.requests[req.intent_id] !== fingerprint) throw new Refusal(409, 'assistant_intent_conflict', 'This intent identifier already names a different message or context.', 'Use a new intent identifier for a new owner request.');
      const message = c.messages.find(m => m.intent_id === req.intent_id && m.role === 'assistant');
      return { conversation: this.public(c), message: message ?? null, status: message?.status ?? 'unknown' };
    }
    if (this.busy.has(id)) throw new Refusal(409, 'assistant_busy', 'A response is already running in this conversation.', 'Wait for it to settle; do not replay the request.');
    if (c.messages.length + 2 > LIMITS.max_messages) throw new Refusal(429, 'assistant_limit', 'The conversation message limit was reached.', 'Start a new assistant conversation.');
    if (this.busy.size >= 2) throw new Refusal(429, 'assistant_limit', 'The assistant concurrency limit was reached.', 'Wait for a current response to settle.');
    this.busy.add(id);
    try {
      const at = new Date().toISOString();
      const human: AssistantMessage = { id: newId('am_'), intent_id: req.intent_id, role: 'user', text: req.text, context: req.context, created_at: at, status: 'unknown', evidence: [], links: [], usage: FAKE_USAGE, actor: { kind: 'human', request_id: actor.request_id } };
      c.requests[req.intent_id] = fingerprint; c.messages.push(human); c.updated_at = at; this.save(c);
      const gateway = new ToolGateway(this.read, req.context, this.token);
      let result: { text: string; links: AssistantLink[] }; let status: AssistantMessage['status'] = 'completed';
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
      return { conversation: this.public(c), message, status };
    } finally { this.busy.delete(id); }
  }
}
