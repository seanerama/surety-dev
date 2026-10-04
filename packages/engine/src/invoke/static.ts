// The static checks of a backend binary (D2 §7.2; SEAM.md §§148, 150): its
// `--version` and its `--help`, each run once, exactly so, outside any
// domain, with a constructed environment, no standard input, a short time
// limit and bounded output. Nothing else of the binary runs here: no prompt,
// no model, no key. A binary the engine's test mode must never run (a real
// backend's own) is refused before it is started.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import { seamRefuseBinary } from '../testing/seam.js';

const OUTPUT_MAX = 1024 * 1024;
const TIMEOUT_MS = 10_000;

export interface StaticRun {
  status: number | null;
  stdout: Buffer;
}

export class StaticRefused extends Error {}

// Run `path arg`; null when it could not be started or did not end in time.
export function runStatic(path: string, backend: string, arg: '--version' | '--help'): Promise<StaticRun | null> {
  const refused = seamRefuseBinary(path, backend);
  if (refused !== null) return Promise.reject(new StaticRefused(refused));
  return new Promise((resolve) => {
    let child;
    try {
      // In a process group of its own, so that on the time limit the whole
      // group (whatever it started) is killed, not the binary alone.
      child = spawn(path, [arg], { cwd: tmpdir(), env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
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
  });
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
