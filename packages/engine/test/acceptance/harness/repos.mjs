// Repositories for the slice-3 rows (Plan §2, resource G; SEAM.md §§25, 30):
// fixture repositories in the topologies the git rows need, what a
// repository and a checkout hold (for "nothing moved" and "the developer's
// files were left alone"), an independent computation of a workspace's
// snapshot tree, and the ways a test makes a repository hostile, unreadable
// or slow. Everything here is test-side git, run with a constructed
// environment and with nothing a fixture repository configures switched on.

import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { sha256Hex } from './engine.mjs';
import { git, gitEnv } from './git.mjs';

// Test-side git that runs nothing a repository configures: no hook, no
// file-system monitor. Used wherever a fixture has planted such things.
const QUIET = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
export const gitQuiet = (repo, args, opts = {}) =>
  execFileSync('git', [...QUIET, '-C', repo, ...args], { env: { ...gitEnv(repo), ...(opts.env ?? {}) }, encoding: 'utf8', input: opts.input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

// A project repository. One commit on `branch` holding README.md and
// `files`. `primary` says what the repository's own work tree, the
// developer's, has checked out afterwards:
//   'detached'    nothing: HEAD is detached at that commit. The integration
//                 branch is checked out nowhere, which is the supported
//                 topology (build spec §6 correction 6; Plan §2);
//   'other'       a developer branch, `developer`, at that commit;
//   'integration' the integration branch itself.
export function makeProjectRepo(dir, { branch = 'main', primary = 'detached', files = {}, developer = 'dev/work' } = {}) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', branch, dir], { env: gitEnv(dir) });
  writeFiles(dir, { 'README.md': '# fixture\n', ...files });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture: initial commit']);
  const head = git(dir, ['rev-parse', 'HEAD']);
  if (primary === 'detached') git(dir, ['checkout', '-q', '--detach', head]);
  else if (primary === 'other') git(dir, ['checkout', '-q', '-b', developer]);
  else if (primary !== 'integration') throw new Error(`unknown primary checkout ${primary}`);
  return { path: dir, branch, head, ref: `refs/heads/${branch}` };
}

// A linked worktree of the repository, the developer's: on `branch` (created
// at `at` if it does not exist) or detached at `at`.
export function addLinkedWorktree(repo, dir, { branch, at = 'HEAD' } = {}) {
  if (branch === undefined) gitQuiet(repo, ['worktree', 'add', '-q', '--detach', dir, at]);
  else if (refOid(repo, `refs/heads/${branch}`) === null) gitQuiet(repo, ['worktree', 'add', '-q', '-b', branch, dir, at]);
  else gitQuiet(repo, ['worktree', 'add', '-q', dir, branch]);
  return dir;
}

export const refOid = (repo, ref) => {
  try {
    return gitQuiet(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    return null;
  }
};

// A commit made with plumbing, the way a developer's push or a second clone
// would move a branch: no checkout is touched. `files` are added to or
// replaced in the tree of `parent` (default: the ref's commit). Returns the
// commit id. With `ref` null the commit is made and no ref is moved.
export function commitOnRef(repo, ref, files, { message = 'developer: a commit', parent } = {}) {
  const base = parent ?? refOid(repo, ref);
  const index = join(repo, '.git', `fixture-index-${process.hrtime.bigint()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if (base) gitQuiet(repo, ['read-tree', base], { env });
    for (const [path, content] of Object.entries(files)) {
      const blob = gitQuiet(repo, ['hash-object', '-w', '--stdin'], { input: content });
      gitQuiet(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
    }
    const tree = gitQuiet(repo, ['write-tree'], { env });
    const commit = gitQuiet(repo, ['commit-tree', tree, ...(base ? ['-p', base] : []), '-m', message]);
    if (ref !== null) gitQuiet(repo, ['update-ref', ref, commit]);
    return commit;
  } finally {
    rmSync(index, { force: true });
  }
}

// ---- what a repository holds ------------------------------------------------------

export const treeOf = (repo, rev) => gitQuiet(repo, ['rev-parse', '--verify', `${rev}^{tree}`]);
export const parentsOf = (repo, rev) => gitQuiet(repo, ['rev-list', '--parents', '-n', '1', rev]).split(' ').slice(1);
export const messageOf = (repo, rev) => gitQuiet(repo, ['log', '-1', '--format=%B', rev]);
export const identityOf = (repo, rev) => gitQuiet(repo, ['log', '-1', '--format=%an|%ae|%cn|%ce', rev]);
export const isAncestor = (repo, ancestor, descendant) => {
  try {
    gitQuiet(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
};

// Every ref of the repository with its object: {refname: oid}.
export function refsOf(repo) {
  const out = {};
  for (const line of gitQuiet(repo, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n')) {
    if (line === '') continue;
    const [name, oid] = line.split(' ');
    out[name] = oid;
  }
  return out;
}

// The refs from which a commit can be reached.
export const refsContaining = (repo, rev) =>
  gitQuiet(repo, ['for-each-ref', '--contains', rev, '--format=%(refname)'])
    .split('\n')
    .filter((line) => line !== '');

// The tree of a revision as {path: "<mode> <type> <object>"}, every level.
export function listTree(repo, rev) {
  const out = {};
  for (const entry of gitQuiet(repo, ['ls-tree', '-r', '-z', '--full-tree', rev]).split('\0')) {
    if (entry === '') continue;
    const tab = entry.indexOf('\t');
    out[entry.slice(tab + 1)] = entry.slice(0, tab);
  }
  return out;
}

// What changed between two revisions as {path: status}, status one of
// A (added), M (modified), D (deleted), T (type changed); renames are shown
// as a deletion and an addition.
export function changedPaths(repo, from, to) {
  const out = {};
  const fields = gitQuiet(repo, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to]).split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i + 1]] = fields[i];
  return out;
}

export const fileAt = (repo, rev, path) => execFileSync('git', [...QUIET, '-C', repo, 'cat-file', 'blob', `${rev}:${path}`], { env: gitEnv(repo), encoding: 'utf8' });

// The trailers of a commit message as {key: [values]}.
export function trailersOf(repo, rev) {
  const out = {};
  const text = execFileSync('git', [...QUIET, '-C', repo, 'interpret-trailers', '--parse'], { env: gitEnv(repo), encoding: 'utf8', input: messageOf(repo, rev) });
  for (const line of text.split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    (out[line.slice(0, at)] ??= []).push(line.slice(at + 1).trim());
  }
  return out;
}

// Everything about a repository that an engine operation which must have no
// effect on it must leave as it was: every ref, the worktrees it lists, and
// its configuration and hooks.
export function repoFingerprint(repo) {
  const gitDir = join(repo, '.git');
  const hooks = existsSync(join(gitDir, 'hooks')) ? readdirSync(join(gitDir, 'hooks')).sort() : [];
  return {
    refs: refsOf(repo),
    worktrees: gitQuiet(repo, ['worktree', 'list', '--porcelain']),
    config: sha256Hex(readFileSync(join(gitDir, 'config'))),
    hooks: hooks.map((name) => `${name} ${sha256Hex(readFileSync(join(gitDir, 'hooks', name)))}`),
  };
}

// Every entry under a directory, `.git` left out: files with their mode's
// executable bit and content hash, symbolic links with their target.
function listFiles(dir) {
  const out = {};
  const walk = (d, prefix) => {
    for (const name of readdirSync(d).sort()) {
      if (prefix === '' && name === '.git') continue;
      const path = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(path);
      if (st.isSymbolicLink()) out[rel] = `link ${readlinkSync(path)}`;
      else if (st.isDirectory()) walk(path, rel);
      else out[rel] = `${st.mode & 0o100 ? 'x' : '-'} ${sha256Hex(readFileSync(path))}`;
    }
  };
  walk(dir, '');
  return out;
}

// What a developer's checkout holds: its HEAD, the branch it is on (null if
// detached), its index, and every file in it. An engine that leaves a
// checkout alone leaves all of this as it was.
export function checkoutState(dir) {
  const gitDir = gitQuiet(dir, ['rev-parse', '--absolute-git-dir']);
  let branch = null;
  try {
    branch = gitQuiet(dir, ['symbolic-ref', '-q', 'HEAD']);
  } catch {
    // detached
  }
  return {
    head: gitQuiet(dir, ['rev-parse', 'HEAD']),
    branch,
    index: existsSync(join(gitDir, 'index')) ? sha256Hex(readFileSync(join(gitDir, 'index'))) : null,
    staged: gitQuiet(dir, ['diff-index', '--cached', '--name-status', 'HEAD']),
    files: listFiles(dir),
  };
}

// The tree a snapshot of a workspace must be (D1 §7.3; SEAM.md §28), computed
// here and not read from the engine: everything in the work tree that
// `git add -A` takes, in an index of its own that started as the tree of
// `base`. No hook, monitor or filter of the repository takes part. The
// workspace's own index and HEAD are not touched.
export function snapshotTree(workspace, base) {
  const gitDir = gitQuiet(workspace, ['rev-parse', '--absolute-git-dir']);
  const index = join(gitDir, `fixture-snapshot-index-${process.hrtime.bigint()}`);
  const env = { GIT_INDEX_FILE: index, GIT_ATTR_NOSYSTEM: '1' };
  const run = (args) => execFileSync('git', [...QUIET, ...noFilters(workspace), '--git-dir', gitDir, '--work-tree', workspace, ...args], { env: { ...gitEnv(workspace), ...env }, encoding: 'utf8' }).trim();
  try {
    run(['read-tree', base]);
    run(['add', '-A']);
    return run(['write-tree']);
  } finally {
    rmSync(index, { force: true });
  }
}

// `-c` arguments that switch off every filter driver the repository's
// configuration names (clean, smudge and process), for test-side git.
function noFilters(repo) {
  let names = [];
  try {
    names = execFileSync('git', ['-C', repo, 'config', '--name-only', '--get-regexp', '^filter\\.'], { env: gitEnv(repo), encoding: 'utf8' })
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split('.').slice(1, -1).join('.'));
  } catch {
    // no filter configured
  }
  return [...new Set(names)].flatMap((name) => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`]);
}

// ---- making a repository hostile, unreadable or slow ------------------------------

// A program that leaves a line of evidence each time it runs, then copies its
// standard input to its standard output (so it can stand in for a filter)
// and exits 0. `label` says in the evidence which program it was.
export function evidenceProgram(file, evidence, label) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\necho "${label} ran: pid $$ in $(pwd), run by: $(tr '\\0' ' ' < /proc/$PPID/cmdline)" >> '${evidence}'\ncat 2>/dev/null\nexit 0\n`);
  chmodSync(file, 0o755);
  return file;
}

export const readEvidence = (evidence) => (existsSync(evidence) ? readFileSync(evidence, 'utf8').trim() : null);

// Every hook git can run in a repository on the calls the engine makes or
// could make, planted in the repository's hooks directory.
export const ALL_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-auto-gc',
  'post-rewrite',
  'reference-transaction',
  'post-index-change',
  'update',
  'push-to-checkout',
];
export function plantAllHooks(repo, evidence) {
  const hooks = join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const name of ALL_HOOKS) {
    writeFileSync(join(hooks, name), `#!/bin/sh\necho "hook ${name} ran: pid $$ in $(pwd), run by: $(tr '\\0' ' ' < /proc/$PPID/cmdline)" >> '${evidence}'\nexit 0\n`);
    chmodSync(join(hooks, name), 0o755);
  }
}

// A filter driver named in the repository's own configuration, with a clean,
// a smudge and a long-running process program, and a committed
// .gitattributes that applies it to `pattern`. Returns the commit that adds
// the attributes file to `ref`.
export function plantFilter(repo, ref, evidence, { dir, name = 'planted', pattern = '*.dat' }) {
  const clean = evidenceProgram(join(dir, 'filter-clean'), evidence, 'filter clean');
  const smudge = evidenceProgram(join(dir, 'filter-smudge'), evidence, 'filter smudge');
  // A process filter speaks a protocol; this one leaves its evidence and
  // exits, which is enough to show it was started.
  const proc = join(dir, 'filter-process');
  writeFileSync(proc, `#!/bin/sh\necho "filter process ran: pid $$ in $(pwd), run by: $(tr '\\0' ' ' < /proc/$PPID/cmdline)" >> '${evidence}'\nexit 1\n`);
  chmodSync(proc, 0o755);
  gitQuiet(repo, ['config', `filter.${name}.clean`, clean]);
  gitQuiet(repo, ['config', `filter.${name}.smudge`, smudge]);
  return { clean, smudge, process: proc, name, commit: commitOnRef(repo, ref, { '.gitattributes': `${pattern} filter=${name}\n`, 'data/seed.dat': 'seed\n' }, { message: 'fixture: a filter attribute' }) };
}

// The other programs a repository's configuration can name for git to run on
// calls of the kinds the engine makes: an external diff program, a textconv
// program, a signing program (with signing switched on for commits and
// tags), an editor and a pager.
export function plantConfiguredPrograms(repo, evidence, { dir }) {
  const program = (label) => evidenceProgram(join(dir, label.replace(/[^a-z]/g, '-')), evidence, label);
  gitQuiet(repo, ['config', 'diff.external', program('diff.external')]);
  gitQuiet(repo, ['config', 'diff.planted.textconv', program('textconv')]);
  gitQuiet(repo, ['config', 'diff.planted.command', program('diff driver command')]);
  gitQuiet(repo, ['config', 'gpg.program', program('gpg.program')]);
  gitQuiet(repo, ['config', 'commit.gpgsign', 'true']);
  gitQuiet(repo, ['config', 'tag.gpgsign', 'true']);
  gitQuiet(repo, ['config', 'core.editor', program('core.editor')]);
  gitQuiet(repo, ['config', 'sequence.editor', program('sequence.editor')]);
  gitQuiet(repo, ['config', 'core.pager', program('core.pager')]);
}

// Environment variables that, inherited by a git child, would point it at
// another repository, another identity or a program of someone's choosing
// (D1 §7.1; D1-07). `decoy` is a repository none of the engine's projects
// uses; `dir` holds the programs and the hostile global configuration.
export function hostileEnvironment({ decoy, dir, evidence }) {
  const program = (label) => evidenceProgram(join(dir, label.replace(/[^A-Za-z]/g, '-')), evidence, label);
  const hooks = join(dir, 'ambient-hooks');
  mkdirSync(hooks, { recursive: true });
  for (const name of ['reference-transaction', 'post-index-change', 'post-checkout']) {
    writeFileSync(join(hooks, name), `#!/bin/sh\necho "ambient hook ${name} ran: pid $$" >> '${evidence}'\nexit 0\n`);
    chmodSync(join(hooks, name), 0o755);
  }
  const globalConfig = join(dir, 'ambient-gitconfig');
  writeFileSync(globalConfig, `[core]\n\thooksPath = ${hooks}\n\tfsmonitor = ${program('ambient core.fsmonitor')}\n[user]\n\tname = Ambient Config\n\temail = ambient-config@hostile.invalid\n`);
  return {
    GIT_DIR: join(decoy, '.git'),
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: join(decoy, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: join(decoy, '.git', 'objects'),
    GIT_COMMON_DIR: join(decoy, '.git'),
    GIT_NAMESPACE: 'hostile',
    GIT_CEILING_DIRECTORIES: '/',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooks,
    GIT_CONFIG_KEY_1: 'user.name',
    GIT_CONFIG_VALUE_1: 'Ambient Count',
    GIT_AUTHOR_NAME: 'Ambient Author',
    GIT_AUTHOR_EMAIL: 'ambient-author@hostile.invalid',
    GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Ambient Committer',
    GIT_COMMITTER_EMAIL: 'ambient-committer@hostile.invalid',
    GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
    GIT_EDITOR: program('GIT_EDITOR'),
    GIT_SEQUENCE_EDITOR: program('GIT_SEQUENCE_EDITOR'),
    EDITOR: program('EDITOR'),
    VISUAL: program('VISUAL'),
    GIT_PAGER: program('GIT_PAGER'),
    PAGER: program('PAGER'),
    GIT_EXTERNAL_DIFF: program('GIT_EXTERNAL_DIFF'),
    GIT_SSH: program('GIT_SSH'),
    GIT_SSH_COMMAND: program('GIT_SSH_COMMAND'),
    GIT_ASKPASS: program('GIT_ASKPASS'),
    SSH_ASKPASS: program('SSH_ASKPASS'),
    GIT_PROXY_COMMAND: program('GIT_PROXY_COMMAND'),
    GIT_EXEC_PATH: join(dir, 'no-such-exec-path'),
    GIT_TEMPLATE_DIR: join(dir, 'ambient-template'),
    GH_REPO: 'hostile/elsewhere',
    GH_HOST: 'hostile.invalid',
    GH_TOKEN: 'ghp_hostileAmbientTokenThatMustNotBeUsed',
    GITHUB_TOKEN: 'ghp_anotherHostileAmbientToken',
    GH_EDITOR: program('GH_EDITOR'),
  };
}
export const HOSTILE_IDENTITIES = ['Ambient Author', 'Ambient Committer', 'Ambient Config', 'Ambient Count', 'hostile.invalid'];

// Make a repository unreadable: git can no longer open its directory. As
// root a mode does not keep anyone out, so there the directory is moved
// away instead. Returns the function that restores access.
export function makeUnreadable(repo) {
  const gitDir = join(repo, '.git');
  if (process.getuid() !== 0) {
    const mode = statSync(gitDir).mode & 0o7777;
    chmodSync(gitDir, 0o000);
    return () => chmodSync(gitDir, mode);
  }
  const away = `${gitDir}.unreadable`;
  renameSync(gitDir, away);
  return () => renameSync(away, gitDir);
}

// Hold every git call on a repository open: its configuration file is
// replaced by a named pipe that nobody writes to, so a git process that
// reads the repository's configuration, which every one does, waits. The
// returned function puts the configuration back, once: a call that is still
// waiting at the pipe is given the configuration through it and goes on;
// one that was killed meanwhile is simply gone. No test-side git may touch
// the repository while it is held.
export function holdGit(repo) {
  const config = join(repo, '.git', 'config');
  const saved = readFileSync(config);
  rmSync(config);
  execFileSync('mkfifo', [config]);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    try {
      // Opening for writing without blocking succeeds only if a reader waits.
      const fd = openSync(config, constants.O_WRONLY | constants.O_NONBLOCK);
      writeSync(fd, saved);
      closeSync(fd);
    } catch {
      // nobody is waiting at the pipe
    }
    rmSync(config, { force: true });
    writeFileSync(config, saved);
  };
}
