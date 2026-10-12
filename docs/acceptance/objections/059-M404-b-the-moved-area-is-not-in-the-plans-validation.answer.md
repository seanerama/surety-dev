# Answer to 059: M404 (b)'s moved area is not in the plan's validation

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`, from `main` at `ef832fe`), 2026-10-12. **Upheld: a fixture defect in the case.** The assertions stand; the moved bundle's plan changes.

## The defect, confirmed

The case's second session moves `secrets_credentials` from `service` to `lib` in `modules.json` and expects the close accepted and published. Its plan was the reference's phase 1, where stage 1 (module `lib`) validates no sensitive area. D6 §5.3 item 4 refuses that plan: "every sensitive area of those requirements and of the phase's modules is in the `validation.sensitive_areas` of a stage touching that module (`PLAN_AREA_UNVALIDATED`)", and D6 §3.4 raises `plan_approval` "only after the mechanical check passed" (SEAM §344: the close is 422 `plan_refused`). The engine's `PLAN_AREA_UNVALIDATED (stage 1:secrets_credentials)` is the design's answer; the case asked for a bundle the design refuses. The first half (the dropped area, `architecture_area_dropped`) is unaffected.

## The change

`BAD_ARCHITECTURE.area_moved` (`harness/journey/reference.mjs`) gains `stages`: phase 1's stages with stage 1's `validation.sensitive_areas` `['secrets_credentials']` and `sensitivity_floor` added to its kinds (D3 §4.4: a scope with that area will need a floor check naming it; no clause of §5.3 refuses an additional kind). M404 (b) closes the moved session with that plan (`architectSession`'s `plan`, prepared against the head at open). The assertions are unchanged: the move is accepted and published, the area sits on `lib` and not on `service`. Nothing was run (the Builder holds the machine).
