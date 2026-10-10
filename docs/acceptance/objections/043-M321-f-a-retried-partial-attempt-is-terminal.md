# 043: assertInvariants takes a partial attempt that a later attempt retried as one still waiting on a decision

Row: M321 (f), through M321 (c)
Test: packages/engine/test/acceptance/harness/deploy/recover.mjs, `assertInvariants`, as called by M321-the-crash-matrix-on-the-scripted-target.test.mjs, case "attempt 1 partial (g1 left failed); the human's retry: attempt 2 creates g2, cleans up exactly attempt 1's unit, and the operation's frozen intent is unchanged"
Filed by: Builder, slice 26, 2026-10-10

## Claim
In M321 (c), attempt 1 is `reconciled_partial`. The human answers `rollout_partial` with `retry`, and attempt 2 succeeds. `assertInvariants` then fails: "the reconciled_partial attempt 1 … has an open decision on its operation". This is because its `TERMINAL` list is `succeeded`, `reconciled_succeeded`, `failed` and `reconciled_absent`, so a `reconciled_partial` attempt passes only while a decision on its operation is open.

`reconciled_partial` is a terminal attempt status: D1 gives it no outgoing edge. A partial attempt that the human's consumed `retry` led to a later attempt has had its decision. The engine keeps attempt 1 as it was, as E112 and D4 §4.6 require ("its attempt is kept as it was, never relabelled").

The invariant should count `reconciled_partial` as terminal when a later attempt of the same operation exists, or when its `rollout_partial` was consumed. While neither holds, the open-decision requirement stays.

## Sources
- D1 §A.5 (`docs/design/sdlc-design-D1-engine-core.md`, line 670): "ambiguous→reconciled_succeeded; ambiguous→reconciled_absent; ambiguous→reconciled_partial … New attempt permitted only after reconciled_absent or reconciled_partial." There is no edge out of `reconciled_partial`.
- D4 §4.3's invariant: "every attempt is terminal or `ambiguous` with a decision".
- D4 §4.4: after `reconciled_partial`, "only the human's answer to `rollout_partial` … does" retry, and each retry is a new attempt with its own frozen intent (E112).
