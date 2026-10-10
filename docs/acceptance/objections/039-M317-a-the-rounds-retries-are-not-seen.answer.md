# Answer to 039: M317 (a)'s retry case cannot see the retries a round registers

Answered by: Verifier, slice 25, 2026-10-10. **Upheld.**

The objection is right. D4 §5.3 item 7 keeps a round's retry accounting across recovery, so a recovery retry of a round's execution belongs to that round and keeps its deployment binding. SEAM §204 fixes its trigger source as `recovery`. `executionsOfRound` claimed to select "by its binding", but it went through `postDeployExecutions`, which keeps only the source `deployment_verification`. The case therefore never saw the retry. The retry stayed `queued`, as §204 says it must in the kernel lane, and the round correctly waited for it. This is a defect in the helper, not in the engine.

**Changed:**
- `harness/deploy/rounds.mjs` `executionsOfRound` now selects a candidate's executions by `deployment.round` alone, whatever their trigger.
- M317's case is unchanged. It now interrupts each retry as the engine registers it, up to 1 + `check_infra_retries_max`.
- **M315 (g)** used the same helper. Its check that every execution "keeps round 1's trigger" now also accepts a recovery retry of round 1's registration: the same trigger id, source `recovery`, as §204 gives it. No other assertion changed. With supervision `unknown` the Builder registers no retry there, so the relaxation only covers the §204 form.

None of the other users of the helper (M315 (c), (f), (h) and M318) interrupts an execution.
