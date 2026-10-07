// Every git command the engine runs (D1 §7.1; build spec §5): spawned with an
// argument array, never a shell string; a constructed environment that
// inherits nothing but PATH; explicit --git-dir and --work-tree; bounded
// output; and a deadline, measured on the monotonic clock, after which the
// child is killed and the outcome is unknown, not a failure that proves
// nothing was written.
//
// Engine git runs no code from the repository (E25 item 3; E27 item 4; E29
// item 1; SEAM.md §31). A role runs as the engine's user and can write the
// repository's configuration and attributes; what they name would run in the
// engine's own process tree. So every command line carries settings that
// outrank every configuration file: no hooks, no file-system monitor, no
// automatic garbage collection, no attributes file from the engine's home,
// and every filter driver that git itself reports for the working copy
// switched off by name (`filterDrivers`, `filterOverrides`). Merge drivers are never reached: the engine
// makes no merge (its rebase is done on an index, git/rebase.ts). Diff
// drivers, signing programs, editors and pagers are not reached by the
// plumbing commands the engine uses.

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';

export interface GitSettings {
  deadlineSeconds: number;
  outputCap: number;
  home: string;
  incarnation: string;
}

let settings: GitSettings | null = null;

export function configureGit(value: GitSettings): void {
  settings = value;
}

export function gitSettings(): GitSettings {
  if (!settings) throw new Error('git is not configured');
  return settings;
}

// The environment variables that mark a git child as the engine's, so a
// later incarnation can find the children of one that died (SEAM.md §46).
export const GIT_INCARNATION_MARKER = 'SURETY_GIT_INCARNATION';
export const GIT_OPERATION_MARKER = 'SURETY_GIT_OPERATION';
// The engine home whose engine started the child: an engine ends only
// processes of its own home, never another home's (E41 item 1).
export const GIT_HOME_MARKER = 'SURETY_GIT_HOME';

export interface GitContext {
  // The repository's common directory (`<repo>/.git`).
  commonDir: string;
  // The git directory of this call: the common directory, or a linked
  // worktree's own metadata directory.
  gitDir: string;
  workTree: string;
}

// The execution context of a project's repository (D1 §7.2): its .git
// directory and its main work tree.
export const repoContext = (repo: string): GitContext => ({ commonDir: join(repo, '.git'), gitDir: join(repo, '.git'), workTree: repo });

// The context of a linked worktree, by the metadata directory the engine
// recorded for it, never by what its .git file says now.
export const worktreeContext = (repo: string, adminDir: string, path: string): GitContext => ({ commonDir: join(repo, '.git'), gitDir: adminDir, workTree: path });

export interface GitResult {
  // null when the deadline passed or the output cap was hit: whether the
  // command had an effect is then unknown.
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  // The standard output's bytes, as git wrote them (a blob's exact content).
  bytes: Buffer;
}

export interface GitOptions {
  deadlineSeconds?: number;
  input?: string | Buffer;
  // Further variables (GIT_INDEX_FILE for a scratch index).
  env?: Record<string, string>;
  // The operation this call performs an effect for, if any.
  operation?: string;
}

const BASE_SETTINGS = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.excludesFile=/dev/null',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
  '-c', 'commit.gpgSign=false',
  '-c', 'diff.external=',
  // Every object and ref git writes is synced before it is renamed into
  // place: the store records git effects, and what it records must survive
  // a power loss (D1 §18; SEAM.md §60). By the file's own fsync, which is
  // what a sync is.
  '-c', 'core.fsync=committed,index',
  '-c', 'core.fsyncMethod=fsync',
];

// ---- filter drivers ------------------------------------------------------------
//
// Which filter drivers a command would run is decided by git, from every
// configuration file git reads for that working copy: the repository's, a
// worktree's own, every file they include (however the include is spelled
// and wherever it leads), with section names normalized as git normalizes
// them. The engine does not parse any of that itself (E33 item 1). Before
// each command it asks git, with the same git directory, work tree and
// environment, which `filter.<driver>.<key>` entries it sees, and gives the
// command an override for exactly those drivers: no clean, smudge or process
// command, and not required. The overrides travel in GIT_CONFIG_COUNT and
// its pairs, which git reads after every configuration file and which carry
// a key as it is, whatever characters its driver name holds. The query
// itself only reads configuration; it runs no program the configuration
// names. If git cannot answer it, the command is not run.

// The driver names (subsections of `filter`) git sees, or null if git could
// not say.
function filterDrivers(ctx: GitContext, env: NodeJS.ProcessEnv, deadlineMs: number): Promise<string[] | null> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', [...BASE_SETTINGS, `--git-dir=${ctx.gitDir}`, `--work-tree=${ctx.workTree}`, 'config', '--null', '--name-only', '--get-regexp', '^filter\\.'], {
      env,
      cwd: ctx.workTree,
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    const out: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish(null);
    }, deadlineMs);
    child.stdout!.on('data', (c: Buffer) => {
      size += c.length;
      if (size > gitSettings().outputCap) {
        kill();
        finish(null);
        return;
      }
      out.push(c);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      // 1: no key matched, which is an answer: no driver.
      if (code === 1) return finish([]);
      if (code !== 0) return finish(null);
      const names = new Set<string>();
      for (const key of Buffer.concat(out).toString('utf8').split('\0')) {
        if (!key.startsWith('filter.')) continue;
        const last = key.lastIndexOf('.');
        if (last <= 'filter.'.length) continue;
        names.add(key.slice('filter.'.length, last));
      }
      finish([...names]);
    });
  });
}

// Can this command run a filter driver? Filters run where content passes
// between a work tree and the object store: adding, hashing a path,
// checking out, comparing a work tree with its index, and writing an index,
// which may re-read a racily clean entry's file. A command that only reads
// objects, refs and indexes, or writes objects and refs, never runs one, and
// needs no query. Anything not known to be such a command is asked about.
export function mayRunFilter(args: readonly string[]): boolean {
  const [command, ...rest] = args;
  const has = (...flags: string[]) => flags.some((f) => rest.includes(f));
  switch (command) {
    case 'rev-parse':
    case 'for-each-ref':
    case 'update-ref':
    case 'ls-tree':
    case 'diff-tree':
    case 'merge-base':
    case 'show-ref':
    case 'symbolic-ref':
    case 'commit-tree':
    case 'mktree':
    case 'config':
      return false;
    case 'ls-files':
      return !rest.every((a) => a === '--stage' || a === '-s' || a === '-z');
    case 'cat-file':
      return has('--filters', '--textconv') || rest.some((a) => a.startsWith('--filters') || a.startsWith('--textconv'));
    case 'hash-object':
      return !(has('--no-filters') || (has('--stdin') && !has('--path', '--stdin-paths') && !rest.some((a) => a.startsWith('--path='))));
    case 'worktree': {
      const [sub] = rest;
      if (sub === 'list' || sub === 'prune') return false;
      // Forced, a removal does not look at the worktree's content.
      if (sub === 'remove') return !has('--force');
      if (sub === 'add') return !has('--no-checkout');
      return true;
    }
    default:
      return true;
  }
}

// The environment pairs that switch off each of `drivers`.
function filterOverrides(drivers: string[]): Record<string, string> {
  const pairs: [string, string][] = [];
  for (const name of drivers) {
    for (const [key, value] of [['clean', ''], ['smudge', ''], ['process', ''], ['required', 'false']] as const) pairs.push([`filter.${name}.${key}`, value]);
  }
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

function gitEnv(home: string, operation: string | undefined, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // Engine git never contacts a remote and never runs a program a remote's
    // configuration names (E37 item 1). An object that is not present is
    // missing; in a partial clone git would otherwise fetch it on demand and
    // run the remote's upload-pack, from any command that looks an object
    // up. Both settings are read by git itself, inside every git process
    // this call starts, so no configuration file and no rewrite of one can
    // outrank them. GIT_NO_LAZY_FETCH stops the on-demand fetch from git
    // 2.44 (and where a distribution backported it). GIT_ALLOW_PROTOCOL
    // holds for every git version the engine
    // supports: set, it is an allow list that overrides every
    // `protocol.*.allow` setting, and empty it allows no transport at all,
    // so the fetch git 2.43 still starts is refused before it connects or
    // runs any transport program (upload-pack, ssh, a remote helper).
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '',
    [GIT_INCARNATION_MARKER]: gitSettings().incarnation,
    ...extra,
  };
  env[GIT_HOME_MARKER] = gitSettings().home;
  // Neither may be loosened by a caller's extra variables.
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_ALLOW_PROTOCOL = '';
  if (operation !== undefined) env[GIT_OPERATION_MARKER] = operation;
  return env;
}

export async function git(ctx: GitContext, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const { home } = gitSettings();
  const deadlineMs = (opts.deadlineSeconds ?? gitSettings().deadlineSeconds) * 1000;
  const env = gitEnv(home, opts.operation, opts.env);
  // Measured on the monotonic clock: the query and the command share the
  // deadline.
  if (!mayRunFilter(args)) return run(ctx, args, env, opts.input, deadlineMs);
  const started = performance.now();
  const drivers = await filterDrivers(ctx, env, deadlineMs);
  if (drivers === null) {
    return { code: -1, stdout: '', stderr: 'the filter drivers of this working copy could not be read from git, so the command was not run', timedOut: false, bytes: Buffer.alloc(0) };
  }
  return run(ctx, args, { ...env, ...filterOverrides(drivers) }, opts.input, Math.max(1, deadlineMs - (performance.now() - started)));
}

function run(ctx: GitContext, args: string[], env: NodeJS.ProcessEnv, input: string | Buffer | undefined, deadlineMs: number): Promise<GitResult> {
  const { outputCap } = gitSettings();
  return new Promise((resolvePromise) => {
    const child = spawn('git', [...BASE_SETTINGS, `--git-dir=${ctx.gitDir}`, `--work-tree=${ctx.workTree}`, ...args], {
      env,
      cwd: ctx.workTree,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // Its own process group, so that a kill at the deadline reaches every
      // process the command started.
      detached: true,
    });
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let cut = false;
    let timedOut = false;
    let settled = false;
    const take = (chunk: Buffer, into: Buffer[]) => {
      size += chunk.length;
      if (size > outputCap) {
        cut = true;
        killGroup();
        return;
      }
      into.push(chunk);
    };
    child.stdout!.on('data', (c: Buffer) => take(c, out));
    child.stderr!.on('data', (c: Buffer) => take(c, err));
    if (input !== undefined) {
      child.stdin!.on('error', () => {});
      child.stdin!.end(input);
    }
    // Node's timers run on the monotonic clock: a wall clock that steps
    // back cannot stretch the deadline.
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, deadlineMs);
    const finish = (code: number | null, extraErr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const bytes = Buffer.concat(out);
      resolvePromise({
        code: timedOut || cut ? null : code,
        stdout: bytes.toString('utf8'),
        bytes,
        stderr: Buffer.concat(err).toString('utf8') + extraErr,
        timedOut: timedOut || cut,
      });
    };
    child.on('error', (e) => finish(-1, e.message));
    child.on('close', (code) => finish(code ?? null));
  });
}

// A git call that must succeed: its stdout, or null if it did not (a
// non-zero status, a deadline, a spawn failure).
export async function gitOk(ctx: GitContext, args: string[], opts: GitOptions = {}): Promise<string | null> {
  const r = await git(ctx, args, opts);
  return r.code === 0 ? r.stdout : null;
}

export const SHA = /^[0-9a-f]{40}$/;
export const ZERO_OID = '0000000000000000000000000000000000000000';
