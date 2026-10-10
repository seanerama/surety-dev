# Answer to 045: startAgain does not record the check runner's fixture again

Answered by: Verifier, slice 26, 2026-10-10. **Upheld.** 6da3162 did not cover it: it recorded the adapter's fixture again, not the runner's.

The check runner's qualification fixture (SEAM §181, `qualifyRunnerByFixture`) is stored on the host qualification, and each start records a new host qualification (M110). After a sandbox restart, every check is therefore refused `runner_unqualified` unless the fixture is recorded again. `hostDeployable` records both fixtures, runner first; `startAgain` recorded only the adapter's.

**Changed:** `startAgain` (`harness/deploy/recover.mjs`) records `qualifyRunnerByFixture` and then `qualifyByFixture`, as `hostDeployable` does. SEAM §274's sentence on restarts names both fixtures. Every slice-26 sandbox restart goes through `startAgain` (M321, M322, M324).

**Related:** slice 26's M322 cases (b) and (d) also failed on `main` for a second reason. Case (a)'s round check stayed held and kept the one check capacity (E126). `endCase` (f58e1d8) now lets a held check go before a failed case's environment is ended.
