// M107, the bootstrap route is off by default; the accepted M1 case opts in
// (M2 slice 10, kernel lane). M2 plan §3.1 M107; D2 §2.6, K3, N05, A.7
// (D2-I12); E44 item 1, E56 item 3, E58 item 11; SEAM.md §§90, 115, 118.
//
// `GET /v1/token/bootstrap` trusts headers any local program can forge
// (E42), so it is the one route through which another uid could obtain the
// token. It answers only when the engine setting `ui_bootstrap` is true,
// and otherwise refuses with `bootstrap_disabled` before the token is read:
// full positive evidence gets the refusal, with no token anywhere in it, and
// the harness fault on the token read is never reached. The engine read
// says whether the exception is in force. The opt-in exists for labelled
// compatibility tests: the accepted M1 case, M68-browser-bootstrap.test.mjs,
// now runs under `ui_bootstrap: true` and is otherwise unchanged (K3; the
// change is recorded in COVERAGE.md). The key is part of the closed
// configuration: a non-boolean is refused, and the default is false.
//
// Cases (a) and (b) are expected to fail on the engine these tests were
// written against, which serves the route unconditionally and knows no such
// key; (c) fails at the key (COVERAGE.md, "M2 slice 10").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertNoCors, selfOrigin } from './harness/boundary.mjs';
import { EXIT, armFault, engineFixture, freePort, makeTempDir, removeDir, snapshotDir, startRefused, writeEngineConfig } from './harness/engine.mjs';
import { assertRefused } from './harness/fixtures.mjs';

const positive = (engine) => ({ 'sec-fetch-site': 'same-origin', referer: `${selfOrigin(engine)}/` });
const bootstrap = (engine, headers) => engine.get('/v1/token/bootstrap', { token: null, headers });
const holdsToken = (res, token) => res.text.includes(token) || JSON.stringify(res.headers).includes(token);

describe('M107 the bootstrap route is off by default', () => {
  test('(a) with ui_bootstrap unset, full positive evidence is refused bootstrap_disabled with no token anywhere, before the token is read; the engine read says the exception is not in force', async (t) => {
    const { engine } = await engineFixture(t);
    const token = engine.token();
    await armFault(engine, { point: 'token_read' });
    const res = await bootstrap(engine, positive(engine));
    assertRefused(res, 403, 'bootstrap_disabled', 'the bootstrap with full positive evidence');
    assert.equal(holdsToken(res, token), false, 'no token in the refusal');
    assertNoCors(res, 'the refusal');
    // The fault on the token read fires as a 500 (the control in (b)): a 403 says the refusal came first.
    assert.notEqual(res.status, 500, 'the token was never read');
    const info = await engine.engineInfo();
    assert.equal(info.bootstrap_exception, false, 'the engine read reports no exception in force');
    assert.deepEqual(info.config.ui_bootstrap, { value: false, source: 'default' }, 'ui_bootstrap is in the closed configuration, false by default');
    // Nor to a page with either header, nor with none: the route is closed whatever the evidence.
    for (const headers of [{ 'sec-fetch-site': 'same-origin', origin: selfOrigin(engine) }, {}]) {
      const again = await bootstrap(engine, headers);
      assert.equal(again.status, 403, `closed to ${JSON.stringify(headers)} (body: ${again.text})`);
      assert.equal(holdsToken(again, token), false);
    }
    assert.equal((await engine.get('/v1/health')).status, 200, 'the rest of the API is as before');
  });

  test('(b) with ui_bootstrap true, the compatibility opt-in: the route answers positive evidence with the token and the engine read says the exception is in force; the token-read fault is live there', async (t) => {
    const { engine } = await engineFixture(t, { config: { ui_bootstrap: true } });
    const token = engine.token();
    const info = await engine.engineInfo();
    assert.equal(info.bootstrap_exception, true, 'the engine read reports the exception in force');
    assert.deepEqual(info.config.ui_bootstrap, { value: true, source: 'file' });
    const res = await bootstrap(engine, positive(engine));
    assert.equal(res.status, 200, `the opt-in serves the route (body: ${res.text})`);
    assert.deepEqual(res.body, { token }, 'the answer is the token and nothing else, as M68 pins');
    assertRefused(await bootstrap(engine, {}), 403, 'origin_refused', 'no evidence, under the opt-in');

    // The control for (a): with the fault armed the token read fails and the request says so.
    await armFault(engine, { point: 'token_read' });
    const faulted = await bootstrap(engine, positive(engine));
    assertRefused(faulted, 500, 'token_read_failed', 'the bootstrap while the token read fails');
    assert.equal(holdsToken(faulted, token), false, 'no token in that answer either');
    assert.equal((await bootstrap(engine, positive(engine))).status, 200, 'the fault was one-shot: the next read answers');
  });

  test('(c) ui_bootstrap is in the closed configuration: a non-boolean is refused invalid_value before the engine takes any state, and the default is false', async (t) => {
    for (const value of ['yes', 'true', 1, 0, null, {}]) {
      const home = makeTempDir('m107');
      t.after(() => removeDir(home));
      const port = await freePort();
      writeEngineConfig(home, { api_port: port, ui_bootstrap: value });
      const before = snapshotDir(home);
      const result = await startRefused({ home });
      const label = JSON.stringify({ ui_bootstrap: value });
      assert.equal(result.code, EXIT.config, `${label}: exit status (stderr: ${result.stderr})`);
      assert.equal(result.refusal?.code, 'invalid_value', `${label}: refusal code (stderr: ${result.stderr})`);
      assert.equal(result.refusal.subject?.field, 'ui_bootstrap', `${label}: refusal names the field`);
      assert.deepEqual(snapshotDir(home), before, `${label}: nothing written under the engine home`);
    }
    const { engine } = await engineFixture(t, { config: { ui_bootstrap: false } });
    assert.deepEqual((await engine.engineInfo()).config.ui_bootstrap, { value: false, source: 'file' }, 'an explicit false is accepted and reported as configured');
    assert.equal((await engine.engineInfo()).bootstrap_exception, false);
  });
});
