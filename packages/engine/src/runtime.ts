// The engine's main-thread services once the store is open: the choke point
// (invoke/), the run-end protocol (runs/), the scheduler (scheduler/) and
// startup recovery (recovery/). They share this object, which holds what the
// running engine knows of each run it is supervising, and the one store
// client every transition goes through.

import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { isoAt, nowMs } from './clock.js';
import type { EngineConfig } from './config/engine-config.js';
import { processState } from './invoke/processes.js';
import type { Journal } from './journal/driver.js';
import type { Claim, Outcome, ReasonClass } from './store/transitions/runs.js';
import type { StoreClient } from './store/client.js';
import type { Scope } from './boundary/scope.js';
import type { SandboxLaunch } from './invoke/sandboxed.js';
import type { DomainProxy } from './invoke/proxy/proxy.js';
import type { BackendSampling, ClaudeStream } from './invoke/adapters/claude.js';
import type { Sampler } from './invoke/sampler.js';
import { seamBoundary } from './testing/seam.js';
import { redactText, redactValue } from './records/redact.js';

export interface RunEnd {
  outcome: Outcome;
  reason: ReasonClass;
  // When the engine decided this end, on the engine clock. The transaction
  // that records it compares it with the lease: an end decided after the
  // lease had expired was not decided before the expiry (E27 item 3).
  decidedAt?: string;
  // Recorded with the outcome (runs.reason_text, runs.reason_detail).
  reasonText?: string;
  detail?: Record<string, unknown>;
  // Recorded as decided, whatever the lease's expiry: a deadline or a budget
  // found passed when the engine resumed from a pause (D2 §3.5).
  asIs?: boolean;
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
  // the same outcome, by the engine's retry or when the run's lease is
  // reconciled (D1 §8.1 step 1). From the decision on, nothing renews the
  // run's lease, the role's heartbeats included (E27 item 5).
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
  // When the role's process exited, on the engine clock. An end the role
  // earned by its exit was decided then, however long the engine goes on
  // reading what the role wrote before it exited (SEAM.md §24).
  exitAt: string | null;
  // The role exited 0 after a valid result, and the engine is accepting
  // what it left (runs/accept.ts). Nothing renews the lease meanwhile; a
  // Stop or an Abandon is still admitted, and waits for `pipeline`.
  accepting: boolean;
  pipeline: Promise<void> | null;
  // The baseline a fresh checkout of the run's base has.
  baseline: { head: string; index_hash: string; tracked_tree_hash: string } | null;
  // The role's output as the engine reads it: `done` resolves once the
  // engine has stopped reading it and its transcript stream has ended
  // (published, or left unpublished); `stop` makes the engine stop reading.
  output: { done: Promise<void>; stop: () => void } | null;
  // Set when the role sent a valid result that could not be recorded
  // however often it was tried: why (SEAM.md §61).
  resultLost: string | null;
  // On the real boundary: the launch (the launcher, then the domain init's
  // channel), from its spawn on (D2 §§1.1, 3.2).
  sandbox: SandboxLaunch | null;
  // The backend has been started inside the sandbox (the init said so).
  backendStarted: boolean;
  // The project's approved `sandbox_read_paths`, validated for this launch.
  readPaths: string[];
  // The project's approved `egress_allow_extra`, and the effective protected
  // roots (D2 §§2.3, 2.4), read with the plan's validation.
  egressExtra: string[];
  protectedRoots: string[];
  // The domain's egress proxy, from before the launcher until the domain is
  // terminated (D2 §2.4).
  egress: DomainProxy | null;
  // What the role left in its workspace has been materialized into the
  // checkout (D2 §2.3), once.
  materialized: boolean;
  // While the engine has resumed from a pause that outlived the run lease:
  // what the role sent meanwhile, and its exit, held until the tick's fresh
  // challenge decides (D2 §3.5).
  gate: { lines: string[]; exit: (() => void) | null; released: Promise<void>; release: () => void } | null;
  // The backend exited during a pause the lease did not outlive by any
  // decision: the run ends by its exit, as decided, whatever the expiry.
  expiryExempt: boolean;
  // On the real boundary: the terminal event the backend's stream carried,
  // the last one read (D2 §1.6: `clean` needs a terminal success event).
  terminal: 'success' | 'failure' | null;
  // The scripted adapter's result line, held unrecorded until termination
  // (its stand-in for the result file when the role wrote none).
  streamResult: { value: unknown } | null;
  // Collection after termination (invoke/collect.ts), once per run: the
  // engine holds the run while it terminates and collects after the
  // backend's exit (D2 §1.4).
  collection: Promise<unknown> | null;
  collecting: boolean;
  // The backend exited on its own before the engine decided to end the run
  // (D2 §1.6; SEAM.md §143, Q13): the exit decides the run's end, by its
  // class and result. No later cause (a Stop, an Abandon, a deadline, a
  // budget) replaces it: a cancellation's cause stands only for an exit the
  // engine signalled (`engine_signaled`).
  // Why a result was not one the engine may take, where more than its form
  // says it (a finding's check naming no check of the project: the review
  // of b72b9cc, F1).
  invalidDetail: string | null;
  exitedFirst: boolean;
  // A Stop or an Abandon confirmed while `exitedFirst` held (the review of
  // 662cd7f, S2): it applied to the work; see Choke.collectAfterExit.
  controlAfterExit: 'stop' | 'abandon' | null;
  // Ends not taken after the exit, each logged once (M2).
  endsNotTaken: Set<string>;
  // The stream's own bounds were exceeded (D2 §3.7): why.
  streamBound: string | null;
  // The domain's egress log entries, kept when its proxy closed (a
  // qualification canary's contacts, D2 §7.2).
  egressEntries: { authority: string; decision: string; reason: string | null; opened_at: string; bytes_up?: number; bytes_down?: number }[] | null;
  // The containment canary's check as the engine watched it (E86); null
  // where there is none, or until the backend has started.
  containment: import('./invoke/containment.js').ContainmentWatch | null;
  // Each of its domains' egress evidence once the domain is terminated and
  // its proxy closed (E85): what the run's ledger row may rest a known zero
  // on.
  egressEvidence: import('./invoke/proxy/egress.js').EgressEvidence[];
  // A real backend's stream, as its adapter reads it (invoke/adapters/
  // claude.ts); null for the scripted protocol.
  adapterStream: ClaudeStream | null;
  // A real backend's canary: the host's samples of its domain's processes
  // (D2 §7.2), from the backend's start to its exit.
  sampler: Sampler | null;
  samplingReport: BackendSampling | null;
  // The entry's help hash, as checked before this run's claim; null where
  // the launch checks it itself.
  helpChecked: string | null;
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
    exitAt: null,
    accepting: false,
    pipeline: null,
    baseline: null,
    output: null,
    resultLost: null,
    sandbox: null,
    backendStarted: false,
    readPaths: [],
    egressExtra: [],
    protectedRoots: [],
    egress: null,
    materialized: false,
    gate: null,
    expiryExempt: false,
    terminal: null,
    streamResult: null,
    collection: null,
    collecting: false,
    invalidDetail: null,
    exitedFirst: false,
    controlAfterExit: null,
    endsNotTaken: new Set(),
    streamBound: null,
    egressEntries: null,
    containment: null,
    egressEvidence: [],
    adapterStream: null,
    sampler: null,
    samplingReport: null,
    helpChecked: null,
  };
}

// The end a run's role earned when its process exited, from what this engine
// saw of it (SEAM.md §13). An end the engine already decided stands.
// Otherwise: a valid result accepted on a live lease and an exit with status
// 0 is `completed`; an invalid result is `invalid_result`; anything else is
// `failed` / `infra_error`.
export function earnedEnd(handle: RunHandle): RunEnd {
  if (handle.intended) return handle.intended;
  if (handle.resultLost !== null) return { outcome: 'failed', reason: 'infra_error', reasonText: handle.resultLost };
  if (handle.result?.valid === false) return { outcome: 'failed', reason: 'invalid_result', ...(handle.invalidDetail ? { reasonText: handle.invalidDetail } : {}) };
  if (handle.result?.valid === true && handle.exit?.code === 0) return { outcome: 'completed', reason: 'none' };
  return { outcome: 'failed', reason: 'infra_error' };
}

// The end of a run whose lease was found expired (E27 items 3 and 7; SEAM.md
// §16). An end the engine decided before the expiry stands; the transaction
// that records it checks the "before" against the lease. With nothing
// decided, the run is treated as recovered, like a run found after a crash:
// a result accepted from a role that has not exited decides nothing, and
// neither does what the role does after the expiry.
export function expiryEnd(handle: RunHandle | undefined): RunEnd {
  return handle?.intended ?? { outcome: 'recovered', reason: 'recovered' };
}

// Is the engine holding this run, so that it renews the run's lease itself
// (D1 §8.3; E25 item 1; E27 items 2 and 5)? While it prepares the run, from
// the claim until the spawn, and while it supervises the role's live process,
// from the spawn until the process exits; never once it has decided to end
// the run or the store has refused the lease. A process that /proc shows gone
// is not supervised, even if its exit was never delivered; one whose /proc
// entry is unreadable is not taken for gone.
function holding(handle: RunHandle): boolean {
  if (handle.ending || handle.leaseLost || handle.abort || handle.accepting) return false;
  if (handle.phase === 'preparing') return true;
  // After the backend's exit, while the engine establishes termination and
  // collects what it left (D2 §1.4): still held.
  if (handle.collecting) return true;
  if (handle.phase !== 'spawned' || handle.exit !== null || handle.pid === null) return false;
  return handle.startTime === null || processState(handle.pid, handle.startTime) !== 'gone';
}

export interface Services {
  endRun(run: string, end: RunEnd): Promise<void>;
  completeEnd(run: string): Promise<void>;
  // Retry every run-end protocol that failed part way and is due again.
  retryEnds(): void;
  requestTick(): void;
  // Accept what a role that exited 0 after a valid result left.
  accept(handle: RunHandle): void;
  // Make the nomination due in a project, if any.
  nominate(project: string): Promise<void>;
  // Drive the unfinished journal operations of a project.
  journal(project: string): Promise<void>;
  // Make the effect of a consumed decision (decisions/effects.ts).
  effect(intent: string): Promise<void>;
  // The re-grant of an expired run lease after a pause (D2 §3.5).
  regrant(run: string): Promise<boolean>;
  // Termination of a run's domains, before what they held is read (D2 §§1.4,
  // 3.2); and collection, after it, on a run's end (invoke/collect.ts).
  terminateDomains(run: string): Promise<boolean>;
  collectAtEnd(handle: RunHandle, quarantined: boolean): Promise<void>;
  // Authorized qualification attempts taken on their way (trust/attempts.ts).
  qualificationStep(): Promise<void>;
}

export class Runtime {
  readonly handles = new Map<string, RunHandle>();
  services: Services | null = null;
  // The journal's main-thread driver (journal/driver.ts), set once at startup.
  journal!: Journal;
  private watcher: NodeJS.Timeout | null = null;
  // Scratch files of the engine's own (scratch indexes), under its home and
  // never in a repository.
  readonly scratch: string;

  constructor(
    readonly store: StoreClient,
    readonly config: EngineConfig,
    readonly incarnation: string,
    readonly home: string,
  ) {
    this.scratch = join(home, 'tmp');
    mkdirSync(this.scratch, { recursive: true, mode: 0o700 });
  }

  // The check runner (checks/run.ts), set once at startup.
  checks: import('./checks/run.js').CheckRunner | null = null;
  // The Release Operator (deploy/release-operator.ts), set once at startup.
  deploy: import('./deploy/release-operator.js').ReleaseOperator | null = null;

  // The incarnation scope (D2 §3.1), null when the engine runs without one.
  scope: Scope | null = null;
  private hostChecks: (() => Promise<unknown>) | null = null;
  private recheck: Promise<unknown> | null = null;

  setting(
    key:
      | 'tick_interval'
      | 'tick_budget'
      | 'tick_step_budget'
      | 'terminate_grace'
      | 'kill_grace'
      | 'max_concurrent_runs'
      | 'git_deadline'
      | 'lease_ttl'
      | 'domain_memory_max'
      | 'domain_tasks_max'
      | 'domain_writable_bytes'
      | 'domain_writable_inodes'
      | 'pause_challenge_timeout'
      | 'result_max_bytes'
      | 'collect_deadline'
      | 'collect_entries_max'
      | 'provider_files_max_bytes'
      | 'stream_line_max_bytes'
      | 'stream_queue_max_bytes'
      | 'max_concurrent_domains'
      | 'host_reserve_memory'
      | 'host_reserve_disk'
      | 'egress_resolve_timeout'
      | 'egress_connect_timeout'
      | 'egress_tunnel_max_seconds'
      | 'egress_tunnels_max'
      | 'egress_buffer_max_bytes'
      | 'egress_log_max_bytes',
  ): number {
    return this.config.values[key];
  }

  // Which execution boundary a run's domain is held by (D2 §5 C3): the real
  // one, through the launcher, the sandbox and the incarnation's scope; or,
  // only in harness mode, the scripted boundary of the kernel lane (SEAM.md
  // §§14, 114), which the harness also falls back to when this start has no
  // scope (M2 plan M110 (b)). Outside harness mode it is always the real one;
  // without a scope no real backend is eligible to be dispatched to it.
  boundary(): 'scripted' | 'real' {
    const chosen = seamBoundary();
    // A sandbox-lane engine without a scope has no boundary to hold a role:
    // its dispatches are refused, never run on the scripted boundary.
    return chosen === 'scripted' ? 'scripted' : 'real';
  }

  // The host checks, run at start and again when a sandbox fails to build
  // (D2 §7.1).
  async runHostChecks(run: () => Promise<unknown>): Promise<void> {
    this.hostChecks = run;
    await run();
  }

  rerunHostChecks(): void {
    if (!this.hostChecks || this.recheck) return;
    this.recheck = this.hostChecks()
      .catch((err) => log('host checks', err, { cause: 'sandbox build failed' }))
      .finally(() => {
        this.recheck = null;
      });
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

  // The engine decides to end a run it holds a handle for. Once only: from
  // here nothing renews the run's lease. The run-end protocol is idempotent;
  // if a step of it fails, the engine retries it (RunEnder), and the lease
  // that nothing renews expires as the backstop.
  requestEnd(handle: RunHandle, end: RunEnd, opts: { afterExit?: boolean } = {}): void {
    if (handle.ending) return;
    // After the backend's own exit only the exit's own end is taken (Q13).
    if (handle.exitedFirst && opts.afterExit !== true) {
      const key = `${end.outcome}/${end.reason}`;
      if (!handle.endsNotTaken.has(key)) {
        handle.endsNotTaken.add(key);
        log('run end', new Error(`${key} not taken: the backend had exited 0 by itself, and its exit decides the run's end`), { run: handle.claim.run });
      }
      return;
    }
    handle.ending = true;
    const asIs = end.asIs === true || handle.expiryExempt;
    const { decidedAt, ...rest } = end;
    handle.intended = asIs ? rest : { ...end, decidedAt: decidedAt ?? isoAt(nowMs()) };
    void this.services?.endRun(handle.claim.run, handle.intended).catch((err) => log('run end', err, { run: handle.claim.run }));
  }

  // Has this engine decided to end the run, whether or not the transaction
  // that records the decision has succeeded (E27 item 5)? A Stop or Abandon
  // confirmed after that is refused (SEAM.md §24).
  endDecided(run: string): boolean {
    return this.handles.get(run)?.ending === true;
  }

  // Has the backend of this engine's run exited on its own before any end
  // was decided (Q13)? A Stop or Abandon confirmed after that changes
  // nothing: the exit decides.
  exitedFirst(run: string): boolean {
    return this.handles.get(run)?.exitedFirst === true;
  }

  // Work a committed API command asked for (D1 §1.5, §8.4).
  afterCommit(effects: { kind: string; run?: string; project?: string; intent?: string; control?: string; environment?: string }[]): void {
    for (const effect of effects) {
      if (effect.kind === 'tick') this.services?.requestTick();
      if (effect.kind === 'preempt' && effect.environment) this.deploy?.cancelCalls(effect.environment);
      if (effect.kind === 'end_run' && effect.run) void this.services?.completeEnd(effect.run).catch((err) => log('run end', err, { run: effect.run }));
      // A Stop or an Abandon confirmed after the backend's own exit (S2).
      if (effect.kind === 'control_after_exit' && effect.run && (effect.control === 'stop' || effect.control === 'abandon')) {
        const h = this.handles.get(effect.run);
        if (h) h.controlAfterExit = effect.control;
      }
      if (effect.kind === 'effect' && effect.intent) {
        const intent = effect.intent;
        void this.services
          ?.effect(intent)
          .catch((err) => log('effect', err, { intent }))
          .finally(() => this.services?.requestTick());
      }
      if (effect.kind === 'journal' && effect.project) {
        const project = effect.project;
        void this.services
          ?.journal(project)
          .catch((err) => log('journal', err, { project }))
          .finally(() => this.services?.requestTick());
      }
    }
  }

  // Twice a second, on the engine clock, so a controlled clock that jumps is
  // acted on within a second:
  // - deadlines on owned work (D1 §8.5): a run past its deadline is cancelled
  //   through the run-end protocol;
  // - the run lease of every run the engine holds (`holding`) is renewed once
  //   a quarter of lease_ttl has passed since its last renewal, so at least
  //   every lease_ttl/3, whether or not the role sends heartbeats (D1 §8.3;
  //   E25 item 1; E27 item 2). Nothing else renews it: a run nobody holds lets
  //   its lease expire, and the tick reconciles it (D1 §8.1 step 1);
  // - a run-end protocol that failed part way is retried once it is due.
  // A clock that steps back only delays what is due by the step: every
  // comparison here is "has enough time passed", and nothing loops on it.
  startWatch(): void {
    const renewEveryMs = (this.setting('lease_ttl') * 1000) / 4;
    this.watcher = setInterval(() => {
      try {
        const now = nowMs();
        for (const [run, handle] of this.handles) {
          if (handle.ending || handle.phase === 'never' || handle.phase === 'aborted') continue;
          if (now >= handle.deadlineMs) {
            // A run on the real boundary whose lease the engine has not
            // renewed for a whole lease_ttl was paused with the engine: the
            // tick's re-grant decides it, its deadline first (D2 §3.5).
            if (handle.sandbox !== null && now - handle.renewedAtMs >= this.setting('lease_ttl') * 1000) {
              this.services?.requestTick();
              continue;
            }
            this.requestEnd(handle, { outcome: 'timed_out', reason: 'deadline' });
            continue;
          }
          if (!handle.renewing && now - handle.renewedAtMs >= renewEveryMs && holding(handle)) this.renew(run, handle);
        }
        this.services?.retryEnds();
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

  // A heartbeat of the role renews the run lease while it is live (D1 §8.3),
  // and only until the engine has decided to end the run (E27 item 5). The
  // decision and this check are made on the main thread, and the store runs
  // its commands in the order they are sent: a renewal sent before the
  // decision commits before the decision's own transaction, and none is sent
  // after it.
  async heartbeat(handle: RunHandle): Promise<void> {
    if (handle.ending || handle.leaseLost) return;
    const { run, generation } = handle.claim;
    const at = await this.role<string | null>('run.heartbeat', run, { run, generation });
    if (at !== null) handle.renewedAtMs = Math.max(handle.renewedAtMs, Date.parse(at));
  }

  stop(): void {
    if (this.watcher) clearInterval(this.watcher);
    // The launch socket closed and removed; running services go on (D4 §9.2).
    this.deploy?.stop();
  }
}

// One line on stderr for a failure the engine survives: what failed, the
// error's message, code and stack, and what it concerned (a run, say), so a
// swallowed error can be diagnosed from the log alone.
export function log(what: string, err: unknown, context: Record<string, unknown> = {}): void {
  const e = err instanceof Error ? err : null;
  const line: Record<string, unknown> = { log: 'error', at: new Date().toISOString(), what, ...redactValue(context), detail: redactText(e ? e.message : String(err)) };
  // Not `code`: a startup refusal is the last stderr line with a string
  // `code` (SEAM.md §1), and a log line must never be taken for one.
  const code = (err as { code?: unknown } | null)?.code;
  if (code !== undefined) line.error_code = code;
  if (e?.stack) line.stack = redactText(e.stack);
  try {
    process.stderr.write(`${JSON.stringify(line)}\n`);
  } catch {
    // stderr is gone; there is nowhere left to report to
  }
}
