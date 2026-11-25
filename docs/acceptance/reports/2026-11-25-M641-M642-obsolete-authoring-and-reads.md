# M641 and M642: the obsolete gap authoring and the reads (slice 50, kernel lane)

Verifier, 2026-11-25. Branch `verify/m641-m642`, on the driver's companion 459951d5 (engine main e6676c2d + rows M641 and M642). Test commit 1b7f9492.

Files:
- `packages/engine/test/acceptance/M641-an-obsolete-gap-authoring-is-retired-with-a-recorded-reason.test.mjs`
- `packages/engine/test/acceptance/M642-the-reads-name-a-held-phase-and-an-authorings-criteria.test.mjs`
- `packages/engine/test/acceptance/harness/gap57.mjs`: the investigator's replay (WO1 probe) restated as a harness fixture. It uses the real refusal route and makes no store write.

## Fixtures

- **M641 (a) to (d), M642 (d), (e).** Iteration 1 of a T1 prototype reaches its Alpha on c1. Iteration 2's spec v2 adds R1.2 and R3.2 and moves R1 and R3 to a new phase 2. The project is paused through the owner's route while the replan is eligible. The owner's redeploy of c1 answers 409 ACCEPTANCE_SCOPE_INCOMPLETE [R1.2, R3.2]. It queues gap item G (`check_authoring`, trigger `authoring_gap`, on iteration 1's plan, with evidence naming c1).
  - (a), (c), (d) follow the replay's scenario A: the project is paused around the publication.
  - (b) follows scenario B: three stages, the plan check routes the plan to plan_approval, and the project is not paused after the replan starts.
  - (d) also adds R2.2 to R2, which stays in phase 1.
- **M641 (e).** Iteration 1's first authoring writes no `operation.json`. The policy's deployment request is refused `kind:post_deploy_behavior`, which queues a kinds-only gap; the next authoring writes the check.
  - Not arranged: a kinds-only gap while a replan is unfinished. On this fixture the kinds gap arises only in iteration 1, when no replan is under way. (e) therefore asserts only: dispatched once, no work.hold_began, completed, no work.cancelled.
- **M642 (a), (c) stale.** The item-55 shape is not produced on e6676c2d, so I used another route with no fixture write.
  - Setup: the T1 reference journey with a phase-only check `phase-r1` (M634 (d)'s authoring). The scripted check boundary records that check's execution exit 1.
  - Observed: the phase gate is fresh and not satisfied with `CHECK_NOT_PASSED`, with no run, no work, no open decision, and NOW idle. This is the console's U58 stall.
  - Stale: after an engine restart the evaluation is stale (staleUnsatisfiedAtStart) until the next tick; the plan is read before ticking.
- **M642 (b).** M634's fixture: a Low finding is owed to the owner as `finding_disposition`, and the phase gate is not satisfied. Answering `fix` makes the phase follow c2 (followed_*), and the phase then completes.
- **M642 (c) replacement_pending.** M430 R1's fixture. On the base the latest phase evaluation is satisfied and completion is held by the replacement.

Readings: the `reason` is G's work.cancelled `payload.reason`. "Held" is the work read's `held`. `text` is any non-empty string. `evaluated_at` is the evaluation's computed_at or created_at. "Nothing on other items" means `authoring` is absent or null. "Names those items" means each eligible item's id or kind. "Unpaused, no primary_action" means `primary_action` is not `resume`.

## Results on the base (459951d5), each file run twice alone, identical

M641: 1/5.

| Case | Result | Failing assertion (run 1) |
|---|---|---|
| (a) | fail | `no run on the obsolete gap authoring … status "awaiting_decision", runs [run_…, ended]; findings from it [R1.2 open, R3.2 open]; decisions [finding_disposition open ×2]`. This is the production record. |
| (b) | fail | `G not dispatched while the bundle awaits plan_approval ({status "executing", runs [run_… validating]})` |
| (c) | fail | `no run on the obsolete gap authoring … status "executing"` |
| (d) | fail | `a narrowed next generation of the gap authoring (gap items: [[G, "eligible", 1, {criteria [R1.2, R2.2, R3.2]}]])` |
| (e) | pass | |

M642: 1/7.

| Case | Result | Failing assertion |
|---|---|---|
| (a) | fail | `plan.verification served as recorded (undefined)` |
| (c) stale | fail | The stale half passes (no entry is served). The fresh re-evaluation fails: `plan.completion_held_by is served while the phase gate is fresh and not satisfied` |
| (b) | fail | `plan.completion_held_by is served while the phase gate is fresh and not satisfied` |
| (a) followed / (c) satisfied | fail | `plan.verification served as recorded, followed_* included (undefined; recorded {nominated_revision, at, registered_at_nomination, followed_candidate, followed_revision, followed_at})` |
| (c) replacement_pending | pass | This is the existing variant, unchanged. |
| (d) | fail | `authoring served on the authoring_gap item ({… "held":null})`: no `authoring` key |
| (e) | fail | `primary_action resume ({"state":"idle","primary_action":null,"reason":"Nothing is under way, nothing waits for you, and no work can be dispatched."})` |

No fixture store writes. No objection.

## Results on the fix

Pending the Builder's sha.
