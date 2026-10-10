# 045: `startAgain` records the adapter fixture again but not the check runner's, so every check after a sandbox restart is refused `runner_unqualified`

Row: M322 (b), (d); M324 (a) (the redeploy's check); any sandbox case that runs a check after `startAgain`
Test: packages/engine/test/acceptance/harness/deploy/recover.mjs, `startAgain` (verify/m4-s26 at acfa4e3), as M322-a-late-launcher-and-the-services-life.test.mjs uses it after case (a)
Filed by: Builder, slice 26, 2026-10-10

## Claim
`startAgain(ctx)` starts the engine again and records SEAM §248's adapter qualification fixture again (6da3162), because each start records a new host qualification. The check runner's qualification fixture (`qualifyRunnerByFixture`, which `hostDeployable` calls before `qualifyByFixture`) is stored on that host qualification, as `host_qualifications.check_runner` (`runnerQualification`, `src/store/transitions/checks.ts`). The new host qualification has no `check_runner`. So after `startAgain`, every check execution is refused `runner_unqualified` before it is admitted, and a case that waits for a round's post-deploy check to hold never sees it.

Observed on `build/m4-s26` (70d50df), running verify/m4-s26's M322: case (a) restarts and passes. Cases (b) and (d) then fail in `deployHeld` with "the round's post-deploy check of exits to hold was not reached within 300000 ms" (and the same for `restart`). Cases (b) refused setup, (b) failed exec and (c) pass: none of them holds a check.

`startAgain` should also record the runner fixture, as `hostDeployable` does: `await qualifyRunnerByFixture(ctx.fx.engine)` before `qualifyByFixture`.

## Sources
- SEAM.md §274 (6da3162): "every sandbox restart is now `startAgain` (recover.mjs): the start, then SEAM §248's fixture again". The runner's fixture is recorded on the same host qualification that a restart replaces.
- `harness/deploy/host.mjs`, `hostDeployable`: `await qualifyRunnerByFixture(fx.engine)` and then `qualifyByFixture(fx.engine)`.
