// Waits, deadlines and durations on the monotonic clock (SEAM.md §87).
//
// The host these tests were written on steps its wall clock back by about
// 1.8 seconds every half minute. A deadline computed from Date.now() can then
// pass early or late, and a duration measured with it can be wrong by seconds
// or negative. Everything the slice-6 tests time, they time here:
// performance.now() does not step. (Node's timers run on the same monotonic
// clock, so a sleep is safe as it is.)

import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

export const now = () => performance.now();

// Poll `probe` until it returns something other than undefined, null or
// false, and return that. A probe that throws is asked again; its last error
// is reported if the wait times out. An error marked `fatal` ends the wait.
export async function until(probe, { timeoutMs = 30_000, intervalMs = 50, what = 'condition' } = {}) {
  const started = performance.now();
  let lastError;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (err) {
      if (err?.fatal) throw err;
      lastError = err;
    }
    const waited = performance.now() - started;
    if (waited > timeoutMs) {
      throw new Error(`timed out after ${Math.round(waited)} ms waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`);
    }
    await sleep(intervalMs);
  }
}

// Run `fn` and say how long it took: {ms, value}.
export async function timed(fn) {
  const started = performance.now();
  const value = await fn();
  return { ms: performance.now() - started, value };
}

// The promise's value, or `fallback` if it has not settled after `ms`.
export async function settledWithin(promise, ms, fallback = null) {
  const timer = new AbortController();
  try {
    return await Promise.race([promise, sleep(ms, fallback, { signal: timer.signal }).catch(() => fallback)]);
  } finally {
    timer.abort();
  }
}

export { sleep };
