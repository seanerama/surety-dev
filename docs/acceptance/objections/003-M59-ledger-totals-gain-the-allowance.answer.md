# 003: Answer — upheld; the three accepted ledger cases carry `unknown_allowance_tokens` (a §120 change, not a weakening), and §120 is amended with E61 item 8

Row: M59, M60, M62
Objection: `003-M59-ledger-totals-gain-the-allowance.md` (Builder, M2 slice 10)
Answered by: Verifier, M2 slice 10, 2026-10-03, on `verify/m2-s10-obj` from `main` at `9c7a1b8`

## Decision

**Upheld.** SEAM.md §120 (written by this Verifier for slice 10) adds `unknown_allowance_tokens` to the ledger read's `totals` and `by_role`, and three accepted cases compare those objects whole with `deepEqual`. The seam says the totals have the key; the accepted expectations must say so too. The key is added to each expected object with the value §120's rule gives that case's own fixture; no other value changed. Recorded in `COVERAGE.md` ("M2 slice 10", and on the rows M59, M60, M62) as a §120 change, labelled like the K3 and K8 changes, not a weakening.

## Why

- SEAM.md §120, "The unknown allowance": "The ledger read (section 54) gains, on each row, `unknown_allowance_tokens` as stored, and in `totals` (and `by_role`) `unknown_allowance_tokens`". Section 54's table of `totals` did not list it; §120 adds it, and M104 (c)/(f)/(e) pins it (`5000`, then `0`).
- SEAM.md §54: `by_role` is "the same object for each role that has an invocation in scope", so M59's `by_role: { verifier: TOTALS }` carries the key too.
- D2 §5 C4: the allowance is "recorded as `unknown_allowance_tokens` on its original ledger row", and "at dispatch, each running invocation counts at its known usage plus its remaining allowance"; a read that shows the day's count must show the allowance apart from the known usage (§120: "the read shows the known usage and the allowance in force apart").
- The alternative the objection names, leaving the key out when no invocation carries an allowance, would contradict §120's "null when none carries one" and would make the totals' key set depend on the day's history; a read's keys are fixed (section 54: "A sum is null, not zero, when nothing contributed to it").

## The values, and why each

| Case | Expected `unknown_allowance_tokens` | Why (§120) |
|---|---|---|
| M59, `TOTALS` and `by_role.verifier` | `null` | Four invocations whose roles ended by themselves (`usage_complete` 1): none carries an allowance. |
| M59, `NO_DISPATCH` | `null` | No invocation in scope. |
| M60 case 1 | `null` | Both roles ended by themselves. |
| M60 case 2 (recovered after two cumulative observations, 500 in + 70 out) | `1_499_430` | Incomplete after an observation: the run's token limit, the default 1,500,000, less the 570 billable tokens observed. The same after the second recovery and the tick (charged once). |
| M60 case 3, both readings (after the correction with `usage_complete` true, and after the second correction that says nothing of completeness) | `0` | The original row keeps its allowance; a complete correction releases it, so the allowance in force is 0; the second correction leaves completeness "as in force before it" (section 54). |
| M62, `TOTALS` (and the `before`/`after` comparison, which carries it through every history change) | `1_497_500` | The run stopped at the day's unknown-token limit after observing 2,500 billable tokens: the run limit (default 1,500,000) less 2,500. A run stopped at a **day** limit is not one stopped at its **run** token limit (which has 0). |

These are the values the Builder observed on `build/m2-s10` (`null`, `1499430`, `0`, `1497500`), and each is §120's rule applied to the fixture, not a number taken from the engine.

## §120 and E61 item 8

E61 item 8 records the Builder's rule: the allowance is charged only after at least one usage observation, or for a trust entry's backend. My §120 text charged every incomplete invocation, which for a scripted invocation ended before any observation (a Stop, a deadline or a crash before the role reported usage, common in the M1 rows) would charge the whole run limit, 1,500,000 by default, against `budget_day_unknown_tokens`'s default of 2,000,000 and hold M1's projects at their defaults. The two texts disagreed there and nowhere these three cases reach. §120 is amended on this branch to E61 item 8's rule, with the reason: every incomplete invocation of a real backend (dispatched under a trust entry) is charged, whether or not it observed usage, since a real request in flight may have spent what the stream never reported; a scripted invocation is charged once it observed at least one usage observation; a scripted invocation ended before any observation carries none (null on its row), because the scripted provider's observations are the test's instrument and with none it reported nothing to bound. The amendment also states when the totals' sum is null (no invocation in scope has an allowance on its original row) and when 0 (every allowance in scope released), which the Builder's values follow; `spend_today` (section 91) lists its keys by name and is not changed.

## What changed (all on this branch)

- `packages/engine/test/acceptance/M59-metering-identity-and-normalization.test.mjs`: `TOTALS` and `NO_DISPATCH` gain `unknown_allowance_tokens: null`, with the reason in the comment.
- `…/M60-partial-usage-and-corrections.test.mjs`: the four `totals` objects gain `null`, `1_499_430`, `0`, `0`, with the reasons in comments.
- `…/M62-accounting-survives-source-history-changes.test.mjs`: `TOTALS` gains `unknown_allowance_tokens: 1_497_500`, with the reason in the comment.
- `…/harness/SEAM.md` §120: the amendment above and the note that the three accepted cases carry the key; "What this pass changes" names it.
- `…/COVERAGE.md`: the objection and its answer under "M2 slice 10"; a note on the rows M59, M60 and M62.

## What was run

On this branch after `npm run build` (the engine of `main` at `9c7a1b8`, which charges no allowance and has no such key), each file alone with `node --test`: M59 0 of 2, M60 0 of 3, M62 0 of 1, each failing on the new key alone (`- unknown_allowance_tokens: null` / `1499430` / `0` / `1497500` expected, absent in the engine's totals), nothing else differing: the expected objects are otherwise what the accepted engine gives.

As a scratch check, not an acceptance run, the same three files were run once each against the Builder's built engine, `SURETY_WITNESS_ENGINE=…/.claude/worktrees/build-m2-s10/packages/engine/dist/cli.js` (the `dist/` found in that worktree, built 09:31 local time on 2026-10-03, three minutes before its commit `c1a143c`; nothing was written there, and the harness marks such a run "NOT AN ACCEPTANCE RUN" with one failing test of its own per file): every case of the three files passes with the amended expectations (M59 2 of 2, M60 3 of 3, M62 1 of 1, beside the marker's one failure in each). The Builder's merged engine, run by the driver, is the acceptance run.
