# 107: M401's journey to Alpha (sandbox) expects CR-1 to invalidate accept-r2's results, and candidate 3 to carry engine-run checks; under Q2 and K2 neither holds

Row: M401 (h), (i)
Test: packages/engine/test/acceptance/M401-the-journey-from-phase-two-to-alpha.test.mjs (sandbox lane)
Filed by: Builder, slice 37, 2026-10-14

## Claim

Run alone on `build/m5-s37` at 4ddf1e9, twice: 3/5 both times. Each result below is read from the kept store.

**(h) "accept-r2's results invalidated spec_changed".** Phase 2's check authoring captured its proposal before CR-1 was proposed. Under the driver's Q2 ruling, CR-1's proposal waits for a protected proposal in the engine's hands. The authoring's version was applied first, so accept-r2's results on candidate 2 are invalidated `protected_version_superseded` at 16:34:55. When CR-1 was approved (seq 1363, 16:35:24), no current accept-r2 result was left for it to invalidate `spec_changed`. Its obligations are recorded and resolved as before, and every later gate is on version 2. I propose (h) accept either reason for accept-r2's earlier results, or look for the `spec_changed` obligations instead of invalidated results.

**(i) "candidate 3 has engine-run checks".** Under K2, phase 2's two stages integrate moments apart. Candidate 3 is superseded by candidate 4 before any of its executions starts, and D3 cancels them all: eight `cancelled`, none recorded. Candidate 4 carries the engine-run checks and is alpha_deployed. I propose (i) read the checks of the candidate the phase completed on (`completion_binding.candidate`), not of a fixed candidate number.

## Sources

- The driver's Q2 ruling and its narrowing (slice 37); D6 K2; D3 §2.5 (superseded candidate); D6 §4.5.
