// `surety serve`: the startup sequence (D1 §1.4, SEAM.md §4).
//
//   lock → listen → store → recovery → integrity → full → scheduler
//
// Configuration is read and validated before the lock (E22). The listener
// starts restricted; a failure in store, recovery or integrity leaves it
// restricted with the failure readable and the scheduler not started.

import type { Server } from 'node:http';

import { createApiServer } from './api/server.js';
import { type EngineConfig, loadEngineConfig } from './config/engine-config.js';
import { type LockRecord, acquireLock } from './lock.js';
import { DEFAULT_MIGRATIONS_DIR, homePaths } from './paths.js';
import { Refusal } from './refusal.js';
import { StoreClient } from './store/client.js';
import { createToken, readToken } from './token.js';
import { type BarrierSpec, configureMain } from './testing/seam.js';

export const EXIT = { usage: 2, locked: 3, config: 4, token: 5, failed: 1 } as const;

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
}

export interface ServeOptions {
  home: string;
  harness: boolean;
  migrationsDir: string | null;
  barriers: BarrierSpec[];
}

// One JSON refusal line on stderr, then exit (SEAM.md §1).
function exitRefused(status: number, refusal: Refusal): never {
  process.stderr.write(`${JSON.stringify(refusal.body())}\n`);
  process.exit(status);
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
    if (err instanceof Refusal) exitRefused(err.code === 'token_file_refused' ? EXIT.token : EXIT.locked, err);
    throw err;
  }
  if (token === null) throw new Error('api.token was neither found nor created');

  const seam = configureMain(opts.harness, opts.barriers);
  const state: EngineState = {
    config,
    lock,
    token,
    mode: 'restricted',
    step: 'lock',
    completed: ['lock'],
    failed: null,
    store: null,
  };

  let server: Server | null = null;
  const shutdown = async () => {
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
    exitRefused(
      EXIT.failed,
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

  // 3. store: open, migrate, record the incarnation
  state.step = 'store';
  const store = new StoreClient(paths.store, opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR, seam);
  state.store = store;
  try {
    await store.call('open', { lock });
  } catch (err) {
    return fail('store', err);
  }
  state.completed.push('store');

  // 4. recovery (D1 §16). Slice 1 creates no runs, leases, domains or journal
  // operations, so there is nothing a recovery pass could act on yet.
  state.step = 'recovery';
  state.completed.push('recovery');

  // 5. repository integrity (D1 §7.6). Not built in slice 1: the ref
  // registry and integrity observations arrive with the git slice. This step
  // establishes nothing about any repository.
  state.step = 'integrity';
  state.completed.push('integrity');

  // 6. lift to full
  state.step = 'full';
  try {
    await store.call('engine.full', { incarnation: lock.incarnation_id });
  } catch (err) {
    return fail('full', err);
  }
  state.mode = 'full';
  state.completed.push('full');

  // 7. scheduler. The tick arrives in slice 2.
  state.step = 'scheduler';
  try {
    await store.call('engine.started', { incarnation: lock.incarnation_id });
  } catch (err) {
    return fail('scheduler', err);
  }
  state.completed.push('scheduler');
}
