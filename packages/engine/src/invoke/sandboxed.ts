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
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { processStartTime } from '../lock.js';
import type { Plan } from './sandbox/mounts.js';
import { VolatileHold } from './sandbox/volatile.js';

const here = dirname(fileURLToPath(import.meta.url));
export const LAUNCHER_SCRIPT = join(here, 'launcher.js');
export const INIT_SCRIPT = join(here, 'domain-init.js');

export interface BackendLaunch {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string | null;
  // The egress forwarder the init starts before the backend (D2 §2.4).
  forwarder?: { port: number; socket: string } | null;
  // A qualification canary's barrier, and the containment check the init
  // runs at the engine's request (D2 §7.2; E86).
  canary?: {
    barrier?: string | null;
    containment?: { program: string; actions: string[]; targets: { host_pid_ns: string; token: string; port: number; unlisted: string }; action_timeout_ms: number; check_ms: number } | null;
  } | null;
}

export interface ExitReport {
  code: number | null;
  signal: number | null;
  startFailed?: boolean;
  termToExitMs?: number | null;
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
  // The domain's volatile filesystem and the workspace's overlay, held from
  // outside once the setup stage mounted them (plan.holdVolatile), until the
  // engine releases them.
  volatile: VolatileHold | null = null;
  // What the init witnessed of a qualification canary (D2 §7.2): each
  // probe-program report it accepted, and the barrier file's appearance.
  readonly witnesses: { action: string; outcome: string; pid: number | null; detail: string; completed: boolean; backend_running: boolean }[] = [];
  // The containment check (E86): when the engine asked the init for it, and
  // the init's report that it ended.
  containmentRequestedAt: string | null = null;
  containmentDone: { ran: boolean; backend_running: boolean; reason: string | null; at: string } | null = null;
  private containmentWaiters: (() => void)[] = [];
  barrierSeen = false;
  // When the init's report of the barrier reached the engine (SEAM.md §165).
  barrierAt: string | null = null;
  onBarrier: (() => void) | null = null;
  // The engine's TERM and the backend's end, on the monotonic clock: the
  // TERM-to-exit time where the init's own count did not reach the engine.
  termSentAt: number | null = null;
  backendEndedAt: number | null = null;

  termToExitMs(): number | null {
    if (this.exitReport?.termToExitMs !== undefined && this.exitReport.termToExitMs !== null) return this.exitReport.termToExitMs;
    if (this.termSentAt === null || this.backendEndedAt === null || this.backendEndedAt < this.termSentAt) return null;
    return Math.round(this.backendEndedAt - this.termSentAt);
  }

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
        this.backendEndedAt ??= performance.now();
        this.channelOpen = false;
        // A launch refused keeps saying so after its launcher has gone.
        if (this.stage !== 'refused') this.stage = 'gone';
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

  // The engine's request for the containment check, on the init's channel
  // (E86); resolves when the init reports it ended, or after `timeoutMs`.
  requestContainment(timeoutMs: number): Promise<void> {
    if (this.containmentRequestedAt === null) {
      this.containmentRequestedAt = new Date().toISOString();
      this.send({ t: 'containment' });
    }
    if (this.containmentDone !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      this.containmentWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
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
      case 'volatile': {
        // The setup stage has mounted the volatile filesystem and the
        // workspace's overlay: the engine takes hold of both from outside
        // (invoke/sandbox/volatile.ts), with the plan's own paths, never the
        // message's. A closed launch goes no further.
        if (this.closed) {
          this.send({ t: 'volatile_refused' });
          return;
        }
        const plan = this.hooks.plan();
        try {
          this.volatile?.release();
          this.volatile = VolatileHold.take(this.pid, plan.vol, plan.workspaceMount ? join(plan.stage, plan.workspaceMount) : null, { bytes: plan.volBytes, inodes: plan.volInodes });
          this.send({ t: 'volatile_held' });
        } catch (err) {
          this.volatile = null;
          this.send({ t: 'volatile_refused', detail: (err as Error).message });
        }
        return;
      }
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
        this.backendEndedAt ??= performance.now();
        this.exitReport = {
          code: typeof m.code === 'number' ? m.code : null,
          signal: typeof m.signal === 'number' ? m.signal : null,
          ...(m.start_failed === true ? { startFailed: true } : {}),
          termToExitMs: typeof m.term_to_exit_ms === 'number' ? m.term_to_exit_ms : null,
        };
        this.resolveBackend();
        return;
      case 'witness':
        this.witnesses.push({
          action: String(m.action ?? ''),
          outcome: String(m.outcome ?? ''),
          pid: typeof m.pid === 'number' ? m.pid : null,
          detail: String(m.detail ?? '').slice(0, 500),
          completed: m.completed === true,
          backend_running: m.backend_running === true,
        });
        return;
      case 'containment_done':
        if (this.containmentDone === null) {
          this.containmentDone = { ran: m.ran === true, backend_running: m.backend_running === true, reason: typeof m.reason === 'string' ? m.reason.slice(0, 300) : null, at: new Date().toISOString() };
          for (const w of this.containmentWaiters.splice(0)) w();
        }
        return;
      case 'barrier':
        if (!this.barrierSeen) {
          this.barrierSeen = true;
          this.barrierAt = new Date().toISOString();
          this.onBarrier?.();
        }
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
    this.termSentAt ??= performance.now();
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
  // True once the launcher's exit is observed; false if it is not within
  // `boundMs`: then its exit cannot be established (D2 §3.4).
  async killUnplaced(boundMs: number): Promise<boolean> {
    if (!this.alive) return true;
    try {
      this.child.kill('SIGKILL');
    } catch {
      // gone meanwhile
    }
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([this.launcherExited.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), boundMs)))]);
    clearTimeout(timer);
    return exited;
  }

  // What the volatile filesystem held goes: after the engine has screened,
  // materialized and collected what it needed of it.
  releaseVolatile(): void {
    this.volatile?.release();
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
