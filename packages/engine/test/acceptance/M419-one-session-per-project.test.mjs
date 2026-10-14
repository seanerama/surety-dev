// M419, one session per project (slice 33; kernel lane). M5 plan §3.3 M419;
// D6-S08 as draft 3 states it (E141 item 4); D6 §2.7; K2; N01 (HoldReason
// `session_busy`); SEAM.md §§344, 389.
//   (a) a one-shot dispatch while a session is open: held `session_busy`, no
//       run created;
//   (b) a second session while one is open: refused `session_busy` (409);
//   (c) the envelope's view of the session: its turn's domain records its
//       `memory_max` as the project's effective `role_memory_max`, the value
//       the envelope counts: 4 GiB by default (E140 N1), a project's own
//       value when set (M5 slice 37, D6 K2, B09; SEAM.md §426: slice 33
//       pinned the configured `domain_memory_max`, the driver's ruling (b),
//       until the per-profile maxima existed);
//   (d) a session while a one-shot runs: refused `session_busy` until the run
//       ends, then admitted;
//   (e) a session's opening racing a one-shot's claim, in both orders (the
//       opening held at `session.admission` †, the claim held at
//       `dispatch.run_created`): exactly one admitted;
//   (f) no project run counter: `max_concurrent_runs` is not a project
//       setting (refused by the policy route; M438 pins the engine key).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { addWork, runsOf, scriptedEngine, tick, waitForRun } from './harness/runs.mjs';
import { roleThatHolds } from './harness/gitruns.mjs';
import { closeSession, openSession, sayAndSettle, scriptTurns, turnThatSays } from './harness/sessions.mjs';
import { changePolicy } from './harness/journal.mjs';
import { withStore } from './harness/store.mjs';
import { ADMISSION, domainsOfRun, pauseAt, reached, release, sessionProject } from './harness/session-lane.mjs';
import { workOf } from './harness/journey/drive.mjs';

const openRaw = (fx, project, role = 'vision') => fx.engine.post(`/v1/projects/${project}/sessions`, { role });
const GIB = 1024 * 1024 * 1024;
// A ceiling other than the 8 GiB default, above both role values used, so the
// record shows the project's role maximum and not the ceiling (Q1: the
// effective maximum is min(the project's value or default, the ceiling)).
const DOMAIN_MEMORY_MAX = 6 * GIB;
const ROLE_MEMORY_MAX = 3 * GIB;

describe('M419 one session per project', () => {
  test('(a) a one-shot dispatch while a session is open is held session_busy; (b) a second session is refused session_busy', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await sessionProject(fx);
    await openSession(fx, p.id, 'vision');
    const item = await addWork(fx.engine, p.id, 'fix');
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.deepEqual(runsOf(fx.home, item), [], 'no run for the one-shot while the session is open');
    const row = workOf(fx.home, p.id).find((w) => w.id === item);
    assert.match(JSON.stringify(row.held ?? row.blocker ?? ''), /session_busy/, `held session_busy (${JSON.stringify({ status: row.status, held: row.held, blocker: row.blocker })})`);
    assertRefused(await openRaw(fx, p.id, 'spec_writer'), 409, 'session_busy', 'a second session');
  });

  test('(c) the session\'s turn domain records its memory_max as the project\'s effective role_memory_max, the value the envelope counts', async (t) => {
    const fx = await scriptedEngine(t, { config: { domain_memory_max: DOMAIN_MEMORY_MAX } });
    // The default: role_memory_max 4 GiB, under the 6 GiB ceiling.
    const p = await sessionProject(fx);
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [turnThatSays('Hello.')]);
    await sayAndSettle(fx, p.id, run.id, 'Hi.');
    const [domain] = domainsOfRun(fx.home, run.id);
    assert.ok(domain, 'the turn had a domain');
    assert.equal(domain.memory_max, 4 * GIB, `its memory_max is the default role_memory_max, 4 GiB, not the ceiling (${JSON.stringify(domain)})`);
    await closeSession(fx, p.id, run.id);

    // The project's own value.
    await changePolicy(fx.engine, p.id, { role_memory_max: ROLE_MEMORY_MAX });
    const second = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, second.id, [turnThatSays('Hello again.')]);
    await sayAndSettle(fx, p.id, second.id, 'Hi.');
    const [again] = domainsOfRun(fx.home, second.id);
    assert.ok(again, 'the second session\'s turn had a domain');
    assert.equal(again.memory_max, ROLE_MEMORY_MAX, `its memory_max is the project's role_memory_max (${JSON.stringify(again)})`);
  });

  test('(d) a session while a one-shot runs: refused session_busy until the run ends, then admitted', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await sessionProject(fx);
    const item = await addWork(fx.engine, p.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([])]);
    await tick(fx.engine, p.id, { rounds: 1 });
    await waitFor(() => fx.scripted.launches({ work_item: item })[0], { what: 'the one-shot to be running' });
    assertRefused(await openRaw(fx, p.id), 409, 'session_busy', 'a session while the one-shot runs');
    fx.scripted.release(item, 'gate');
    await waitForRun(fx.home, item, { state: 'ended' });
    const res = await openRaw(fx, p.id);
    assert.equal(res.status, 201, `admitted once the run ended (→ ${res.status} ${res.text})`);
  });

  test('(e) an opening racing a claim, in both orders: exactly one admitted', async (t) => {
    // Order 1: the opening held at its admission; the one-shot is claimed meanwhile.
    {
      const fx = await scriptedEngine(t);
      const p = await sessionProject(fx);
      const item = await addWork(fx.engine, p.id, 'fix');
      fx.scripted.script(item, [roleThatHolds([])]);
      await pauseAt(fx, ADMISSION);
      const opening = openRaw(fx, p.id);
      await reached(fx, ADMISSION, 'the opening\'s admission');
      await tick(fx.engine, p.id, { rounds: 1 });
      await release(fx, ADMISSION);
      const res = await opening;
      const claimed = runsOf(fx.home, item).length > 0;
      assert.equal((res.status === 201 ? 1 : 0) + (claimed ? 1 : 0), 1, `order 1: exactly one of the opening (${res.status}) and the claim (${claimed}) admitted`);
      if (res.status !== 201) assert.equal(res.body?.code, 'session_busy');
      if (claimed) fx.scripted.release(item, 'gate');
    }
    // Order 2: the claim held after its run is created; the opening meanwhile.
    {
      const fx = await scriptedEngine(t);
      const p = await sessionProject(fx);
      const item = await addWork(fx.engine, p.id, 'fix');
      fx.scripted.script(item, [roleThatHolds([])]);
      await pauseAt(fx, 'dispatch.run_created');
      const ticking = tick(fx.engine, p.id, { rounds: 1 }).catch(() => null);
      await reached(fx, 'dispatch.run_created', 'the one-shot\'s claim');
      const res = await openRaw(fx, p.id);
      await release(fx, 'dispatch.run_created');
      await ticking;
      assertRefused(res, 409, 'session_busy', 'order 2: the opening after the claim');
      fx.scripted.release(item, 'gate');
    }
  });

  test('(f) no project run counter: max_concurrent_runs is not a project setting', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await sessionProject(fx);
    const res = await fx.engine.post(`/v1/projects/${p.id}/policy`, { max_concurrent_runs: 2 });
    assert.ok(res.status >= 400 && res.status < 500, `refused (→ ${res.status} ${res.text})`);
    const cols = withStore(fx.home, (db) => db.prepare('PRAGMA table_info("projects")').all().map((c) => c.name));
    assert.ok(!cols.includes('running_runs') && !cols.includes('run_count'), 'no project run counter column');
  });
});
