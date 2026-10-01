// M69, core cases (slice 1). Plan §3.7 M69; D1 §§11.1, 17(1), 17(2), 17(14);
// build spec §8 ("Slice 1 builds the Host check, the token and the audit event
// for the routes it has"). Host and absolute-form authority are checked before
// routing and before any `100 Continue`; a request with more than one Host
// header is malformed and refused; every origin-less request needs the token;
// the token file is private and a start that finds it otherwise is refused;
// every mutating request, refusals included, is audited without the token; a
// failed audit write refuses the mutation. The rest of M69 (Origin/Referer/
// fetch metadata, body caps and `100 Continue` against those refusals,
// defensive headers, callback failures) is slice 6.

import assert from 'node:assert/strict';
import { chmodSync, statSync } from 'node:fs';
import { describe, test } from 'node:test';

import { EXIT, armFault, engineFixture, rawRequest, snapshotDir, startRefused } from './harness/engine.mjs';
import { assertRefused, auditEvents, eventsSince, maxEventSeq, projectFixture } from './harness/fixtures.mjs';
import { withStore } from './harness/store.mjs';

const pausedFlag = (home, project) =>
  withStore(home, (db) => db.prepare('SELECT "paused" FROM "projects" WHERE "id" = ?').get(project).paused);

const anyRowContains = (home, needle) =>
  withStore(home, (db) =>
    db
      .prepare('SELECT * FROM "events"')
      .all()
      .some((row) => JSON.stringify(row).includes(needle)),
  );

describe('M69 core boundary: Host, token and audit', () => {
  test('a foreign Host is refused before routing, on reads and on mutations', async (t) => {
    const { engine, home, project, port } = await projectFixture(t);
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, `localhost:${port}`]) {
      assertRefused(await engine.get('/v1/health', { host }), 400, 'host_refused', `GET with Host ${host}`);
      assertRefused(await engine.post(`/v1/projects/${project}/pause`, {}, { host }), 400, 'host_refused', `POST with Host ${host}`);
    }
    assert.equal(pausedFlag(home, project), 0, 'no refused request reached the route');
  });

  test('an absolute-form request target with a foreign authority is refused', async (t) => {
    const { engine, home, project, port } = await projectFixture(t);
    const token = engine.token();
    const send = (target, method = 'GET') =>
      rawRequest({
        port,
        text:
          `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Surety-Token: ${token}\r\n` +
          `Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      });
    assertRefused(await send(`http://evil.example:${port}/v1/health`), 400, 'host_refused', 'absolute-form GET');
    assertRefused(
      await send(`http://evil.example:${port}/v1/projects/${project}/pause`, 'POST'),
      400,
      'host_refused',
      'absolute-form POST',
    );
    assert.equal(pausedFlag(home, project), 0);
    const ok = await send(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(ok.status, 200, 'absolute-form with the exact self authority is accepted');
  });

  // HTTP/1.1 (RFC 9112 §3.2): a request with more than one Host header line
  // is answered 400, whatever the lines say. A server that keeps one line and
  // drops the rest would check a Host the client did not exclusively send.
  test('a request with more than one Host header is refused, whatever the copies say', async (t) => {
    const { engine, home, project, port } = await projectFixture(t);
    const token = engine.token();
    const self = `127.0.0.1:${port}`;
    const send = (hosts, method = 'GET', path = '/v1/health') =>
      rawRequest({
        port,
        text:
          `${method} ${path} HTTP/1.1\r\n` +
          hosts.map((h) => `Host: ${h}\r\n`).join('') +
          `X-Surety-Token: ${token}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      });
    const ok = await send([self]);
    assert.equal(ok.status, 200, `the same request with exactly one Host header is accepted (body: ${ok.text})`);

    assertRefused(await send([self, 'evil.example']), 400, 'host_refused', 'GET with the self authority, then a foreign Host');
    assertRefused(await send(['evil.example', self]), 400, 'host_refused', 'GET with a foreign Host, then the self authority');
    assertRefused(await send([self, self]), 400, 'host_refused', 'GET with the self authority twice');
    const pause = `/v1/projects/${project}/pause`;
    assertRefused(await send([self, 'evil.example'], 'POST', pause), 400, 'host_refused', 'POST with the self authority, then a foreign Host');
    assertRefused(await send([self, self], 'POST', pause), 400, 'host_refused', 'POST with the self authority twice');
    assert.equal(pausedFlag(home, project), 0, 'no refused request reached the route');
  });

  // D1 §11.1: the Host check comes before any `100 Continue`. The requests
  // below send only their head, as a client that expects 100 does; `interim`
  // is every 1xx response the engine wrote before its final one.
  test('100 Continue is not sent to a request the Host check refuses', async (t) => {
    const { engine, home, project, port } = await projectFixture(t);
    const token = engine.token();
    const self = `127.0.0.1:${port}`;
    const pause = `/v1/projects/${project}/pause`;
    const resume = `/v1/projects/${project}/resume`;
    const head = (target, host) =>
      `POST ${target} HTTP/1.1\r\nHost: ${host}\r\nX-Surety-Token: ${token}\r\n` +
      `Content-Type: application/json\r\nContent-Length: 2\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`;

    // Control: this client does see an interim response, and a request that
    // passes the checks is told to continue and is then carried out.
    const accepted = await rawRequest({ port, text: head(pause, self), continueWith: '{}' });
    assert.deepEqual(accepted.interim, [100], 'a request that passes the Host and token checks is sent 100 Continue');
    assert.equal(accepted.status, 200, `and is answered once its body has arrived (body: ${accepted.text})`);
    assert.equal(pausedFlag(home, project), 1, 'the accepted request was carried out');

    const foreignHost = await rawRequest({ port, text: head(resume, 'evil.example') });
    assertRefused(foreignHost, 400, 'host_refused', 'Expect: 100-continue with a foreign Host');
    assert.deepEqual(foreignHost.interim, [], 'no interim response precedes the refusal of a foreign Host');

    const foreignTarget = await rawRequest({ port, text: head(`http://evil.example:${port}${resume}`, self) });
    assertRefused(foreignTarget, 400, 'host_refused', 'Expect: 100-continue with a foreign absolute-form authority');
    assert.deepEqual(foreignTarget.interim, [], 'no interim response precedes the refusal of a foreign absolute-form authority');

    const twoHosts = await rawRequest({
      port,
      text: head(resume, self).replace(`Host: ${self}\r\n`, `Host: ${self}\r\nHost: evil.example\r\n`),
    });
    assertRefused(twoHosts, 400, 'host_refused', 'Expect: 100-continue with two Host headers');
    assert.deepEqual(twoHosts.interim, [], 'no interim response precedes the refusal of a repeated Host');
    assert.equal(pausedFlag(home, project), 1, 'no refused request reached the route');
  });

  test('requests without a valid token are refused', async (t) => {
    const { engine, home, project } = await projectFixture(t);
    const real = engine.token();
    assertRefused(await engine.get('/v1/health', { token: null }), 401, 'token_required', 'health without token');
    assertRefused(await engine.get('/v1/engine', { token: null }), 401, 'token_required', 'engine without token');
    const wrongSameLength = real.slice(0, -1) + (real.endsWith('a') ? 'b' : 'a');
    for (const token of [wrongSameLength, real.slice(0, 8), `${real}x`, '']) {
      assertRefused(await engine.get('/v1/engine', { token }), 401, ['token_invalid', 'token_required'], `token ${JSON.stringify(token.slice(0, 4))}…`);
    }
    assertRefused(await engine.post(`/v1/projects/${project}/pause`, {}, { token: null }), 401, 'token_required', 'mutation without token');
    assertRefused(await engine.post(`/v1/projects/${project}/pause`, {}, { token: wrongSameLength }), 401, 'token_invalid', 'mutation with wrong token');
    assert.equal(pausedFlag(home, project), 0);
  });

  test('the token file is private, long and stable across restart', async (t) => {
    const { engine, restart } = await projectFixture(t);
    const mode = statSync(engine.tokenPath()).mode & 0o777;
    assert.equal(mode & 0o077, 0, `api.token mode ${mode.toString(8)} grants nothing to group or others`);
    const token = engine.token();
    assert.ok(token.length >= 32, 'token has at least 32 characters');
    await engine.stop();
    const again = await restart();
    assert.equal(again.token(), token, 'a restart does not rotate the token');
  });

  // A token file that group or others can use may already have been read. The
  // engine does not start on it, does not repair the mode and does not replace
  // the token: it refuses like any other startup refusal (SEAM.md §1, status 5)
  // and writes nothing under the engine home.
  test('a token file open to group or others refuses the start and is left as it was', async (t) => {
    const { engine, home } = await engineFixture(t);
    const tokenPath = engine.tokenPath();
    await engine.stop();
    for (const mode of [0o644, 0o640, 0o620, 0o610, 0o604, 0o602, 0o601]) {
      const label = `api.token mode 0${mode.toString(8)}`;
      chmodSync(tokenPath, mode);
      const before = snapshotDir(home);
      const result = await startRefused({ home });
      assert.equal(result.code, EXIT.token, `${label}: exit status (signal: ${result.signal}; stderr: ${result.stderr})`);
      assert.equal(result.refusal?.code, 'token_file_refused', `${label}: refusal code (stderr: ${result.stderr})`);
      assert.equal(result.refusal.subject?.file, 'api.token', `${label}: refusal names the file`);
      assert.ok(result.refusal.reason && result.refusal.what_to_do, `${label}: refusal explains itself`);
      assert.equal(statSync(tokenPath).mode & 0o777, mode, `${label}: the mode is not repaired silently`);
      assert.deepEqual(snapshotDir(home), before, `${label}: nothing written under the engine home`);
    }
  });

  test('refused mutations are audited, and no token value is recorded', async (t) => {
    const { engine, home, project } = await projectFixture(t);
    const real = engine.token();
    const wrong = real.slice(0, -4) + 'zzzz';
    const seq = maxEventSeq(home);
    const path = `/v1/projects/${project}/pause`;
    await engine.post(path, {}, { token: null });
    await engine.post(path, {}, { token: wrong });
    const audits = auditEvents(home, seq, 'POST', path);
    assert.deepEqual(
      audits.map((e) => JSON.parse(e.payload).status),
      [401, 401],
    );
    assert.equal(anyRowContains(home, real), false, 'the real token appears in no event');
    assert.equal(anyRowContains(home, wrong), false, 'a presented token appears in no event');
  });

  test('a successful mutation is audited and attributable to its request', async (t) => {
    const { engine, home, project } = await projectFixture(t);
    const seq = maxEventSeq(home);
    const path = `/v1/projects/${project}/pause`;
    const res = await engine.post(path, {});
    assert.equal(res.status, 200, res.text);
    const requestId = res.headers['x-surety-request-id'];
    assert.ok(requestId, 'response names its request id');
    const audits = auditEvents(home, seq, 'POST', path);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].request_id, requestId);
    assert.equal(audits[0].actor_kind, 'human');
    assert.equal(JSON.parse(audits[0].payload).status, 200);
    const paused = eventsSince(home, seq).filter((e) => e.type === 'project.paused');
    assert.equal(paused.length, 1);
    assert.equal(paused[0].request_id, requestId, 'the domain event names the same request');
    assert.equal(anyRowContains(home, engine.token()), false);
  });

  test('a failed audit write refuses the mutation', async (t) => {
    const { engine, home, project } = await projectFixture(t);
    const seq = maxEventSeq(home);
    await armFault(engine, { point: 'audit_write' });
    assertRefused(await engine.post(`/v1/projects/${project}/pause`, {}), 500, 'audit_failed', 'pause with failing audit');
    assert.equal(pausedFlag(home, project), 0, 'no effect without its audit record');
    assert.equal(eventsSince(home, seq).filter((e) => e.type === 'project.paused').length, 0);
  });
});
