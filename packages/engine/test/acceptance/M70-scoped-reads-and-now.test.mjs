// M70, scoped reads, NOW and source ages (slice 6). Plan §3.7 M70; D1 §§11.1,
// 11.3, 12.2 to 12.4, 13.1, 14, D1-28; Review §8.3 and N03; SEAM.md §91.
//
// Four fixtures.
//
// One engine with six projects in the states the row names, read by four
// cases: NOW is one of five values by a fixed priority (refused, waiting on
// you, running, ready, idle); the execution and spend facts beside it stay
// what they are, whatever NOW says (a run is listed as executing while NOW
// says the project waits on a person; a project that never dispatched is not
// a project that spent nothing known); and reading changes nothing and
// calls no adapter.
//
// One stored observation with a time of its own: reads never move it, and
// once its freshness bound has passed it is projected as Unknown, with the
// stored observation untouched. M1 builds no observation job and no
// observation history (Plan §4, D1-28), so the observation enters as a
// fixture and says so.
//
// One engine for the record reads that must refuse: another project's
// record, and a record whose file was replaced by a link, a named pipe, a
// link to a device, or content of another size. Each is refused promptly and
// in the engine's form, discloses nothing, and leaves the engine answering.
// A real device node cannot be made without privilege; a link to one is as
// far as an unprivileged test reaches, and that is what the case builds.
//
// One engine with two projects, each with a Stop asked for and not confirmed,
// for the decisions read (D1 §11.3; E39): a project's open decisions are
// listed with what a person needs to answer one, another project's are not
// shown, and a consumed decision is no longer listed.
//
// Two more reads, one case each, added after M1 was accepted (D1 §11.3; E44
// item 3, E47; SEAM.md §98). A project's work items: each with its kind,
// status, subject, trigger and chain, and when it is blocked the blocker
// (its reason, the decision it waits on, the options offered); the fixture
// has one item waiting at the chain boundary and one parked. A candidate's
// gate: the latest recorded evaluation of a gate kind with its outcome, its
// reasons naming their subjects, the scope's required checks with their
// states, and whether it is stale; the read evaluates nothing, so before an
// evaluation it is not found. Both are scoped to the project and write
// nothing. The reads D1 §11.3 lists that remain unpinned: one decision by
// id, operations, environments as a route of their own.
//
// M2 slice 2 (`docs/spec/M2-slice-2-legibility.md`, entries B3 and B4;
// SEAM.md §§107, 108) adds two blocks. NOW's other causes: `refused` when
// the repository cannot be read, when an out-of-band change of the
// integration branch is unresolved, and when the store fails (the budget
// read of row M61), each naming its cause; `unknown` when the status cannot
// be computed. And the three reads that were left: one decision by its
// identifier, a project's git operations (pending and blocked ones included),
// and its environments as a route of their own.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, ftruncateSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { armFault, clearFaults, isRefusalBody, releaseBarrier, waitFor } from './harness/engine.mjs';
import { assertRefused, eventsSince, maxEventSeq } from './harness/fixtures.mjs';
import { assertPreview, consume, decision, openDecision, reachBarrier } from './harness/decisions.mjs';
import { addEnvironment, check, evaluationsOf, installChecks, nominated, passedInventory, postResult, scopeOf, sharedFixture, stageGate } from './harness/gates.mjs';
import { addGitProject, addItem, permittedEdit, roleThat, runToEnd } from './harness/gitruns.mjs';
import { armBarrier, changePolicy, journalBarrier, operationDetails, outOfBand, registryOf, workItemsOf } from './harness/journal.mjs';
import { awayFromMidnight, getLedger } from './harness/ledger.mjs';
import { sleep, timed } from './harness/mono.mjs';
import { arrange, killedAt } from './harness/probes.mjs';
import { boundedGet, listDecisions, listEnvironments, listOperations, listProjects, listWork, readDecision, readGate, readProject, readRun } from './harness/reads.mjs';
import { readRecord, recordFile, recordRow } from './harness/records.mjs';
import { commitOnRef, makeUnreadable, refOid } from './harness/repos.mjs';
import { addProject, addWork, advanceClock, runsOf, scriptedEngine, tick, tickOnce, tickUntil, waitForQuarantine, waitForRun, waitForWork, workItem } from './harness/runs.mjs';
import { BOUNDARY, script } from './harness/scripted.mjs';
import { dumpStore, withStore } from './harness/store.mjs';

const NOW_STATES = ['refused', 'waiting_on_you', 'running', 'ready', 'idle'];
const SPEND_KEYS = ['no_dispatch', 'invocations', 'billable_in', 'cached_in', 'out', 'usage_incomplete', 'reported_usd', 'estimated_usd', 'unknown_cost_invocations', 'unknown_cost_tokens'];

describe('M70 NOW, and the execution and spend facts beside it', () => {
  const shared = sharedFixture();
  const ctx = {};
  after(() => shared.cleanup());

  // Six projects, each brought to its state by the engine's own paths.
  let built = null;
  const fixture = () =>
    (built ??= (async () => {
      await awayFromMidnight();
      const fx = await scriptedEngine(shared.context, { config: { max_concurrent_runs: 8 } });
      const engine = fx.engine;
      ctx.fx = fx;
      fx.scripted.defaultScript(script.complete());
      const p = {};
      const item = {};
      const run = {};

      // "spent": one run that completed and reported no usage at all.
      p.spent = (await addProject(fx)).id;
      item.spent = await addWork(engine, p.spent, 'verification');
      await tick(engine, p.spent);
      run.spent = await waitForRun(fx.home, item.spent, { state: 'ended' });

      // "quarantined": a run whose termination the boundary cannot establish.
      p.quarantined = (await addProject(fx)).id;
      fx.scripted.boundary({ default: BOUNDARY.unknown });
      item.quarantined = await addWork(engine, p.quarantined, 'verification');
      await tick(engine, p.quarantined);
      run.quarantined = await waitForRun(fx.home, item.quarantined);
      await waitForQuarantine(fx.home, run.quarantined.id);
      const domain = withStore(fx.home, (db) => db.prepare('SELECT "id" FROM "execution_domains" WHERE "run" = ?').get(run.quarantined.id).id);
      fx.scripted.boundary({ default: BOUNDARY.auto, domains: { [domain]: BOUNDARY.unknown } });

      // "waiting" and "running": each with a role under way. A Stop is asked
      // for in "waiting" and not confirmed: an open decision beside a live run.
      p.waiting = (await addProject(fx)).id;
      p.running = (await addProject(fx)).id;
      for (const key of ['waiting', 'running']) {
        item[key] = await addWork(engine, p[key], 'verification');
        fx.scripted.script(item[key], [script.hold('gate', { heartbeat_ms: 0 })]);
      }
      await tick(engine, p.waiting);
      for (const key of ['waiting', 'running']) {
        run[key] = await waitForRun(fx.home, item[key], { state: 'executing' });
        await fx.scripted.waitForHolding({ run: run[key].id });
      }
      assertRefused(await engine.post(`/v1/projects/${p.waiting}/runs/${run.waiting.id}/stop`, {}), 409, 'confirm_required', 'the unconfirmed Stop');

      // "untouched": nothing was ever dispatched. "ready": eligible work that no tick has seen yet.
      p.untouched = (await addProject(fx)).id;
      p.ready = (await addProject(fx)).id;
      item.ready = await addWork(engine, p.ready, 'verification');

      Object.assign(ctx, { engine, p, item, run });
      return ctx;
    })());

  const EXPECTED_NOW = { quarantined: 'refused', waiting: 'waiting_on_you', running: 'running', ready: 'ready', spent: 'idle', untouched: 'idle' };

  test('NOW is one state per project, by priority: a quarantine is refused although a decision is open; an open decision is waiting on you although a run is executing; then running, ready, idle', async () => {
    const { engine, p } = await fixture();
    const list = await listProjects(engine);
    const listed = Object.fromEntries(list.projects.map((project) => [project.id, project]));
    assert.deepEqual(Object.keys(listed).sort(), Object.values(p).sort(), 'the list holds the six projects, each once');
    for (const [key, state] of Object.entries(EXPECTED_NOW)) {
      const now = listed[p[key]].now;
      assert.ok(NOW_STATES.includes(now?.state), `the ${key} project has a NOW state (${JSON.stringify(now)})`);
      assert.equal(now.state, state, `NOW of the ${key} project (reason given: ${now.reason})`);
      assert.ok(typeof now.reason === 'string' && now.reason.length > 0, `NOW of the ${key} project says why, in a sentence`);
      assert.ok('primary_action' in now, `NOW of the ${key} project names its primary action, or null`);
      const detail = (await readProject(engine, p[key])).project;
      assert.equal(detail.now?.state, state, `the ${key} project's own projection gives the same NOW as the list`);
    }
  });

  test('the execution facts stay true beside NOW: the run of a project that waits on a person is listed as executing, and a quarantined run as quarantined', async () => {
    const { engine, p, run } = await fixture();
    const facts = {};
    for (const key of Object.keys(EXPECTED_NOW)) facts[key] = (await readProject(engine, p[key])).project;
    const runsOf = (key) => facts[key].execution?.runs?.map((row) => ({ id: row.id, state: row.state, quarantined: row.quarantined }));

    assert.deepEqual(runsOf('waiting'), [{ id: run.waiting.id, state: 'executing', quarantined: false }], 'NOW says waiting on you, and the execution facts still show the run executing');
    assert.ok(facts.waiting.open_decisions?.count >= 1, 'with its open decision counted');
    assert.deepEqual(runsOf('running'), [{ id: run.running.id, state: 'executing', quarantined: false }]);
    assert.equal(facts.running.open_decisions?.count, 0, 'a project nobody is asked about has no open decision');
    assert.deepEqual(runsOf('quarantined'), [{ id: run.quarantined.id, state: 'finalizing', quarantined: true }], 'a quarantined run is shown as what it is: not ended, quarantined');
    assert.ok(facts.quarantined.open_decisions?.count >= 1, 'with its blocker counted');
    for (const key of ['spent', 'untouched', 'ready']) assert.deepEqual(runsOf(key), [], `the ${key} project has no run under way`);
  });

  test('no dispatch is not unknown spend, and neither is zero: a project that never dispatched says so with null amounts; one that dispatched a role that reported nothing has one invocation of unknown cost', async () => {
    const { engine, p } = await fixture();
    const list = await listProjects(engine);
    const spendOf = async (key) => {
      const spend = (await readProject(engine, p[key])).project.spend_today;
      for (const name of SPEND_KEYS) assert.ok(spend && name in spend, `spend_today of the ${key} project has "${name}" (${JSON.stringify(spend)})`);
      assert.deepEqual(list.projects.find((project) => project.id === p[key]).spend_today, spend, `the list repeats the ${key} project's spend`);
      return spend;
    };
    const untouched = await spendOf('untouched');
    assert.deepEqual(
      [untouched.no_dispatch, untouched.invocations, untouched.reported_usd, untouched.estimated_usd, untouched.unknown_cost_invocations, untouched.billable_in],
      [true, 0, null, null, 0, null],
      'a project that dispatched nothing: no dispatch, and no amount, which is not an amount of zero',
    );
    const spent = await spendOf('spent');
    assert.deepEqual(
      [spent.no_dispatch, spent.invocations, spent.reported_usd, spent.unknown_cost_invocations, spent.usage_incomplete],
      [false, 1, null, 1, 1],
      'a project whose one invocation reported nothing: dispatched, cost unknown, not zero',
    );
    // The projection is the ledger's own account of the day.
    const totals = (await getLedger(engine, p.spent)).totals;
    for (const name of SPEND_KEYS.filter((key) => key !== 'no_dispatch')) assert.deepEqual(spent[name], totals[name], `spend_today.${name} is the ledger's total`);
  });

  test('reading changes nothing and calls no adapter: after repeated reads of every projection no row has changed, no event was written for a read, no role was launched, and the facts are the same facts', async () => {
    const { engine, fx, p, run } = await fixture();
    const stored = () => withStore(fx.home, (db) => dumpStore(db, { exclude: ['events', 'engine_incarnations', 'leases'] }));
    const facts = async () => {
      const out = {};
      for (const key of Object.keys(EXPECTED_NOW)) {
        const project = (await readProject(engine, p[key])).project;
        out[key] = { now: project.now.state, runs: project.execution.runs, decisions: project.open_decisions, spend: project.spend_today };
      }
      return out;
    };
    const before = stored();
    const seq = maxEventSeq(fx.home);
    const launches = fx.scripted.launches().length;
    const first = await facts();
    let lastSnapshot = 0;
    for (let round = 0; round < 5; round++) {
      const list = await listProjects(engine);
      assert.ok(list.snapshot_seq >= lastSnapshot && list.snapshot_seq <= maxEventSeq(fx.home), 'a read names the store snapshot it was computed from');
      lastSnapshot = list.snapshot_seq;
      await facts();
      await readRun(engine, p.waiting, run.waiting.id);
      await getLedger(engine, p.spent);
    }
    assert.deepEqual(await facts(), first, 'the last read gives the facts the first one gave');
    assert.deepEqual(stored(), before, 'no stored row changed while the projections were read');
    const written = [...new Set(eventsSince(fx.home, seq).map((event) => event.type))];
    assert.deepEqual(written.filter((type) => !['run.heartbeat', 'engine.tick'].includes(type)), [], 'no event was written for a read');
    assert.equal(fx.scripted.launches().length, launches, 'no role was launched by a read');
  });
});

describe('M70 the decisions read', () => {
  test("a project's open decisions are listed with what a person needs to answer one: kind, subject, question, options and preview hash; another project's are not shown; a consumed decision is no longer listed", async (t) => {
    const fx = await scriptedEngine(t);
    const engine = fx.engine;

    // Two projects, each with a role under way and a Stop asked for and not confirmed: one open decision each.
    const p = {};
    const item = {};
    const run = {};
    const row = {};
    for (const key of ['mine', 'other']) {
      p[key] = (await addProject(fx)).id;
      item[key] = await addWork(engine, p[key], 'verification');
      fx.scripted.script(item[key], [script.hold('gate', { heartbeat_ms: 0 })]);
    }
    await tick(engine, p.mine);
    for (const key of ['mine', 'other']) {
      run[key] = await waitForRun(fx.home, item[key], { state: 'executing' });
      await fx.scripted.waitForHolding({ run: run[key].id });
      const asked = await engine.post(`/v1/projects/${p[key]}/runs/${run[key].id}/stop`, {});
      assertRefused(asked, 409, 'confirm_required', `the unconfirmed Stop of the ${key} project`);
      row[key] = decision(fx.home, asked.body.subject?.decision);
      assert.equal(row[key]?.status, 'open', `the fixture is live: the ${key} project has an open decision`);
    }

    // The read shows each project its own open decision, as its row has it, and nothing of the other's.
    const shownTo = async (key) => (await listDecisions(engine, p[key])).decisions;
    for (const key of ['mine', 'other']) {
      const listed = await shownTo(key);
      assert.deepEqual(listed.map((shown) => shown.id), [row[key].id], `the ${key} project is shown its own open decision and no other project's`);
      const [shown] = listed;
      assert.deepEqual(
        [shown.kind, shown.subject_type, shown.subject_id, shown.question, shown.preview_hash],
        ['stop_confirm', 'run', run[key].id, row[key].question, row[key].preview_hash],
        'with its kind, its subject, its question and its preview hash, as its row has them',
      );
      assert.ok(typeof shown.question === 'string' && shown.question.length > 0, 'the question is a sentence a person can read');
      assert.ok(Array.isArray(shown.options), `and its options (${JSON.stringify(shown.options)})`);
      assert.deepEqual(
        shown.options.map((option) => [option.key, option.plan_hash, option.effect_plan]),
        row[key].options.map((option) => [option.key, option.plan_hash, option.effect_plan]),
        "each option with its key, its effect plan and that plan's hash, as stored",
      );
      assert.deepEqual(shown.options.map((option) => option.key), ['confirm'], 'a Stop offers its confirmation');
      assert.equal((await readProject(engine, p[key])).project.open_decisions?.count, 1, "the project's own projection counts the decision the read lists");
    }

    // What the read showed is enough to answer: the Stop is confirmed with the preview hash taken from the read, not from the store.
    const [mine] = await shownTo('mine');
    const confirmed = await engine.post(`/v1/projects/${p.mine}/runs/${run.mine.id}/stop`, { preview_hash: mine.preview_hash });
    assert.equal(confirmed.status, 200, `the Stop confirmed with the preview hash the read showed (body: ${confirmed.text})`);
    assert.equal(decision(fx.home, row.mine.id).status, 'consumed', 'the fixture is live: the decision is consumed');

    // A consumed decision is not among the open decisions; the other project's list is as it was.
    assert.deepEqual(await shownTo('mine'), [], 'the consumed decision is no longer listed');
    assert.equal((await readProject(engine, p.mine)).project.open_decisions?.count, 0, "and the project's own projection counts none");
    assert.deepEqual((await shownTo('other')).map((shown) => [shown.id, shown.preview_hash]), [[row.other.id, row.other.preview_hash]], "the other project's open decision is still listed, unchanged");
  });
});

// What a read may not do (SEAM.md §91): change a row, write an event, launch
// a role. `exclude` is the existing read-purity case's: the log, the engine's
// bookkeeping, and the leases the engine renews on its own.
const quiet = (fx) => {
  const stored = () => withStore(fx.home, (db) => dumpStore(db, { exclude: ['events', 'engine_incarnations', 'leases'] }));
  const before = { rows: stored(), seq: maxEventSeq(fx.home), launches: fx.scripted.launches().length };
  return (what) => {
    assert.deepEqual(stored(), before.rows, `${what}: no stored row changed`);
    const written = [...new Set(eventsSince(fx.home, before.seq).map((event) => event.type))];
    assert.deepEqual(written.filter((type) => !['run.heartbeat', 'engine.tick'].includes(type)), [], `${what}: no event was written for a read`);
    assert.equal(fx.scripted.launches().length, before.launches, `${what}: no role was launched by a read`);
  };
};

describe('M70 the work read', () => {
  test("a project's work items are listed with kind, status, subject, trigger and chain, and a blocked item with its blocker: the reason, the decision it waits on and the options offered; another project's items are not shown; reading writes nothing", async (t) => {
    const fx = await scriptedEngine(t);
    const engine = fx.engine;

    // A project whose first stage was built, integrated and nominated. The
    // candidate's verification, which the engine made on the Builder's run,
    // waits at the chain boundary (SEAM.md §40): eligible, not dispatched,
    // with a blocker decision offering continue and cancel.
    const ctx = await nominated(fx);
    const mine = ctx.project.id;
    const stageWork = ctx.items[0];
    const verification = workItemsOf(fx.home, mine).find((work) => work.kind === 'verification' && work.subject?.candidate === ctx.candidate.id);
    assert.ok(verification, 'the fixture is live: the nomination created verification work');
    const boundary = await openDecision(fx, mine, 'blocker', verification.id);

    // And one item a fixture made that is parked: a fix whose one permitted
    // run crashed (SEAM.md §15), with a blocker decision offering retry and cancel.
    await changePolicy(engine, mine, { repair_attempts_max: 0 });
    const fix = await addItem(fx, mine, 'fix');
    fx.scripted.script(fix, [script.crash(3)]);
    await runToEnd(fx, mine, fix);
    await waitForWork(fx.home, fix, 'parked');
    const parked = await openDecision(fx, mine, 'blocker', fix);

    // Another project with an item of its own: eligible, nothing blocks it.
    const other = (await addProject(fx)).id;
    const theirs = await addWork(engine, other, 'verification');

    const rows = Object.fromEntries(workItemsOf(fx.home, mine).map((work) => [work.id, work]));
    assert.deepEqual(
      [stageWork, verification.id, fix].map((id) => [rows[id].status, rows[id].blocker?.reason ?? null, rows[id].blocker?.decision ?? null]),
      [['verifying', null, null], ['eligible', 'max_chained_roles', boundary.id], ['parked', 'repair_attempts_max', parked.id]],
      'the fixture is live: the stage work is verifying with no blocker, the verification waits at the chain boundary, the fix is parked, and each blocker names its decision',
    );

    // The read lists the project's items, each as its row has it.
    const listed = (await listWork(engine, mine)).work_items;
    assert.deepEqual(listed.map((shown) => shown.id), Object.keys(rows), "every work item of the project, each once, oldest first, and no other project's");
    for (const shown of listed) {
      const row = rows[shown.id];
      assert.deepEqual(
        [shown.kind, shown.status, shown.subject, shown.trigger_source, shown.trigger_id, shown.trigger_generation, shown.chain],
        [row.kind, row.status, row.subject, row.trigger_source, row.trigger_id, row.trigger_generation, row.chain],
        `item ${shown.id} is shown with its kind, status, subject, trigger and chain, as its row has them`,
      );
    }
    const shown = Object.fromEntries(listed.map((item) => [item.id, item]));
    assert.deepEqual(
      [stageWork, verification.id, fix].map((id) => [shown[id].kind, shown[id].status, shown[id].chain]),
      [['stage_build', 'verifying', 0], ['verification', 'eligible', 1], ['fix', 'parked', 0]],
      "the stage's work (a fixture's, chain 0) is verifying; the verification the engine made on the Builder's run (chain 1) is eligible; the fix (a fixture's) is parked",
    );
    assert.deepEqual([shown[stageWork].subject, shown[verification.id].subject], [{ stage: ctx.stage }, { candidate: ctx.candidate.id }], 'each with what it is about');
    assert.equal(shown[stageWork].blocker, null, 'an item nothing blocks has no blocker');

    // A blocked item carries its blocker: why, which decision, and what can be answered.
    const blocked = (id, decision, offered) => {
      const blocker = shown[id].blocker;
      assert.ok(blocker && typeof blocker === 'object', `the blocked item ${id} shows its blocker (${JSON.stringify(shown[id])})`);
      assert.deepEqual([blocker.reason, blocker.raised_at, blocker.decision], [rows[id].blocker.reason, rows[id].blocker.raised_at, decision.id], `the blocker of ${id}: its reason, when it was raised and the open decision that holds the item, as stored`);
      assert.ok(Array.isArray(blocker.options), `and the options that decision offers (${JSON.stringify(blocker)})`);
      assert.deepEqual(blocker.options.map((option) => option.key), decision.options.map((option) => option.key), 'each with its key, in the stored order');
      assert.deepEqual([...blocker.options.map((option) => option.key)].sort(), offered, `the answers a person can give for ${blocker.reason}`);
    };
    blocked(verification.id, boundary, ['cancel', 'continue']);
    assert.equal(shown[verification.id].blocker.reason, 'max_chained_roles', 'the verification waits for a person at the chain boundary');
    blocked(fix, parked, ['cancel', 'retry']);
    assert.equal(shown[fix].blocker.reason, 'repair_attempts_max', 'the fix is parked at the repair limit');

    // The other project sees its own item and nothing of the first project's.
    assert.deepEqual(
      (await listWork(engine, other)).work_items.map((item) => [item.id, item.kind, item.status, item.chain, item.blocker]),
      [[theirs, 'verification', 'eligible', 0, null]],
      "the other project's one item, eligible and unblocked, and none of the first project's",
    );

    // Reading writes nothing.
    const unchanged = quiet(fx);
    for (let round = 0; round < 3; round++) {
      await listWork(engine, mine);
      await listWork(engine, other);
    }
    unchanged('after six reads of the work of two projects');
  });
});

describe('M70 the gate read', () => {
  const KEYS = ['id', 'gate_kind', 'outcome', 'reasons', 'check_states', 'scope', 'stale'];
  const pick = (evaluation) => Object.fromEntries(KEYS.map((key) => [key, evaluation?.[key]]));
  const fromRow = (row) => ({ id: row.id, gate_kind: row.gate_kind, outcome: row.outcome, reasons: JSON.parse(row.reasons), check_states: JSON.parse(row.check_states), scope: row.scope, stale: row.stale === 1 });

  test("a candidate's gate read returns the latest recorded evaluation of that kind, with its outcome, its reasons naming their subjects, the scope's required checks with their states, and whether it is stale; it evaluates nothing, so before any evaluation it is not found; another project's path is not found", async (t) => {
    const fx = await scriptedEngine(t);
    const engine = fx.engine;
    const ctx = await nominated(fx);
    const project = ctx.project.id;
    const candidate = ctx.candidate.id;
    const k = (await installChecks(engine, project, [check('login', { requirements: ['R1'] })])).id;
    const other = (await addProject(fx)).id;
    const path = (p) => `/v1/projects/${p}/candidates/${candidate}/gates/stage`;
    const recorded = () => evaluationsOf(fx.home, candidate, 'stage');

    // Before any evaluation: the read finds none, and makes none.
    assert.equal(recorded().length, 0, 'the fixture is live: no stage evaluation of the candidate has been recorded (its verification waits at the chain boundary)');
    const none = await engine.get(path(project));
    assertRefused(none, 404, 'not_found', 'the gate read before any evaluation');
    assert.deepEqual([none.body.subject?.candidate, none.body.subject?.gate_kind], [candidate, 'stage'], `the refusal names what was not found, the candidate and the gate kind (body: ${none.text})`);
    assert.equal(recorded().length, 0, 'the read evaluated nothing');

    // One evaluation, asked for by its route: not satisfied, the one required check missing.
    const first = await stageGate(fx, ctx);
    assert.deepEqual(
      [first.outcome, first.reasons, first.check_states],
      ['not_satisfied', [{ code: 'CHECK_NOT_PASSED', subjects: [k.login] }], { ...passedInventory(k), [k.login]: 'missing' }],
      'the fixture is live: the evaluation is not satisfied, for the check that was never executed',
    );
    assert.equal(recorded().length, 1);

    // The read returns that evaluation: what the route answered, and what the store holds.
    const shown = (await readGate(engine, project, candidate, 'stage')).evaluation;
    assert.deepEqual(pick(shown), pick(first), 'the read returns what the evaluation route answered: id, gate kind, outcome, reasons with their subjects, check states, scope, staleness');
    assert.deepEqual(pick(shown), fromRow(recorded()[0]), 'and what the store recorded, exactly');
    assert.deepEqual(Object.keys(shown.check_states).sort(), [...scopeOf(fx.home, recorded()[0]).required].sort(), "the check states are the scope's required checks, each with its state, and no other");
    assert.deepEqual([shown.outcome, shown.stale, shown.reasons.map((reason) => [reason.code, reason.subjects])], ['not_satisfied', false, [['CHECK_NOT_PASSED', [k.login]]]], 'not satisfied, not stale, and the reason names the check it is about');

    // A later evaluation of the same kind: the read returns the latest, not the first.
    await postResult(engine, project, { candidate, check: k.login, exit_status: 1 });
    const second = await stageGate(fx, ctx);
    assert.notEqual(second.id, first.id, 'the fixture is live: a second evaluation was recorded');
    assert.equal(second.check_states[k.login], 'failed', 'the fixture is live: the second evaluation saw the failed execution');
    const again = (await readGate(engine, project, candidate, 'stage')).evaluation;
    const latest = recorded().at(-1);
    assert.notEqual(latest.id, first.id);
    assert.deepEqual(pick(again), fromRow(latest), 'the read returns the latest recorded evaluation of the kind');
    assert.equal(again.check_states[k.login], 'failed');

    // Scoped to the project: the same candidate through another project's path is not found.
    assertRefused(await engine.get(path(other)), 404, 'not_found', "the gate read through another project's path");

    // Reading evaluates nothing and writes nothing, however often.
    const count = recorded().length;
    const unchanged = quiet(fx);
    for (let round = 0; round < 3; round++) {
      await readGate(engine, project, candidate, 'stage');
      await engine.get(path(other));
    }
    assert.equal(recorded().length, count, 'no evaluation was recorded by a read');
    unchanged('after six gate reads');
  });
});

describe('M70 a stored observation and its age', () => {
  test('reads never move the time of an observation, and once its freshness bound has passed it is projected as Unknown while the stored observation stays as it was', async (t) => {
    const fx = await scriptedEngine(t);
    const engine = fx.engine;
    const project = (await addProject(fx)).id;
    const environment = await addEnvironment(engine, project, { name: 'alpha', targets: ['alpha-1'] });
    // Ten seconds before the engine's own "now"; the project's freshness bound is its default, 90 s.
    const observedAt = new Date(Date.parse((await readProject(engine, project)).served_at) - 10_000).toISOString();
    const seeded = await engine.post('/v1/harness/fixtures/observation', { project, environment, condition: 'healthy', observed_at: observedAt, source: 'fixture-probe' });
    assert.equal(seeded.status, 201, `the observation fixture (body: ${seeded.text})`);

    const stored = () => withStore(fx.home, (db) => db.prepare('SELECT "observed" FROM "environment_records" WHERE "environment" = ?').get(environment)?.observed);
    const projected = async () => {
      const found = (await readProject(engine, project)).project.environments?.find((row) => row.id === environment);
      assert.ok(found?.observed, 'the project projection shows the environment with its observation');
      return found.observed;
    };
    const before = stored();
    assert.equal(JSON.parse(before).condition, 'healthy', 'the fixture is live: the observation is stored');

    for (let i = 0; i < 3; i++) {
      const seen = await projected();
      assert.deepEqual(
        [seen.condition, seen.observed_at, seen.source, seen.freshness],
        ['healthy', observedAt, 'fixture-probe', 'fresh'],
        'a fresh observation is shown with its own time and source, however often it is read',
      );
      assert.ok(['observed', 'claimed', 'configured'].includes(seen.provenance), `and says where the fact comes from (${seen.provenance})`);
    }
    assert.equal(stored(), before, 'reading did not touch the stored observation');

    await advanceClock(engine, 200);
    for (let i = 0; i < 2; i++) {
      const seen = await projected();
      assert.deepEqual([seen.condition, seen.freshness, seen.observed_at, seen.source], ['unknown', 'expired', observedAt, 'fixture-probe'], 'past its bound the observation is projected as Unknown, with the time it was really made');
    }
    assert.equal(stored(), before, 'the stored observation is still what was observed: expiry is computed at the read, not written by it');
  });
});

describe('M70 record reads that must refuse', () => {
  const shared = sharedFixture();
  const ctx = {};
  after(() => shared.cleanup());

  let built = null;
  const fixture = () =>
    (built ??= (async () => {
      const fx = await scriptedEngine(shared.context);
      fx.scripted.defaultScript(script.complete());
      Object.assign(ctx, { fx, engine: fx.engine, owner: (await addProject(fx)).id, other: (await addProject(fx)).id });
      return ctx;
    })());

  // A published record of the owner project, with its file and its bytes.
  async function publishedRecord() {
    const { fx, engine, owner } = await fixture();
    const item = await addWork(engine, owner, 'verification');
    const run = await runToEnd(fx, owner, item);
    assert.ok(run.result, 'the fixture is live: the run has a result record');
    const record = recordRow(fx.home, run.result);
    const file = recordFile(fx.home, record);
    const bytes = readFileSync(file);
    const served = await readRecord(engine, owner, record.id);
    assert.deepEqual([served.status, served.text], [200, bytes.toString('utf8')], 'the fixture is live: the record is served to its own project');
    return { record, file, bytes, path: `/v1/projects/${owner}/records/${record.id}` };
  }

  test("another project's record is not found, and nothing of it is disclosed", async () => {
    const { engine, other } = await fixture();
    const { record, bytes } = await publishedRecord();
    const res = await readRecord(engine, other, record.id);
    assertRefused(res, 404, 'not_found', "a record read through another project's path");
    assert.equal(res.text.includes(bytes.toString('utf8')), false, 'the refusal does not hold the record');
  });

  const SUBSTITUTIONS = [
    {
      what: 'a symbolic link, even one that leads to the same bytes',
      put: ({ file, bytes, fx }) => {
        const copy = join(fx.root, `copy-${Date.now()}`);
        writeFileSync(copy, bytes);
        rmSync(file);
        symlinkSync(copy, file);
      },
    },
    {
      what: 'a symbolic link to the API token',
      put: ({ file, engine }) => {
        rmSync(file);
        symlinkSync(engine.tokenPath(), file);
      },
      secret: ({ engine }) => engine.token(),
    },
    {
      what: 'a named pipe',
      put: ({ file }) => {
        rmSync(file);
        execFileSync('mkfifo', [file]);
      },
      // If the engine is waiting at the pipe, let it go, so the next case has an engine.
      undo: ({ file }) => {
        try {
          const fd = openSync(file, constants.O_WRONLY | constants.O_NONBLOCK);
          writeSync(fd, 'x');
          closeSync(fd);
        } catch {
          // nobody was waiting at the pipe
        }
      },
    },
    {
      what: 'a link to a device',
      put: ({ file }) => {
        rmSync(file);
        symlinkSync('/dev/zero', file);
      },
    },
    {
      what: 'content of another size (a gibibyte where a few bytes were recorded)',
      put: ({ file }) => {
        rmSync(file);
        const fd = openSync(file, 'w');
        ftruncateSync(fd, 1 << 30);
        closeSync(fd);
      },
    },
  ];

  for (const substitution of SUBSTITUTIONS) {
    test(`a record whose file was replaced by ${substitution.what} is refused promptly, discloses nothing, and does not hold the engine up`, async (t) => {
      const { fx, engine } = await fixture();
      const made = await publishedRecord();
      const scene = { ...made, fx, engine };
      substitution.put(scene);
      if (substitution.undo) t.after(() => substitution.undo(scene));

      const reading = boundedGet(engine, made.path, { maxBytes: 1 << 20, timeoutMs: 10_000 });
      await sleep(200);
      const health = await timed(() => engine.get('/v1/health'));
      assert.equal(health.value.status, 200, 'the engine answers while the read is being decided');
      assert.ok(health.ms < 2000, `and is not held up by it (health took ${Math.round(health.ms)} ms)`);
      const res = await reading;
      assert.equal(res.complete, true, `the read is answered and ended by the engine (${res.gaveUp}; status ${res.status}, ${res.bytes} bytes)`);
      assert.equal(res.status, 409, `the read is refused (body: ${res.text.slice(0, 300)})`);
      const body = JSON.parse(res.text);
      assert.ok(isRefusalBody(body) && body.code === 'record_missing', `in the engine's form, as a record whose bytes are not there: ${res.text.slice(0, 300)}`);
      if (substitution.secret) assert.equal(res.text.includes(substitution.secret(scene)), false, 'what the link leads to is not disclosed');
      assert.ok(engine.isRunning(), 'the engine is still running');
    });
  }
});

// ---- M2 slice 2 ---------------------------------------------------------------------

// A fault that outlasts any retry (row M61).
const KEEPS_FAILING = 1000;

// NOW as the list and the project read give it, which must agree.
async function nowOf(engine, project) {
  const detail = (await readProject(engine, project)).project.now;
  const listed = (await listProjects(engine)).projects.find((row) => row.id === project)?.now;
  assert.deepEqual(listed, detail, "the list and the project's own projection give the same NOW");
  assert.ok(NOW_STATES.includes(detail?.state) || detail?.state === 'unknown', `NOW is a NowState (${JSON.stringify(detail)})`);
  assert.ok(typeof detail.reason === 'string' && detail.reason.length > 0, 'NOW says why, in a sentence');
  assert.ok('primary_action' in detail, 'NOW names its primary action, or null');
  return detail;
}

function assertRefusedNow(now, cause, what) {
  assert.equal(now.state, 'refused', `${what}: NOW is refused (it is ${now.state}: ${now.reason})`);
  assert.match(now.reason, cause, `${what}: the reason names the cause`);
}

describe('M70 NOW: the other causes of refused, and unknown', () => {
  test('a repository that cannot be read: NOW is refused and names the repository; once it can be read again, the project goes on and NOW says so', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    const restore = makeUnreadable(project.repo.path);
    let restored = false;
    const readable = () => {
      if (!restored) restore();
      restored = true;
    };
    fx.beforeCleanup.push(readable);
    await tick(fx.engine, project.id);
    assert.deepEqual([outOfBand(fx.home, project.id)[0]?.subject_kind, runsOf(fx.home, item).length], ['repository', 0], 'the fixture is live: the repository is observed unreadable and nothing is dispatched (row M25)');

    assertRefusedNow(await nowOf(fx.engine, project.id), /repositor/i, 'with the repository unreadable');

    readable();
    await runToEnd(fx, project.id, item);
    const after = await nowOf(fx.engine, project.id);
    assert.notEqual(after.state, 'refused', `once the repository can be read the engine acts on the project again (NOW: ${after.state}, ${after.reason})`);
  });

  test('an unresolved out-of-band change of the integration branch: NOW is refused, although the observation is a decision waiting for a person, and names the change; once it is reconciled, NOW is not refused', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    const stray = commitOnRef(project.repo.path, project.repo.ref, { 'stray.txt': 'moved by hand\n' });
    await tick(fx.engine, project.id);
    const [observed] = outOfBand(fx.home, project.id);
    assert.deepEqual([observed?.subject_kind, observed?.found, observed?.decision.status, runsOf(fx.home, item).length], ['ref', stray, 'open', 0], 'the fixture is live: the moved branch is observed, its decision is open, and nothing is dispatched (row M24)');

    assertRefusedNow(await nowOf(fx.engine, project.id), /out[ -]of[ -]band|integration branch|refs\/heads\/main/i, 'with the integration branch moved and the observation unresolved');

    await consume(fx, project.id, assertPreview(decision(fx.home, observed.decision.id)), 'discard');
    await waitFor(() => refOid(project.repo.path, project.repo.ref) === project.base && registryOf(fx.home, project.id)[project.repo.ref].expected_oid === project.base, { what: 'the discard to put the branch back' });
    await tick(fx.engine, project.id);
    const after = await nowOf(fx.engine, project.id);
    assert.notEqual(after.state, 'refused', `once the change is reconciled the engine acts on the project again (NOW: ${after.state}, ${after.reason})`);
  });

  test("the store fails for the project (its budget cannot be read, row M61): NOW is refused and names the store or the budget, while another project's NOW is unaffected; once the store answers, NOW is ready", async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const other = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.defaultScript(script.complete());
    assert.equal((await nowOf(fx.engine, project)).state, 'ready', 'the fixture is live: eligible work the next tick could dispatch');

    await armFault(fx.engine, { point: 'budget_read', project, times: KEEPS_FAILING });
    for (let i = 0; i < 2; i++) await tickOnce(fx.engine, project);
    assert.equal(runsOf(fx.home, item).length, 0, 'the fixture is live: nothing is dispatched while the budget cannot be read (row M61)');

    assertRefusedNow(await nowOf(fx.engine, project), /store|budget/i, 'with the budget read failing');
    const theirs = await nowOf(fx.engine, other);
    assert.notEqual(theirs.state, 'refused', `the other project's NOW is its own (${theirs.state})`);

    await clearFaults(fx.engine);
    assert.equal((await nowOf(fx.engine, project)).state, 'ready', 'once the store answers, the eligible work can be dispatched again');
    await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'complete', { what: 'the item to complete once the budget can be read' });
  });

  test("the status cannot be computed (the store fails in the read itself): the project is listed with NOW unknown, which names that, and the other project's NOW is computed as before", async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const other = (await addProject(fx)).id;
    // The harness fault `status_read` (SEAM.md §107): the next computation of
    // that project's NOW fails as a store error.
    await armFault(fx.engine, { point: 'status_read', project, times: KEEPS_FAILING });
    const list = await listProjects(fx.engine);
    const mine = list.projects.find((row) => row.id === project)?.now;
    const theirs = list.projects.find((row) => row.id === other)?.now;
    assert.equal(mine?.state, 'unknown', `a status that cannot be computed is unknown, not any of the five (${JSON.stringify(mine)})`);
    assert.ok(typeof mine.reason === 'string' && /unknown|comput/i.test(mine.reason), `and the reason says the status could not be computed (${mine.reason})`);
    assert.ok('primary_action' in mine);
    assert.equal(theirs?.state, 'idle', "the other project's status is computed as before");

    await clearFaults(fx.engine);
    assert.equal((await nowOf(fx.engine, project)).state, 'idle', 'once the store answers, the status is computed again');
  });
});

describe('M70 the three reads that were left', () => {
  test("one decision by its identifier: the list's item with its options and preview, and its status; a consumed decision is still readable with its answer; another project's path and an unknown id are not found; reading writes nothing", async (t) => {
    const fx = await scriptedEngine(t);
    const engine = fx.engine;
    const mine = (await addProject(fx)).id;
    const other = (await addProject(fx)).id;
    const item = await addWork(engine, mine, 'verification');
    fx.scripted.script(item, [script.hold('gate', { heartbeat_ms: 0 })]);
    await tick(engine, mine);
    const run = await waitForRun(fx.home, item, { state: 'executing' });
    await fx.scripted.waitForHolding({ run: run.id });
    const asked = await engine.post(`/v1/projects/${mine}/runs/${run.id}/stop`, {});
    assertRefused(asked, 409, 'confirm_required', 'the unconfirmed Stop');
    const row = decision(fx.home, asked.body.subject?.decision);
    assert.equal(row?.status, 'open', 'the fixture is live: the project has an open decision');

    // The read by id gives what the list gives for the same decision, and its status.
    const [listed] = (await listDecisions(engine, mine)).decisions;
    assert.equal(listed?.id, row.id, 'the fixture is live: the list shows the decision');
    const shown = (await readDecision(engine, mine, row.id)).decision;
    for (const key of ['id', 'kind', 'subject_type', 'subject_id', 'question', 'preview_hash']) assert.deepEqual(shown[key], listed[key], `the read by id gives the list's ${key}`);
    assert.deepEqual(
      shown.options.map((option) => [option.key, option.plan_hash, option.effect_plan]),
      listed.options.map((option) => [option.key, option.plan_hash, option.effect_plan]),
      "and the list's options, each with its key, effect plan and plan hash",
    );
    assert.deepEqual([shown.kind, shown.subject_id, shown.preview_hash, shown.status], ['stop_confirm', run.id, row.preview_hash, 'open'], 'as the row has them, with its status');

    // Scoped to the project; an id nobody has is not found either.
    assertRefused(await engine.get(`/v1/projects/${other}/decisions/${row.id}`), 404, 'not_found', "the decision through another project's path");
    assertRefused(await engine.get(`/v1/projects/${mine}/decisions/dec_00000000000000000000000000`), 404, 'not_found', 'an unknown decision id');

    // Reading writes nothing.
    const unchanged = quiet(fx);
    for (let round = 0; round < 3; round++) await readDecision(engine, mine, row.id);
    unchanged('after three reads of the decision');

    // Answered, the decision leaves the list and is still readable by id, with its answer.
    const confirmed = await engine.post(`/v1/projects/${mine}/runs/${run.id}/stop`, { preview_hash: shown.preview_hash });
    assert.equal(confirmed.status, 200, `the Stop confirmed with the preview hash the read showed (body: ${confirmed.text})`);
    assert.deepEqual((await listDecisions(engine, mine)).decisions, [], 'the fixture is live: the consumed decision is no longer listed');
    const consumed = (await readDecision(engine, mine, row.id)).decision;
    assert.deepEqual([consumed.id, consumed.status, consumed.answer?.option, consumed.preview_hash], [row.id, 'consumed', 'confirm', row.preview_hash], 'a consumed decision is read by its id with its status and the answer given');
  });

  test("a project's git operations are listed, each with its kind, journal state, status, intent and attempts: finalized ones, a pending one held before its effect, and a blocked one with the decision that holds it; another project's are not shown; reading writes nothing", async (t) => {
    // Project A: a run whose integration was intended and the engine killed
    // there; the branch moved by hand meanwhile, so the restarted engine's
    // probe finds the ref conflicting and blocks the operation (SEAM.md §45).
    const ctx = await killedAt(t, 'ref_update', 'intent_committed');
    const { fx } = ctx;
    const engine = fx.engine;
    arrange(ctx, 'conflicting');
    await fx.start();
    const blocked = operationDetails(fx.home, { project: ctx.project.id }).find((op) => op.id === ctx.op.id);
    assert.deepEqual([blocked.state, blocked.status, blocked.blockers.filter((d) => d.status === 'open').length], ['ambiguous', 'ambiguous', 1], 'the fixture is live: the integration is blocked, with one open blocker');

    // Project B: a run whose integration is intended and held before its effect.
    const held = journalBarrier('ref_update', 'intent_committed');
    await armBarrier(fx.engine, held, 'pause');
    const other = await addGitProject(fx);
    const item = await addItem(fx, other.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    await reachBarrier(fx, other.id, held);
    t.after(() => releaseBarrier(fx.engine, held).catch(() => {}));
    const pending = operationDetails(fx.home, { project: other.id, journalKind: 'ref_update' });
    assert.deepEqual([pending.length, pending[0]?.state, pending[0]?.finalized], [1, 'intended', false], 'the fixture is live: the integration of project B is intended and not yet made');

    const attemptsOf = (op) => op.attempts.map((a) => ({ attempt_number: a.attempt_number, status: a.status, started_at: a.started_at, finished_at: a.finished_at, reconciliation_reads: a.reads }));
    const expected = (op) => ({
      id: op.id,
      kind: op.kind,
      journal_kind: op.journal_kind,
      state: op.state,
      status: op.status,
      intent: op.payload,
      attempts: attemptsOf(op),
      finalized_at: op.finalized_at,
      blocker: op.blockers.find((d) => d.status === 'open')?.id ?? null,
    });
    const shownOf = (op) => ({
      id: op.id,
      kind: op.kind,
      journal_kind: op.journal_kind,
      state: op.state,
      status: op.status,
      intent: op.intent,
      attempts: op.attempts?.map((a) => ({ attempt_number: a.attempt_number, status: a.status, started_at: a.started_at, finished_at: a.finished_at, reconciliation_reads: a.reconciliation_reads })),
      finalized_at: op.finalized_at,
      blocker: op.blocker,
    });

    for (const [label, project] of [['A', ctx.project.id], ['B', other.id]]) {
      const rows = operationDetails(fx.home, { project });
      const listed = (await listOperations(engine, project)).operations;
      assert.deepEqual(listed.map((op) => op.id), rows.map((op) => op.id), `project ${label}: every operation of the project, each once, oldest first, and no other project's`);
      assert.deepEqual(listed.map(shownOf), rows.map(expected), `project ${label}: each with its kind, journal kind and state, status, intent, attempts, when it was finalized, and the open blocker that holds it`);
    }
    const a = (await listOperations(engine, ctx.project.id)).operations;
    assert.deepEqual(
      a.map((op) => [op.journal_kind, op.state, op.status, op.blocker !== null]),
      [['worktree_add', 'finalized', 'succeeded', false], ['commit_tree', 'finalized', 'succeeded', false], ['ref_update', 'ambiguous', 'ambiguous', true]],
      "project A: the run's workspace and commit finalized, its integration ambiguous and blocked",
    );
    assert.equal(a[2].blocker, blocked.blockers.find((d) => d.status === 'open').id, 'the blocked operation names the open decision a person has to look at');
    const b = (await listOperations(engine, other.id)).operations;
    assert.deepEqual(
      b.map((op) => [op.journal_kind, op.state, op.blocker]),
      [['worktree_add', 'finalized', null], ['commit_tree', 'finalized', null], ['ref_update', 'intended', null]],
      "project B: the run's workspace and commit finalized, its integration pending",
    );
    assert.deepEqual([b[2].intent.ref, b[2].intent.old_oid, b[2].intent.new_oid], [other.repo.ref, other.base, pending[0].payload.new_oid], 'the pending integration shows what it is to do: the ref, and the commits it moves from and to');

    const unchanged = quiet(fx);
    for (let round = 0; round < 3; round++) {
      await listOperations(engine, ctx.project.id);
      await listOperations(engine, other.id);
    }
    unchanged('after six reads of the operations of two projects');
  });

  test("a project's environments as a route of their own: each with its observation as the project read shows it, a never-observed one as unknown; another project's are not shown; reading writes nothing and moves no observation", async (t) => {
    const fx = await scriptedEngine(t);
    const engine = fx.engine;
    const mine = (await addProject(fx)).id;
    const other = (await addProject(fx)).id;
    const alpha = await addEnvironment(engine, mine, { name: 'alpha', targets: ['alpha-1'] });
    const beta = await addEnvironment(engine, mine, { name: 'beta', targets: ['beta-1'] });
    const theirs = await addEnvironment(engine, other, { name: 'alpha', targets: ['alpha-9'] });
    const observedAt = new Date(Date.parse((await readProject(engine, mine)).served_at) - 10_000).toISOString();
    const seeded = await engine.post('/v1/harness/fixtures/observation', { project: mine, environment: alpha, condition: 'healthy', observed_at: observedAt, source: 'fixture-probe' });
    assert.equal(seeded.status, 201, `the observation fixture (body: ${seeded.text})`);

    const listed = (await listEnvironments(engine, mine)).environments;
    assert.deepEqual(listed.map((row) => row.id).sort(), [alpha, beta].sort(), "the project's environments, each once, and not the other project's");
    const fromProject = (await readProject(engine, mine)).project.environments;
    assert.deepEqual(listed, fromProject, "each as the project's own projection shows it: id, name and observation");
    const shown = Object.fromEntries(listed.map((row) => [row.id, row]));
    assert.deepEqual(
      [shown[alpha].name, shown[alpha].observed?.condition, shown[alpha].observed?.observed_at, shown[alpha].observed?.source, shown[alpha].observed?.freshness],
      ['alpha', 'healthy', observedAt, 'fixture-probe', 'fresh'],
      "the observed environment with its observation's own time and source, fresh",
    );
    assert.deepEqual([shown[beta].name, shown[beta].observed?.condition, shown[beta].observed?.observed_at], ['beta', 'unknown', null], 'an environment never observed is unknown, with no time of observation');
    assert.deepEqual((await listEnvironments(engine, other)).environments.map((row) => row.id), [theirs], "the other project's one environment, and none of the first project's");

    const stored = () => withStore(fx.home, (db) => db.prepare('SELECT "observed" FROM "environment_records" WHERE "environment" = ?').get(alpha)?.observed);
    const before = stored();
    const unchanged = quiet(fx);
    for (let round = 0; round < 3; round++) await listEnvironments(engine, mine);
    unchanged('after three reads of the environments');
    assert.equal(stored(), before, 'reading did not touch the stored observation');

    await advanceClock(engine, 200);
    const expired = (await listEnvironments(engine, mine)).environments.find((row) => row.id === alpha).observed;
    assert.deepEqual([expired.condition, expired.freshness, expired.observed_at], ['unknown', 'expired', observedAt], 'past its bound the observation is projected as unknown, with the time it was really made (SEAM.md §91)');
    assert.equal(stored(), before);
  });
});
