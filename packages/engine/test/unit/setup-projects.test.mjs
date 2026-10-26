import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { configureGit, git, repoContext } from '../../dist/git/exec.js';
import { prepareNewProject } from '../../dist/setup/projects.js';

test('a new app owns a detached repository; existing folders are never overwritten', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ui-app-')); const home = join(root, 'home'); const scratch = join(home, 'scratch'); mkdirSync(scratch, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  configureGit({ home, incarnation: 'test', deadlineSeconds: 30, outputCap: 1048576 });
  const rt = { home, scratch, setting: () => 30 };
  const body = { name: 'Garden journal', tier: 'T2', idea: 'Track watering and photos.', dev_repo_path: join(root, 'garden') };
  const prepared = await prepareNewProject(rt, body);
  assert.equal(prepared.initiallyPaused, true); assert.equal(prepared.name, body.name);
  assert.match(prepared.commit.content, /bootstrap project/);
  assert.equal((await git(repoContext(body.dev_repo_path), ['symbolic-ref', '-q', 'HEAD'])).code, 1);
  assert.equal((await git(repoContext(body.dev_repo_path), ['rev-parse', 'main'])).code, 0);
  const before = readFileSync(join(body.dev_repo_path, 'README.md'), 'utf8');
  await assert.rejects(prepareNewProject(rt, body), e => e.code === 'repository_not_created');
  assert.equal(readFileSync(join(body.dev_repo_path, 'README.md'), 'utf8'), before);
  const invalid = join(root, 'invalid');
  await assert.rejects(prepareNewProject(rt, { ...body, tier: 'bad', dev_repo_path: invalid }));
  assert.equal(existsSync(invalid), false);
  await assert.rejects(prepareNewProject(rt, { ...body, dev_repo_path: join(home, 'app') }));
});
