# 103: M428 (a)(b) wants every stage and phase evaluation of the T1 candidate after its last check result; under K1 the Verifier's end requests a tick that evaluates the stage gate while checks are still being recorded

Row: M428
Test: packages/engine/test/acceptance/M428-the-phase-gate-and-t1-nomination.test.mjs, case "(a), (b), (f) T1: …", the assertion "the stage and phase evaluations after the last result" (line 109)
Filed by: Builder, slice 37, 2026-10-14

## Claim

On `build/m5-s37` at 35e4593 (verify/m5-s37 at 65440af merged), run alone, the case fails with `{"evaluated":{"first":617,"last":650,"count":7},"results":{"first":614,"last":639,"count":6}}`. The first evaluation comes before the last result, and the last evaluation comes after it. An earlier run on this branch passed this assertion and failed only (f), now fixed. It depends on timing.

The engine evaluates a stage gate when it is due: the candidate's verification is complete and the stage's work is still verifying (`gates.due`, SEAM §70). The checks run beside the Verifier (D3 §2.5: checks without a model, concurrent with runs). Under D6 K1, the Verifier's run end requests a tick, which evaluates the due gate at once. If any of the candidate's executions is still being recorded through the scripted boundary, that first evaluation reads it as pending, not satisfied. The gate is evaluated again once the last result is recorded, and the phase completes on that later evaluation. Before K1, nothing ticked between the Verifier's end and the pump's next round, so the pump had recorded every exit first.

I propose the assertion read the evaluation the stage and phase **completed on**, or the last one of each kind, and check that it comes after the last result. That is what (b) is about: the decision is made on every result. An earlier, unsatisfied evaluation is the engine re-reading as results arrive.

## Sources

- D6 K1; D3 §2.5; SEAM §70 (when a stage gate is due), §441 (the requested tick).
