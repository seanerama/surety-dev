// Developer tests for the slice-15 review's findings (S1, S2 and minor items
// 1 to 9): an input's target is never made through a link; every
// materialized file is its blob's bytes whatever any attributes say;
// staging leftovers go at start; a quarantined execution keeps its tree; a
// link under the roots is an error under default inputs; a definitions
// directory that is not a directory is an error; the deadline and its
// disarming; a lapsed check lease is no verdict; an unknown orphans count or
// dropped-byte count stays unknown; recovery honours a prior incarnation
// that could not be closed; a due registration takes the version effective
// at registration.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { materialize, removeStagingLeftovers, checktreesDir, projectionOf } = await import(join(dist, 'checks', 'checktree.js'));
const { buildCheckPlan, inputTargetConflict } = await import(join(dist, 'checks', 'profile.js'));
const { discover } = await import(join(dist, 'checks', 'discovery.js'));
const { decideResult, armDeadline, Supervisor, recoverChecks } = await import(join(dist, 'checks', 'run.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { registerDue } = await import(join(dist, 'store', 'transitions', 'checks.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));

const PROJECT = `proj_${'0'.repeat(26)}`;
const VERSION = `pv_${'0'.repeat(26)}`;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-review-'));
  t.after(() => {
    execFileSync('chmod', ['-R', 'u+w', dir]);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function repoIn(dir) {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  const g = (...a) => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  const home = join(dir, 'home');
  mkdirSync(join(home, 'tmp'), { recursive: true });
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 24, home, incarnation: 'inc_unit' });
  const commit = (files, msg = 'c') => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      if (typeof content === 'object' && content.link) symlinkSync(content.link, join(repo, path));
      else writeFileSync(join(repo, path), content);
    }
    g('add', '-A');
    g('commit', '-qm', msg);
    return g('rev-parse', 'HEAD');
  };
  return { repo, home, g, commit };
}

const mat = (r, rev, manifest) =>
  materialize({ home: r.home, scratch: join(r.home, 'tmp'), repo: r.repo, project: PROJECT, revision: rev, version: VERSION, roots: ['.surety/checks/'], manifests: [manifest], maxEntries: 1000, maxBytes: 1 << 30 });

// ---- S1 ---------------------------------------------------------------------------------

test('S1: an input whose ancestor in the candidate source is a link or a file refuses the plan; otherwise its targets are made with no link followed', async (t) => {
  const r = repoIn(scratch(t));
  const victim = join(dirname(r.repo), 'victim');
  mkdirSync(victim);
  const protectedRev = r.commit({ '.surety/checks/expect.txt': 'protected\n' });
  const oid = r.g('rev-parse', `${protectedRev}:.surety/checks/expect.txt`);
  const manifest = [['.surety/checks/expect.txt', 'blob', '100644', oid]];
  r.g('rm', '-rq', '.surety');
  const linked = r.commit({ '.surety': { link: victim }, 'app.txt': 'app\n' });
  const tree = await mat(r, linked, manifest);
  assert.match(inputTargetConflict(tree.src, manifest), /\.surety as a symbolic link/);
  r.g('rm', '-q', '.surety');
  const file = r.commit({ '.surety': 'a file\n' });
  const t2 = await materialize({ home: r.home, scratch: join(r.home, 'tmp'), repo: r.repo, project: PROJECT, revision: file, version: VERSION, roots: ['.surety/checks/'], manifests: [manifest], maxEntries: 1000, maxBytes: 1 << 30 });
  assert.match(inputTargetConflict(t2.src, manifest), /not a directory/);
  r.g('rm', '-q', '.surety');
  const plain = r.commit({ 'src/x.txt': 'x\n' });
  const t3 = await materialize({ home: r.home, scratch: join(r.home, 'tmp'), repo: r.repo, project: PROJECT, revision: plain, version: VERSION, roots: ['.surety/checks/'], manifests: [manifest], maxEntries: 1000, maxBytes: 1 << 30 });
  assert.equal(inputTargetConflict(t3.src, manifest), null, 'control: a source with no .surety is fine');
  // The plan marks the input targets to be made without following links.
  const area = join(dirname(r.repo), 'area');
  mkdirSync(join(area, 'root'), { recursive: true });
  const plan = buildCheckPlan({
    area,
    source: t3.src,
    projection: projectionOf(t3, manifest),
    manifest,
    readPaths: [],
    volBytes: 1 << 20,
    volInodes: 1000,
    shmBytes: 1 << 20,
    tools: { mount: '/bin/mount', umount: '/bin/umount', pivot_root: '/sbin/pivot_root', ip: '/sbin/ip', unshare: '/usr/bin/unshare', setpriv: '/usr/bin/setpriv', mknod: '/bin/mknod' },
    node: process.execPath,
    initNodeCopy: process.execPath,
    initScript: join(dist, 'invoke', 'domain-init.js'),
  });
  const targets = plan.late.filter((e) => e.path.startsWith('surety/workspace/'));
  assert.ok(targets.length > 0 && targets.every((e) => e.nofollow === true), `every input target is made without following links (${JSON.stringify(targets)})`);
  assert.deepEqual(fs.readdirSync(victim), [], 'nothing was written where the link pointed');
});

// The domain init's maker of such an entry, taken from the built init (which
// exits unless it is process 1, so it cannot be imported) and run against a
// scratch root where a link stands at an ancestor.
test("S1: the init's no-follow maker refuses a link at any component and creates nothing outside its root", (t) => {
  const dir = scratch(t);
  const text = readFileSync(join(dist, 'invoke', 'domain-init.js'), 'utf8');
  const body = text.slice(text.indexOf('function makeNoFollow('), text.indexOf('function make(root, e)'));
  const makeNoFollow = new Function('join', 'lstatSync', 'mkdirSync', 'closeSync', 'openSync', 'fsConstants', `${body}; return makeNoFollow;`)(join, fs.lstatSync, fs.mkdirSync, fs.closeSync, fs.openSync, fs.constants);
  const rootDir = join(dir, 'root');
  const outside = join(dir, 'outside');
  mkdirSync(join(rootDir, 'ws'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(rootDir, 'ws', '.surety'));
  assert.throws(() => makeNoFollow(rootDir, { path: 'ws/.surety/checks/expect.txt', kind: 'file', nofollow: true }), /not a directory/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was created through the link');
  writeFileSync(join(rootDir, 'ws', 'taken'), 'x');
  assert.throws(() => makeNoFollow(rootDir, { path: 'ws/taken', kind: 'file', nofollow: true }), /exists already/);
  symlinkSync(join(outside, 'target'), join(rootDir, 'ws', 'dangling'));
  assert.throws(() => makeNoFollow(rootDir, { path: 'ws/dangling', kind: 'file', nofollow: true }));
  assert.equal(existsSync(join(outside, 'target')), false, 'a dangling link at the target is not followed');
  makeNoFollow(rootDir, { path: 'ws/a/b/c.txt', kind: 'file', nofollow: true });
  assert.ok(fs.lstatSync(join(rootDir, 'ws/a/b/c.txt')).isFile());
});

// ---- S2 ---------------------------------------------------------------------------------

test('S2: every materialized file is its blob byte for byte, whatever a work-tree, info, committed attributes file or core.autocrlf says', async (t) => {
  const r = repoIn(scratch(t));
  const content = 'line1\nline2\n$Id$\r\nlast\n';
  const rev = r.commit({ '.gitattributes': '* text eol=crlf ident\n', 'src/a.txt': content, '.surety/checks/expect.txt': content });
  writeFileSync(join(r.repo, '.gitattributes'), '* text eol=crlf ident working-tree-encoding=UTF-16\n');
  mkdirSync(join(r.repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(r.repo, '.git', 'info', 'attributes'), '*.txt text eol=crlf ident\n');
  r.g('config', 'core.autocrlf', 'true');
  r.g('config', 'core.eol', 'crlf');
  const oid = r.g('rev-parse', `${rev}:.surety/checks/expect.txt`);
  const manifest = [['.surety/checks/expect.txt', 'blob', '100644', oid]];
  const tree = await mat(r, rev, manifest);
  const blob = (path) => execFileSync('git', ['cat-file', 'blob', `${rev}:${path}`], { cwd: r.repo });
  assert.deepEqual(readFileSync(join(tree.src, 'src/a.txt')), blob('src/a.txt'));
  assert.deepEqual(readFileSync(join(tree.src, '.gitattributes')), blob('.gitattributes'));
  assert.deepEqual(readFileSync(join(projectionOf(tree, manifest), '.surety/checks/expect.txt')), blob('.surety/checks/expect.txt'));
});

// ---- minor items ------------------------------------------------------------------------------

test('1: a staging directory left by a stopped build is removed at start; a finished tree is not', async (t) => {
  const r = repoIn(scratch(t));
  const rev = r.commit({ 'src/a.txt': 'a\n' });
  const tree = await mat(r, rev, []);
  const leftover = join(checktreesDir(r.home), PROJECT, '.staging-0123456789abcdef');
  mkdirSync(join(leftover, 'src'), { recursive: true });
  writeFileSync(join(leftover, 'src', 'x'), 'x');
  assert.equal(removeStagingLeftovers(r.home), 1);
  assert.equal(existsSync(leftover), false);
  assert.ok(existsSync(tree.src));
});

test('2: a quarantined execution whose domain is still unknown at a re-observation keeps every check tree', async (t) => {
  const r = repoIn(scratch(t));
  const rev = r.commit({ 'src/a.txt': 'a\n' });
  const tree = await mat(r, rev, []);
  const calls = [];
  const rt = {
    home: r.home,
    scope: null,
    incarnation: 'inc_unit',
    setting: () => 1,
    read: async (name) => {
      calls.push(name);
      if (name === 'domain.row') return { id: 'dom_x', status: 'quarantined', cgroup_path: '/sys/fs/cgroup/x', cgroup_inode: 1, launch_binding: null };
      return null;
    },
    engine: async (name) => (calls.push(name), null),
  };
  const s = new Supervisor(rt, { execution: 'cx_1', project: PROJECT, domain: 'dom_x', governed: null, definition: {}, revision: rev, version: VERSION });
  s.quarantined = true;
  assert.equal(await s.reobserve(), false, 'still unknown: not collected');
  assert.ok(!calls.includes('checks.tree_in_use') && existsSync(tree.src), 'and its tree is kept');
});

test('3 and 4: a link or submodule under the roots is input_not_regular under default inputs; a definitions directory that is a link or a file is an error', async (t) => {
  const r = repoIn(scratch(t));
  const smoke = JSON.stringify({ schema: 1, key: 's', kind: 'smoke', command: ['probe'], timeout_s: 5, gate_kinds: ['stage'] });
  const rev = r.commit({
    '.surety/checks/protected-policy.json': JSON.stringify({ check_commands: { probe: { path: '/usr/bin/true' } } }),
    '.surety/checks/defs/s.json': smoke,
    '.surety/checks/lib/real.js': 'x\n',
    '.surety/checks/lib/link.js': { link: 'real.js' },
  });
  const d = await discover(r.repo, rev);
  assert.deepEqual(d.errors, [{ path: '.surety/checks/lib/link.js', code: 'input_not_regular' }]);
  assert.deepEqual(d.checks.map((c) => c.key), ['s'], 'the definition is still discovered, nothing dropped silently');
  r.g('rm', '-rq', '.surety/checks/defs');
  mkdirSync(join(r.repo, 'elsewhere'));
  writeFileSync(join(r.repo, 'elsewhere', 's.json'), smoke);
  const linked = r.commit({ '.surety/checks/defs': { link: '../../elsewhere' } });
  const d2 = await discover(r.repo, linked);
  assert.deepEqual([d2.checks.length, d2.errors.filter((e) => e.code === 'not_regular_file').map((e) => e.path)], [0, ['.surety/checks/defs/']]);
  r.g('rm', '-q', '.surety/checks/defs');
  const asFile = r.commit({ '.surety/checks/defs': 'not a directory\n' });
  assert.deepEqual((await discover(r.repo, asFile)).errors.filter((e) => e.code === 'not_regular_file').map((e) => e.path), ['.surety/checks/defs/']);
});

test('5: the deadline fires only while the check has not exited by itself; an in-time exit is never deadline_hit', async () => {
  let fired = 0;
  const exited = { v: false };
  armDeadline(20, () => exited.v, () => fired++);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fired, 1);
  exited.v = true;
  armDeadline(20, () => exited.v, () => fired++);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fired, 1, 'disarmed by the exit');
  const base = { leaseLost: false, authorized: true, started: true, execFailed: false, orphans: false };
  const inTime = decideResult({ ...base, report: { code: 0, signal: null }, cancelAt: null, cancelCause: null, reportAt: 10 });
  assert.deepEqual([inTime.fields.exit_status, inTime.fields.deadline_hit, inTime.fields.signaled], [0, false, false]);
  const late = decideResult({ ...base, report: { code: 0, signal: null }, cancelAt: 10, cancelCause: 'deadline', reportAt: 20 });
  assert.deepEqual([late.fields.exit_status, late.fields.deadline_hit, late.fields.signaled], [null, true, true], 'an exit after the engine cancelled is never the exit status');
  const before = decideResult({ ...base, report: { code: 0, signal: null }, cancelAt: 30, cancelCause: 'deadline', reportAt: 20 });
  assert.deepEqual([before.fields.exit_status, before.fields.deadline_hit], [0, false]);
});

test('6: a lapsed check lease is no verdict: the execution ends interrupted, never failed or passed', () => {
  const r = decideResult({ leaseLost: true, authorized: true, started: true, execFailed: false, report: { code: 0, signal: null }, cancelAt: 5, cancelCause: 'lease', reportAt: 1, orphans: false });
  assert.equal(r.kind, 'interrupt');
});

test('7: an orphans count not reported or unreadable is unknown and recorded so', () => {
  const r = decideResult({ leaseLost: false, authorized: true, started: true, execFailed: false, report: { code: 0, signal: null }, cancelAt: null, cancelCause: null, reportAt: 1, orphans: null });
  assert.equal(r.fields.orphans, null);
});

test('8: recovery leaves an execution quarantined when its domain belongs to a prior incarnation that could not be closed', async () => {
  const calls = [];
  const rt = {
    home: '/nonexistent',
    scope: null,
    incarnation: 'inc_now',
    setting: () => 1,
    read: async (name) => {
      if (name === 'checks.live') return [{ id: 'cx_1', domain: 'dom_1' }];
      if (name === 'domain.row') return { id: 'dom_1', status: 'launched', cgroup_path: '/sys/fs/cgroup/x/dom_1', cgroup_inode: 7, launch_binding: '{}' };
      if (name === 'checks.domain_owner') return { incarnation: 'inc_old' };
      return null;
    },
    engine: async (name, args) => (calls.push([name, args]), null),
  };
  await recoverChecks(rt, new Map([['inc_old', 'the prior supervisor leaf cannot be killed']]));
  const names = calls.map(([n]) => n);
  assert.ok(names.includes('checks.quarantine') && !names.includes('checks.interrupt'), `quarantined, never interrupted (${names.join(', ')})`);
  assert.equal(calls.find(([n]) => n === 'checks.quarantine')[1].why, 'the prior supervisor leaf cannot be killed');
});

test('9: a due registration is made under the version effective when it is made, not the one stored with the due mark', (t) => {
  const dir = scratch(t);
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });
  const AT = '2026-10-07T00:00:00.000Z';
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  for (const [id, seq, superseded] of [
    ['pv_old', 1, 'pv_new'],
    ['pv_new', 2, null],
  ]) {
    run(
      `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, superseded_by, roots)
       VALUES (?, ?, 'prj_1', ?, 'f', 'initial', 'h', 'human', ?, 1, ?, ?, '[]')`,
      id,
      AT,
      seq,
      AT,
      AT,
      superseded,
    );
    run(
      `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class)
       VALUES (?, ?, 'prj_1', 'smoke', ?, 'smoke', 1, '["alpha_authorize"]', 'p', 'h', 'direct')`,
      `chk_${id}`,
      AT,
      id,
    );
  }
  run(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress, checks_due)
     VALUES ('cand_1', ?, 'prj_1', 1, ?, 'lin_1', ?, 'engine_cadence', 'developing', ?)`,
    AT,
    'a'.repeat(40),
    AT,
    JSON.stringify([{ trigger: { source: 'nomination', id: 'cand_1', generation: 1 }, version: 'pv_old', at: AT }]),
  );
  assert.equal(
    transact(db, ENGINE_ACTOR, (tx) => registerDue(tx, { project: 'prj_1' })),
    1,
  );
  const rows = db.prepare('SELECT "protected_version", "check" FROM "check_executions"').all();
  assert.deepEqual(rows, [{ protected_version: 'pv_new', check: 'chk_pv_new' }]);
  assert.equal(db.prepare('SELECT "checks_due" FROM "candidates"').get().checks_due, null);
});
