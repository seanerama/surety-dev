# 085: M401 (i) reads phase 2's stages from the completed plan's row, but the mid-build spec change now replaces phase 2's plan

Row: M401 (with M430)
Test: packages/engine/test/acceptance/M401-the-journey-from-phase-two-to-alpha.test.mjs, case "(i) phase 2 as (f) and (g), without a next phase: …"
Filed by: Builder, slice 35, 2026-10-13

## Claim

The journey's specification change (CR-1, SEAM §353) is approved while phase 2 is open and touches it, so it makes `replan` work with `trigger_source` `spec_change`. Through slice 34 that replan's plan could only go stale ("a replacement is the early-replacement route's"). With slice 35 it is an early replacement (D6 §5.7). Its plan keeps phase 2's two stages, which are integrated or verified, so it publishes generation 2 with no remainder. Phase 2 completes on generation 2, and every other clause of the journey passes, including the T1 variant (3/3).

M430 pins where kept stages live. In "(a) … (c) the swap", `stagesOfPlan(g2.id)` holds only the remainder (`[4, 5]`, "only the remainder registered, no duplicate of S1"). `stagesOfPlan(plan.id)` still holds the kept S1, `integrated`. In "(d) … retained", `stagesOfPlan(g2.id)` is `[5]`. So a kept stage keeps its row on its own generation's plan, and the engine reads a generation's active stages through the replacement chain.

(i) asserts `stagesOfPlan(fx.home, phase2.id)`, where `phase2` is the completed plan (generation 2), to be `['verified', 'verified']`. Under M430's rule that row set is empty. Both stages are `verified` on generation 1's row.

I propose (i) reads phase 2's stages across its generations, for example every stage of the phase's plans with no `cancelled_at`. Equivalently, it can read the stages of generation 1 when generation 2's `replacement.kept` names them. Either reading holds with M430.

## Sources

- D6 §5.7: "it preserves completed stage identities and history (stages `integrated` or `verified` keep their rows …) … and it registers only the replacement remainder, never a duplicate of a kept stage."
- D6 §5.7: "`replan` work is also created … by: an approved spec change touching the current or a later phase (§4.5)".
- M430 (a), (d) as written in slice 35.
