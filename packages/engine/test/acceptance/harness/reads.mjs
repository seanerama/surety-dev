// Reads of the engine's projections for rows M70 and M74 (SEAM.md §§91, 95):
// the project list and one project's combined projection, a candidate, and a
// read that gives up after a stated number of bytes or milliseconds, for the
// record reads that must refuse instead of serving or waiting.

import assert from 'node:assert/strict';
import http from 'node:http';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Every read carries when it was served and the store snapshot it was
// computed from (D1 §11.3, A.10).
export function assertReadEnvelope(body, what) {
  assert.match(String(body?.served_at), TIMESTAMP, `${what}: served_at is a timestamp`);
  assert.ok(Number.isInteger(body?.snapshot_seq) && body.snapshot_seq >= 0, `${what}: snapshot_seq is the store's event sequence at the read (${body?.snapshot_seq})`);
}

// GET /v1/projects: {served_at, snapshot_seq, projects: [...]}.
export async function listProjects(engine) {
  const res = await engine.get('/v1/projects');
  assert.equal(res.status, 200, `GET /v1/projects (body: ${res.text})`);
  assertReadEnvelope(res.body, 'GET /v1/projects');
  assert.ok(Array.isArray(res.body.projects), `GET /v1/projects lists projects (body: ${res.text})`);
  return res.body;
}

// GET /v1/projects/:p: {served_at, snapshot_seq, project: {...}}.
export async function readProject(engine, project) {
  const res = await engine.get(`/v1/projects/${project}`);
  assert.equal(res.status, 200, `GET /v1/projects/${project} (body: ${res.text})`);
  assertReadEnvelope(res.body, `GET /v1/projects/${project}`);
  assert.equal(res.body.project?.id, project, `the projection is of the project in the path (body: ${res.text.slice(0, 300)})`);
  return res.body;
}

// GET /v1/projects/:p/candidates/:c: {served_at, snapshot_seq, candidate: {...}}.
export async function readCandidate(engine, project, candidate) {
  const res = await engine.get(`/v1/projects/${project}/candidates/${candidate}`);
  assert.equal(res.status, 200, `GET candidate ${candidate} (body: ${res.text})`);
  assertReadEnvelope(res.body, `GET candidate ${candidate}`);
  assert.equal(res.body.candidate?.id, candidate, `the answer is the candidate in the path (body: ${res.text.slice(0, 300)})`);
  return res.body.candidate;
}

// GET /v1/projects/:p/runs/:r: the run (SEAM.md §17).
export async function readRun(engine, project, run) {
  const res = await engine.get(`/v1/projects/${project}/runs/${run}`);
  assert.equal(res.status, 200, `GET run ${run} (body: ${res.text})`);
  assert.equal(res.body.run?.id, run, `the answer is the run in the path (body: ${res.text.slice(0, 300)})`);
  return res.body.run;
}

// A GET that takes at most `maxBytes` of body and waits at most `timeoutMs`
// (a timer, so monotonic). Resolves with {status, headers, text, bytes,
// complete, gaveUp}: `complete` is true when the response ended by itself
// within both limits; otherwise `gaveUp` says which limit was hit, and `text`
// holds what had arrived.
export function boundedGet(engine, path, { maxBytes = 1 << 20, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let status = null;
    let headers = {};
    let settled = false;
    const finish = (complete, gaveUp) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ status, headers, text: Buffer.concat(chunks).toString('utf8'), bytes, complete, gaveUp });
    };
    const timer = setTimeout(() => finish(false, `no complete answer within ${timeoutMs} ms`), timeoutMs);
    const req = http.request(
      { host: '127.0.0.1', port: engine.port, method: 'GET', path, headers: { host: engine.authority, 'x-surety-token': engine.token(), connection: 'close' }, setHost: false, agent: false },
      (res) => {
        status = res.statusCode;
        headers = res.headers;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) return finish(false, `more than ${maxBytes} bytes of body`);
          chunks.push(chunk);
        });
        res.on('end', () => finish(true, null));
        res.on('error', (err) => finish(false, `the response failed: ${err.message}`));
      },
    );
    req.on('error', (err) => finish(false, `the request failed: ${err.message}`));
    req.end();
  });
}
