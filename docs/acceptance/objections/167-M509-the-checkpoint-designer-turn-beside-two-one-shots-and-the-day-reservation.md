# 167: M509's checkpoint Designer turn is posted while two one-shots are under way, and the day limit's reservation refuses it

Row: M509 (the shared journey, step (d), "a newer checkpoint than the approved revision")
Test: packages/engine/test/acceptance/M509-the-ui-builders-package.test.mjs (`make`)
Filed by: Builder, slice 40, 2026-10-17

## Claim

M509 fails in all five cases, intermittently, at the second Designer session's first turn:

```
POST …/turns admits the owner's message (SEAM.md §344) (→ 409 {"code":"budget_exhausted","reason":"Project … has passed
budget_day_unknown_tokens; the session admits no further turn.", … "limits":["budget_day_unknown_tokens"]})
```

Observed 5 times in 34 runs on this workstation (three loops of M509 alone, each in its own TMPDIR, two loops at a time): 3 in 12, 0 in 10, 2 in 12.

What the kept stores show, the same both times (`b40c8` runs 4 and 10):
- The design is approved at the batch's answer, so the wait `the design approved` returns at once.
- The approval and the API stage's integration each made the engine request a tick for itself (`scheduler.tick_requested`, causes `work_eligible`, `operation_finalized`, `decision_answered`).
- That tick dispatched two Verifier one-shots, created 11 ms and 38 ms after the test opened the checkpoint Designer session: the API candidate's `verification` and the design criteria's `check_correction`.
- When the turn was posted, both invocations were under way (receipts, no terminal observation, no ledger row).

The turn's admission checks the day limits as a dispatch (`exhaustedLimits(…, { dispatch: true })`, D1 §13.3; SEAM.md §120 as the slice-10 review's S2 amended it). Each invocation under way counts its run's remaining allowance: 1,500,000 (`budget_run_billable_tokens`) each, 3,000,000 together, against the default `budget_day_unknown_tokens` of 2,000,000. Nothing has been spent: every ledger row of the day is `unknown` with no billable tokens. The refusal is the reservation alone, and it lasts only until the two one-shots end. That is the engine's specified rule, applied as M2 accepted it. The test posts the turn into a window the engine's own ticks open.

## What the test can do (the Verifier's choice)

- Before opening the checkpoint session, wait until no run of the project is under way. `waitForIdle` alone does not prevent a requested tick from dispatching again between the wait and the POST, so wait for idle with no work `eligible` (or no `scheduler.tick_requested` after the last `engine.tick`); or
- set `budget_day_unknown_tokens` high enough for the journey at creation, alongside `design` (if the harness treats raising it as an allowed creation setting, as it does `design`); or
- treat `409 budget_exhausted` at a turn's admission, while invocations are under way, as "not yet": wait for idle and post again.

## For Sean (a design question, not this objection)

D7 G12 has the Designer work beside one-shots (M532). With the default limits (`budget_run_billable_tokens` 1.5 M, `budget_day_unknown_tokens` 2 M), any two one-shots under way refuse the owner's next Designer turn. The refusal reads "has passed budget_day_unknown_tokens … wait for the day to pass" although nothing has been spent, and D6 §2.4 says budget exhaustion "admits no further turn and closes" the session. Whether a session turn's admission should count other runs' reservations, and how the refusal should be worded and treated, is not decided for the Designer.

## Sources

- D1 §13.3; SEAM.md §§55, 120 (the reservation at a dispatch); D6 §2.4 (budget exhaustion and sessions); D7 G12 (the Designer beside one-shots).
- `packages/engine/src/store/transitions/ledger.ts` `daySpend` / `exhaustedLimits`; `packages/engine/src/sessions/session.ts` (the turn's admission).

## Decision

Decided by the driver under the owner's delegation, 2026-10-17, **as objection 156 (a)**: a Designer turn's dispatch is held on the day limits as a one-shot's dispatch is held. The hold is visible, and the held turn is dispatched ahead of one-shots that become eligible after it. The session closes `budget_exhausted` only on its own budget (`designer_session_budget_billable_tokens`), never because other runs' reservations refused a turn. A turn posted beside two Verifier one-shots is held until their reservations end, then admitted.

**No test change** (Verifier, `verify/m6-s40c` from `main` `ca0ac5a`). M509's `make` posts the checkpoint Designer turn as the owner would. Under 156 (a) the turn is held, then admitted, so the file passes on an engine that builds the hold. M509 was not run for this decision.
