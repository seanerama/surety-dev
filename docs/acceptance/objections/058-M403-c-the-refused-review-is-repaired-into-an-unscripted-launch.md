# 058: M403 (c)'s refused review is retried as a repair, and the retry has no script, so it holds

Row: M403
Test: packages/engine/test/acceptance/M403-close-raises-the-products-decision.test.mjs, case "(c) neither approval alone publishes; both do, once, by the authorized finalizer; a role cannot answer"
Filed by: Builder, slice 31a, 2026-10-12

## Claim

The case adds `review` work and scripts exactly one launch for it: `roleThat([], { decisions: [...] })`. It then calls `tickUntil` until the item has an ended run, and requires that run to be `failed` / `invalid_result`.

The engine refuses the result as the case requires. `decisions` is not a field of a one-shot result (SEAM.md §343), so the run ends `failed` / `invalid_result`. But a failed run's work goes back to `eligible` with a repair due while `repair_attempts` < `repair_attempts_max` (default 3, D1 §4.3; `workAfterRun`). The project is `createWithIdea` with no policy, so the next tick round dispatches the repair. The repair has no script of its own and no default, so the role program holds it until it is killed (harness/scripted/child.mjs: "With no script at all the program holds until it is killed").

`tickUntil` ticks two rounds and then calls `waitForIdle`. The second round dispatches the held repair, so `waitForIdle` never returns:

```
error: 'timed out after 30000 ms waiting for every run of proj_… to end'
```

On a scratch copy I saw the item's runs as `[["ended","failed","invalid_result"],["executing",null,null]]`, with work `executing` and `repair_attempts` 1.

What I believe the case should do: keep the retry from holding. Either pin `repair_attempts_max: 0` on the project, as M404's `approvedSpec` does with `createWithIdea(fx, { policy: { repair_attempts_max: 0 } })`, or give the item a script for each launch it can take. The assertions can stay as they are.

## Sources

- D1 §4.3 and store/transitions/runs.ts `workAfterRun`: `failed` → `eligible` with `repair_due` while `repair_attempts` < `repair_attempts_max`.
- harness/scripted/child.mjs header: "With no script at all the program holds until it is killed".
- harness/runs.mjs `tickUntil`: `tick(engine, projects)` (two rounds by default), then `waitForIdle`.
