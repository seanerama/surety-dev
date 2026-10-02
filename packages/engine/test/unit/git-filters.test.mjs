// Developer tests for E33 item 1: engine git runs no filter driver planted in
// a repository's configuration, however the configuration spells it. Each
// case plants a driver whose clean command creates a marker file, shows with
// plain git that the plant works, and then runs the engine's git over the
// same files: the marker must not appear.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { configureGit, git, repoContext, worktreeContext } = await import(join(dist, 'git', 'exec.js'));

function scratchRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-filters-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', repo, 'add', 'a.txt'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'one'], { env });
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 20, home: dir, incarnation: 'inc_unit' });
  return { dir, repo, env };
}

// What runs when the driver runs: it leaves a marker, and passes content through.
const program = (marker) => `"sh -c 'touch ${marker}; cat'"`;

// Plain git, as anyone would run it, does run the planted driver.
function plainGitRuns(cwd, env, marker) {
  rmSync(marker, { force: true });
  execFileSync('git', ['hash-object', 'a.txt'], { cwd, env });
  const ran = existsSync(marker);
  rmSync(marker, { force: true });
  return ran;
}

async function engineGitRuns(ctx, scratch, marker) {
  rmSync(marker, { force: true });
  const hashed = await git(ctx, ['hash-object', 'a.txt']);
  assert.equal(hashed.code, 0, `engine git hash-object: ${hashed.stderr}`);
  const added = await git(ctx, ['add', '-A'], { env: { GIT_INDEX_FILE: join(scratch, 'index') } });
  assert.equal(added.code, 0, `engine git add: ${added.stderr}`);
  return existsSync(marker);
}

const SPELLINGS = {
  'an old-style section name in capitals': (repo, marker) => {
    appendFileSync(join(repo, '.git', 'config'), `[filter.EVIL]\n\tclean = ${program(marker)}\n`);
    return 'evil';
  },
  'two section headers on one line': (repo, marker) => {
    appendFileSync(join(repo, '.git', 'config'), `[core] [filter "evil"]\n\tclean = ${program(marker)}\n`);
    return 'evil';
  },
  'an include written on one line': (repo, marker) => {
    writeFileSync(join(repo, '.git', 'other.cfg'), `[filter "evil"]\n\tclean = ${program(marker)}\n`);
    appendFileSync(join(repo, '.git', 'config'), '[include] path = other.cfg\n');
    return 'evil';
  },
  'an included file behind a symbolic link': (repo, marker) => {
    const real = join(dirname(repo), 'elsewhere.cfg');
    writeFileSync(real, `[filter "evil"]\n\tclean = ${program(marker)}\n`);
    symlinkSync(real, join(repo, '.git', 'linked.cfg'));
    appendFileSync(join(repo, '.git', 'config'), '[include]\n\tpath = linked.cfg\n');
    return 'evil';
  },
};

for (const [spelling, plant] of Object.entries(SPELLINGS)) {
  test(`engine git runs no filter driver planted as ${spelling}`, async (t) => {
    const { dir, repo, env } = scratchRepo(t);
    const marker = join(dir, 'filter-ran');
    const driver = plant(repo, marker);
    writeFileSync(join(repo, '.gitattributes'), `* filter=${driver}\n`);
    assert.equal(plainGitRuns(repo, env, marker), true, 'the plant works: plain git runs the driver');
    assert.equal(await engineGitRuns(repoContext(repo), dir, marker), false, 'engine git did not run it');
  });
}

test('engine git runs no filter driver a worktree defines in its own config.worktree', async (t) => {
  const { dir, repo, env } = scratchRepo(t);
  const marker = join(dir, 'filter-ran');
  const ws = join(dir, 'ws');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', ws, 'HEAD'], { env });
  execFileSync('git', ['-C', repo, 'config', 'extensions.worktreeConfig', 'true'], { env });
  const admin = join(repo, '.git', 'worktrees', 'ws');
  writeFileSync(join(admin, 'config.worktree'), `[filter "Sneaky"]\n\tclean = ${program(marker)}\n`);
  writeFileSync(join(ws, '.gitattributes'), '* filter=Sneaky\n');
  assert.equal(plainGitRuns(ws, env, marker), true, 'the plant works: plain git runs the driver');
  assert.equal(await engineGitRuns(worktreeContext(repo, admin, ws), dir, marker), false, 'engine git did not run it');
});

test('a configuration git cannot read stops the command instead of running it unprotected', async (t) => {
  const { repo } = scratchRepo(t);
  appendFileSync(join(repo, '.git', 'config'), '[filter "broken\n');
  const r = await git(repoContext(repo), ['rev-parse', 'HEAD']);
  assert.notEqual(r.code, 0);
});
