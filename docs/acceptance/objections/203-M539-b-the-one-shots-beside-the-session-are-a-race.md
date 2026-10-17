# 203: M539 (b)'s check that a one-shot ran beside the Designer session is a race the fixture loses about two times in three

Row: M539 (slice 46)
Test: packages/engine/test/acceptance/M539-the-pace-reads-design-figures.test.mjs, case "(b) per Designer session: turns, time, tokens with cached_in apart, screens per target, the one-shots beside it", its assertion "the fixture is live: one-shot runs of the project ran beside the session (G12)"
Filed by: Builder, slice 46, 2026-10-17

## Claim

The case asserts `beside > 0`, where `beside` counts the project's one-shot runs that overlap the Designer session's run (created before its `finished_at`, and finished after its `started_at ?? created_at`). It then compares that count with the read's `one_shots_beside`. The read computes the same count from the same rows. What fails is the liveness check, and it fails by timing.

The fixture pumps until the API stage's `stage_build` is **launched** and only then opens the Designer session. `pump` waits for the project to be idle after each tick, so by the time it returns, the stage build has ended. The engine dispatches the stage's verification on its own after the build ends (no tick needed), and that verification ends a few hundred milliseconds later. On the kernel lane nothing else one-shot can start during the session: the verification's check executions stay queued until the next `pump` records them, and the review waits on them. So whether a one-shot overlaps the session depends on whether that verification is still running when the session opens.

Observed on `build/m6-s46` (`TMPDIR=/tmp/b46`, each run the file alone or a copy of the fixture up to the close):

- run 1, the file alone: failed, "the fixture is live: one-shot runs of the project ran beside the session (G12)";
- run 2, the file alone: passed (`ok 4`);
- run 3, the file alone in the serial list: failed, the same message;
- the fixture's copy, its times:

```
SESSION {"created_at":"…T17:48:36.136Z","started_at":"…T17:48:36.536Z","finished_at":"…T17:48:38.279Z"}
ONESHOT check_authoring  created …34.022Z finished …34.570Z
ONESHOT stage_build      created …34.948Z finished …35.593Z
ONESHOT verification     created …35.636Z finished …36.074Z
```

The verification ended 62 ms before the session was created. In the failing runs the case stops at the liveness assertion, before comparing the read with the store. The read's `one_shots_beside` uses the same rows and the same rule (`src/design/pace.ts`). In the passing run the read equalled the store's count. Under the split gate's load the race can go either way.

**Asked:** make the overlap certain, so the case tests the read rather than the scheduler's timing. For example: script the API stage's first Builder run to hold (`step.hold('gate', …)`) and pump only until it is launched; open, drive and close the Designer session while it is held; then release it (`fx.scripted.release(…)`) before the batch. Or open the session before the pump that dispatches the API stage, since G12 admits one-shots beside it. The count the case compares stays the same.

## Sources

- SEAM.md §540, `designer_sessions[]`: "`one_shots_beside` (one-shot runs of the project overlapping the session)".
- D7 §3.1, G12 (a Designer session opens beside one-shot runs); M532.
- BS6 §4 (the split gate; "a failure is rerun alone before it is called real").

## Decision

Upheld by the driver under the owner's delegation, 2026-10-17 (Verifier, `verify/m6-s46b` from `build/m6-s46` `60cefbc`). **The overlap is made certain by a held build.**

- The API stage's first Builder launch now holds (`step.hold('gate', {heartbeat_ms: 250})`), and the pump that dispatches it keeps running in the background.
- Once the build is seen held, the Designer session opens and its first turn is posted. As soon as the session's run has a `started_at`, the build is released by its work item, and then the turn and the pump are awaited.
- So the build was created before the session ended and finished after it started. `beside > 0` holds by construction, and the case still compares the read's `one_shots_beside` with the store's count.

M539 passed 11 of 11 in each of three runs alone on `60cefbc` (`TMPDIR=/tmp/v46b`). SEAM.md §540 says so, and §546 records this decision.
