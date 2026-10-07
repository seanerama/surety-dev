// Developer tests for the reads of registered refs (D3 §5 X1; N02; slice 16
// review m1, m2): a ref git does not list is absent only when its absence is
// verified, and a read across which the registry's generation never held
// still is unread. Against scratch repositories with real git.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { configureGit, repoContext } = await import(join(dist, 'git', 'exec.js'));
const { readRef, readRefs, refAbsent } = await import(join(dist, 'git', 'repo.js'));
const { judgeRefs } = await import(join(dist, 'gates', 'refs.js'));
const { readGateRefs } = await import(join(dist, 'gates', 'prepare.js'));

function scratchRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', repo, 'add', 'a.txt'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'one'], { env });
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 20, home: dir, incarnation: 'inc_unit' });
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
  const g = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
  return { dir, repo, head, g };
}

const REF = 'refs/surety/cand/1';

test('a deleted ref, loose or packed, is verified absent', async (t) => {
  const { repo, head, g } = scratchRepo(t);
  const ctx = repoContext(repo);
  g('update-ref', REF, head);
  assert.deepEqual(await readRef(ctx, REF), { state: 'ok', oid: head });
  g('update-ref', '-d', REF);
  assert.deepEqual(await readRef(ctx, REF), { state: 'missing' });
  g('update-ref', REF, head);
  g('pack-refs', '--all');
  g('update-ref', '-d', REF);
  assert.deepEqual(await readRef(ctx, REF), { state: 'missing' }, 'removed from packed-refs too');
  assert.equal(await refAbsent(ctx, 'refs/../HEAD'), false, 'a name that is not a plain ref is never verified absent');
});

test('a broken loose ref, which for-each-ref skips, is unknown, never absent (m1)', async (t) => {
  const { repo, head, g } = scratchRepo(t);
  const ctx = repoContext(repo);
  g('update-ref', REF, head);
  writeFileSync(join(repo, '.git', REF), 'not an object id\n');
  assert.equal(g('for-each-ref', '--format=%(refname)').includes(REF), false, 'the fixture is live: git skips it and exits 0');
  assert.deepEqual(await readRef(ctx, REF), { state: 'unknown' });
  const read = await readRefs(ctx, [REF, 'refs/heads/main']);
  assert.deepEqual(read.get(REF), { state: 'unknown' });
  assert.deepEqual(read.get('refs/heads/main'), { state: 'ok', oid: head });
  const gen = [{ registry: 'ref_c1', ref: REF, expected: head, moving: [] }];
  assert.deepEqual(judgeRefs(gen, gen, read), [{ fact: { ref: REF, read: 'unread', oid: null }, change: null }], 'judged unread: nothing is recorded as a deletion');
});

test('a ref still named by packed-refs, or whose loose path is not a plain file, is never verified absent (m1)', async (t) => {
  const { repo, head, g } = scratchRepo(t);
  const ctx = repoContext(repo);
  g('update-ref', REF, head);
  g('pack-refs', '--all');
  assert.equal(await refAbsent(ctx, REF), false, 'packed and resolvable');
  g('update-ref', '-d', REF);
  mkdirSync(join(repo, '.git', REF), { recursive: true });
  assert.equal(g('for-each-ref', '--format=%(refname)').includes(REF), false, 'the fixture is live: git lists nothing at that name');
  assert.deepEqual(await readRef(ctx, REF), { state: 'unknown' }, 'a directory where the loose ref would be is not a verified absence');
});

test('a read across which the registry never held still is unread, and nothing is recorded (m2)', async (t) => {
  const { repo, head } = scratchRepo(t);
  let n = 0;
  const engine = [];
  const rt = {
    read: async () => [{ registry: 'ref_main', ref: 'refs/heads/main', expected: `${n++}`.padStart(40, '0'), moving: [] }],
    engine: async (name, args) => engine.push([name, args]),
  };
  assert.deepEqual(await readGateRefs(rt, 'prj_1', 'cand_1', repo), [{ ref: 'refs/heads/main', read: 'unread', oid: null }]);
  assert.deepEqual(engine, [], 'no observation is recorded');
  // A generation that holds still is judged: the head is the expected value.
  const still = { read: async () => [{ registry: 'ref_main', ref: 'refs/heads/main', expected: head, moving: [] }], engine: rt.engine };
  assert.deepEqual(await readGateRefs(still, 'prj_1', 'cand_1', repo), [{ ref: 'refs/heads/main', read: 'value', oid: head }]);
  assert.deepEqual(engine, []);
});
