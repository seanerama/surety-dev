// The main thread's handle on the store worker: one interface, a bounded
// command queue, and replies as values or refusals.

import { Worker } from 'node:worker_threads';

import { Refusal, storeError } from '../refusal.js';
import { seamMessage, seamWorkerData } from '../testing/seam.js';
import type { Reply, WorkerData } from './worker.js';

const QUEUE_LIMIT = 256;

export class StoreClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private dead: Error | null = null;

  constructor(file: string, migrationsDir: string) {
    const data: WorkerData = { file, migrationsDir, seam: seamWorkerData() };
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: data });
    this.worker.on('message', (msg: Reply | { id?: undefined }) => {
      if (typeof msg.id !== 'number') {
        seamMessage(msg);
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.value);
      else waiter.reject(Refusal.fromWire(msg.refusal));
    });
    const fail = (err: Error) => {
      this.dead = err;
      for (const w of this.pending.values()) w.reject(storeError(err));
      this.pending.clear();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', (code) => fail(new Error(`store worker exited with code ${code}`)));
  }

  call<T = unknown>(op: string, args: unknown = {}): Promise<T> {
    if (this.dead) return Promise.reject(storeError(this.dead));
    if (this.pending.size >= QUEUE_LIMIT) return Promise.reject(storeError(new Error('the store command queue is full')));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, args });
    });
  }

  async close(): Promise<void> {
    if (!this.dead) {
      try {
        await this.call('close');
      } catch {
        // closing a failed store is best effort
      }
    }
    await this.worker.terminate();
  }
}
