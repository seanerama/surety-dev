# 170: the Verifier's decision table lacks the Designer's finding question (`finding_disposition` about a `design_finding`)

Row: M538 (the contract table that every case's `assertPreview` reads)
Test: packages/engine/test/acceptance/contract/decisions.json, `kinds.finding_disposition`; read by harness/decisions.mjs `assertPreview`
Filed by: Builder, slice 41, 2026-10-17

## Claim

Slice 41 routes a Designer's `contract_conflict` and `requirement_conflict` to an owner question (D7 §4.5; SEAM.md §491; objection 130, E157 item 5). The decision table has a closed list of kinds, so the question is a `finding_disposition` decision:

- `subject_type` `design_finding`, its subject a `design_findings` row;
- scope `design_conflict`;
- options `change_spec` and `architect` for a `contract_conflict`, and `change_spec` alone for a `requirement_conflict`.

Its dependency manifest holds every key the table names for `finding_disposition`: `finding_status`, `disposition`, `proposed_disposition`, `effective_severity`, `sensitive_area`, `evidence`, `defer_target`, `linked_issue`, `applicable`, `candidate_revision`, `acceptance_content_hash`, `policy_revision`. Beside them it holds `scope`, `design_finding`, `category`, `interface` and `requirement`.

`contract/decisions.json` lists `finding_disposition` with `subject_types: ["finding"]` and `options: ["approve", "reject", "alpha_exception"]`. `assertPreview` asserts that a decision's `subject_type` is one of the kind's `subject_types`. A case that calls it on the Designer's finding question would therefore fail on `design_finding`. No current case does: M538 (d) reads the question's options and text without calling `assertPreview`, and passes.

What the table should hold, if the Verifier agrees:

- `kinds.finding_disposition.subject_types`: add `"design_finding"`.
- `kinds.finding_disposition.options`: add `"change_spec"` and `"architect"`, if `options` is read as every key the kind can offer. It already omits the owed scope's `fix`, `correct_check`, `change_spec`, `lower_and_accept` and `accept`, so it may be read as a subset.
- The manifest needs no change. `effect` stays `false`: `change_spec` makes a spec change request in the answer's transaction, as the owed scope's `change_spec` does, and `architect` records the route only.

Slice 41 adds no other decision kind, and no configuration key, to these tables. Its other additions need no entry in `config.json` or `decisions.json`, which list neither tables nor events. Those additions are:

- the tables `design_findings`, `design_native_obligations` and `session_held_turns`;
- the events `session.turn_held` and `session.turn_released`;
- the enumerations `DesignFindingCategory`, `DesignFindingStatus`, `DesignFindingRoute`, `Target`, `NativeConvention` and `NativeObligationStatus` (and `Severity`, reused).

All of them are in the engine's exported contract (`api/schema.json`, regenerated), and `surety contract check` reports no finding.

## Sources

- D7 §4.5 and A.2 (DecisionKind: the three design kinds added, `finding_disposition` unchanged); SEAM.md §491 ("of a kind other than `design_approval`, `design_due` and `design_verdicts` … The kind … not pinned").
- E157 item 5 (objection 130): `change_spec` and the Architect route; D3 X2's `correct_check`, `retry` and `cancel` not offered.
- packages/engine/src/design/findings.ts (`DESIGN_CONFLICT`); harness/decisions.mjs `assertPreview`.
