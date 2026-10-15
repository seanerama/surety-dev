# 104: M401's T1 variant queues one scripted deploy answer, and under K1/K2 the Alpha policy makes two deployments

Row: M401 (m)
Test: packages/engine/test/acceptance/M401-the-t1-variant-on-the-scripted-backend.test.mjs, its `before` hook (`alphaReady(fx, ctx)`, then `alphaDeployed`); harness/journey/drive.mjs `alphaReady` (`answers = [{ result: 'issued', apply: true }]`)
Filed by: Builder, slice 37, 2026-10-14 (the driver's ruling 3 on M401)

## Claim

After objection 101's fix, the hook fails: "a candidate to be alpha_deployed: not reached within 80 ticks". Run on `build/m5-s37` at eb0ad74, with the store kept, this is what happens:

1. **Phase 1 completes before phase 2's candidate exists**, so `alpha_deploy: on_phase_complete` requests the deployment of candidate 1 (`dreq_…FHQ`, by policy). It consumes the one scripted answer and is applied.
2. **While that deployment is being verified, phase 2's candidate supersedes candidate 1.** D3 cancels candidate 1's queued checks, and its `alpha_complete` is refused: CANDIDATE_SUPERSEDED, CHECK_NOT_PASSED, DEPLOY_VERIFICATION_UNKNOWN. D4 §4.7 and §5.5 name this as a way out with a blocker. The driver kept the engine as D4 has it (ruling 1 withdrawn).
3. **The policy then requests the newest candidate** (`dreq_…XX2`). Its attempt finds no answer queued on the scripted adapter (`testing/deploy-adapter.ts`: "no answer queued" → `not_issued`). The operation ends `failed` and its work `cancelled`, as D4 has it for an effect not issued.

Before K1/K2 the phases ran in series and one answer was enough.

The driver's ruling: `alphaReady` queues an answer for each deployment the journey will make (here two: one per completed phase under `on_phase_complete`). The journey then expects the deploy of the **newest** candidate to reach `alpha_deployed` through the policy's request.

## Sources

- D4 §4.7 (a candidate superseded meanwhile, whose queued checks D3 cancels), §5.5 (alpha_complete refuses a superseded candidate); D6 §6.8 (`on_phase_complete`); D6 K1, K2; SEAM §247 (the scripted deployment adapter).
