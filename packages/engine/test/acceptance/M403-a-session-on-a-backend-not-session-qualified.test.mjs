// M403, a session on a real backend whose trust entry is not session-
// qualified (slice 31, the 31a review's S2; kernel lane). D6 §2.6 ("a
// one-shot entry without it refuses `session` runs with `backend_refused`"),
// §2.4 ("every next turn revalidates ... the backend's qualification"); D2
// A.3 `session_qualified`; SEAM.md §§113 to 116, 365.
//
// A project whose Architect runs on `claude`, with an active one-shot trust
// entry (the test-labelled fixture entry bound to the stand-in binary; never
// a real binary; `session_qualified` is never true of it). Opening an
// Architect session, or else admitting its first turn, answers
// `backend_refused`; nothing is launched: no launch of the stand-in, no
// launch of the scripted role program for the session, no turn running.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { tick } from './harness/runs.mjs';
import { launchesOfRun, turnRows } from './harness/sessions.mjs';
import { installTrustEntry, realBackendProject, trustEntry } from './harness/trust.mjs';

const refusedBackend = (res, what) => {
  assert.ok([403, 409, 422].includes(res.status), `${what} is refused (→ ${res.status} ${res.text})`);
  assert.equal(res.body?.code, 'backend_refused', `${what}: backend_refused (body: ${res.text})`);
};

describe('M403 a session on a backend that is not session-qualified', () => {
  test('(S2) backend_architect claude with an active one-shot entry: the Architect session is refused backend_refused at its open or at its first turn, and nothing is launched', async (t) => {
    const { fx, standIn, project } = await realBackendProject(t, { roles: ['architect'] });
    const active = await installTrustEntry(fx.engine, standIn, { status: 'active' });
    const entry = trustEntry(fx.home, active.id);
    assert.equal(entry?.status, 'active', 'the fixture is live: an active entry for claude');
    assert.ok(!entry.session_qualified, 'and it is not session-qualified (one-shot qualification never establishes continuation)');

    const opened = await fx.engine.post(`/v1/projects/${project}/sessions`, { role: 'architect' });
    let run = null;
    if (opened.status === 201) {
      run = opened.body?.run?.id;
      assert.match(run ?? '', /^run_/, `the open names the run (body: ${opened.text})`);
      const turn = await fx.engine.post(`/v1/projects/${project}/sessions/${run}/turns`, { text: 'Design the architecture.' });
      refusedBackend(turn, 'the first turn of a session on a backend that is not session-qualified');
    } else refusedBackend(opened, 'opening a session on a backend that is not session-qualified');

    await tick(fx.engine, project, { rounds: 3 });
    assert.deepEqual(standIn.launches(), [], 'the stand-in backend was never launched');
    if (run !== null) {
      assert.deepEqual(launchesOfRun(fx, run), [], 'no launch for the session');
      assert.deepEqual(turnRows(fx.home, run).filter((r) => r.state === 'running' || r.settled_at === null), [], 'no turn admitted or running');
    }
  });
});
