// M69, the rest of the boundary matrix (slice 6). Plan §3.7 M69; D1 §§11.1,
// 17(1), 17(2), 17(13), 17(14), D1-29; Review §8.3 and B14; E23 item 10;
// SEAM.md §89. Slice 1 pinned Host, the token and the audit record
// (`M69-boundary-core.test.mjs` and the two files after it). This file pins
// what slice 6 completes, each named item of the row once:
//
//   - Origin, Referer and fetch metadata: a present signal that is not the
//     engine's own origin refuses the request before its route; no CORS;
//   - body caps: a declared length over the cap is refused before the body
//     is read; a streamed body is counted and parsing stops when the cap is
//     crossed;
//   - `100 Continue` is never sent to a request that one of these refuses;
//   - a request the HTTP parser itself rejects is answered by the engine;
//   - defensive headers are on every response, errors included;
//   - a client that fails half way through a request or a stream does not
//     stop the engine.
//
// Every refusal of a mutation is checked for having had no effect, and for
// its audit record (slice 1's rule: every mutating request that passes the
// Host check is audited, refusals included).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { abandonedUpload, assertDefensiveHeaders, assertNoCors, requestHead, selfOrigin, sendRaw, unfinishedChunkedBody } from './harness/boundary.mjs';
import { isRefusalBody } from './harness/engine.mjs';
import { CONTRACT, assertRefused, auditEvents, maxEventSeq, projectFixture } from './harness/fixtures.mjs';
import { eventsPath, streamOf } from './harness/sse.mjs';
import { withStore } from './harness/store.mjs';

const BODY_CAP = CONTRACT.engine.body_cap.default;
const JSON_BODY = { 'Content-Type': 'application/json' };

const pausedFlag = (home, project) => withStore(home, (db) => db.prepare('SELECT "paused" FROM "projects" WHERE "id" = ?').get(project).paused);
const auditStatuses = (home, seq, path) => auditEvents(home, seq, 'POST', path).map((event) => JSON.parse(event.payload).status);

describe('M69 the boundary matrix: origin evidence, body caps, parser refusals, headers, failing clients', () => {
  test("a present Origin or Referer that is not exactly the engine's own origin refuses the request before its route, on reads and on mutations; the engine's own origin is accepted", async (t) => {
    const { engine, home, project, port } = await projectFixture(t);
    const self = selfOrigin(engine);
    const pause = `/v1/projects/${project}/pause`;
    const seq = maxEventSeq(home);
    const foreign = [
      ['origin', 'http://evil.example'],
      ['origin', 'null'],
      ['origin', `http://127.0.0.1:${port + 1}`],
      ['origin', `https://127.0.0.1:${port}`],
      ['origin', `http://localhost:${port}`],
      ['origin', `http://127.0.0.1.evil.example:${port}`],
      ['origin', 'not an origin'],
      ['referer', 'http://evil.example/page'],
      ['referer', `http://127.0.0.1:${port + 1}/`],
      ['referer', `https://127.0.0.1:${port}/`],
      ['referer', `http://127.0.0.1.evil.example:${port}/`],
      ['referer', 'not a url'],
    ];
    for (const [name, value] of foreign) {
      const what = `${name}: ${value}`;
      const mutation = await engine.post(pause, {}, { headers: { [name]: value } });
      assertRefused(mutation, 403, 'origin_refused', `POST with ${what}`);
      assertNoCors(mutation, `POST with ${what}`);
      assertRefused(await engine.get('/v1/engine', { headers: { [name]: value } }), 403, 'origin_refused', `GET with ${what}`);
    }
    assert.equal(pausedFlag(home, project), 0, 'no refused request reached the route');
    assert.deepEqual(auditStatuses(home, seq, pause), foreign.map(() => 403), 'every refused mutation is audited with its refusal');

    // The exact self origin, in either header or in both, is accepted.
    const byOrigin = await engine.post(pause, {}, { headers: { origin: self } });
    assert.equal(byOrigin.status, 200, `a mutation with the engine's own Origin is accepted (body: ${byOrigin.text})`);
    assert.equal(pausedFlag(home, project), 1);
    const byReferer = await engine.post(`/v1/projects/${project}/resume`, {}, { headers: { referer: `${self}/some/page?x=1` } });
    assert.equal(byReferer.status, 200, `a mutation with a Referer of the engine's own origin is accepted (body: ${byReferer.text})`);
    assert.equal(pausedFlag(home, project), 0);
    const both = await engine.get('/v1/engine', { headers: { origin: self, referer: `${self}/` } });
    assert.equal(both.status, 200, `a read with both, of the engine's own origin, is accepted (body: ${both.text})`);
    assertNoCors(both, "a read from the engine's own origin");
  });

  test('fetch metadata that says the request is not same-origin refuses it; no response grants another origin anything, a preflight included', async (t) => {
    const { engine, home, project } = await projectFixture(t);
    const pause = `/v1/projects/${project}/pause`;
    for (const site of ['cross-site', 'same-site']) {
      const mutation = await engine.post(pause, {}, { headers: { 'sec-fetch-site': site } });
      assertRefused(mutation, 403, 'origin_refused', `POST with Sec-Fetch-Site: ${site}`);
      assertNoCors(mutation, `POST with Sec-Fetch-Site: ${site}`);
      assertRefused(await engine.get('/v1/engine', { headers: { 'sec-fetch-site': site } }), 403, 'origin_refused', `GET with Sec-Fetch-Site: ${site}`);
    }
    assert.equal(pausedFlag(home, project), 0, 'no refused request reached the route');
    const same = await engine.post(pause, {}, { headers: { 'sec-fetch-site': 'same-origin', origin: selfOrigin(engine) } });
    assert.equal(same.status, 200, `a same-origin request is accepted (body: ${same.text})`);
    assert.equal(pausedFlag(home, project), 1);

    // A preflight from another origin: it is a request like any other, it is refused, and it is granted nothing.
    const preflight = await engine.request('OPTIONS', `/v1/projects/${project}/resume`, {
      token: null,
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-surety-token, content-type' },
    });
    assert.ok(preflight.status >= 400 && preflight.status <= 499, `a cross-origin preflight is refused (status ${preflight.status})`);
    assert.ok(isRefusalBody(preflight.body), `with the engine's refusal body: ${preflight.text}`);
    assertNoCors(preflight, 'a cross-origin preflight');
    assert.equal(pausedFlag(home, project), 1, 'and nothing happened');
  });

  test('a declared body over the cap is refused before any of it is read; a body of exactly the cap is read', async (t) => {
    const { engine, home, project } = await projectFixture(t);
    const pause = `/v1/projects/${project}/pause`;
    const seq = maxEventSeq(home);
    // Only the head is sent. The engine must not wait for a body it has already refused.
    const over = await sendRaw(engine, requestHead(engine, 'POST', pause, { ...JSON_BODY, 'Content-Length': BODY_CAP + 1 }));
    assertRefused(over, 413, 'payload_too_large', `a declared Content-Length of ${BODY_CAP + 1}`);
    assert.equal(pausedFlag(home, project), 0, 'the refused request had no effect');
    assert.deepEqual(auditStatuses(home, seq, pause), [413], 'and is audited');

    const atCap = await engine.post(pause, `{}${' '.repeat(BODY_CAP - 2)}`);
    assert.equal(atCap.status, 200, `a body of exactly ${BODY_CAP} bytes is read and carried out (body: ${atCap.text})`);
    assert.equal(pausedFlag(home, project), 1);
  });

  test('a streamed body is counted as it arrives, and parsing stops when the cap is crossed: the refusal does not wait for the end of the body', async (t) => {
    // A long body deadline, so that the refusal below cannot be the deadline's.
    const { engine, home, project, port } = await projectFixture(t, { config: { request_body_deadline: 60 } });
    const pause = `/v1/projects/${project}/pause`;
    const seq = maxEventSeq(home);
    const head = requestHead(engine, 'POST', pause, { ...JSON_BODY, 'Transfer-Encoding': 'chunked' });
    // 17 chunks of 64 KiB cross the cap of 1 MiB. The body is never finished.
    const sent = await unfinishedChunkedBody({ port, head, first: '{"note":"', size: 65_536, count: 17, waitMs: 10_000 });
    assert.ok(sent.sentBytes > BODY_CAP, 'the fixture is live: more than the cap was sent');
    assert.ok(sent.response !== null, `the engine answers once the cap is crossed, without the end of the body (${sent.sentBytes} bytes sent, no answer after 10 s)`);
    assertRefused(sent.response, 413, 'payload_too_large', 'a chunked body that crossed the cap');
    assertDefensiveHeaders(sent.response, 'the refusal of a streamed body');
    assert.equal(pausedFlag(home, project), 0, 'the refused request had no effect');
    assert.deepEqual(auditStatuses(home, seq, pause), [413], 'and is audited');

    // Chunked is not refused as such: a small chunked body is read and carried out.
    const small = await sendRaw(engine, `${head}2\r\n{}\r\n0\r\n\r\n`);
    assert.equal(small.status, 200, `a chunked body under the cap is accepted (body: ${small.text})`);
    assert.equal(pausedFlag(home, project), 1);
    assert.ok(engine.isRunning(), 'the engine is still running');
  });

  test('100 Continue is never sent to a request that its origin evidence or its declared length refuses', async (t) => {
    const { engine, home, project } = await projectFixture(t);
    const pause = `/v1/projects/${project}/pause`;
    const expecting = { ...JSON_BODY, 'Content-Length': 2, Expect: '100-continue' };
    const refused = [
      ['a foreign Origin', { ...expecting, Origin: 'http://evil.example' }, 403, 'origin_refused'],
      ['a foreign Referer', { ...expecting, Referer: 'http://evil.example/page' }, 403, 'origin_refused'],
      ['cross-site fetch metadata', { ...expecting, 'Sec-Fetch-Site': 'cross-site' }, 403, 'origin_refused'],
      ['a declared length over the cap', { ...expecting, 'Content-Length': BODY_CAP + 1 }, 413, 'payload_too_large'],
    ];
    for (const [what, headers, status, code] of refused) {
      // The head only, as a client that waits for 100 Continue sends it.
      const res = await sendRaw(engine, requestHead(engine, 'POST', pause, headers));
      assertRefused(res, status, code, `Expect: 100-continue with ${what}`);
      assert.deepEqual(res.interim, [], `no interim response precedes the refusal of ${what}`);
    }
    assert.equal(pausedFlag(home, project), 0, 'no refused request reached the route');
  });

  test('a request the HTTP parser rejects is answered by the engine, in its own form, and the engine goes on', async (t) => {
    const { engine } = await projectFixture(t);
    const token = engine.token();

    // No Host header at all (E23 item 10): the engine's host refusal, not a bare 400.
    const noHost = await sendRaw(engine, `GET /v1/health HTTP/1.1\r\nX-Surety-Token: ${token}\r\nConnection: close\r\n\r\n`);
    assertRefused(noHost, 400, 'host_refused', 'a request with no Host header');
    assertDefensiveHeaders(noHost, 'a request with no Host header');

    const garbage = await sendRaw(engine, 'THIS IS NOT HTTP\r\n\r\n');
    assert.equal(garbage.status, 400, 'a request line that is not HTTP is answered 400');
    assert.ok(isRefusalBody(garbage.body), `with a refusal body: ${garbage.text}`);
    assertDefensiveHeaders(garbage, 'a malformed request line');

    const huge = await sendRaw(engine, requestHead(engine, 'GET', '/v1/health', { 'X-Filler': 'a'.repeat(256 * 1024) }));
    assert.ok([400, 431].includes(huge.status), `a header section far over any limit is refused (status ${huge.status})`);
    assert.ok(isRefusalBody(huge.body), `with a refusal body: ${huge.text}`);
    assertDefensiveHeaders(huge, 'an oversized header section');

    assert.ok(engine.isRunning(), 'the engine is still running');
    assert.equal((await engine.get('/v1/health')).status, 200, 'and still answers');
  });

  test('defensive headers are on every response, errors included', async (t) => {
    const { engine, project } = await projectFixture(t);
    const pause = `/v1/projects/${project}/pause`;
    const responses = [
      ['200, health', await engine.get('/v1/health'), 200],
      ['200, engine', await engine.get('/v1/engine'), 200],
      ['202, a tick', await engine.post(`/v1/projects/${project}/tick`, {}), 202],
      ['400, a foreign Host', await engine.get('/v1/health', { host: 'evil.example' }), 400],
      ['400, an unknown field', await engine.post(`/v1/projects/${project}/policy`, { no_such_key: 1 }), 400],
      ['401, no token', await engine.get('/v1/health', { token: null }), 401],
      ['403, a foreign Origin', await engine.get('/v1/health', { headers: { origin: 'http://evil.example' } }), 403],
      ['403, a bootstrap without evidence', await engine.get('/v1/token/bootstrap', { token: null }), 403],
      ['404, an unknown route', await engine.get('/v1/no-such-route'), 404],
      ['413, a declared body over the cap', await sendRaw(engine, requestHead(engine, 'POST', pause, { ...JSON_BODY, 'Content-Length': BODY_CAP + 1 })), 413],
      ['417, an Expect the engine does not meet', await sendRaw(engine, `${requestHead(engine, 'POST', pause, { ...JSON_BODY, 'Content-Length': 2, Expect: 'something-else' })}{}`), 417],
      ['501, an excluded capability', await engine.post(`/v1/projects/${project}/sessions`, {}), 501],
    ];
    for (const [what, res, status] of responses) {
      assert.equal(res.status, status, `${what} (body: ${res.text})`);
      assertDefensiveHeaders(res, what);
    }
    const stream = await streamOf(engine, eventsPath({ since: 0, limit: 1 }));
    t.after(() => stream.close());
    assert.equal(stream.status, 200, `the event stream opens (refusal: ${JSON.stringify(stream.refusal)})`);
    assertDefensiveHeaders(stream, '200, an event stream');
  });

  test('a client that fails in the middle of a request body or of a stream does not stop the engine', async (t) => {
    const { engine, home, project, port } = await projectFixture(t);
    const pause = `/v1/projects/${project}/pause`;
    const resume = `/v1/projects/${project}/resume`;
    const pid = engine.pid;

    // A request body that stops arriving, and whose connection is then reset.
    for (let i = 0; i < 3; i++) {
      await abandonedUpload({ port, head: requestHead(engine, 'POST', pause, { ...JSON_BODY, 'Content-Length': 1000 }), partial: '{"note":"' });
    }
    assert.equal(pausedFlag(home, project), 0, 'a request whose body never arrived had no effect');

    // Streams whose client resets the connection while events are being written to them.
    for (let i = 0; i < 3; i++) {
      const stream = await streamOf(engine, eventsPath({ since: 0 }));
      assert.equal(stream.status, 200, `the event stream opens (refusal: ${JSON.stringify(stream.refusal)})`);
      const mutations = [engine.post(pause, {}), engine.post(resume, {})];
      stream.reset();
      await Promise.all(mutations);
      await engine.post(pause, {});
      await engine.post(resume, {});
    }

    assert.ok(engine.isRunning() && engine.pid === pid, 'the engine is the same process, still running');
    assert.equal((await engine.get('/v1/health')).status, 200, 'it answers');
    const after = await engine.post(pause, {});
    assert.equal(after.status, 200, `it still carries out a mutation (body: ${after.text})`);
    assert.equal(pausedFlag(home, project), 1);
    const again = await streamOf(engine, eventsPath({ since: 0, limit: 5 }));
    await again.waitEnd({ timeoutMs: 15_000 });
    assert.equal(again.ids.length, 5, 'and still serves its event stream to the next client');
  });
});
