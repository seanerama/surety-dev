# 220, answered: upheld; M301 (f) reads the historical completion at completion, and current availability after the teardown

Answer to `220-M301-alpha-deployed-is-current-availability-and-teardown-withdraws-it.md`, by the Verifier on `verify/rapid-prototype`, merged up to the Builder's `build/rapid-prototype` 4bb74433 (slice E5), 2026-10-28.

**Upheld.** The owner's ruling S3 of 2026-10-28: "Make current Alpha availability consistent across modes. Teardown must remove any claim that the Alpha is currently available. Preserve the historical deployment record. Have the Verifier distinguish those meanings before restating M301."

Case (f) read `candidates.progress` after the journey's teardown and took it for the completion. Under S3 that column means one thing only: whether the candidate's Alpha is deployed now.

## The two meanings

1. **The historical deployment record.** The candidate reached `alpha_deployed` when `alpha_complete` was satisfied. A teardown keeps all of this unchanged:
   - the `candidate.advanced` event (`from: developing`, `to: alpha_deployed`), written in the completion's transaction with the deploy work item's completion;
   - the satisfied `alpha_complete` gate evaluation;
   - the deployment request and its outcome `deployed`;
   - the round's deployment verification;
   - `last_verified`;
   - the observation history, which is only appended to;
   - for a rapid prototype, also the iteration's `alpha_at` and `alpha_ready` outcome.
2. **Current availability.** This is `candidates.progress` read now, plus, for a prototype, the iteration's `alpha.current`. A finalized teardown of the environment sets a candidate still `alpha_deployed` there back to `developing`, in every mode. Its finalizer records this with one `candidate.alpha_withdrawn` event (`from: alpha_deployed`, `to: developing`, the environment, the teardown operation).

## What changed (tests only; SEAM.md §576)

`packages/engine/test/acceptance/M301-the-walking-deployment.test.mjs`. The `before` hook now records the candidate row and the historical record (deployment requests, verifications, `alpha_complete` evaluations, observation history) at completion, and again after the teardown. Case (f) is now two tests:

- **(f), the historical completion.** It keeps every assertion it had:
  - one satisfied evaluation;
  - `candidate.advanced` once, in the same transaction as the work item's completion;
  - the lease released;
  - the operation succeeded and ended;
  - no releases row.

  It now reads the progress `alpha_deployed` from the row taken at completion, before the teardown. It also asserts `candidate.advanced`'s `from: developing`, `to: alpha_deployed`.
- **(f) after the teardown, current availability.** It asserts:
  - the candidate's progress is `developing`;
  - `candidate.alpha_withdrawn` exactly once, naming the candidate, `alpha_deployed → developing`, the environment and the teardown operation, in the teardown operation's finalizing transaction (`operation.finalized`);
  - `candidate.advanced` still once;
  - the deployment request rows unchanged, outcome `deployed`;
  - the verification rows, the `alpha_complete` evaluations and `last_verified` unchanged;
  - the observation history kept and only appended to;
  - the candidate row the same candidate.

No other assertion of M301 was weakened or removed. Cases (a) to (e), (g) and (h) are unchanged.

The same two meanings are pinned in every mode by the M7 rows: M609 (a) and (c) and M612 (b) on the kernel lane, and M611 (c) and (d) on a real unit (sandbox lane).

## The same read in two sandbox files

M307 and M307 qualified by command make the same read. Their `before` hooks end with the teardown, and their cases (d) and (f)(d) read `candidates.progress` afterwards.

Run alone on this branch, M307-the-deployment-journey-on-a-real-unit failed (d) the way M301 (f) did: `+ 'developing'`, `- 'alpha_deployed'`, tests 5, pass 4, fail 1.

Both files are restated the same way:

- the `before` hook keeps the candidate row taken at completion;
- (d), and (f)(d), assert `alpha_deployed` from that row and `candidate.advanced` once (`developing → alpha_deployed`);
- a second test of the same letter asserts, after the teardown:
  - the candidate `developing`;
  - one `candidate.alpha_withdrawn` naming the environment and the teardown operation;
  - `candidate.advanced` still once.

Nothing else in those files changed.

## Runs

Run alone with `node --test` on this branch after `npm run build`, `TMPDIR=/tmp/rpv-m7`:

- M301-the-walking-deployment: tests 9, pass 9, fail 0.

## Sources

- The owner's ruling S3 of 2026-10-28, quoted above.
- The ruling R7 of 2026-10-28: an iteration's Alpha outcome is history, and its availability now is apart from it.
- `packages/engine/src/store/transitions/prototype.ts` `withdrawAlpha`, called from `deploy.ts`'s teardown finalizer, on 4bb74433.
