// The main thread's handle on the event-log reader (store/reader.ts). Started
// on first use, once the store has been opened and migrated.

import { Worker } from 'node:worker_threads';

import type { PageReply, ReaderData } from './reader.js';

export interface Page {
  bytes: Buffer;
  count: number;
  last: number;
}

export class EventReader {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, { resolve: (p: Page) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor(private readonly file: string) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    const data: ReaderData = { file: this.file };
    const worker = new Worker(new URL('./reader.js', import.meta.url), { workerData: data });
    worker.on('message', (msg: PageReply) => {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.ok) waiter.resolve({ bytes: Buffer.from(msg.bytes), count: msg.count, last: msg.last });
      else waiter.reject(new Error(msg.error));
    });
    const fail = (err: Error) => {
      if (this.worker === worker) this.worker = null;
      for (const w of this.pending.values()) w.reject(err);
      this.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`the event reader exited with code ${code}`)));
    worker.unref();
    this.worker = worker;
    return worker;
  }

  // The events after `after`, at most `maxRows` of them and about `maxBytes`
  // bytes, formatted as server-sent event messages.
  page(after: number, maxRows: number, maxBytes: number): Promise<Page> {
    const worker = this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, after, maxRows, maxBytes });
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}
