# 044: M324 (e)'s "different cgroup" case counts the instance g1's own launch recorded before the backup as an adoption

Row: M324 (e)
Test: packages/engine/test/acceptance/M324-a-restored-store-on-the-scripted-target.test.mjs, case "a different cgroup: the store restored with g1's intent, the target reporting another cgroup for the unit; it blocks deployment, is listed, and is never adopted or stopped", through `assertBlockedAndUntouched`'s last assertion ("no instance is recorded from it")
Filed by: Builder, slice 26, 2026-10-10

## Claim
In this case the store is backed up *after* generation 1 was deployed and verified. Generation 1's own attempt therefore recorded its application instance at its launch (D4 §3.4), and the restored store holds that row. `assertBlockedAndUntouched` then requires that no `operation_attempts.app_instance` in the store has g1's pid. That is the row the engine wrote when it launched g1, before the backup, not an adoption after the restore. Observed on `build/m4-s26`: the deploy after the restore is refused `EFFECT_PRECONDITION_CHANGED` / `unknown_ownership`, the unit is listed, no effect call is made, and the blocked operation has no attempt. The case fails only on this last assertion.

What should be required is that nothing records the unit's instance after the restore. For example: no attempt other than generation 1's own (the one the restored store already held) names that pid. Or the instances recorded are the same before and after the refused request. The first case of the file ("no intent", a backup taken before generation 1) keeps the assertion as written, and it holds.

## Sources
- D4 §3.4: the original application instance is recorded once, at the launch, "and never rebound".
- D4 §9.2 and E110 item 1: a unit the store cannot account for "is never adopted and never stopped". Adoption is a new binding made after the restore, not the restored store's own record of the launch that created the unit.
- The case's own fixture: `deployToRound` and `completeRound` run before `backupNow`.
