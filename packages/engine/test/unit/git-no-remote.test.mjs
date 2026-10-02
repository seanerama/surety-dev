// Developer tests for E37 item 1: engine git never contacts a remote and never
// runs a program a remote's configuration names, whatever the repository's
// configuration says. The repository is made a partial clone whose promisor
// remote names a program that leaves a marker; each case shows that plain git
// runs it when looking up a missing object, and that the engine's git does
// not, and reports the object missing.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { configureGit, git, repoContext } = await import(join(dist, 'git', 'exec.js'));

const MISSING = '1234567890123456789012345678901234567890';

function promisorRepo(t, remote) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-noremote-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', repo, 'add', 'a.txt'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'one'], { env });
  const marker = join(dir, 'ran');
  const prog = join(dir, 'prog.sh');
  writeFileSync(prog, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(prog, 0o755);
  // A remote helper on the PATH the engine passes on.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'git-remote-planted'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(join(dir, 'bin', 'git-remote-planted'), 0o755);
  const lines = remote(dir, prog).map((l) => `\t${l}\n`).join('');
  appendFileSync(
    join(repo, '.git', 'config'),
    `[extensions]\n\tpartialClone = origin\n[remote "origin"]\n\tpromisor = true\n${lines}[protocol]\n\tallow = always\n[protocol "file"]\n\tallow = always\n[protocol "ext"]\n\tallow = always\n[protocol "planted"]\n\tallow = always\n`,
  );
  execFileSync('git', ['-C', repo, 'config', 'core.repositoryformatversion', '1'], { env });
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 20, home: dir, incarnation: 'inc_unit' });
  return { dir, repo, env, marker };
}

const REMOTES = {
  'upload-pack': (dir, prog) => [`url = ${join(dir, 'nowhere')}`, `uploadpack = ${prog}`],
  'file url with upload-pack': (dir, prog) => [`url = file://${join(dir, 'nowhere')}`, `uploadpack = ${prog}`],
  'ext transport': (_dir, prog) => [`url = ext::${prog}`],
  'remote helper by url': () => ['url = planted::x'],
  'remote helper by vcs': (dir) => [`url = ${join(dir, 'nowhere')}`, 'vcs = planted'],
};

const LOOKUPS = [
  ['cat-file', '-e', MISSING],
  ['cat-file', '-e', `${MISSING}^{commit}`],
  ['merge-base', '--is-ancestor', MISSING, 'HEAD'],
  ['read-tree', MISSING],
];

for (const [name, remote] of Object.entries(REMOTES)) {
  test(`a missing object is missing, and no remote program runs: ${name}`, async (t) => {
    const { repo, env, marker } = promisorRepo(t, remote);
    // Plain git does run the planted program.
    spawnSync('git', ['-C', repo, 'cat-file', '-e', MISSING], { env });
    assert.equal(existsSync(marker), true, 'the plant does not work with plain git');
    rmSync(marker, { force: true });
    for (const args of LOOKUPS) {
      const r = await git(repoContext(repo), args, { env: { GIT_INDEX_FILE: join(repo, '.git', 'scratch-index') } });
      assert.notEqual(r.code, 0, `${args.join(' ')} found an object that is not present`);
      assert.equal(existsSync(marker), false, `${args.join(' ')} ran the remote's program`);
    }
  });
}

test('a caller cannot loosen the no-remote settings through its extra variables', async (t) => {
  const { repo, marker } = promisorRepo(t, REMOTES['upload-pack']);
  const r = await git(repoContext(repo), ['cat-file', '-e', MISSING], { env: { GIT_NO_LAZY_FETCH: '0', GIT_ALLOW_PROTOCOL: 'file' } });
  assert.notEqual(r.code, 0);
  assert.equal(existsSync(marker), false);
});
