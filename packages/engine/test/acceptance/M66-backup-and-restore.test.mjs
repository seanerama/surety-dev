// M66, complete backup and restore (slice 4). Plan §3.6 M66; D1 §§6.5, 14.3,
// 16.2, D1-02, D1-23; SEAM.md §59.
//
// A backup is the store, every record the store refers to, and a manifest
// of the git objects it refers to, which the engine keeps reachable in the
// repository. Restored into a fresh engine home with the repository bound
// explicitly, it gives back the accounting, the records and the commits,
// also after the repository was garbage-collected, and the engine reaches
// full mode on it. A backup with a member missing or altered is refused,
// and a copy of the database alone is labeled as not enough to recover from.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { STORE_REFUSED, backup, restore } from './harness/backup.mjs';
import { freePort, sha256Hex, startEngine, writeEngineConfig } from './harness/engine.mjs';
import { addGitProject, addItem, permittedEdit, roleThat } from './harness/gitruns.mjs';
import { revisionsOf } from './harness/journal.mjs';
import { getLedger } from './harness/ledger.mjs';
import { readRecord, recordRow } from './harness/records.mjs';
import { gitQuiet, objectExists } from './harness/repos.mjs';
import { pauseProject, scriptedEngine, tickOnce, waitForRun } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

describe('M66 backup and restore', () => {
  // One engine home with a history worth restoring: a Builder's run that was
  // charged, left a transcript and a result, and whose commit is a checkpoint,
  // on no branch. Backed up once, complete and database-only; the repository
  // is then garbage-collected. Each case restores its own copy.
  const cleanup = [];
  let made;
  before(async () => {
    const fx = await scriptedEngine({ after: (fn) => cleanup.push(fn) });
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit(), step.usage({ input_tokens: 900, output_tokens: 300, cost_usd: 0.6 })], { checkpoint: true })]);
    // One tick, then the project is paused: a checkpoint returns its work to
    // eligible, and nothing more is to be dispatched, here or after a restore.
    await tickOnce(fx.engine, project.id);
    const run = await waitForRun(fx.home, item, { state: 'ended' });
    assert.equal(run.outcome, 'completed', 'the fixture run completed');
    await pauseProject(fx.engine, project.id);
    const { rows, totals, by_role } = await getLedger(fx.engine, project.id);
    const records = [];
    for (const id of [run.transcript, run.result]) records.push({ id, sha256: recordRow(fx.home, id).sha256, served: sha256Hex(Buffer.from((await readRecord(fx.engine, project.id, id)).text)) });
    const commits = revisionsOf(fx.home, { project: project.id }).map((revision) => revision.sha);
    assert.ok(commits.length >= 1, 'the fixture has a recorded commit');
    await fx.engine.stop();

    const complete = backup(fx.home);
    const databaseOnly = backup(fx.home, { databaseOnly: true });
    gitQuiet(project.repo.path, ['reflog', 'expire', '--expire=now', '--all']);
    gitQuiet(project.repo.path, ['gc', '-q', '--prune=now']);
    made = { fx, project, ledger: { rows, totals, by_role }, records, commits, complete, databaseOnly };
  });
  after(async () => {
    for (const fn of cleanup.reverse()) await fn();
  });

  // A fresh engine home and a private copy of a backup.
  async function freshHome(t, source) {
    const dir = join(made.fx.root, `case-${t.name.length}-${Math.random().toString(36).slice(2, 8)}`);
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const port = await freePort();
    writeEngineConfig(home, { api_port: port });
    const copy = join(dir, 'backup');
    cpSync(source.dir, copy, { recursive: true });
    return { home, port, copy };
  }
  const bindings = () => ({ [made.project.id]: made.project.repo.path });

  function assertRefusedRestore(done, home, code) {
    assert.equal(done.status, STORE_REFUSED, `the restore is refused (stdout: ${done.stdout}; stderr: ${done.stderr})`);
    assert.equal(done.refusal?.code, code);
    assert.equal(existsSync(join(home, 'store.db')), false, 'a refused restore leaves no store behind');
  }

  test('a complete backup, restored into a fresh home with the repository bound, gives back accounting, records and commits, and the engine reaches full mode', async (t) => {
    const { complete, project, ledger, records, commits } = made;
    assert.equal(complete.label, 'complete');
    assert.equal(complete.manifest.label, 'complete');
    assert.deepEqual(complete.manifest.records.map((r) => r.id).sort(), records.map((r) => r.id).sort(), 'the manifest lists the records the store refers to');
    const listed = complete.manifest.git.find((g) => g.project === project.id)?.objects ?? [];
    for (const sha of commits) assert.ok(listed.includes(sha), `the manifest lists commit ${sha}`);

    const { home, port, copy } = await freshHome(t, complete);
    const done = restore(home, copy, bindings());
    assert.equal(done.status, 0, `surety store restore exits 0 (stderr: ${done.stderr})`);
    const engine = await startEngine({ home, port });
    t.after(() => engine.kill());
    const info = await engine.engineInfo();
    assert.deepEqual([info.mode, info.startup.failed], ['full', null]);

    const { rows, totals, by_role } = await getLedger(engine, project.id);
    assert.deepEqual({ rows, totals, by_role }, ledger, 'the accounting is what it was');
    for (const record of records) {
      const res = await readRecord(engine, project.id, record.id);
      assert.equal(res.status, 200, `record ${record.id} is readable in the restored home (body: ${res.text.slice(0, 200)})`);
      assert.equal(sha256Hex(Buffer.from(res.text)), record.served, `record ${record.id} holds what it held`);
    }
    for (const sha of commits) assert.ok(objectExists(project.repo.path, sha), `commit ${sha} survived the garbage collection`);
  });

  test('a backup with a member omitted is refused', async (t) => {
    const { home, copy } = await freshHome(t, made.complete);
    rmSync(join(copy, made.complete.manifest.records[0].file));
    assertRefusedRestore(restore(home, copy, bindings()), home, 'backup_incomplete');
  });

  test('a backup with a member altered is refused', async (t) => {
    const { home, copy } = await freshHome(t, made.complete);
    const file = join(copy, made.complete.manifest.records[0].file);
    const bytes = readFileSync(file);
    bytes[0] ^= 0xff;
    writeFileSync(file, bytes);
    assertRefusedRestore(restore(home, copy, bindings()), home, 'backup_incomplete');
  });

  test('a copy of the database alone is labeled insufficient for recovery, and is refused as one', async (t) => {
    const { databaseOnly } = made;
    assert.equal(databaseOnly.label, 'incomplete_for_recovery');
    assert.equal(databaseOnly.manifest.label, 'incomplete_for_recovery');
    const { home, copy } = await freshHome(t, databaseOnly);
    assertRefusedRestore(restore(home, copy, bindings()), home, 'incomplete_for_recovery');
  });
});
