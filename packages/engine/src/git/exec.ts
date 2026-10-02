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
// and every filter driver the repository's configuration names switched off
// by name (`filterOverrides`). Merge drivers are never reached: the engine
// makes no merge (its rebase is done on an index, git/rebase.ts). Diff
// drivers, signing programs, editors and pagers are not reached by the
// plumbing commands the engine uses.

import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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
];

// ---- filter drivers ------------------------------------------------------------

const FILTER_SECTION = /^\s*\[\s*filter\s+"((?:[^"\\\n]|\\.)*)"\s*\]/i;
const FILTER_SECTION_OLD = /^\s*\[\s*filter\.([^\]\s]+)\s*\]/i;
const INCLUDE_SECTION = /^\s*\[\s*include(?:if\s+"[^"]*")?\s*\]/i;
const ANY_SECTION = /^\s*\[/;
const PATH_KEY = /^\s*path\s*=\s*(.*)$/i;

interface ConfigCache {
  stamp: string;
  names: string[];
}
const configCache = new Map<string, ConfigCache>();

function stampOf(file: string): string | null {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return null;
    return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : null;
  }
}

const unquote = (value: string): string => {
  let v = value.trim();
  const hash = v.search(/(^|\s)[#;]/);
  if (hash >= 0 && !v.startsWith('"')) v = v.slice(0, hash).trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
  return v.replace(/\\(.)/g, '$1');
};

// The filter driver names one configuration file defines, following its
// include paths. A file that is not a regular file is never opened (it could
// be a pipe nobody writes to); the last names read from it stand in.
function filterNames(file: string, depth = 0, seen = new Set<string>()): string[] {
  if (depth > 8 || seen.has(file)) return [];
  seen.add(file);
  const stamp = stampOf(file);
  const cached = configCache.get(file);
  if (stamp === 'absent') return [];
  if (stamp === null) return cached?.names ?? [];
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return cached?.names ?? [];
  }
  const names = new Set<string>();
  let inInclude = false;
  for (const line of text.split('\n')) {
    const section = FILTER_SECTION.exec(line) ?? FILTER_SECTION_OLD.exec(line);
    if (section) names.add(section[1]!.replace(/\\(.)/g, '$1'));
    if (INCLUDE_SECTION.test(line)) inInclude = true;
    else if (ANY_SECTION.test(line)) inInclude = false;
    const path = inInclude ? PATH_KEY.exec(line) : null;
    if (path) {
      let target = unquote(path[1]!);
      if (target.startsWith('~/')) target = join(gitSettings().home, target.slice(2));
      if (!isAbsolute(target)) target = resolve(dirname(file), target);
      for (const n of filterNames(target, depth + 1, seen)) names.add(n);
    }
  }
  const out = [...names];
  configCache.set(file, { stamp, names: out });
  return out;
}

// `-c` settings that switch off, by name, every filter driver the
// repository's configuration (and the worktree's own) defines.
function filterOverrides(ctx: GitContext): string[] {
  const names = new Set<string>();
  for (const n of filterNames(join(ctx.commonDir, 'config'))) names.add(n);
  if (ctx.gitDir !== ctx.commonDir) for (const n of filterNames(join(ctx.gitDir, 'config.worktree'))) names.add(n);
  return [...names].flatMap((name) => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`]);
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
    [GIT_INCARNATION_MARKER]: gitSettings().incarnation,
    ...extra,
  };
  if (operation !== undefined) env[GIT_OPERATION_MARKER] = operation;
  return env;
}

export function git(ctx: GitContext, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const { outputCap, home } = gitSettings();
  const deadlineMs = (opts.deadlineSeconds ?? gitSettings().deadlineSeconds) * 1000;
  return new Promise((resolvePromise) => {
    let overrides: string[];
    try {
      overrides = filterOverrides(ctx);
    } catch {
      overrides = [];
    }
    const child = spawn('git', [...BASE_SETTINGS, ...overrides, `--git-dir=${ctx.gitDir}`, `--work-tree=${ctx.workTree}`, ...args], {
      env: gitEnv(home, opts.operation, opts.env),
      cwd: ctx.workTree,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
    if (opts.input !== undefined) {
      child.stdin!.on('error', () => {});
      child.stdin!.end(opts.input);
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
      resolvePromise({
        code: timedOut || cut ? null : code,
        stdout: Buffer.concat(out).toString('utf8'),
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
