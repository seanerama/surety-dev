# 069: under `authoritative` the engine raises the Reviewer's review of a classified tightening, which M227 leaves unscripted

Row: M227 (c), (d) (and (b)'s replay under `authoritative`)
Test: packages/engine/test/acceptance/M227-revalidation-and-authority.test.mjs; harness `reviewerApproves` (harness/gates.mjs) and `reviewerApproval` (harness/checks/classifier.mjs), which add their own `review` work about the proposal
Filed by: Builder, slice 31b, 2026-10-12

## Claim

SEAM.md §351 has phase 2's authoring "a tightening, applied by the Reviewer's `proposal_approval` under `authoritative` (`review_auto`), no human act". Nothing in the journey adds that review by fixture, so the engine raises it. In this branch's `recordClassification` (src/store/transitions/classification.ts), a tightening classified under `authoritative` naming the running classifier gets `review` work about the proposal, from (`protected_proposal`, `<proposal>`, 1).

M227 was written before that. Under `authoritative` it captures a tightening (`correctionOn`) and then adds a review of its own (`reviewerApproves`, `reviewerApproval`), scripted with the approval. The engine's review, raised at classification, has no script on the scripted backend. Its Reviewer run is dispatched and never ends, so `roleRun`'s wait for "every run of the project to end" times out:

```
not ok 2 - (c) recommend: … for the running version it applies after revalidation …
  error: 'timed out after 30000 ms waiting for every run of proj_… to end'
    roleRun (harness/gates.mjs:495) ← acceptedRun ← capturedProposal ← correctionOn (M227…:105) ← (c) (M227…:221)
```

On a scratch copy that dumps the open runs at that point, the one run not ended is:

```
{"role":"reviewer","state":"executing","kind":"review","subject":"{\"proposal\":\"prop_…\"}"}
```

M227 is 1/4 on this branch: the first test ((a), (b)) passes, and the other three fail the same way. Every other file I ran that uses `authoritative` scripts `review` work (M406, M407, M401's T1 variant) and passes.

What I believe the test should do: under `authoritative`, script the engine's review (for example, `fx.scripted.kindScript('review', …)` with the approval, or a script for the item the engine created) and use it as the Reviewer's approval, instead of adding a second review. The engine raising the review is what §351's "no human act" needs. Two reviews of one proposal would be the engine's choice of how a Reviewer is reached, and M227 does not pin that.

## Sources

- SEAM.md §351; D3 §3.3 (the Reviewer's authority under `authoritative`); D6 §6.2.
- src/store/transitions/classification.ts `recordClassification`.
