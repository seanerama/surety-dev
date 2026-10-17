# 166: M507 (c), (e) and M509's journey answer the design batch while the owner's own protected application is in flight, and never answer the batch the engine asks again

Rows: M507 (c), (e) (`the design criteria's correction captured`), M509 (the shared journey, `the design approved`)
Tests: packages/engine/test/acceptance/M507-design-readiness-and-the-third-milestone.test.mjs, M509-the-ui-builders-package.test.mjs; harness/journey/drive.mjs `pump`
Filed by: Builder, slice 40, 2026-10-17

## Claim

Both stalls the driver saw (mini-hp01 gate at b7326fe: M509, "the design approved: not reached within 10 ticks (human acts so far: [{kind: check_correction_unclassifiable, option: approve, status: 200}])"; M507 alone, 1 run in 3: "the design criteria's correction captured: not reached within 40 ticks", same human acts) are one order of events, and the engine does in it what D1 §10.5 and D6 §4.4 say it does. The test then waits for something only the owner can unblock, and its pump is told not to answer it.

1. Phase 1's check authoring (scripted `requested_change_kind: unclassifiable`) raises `check_correction_unclassifiable`. The pump answers it `approve`. The answer records a `protected_application` intent, and the engine applies it later: at a tick's effects step, or at a tick the engine requests for itself (`scheduler.tick_requested`), behind the project's journal.
2. The test answers the batch by hand, `design_approval` (`assets_held: ['logo']`) and then `spec_change`. Both are consumed 200. The `spec_change_application` intent is recorded with the preconditions of the answered preview, among them `protected_version` (the version before step 1's application).
3. If step 1's application finishes before the spec change's application begins, the effective protected version has moved. The intent is invalidated `EFFECT_PRECONDITION_CHANGED`, and the batch is raised again as a pair (`spec/change.ts`: a design request's `spec_change` asked again takes its `design_approval` with it, D7 §7.4). Nothing else can run: the UI stages are held `design_pending`, and `design_due` is open and names them, so the hold is not silent.
4. The pump answers only `ctx.answerKinds` (M507: `check_correction_unclassifiable`, `check_correction_loosening`, `plan_approval`; M509 the same plus `check_correction_tightening`). The new `design_approval` and `spec_change` stay open, and the wait runs out. The human acts show the one approval of step 1.

Whether step 3 happens depends on timing: whether step 1's application has finished when the test answers the batch. On this workstation (20 cores) M507 (c), (e) passed 45 runs out of 45 in three parallel loops; the driver saw it on mini-hp01.

**Reproduced deterministically** by forcing the order: M507 (c)'s journey with `ctx.answerKinds = []` until the batch, then the open `check_correction_unclassifiable` answered `approve` through the owner's route and, with no tick between, the batch answered as the test answers it. The result is the driver's message exactly:

```
INTENTS AFTER UNCLASSIFIABLE  protected_application pending
INTENTS AFTER ANSWERS         protected_application done; spec_change_application invalidated (EFFECT_PRECONDITION_CHANGED;
                              its preconditions bound protected_version pv_…KX, the version before the correction)
DECISIONS  … design_approval consumed, spec_change consumed, design_approval open, spec_change open (raised again)
DESIGN     proposed, batch_released_at null;  SCR proposed, last_refusal null
error: 'the design approved: not reached within 10 ticks (human acts so far: [{"kind":"check_correction_unclassifiable","status":200}])'
```

The kept store's events, in order:
- 429 to 432: the correction answered, consumed, `protected.approved`, `intent.recorded protected_application`.
- 435 to 441: `design_approval` answered and consumed; `spec_change` answered and consumed; `intent.recorded spec_change_application`.
- 445 to 467: the protected application's commit and ref update, then `intent.done` and `protected.applied`.
- 470: `intent.invalidated` (`EFFECT_PRECONDITION_CHANGED`) for the spec change.
- 471, 472: `decision.raised` `design_approval` and `spec_change`.

With the other order (the batch answered before the correction is approved) the journey passes: the change applies at the answer, and the design criteria's correction is classified `unclassifiable` first and then, when phase 1's correction applies, classified again as `tightening`. That second classification is why a `check_correction_unclassifiable` can belong to the design criteria for a while. Each order is the engine's specified behaviour.

## What the test can do (the Verifier's choice)

- Before answering the batch, wait until the project has no effect intent `pending` or `executing` and no approved protected proposal unapplied. This is the same quiescence `waitForIdle` gives for runs. Then answer the batch's current questions (re-read their preview hashes after the wait); or
- let the pump follow a batch raised again, as it already follows a `spec_change` asked again (the slice-37 ruling): answer the open `design_approval` and `spec_change` about the same revision and request, with the same option and the same `assets_held`.

## For Sean (a design question, not this objection)

The engine raises, or keeps open, a batch whose `spec_change` binds the effective protected version while an approved proposal that will move that version has not been applied yet. The owner's answer can then only be refused at the effect and asked again. Whether the batch should wait for such a pending application before it is asked is not decided by D1 §10.5, D6 §4.4 or D7 §7.4. As built, the owner is asked twice.

## Sources

- D1 §10.5 (an effect's preconditions read again; a change between answer and effect asks again); D6 §4.4 and the slice-37 ruling (a spec change asked again); D7 §7.4 (the batch, neither answer alone having effect).
- harness/journey/drive.mjs `pump` (`ctx.answerKinds`; the `spec_change` re-answer loop).

## Decision

Decided **engine-side** by the driver under the owner's delegation, 2026-10-17. The engine defers raising the design batch (`design_approval` with its `spec_change`) while an approved protected-check correction that would move the batch's binding (the effective `protected_version`) is still unapplied, and the deferral is visible. The batch is not raised into a question the effect would refuse and ask again, so the owner is asked once, after the application.

**No test change** (Verifier, `verify/m6-s40c` from `main` `ca0ac5a`). The objection shows no test fault beyond this order of events. M507 (c), (e) and M509's journey wait for the batch and answer it as the owner would. On an engine that defers, the pump answers the `check_correction_unclassifiable`, the application lands, and the batch is raised after it, bound to the moved version.

**Observed** on the Builder's engine before that change (a detached scratch worktree of `build/m6-s40-fix` at `f001d4a`, `TMPDIR=/tmp/v40d`, M507 run whole with `node --test`): M507 (c), (e) failed in 2 of 3 whole-file runs with this objection's message ("the design criteria's correction captured: not reached within 40 ticks", the one human act being the `check_correction_unclassifiable` approval). This awaits the Builder's deferral.
