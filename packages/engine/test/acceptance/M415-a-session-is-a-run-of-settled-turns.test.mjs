// M415, a session is a run; a turn is an invocation (slice 33; SANDBOX lane:
// real `role` domains under D2's launcher, the scripted backend, no model).
// M5 plan §3.3 M415; D6-S01, D6-S02; D6 §2.1, §2.2; K6; E10; B01; D2 §1,
// §4.3 (the provider-files inventory, SEAM.md §152); SEAM.md §§344, 388.
// Not re-tested (M401 on the project lane, slice 31b): a turn's result parsed
// as its reply, a second turn launching, a turn's writes materialized at
// settlement.
//   (a) open: a run of kind `session` with its grant, workspace and lease; no
//       domain and no process;
//   (b) a turn: one invocation receipt, one `role` domain, one ledger row with
//       the model requested; the turn's deadline `deadline_<role>`;
//   (c) between turns: no live process of the session, its domains
//       terminated;
//   (d) two turns: each a fresh volatile home; a provider file the first left
//       under /surety/home is absent at the second (inventoried after the
//       first, never carried);
//   (e) no ledger row for the session itself;
//   (f) the cumulative budget, checked before each turn: at exhaustion no
//       turn admitted and the session closed `budget_exhausted`;
//   (g) a turn ending in unknown termination: the session not idle until
//       recovery settles the turn `unknown` on its own row.
//
// SAFETY (BS5 §4.1; E64): the scripted role program in the test's own
// domains; the test signals nothing but its own engine (the verified kill).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { changePolicy } from './harness/journal.mjs';
import { tick } from './harness/runs.mjs';
import { roleAlive, sandboxEngine } from './harness/sandbox/lane.mjs';
import { members } from './harness/sandbox/procs.mjs';
import { acting, hostNamespaces, step } from './harness/scripted.mjs';
import { ledgerRowsOf, openSession, postTurn, runRow, say, sayAndSettle, scriptTurns, turnResult, turnRows, turnThatSays } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';
import { countRows, domainsOfRun, invocationsOf, postTurnRaw, sessionProject, sessionState } from './harness/session-lane.mjs';

const PROVIDER_FILE = '/surety/home/.claude/projects/session.jsonl';
const recordsOfKind = (home, project, kind) => withStore(home, (db) => db.prepare('SELECT * FROM "records" WHERE "project" = ? AND "kind" = ?').all(project, kind));

async function session(t, turns, { config } = {}) {
  const fx = await sandboxEngine(t, { config });
  const p = await sessionProject(fx);
  const run = await openSession(fx, p.id, 'vision');
  scriptTurns(fx, run.id, turns);
  return { fx, p, run };
}

describe('M415 a session is a run of settled turns, in real role domains', () => {
  test('(a) open: a session run with grant, workspace and lease, no domain, no process; (b) a turn: one receipt, one role domain, one ledger row, the role\'s deadline; (c) between turns nothing lives; (e) no ledger row for the session itself', async (t) => {
    const { fx, p, run } = await session(t, [turnThatSays('One.'), turnThatSays('Two.')]);
    const row = runRow(fx.home, run.id);
    assert.ok(row.grant && row.workspace, `a grant and a workspace (${JSON.stringify({ grant: row.grant, workspace: row.workspace })})`);
    assert.equal(countRows(fx.home, 'leases', `"resource_kind" = 'run' AND "resource_id" = ? AND "released_at" IS NULL`, run.id), 1, 'a lease');
    assert.deepEqual([domainsOfRun(fx.home, run.id).length, fx.scripted.launches({ run: run.id }).length], [0, 0], 'no domain and no process at open');
    const started = Date.now();
    await sayAndSettle(fx, p.id, run.id, 'First.');
    const receipts = invocationsOf(fx.home, run.id);
    const domains = domainsOfRun(fx.home, run.id);
    assert.equal(receipts.length, 1, 'one invocation receipt for the turn');
    assert.deepEqual(domains.map((d) => [d.profile, d.status]), [['role', 'terminated']], 'one role domain, terminated');
    const ledger = ledgerRowsOf(fx.home, p.id, run.id);
    assert.equal(ledger.length, 1, 'one ledger row for the turn');
    assert.ok(ledger[0].model_requested && 'billable_in' in ledger[0] && 'cached_in' in ledger[0], `with the model requested and the token counts (${JSON.stringify(ledger[0])})`);
    const deadline = Date.parse(receipts[0].deadline_at ?? row.deadline_at);
    assert.ok(Math.abs(deadline - (started + 1800 * 1000)) < 120_000, `the turn's deadline is deadline_vision, 30 m (${receipts[0].deadline_at ?? row.deadline_at})`);
    // (c)
    assert.equal(sessionState(fx.home, run.id), 'open_idle');
    // Read host-side (the gate on mini-hp01, 2026-10-13): a launch's `pid` is its pid inside the domain's pid
    // namespace and is never compared with the host's. Each turn's domain is terminated and its cgroup has no
    // member, and no member of any of them is the role program of one of this session's invocations.
    const live = domainsOfRun(fx.home, run.id).flatMap((d) => {
      let inside = [];
      try {
        inside = d.cgroup_path ? members(d.cgroup_path) : [];
      } catch {
        inside = [];
      }
      return inside.map((m) => ({ domain: d.id, status: d.status, pid: m.pid, cmdline: m.cmdline }));
    });
    assert.ok(domainsOfRun(fx.home, run.id).every((d) => d.status === 'terminated'), 'every turn\'s domain terminated between turns');
    assert.deepEqual(live, [], 'no live process in any of the session\'s domains between turns');
    assert.deepEqual(fx.scripted.launches({ run: run.id }).filter((l) => { const d = domainsOfRun(fx.home, run.id).find((x) => x.invocation === l.invocation); return d ? roleAlive(d, l) : false; }).map((l) => l.invocation), [], 'no role program of the session alive');
    await sayAndSettle(fx, p.id, run.id, 'Second.');
    // (e)
    assert.equal(ledgerRowsOf(fx.home, p.id, run.id).length, 2, 'one ledger row a turn and none for the session');
  });

  test('(d) two turns: a fresh volatile home each; the provider file the first left is not carried to the second', async (t) => {
    const leave = { steps: [acting(hostNamespaces()).volatileShapes({ files: [{ path: PROVIDER_FILE, content: '{"session":"one"}\n' }] }), step.result(turnResult({ reply: 'Left a provider file.' }))] };
    const look = { steps: [step.probe('stat_paths', { paths: [PROVIDER_FILE] }), step.result(turnResult({ reply: 'Looked.' }))] };
    const { fx, p, run } = await session(t, [leave, look]);
    await sayAndSettle(fx, p.id, run.id, 'Leave it.');
    await sayAndSettle(fx, p.id, run.id, 'Look for it.');
    const [, second] = invocationsOf(fx.home, run.id);
    const [stat] = fx.scripted.probes(second.id, 'stat_paths');
    assert.ok(stat, 'the fixture is live: the second turn looked');
    assert.equal(stat.results?.[0]?.outcome, 'failed', `the first turn's provider file is absent at the second (${JSON.stringify(stat.results)})`);
    assert.ok(recordsOfKind(fx.home, p.id, 'provider_files').length >= 1, 'the first turn\'s volatile home was inventoried');
    const homes = fx.scripted.launches({ run: run.id }).map((l) => l.env_hashes?.HOME ?? l.home ?? null);
    if (homes.every((h) => h !== null)) assert.notEqual(homes[0], homes[1], 'a fresh volatile home each');
  });

  test('(f) the cumulative budget checked before each turn: at exhaustion no turn admitted; closed budget_exhausted', async (t) => {
    const spend = { steps: [step.usage({ input_tokens: 9990, output_tokens: 10 }), step.result(turnResult({ reply: 'Spent.' }))] };
    const { fx, p, run } = await session(t, [spend, turnThatSays('Never.')]);
    await changePolicy(fx.engine, p.id, { budget_run_billable_tokens: 10000 });
    // The session closes at this settlement (the slice-33 review's M5): read with `say`, not as idle again.
    await say(fx, p.id, run.id, 'Spend.');
    // Closed at that settlement (objection 079): no later turn posted, no clock advanced.
    const ended = await waitFor(() => (runRow(fx.home, run.id).state === 'ended' ? runRow(fx.home, run.id) : undefined), { what: 'the session to close at the settlement' });
    const res = await postTurnRaw(fx, p.id, run.id, 'More.');
    assert.ok(res.status >= 400, `no turn admitted (→ ${res.status} ${res.text})`);
    // `budget_exhausted` is the public code of reason class `budget`, not a RunOutcome (D6 A.2; the driver's ruling).
    assert.equal(ended.reason_class, 'budget', `ended with reason class budget (${JSON.stringify([ended.outcome, ended.reason_class])})`);
    const read = await fx.engine.get(`/v1/projects/${p.id}/runs/${run.id}`);
    assert.equal(read.body?.run?.code, 'budget_exhausted', `its public code budget_exhausted (${read.text})`);
  });

  test('(g) a turn whose termination is unknown: not idle until recovery settles it unknown on its own row', async (t) => {
    const hold = { steps: [step.hold('gate')] };
    const { fx, p, run } = await session(t, [hold]);
    await postTurn(fx, p.id, run.id, 'Hold.');
    await tick(fx.engine, p.id, { rounds: 1 });
    await waitFor(() => fx.scripted.launches({ run: run.id })[0], { what: 'the turn to be running' });
    await fx.engine.kill();
    await fx.start();
    assert.notEqual(sessionState(fx.home, run.id), 'open_idle', 'not idle before recovery settles the turn');
    await tick(fx.engine, p.id, { rounds: 3 });
    const turn = await waitFor(() => turnRows(fx.home, run.id).find((x) => x.settled_at), { what: 'the turn to be settled by recovery', timeoutMs: 120_000 });
    assert.equal(turn.outcome, 'unknown', `settled unknown on its own row (${JSON.stringify(turn)})`);
    fx.scripted.release('all', 'gate');
  });
});
