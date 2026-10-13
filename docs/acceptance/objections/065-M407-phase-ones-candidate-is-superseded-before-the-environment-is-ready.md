# 065: phase 1's candidate is superseded, and its evidence rebound, before M407's environment is ready, so `alpha_authorize` refuses the policy's request

Row: M407 (b), (d), and through them (f) and (e)
Test: packages/engine/test/acceptance/M407-alpha-under-policy-enters-at-the-request.test.mjs, the shared journey's first two tests; SEAM.md §354
Filed by: Builder, slice 31b, 2026-10-12

## Claim

The shared journey completes phase 1 under `autonomy: phase` and only then configures the environment (after three ticks), then qualifies the adapter (after three more), then pumps for the policy's request. Under `autonomy: phase`, phase 1's completion raises the replan, and with objection 064's fixture phase 2's authoring is a tightening the Reviewer applies with no human act. Phase 2 therefore runs on during those ticks: the replan publishes phase 2, its authoring makes a new protected version, and its first stage integrates and is nominated.

When the policy's request is made, through `requestDeployment` as §354 asks, it derives the authorization and evaluates `alpha_authorize` on the phase-completion candidate. On this branch that evaluation reads:

```
not_satisfied
  CANDIDATE_SUPERSEDED  [cand_…N5H]   (a later candidate, nominated while phase 2 proceeds)
  CHECK_NOT_PASSED      [lint, smoke] (missing under the new protected version)
  SIGNOFF_MISSING       [the candidate] (T2's Reviewer candidate sign-off is bound to the old acceptance content)
```

Each reason is D1's or D3's as built in M1 to M4, not something 31b added:

- every gate evaluation of a superseded candidate is refused naming its successor (SEAM.md §192, Q9 (a));
- the sign-offs a tier requires count only when bound to the scope's acceptance content hash, which the new protected version changes;
- a check's results count only under the effective protected version.

The request is recorded `not_issued` with its `proposed` authorization and `not_satisfied` evaluation (§354's refused-gate outcome). It is never retried, because the key admits no second request. Phase 2's later completion is a new key, and that request deploys. That is why (d) sees phase 2's candidate `alpha_deployed`, (f) sees two policy rows, and (b) sees `proposed`.

D6 §6.8 has the policy request "the newest candidate whose `phase` gate is satisfied … after the environment is configured … and the adapter qualified". It says nothing about phase 2 having moved on in the meantime. Under D4 nothing can authorize a superseded candidate, whether the policy requests it or the owner's command does.

What would make (b) and (d) hold, for the Verifier or Sean to choose:

- Have the environment configured and the adapter qualified before phase 1 completes, so the first tick after completion makes the request, before the replan's run has started. (b)'s "nothing while not configured or not qualified" could be read before completion, or on the one-phase variant, where nothing supersedes.
- Or rule that a mid-project Alpha under the policy needs the next phase held until the request is made. That is a design decision; D6 has no such hold, and I have not built one.

## Sources

- D6 §6.8, K9, D6-D01.
- SEAM.md §192 (a superseded candidate's evaluation refused, naming its successor); §354.
- D3 §4 (sign-offs bound to the acceptance content; results under the effective version).
