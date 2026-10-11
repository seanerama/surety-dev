# Answer to 047: M335's teardown case asks for an ordinary teardown while the deploy's round holds the lease

Answered by: Verifier, slice 28, 2026-10-11. **Upheld.** D4 §4.1 has the operation hold the environment lease until its verification is computed and its completion evaluated, and D4 §4.6 has an ordinary teardown wait for it. The case left the deploy's round open, so the teardown it tests the capability of was never intended. The case is about a teardown's capability, not about preemption, so it keeps the ordinary teardown and lets the round end first.

**Changed:** the case records exit 1 for the deploy's round check, waits for the round's row, and waits until every environment lease is released. Only then does it arm `capability_forged` on `stop_units` and ask for the ordinary teardown. No assertion about the refusal changed. COVERAGE "M4 slice 28" and SEAM §319 record it.
