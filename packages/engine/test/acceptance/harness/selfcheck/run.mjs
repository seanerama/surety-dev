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
//   3. id, process-identity, refusal-parsing and HTTP helpers behave as SEAM.md says.
//
// It is not an acceptance test and is not run by scripts/run-tests.mjs.
// Usage: node packages/engine/test/acceptance/harness/selfcheck/run.mjs

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import {
  freePort,
  httpRequest,
  isRefusalBody,
  parseRefusal,
  rawRequest,
  snapshotDir,
  startEngine,
  startRefused,
  writeEngineConfig,
} from '../engine.mjs';
import { hasIdForm, isoNow, newId, ulid } from '../ids.mjs';
import { procStartTime } from '../proc.mjs';
import * as cases from '../store-cases.mjs';

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
