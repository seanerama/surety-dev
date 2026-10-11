// Developer tests for objection 055: a unix socket path is checked against
// what a socket address holds (107 bytes) before every bind the engine
// makes; the engine start refuses a home whose socket paths would pass it,
// saying how long the home may be; the service link's socket is named
// short, attributable to its environment and generation, and never governs
// the home's longest path; a check whose setup failed in this engine is not
// recorded as an engine restart. Pure functions and a scratch directory; no
// engine is started and no socket is bound.

import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { SOCKET_PATH_MAX, GENERATION_DIGITS, SocketPathTooLong, assertSocketPath, checkHomeSocketPaths, homePathMaxBytes, homeSocketPaths, socketPathBytes } = await import(join(dist, 'socket-path.js'));
const { launchSocketPath, linkSocketName, linkNamesOf } = await import(join(dist, 'deploy', 'service-host.js'));
const { fromReports } = await import(join(dist, 'checks', 'run.js'));
const { Refusal } = await import(join(dist, 'refusal.js'));

const ENV = 'env_01M4P237NMF945C8BDB99JP4FD';
const OTHER = 'env_01M4P237NMF945C8BDB99JP4FE';
const DOMAIN = 'dom_01M4P26BPXZAW525KFRQM2Y6TF';

test('a socket path of 107 bytes passes; 108 is refused by name with the path and its length, counted in bytes', () => {
  const fits = `/${'a'.repeat(106)}`;
  assert.equal(socketPathBytes(fits), 107);
  assert.equal(assertSocketPath(fits), fits, 'the path at the limit is returned unchanged');
  const over = `${fits}b`;
  assert.throws(
    () => assertSocketPath(over),
    (err) => {
      assert.ok(err instanceof SocketPathTooLong);
      assert.equal(err.code, 'socket_path_too_long');
      assert.equal(err.path, over);
      assert.equal(err.length, 108);
      assert.match(err.message, /^socket_path_too_long: /);
      assert.ok(err.message.includes(over) && err.message.includes('108 bytes') && err.message.includes(String(SOCKET_PATH_MAX)), err.message);
      return true;
    },
  );
  // Bytes, not characters: 54 two-byte characters are 108 bytes.
  const wide = `/${'é'.repeat(54)}`;
  assert.equal(wide.length, 55);
  assert.throws(() => assertSocketPath(wide), { code: 'socket_path_too_long', length: 109 });
});

test("Node binds a longer path cut and reports no error: the defect the check stands in front of (reproduced, then removed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-055-'));
  const server = net.createServer();
  server.unref();
  try {
    const path = join(dir, 'x'.repeat(115 - dir.length - 1));
    assert.equal(socketPathBytes(path), 115);
    const bound = await new Promise((resolve) => {
      server.once('error', (err) => resolve({ error: err.code }));
      server.listen(path, () => resolve({ listening: true }));
    });
    assert.deepEqual(bound, { listening: true }, 'Node reports the 115-byte path bound');
    const names = readdirSync(dir);
    assert.equal(names.length, 1);
    const cut = join(dir, names[0]);
    // libuv copies sizeof(sun_path) bytes with no terminator, and Linux binds
    // an unterminated 108-byte name as 108 characters; the engine's limit is
    // the portable 107 (`man 7 unix`), as the objection and M122 have it.
    assert.ok(path.startsWith(cut) && cut !== path, `the socket is at a cut of the path (${names[0].length} of ${path.length - dir.length - 1} characters)`);
    assert.ok(socketPathBytes(cut) > SOCKET_PATH_MAX && socketPathBytes(cut) <= SOCKET_PATH_MAX + 1, `the cut path is ${socketPathBytes(cut)} bytes (sun_path's 108 at most)`);
    assert.ok(lstatSync(cut).isSocket(), 'a socket, at the cut path');
    assert.throws(() => lstatSync(path), { code: 'ENOENT' }, 'nothing is at the full path');
    assert.throws(() => assertSocketPath(path), { code: 'socket_path_too_long' }, 'the engine refuses it before binding');
    assert.throws(() => assertSocketPath(cut), { code: 'socket_path_too_long' }, 'and refuses the 108-byte cut too: 107 is the limit');
  } finally {
    await new Promise((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the home produces three socket paths under run/, the ingress the longest, the link never governing', () => {
  const home = '/h';
  const paths = homeSocketPaths(home);
  assert.deepEqual(paths.map((p) => p.kind), ['launch', 'link', 'ingress']);
  for (const p of paths) assert.ok(p.path.startsWith('/h/run/'), p.path);
  const by = Object.fromEntries(paths.map((p) => [p.kind, p]));
  assert.equal(by.launch.path, launchSocketPath(home));
  assert.equal(by.launch.bytes, socketPathBytes(home) + 16);
  assert.equal(by.ingress.bytes, socketPathBytes(home) + 45 + GENERATION_DIGITS, 'run/env_<26>-g<digits>/in.sock');
  assert.ok(by.link.bytes < by.ingress.bytes, `the link (${by.link.bytes}) is shorter than the ingress (${by.ingress.bytes})`);
  assert.equal(by.link.bytes, socketPathBytes(join(home, 'run', linkSocketName(ENV, Number('9'.repeat(GENERATION_DIGITS)), DOMAIN))), 'the budget uses the real link name');
});

test('the start refuses a home whose longest socket path passes the limit, in the start-refusal form, saying how long the home may be; a home at the limit starts', () => {
  const max = homePathMaxBytes();
  assert.equal(max, SOCKET_PATH_MAX - 45 - GENERATION_DIGITS, 'the ingress path governs');
  const atMax = `/${'h'.repeat(max - 1)}`;
  assert.equal(socketPathBytes(atMax), max);
  assert.doesNotThrow(() => checkHomeSocketPaths(atMax));
  const over = `${atMax}x`;
  assert.throws(
    () => checkHomeSocketPaths(over),
    (err) => {
      assert.ok(err instanceof Refusal, 'a Refusal, as unsafe_filesystem is');
      assert.equal(err.status, 500);
      assert.equal(err.code, 'socket_path_too_long');
      const body = err.body();
      assert.deepEqual(Object.keys(body).sort(), ['code', 'reason', 'subject', 'what_to_do']);
      assert.ok(body.reason.includes(`${max + 1} bytes`) && body.reason.includes(String(SOCKET_PATH_MAX)) && body.reason.includes('ingress'), body.reason);
      assert.ok(body.what_to_do.includes(`at most ${max} bytes`), body.what_to_do);
      assert.equal(body.subject.path, '.');
      assert.equal(body.subject.home_bytes, max + 1);
      assert.equal(body.subject.home_max_bytes, max);
      assert.equal(body.subject.limit, SOCKET_PATH_MAX);
      assert.equal(body.subject.longest.kind, 'ingress');
      assert.equal(body.subject.longest.bytes, SOCKET_PATH_MAX + 1);
      return true;
    },
  );
  // The rehearsal's home of objection 055 (56 bytes) is accepted; the README's real-run home (43 bytes) too.
  assert.doesNotThrow(() => checkHomeSocketPaths('/home/smahoney/surety-m4-rehearsal-20261011T180141Z/home'));
  assert.doesNotThrow(() => checkHomeSocketPaths('/home/smahoney/surety-m4-real-20261011/home'));
});

test('the link socket is named lk-<environment tail>-g<generation>-<check domain tail>.sock, lower case, 29 bytes plus the generation; it carries no environment name', () => {
  const name = linkSocketName(ENV, 1, DOMAIN);
  assert.equal(name, 'lk-b99jp4fd-g1-kfrqm2y6tf.sock');
  assert.match(name, /^lk-[0-9a-z]{8}-g[1-9][0-9]*-[0-9a-z]{10}\.sock$/);
  assert.equal(name, `lk-${ENV.slice(-8).toLowerCase()}-g1-${DOMAIN.slice(-10).toLowerCase()}.sock`);
  assert.equal(socketPathBytes(name), 29 + 1);
  assert.ok(!name.includes(ENV) && !name.includes('env_'), 'no environment name');
  assert.equal(socketPathBytes(linkSocketName(ENV, 123456, DOMAIN)), 29 + 6);
  // In the objection's home the link fits with room (the old name was 115 bytes there).
  const path = join('/home/smahoney/surety-m4-rehearsal-20261011T180141Z/home', 'run', name);
  assert.ok(socketPathBytes(path) <= SOCKET_PATH_MAX, `${socketPathBytes(path)} bytes`);
  assert.equal(assertSocketPath(path), path);
});

test('the inventory attributes a link socket to its environment and generation by name, and not to another environment', () => {
  const mine = linkNamesOf(ENV);
  const m = mine.exec(linkSocketName(ENV, 42, DOMAIN));
  assert.ok(m, 'matches its own');
  assert.equal(Number(m[1]), 42);
  assert.equal(mine.exec(linkSocketName(OTHER, 42, DOMAIN)), null, 'not another environment of the same prefix');
  assert.equal(mine.exec(`${ENV}-g42-link-${DOMAIN.slice(-10).toLowerCase()}.sock`), null, 'not the old name');
  assert.equal(mine.exec('launch.sock'), null);
  assert.equal(mine.exec(`${ENV}-g42`), null, 'not a runtime directory');
});

test('a check whose setup failed in the engine that admitted it is interrupted with that reason, never as an engine restart; a restart keeps its reason', () => {
  const none = fromReports({ reports: [], authorized: false, cause: 'failure' });
  assert.equal(none.kind, 'interrupt');
  assert.ok(!none.why.includes('restarted before'), none.why);
  assert.ok(none.why.includes('no engine restarted') && none.why.includes('failed in the engine that admitted it'), none.why);
  const restart = fromReports({ reports: [], authorized: false, cause: 'restart' });
  assert.equal(restart.kind, 'interrupt');
  assert.equal(restart.why, "the engine restarted before the check's exit report was recorded");
  const unsaid = fromReports({ reports: [], authorized: false });
  assert.equal(unsaid.why, restart.why, 'the cause left unsaid is a restart, as every earlier caller meant');
  // A started report without an exit, the same.
  const started = fromReports({ reports: [{ kind: 'started', detail: null }], authorized: true, cause: 'failure' });
  assert.equal(started.kind, 'interrupt');
  assert.ok(started.why.includes('no engine restarted'), started.why);
});

test('the socket-path module and the scratch directory leave nothing behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-055-'));
  mkdirSync(join(dir, 'run'));
  rmSync(dir, { recursive: true, force: true });
  assert.throws(() => lstatSync(dir), { code: 'ENOENT' });
});
