# 169: M507 (g) leaves phase 1's correction unanswered until the batch is raised, and the batch now waits for that correction

Row: M507 (g) (also, once their slices are built: M518 (b) to (g), M529's review batch)
Test: packages/engine/test/acceptance/M507-design-readiness-and-the-third-milestone.test.mjs, case (g)
Filed by: Builder, slice 40, 2026-10-17

## Claim

The driver's extension of objection 166 (under the owner's delegation): a design batch is not raised while any correction of the protected checks is pending. Pending means undecided (its question open, or not yet classified) or approved and not yet applied. The owner answers the correction first and the batch once. That rule is built in `build/m6-s40-fix`.

M507 (g) does the opposite on purpose:

```js
// Nothing answered until the batch is approved, so no UI stage builds against no design.
ctx.answerKinds = [];
await designed(fx, p);
const batch = await untilBatch(fx, ctx);
```

Phase 1's check authoring raises `check_correction_unclassifiable`. The case leaves it open. The design's batch waits for it, and the case waits for the batch. Observed:

```
not ok 7 - (g) gates while the design criteria's checks do not exist: …
  error: 'the batch: not reached within 40 ticks (human acts so far: [])'
```

`GET …/design` names the deferral and the open question as the reason (`batches_deferred[0].pending_corrections: [{proposal, status: 'awaiting_human', question}]`). The engine is doing what the ruling asks. M507's other six cases pass, and so does every other slice-40 file run.

## What the test can do

Answer phase 1's correction before waiting for the batch. That is the order the ruling now requires of an owner. Then keep the UI stages from building against no design by other means. Under `design: at_alpha` they are not held by design, so the case can:
- read its gates before the UI Builders' integration, as it does now (its window is the gates after version 2); or
- script the UI Builders to hold (`step.hold`) until the batch is answered.

The same pattern is in M518 (`ctx.answerKinds = []` from the close to (f)) and M529 ("The correction's proposal left unanswered until (e)"). Their slices are not built yet, so I have not observed them deadlock. If the correction they hold back is open when their batch's proposal is recorded, they will wait the same way.

## Sources

- The driver's rulings on objection 166 (the deferral, and its extension to open corrections).
- M507 (g) as written; harness/journey/drive.mjs `pump`.

## Decision

Upheld by the driver under the owner's delegation, 2026-10-17. **The tests are changed** (Verifier, `verify/m6-s40c` from `main` `ca0ac5a`).

**M507 (g).** Phase 1's correction is now answered before the batch, the order the extended rule of objection 166 requires. The UI stages are kept from building against no design by the objection's second option:
- Stage 1's (API) Builder is scripted to wait at a hold (`until-batch`) until the batch is answered. The UI stages depend on stage 1's code milestone, so neither can dispatch before the release.
- The journey's `pump` waits for every run to end, and a held Builder does not end. So the wait for the batch ticks the engine itself and answers each open `check_correction_unclassifiable` `approve` by hand, then reads the batch.
- After the batch is answered, the case checks that no launch of stage 2 or stage 3 exists, then releases the hold.
- The design criteria's own correction stays unanswered, so the assertion keeps its meaning: while `accept-r2-tokens` does not exist, every gate delivering R2 (objection 168's reading) names `ACCEPTANCE_SCOPE_INCOMPLETE` with R2.2.

**M518** (slice 45, not built; changed by reading). The at_alpha case set `ctx.answerKinds = []` from the close to (f). The conformance phase's check authoring raises `check_correction_unclassifiable` (`authoringResult`, harness/retrofit/products.mjs), and the Designer session opens right after the conformance plan is published, so that correction can be open when the batch would be raised. That is the same deadlock.
- The case now answers the three `check_correction_*` kinds from the close until `design_approval` is raised, then sets `ctx.answerKinds = []` as before.
- The batch's `spec_change` is not among those kinds, so the case still answers the batch itself.
- The design criterion's own correction (`R5_TOKENS_CORRECTION`) is raised only after version 2 is applied, so it stays unanswered until (f), as written.

**M529** (slice 45, not built; read, not changed). Its "left unanswered until (e)" sets `ctx.answerKinds = []` only after the batch is raised. The correction it holds back is the design's own (`MARKER_CORRECTION`, raised after version 2: trigger `spec_obligation`, excluded from the deferral). Before the batch, the journey's earlier answer kinds still apply, so no correction is held back while the batch is due. The pattern is not there.

**Run** against the Builder's engine (a detached scratch worktree of `build/m6-s40-fix` at `906e2ff`, `npm ci`, `npm run build`, the Verifier's tables of `de7410c` and the changed M507 copied over, `TMPDIR=/tmp/v40e`, `node --test`, each run alone):
- **M507 (g) alone: 5 of 5 passed.** A first version that held the Builder and waited with the `pump` failed 5 of 5 ("timed out after 30000 ms waiting for every run … to end"). That is why this wait ticks by hand.
- **M507 whole: 7/7, 7/7, 7/7.**

M518 and M529 were not run: their slices are not built.
