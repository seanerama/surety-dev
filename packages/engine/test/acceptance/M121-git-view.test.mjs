// M121, the repository's configuration and hooks; git works through the
// view (M2 slice 12, sandbox lane). M2 plan §3.4 M121; D2 §2.3, §2.7, A.6
// P4, P5 (D2-I04); AR P4, P5; E37 item 5; Q4; SEAM.md §§132, 135, 141.
//
// A role sees the engine's own git metadata at /surety/git and nothing of
// the repository's: its configuration is the engine's (core settings only,
// no include, no hooks path, no helper) and cannot be written, by `git
// config` or by a write at the path git resolves; its hooks directory is
// empty and cannot be written; reads work, `add` works on an index of the
// run's own, `commit` and `update-ref` fail and write no object and no ref;
// the view holds no configuration variant, no `info/`, no other worktree's
// metadata; and what the role edits reaches the checkout only after its
// domain is terminated, where the snapshot commits it as before.
//
// Every target is seeded and read from the host: the repository's real
// `config` (with a value the host's own `git config` set there: the
// control), its real hooks directory (with a hook the host created: the
// control), its objects and refs (`count-objects`, `for-each-ref`).
//
// SAFETY: the two acting probes (a write at the path git resolves for
// `config` and for `hooks`) are guarded: the role program refuses them
// outside a sandbox, and the role is released into them only after the host
// has read that it is contained (SEAM.md §141). On an engine with no git
// view the path git resolves is the fixture repository's own, a test-owned
// directory, and the host-side witness then fails the case.
//
// Every case here is expected to fail on the engine these tests were
// written against, whose /surety/git is empty (COVERAGE.md, "M2 slice 12").

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { sha256Hex } from './harness/engine.mjs';
import { PERMITTED_EDIT, addGitProject, addItem, permittedEdit } from './harness/gitruns.mjs';
import { assertCommitted, changePolicy, operationsOf } from './harness/journal.mjs';
import { addLinkedWorktree, gitQuiet } from './harness/repos.mjs';
import { holdSecret } from './harness/records.mjs';
import { addWork, getRow } from './harness/runs.mjs';
import { eventsOf, sandboxEngine } from './harness/sandbox/lane.mjs';
import { armedRole } from './harness/sandbox/view.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const VIEW = '/surety/git';
const underView = (path) => path === VIEW || path.startsWith(`${VIEW}/`);
// Settings of `core.*` that name a program, a hooks directory or a file for
// git to read: none belongs in the engine's configuration (D2 §2.3, §2.7).
const CORE_FORBIDDEN = ['core.hookspath', 'core.fsmonitor', 'core.sshcommand', 'core.gitproxy', 'core.askpass', 'core.editor', 'core.pager', 'core.alternaterefscommand', 'core.attributesfile', 'core.excludesfile', 'core.worktree'];

const hooksOf = (repo) =>
  Object.fromEntries(
    readdirSync(join(repo, '.git', 'hooks'))
      .sort()
      .map((name) => [name, sha256Hex(readFileSync(join(repo, '.git', 'hooks', name)))]),
  );
const objectsAndRefs = (repo) => ({ objects: gitQuiet(repo, ['count-objects', '-v']), refs: gitQuiet(repo, ['for-each-ref']) });
const gitOf = (entries, ...args) => {
  const found = entries.filter((e) => JSON.stringify(e.args) === JSON.stringify(args));
  assert.equal(found.length, 1, `the role ran git ${args.join(' ')} once (its git steps: ${entries.map((e) => e.args.join(' ')).join(' | ') || 'none'})`);
  return found[0];
};

describe('M121 the repository\'s configuration and hooks; git through the view', () => {
  test('(a) P4: git resolves its config under /surety/git; `git config probe.x y` and a write at that path fail; the list shows only /surety/git/config with core settings, no include, no hooks path, no helper; the repository\'s real config is unchanged; control: the host\'s git config on the fixture succeeds', async (t) => {
    const fx = await sandboxEngine(t);
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    // Control and seeded target: the host sets a value in the real config.
    gitQuiet(repo, ['config', 'probe.seeded', 'set-by-the-host']);
    assert.equal(gitQuiet(repo, ['config', '--get', 'probe.seeded']), 'set-by-the-host', 'control: the host\'s git config on the fixture succeeds');
    const configFile = join(repo, '.git', 'config');
    const before = sha256Hex(readFileSync(configFile));

    const role = await armedRole(fx, project.id, await addWork(fx.engine, project.id, 'verification'), {
      acts: (act) => [step.git('rev-parse', '--git-path', 'config'), step.git('config', 'probe.x', 'y'), act.gitPath('config'), step.git('config', '--list', '--show-origin')],
      thenHold: true,
    });
    await role.release();
    const gits = role.gits();

    const resolved = gitOf(gits, 'rev-parse', '--git-path', 'config');
    assert.equal(resolved.status, 0, `git resolves its config path (${resolved.stderr})`);
    assert.ok(underView(resolve('/surety/workspace', resolved.stdout.trim())), `the path is under ${VIEW} (${resolved.stdout.trim()})`);
    assert.notEqual(gitOf(gits, 'config', 'probe.x', 'y').status, 0, '`git config probe.x y` fails');
    const literal = role.probe('git_path_probe');
    assert.deepEqual([literal.outcome, literal.write?.outcome], ['probed', 'refused'], `a write at the path git resolves is refused (${JSON.stringify(literal)})`);
    assert.ok(underView(literal.resolved), `and that path is under ${VIEW} (${literal.resolved})`);

    const list = gitOf(gits, 'config', '--list', '--show-origin');
    assert.equal(list.status, 0, `the role reads its configuration (${list.stderr})`);
    const lines = list.stdout.split('\n').filter(Boolean).map((line) => {
      const [origin, setting] = line.split('\t');
      return { origin, key: setting.split('=')[0].toLowerCase(), line };
    });
    assert.ok(lines.length > 0, 'the engine\'s configuration holds its core settings');
    for (const l of lines) {
      assert.equal(l.origin, `file:${VIEW}/config`, `the only configuration shown is ${VIEW}/config (${l.line})`);
      assert.match(l.key, /^core\./, `core settings only: no include, no helper, nothing of the repository's (${l.line})`);
      assert.ok(!CORE_FORBIDDEN.includes(l.key), `no setting that names a program, a hooks path or a file (${l.line})`);
    }
    assert.ok(!list.stdout.includes('probe.'), 'neither the host\'s seeded value nor the role\'s own is in it');

    // Host-side witnesses.
    assert.equal(sha256Hex(readFileSync(configFile)), before, 'host-witnessed: the repository\'s real config is unchanged');
    assert.equal(gitQuiet(repo, ['config', '--get-all', 'probe.seeded']), 'set-by-the-host');
    assert.throws(() => gitQuiet(repo, ['config', '--get', 'probe.x']), 'host-witnessed: the role\'s setting is nowhere in the repository');
    await role.stop();
  });

  test('(b) P5: git resolves its hooks path under /surety/git, where there is nothing; creating a hook there fails; the repository\'s real hooks directory is unchanged; control: the host creates a hook in the fixture', async (t) => {
    const fx = await sandboxEngine(t);
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    writeFileSync(join(repo, '.git', 'hooks', 'host-control'), '#!/bin/sh\necho made by the host\n', { mode: 0o755 });
    const before = hooksOf(repo);
    assert.ok('host-control' in before, 'control: the host creates a hook in the fixture\'s real hooks directory');

    const role = await armedRole(fx, project.id, await addWork(fx.engine, project.id, 'verification'), {
      acts: (act) => [step.git('rev-parse', '--git-path', 'hooks'), act.gitPath('hooks', { create: 'pre-commit' })],
      thenHold: true,
    });
    await role.release();
    const resolved = gitOf(role.gits(), 'rev-parse', '--git-path', 'hooks');
    assert.equal(resolved.status, 0, `git resolves its hooks path (${resolved.stderr})`);
    assert.ok(underView(resolve('/surety/workspace', resolved.stdout.trim())), `the hooks path is under ${VIEW} (${resolved.stdout.trim()})`);
    const p = role.probe('git_path_probe');
    assert.equal(p.outcome, 'probed', JSON.stringify(p));
    assert.ok(underView(p.resolved), `the path the role wrote at is under ${VIEW} (${p.resolved})`);
    assert.ok(p.listing === undefined || p.listing.length === 0, `the view's hooks directory is empty (${JSON.stringify(p.listing ?? p.type)})`);
    assert.equal(p.write.outcome, 'refused', `creating a hook there fails (${JSON.stringify(p.write)})`);
    assert.deepEqual(hooksOf(repo), before, 'host-witnessed: the repository\'s real hooks directory is unchanged');
    await role.stop();
  });

  test('(c) status, diff, log and cat-file work; add works on an index of the run\'s own; commit and update-ref fail, and no object and no ref is written (count-objects and for-each-ref on the host unchanged, the checkout\'s own index untouched)', async (t) => {
    const fx = await sandboxEngine(t);
    const project = await addGitProject(fx, { files: { 'tracked.txt': 'as committed\n' } });
    const repo = project.repo.path;
    const role = await armedRole(fx, project.id, await addWork(fx.engine, project.id, 'verification'), {
      after: [
        step.write('tracked.txt', 'as the role changed it\n'),
        step.git('status', '--porcelain'),
        step.git('diff', '--name-only'),
        step.git('log', '-1', '--format=%H'),
        step.git('cat-file', '-p', 'HEAD:tracked.txt'),
        step.git('add', 'tracked.txt'),
        step.git('diff', '--cached', '--name-only'),
        step.git('-c', 'user.name=The Role', '-c', 'user.email=role@surety.invalid', 'commit', '-m', 'a commit of the role\'s own'),
        step.git('update-ref', 'refs/heads/made-by-the-role', 'HEAD'),
        step.git('rev-parse', 'HEAD'),
      ],
      thenHold: true,
    });
    // The host's baseline, with the role's domain alive and none of its git steps taken.
    const checkout = getRow(fx.home, 'workspaces', role.run.workspace).path;
    const indexFile = gitQuiet(checkout, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const before = { ...objectsAndRefs(repo), index: sha256Hex(readFileSync(indexFile)) };
    await role.release();
    const gits = role.gits();

    assert.match(gitOf(gits, 'status', '--porcelain').stdout, /^ M tracked\.txt$/m, 'status reports the role\'s own edit');
    assert.equal(gitOf(gits, 'diff', '--name-only').stdout.trim(), 'tracked.txt', 'diff works');
    assert.equal(gitOf(gits, 'log', '-1', '--format=%H').stdout.trim(), project.base, 'log reads the base commit');
    assert.equal(gitOf(gits, 'cat-file', '-p', 'HEAD:tracked.txt').stdout, 'as committed\n', 'cat-file reads an object');
    assert.equal(gitOf(gits, 'add', 'tracked.txt').status, 0, `add works (${gitOf(gits, 'add', 'tracked.txt').stderr})`);
    assert.equal(gitOf(gits, 'diff', '--cached', '--name-only').stdout.trim(), 'tracked.txt', 'on an index of the run\'s own');
    const commit = gits.find((e) => e.args.includes('commit'));
    assert.ok(commit && commit.status !== 0, `commit fails (status ${commit?.status}: ${commit?.stdout} ${commit?.stderr})`);
    assert.ok(!/tell me who you are|empty ident/i.test(commit.stderr), `and not for want of an identity (${commit.stderr})`);
    assert.notEqual(gitOf(gits, 'update-ref', 'refs/heads/made-by-the-role', 'HEAD').status, 0, 'update-ref fails');
    assert.equal(gitOf(gits, 'rev-parse', 'HEAD').stdout.trim(), project.base, 'HEAD is where it was');

    assert.deepEqual({ ...objectsAndRefs(repo), index: sha256Hex(readFileSync(indexFile)) }, before, 'host-witnessed: no object and no ref was written, and the checkout\'s own index is untouched');
    assert.throws(() => gitQuiet(repo, ['rev-parse', '--verify', 'refs/heads/made-by-the-role']), 'host-witnessed: the role\'s ref does not exist');
    await role.stop();
  });

  test('(d) /surety/git holds no config.worktree, no info/, no hooks content and no other worktree\'s metadata; the workspace\'s .git names /surety/git and no host path', async (t) => {
    const fx = await sandboxEngine(t);
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    // Seeded: the real repository has info/, and another worktree's metadata.
    addLinkedWorktree(repo, join(fx.root, 'developer-worktree'), { branch: 'dev/other' });
    assert.ok(existsSync(join(repo, '.git', 'info')) && readdirSync(join(repo, '.git', 'worktrees')).length >= 1, 'the targets are seeded: the repository has info/ and a developer\'s worktree');

    const role = await armedRole(fx, project.id, await addWork(fx.engine, project.id, 'verification'), {
      before: [step.probe('list_dirs', { paths: [VIEW], recursive: true, skip: ['objects', 'refs'], max: 2000 }), step.probe('read_back', { path: '.git' })],
      thenHold: true,
    });
    await role.release();
    const listing = role.probe('list_dirs').results[0];
    assert.equal(listing.outcome, 'listed', `the role lists ${VIEW} (${listing.error})`);
    const names = listing.entries.map((e) => e.name);
    for (const required of ['config', 'HEAD', 'index', 'objects', 'refs']) assert.ok(names.includes(required), `the view holds ${required} (it holds ${names.filter((n) => !n.includes('/')).join(', ')})`);
    const top = (name) => name.split('/')[0];
    for (const absent of ['config.worktree', 'info', 'worktrees', 'credentials', '.git-credentials', 'modules']) assert.ok(!names.some((n) => top(n) === absent), `the view holds no ${absent}`);
    assert.deepEqual(names.filter((n) => top(n) === 'hooks' && n !== 'hooks'), [], 'no hooks content');
    assert.ok(readdirSync(join(repo, '.git', 'worktrees')).length >= 2, 'host-read: the repository holds the developer\'s worktree metadata beside the run\'s');
    const dotGit = role.probe('read_back');
    assert.equal(dotGit.outcome, 'read', `the workspace has its .git (${dotGit.error})`);
    assert.equal(dotGit.content.trim(), `gitdir: ${VIEW}`, 'which names the view');
    for (const hostPath of [fx.home, repo, fx.root]) assert.ok(!dotGit.content.includes(hostPath), 'and no host path');
    await role.stop();
  });

  test("(e) a role's edit reaches the checkout only after its domain is terminated, and the snapshot commits it (M19's validation unchanged)", async (t) => {
    const fx = await sandboxEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    const role = await armedRole(fx, project.id, item, { before: [permittedEdit(), step.probe('read_back', { path: PERMITTED_EDIT.path })] });
    const checkout = getRow(fx.home, 'workspaces', role.run.workspace).path;
    assert.equal(role.probe('read_back').content, PERMITTED_EDIT.content, 'the fixture is live: the role wrote its edit and reads it back in its workspace');
    assert.equal(existsSync(join(checkout, PERMITTED_EDIT.path)), false, 'host-read, while the role lives: the edit is not in the checkout');
    assert.equal(gitQuiet(checkout, ['status', '--porcelain', '--untracked-files=all']), '', 'host-read: the checkout is as the engine made it');

    await role.release();
    const committed = assertCommitted(fx, role.run.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
    assert.equal(readFileSync(join(checkout, PERMITTED_EDIT.path), 'utf8'), PERMITTED_EDIT.content, 'host-read: after the run, the checkout holds the edit');
    assert.match(committed.sha, /^[0-9a-f]{40}$/);
    // Order, read from event sequence: the domain was terminated before the commit was intended.
    const terminated = eventsOf(fx.home, 'domain', role.domain.id, 'domain.terminated')[0]?.seq ?? null;
    const [commitOp] = operationsOf(fx.home, { run: role.run.id, journalKind: 'commit_tree' });
    const intended = withStore(fx.home, (db) => db.prepare(`SELECT "seq", "subject", "payload" FROM "events" WHERE "type" = 'git.journal_intended' ORDER BY "seq"`).all()).filter((e) => `${e.subject} ${e.payload}`.includes(commitOp.id));
    assert.ok(terminated !== null && intended.length === 1, `one domain.terminated and one intent of the run's commit (terminated ${terminated}, intents ${intended.length})`);
    assert.ok(terminated < intended[0].seq, `the domain was terminated (${terminated}) before the snapshot's commit was intended (${intended[0].seq})`);
  });

  // The slice-12 review's S1 (D2 §2.5; SEAM §135, "Materialization", and the
  // section "Amended after the slice-12 review"): the upper layer is screened
  // for every registered secret before it is materialized, and a path is
  // part of what is materialized. A held secret as a file's name, or as a
  // directory's, refuses the materialization exactly as the same secret in
  // a file's content does (the control, run first on the same engine).
  test('S1 (the slice-12 review): a held secret as a file name and as a directory name refuses the materialization as the secret in a file\'s content does: nothing reaches the checkout or any ref, the run ends as the content control ends', async (t) => {
    const fx = await sandboxEngine(t);
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 0 });
    const secret = `sk-review-secret-${randomBytes(12).toString('hex')}`;
    await holdSecret(fx.engine, 'review/s1/secret', secret);

    const attempt = async (what, steps) => {
      const refsBefore = gitQuiet(repo, ['for-each-ref', '--format=%(refname) %(objectname)']);
      const role = await armedRole(fx, project.id, await addItem(fx, project.id, 'fix'), { before: [...steps, step.write('src/plain.txt', `plain, beside ${what}\n`)] });
      const ended = await role.release();
      const checkout = getRow(fx.home, 'workspaces', role.run.workspace).path;
      return { ended, checkout, refsBefore, refsAfter: gitQuiet(repo, ['for-each-ref', '--format=%(refname) %(objectname)']) };
    };
    const nothingReached = (r, what, paths) => {
      assert.equal(r.refsAfter, r.refsBefore, `${what}: no ref moved and none was made`);
      for (const p of paths) assert.equal(existsSync(join(r.checkout, p)), false, `${what}: host-read, ${p} did not reach the checkout`);
      assert.equal(existsSync(join(r.checkout, 'src/plain.txt')), false, `${what}: nor did anything else of the refused materialization`);
      const named = gitQuiet(repo, ['log', '--all', '--format=', '--name-only']).split('\n').filter((n) => n.includes(secret));
      assert.deepEqual(named, [], `${what}: no commit of any ref names the secret`);
      assert.ok(!r.refsAfter.includes(secret), `${what}: no ref's name holds it`);
    };

    // The control: the secret in a file's content.
    const control = await attempt('the content control', [step.write('src/holds-it.txt', `x ${secret} y\n`)]);
    assert.notEqual(control.ended.outcome, 'completed', `control: the secret in a file's content refuses the run (${control.ended.outcome}/${control.ended.reason_class}: ${control.ended.reason_text})`);
    nothingReached(control, 'control', ['src/holds-it.txt']);

    for (const [what, path] of [
      ['a file named with the secret', `src/${secret}.txt`],
      ['a directory named with the secret', `docs/${secret}/readme.txt`],
    ]) {
      const r = await attempt(what, [step.write(path, 'harmless content\n')]);
      assert.deepEqual(
        [r.ended.outcome, r.ended.reason_class],
        [control.ended.outcome, control.ended.reason_class],
        `${what}: the held secret in a path refuses the materialization as the content control does (D2 §2.5: screened for every registered secret before materialization); the run ended ${r.ended.outcome}/${r.ended.reason_class} (${r.ended.reason_text})`,
      );
      nothingReached(r, what, [path, path.split('/').slice(0, 2).join('/')]);
    }
  });
});
