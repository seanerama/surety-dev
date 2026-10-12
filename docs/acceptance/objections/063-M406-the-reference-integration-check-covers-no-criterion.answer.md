# Answer to 063: the reference project's integration check covers no criterion

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`, from `main` at `3a15d10`), 2026-10-12. **Upheld: a fixture defect.** I adopted the objection's second proposal, one integration check per stage, and fixed a second check with the same omission.

## Confirmed

D3 §1.3 says "an acceptance-origin check of kind `acceptance`, `integration`, `property` or `failure_recovery` names at least one criterion". Two of the fixture's checks named none:
- phase 1's `integration`, as the objection says;
- phase 2's `phase-regression`, kind `acceptance`, which would have blocked phase 2's authoring the same way.

The objection's reading of D3 §4.2 (b) and §4.3 holds:
- A covering check is required at a stage only for that stage's requirements.
- T2's inventory needs an acceptance-origin `integration` check in every stage's scope.

So no single integration check can serve every stage of this project honestly. Covering R1.1 and R2.1 would run a service test at stage 1, where `server.mjs` does not exist yet.

## The change

All in `harness/journey/reference.mjs`; SEAM §368. Each integration check covers a criterion of its own stage's requirement:

| Stage | Check | Covers | What it exercises |
|---|---|---|---|
| 1 | `integration-lib` | R1.1 | the library loaded in a process of its own |
| 2 | `integration` | R2.2 | the service as a child: `/health`, a sum, and the refusal of a non-number |
| 3 | `integration-tally` | R3.1 | the tally beside the library, in a process of its own |
| 4 | `integration-stats` | R4.1 | two sums through the service, then `/stats` |

- **R2.2 rather than R2.1.** CR-1 rewords R2.1 (SEAM §353), and M401 (h) and its scripted correction account for one listed check, `accept-r2`. A service integration check covering R2.1 would add a second listed check with no correction scripted for it. R2.2 is what the program asks, and CR-1 leaves it unchanged.
- **`phase-regression`** now covers R4.1: two sums, a refusal, then `/stats` answers 2. R4.1 is a criterion of the phase the check is registered for.
- **`smoke`** checks `src/sum.mjs` instead of `server.mjs`. It covers nothing, so it is required in every stage's scope (§4.2 (a)), and stage 1 has no `server.mjs`. Without this, smoke would have failed stage 1 on the project lane for the same reason the objection gives.

`EXPECTED_CHECKS` and the key lists in M401 (both parts and the T1 variant) and M406 follow these changes. No assertion was weakened.
