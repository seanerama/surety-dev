// Developer tests for GET /v1/assistant's selection and failure (the
// assistant design §2): version 1 always; with no block, the fake only in the
// test mode, else unconfigured; with a block, the real state, and a store
// failure while computing it is a 503 refusal, never `ready`; a message is
// refused with the state's code unless the state is ready.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { AssistantService } = await import(join(dist, 'assistant', 'service.js'));
const { RealAssistant } = await import(join(dist, 'assistant', 'real.js'));

const BLOCK = { backend: 'claude', model: 'sonnet', credential_ref: 'backend/claude/subscription_token', day_limit_billable_tokens: 400_000, turn_limit_billable_tokens: 40_000, turn_deadline_seconds: 120 };
const actor = { actor_kind: 'human', actor_id: null, request_id: 'r' };

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-wae-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const noRead = async () => {
  throw new Error('no read');
};

test('no block: the fake only in the test mode, unconfigured otherwise; version 1', async (t) => {
  const h = home(t);
  const fake = await new AssistantService(h, true, noRead, 'tok').capability();
  assert.deepEqual([fake.version, fake.state, fake.configured, fake.provider, fake.account], [1, 'ready', true, 'fake', null]);
  const none = await new AssistantService(h, false, noRead, 'tok').capability();
  assert.deepEqual([none.version, none.state, none.configured, none.provider, none.account, none.qualification], [1, 'unconfigured', false, 'unconfigured', null, null]);
  assert.deepEqual(none.actions, []);
});

test('a block: the real state as the store computes it; a store failure is a 503, never ready', async (t) => {
  const h = home(t);
  const seen = [];
  const real = new RealAssistant(h, BLOCK, async (name, args) => {
    seen.push([name, args]);
    return { state: 'qualification_pending', configured: false, reason: 'r', what_to_do: 'w', provider: 'claude', model: 'sonnet', qualification: null, account: { unit: 'billable_tokens' }, trust_entry: null };
  });
  const body = await new AssistantService(h, true, noRead, 'tok', real).capability();
  assert.deepEqual([body.version, body.state, body.configured, body.provider], [1, 'qualification_pending', false, 'claude']);
  assert.equal(seen[0][0], 'assistant.state');
  assert.deepEqual(seen[0][1].credential, { manifest_ok: true, loaded: false }, 'the credential facts are the main thread\'s, never a value');
  const failing = new RealAssistant(h, BLOCK, async () => {
    throw new Error('disk I/O error');
  });
  await assert.rejects(new AssistantService(h, false, noRead, 'tok', failing).capability(), (e) => e.status === 503 && e.code === 'assistant_state_unavailable' && /not ready/.test(e.reason));
});

test('a message refused at its admission: the refusal answers, no turn is waited for, the owner message is failed with the refusal and nothing else is written', async (t) => {
  const h = home(t);
  const { Refusal } = await import(join(dist, 'refusal.js'));
  for (const [code, status] of [
    ['assistant_credential_missing', 409],
    ['assistant_qualification_pending', 409],
    ['assistant_limit_reached', 429],
    ['assistant_not_configured', 503],
  ]) {
    const calls = [];
    const port = {
      state: async () => ({ state: 'ready', configured: true }),
      admit: async (a) => {
        calls.push(a);
        throw new Refusal(status, code, `refused: ${code}`, 'do', { state: code });
      },
      settled: async () => {
        throw new Error('nothing is waited for');
      },
      turn: async () => null,
      cancel: async () => null,
      onSettled: () => {},
    };
    const reads = [];
    const svc = new AssistantService(h, false, async (name) => {
      reads.push(name);
      return { decisions: [], projects: [] };
    }, 'tok', port);
    const id = svc.create({}).conversation.id;
    await assert.rejects(svc.message(id, { intent_id: 'i1', text: 'What is waiting on me?', context: { project: null, screen: 'home' } }, actor), (e) => e.code === code && e.status === status);
    assert.equal(calls.length, 1, 'one admission');
    assert.deepEqual(calls[0].pkg.request, { intent_id: 'i1', text: 'What is waiting on me?', context: { project: null, screen: 'home' } });
    assert.ok(reads.includes('decisions.engine'), 'the engine chose its reads before the admission');
    const c = svc.get(id).conversation;
    assert.deepEqual(c.messages.map((m) => [m.role, m.status, m.error?.code, m.error?.outcome]), [['user', 'failed', code, 'refused']]);
    // The same intent again is the stored answer, never a second admission.
    const again = await svc.message(id, { intent_id: 'i1', text: 'What is waiting on me?', context: { project: null, screen: 'home' } }, actor);
    assert.equal(again.status, 'failed');
    assert.equal(calls.length, 1);
  }
});
