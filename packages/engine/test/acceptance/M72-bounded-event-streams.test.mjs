// M72, bounded event streams and reconnect (slice 6). Plan §3.7 M72; D1
// §§11.3, 12.1, D1-33; Review B14; SEAM.md §92.
//
// GET /v1/events is the live feed and the audit trail: every committed event
// after a cursor, once, in order, as server-sent events whose `id` is the
// event's sequence number. A client that falls behind is not allowed to make
// the engine hold its backlog: the engine lets go of a client that takes
// nothing, and the client goes on from the last id it has. The token is a
// header, never part of a URL.
//
// The fixture is one engine whose log holds 256 MiB of filler events
// (harness/load.mjs `fillStore`), so that "the whole log" is far more than
// any buffer a correct engine keeps for one client. Memory is judged
// against that size, not against a number measured on some engine: an engine
// that buffers a client's backlog grows by the backlog; one that does not
// stays far below half of it.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { maxEventSeq } from './harness/fixtures.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { LIMITS, MIB, fillStore, mib, residentMemory } from './harness/load.mjs';
import { now, until } from './harness/mono.mjs';
import { addProject, addWork, countOf, pauseProject, resumeProject, scriptedEngine, tick, waitForRun } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { engineEndState, eventsPath, openStream, replayInPages, streamOf } from './harness/sse.mjs';
import { withStore } from './harness/store.mjs';

const LOG_BYTES = 256 * MIB;
// What an engine that keeps a client's backlog in memory would have to hold.
const MEMORY_ALLOWANCE = LOG_BYTES / 2;

const seqs = (home, after, upTo) => withStore(home, (db) => db.prepare('SELECT "seq" FROM "events" WHERE "seq" > ? AND "seq" <= ? ORDER BY "seq"').all(after, upTo).map((row) => row.seq));
const anyEventContains = (home, needle, afterSeq) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "events" WHERE "seq" > ?').all(afterSeq).some((row) => JSON.stringify(row).includes(needle)));

describe('M72 bounded event streams and reconnect', () => {
  const shared = sharedFixture();
  const ctx = {};

  // One engine for the four cases, built the first time a case asks for it.
  let built = null;
  const fixture = () =>
    (built ??= (async () => {
      const fx = await scriptedEngine(shared.context);
      ctx.fx = fx;
      ctx.project = (await addProject(fx)).id;
      await fx.engine.stop();
      ctx.fill = fillStore(fx.home, { bytes: LOG_BYTES });
      await fx.start();
      // One role under way, silent, so that the count of adapter calls means something.
      ctx.item = await addWork(fx.engine, ctx.project, 'verification');
      fx.scripted.script(ctx.item, [script.hold('gate', { heartbeat_ms: 0 })]);
      await tick(fx.engine, ctx.project);
      ctx.run = await waitForRun(fx.home, ctx.item, { state: 'executing' });
      return ctx;
    })());

  after(() => shared.cleanup());

  test('twenty clients, one of which reads nothing, each receive every committed event once and in order, replayed and live; the number of clients changes no adapter call', async (t) => {
    const { fx, project, fill } = await fixture();
    const engine = fx.engine;
    const launchesBefore = fx.scripted.launches().length;
    const receiptsBefore = countOf(fx.home, 'invocation_receipts');
    const since = fill.lastSeq - 40;

    const clients = [];
    t.after(() => clients.forEach((client) => client.close()));
    const slow = await streamOf(engine, eventsPath({ since: 0 }), { paused: true });
    clients.push(slow);
    for (let i = 0; i < LIMITS.clients - 1; i++) clients.push(await streamOf(engine, eventsPath({ since }), { keepRaw: i === 0 }));
    const followers = clients.slice(1);
    assert.equal(clients.length, LIMITS.clients);
    for (const client of clients) {
      assert.equal(client.status, 200, `the event stream opens (refusal: ${JSON.stringify(client.refusal)})`);
      assert.match(client.headers['content-type'] ?? '', /^text\/event-stream\b/, 'it is a server-sent event stream');
    }

    // Events committed while all twenty are connected.
    for (let i = 0; i < 10; i++) {
      await pauseProject(engine, project);
      await resumeProject(engine, project);
    }
    const target = maxEventSeq(fx.home);
    await Promise.all(followers.map((client) => client.waitForId(target, { timeoutMs: 30_000 })));

    const expected = seqs(fx.home, since, target);
    assert.ok(expected.length >= 40 + 20, 'the fixture is live: the expected events include replayed and newly committed ones');
    followers.forEach((client, n) => {
      assert.deepEqual(client.ids.filter((id) => id <= target), expected, `client ${n + 1} received exactly the committed events after its cursor, each once, in order`);
      assert.equal(client.ended, false, `client ${n + 1}, which reads its stream, is still connected`);
    });

    // A message is the event: its id is the sequence number, its name the type, its data the row.
    const paused = followers[0].of('project.paused').find((message) => Number(message.id) > fill.lastSeq);
    assert.ok(paused?.json, 'a project.paused event committed during the test arrived with its data');
    assert.deepEqual([paused.json.seq, paused.json.type, paused.json.subject?.project], [Number(paused.id), 'project.paused', project], 'the data of a message is the event it names');
    assert.equal(followers[0].text().includes(engine.token()), false, 'the API token is in nothing a client received');

    // Twenty clients, and the adapter was called exactly as often as with none.
    assert.equal(fx.scripted.launches().length, launchesBefore, 'no role was launched for a client');
    assert.equal(countOf(fx.home, 'invocation_receipts'), receiptsBefore, 'no invocation was allocated for a client');
  });

  test('a client that takes nothing is let go of while the engine stays small, and goes on from its last id without losing an event', async (t) => {
    const { fx } = await fixture();
    const engine = fx.engine;
    const memoryBefore = residentMemory(engine.pid).peak;

    const slow = await streamOf(engine, eventsPath({ since: 0 }), { paused: true });
    t.after(() => slow.close());
    assert.equal(slow.status, 200, `the event stream opens (refusal: ${JSON.stringify(slow.refusal)})`);
    const stalledAt = now();
    // The engine has 256 MiB for this client and the client takes none of it.
    await until(() => engineEndState(slow) !== 'established', {
      timeoutMs: 40_000,
      intervalMs: 100,
      what: 'the engine to close the connection of a client that takes nothing (SEAM.md §92: within five seconds)',
    });
    t.diagnostic(`M72 slow client: let go of ${Math.round(now() - stalledAt)} ms after it stopped reading`);
    const grown = residentMemory(engine.pid).peak - memoryBefore;
    assert.ok(grown < MEMORY_ALLOWANCE, `the engine did not hold the client's backlog in memory: its peak resident memory grew by ${mib(grown)} while ${mib(LOG_BYTES)} were waiting for the client (allowed: less than ${mib(MEMORY_ALLOWANCE)})`);

    // What the client was sent before that is still its own: whole events, in order, from the start.
    slow.resume();
    await slow.waitEnd({ timeoutMs: 30_000, what: 'the closed stream to be read to its end' });
    const all = seqs(fx.home, 0, maxEventSeq(fx.home));
    assert.ok(slow.ids.length < all.length, `the client really was behind: it has ${slow.ids.length} of ${all.length} events`);
    assert.deepEqual(slow.ids, all.slice(0, slow.ids.length), 'what it has is the beginning of the log, with no gap and no repeat');

    // The cursor is the last id it has. From there, nothing is lost and nothing repeated.
    const cursor = slow.lastId ?? 0;
    const rest = await replayInPages(engine, { since: cursor, limit: 500 });
    const end = rest.ids.at(-1) ?? cursor;
    assert.ok(end >= ctx.fill.lastSeq, 'the client reached the end of the log on its second connection');
    assert.deepEqual([...slow.ids, ...rest.ids], seqs(fx.home, 0, end), 'the two connections together hold every committed event exactly once, in order');
  });

  test('the whole log read in large replay pages is complete and in order, and the engine stays small', async (t) => {
    const { fx, fill } = await fixture();
    const engine = fx.engine;
    const memoryBefore = residentMemory(engine.pid).peak;
    const all = await replayInPages(engine, { since: 0, limit: 1_000_000, timeoutMs: 180_000 });
    t.diagnostic(`M72 replay: ${all.ids.length} events, ${mib(all.bytes)}, in ${all.pages} pages of at most 1,000,000`);
    assert.ok(all.ids.at(-1) >= fill.lastSeq, 'the replay reached the end of the log');
    assert.deepEqual(all.ids, seqs(fx.home, 0, all.ids.at(-1)), 'every committed event, once, in order, across the pages');
    assert.ok(all.bytes >= fill.rows * 65_536, `the pages carried the events themselves (${mib(all.bytes)})`);
    const grown = residentMemory(engine.pid).peak - memoryBefore;
    assert.ok(grown < MEMORY_ALLOWANCE, `a page of a million events is not built in memory: the engine's peak resident memory grew by ${mib(grown)} while it served ${mib(all.bytes)} (allowed: less than ${mib(MEMORY_ALLOWANCE)})`);

    // A page is a page: with a limit the stream ends by itself and never waits for an event to come.
    const one = await streamOf(engine, eventsPath({ since: 0, limit: 3 }));
    await one.waitEnd({ timeoutMs: 15_000, what: 'a page of three events to end' });
    assert.deepEqual(one.ids, all.ids.slice(0, 3), 'a page of three holds the first three events');
    const empty = await streamOf(engine, eventsPath({ since: maxEventSeq(fx.home) + 1000, limit: 10 }));
    await empty.waitEnd({ timeoutMs: 15_000, what: 'a page past the end of the log to end' });
    assert.deepEqual([empty.status, empty.ids], [200, []], 'a page past the end of the log is empty, and ends');
  });

  test('the token is never taken from a URL', async () => {
    const { fx } = await fixture();
    const engine = fx.engine;
    const token = engine.token();
    const seq = maxEventSeq(fx.home);
    for (const name of ['token', 'x-surety-token', 'X-Surety-Token', 'access_token']) {
      const refused = await openStream({ port: engine.port, authority: engine.authority, token: null, path: `/v1/events?since=0&limit=1&${name}=${encodeURIComponent(token)}` });
      assert.deepEqual([refused.status, refused.refusal?.code], [401, 'token_required'], `a stream request with the token as the query parameter "${name}" and no header is refused`);
      assert.deepEqual(refused.ids, [], 'and is sent no event');
    }
    const ok = await streamOf(engine, eventsPath({ since: 0, limit: 1 }));
    await ok.waitEnd({ timeoutMs: 15_000 });
    assert.deepEqual([ok.status, ok.ids.length], [200, 1], 'the same request with the token in its header is served');
    assert.equal(anyEventContains(fx.home, token, seq), false, 'the token presented in those URLs is in no event');
  });
});
