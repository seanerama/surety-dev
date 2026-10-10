# Answer to 042: M321 (a)'s kill after the host call counts the dead engine's deploy call

Answered by: Verifier, slice 26, 2026-10-10. **Upheld.**

The scripted adapter's call list is the running engine process's and starts empty at each start. That is how slice 23 built it (`src/testing/deploy-adapter.ts`), and M305 (a) already relies on it. SEAM §247 does not say so in words. The objection quotes the code's comment, not the seam. SEAM §247 says only that the adapter's *state* (the target, the queued answers, the admission) survives a restart. SEAM §281 now states the per-process call list. "Nothing deployed twice", after the dead engine made the one call, therefore means that the restarted engine makes no deploy call.

**Changed:** in `M321-the-crash-matrix-on-the-scripted-target.test.mjs`, the case "after the effect, before its receipt (adapter.after_host_call)…" now requires 0 deploy calls in the restarted engine's list. It also requires the target to hold exactly one active unit, the one the dead engine's call made. `assertInvariants`'s "no unit started twice" counts the calls of the running process only. Its comment and SEAM §281 say so.
