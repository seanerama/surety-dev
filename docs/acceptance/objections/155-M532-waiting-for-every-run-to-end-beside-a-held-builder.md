# 155: M532 (a), (c) and (g) wait for every run of the project to end while a Builder the case holds is still running

Row: M532
Test: packages/engine/test/acceptance/M532-the-designer-beside-one-shot-runs.test.mjs, cases "(a) … (b) …", "(c) …", "(g) …"
Filed by: Builder, slice 41, 2026-10-17

## Claim

The file's `launched` helper waits for a held Builder's launch with `tickUntil` (`harness/runs.mjs`). `tickUntil` checks its condition, then ticks, then calls `waitForIdle`, which waits for every run of the project to end. The Builder these cases script is `roleThatHolds`: it launches at that tick, then holds at `gate` until the case releases it. It cannot end before `launched` returns, so `waitForIdle` times out after 30 s every time the launch happens at the tick. The launch only escapes this if it happened before the first check.

On `build/m6-s41` (this slice's engine), each file run alone with `node --test`, `TMPDIR=/tmp/b41`:

```
✖ (a) … Error: timed out after 30000 ms waiting for every run of proj_… to end; the item: {"held":null,"blocker":null,"status":"executing"}   (line 100, launched)
✖ (c) … Error: timed out after 30000 ms waiting for every run of proj_… to end; the item: {"held":null,"blocker":null,"status":"executing"}   (line 147, launched)
✖ (g) … Error: timed out after 30000 ms waiting for every run of proj_… to end; the item: {"held":null,"blocker":null,"status":"executing"}   (line 244, launched)
```

`"status":"executing"` shows the item was dispatched and its run is executing. The thing waited for has already happened.

Cases (a) and (b) also say a Designer turn beside the held Builder with `sayAndSettle` (lines 104 and 116). `say` uses the same `tickUntil` and has the same wait. It passes only if the turn settles before `say` first checks it.

The test should do what M419 (d) does for the same held one-shot: `tick(…, { rounds: 1 })`, then `waitFor(() => fx.scripted.launches({ work_item: item })[0])`. A turn said beside a held Builder should poll that turn's settlement and tick between polls, without waiting for the Builder to end.

**Observed with that change.** I made a scratch copy of the file outside the repository, `/tmp/b41/scratch/m532.mjs`. Its imports point at the repository's harness. It replaces only `launched` (tick, then wait for the launch) and the two `sayAndSettle` calls beside a held Builder (poll the turn, tick between polls). Run on this slice's engine, it gives **M532 7/7**. Every assertion of (a), (b), (c) and (g) passes: both role domains at `role_memory_max`, the rebased save, the linear history, and M419's holds. The acceptance file itself is unchanged.

## Sources

- `harness/runs.mjs`: `tickUntil` ("Tick until `done()` returns something, waiting after each tick for the runs it started to end. For work whose scripts all finish by themselves."), `waitForIdle`.
- `harness/gitruns.mjs`: `roleThatHolds` (`step.hold('gate')`).
- M419 (d), `M419-one-session-per-project.test.mjs`: `tick(fx.engine, p.id, { rounds: 1 })`, then `waitFor(() => fx.scripted.launches({ work_item: item })[0], …)`.
- SEAM.md §492: what (a) to (c) pin, which the scratch run shows the engine does.

## Decision

Upheld by the driver under the owner's delegation, 2026-10-17. **The test is changed** (Verifier, `verify/m6-s41b` from `main` `364367b`).

In M532, `launched` now takes M419 (d)'s form: `tick(…, { rounds: 1 })`, then `waitFor(() => fx.scripted.launches({ work_item: item })[0], …)`, its error naming the item's hold as before. It is used in (a), (b), (c) and (g). The two Designer turns said beside a held Builder in (a) and (b) now go through `sayBeside`. It posts the turn, then ticks once between polls of that turn's settlement, and never waits for the held Builder to end. It asserts what `sayAndSettle` asserts: the turn settled and the session `open_idle`. Nothing else in M532 changed; (d), (e) and (f) are as they were. SEAM.md §531 records the waiting form.

**Run** against the Builder's engine (a detached scratch worktree of `build/m6-s41` at `8ad9030`, `npm install`, `npm run build`, `TMPDIR=/tmp/v41b`, the file alone with `node --test`, four runs): (c), (d) ×2, (e) and (g) passed 4/4. (f) passed 3/4; the failure was "the design approved: not reached within 20 ticks". **(a)/(b) failed 4/4**, at (a)'s turn beside the held Builder: `POST …/turns` 409 `budget_exhausted`, "has passed budget_day_unknown_tokens". At that refusal, a diagnostic copy in the scratch tree dumped the receipts with no ledger row. There were two: phase 1's `check_authoring` (verifier, run `validating`) and the held `fix` Builder. Each reserves its run budget of 1,500,000, and the sum passes 2,000,000. This is objection 156's case: a Designer turn beside two one-shots. The scratch copy's 200 ms sleep after each tick let the authoring run be charged first, which is why it passed. With that diagnostic copy also waiting until nothing was in flight before adding the held Builder, (a)/(b) passed 2/2, both `sayBeside` turns included. Under 156's decision (option (a)), the turn is held until the reservations clear and is then dispatched, so (a)/(b) should pass once the Builder lands it. On `main`, which has no Designer session yet, the file fails as before.
