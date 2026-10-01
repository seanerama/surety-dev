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
import { Launcher } from './invoke/choke.js';
import { type LockRecord, acquireLock, releaseLock } from './lock.js';
import { DEFAULT_MIGRATIONS_DIR, homePaths } from './paths.js';
import { recoverAtStartup } from './recovery/startup.js';
import { Refusal, homeUnusable } from './refusal.js';
import { RunEnder } from './runs/end.js';
import { Runtime, log } from './runtime.js';
import { Scheduler } from './scheduler/tick.js';
import { StoreClient } from './store/client.js';
import { createToken, readToken } from './token.js';

export const EXIT = { usage: 2, locked: 3, config: 4, token: 5, notStarted: 6 } as const;

export type Step = 'lock' | 'listen' | 'store' | 'recovery' | 'integrity' | 'full' | 'scheduler';

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
}

export interface ServeOptions {
  home: string;
  migrationsDir: string | null;
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

  // An existing api.token is judged before the lock, reading only (SEAM.md
  // §1, §6): a start refused for it writes nothing and takes no lock.
  let token: string | null;
  try {
    token = readToken(paths.token);
  } catch (err) {
    if (err instanceof Refusal) exitRefused(EXIT.token, err);
    throw err;
  }

  // 1. lock. A first start creates api.token once the lock is judged free and
  // before the lock record names it, so a refusal there leaves the lock as
  // found. The listener, which needs the token, starts after.
  let lock: LockRecord;
  try {
    lock = acquireLock(opts.home, () => {
      token ??= createToken(paths.token);
    });
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
    completed: ['lock'],
    failed: null,
    store: null,
    runtime: null,
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
  server = createApiServer(state);
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
  // failure the engine did not catch is reported and the engine goes on.
  process.on('uncaughtException', (err) => log('uncaught', err));
  process.on('unhandledRejection', (err) => log('unhandled', err));

  // 3. store: open, migrate, record the incarnation
  state.step = 'store';
  const store = new StoreClient(paths.store, opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  state.store = store;
  try {
    await store.call('open', {
      lock,
      settings: { lease_ttl: config.values.lease_ttl, decision_targets: config.values.decision_targets },
    });
  } catch (err) {
    return fail('store', err);
  }
  state.completed.push('store');

  configureGit({ deadlineSeconds: config.values.git_deadline, outputCap: config.values.git_output_cap, home: opts.home });
  const runtime = new Runtime(store, config, lock.incarnation_id, opts.home);
  const ender = new RunEnder(runtime);
  const launcher = new Launcher(runtime);
  scheduler = new Scheduler(runtime, launcher, ender);
  const tick = scheduler;
  runtime.services = {
    endRun: (run, outcome, reason) => ender.endRun(run, outcome, reason),
    completeEnd: (run) => ender.complete(run),
    requestTick: () => tick.request(),
  };

  // 4. recovery (D1 §16): every run the previous incarnation left is ended
  // or quarantined, and every journal operation settled, before full mode.
  state.step = 'recovery';
  try {
    await recoverAtStartup(runtime, ender);
  } catch (err) {
    return fail('recovery', err);
  }
  state.completed.push('recovery');

  // 5. repository integrity (D1 §7.6). Not built yet: the ref registry and
  // integrity observations arrive with the git slice. This step establishes
  // nothing about any repository.
  state.step = 'integrity';
  state.completed.push('integrity');

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
  runtime.startDeadlineWatch();
  scheduler.start();
  state.completed.push('scheduler');
}
