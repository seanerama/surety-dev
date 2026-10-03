# 003: The ledger read's totals gain `unknown_allowance_tokens` (SEAM.md §120), and three accepted cases compare the totals with deepEqual

Row: M59, M60, M62
Test: packages/engine/test/acceptance/M59-metering-identity-and-normalization.test.mjs (both cases: `TOTALS`, `NO_DISPATCH`), M60-partial-usage-and-corrections.test.mjs (all three cases), M62-accounting-survives-source-history-changes.test.mjs (`TOTALS`)
Filed by: Builder, M2 slice 10, 2026-10-03

## Claim

SEAM.md §120, fixed for slice 10: "The ledger read (section 54) gains, on each row, `unknown_allowance_tokens` as stored, and in `totals` (and `by_role`) `unknown_allowance_tokens`, the sum of the allowances in force over the invocations in scope (null when none carries one)". M104 (c) pins the key in `totals` (`unknown_allowance_tokens: 5000`, then `0`). The three accepted cases above compare `totals` (and M59 `by_role`) with `assert.deepEqual` against objects written before the key existed. Each now fails on that key alone. From the runs on this branch:

- M59, both cases: `+ unknown_allowance_tokens: null` (no allowance is charged; the key is null, as §120 says).
- M60, case 1: `+ unknown_allowance_tokens: null`. Case 2, the recovered run: `+ unknown_allowance_tokens: 1499430` (§120: "or it was recovered"). Case 3, after the complete correction: `+ unknown_allowance_tokens: 0`.
- M62: `+ unknown_allowance_tokens: 1497500`.

No other key or value differs in any of these assertions. I believe the expected objects should gain the key with the values above, as the K3 and K8 changes did for M68, M37, M53 and M74. The alternative, leaving the key out of `totals` when no invocation carries an allowance, would satisfy M59 and M60's first case only, and would contradict §120's "null when none carries one".

## Sources

- SEAM.md §120, "The unknown allowance" (quoted above).
- M104-estimated-cost-and-unknown-allowance.test.mjs, case (c)/(e)/(f): `pick(ledger.totals, [..., 'unknown_allowance_tokens', ...])` equal to `5000`, then `0`.
- SEAM.md §54's table of `totals`, which the accepted cases follow, does not list the key: §120 adds it.
