# 224: M610 (a) requires a torn-down iteration's served `outcome.next_step` to stay `open_alpha`; under the owner's ruling of 2026-10-29 a read no longer offers to open an Alpha that a teardown removed

Row: M610 (the owner's draft M7 plan, `docs/acceptance/sdlc-M7-acceptance-plan.md` §3)
Test: packages/engine/test/acceptance/M610-iterate-and-the-second-alpha.test.mjs, case "(a) on a running iteration, and while a deployment operation or a one-shot run of the project is in flight: 409; on an ended one: iteration seq + 1 with its predecessor, the limits snapshotted, the predecessor untouched"
Filed by: Builder, branch build/rapid-prototype (follow-up B, 4bbab3b3), 2026-10-29
For: the Verifier (restate the assertion); the owner if he reads `outcome.next_step` as history

## Claim

Case (a) tears down iteration 1's environment (the teardown in flight that makes the first iterate 409, then pumped until it is finalized), iterates, and then asserts that the predecessor's `outcome` read is deep-equal to the read taken before the teardown:

```
for (const k of ['usage', 'owner_approvals', 'plan', 'brief', 'limitations', 'outcome']) assert.deepEqual(after1[k], S.oneRead[k], `the predecessor's ${k} untouched`);
```

Before the teardown `outcome` is `{status: 'alpha_ready', reason: 'alpha_complete', next_step: 'open_alpha'}`. After it, the engine at 4bbab3b3 serves `next_step: 'its Alpha is no longer deployed (torn down or replaced): iterate from the current iteration, or discard'`. Status and reason are unchanged. The iteration row is unchanged too, including its stored `next_step`: the change is in the read only (`packages/engine/src/prototype/iterations.ts` `servedNextStep`). Observed, the file run alone (`node --test`, `TMPDIR=/tmp/rpf`): tests 5, pass 4, fail 1:

```
the predecessor's outcome untouched
+ actual - expected
  {
+   next_step: 'its Alpha is no longer deployed (torn down or replaced): iterate from the current iteration, or discard',
-   next_step: 'open_alpha',
    reason: 'alpha_complete',
    status: 'alpha_ready'
  }
```

The owner ruled on 2026-10-29: "Keep historical deployment evidence separate from current availability. Teardown or replacement must remove any claim that the old candidate is currently available." `open_alpha` as the next step of an Alpha that a finalized teardown removed is such a claim: it offers to open something that is not running. So the read serves the stored `open_alpha` only while the Alpha is still deployed (`alpha.current_state` neither `torn_down` nor `replaced`). The history the case means to protect stays as it was: `outcome.status`, `outcome.reason`, `iteration.alpha_at`, `alpha.candidate`, `alpha.deployment_request` and `alpha.deployed_at`, which the next assertion of the case already checks and which pass.

I ask the Verifier to restate the `outcome` comparison of case (a) as the historical outcome (`status` and `reason` unchanged), with `next_step` after the teardown no longer `open_alpha` (the engine serves `ALPHA_GONE_NEXT_STEP`, exported by `prototype/iterations.js`, and `alpha.current_state` `torn_down`). If the owner reads `outcome.next_step` as history that a teardown must leave as `open_alpha`, the engine change is reverted and this objection is withdrawn. That reading is his to decide.

## Sources

- The owner's ruling of 2026-10-29 (Alpha state), quoted above, given to the Builder in the follow-up brief for build/rapid-prototype.
- The owner's ruling S3 of 2026-10-28: "Teardown must remove any claim that the Alpha is currently available. Preserve the historical deployment record." (objection 220, which restated M301 (f) the same way).
- M612 (b) already reads a torn-down `alpha_ready` iteration as "the historical outcome kept" (`outcome.status`, `alpha_at`, `alpha.deployed_at`, `alpha.candidate`) beside "Alpha not currently available"; it does not read `next_step`.
