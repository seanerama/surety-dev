# 070: CR-1's scripted correction names only `accept-r2`, so R4.1's obligations never resolve and phase 2 never completes

Row: M401 (h), (m) (the T1 variant), and every journey that carries CR-1 to the end of phase 2
Test: packages/engine/test/acceptance/harness/journey/drive.mjs `correctionScript` (rewrites `.surety/checks/tests/service.test.mjs` alone); reference.mjs `SPEC_V2` (R4's statement sharpened, a `text_changed` requirement)
Filed by: Builder, slice 31b, 2026-10-12

## Claim

CR-1 changes two requirements. R2.1's text is reworded (`criteria_changed`), and R4's statement is sharpened (`text_changed`). D6 §4.4 makes every criterion of a `text_changed` requirement affected: "A requirement-statement change affects its criteria and their checks even when every ID remains" (B05). At the approval, the effective protected version holds phase 2's checks (the authoring is applied before CR-1's effect), so the impact lists:

- `accept-r2` for R2.1;
- `accept-r4`, `integration-stats` and `phase-regression` for R4.1.

The approval records one `spec_changed` obligation for each.

The 31b review's S2, accepted and now built, resolves an obligation only when the applied correction names its check (the proposal's `affected_checks`) and still covers its criteria. The scripted correction rewrites `service.test.mjs` alone, so its proposal's `affected_checks` is `[accept-r2 (input_changed)]`. `accept-r2`'s obligation resolves. The three R4.1 obligations stay open, so every gate naming those checks is `ACCEPTANCE_SCOPE_INCOMPLETE`. Phase 2's stage 4 never passes its stage gate, and the phase never completes. On this branch the T1 variant fails in its `before` hook:

```
phase 2 to complete: not reached within 200 ticks
```

A dump at that point:

```
check_obligations: accept-r2 [R2.1] resolved by prop_3; accept-r4 [R4.1], integration-stats [R4.1], phase-regression [R4.1] unresolved
gate_evaluations: stage  ACCEPTANCE_SCOPE_INCOMPLETE [chk accept-r4, chk integration-stats]
```

The ruling on M2 defers "an obligation that can never be resolved" to slice 36. These obligations can be resolved: a correction that names the R4.1 checks resolves them.

What I believe the fixture needs, for the Verifier or Sean to choose:

- The scripted `check_correction` also touches each R4.1 check's declared inputs. For example, it rewrites `stats.test.mjs`, `integration-stats.test.mjs` and `phase-regression.test.mjs`, with an assertion that only successful sums are counted. Then `affected_checks` names all four checks.
- Or CR-1 changes R2.1 alone (no `text_changed` R4), so only `accept-r2` owes a correction.

The engine resolves no obligation the correction does not name. That is S2, and D6 §4.5's "a protected correction applied that names the criteria".

## Sources

- D6 §4.4 (text_changed affects its criteria and their checks), §4.5 (what resolves an obligation); B05.
- The 31b review's S2 (resolution only for the checks and criteria the correction names); the ruling on M2 (unresolvable obligations deferred to slice 36).
- src/spec/change.ts `computeImpact`, `resolveByCorrection`.
