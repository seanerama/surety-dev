// The two server-sent event streams (D1 §§11.3, 12.1, 14.2, 17(5), D1-33;
// SEAM.md §92): the event log after a cursor, and a run's captured output
// from a byte offset.
//
// Both hold a bounded amount of undelivered data for a client: the next page
// is fetched only once the client has taken the last one. A client that takes
// nothing for STALL_MS while the engine has data for it is let go of: its
// connection is closed, and the last whole message it received is its cursor.
// A client that reads its stream is never let go of. Nothing here may stop
// the engine: a client that fails ends its own stream and nothing else.

import type { ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';

import { liveTranscript, transcriptChange } from '../records/files.js';
import type { StoreClient } from '../store/client.js';
import type { EventReader } from '../store/reader-client.js';

export const STALL_MS = 5000;
// What one page of the log handed to a client holds at most.
const PAGE_ROWS = 1024;
const PAGE_BYTES = 512 * 1024;
// One output message holds at most this much of a run's output.
const TAIL_CHUNK = 64 * 1024;

const gone = (res: ServerResponse): boolean => res.destroyed || res.writableEnded;

// Resolves true once the client has taken what was written, false if it went
// away or was let go of for taking nothing for STALL_MS.
function drained(res: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    let last = res.writableLength;
    let progressAt = performance.now();
    const finish = (value: boolean) => {
      clearInterval(timer);
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(value);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const timer = setInterval(() => {
      if (gone(res)) return finish(false);
      const now = res.writableLength;
      if (now < last) {
        last = now;
        progressAt = performance.now();
        return;
      }
      if (performance.now() - progressAt >= STALL_MS) {
        // Let go of a client that takes nothing (SEAM.md §92).
        res.destroy();
        finish(false);
      }
    }, 250);
    res.on('drain', onDrain);
    res.on('close', onClose);
  });
}

// Write and wait until the client can take more. False: the stream is over.
async function deliver(res: ServerResponse, chunk: Buffer | string): Promise<boolean> {
  if (gone(res)) return false;
  if (res.write(chunk)) return true;
  return drained(res);
}

// Resolves when `ready()` may have become true (a nudge from `subscribe`),
// after `ms` at the latest, or when the client goes away.
function waitFor(res: ServerResponse, subscribe: (wake: () => void) => () => void, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => {};
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      res.off('close', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    res.on('close', done);
    unsubscribe = subscribe(done);
  });
}

// GET /v1/events?since=<seq>[&limit=<n>]: every committed event after the
// cursor, once, in order; then, without a limit, each event as it commits.
// With a limit the response is one page and ends; it never waits.
export async function serveEvents(res: ServerResponse, ctx: { reader: EventReader; store: StoreClient; since: number; limit: number | null }): Promise<void> {
  let cursor = ctx.since;
  let remaining = ctx.limit ?? Number.POSITIVE_INFINITY;
  try {
    for (;;) {
      if (gone(res)) return;
      if (remaining <= 0) {
        res.end();
        return;
      }
      const page = await ctx.reader.page(cursor, Math.min(PAGE_ROWS, remaining), PAGE_BYTES);
      if (page.count === 0) {
        if (ctx.limit !== null) {
          res.end();
          return;
        }
        // Caught up: wait for the next commit.
        const at = cursor;
        if (ctx.store.lastSeq <= at) await waitFor(res, (wake) => ctx.store.onSeq((seq) => seq > at && wake()), 1000);
        continue;
      }
      cursor = page.last;
      remaining -= page.count;
      if (!(await deliver(res, page.bytes))) return;
    }
  } catch {
    res.destroy();
  }
}

const outputMessage = (offset: number, bytes: Buffer): string =>
  `id: ${offset + bytes.length}\nevent: output\ndata: {"offset":${offset},"b64":"${bytes.toString('base64')}"}\n\n`;
const endMessage = (offset: number): string => `id: ${offset}\nevent: end\ndata: {"offset":${offset}}\n\n`;

// Where a run's tail reads from: its live transcript while the engine writes
// it, its published transcript once that exists, or nothing yet.
export type TailSource = { kind: 'file'; read: (offset: number, max: number) => Promise<Buffer>; total: number };

// GET /v1/projects/:p/runs/:r/tail?offset=<n>: the run's captured output,
// redacted, from the offset, as it is captured; `end` once it has ended.
// `settled` says what to read when no live transcript is there: the
// published one, a run whose output ended unpublished ('ended'), or one
// whose output has not begun ('pending').
export async function serveTail(res: ServerResponse, ctx: { run: string; offset: number; settled: () => Promise<TailSource | 'ended' | 'pending'> }): Promise<void> {
  let offset = ctx.offset;
  try {
    for (;;) {
      if (gone(res)) return;
      const live = liveTranscript(ctx.run);
      if (live) {
        const bytes = await live.read(offset, TAIL_CHUNK);
        if (bytes.length > 0) {
          if (!(await deliver(res, outputMessage(offset, bytes)))) return;
          offset += bytes.length;
          continue;
        }
        if (live.over) {
          // Everything it accepted that can still be read has been delivered.
          await deliver(res, endMessage(offset));
          res.end();
          return;
        }
        await waitFor(res, (wake) => live.listen(wake), 1000);
        continue;
      }
      const settled = await ctx.settled();
      if (settled === 'pending') {
        await transcriptChange(250);
        continue;
      }
      if (settled === 'ended') {
        await deliver(res, endMessage(offset));
        res.end();
        return;
      }
      {
        while (offset < settled.total) {
          const bytes = await settled.read(offset, Math.min(TAIL_CHUNK, settled.total - offset));
          if (bytes.length === 0) break;
          if (!(await deliver(res, outputMessage(offset, bytes)))) return;
          offset += bytes.length;
        }
        await deliver(res, endMessage(offset));
        res.end();
        return;
      }
    }
  } catch {
    res.destroy();
  }
}
