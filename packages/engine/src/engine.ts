// `surety serve`: the startup sequence (D1 §1.4, SEAM.md §4).
//
//   lock → listen → store → recovery → integrity → full → scheduler
//
// Configuration is read and validated before the lock (E22). The listener
// starts restricted; a failure in store, recovery or integrity leaves it
// restricted with the failure readable and the scheduler not started.

import type { Server } from 'node:http';
import { relative } from 'node:path';

import { createApiServer } from './api/server.js';
import { type EngineConfig, loadEngineConfig } from './config/engine-config.js';
import { configureGit } from './git/exec.js';
import { observeIntegrity } from './git/integrity.js';
import { Launcher } from './invoke/choke.js';
import { Effects } from './decisions/effects.js';
import { checkHomeFilesystem } from './home-fs.js';
import { Journal } from './journal/driver.js';
import { nominate } from './journal/nominate.js';
import { type LockRecord, acquireLock, releaseLock } from './lock.js';
import { DEFAULT_MIGRATIONS_DIR, homePaths } from './paths.js';
import { recoverAtStartup } from './recovery/startup.js';
import { Refusal, homeUnusable } from './refusal.js';
import { Acceptor } from './runs/accept.js';
import { RunEnder } from './runs/end.js';
import { Runtime, log } from './runtime.js';
import { Scheduler, reconcileProject } from './scheduler/tick.js';
import { StoreClient } from './store/client.js';
import { createToken, readToken } from './token.js';
import { createIncarnationScope } from './boundary/scope.js';
import { newId } from './ids.js';
import { seamHostChecks, seamScopeBarrier } from './testing/seam.js';
import { runHostChecks, type ScopeOutcome } from './trust/checks.js';

export const EXIT = { usage: 2, locked: 3, config: 4, token: 5, notStarted: 6 } as const;

// `scope` (K2's step 0, before the lock) and `host_qualification` (between
// integrity and full mode, D2 §7.1) run on every start but the harness's
// kernel lane (SEAM.md §§114, 123).
export type Step = 'scope' | 'lock' | 'listen' | 'store' | 'recovery' | 'integrity' | 'host_qualification' | 'full' | 'scheduler';

export interface StartupFailure {
  step: Step;
  code: string;
  reason: string;
  subject: unknown;
}

export interface EngineState {
  config: EngineConfig;
  lock: LockRecord;
  token: string;
  mode: 'restricted' | 'full';
  step: Step;
  completed: Step[];
  failed: StartupFailure | null;
  store: StoreClient | null;
  runtime: Runtime | null;
  // The incarnation scope (D2 §3.1), or why there is none.
  scope: { unit: string; path: string } | null;
  scopeObserved: string | null;
}

export interface ServeOptions {
  home: string;
  migrationsDir: string | null;
  // The static shell's directory, or null (SEAM.md §90).
  shellDir: string | null;
  // The kind of filesystem the home is on, if it is given rather than
  // detected (SEAM.md §88).
  homeFsType: string | null;
}

// One JSON refusal line on stderr, then exit (SEAM.md §1).
function exitRefused(status: number, refusal: Refusal): never {
  process.stderr.write(`${JSON.stringify(refusal.body())}\n`);
  process.exit(status);
}

// What stopped a start before the listener: a refusal the engine decided, or
// an environmental failure, which is reported against the path it concerns
// (SEAM.md §1 "A start that fails before listening"). Never an uncaught error.
function startFailure(home: string, err: unknown): { status: number; refusal: Refusal } {
  if (err instanceof Refusal) {
    const status =
      err.code === 'token_file_refused' ? EXIT.token : err.code === 'engine_locked' ? EXIT.locked : err.code === 'home_unusable' ? EXIT.notStarted : EXIT.notStarted;
    return { status, refusal: err };
  }
  const e = err as NodeJS.ErrnoException;
  const at = typeof e?.path === 'string' ? relative(home, e.path) || '.' : '.';
  return { status: EXIT.notStarted, refusal: homeUnusable(at.startsWith('..') ? '.' : at, e?.message ?? String(err)) };
}

export async function serve(opts: ServeOptions): Promise<void> {
  const paths = homePaths(opts.home);

  let config: EngineConfig;
  try {
    config = loadEngineConfig(paths.config);
  } catch (err) {
    if (err instanceof Refusal) exitRefused(EXIT.config, err);
    throw err;
  }

  // A home on a kind of filesystem that does not keep what is written is
  // refused before anything is written or locked (D1 §6.1; SEAM.md §88).
  try {
    checkHomeFilesystem(opts.home, opts.homeFsType);
  } catch (err) {
    if (err instanceof Refusal) exitRefused(EXIT.notStarted, err);
    throw err;
  }

  // An existing api.token is judged before the lock, reading only (SEAM.md
  // §1, §6): a start refused for it writes nothing and takes no lock.
  let token: string | null;
  try {
    token = readToken(paths.token);
  } catch (err) {
    if (err instanceof Refusal) exitRefused(EXIT.token, err);
    throw err;
  }

  // 0. The incarnation scope (D2 §3.1, K2), before the lock: the engine runs
  // in `surety-<home>-<incarnation>.scope` under the user's systemd manager,
  // in its `supervisor` leaf. A start that cannot have its scope goes on,
  // with H3 failed and real backends refused; a start the lock then refuses
  // exits, and the manager removes its empty scope with it. The harness's
  // kernel lane runs without one (SEAM.md §114).
  const incarnation = newId('inc_');
  let scope: ScopeOutcome = { scope: null, observed: 'the host checks were not run at this start' };
  const checksRun = seamHostChecks()?.mode !== 'unrun';
  await seamScopeBarrier(opts.home, checksRun);
  if (checksRun) {
    const made = createIncarnationScope(opts.home, incarnation);
    scope = made.ok ? { scope: made.scope, observed: made.scope.unit } : { scope: null, observed: made.observed };
  }

  // 1. lock. A first start creates api.token once the lock is judged free and
  // before the lock record names it, so a refusal there leaves the lock as
  // found. The listener, which needs the token, starts after.
  let lock: LockRecord;
  try {
    lock = acquireLock(
      opts.home,
      () => {
        token ??= createToken(paths.token);
      },
      incarnation,
    );
  } catch (err) {
    const { status, refusal } = startFailure(opts.home, err);
    exitRefused(status, refusal);
  }
  if (token === null) exitRefused(EXIT.notStarted, homeUnusable('api.token', 'the token was neither found nor created'));

  const state: EngineState = {
    config,
    lock,
    token,
    mode: 'restricted',
    step: 'lock',
    completed: checksRun ? ['scope', 'lock'] : ['lock'],
    failed: null,
    store: null,
    runtime: null,
    scope: scope.scope ? { unit: scope.scope.unit, path: scope.scope.path } : null,
    scopeObserved: checksRun ? scope.observed : null,
  };

  let server: Server | null = null;
  let scheduler: Scheduler | null = null;
  const shutdown = async () => {
    scheduler?.stop();
    state.runtime?.stop();
    server?.close();
    if (state.store) await Promise.race([state.store.close(), new Promise((r) => setTimeout(r, 3000))]);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  // 2. listen, restricted
  state.step = 'listen';
  server = createApiServer(state, { home: opts.home, shellDir: opts.shellDir });
  try {
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(config.values.api_port, '127.0.0.1', () => resolve());
    });
  } catch (err) {
    // This start never became an owner that others could reach: give the
    // lock back so the next start does not have to judge it stale.
    releaseLock(opts.home, lock);
    exitRefused(
      EXIT.notStarted,
      new Refusal(500, 'listen_failed', `The API could not listen on 127.0.0.1:${config.values.api_port}: ${(err as Error).message}`, 'Free the port or configure api_port.', {
        port: config.values.api_port,
      }),
    );
  }
  state.completed.push('listen');

  const fail = (step: Step, err: unknown) => {
    const r = err instanceof Refusal ? err : new Refusal(500, 'store_error', (err as Error).message ?? String(err), 'Inspect the store.');
    state.failed = { step, code: r.code, reason: r.reason, subject: r.subject };
  };

  // No request or callback may crash the engine (D1 §11.1): from here on a
  // failure the engine did not catch is reported, with its stack, and the
  // engine goes on. It cannot strand a run: a run is held only by a lease the
  // engine renews while it prepares the run or supervises its live role
  // process, and never once it has decided to end the run. Whatever such a
  // failure interrupted, that lease is then no longer renewed, expires, and
  // the tick's first step takes its run through the run-end protocol (D1 §8.1
  // step 1). A run-end protocol that failed part way is retried by the engine
  // before that (RunEnder.retryDue); the expiry is the backstop.
  process.on('uncaughtException', (err, origin) => log('uncaught exception', err, { origin }));
  process.on('unhandledRejection', (reason) => log('unhandled rejection', reason));

  // 3. store: open, migrate, record the incarnation
  state.step = 'store';
  const store = new StoreClient(paths.store, opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  state.store = store;
  try {
    await store.call('open', {
      lock,
      scope: scope.scope?.path ?? null,
      settings: {
        lease_ttl: config.values.lease_ttl,
        git_deadline: config.values.git_deadline,
        decision_targets: config.values.decision_targets,
        ui_bootstrap: config.values.ui_bootstrap,
      },
      // The resource envelope's admission (D2 §3.7), on the real boundary.
      envelope: checksRun
        ? {
            max_concurrent_domains: config.values.max_concurrent_domains,
            host_reserve_memory: config.values.host_reserve_memory,
            host_reserve_disk: config.values.host_reserve_disk,
            domain_memory_max: config.values.domain_memory_max,
            domain_writable_bytes: config.values.domain_writable_bytes,
            home: opts.home,
          }
        : null,
    });
  } catch (err) {
    return fail('store', err);
  }
  state.completed.push('store');

  configureGit({ deadlineSeconds: config.values.git_deadline, outputCap: config.values.git_output_cap, home: opts.home, incarnation: lock.incarnation_id });
  const runtime = new Runtime(store, config, lock.incarnation_id, opts.home);
  runtime.scope = scope.scope;
  const journal = new Journal(runtime);
  runtime.journal = journal;
  const ender = new RunEnder(runtime);
  const acceptor = new Acceptor(runtime, ender, journal);
  const launcher = new Launcher(runtime);
  const effects = new Effects(runtime, journal);
  scheduler = new Scheduler(runtime, launcher, ender, journal, effects);
  const tick = scheduler;
  runtime.services = {
    endRun: (run, end) => ender.endRun(run, end),
    completeEnd: (run) => ender.complete(run),
    retryEnds: () => ender.retryDue(),
    requestTick: () => tick.request(),
    accept: (handle) => acceptor.start(handle),
    nominate: (project) => nominate(runtime, journal, project),
    journal: (project) => reconcileProject(runtime, journal, project),
    effect: (intent) => effects.run(intent),
    regrant: (run) => launcher.regrant(run),
    terminateDomains: (run) => ender.terminateDomains(run),
    collectAtEnd: (handle, quarantined) => launcher.collectAtEnd(handle, quarantined),
  };

  // 4. recovery (D1 §16): every journal operation the previous incarnation
  // left is taken on its way, and every run it left is ended or quarantined,
  // before full mode.
  state.step = 'recovery';
  try {
    await recoverAtStartup(runtime, ender, journal);
  } catch (err) {
    return fail('recovery', err);
  }
  state.completed.push('recovery');

  // 5. repository integrity (D1 §7.6), for every registered project. What it
  // observes is recorded and blocks that project; it does not keep the
  // engine restricted.
  state.step = 'integrity';
  try {
    for (const project of await runtime.read<string[]>('scheduler.projects')) await observeIntegrity(runtime, project);
  } catch (err) {
    return fail('integrity', err);
  }
  state.completed.push('integrity');

  // 5a. The host checks (D2 §6, §7.1), bounded by tick_step_budget, while the
  // API answers. Their outcome never keeps the engine restricted: a host that
  // does not qualify leaves real backends refused (`isolation_unqualified`).
  if (checksRun) {
    state.step = 'host_qualification';
    try {
      await runtime.runHostChecks(() => runHostChecks(runtime, { scope, budgetMs: config.values.tick_step_budget * 1000 }));
    } catch (err) {
      log('host checks', err);
    }
    state.completed.push('host_qualification');
  }

  // 6. lift to full
  state.step = 'full';
  try {
    await store.call('engine.full', { incarnation: lock.incarnation_id });
  } catch (err) {
    return fail('full', err);
  }
  state.runtime = runtime;
  state.mode = 'full';
  state.completed.push('full');

  // 7. scheduler
  state.step = 'scheduler';
  try {
    await store.call('engine.started', { incarnation: lock.incarnation_id });
  } catch (err) {
    return fail('scheduler', err);
  }
  runtime.startWatch();
  scheduler.start();
  state.completed.push('scheduler');
}
