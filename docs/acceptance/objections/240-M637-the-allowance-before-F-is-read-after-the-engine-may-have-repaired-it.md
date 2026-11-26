# 240: M637 reads "the allowance before F" after the engine's own tick may already have registered F's fix ("3 → 3")

Row: M637 ((a), "one unit of prototype_repairs_per_iteration consumed")
Test: packages/engine/test/acceptance/M637-a-verifiable-defect-is-repaired-within-the-brief.test.mjs at 0f8d14c0: `toFinding` (S.repairsAtF) and `assertRepairedByPolicy` (the "one unit" assertion)
Filed by: Builder B, item 57 rulings batch, 2026-11-26

## Claim
On the final gate tree 285b0571, (a) high failed once with "one unit of prototype_repairs_per_iteration consumed (3 → 3)". The preset allowance is 4 (config/schema.ts `prototype_repairs_per_iteration: int(4, 0, 40)`), and the passing runs and (b)'s report read "4 → …". So exactly one unit was consumed in that run (4 − 1 = 3 at the end), and it was consumed **before** the test read `S.repairsAtF`.

The engine registers the policy fix with its `fix_registered` act in the transaction that first sees F reproduced. That is either the sweep of the tick the engine requests itself when the verification run's launcher exits (E79 item 2, the launcher-exit tick), or the recording of X's failing result (reconcileRepair → policyFix). `pumpWith` reads F on the next pass of its loop, after `idle`. When the engine's own tick lands between F's raise and that read, the unit is already spent and the test's "before" is 3. It is a race between the test's read and the engine's own tick.

The engine side was checked: there is one writer of the act (policy-fix.ts policyFix), used by both paths, writing exactly one row with the iteration the fix belongs to, in the transaction that records the disposition. New unit cases cover the result-transaction path and the sweep path (e1-policy-fix-holds-the-stage).

## What I ask
The Verifier reads the allowance before F can exist. For example, take S.repairsAtF before the verification that raises F is dispatched (after `alphaReady`, with no repair spent yet). Or assert `repairs_iteration` at the end against the iteration's limit less its stage repairs and the policy's `fix_registered` acts. Either way, not against a read taken after the engine may have acted.

## Sources
- config/schema.ts l.362 (preset 4); prototype.ts iterationAccount (repairs_used counts fix_registered acts).
- test/unit/launcher-exit-tick.test.mjs (a run's end requests one tick).
- The gate log gate58/local-final/logs-M637-…log l.17: "(3 → 3)".
