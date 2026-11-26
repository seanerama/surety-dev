# 236: an added assertion in an existing check is `unclassifiable` under classifier version 1, so M636 (b), M637 (b) and M646's tightened R5.5 cannot be applied by the brief's policy

Row: M636, M637 (and M646, which composes them)
Test: not yet written (rows as committed on driver/item57-rulings-rows e3ee6122, docs/acceptance/sdlc-M7-acceptance-plan.md §3j)
Filed by: Builder B, item 57 rulings batch, 2026-11-26

## Claim
M636 (b) requires that "a proposal tightening an existing check (an added assertion) for a criterion of the brief" is "applied once, `approver_authority` `policy`". M637 (b) requires that after a passing check X, "check-correction work for X routed to the Verifier; its tightening applied under M636; the tightened X fails on C; then (a)". M646 requires the print finding "reproduced by the tightened R5.5 check (fails on a88fa57)" with **Owner decisions = 1**.

Under the classifier the engine runs (`CLASSIFIER_VERSION = 1`, packages/engine/src/checks/classify.ts), a change to an existing check's input files (the scenario a Verifier adds an assertion to) is the element `input_changed`, which is in `UNCLASSIFIABLE_REASONS`; a change to its definition that no rule places is `unhandled_change`. Either makes the proposal `unclassifiable` (classify.ts `kindOf`). Sean's ruling D2 sends it to him: "A proposal that changes what can execute, weakens existing coverage, or cannot be classified comes to me." The engine as built (classification.ts policyCoverage) therefore raises `check_correction_unclassifiable` with evidence `{policy_not_covered: "classified_unclassifiable"}` for such a proposal, as M636 (e) requires for an unclassifiable one.

What classifier 1 does classify as a tightening of coverage for a criterion: a new check (`check_added`, with `required_key_added_with_check` when it joins the required set), a criterion added to an existing check's `covers.criteria` (`criteria_added`) with nothing else changed, an added gate kind, a lowered tier floor. So the scenarios M636 (b), M637 (b) and M646 can be realised only by the Verifier's correction **adding a new check** covering the criterion (for M646: a print-order check for R5.5 beside accept-r5-5), not by editing accept-r5-5.

That raises a second point the rows do not settle: the finding names X (accept-r5-5). If the correction adds Y instead, X still passes on C, and the engine (policy-fix.ts policyFix) refuses with `repair_unverifiable: the corrected check still passes on the candidate`, as M637 (c) requires. Accepting a failing Y covering the finding's criterion as the reproduction, and binding the finding to Y so its resolution is verified by Y rather than by X's vacuous pass, is a design change the rulings do not state.

## What I ask
A decision for Sean (not a test change I can make): either
1. the rows' (b) cases are realised by a correction that **adds** a check covering the criterion, and D3 accepts as the reproduction a failed result of any required acceptance check covering the finding's criterion on its candidate, the finding's `check` then bound to that check (recorded, its old check kept in the finding's history), so its `resolution_verification` names the discriminating result; or
2. the rows keep "the tightened X", which needs a classifier version 2 rule that can prove an edited scenario is strictly tighter (D3 §3.2 says it is conservative by construction; I know of no such rule), and until then (b) ends in the owner's `check_correction_unclassifiable` question.

The engine on build/item57-checks-findings-clock implements the rows' text with classifier 1 (option 2's interim behaviour). Option 1 is a small change in policy-fix.ts once ruled.

## Sources
- Sean's ruling D2, 2026-11-26 (DECISIONS item 57): "A proposal that changes what can execute, weakens existing coverage, or cannot be classified comes to me."
- packages/engine/src/checks/classify.ts: `UNCLASSIFIABLE_REASONS` includes `input_changed` and `unhandled_change`; `if (inputChanged) at('input_changed')`; `kindOf`: "`unclassifiable` if any element is".
- SLICE-PLAN-rulings.md fact 1: "the real accept-r5-5 passes on the defective candidate ... the discriminating evidence must be a print-order assertion".
