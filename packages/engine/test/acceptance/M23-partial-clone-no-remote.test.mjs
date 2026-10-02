// M23, engine git never contacts a remote and never runs a program a
// remote's configuration names (the slice-4 review; E37 item 1; listed under
// slice 4). Plan §3.3 M23; D1 §7.1; E25 item 3; E29 item 1; SEAM.md §31
// ("No remote").
//
// A partial clone holds commits and trees and leaves blobs with its remote:
// ordinary git, asked for an object that is not there, fetches it, and runs
// whatever program the repository's configuration names as the remote's
// upload-pack. The Reviewer showed the slice-4 engine doing exactly that
// when it created a workspace. The rule that engine git runs no repository
// code covers it: for the engine an object that is not present is missing.
// A partial clone is therefore not supported in M1, like a repository that
// needs a filter driver; where every object a run needs is present, the run
// goes its ordinary course.
//
// One case, on one blob-less clone (`git clone --filter=blob:none`). It
// first shows, with ordinary git on the same fixture, that git runs the
// planted program and fetches. Then the base of a run lacks a blob: the
// engine neither runs the program nor fetches, so the workspace cannot be
// made and the run fails unlaunched, as on any repository with that object
// missing. The developer then supplies the blob by hand, and the repair goes
// through workspace creation, snapshot, commit and integration with the
// program still never run and the blob the history lacks still absent.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import { installProject } from './harness/engine.mjs';
import { git, gitEnv } from './harness/git.mjs';
import { addItem, roleThat, runToEnd } from './harness/gitruns.mjs';
import { assertCommitted } from './harness/journal.mjs';
import { fileAt, gitQuiet, readEvidence, refOid } from './harness/repos.mjs';
import { assertRunEnded, runsOf, scriptedEngine, tick, tickOnce, waitForIdle, waitForRun } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

// A commit on the origin's branch holding `files`; returns its id.
function commitAtOrigin(origin, files, message) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(origin, path)), { recursive: true });
    writeFileSync(join(origin, path), content);
  }
  git(origin, ['add', '-A']);
  git(origin, ['commit', '-q', '-m', message]);
  return git(origin, ['rev-parse', 'HEAD']);
}

// The objects reachable from `rev` that the repository does not hold, sorted.
// `--missing=print` lists them and fetches nothing.
const absentObjects = (repo, rev) =>
  gitQuiet(repo, ['rev-list', '--objects', '--missing=print', rev])
    .split('\n')
    .filter((line) => line.startsWith('?'))
    .map((line) => line.slice(1))
    .sort();

// The file the integration branch's last commit adds, whose blob the clone does not fetch.
const LATE_CONTENT = 'content only the origin has\n';

describe("M23 engine git never contacts a remote, and runs no program a remote's configuration names", () => {
  test('a blob-less partial clone: the program named as its remote\'s upload-pack is never run and nothing is fetched; a base with a blob absent gives no workspace and no launch; with the blob present the run is committed and integrated', async (t) => {
    const fx = await scriptedEngine(t);

    // The origin, and a blob-less clone of it: the clone holds every commit
    // and tree, and only the blobs its own checkout needed.
    const origin = join(fx.root, 'origin');
    mkdirSync(origin);
    execFileSync('git', ['init', '-q', '-b', 'main', origin], { env: gitEnv(origin) });
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    commitAtOrigin(origin, { 'README.md': '# fixture\n', 'notes.txt': 'notes, first version\n' }, 'origin: one');
    commitAtOrigin(origin, { 'notes.txt': 'notes, second version\n' }, 'origin: two');
    commitAtOrigin(origin, { 'notes.txt': 'notes, third version\n' }, 'origin: three');
    const repo = join(fx.root, 'repo-partial');
    execFileSync('git', ['clone', '-q', '--filter=blob:none', `file://${origin}`, repo], { env: gitEnv(fx.root) });
    git(repo, ['checkout', '-q', '--detach', 'HEAD']);
    // A later commit, fetched as a partial clone fetches: without its new
    // blob. The integration branch is moved to it before the project exists.
    const base = commitAtOrigin(origin, { 'data/late.txt': LATE_CONTENT }, 'origin: four');
    git(repo, ['fetch', '-q', 'origin']);
    git(repo, ['update-ref', 'refs/heads/main', base]);
    const blob = (rev) => git(origin, ['rev-parse', rev]);
    const [first, second, late] = [blob('main~3:notes.txt'), blob('main~2:notes.txt'), blob('main:data/late.txt')];
    assert.deepEqual(absentObjects(repo, base), [first, second, late].sort(), 'the fixture: the clone lacks two blobs of its history and one of its branch');

    // The program the repository's configuration names as the remote's
    // upload-pack: it leaves a line of evidence, then serves the fetch as the
    // real one would, so that a fetch through it succeeds.
    const evidence = join(fx.root, 'upload-pack-evidence.txt');
    const program = join(fx.root, 'planted-remote', 'upload-pack');
    mkdirSync(join(fx.root, 'planted-remote'));
    writeFileSync(program, `#!/bin/sh\necho "upload-pack ran: pid $$, run by: $(tr '\\0' ' ' < /proc/$PPID/cmdline)" >> '${evidence}'\nexec git upload-pack "$@"\n`);
    chmodSync(program, 0o755);
    git(repo, ['config', 'remote.origin.uploadpack', program]);

    // The fixture is live: ordinary git, asked for an object that is not there, runs the program and fetches the object.
    gitQuiet(repo, ['cat-file', '-e', first]);
    assert.ok((readEvidence(evidence) ?? '').includes('upload-pack ran'), `ordinary git runs the planted upload-pack program for an absent object (evidence: ${readEvidence(evidence)})`);
    assert.deepEqual(absentObjects(repo, base), [second, late].sort(), 'and fetches the object through it');
    rmSync(evidence);

    // The base lacks a blob. The engine does not fetch it: the workspace cannot be made.
    const project = await installProject(fx.engine, { repoPath: repo });
    const item = await addItem(fx, project, 'fix');
    const files = { 'src/added.txt': 'added by the Builder\n', 'notes.txt': 'notes, as the Builder left them\n' };
    fx.scripted.script(item, [roleThat(Object.entries(files).map(([path, content]) => step.write(path, content)))]);
    await tickOnce(fx.engine, project);
    const refused = await waitForRun(fx.home, item, { state: 'ended' });
    await waitForIdle(fx.home, project);
    assert.ok(readEvidence(evidence) === null, `engine git ran the program the repository's configuration names as its remote's upload-pack:\n${readEvidence(evidence)}`);
    assert.deepEqual(absentObjects(repo, base), [second, late].sort(), 'the engine fetched nothing: the objects that were not there are still not there');
    assertRunEnded(fx.home, refused.id, { outcome: 'failed', reason_class: 'infra_error', launched: false });
    assert.equal(fx.scripted.launches().length, 0, 'no role was launched on a base that could not be checked out whole');
    assert.equal(refOid(repo, 'refs/heads/main'), base, 'the integration branch is where it was');

    // The developer supplies the blob by hand: written into the object store, with no fetch.
    assert.equal(gitQuiet(repo, ['hash-object', '-w', '--stdin'], { input: LATE_CONTENT }), late);
    assert.deepEqual(absentObjects(repo, base), [second], 'the base is whole now; a blob of the history is still absent');
    assert.ok(readEvidence(evidence) === null, 'supplying the blob by hand ran no program');

    // The repair's whole course: workspace, snapshot, commit, ref update, and two ticks with their integrity step.
    const run = await runToEnd(fx, project, item, { index: runsOf(fx.home, item).length });
    for (let i = 0; i < 2; i++) await tick(fx.engine, project);
    await waitForIdle(fx.home, project);
    assert.ok(readEvidence(evidence) === null, `engine git ran the program the repository's configuration names as its remote's upload-pack:\n${readEvidence(evidence)}`);
    assert.deepEqual(absentObjects(repo, base), [second], 'the engine fetched nothing: the blob the history lacks is still absent');
    // The evidence was read before this: assertCommitted runs the test's own git in the workspace.
    const committed = assertCommitted(fx, run.id, { kind: 'engine_commit', parent: base, integrated: true });
    for (const [path, content] of Object.entries(files)) assert.equal(fileAt(repo, committed.sha, path), content, `${path} is committed as the role left it`);
  });
});
