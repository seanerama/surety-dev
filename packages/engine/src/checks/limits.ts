// The engine's bounds for checks (D3 A.7; SEAM.md §186): engine
// configuration keys, read once at start, and the project key
// `max_concurrent_checks`, which is each project's policy. Both threads read
// them through this module: the main thread sets them from the configuration
// it validated, and the store worker from what it is handed when it opens
// the store. Until set, A.7's defaults.

export interface CheckLimits {
  // Seconds: the largest `runner_config.direct.timeout_max_s` a project may set.
  check_timeout_max: number;
  // Bytes: the largest `result_collection.output_max_bytes` a project may set.
  check_output_max_bytes: number;
  checktree_max_bytes: number;
  checktree_max_entries: number;
  checktrees_max_bytes: number;
  check_infra_retries_max: number;
}

export const CHECK_LIMIT_KEYS = ['check_timeout_max', 'check_output_max_bytes', 'checktree_max_bytes', 'checktree_max_entries', 'checktrees_max_bytes', 'check_infra_retries_max'] as const;

let limits: CheckLimits = Object.freeze({
  check_timeout_max: 30 * 60,
  check_output_max_bytes: 1024 * 1024,
  checktree_max_bytes: 2 * 1024 * 1024 * 1024,
  checktree_max_entries: 200_000,
  checktrees_max_bytes: 8 * 1024 * 1024 * 1024,
  check_infra_retries_max: 2,
});

export function setCheckLimits(values: Record<string, unknown>): void {
  const next = { ...limits };
  for (const key of CHECK_LIMIT_KEYS) if (typeof values[key] === 'number') next[key] = values[key] as number;
  limits = Object.freeze(next);
}

export function checkLimits(): CheckLimits {
  return limits;
}
