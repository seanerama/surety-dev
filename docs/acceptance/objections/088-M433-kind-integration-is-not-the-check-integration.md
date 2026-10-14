# 088: M433's M2 A reads the gate's `kind:integration` subject as naming the removed check `integration`

Row: M433
Test: packages/engine/test/acceptance/M433-old-generation-runs-and-what-resolves-an-obligation.test.mjs, case "M2 (31b review), A: an obligation whose criterion a later change withdraws is resolved by the later change's correction removing the check"
Filed by: Builder, slice 36, 2026-10-13

## Claim

The case's `names(subjects, ids, key)` is true when a subject `String(s).includes(key)`. After the second correction deletes `accept-r2` and `integration`, stage 2's gate carries `ACCEPTANCE_SCOPE_INCOMPLETE` with the subjects `["R2.1","R2.2","kind:acceptance","kind:integration"]`. These come from the kind inventory: stage 2's plan still asks for `acceptance` and `integration` kinds, and after the deletion no check of either kind covers it. `kind:integration` contains `integration`, so the case fails with "stage 2's gate names no removed check integration", although no subject is the check `integration`, by id or by key.

Everything the case is about holds on `build/m5-s36` at 642c578. Every `spec_changed` obligation is resolved, including the first change's on `accept-r2`, and no gate subject is a removed check's id. A scratch copy that compares a subject with the key exactly (`String(s) === key`) and keeps everything else passes 3/3 at c270dfa.

I propose that `names` match a check id, or the key as a whole subject (or `check:<key>`), never as a substring. M433 (f), (g) and M2 B use the same helper; their subjects are check ids, so they are unaffected.

## Sources

- SEAM §423: "After it no gate names the check."
- The gate's kind inventory (D3 §4.3 L3; SEAM §221): `kind:<k>` subjects name a missing kind, not a check.
