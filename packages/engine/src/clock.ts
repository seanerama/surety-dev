// Engine time. Timestamps are ISO-8601 UTC with milliseconds (SEAM.md §8).
// The controlled clock of build spec §8 arrives with the slice that needs it.

export const nowIso = (): string => new Date().toISOString();
