# 009: `armedRole` waits for the item's first run to be executing, so M125 (c)'s resumed run, the item's second, is never found

Row: M125
Test: packages/engine/test/acceptance/M125-handover.test.mjs, case "(c) the context package, fresh and resumed, …" (line 172: `const second = await armedRole(fx, project, item, …)` after `resumeWork`); the helper `armedRole` in packages/engine/test/acceptance/harness/sandbox/view.mjs (line 82: `const run = await waitForRun(fx.home, item, { state: 'executing' })`)
Filed by: Builder, M2 slice 12, 2026-10-03

## Claim

`armedRole` finds the role's launch by the work item (`waitForHolding({ work_item: item }, 'armed')`, which takes the latest launch) and then the run by `waitForRun(fx.home, item, { state: 'executing' })`, whose `index` defaults to 0: the item's **first** run. In M125 (c) the item's first run was stopped (`first.stop()`, asserted `stopped` / `human_stop`) before `resumeWork`; the resumed run is the item's second (the case itself asserts `runsOf(fx.home, item)[1].parent_run === first.run.id`). The first run never becomes `executing` again, so the wait times out although the resumed run's role is holding at `armed`:

```
not ok 2 - (c) the context package, fresh and resumed, …
  error: 'timed out after 30000 ms waiting for run 1 of wi_01M41VB7N2H23BENH8DVAZTY56 to be executing'
    async armedRole (harness/sandbox/view.mjs:82:15)
    async TestContext.<anonymous> (M125-handover.test.mjs:172:20)
```

The fresh part of the case passes before it on `build/m2-s12` (the manifest, the requirement by its id, the stage's goal in the prompt, the package read-only, no raw report).

## Proposed change

In `armedRole`, find the run of the launch that is holding: `waitForRunState`/`waitFor` on `launch.run` (the scripted launch entry carries `run`), or `waitForRun(fx.home, item, { index: runsOf(fx.home, item).length - 1, state: 'executing' })`. No case's meaning changes.

## Sources

- harness/sandbox/view.mjs `armedRole`; harness/runs.mjs `waitForRun` ("The (index+1)-th run of a work item").
- SEAM.md §17 (`parent_run`), §139 ("A resumed run lists at least one `prior_run` file …").
