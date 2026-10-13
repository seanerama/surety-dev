// M420 (c), the conversational roles' backends and every role's model
// (slice 33; kernel lane, beside the row's sandbox file; the driver's
// approval of the outline). M5 plan §3.3 M420 (c), M415 (b); D6 §2.6, A.7;
// D2 §4.1, §7.2; E139 Q6; SEAM.md §391. No model runs: the Claude entries
// here are stand-ins (SEAM.md §116), and nothing is launched on them.
//   (a) `backend_vision` and `backend_spec_writer` are project keys, default
//       `scripted`, as the other `backend_*` keys; a session of each role is
//       dispatched to the backend its key names;
//   (b) a conversational role pointed at `claude` whose active entry is not
//       `session_qualified`: the session refused `backend_refused`, nothing
//       launched;
//   (c) Q6: `model_vision`, `model_spec_writer` and `model_architect` default
//       to `opus`, `model_builder`, `model_verifier` and `model_reviewer` to
//       `sonnet`; each session turn's and each one-shot run's ledger row
//       records `model_requested` as its role's key says; a project setting
//       changes it.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { getPolicy, changePolicy } from './harness/journal.mjs';
import { addWork, runsOf, scriptedEngine, tick, waitForRun } from './harness/runs.mjs';
import { ledgerRowsOf, openSession, sayAndSettle, scriptTurns, turnThatSays } from './harness/sessions.mjs';
import { StandIn, apiKeyRef, installTrustEntry, standInProcesses } from './harness/trust.mjs';
import { holdSecret } from './harness/records.mjs';
import { sessionProject } from './harness/session-lane.mjs';

const Q6 = Object.freeze({ vision: 'opus', spec_writer: 'opus', architect: 'opus', builder: 'sonnet', verifier: 'sonnet', reviewer: 'sonnet' });

describe('M420 (c) the conversational roles\' backends and the roles\' models', () => {
  test('(a) backend_vision and backend_spec_writer default scripted; (c) the model_<role> keys default as Q6', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await sessionProject(fx);
    const { effective } = await getPolicy(fx.engine, p.id);
    assert.deepEqual([effective.backend_vision, effective.backend_spec_writer], ['scripted', 'scripted'], `the two keys, default scripted (${JSON.stringify(effective)})`);
    for (const [role, model] of Object.entries(Q6)) assert.equal(effective[`model_${role}`], model, `model_${role} defaults to ${model}`);
  });

  test('(c) each session turn and each one-shot run records the model its role\'s key names; a setting changes it', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await sessionProject(fx);
    const run = await openSession(fx, p.id, 'spec_writer');
    scriptTurns(fx, run.id, [turnThatSays('Specified.')]);
    await sayAndSettle(fx, p.id, run.id, 'Write the specification.');
    const [turnRow] = ledgerRowsOf(fx.home, p.id, run.id);
    assert.equal(turnRow?.model_requested, 'opus', `the Spec Writer's turn requested opus (${JSON.stringify(turnRow)})`);
    await fx.engine.post(`/v1/projects/${p.id}/sessions/${run.id}/close`, { refuse: true });
    const item = await addWork(fx.engine, p.id, 'fix');
    await tick(fx.engine, p.id, { rounds: 1 });
    const [builder] = runsOf(fx.home, item);
    await waitForRun(fx.home, item, { state: 'ended' });
    const [builderRow] = ledgerRowsOf(fx.home, p.id, builder.id);
    assert.equal(builderRow?.model_requested, 'sonnet', `a Builder's run requested sonnet (${JSON.stringify(builderRow)})`);
    await changePolicy(fx.engine, p.id, { model_vision: 'sonnet' });
    const vision = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, vision.id, [turnThatSays('Envisioned.')]);
    await sayAndSettle(fx, p.id, vision.id, 'Hello.');
    assert.equal(ledgerRowsOf(fx.home, p.id, vision.id)[0]?.model_requested, 'sonnet', 'model_vision set to sonnet: the Vision turn requested sonnet');
  });

  test('(a) each conversational role\'s session goes to the backend its key names; (b) an entry that is not session_qualified refuses the session backend_refused, launching nothing', async (t) => {
    for (const role of ['vision', 'spec_writer']) {
      const fx = await scriptedEngine(t);
      const standIn = new StandIn(join(fx.root, 'standin'));
      const p = await sessionProject(fx);
      await holdSecret(fx.engine, apiKeyRef('claude'), 'sk-test-key-for-the-stand-in-0001');
      await installTrustEntry(fx.engine, standIn, { status: 'active', session_qualified: false });
      await changePolicy(fx.engine, p.id, { [`backend_${role}`]: 'claude' });
      const res = await fx.engine.post(`/v1/projects/${p.id}/sessions`, { role });
      if (res.status === 201) {
        const runId = res.body.run.id;
        await fx.engine.post(`/v1/projects/${p.id}/sessions/${runId}/turns`, { text: 'Hello.' });
        await tick(fx.engine, p.id, { rounds: 2 });
        const read = await fx.engine.get(`/v1/projects/${p.id}/sessions/${runId}`);
        assert.match(JSON.stringify(read.body), /backend_refused/, `${role}: the session's turn refused backend_refused (${read.text.slice(0, 400)})`);
      } else {
        assert.deepEqual([res.status, res.body?.code], [409, 'backend_refused'], `${role}: the session refused backend_refused (→ ${res.status} ${res.text})`);
      }
      assert.deepEqual([standIn.launches().length, standInProcesses(standIn).length], [0, 0], `${role}: nothing launched on the entry`);
    }
  });
});
