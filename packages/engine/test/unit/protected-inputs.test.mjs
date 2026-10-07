// Developer tests for M3 slice 17, "the protected inputs" (D3 §§1.3, 1.5,
// 2.2, 2.4; L6, B01; Q11; E95; SEAM.md §§195 to 202): the fingerprint over
// the [path, type, mode, object id] manifest and the mode-free form it
// replaces; the Q11 recomputation and its refusals; the migration's columns
// and backfill; the gate comparing no fingerprint across schemes; the
// immutable input namespace in the check plan; the check tree's modes,
// projections and the bound for all trees.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { configureGit, repoContext } = await import(join(dist, 'git', 'exec.js'));
const { protectedManifest, fingerprintOf, legacyFingerprintOf, protectedSetAt } = await import(join(dist, 'protected', 'set.js'));
const { recompute } = await import(join(dist, 'protected', 'migrate.js'));
const { materialize, projectionOf, checktreesDir, checktreeBytesInUse, releaseTree } = await import(join(dist, 'checks', 'checktree.js'));
const { buildCheckPlan, inputMountConflict, inputTops } = await import(join(dist, 'checks', 'profile.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { fingerprintsToRecompute, recordRecomputedFingerprint } = await import(join(dist, 'store', 'transitions', 'protected.js'));

const PROJECT = `proj_${'0'.repeat(26)}`;
const VERSION = `pv_${'2'.repeat(26)}`;
const AT = '2026-10-07T00:00:00.000Z';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-s17-'));
  t.after(() => {
    execFileSync('chmod', ['-R', 'u+w', dir]);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// A repository whose commits are made with plumbing, so a symlink and an
// executable bit can be given a chosen blob.
function repoIn(dir) {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  const g = (args, input) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', input }).trim();
  g(['init', '-q', '-b', 'main']);
  const home = join(dir, 'home');
  mkdirSync(join(home, 'tmp'), { recursive: true });
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 24, home, incarnation: 'inc_unit' });
  const index = join(repo, '.git', 'unit-index');
  // entries: {path: string | {content, mode} | {link}}
  const commit = (entries) => {
    const ienv = { ...env, GIT_INDEX_FILE: index };
    rmSync(index, { force: true });
    for (const [path, v] of Object.entries(entries)) {
      const content = typeof v === 'string' ? v : (v.content ?? v.link);
      const mode = typeof v === 'string' ? '100644' : v.link !== undefined ? '120000' : v.mode;
      const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env, encoding: 'utf8', input: content }).trim();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`], { cwd: repo, env: ienv });
    }
    const tree = execFileSync('git', ['write-tree'], { cwd: repo, env: ienv, encoding: 'utf8' }).trim();
    return g(['commit-tree', tree, '-m', 'c']);
  };
  return { repo, home, g, commit };
}

const ROOTS = ['.surety/checks/'];

// ---- the fingerprint (L6) ------------------------------------------------------------------

test('L6: type and mode are identity; the mode-free form cannot tell a regular file, its executable twin and a symlink apart', async (t) => {
  const r = repoIn(scratch(t));
  const base = { '.surety/checks/protected-policy.json': '{}', 'src/a.js': 'a\n' };
  const regular = r.commit({ ...base, '.surety/checks/x': 'target' });
  const exec = r.commit({ ...base, '.surety/checks/x': { content: 'target', mode: '100755' } });
  const link = r.commit({ ...base, '.surety/checks/x': { link: 'target' } });
  const ctx = repoContext(r.repo);
  const manifests = await Promise.all([regular, exec, link].map((rev) => protectedManifest(ctx, rev, ROOTS)));
  assert.deepEqual(manifests[0].map(([p]) => p), ['.surety/checks/protected-policy.json', '.surety/checks/x'], 'the governed file and the roots, sorted; no source');
  assert.deepEqual(manifests.map((m) => m[1].slice(1, 3)), [['blob', '100644'], ['blob', '100755'], ['blob', '120000']]);
  assert.equal(new Set(manifests.map(legacyFingerprintOf)).size, 1, 'the mode-free form is one value for all three');
  assert.equal(new Set(manifests.map(fingerprintOf)).size, 3, 'over the manifest, three');
  assert.equal((await protectedSetAt(r.repo, exec, ROOTS)).fingerprint, fingerprintOf(manifests[1]), 'a version records the manifest fingerprint');
  assert.equal(await protectedManifest(ctx, '0'.repeat(40), ROOTS), null, 'an unreadable tree is null, never empty');
});

test('Q11: a version is recomputed from its authorized revision only when the recorded mode-free value is that tree\'s; otherwise it is unreadable', async (t) => {
  const r = repoIn(scratch(t));
  const rev = r.commit({ '.surety/checks/protected-policy.json': '{}', '.surety/checks/x': 'x\n' });
  const manifest = await protectedManifest(repoContext(r.repo), rev, ROOTS);
  const v = { id: 'pv_1', project: 'p', repo: r.repo, roots: ROOTS, fingerprint: legacyFingerprintOf(manifest), scheme: 'pairs', revision: rev };
  assert.deepEqual(await recompute(v), { fingerprint: fingerprintOf(manifest), why: null });
  assert.equal((await recompute({ ...v, revision: null })).fingerprint, null, 'no recorded revision: no guessing');
  assert.equal((await recompute({ ...v, revision: '0'.repeat(40) })).fingerprint, null, 'an unreadable tree');
  assert.match((await recompute({ ...v, fingerprint: 'f'.repeat(64) })).why, /not that of/, 'a revision whose set is not the recorded one is never adopted');
  assert.equal((await recompute({ ...v, scheme: 'unreadable' })).fingerprint, fingerprintOf(manifest), 'an unreadable version is retried at the next start');
});

// ---- the migration's columns, the recording, and the gate ---------------------------------

function store(t) {
  const dir = scratch(t);
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  db.prepare(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
  ).run(AT);
  return db;
}

test('migration 0013: a version written without the new columns is mode-free and has no authorized revision; recording moves it once, and a manifest version is never touched', (t) => {
  const db = store(t);
  db.prepare(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots)
     VALUES ('pv_old', ?, 'prj_1', 1, 'legacy', 'initial', 'human', 'human', ?, 1, ?, '[".surety/checks/"]')`,
  ).run(AT, AT, AT);
  const row = () => db.prepare('SELECT fingerprint, fingerprint_scheme, authorized_revision FROM protected_versions WHERE id = ?').get('pv_old');
  assert.deepEqual(row(), { fingerprint: 'legacy', fingerprint_scheme: 'pairs', authorized_revision: null });
  assert.deepEqual(fingerprintsToRecompute(db).map((v) => [v.id, v.scheme, v.revision, v.repo]), [['pv_old', 'pairs', null, '/nowhere']]);
  transact(db, ENGINE_ACTOR, (tx) => recordRecomputedFingerprint(tx, { version: 'pv_old', fingerprint: null, why: 'no revision' }));
  assert.deepEqual(row(), { fingerprint: 'legacy', fingerprint_scheme: 'unreadable', authorized_revision: null }, 'unreadable: the value kept, compared with nothing');
  transact(db, ENGINE_ACTOR, (tx) => recordRecomputedFingerprint(tx, { version: 'pv_old', fingerprint: null, why: 'again' }));
  const events = () => db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'protected.fingerprint_recomputed'`).get().n;
  assert.equal(events(), 1, 'a repeated unreadable outcome records nothing new');
  transact(db, ENGINE_ACTOR, (tx) => recordRecomputedFingerprint(tx, { version: 'pv_old', fingerprint: 'n'.repeat(64), why: null }));
  assert.deepEqual(row(), { fingerprint: 'n'.repeat(64), fingerprint_scheme: 'manifest', authorized_revision: null });
  transact(db, ENGINE_ACTOR, (tx) => recordRecomputedFingerprint(tx, { version: 'pv_old', fingerprint: null, why: 'late' }));
  assert.equal(row().fingerprint_scheme, 'manifest', 'a version over the manifest is never made unreadable');
  assert.deepEqual(fingerprintsToRecompute(db), []);
});

// ---- the immutable input namespace (B01; E95) ----------------------------------------------

const TOOLS = { mount: '/bin/mount', umount: '/bin/umount', pivot_root: '/sbin/pivot_root', ip: '/sbin/ip', unshare: '/usr/bin/unshare', setpriv: '/usr/bin/setpriv', mknod: '/bin/mknod' };

function plan(dir, source, projection, manifest) {
  const area = join(dir, 'area');
  mkdirSync(join(area, 'root'), { recursive: true });
  return buildCheckPlan({ area, source, projection, manifest, readPaths: [], volBytes: 1 << 20, volInodes: 1000, shmBytes: 1 << 20, tools: TOOLS, node: process.execPath, initNodeCopy: process.execPath, initScript: join(dist, 'invoke', 'domain-init.js') });
}

test('B01: one read-only mount per top-level component holding an input: an overlay with no upper layer over the source, a bind where the source has none, a file bind at the top', async (t) => {
  const dir = scratch(t);
  const source = join(dir, 'src');
  const projection = join(dir, 'proj');
  mkdirSync(join(source, '.surety'), { recursive: true });
  writeFileSync(join(source, '.surety', 'README.md'), 'r\n');
  for (const p of ['.surety/checks/expect/app.js', 'acceptance/c.txt', 'top.txt']) {
    mkdirSync(dirname(join(projection, p)), { recursive: true });
    writeFileSync(join(projection, p), 'x\n');
  }
  const manifest = [
    ['.surety/checks/expect/app.js', 'blob', '100644', 'a'.repeat(40)],
    ['acceptance/c.txt', 'blob', '100644', 'b'.repeat(40)],
    ['top.txt', 'blob', '100644', 'c'.repeat(40)],
  ];
  assert.deepEqual(inputTops(manifest), ['.surety', 'acceptance', 'top.txt']);
  const p = plan(dir, source, projection, manifest);
  const lines = p.lateFstab.filter((l) => l.includes('/surety/workspace/'));
  const at = (top) => lines.filter((l) => l.split(' ')[1].endsWith(`/surety/workspace/${top}`));
  assert.equal(lines.length, 3, `exactly three input mounts, none per file below a component (${lines.join(' | ')})`);
  const [ovl] = at('.surety');
  assert.match(ovl, / overlay lowerdir=[^ ]*proj\/\.surety:[^ ]*src\/\.surety,userxattr,ro,nosuid,nodev /, 'the projection over the source, no upper layer, read-only');
  assert.doesNotMatch(ovl, /upperdir/);
  assert.match(at('acceptance')[0], /proj\/acceptance .* none bind,ro,nosuid,nodev /, 'no source there: a read-only bind of the projection');
  assert.match(at('top.txt')[0], /proj\/top\.txt .* none bind,ro,nosuid,nodev /, 'an input at the top: a read-only bind of the file');
  const targets = p.late.filter((e) => e.path.startsWith('surety/workspace/'));
  assert.deepEqual(targets.map((e) => [e.path, e.kind, e.nofollow]), [['surety/workspace/.surety', 'dir', true], ['surety/workspace/acceptance', 'dir', true], ['surety/workspace/top.txt', 'file', true]], 'only the components are made, never through a link');
});

test('B01: a top-level component an overlay cannot name refuses the plan, the reason naming it', () => {
  for (const name of ['a b', 'a,b', 'a:b', 'a\\b', 'a\tb']) {
    assert.match(inputMountConflict([[`${name}/x`, 'blob', '100644', 'a'.repeat(40)]]), /comma, colon, backslash or white space/, JSON.stringify(name));
  }
  assert.equal(inputMountConflict([['.surety/checks/x', 'blob', '100644', 'a'.repeat(40)]]), null);
});

// ---- the check tree: modes, projections, bounds ---------------------------------------------

const mat = (r, rev, manifests, extra = {}) =>
  materialize({ home: r.home, scratch: join(r.home, 'tmp'), repo: r.repo, project: PROJECT, revision: rev, version: VERSION, roots: ROOTS, manifests, maxEntries: 1000, maxBytes: 1 << 30, maxAllBytes: 1 << 30, ...extra });

const walk = (dir) => readdirSync(dir).flatMap((n) => (lstatSync(join(dir, n)).isDirectory() ? walk(join(dir, n)).map((p) => `${n}/${p}`) : [n]));

test('the tree: source keeps its git modes (writable in the overlay); each distinct manifest has one exact, read-only projection', async (t) => {
  const r = repoIn(scratch(t));
  const rev = r.commit({ '.surety/checks/protected-policy.json': '{}', '.surety/checks/a.txt': 'a\n', '.surety/checks/b.txt': 'b\n', 'src/run.sh': { content: '#!/bin/sh\n', mode: '100755' }, 'src/a.js': 'a\n' });
  const oid = (p) => r.g(['rev-parse', `${rev}:${p}`]);
  const ma = [['.surety/checks/a.txt', 'blob', '100644', oid('.surety/checks/a.txt')]];
  const mab = [...ma, ['.surety/checks/b.txt', 'blob', '100644', oid('.surety/checks/b.txt')]];
  const tree = await mat(r, rev, [ma, mab, [...ma]]);
  assert.equal(lstatSync(join(tree.src, 'src/a.js')).mode & 0o777, 0o644);
  assert.equal(lstatSync(join(tree.src, 'src/run.sh')).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(tree.inputs).length, 2, 'one projection per distinct manifest');
  assert.deepEqual(walk(projectionOf(tree, ma)), ['.surety/checks/a.txt'], 'exactly the manifest');
  assert.deepEqual(walk(projectionOf(tree, mab)).sort(), ['.surety/checks/a.txt', '.surety/checks/b.txt']);
  assert.equal(lstatSync(join(projectionOf(tree, ma), '.surety/checks/a.txt')).mode & 0o777, 0o444);
  assert.equal(lstatSync(join(projectionOf(tree, ma), '.surety/checks')).mode & 0o777, 0o555);
  assert.equal(existsSync(join(tree.src, '.surety')), false, 'no protected content and no governed file in the source');
  releaseTree(r.home, PROJECT, rev, VERSION);
  assert.equal(existsSync(tree.root), false, 'a read-only projection does not keep its tree from going');
});

test('checktrees_max_bytes: a tree that would take all trees past it is refused before anything is written; the tree in use stays', async (t) => {
  const r = repoIn(scratch(t));
  const first = r.commit({ '.surety/checks/protected-policy.json': '{}', 'bin/p': 'x'.repeat(60 * 1024) });
  const second = r.commit({ '.surety/checks/protected-policy.json': '{}', 'bin/p': 'y'.repeat(60 * 1024) });
  const one = await mat(r, first, [[]], { maxAllBytes: 100 * 1024 });
  assert.ok(checktreeBytesInUse(r.home) >= 60 * 1024);
  await assert.rejects(mat(r, second, [[]], { maxAllBytes: 100 * 1024 }), /checktrees_max_bytes \(102400\)/);
  assert.deepEqual(readdirSync(join(checktreesDir(r.home), PROJECT)), [`${first}-${VERSION}`], 'nothing of the refused tree is left, staging included');
  assert.ok(existsSync(join(one.src, 'bin/p')), 'the tree in use is unaffected');
  releaseTree(r.home, PROJECT, first, VERSION);
  assert.equal(checktreeBytesInUse(r.home), 0, 'its bytes go with it');
  await mat(r, second, [[]], { maxAllBytes: 100 * 1024 });
});

test('a tree of the earlier layout (no projections) is built again rather than used', async (t) => {
  const r = repoIn(scratch(t));
  const rev = r.commit({ '.surety/checks/protected-policy.json': '{}', '.surety/checks/a.txt': 'a\n', 'src/a.js': 'a\n' });
  const old = join(checktreesDir(r.home), PROJECT, `${rev}-${VERSION}`);
  mkdirSync(join(old, 'src'), { recursive: true });
  mkdirSync(join(old, 'protected'), { recursive: true });
  symlinkSync('/nowhere', join(old, 'src', 'stale'));
  const m = [['.surety/checks/a.txt', 'blob', '100644', r.g(['rev-parse', `${rev}:.surety/checks/a.txt`])]];
  const tree = await mat(r, rev, [m]);
  assert.deepEqual(walk(tree.src), ['src/a.js']);
  assert.ok(existsSync(join(projectionOf(tree, m), '.surety/checks/a.txt')));
  assert.equal(existsSync(join(old, 'protected')), false);
});
