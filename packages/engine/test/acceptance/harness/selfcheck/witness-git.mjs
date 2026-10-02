// The git side of the witness engine for slice 3 (witness-engine.mjs): how it
// calls git, what it takes for a snapshot, and what it rejects in one. Like
// the rest of the witness this is NOT the engine and not a design for it: it
// does what SEAM.md §§27–34 ask as plainly as it can, with synchronous git
// calls, so that the slice-3 acceptance tests can be shown to be satisfiable
// and to bite. Each `mutant(...)` is one defect a test is meant to catch.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function makeGit({ home, cfg, mutant }) {
  // Engine git runs no code from the repository (SEAM.md §§16, 31): hooks,
  // the file-system monitor and every filter driver the repository names are
  // switched off on every call, and the environment is constructed.
  const off = () => [
    ...(mutant('hooks_run') ? [] : ['-c', 'core.hooksPath=/dev/null']),
    ...(mutant('fsmonitor_runs') ? [] : ['-c', 'core.fsmonitor=false']),
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.pager=cat',
  ];
  const env = () => ({
    // The defect `ambient_env_inherited`: the engine's own environment is passed on to git.
    ...(mutant('ambient_env_inherited') ? process.env : {}),
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    ...(mutant('ambient_env_inherited')
      ? {}
      : {
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Surety Witness',
          GIT_AUTHOR_EMAIL: 'witness@surety.invalid',
          GIT_COMMITTER_NAME: 'Surety Witness',
          GIT_COMMITTER_EMAIL: 'witness@surety.invalid',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
        }),
  });
  const filtersOff = (gitDir) => {
    if (mutant('filters_run')) return [];
    let names = [];
    try {
      names = execFileSync('git', ['--git-dir', gitDir, 'config', '--name-only', '--get-regexp', '^filter\\.'], { env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: cfg.git_deadline * 1000 })
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.split('.').slice(1, -1).join('.'));
    } catch {
      // no filter configured, or the repository cannot be read: the call that follows says so
    }
    return [...new Set(names)].flatMap((name) => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`]);
  };

  // One git command on a repository, with a deadline. `gitDir` is the
  // repository's .git or a worktree's own git directory. `filters: true`
  // looks up the filter drivers the repository names and switches them off.
  const argvOf = (gitDir, args, { workTree, filters = false } = {}) => [...off(), ...(filters ? filtersOff(gitDir) : []), '--git-dir', gitDir, ...(workTree ? ['--work-tree', workTree] : []), ...args];
  function run(gitDir, args, { workTree, input, extraEnv = {}, filters = false } = {}) {
    const argv = argvOf(gitDir, args, { workTree, filters });
    if (mutant('git_no_deadline')) return execFileSync('git', argv, { env: { ...env(), ...extraEnv }, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).replace(/\n$/, '');
    return execFileSync('git', argv, {
      env: { ...env(), ...extraEnv },
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      timeout: cfg.git_deadline * 1000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
    }).replace(/\n$/, '');
  }
  const timedOut = (err) => err?.code === 'ETIMEDOUT' || err?.signal === 'SIGKILL';

  const repoDir = (repo) => join(repo, '.git');
  const refOid = (repo, ref) => {
    try {
      return run(repoDir(repo), ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    } catch (err) {
      if (timedOut(err)) throw err;
      return null;
    }
  };
  const readable = (repo) => {
    try {
      run(repoDir(repo), ['rev-parse', '--git-dir']);
      return true;
    } catch {
      return false;
    }
  };

  // The worktrees of a repository: [{path, head, branch}], branch null if detached.
  function worktrees(repo) {
    const out = [];
    let current = null;
    for (const line of run(repoDir(repo), ['worktree', 'list', '--porcelain']).split('\n')) {
      if (line.startsWith('worktree ')) {
        current = { path: line.slice('worktree '.length), head: null, branch: null };
        out.push(current);
      } else if (line.startsWith('HEAD ') && current) current.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ') && current) current.branch = line.slice('branch '.length);
    }
    return out;
  }
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const engineOwned = (path) => real(path).startsWith(`${join(real(home), 'workspaces')}${sep}`);

  // The worktrees the engine does not own that have this branch checked out.
  const checkoutsOf = (repo, branchRef) => worktrees(repo).filter((w) => !engineOwned(w.path) && w.branch === branchRef);

  // The git directory of a worktree, from its .git link file or directory.
  function gitDirOf(worktree) {
    const dotGit = join(worktree, '.git');
    if (lstatSync(dotGit).isDirectory()) return dotGit;
    const text = readFileSync(dotGit, 'utf8').trim();
    return text.startsWith('gitdir: ') ? text.slice('gitdir: '.length) : null;
  }

  // What a checkout holds: {head, index_hash, tracked_tree_hash}. Nothing here writes to the checkout.
  function checkoutBaseline(worktree) {
    const gitDir = gitDirOf(worktree);
    const head = run(gitDir, ['rev-parse', 'HEAD'], { workTree: worktree });
    const index = run(gitDir, ['ls-files', '-s', '-z'], { workTree: worktree });
    // diff-index reads the work tree's files, and would run a clean filter on them.
    const changed = run(gitDir, ['diff-index', '--name-only', '-z', 'HEAD'], { workTree: worktree, filters: true })
      .split('\0')
      .filter((p) => p !== '')
      .sort();
    const content = changed.map((p) => {
      const file = join(worktree, p);
      return `${p}\0${existsSync(file) && lstatSync(file).isFile() ? sha256(readFileSync(file)) : 'gone'}`;
    });
    return { head, index_hash: sha256(index), tracked_tree_hash: sha256(content.join('\n')) };
  }

  // What must be as the engine left it around a run's workspace (correction 15).
  function metadataOf(repo, worktree) {
    const hooksDir = join(repoDir(repo), 'hooks');
    const hooks = existsSync(hooksDir)
      ? readdirSync(hooksDir)
          .sort()
          .map((name) => `${name} ${sha256(readFileSync(join(hooksDir, name)))}`)
      : [];
    const gitFile = readFileSync(join(worktree, '.git'), 'utf8');
    const gitDir = gitDirOf(worktree);
    return { config: sha256(readFileSync(join(repoDir(repo), 'config'))), hooks: sha256(hooks.join('\n')), gitFile, gitDir, index: sha256(run(gitDir, ['ls-files', '-s', '-z'], { workTree: worktree })) };
  }

  // The snapshot of a workspace: `git add -A` in an index of its own that
  // started as the tree of the base (SEAM.md §28). The real index is not used.
  function snapshot(worktree, gitDir, base) {
    const index = join(gitDir, `witness-snapshot-${process.hrtime.bigint()}`);
    const extraEnv = { GIT_INDEX_FILE: index, GIT_ATTR_NOSYSTEM: '1' };
    try {
      run(gitDir, ['read-tree', base], { workTree: worktree, extraEnv, filters: true });
      run(gitDir, ['add', '-A'], { workTree: worktree, extraEnv, filters: true });
      return run(gitDir, ['write-tree'], { workTree: worktree, extraEnv, filters: true });
    } finally {
      rmSync(index, { force: true });
    }
  }

  // What a tree changes against another: [{path, status, mode, oid}].
  function changes(repo, from, to) {
    const out = [];
    const fields = run(repoDir(repo), ['diff-tree', '-r', '-z', '--no-renames', '--raw', from, to]).split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [, mode, , oid, status] = fields[i].replace(/^:/, '').split(' ');
      out.push({ path: fields[i + 1], status, mode, oid });
    }
    return out;
  }

  // Does the link at `path` (relative to the workspace), whose target is
  // `target`, lead outside the workspace? Other links on the way are followed.
  function linkEscapes(worktree, path, target, depth = 0) {
    if (depth > 40) return true;
    if (isAbsolute(target)) return true;
    const resolved = normalize(join(dirname(path), target));
    if (resolved.startsWith('..') || isAbsolute(resolved)) return true;
    const onDisk = join(worktree, resolved);
    try {
      if (lstatSync(onDisk).isSymbolicLink()) return linkEscapes(worktree, resolved, execFileSync('readlink', [onDisk], { encoding: 'utf8' }).replace(/\n$/, ''), depth + 1);
    } catch {
      // a dangling link inside the workspace leads nowhere, and so not outside
    }
    return relative(worktree, resolve(worktree, resolved)).startsWith('..');
  }

  return { argv: argvOf, env, run, timedOut, repoDir, refOid, readable, worktrees, engineOwned, checkoutsOf, gitDirOf, checkoutBaseline, metadataOf, snapshot, changes, linkEscapes, real };
}

// The rules of contract/snapshot-validation.json, as the witness applies them.
const ARCHITECT_PREFIXES = ['.surety/adrs/', '.surety/architecture/', '.surety/roadmap/', '.surety/phases/'];
export function pathViolation(role, path) {
  if (role === 'builder') return path === '.surety' || path.startsWith('.surety/') ? `a Builder may not change ${path}` : null;
  if (role === 'architect') return ARCHITECT_PREFIXES.some((prefix) => path.startsWith(prefix)) ? null : `an Architect may not change ${path}`;
  return null;
}
