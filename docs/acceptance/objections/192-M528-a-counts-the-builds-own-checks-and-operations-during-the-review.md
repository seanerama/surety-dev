# 192: M528 (a) counts every check execution and operation while the shared fixture's build is still running, and counts the review session's own git operations, so neither count can stay put

Row: M528 (a) (slice 45)
Test: packages/engine/test/acceptance/M528-the-owner-invoked-review-of-a-native-build.test.mjs, both (a) cases: "(a) surety design review --target android --build \"1.4.2 (37)\" --evidence a.png b.webm: …" and "(a) POST …/design/reviews with a candidate: the candidate recorded as his word, unverified"
Filed by: Builder, slice 45, 2026-10-17

## Claim

SEAM.md §522: "The candidate is his word … The command records it in the subject and makes no observation, check execution or operation. The tests count `records` of kind `design_observation`, `check_executions` and the project's `operations` before and after."

**The build is still running.** The shared fixture is `designedPantry` followed by

```js
J.candidate = await pump(fx, d.ctx, () => candidatesOfProject(fx.home, d.p.id).at(-1), { what: 'a candidate of the built stages', max: 120 });
await waitForIdle(fx.home, d.p.id);
```

That returns at the **first** candidate, while Pantry's build is far from done: the UI stages, their checks, the phase. `waitForIdle` waits for the runs in flight to end, not for the project to have nothing left to dispatch. Each case then drives the review session with `driveReview`, whose `sayAndSettle` ticks the engine (`tickUntil`) until the turn settles. Every tick also dispatches the project's remaining build work (one-shot runs are admitted beside a Designer session, D7 §3.1, G12), and the checks of the new candidates run:

```
not ok … (a) surety design review … : no check run   18 !== 4
not ok … (a) POST …/design/reviews with a candidate: no check run   18 !== 4   (also on 9a75c98, slice 44, before any slice-45 change)
```

The same 18 !== 4 appears on `9a75c98`, where the route opened the review session with no evidence and touched no check, so the executions are the build's, not the review's. `check_executions` is counted over the whole home, with nothing tying a row to the review.

**The review session makes git operations of its own.** A review session is a Designer session: its workspace is made, and its save committed and integrated, through the git journal as every session's is (D1 §7.3; D6 §2.1). Those are rows of `operations`. Observed on a scratch copy with the fixture waiting for phase 1 to complete, the three rows the first (a) case's window adds are exactly these, each naming the review's own run:

```
[{"kind":"git_worktree","subject":{"run":"run_01M558QK…","action":"worktree_add"}},
 {"kind":"git_commit","subject":{"purpose":"run","run":"run_01M558QK…"}},
 {"kind":"git_ref_update","subject":{"run":"run_01M558QK…","old_oid":"ee7dcbd…","new_oid":"2fb2d43…","checkpoint":true}}]
```

"Makes no … operation" reads naturally as no D4 operation for the build he names (no deploy, rollback, teardown or publish: nothing is deployed or verified for it), which is what D7 §10.5 means by "does not verify that the build exists". The `design_observation` count stays put on `build/m6-s45`: the owner-invoked review fetches nothing.

**Asked**, for the check executions, either:
- (a) the fixture waits until the build is quiet before the cases (for example `phaseCompleted(fx, d.ctx, 1)`), so a count that moves is the review's; or
- (b) the count is tied to the review: no `check_executions` row created in the window for the candidate the owner names, or by the review's run.

And for the operations: count only the D4 kinds (`deploy`, `rollback`, `teardown`, `publish`), or exclude those naming the review's run; §522's sentence says which.

**Scratch runs** (a copy of the acceptance tree under `/tmp/b45/scr`, the Builder's `dist` linked in, `TMPDIR=/tmp/b45`; the repository's tree unchanged):
- as written, on `build/m6-s45`: (b), (c), (e), (g), (h) pass; both (a) cases fail at the counts (`check_executions` 18 !== 4; `operations` 47 !== 44). Everything the first (a) case asserts before them passes: the subject verbatim, the review-mode session, the two evidence records by digest with provenance, format, size, target and `observed_on`, the package's `design/evidence.json` with the screenshot as a file and the recording by name only, and no `design_observation` record;
- the fixture waiting for `phaseCompleted(fx, d.ctx, 1)`: both (a) cases then pass the `design_observation` and `check_executions` counts and fail only "no operation" (47 !== 44; 50 !== 47);
- the same, with the operations line replaced by a print of the window's rows (above): the first (a) case passes whole, (d) and (f) included (`GET …/design`'s `evidence_by_provenance` `{engine_observed: 0, owner_supplied: 2, owner_reported: 0}`, the android human test's evidence bound to the build and `device`, shown "owner accepted").

## Sources

- SEAM.md §522 (the counts), §521 (the shared fixture's names).
- D7 §3.1, G12 (one-shot runs beside a Designer session); §10.5; D1 §7.3 and D6 §2.1 (a session's workspace and checkpoints through the journal).
- harness/sessions.mjs `say` (ticks until the turn settles); harness/runs.mjs `waitForIdle`.
