// M05 (slice 1). Plan §3.1 M05; D1 §§1.4, 6.4; build spec §6 correction 19;
// Review B17. Migration identity, order and checksum are durable; no partial
// upgrade is exposed; failure or checksum disagreement keeps the engine in
// restricted mode with readable diagnostics and no dispatch; a correct restart
// applies each migration once. Upgrade, failure and checksum cases use a
// test-owned migrations directory (SEAM.md "Harness flags"): a copy of the
// engine's own migrations plus fixture migrations numbered 9001 and up.

import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  ENGINE_MIGRATIONS,
  freePort,
  installProject,
  makeTempDir,
  releaseBarrier,
  removeDir,
  sha256Hex,
  startEngine,
  waitFor,
  writeEngineConfig,
} from './harness/engine.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { makeRepo } from './harness/git.mjs';
import { hasTable, withStore } from './harness/store.mjs';

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

function migrationList(dir) {
  return readdirSync(dir)
    .filter((name) => MIGRATION_FILE.test(name))
    .map((name) => ({
      seq: Number(MIGRATION_FILE.exec(name)[1]),
      name,
      checksum: sha256Hex(readFileSync(join(dir, name))),
    }))
    .sort((a, b) => a.seq - b.seq);
}

const applied = (home) =>
  withStore(home, (db) => db.prepare('SELECT "seq", "name", "checksum", "applied_at" FROM "schema_migrations" ORDER BY "seq"').all());

const identity = (rows) => rows.map(({ seq, name, checksum }) => ({ seq, name, checksum }));

const countEvents = (home, type) =>
  withStore(home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "events" WHERE "type" = ?').get(type).n);

const UPGRADE = {
  name: '9001_fixture_upgrade.sql',
  sql: "CREATE TABLE fixture_upgrade_a (id INTEGER PRIMARY KEY, note TEXT NOT NULL);\nINSERT INTO fixture_upgrade_a (note) VALUES ('applied');\n",
};
const BROKEN = {
  name: '9001_fixture_broken.sql',
  sql: 'CREATE TABLE fixture_partial (id INTEGER PRIMARY KEY);\nTHIS IS NOT VALID SQL;\n',
};

// A home whose engine reads its migrations from a test-owned copy of the
// engine's own, already applied once, with a fixture project installed.
async function upgradeFixture(t) {
  const root = makeTempDir('m05');
  t.after(() => removeDir(root));
  const home = join(root, 'home');
  const migrations = join(root, 'migrations');
  mkdirSync(home);
  mkdirSync(migrations);
  for (const { name } of migrationList(ENGINE_MIGRATIONS)) copyFileSync(join(ENGINE_MIGRATIONS, name), join(migrations, name));
  const port = await freePort();
  writeEngineConfig(home, { api_port: port });
  const repo = makeRepo(join(root, 'repo'));
  const engines = [];
  t.after(async () => {
    for (const e of engines) await e.kill();
  });
  const start = async (opts = {}) => {
    const args = ['--harness-migrations', migrations, ...(opts.args ?? [])];
    const e = await startEngine({ home, port, args, until: opts.until ?? 'full' });
    engines.push(e);
    return e;
  };
  const first = await start();
  const project = await installProject(first, { repoPath: repo.path });
  await first.stop();
  return { home, migrations, start, project };
}

describe('M05 migrations and restricted startup', () => {
  test('a fresh store records each migration once with its identity, order and checksum', async (t) => {
    const expected = migrationList(ENGINE_MIGRATIONS);
    assert.ok(expected.length >= 1, 'the engine ships at least one migration');
    const root = makeTempDir('m05-fresh');
    t.after(() => removeDir(root));
    const port = await freePort();
    writeEngineConfig(root, { api_port: port });
    const first = await startEngine({ home: root, port });
    t.after(() => first.kill());
    await waitFor(() => countEvents(root, 'engine.started') === 1, { what: 'engine.started' });
    await first.stop();
    const rows = applied(root);
    assert.deepEqual(identity(rows), expected);
    for (const row of rows) assert.match(row.applied_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(countEvents(root, 'engine.started'), 1);

    const second = await startEngine({ home: root, port });
    t.after(() => second.kill());
    await waitFor(() => countEvents(root, 'engine.started') === 2, { what: 'the second engine.started' });
    await second.stop();
    assert.deepEqual(applied(root), rows, 'a restart applies nothing again and rewrites no history row');
    assert.equal(countEvents(root, 'engine.started'), 2);
  });

  test('an upgrade applies only the pending migration, once, after those already applied', async (t) => {
    const { home, migrations, start, project } = await upgradeFixture(t);
    const before = applied(home);
    writeFileSync(join(migrations, UPGRADE.name), UPGRADE.sql);

    const engine = await start();
    await engine.stop();
    const after = applied(home);
    assert.deepEqual(identity(after), migrationList(migrations));
    assert.deepEqual(after.slice(0, before.length), before, 'applied rows unchanged');
    withStore(home, (db) => {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixture_upgrade_a').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "projects" WHERE "id" = ?').get(project).n, 1, 'data preserved');
    });

    const again = await start();
    await again.stop();
    assert.deepEqual(applied(home), after);
    withStore(home, (db) => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixture_upgrade_a').get().n, 1));
  });

  test('a kill during migration exposes no partial upgrade, and a restart applies it once', async (t) => {
    const { home, migrations, start } = await upgradeFixture(t);
    const before = applied(home);
    writeFileSync(join(migrations, UPGRADE.name), UPGRADE.sql);

    const dying = await start({ args: ['--harness-barrier', 'migration.before_commit=kill'], until: 'none' });
    const status = await Promise.race([dying.exited, sleep(30_000).then(() => null)]);
    assert.ok(status, 'the engine reached the barrier and killed itself within 30 s');
    assert.equal(status.signal, 'SIGKILL', `engine killed itself at the barrier: ${JSON.stringify(status)}`);
    assert.deepEqual(applied(home), before, 'no history row for the interrupted migration');
    withStore(home, (db) => assert.equal(hasTable(db, 'fixture_upgrade_a'), false, 'no table from the interrupted migration'));

    const engine = await start();
    await engine.stop();
    assert.deepEqual(identity(applied(home)), migrationList(migrations));
    withStore(home, (db) => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixture_upgrade_a').get().n, 1));
  });

  test('a failing migration leaves the engine restricted, diagnosable and without partial state', async (t) => {
    const { home, migrations, start, project } = await upgradeFixture(t);
    const before = applied(home);
    const startedBefore = countEvents(home, 'engine.started');
    writeFileSync(join(migrations, BROKEN.name), BROKEN.sql);

    const engine = await start({ until: 'failed' });
    const health = await engine.get('/v1/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.mode, 'restricted');
    const info = await engine.engineInfo();
    assert.equal(info.mode, 'restricted');
    assert.equal(info.startup.failed.step, 'store');
    assert.equal(info.startup.failed.code, 'migration_failed');
    assert.equal(info.startup.failed.subject.migration, BROKEN.name);
    assertRefused(await engine.post(`/v1/projects/${project}/pause`), 503, 'engine_starting', 'mutation while restricted');
    assert.ok(engine.isRunning(), 'the engine stays up so its diagnostics remain readable');

    assert.deepEqual(applied(home), before);
    withStore(home, (db) => {
      assert.equal(hasTable(db, 'fixture_partial'), false, 'no partial migration');
      assert.equal(db.prepare('SELECT "paused" FROM "projects" WHERE "id" = ?').get(project).paused, 0);
    });
    assert.equal(countEvents(home, 'engine.started'), startedBefore, 'the scheduler never started');
    await engine.kill();

    writeFileSync(join(migrations, BROKEN.name), UPGRADE.sql.replaceAll('fixture_upgrade_a', 'fixture_partial'));
    const fixed = await start();
    await fixed.stop();
    assert.deepEqual(identity(applied(home)), migrationList(migrations));
  });

  test('a changed checksum on an applied migration prevents full mode', async (t) => {
    const { home, migrations, start, project } = await upgradeFixture(t);
    const before = applied(home);
    const target = before[0].name;
    const original = readFileSync(join(migrations, target));
    appendFileSync(join(migrations, target), '\n-- altered after it was applied\n');

    const engine = await start({ until: 'failed' });
    const info = await engine.engineInfo();
    assert.equal(info.mode, 'restricted');
    assert.equal(info.startup.failed.step, 'store');
    assert.equal(info.startup.failed.code, 'migration_checksum_mismatch');
    assert.equal(info.startup.failed.subject.migration, target);
    assertRefused(await engine.post(`/v1/projects/${project}/pause`), 503, 'engine_starting', 'mutation while restricted');
    assert.deepEqual(applied(home), before, 'the recorded checksum is not overwritten');
    await engine.kill();

    writeFileSync(join(migrations, target), original);
    const restored = await start();
    await restored.stop();
    assert.deepEqual(applied(home), before);
  });

  test('while a migration is in progress, health answers in restricted mode and mutations are refused', async (t) => {
    const { home, migrations, start, project } = await upgradeFixture(t);
    writeFileSync(join(migrations, UPGRADE.name), UPGRADE.sql);

    const engine = await start({
      args: ['--harness-barrier', 'migration.before_commit=pause'],
      until: 'barrier:migration.before_commit',
    });
    const health = await engine.get('/v1/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.mode, 'restricted');
    const info = await engine.engineInfo();
    assert.equal(info.mode, 'restricted');
    assert.equal(info.startup.step, 'store');
    assert.equal(info.startup.failed, null);
    assertRefused(await engine.post(`/v1/projects/${project}/pause`), 503, 'engine_starting', 'mutation during migration');

    await releaseBarrier(engine, 'migration.before_commit');
    await engine.waitUntil('full');
    await engine.stop();
    assert.deepEqual(identity(applied(home)), migrationList(migrations));
    withStore(home, (db) => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixture_upgrade_a').get().n, 1));
  });
});
