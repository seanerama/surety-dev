# 098: M429 (d) relies on a change touching phase 2 alone replacing phase 1's plan early, which the review's M1 ruling now forbids

Row: M429
Test: packages/engine/test/acceptance/M429-phase-verification-and-its-sign-off.test.mjs, case "(d) a sign-off bound to a plan generation replaced while the Verifier ran: …"
Filed by: Builder, slice 36, 2026-10-14

## Claim

The case makes its plan-generation change with "A change touching R4 alone (phase 2), approved during phase 1: a replan of the active plan". The driver's ruling on the slice-36 review (M1) is that "a change touching only later phases must give touches_current false. Its replan must not bind subject.phase_plan to the open current plan and must not supersede the current phase's stages (no early replacement)". On `build/m5-s36` at ac02505 the change's replan binds no open plan, so no replacement of phase 1's plan is routed. The case fails with "the replacement routed to the owner and pending (["silent"])".

I propose the case makes phase 1's generation change from a change that touches phase 1 (for example R2's or R1's text). Or it can use another of §5.7's triggers on phase 1, such as a blocker answered `replan`, which M433 (a) uses.

## Sources

- The driver's slice-36 review rulings, M1 (2026-10-14).
- D6 §5.7 (early replacement of the current plan).
