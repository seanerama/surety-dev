# 002: A refused item stays eligible and is dispatched again, so a case that adds a second item to the same project waits for a run that never starts

Row: M101, M108
Test: packages/engine/test/acceptance/M101-no-entry-no-dispatch.test.mjs, cases "(a) no entry, (b) a proposed entry, (c) a revoked entry: ..." and "(e) an authorized qualification attempt dispatches nothing but its canaries: ..."; packages/engine/test/acceptance/M108-widening-settings.test.mjs, case "(c) an approved sandbox_read_paths that exposes forbidden authority refuses every launch mount_plan_refused, ..."
Filed by: Builder, M2 slice 10, 2026-10-03

## Claim

Each of these cases refuses one item of a project, then adds another item to the **same project** and asks for **one** tick, expecting the new item to be dispatched (and refused) and the first refused item to show `preflight_refusals` 1. On the accepted engine a preflight refusal leaves the item `eligible` with its count raised (SEAM.md §15; D1 §4.3), and the scheduler dispatches a project's eligible items oldest first, one run per project at a time (max_concurrent_runs 1, E18). So the tick dispatches the **older** refused item again, not the new one:

- M101 (a) to (c): after (a), the (a) item is eligible with one refusal. The tick (b) asks for dispatches the (a) item a second time, and the (b) item has no run. `waitForRun(item (b), {state: 'ended'})` times out after 30 s ("timed out after 30000 ms waiting for run 1 of wi_... to be ended").
- M101 (e): a tick the journal requests after the second project's policy commit dispatches the item, and the case's own tick dispatches it again: `preflight_refusals` is 2, and the assertion "the refusal is counted on the work item" fails (`2 !== 1`). Whether this happens depends on timing: it failed in my first run of the file and passed in the second.
- M108 (c): each iteration adds an item and asks for one tick, and the policy changes between iterations request further ticks. The earlier refused items are dispatched first. A scratch reproduction: after the `/run` iteration the first item has 1 refusal; after the `/proc` iteration the first item has 3 refusals and is parked, and the `/proc` item has 0 runs. The case times out waiting for that run.

The refusal itself is as the cases require: M101 (d), which refuses one item of its project, passes on this branch with every assertion of `assertDispatchRefused`, and in M101 (a) and M108 (c) the first item's refusal passes its assertions before the second item is added. What fails is which item a later tick dispatches, and M1's scheduler already pins that.

I believe each case should take the earlier refused item out of the way before it adds the next, or use a project per path. Any of these keeps every refusal assertion as it is:

1. Set `preflight_refusals_max` to 1 for the project, so a refused item parks at once (SEAM.md §15); the "refusal is counted" assertion then reads the parked item's count.
2. Cancel the refused item through the harness's work transition (`forceTransition(item, 'cancelled')`) before the next one is added.
3. Use a fresh project (`addGitProject`) for each path or entry status.

## Sources

- SEAM.md §15 (line 423): "A run that ends `refused` returns its work item to `eligible` and adds one to `preflight_refusals`; when that reaches `preflight_refusals_max` the item is parked instead."
- D1 §4.3: "`preflight_refusals` parks at `preflight_refusals_max`".
- `packages/engine/src/store/reads.ts`, `dispatchCandidates`: eligible items of a project are offered in `seq` order, and `dispatchBlocker` allows one run per project ("project has a run").
- M08-scheduler-capability-refusals.test.mjs avoids this by pausing the project before adding its one item.

The engine side is unchanged by this objection. I have not made a refused item wait, because nothing in D2 or the seam says a refusal should hold an item, and M1 pins that it is eligible again.
