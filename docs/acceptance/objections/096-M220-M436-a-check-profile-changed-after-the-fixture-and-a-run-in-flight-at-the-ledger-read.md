# 096: M220 (a) changes `check_memory_max` after the runner's qualification, which the driver's ruling 3 holds `runner_unqualified`; M436's project-lane (e) reads the ledger while phase 2's `check_authoring` run is still in flight

Rows: M220, M436
Tests:
- packages/engine/test/acceptance/M220-scheduling-within-the-envelope.test.mjs, case "(a) max_concurrent_domains and the two host reserves: …", its `host_reserve_memory` round
- packages/engine/test/acceptance/M436-the-phase-profile-on-the-project-lane.test.mjs, case "(e) every launched one-shot metered; every check result an engine execution by a self-tested runner"
Filed by: Builder, slice 37, 2026-10-14

## Claim

Each file was run alone on `build/m5-s37` (a0a232e): M220 1/2, M436 project lane 1/2.

**M220 (a).** The `host_reserve_memory` round has these steps:
1. Restart the engine.
2. Call `qualifyRunnerByFixture(fx.engine)`. The fixture qualifies the default check profile and every registered project's effective `check_memory_max` at that moment.
3. Only then call `changePolicy(fx.engine, project.id, { check_memory_max: memoryLimit })`.

The project's check profile is then one the runner's qualification does not cover. The driver's ruling 3 (slice 37) says such a change holds `runner_unqualified` until the next start, and what_to_do names the restart. So the queued check is held `runner_unqualified`, not `resource_envelope`: "`[queued, runner_unqualified, undefined]`, expected `[queued, resource_envelope, host_reserve_memory]`". The envelope is never reached.

I propose the round change the policy before the fixture. Or it can pass the profile to the fixture: `POST /v1/harness/fixtures/runner-qualification` takes `check_memory_max`, though `qualifyRunnerByFixture` sends only `runner_class` today. Nothing else changes.

**M436, project lane, (e).** The `before` hook ends at `nextPhasePublished(…, 2)`. Under K1 the publication makes phase 2's `check_authoring` work eligible, which requests a tick. That tick dispatches the work at once, so when the case reads the ledger the run has `started_at` and no `ledger_rows` row. A ledger row is charged at the run's terminal observation (`store/transitions/ledger.ts` `chargeInvocation`, from the run's end), never at launch. The failure: "a ledger row for every launched one-shot (E10)": `[[run_…QA, 'check_authoring']]`, expected `[]`. The run is in flight, not unmetered.

I propose the case count only ended runs (`r.state === 'ended'`), or pause the project once phase 2 is published. This is the same K1 hazard as objections 094 and 095.

## Sources

- The driver's ruling 3 (slice 37): the start self-test qualifies the default and every registered project's effective `check_memory_max`; a later change holds `runner_unqualified`.
- `store/transitions/checks.ts` `runnerProfileHold`; `testing/fixtures.ts` `parseRunnerQualification` (`check_memory_max`).
- D6 K1; SEAM §430 (`work_eligible`); D1 §13.1 (one charge per invocation, at its terminal observation).
