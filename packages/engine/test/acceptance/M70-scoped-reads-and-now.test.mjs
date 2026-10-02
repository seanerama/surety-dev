// M70, scoped reads, NOW and source ages (slice 6). Plan §3.7 M70; D1 §§11.1,
// 11.3, 12.2 to 12.4, 13.1, 14, D1-28; Review §8.3 and N03; SEAM.md §91.
//
// Three fixtures.
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

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, ftruncateSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { isRefusalBody } from './harness/engine.mjs';
import { assertRefused, eventsSince, maxEventSeq } from './harness/fixtures.mjs';
import { addEnvironment, sharedFixture } from './harness/gates.mjs';
import { runToEnd } from './harness/gitruns.mjs';
import { awayFromMidnight, getLedger } from './harness/ledger.mjs';
import { sleep, timed } from './harness/mono.mjs';
import { boundedGet, listProjects, readProject, readRun } from './harness/reads.mjs';
import { readRecord, recordFile, recordRow } from './harness/records.mjs';
import { addProject, addWork, advanceClock, scriptedEngine, tick, waitForQuarantine, waitForRun } from './harness/runs.mjs';
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
