// Developer tests for slice 13's guards and collection (D2 §§1.4, 2.5, 3.7,
// 4.3, A.6 P20; E64 item 2; E69): the limits read back before a launch, the
// volatile filesystem's bounds read back, the exhaustion instruments'
// ceilings, and collection from a hold that never follows a link or opens a
// special file. Nothing here forks to a limit, allocates to one or fills a
// filesystem (E69 item 4): only pure functions and tiny calls on ordinary
// directories.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const cgroup = await import(join(dist, 'boundary', 'cgroup.js'));
const { volatileBoundsWrong } = await import(join(dist, 'invoke', 'sandbox', 'volatile.js'));
const program = await import(join(dist, 'invoke', 'probes', 'program.js'));
const collect = await import(join(dist, 'invoke', 'collect.js'));
const redact = await import(join(dist, 'records', 'redact.js'));

const scratch = () => mkdtempSync(join(tmpdir(), 'limits-'));

test('a domain is never made outside an engine scope, and its limits are read back as written', () => {
  // The guard refuses before anything is made.
  assert.throws(() => cgroup.createDomainCgroup('/sys/fs/cgroup/user.slice', { memoryMax: 1 << 26, tasksMax: 64 }), /not inside an engine scope/);
  assert.throws(() => cgroup.createDomainCgroup('', { memoryMax: 1 << 26, tasksMax: 64 }), /not inside an engine scope/);
  // The read-back on ordinary files standing for a cgroup's.
  const dir = scratch();
  try {
    const write = (mem, swap, pids) => {
      writeFileSync(join(dir, 'memory.max'), `${mem}\n`);
      writeFileSync(join(dir, 'memory.swap.max'), `${swap}\n`);
      writeFileSync(join(dir, 'pids.max'), `${pids}\n`);
    };
    const limits = { memoryMax: 64 * 1024 * 1024, tasksMax: 64 };
    write(64 * 1024 * 1024, 0, 64);
    assert.equal(cgroup.verifyLimits(dir, limits), null);
    // The kernel keeps whole pages: a size rounded down to a page reads back.
    assert.equal(cgroup.verifyLimits(dir, { memoryMax: 64 * 1024 * 1024 + 100, tasksMax: 64 }), null);
    write('max', 0, 64);
    assert.match(cgroup.verifyLimits(dir, limits), /memory\.max reads max/);
    write(64 * 1024 * 1024, 'max', 64);
    assert.match(cgroup.verifyLimits(dir, limits), /memory\.swap\.max reads max/);
    write(64 * 1024 * 1024, 0, 'max');
    assert.match(cgroup.verifyLimits(dir, limits), /pids\.max reads max/);
    rmSync(join(dir, 'pids.max'));
    assert.match(cgroup.verifyLimits(dir, limits), /pids\.max reads unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a filesystem that is not the plan's bounded tmpfs is refused by its bounds", () => {
  const dir = scratch();
  try {
    assert.match(volatileBoundsWrong(dir, { bytes: 1024 * 1024, inodes: 64 }), /holds \d+ (bytes|inodes)/);
    assert.match(volatileBoundsWrong(join(dir, 'absent'), { bytes: 1024 * 1024, inodes: 64 }), /cannot be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the exhaustion instruments stop at fixed ceilings whatever the limit (E69)', () => {
  assert.equal(program.PIDS_LIMIT_MAX, 64);
  assert.equal(program.PIDS_CEILING, 96);
  assert.equal(program.MEMORY_LIMIT_MAX, 64 * 1024 * 1024);
  assert.equal(program.MEMORY_CEILING, 128 * 1024 * 1024);
  for (const limit of [1, 16, 64, 1000, 1e9]) assert.ok(program.forkCeiling(limit) <= 96 && program.forkCeiling(limit) > Math.min(limit, 64) - 1, `fork ceiling for ${limit}`);
  assert.equal(program.forkCeiling(64), 96);
  for (const limit of [1, 64 * 1024 * 1024, 2 ** 40]) assert.ok(program.allocationCeiling(limit) <= 128 * 1024 * 1024, `allocation ceiling for ${limit}`);
  assert.equal(program.allocationCeiling(64 * 1024 * 1024), 128 * 1024 * 1024);
});

test('the exhaustion instruments refuse outside a sandbox: the guard alone, nothing acted', () => {
  // The program's own containment reads, on this host, refuse: the host's
  // pid namespace is named, pid 1 is not the domain init.
  const own = spawnSync('readlink', ['/proc/self/ns/pid'], { encoding: 'utf8' }).stdout.trim();
  const g = program.containment(own);
  assert.ok(g.reasons.length > 0, 'refused on the host');
  assert.ok(program.containment(undefined).reasons.some((r) => /no host pid namespace/.test(r)));
});

// A hold standing for the engine's (sandbox/volatile.ts) over an ordinary
// directory laid out as the volatile filesystem is.
function fakeHold() {
  const vol = scratch();
  for (const d of ['home', 'out', 'tmp', 'upper', 'gitobj/upper']) mkdirSync(join(vol, d), { recursive: true });
  return { vol, held: true, merged: null };
}

const BOUNDS = { resultMaxBytes: 64, entriesMax: 100, filesMaxBytes: 1 << 20, deadlineMs: 5000 };

test('the result is read only as a regular file within its bound; a link, a FIFO and an oversize file are refused unopened', () => {
  const h = fakeHold();
  try {
    assert.equal(collect.collectResult(h, BOUNDS).state, 'absent');
    assert.equal(collect.collectResult(null, BOUNDS).state, 'not_held');
    writeFileSync(join(h.vol, 'out', 'result.json'), '{"status":"completed","summary":"s"}');
    const r = collect.collectResult(h, BOUNDS);
    assert.equal(r.state, 'read');
    rmSync(join(h.vol, 'out', 'result.json'));
    symlinkSync('/dev/zero', join(h.vol, 'out', 'result.json'));
    assert.deepEqual([collect.collectResult(h, BOUNDS).state, collect.collectResult(h, BOUNDS).reason], ['refused', 'link']);
    rmSync(join(h.vol, 'out', 'result.json'));
    assert.equal(spawnSync('mkfifo', [join(h.vol, 'out', 'result.json')]).status, 0);
    const started = Date.now();
    assert.deepEqual([collect.collectResult(h, BOUNDS).state, collect.collectResult(h, BOUNDS).reason], ['refused', 'fifo']);
    assert.ok(Date.now() - started < 1000, 'a FIFO is never opened, so nothing waits on a writer');
    rmSync(join(h.vol, 'out', 'result.json'));
    writeFileSync(join(h.vol, 'out', 'result.json'), 'x'.repeat(65));
    assert.deepEqual([collect.collectResult(h, BOUNDS).state, collect.collectResult(h, BOUNDS).reason], ['refused', 'oversize']);
  } finally {
    rmSync(h.vol, { recursive: true, force: true });
  }
});

test('the inventory lists every writable location without following links or opening special files, excludes credential files, and stops at its bounds', () => {
  const h = fakeHold();
  try {
    writeFileSync(join(h.vol, 'home', 'settings.json'), '{"a":1}');
    writeFileSync(join(h.vol, 'home', '.credentials.json'), 'never read');
    symlinkSync('/etc/passwd', join(h.vol, 'home', 'link'));
    assert.equal(spawnSync('mkfifo', [join(h.vol, 'tmp', 'pipe')]).status, 0);
    writeFileSync(join(h.vol, 'upper', 'src.txt'), 'workspace');
    const inv = collect.inventory(h, BOUNDS, ['--no-session-persistence']);
    const by = Object.fromEntries(inv.entries.map((e) => [e.path, e]));
    assert.equal(by['/surety/home/settings.json'].content, '{"a":1}');
    assert.equal(by['/surety/home/link'].kind, 'link');
    assert.equal(by['/surety/home/link'].target, '/etc/passwd');
    assert.equal(by['/surety/home/link'].content, undefined, "a link's target is never duplicated");
    assert.equal(by['/tmp/pipe'].kind, 'fifo');
    assert.equal(by['/surety/home/.credentials.json'].retained, false);
    assert.equal(by['/surety/home/.credentials.json'].content, undefined);
    assert.deepEqual(inv.excluded, [{ path: '/surety/home/.credentials.json', reason: 'credential_name' }]);
    assert.equal(by['/surety/workspace/src.txt'].retained, false, "the workspace's changes are materialized, not retained here");
    assert.equal(inv.truncated, null);
    assert.equal(inv.secret, null);
    assert.deepEqual(collect.inventory(h, { ...BOUNDS, entriesMax: 2 }, []).truncated, { limit: 'collect_entries_max', value: 2 });
    assert.deepEqual(collect.inventory(h, { ...BOUNDS, filesMaxBytes: 3 }, []).truncated, { limit: 'provider_files_max_bytes', value: 3 });
    const record = JSON.parse(collect.inventoryRecord(inv, { domain: 'd', run: 'r', invocation: 'i' }).toString());
    assert.deepEqual(Object.keys(record).filter((k) => ['locations', 'persistence_flags', 'excluded'].includes(k)).sort(), ['excluded', 'locations', 'persistence_flags']);
    assert.equal(record.complete, true);
  } finally {
    rmSync(h.vol, { recursive: true, force: true });
  }
});

test('the screen finds a held secret in a collected file, in a name, and in a result', () => {
  const h = fakeHold();
  try {
    redact.holdSecret('test/unit/key', 'sk-unit-secret-0123456789');
    writeFileSync(join(h.vol, 'home', 'notes.txt'), 'the key is sk-unit-secret-0123456789');
    assert.equal(collect.inventory(h, BOUNDS, []).secret.path, '/surety/home/notes.txt');
    rmSync(join(h.vol, 'home', 'notes.txt'));
    writeFileSync(join(h.vol, 'tmp', 'sk-unit-secret-0123456789'), '');
    assert.ok(collect.inventory(h, BOUNDS, []).secret !== null, 'a name is screened');
    writeFileSync(join(h.vol, 'out', 'result.json'), '{"k":"sk-unit-secret-0123456789"}');
    assert.equal(collect.collectResult(h, { ...BOUNDS, resultMaxBytes: 1024 }).state, 'secret');
  } finally {
    rmSync(h.vol, { recursive: true, force: true });
  }
});

test('credential names', () => {
  for (const n of ['.credentials.json', 'auth.json', '.netrc', 'id_ed25519', 'server.pem', 'api_key.txt', 'oauth_token']) assert.ok(collect.isCredentialName(n), n);
  for (const n of ['settings.json', 'notes.txt', 'result.json']) assert.ok(!collect.isCredentialName(n), n);
});
