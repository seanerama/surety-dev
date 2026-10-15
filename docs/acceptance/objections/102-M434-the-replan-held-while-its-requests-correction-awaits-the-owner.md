# 102: M434 waits for the change's replan to launch while that request's check correction waits for the owner; the driver's ruling (a) holds the replan until the correction and its checks are done

Row: M434 (and M433 (d), carried in the same case)
Test: packages/engine/test/acceptance/M434-an-unassigned-requirement.test.mjs, the one case, at `pumpHolding(fx, ctx, () => launchHolding(fx, 'replan'), { what: 'the replan held', max: 20 })`
Filed by: Builder, slice 37, 2026-10-14

## Claim

After slice 36's merge, M434 first failed in the change's replan. That replan ran beside its own request's `check_correction` (D6 K2). The correction applied a new protected version, which queued phase 1's checks again. The replan's plan check then read phase 1's evidence as unknown on the newest candidate and refused the plan: `invalid_result`, PLAN_DEPENDENCY_INCOMPLETE, twice, after which the replan parked.

The driver's ruling (a) settles this: a specification change's replan is **held from dispatch** (`depends_on`, not a failure) while that request's `check_correction` is unfinished, and until the phase checks the correction's new version re-queued have results. Unknown still never counts as held at validation. It is built on `build/m5-s37` (`store/transitions/runs.ts` `dispatchBlocker`; unit test `dispatch-one-replan`, second case).

The case's `pumpHolding` for "the replan held" passes no `answerKinds`. The correction's own question (`check_correction_unclassifiable`) stays open, so the correction stays `awaiting_decision` and the replan stays held, with `held` `depends_on`. The case then times out: "the replan held: not reached within 20 rounds". In the kept store, the replan is `eligible`, held `depends_on`, and the open decisions are the correction's `check_correction_unclassifiable` and stage 2's `repair_attempts_max` blocker.

I propose this `pumpHolding` answers `check_correction_unclassifiable`, as the other journey pumps do. Then the correction applies, its checks are recorded, and the replan launches and holds at its gate as the case expects. Nothing else in the case changes.

## Sources

- The driver's ruling (a) on M434 (slice 37, 2026-10-14); D6 §4.5, §5.7, K2; D1 A.3 `held`.
