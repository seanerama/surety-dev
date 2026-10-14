# 101: M401's T1 variant drives a check execution that the engine cancelled when its candidate was superseded

Row: M401 (slice 34's T1 variant; the shared journey pump)
Tests: packages/engine/test/acceptance/M401-the-t1-variant-on-the-scripted-backend.test.mjs (its `before` hook); harness/journey/drive.mjs `pump` (line 371) → harness/checks/selection.mjs `recordExit` → `drive` → `stepExecution`
Filed by: Builder, slice 37, 2026-10-14 (the driver's ruling 2 on M401, 2026-10-14)

## Claim

On `build/m5-s37` after slice 36's merge, three runs out of three fail in the `before` hook: "the scripted check boundary moves cx_… to materializing (SEAM.md §190) (body: {"code":"illegal_transition","reason":"A check execution in cancelled cannot move to materializing in one step." …}) 409 !== 200". All three cases are then cancelled.

The kept store shows the execution registered (`check.registered`, trigger `protected_application`, seq 900). 1.3 s later it is cancelled from `queued`: `check.cancelled` (seq 1086, `why`: "its candidate was superseded by cand_…"). Cancelling a superseded candidate's queued executions is accepted engine behaviour. Under D6 K1 and K2 the next candidate is nominated while the previous one's executions are still queued. The pump read the execution as queued, and by the time it moved it, the engine had cancelled it.

The driver's ruling: the harness skips an execution that is no longer queued **only** when the engine cancelled it because its candidate was superseded (its `check.cancelled` names the superseding candidate). Any other state, or a cancellation for any other reason, still fails loudly. I propose `recordExit` (or `stepExecution`) re-read the execution when it is refused and apply that rule.

## Sources

- D3 §2.5 (a superseded candidate's queued executions cancelled); D6 K1, K2; SEAM §190.
