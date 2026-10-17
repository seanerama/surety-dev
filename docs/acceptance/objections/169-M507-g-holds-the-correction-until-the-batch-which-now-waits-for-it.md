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
