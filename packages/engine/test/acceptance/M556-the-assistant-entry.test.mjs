// M556, WA-entry: the assistant's trust entries and the projects' never
// stand in for each other (UI1 slice 48, kernel lane; the assistant design
// of 2026-10-27, §3: "Entries bind one template … the assistant needs its
// own entry"; "`resolveBackend` must exclude assistant-template entries from
// project roles, and the assistant must accept only them"; E184; SEAM.md
// §§113, 116, 567, 568).
//
// Entries here are trust-entry fixtures (test setup, labelled as such;
// SEAM.md §116) for the Claude backend, bound to the stand-in binary; the
// route takes `template_version: "claude-assistant-1"` for an
// assistant-template entry. Nothing is launched but what each case says.
//
//   (a) Project roles never resolve an assistant-template entry: with only
//       an active `claude-assistant-1` entry, a project whose verifier
//       names Claude has its dispatch refused `backend_refused` before
//       launch, and the engine does not list Claude among the backends it
//       would dispatch to.
//   (b) The assistant never resolves a coding entry, nor a session-qualified
//       one (as Vision's and the session roles' are): with only an active
//       coding-template entry for the block's backend and model, and then
//       also an active session-qualified one, the assistant's state stays
//       `qualification_pending`, whose reason says a role's entry is not the
//       assistant's; a message is refused. Control: an active
//       `claude-assistant-1` entry for the block's model makes it `ready`;
//       one for another model does not.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CLAUDE_BLOCK, KEY_REF, TEST_KEY, assertMessageRefused, assistantState, newConversation } from './harness/assistant.mjs';
import { ledgerRows } from './harness/ledger.mjs';
import { readRun } from './harness/reads.mjs';
import { holdSecret } from './harness/records.mjs';
import { addWork, assertRunEnded, requestTick, scriptedEngine, waitForRun } from './harness/runs.mjs';
import { BACKENDS, PARK_ON_REFUSAL, StandIn, installTrustEntry, realBackendProject, standInProcesses, trustEntry } from './harness/trust.mjs';
import { join } from 'node:path';

const ASSISTANT_TEMPLATE = 'claude-assistant-1';

describe("M556 the assistant's entries and the projects' never stand in for each other", () => {
  test('(a) a project role never resolves an assistant-template entry: dispatch refused backend_refused before launch', async (t) => {
    const { fx, standIn, project } = await realBackendProject(t, { policy: PARK_ON_REFUSAL });
    const entry = await installTrustEntry(fx.engine, standIn, { status: 'active', template_version: ASSISTANT_TEMPLATE });
    assert.deepEqual([trustEntry(fx.home, entry.id)?.status, trustEntry(fx.home, entry.id)?.template_version], ['active', ASSISTANT_TEMPLATE], 'the fixture is live: an active assistant-template entry for Claude');
    assert.ok(!(await fx.engine.engineInfo()).backends.includes(BACKENDS.claude), 'Claude is not among the backends the engine would dispatch a role to');
    const item = await addWork(fx.engine, project, 'verification');
    await requestTick(fx.engine, project);
    const run = await waitForRun(fx.home, item, { state: 'ended' });
    const facts = assertRunEnded(fx.home, run.id, { outcome: 'refused', reason_class: 'preflight_refused', launched: false, recovery: false });
    assert.deepEqual(facts.receipts.map((r) => r.statuses), [['refused']], 'the receipt has the observation refused and nothing else');
    assert.equal((await readRun(fx.engine, project, run.id)).code, 'backend_refused', 'the run read reports backend_refused');
    assert.deepEqual(ledgerRows(fx.home, project).filter((r) => r.run === run.id), [], 'no ledger row');
    assert.equal(standIn.launches().length, 0, 'the stand-in was not launched');
    assert.deepEqual(standInProcesses(standIn), [], 'no process of the backend is running');
  });

  test('(b) the assistant never resolves a coding or a session-qualified entry; an assistant-template entry for the block\'s model makes it ready, one for another model does not', async (t) => {
    const fx = await scriptedEngine(t, { config: { workspace_assistant: CLAUDE_BLOCK } });
    const standIn = new StandIn(join(fx.root, 'standin'));
    await holdSecret(fx.engine, KEY_REF, TEST_KEY);
    const conv = await newConversation(fx);
    let s = await assistantState(fx);
    assert.equal(s.state, 'qualification_pending', `no entry: ${s.reason}`);

    const coding = await installTrustEntry(fx.engine, standIn, { status: 'active', model: CLAUDE_BLOCK.model });
    assert.notEqual(trustEntry(fx.home, coding.id).template_version, ASSISTANT_TEMPLATE, 'the fixture is live: an active coding-template entry');
    s = await assistantState(fx);
    assert.equal(s.state, 'qualification_pending', `a coding entry is not the assistant's (${s.reason})`);
    assert.match(s.reason, /not the assistant's/, 'the reason says so');
    await assertMessageRefused(fx, conv, 'm556-b1', 409, 'assistant_qualification_pending', 'a coding entry only');

    const session = await installTrustEntry(fx.engine, standIn, { status: 'active', model: CLAUDE_BLOCK.model, session_qualified: true });
    assert.equal(trustEntry(fx.home, session.id).session_qualified, 1, 'the fixture is live: an active session-qualified entry (as Vision\'s)');
    s = await assistantState(fx);
    assert.equal(s.state, 'qualification_pending', `a session-qualified entry is not the assistant's (${s.reason})`);
    await assertMessageRefused(fx, conv, 'm556-b2', 409, 'assistant_qualification_pending', 'a session-qualified entry');

    const other = await installTrustEntry(fx.engine, standIn, { status: 'active', template_version: ASSISTANT_TEMPLATE, model: 'claude-opus-5-5' });
    assert.equal(trustEntry(fx.home, other.id).status, 'active', 'the fixture is live: an assistant entry for another model');
    s = await assistantState(fx);
    assert.equal(s.state, 'qualification_pending', `an assistant entry for another model is not this block's (${s.reason})`);

    const mine = await installTrustEntry(fx.engine, standIn, { status: 'active', template_version: ASSISTANT_TEMPLATE, model: CLAUDE_BLOCK.model });
    s = await assistantState(fx);
    assert.deepEqual([s.state, s.trust_entry], ['ready', mine.id], `control: the assistant-template entry for the block's model (${s.reason})`);
  });
});
