// M120, the control plane is invisible (M2 slice 12, sandbox lane). M2 plan
// §3.4 M120; D2 §2.3, §5 C3, A.6 P1 to P3 (D2-I01, D2-I02, D2-I03; D2-C06
// observed in the sandbox); AR B02, P1 to P3; SEAM.md §§132, 134.
//
// A role cannot open the API token, the store, the engine's log, a record,
// another domain's area, another run's workspace or the developer's
// checkout, by its host path or by any alias; no descriptor of it names
// them and the init's descriptors are unreadable; `/surety` holds exactly
// its five entries and the engine home's path does not exist. Every target
// is seeded and read from the host before the role probes it (a probe
// whose target the host cannot read fails the case), and every negative has
// its control: the host reads the target, the role reads its own
// workspace's sentinel.
//
// The role's probes here only read (open_paths, list_dirs, stat_paths,
// self_status, init_fd); nothing of the user's is touched: every target is
// under the test's own engine home and repositories.
//
// On the engine these tests were written against the cases pass or fail as
// COVERAGE.md, "M2 slice 12", records: slice 11's sandbox already keeps the
// engine home out of the role's root.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { sha256Hex } from './harness/engine.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { recordFile, recordsOf } from './harness/records.mjs';
import { addWork, assertRunEnded, getRow, stopRun, waitForRunState } from './harness/runs.mjs';
import { roleHolding, sandboxEngine } from './harness/sandbox/lane.mjs';
import { aliasesOf, byPath, probedRun, seedSentinel } from './harness/sandbox/view.mjs';
import { step } from './harness/scripted.mjs';

const WORKSPACE_SENTINEL = 'the sentinel the test put in the base commit\n';

// An engine with every target of P1 to P3 seeded and read from the host:
// a first project whose run was stopped (its workspace retained, its
// transcript a record, its domain's area), the developer's checkouts of both
// projects, and sentinels at the engine home's own files. Returns the
// fixture and the targets, each {what, path, sha256} with the host's read.
async function seededEngine(t) {
  const fx = await sandboxEngine(t);
  const home = realpathSync(fx.home);

  const other = await addGitProject(fx, { files: { 'other-workspace-sentinel.txt': 'a file of another run\'s workspace\n' } });
  // The role writes a line of its own, so that its transcript, a record
  // file under the engine home, holds something the host can read.
  const held = await roleHolding(fx, other.id, await addWork(fx.engine, other.id, 'verification'), { before: [step.stdout('a line of the stopped role\'s own output\n')] });
  await stopRun(fx.engine, other.id, held.run.id);
  await waitForRunState(fx.home, held.run.id, 'ended', { timeoutMs: 40_000 });
  assertRunEnded(fx.home, held.run.id, { outcome: 'stopped', reason_class: 'human_stop', launched: true, recovery: false });

  const project = await addGitProject(fx, { files: { 'workspace-sentinel.txt': WORKSPACE_SENTINEL } });

  const hostRead = (what, path) => {
    assert.ok(existsSync(path), `the target is seeded: ${what} exists at ${path}`);
    const bytes = readFileSync(path);
    assert.ok(bytes.length > 0, `control: the host reads ${what} (${path})`);
    return { what, path, sha256: sha256Hex(bytes.subarray(0, 65536)) };
  };
  const otherWorkspace = getRow(fx.home, 'workspaces', held.run.workspace);
  assert.equal(otherWorkspace.disposition, 'retained', 'the stopped run\'s workspace is retained: a second populated workspace');
  const record = recordsOf(fx.home, other.id).find((r) => r.published === 1 && r.path !== null && r.bytes > 0);
  assert.ok(record, 'the target is seeded: the stopped run left a published record file');
  if (!existsSync(join(home, 'engine.log'))) seedSentinel(join(home, 'engine.log'), 'a line of the engine log');
  seedSentinel(join(home, 'sentinel-beside-the-store.txt'), 'a sentinel in the store\'s directory');
  seedSentinel(join(home, 'domains', held.domain.id, 'context', 'sentinel.txt'), 'a sentinel in another domain\'s area');

  const targets = {
    token: hostRead('api.token', join(home, 'api.token')),
    home: [
      hostRead('store.db', join(home, 'store.db')),
      hostRead('the sentinel beside the store', join(home, 'sentinel-beside-the-store.txt')),
      hostRead('engine.log', join(home, 'engine.log')),
      hostRead('a record file', recordFile(home, record)),
      hostRead('another domain\'s area', join(home, 'domains', held.domain.id, 'context', 'sentinel.txt')),
    ],
    elsewhere: [
      hostRead('another run\'s workspace', join(realpathSync(otherWorkspace.path), 'other-workspace-sentinel.txt')),
      hostRead('the developer\'s checkout of another project', join(other.repo.path, 'other-workspace-sentinel.txt')),
      hostRead('the developer\'s checkout of the role\'s own project', join(project.repo.path, 'workspace-sentinel.txt')),
    ],
  };
  assert.equal(readFileSync(targets.token.path, 'utf8').trim(), fx.engine.token(), 'control: the host reads the token, and it is the engine\'s');
  return { fx, home, project, targets };
}

const assertNotFound = (results, target, paths) => {
  for (const path of paths) {
    const r = results[path];
    assert.ok(r, `the role probed ${path}`);
    assert.deepEqual([r.outcome, r.error], ['failed', 'ENOENT'], `${target.what}: not found by ${path}`);
  }
};

describe('M120 the control plane is invisible', () => {
  test('(a) P1: the role opens api.token by its host path, by /proc/self/root and by .. forms: not found each; control: the host reads the token', async (t) => {
    const { fx, project, targets } = await seededEngine(t);
    const paths = aliasesOf(targets.token.path);
    const { probe, launch } = await probedRun(fx, project.id, await addWork(fx.engine, project.id, 'verification'), { before: [step.probe('open_paths', { paths })] });
    assertNotFound(byPath(probe('open_paths')), targets.token, paths);
    assert.ok(!launch.env_value_hashes.includes(sha256Hex(fx.engine.token())), 'and no environment value of the role is the token');
    assert.equal(sha256Hex(readFileSync(targets.token.path).subarray(0, 65536)), targets.token.sha256, 'host-witnessed: the token file is unchanged');
  });

  test("(b) P2: store.db, engine.log, a record file, another domain's area and a sentinel beside the store: not found each; no descriptor of the role names them; /proc/1/fd is unreadable; control: the host reads each", async (t) => {
    const { fx, home, project, targets } = await seededEngine(t);
    const paths = targets.home.flatMap((target) => [target.path, `/proc/self/root${target.path}`]);
    const { probe } = await probedRun(fx, project.id, await addWork(fx.engine, project.id, 'verification'), {
      before: [step.probe('open_paths', { paths }), step.probe('self_status'), step.probe('init_fd'), step.probe('list_dirs', { paths: ['/proc/self/fd'] })],
    });
    const opened = byPath(probe('open_paths'));
    for (const target of targets.home) assertNotFound(opened, target, [target.path, `/proc/self/root${target.path}`]);
    const fds = probe('self_status').fds;
    assert.ok(Object.keys(fds).length >= 3, 'the fixture is live: the role listed its descriptors');
    assert.deepEqual(Object.entries(fds).filter(([, to]) => to.startsWith(home) || to.startsWith(fx.home)), [], `no descriptor of the role names anything of the engine home (${JSON.stringify(fds)})`);
    const init = probe('init_fd');
    assert.deepEqual([init.outcome, init.error], ['refused', 'EACCES'], `the init's descriptors are unreadable (${JSON.stringify(init)})`);
    for (const target of targets.home) assert.equal(sha256Hex(readFileSync(target.path).subarray(0, 65536)).length, 64, `control: the host still reads ${target.what}`);
  });

  test("(c) P3: another run's workspace and the developer's checkouts: not found; control: the role reads its own workspace's sentinel with the content the test put in the base commit", async (t) => {
    const { fx, project, targets } = await seededEngine(t);
    const paths = targets.elsewhere.flatMap((target) => [target.path, `/proc/self/root${target.path}`]);
    const { probe } = await probedRun(fx, project.id, await addWork(fx.engine, project.id, 'verification'), {
      before: [step.probe('open_paths', { paths, label: 'elsewhere' }), step.probe('open_paths', { paths: ['/surety/workspace/workspace-sentinel.txt', 'workspace-sentinel.txt'], label: 'control' })],
    });
    const opened = byPath(probe('open_paths', 'elsewhere'));
    for (const target of targets.elsewhere) assertNotFound(opened, target, [target.path, `/proc/self/root${target.path}`]);
    for (const r of probe('open_paths', 'control').results) {
      assert.deepEqual([r.outcome, r.sha256], ['opened', sha256Hex(WORKSPACE_SENTINEL)], `control: the role reads its own workspace's sentinel (${r.path})`);
    }
  });

  test("(d) /surety holds exactly context, workspace, git, home and out; the engine home's path does not exist in the role's view, and SURETY_HOME is not in its environment", async (t) => {
    const { fx, home, project } = await seededEngine(t);
    const candidates = [...new Set([fx.home, home, `/proc/self/root${home}`, join(home, 'workspaces'), join(home, 'domains'), join(home, 'records')])];
    const { probe, launch } = await probedRun(fx, project.id, await addWork(fx.engine, project.id, 'verification'), {
      before: [step.probe('list_dirs', { paths: ['/surety'] }), step.probe('stat_paths', { paths: candidates })],
    });
    const listing = probe('list_dirs').results[0];
    assert.equal(listing.outcome, 'listed', `the role lists /surety (${listing.error})`);
    assert.deepEqual(listing.entries.map((e) => e.name).sort(), ['context', 'git', 'home', 'out', 'workspace'], '/surety holds exactly its five entries');
    for (const r of probe('stat_paths').results) assert.deepEqual([r.outcome, r.error], ['failed', 'ENOENT'], `${r.path} does not exist in the role's view`);
    assert.ok(statSync(home).isDirectory(), 'control: the host sees the engine home');
    assert.ok(!launch.env_keys.includes('SURETY_HOME'), `SURETY_HOME is not in the role's environment (${launch.env_keys.join(', ')})`);
    for (const value of [fx.home, home]) assert.ok(!launch.env_value_hashes.includes(sha256Hex(value)), 'and no variable holds the engine home\'s path');
  });
});
