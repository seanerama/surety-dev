// The static checks of a backend binary (D2 §7.2; SEAM.md §§148, 150): its
// `--version` and its `--help`, and for Codex its `features list` (D2 §4.6,
// D2-T13; adapters/codex-features.ts), each run once, exactly so, outside any
// domain, with a constructed environment, no standard input, a short time
// limit and bounded output. Nothing else of the binary runs here: no prompt,
// no model, no key. A binary the engine's test mode must never run (a real
// backend's own) is refused before it is started.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { seamRefuseStatic } from '../testing/seam.js';

const OUTPUT_MAX = 1024 * 1024;
const TIMEOUT_MS = 10_000;

export interface StaticRun {
  status: number | null;
  stdout: Buffer;
}

export class StaticRefused extends Error {}

// The environment of a static check: a home of its own, empty and removed
// after, so that the operator's settings and credentials (`~/.claude`,
// `~/.codex`) are neither read nor written and the help does not depend on
// them; and, for Claude Code, its documented switches that stop it updating
// itself or making other nonessential network contacts
// (code.claude.com/docs: DISABLE_AUTOUPDATER, DISABLE_UPDATES,
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC), so that a check can never
// replace the binary it checks.
function staticEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    CODEX_HOME: join(home, '.codex'),
    DISABLE_AUTOUPDATER: '1',
    DISABLE_UPDATES: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

// Run `path arg`; null when it could not be started or did not end in time.
export function runStatic(path: string, backend: string, arg: '--version' | '--help' | readonly string[]): Promise<StaticRun | null> {
  const args = typeof arg === 'string' ? [arg] : [...arg];
  const refused = seamRefuseStatic(path, backend);
  if (refused !== null) return Promise.reject(new StaticRefused(refused));
  let home: string;
  try {
    home = mkdtempSync(join(tmpdir(), 'surety-static-'));
  } catch {
    return Promise.resolve(null);
  }
  const done = (v: StaticRun | null) => {
    rmSync(home, { recursive: true, force: true });
    return v;
  };
  const env = staticEnv(home);
  // The directories the environment names exist, empty, before the binary
  // starts: Codex 0.160.0's `features list` exits 1 ("failed to resolve
  // CODEX_HOME") when CODEX_HOME names no directory, while its `--version`
  // and `--help` only warn (C2e, observed on MAIN 2026-10-28). The XDG
  // directories likewise, so that no check depends on a binary making them.
  try {
    for (const d of [env.CODEX_HOME!, env.XDG_CONFIG_HOME!, env.XDG_CACHE_HOME!, env.XDG_DATA_HOME!]) mkdirSync(d, { recursive: true });
  } catch {
    return Promise.resolve(done(null));
  }
  return new Promise<StaticRun | null>((resolve) => {
    let child;
    try {
      // In a process group of its own, so that on the time limit the whole
      // group (whatever it started) is killed, not the binary alone.
      child = spawn(path, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      // The group this call's own child leads, while that child is alive
      // (so its id is still that group's): never 0, 1, a negative or the
      // engine's own.
      const pid = child.pid;
      if (pid !== undefined && Number.isInteger(pid) && pid > 1 && pid !== process.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
      resolve(null);
    }, TIMEOUT_MS);
    child.stdout!.on('data', (d: Buffer) => {
      if (size >= OUTPUT_MAX) return;
      chunks.push(d.subarray(0, OUTPUT_MAX - size));
      size += d.length;
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(chunks) });
    });
  }).then(done);
}

// The SHA-256 of `--help`'s standard output; null when it could not be run.
export async function helpHash(path: string, backend: string): Promise<string | null> {
  const r = await runStatic(path, backend, '--help');
  if (r === null || r.status !== 0) return null;
  return createHash('sha256').update(r.stdout).digest('hex');
}

// The first line of `--version`'s standard output, trimmed; null when it
// could not be run.
export async function versionOf(path: string, backend: string): Promise<string | null> {
  const r = await runStatic(path, backend, '--version');
  if (r === null || r.status !== 0) return null;
  const line = r.stdout.toString('utf8').split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

// Codex's feature inventory (D2 §4.6): `codex features list`'s standard
// output and its SHA-256, with the exact arguments it was run with (C2d:
// the template's feature flags in front of `features list`,
// adapters/codex-features.ts CODEX_FEATURES_ARGS); null when it could not
// be run or did not exit 0.
export async function featureInventory(path: string, backend: string, args: readonly string[]): Promise<{ text: string; sha256: string; args: readonly string[] } | null> {
  const r = await runStatic(path, backend, args);
  if (r === null || r.status !== 0) return null;
  return { text: r.stdout.toString('utf8'), sha256: createHash('sha256').update(r.stdout).digest('hex'), args: [...args] };
}
