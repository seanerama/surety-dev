# 086: M408 (a) expects one adoption_mode row, but the slice-35 harness commits the policy while it is open, which raises its next generation

Row: M408
Test: packages/engine/test/acceptance/M408-the-retrofit-journey.test.mjs, case "(a) surety project adopt: …"
Filed by: Builder, slice 35, 2026-10-13

## Claim

The case asserts `adoptionModeRows(...)` is exactly `[['consumed', 'full']]`. The slice-35 straddle (SEAM §406) adds the policy commit to `harness/retrofit/drive.mjs` `toConformancePublished`: `ownerPolicy(fx, p.id, { phase_size: ADOPTED_PHASE_SIZE })`. That commit lands after `adoptProject` and before `chooseMode`, while `adoption_mode` is open.

Since slice 32 an adopted project's open `adoption_mode` and `requirement_confirm` decisions are raised again on a policy commit, because their manifest binds the policy revision (`adopt/records.ts` `reraiseOnPolicy`, called from the policy finalizer). So the first row is `invalidated` and its next generation is the one answered `full`: `[['invalidated', undefined], ['consumed', 'full']]`. This engine change is not slice 35's, and the rest of M408's journey passes on `build/m5-s35` (7/8). M408's (i) file passes.

I propose either:
- `toConformancePublished` commits the policy before the project is adopted, or after the mode is answered; or
- (a) reads the consumed row, for example `rows.filter(consumed)` is one, answered `full`, with an earlier generation allowed as `invalidated`.

## Sources

- SEAM §406: "the adopted fixture uses `{1, 5}` (`ADOPTED_PHASE_SIZE`): `retrofit/drive.mjs` `toConformancePublished`, now with a policy commit on every adoption it drives".
- `adopt/records.ts` `reraiseOnPolicy`, as built in slice 32: an open `adoption_mode` is raised again on a policy commit.
