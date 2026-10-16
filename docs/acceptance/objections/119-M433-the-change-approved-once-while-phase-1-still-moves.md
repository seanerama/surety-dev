# 119: M433's change fixtures answer the owner's question once, while phase 1's stage work still moves, so the approval goes stale and the next generation is never answered

Rows: M433 (the slice-36 review's S1, S3 and M2)
Tests:
- packages/engine/test/acceptance/M433-a-failed-correction-and-a-partial-one.test.mjs, every case, through `approvedR2`.
- packages/engine/test/acceptance/M433-old-generation-runs-and-what-resolves-an-obligation.test.mjs, cases "M2 (31b review), A" and "B", through `proposeAndApprove`.

Filed by: Builder, 2026-10-16, on `fix/m5-test-health` from main 4c0f067, on the driver's instruction

## What fails

Each file was run 5 times alone on this workstation at 4c0f067, with nothing else of mine running for the first file:

- `M433-a-failed-correction-and-a-partial-one`: **3 of 5 runs failed**.
  - S1 one fault failed in runs 1, 2 and 4.
  - S3 also failed in run 4.
- `M433-old-generation-runs-and-what-resolves-an-obligation`: **2 of 5 runs failed**, case M2 A in runs 1 and 5.

Every failure is the same:

```
error: 'version 2: not reached within 20 rounds'
```

## Mechanism (two failing stores read)

Each case calls `authoringReady(fx, ctx, 1)` and then posts the change straight away. Phase 1's two stages are still being built, verified and reviewed under `autonomy: phase`. The fixture waits for `proposed`, answers the `spec_change` decision `approve` once, then pumps 20 rounds for version 2. Its `answerKinds` (`OWNER_KINDS`) exclude `spec_change`.

**The S1 store** (kept by a scratch copy of the file):

- 754: `spec.change_proposed`, while stage 2's review run is executing. The impact's `dependency_manifest.work` lists stage 2's `stage_build` as `active`.
- 771: `decision.answered` (approve). 773: `intent.recorded` (`spec_change_application`).
- 781: `work.complete` of stage 2's `stage_build`, its stage gate satisfied after the review's sign-off. 785: the review's `run.ended`.
- 788: `intent.invalidated` (`EFFECT_PRECONDITION_CHANGED`, `changed: ["dependency_manifest"]`). 789: `decision.raised` `spec_change`, `semantic_generation` 2.
- 807, 819, 864: generations 2 to 4 invalidated in turn, as the phase's results for accept-r2 and integration land and the phase completes (`.impact`). 865: generation 5 raised.
- At the timeout: request `proposed`, generation 5 open, no `spec_revisions` version 2.

**The M2 A store:** the same sequence.

- 750: `spec.change_proposed`. 767: answered.
- 777: `work.complete` of a stage of phase 1 (its gate satisfied).
- 779: `intent.invalidated` `EFFECT_PRECONDITION_CHANGED` (`dependency_manifest`).
- 780, 804, 864: generations 2 to 4 raised, never answered.

## Claim

The engine does what the row and SEAM §420 say:

- "a work item of a listed stage changing status; a new result of a listed check … makes the answer stale … and the next generation is raised about the same request";
- "Between the answer and the effect, a new result of a listed check invalidates the effect's intent (`EFFECT_PRECONDITION_CHANGED`): nothing applied, the request not approved."

The question's own text says so when executions are still settling: "a result they record may change the impact, and the question is then asked again".

The fixtures assume nothing in the listed scope moves between the proposal and the effect. Before K1 that mostly held, because phase 1 moved only on the pump's ticks. Under K1 (D6 §12.1) every run end and result requests the next tick, so stage 2's review, gate and phase results land inside the window. The other order of the same race fails at the answer instead: the decision is stale before the answer, and `the owner approves it` reads 409.

## Proposed

Either of these:

1. **Re-answer as the owner.** The version-n pump answers the request's re-raised `spec_change` generations too, for example `answerKinds: [...(ctx.holdOpts.answerKinds ?? []), 'spec_change']` on the `version 2` / `version ${version}` pumps.
   - The first answer should tolerate a stale refusal (409 `decision_stale` or `decision_invalidated`) by answering the next generation.
   - This is what an owner does when the question is asked again (§420), and none of these cases counts human acts.
2. **Ask with the scope at rest.** Post the change only once phase 1's listed scope is at rest: stage 2's work terminal, and no execution of accept-r2 or integration queued or running. This is the §420 Q5 discipline ("the project at rest (no run live, no work status changing for two rounds)"). Case (f) already does this for its own executions with `hold`.

Option 1 was checked in scratch copies of both files (imports made absolute, outside the repository) at 4c0f067, with only the pump's `answerKinds` changed:

- **`M433-old-generation-…`:** 5 of 5 runs passed in full.
- **`M433-a-failed-…`:** 16 of 17 whole-file runs passed (one of them under `npm run test:unit` running beside it), and the S1 one-fault case passed 10 of 10 alone.
  - The one failure was S1 one fault, in the first batch.
  - Its multi-line assertion message was not kept, so I cannot say which assertion it was or whether it shares this mechanism.
  - It was not reproduced in the 16 runs after it. A Verifier rerunning the changed file should watch for it.

## Sources

- D6 §4.4, §4.5, §12.1 K1; D1 §10.5; SEAM §§76, 420, 427.
- `spec/change.ts`: `beginApplication` → `revalidateIntent`; `specChangeKind` (the question's settling text).
- Objection 100 (the same class across other files).

## Ruling (Verifier, 2026-10-16, on `verify/m5-objections-117-120` from main a44a9c3)

**Upheld; SEAM §468. Remedy 1 (re-answering) is taken.**

- The engine does what SEAM §420 says. The driver's ruling at §464 (CR-1 answered twice) already says an approval whose intent is invalidated is asked again, and that the owner's next answer is the ruled re-ask.
- **The fixtures changed** are `approvedR2` (M433-a-failed-correction-and-a-partial-one) and `proposeAndApprove` (M433-old-generation-runs-and-what-resolves-an-obligation):
  - The owner's first approval may be accepted (200) or refused stale (409 `decision_stale` / `decision_invalidated`).
  - The version-n pump then answers the request's re-raised `spec_change` generations as the owner, beside the case's own `answerKinds`, for at most 40 rounds.
- **Why this remedy keeps the row's intent most directly:**
  - Each case keeps its moment: the change is still posted while phase 1 moves, and the faults and the rediscovery are still armed between the proposal and the answer.
  - Re-answering is the owner's act §420 describes.
  - Posting at rest would move every case's change to after phase 1 settles.
  - None of these cases counts human acts.
