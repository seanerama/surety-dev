import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { configureGit } from '../../dist/git/exec.js';
import { defaultProjectsDirectory, prepareNewProject } from '../../dist/setup/projects.js';

// The default app folder (~/projects) is created on first use, one level,
// mode 700; any other missing parent is still refused; nothing existing changes.
test('a first app under the default folder creates that folder; other missing parents are refused; existing folders are untouched', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ui-default-'));
  const home = join(root, 'engine-home'); const scratch = join(home, 'scratch'); mkdirSync(scratch, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previousHome = process.env.HOME;
  process.env.HOME = join(root, 'user'); mkdirSync(process.env.HOME);
  t.after(() => { process.env.HOME = previousHome; });
  configureGit({ home, incarnation: 'test', deadlineSeconds: 30, outputCap: 1048576 });
  const rt = { home, scratch, setting: () => 30 };
  const dflt = defaultProjectsDirectory();
  assert.equal(dflt, join(root, 'user', 'projects'));
  assert.equal(existsSync(dflt), false);
  const body = { name: 'Garden journal', tier: 'T2', idea: 'Track watering.', dev_repo_path: join(dflt, 'garden') };
  const prepared = await prepareNewProject(rt, body);
  assert.equal(prepared.initiallyPaused, true);
  assert.equal(statSync(dflt).mode & 0o777, 0o700);
  assert.equal(existsSync(join(dflt, 'garden', 'README.md')), true);
  // A second app under the now-existing default folder; the folder's contents are not touched.
  writeFileSync(join(dflt, 'keep.txt'), 'kept');
  await prepareNewProject(rt, { ...body, name: 'Reading list', dev_repo_path: join(dflt, 'reading') });
  assert.equal(existsSync(join(dflt, 'keep.txt')), true);
  // Not the default parent: refused as before, nothing created.
  const elsewhere = join(root, 'missing-parent', 'app');
  await assert.rejects(prepareNewProject(rt, { ...body, dev_repo_path: elsewhere }), e => e.code === 'invalid_value' && /parent folder must already exist/.test(e.message ?? e.reason ?? ''));
  assert.equal(existsSync(join(root, 'missing-parent')), false);
  // The default folder's own parent missing: refused, nothing created recursively.
  process.env.HOME = join(root, 'nobody');
  await assert.rejects(prepareNewProject(rt, { ...body, dev_repo_path: join(defaultProjectsDirectory(), 'x') }), e => e.code === 'invalid_value');
  assert.equal(existsSync(join(root, 'nobody')), false);
});
