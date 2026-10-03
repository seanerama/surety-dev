// The engine's side of a launch into the real sandbox (D2 §§1.1, 3.2, 3.5):
// it spawns the launcher (invoke/launcher.ts), answers it at each stage, and
// then speaks with the domain init over the same channel. The launcher is the
// only way a backend runs inside the sandbox; the choke point (invoke/
// choke.ts) is the only caller for a run, and the host checks (trust/
// checks.ts) for the start-up trial.
//
// The channel is the launcher's standard input and output, one JSON object per
// line. The engine sends only answers and the init's commands (`term`,
// `challenge`); the role's standard output reaches the engine through the
// init as `out` messages, and is handed to the stream given.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { processStartTime } from '../lock.js';
import type { Plan } from './sandbox/mounts.js';

const here = dirname(fileURLToPath(import.meta.url));
export const LAUNCHER_SCRIPT = join(here, 'launcher.js');
export const INIT_SCRIPT = join(here, 'domain-init.js');

export interface BackendLaunch {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string | null;
}

export interface ExitReport {
  code: number | null;
  signal: number | null;
  startFailed?: boolean;
}

export interface ChallengeResponse {
  nonce: string;
  invocation: string;
  generation: number;
  backend: { state: 'running'; pid: number | null } | { state: 'exited'; code: number | null; signal: number | null };
  respondedAt: number;
}

export interface LaunchHooks {
  // A named point the engine may pause or be killed at (the seam's barriers).
  barrier(name: string): Promise<void>;
  // The launcher reports its placement; the engine records it.
  placed(pid: number): Promise<void>;
  // The launcher asks for the launch authorization; the engine grants it in
  // one transaction or refuses.
  authorize(): Promise<boolean>;
  plan(): Plan;
  backend(): BackendLaunch;
  // The backend was started (its pid in the sandbox's pid namespace).
  started(pid: number): Promise<void>;
  // The sandbox could not be built.
  setupFailed(detail: string): void;
  // The launcher reached one of the wait points it was handed.
  reached?(name: string, action: string): void;
}

export interface LaunchSpec {
  domain: string;
  invocation: string;
  incarnation: string;
  generation: number;
  cgroup: string | null;
  unshare: string;
  node: string;
  // Wait points the launcher keeps itself, and where it marks them (only the
  // test seam hands any out).
  waits?: Record<string, string>;
  releaseDir?: string | null;
}

type Stage = 'spawned' | 'placed' | 'authorized' | 'refused' | 'setup' | 'init' | 'running' | 'gone';

export class SandboxLaunch {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly startTime: string | null;
  // The role's standard output, as the init relays it.
  readonly output = new PassThrough();
  stage: Stage = 'spawned';
  placedPid: number | null = null;
  exitReport: ExitReport | null = null;
  // The launcher's own exit (the sandbox's end: unshare exits with the init).
  launcherExit: { code: number | null; signal: string | null } | null = null;
  readonly launcherExited: Promise<void>;
  // Resolves when the init reports the backend's exit, or the launcher exits
  // without such a report.
  readonly backendDone: Promise<void>;
  private resolveBackend!: () => void;
  private channelOpen = true;
  private readonly challenges = new Map<string, (r: ChallengeResponse) => void>();
  // Messages to drop before acting on them (the seam's `init_report_lost`).
  dropExitReport = false;
  // The launch is closed (D2 §3.2): the engine takes the sandbox no further.
  // An authorized launcher that has not yet started the backend gets no
  // plan, no backend and no start, and waits for termination.
  closed = false;
  // What the setup stage reported of the start-up trial's overlay.
  overlay: { ok: boolean; detail: string } | null = null;
  setupFailure: string | null = null;

  constructor(
    spec: LaunchSpec,
    private readonly hooks: LaunchHooks,
  ) {
    this.backendDone = new Promise((resolve) => (this.resolveBackend = resolve));
    this.child = spawn(spec.node, ['--no-warnings', LAUNCHER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: true,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    this.pid = this.child.pid ?? -1;
    let start: string | null = null;
    try {
      start = this.pid > 0 ? processStartTime(this.pid) : null;
    } catch {
      start = null;
    }
    this.startTime = start;
    this.child.on('error', () => {});
    this.child.stdin!.on('error', () => {
      this.channelOpen = false;
    });
    this.launcherExited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.launcherExit = { code, signal };
        this.channelOpen = false;
        this.stage = 'gone';
        this.output.end();
        this.resolveBackend();
        resolve();
      });
    });
    const lines = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      void this.onMessage(msg).catch(() => {});
    });
    this.send({ ...spec, init: INIT_SCRIPT });
  }

  get alive(): boolean {
    return this.launcherExit === null;
  }

  private send(msg: Record<string, unknown>): boolean {
    if (!this.channelOpen) return false;
    try {
      this.child.stdin!.write(`${JSON.stringify(msg)}\n`);
      return true;
    } catch {
      this.channelOpen = false;
      return false;
    }
  }

  private async onMessage(m: Record<string, unknown>): Promise<void> {
    switch (m.t) {
      case 'wait':
        this.hooks.reached?.(String(m.name ?? ''), String(m.action ?? 'pause'));
        return;
      case 'placed':
        this.placedPid = typeof m.pid === 'number' ? m.pid : this.pid;
        this.stage = 'placed';
        await this.hooks.placed(this.placedPid);
        this.send({ t: 'go' });
        return;
      case 'authorize': {
        let granted = false;
        try {
          granted = await this.hooks.authorize();
        } catch {
          granted = false;
        }
        if (!granted) {
          this.stage = 'refused';
          this.send({ t: 'refused' });
          return;
        }
        this.stage = 'authorized';
        this.send({ t: 'granted' });
        return;
      }
      case 'hello':
        if (this.closed) return;
        if (m.stage === 'setup') {
          this.stage = 'setup';
          this.send({ t: 'plan', plan: this.hooks.plan() });
        } else if (m.stage === 'init') {
          this.stage = 'init';
          this.send({ t: 'backend', backend: this.hooks.backend() });
        }
        return;
      case 'setup_failed':
        this.setupFailure = String(m.detail ?? 'the sandbox could not be built');
        this.hooks.setupFailed(this.setupFailure);
        return;
      case 'overlay':
        this.overlay = { ok: m.ok === true, detail: String(m.detail ?? '') };
        return;
      case 'ready':
        if (this.closed) return;
        await this.hooks.barrier('init.before_backend');
        if (this.closed) return;
        this.send({ t: 'start' });
        return;
      case 'started':
        this.stage = 'running';
        await this.hooks.started(typeof m.pid === 'number' ? m.pid : -1);
        return;
      case 'out':
        if (typeof m.d === 'string') this.output.write(Buffer.from(m.d, 'base64'));
        return;
      case 'eof':
        this.output.end();
        return;
      case 'exit':
        // Under the seam's `init_report_lost` the report is acknowledged and
        // lost here, before the engine knows of it. Otherwise the engine
        // acknowledges it when it acts on it (`ackExit`): the init stays
        // until then, so that an engine resumed from a pause can still ask
        // it (D2 §3.5).
        if (this.dropExitReport) {
          this.send({ t: 'exit_ack' });
          return;
        }
        if (this.exitReport !== null) return;
        this.exitReport = {
          code: typeof m.code === 'number' ? m.code : null,
          signal: typeof m.signal === 'number' ? m.signal : null,
          ...(m.start_failed === true ? { startFailed: true } : {}),
        };
        this.resolveBackend();
        return;
      case 'challenge_response': {
        const nonce = String(m.nonce ?? '');
        const resolve = this.challenges.get(nonce);
        if (!resolve) return;
        this.challenges.delete(nonce);
        resolve({
          nonce,
          invocation: String(m.invocation ?? ''),
          generation: Number(m.generation),
          backend: m.backend as ChallengeResponse['backend'],
          respondedAt: Date.now(),
        });
        return;
      }
      default:
        return;
    }
  }

  // The engine has the backend's exit report.
  ackExit(): void {
    this.send({ t: 'exit_ack' });
  }

  // TERM through the init, which relays it to every process of the sandbox
  // (D2 §1.6). False if the channel is gone.
  term(): boolean {
    return this.send({ t: 'term' });
  }

  // A fresh challenge (D2 §3.5): a nonce bound to the invocation and the
  // lease generation, answered by the init within `timeoutMs`, or null.
  challenge(invocation: string, generation: number, timeoutMs: number, drop = false): Promise<ChallengeResponse | null> {
    const nonce = randomBytes(16).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.challenges.delete(nonce);
        resolve(null);
      }, timeoutMs);
      this.challenges.set(nonce, (r) => {
        // The seam's `challenge_response_dropped`: the response is lost, and
        // the bound runs out.
        if (drop) return;
        clearTimeout(timer);
        if (r.invocation !== invocation || r.generation !== generation) resolve(null);
        else resolve(r);
      });
      if (!this.send({ t: 'challenge', nonce, invocation, generation })) {
        clearTimeout(timer);
        this.challenges.delete(nonce);
        resolve(null);
      }
    });
  }

  // An unplaced launcher is the engine's own child: killed through its handle
  // and its exit awaited (D2 §3.2 step 2).
  async killUnplaced(): Promise<void> {
    if (!this.alive) return;
    try {
      this.child.kill('SIGKILL');
    } catch {
      // gone meanwhile
    }
    await this.launcherExited;
  }

  closeChannel(): void {
    this.channelOpen = false;
    try {
      this.child.stdin!.end();
    } catch {
      // nothing to close
    }
  }
}
