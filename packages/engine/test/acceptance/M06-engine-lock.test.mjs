// M06 (slice 1). Plan §3.1 M06; D1 §§1.3–1.4, 16.1; D1-17; Review B17. One
// exclusive engine per home. A second start is refused with engine_locked and
// changes nothing; simultaneous starts produce one owner; a restart tells a
// stale owner from a live or reused process identity and runs recovery before
// it lifts to full mode and starts the scheduler.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  EXIT,
  Engine,
  engineFixture,
  freePort,
  makeTempDir,
  removeDir,
  spawnEngine,
  startEngine,
  startRefused,
  waitFor,
  writeEngineConfig,
} from './harness/engine.mjs';
import { hasIdForm, isoNow, newId } from './harness/ids.mjs';
import { bootId, isAlive, procStartTime } from './harness/proc.mjs';
import { storePath, withStore } from './harness/store.mjs';

const STARTUP_STEPS = ['lock', 'listen', 'store', 'recovery', 'integrity', 'full', 'scheduler'];

const lockPath = (home) => join(home, 'engine.lock');
const readLock = (home) => JSON.parse(readFileSync(lockPath(home), 'utf8'));
const incarnations = (home) =>
  withStore(home, (db) => db.prepare('SELECT "id", "pid", "started_at", "host_boot_id" FROM "engine_incarnations" ORDER BY "id"').all());

async function freshHome(t) {
  const home = makeTempDir('m06');
  t.after(() => removeDir(home));
  const port = await freePort();
  writeEngineConfig(home, { api_port: port });
  return { home, port };
}

// A long-lived process the test owns, to stand in for an unrelated or live pid.
function bystander(t) {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  return child;
}

function writeLock(home, fields) {
  writeFileSync(
    lockPath(home),
    JSON.stringify({ incarnation_id: newId('inc_'), started_at: isoNow(-60_000), host_boot_id: bootId(), ...fields }),
  );
}

async function waitForFullStartup(engine) {
  return waitFor(
    async () => {
      const info = await engine.engineInfo();
      return info.startup?.completed?.includes('scheduler') ? info : undefined;
    },
    { what: 'startup to complete through the scheduler step' },
  );
}

describe('M06 one engine incarnation per home', () => {
  test('a second engine on a live home is refused with engine_locked and changes nothing', async (t) => {
    const { home, engine } = await engineFixture(t);
    const info = await engine.engineInfo();
    const lockBytes = readFileSync(lockPath(home));
    const lock = JSON.parse(lockBytes);

    assert.ok(hasIdForm(lock.incarnation_id, 'inc_'), `incarnation id form: ${lock.incarnation_id}`);
    assert.equal(lock.pid, engine.pid);
    assert.equal(lock.pid_start_time, procStartTime(engine.pid));
    assert.equal(lock.host_boot_id, bootId());
    assert.match(lock.started_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(info.incarnation, lock.incarnation_id);
    const rowsBefore = incarnations(home);
    assert.deepEqual(
      rowsBefore.map((r) => [r.id, r.pid]),
      [[lock.incarnation_id, engine.pid]],
    );

    const second = await startRefused({ home });
    assert.equal(second.code, EXIT.locked, `exit status (stderr: ${second.stderr})`);
    assert.equal(second.refusal?.code, 'engine_locked', second.stderr);
    assert.equal(second.refusal.subject?.incarnation_id, lock.incarnation_id);

    assert.deepEqual(readFileSync(lockPath(home)), lockBytes, 'lock untouched');
    assert.deepEqual(incarnations(home), rowsBefore, 'no incarnation row added');
    const after = await engine.engineInfo();
    assert.equal(after.incarnation, info.incarnation);
    assert.equal(after.mode, 'full');
  });

  test('simultaneous starts on one home produce exactly one owner', async (t) => {
    const { home, port } = await freshHome(t);
    const procs = Array.from({ length: 4 }, () => spawnEngine({ home }));
    t.after(async () => {
      for (const p of procs) {
        if (p.exitStatus() === null) p.child.kill('SIGKILL');
        await p.exited;
      }
    });
    const losers = await waitFor(() => {
      const done = procs.filter((p) => p.exitStatus() !== null);
      return done.length >= procs.length - 1 ? done : undefined;
    }, { what: 'all but one engine to exit' });
    assert.equal(losers.length, procs.length - 1, 'exactly one engine keeps running');
    for (const p of losers) {
      assert.equal(p.exitStatus().code, EXIT.locked, p.out.stderr);
      assert.match(p.out.stderr, /"code"\s*:\s*"engine_locked"/);
    }
    const winnerProc = procs.find((p) => p.exitStatus() === null);
    const winner = new Engine({ home, port, proc: winnerProc });
    await winner.waitUntil('full');
    const info = await winner.engineInfo();
    assert.equal(readLock(home).incarnation_id, info.incarnation);
    assert.equal(readLock(home).pid, winner.pid);
    assert.deepEqual(
      incarnations(home).map((r) => r.id),
      [info.incarnation],
    );
  });

  test('after the owner is killed, a restart takes over with a new incarnation and recovers before full mode', async (t) => {
    const { home, port, engine: first } = await engineFixture(t);
    const firstInc = (await first.engineInfo()).incarnation;
    await first.kill();
    assert.equal(readLock(home).incarnation_id, firstInc, 'a killed owner leaves its lock behind');

    const second = await startEngine({ home, port });
    t.after(() => second.kill());
    const info = await waitForFullStartup(second);
    assert.notEqual(info.incarnation, firstInc);
    assert.ok(hasIdForm(info.incarnation, 'inc_'));
    assert.ok(info.incarnation > firstInc, 'incarnation ids are time-ordered');
    assert.equal(readLock(home).incarnation_id, info.incarnation);
    assert.equal(readLock(home).pid, second.pid);
    assert.deepEqual(
      incarnations(home).map((r) => r.id),
      [firstInc, info.incarnation],
    );
    assert.deepEqual(info.startup.completed, STARTUP_STEPS, 'recovery and integrity precede full mode and the scheduler');
    assert.equal(info.startup.failed, null);
  });

  test('a lock naming a live process with a different start time is stale, and that process is not signalled', async (t) => {
    const { home, port } = await freshHome(t);
    const other = bystander(t);
    writeLock(home, { pid: other.pid, pid_start_time: '1' });

    const engine = await startEngine({ home, port });
    t.after(() => engine.kill());
    assert.equal(readLock(home).pid, engine.pid);
    assert.equal(readLock(home).incarnation_id, (await engine.engineInfo()).incarnation);
    assert.ok(isAlive(other.pid) && other.exitCode === null && other.signalCode === null, 'reused pid untouched');
  });

  test('a lock naming a live process identity is honoured', async (t) => {
    const { home } = await freshHome(t);
    const other = bystander(t);
    await waitFor(() => existsSync(`/proc/${other.pid}/stat`));
    const incarnation = newId('inc_');
    writeLock(home, { incarnation_id: incarnation, pid: other.pid, pid_start_time: procStartTime(other.pid) });
    const lockBytes = readFileSync(lockPath(home));

    const refused = await startRefused({ home });
    assert.equal(refused.code, EXIT.locked, refused.stderr);
    assert.equal(refused.refusal?.code, 'engine_locked');
    assert.equal(refused.refusal.subject?.incarnation_id, incarnation);
    assert.deepEqual(readFileSync(lockPath(home)), lockBytes);
    assert.equal(existsSync(storePath(home)), false, 'the store is not opened before the lock is held');
    assert.ok(isAlive(other.pid) && other.signalCode === null, 'the live owner is not signalled');
  });

  test('a lock written under a previous boot is stale', async (t) => {
    const { home, port } = await freshHome(t);
    const other = bystander(t);
    await waitFor(() => existsSync(`/proc/${other.pid}/stat`));
    writeLock(home, { pid: other.pid, pid_start_time: procStartTime(other.pid), host_boot_id: randomUUID() });

    const engine = await startEngine({ home, port });
    t.after(() => engine.kill());
    assert.equal(readLock(home).pid, engine.pid);
    assert.equal(readLock(home).host_boot_id, bootId());
    assert.ok(isAlive(other.pid) && other.signalCode === null, 'the unrelated process is not signalled');
  });
});
