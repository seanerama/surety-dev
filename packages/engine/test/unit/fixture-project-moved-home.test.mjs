// Developer test for the engine's qualification fixture project in a home
// that was moved or copied (the driver's real-lane finding at gate-s33,
// 2026-10-13): the store's fixture project names the repository's old path.
// It is rebound to the repository here, never doubled by a second project
// on the same repository, whose keep refs (numbered per project) collide
// with the first's; a repository holding Surety refs no fixture project of
// this store can be rebound to is refused, not shared.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { ensureFixtureProject, ensureFixtureRepo, FIXTURE_NAME } = await import(join(dist, 'trust', 'fixture.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-fx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A store client that answers the reads ensureFixtureProject makes and
// records its mutations; nothing else is reached.
function fakeStore(answers) {
  const calls = [];
  return {
    calls,
    call: async (kind, req) => {
      calls.push({ kind, ...req });
      if (kind === 'read') return answers[req.name]?.(req.args) ?? null;
      if (kind === 'mutate' && req.name === 'project.rebind') return { status: 200, body: { project: { id: req.args.project } } };
      throw new Error(`unexpected ${kind} ${req.name}`);
    },
  };
}

test("a moved home's fixture project is rebound to the repository here, not made again", async (t) => {
  const home = scratch(t);
  configureGit({ deadlineSeconds: 10, outputCap: 1 << 20, home, incarnation: 'inc_unit' });
  const repo = await ensureFixtureRepo(home);
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'main']).toString().trim();
  // The first project's engine record in the copied repository.
  execFileSync('git', ['-C', repo, 'update-ref', 'refs/surety/keep/1', head]);
  const store = fakeStore({
    'qualification.engine_fixture': () => null,
    'qualification.moved_fixtures': (a) => (a.name === FIXTURE_NAME ? [{ id: 'proj_old', dev_repo_path: '/elsewhere/home/qualification/fixture', head }] : []),
  });
  const id = await ensureFixtureProject({ home, services: null, afterCommit: () => {} }, store);
  assert.equal(id, 'proj_old', 'the existing fixture project');
  const mutations = store.calls.filter((c) => c.kind === 'mutate');
  assert.deepEqual(mutations.map((m) => [m.name, m.args]), [['project.rebind', { project: 'proj_old', dev_repo_path: repo }]], 'rebound, and no project.create');
});

test('a repository holding Surety refs that no fixture project of this store can be rebound to is refused, never shared', async (t) => {
  const home = scratch(t);
  configureGit({ deadlineSeconds: 10, outputCap: 1 << 20, home, incarnation: 'inc_unit' });
  const repo = await ensureFixtureRepo(home);
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'main']).toString().trim();
  execFileSync('git', ['-C', repo, 'update-ref', 'refs/surety/keep/1', head]);
  const store = fakeStore({
    'qualification.engine_fixture': () => null,
    // A fixture project whose head this repository does not hold.
    'qualification.moved_fixtures': () => [{ id: 'proj_other', dev_repo_path: '/elsewhere/home/qualification/fixture', head: '0'.repeat(40) }],
  });
  await assert.rejects(ensureFixtureProject({ home, services: null, afterCommit: () => {} }, store), /holds Surety records/);
  assert.deepEqual(store.calls.filter((c) => c.kind === 'mutate'), [], 'nothing created, nothing rebound');
});
