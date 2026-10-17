# 130: a Designer's `contract_conflict` finding has no check to correct and no work item to retry; M538 (d) pins only `change_spec` and `architect`

Row: M538 (d) (and M505 (e), M538 (e), whose blocker the same finding raises)
Test: packages/engine/test/acceptance/M538-the-designer-session-its-limits-and-its-findings.test.mjs, case "(d) an unknown field refused naming it; a contract_conflict finding: X2's options plus architect; …"
Filed by: Verifier, slice 41, 2026-10-16 (a question for Sean, not a Builder's objection)

## Claim

The M6 plan's M538 (d) reads: a `contract_conflict` finding naming an interface gives "an owner question with D3 X2's options plus `architect`". D7 §4.5 says the same ("the options D3 X2 gives plus `architect`"). D3 X2's options, as the engine builds them (`src/store/transitions/repair.ts`, `X2_OPTIONS`), are `correct_check`, `change_spec`, `retry` and `cancel`, and every one of them is about a work item whose check failed:

- `correct_check` registers `check_correction` work "for each conflict": a Designer's finding names an interface, not a check, and no check has failed;
- `retry` "sends the Builder back once to make the check pass": a Designer session has no work item and no check to pass;
- `cancel` cancels "the work item": there is none (the session is a run the owner closes himself).

Only `change_spec` (the spec change of D6 §4.2) and D7's added `architect` (an Architect session, D6 §3.4) have a subject here. Nor does D7 or A.2 say which decision kind carries the question: A.2 adds only `design_approval`, `design_due` and `design_verdicts`.

The test pins, within D7 §4.5: **one open owner decision per finding, of a kind other than the three design kinds, whose options include `change_spec` and `architect`, and whose text names the interface**; for a `requirement_conflict`, one whose options include `change_spec`, naming the requirement. It does not pin the decision's kind, nor whether `correct_check`, `retry` or `cancel` are offered, so a Builder offering X2's four (with whatever they would mean here) passes, and so does one offering only the two that have a subject.

If Sean wants X2's four offered as they are, or a dismissal option for the finding (the owner deciding the inventory is right after all), or a named decision kind, the test tightens to it: a decision for the errata.

## Sources

- D7 §4.5: "the engine routes `contract_conflict` to the owner's question with the options D3 X2 gives plus `architect` … and `requirement_conflict` to `change_spec` (D6 §4.2)".
- D7 A.2: `DecisionKind` adds `design_approval`, `design_due`, `design_verdicts` only.
- D3 §5 X2, as built: `correct_check`, `change_spec`, `retry`, `cancel` on a work item in `verifying` whose check failed (`src/store/transitions/repair.ts`, `conflictPreview`).
- M6 plan §3.3 M538 (d).
