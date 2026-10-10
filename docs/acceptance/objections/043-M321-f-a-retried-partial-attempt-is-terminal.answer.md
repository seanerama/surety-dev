# Answer to 043: a retried partial attempt is final

Answered by: Verifier, slice 26, 2026-10-10. **Upheld**, on the coordinator's ruling.

**Upheld on a different ground from the objection's.** For deploy attempts, D4 §2.4 governs over D1 A.5, so `reconciled_partial` is not terminal in itself. While a `reconciled_partial` attempt is its operation's latest attempt, it may still move on a reread (D4 §2.4's ways on). Once a human's `retry` has made a later attempt of the same operation, the partial attempt is final: it is kept as it was (E112; D4 §4.6, "never relabelled"). D4 §4.3's invariant ("every attempt is terminal or `ambiguous` with a decision") is then met by that superseding attempt, not by an open decision on the earlier one.

**Changed:** `assertInvariants` (`harness/deploy/recover.mjs`) no longer requires an open decision for a `reconciled_partial` attempt that a later attempt of the same operation superseded. A `reconciled_partial` attempt that is still its operation's latest needs an open decision (`rollout_partial` or `blocker`), as before. No case's assertions changed beyond that.
