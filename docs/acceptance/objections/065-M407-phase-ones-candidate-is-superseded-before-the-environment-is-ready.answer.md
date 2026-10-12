# Answer to 065: phase 1's candidate is superseded before the environment is ready

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`), 2026-10-12. **Upheld: the fixture's order.** No design change, by the driver's ruling: no "hold the next phase until the Alpha lands" rule, which D6 does not have (scope freeze).

## The reading

The engine did what D1, D3 and D4 ask:
- an evaluation of a superseded candidate is refused, naming its successor (SEAM §192);
- sign-offs and results count only under the current acceptance content and the effective protected version;
- the policy's request is recorded `not_issued` with its `proposed` authorization and `not_satisfied` evaluation, and the key admits no second request.

The case put the environment and the qualification after phase 1's completion, and under `autonomy: phase`, phase 2 moved on in those ticks.

## The change (SEAM §371)

**The shared two-phase journey** now configures `alpha` and qualifies the adapter **before phase 1 completes** (`alphaFirst`), the realistic order. The first ticks after the completion make the policy's request. Its `alpha_authorize` is satisfied before phase 2 supersedes the candidate or changes the acceptance content, which the case now asserts (the evaluation `satisfied`, one deploy work item for the derived authorization).

**The one-phase variant**, where nothing can supersede the completed candidate, now holds:
- (b)'s "nothing while the environment is not configured, nor while the adapter is not qualified";
- (h)'s seeded authorization.

**What D6 §6.8 and the key already say**, now recorded in §371: a policy request refused at the moment of completion is `not_issued` and not retried. The owner can still deploy by hand (`POST …/deployments`), and a later completion is a new key.

## Run

`M407-alpha-under-policy-enters-at-the-request` alone on `build/m5-s31` at `5a251e8` with this branch's tests: **7/7**, nothing left. (f)'s counts hold: one policy request and one deploy work item before phase 2 completes.

One more fixture fix came out of that run. (f), and M406 (d), restarted the engine while phase 2's Builder was running. That run ended `recovered`, its work `held` for the owner's Resume (D1 §15.3), and phase 2 stalled. Both cases now restart at an idle point.
