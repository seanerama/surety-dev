// M71, latency under the declared maximum load (slice 6). Plan §3.7 M71; D1
// §§6.1, 8.1, 8.5, D1-20; Review N03 and B09; RN §4; E36 item 2; SEAM.md §93.
//
// The limits are numbers, in contract/load-limits.json: 5 projects, 20
// connected clients, a store of one gibibyte, the default api_latency_bound
// of 250 ms. The store is built once for this file, in one bulk transaction
// (harness/load.mjs `fillStore`), and each case first shows that its fixture
// is at the limits: a pass on a smaller store would qualify nothing.
//
// Two cases, because the row's load has two shapes that cannot be had at
// once. In the first the engine is starting and its store worker runs one
// long migration over the full store: the busy worker in its plainest form.
// In the second the engine is in full mode with everything else the row
// names going on together: a git child held open, a backup, replay in large
// pages, a client that reads nothing, twenty clients in all, a role's output
// being hashed into chunks, a tick that recomputes a gate. In both, health
// and Stop must be answered within the bound.
//
// How a latency is judged on a host that may be busy with other things is in
// harness/load.mjs: every sample is paired with a control request, a sample
// whose control was slow is void, the bound is never widened, and too few
// valid samples is a failure, not a pass. Every time is monotonic.
//
// Termination is another quantity (Review N03): the time from a Stop's
// admission to the run's end, which waits for the role's processes to be
// gone. It is measured and printed apart, and it is not judged against the
// bound: a role that ignores SIGTERM is admitted at once and ends seconds
// later, and the run does not report `ended` before its process is gone.
//
// The obligation the slice-2 review left with this row (the scripted
// boundary's process scan while a run is ending; COVERAGE.md) is covered by
// the second case: health is sampled while two runs are being terminated.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { ENGINE_MIGRATIONS } from './harness/engine.mjs';
import { consume, openDecision } from './harness/decisions.mjs';
import { assertRefused, maxEventSeq } from './harness/fixtures.mjs';
import { check, evaluationsOf, installChecks, nominated, passAll, sharedFixture } from './harness/gates.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { newId } from './harness/ids.mjs';
import { eventsOfType, workItemsOf } from './harness/journal.mjs';
import { Control, LIMITS, assertWithinBound, fillStore, mib, now, sample, sleep, startStreamClients, storeBytes, summary, until } from './harness/load.mjs';
import { gitProcessesNaming, holdGit } from './harness/repos.mjs';
import { addWork, leasesOf, requestTick, run as runRow, runsOf, scriptedEngine, tick, tickUntil, waitForRun, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

// The migration the first case applies at startup: full scans of the filler
// events, nothing else. It keeps the store's one connection busy for seconds
// on a store of the declared size, and for no time on a small one.
const SCAN_MIGRATION = '9000_m71_full_scans.sql';
const SCAN_PASSES = 8;
const SCAN_SQL = [
  'CREATE TABLE "m71_scan" ("pass" INTEGER PRIMARY KEY, "rows" INTEGER NOT NULL, "found" INTEGER NOT NULL);',
  ...Array.from({ length: SCAN_PASSES }, (unused, i) => `INSERT INTO "m71_scan" SELECT ${i + 1}, COUNT(*), COALESCE(SUM(INSTR("payload", 'needle-${i + 1}-that-is-not-there')), 0) FROM "events";`),
  '',
].join('\n');

const CONFIG = { max_concurrent_runs: 8, tick_step_budget: 1, git_deadline: 30 };

// The bound the engine was configured with: its default, which is the limit
// the row qualifies. Read from the engine, compared with the contract.
async function latencyBound(engine) {
  const info = await engine.get('/v1/engine');
  assert.equal(info.status, 200, `GET /v1/engine (body: ${info.text})`);
  assert.deepEqual(info.body.config?.api_latency_bound, { value: LIMITS.api_latency_bound_ms, source: 'default' }, 'the engine runs with its default api_latency_bound, the bound the limits name');
  return info.body.config.api_latency_bound.value;
}

const show = (s) => `valid ${s.valid} of ${s.taken}, median ${s.median} ms, worst ${s.max} ms`;

describe('M71 latency under the declared maximum load', () => {
  const shared = sharedFixture();
  const ctx = {};

  before(async () => {
    const fx = await scriptedEngine(shared.context, { config: CONFIG });
    ctx.fx = fx;
    ctx.control = await Control.start(shared.context);
    ctx.projects = [];
    for (let i = 0; i < LIMITS.projects; i++) ctx.projects.push(await addGitProject(fx, { tier: 'T1' }));
    await fx.engine.stop();

    // One gibibyte, once for the file.
    ctx.fill = fillStore(fx.home, { bytes: LIMITS.store_bytes });

    // The engine's migrations and one more, for the engine to find pending.
    ctx.migrations = join(fx.root, 'migrations');
    mkdirSync(ctx.migrations);
    cpSync(ENGINE_MIGRATIONS, ctx.migrations, { recursive: true });
    writeFileSync(join(ctx.migrations, SCAN_MIGRATION), SCAN_SQL);
  });

  after(() => shared.cleanup());

  // Every case starts from a stopped engine and a store at the limit.
  const assertAtLimits = (t) => {
    const { fx, fill } = ctx;
    assert.ok(fill, 'the load fixture was built');
    const bytes = storeBytes(fx.home);
    assert.ok(bytes >= LIMITS.store_bytes, `the store is at its declared size: ${bytes} bytes, limit ${LIMITS.store_bytes}`);
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "projects"').get().n), LIMITS.projects, `the store holds ${LIMITS.projects} projects`);
    t.diagnostic(`M71 limits: ${LIMITS.projects} projects, ${LIMITS.clients} clients, store ${mib(bytes)} (limit ${mib(LIMITS.store_bytes)}), api_latency_bound ${LIMITS.api_latency_bound_ms} ms`);
    t.diagnostic(`M71 fixture: ${fill.rows} filler events written in one transaction in ${fill.ms} ms`);
  };

  test('while a startup migration works through the full store, health and Stop are answered within the bound, in restricted mode', async (t) => {
    const { fx, control, projects, migrations } = ctx;
    assertAtLimits(t);
    const engine = await fx.start({ until: 'none', args: ['--harness-migrations', migrations] });
    t.after(() => engine.stop());
    await until(
      async () => {
        if (!engine.isRunning()) throw Object.assign(new Error(engine.failureMessage('the engine exited while it was starting')), { fatal: true });
        return existsSync(engine.tokenPath()) && (await engine.get('/v1/health')).status === 200;
      },
      { timeoutMs: 60_000, intervalMs: 5, what: 'the engine to listen' },
    );
    const boundMs = await latencyBound(engine);

    // Is the store step still under way? A sample counts only if it was,
    // before the sample and after it.
    const migrating = async () => {
      const info = await engine.get('/v1/engine');
      return info.status === 200 && info.body.mode === 'restricted' && info.body.startup?.step === 'store' && info.body.startup.failed === null;
    };
    const stopPath = `/v1/projects/${projects[0].id}/runs/${newId('run_')}/stop`;
    const health = [];
    const stops = [];
    const started = now();
    while ((await migrating()) && now() - started < 120_000) {
      const taken = await sample(control, () => engine.get('/v1/health'));
      const stop = stops.length < 5 ? await sample(control, () => engine.post(stopPath, {})) : null;
      if (!(await migrating())) break;
      health.push(taken);
      if (stop !== null) stops.push(stop);
      await sleep(40);
    }
    await until(async () => (await engine.get('/v1/health')).body?.mode === 'full', { timeoutMs: 180_000, what: 'the engine to reach full mode once the migration is applied' });

    assert.ok(health.length >= 5, `the migration kept the store busy long enough to be sampled: ${health.length} samples were taken while it ran (5 are needed). On a store of the declared size the scans take seconds`);
    for (const taken of health) assert.deepEqual([taken.response.status, taken.response.body?.mode], [200, 'restricted'], 'health answers, and says restricted, while the migration runs');
    for (const taken of stops) assertRefused(taken.response, 503, 'engine_starting', 'a Stop submitted while the engine is starting');
    const healthSeen = assertWithinBound(health, { boundMs, minValid: 5, what: 'GET /v1/health during the startup migration' });
    const stopSeen = assertWithinBound(stops, { boundMs, minValid: 2, what: 'Stop during the startup migration' });
    t.diagnostic(`M71 startup migration: health ${show(healthSeen)}; Stop (refused, engine_starting) ${show(stopSeen)}`);

    // The migration was the load: it ran over the whole store, once.
    const scans = withStore(fx.home, (db) => db.prepare('SELECT * FROM "m71_scan" ORDER BY "pass"').all());
    const events = withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "events" WHERE "seq" <= ?').get(ctx.fill.lastSeq).n);
    assert.equal(scans.length, SCAN_PASSES, 'every scan of the migration ran');
    assert.ok(scans.every((row) => row.rows >= events), 'each scan read every event of the full store');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "schema_migrations" WHERE "name" = ?').get(SCAN_MIGRATION).n), 1, 'the migration is recorded once');
  });

  test('in full mode at the limits, with git held, a backup, replay, a slow reader, output being hashed and a gate recomputed, health and Stop are admitted within the bound; termination takes its own time; a prerequisite that timed out dispatches nothing, even when it completes late', async (t) => {
    const { fx, control, projects, migrations } = ctx;
    assertAtLimits(t);
    const engine = await fx.start({ args: ['--harness-migrations', migrations], timeoutMs: 180_000 });
    t.after(() => engine.stop());
    const boundMs = await latencyBound(engine);
    const [gated, held, hashing, quick, stubborn] = projects;
    fx.scripted.defaultScript(script.complete());

    // Project 1: a candidate whose stage gate waits for one execution of its check.
    const login = check('login', { requirements: ['R1'] });
    const cand = await nominated(fx, { project: gated, tier: 'T1' });
    const checks = await installChecks(engine, gated.id, [login]);
    const verification = workItemsOf(fx.home, gated.id).find((work) => work.kind === 'verification' && work.subject?.candidate === cand.candidate.id);
    assert.ok(verification, 'the fixture is live: the nomination registered verification work');
    await consume(fx, gated.id, await openDecision(fx, gated.id, 'blocker', verification.id), 'continue');
    await tickUntil(engine, gated.id, () => workItem(fx.home, verification.id).status === 'complete', { what: "the candidate's verification to complete" });
    await tickUntil(engine, gated.id, () => evaluationsOf(fx.home, cand.candidate.id, 'stage').at(-1), { max: 4, what: 'the engine to evaluate the stage gate' });
    assert.equal(workItem(fx.home, cand.items[0]).status, 'verifying', "the fixture is live: the stage's work waits for its gate");
    const evaluationsBefore = evaluationsOf(fx.home, cand.candidate.id, 'stage').length;

    // Projects 3 to 5: runs under way. One will write six mebibytes of output
    // during the window; two ignore SIGTERM, so their termination takes the grace period.
    const output = Array.from({ length: 24 }, () => [step.stdoutFill(256 * 1024), step.stdout('\n'), step.sleep(150)]).flat();
    const items = {
      hashing: await addWork(engine, hashing.id, 'verification'),
      quick: await addWork(engine, quick.id, 'verification'),
      stubborn: await addWork(engine, stubborn.id, 'verification'),
    };
    fx.scripted.script(items.hashing, [{ steps: [step.hold('start'), ...output, step.hold('gate')], on_term: 'ignore' }]);
    fx.scripted.script(items.quick, [script.hold('gate')]);
    fx.scripted.script(items.stubborn, [script.hold('gate', { on_term: 'ignore' })]);
    await tick(engine, gated.id);
    const runs = {};
    const launches = {};
    for (const key of ['hashing', 'quick', 'stubborn']) {
      runs[key] = await waitForRun(fx.home, items[key], { state: 'executing' });
      launches[key] = await fx.scripted.waitForHolding({ run: runs[key].id }, key === 'hashing' ? 'start' : 'gate');
    }
    const projectOf = { hashing: hashing.id, quick: quick.id, stubborn: stubborn.id };

    // Project 2: eligible work, created after that tick, so nothing has dispatched it yet.
    items.held = await addWork(engine, held.id, 'verification');

    // Twenty clients: seventeen follow the stream, two read the whole log
    // again and again in large pages, one asks for the whole log and reads nothing.
    const clients = await startStreamClients(t, engine, { followers: LIMITS.clients - 3, pagers: 2, slow: 1, since: maxEventSeq(fx.home), limit: 1_000_000 });
    assert.deepEqual([clients.connected, clients.statuses.every((status) => status === 200)], [LIMITS.clients, true], `${LIMITS.clients} clients are connected to the event stream (statuses: ${clients.statuses.join(', ')})`);
    const replayBefore = (await clients.progress()).clients.filter((c) => c.kind === 'pager').reduce((sum, c) => sum + c.bytes, 0);

    // ---- the window ----
    const seqAtStart = maxEventSeq(fx.home);
    const receipts = () => withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "stream_chunk_receipts" WHERE "project" = ?').get(hashing.id).n);
    const receiptsBefore = receipts();
    const windowStart = now();
    fx.scripted.release(items.hashing, 'start');
    const backup = await engine.post('/v1/harness/backup', {});
    assert.equal(backup.status, 202, `the backup is started (body: ${backup.text})`);
    const releaseGit = holdGit(held.repo.path);
    fx.beforeCleanup.push(releaseGit);
    await passAll(engine, gated.id, cand.candidate.id, [checks.id.login]);
    await requestTick(engine, gated.id);

    const backupDone = () => eventsOfType(fx.home, 'engine.backup', seqAtStart).length > 0;
    const health = [];
    const stopSamples = [];
    const admitted = {};
    const ending = {};
    let duringBackup = 0;
    let gitHeld = [];
    const plan = [
      { at: 1200, key: 'quick' },
      { at: 2200, key: 'stubborn' },
      { at: 3200, key: 'hashing' },
    ];
    while (now() - windowStart < 6500 || health.length < 30) {
      if (now() - windowStart > 90_000) break;
      const inBackup = !backupDone();
      const taken = await sample(control, () => engine.get('/v1/health'));
      health.push(taken);
      if (inBackup && taken.valid && !backupDone()) duringBackup++;
      if (gitHeld.length === 0) gitHeld = gitProcessesNaming(held.repo.path);

      if (plan.length > 0 && now() - windowStart >= plan[0].at) {
        const { key } = plan.shift();
        const path = `/v1/projects/${projectOf[key]}/runs/${runs[key].id}/stop`;
        const first = await sample(control, () => engine.post(path, {}));
        assertRefused(first.response, 409, 'confirm_required', `Stop of the ${key} run, first request`);
        const second = await sample(control, () => engine.post(path, { preview_hash: first.response.body.subject.preview_hash }));
        const at = now();
        assert.equal(second.response.status, 200, `Stop of the ${key} run is admitted (body: ${second.response.text})`);
        stopSamples.push(first, second);
        // What admission means, and what it does not: the run is fenced, and it has not ended.
        const lease = leasesOf(fx.home, runs[key].id).find((row) => row.resource_kind === 'run');
        const state = runRow(fx.home, runs[key].id).state;
        admitted[key] = { at, closing: lease?.closing, state, live: fx.scripted.isLive(launches[key]) };
        // Awaited after the window; a failure is kept, not left unhandled.
        ending[key] = until(() => (runRow(fx.home, runs[key].id).state === 'ended' ? { ms: now() - at, live: fx.scripted.isLive(launches[key]) } : undefined), {
          timeoutMs: 60_000,
          intervalMs: 20,
          what: `the stopped ${key} run to end`,
        }).catch((error) => ({ error }));
      }
      await sleep(70);
    }
    const windowMs = Math.round(now() - windowStart);

    // ---- the judgement ----
    const healthSeen = assertWithinBound(health, { boundMs, minValid: 30, what: 'GET /v1/health under the combined load' });
    assert.equal(stopSamples.length, 6, 'three runs were stopped, two requests each');
    const stopSeen = assertWithinBound(stopSamples, { boundMs, minValid: 4, what: 'Stop under the combined load (both requests of each Stop)' });
    for (const taken of health) assert.equal(taken.response.status, 200, 'health answers 200 throughout');
    t.diagnostic(`M71 full mode, window ${windowMs} ms: health ${show(healthSeen)}; Stop admission ${show(stopSeen)}`);

    // Termination is recorded apart, and a run does not end before its role is gone.
    for (const key of ['quick', 'stubborn', 'hashing']) {
      const ended = await ending[key];
      if (ended.error) throw ended.error;
      t.diagnostic(`M71 termination latency, ${key} run: ${Math.round(ended.ms)} ms from admission to ended (recorded separately; not judged against api_latency_bound)`);
      assert.equal(ended.live, false, `the ${key} run is ended only once its role's process is gone`);
      assert.equal(admitted[key].closing, 1, `when the Stop of the ${key} run is admitted its lease is closing`);
    }
    for (const key of ['stubborn', 'hashing']) {
      assert.deepEqual([admitted[key].state === 'ended', admitted[key].live], [false, true], `the ${key} run, whose role ignores SIGTERM, was admitted while its role was alive and was not reported ended`);
      assert.ok((await ending[key]).ms >= 1500, `the ${key} run ended only after the grace period (terminate_grace is 2 s): admission is not termination`);
    }

    // The load was the load the row names.
    await until(backupDone, { timeoutMs: 180_000, what: 'the backup to finish (an engine.backup event)' });
    const [backedUp] = eventsOfType(fx.home, 'engine.backup', seqAtStart);
    assert.equal(backedUp.payload?.label, 'complete', `the backup that ran is a complete one (payload: ${JSON.stringify(backedUp.payload)})`);
    const manifest = JSON.parse(readFileSync(join(backedUp.payload.backup, 'manifest.json'), 'utf8'));
    assert.ok(manifest.store.bytes >= LIMITS.store_bytes, `the backup copied a store of the declared size (${manifest.store.bytes} bytes)`);
    assert.ok(duringBackup >= 3, `health was sampled while the backup was running (${duringBackup} valid samples before it finished)`);
    assert.ok(gitHeld.length > 0, "a git child of the engine was held open on the second project's repository during the window");
    assert.ok(receipts() - receiptsBefore >= 5, `the role's output was hashed into chunks during the window (${receipts() - receiptsBefore} chunk receipts)`);
    const progress = (await clients.progress()).clients;
    const replayed = progress.filter((c) => c.kind === 'pager').reduce((sum, c) => sum + c.bytes, 0) - replayBefore;
    assert.ok(replayed >= 64 * 1024 * 1024, `the log was replayed in large pages during the window (${mib(replayed)})`);
    assert.ok(progress.filter((c) => c.kind === 'follower').every((c) => c.ended === false), 'the clients that read their stream are still connected');
    await tickUntil(engine, gated.id, () => workItem(fx.home, cand.items[0]).status === 'complete', { max: 6, what: "the stage's work to complete with its recomputed gate" });
    const evaluations = evaluationsOf(fx.home, cand.candidate.id, 'stage');
    assert.ok(evaluations.length > evaluationsBefore && evaluations.at(-1).outcome === 'satisfied', 'the stage gate was recomputed after the window began, and is satisfied');
    t.diagnostic(`M71 load: backup of ${mib(manifest.store.bytes)}, ${mib(replayed)} replayed, ${receipts() - receiptsBefore} chunks hashed, ${LIMITS.clients} clients`);

    // A prerequisite that timed out dispatches nothing, also when it completes late (D1 §8.1).
    await until(() => eventsOfType(fx.home, 'engine.tick', seqAtStart).length > 0, { timeoutMs: 60_000, what: 'the tick that could not check the held repository to end' });
    assert.equal(runsOf(fx.home, items.held).length, 0, "nothing of the project was dispatched by a tick whose integrity step overran its budget on the held repository");
    releaseGit();
    await sleep(2000);
    assert.equal(runsOf(fx.home, items.held).length, 0, 'the late completion of that step dispatched nothing either');
    // The continuation: once its repository can be read again, the project is dispatched like any other.
    const done = await tickUntil(engine, held.id, () => (runsOf(fx.home, items.held)[0]?.state === 'ended' ? runsOf(fx.home, items.held)[0] : undefined), { max: 8, what: 'the held project to be dispatched by a later tick' });
    assert.equal(done.outcome, 'completed', 'and its work runs to completion');

    const final = await clients.stop();
    t.diagnostic(`M71 clients at the end: ${final.clients.map((c) => `${c.kind}:${c.ended ? 'closed' : 'open'}`).join(' ')}`);
    t.diagnostic(`M71 samples: ${JSON.stringify({ health: summary(health), stop: summary(stopSamples) })}`);
  });
});
