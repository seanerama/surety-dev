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
