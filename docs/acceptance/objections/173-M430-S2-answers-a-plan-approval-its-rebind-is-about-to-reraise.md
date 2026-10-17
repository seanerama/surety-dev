# 173: M430 S2 answers the replacement's plan_approval in the ~100 ms before stage 1's integration re-raises it

Row: M430
Test: packages/engine/test/acceptance/M430-replacements-pending-while-stages-move.test.mjs, case "S2 stage 1 integrated and verifying, kept by the replacement; its check fails after the swap: …"
Filed by: Builder, slice 41, 2026-10-17

## Claim

S2 waits until stage 1's candidate exists (`candidatesOfProject(...)[0]`). It then reads the open `plan_approval` (`currentApproval`) and answers it at once (`approveNow`). The replacement is a replan's bundle. Its manifest's `baseline_revision` is the head the bundle was re-based onto (`bundleManifest`, `boundHead`). Stage 1's integration moves the head, so on the next tick the rebind re-raises the pending approval as its next generation. That is by design: slice 34's ruling, and the harness's own comment on `currentApproval`: "a harmless head move re-raises a pending one as its next generation". The candidate is nominated after the integration moves the head and before that tick's rebind. If S2's `done()` check lands in that window, it reads the generation bound to the old head. Its answer then races the rebind, and when the rebind commits first the answer is 409 `decision_invalidated`. That is the failure the gate saw.

The event timeline of one S2 run is below (a scratch copy outside the repository, `/tmp/b41/scratch/m430.mjs`; the store's `events`, on `build/m6-s41` at `46b18ab`). The plan_approval had already been re-raised once by an earlier head move.

```
665 work.integrated        15:02:03.028  stage 1, revision d6f7ce9…   (the head moves)
670 engine.tick            15:02:03.033
677 candidate.nominated    15:02:03.071  revision d6f7ce9…            (S2's condition holds from here)
693 decision.invalidated   15:02:03.176  plan_approval, "dependency manifest changed", changed [".baseline_revision"]
694 decision.raised        15:02:03.176  plan_approval, semantic_generation 3, bound to the new head
```

Between 03.071 and 03.176, `currentApproval` returns generation 2, bound to `62aca25…`. Generation 2 is invalidated at 03.176, so an answer posted after that is refused 409 `decision_invalidated`. Once generation 3 is raised (bound to the current head), one more tick changes nothing (the same probe, before and after a tick).

## Is it slice 41's?

I found nothing in slice 41 that touches this path:

- The `plan_approval` manifest, `bundleManifest` and the rebind are unchanged.
- Plan check clause 5 records nothing under `design` off, and M430 runs under `design` off.
- The batch inventory change is the design batch's only.
- The `.effective` policy fix changes the materialization caps, which are read on the real boundary only.
- The tick does a little more work per round: one extra read of the held turns, one more query in `dispatchBlocker`, and one more per receipt in flight in the day check.

Rates, M430 (this file) run alone:

| Where | Runs | Failed |
|---|---|---|
| mini-hp01, `f6287ea` (the gate's) | 9 | 2 |
| mini-hp01, `1bbe470` (main) | 6 | 0 |
| workstation, `build/m6-s41` at `46b18ab`, whole file, `TMPDIR=/tmp/b41` | 10 | 0 |
| workstation, `1bbe470` exported and built, whole file | 10 | 0 |
| workstation, `46b18ab`, S2 only, four in parallel | 20 | 0 |

The mini-hp01 figures are the gate's; I ran none on mini-hp01. 2 of 9 against 0 of 6 is not a significant difference (Fisher's exact test, two-sided, p ≈ 0.49). The window exists on main as well: it is the nomination-to-rebind interval, about 100 ms in the run above. Any timing shift moves how often `done()` lands in it.

## What the test should require

S2 should wait for the open `plan_approval` to be bound to the integration head before reading it (its manifest's `baseline_revision` equal to the registered head). Or, if its answer is refused 409 `decision_invalidated`, it should read `currentApproval` again and answer once more. That is the re-raise the harness already expects. The case's subject is unchanged: approved while stage 1 is verifying, the repair dispatched, and stage 1 verified.

## Sources

- plan/bundle.ts `bundleManifest` (a replan's bundle binds the head it was re-based onto), the rebind (`rebindDue`, `rebindBundle`), store/transitions/queue.ts `refreshDecisions`.
- harness/journey/review35.mjs `currentApproval`: "a harmless head move re-raises a pending one as its next generation, slice 34's ruling; SEAM.md §405".

## Decision

Upheld by the driver under the owner's delegation, 2026-10-17. **The test is changed; the engine is not** (Verifier, `verify/m6-s41d` from `main` `743f674`).

- **The wait, not a retry.** `harness/journey/review35.mjs` gains `registeredHead` (the integration ref's `expected_oid` in `ref_registry`, the head `rebindDue` compares with) and `boundApproval`: the open `plan_approval` once its manifest's `baseline_revision` equals that head, or null once none is open. Until then it ticks one round at a time, answering nothing and recording no exit, for at most 20 rounds, then fails naming the bound head and the registered one. M430's `approveNow` reads the approval through it instead of `currentApproval`. No answer is retried on a 409.
- **S2 keeps its subject.** Its checks stay queued while it waits, so the approval still lands while stage 1 is verifying. A new assertion makes that explicit: stage 1 is not `verified` at the approval. The swap, the failed `accept-r1` after it, the repair dispatched and stage 1 reaching `verified` are unchanged.
- **S1 (a) had the same window, and is fixed the same way.** It answers right after stage 2 integrates. In an instrumented run its open generation was still bound to the head before that move at the first read (`4db659c…` against the registered `ec7ca88…`). If the rebind commits first, its answer is 409 `decision_invalidated`, and `assertStale` accepts only `plan_generation_stale`. With the wait, the rebind decides first. It found stage 2 changed and staled the bundle, closing the approval, so `approveNow` returns null. `assertStale`'s other branch then checks that the bundle is listed `stale` and that the replan's next generation exists, and the "never silently dropped" check is unchanged. One consequence: S1 (a) no longer posts an answer, so the approval-time guard (`bundleGuard`) is not exercised there. S1 (b) still exercises it, because it moves no head (its stage 1 parks without integrating). Its approval was bound to the registered head at the first read.
- **S1 (b) and M4** have no window. S1 (b) moves no head before its approval. M4 answers a `blocker`, not a `plan_approval`, and waits for publications through `pumpNoIdle`.
- **M429 (`M429-a-replacement-at-phase-verification`)**, the only other file that uses `currentApproval`, answers after `phase_verification` is under way. That is many ticks after the last stage's integration, and every tick runs the rebind. In an instrumented run its approval was bound to the registered head (`cb381a7…` on both). It is left unchanged.

**Run** against main's engine at `743f674` (`npm ci`, `npm run build`, each run `node --test` on M430 alone): **10 runs alone with `TMPDIR=/tmp/v41d`, 10 of 10 passed, 4 of 4 tests each. Then 5 rounds of 3 copies in parallel (`/tmp/v41d1` to `/tmp/v41d3`), 15 of 15 passed, 4 of 4 tests each.** None ran on mini-hp01. Before the change the failure rate there was 2 in 9, and the workstation showed none in 40, so the workstation runs show that the change does no harm. They do not show that the race is gone. The gate's run on mini-hp01 is the evidence for that.
