# 116: M413 (d) "an application-source file changed" can read a stage-gate evaluation that read the head before the case's hand commit

Row: M413 (d)
Test: packages/engine/test/acceptance/M413-the-conformance-stage.test.mjs, "(d) an application-source file changed, a mode changed: CONFORMANCE_SOURCE_MOVED each"
Filed by: Builder, 2026-10-15, on `fix/m5-s37-m413` from main eccfceb (the driver's follow-up: intermittent on main, CHECK_NOT_PASSED where CONFORMANCE_SOURCE_MOVED is expected)

## Observed

Alone on the workstation at eccfceb (a clean build, private TMPDIR, store kept), the first run failed: "an application-source file changed: CONFORMANCE_SOURCE_MOVED (["CHECK_NOT_PASSED"])".

## What the kept store shows

| seq | event | what it read |
|---|---|---|
| 396 to 398 | the conformance stage's last check run ends and requests a tick (D6 K1) | |
| 399, 400 | `gate.evaluated`, stage, not satisfied: CHECK_NOT_PASSED | its snapshot: `expected` = `head` = 0e51389…, the old head, with no out-of-band move adopted (`adopted` 0) |
| 405 | `repo.out_of_band`: refs/heads/main found at 7475e1c…, the case's hand commit | |
| 407, 409 | the owner's adopt: `repo.reconciled` adopt 7475e1c… | |
| 412, 413 | `gate.evaluated`, stage, not satisfied: **CONFORMANCE_SOURCE_MOVED** (`integration_head:7475e1c…`) and CHECK_NOT_PASSED | its snapshot: head 7475e1c…, `adopted` 1 |

The stage is `blocked`. Evaluation 413, the first made on the moved source, names CONFORMANCE_SOURCE_MOVED with CHECK_NOT_PASSED beside it. That is the driver's ruling, and the engine already does it: `sourceMoved` does not depend on the check states, and both reasons are added.

The case takes `since = maxEventSeq` before it makes the hand commit, at line 172. Evaluation 400 was made by the requested tick at 398. Its git read of the head came before the hand commit (it read 0e51389), and its transaction committed after `since`. `afterChange` accepts the first evaluation after `since` that has reasons, so it returns evaluation 400. That evaluation describes the source before the change, and nothing in it is wrong: the move was neither made nor observed when it read the head.

## Proposed

Take `since` after `adoptedOutOfBand` returns (the `repo.reconciled` adopt), not before the commit. Alternatively, accept only an evaluation whose recorded snapshot read the moved head (`inputs_snapshot.conformance.head` equals the commit `change()` returned). The binding case ("(d) the stage's source binding moved") takes `since` before its store write, so it has the same exposure to a tick's evaluation in flight.

No engine change is proposed: the evaluation after the move names CONFORMANCE_SOURCE_MOVED.

## Sources

- D6 §8.1 step 5, K1; B11; the driver's rulings on M413 (d) and M408 (e) (slice 37); objection 114.
