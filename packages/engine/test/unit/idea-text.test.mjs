import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { configureGit, git, repoContext } from '../../dist/git/exec.js';
import { ideaText, withIdeaText } from '../../dist/projects/idea-text.js';

// First-app gap N4: the project read serves the idea record's text beside its
// blob; text that cannot be read is unknown, with why, never empty.
test("the project read's idea carries the blob's text; an unreadable blob is unknown; a project without an idea is unchanged", async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'idea-text-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home);
  configureGit({ home, incarnation: 'test', deadlineSeconds: 30, outputCap: 1048576 });
  const repo = join(root, 'repo'); mkdirSync(repo);
  assert.equal((await git(repoContext(repo), ['init', '-q', '-b', 'main'])).code, 0);
  const brief = '# Tally\n\nCount the birds in the garden. Ünïcode kept.\n';
  const blob = (await git(repoContext(repo), ['hash-object', '-w', '--stdin'], { input: brief })).stdout.trim();
  assert.match(blob, /^[0-9a-f]{40}$/);

  const served = { version: 1, project: { id: 'proj_1', idea: { version: 1, blob, binding: null, identity: null, history: [] } } };
  const body = await withIdeaText(served, async () => ({ repo }));
  assert.equal(body.project.idea.text, brief, 'the text is the blob, verbatim');
  assert.equal(body.project.idea.blob, blob, 'the rest of the idea is as served');
  assert.equal(body.project.idea.version, 1);

  const missing = 'f'.repeat(40);
  const unknown = await withIdeaText({ project: { idea: { version: 1, blob: missing } } }, async () => ({ repo }));
  assert.match(unknown.project.idea.text.unknown, /could not be read/, 'a blob the repository does not hold is unknown');
  assert.match((await ideaText(null, 'e'.repeat(40))).unknown, /repository is not known/);
  assert.match((await ideaText(repo, 'not-a-blob')).unknown, /no readable blob id/);
  const gone = await withIdeaText({ project: { idea: { version: 1, blob: 'd'.repeat(40) } } }, async () => { throw new Error('store down'); });
  assert.ok(typeof gone.project.idea.text === 'object' && gone.project.idea.text.unknown, 'a repository that cannot be looked up is unknown');

  const none = { project: { id: 'proj_2', idea: null } };
  assert.deepEqual(await withIdeaText(none, async () => { throw new Error('not asked'); }), { project: { id: 'proj_2', idea: null } }, 'no idea record: nothing added');
});
