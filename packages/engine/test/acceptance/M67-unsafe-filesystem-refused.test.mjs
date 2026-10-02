// M67, the engine home's filesystem (slice 6). E36 item 7, which settles E32
// item 2 and the open item this row carried since slice 1 (COVERAGE.md); D1
// §6.1 ("an engine home on a filesystem that does not [honour fsync] is
// refused at startup"); SEAM.md §88.
//
// The case belongs to this row because the row is where durability is
// pinned: M67's power-loss cases show that the engine syncs what it must, and
// say nothing about the storage underneath. No process can observe that a
// device honours a sync. What the engine can do is refuse a home on a kind of
// filesystem known not to keep what is written to it, or not to give sync
// guarantees: memory-backed, network and user-space filesystems, a Windows
// drive seen from inside WSL among them. Any other kind starts normally.
//
// How the engine is made to see such a kind without privilege:
//   - memory-backed, for real: a home under /dev/shm, which is a tmpfs any
//     user can write to. That start has no harness flag at all: it is the
//     engine's own detection that is tested;
//   - the other kinds cannot be mounted without privilege, so for them the
//     harness says what kind the home is on (--harness-home-fstype). The
//     flag replaces the detection, not the judgement: which kinds are refused
//     is still the engine's own table. The expected table is
//     contract/filesystems.json.
// A pass says nothing about this host's storage; the M1 report must say so.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { freePort, makeTempDir, removeDir, snapshotDir, startEngine, startRefused, writeEngineConfig } from './harness/engine.mjs';
import { FILESYSTEMS, filesystemOf } from './harness/filesystem.mjs';

const REFUSED_NAMES = FILESYSTEMS.refused.map((kind) => kind.name);
const SHM = '/dev/shm';

// A refused start: status 6, one refusal line that names the kind, and
// nothing written under the home.
function assertRefusedForFilesystem(result, { home, before, name, what }) {
  assert.equal(result.code, FILESYSTEMS.refusal.exit_status, `${what}: exit status (signal: ${result.signal}; stderr: ${result.stderr.slice(-600)})`);
  assert.equal(result.refusal?.code, FILESYSTEMS.refusal.code, `${what}: refusal code (stderr: ${result.stderr.slice(-600)})`);
  assert.deepEqual([result.refusal.subject?.path, result.refusal.subject?.filesystem], ['.', name], `${what}: the refusal names the home and the kind of filesystem it is on`);
  assert.ok(typeof result.refusal.reason === 'string' && result.refusal.reason.includes(name.split('.')[0]), `${what}: the reason says which kind it found (${result.refusal.reason})`);
  assert.ok(typeof result.refusal.what_to_do === 'string' && result.refusal.what_to_do.length > 0, `${what}: the refusal says what to do`);
  assert.doesNotMatch(result.stderr, /^\s+at .+:\d+:\d+\)?$/m, `${what}: no stack trace`);
  assert.deepEqual(snapshotDir(home), before, `${what}: nothing was written under the engine home`);
  assert.equal(existsSync(join(home, 'engine.lock')), false, `${what}: no lock was taken`);
}

async function freshHome(t, parent = null) {
  const home = parent === null ? makeTempDir('fs-home') : mkdtempSync(join(parent, 'surety-acc-fs-home-'));
  t.after(() => (parent === null ? removeDir(home) : rmSync(home, { recursive: true, force: true })));
  const port = await freePort();
  writeEngineConfig(home, { api_port: port });
  return { home, port };
}

describe('M67 an engine home on an unsafe kind of filesystem', () => {
  test('a home on a memory-backed filesystem is refused by the engine as it is started outside any test mode, before anything is written', async (t) => {
    assert.equal(filesystemOf(SHM), 'tmpfs', `this case needs ${SHM} to be a tmpfs, which it is on the hosts M1 is qualified on; without it the memory-backed lane is missing, and a missing lane is not a pass`);
    const { home } = await freshHome(t, SHM);
    assert.equal(filesystemOf(home), 'tmpfs', 'the fixture is live: the home is on a tmpfs');
    const before = snapshotDir(home);
    const result = await startRefused({ home, harness: false, timeoutMs: 10_000 });
    assertRefusedForFilesystem(result, { home, before, name: 'tmpfs', what: `a home under ${SHM}` });
  });

  test('network and user-space filesystems are refused the same way, a Windows drive seen from inside WSL among them', async (t) => {
    const { home } = await freshHome(t);
    const before = snapshotDir(home);
    for (const kind of FILESYSTEMS.refused) {
      const result = await startRefused({ home, args: ['--harness-home-fstype', kind.name], timeoutMs: 10_000 });
      assertRefusedForFilesystem(result, { home, before, name: kind.name, what: `a home on ${kind.name} (${kind.class})` });
    }
  });

  test('any other kind starts normally: the kinds the tests themselves run on, and a kind nobody has heard of', async (t) => {
    const { home, port } = await freshHome(t);
    const real = filesystemOf(home);
    assert.equal(REFUSED_NAMES.includes(real.split('.')[0]) || REFUSED_NAMES.includes(real), false, `the tests' own temporary directory (${tmpdir()}) is on ${real}, a kind the engine refuses: set TMPDIR to a directory on a disk filesystem (E36 item 7)`);
    const engines = [];
    t.after(async () => {
      for (const engine of engines) await engine.kill();
    });
    // As it is, with nothing said about the filesystem.
    const plain = await startEngine({ home, port, harness: false });
    engines.push(plain);
    assert.equal((await plain.get('/v1/health')).body?.mode, 'full', `a home on ${real} starts`);
    await plain.stop();
    for (const name of FILESYSTEMS.accepted) {
      const engine = await startEngine({ home, port, args: ['--harness-home-fstype', name] });
      engines.push(engine);
      assert.equal((await engine.get('/v1/health')).body?.mode, 'full', `a home on ${name} starts`);
      await engine.stop();
    }
  });
});
