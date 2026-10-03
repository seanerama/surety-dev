# 004: The repair run of M112 (e) is the item's first scripted launch, so it follows the held script and never completes

Row: M112
Test: packages/engine/test/acceptance/M112-placement-and-launch-authorization.test.mjs, case "(e) a launcher killed before placement: the domain is never launched, the run ends failed and is repaired", its last step (`waitForWork(fx.home, item, 'complete')`)
Filed by: Builder, M2 slice 11, 2026-10-03

## Claim

Every assertion of the case up to the repair passes on `build/m2-s11` (`bc87097`): the launcher waits in the supervisor leaf, the test kills it, the release is answered, the run ends `failed` / `infra_error` with the receipt `dispatch_started`, `refused`, no `domain.placed`, the domain closed, terminated and its directory removed. The case then sets `fx.scripted.defaultScript(script.complete())`, asks for a tick and waits for the item to be `complete`. That wait times out:

```
not ok 5 - (e) a launcher killed before placement: the domain is never launched, the run ends failed and is repaired
  error: 'timed out after 30000 ms waiting for work item wi_01M41CED0SKSVASJ94H6R4WRKB to be complete'
```

What the engine did, read from the store 8 s after the tick (a scratch copy of the case, outside the repository): the repair run `run_01M41CFQ9B…` is `executing`, its domain `launched` / `authorized`, the item `executing` with `repair_attempts` 1. The role is alive and holding.

Why: `launcherPausedAt` scripted the item with `fx.scripted.script(item, [script.holdThenComplete('gate')])`. `harness/scripted/child.mjs` picks a launch's script by `priorLaunches(workItem)`, the number of `launch` entries already in `launches.jsonl` for the item. The first run's launcher was killed before placement, so the role never started and logged nothing (as the case itself asserts: `fx.scripted.launches({ run: run.id })` is `[]`). The repair run's role is therefore launch index 0, takes `scripts[0]`, `holdThenComplete('gate')`, and holds; `defaultScript` applies only to an index with no script of the item's own. Nothing releases the hold, so the item stays `executing`.

## Proposed change

Release the hold after the tick (`fx.scripted.release(item)`), or script the item again before the repair (`fx.scripted.script(item, [script.complete()])`). Either keeps every assertion of the case; the engine side is unchanged by this objection.

## Sources

- `harness/scripted/child.mjs`, `priorLaunches` and `chooseScript` ("Launch n of `workItem` follows scripts[n-1]", `harness/scripted.mjs`).
- SEAM.md §125, "A launcher killed before placement": the run ends `failed` / `infra_error` and "the work is repaired like any failed run's", which it is: the repair run is dispatched and launched.
