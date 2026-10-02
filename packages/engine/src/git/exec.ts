// Every git command the engine runs (D1 §7.1; build spec §5): spawned with an
// argument array, never a shell string; a constructed environment that
// inherits nothing but PATH; explicit --git-dir and --work-tree; bounded
// output; and a deadline after which the child is killed and the outcome is
// unknown, not a failure that proves nothing was written.

import { spawn } from 'node:child_process';
import { join } from 'node:path';

export interface GitSettings {
  deadlineSeconds: number;
  outputCap: number;
  home: string;
}

let settings: GitSettings | null = null;

export function configureGit(value: GitSettings): void {
  settings = value;
}

export interface GitContext {
  gitDir: string;
  workTree: string;
}

// The execution context of a project's repository (D1 §7.2): its .git
// directory and its main work tree.
export const repoContext = (repo: string): GitContext => ({ gitDir: join(repo, '.git'), workTree: repo });

export interface GitResult {
  // null when the deadline passed or the output cap was hit: whether the
  // command had an effect is then unknown.
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Settings given on every engine git command line. A command-line setting
// outranks every configuration file, so these hold whatever the repository's
// configuration says (D1 §7.1; E25 item 3; E27 item 4):
// - core.hooksPath: a hooks directory that is not a directory, so no hook can
//   exist in it, wherever the repository keeps or names its hooks;
// - core.fsmonitor: off. Git runs the program this names whenever it refreshes
//   an index, a checkout into a new worktree included, and core.hooksPath
//   does not govern it.
// Filter drivers are deliberately not touched yet (E26 item 4).
const NO_REPOSITORY_CODE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function git(ctx: GitContext, args: string[], opts: { deadlineSeconds?: number } = {}): Promise<GitResult> {
  if (!settings) throw new Error('git is not configured');
  const { outputCap, home } = settings;
  const deadlineMs = (opts.deadlineSeconds ?? settings.deadlineSeconds) * 1000;
  return new Promise((resolve) => {
    // Engine git runs no code from the repository (D1 §7.1; E25 item 3): a
    // role can write the repository's hooks directory and its configuration,
    // and what they name would run in the engine's own process tree, outside
    // every execution domain (NO_REPOSITORY_CODE).
    const child = spawn('git', [...NO_REPOSITORY_CODE, `--git-dir=${ctx.gitDir}`, `--work-tree=${ctx.workTree}`, ...args], {
      env: gitEnv(home),
      cwd: ctx.workTree,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let cut = false;
    let timedOut = false;
    const take = (chunk: Buffer, into: 'out' | 'err') => {
      size += chunk.length;
      if (size > outputCap) {
        cut = true;
        child.kill('SIGKILL');
        return;
      }
      if (into === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (c: Buffer) => take(c, 'out'));
    child.stderr.on('data', (c: Buffer) => take(c, 'err'));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, deadlineMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut || cut ? null : (code ?? null), stdout, stderr, timedOut: timedOut || cut });
    });
  });
}
