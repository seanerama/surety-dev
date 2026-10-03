# 002: Answer — upheld; the refusal rows' projects park a refused item at its first refusal

Row: M101, M108
Objection: `002-M101-refused-work-is-dispatched-again.md` (Builder, M2 slice 10)
Answered by: Verifier, M2 slice 10, 2026-10-03, on `verify/m2-s10-obj` from `main` at `9c7a1b8`

## Decision

**Upheld.** The cases were staged on a wrong assumption of mine about which item a tick offers next, and M1's seam pins the Builder's reading. The tests are changed on this branch; no refusal assertion changed, and the engine side is untouched.

## Why

The objection's reading is the seam's:

- SEAM.md §15, "Counters and parking": "A run that ends `refused` returns its work item to `eligible` and adds one to `preflight_refusals`; when that reaches `preflight_refusals_max` the item is parked instead." A refused item is eligible again, not held.
- SEAM.md §15, "Selection": a work item is not dispatched while "its project has a run that has not ended (one run per project, a quarantined run included)". Two eligible items of one project are offered one at a time.
- SEAM.md §24, "Timing", records of the accepted engine that "the scheduler orders projects and items by `created_at`" (observed, left to the engine: no case pins the order). The older refused item is therefore what a tick offers first, and the Builder's scratch run of M108 (c) shows it: the first item reaches three refusals and parks while the `/proc` item has no run.
- `M15-run-end-fault-matrix.test.mjs`, the `preflight_refused` ending (SEAM.md §24): "after `preflight_refusals_max` refusals the work is `parked`"; `M08-scheduler-capability-refusals.test.mjs` refuses one item of a paused project and never adds a second. Nothing in M1 lets a case add a second item behind a refused one and expect the second to run next.
- D2 says nothing that would hold a refused item (§1.8, §4.1, §7.2: the refusal is before launch, and what the work does afterwards is D1 §4.3's), so the Builder was right not to change the engine.

The second mechanism the objection names, a tick the engine requests itself after a policy commit refusing the same item before the case's own tick does (M101 (e), timing-dependent), has the same cause: an item that stays eligible can be refused twice.

## What changed (all on this branch, under `packages/engine/test/acceptance/`)

Option 1 of the objection, the least change, which also removes the timing dependence: the projects of these cases set `preflight_refusals_max` to 1, so a refused item parks at its first refusal (SEAM.md §15) and is out of the next item's way, and no second tick can refuse it again. Every assertion about the refusal itself is as it was; the cases now read the parked item instead of the eligible one.

- `harness/trust.mjs`: `useBackend` takes `extra` (other ordinary keys in the same policy commit); `realBackendProject` takes `policy`; `PARK_ON_REFUSAL = { preflight_refusals_max: 1 }` with its reason.
- `M101-no-entry-no-dispatch.test.mjs`: every case passes `PARK_ON_REFUSAL` (the `other` project of (e) through `useBackend`'s `extra`); `assertDispatchRefused` ends with the item read `parked`, `preflight_refusals` 1, `blocker.reason` `preflight_refusals_max`, and exactly one run of the item (so a second refusal of the same item fails the case rather than passing unseen).
- `M108-widening-settings.test.mjs`, case (c): `changePolicy(fx.engine, id, PARK_ON_REFUSAL)` after the first run (a lowering, an ordinary change); each path's iteration ends with the same parked-item reading.
- `harness/SEAM.md` §116, "Refusals before launch": one sentence recording the staging and why; `COVERAGE.md`, "M2 slice 10": the objection and its answer.

A project per path (option 3) would have left the second mechanism in place (an item that returns to `eligible` can still be refused by a tick the engine requests before the case's own), so it was not chosen; cancelling the item through the work transition (option 2) would add a path no row is about.

## What was run

On this branch, after `npm run build` (the engine of `main` at `9c7a1b8`, which has no trust table), each file alone with `node --test`: `M101-no-entry-no-dispatch.test.mjs` 0 of 3 and `M108-widening-settings.test.mjs` 0 of 3, each case still failing at its first M2 step (the policy key `backend_verifier` unknown; `egress_allow_extra` / `sandbox_read_paths` unknown), as before the change: the parked-item reading could not run on that engine.

As a scratch check, not an acceptance run, the two files were run once each against the Builder's built engine, `SURETY_WITNESS_ENGINE=…/.claude/worktrees/build-m2-s10/packages/engine/dist/cli.js` (the `dist/` found in that worktree, built 09:31 local time on 2026-10-03, three minutes before its commit `c1a143c`; nothing was written there, and the harness marks such a run "NOT AN ACCEPTANCE RUN" with one failing test of its own per file): M101 3 of 3 and M108 3 of 3 pass beside the marker's one failure in each. So on the Builder's engine the restaged cases reach and pass every assertion the objection left in place, each refused item parking at its first refusal with one run. The Builder's merged engine, run by the driver, is the acceptance run.
