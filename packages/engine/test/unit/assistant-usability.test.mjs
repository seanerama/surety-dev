// Developer tests for the workspace assistant's usability batch of
// 2026-10-27 (the driver's decisions 1 to 5): the real path answers 202 at
// the admission with the turn's identifier and its cancel route, and the
// conversation read is the outcome; a cancel during execution keeps the
// accounting and never resends; a turn the engine's restart interrupted is
// `unknown` until recovery ends it, then `interrupted` with what recovery
// charged, and the conversation accepts a new message; a refused admission
// writes no turn and charges nothing; an intent names one turn. The store and
// the runner boundary are a port here: their own tests are
// assistant-account.test.mjs and assistant-qualification.test.mjs.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { AssistantService } = await import(join(dist, 'assistant', 'service.js'));
const { Refusal } = await import(join(dist, 'refusal.js'));
const { MESSAGE_STATUSES } = await import(join(dist, 'assistant', 'contract.js'));

const actor = { actor_kind: 'human', actor_id: null, request_id: 'req_owner' };
const ask = (intent, text = 'What is waiting on me?') => ({ intent_id: intent, text, context: { project: null, screen: 'home' } });
// A realistic API token: the redactor masks its value wherever it appears.
const TOKEN = 'k7Qp2vXw9LmN4rTz8YbC1dFh6JsG3aE5';
const DEADLINE = '2026-10-27T12:02:00.000Z';
const reads = async (name) => (name === 'decisions.engine' ? { served_at: 't', snapshot_seq: 1, decisions: [] } : { served_at: 't', snapshot_seq: 1, projects: [] });

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-wau-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The store's side as a port: turns admitted, read, cancelled and ended; the
// map outlives a service (the store outlives an engine).
function store() {
  const turns = new Map();
  return { turns, admits: [], cancels: [], n: 0 };
}
function port(s, { incarnation = 'inc_A' } = {}) {
  let hook = null;
  const p = {
    refusal: null,
    state: async () => ({ state: 'ready', configured: true }),
    admit: async (a) => {
      s.admits.push(a);
      if (p.refusal) throw p.refusal;
      const invocation = `inv_${++s.n}`;
      s.turns.set(invocation, { invocation, conversation: a.conversation, intent_id: a.intent_id, status: 'admitted', outcome: null, reason: null, reason_text: null, incarnation, deadline_at: DEADLINE, reply: null, usage: null, cancel_requested_at: null });
      return { invocation, deadline_at: DEADLINE, backend: 'claude' };
    },
    turn: async (args) => ('invocation' in args ? s.turns.get(args.invocation) ?? null : [...s.turns.values()].find((x) => x.conversation === args.conversation && x.intent_id === args.intent_id) ?? null),
    cancel: async (a) => {
      s.cancels.push(a);
      const x = [...s.turns.values()].find((y) => y.conversation === a.conversation && y.intent_id === a.intent_id);
      if (!x) return null;
      if (x.status !== 'ended' && x.cancel_requested_at === null) x.cancel_requested_at = 'now';
      return { invocation: x.invocation, status: x.status };
    },
    onSettled: (fn) => {
      hook = fn;
      return true;
    },
    provider: () => ({ provider: 'claude', model: 'claude-sonnet-5-5' }),
    incarnation: () => incarnation,
    // The turn's end in the store, then the runner's settled hook.
    end: async (invocation, fields, { notify = true } = {}) => {
      Object.assign(s.turns.get(invocation), { status: 'ended', ...fields });
      if (notify && hook) await hook(invocation);
    },
  };
  return p;
}
const usage = (fields) => ({ account: 'workspace_assistant', provider: 'claude', model_observed: 'claude-sonnet-5-5', cost_status: 'reported', cost_usd: 0.01, input_tokens: 900, output_tokens: 100, cached_input_tokens: 0, usage_complete: true, unknown_allowance_tokens: null, basis: 'claude-1', ...fields });
const owners = (c) => c.messages.filter((m) => m.role === 'user');

test('the closed message statuses', () => {
  assert.deepEqual([...MESSAGE_STATUSES], ['running', 'completed', 'failed', 'stopped', 'timed_out', 'refused', 'interrupted', 'unknown']);
});

test('202 at the admission with the turn and its cancel route; the read is the outcome; a repeat is the state, never a second turn', async (t) => {
  const s = store();
  const p = port(s);
  const svc = new AssistantService(home(t), false, reads, TOKEN, p);
  const id = svc.create({}).conversation.id;
  const r = await svc.message(id, ask('i1'), actor);
  assert.equal(r.status, 202);
  assert.deepEqual(Object.keys(r.body).sort(), ['conversation', 'message', 'reply', 'turn']);
  const m = r.body.message;
  assert.deepEqual([m.role, m.status, m.invocation, r.body.reply], ['user', 'running', 'inv_1', null]);
  assert.deepEqual(r.body.turn, { id: 'inv_1', status: 'running', deadline_at: DEADLINE, cancel: `/v1/assistant/conversations/${id}/messages/${m.id}/cancel` });
  // The configured backend and model, not charged yet (decision 5).
  assert.deepEqual(m.usage, { account: 'workspace_assistant', provider: 'claude', model: 'claude-sonnet-5-5', cost_status: 'unknown', cost_usd: null, input_tokens: null, output_tokens: null, charged: false });
  assert.equal(s.admits.length, 1);
  assert.ok(s.admits[0].pkg.evidence.length > 0, 'the reads were made before the admission');
  // Repeats while it runs: the same turn, 202; nothing admitted again.
  const again = await svc.message(id, ask('i1'), actor);
  assert.deepEqual([again.status, again.body.turn.id, again.body.message.id], [202, 'inv_1', m.id]);
  await assert.rejects(svc.message(id, ask('i1', 'Something else'), actor), (e) => e.code === 'assistant_intent_conflict' && e.status === 409);
  // Another intent while it runs: busy, and nothing written.
  await assert.rejects(svc.message(id, ask('i2'), actor), (e) => e.code === 'assistant_busy' && e.status === 409);
  assert.equal(owners((await svc.get(id)).conversation).length, 1);
  assert.equal(s.admits.length, 1);
  // The read serves the same turn on the owner message: a client never
  // builds a route.
  assert.deepEqual(owners((await svc.get(id)).conversation)[0].turn, r.body.turn);
  assert.deepEqual(r.body.message.turn, r.body.turn);
  // It ends; the hook writes it.
  await p.end('inv_1', { outcome: 'completed', reason: 'none', reply: { text: 'Nothing waits.', cited_evidence: [], links: [{ label: 'Home', href: '#/w' }] }, usage: usage() });
  const c = (await svc.get(id)).conversation;
  const [owner, reply] = c.messages;
  assert.deepEqual([owner.status, owner.error, owner.usage.charged, owner.usage.input_tokens, owner.usage.unknown_allowance_tokens], ['completed', undefined, true, 900, null]);
  assert.deepEqual([reply.role, reply.status, reply.text, reply.invocation, reply.evidence.length > 0], ['assistant', 'completed', 'Nothing waits.', 'inv_1', true]);
  assert.deepEqual(owner.turn, { id: 'inv_1', status: 'completed', deadline_at: DEADLINE, cancel: null }, 'kept after the end, its final status, no cancel');
  assert.equal(reply.turn, undefined, 'the reply carries no turn object');
  const done = await svc.message(id, ask('i1'), actor);
  assert.deepEqual([done.status, done.body.turn.status, done.body.turn.cancel, done.body.reply.text], [200, 'completed', null, 'Nothing waits.']);
  assert.equal(s.admits.length, 1, 'never a second turn');
  // The next message is accepted.
  assert.equal((await svc.message(id, ask('i2'), actor)).status, 202);
});

test('an end the hook never saw is written by the next read', async (t) => {
  const s = store();
  const p = port(s);
  const svc = new AssistantService(home(t), false, reads, TOKEN, p);
  const id = svc.create({}).conversation.id;
  await svc.message(id, ask('i1'), actor);
  await p.end('inv_1', { outcome: 'timed_out', reason: 'assistant_timed_out', reason_text: 'the turn passed its turn_deadline_seconds', usage: usage({ usage_complete: false, input_tokens: 500, output_tokens: null, unknown_allowance_tokens: 39_500, cost_status: 'unknown', cost_usd: null }) }, { notify: false });
  const [owner, reply] = (await svc.get(id)).conversation.messages;
  assert.deepEqual([owner.status, owner.error.code, owner.error.outcome, owner.usage.unknown_allowance_tokens, owner.usage.charged], ['timed_out', 'assistant_timed_out', 'timed_out', 39_500, true]);
  assert.equal(reply.status, 'timed_out');
});

test('a cancel during execution: the route from the 202 on, `stopped`, the accounting kept, never resent', async (t) => {
  const s = store();
  const p = port(s);
  const svc = new AssistantService(home(t), false, reads, TOKEN, p);
  const id = svc.create({}).conversation.id;
  const r = await svc.message(id, ask('i1'), actor);
  s.turns.get('inv_1').status = 'running';
  const cancelled = await svc.cancel(id, r.body.message.id, actor);
  assert.deepEqual(cancelled, { invocation: 'inv_1', status: 'cancel_requested' });
  // The runner stops it and charges what was observed (here the
  // egress-evidence zero).
  await p.end('inv_1', { outcome: 'stopped', reason: 'assistant_cancelled', reason_text: 'the owner cancelled the turn', usage: usage({ cost_status: 'measured_zero', cost_usd: 0, input_tokens: 0, output_tokens: 0, basis: 'egress_evidence_zero' }) });
  const c = (await svc.get(id)).conversation;
  const owner = owners(c)[0];
  assert.deepEqual([owner.status, owner.error.code, owner.error.outcome, owner.usage.charged, owner.usage.cost_status, owner.usage.basis], ['stopped', 'assistant_cancelled', 'stopped', true, 'measured_zero', 'egress_evidence_zero']);
  // A cancel after the end says so; a repeat of the intent is its state.
  assert.deepEqual(await svc.cancel(id, owner.id, actor), { invocation: 'inv_1', status: 'ended' });
  const again = await svc.message(id, ask('i1'), actor);
  assert.deepEqual([again.status, again.body.message.status], [200, 'stopped']);
  assert.equal(s.admits.length, 1, 'never resent');
  // A cancel before the launch: nothing spent, `stopped`, not charged.
  const r2 = await svc.message(id, ask('i2'), actor);
  assert.equal(r2.status, 202);
  assert.equal((await svc.cancel(id, r2.body.message.id, actor)).status, 'cancel_requested');
  await p.end('inv_2', { outcome: 'refused', reason: 'assistant_cancelled', reason_text: 'the owner cancelled the turn before it was launched', usage: null });
  const o2 = owners((await svc.get(id)).conversation)[1];
  assert.deepEqual([o2.status, o2.error.code, o2.usage.charged, o2.usage.provider], ['stopped', 'assistant_cancelled', false, 'claude']);
  assert.equal(s.admits.length, 2);
});

test('a restart: `unknown` until recovery ends the turn, then `interrupted` with what recovery charged; the next message is accepted', async (t) => {
  const s = store();
  const dir = home(t);
  const before = new AssistantService(dir, false, reads, TOKEN, port(s, { incarnation: 'inc_A' }));
  const id = before.create({}).conversation.id;
  const first = await before.message(id, ask('i1'), actor);
  s.turns.get('inv_1').status = 'running';
  // The engine restarts: a new incarnation, the same store and home.
  const p = port(s, { incarnation: 'inc_B' });
  const after = new AssistantService(dir, false, reads, TOKEN, p);
  let owner = owners((await after.get(id)).conversation)[0];
  assert.deepEqual([owner.status, owner.invocation], ['unknown', 'inv_1'], 'the engine does not know while recovery has not ended it');
  await assert.rejects(after.message(id, ask('i2'), actor), (e) => e.code === 'assistant_busy');
  const repeat = await after.message(id, ask('i1'), actor);
  assert.deepEqual([repeat.status, repeat.body.message.status, repeat.body.turn.cancel], [200, 'unknown', null]);
  // Recovery ends it: what was observed and the allowance (C4).
  await p.end('inv_1', { outcome: 'recovered', reason: 'recovered', reason_text: 'the engine restarted while the turn ran; it is never replayed', usage: usage({ input_tokens: 1000, output_tokens: null, usage_complete: false, unknown_allowance_tokens: 39_000, cost_status: 'unknown', cost_usd: null }) }, { notify: false });
  let c = (await after.get(id)).conversation;
  owner = owners(c)[0];
  assert.equal(owner.id, first.body.message.id);
  assert.deepEqual(
    [owner.status, owner.error.code, owner.error.outcome, owner.usage.charged, owner.usage.input_tokens, owner.usage.unknown_allowance_tokens, owner.usage.cost_status],
    ['interrupted', 'assistant_interrupted', 'recovered', true, 1000, 39_000, 'unknown'],
  );
  assert.ok(owner.error.what_to_do && owner.error.reason);
  assert.equal(c.messages.filter((m) => m.role === 'assistant').length, 0, 'no reply is written, nothing replayed');
  // A new message is accepted; the interrupted turn's outcome and usage stay.
  const next = await after.message(id, ask('i2'), actor);
  assert.deepEqual([next.status, next.body.turn.id], [202, 'inv_2']);
  c = (await after.get(id)).conversation;
  assert.deepEqual(owners(c).map((m) => [m.intent_id, m.status, m.usage.unknown_allowance_tokens ?? null]), [['i1', 'interrupted', 39_000], ['i2', 'running', null]]);
  assert.deepEqual(s.admits.map((a) => a.intent_id), ['i1', 'i2'], 'the interrupted intent was never admitted again');
});

test('a message written but never admitted before a restart is `interrupted`, nothing charged', async (t) => {
  const s = store();
  const dir = home(t);
  const svc = new AssistantService(dir, false, reads, TOKEN, port(s));
  const id = svc.create({}).conversation.id;
  // What the engine left: the owner message `running`, no turn in the store.
  const path = join(dir, 'assistant', `${id}.json`);
  const disk = JSON.parse(readFileSync(path, 'utf8'));
  disk.requests.i1 = 'f';
  disk.messages.push({ id: 'am_01ARZ3NDEKTSV4RRFFQ69G5FAV', intent_id: 'i1', role: 'user', text: 'q', context: { project: null, screen: 'home' }, created_at: 'x', status: 'running', evidence: [], links: [], usage: { account: 'workspace_assistant', provider: 'claude', model: 'm', cost_status: 'unknown', cost_usd: null, input_tokens: null, output_tokens: null, charged: false }, actor: { kind: 'human', request_id: null } });
  writeFileSync(path, JSON.stringify(disk));
  const restarted = new AssistantService(dir, false, reads, TOKEN, port(s, { incarnation: 'inc_B' }));
  const owner = owners((await restarted.get(id)).conversation)[0];
  assert.deepEqual([owner.status, owner.error.code, owner.error.outcome, owner.usage.charged], ['interrupted', 'assistant_interrupted', 'not_admitted', false]);
  assert.equal((await restarted.message(id, ask('i2'), actor)).status, 202);
});

test('a refused admission (the day limit): a 4xx, no turn, nothing charged; its repeat is the refusal, and a new intent is admitted once the state allows', async (t) => {
  const s = store();
  const p = port(s);
  const svc = new AssistantService(home(t), false, reads, TOKEN, p);
  const id = svc.create({}).conversation.id;
  p.refusal = new Refusal(429, 'assistant_limit_reached', "Today's assistant limit is reached.", 'Wait for the reset.', { state: 'limit_reached', unknown_allowance_tokens: 39_000 });
  await assert.rejects(svc.message(id, ask('i1'), actor), (e) => e.status === 429 && e.code === 'assistant_limit_reached');
  assert.equal(s.turns.size, 0, 'no turn, no receipt');
  const owner = owners((await svc.get(id)).conversation)[0];
  assert.deepEqual([owner.status, owner.error.code, owner.error.outcome, owner.usage.charged, owner.invocation, owner.turn], ['refused', 'assistant_limit_reached', 'refused', false, undefined, null]);
  const again = await svc.message(id, ask('i1'), actor);
  assert.deepEqual([again.status, again.body.message.status, again.body.turn], [200, 'refused', null]);
  assert.equal(s.admits.length, 1, 'the refused intent is not admitted again');
  p.refusal = null;
  assert.equal((await svc.message(id, ask('i2'), actor)).status, 202);
  assert.equal(s.admits.length, 2);
});

test('a conversation with a turn under way is not deleted', async (t) => {
  const s = store();
  const p = port(s);
  const svc = new AssistantService(home(t), false, reads, TOKEN, p);
  const id = svc.create({}).conversation.id;
  await svc.message(id, ask('i1'), actor);
  await assert.rejects(svc.delete(id), (e) => e.code === 'assistant_busy');
  await p.end('inv_1', { outcome: 'failed', reason: 'assistant_provider_error', reason_text: 'exit 1', usage: usage() });
  assert.deepEqual(await svc.delete(id), { deleted: id });
});

test('the fake answers 200 at once with the same keys, its reply present', async (t) => {
  const svc = new AssistantService(home(t), true, reads, TOKEN);
  const id = svc.create({}).conversation.id;
  const r = await svc.message(id, ask('i1'), actor);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.message.role, r.body.message.status, r.body.reply.role, r.body.reply.status], ['user', 'completed', 'assistant', 'completed']);
  assert.deepEqual(r.body.turn, { id: null, status: 'completed', deadline_at: null, cancel: null });
  assert.equal(r.body.message.usage.provider, 'fake');
  assert.deepEqual(r.body.message.turn, r.body.turn);
});

test('the fake: a repeat that arrives while its turn still runs is 202, the same message, never a second answer; the turn is never stored', async (t) => {
  let release;
  const held = new Promise((r) => (release = r));
  let calls = 0;
  const dir = home(t);
  const svc = new AssistantService(dir, true, async (name) => { calls++; await held; return reads(name); }, TOKEN);
  const id = svc.create({}).conversation.id;
  const first = svc.message(id, ask('i1'), actor);
  await new Promise((r) => setTimeout(r, 20));
  const again = await svc.message(id, ask('i1'), actor);
  assert.deepEqual([again.status, again.body.message.status, again.body.turn, again.body.reply], [202, 'running', { id: null, status: 'running', deadline_at: null, cancel: null }, null]);
  release();
  const done = await first;
  assert.deepEqual([done.status, done.body.message.id], [200, again.body.message.id]);
  const n = calls;
  assert.equal((await svc.message(id, ask('i1'), actor)).body.reply.id, done.body.reply.id);
  assert.equal(calls, n, 'never answered twice');
  const disk = JSON.parse(readFileSync(join(dir, 'assistant', `${id}.json`), 'utf8'));
  assert.ok(disk.messages.every((m) => !('turn' in m)), 'served, never stored');
});
