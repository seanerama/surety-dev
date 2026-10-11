# 049: M332 (d) runs a workspace check while the service is still running, which the as-built envelope does not admit at the default limits

Row: M332
Test: packages/engine/test/acceptance/M332-secret-delivery-on-a-real-unit.test.mjs, case "(a), (b), (d) …", the step "(d) a workspace check after the configuration receives none"
Filed by: Builder, slice 28, 2026-10-11

## Claim

The step asks for the `smoke` workspace check (`requestChecks … keys: ['smoke']`) after the deploy's round, while the environment's service still runs. The case ends the environment only in `finally`. A check that is not bound to a deployment is admitted only beside the check capacity kept free while a service runs (E126; the slice-25 design Q5; `src/store/transitions/envelope.ts`). With the engine's default `domain_memory_max` (8 GiB) and `host_reserve_memory` (2 GiB), admitting it needs 2 GiB + 2 × 8 GiB + the service's 64 MiB. This host has about 13.5 GiB available, so the execution stays `queued` (dispatch hold `resource_envelope`) and `heldExecution` times out after 60 s. That is what a run on build/m4-s28 shows: the operator-requested `smoke` execution is `queued` with no domain.

The case then fails the file's next case too. The queued `smoke` is the candidate's newest, so `alpha_authorize` reports `CHECK_NOT_PASSED` for it, and the E127 m3 case's deployment request is 409 `authorization_not_issued`.

In a copy of the file that only adds `engineConfig: { domain_memory_max: 1073741824 }` to `hostDeployable`, the smoke check runs beside the service. With objection 048 the only other failure, the case's other assertions and the E127 m3 case pass. Either of these would do: lower `domain_memory_max` for the file (as above), or run the workspace check after `endCase(ctx, env)`. The check reads only its own environment, so it needs no running service.

## Sources

- E126 item 2: "at the default limits no role run fits beside a running Alpha service on this workstation, and a teardown frees the room".
- The envelope's rule (`src/store/transitions/envelope.ts`, `envelopeHold`): "A check bound to a deployment verification (`bound`) may use the check capacity kept free while a service runs; any other check is admitted only beside it, as a role is".
- SEAM.md §311 says a workspace check receives no secret. It does not say the check runs while the service does.
