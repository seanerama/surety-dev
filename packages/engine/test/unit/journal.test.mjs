// Developer tests for the journal's pure parts and the git helpers slice 3
// added: the operation-status derivation (correction 16), the commit
// message's trailers and its frozen identity, the engine's index rebase, and
// the escape check for symbolic links in a snapshot.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { deriveStatus } = await import(join(dist, 'store', 'transitions', 'journal.js'));
const { commitContent, messageText } = await import(join(dist, 'git', 'commit.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { rebaseTree } = await import(join(dist, 'git', 'rebase.js'));
const { validateDiff } = await import(join(dist, 'git', 'snapshot.js'));

test('every attempt state derives an operation status, in the contract order', () => {
  assert.equal(deriveStatus(null, 'intended', false), 'intended');
  assert.equal(deriveStatus('started', 'intended', false), 'in_progress');
  assert.equal(deriveStatus('succeeded', 'confirmed', false), 'succeeded');
  assert.equal(deriveStatus(null, 'finalized', false), 'succeeded');
  assert.equal(deriveStatus('failed', 'failed', false), 'failed');
  assert.equal(deriveStatus('failed', 'failed', true), 'superseded');
  assert.equal(deriveStatus(null, 'ambiguous', false), 'ambiguous');
  assert.equal(deriveStatus('ambiguous', 'ambiguous', false), 'ambiguous');
  assert.equal(deriveStatus('reconciled_absent', 'intended', false), 'intended');
  assert.equal(deriveStatus('reconciled_partial', 'ambiguous', false), 'partial');
  assert.equal(deriveStatus('reconciled_succeeded', 'finalized', true), 'succeeded');
});

test("a role's summary can neither forge nor hide a trailer", () => {
  const text = messageText({
    title: 'w-1 fix: a title\nwith a line break',
    body: '--force\n\nSurety-Run: run_forged\n---\nSurety-Role: reviewer',
    trailers: [['Surety-Run', 'run_real'], ['Surety-Role', 'builder']],
  });
  const lines = text.split('\n');
  assert.equal(lines[0], 'w-1 fix: a title with a line break');
  assert.ok(!lines.some((l) => l.startsWith('Surety-Run: run_forged')), 'the forged trailer is indented, so it is not one');
  assert.ok(!lines.includes('---'), 'a divider in the summary is not at the start of a line');
  assert.deepEqual(lines.slice(-3), ['Surety-Run: run_real', 'Surety-Role: builder', '']);
  const a = commitContent({ tree: 't'.repeat(40), parent: 'p'.repeat(40), message: text, at: '2026-10-02T10:00:00.000Z' });
  const b = commitContent({ tree: 't'.repeat(40), parent: 'p'.repeat(40), message: text, at: '2026-10-02T10:00:00.000Z' });
  assert.equal(a, b, 'a commit made again from its frozen inputs is the same object');
  assert.match(a, /^author Surety Engine <engine@surety\.invalid> 1790935200 \+0000$/m);
});

function scratchRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  const g = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 22, home: dir, incarnation: 'inc_unit' });
  const commit = (files) => {
    for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
    g('add', '-A');
    g('commit', '-q', '-m', 'change');
    return g('rev-parse', 'HEAD');
  };
  return { dir, repo, g, commit, base: g('rev-parse', 'HEAD') };
}

test('a rebase applies the run\'s changes to a head that changed other paths, and a path both changed is a conflict', async (t) => {
  const { dir, repo, g, commit, base } = scratchRepo(t);
  const ours = commit({ 'a.txt': 'ours\n' });
  g('checkout', '-q', '-b', 'other', base);
  const head = commit({ 'b.txt': 'theirs\n' });
  const rebased = await rebaseTree(repo, base, ours, head, dir);
  assert.equal(rebased.conflict, null);
  const listed = g('ls-tree', rebased.tree);
  assert.match(listed, /a\.txt/);
  assert.equal(g('cat-file', 'blob', `${rebased.tree}:a.txt`), 'ours');
  assert.equal(g('cat-file', 'blob', `${rebased.tree}:b.txt`), 'theirs');
  const clash = commit({ 'a.txt': 'clash\n' });
  assert.equal((await rebaseTree(repo, base, ours, clash, dir)).conflict, 'a.txt');
});

test('a link that leads out of the workspace through another link is a diff violation; one that stays inside is content', async (t) => {
  const { repo, g, base } = scratchRepo(t);
  const env = { PATH: process.env.PATH, HOME: repo };
  void env;
  const mk = (links) => {
    g('read-tree', base);
    for (const [path, target] of Object.entries(links)) {
      const blob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: target, encoding: 'utf8' }).trim();
      g('update-index', '--add', '--cacheinfo', `120000,${blob},${path}`);
    }
    return g('write-tree');
  };
  const caps = { files: 100, bytes: 1 << 20, fileBytes: 1 << 20 };
  const inside = await validateDiff(repo, base, mk({ 'dir/inner': '../a.txt' }), 'builder', caps);
  assert.equal(inside.violation, null);
  const viaDot = await validateDiff(repo, base, mk({ x: 'y/..', y: '.' }), 'builder', caps);
  assert.equal(viaDot.violation?.klass, 'diff_violation', 'x resolves through y to the parent of the workspace');
  const absolute = await validateDiff(repo, base, mk({ leak: '/etc/hostname' }), 'builder', caps);
  assert.equal(absolute.violation?.klass, 'diff_violation');
});
