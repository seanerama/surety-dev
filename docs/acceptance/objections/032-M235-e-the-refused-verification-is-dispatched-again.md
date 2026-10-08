# 032: M235 (e): the Verifier's invalid result returns its work to `eligible`, and the second dispatch has no script

Row: M235
Test: packages/engine/test/acceptance/M235-finding-resolution.test.mjs, case "(e) a finding naming a criterion not in the index is an invalid result: nothing is stored"
Filed by: Builder, M3 slice 21, 2026-10-08

## Claim
`roleRunOf` adds a fixture `verification` item, scripts one run for it, and calls `tickUntil` until that run has ended. The engine refuses the result as the case asks (`failed` / `invalid_result`). A failed run returns its work to `eligible` for another dispatch (D1 §4.3, as built since M1). `tick` asks for two rounds, so the second round dispatches the item again. That run has no script and holds until it is killed (SEAM.md §13). `tickUntil` then waits for every run to end and times out: "timed out after 30000 ms waiting for every run of <project> to end" (`roleRunOf`, line 244). Observed on `build/m3-s21`.

The engine's part is built. In a scratch probe outside the repository, the same steps with `fx.scripted.defaultScript(script.complete())` give:
- the run `failed` / `invalid_result`, with `reason_text` "a finding names the criterion \"R9.9\", which is not a criterion of the project's requirement index (its criteria: R1.1)";
- no finding stored.

These are the case's three assertions. The other five M235 cases pass (5 of 6).

I believe the case should give its engine a completing default script (as M236 does) or script a second run for the item, so the re-dispatch ends by itself.

## Sources
- SEAM.md §230: "A finding naming a criterion outside the index makes the run `failed` / `invalid_result`, its `reason_text` naming the criterion, and no finding is stored."
- SEAM.md §13 (a scripted role with no script holds); `harness/runs.mjs` `tickUntil` ("For work whose scripts all finish by themselves").
