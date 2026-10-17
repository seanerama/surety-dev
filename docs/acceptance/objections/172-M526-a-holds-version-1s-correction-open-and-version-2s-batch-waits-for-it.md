# 172: M526 (a) leaves design version 1's criteria correction open to keep the UI stages from building, and version 2's batch waits for that correction

Row: M526 (a), (c), (d), (e), (f) (the first case of the file)
Test: packages/engine/test/acceptance/M526-the-effective-asset-set.test.mjs, case "(a), (c), (d), (e), (f) a logo approved, a revised layout approved with a new logo held: …"
Filed by: Builder, slice 43, 2026-10-17

## Claim

This is objection 169's pattern again, in a slice-43 case.

The case sets `ctx.answerKinds = ['check_correction_unclassifiable', 'check_correction_loosening', 'plan_approval']`. That leaves `check_correction_tightening` unanswered on purpose:

```js
// Version 1: the logo A proposed and approved; the criteria's correction left unanswered, so no UI stage builds yet.
…
await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'check_correction_tightening')[0], { what: 'the criteria\'s correction captured', max: 40 });
```

That open correction is version 1's own design criteria correction. Its `check_correction` item has trigger `spec_obligation`, and its subject's `request` is version 1's change request. The case then runs a second Designer session (version 2, logo B), closes it, and waits for version 2's batch (`approveTheBatch`, line 131).

The driver's extended ruling on objection 166 says a design batch is not raised while any correction of the protected checks is pending. Pending includes undecided, with its question open. The only correction excluded is the one this batch's own obligations caused. Version 1's correction is not version 2's. So version 2's batch is deferred: its `spec_change` item waits `awaiting_decision` with the blocker `design_batch_deferred`, and `GET …/design` `batches_deferred` names the proposal. The case waits for a batch that only answering that correction can release, and its pump is told not to answer it.

**Observed** (`build/m6-s43`, `TMPDIR=/tmp/b43`, the file alone):

```
not ok 1 - (a), (c), (d), (e), (f) a logo approved, a revised layout approved with a new logo held: …
  error: 'the batch: not reached within 40 ticks (human acts so far: [{"kind":"check_correction_unclassifiable", … "option":"approve","status":200}])'
```

The kept store (`SURETY_KEEP_TMP=1`) shows:
- work item 9 (`spec_change`, version 2's request) is `awaiting_decision` with `{"reason":"design_batch_deferred", …, "pending_corrections":["prop_…DEDDV"]}`;
- `prop_…DEDDV` is `classified`. Its `check_correction_tightening` question is open. Its item (seq 7) is version 1's criteria correction.
- Design revision 2 is `proposed`.

Case (b) of the same file passes.

**The rest of case (a) passes on this engine once that correction is answered.** I ran a scratch copy of the file outside the repository, with its imports pointed at the harness. It differed in three lines: `check_correction_tightening` added to `ctx.answerKinds`, and the two lines that wait for the tightening question and assert no UI Builder launched before version 2 removed. That copy passed 1 of 1. Those lines are the logo held, the restart between the approval and the next package, the packages, the asset inputs and `GET …/design`, and the later asset-only approval of logo B. The acceptance file was not changed.

## What the test can do (the Verifier's choice)

Answer version 1's criteria correction before waiting for version 2's batch. That is the order the extended rule of objection 166 requires of an owner. Then keep the UI stages from building before the restart by other means, as objection 169 did for M507 (g). For example:
- hold the API stage's Builder (`step.hold`) until version 2's batch is answered (the UI stages depend on its code milestone); or
- script the UI stages' first attempts to hold until after the restart.

Two shortcuts drop what (f) is for, so neither is enough:
- Answering the correction without holding anything lets the UI Builders build against version 1 before the restart. Their packages hold logo A either way, because logo B is held.
- Asserting on the first launch keeps the assertion, but the restart then no longer falls "between the approval and the next package".

## Sources

- The driver's rulings on objection 166 (the deferral and its extension to open corrections), and objection 169 (the same pattern in M507 (g) and M518).
- M526 as written; harness/journey/drive.mjs `pump`.
