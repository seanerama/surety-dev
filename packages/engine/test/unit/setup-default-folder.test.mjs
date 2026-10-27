import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

// The destination is validated before the default folder is created: a
// destination the engine would refuse creates nothing, and an existing
// default folder is left exactly as it is, mode included.
test('a refused destination never creates the default folder; an existing default folder keeps its mode and contents', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ui-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previousHome = process.env.HOME;
  t.after(() => { process.env.HOME = previousHome; });
  const body = { name: 'Garden journal', tier: 'T2', idea: 'Track watering.' };
  const reason = e => e.message ?? e.reason ?? '';

  // (1) The engine home is the person's home: ~/projects/app is inside the
  // engine home. Refused, and ~/projects is not created.
  const userA = join(root, 'a'); mkdirSync(userA);
  const scratchA = join(userA, 'scratch'); mkdirSync(scratchA);
  process.env.HOME = userA;
  configureGit({ home: userA, incarnation: 'test', deadlineSeconds: 30, outputCap: 1048576 });
  await assert.rejects(prepareNewProject({ home: userA, scratch: scratchA, setting: () => 30 }, { ...body, dev_repo_path: join(userA, 'projects', 'app') }),
    e => e.code === 'invalid_value' && /outside the engine home/.test(reason(e)));
  assert.equal(existsSync(join(userA, 'projects')), false, 'a destination inside the engine home creates no default folder');

  // (2) The same through a symbolic link to the engine home: the path as the
  // file system resolves it is inside, so nothing is created.
  const userB = join(root, 'b'); mkdirSync(userB);
  const engineB = join(root, 'engine-b'); mkdirSync(join(engineB, 'scratch'), { recursive: true });
  symlinkSync(engineB, join(userB, 'link'));
  process.env.HOME = join(userB, 'link');
  await assert.rejects(prepareNewProject({ home: engineB, scratch: join(engineB, 'scratch'), setting: () => 30 }, { ...body, dev_repo_path: join(userB, 'link', 'projects', 'app') }),
    e => e.code === 'invalid_value' && /outside the engine home/.test(reason(e)));
  assert.equal(existsSync(join(engineB, 'projects')), false, 'a destination resolving into the engine home creates no default folder');

  // (3) An existing destination under an existing default folder of mode
  // 755: refused, its contents and the default folder's mode unchanged.
  const userC = join(root, 'c'); mkdirSync(userC);
  const engineC = join(root, 'engine-c'); mkdirSync(join(engineC, 'scratch'), { recursive: true });
  const rtC = { home: engineC, scratch: join(engineC, 'scratch'), setting: () => 30 };
  process.env.HOME = userC;
  const dflt = defaultProjectsDirectory();
  mkdirSync(dflt, { mode: 0o755 }); chmodSync(dflt, 0o755);
  mkdirSync(join(dflt, 'app')); writeFileSync(join(dflt, 'app', 'notes.txt'), 'mine');
  await assert.rejects(prepareNewProject(rtC, { ...body, dev_repo_path: join(dflt, 'app') }), e => e.code === 'repository_not_created');
  assert.equal(readFileSync(join(dflt, 'app', 'notes.txt'), 'utf8'), 'mine', 'the existing destination is untouched');
  assert.equal(statSync(dflt).mode & 0o777, 0o755, "the existing default folder's mode is unchanged");
  // An existing file at the destination is refused the same way, and kept.
  writeFileSync(join(dflt, 'file-app'), 'kept');
  await assert.rejects(prepareNewProject(rtC, { ...body, dev_repo_path: join(dflt, 'file-app') }), e => e.code === 'repository_not_created');
  assert.equal(readFileSync(join(dflt, 'file-app'), 'utf8'), 'kept');
  // A valid new app under it: the folder's mode is still 755 afterwards.
  await prepareNewProject(rtC, { ...body, dev_repo_path: join(dflt, 'fresh') });
  assert.equal(statSync(dflt).mode & 0o777, 0o755, 'creating an app never changes an existing default folder');

  // (4) An invalid form (a bad tier) creates no default folder.
  const userD = join(root, 'd'); mkdirSync(userD);
  process.env.HOME = userD;
  await assert.rejects(prepareNewProject(rtC, { ...body, tier: 'T9', dev_repo_path: join(userD, 'projects', 'app') }), e => e.code === 'invalid_value');
  assert.equal(existsSync(join(userD, 'projects')), false, 'an invalid form creates no default folder');

  // (5) Something that is not a folder at ~/projects (a file) is left as it
  // is, and the destination under it is refused.
  writeFileSync(join(userD, 'projects'), 'a file');
  await assert.rejects(prepareNewProject(rtC, { ...body, dev_repo_path: join(userD, 'projects', 'app') }));
  assert.equal(readFileSync(join(userD, 'projects'), 'utf8'), 'a file');
});
