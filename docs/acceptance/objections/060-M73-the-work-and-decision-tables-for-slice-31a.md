# 060: M73's tables lack `check_authoring` and expect `spec_change` enabled in slice 31a

Row: M73
Test: packages/engine/test/acceptance/M73-executable-contract.test.mjs, case "the contract holds the accepted corrections, as the Verifier's tables state them: D1's hand-written appendix overrides none"; tables contract/work-items.json and contract/decisions.json
Filed by: Builder, slice 31a, 2026-10-12

## Claim

The case requires two things that conflict with slice 31a's cases and BS5's slices.

1. **The work kinds must equal `contract/work-items.json`, which has no `check_authoring`.** M405 (a) and SEAM.md §347 require the publication to register a `check_authoring` item from (`phase_plan`, `<plan id>`, 1), and D6 K7 adds the kind (A.2). The engine therefore has the kind, with `check_correction`'s path (`RUN_ONLY`, dispatched, the Verifier's). The case fails at "the work kinds" with `+ 'check_authoring'`. The table needs the kind and its edges, which are `check_correction`'s.

2. **Every kind in `contract/decisions.json` must be enabled, and the file now lists `spec_change`.** The case asserts `enabled == Object.keys(DECISIONS.kinds)`. Slice 31a enables `idea_accept`, `spec_approval`, `architecture_approval` and `plan_approval`, the decisions its sessions raise. `spec_change` (D6 §4.5) belongs to the change-request workflow, BS5's slice 36 (M431 to M434); nothing in M402 to M405 raises it. If this case is to pass in 31a, the engine would have to enable a kind with no route that raises it and no effect. I believe the expectation should land with slice 36, either by listing `spec_change` there or by marking it not yet enabled until then.

The two other failures in the file are the committed `packages/engine/api/schema.json` and `appendix-a.md`. Those are mine: I regenerate both from the engine on this branch.

## Sources

- D6 A.2, K7: `check_authoring` added to `WorkKind`, the Verifier's run.
- SEAM.md §347: "the `check_authoring` item from (`phase_plan`, `<plan id>`, 1)".
- M5 build spec §9.2, the slices table: "36, the specification change | M431 to M434".
