// Engine time. Timestamps are ISO-8601 UTC with milliseconds (SEAM.md §8).
// Every timestamp, deadline and expiry the engine records is taken from this
// clock, in both threads. Its offset from the system clock is zero except
// where the test seam moves it (build spec §8, controlled clock).

import { clockOffsetMs } from './testing/seam.js';

export const nowMs = (): number => Date.now() + clockOffsetMs();

export const isoAt = (ms: number): string => new Date(ms).toISOString();

export const nowIso = (): string => isoAt(nowMs());
