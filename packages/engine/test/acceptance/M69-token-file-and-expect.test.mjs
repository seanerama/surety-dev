// M69, cases carried over from the slice-1 reviews (listed under slice 2).
// Plan §3.7 M69; D1 §§11.1, 17(1), 17(2), 17(14); E23 items 8 and 12;
// SEAM.md §6. The token file is the engine's only credential: one that is not
// a regular file, or does not hold a well-formed token, refuses the start as
// an exposed one does, and is never replaced. A request whose `Expect` is not
// `100-continue` is answered by the engine, after its Host and token checks
// and with its audit record, not by the HTTP library ahead of them.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { EXIT, freePort, makeTempDir, rawRequest, removeDir, sha256Hex, startEngine, startRefused, writeEngineConfig } from './harness/engine.mjs';
import { assertRefused, auditEvents, maxEventSeq, projectFixture } from './harness/fixtures.mjs';
import { withStore } from './harness/store.mjs';

async function freshHome(t) {
  const home = makeTempDir('m69t');
  t.after(() => removeDir(home));
  const port = await freePort();
  writeEngineConfig(home, { api_port: port });
  return { home, port };
}

// Every entry of the home with its kind and mode, and the content hash of
// regular files. It never opens anything that is not a regular file: reading
// a pipe would block.
function listHome(home) {
  const out = {};
  for (const name of readdirSync(home).sort()) {
    const st = lstatSync(join(home, name));
    const kind = st.isFIFO() ? 'fifo' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    out[name] = `${kind} ${(st.mode & 0o777).toString(8)}${st.isFile() ? ` ${sha256Hex(readFileSync(join(home, name)))}` : ''}`;
  }
  return out;
}

function assertTokenFileRefused(result, label) {
  assert.equal(result.code, EXIT.token, `${label}: exit status (signal: ${result.signal}; stderr: ${result.stderr})`);
  assert.equal(result.refusal?.code, 'token_file_refused', `${label}: refusal code (stderr: ${result.stderr})`);
  assert.equal(result.refusal.subject?.file, 'api.token', `${label}: the refusal names the file`);
  assert.ok(result.refusal.reason && result.refusal.what_to_do, `${label}: the refusal explains itself`);
}

const pausedFlag = (home, project) =>
  withStore(home, (db) => db.prepare('SELECT "paused" FROM "projects" WHERE "id" = ?').get(project).paused);

describe('M69 the token file and the Expect header', () => {
  // E23 item 12. Opening a pipe for reading waits for a writer; the engine
  // must look before it opens. Nothing ever writes into this pipe.
  test('a named pipe at api.token refuses the start promptly, whatever its mode, and nothing is written', async (t) => {
    for (const mode of ['600', '644', '666']) {
      const { home } = await freshHome(t);
      const label = `fifo mode ${mode}`;
      execFileSync('mkfifo', ['-m', mode, join(home, 'api.token')]);
      const before = listHome(home);
      const result = await startRefused({ home, timeoutMs: 10_000 });
      assertTokenFileRefused(result, label);
      assert.deepEqual(listHome(home), before, `${label}: nothing written, the pipe left as it was`);
      assert.ok(lstatSync(join(home, 'api.token')).isFIFO(), `${label}: the pipe was not replaced`);
      assert.equal(existsSync(join(home, 'engine.lock')), false, `${label}: no lock taken`);
    }
  });

  // E23 item 8. The engine never rotates the operator's token on its own: a
  // file that cannot be a token is refused, like one with unsafe permissions.
  const MALFORMED = [
    ['empty', ''],
    ['only a line break', '\n'],
    ['only spaces', '   \n'],
    ['31 characters', `${'a'.repeat(31)}\n`],
    ['leading space', ` ${'a'.repeat(64)}\n`],
    ['leading line break', `\n${'a'.repeat(64)}\n`],
    ['leading tab', `\t${'a'.repeat(64)}\n`],
    ['a line break inside', `${'a'.repeat(32)}\n${'b'.repeat(32)}\n`],
    ['a control character', `${'a'.repeat(32)}\u0001${'b'.repeat(31)}\n`],
    ['a NUL', `${'a'.repeat(32)}\u0000${'b'.repeat(31)}\n`],
    ['DEL', `${'a'.repeat(32)}\u007f${'b'.repeat(31)}\n`],
    ['a non-ASCII letter', `${'a'.repeat(32)}é${'b'.repeat(31)}\n`],
    ['non-ASCII only', `${'ü'.repeat(64)}\n`],
  ];
  test('a malformed token file refuses the start and is never replaced', async (t) => {
    // Every form is tried, each in its own home, and every one that is not
    // refused is reported: a start that has not exited after five seconds is
    // an engine that accepted the file.
    const problems = [];
    for (const [name, content] of MALFORMED) {
      const { home } = await freshHome(t);
      const tokenPath = join(home, 'api.token');
      writeFileSync(tokenPath, content, { mode: 0o600 });
      chmodSync(tokenPath, 0o600);
      const before = listHome(home);
      try {
        const result = await startRefused({ home, timeoutMs: 5_000 });
        assertTokenFileRefused(result, name);
        assert.deepEqual(listHome(home), before, 'nothing written, the file left byte for byte');
      } catch (err) {
        problems.push(`api.token with ${name}: ${String(err.message).split('\n')[0]}`);
      }
    }
    assert.deepEqual(problems, [], 'every malformed token file is refused with token_file_refused and left as it was');
  });

  test('a well-formed token an operator wrote is used as it is', async (t) => {
    // 32 visible ASCII characters, punctuation included, and a trailing line break.
    const token = `Aa0!#$%&'()*+,-./:;<=>?@[]^_{|}~`;
    assert.equal(token.length, 32);
    const { home, port } = await freshHome(t);
    writeFileSync(join(home, 'api.token'), `${token}\n`, { mode: 0o600 });
    const engine = await startEngine({ home, port });
    t.after(() => engine.kill());
    assert.equal(readFileSync(join(home, 'api.token'), 'utf8'), `${token}\n`, 'the file is not rewritten');
    assert.equal((await engine.get('/v1/health', { token })).status, 200, 'the token in the file authenticates');
    assertRefused(await engine.get('/v1/health', { token: `${token}x` }), 401, 'token_invalid', 'a longer token');
  });

  // E23 item 12; D1 §11.1: the Host check comes before anything else. Without
  // a handler of its own for such requests, the HTTP library answers 417
  // before the engine has checked the Host, and nothing is audited.
  test('an Expect other than 100-continue is answered by the engine: Host first, then its own audited refusal', async (t) => {
    const { engine, home, project, port } = await projectFixture(t);
    const token = engine.token();
    const self = `127.0.0.1:${port}`;
    const pause = `/v1/projects/${project}/pause`;
    const request = (method, target, host, expect, { withToken = true } = {}) =>
      rawRequest({
        port,
        text:
          `${method} ${target} HTTP/1.1\r\nHost: ${host}\r\n` +
          (withToken ? `X-Surety-Token: ${token}\r\n` : '') +
          `Content-Type: application/json\r\nContent-Length: 2\r\nExpect: ${expect}\r\nConnection: close\r\n\r\n{}`,
      });

    for (const expect of ['200-ok', 'something-else', '100-continue, 200-ok']) {
      const foreign = await request('POST', pause, 'evil.example', expect);
      assertRefused(foreign, 400, 'host_refused', `Expect: ${expect} with a foreign Host`);
      assert.deepEqual(foreign.interim, [], 'no interim response');
      const foreignTarget = await request('POST', `http://evil.example:${port}${pause}`, self, expect);
      assertRefused(foreignTarget, 400, 'host_refused', `Expect: ${expect} with a foreign absolute-form authority`);
    }
    assert.equal(pausedFlag(home, project), 0, 'no refused request reached the route');

    const seq = maxEventSeq(home);
    const refused = await request('POST', pause, self, '200-ok');
    assertRefused(refused, 417, 'expect_refused', 'Expect: 200-ok with a valid Host and token');
    assert.equal(refused.body.subject?.expect, '200-ok', 'the refusal names the expectation');
    assert.deepEqual(refused.interim, [], 'no interim response');
    assert.equal(pausedFlag(home, project), 0, 'the route was not reached');
    const audits = auditEvents(home, seq, 'POST', pause);
    assert.equal(audits.length, 1, 'the refusal is audited once');
    assert.equal(JSON.parse(audits[0].payload).status, 417);
    assert.equal(audits[0].request_id, refused.headers['x-surety-request-id'], 'the audit record names the request');

    assertRefused(await request('GET', '/v1/health', self, '200-ok'), 417, 'expect_refused', 'a read with Expect: 200-ok');

    // The same request without the odd expectation is carried out.
    const ok = await engine.post(pause, {});
    assert.equal(ok.status, 200, ok.text);
    assert.equal(pausedFlag(home, project), 1);
  });
});
