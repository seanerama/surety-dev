// The engine's main-thread services once the store is open: the choke point
// (invoke/), the run-end protocol (runs/), the scheduler (scheduler/) and
// startup recovery (recovery/). They share this object, which holds what the
// running engine knows of each run it is supervising, and the one store
// client every transition goes through.

import type { ChildProcess } from 'node:child_process';

import { nowMs } from './clock.js';
import type { EngineConfig } from './config/engine-config.js';
import type { Claim } from './store/transitions/runs.js';
import type { StoreClient } from './store/client.js';

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
  // Resolves once the choke point writes nothing more for the launch.
  settled: Promise<void>;
  settle: () => void;
  ending: boolean;
  deadlineMs: number;
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
    deadlineMs: Date.parse(claim.deadline_at),
    workspacePath: null,
    child: null,
    pid: null,
    startTime: null,
    result: null,
    exit: null,
  };
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

  setting(key: 'tick_interval' | 'tick_budget' | 'tick_step_budget' | 'terminate_grace' | 'kill_grace' | 'max_concurrent_runs' | 'git_deadline'): number {
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

  // Work a committed API command asked for (D1 §1.5, §8.4).
  afterCommit(effects: { kind: string; run?: string }[]): void {
    for (const effect of effects) {
      if (effect.kind === 'tick') this.services?.requestTick();
      if (effect.kind === 'end_run' && effect.run) void this.services?.completeEnd(effect.run).catch((err) => log('run end', err));
    }
  }

  // Deadlines on owned work (D1 §8.5): a run past its deadline is cancelled
  // through the run-end protocol. Checked against the engine clock, so a
  // controlled clock that jumps is acted on within a second.
  startDeadlineWatch(): void {
    this.watcher = setInterval(() => {
      const now = nowMs();
      for (const [run, handle] of this.handles) {
        if (handle.ending || handle.phase === 'never' || handle.phase === 'aborted') continue;
        if (now >= handle.deadlineMs) {
          handle.ending = true;
          void this.services?.endRun(run, 'timed_out', 'deadline').catch((err) => log('deadline', err));
        }
      }
    }, 500);
    this.watcher.unref();
  }

  stop(): void {
    if (this.watcher) clearInterval(this.watcher);
  }
}

// One line on stderr for a failure the engine survives.
export function log(what: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${JSON.stringify({ log: 'error', what, detail })}\n`);
}
