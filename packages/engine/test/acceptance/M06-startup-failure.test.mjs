// M06, cases carried over from the slice-1 reviews (listed under slice 2).
// Plan §3.1 M06; D1 §1.4; E23 item 11; SEAM.md §1 "A start that fails before
// listening". Whatever stops a start before the listener is up, the engine
// says why in the one-line refusal and exits with a defined status. It never
// ends in an uncaught error, it does not become an owner, and it does not
// block the next start. A failure after the listener is up is not an exit:
// the engine stays restricted with the failing step readable.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { freePort, isRefusalBody, makeTempDir, removeDir, startEngine, startRefused, writeEngineConfig } from './harness/engine.mjs';
import { assertRefused } from './harness/fixtures.mjs';

const EXIT_NOT_STARTED = 6;

async function freshHome(t) {
  const home = makeTempDir('m06f');
  t.after(() => {
    try {
      chmodSync(home, 0o755);
    } catch {
      // already removed
    }
    removeDir(home);
  });
  const port = await freePort();
  writeEngineConfig(home, { api_port: port });
  return { home, port };
}

// The start exited with the defined status and one refusal line, and not
// through an uncaught error.
function assertRefusedToStart(result, code, label) {
  assert.ok(!/^\s+at .+:\d+:\d+\)?$/m.test(result.stderr), `${label}: no stack trace on stderr:\n${result.stderr.slice(-1500)}`);
  assert.ok(!/Node\.js v\d+/.test(result.stderr), `${label}: not Node's report of an uncaught error:\n${result.stderr.slice(-1500)}`);
  assert.equal(result.code, EXIT_NOT_STARTED, `${label}: exit status (signal: ${result.signal}; stderr: ${result.stderr.slice(-600)})`);
  assert.ok(isRefusalBody(result.refusal), `${label}: one refusal line with code, reason, what_to_do and subject (stderr: ${result.stderr.slice(-600)})`);
  assert.equal(result.refusal.code, code, `${label}: refusal code`);
}

async function assertNextStartSucceeds(t, home, port, label) {
  const engine = await startEngine({ home, port });
  t.after(() => engine.kill());
  assert.equal((await engine.engineInfo()).mode, 'full', `${label}: once the cause is removed the next start reaches full mode`);
  await engine.stop();
}

describe('M06 a start that cannot begin says why and exits with a defined status', () => {
  test('a directory where api.token.tmp should be', async (t) => {
    const { home, port } = await freshHome(t);
    mkdirSync(join(home, 'api.token.tmp'));
    const result = await startRefused({ home });
    assertRefusedToStart(result, 'home_unusable', 'api.token.tmp is a directory');
    assert.equal(result.refusal.subject?.path, 'api.token.tmp', 'the refusal names the path');
    assert.equal(existsSync(join(home, 'engine.lock')), false, 'the refused start left no lock');
    assert.equal(existsSync(join(home, 'api.token')), false, 'and no token');
    assert.equal(existsSync(join(home, 'store.db')), false, 'and opened no store');
    rmSync(join(home, 'api.token.tmp'), { recursive: true });
    await assertNextStartSucceeds(t, home, port, 'api.token.tmp removed');
  });

  test('a directory where engine.lock.guard should be', async (t) => {
    const { home, port } = await freshHome(t);
    mkdirSync(join(home, 'engine.lock.guard'));
    const result = await startRefused({ home });
    assertRefusedToStart(result, 'home_unusable', 'engine.lock.guard is a directory');
    assert.equal(result.refusal.subject?.path, 'engine.lock.guard', 'the refusal names the path');
    assert.equal(existsSync(join(home, 'engine.lock')), false, 'the refused start left no lock');
    assert.equal(existsSync(join(home, 'api.token')), false, 'and no token');
    rmSync(join(home, 'engine.lock.guard'), { recursive: true });
    await assertNextStartSucceeds(t, home, port, 'engine.lock.guard removed');
  });

  test('an engine home that is not writable', async (t) => {
    assert.notEqual(process.getuid(), 0, 'this case needs a user that file modes apply to; it cannot be shown as root');
    const { home, port } = await freshHome(t);
    chmodSync(home, 0o555);
    const result = await startRefused({ home });
    chmodSync(home, 0o755);
    assertRefusedToStart(result, 'home_unusable', 'the home is not writable');
    assert.equal(typeof result.refusal.subject?.path, 'string', 'the refusal names a path');
    for (const name of ['engine.lock', 'api.token', 'store.db']) assert.equal(existsSync(join(home, name)), false, `no ${name} was left behind`);
    await assertNextStartSucceeds(t, home, port, 'home writable again');
  });

  test('an API port that is already bound', async (t) => {
    const { home, port } = await freshHome(t);
    const squatter = net.createServer();
    await new Promise((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(port, '127.0.0.1', resolve);
    });
    let result;
    try {
      result = await startRefused({ home });
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
    assertRefusedToStart(result, 'listen_failed', 'the port is taken');
    assert.equal(result.refusal.subject?.port, port, 'the refusal names the port');
    await assertNextStartSucceeds(t, home, port, 'port free again');
  });

  // D1 §1.4: a failure in the store step is not an exit. This is what a
  // directory at store.db produces.
  test('a directory where store.db should be leaves the engine restricted with the failure readable', async (t) => {
    const { home, port } = await freshHome(t);
    mkdirSync(join(home, 'store.db'));
    const engine = await startEngine({ home, port, until: 'failed' });
    t.after(() => engine.kill());
    const info = await engine.engineInfo();
    assert.equal(info.mode, 'restricted');
    assert.equal(info.startup.failed.step, 'store');
    assert.equal(typeof info.startup.failed.code, 'string');
    assert.ok(!info.startup.completed.includes('store') && !info.startup.completed.includes('full'));
    assert.equal((await engine.get('/v1/health')).body.mode, 'restricted', 'health still answers');
    assertRefused(await engine.post('/v1/projects/proj_x/pause', {}), 503, 'engine_starting', 'a mutation while restricted');
    assert.equal(engine.isRunning(), true, 'the engine did not crash');
  });
});
