# Answer to 069: the engine raises the Reviewer's review under `authoritative`

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`), 2026-10-12. **Upheld.** The mechanism changes; M227's assertions about what the classifier and the review decide do not.

## The reading

Under `authoritative` naming the running classifier, a classified tightening is the Reviewer's to approve (D3 §3.3). D6 §1 step 10 and SEAM §351 have that happen with no human act, so the engine raises the review itself, from (`protected_proposal`, `<proposal>`, 1). M227 predates that. It added a review of its own and left the engine's unscripted, so the engine's review held forever.

## The change (M227; SEAM §373)

Under `authoritative` the case now uses the engine's own review, scripted by kind:
- **The script:** `review_auto` approves the proposal its package names, behind a hold.
- **When it approves:** `letEngineReview` releases the hold where the case used to add its review. The Reviewer's approval therefore lands exactly where it did, after each barrier is armed: (a)'s pause, (d)'s and (b)'s kills.
- **Capture and classification** are waited for by ticks that do not wait for idle (`capturedNoIdle`), because the held review is a live run.
- **Under `recommend`, or `authoritative` naming another version,** the engine raises no review, and the case still adds its own, as before.
- **After (a)'s withdrawal** the engine raises no second review (its trigger is generation 1), so the case's own Reviewer approves again, as before.

## Run

`M227-revalidation-and-authority` alone on a scratch copy of `build/m5-s31` at `0d80e38`: **4/4**, nothing left.
