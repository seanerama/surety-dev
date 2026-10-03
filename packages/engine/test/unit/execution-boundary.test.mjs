// Developer tests for the execution boundary's pure parts and its store
// rules (D2 §§2.3, 3.1 to 3.5, 1.6, A.3, A.4; rows M110 to M118): the scope's
// name, the verified hierarchy, the exit class's precedence, the mount plan's
// shape, the cgroup readers on ordinary directories, and the launch state's
// transitions in a scratch store. Nothing here needs the sandbox or the user
// manager; the acceptance rows run those.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const cgroup = await import(join(dist, 'boundary', 'cgroup.js'));
const { classifyExit } = await import(join(dist, 'boundary', 'terminate.js'));
const { buildPlan, hostMountPoints } = await import(join(dist, 'invoke', 'sandbox', 'mounts.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const boundary = await import(join(dist, 'store', 'transitions', 'boundary.js'));

const INC = 'inc_01J00000000000000000000000';
const DOM = 'dom_01J00000000000000000000001';

test('the scope is named for the home and the incarnation', () => {
  const unit = cgroup.scopeUnit('/srv/surety-home', INC);
  assert.match(unit, /^surety-[0-9a-f]{16}-inc_[0-9A-Z]{26}\.scope$/);
  assert.equal(unit, cgroup.scopeUnit('/srv/surety-home', INC), 'stable');
  assert.notEqual(cgroup.homeHash('/srv/a'), cgroup.homeHash('/srv/b'));
});

test('a domain path is inside the verified hierarchy only as its own scope directory', () => {
  const parent = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice';
  const home = '/srv/home-a';
  const scope = `${parent}/${cgroup.scopeUnit(home, INC)}`;
  const ok = cgroup.verifyDomainPath(`${scope}/${DOM}`, { parent, home, domain: DOM, incarnation: INC });
  assert.equal(ok.where, 'inside');
  const cases = [
    [`/tmp/${DOM}`, 'not under the parent'],
    [`${scope}/dom_01J00000000000000000000009`, 'another domain'],
    [`${parent}/${cgroup.scopeUnit('/srv/home-b', INC)}/${DOM}`, "another home's scope"],
    [`${parent}/${cgroup.scopeUnit(home, 'inc_01J00000000000000000000099')}/${DOM}`, "another incarnation's scope"],
    [`${parent}/other.scope/${DOM}`, 'not an engine scope'],
  ];
  for (const [path, what] of cases) assert.equal(cgroup.verifyDomainPath(path, { parent, home, domain: DOM, incarnation: INC }).where, 'outside', what);
});

test('the exit class follows D2 §1.6 precedence and keeps every fact', () => {
  const none = { oom_kill: 0, pids_max: 0 };
  const base = { termSent: false, killWritten: false, resources: none, cleanResult: true, cancelledBeforeExit: false };
  assert.equal(classifyExit({ ...base, report: { code: 0, signal: null } }).exit_class, 'clean');
  assert.equal(classifyExit({ ...base, report: { code: 0, signal: null }, cleanResult: false }).exit_class, 'error_exit');
  assert.equal(classifyExit({ ...base, report: { code: 2, signal: null } }).exit_class, 'error_exit');
  assert.equal(classifyExit({ ...base, report: null }).exit_class, 'unknown');
  assert.equal(classifyExit({ ...base, report: { code: null, signal: 9 }, resources: { oom_kill: 1, pids_max: 0 } }).exit_class, 'resource_limit');
  assert.equal(classifyExit({ ...base, report: { code: null, signal: 11 } }).exit_class, 'foreign_signal');
  // A cancellation the engine began before the exit wins over a counter rise.
  const signaled = classifyExit({ ...base, report: null, cancelledBeforeExit: true, termSent: true, killWritten: true, resources: { oom_kill: 3, pids_max: 0 } });
  assert.equal(signaled.exit_class, 'engine_signaled');
  assert.equal(signaled.exit_evidence.signal, 9);
  assert.equal(signaled.exit_evidence.signal_by_engine, true);
  assert.deepEqual(signaled.exit_evidence.resource_events, { oom_kill: 3, pids_max: 0 });
  // A counter rise that did not end the backend does not fail it.
  assert.equal(classifyExit({ ...base, report: { code: 0, signal: null }, resources: { oom_kill: 1, pids_max: 4 } }).exit_class, 'clean');
});

test('the mount plan binds around host submounts and gives /surety exactly its five entries', () => {
  const area = mkdtempSync(join(tmpdir(), 'plan-'));
  try {
    const tools = { mount: '/usr/bin/mount', umount: '/usr/bin/umount', pivot_root: '/usr/sbin/pivot_root', ip: '/usr/sbin/ip', unshare: '/usr/bin/unshare', setpriv: '/usr/bin/setpriv' };
    const plan = buildPlan({
      area,
      context: area,
      workspace: area,
      readPaths: [],
      writablePaths: [],
      volBytes: 1 << 20,
      volInodes: 64,
      shmBytes: 1 << 20,
      tools,
      node: process.execPath,
      initNodeCopy: process.execPath,
      initScript: process.execPath,
    });
    const targets = [...plan.fstab, ...plan.lateFstab].map((l) => l.split(' ')[1]);
    // No host submount under a permitted tree is a bind source or target.
    for (const m of hostMountPoints().filter((p) => ['/usr/', '/bin/', '/lib/', '/lib64/'].some((t) => p.startsWith(t)))) {
      assert.ok(!targets.includes(join(plan.stage, m)), `${m} is not bound`);
    }
    const surety = plan.skeleton.filter((e) => /^surety\/[^/]+$/.test(e.path)).map((e) => e.path.slice('surety/'.length));
    assert.deepEqual([...new Set(surety)].sort(), ['context', 'git', 'home', 'out', 'workspace']);
    // Device nodes only where they can be used; nothing else allows devices.
    for (const line of plan.fstab) {
      const [source, , , options] = line.split(' ');
      if (source.startsWith('/dev/')) assert.ok(!options.split(',').includes('nodev'), `${source} is usable`);
      else if (options.includes('bind')) assert.ok(options.split(',').includes('nodev'), `${source} is nodev`);
    }
    assert.ok(plan.fstab.some((l) => l.startsWith('proc ') && l.split(' ')[1] === join(plan.stage, 'proc')), 'a private /proc');
    assert.ok(plan.fstab.some((l) => l.startsWith('devpts ') && l.includes('newinstance')), 'a private devpts');
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
});

test('cgroup readers tell absent, unreadable and populated apart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-'));
  try {
    assert.deepEqual(cgroup.readPopulated(join(dir, 'gone')), { state: 'absent' });
    assert.equal(cgroup.readPopulated(dir).state, 'unreadable', 'a directory without cgroup.events is not a cgroup');
    writeFileSync(join(dir, 'cgroup.events'), 'populated 1\nfrozen 0\n');
    assert.deepEqual(cgroup.readPopulated(dir), { state: 'populated', value: 1 });
    writeFileSync(join(dir, 'cgroup.events'), 'populated 0\nfrozen 0\n');
    assert.deepEqual(cgroup.readPopulated(dir), { state: 'populated', value: 0 });
    writeFileSync(join(dir, 'cgroup.events'), 'garbage\n');
    assert.equal(cgroup.readPopulated(dir).state, 'unreadable');
    mkdirSync(join(dir, 'parent'));
    const scope = join(dir, 'parent', cgroup.scopeUnit('/h', INC));
    mkdirSync(scope);
    assert.deepEqual([...cgroup.homeScopes(join(dir, 'parent'), '/h').keys()], [INC]);
    assert.equal(cgroup.homeScopes(join(dir, 'missing'), '/h'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the launch state moves only along D2 A.4, and termination needs closure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-'));
  const db = new Database(join(dir, 'store.db'));
  try {
    db.pragma('foreign_keys = OFF');
    migrate(db, join(root, 'migrations'));
    setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: INC });
    const now = new Date().toISOString();
    db.prepare('INSERT INTO engine_incarnations (id, created_at, pid, started_at, host_boot_id) VALUES (?, ?, 1, ?, ?)').run(INC, now, now, 'boot');
    db.prepare(`INSERT INTO execution_domains (id, created_at, project, run, invocation, status, profile, launch_state) VALUES (?, ?, 'proj_x', 'run_x', 'inv_x', 'allocated', 'role', 'authorizable')`).run(DOM, now);
    const raw = (sql) => () => db.prepare(sql).run(DOM);
    assert.throws(raw(`UPDATE execution_domains SET launch_state = 'authorized' WHERE id = ?`), /SQLITE_CONSTRAINT|binding/, 'authorized names its binding');
    assert.throws(raw(`UPDATE execution_domains SET status = 'terminated' WHERE id = ?`), /closed/, 'not terminated before closure');
    assert.equal(transact(db, ENGINE_ACTOR, (tx) => boundary.closeLaunch(tx, { domain: DOM })), true);
    assert.equal(transact(db, ENGINE_ACTOR, (tx) => boundary.closeLaunch(tx, { domain: DOM })), false, 'closure is idempotent');
    assert.throws(raw(`UPDATE execution_domains SET launch_state = 'authorizable' WHERE id = ?`), /never reopened/);
    const granted = transact(db, ENGINE_ACTOR, (tx) => boundary.authorizeLaunch(tx, { domain: DOM, invocation: 'inv_x', incarnation: INC, generation: 1, pid: 1, startTime: '1' }));
    assert.deepEqual(granted, { granted: false, reason: 'the launch is closed' });
    db.prepare(`UPDATE execution_domains SET status = 'terminated' WHERE id = ?`).run(DOM);
    assert.throws(raw(`UPDATE execution_domains SET status = 'launched' WHERE id = ?`), /never repopulated/);
    const events = db.prepare(`SELECT type FROM events ORDER BY seq`).all().map((e) => e.type);
    assert.deepEqual(events, ['domain.launch_closed']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
