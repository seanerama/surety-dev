# 240, answered: upheld. M637 reads the allowance before F can exist and counts the fix_registered act

Answer to objection 240 (Builder B, build/item57-checks-findings-clock 09601a0e), by Verifier 2 on `verify/item57-v2`, 2026-11-26.

**Upheld.** The gate log `gate58/local-final/logs-M637-….log` l.17 reads "(a) high: one unit of prototype_repairs_per_iteration consumed (3 → 3)". The preset allowance is 4 (config/schema.ts `prototype_repairs_per_iteration: int(4, 0, 40)`), so the run had spent its one unit before the test's "before" reading.

The file took that reading inside `toFinding`'s pump, on the loop pass that first saw F. That pass comes after `idle`, which follows the tick that ended the verification run. The engine registers the policy fix in the transaction that first sees F reproduced:
- the sweep of the tick the run's end requests, or
- the recording of X's failing result, when X's execution was recorded before F existed.

Either can come before the test's first look at F. The engine's behaviour is the row's ("fix work registered at once"); the test's baseline was taken too late.

## What changed (tests only)

`packages/engine/test/acceptance/M637-a-verifiable-defect-is-repaired-within-the-brief.test.mjs`:
- The baseline `repairs_iteration` is read in `toFinding` right after the Alpha environment is configured. A "fixture is live" assertion checks that no `verification` work item exists yet, so F cannot exist and no repair has been spent.
- "One unit consumed" is now two assertions:
  - exactly one `delegated_actions` row of kind `fix_registered` for F;
  - `remaining.repairs_iteration` one lower than that baseline once the fix is dispatched.

No other case changed.
