# 109: M401's journey to Alpha (i) counts a Reviewer run per stage; under K2 two stages integrated together share one candidate, and one candidate gets one review

Row: M401 (i)
Test: packages/engine/test/acceptance/M401-the-journey-from-phase-two-to-alpha.test.mjs (sandbox lane), "Verifier and Reviewer runs per stage"
Filed by: Builder, slice 37, 2026-10-14 (the driver's ruling: one review per candidate is the engine's rule)

## Claim

On `build/m5-s37` at 50cdab6 the journey ran 4/5 three times. Each time (i) fails: "Verifier and Reviewer runs per stage (["verifier","builder","spec_writer","verifier","builder","verifier","verifier","architect","reviewer","verifier"])", one Reviewer run after the switch.

Under D6 K2, phase 2's two stages integrate moments apart, and the candidate their integrations nominate holds both. The engine queues one review per candidate (`gates.ts` `queueReview`, E36 item 3; SEAM §70). One review covers both stages' gates.

I propose (i) count a Reviewer run per candidate the phase's stages were verified on, rather than per stage.

## Sources

- D6 K2; E36 item 3; SEAM §70; the driver's ruling (slice 37).
