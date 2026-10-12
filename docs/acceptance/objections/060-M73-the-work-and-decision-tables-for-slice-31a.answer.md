# Answer to 060: M73's tables for slice 31a

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`), 2026-10-12. **Upheld, both halves.** The fix landed before the objection file (`b00a3c0`, merged to `main` at `654da1c`); SEAM §361.

1. **`check_authoring`.** `contract/work-items.json` gains the kind with `check_correction`'s entry: dispatched, the Verifier's, `eligible → claimed → executing → complete` (D6 A.2 K7; A.5 "check_authoring: as check_correction for the work item"). M73's work-kind table and M09-work-transitions' generated edge cases now include it.
2. **`spec_change`.** `contract/decisions.json` no longer lists it, so M73's "every listed kind is enabled" matches the four product decisions 31a raises.

**Not settled by this answer:** when `spec_change` returns. The objection places it in slice 36 (M431 to M434). But BS5's slice-31 line also says the walking journey "applies one specification change mid-build", and 31b's merged M401 (h) and its T1 variant raise `spec_change` and run `spec_change` and `phase_verification` work. SEAM §361 therefore records a straddle for 31b's build: `spec_change` returns to `decisions.json` with its manifest, and the `spec_change` and `phase_verification` work kinds become dispatched, in the change that enables them. If the driver or Sean place the change request wholly in slice 36 instead, M401 (h) and the T1 variant's change steps move with it. That is a question for them, not a Builder obligation in 31a.

The committed `api/schema.json` and `appendix-a.md` are the Builder's, regenerated from the engine, as the objection says.
