#!/usr/bin/env node
// Harness self-check (build spec §8, "A limit the Verifier should plan for").
// The engine is not built while its tests are written, so running a test
// cannot show the test is right. This script checks the harness helpers that
// carry logic, against scratch SQLite databases, child processes and a local
// HTTP server:
//
//   1. every store case in ../store-cases.mjs passes against witness-schema.sql;
//   2. every store case FAILS against a mutant of that schema that lacks the
//      constraint the case pins (so a case cannot pass vacuously);
//   3. id, process-identity, refusal-parsing and HTTP helpers behave as SEAM.md says,
//      including the raw-socket client against a byte-level server (repeated
//      header lines, interim responses, a body held back until `100 Continue`).
//   4. the source inspection behind row M74 (../source-lint.mjs) reads comments,
//      strings, templates and regular expressions correctly, passes a witness
//      source set that follows SEAM.md §7 "Confinement", fails each mutant of it
//      on the rule the mutant breaks, and has the limit SEAM.md states.
//
//   5-8. the slice-2 helpers: see slice2.mjs.
//
// It is not an acceptance test and is not run by scripts/run-tests.mjs.
// Usage: node packages/engine/test/acceptance/harness/selfcheck/run.mjs

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import {
  freePort,
  httpRequest,
  isRefusalBody,
  parseRawResponse,
  parseRefusal,
  rawRequest,
  snapshotDir,
  startEngine,
  startRefused,
  writeEngineConfig,
} from '../engine.mjs';
import { hasIdForm, isoNow, newId, ulid } from '../ids.mjs';
import { procStartTime } from '../proc.mjs';
import { inspectSources, tokenize } from '../source-lint.mjs';
import * as cases from '../store-cases.mjs';
import { slice2Checks } from './slice2.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WITNESS = readFileSync(join(here, 'witness-schema.sql'), 'utf8');
const work = mkdtempSync(join(tmpdir(), 'surety-selfcheck-'));
let n = 0;
const results = [];

function freshStore(mutate) {
  const file = join(work, `store-${++n}.db`);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(WITNESS);
  if (mutate) db.exec(mutate);
  const project = newId('proj_');
  db.prepare('INSERT INTO projects (id, created_at, name) VALUES (?, ?, ?)').run(project, isoNow(), 'selfcheck');
  return { db, file, project };
}

async function check(name, fn) {
  try {
    await fn();
    results.push([true, name]);
  } catch (err) {
    results.push([false, name, err]);
  }
}

// ---- 1. cases pass against the witness --------------------------------------

const simple = [
  'm02DistinctRunsDistinctReceipts',
  'm02SecondNullTurnReceiptRejected',
  'm02NoDuplicateOriginalLedgerRow',
  'm03DuplicateTurnReceiptRejected',
  'm03CrossRunTurnRejected',
  'm03SessionRunNullTurnRejected',
  'm03OneShotRunWithTurnRejected',
  'm03RejectedWriteIsAtomic',
];
for (const name of simple) {
  await check(`witness: ${name}`, () => {
    const { db, project } = freshStore();
    try {
      cases[name](db, project);
    } finally {
      db.close();
    }
  });
}
for (const table of Object.keys(cases.APPEND_ONLY)) {
  await check(`witness: m04AppendOnly(${table})`, () => {
    const { db, project } = freshStore();
    try {
      cases.m04AppendOnly(db, project, table);
    } finally {
      db.close();
    }
  });
}
await check('witness: m02 rejection survives reopening the store', () => {
  const { db, file, project } = freshStore();
  const seeded = cases.m02SecondNullTurnReceiptRejected(db, project);
  db.close();
  const again = new Database(file);
  again.pragma('foreign_keys = ON');
  try {
    cases.m02RetryNullTurnReceiptRejected(again, project, seeded);
  } finally {
    again.close();
  }
});
await check('witness: concurrent allocation stores exactly one receipt', async () => {
  const { db, file, project } = freshStore();
  const setup = cases.m02ConcurrentSetup(db, project);
  db.close();
  await cases.m02ConcurrentAllocation(file, project, setup);
});
await check('mutant fails: concurrent allocation without the null-turn index', async () => {
  const { db, file, project } = freshStore('DROP INDEX receipts_one_per_one_shot_run');
  const setup = cases.m02ConcurrentSetup(db, project);
  db.close();
  await assert.rejects(cases.m02ConcurrentAllocation(file, project, setup));
});

// ---- 2. cases fail against mutants -------------------------------------------

const mutants = [
  ['DROP INDEX receipts_one_per_one_shot_run', ['m02SecondNullTurnReceiptRejected', 'm03RejectedWriteIsAtomic']],
  ['DROP INDEX receipts_one_per_turn', ['m03DuplicateTurnReceiptRejected']],
  [
    'DROP TRIGGER receipts_kind_matches_turn',
    ['m03CrossRunTurnRejected', 'm03SessionRunNullTurnRejected', 'm03OneShotRunWithTurnRejected'],
  ],
  ['DROP INDEX ledger_one_original_per_invocation', ['m02NoDuplicateOriginalLedgerRow']],
  [
    'DROP INDEX ledger_one_original_per_invocation; CREATE UNIQUE INDEX ledger_any ON ledger_rows(invocation)',
    ['m02NoDuplicateOriginalLedgerRow'],
  ],
];
for (const table of Object.keys(cases.APPEND_ONLY)) {
  mutants.push([`DROP TRIGGER ${table}_no_update`, [`m04AppendOnly:${table}`]]);
  mutants.push([`DROP TRIGGER ${table}_no_delete`, [`m04AppendOnly:${table}`]]);
  mutants.push([
    `DROP TRIGGER ${table}_no_update; CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
    [`m04AppendOnly:${table}`],
  ]);
}
for (const [mutation, names] of mutants) {
  for (const name of names) {
    await check(`mutant fails: ${name} under "${mutation}"`, () => {
      const { db, project } = freshStore(mutation);
      try {
        const [fn, arg] = name.split(':');
        let passed = false;
        try {
          if (arg) cases[fn](db, project, arg);
          else cases[fn](db, project);
          passed = true;
        } catch {
          // expected
        }
        assert.equal(passed, false, 'case passed against a schema missing the constraint it pins');
      } finally {
        db.close();
      }
    });
  }
}

// ---- 3. helpers ----------------------------------------------------------------

await check('ids: ULID form and time order', () => {
  const ids = Array.from({ length: 2000 }, () => newId('run_'));
  for (const id of ids) assert.ok(hasIdForm(id, 'run_'), id);
  assert.deepEqual([...ids].sort(), ids, 'ids made in sequence sort in sequence');
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!hasIdForm('run_01ARZ3NDEKTSV4RRFFQ69G5FAI', 'run_'), 'I is not Crockford');
  assert.ok(!hasIdForm('inc_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'run_'), 'wrong prefix');
  const a = ulid(1_000);
  const b = ulid(2_000);
  assert.ok(a < b);
});

await check('proc: start time of a process whose name has spaces and parentheses', async () => {
  const odd = join(work, 'a) b (c');
  copyFileSync('/bin/sleep', odd);
  execFileSync('chmod', ['+x', odd]);
  const child = spawn(odd, ['30'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200));
  try {
    const ticks = Number(procStartTime(child.pid));
    const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    const etimes = Number(execFileSync('ps', ['-o', 'etimes=', '-p', String(child.pid)], { encoding: 'utf8' }).trim());
    assert.ok(Math.abs(uptime - ticks / hz - etimes) <= 2, `ticks=${ticks} hz=${hz} uptime=${uptime} etimes=${etimes}`);
    assert.equal(procStartTime(child.pid), procStartTime(child.pid));
    assert.notEqual(procStartTime(child.pid), procStartTime(process.pid));
  } finally {
    child.kill('SIGKILL');
  }
});

await check('engine helpers: refusal parsing', () => {
  const stderr = 'starting\n{"level":"info","msg":"x"}\nnot json {\n{"code":"engine_locked","reason":"r","what_to_do":"w","subject":{"incarnation_id":"inc_x"}}\n';
  assert.equal(parseRefusal(stderr).code, 'engine_locked');
  assert.equal(parseRefusal('nothing here\n'), null);
  assert.ok(isRefusalBody({ code: 'x', reason: 'r', what_to_do: 'w', subject: null }));
  assert.ok(!isRefusalBody({ code: 'x', reason: '', what_to_do: 'w', subject: null }));
  assert.ok(!isRefusalBody({ error: { code: 'x' } }));
});

await check('engine helpers: http and raw requests send exactly what the test says', async () => {
  const port = await freePort();
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host, token: req.headers['x-surety-token'] });
    if (req.url.endsWith('/chunked')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"a":');
      res.end('1}');
      return;
    }
    res.writeHead(418, { 'content-type': 'application/json', 'x-test': 'yes' });
    res.end(JSON.stringify({ code: 'teapot' }));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const a = await httpRequest({ port, path: '/v1/x', headers: { host: 'evil.example:1', 'x-surety-token': 't' } });
    assert.equal(a.status, 418);
    assert.equal(a.body.code, 'teapot');
    assert.equal(a.headers['x-test'], 'yes');
    assert.deepEqual(seen.at(-1), { method: 'GET', url: '/v1/x', host: 'evil.example:1', token: 't' });
    const b = await rawRequest({
      port,
      text: `GET http://evil.example:${port}/v1/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    });
    assert.equal(b.status, 418);
    assert.equal(seen.at(-1).url, `http://evil.example:${port}/v1/health`);
    const c = await rawRequest({ port, text: `GET /chunked HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n` });
    assert.deepEqual(c.body, { a: 1 });
  } finally {
    server.close();
  }
});

// A byte-level server, so the checks below control and see exactly what
// crosses the socket. `react(conn, socket)` runs on every data event; `conn`
// holds everything received so far and whatever `react` notes on it.
async function withRawServer(react, fn) {
  const port = await freePort();
  const conns = [];
  const server = net.createServer((socket) => {
    const conn = { received: '' };
    conns.push(conn);
    socket.on('error', () => {});
    socket.on('data', (c) => {
      conn.received += c.toString('utf8');
      react(conn, socket);
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    return await fn(port, conns);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const OK = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}';
const REFUSED = 'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{"code":"nope"}';
const CONTINUE = 'HTTP/1.1 100 Continue\r\n\r\n';
const EXPECT_HEAD = 'POST /v1/x HTTP/1.1\r\nHost: a\r\nContent-Length: 2\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n';

await check('raw request: a repeated header line reaches the server byte for byte', async () => {
  const text = 'GET /v1/x HTTP/1.1\r\nHost: a.example:1\r\nHost: b.example\r\nConnection: close\r\n\r\n';
  await withRawServer(
    (conn, socket) => {
      if (conn.received.endsWith('\r\n\r\n')) socket.end(OK);
    },
    async (port, conns) => {
      const res = await rawRequest({ port, text });
      assert.equal(conns.length, 1);
      assert.equal(conns[0].received, text, 'nothing added, dropped or reordered');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.deepEqual(res.interim, []);
    },
  );
});

await check('raw request: an interim 100 is reported, and the body is sent only after it', async () => {
  await withRawServer(
    (conn, socket) => {
      if (conn.atHead === undefined && conn.received.endsWith('\r\n\r\n')) {
        conn.atHead = conn.received;
        // Leave time for a client that does not wait to show itself.
        setTimeout(() => {
          conn.beforeContinue = conn.received;
          socket.write(CONTINUE);
        }, 150);
      } else if (conn.received.endsWith('\r\n\r\n{}')) socket.end(OK);
    },
    async (port, conns) => {
      const res = await rawRequest({ port, text: EXPECT_HEAD, continueWith: '{}' });
      assert.equal(conns[0].atHead, EXPECT_HEAD);
      assert.equal(conns[0].beforeContinue, EXPECT_HEAD, 'no body byte was sent before the 100 arrived');
      assert.equal(conns[0].received, `${EXPECT_HEAD}{}`);
      assert.deepEqual(res.interim, [100]);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
    },
  );
});

await check('raw request: a final response with no 100 before it leaves the body unsent', async () => {
  await withRawServer(
    (conn, socket) => {
      if (conn.received.endsWith('\r\n\r\n')) socket.end(REFUSED);
    },
    async (port, conns) => {
      const res = await rawRequest({ port, text: EXPECT_HEAD, continueWith: '{}' });
      assert.deepEqual(res.interim, []);
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'nope');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(conns[0].received, EXPECT_HEAD, 'the body was never sent');
    },
  );
});

await check('raw request: a 100 sent ahead of a refusal is seen, in one segment or two', async () => {
  for (const split of [false, true]) {
    await withRawServer(
      (conn, socket) => {
        if (!conn.received.endsWith('\r\n\r\n')) return;
        if (!split) return void socket.end(CONTINUE + REFUSED);
        socket.write(CONTINUE);
        setTimeout(() => socket.end(REFUSED), 100);
      },
      async (port, conns) => {
        const res = await rawRequest({ port, text: EXPECT_HEAD });
        assert.deepEqual(res.interim, [100], `split=${split}`);
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'nope');
        assert.equal(conns[0].received, EXPECT_HEAD, 'no continuation was asked for, so none was sent');
      },
    );
  }
});

await check('raw responses: interim heads are separated from the final response', () => {
  const two = parseRawResponse(`HTTP/1.1 102 Processing\r\nX-A: 1\r\n\r\n${CONTINUE}${OK}`);
  assert.deepEqual(two.interim, [102, 100]);
  assert.equal(two.status, 200);
  assert.equal(two.headers['x-a'], undefined, 'an interim header is not attributed to the final response');
  assert.equal(two.headers['content-length'], '11');
  assert.deepEqual(parseRawResponse(OK).interim, []);
  assert.throws(() => parseRawResponse(CONTINUE), /no complete final HTTP response head.*after interim 100/);
  assert.throws(() => parseRawResponse(''), /no complete final HTTP response head/);
});

await check('raw request: a server that answers nothing is a timeout that says what arrived', async () => {
  await withRawServer(
    (conn, socket) => {
      if (conn.received.endsWith('\r\n\r\n')) socket.write(CONTINUE);
    },
    async (port) => {
      await assert.rejects(rawRequest({ port, text: EXPECT_HEAD, timeoutMs: 300 }), /timed out after 300 ms; received so far: "HTTP\/1\.1 100 Continue/);
    },
  );
});

await check('engine helpers: start, wait for full mode, refuse and stop a stand-in process', async () => {
  const cli = join(here, 'fake-engine.mjs');
  const home = mkdtempSync(join(work, 'home-'));
  const port = await freePort();
  writeEngineConfig(home, { api_port: port });
  const engine = await startEngine({ home, port, cli });
  assert.equal(engine.isRunning(), true);
  assert.equal((await engine.get('/v1/health')).body.mode, 'full');
  assert.equal((await engine.get('/v1/health', { token: null })).status, 401);
  const stopped = await engine.stop();
  assert.deepEqual(stopped, { code: 0, signal: null });

  writeEngineConfig(home, { api_port: port, bad: 1 });
  const before = snapshotDir(home);
  const refused = await startRefused({ home, cli });
  assert.equal(refused.code, 4);
  assert.equal(refused.refusal.code, 'unknown_field');
  assert.deepEqual(snapshotDir(home), before);

  writeEngineConfig(home, { api_port: port });
  const killed = await startEngine({ home, port, cli });
  assert.deepEqual(await killed.kill(), { code: null, signal: 'SIGKILL' });
});

// ---- 4. source inspection (row M74) ---------------------------------------------

const lex = (src) => tokenize(src).map((t) => `${t.kind}:${t.text}`);

await check('source lint: comments vanish; strings, templates and regular expressions do not hide or invent code', () => {
  assert.deepEqual(lex("a // harness 'x\n/* harness\n ` */ b"), ['word:a', 'word:b']);
  assert.deepEqual(lex("f('http://x') // c"), ['word:f', 'punct:(', 'string:http://x', 'punct:)']);
  assert.deepEqual(lex('const m = /^http:\\/\\/([^/?#]*)(.*)$/i.exec(raw);').slice(3, 6), ['regex:^http:\\/\\/([^/?#]*)(.*)$', 'punct:.', 'word:exec']);
  assert.deepEqual(lex('x = a / b / c'), ['word:x', 'punct:=', 'word:a', 'punct:/', 'word:b', 'punct:/', 'word:c']);
  assert.deepEqual(lex('i++ / 2\nharness'), ['word:i', 'punct:+', 'punct:+', 'punct:/', 'number:2', 'word:harness'], 'a division is not an unterminated regular expression');
  assert.deepEqual(lex('return /a\\/[/]b/.test(s)'), ['word:return', 'regex:a\\/[/]b', 'punct:.', 'word:test', 'punct:(', 'word:s', 'punct:)']);
  assert.deepEqual(lex('`a${f(`b${c}d`, { x: 1 })}e` + z'), [
    'template:a', 'word:f', 'punct:(', 'template:b', 'word:c', 'template:d', 'punct:,', 'punct:{', 'word:x', 'punct::', 'number:1', 'punct:}', 'punct:)', 'template:e', 'punct:+', 'word:z',
  ]);
  assert.deepEqual(lex("a?.b ? 0.5 : arr[0].x; f(...r)"), [
    'word:a', 'punct:?.', 'word:b', 'punct:?', 'number:0.5', 'punct::', 'word:arr', 'punct:[', 'number:0', 'punct:]', 'punct:.', 'word:x', 'punct:;', 'word:f', 'punct:(', 'punct:...', 'word:r', 'punct:)',
  ]);
  const lines = tokenize('a\n/* x\n y */ b\n`t\n${c}\nu` d');
  assert.deepEqual(lines.map((t) => [t.text, t.line]), [['a', 1], ['b', 3], ['t\n', 4], ['c', 5], ['\nu', 5], ['d', 6]]);
  assert.throws(() => tokenize("x = 'abc\ny", 'f.ts'), /f\.ts:1: unterminated string/);
  assert.throws(() => tokenize('x = `abc', 'f.ts'), /f\.ts:1: unterminated template/);
});

// A source set shaped the way SEAM.md §7 "Confinement" asks: harness behaviour
// under testing/, production files importing only the seam module and only
// calling it, the flags parsed in cli.ts.
const CONFINED = {
  'cli.ts': [
    "import { serve } from './engine.js';",
    "import { type SeamFlags, configureSeam, parseBarrierFlag } from './testing/seam.js';",
    '// Harness flags are accepted only together with --harness.',
    'let harness = false;',
    'const harnessOnly: string[] = [];',
    'for (const flag of process.argv.slice(3)) {',
    "  if (flag === '--harness') harness = true;",
    "  else if (flag === '--harness-migrations' || flag === '--harness-barrier') harnessOnly.push(flag);",
    '}',
    'if (!harness && harnessOnly.length > 0) usage(`${harnessOnly[0]} is accepted only with --harness`);',
    'const flags: SeamFlags = { on: harness };',
    'await serve({ home, seam: configureSeam(flags, harnessOnly.map((v, i) => parseBarrierFlag(v, i))) });',
  ],
  'index.ts': ["export const ENGINE_VERSION = '0.0.0';"],
  'api/server.ts': [
    "import { seamInfo, seamRoute } from '../testing/seam.js';",
    'export async function handle(r) {',
    '  const reply = await seamRoute(r.method, r.segments, r);',
    '  if (reply) return reply;',
    "  return { status: 200, body: { mode: 'full', ...seamInfo() } };",
    '}',
  ],
  'store/migrate.ts': [
    "import * as seam from '../testing/seam.js';",
    "export function migrate(db) { seam.barrier('migration.before_commit'); db.exec('COMMIT'); }",
  ],
  'store/client.ts': [
    "import { Worker } from 'node:worker_threads';",
    "import { barrierReached, type SeamInit } from '../testing/seam.js';",
    "export const start = () => new Worker(new URL('./worker.js', import.meta.url));",
    'export function onMessage(msg: { barrier: string }, init: SeamInit) {',
    '  barrierReached(msg.barrier, msg.state);',
    '  return { barrierReached: 1, init, note: msg.barrierReached };',
    '}',
  ],
  'store/transitions/project.ts': [
    '// The harness fixture installer (in testing/) calls this with its label.',
    'export function registerProject(tx, fields, label: Record<string, unknown>) {',
    "  tx.emit('project.created', { project: fields.id }, { ...label, name: fields.name });",
    '}',
  ],
  'testing/seam.ts': [
    "import { installFixture } from './fixtures.js';",
    "export const isHarness = () => on; // anything goes in here: '/v1/harness', test_fixture",
  ],
  'testing/fixtures.ts': ["export const installFixture = (tx) => registerProject(tx, {}, { test_fixture: true });"],
};
const sourceSet = (edit = {}) =>
  Object.entries({ ...CONFINED, ...edit }).map(([file, lines]) => ({ file, text: lines.join('\n') }));
// The witness with one file's lines replaced or appended to.
const withLines = (file, extra, { replace = false } = {}) => sourceSet({ [file]: replace ? extra : [...CONFINED[file], ...extra] });
const found = (list) => list.map((v) => `${v.file}:${v.line}`);

await check('source lint: the witness source set passes all three rules', () => {
  assert.deepEqual(inspectSources(sourceSet()), { door: [], callOnly: [], names: [] });
});

const DOOR_MUTANTS = [
  ['a second module of the seam folder', 'api/server.ts', ["import { installFixture } from '../testing/fixtures.js';"], 'api/server.ts:7', /other than the seam module/],
  ['a dynamic import of the seam module', 'api/server.ts', ["const m = await import('../testing/seam.js');"], 'api/server.ts:7', /dynamically/],
  ['a re-export of the seam module', 'index.ts', ["export * from './testing/seam.js';"], 'index.ts:2', /re-exports/],
  ['a named re-export of the seam module', 'index.ts', ["export { seamRoute } from './testing/seam.js';"], 'index.ts:2', /re-exports/],
  ['a worker file in the seam folder', 'store/client.ts', ["new Worker(new URL('../testing/worker.js', import.meta.url));"], 'store/client.ts:8', /names a path inside/],
  ['a path built from a root', 'store/client.ts', ["load(join(root, 'dist/testing/fixtures.js'));"], 'store/client.ts:8', /names a path inside/],
  ['a require of the seam module', 'store/client.ts', ["const s = require('../testing/seam.js');"], 'store/client.ts:8', /dynamically/],
  ['a template path', 'store/client.ts', ['load(`${root}/testing/fixtures.js`);'], 'store/client.ts:8', /names a path inside/],
];
for (const [name, file, extra, at, what] of DOOR_MUTANTS) {
  await check(`source lint mutant fails rule 1: ${name}`, () => {
    const r = inspectSources(withLines(file, extra));
    assert.deepEqual(found(r.door), [at]);
    assert.match(r.door[0].what, what);
  });
}
await check('source lint: rule 1 leaves other paths and the bare word alone', () => {
  const r = inspectSources(
    withLines('store/client.ts', ["import x from '../testingx/seam.js';", "import y from './testing-notes/a.js';", "const mode = 'testing';", "import z from '../../elsewhere/testing/a.js';"]),
  );
  assert.deepEqual(r.door, []);
});

const CALL_MUTANTS = [
  ['a seam constant compared', 'api/server.ts', ["import { SEGMENT } from '../testing/seam.js';", 'if (s[1] === SEGMENT) extra();'], ['api/server.ts:8']],
  ['a seam class tested with instanceof', 'api/server.ts', ["import { InjectedFault } from '../testing/seam.js';", 'const x = err instanceof InjectedFault ? a : b;'], ['api/server.ts:8']],
  ['a seam function passed as a value', 'api/server.ts', ['const all = list.map(seamInfo);'], ['api/server.ts:7']],
  ['a seam export in a shorthand property', 'api/server.ts', ['const o = { a: 1, seamInfo };'], ['api/server.ts:7']],
  ['a property read off the namespace', 'store/migrate.ts', ['const on = seam.on;', 'const again = seam;'], ['store/migrate.ts:3', 'store/migrate.ts:4']],
  ['a renamed import read as a value', 'api/server.ts', ["import { mode as m } from '../testing/seam.js';", 'if (cond ? m : 0) extra();'], ['api/server.ts:8']],
];
for (const [name, file, extra, at] of CALL_MUTANTS) {
  await check(`source lint mutant fails rule 2: ${name}`, () => {
    const r = inspectSources(withLines(file, extra));
    assert.deepEqual(found(r.callOnly), at);
    assert.deepEqual(r.door, []);
  });
}

const NAME_MUTANTS = [
  ['a harness route matched in the server, mode query renamed', 'api/server.ts', ["import { seamOn } from '../testing/seam.js';", "if (s[1] === 'harness' && seamOn()) serve();"], ['api/server.ts:8'], /string 'harness'/],
  ['the engine-info field written in the server', 'api/server.ts', ['const info = { harness: seamInfo() };'], ['api/server.ts:7'], /identifier harness/],
  ['a mode query imported under its own name', 'api/server.ts', ["import { isHarness } from '../testing/seam.js';", 'isHarness();'], ['api/server.ts:7', 'api/server.ts:8'], /identifier isHarness/],
  ['a harness store operation in the worker', 'store/migrate.ts', ["const OPS = { 'harness.command': run };"], ['store/migrate.ts:3'], /string 'harness\.command'/],
  ['a route in a template', 'api/server.ts', ['const p = `/v1/harness/${name}`;'], ['api/server.ts:7'], /template `\/v1\/harness\/`/],
  ['a route in a regular expression', 'api/server.ts', ['const re = /^\\/v1\\/HARNESS\\//;'], ['api/server.ts:7'], /regular expression/],
  ['the fixture label written by a transition', 'store/transitions/project.ts', ["const payload = { test_fixture: true };"], ['store/transitions/project.ts:5'], /fixture label/],
  ['the fixture label as a string key', 'store/transitions/project.ts', ["payload['test_fixture'] = true;"], ['store/transitions/project.ts:5'], /fixture label/],
  ['a route named in the CLI entry point', 'cli.ts', ["const base = '/v1/harness';"], ['cli.ts:13'], /string '\/v1\/harness'/],
  ['the bare word in a CLI string', 'cli.ts', ["log('harness mode');"], ['cli.ts:13'], /string 'harness mode'/],
  ['the fixture label in the CLI entry point', 'cli.ts', ['const test_fixture = 1;'], ['cli.ts:13'], /fixture label/],
];
for (const [name, file, extra, at, what] of NAME_MUTANTS) {
  await check(`source lint mutant fails rule 3: ${name}`, () => {
    const r = inspectSources(withLines(file, extra));
    assert.deepEqual(found(r.names), at);
    assert.match(r.names[0].what, what);
  });
}

await check('source lint limit: a mode query under another name that is only called is not detected', () => {
  // SEAM.md §7 says so: the inspection cannot tell a hook from a question
  // about the mode. Pinned here so the limit is not forgotten.
  const r = inspectSources(withLines('api/server.ts', ["import { seamOn } from '../testing/seam.js';", 'if (seamOn()) extra();']));
  assert.deepEqual(r, { door: [], callOnly: [], names: [] });
});

// ---- 5 to 8. slice 2 -------------------------------------------------------------

await slice2Checks(check, work);

// ---- report --------------------------------------------------------------------

rmSync(work, { recursive: true, force: true });
let failed = 0;
for (const [ok, name, err] of results) {
  if (ok) console.log(`ok   ${name}`);
  else {
    failed++;
    console.log(`FAIL ${name}\n     ${String(err?.stack ?? err).split('\n').slice(0, 4).join('\n     ')}`);
  }
}
console.log(`\nselfcheck: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
