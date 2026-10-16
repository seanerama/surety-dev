# 118: M207's second policy change comes after the plan exists, so under K1 the stage's Builder launches before its script is written

Row: M207
Test: packages/engine/test/acceptance/M207-reuse-bounded-history-beside-the-result.test.mjs, case "(c) two failures then a pass at the same bindings …"
Filed by: Builder, 2026-10-16, on `fix/m5-test-health` from main 4c0f067, on the driver's instruction

## What fails

On this workstation the case fails every time. It failed 5 of 5 alone at 4c0f067, and failed at 6426618 and at d1f8f11 as well:

```
not ok 1 - (c) two failures then a pass at the same bindings: …
  error: 'timed out after 15000 ms waiting for 1 candidate(s) of proj_…'
```

The stack is `waitForCandidates` (harness/gitruns.mjs) in `nominateStage` (harness/checks/selection.mjs).

## Where it started

Bisected on main's first-parent line. Each step built and ran the file alone with `node --test --test-concurrency=1`.

- 24bdf0d (before M5's build): pass.
- ebf298b, fd93810, 0cc869f, 4695751 (slice 36 merged): pass.
- eccfceb (slice 37 merged: K1, the requested tick): **first bad**.
- d1f8f11, 6426618, 4c0f067: fail.

## Mechanism (store read at the timeout)

The case pins `autonomy: step` through `discoveredProject`'s `policy`, before the plan (SEAM §363). It then makes a **second** policy change, `repair_attempts_max: 0` (objection 030), **after** `discoveredProject` has installed the plan. Only then does `nominateStage` write the Builder's script and tick.

Under D6 K1 the plan's `work.created … to: eligible` requests a tick (`scheduler.tick_requested`, cause `work_eligible`), and that tick dispatches the stage's Builder at once. The events from the kept store:

- seq 25: `work.created` (eligible).
- seq 26: `scheduler.tick_requested` `work_eligible`.
- seq 28 to 30: `run.created`, `run.claimed`, `work.claimed`.
- seq 36: the case's `POST …/policy` (`repair_attempts_max`) is admitted; its commit and ref update are seq 34 to 65.
- seq 47 and 48: `invocation.status launched`, `run.started`. The launch comes before the policy change finishes, so before `nominateStage` writes the script.
- seq 63: `policy.changed` `{repair_attempts_max: 0}`.
- After that: the run only heartbeats. There are no candidates (`candidates: []`), and the work item is `executing`.

The launch found no script of its own, so the role holds and never nominates. The policy commit always takes longer than the dispatch, so the case loses this race every time. Before K1 nothing ticked until the case's own `tick`.

This is the case SEAM §363 describes for M234 (g): "so no tick between two policy changes can dispatch the stage's work before its script is written (case (g) saw the first Builder launch `unscripted`)". Its "every pin before the plan" list moved M208's fixtures to `discoveredProject`'s `policy`. M207's own key was left as a separate change after the plan.

## Claim

The engine does what K1 says (D6 §12.1 K1: "A transition that makes work eligible … sets the same flag, so the next tick follows at once"). The case assumes nothing is dispatched between the plan's installation and its own tick, and K1 removed that.

## Proposed

Make the case's two keys one change, before the plan, as §363 does for M234:

```js
const p = await discoveredProject(fx, ['sm'], { policy: { autonomy: 'step', repair_attempts_max: 0 } });
// (and drop the separate changePolicy after it)
```

Checked in a scratch copy of the file (imports made absolute, outside the repository), with only that change: **5 of 5 pass** at 4c0f067.

A narrower window stays in every `discoveredProject` + `nominateStage` case: the plan's tick can dispatch the Builder before `nominateStage` writes its script. It almost always loses to the script write, which follows with no I/O in between. Writing the stage's script (or a `kindScript('stage_build', …)`) before `installIndexedPlan` would close it. That is the Verifier's call.

## Sources

- D6 §12.1 K1; SEAM §§363, 430; objection 030; objection 100 (the same class across other files).
- `store/transitions/tick-requests.ts` `requestOf` (`work.created … to: eligible` → `work_eligible`).
