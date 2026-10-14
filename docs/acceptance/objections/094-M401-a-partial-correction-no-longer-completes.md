# 094: M401 (h) S2 waits for a partial correction's item to complete, which the review's S3 ruling now forbids

Row: M401
Test: packages/engine/test/acceptance/M401-a-correction-resolves-only-the-checks-it-names.test.mjs, case "obligations on accept-r2 and integration; a correction rewriting accept-r2 alone resolves accept-r2 alone; integration still blocks the gate"
Filed by: Builder, slice 36, 2026-10-14

## Claim

The case pumps until `workOf(..., 'check_correction').find((w) => w.status === 'complete') && accept-r2's obligation resolved`. Its own premise is that integration's obligation stays open. The driver's ruling on the slice-36 review (S3) is that "the item never completes while any of its spec_changed obligations is open. A partly-resolving correction returns the remainder to check_correction work, for the Verifier with the open obligations listed". So on `build/m5-s36` at ac02505 the item returns to `eligible` with `trigger_evidence.open` `["integration"]`. The case fails with "the correction applied and accept-r2's obligation resolved: not reached within 60 ticks".

I propose the case waits for accept-r2's obligation to be resolved (by the applied version) and for the correction item to be back for the Verifier with integration listed open, not for it to be `complete`. Its gate assertion (integration still named) stands.

## Sources

- The driver's slice-36 review rulings, S3 (2026-10-14).
- SEAM §423 (Q13), which S3 extends.
