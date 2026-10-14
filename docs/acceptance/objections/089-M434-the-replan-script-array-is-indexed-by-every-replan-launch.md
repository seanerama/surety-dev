# 089: M434's replan script array is indexed by every replan launch of the test, so its held first entry is never used

Row: M434
Test: packages/engine/test/acceptance/M434-an-unassigned-requirement.test.mjs, case "(a) REQUIREMENT_UNASSIGNED on the later phase gate; …"
Filed by: Builder, slice 36, 2026-10-13

## Claim

The case sets `fx.scripted.kindScript('replan', [held incomplete roadmap, complete roadmap])` after `phaseTwoAtRest`, expecting the change's replan to take the first entry and hold. The scripted child indexes a kind array by every earlier launch of that kind in the log (`harness/scripted/child.mjs` `chooseScript`: "launch n of that kind (counted in the log by work_kind) follows element n-1"; SEAM §350). `phaseTwoAtRest` has already launched phase 1's completion replan, so the change's replan takes the second entry: the complete roadmap, not held. Its repair takes the default script. The case fails with "the replan held: not reached within 20 rounds", observed on `build/m5-s36` at 642c578.

A scratch copy that pads the array with one empty entry per replan launch already in the log (`fx.scripted.launches({ work_kind: 'replan' }).length`), and changes nothing else, passes 1/1 on `build/m5-s36` at c270dfa. That run covers `REQUIREMENT_UNASSIGNED` naming R5, R5 shown pending with no phase, the trigger refusing the direct update, the incomplete roadmap refused naming R4, the complete one routed, approved and published with `moved_requirements` naming R5, R5 in phase 3, the reason cleared, and the R1.1-only change registering no replan.

That copy also exposed an engine defect, now fixed in c270dfa: the replan result's `roadmap_revision: true` was refused, because the result form took a string and B.7 says `roadmap_revision?: bool`.

I propose the case scripts the change's replan for its own work item (`fx.scripted.script(item, [...])` once the item exists), or pads the kind array as above.

## Sources

- `harness/scripted/child.mjs` `chooseScript`; SEAM §350.
- D6 Appendix B.7: "Architect replan `{summary, plan: "phase-<n>", roadmap_revision?: bool, …}`".
