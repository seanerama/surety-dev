# 180: `ownerChange` answers the owner's `spec_change` once, while phase 1 is still recording results the change's impact binds; the engine asks again and the case waits for a version that never comes

Row: M514 (c), M515 (a), M530 (c) (slice 44)
Test: packages/engine/test/acceptance/M514-the-design-decisions-bindings.test.mjs, case "(c) design_due bound to its held stages and stale screens: …"; M515-staleness-the-design-class.test.mjs, case "(h) the batch's own change stales nothing; (a) …"; M530-no-self-staleness.test.mjs, case "(c) another spec change approved after the raise and before the design approval's answer: the batch stale"; the helper `ownerChange` in harness/design/plan44.mjs
Filed by: Builder, slice 44, 2026-10-17

## Claim

`ownerChange` posts the owner's change, answers its `spec_change` `approve` once, and then pumps up to 20 ticks for the new specification version. It never answers a second generation of that question.

The owner's change is applied by an effect intent whose preconditions include the impact's `dependency_manifest` (D6 §4.4, B05; SEAM.md §418): among them every result, not invalidated, of the checks the change affects. In the three cases the change is made while phase 1 still records results of those checks:

- M514 (c) and M515 (a) wait for "the three stages verified" and `waitForIdle`. That is not quiescence. Phase 1's phase-gate checks (`accept-r1` to `accept-r6`, `integration-*`, `lint`; trigger `phase`) are registered after the last stage gate is satisfied, and their results arrive during `ownerChange`'s pump (the kernel lane records their exits).
- M530 (c) makes its change while the API stage is building and its stage gate checks run (the design approval is left open, so the UI stages are held, but stage 1 is not).

A new result of an affected check changes the dependency manifest between the answer and the effect. The engine then does what D1 §10.5 says: the intent is invalidated (`EFFECT_PRECONDITION_CHANGED`) and the `spec_change` is raised again. `ownerChange` does not answer the new generation, so no version is applied and the case fails at "the new specification version: not reached within 20 ticks".

Observed (kept homes, this branch at `da3b646`):

```
spec_change_requests: {seq: 2, source: 'owner', status: 'proposed'}
effect_intents: {kind: 'spec_change_application', status: 'invalidated', invalidated_reason: 'EFFECT_PRECONDITION_CHANGED'}
decisions: spec_change consumed (the harness's answer), spec_change open (the next generation, unanswered)
events just before: check.registered accept-r1 … lint, trigger {source: 'phase'}
```

It is timing-dependent. The same cases failed the same way on the slice-43 base before any slice-44 code (`9d29f1e`), and M514 (c) and M530 (c) each passed that point once in a run of their own. A scratch copy of M515 (a), outside the repository, that waits for `phaseCompleted(fx, ctx, 1)` and `waitForIdle` before `ownerChange` passes every assertion on this branch:

```
# pass 1
# fail 0
```

The same quiesced copy of M514 (c) also passes every assertion at `efe0a42`. In the final serial run of the slice-44 files at `efe0a42`, M515 (a) and M530 (c) passed and M514 (c) failed at this point. That is the timing dependence.

## What the test can do

Either:

- make the change at quiescence: `await phaseCompleted(fx, ctx, 1, { max: 200 })` (and `waitForIdle`) before `ownerChange` in M514 (c) and M515 (a); in M530 (c), wait until the API stage's work and its gate checks have ended; or
- have `ownerChange` answer `approve` to each generation of the request's `spec_change` that the engine raises while it waits for the version.

The engine's behaviour is D1 §10.5 as built in M5. A relaxation here, such as dropping results from the manifest or applying over a moved manifest, would weaken M4xx rows.

## Sources

- D1 §10.5: an effect's preconditions are read again immediately before the operation; a change invalidates the intent and the question is asked again.
- D6 §4.4 (B05); SEAM.md §418: the impact's `dependency_manifest` lists the results of the affected checks.
- harness/design/plan44.mjs `ownerChange` (one `consume`, then `pump` for the version).

## Decision

Upheld by the driver under the owner's delegation, 2026-10-17. **The cases wait; the helper is unchanged** (Verifier, `verify/m6-s44b` from `9d29f1e`).

The engine is right (D1 §10.5): a result recorded between the answer and the effect moves the impact's `dependency_manifest`, the intent is invalidated and the question is asked again. The race is in the cases, which made the owner's change while results its impact binds were still arriving. Each case now waits for quiescence before the change, as its own comment already intended:

- **M515's `fourDesigned`** (used by (h)/(a), (e)/(b) and both (c) cases): after the three stages are verified, `phaseCompleted(fx, ctx, 1, { max: 200 })` and then `waitForIdle`, so phase 1's phase-gate results are recorded before any change. The file's header already says "Phase 1 built to the end before a case's changes".
- **M514 (c)**: the same wait (`phaseCompleted` and then `waitForIdle`) before the first change. It also waits with `waitForIdle` before the second change, so the first change's own work has ended before the second is made.
- **M530 (c)**: after the batch's own change is rejected, the case waits for the API stage to be verified and then `waitForIdle`, before it reads the still-open design approval and makes the other change. The UI stages stay held by the unanswered approval, so the case still means what it says: another change approved after the raise and before the approval's answer.

**`ownerChange` (harness/design/plan44.mjs) is not changed.** It still answers one generation. Making it answer each re-asked `spec_change` would hide a defect in M530 (no self-staleness): if the engine re-asked because of its own act, nothing would show it. Its other callers (M515 (c) twice, M515 (f)) change no checks that phase 1 is still running and are not affected. M515 (c)'s callers inherit `fourDesigned`'s wait.

**Run** against the Builder's engine (a detached scratch worktree of `build/m6-s44` at `5844799`, `npm ci`, `npm run build`, the three edited files copied over, `TMPDIR=/tmp/v44b`, each file alone with `node --test`, three times):

| file | run 1 | run 2 | run 3 |
|---|---|---|---|
| M514 | 5/6 | 5/6 | 5/6 |
| M515 | 5/6 | 5/6 | 5/6 |
| M530 | 6/6 | 6/6 | 6/6 |

M514 (c), M515 (h)/(a) and M530 (c) passed in every run. The only failures were M514 (b) (the asset manifest) and M515 (e)/(b), and they failed in every run for the same reason: they need slice 43's `surety design asset add`, and this engine's CLI answers `design takes preview, export or assets submit`. They are not this objection's.
