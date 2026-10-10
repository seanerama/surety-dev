# 039: M317 (a)'s retry case cannot see the retries a round registers

Row: M317
Test: packages/engine/test/acceptance/M317-verification-outcomes.test.mjs, case "a required check interrupted until check_infra_retries_max is spent: unknown, missing naming the check; never failed, never verified"; helper `harness/deploy/rounds.mjs` `executionsOfRound`
Filed by: Builder, slice 25, 2026-10-10

## Claim

### What the case does

The case interrupts every queued execution of round 1, ticks, and repeats, then waits up to 20 ticks for round 1's row. It finds the round's executions with `executionsOfRound` (`harness/deploy/rounds.mjs`). That helper filters `postDeployExecutions` (`harness/deploy/kernel.mjs`), which keeps only executions whose `trigger.source` is `deployment_verification`.

### Why it cannot pass against the approved design

The driver approved my slice-25 design, including its section 0 fix 1: a recovery retry of a deployment-bound execution keeps its deployment binding (`environment`, `artifact_digest`, `deployment`). That is what D4 §5.3 item 7 asks for: "Recovery preserves the bounded retry accounting of round k's executions." The retry's trigger is the form SEAM §204 fixes: `{"source": "recovery", "id": <the original's trigger id>, "generation": <the original's + n>}`.

So the retry belongs to round 1. It carries `deployment.round` = round 1. Its trigger source, though, is `recovery`, so `postDeployExecutions` drops it. The case interrupts the original once and never sees the retry. The retry stays `queued`, nothing in the kernel lane moves it (SEAM §204: "the retry stays `queued` until the route moves it"), and the round correctly waits for it. The row is not reached in 20 ticks.

This was read from the kept store of a run on this branch:
- round 1 is `open` at step `checks`;
- the original execution is `interrupted`;
- one retry is `queued`, with `retry_of` set to the original, `infra_retries` 1, trigger source `recovery`, generation 2, and the deployment binding of round 1.

Before slice 25 the retry lost its binding. It was then recorded `environment_unbound` and was no part of the round, which is why the case was written this way.

### What I ask

Have `executionsOfRound` select a round's executions by their binding only (`x.deployment?.round === round`), without the trigger-source filter. Its name already says that is what it does: "every post-deploy execution the engine registered for a round, by its binding". The case then interrupts each retry as it is registered. The engine gives at most 1 + `check_infra_retries_max` executions, and the row is `unknown` with `missing` naming the check's result. That is what the case asserts.

I checked the other cases that use `executionsOfRound`:
- **M315 (g):** after a restart no retry is registered, because the service's supervision is `unknown` (E110). Its check that every execution "keeps round 1's trigger" is not affected.
- **M315 (c), (f), (h) and M318:** no execution is interrupted, so they register no retries.

### Until then

The case fails on this branch. Every other case of M317 passes (11 of 12).

## Sources
- D4 §5.3 item 7: "Recovery preserves the bounded retry accounting of round k's executions (D3's `check_infra_retries_max`, a restart resetting nothing)".
- SEAM §204: the n-th retry's trigger is `{"source": "recovery", "id": <the original registration's trigger id>, "generation": <the original's generation + n>}`; "after a restart the retry stays `queued` until the route moves it".
- The slice-25 design, section 0 fix 1, approved by the driver: "`registerRecoveryRetry` … copies neither `environment`, `artifact_digest` nor `deployment` to the retry … breaks D4 §5.3 item 7's retry accounting".
- `harness/deploy/rounds.mjs`: "Every post-deploy execution the engine registered for a round, by its binding."
