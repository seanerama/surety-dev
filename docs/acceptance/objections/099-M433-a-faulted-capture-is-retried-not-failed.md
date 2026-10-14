# 099: M433's S1 case expects a faulted capture to fail the run, but with S1 fixed the acceptance retries the transaction and the run completes

Row: M433
Test: packages/engine/test/acceptance/M433-a-failed-correction-and-a-partial-one.test.mjs, case "S1: the failed run's assessment resolves nothing; its repair captures the correction and the assessment and resolves both"
Filed by: Builder, slice 36, 2026-10-14

## Claim

The case arms a one-shot `before_event` fault on `protected.proposed`, then asserts "the fixture is live: the faulted acceptance fails the run" (`first.outcome !== 'completed'`). It then expects the repair (launch 2) to resolve both obligations.

The run failed on 46e326a only because of the defect S1 names. The assessment committed in a transaction of its own; the capture then failed and was retried; the retry's validation found integration's obligation already resolved and refused the run `invalid_result`, "spec_applicability names no open obligation it covers".

With S1's ruling built (d6dbddf: the assessment is recorded only inside the capture transaction), the injected fault rolls back the capture and the assessment together. The acceptance pipeline retries a step that threw (`runs/accept.ts` `pipeline`, as built since M1). The retry finds both obligations open, captures the correction and records the assessment once, and the run completes. On `build/m5-s36` at 076f010 the case fails at that liveness check: "the faulted acceptance fails the run (completed/none: null)". That is the ruling's "a failed or retried run leaves the obligation open, and the retry or repair succeeds", reached through the retry rather than the repair.

I propose the case accepts the retry. After the first run ends: if it completed, the fault was observed to fire (it is consumed), there is exactly one assessment row, and integration is resolved by it. If it did not complete, the repair path as written. Either way, no obligation is resolved by an assessment whose capture rolled back.

## Sources

- The driver's slice-36 review rulings, S1 (2026-10-14).
- `runs/accept.ts` `pipeline`: a step that throws is retried with backoff while the run is `validating`.
- SEAM §61 (`before_event`: the transaction rolls back and is reported like any store failure).
