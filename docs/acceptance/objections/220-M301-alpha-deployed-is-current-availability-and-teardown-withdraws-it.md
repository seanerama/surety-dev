# 220: M301 (f) reads `candidates.progress` after the teardown; the owner's ruling S3 makes it current availability, which the teardown withdraws in every mode

Row: M301
Test: packages/engine/test/acceptance/M301-the-walking-deployment.test.mjs, case "(f) alpha_complete satisfied: in one transaction the candidate developing → alpha_deployed (candidate.advanced) and the work item complete; the lease released; no releases row"
Filed by: Builder, branch build/rapid-prototype (slice E5 of "Rapid prototype to Alpha"), 2026-10-28

## Claim

Case (f) asserts `candidateRow(fx.home, candidate.id).progress === 'alpha_deployed'`, but the journey in its `before` hook ends with the teardown (case (g)'s operation), so the row it reads is the candidate as it stands after the teardown. Two meanings are folded into that one read:

1. **The historical deployment record**: the candidate reached `alpha_deployed` when `alpha_complete` was satisfied. It is kept, unchanged, by the teardown: the `candidate.advanced` event (`from: developing`, `to: alpha_deployed`, in the completion's transaction), the satisfied `alpha_complete` gate evaluation, the deployment request with its outcome `deployed`, the deploy operation and its journal, the deployment verification, `last_verified`, and the observation history.
2. **Current availability**: whether the candidate's Alpha is deployed now. That is what `candidates.progress` says once the owner's ruling S3 applies: a finalized teardown of the environment sets a candidate still `alpha_deployed` there back to `developing` (event `candidate.alpha_withdrawn`, `from: alpha_deployed`, `to: developing`, naming the environment and the teardown operation), in every mode. Before slice E5 this was done for `rapid_prototype` projects only; M301's project is planned, so the row it read was never reset.

With S3, case (f) fails: the progress read after the teardown is `developing`, correctly, while everything (f) states about the completion (one satisfied evaluation, `candidate.advanced` once, the work item complete in the same transaction, the lease released, the operation succeeded and ended, no releases row) holds unchanged.

I ask the Verifier to restate (f) so that it reads the historical record for the completion and, if it wants the current claim, reads it at the moment it means: either the progress at completion (taken in `J.atCompletion`, before the teardown, where it is `alpha_deployed`), or the `candidate.advanced` event's `to: alpha_deployed`; and, in (g) or (f), that after the teardown the candidate's progress is `developing` with one `candidate.alpha_withdrawn` naming the environment and the teardown operation, the history above unchanged. The Builder changes no acceptance test and does not work around the row.

Observed (this branch, the file run alone with `node --test test/acceptance/M301-the-walking-deployment.test.mjs`): 8 tests, 7 pass, 1 fail: (f), at its first assertion (line 246), `+ 'developing'` `- 'alpha_deployed'`. Cases (a) to (e), (g) and (h) pass.

## Sources

The owner's ruling S3, Sean, 2026-10-28 (given to the Builder in slice E5's prompt): "Make current Alpha availability consistent across modes. Teardown must remove any claim that the Alpha is currently available. Preserve the historical deployment record."

The rapid prototype's ruling R7 (2026-10-28), on which slice E1 built the prototype half of this: an iteration's Alpha outcome and `alpha_at` are history; whether the Alpha is available now is apart from them, and a teardown makes it null.
