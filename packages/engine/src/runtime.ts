// The engine's main-thread services once the store is open: the choke point
// (invoke/), the run-end protocol (runs/), the scheduler (scheduler/) and
// startup recovery (recovery/). They share this object, which holds what the
// running engine knows of each run it is supervising, and the one store
// client every transition goes through.

import type { ChildProcess } from 'node:child_process';

import { nowMs } from './clock.js';
import type { EngineConfig } from './config/engine-config.js';
import { processState } from './invoke/processes.js';
import type { Claim, Outcome, ReasonClass } from './store/transitions/runs.js';
import type { StoreClient } from './store/client.js';

export interface RunEnd {
  outcome: Outcome;
  reason: ReasonClass;
}

export interface RunHandle {
  claim: Claim;
  // Whether this incarnation spawned the role: `preparing` until the choke
  // point either spawns it (`spawned`), stops short of the spawn because the
  // run is ending (`aborted`), or never can (`never`: refused, or the spawn
  // failed). Only `aborted` and `never` let the run-end protocol treat the
  // domain as one the engine knows it never spawned into.
  phase: 'preparing' | 'spawned' | 'aborted' | 'never';
  // Set by the run-end protocol: the choke point must not spawn.
  abort: boolean;
  // Resolves once the choke point writes nothing more for the launch. The
  // choke point resolves it on every path out of a launch, failures included.
  settled: Promise<void>;
  settle: () => void;
  // The engine has decided to end the run; `intended` is the end it decided,
  // kept so that a run-end protocol interrupted by a failure is resumed with
  // the same outcome when the run's lease is reconciled (D1 §8.1 step 1).
  ending: boolean;
  intended: RunEnd | null;
  deadlineMs: number;
  // The last renewal of the run lease this engine knows of, on the engine
  // clock; and whether the store has refused a renewal (the lease is closing,
  // released or expired, and expiry is final).
  renewedAtMs: number;
  renewing: boolean;
  leaseLost: boolean;
  workspacePath: string | null;
  child: ChildProcess | null;
  pid: number | null;
  startTime: string | null;
  result: { valid: boolean } | null;
  exit: { code: number | null; signal: string | null } | null;
}

export function newHandle(claim: Claim): RunHandle {
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    claim,
    phase: 'preparing',
    abort: false,
    settled,
    settle,
    ending: false,
    intended: null,
    deadlineMs: Date.parse(claim.deadline_at),
    renewedAtMs: Date.parse(claim.lease_renewed_at),
    renewing: false,
    leaseLost: false,
    workspacePath: null,
    child: null,
    pid: null,
    startTime: null,
    result: null,
    exit: null,
  };
}

// The end a run's role earned, from what this engine saw of it (SEAM.md §13;
// E26 item 2). An end the engine already decided stands. Otherwise: a valid
// result accepted on a live lease and an exit with status 0 is `completed`;
// an invalid result is `invalid_result`; anything else, a role that has not
// been seen to exit included, is `failed` / `infra_error`. A run this engine
// holds no handle for gets the last of these: nothing it knows is a success.
export function earnedEnd(handle: RunHandle | undefined): RunEnd {
  if (handle?.intended) return handle.intended;
  if (handle?.result?.valid === false) return { outcome: 'failed', reason: 'invalid_result' };
  if (handle?.result?.valid === true && handle.exit?.code === 0) return { outcome: 'completed', reason: 'none' };
  return { outcome: 'failed', reason: 'infra_error' };
}

// Is the engine supervising a live role process for this run? From the spawn
// until the process exits, the run starts ending, or the store refuses the
// lease. A process that /proc shows gone is not supervised, even if its exit
// was never delivered; one whose /proc entry is unreadable is not taken for
// gone.
function supervising(handle: RunHandle): boolean {
  if (handle.phase !== 'spawned' || handle.exit !== null || handle.ending || handle.leaseLost || handle.pid === null) return false;
  return handle.startTime === null || processState(handle.pid, handle.startTime) !== 'gone';
}

export interface Services {
  endRun(run: string, outcome: string, reason: string): Promise<void>;
  completeEnd(run: string): Promise<void>;
  requestTick(): void;
}

export class Runtime {
  readonly handles = new Map<string, RunHandle>();
  services: Services | null = null;
  private watcher: NodeJS.Timeout | null = null;

  constructor(
    readonly store: StoreClient,
    readonly config: EngineConfig,
    readonly incarnation: string,
    readonly home: string,
  ) {}

  setting(key: 'tick_interval' | 'tick_budget' | 'tick_step_budget' | 'terminate_grace' | 'kill_grace' | 'max_concurrent_runs' | 'git_deadline' | 'lease_ttl'): number {
    return this.config.values[key];
  }

  // An engine transition: one store transaction, actor engine.
  engine<T = unknown>(name: string, args: unknown = {}): Promise<T> {
    return this.store.call<T>('engine', { name, args });
  }

  // A role callback on behalf of a run, fenced in the store (D1 §8.3).
  role<T = unknown>(name: string, run: string, args: unknown): Promise<T> {
    return this.store.call<T>('role', { name, run, args });
  }

  read<T = unknown>(name: string, args: unknown = {}): Promise<T> {
    return this.store.call<T>('read', { name, args });
  }

  // The engine decides to end a run it holds a handle for. Once only; the
  // run-end protocol is idempotent and, if it fails, the lease that is no
  // longer renewed expires and the tick resumes it with the same end.
  requestEnd(handle: RunHandle, end: RunEnd): void {
    if (handle.ending) return;
    handle.ending = true;
    handle.intended = end;
    void this.services?.endRun(handle.claim.run, end.outcome, end.reason).catch((err) => log('run end', err, { run: handle.claim.run }));
  }

  // Work a committed API command asked for (D1 §1.5, §8.4).
  afterCommit(effects: { kind: string; run?: string }[]): void {
    for (const effect of effects) {
      if (effect.kind === 'tick') this.services?.requestTick();
      if (effect.kind === 'end_run' && effect.run) void this.services?.completeEnd(effect.run).catch((err) => log('run end', err, { run: effect.run }));
    }
  }

  // Twice a second, on the engine clock, so a controlled clock that jumps is
  // acted on within a second:
  // - deadlines on owned work (D1 §8.5): a run past its deadline is cancelled
  //   through the run-end protocol;
  // - the run lease of every role process the engine supervises is renewed
  //   once a quarter of lease_ttl has passed since its last renewal, so at
  //   least every lease_ttl/3, whether or not the role sends heartbeats
  //   (D1 §8.3; E25 item 1). Nothing else renews it: a run nobody supervises
  //   lets its lease expire, and the tick reconciles it (D1 §8.1 step 1).
  startWatch(): void {
    const renewEveryMs = (this.setting('lease_ttl') * 1000) / 4;
    this.watcher = setInterval(() => {
      try {
        const now = nowMs();
        for (const [run, handle] of this.handles) {
          if (handle.ending || handle.phase === 'never' || handle.phase === 'aborted') continue;
          if (now >= handle.deadlineMs) {
            this.requestEnd(handle, { outcome: 'timed_out', reason: 'deadline' });
            continue;
          }
          if (!handle.renewing && now - handle.renewedAtMs >= renewEveryMs && supervising(handle)) this.renew(run, handle);
        }
      } catch (err) {
        log('watch', err);
      }
    }, 500);
    this.watcher.unref();
  }

  private renew(run: string, handle: RunHandle): void {
    handle.renewing = true;
    this.engine<string | null>('run.renew', { run, generation: handle.claim.generation })
      .then((at) => {
        if (at === null) handle.leaseLost = true;
        else handle.renewedAtMs = Math.max(handle.renewedAtMs, Date.parse(at));
      })
      .catch((err) => log('lease renewal', err, { run }))
      .finally(() => {
        handle.renewing = false;
      });
  }

  // A renewal the role's heartbeat made.
  renewedByRole(handle: RunHandle, at: string | null): void {
    if (at !== null) handle.renewedAtMs = Math.max(handle.renewedAtMs, Date.parse(at));
  }

  stop(): void {
    if (this.watcher) clearInterval(this.watcher);
  }
}

// One line on stderr for a failure the engine survives: what failed, the
// error's message, code and stack, and what it concerned (a run, say), so a
// swallowed error can be diagnosed from the log alone.
export function log(what: string, err: unknown, context: Record<string, unknown> = {}): void {
  const e = err instanceof Error ? err : null;
  const line: Record<string, unknown> = { log: 'error', at: new Date().toISOString(), what, ...context, detail: e ? e.message : String(err) };
  // Not `code`: a startup refusal is the last stderr line with a string
  // `code` (SEAM.md §1), and a log line must never be taken for one.
  const code = (err as { code?: unknown } | null)?.code;
  if (code !== undefined) line.error_code = code;
  if (e?.stack) line.stack = e.stack;
  try {
    process.stderr.write(`${JSON.stringify(line)}\n`);
  } catch {
    // stderr is gone; there is nowhere left to report to
  }
}
