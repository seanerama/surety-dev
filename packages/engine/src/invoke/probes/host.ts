// The probe suite's host side (D2 A.6): the processes the engine starts on
// the host as targets and as authorized controls, never inside a sandbox and
// never a backend. Each is started from an absolute path in the system
// directories with a constructed environment, bounded in time, and is the
// engine's own child: the only process here the engine signals is a sentinel
// it started itself, through its own child handle, while it is alive.

import { type ChildProcess, execFile, spawn } from 'node:child_process';

export interface HostRun {
  status: number | null;
  signal: string | null;
  error: string | null;
  stdout: string;
  stderr: string;
}

export function runHost(file: string, args: string[], opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {}): Promise<HostRun> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: opts.env ?? { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, cwd: opts.cwd ?? '/', timeout: opts.timeoutMs ?? 5000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { signal?: string; code?: number | string }) | null;
        resolve({
          status: e ? (typeof e.code === 'number' ? e.code : null) : 0,
          signal: e?.signal ?? null,
          error: e && typeof e.code === 'string' ? e.code : null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

// A host sentinel process for P13: `sleep` in the engine's own cgroup, its
// own child, ended by the engine through its handle when the suite is done.
export class Sentinel {
  private readonly child: ChildProcess;
  private exited = false;

  constructor(seconds = 60) {
    this.child = spawn('/usr/bin/sleep', [String(seconds)], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    this.child.on('error', () => {
      this.exited = true;
    });
    this.child.once('exit', () => {
      this.exited = true;
    });
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  // Alive, as the host sees it: its handle has not seen an exit and the
  // kernel still has the process.
  alive(): boolean {
    if (this.exited || this.child.pid === undefined) return false;
    try {
      process.kill(this.child.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // Ended through the engine's own handle, and only while it is alive.
  end(): void {
    if (!this.exited) this.child.kill('SIGKILL');
  }
}
