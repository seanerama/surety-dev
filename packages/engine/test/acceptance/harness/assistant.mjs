// The workspace assistant's real path, the test side (UI1 slice 48, rows
// M548 to M559; the assistant design of 2026-10-27, §§1 to 5; E183, E184;
// SEAM.md §§567 to 570).
//
// An engine whose config.json holds a `workspace_assistant` block runs the
// real path even in its test mode: the scripted backend stands in for a
// real provider through an ordinary assistant-template trust entry
// (`scripted-assistant-1`), which only a qualification attempt with
// `"purpose": "assistant"` makes. The attempt's canaries run inside the
// real sandbox, so a fixture that needs a ready assistant is a sandbox-lane
// fixture (lane.mjs): the stand-in built to run the scripted role program
// (trust.mjs) is the attempt's binary, its canaries obey their canary.json,
// and once it has passed and the owner has activated its entry the state is
// `ready`. A turn is then one launch of work kind `workspace_assistant`,
// whose script is `scripts/kind-workspace_assistant.json` (Scripted
// kindScript; launch n of that kind follows element n-1).
//
// Nothing here calls a model: the scripted backend runs no model and holds
// no account; the credential the block names is a test value the harness
// holds in the engine's redactor (records.mjs holdSecret).
//
// The message route's answer changes shape on the usability batch (SEAM.md
// §570): on engine main 600b6e88 a POST waits for the turn's end and
// answers 200; on the Builder's `build/assistant-usability` it answers 202
// at admission. `askAndSettle` takes either: it waits for the turn's end in
// the store and for the conversation to record it. Only rows M554 (b) and
// M559 pin the new shape.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { httpRequest, waitFor } from './engine.mjs';
import { holdSecret } from './records.mjs';
import { scriptedEngine } from './runs.mjs';
import { step } from './scripted.mjs';
import { withStore } from './store.mjs';
import { FakeClaude } from './sandbox/fakeclaude.mjs';
import { sandboxEngine } from './sandbox/lane.mjs';
import { approveAttempt, attemptFixture, qualify, scriptedBody, waitAttempt } from './sandbox/qualify.mjs';
import { consumeEngine, installTrustEntry, openEngineDecision } from './trust.mjs';

// The Verifier's table of the assistant's states, codes, failure classes
// and message statuses (contract/assistant.json; contract/README.md).
export const ASSISTANT_CONTRACT = JSON.parse(readFileSync(new URL('../contract/assistant.json', import.meta.url), 'utf8'));
export const refusalOf = (state) => ASSISTANT_CONTRACT.states.find((s) => s.state === state).refusal;

export const ACCOUNT = 'workspace_assistant';
export const KIND = 'workspace_assistant';
// The block's credential reference and the test value held for it. The
// scripted backend takes no credential, but the state requires the block's
// reference to be loaded (the assistant design §2).
export const KEY_REF = 'backend/claude/api_key';
export const TEST_KEY = 'sk-test-assistant-key-0001';

// A whole block: every field given (the block has no defaults).
export const BLOCK = Object.freeze({
  backend: 'scripted',
  model: 'scripted-model',
  credential_ref: KEY_REF,
  day_limit_billable_tokens: 150_000,
  turn_limit_billable_tokens: 40_000,
  turn_deadline_seconds: 60,
});
export const block = (over = {}) => ({ ...BLOCK, ...over });

export const HOME_CONTEXT = Object.freeze({ project: null, screen: 'home' });
// A question the engine routes to its attention reads (assistant/service.ts
// fakeReply's routing, which the real path uses to choose its reads).
export const WAITING = 'What is waiting on me?';

// ---- the scripted assistant's steps --------------------------------------------------------

// A reply as the assistant's result (/surety/out/result.json and the
// terminal line in the sandbox; the line alone in the kernel lane).
export const reply = (text, { cited = [], links = [] } = {}) => step.result({ text, cited_evidence: cited, links });
// A cumulative usage report in the scripted backend's own names.
export const usage = (raw) => step.usage(raw, 'cumulative');
// Known counts: input, output and cache reads (all three known).
export const counts = (input, output, extra = {}) => usage({ input_tokens: input, output_tokens: output, cache_read_tokens: 0, ...extra });
// A silent hold (no heartbeat lines on stdout).
export const hold = (name) => step.hold(name, { heartbeat_ms: 0 });

// The assistant's launches follow `scripts`, in launch order.
export const assistantScripts = (fx, scripts) => fx.scripted.kindScript(KIND, scripts);
export const assistantLaunches = (fx) => fx.scripted.launches({ work_kind: KIND });

// ---- a ready assistant (sandbox lane) --------------------------------------------------------

// The three canaries of the assistant's attempt obey their canary.json; the
// containment canary waits and ends with its result while the engine runs
// its own probe beside it (E86).
export function obeyingAssistantCanaries(fx) {
  const times = (one) => Array.from({ length: 6 }, () => one);
  fx.scripted.canaryScript('positive', times({ steps: [step.canary('obey')] }));
  fx.scripted.canaryScript('cancellation', times({ steps: [step.canary('obey')], on_term: 'exit' }));
  fx.scripted.canaryScript('containment', times({ steps: [step.canary('obey')] }));
}

// Propose the assistant's qualification attempt for the block's backend and
// model (the scripted backend, its stand-in binary), approve it, wait for
// its end. Returns {id, row}.
export async function assistantAttempt(fx, standIn, fixtureProject, { model = BLOCK.model, extra = {}, approve = true } = {}) {
  const a = await qualify(fx, scriptedBody(standIn, fixtureProject, { purpose: 'assistant', model, ...extra }));
  if (!approve) return { id: a.id, row: null, proposed: a };
  await approveAttempt(fx, fixtureProject, a.id);
  const row = await waitAttempt(fx.home, a.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 300_000 });
  return { id: a.id, row, proposed: a };
}

// A sandbox-lane engine whose assistant is `ready`: the block, the credential
// held, the assistant's attempt passed and its entry activated by the owner.
// Returns {fx, standIn, fixtureProject, attempt, entry}.
export async function readyAssistant(t, { block: b = BLOCK, config = {} } = {}) {
  const { fx, standIn, fixtureProject } = await attemptFixture(t, { config: { workspace_assistant: b, ...config } });
  await holdSecret(fx.engine, b.credential_ref, TEST_KEY);
  obeyingAssistantCanaries(fx);
  const { id, row } = await assistantAttempt(fx, standIn, fixtureProject, { model: b.model });
  assert.equal(row.status, 'succeeded', `the fixture is live: the assistant's attempt passed (canaries: ${JSON.stringify(row.canaries)})`);
  const activation = await openEngineDecision(fx, fixtureProject, 'trust_activation', row.trust_entry);
  await consumeEngine(fx, activation, 'approve');
  const s = await assistantState(fx);
  assert.equal(s.state, 'ready', `the fixture is live: the assistant is ready (${s.reason})`);
  return { fx, standIn, fixtureProject, attempt: id, entry: row.trust_entry, block: b };
}

// ---- a Claude-template assistant on the fake claude (SEAM.md §569) ------------------------

// A block naming the Claude backend and the model the trust-entry fixture
// binds by default.
export const CLAUDE_BLOCK = Object.freeze({ ...BLOCK, backend: 'claude', model: 'claude-sonnet-5-5' });

// An engine (the sandbox lane, or with `kernel` the kernel lane) whose
// assistant runs on an active `claude-assistant-1` entry installed by the
// trust-entry fixture (test setup, labelled as such; SEAM.md §116) and bound
// to the fake claude (sandbox/fakeclaude.mjs), never the real binary. The
// fake's mode file says what each turn does. Returns {fx, fake, entry}.
export async function claudeAssistant(t, { block: b = CLAUDE_BLOCK, kernel = false, config = {} } = {}) {
  const fx = kernel ? await scriptedEngine(t, { config: { workspace_assistant: b, ...config } }) : await sandboxEngine(t, { config: { workspace_assistant: b, ...config } });
  const fake = new FakeClaude(join(fx.root, 'fakeclaude'), { modeDir: fx.scripted.dir });
  await holdSecret(fx.engine, b.credential_ref, TEST_KEY);
  const entry = await installTrustEntry(fx.engine, { binary: { path: fake.path, sha256: fake.sha256 } }, { status: 'active', template_version: 'claude-assistant-1', model: b.model });
  return { fx, fake, entry: entry.id };
}

// Start the engine again on the same home: the sandbox lane, or with
// `kernel` the kernel lane's scripted boundary (lane.mjs startKernel); the
// credential is held again (held secrets live in the engine's memory).
export async function restartAssistant(fx, { kernel = false, killed = false, b = BLOCK } = {}) {
  if (fx.engine.isRunning()) await (killed ? fx.engine.kill() : fx.engine.stop());
  const engine = kernel ? await fx.startKernel() : await fx.start();
  await holdSecret(engine, b.credential_ref, TEST_KEY);
  return engine;
}

// ---- the routes ---------------------------------------------------------------------------

export async function assistantState(fx) {
  const res = await fx.engine.get('/v1/assistant');
  assert.equal(res.status, 200, `GET /v1/assistant (body: ${res.text})`);
  return res.body;
}

export async function newConversation(fx) {
  const res = await fx.engine.post('/v1/assistant/conversations', {});
  assert.equal(res.status, 201, `POST /v1/assistant/conversations (body: ${res.text})`);
  return res.body.conversation.id;
}

export async function conversation(fx, conv) {
  const res = await fx.engine.get(`/v1/assistant/conversations/${conv}`);
  assert.equal(res.status, 200, `GET the conversation (body: ${res.text})`);
  return res.body.conversation;
}

export const messagesPath = (conv) => `/v1/assistant/conversations/${conv}/messages`;
export const cancelPath = (conv, message) => `/v1/assistant/conversations/${conv}/messages/${message}/cancel`;

// A request on its own connection with a long bound: on 600b6e88 the message
// route answers only once the turn has ended.
export function longRequest(fx, method, path, body, { timeoutMs = 240_000 } = {}) {
  return httpRequest({
    port: fx.engine.port,
    method,
    path,
    headers: { host: fx.engine.authority, connection: 'close', 'x-surety-token': fx.engine.token() },
    body,
    timeoutMs,
  });
}

export const messageBody = (intent, text = WAITING, context = HOME_CONTEXT) => ({ intent_id: intent, text, context });
export const ask = (fx, conv, intent, text = WAITING, context = HOME_CONTEXT) => longRequest(fx, 'POST', messagesPath(conv), messageBody(intent, text, context));

// The owner's message and the assistant's reply of one intent.
export function messagesOf(conv, intent) {
  const all = conv.messages.filter((m) => m.intent_id === intent);
  return { owner: all.find((m) => m.role === 'user') ?? null, reply: all.find((m) => m.role === 'assistant') ?? null, all };
}

// Not yet settled: the owner's message is still unknown (600b6e88, while the
// turn runs) or running (the usability batch).
const UNSETTLED = ['unknown', 'running'];

// Wait until the conversation records the turn of `intent` as ended.
export async function settledMessages(fx, conv, intent, { timeoutMs = 120_000 } = {}) {
  return waitFor(
    async () => {
      const c = await conversation(fx, conv);
      const m = messagesOf(c, intent);
      return m.owner !== null && !UNSETTLED.includes(m.owner.status) ? { ...m, conversation: c } : undefined;
    },
    { timeoutMs, what: `the conversation to record the end of the turn of intent ${intent}` },
  );
}

// Send a message and wait for its turn's end. A refused admission answers
// 4xx at once and has no turn: {res, turn: null}. Otherwise {res, turn (the
// store's row, ended), owner, reply}.
export async function askAndSettle(fx, conv, intent, text = WAITING, context = HOME_CONTEXT, { timeoutMs = 180_000 } = {}) {
  const pending = ask(fx, conv, intent, text, context);
  let answered = null;
  pending.then(
    (r) => (answered = { res: r }),
    (err) => (answered = { err }),
  );
  await waitFor(() => (answered !== null || turnOf(fx.home, intent) !== null ? true : undefined), { timeoutMs, what: `an answer to, or the admission of, intent ${intent}` });
  if (answered?.err) throw answered.err;
  if (answered !== null && answered.res.status >= 400 && turnOf(fx.home, intent) === null) return { res: answered.res, turn: null, owner: null, reply: null };
  const ended = await waitTurn(fx, intent, { timeoutMs });
  const res = await pending;
  if (res.status >= 400) return { res, turn: ended, owner: null, reply: null };
  const m = await settledMessages(fx, conv, intent, { timeoutMs });
  return { res, turn: turnOf(fx.home, intent), owner: m.owner, reply: m.reply, conversation: m.conversation };
}

// The owner's cancel of the message `message` (its id).
export const cancelMessage = (fx, conv, message) => fx.engine.post(cancelPath(conv, message), {});

// ---- the store's account rows ------------------------------------------------------------

const parse = (text) => (text === null || text === undefined ? text : JSON.parse(text));

export const turnOf = (home, intent) => withStore(home, (db) => db.prepare('SELECT * FROM "assistant_turns" WHERE "intent_id" = ? ORDER BY rowid DESC').get(intent)) ?? null;
export const turns = (home) => withStore(home, (db) => db.prepare('SELECT * FROM "assistant_turns" ORDER BY rowid').all());

export const waitTurn = (fx, intent, { status = 'ended', timeoutMs = 180_000 } = {}) =>
  waitFor(
    () => {
      const t = turnOf(fx.home, intent);
      return t !== null && (status === null || t.status === status) ? t : undefined;
    },
    { timeoutMs, what: `the turn of intent ${intent} to be ${status ?? 'admitted'}` },
  );

export const receipts = (home) =>
  withStore(home, (db) => db.prepare(`SELECT * FROM "invocation_receipts" WHERE "account" = 'workspace_assistant' ORDER BY rowid`).all()).map((r) => ({ ...r, budget_snapshot: parse(r.budget_snapshot) }));

export const rowsOf = (home, invocation) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "ledger_rows" WHERE "invocation" = ? ORDER BY rowid').all(invocation)).map((r) => ({ ...r, raw_usage: parse(r.raw_usage) }));

export const accountRows = (home) =>
  withStore(home, (db) => db.prepare(`SELECT * FROM "ledger_rows" WHERE "account" = 'workspace_assistant' ORDER BY rowid`).all()).map((r) => ({ ...r, raw_usage: parse(r.raw_usage) }));

export const statusesOf = (home, invocation) =>
  withStore(home, (db) => db.prepare('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ? ORDER BY "seq"').all(invocation)).map((r) => r.status);

export const domainOfTurn = (home, invocation) => {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "invocation" = ?').get(invocation));
  return row ? { ...row, launch_binding: parse(row.launch_binding) } : null;
};

// The account view's allowance, under its name on 600b6e88
// (`unknown_allowance`) or the usability batch's (`unknown_allowance_tokens`;
// pinned by M559 alone).
export const allowanceOf = (view) => (view?.unknown_allowance_tokens !== undefined ? view.unknown_allowance_tokens : view?.unknown_allowance);

// The account's figures the rows pin, from GET /v1/assistant.
export async function accountView(fx) {
  const s = await assistantState(fx);
  assert.ok(s.account && typeof s.account === 'object', `GET /v1/assistant has the account (state ${s.state})`);
  return s.account;
}

// The next 00:00Z after the instant `iso`.
export function nextMidnight(iso) {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

// No receipt, no turn and no account row was written for `intent`.
export function assertNothingAdmitted(home, intent, what) {
  assert.equal(turnOf(home, intent), null, `${what}: no turn was admitted for intent ${intent}`);
}

// A message refused at its admission with `status` and `code` (each one
// value or a list of the values accepted): no turn was
// admitted (so no receipt and nothing reserved), no reply; the owner's
// message, where the conversation keeps it, is not completed and names the
// refusal. Returns the response.
export async function assertMessageRefused(fx, conv, intent, status, code, what) {
  const before = receipts(fx.home).length;
  const { res } = await askAndSettle(fx, conv, intent);
  assert.ok([status].flat().includes(res.status), `${what}: the message is refused ${[status].flat().join(' or ')} (body: ${res.text})`);
  assert.ok([code].flat().includes(res.body?.code), `${what}: with the code ${[code].flat().join(' or ')} (body: ${res.text})`);
  assert.equal(turnOf(fx.home, intent), null, `${what}: no turn was admitted`);
  assert.equal(receipts(fx.home).length, before, `${what}: no receipt was written`);
  const m = messagesOf(await conversation(fx, conv), intent);
  assert.equal(m.reply, null, `${what}: no reply`);
  if (m.owner !== null) {
    assert.notEqual(m.owner.status, 'completed', `${what}: the owner's message is not completed`);
    assert.equal(m.owner.error?.code, res.body.code, `${what}: the owner's message names the refusal (${JSON.stringify(m.owner.error ?? null)})`);
  }
  return res;
}
