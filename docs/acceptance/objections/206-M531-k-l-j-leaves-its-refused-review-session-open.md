# 206: M531 (j) ends with its refused review session still open, so (k) and (l) cannot open theirs (409 `session_busy`)

Row: M531 (j), (k), (l) (slice 45)
Test: packages/engine/test/acceptance/M531-owner-verdicts-are-owner-acts.test.mjs, cases "(j) F4: the Designer's review file proposing R3.2 …", "(k) F4: the owner's edit removing the link …", "(l) F4: a proposed link valid when the review was recorded, made stale …" (Verifier's `2338919`, `verify/f4c`)
Filed by: Builder, F4 second ruling (`build/f4c`), 2026-10-18

## Claim

(j)'s last step opens a review session (`ownerReviewOf`, review-7) whose close is refused 422 `design_check_failed`, as (j) asserts. A refused close leaves the session open, as the engine says in the refusal ("Correct the review in the session, save, and close again; or close with refuse"; `src/sessions/driver.ts`, `src/design/review-driver.ts`), and as it did before F4. (j) does not close it with refuse. The next case, (k), then opens a review session on the same project of the shared fixture and is refused 409 `session_busy`; (l) the same:

```
✖ (k) … AssertionError: POST …/design/reviews (→ 409 {"code":"session_busy","reason":"Project proj_01M5869G6Y9XHR6YRS0FFVSSHQ has a session run (run_01M586A96AA4GNWQEVC2HMRQM9, designer) that has not ended; one session at a time, and none beside a one-shot run." …) 409 !== 201
    at ownerReviewOf (M531-owner-verdicts-are-owner-acts.test.mjs:219:10)
✖ (l) … the same 409 session_busy, at ownerReviewOf (…:219:10) from (l) line 606
```

Observed (`TMPDIR=/tmp/bf4c`, the file alone, `build/f4c` at the merge of `2338919`, after `npm run build`): 7 pass, 2 fail, (k) and (l), each at its first request.

The same file with `--test-name-pattern='^\((k|l)\) F4'` (the shared `before` run, (a) to (j) not run, so no session left open): 2 pass, 0 fail. The engine meets (k) and (l); only the order fails them.

## Proposed

(j) closes its refused session with `refuse` (or otherwise ends it) after its assertions, so the shared project has no open session when (k) begins. No engine change is asked.

## Decision

Upheld, test-side. Decided by the Verifier on `verify/f4d`, 2026-10-18, against `build/f4c` at `22082f0`.

- Reproduced as filed. With `22082f0` built, M531 run alone gives 7 pass and 2 fail: (k) and (l) each fail at `ownerReviewOf`, 409 `session_busy`, naming a Designer run that has not ended. `--test-name-pattern='^\((k|l)\) F4'` gives 2 pass, 0 fail. The engine's refusal text ("Correct the review in the session, save, and close again; or close with refuse") says a refused close leaves the session open, and (j) never ended it. The test was at fault.
- Closing with `refuse` alone was not enough. With only that change, (k) opened its session, but its save's design check was refused `DESIGN_SCHEMA_INVALID` on `reviews/review-7.json`, `screens[0].deltas[0].check` ("accept-r1 does not cover R3.2"). That is (j)'s refused file. (j)'s save had committed it to the session's tree, and the next review session's check reads every `reviews/*.json` in the tree (`src/design/check.ts`, the review files loop). So (j) also has to take the file out of the tree, and it does so through the engine's own routes.
- (j), after its existing assertions, which are unchanged:
  - it asserts that the session whose close was refused has not ended;
  - it drives one more turn in that session in which the Designer deletes `review-7.json` (`step.delete(REVIEW_FILE(7))`);
  - it asserts that the save's design check is `passed`;
  - it closes with `{ refuse: true }` and asserts 200, `decisions: []` (the refuse raises nothing) and the run `ended`;
  - it repeats the "nothing recorded" assertions: no verdict recorded from the review, the count of reviews with verdicts unchanged, no `design_verdicts` asked, nothing filed.
- (k) and (l) are unchanged, and no assertion was removed or weakened.
- For the owner (a design question, not a failing test): a review file whose close was refused stays in the design tree after a `refuse` close, unrecorded. Every later review session's check then refuses it until a session removes it. That matches D7 §5.6 as written ("the owner closes with `--refuse`, which records the product and raises nothing"). Neither §5.6 nor §10 says whether a kept, unrecorded review file should fail every later review session's check, or should be dropped. The engine meets what the tests ask either way.

Observed on `22082f0` plus this change, after `npm run build`, each file run alone with `TMPDIR=/tmp/vf4d`:

- M531, first run: 9 of 9 pass.
- M531, second run: 9 of 9 pass.
- M516: 7 of 7 pass.
