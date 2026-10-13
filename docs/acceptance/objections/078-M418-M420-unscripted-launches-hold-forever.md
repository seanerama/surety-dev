# 078: M418 (c) and M420 (c) wait on a launch that has no script, so its role holds forever

Rows: M418 (c), M420 (c)
Tests:
- packages/engine/test/acceptance/M418-idle-timeout-budget-exhaustion-and-resume.test.mjs:114, `sayAndSettle(fx, p.id, next.id, 'Carry on.')` on the resumed run `next`.
- packages/engine/test/acceptance/M420-session-backends-and-models.test.mjs:49-52: `addWork(fx.engine, p.id, 'fix')`, then `waitForRun(fx.home, item, { state: 'ended' })`.

Filed by: Builder, slice 33, 2026-10-13

## What happens

`harness/scripted/child.mjs` picks a launch's script with `chooseScript` (SEAM.md §§343, 350), in this order:
1. `scripts/run-<run>.json`;
2. the work item's script;
3. `scripts/kind-<kind>.json`;
4. `scripts/default.json`;
5. otherwise `HOLD_FOREVER`, with source `unscripted`.

Neither case gives its launch any of the first four.

**M418 (c).** The case scripts the first session's run, `scriptTurns(fx, run.id, [writes, 'Resumed.'])`. A resume creates a new run (SEAM.md §394, D1 §15.3), whose id is known only from the 201. The test never scripts it. The second element of the old run's script belongs to the old run, which the resume never continues; that is the row's (e). So the resumed run's first turn holds, its run never leaves `turn_running`, and `say`'s `tickUntil` times out waiting for every run to end. Error on `build/m5-s33`:

```
error: 'timed out after 30000 ms waiting for every run of proj_… to end'
  at tickUntil (harness/runs.mjs:179) at say (harness/sessions.mjs:87) at sayAndSettle (harness/sessions.mjs:106)
  at M418-idle-timeout-budget-exhaustion-and-resume.test.mjs:114
```

Everything (c) asserts before line 114 passed: the 201, `parent_run`, the role and kind, `current_base` at the last checkpoint, and the transcript continued.

**M420 (c).** The fix item is added with no script. `sessionProject` (`createWithIdea`) sets no default script, so the Builder's launch is `unscripted` and holds. The run never ends. The assertion this case exists for comes after `waitForRun`, and it holds before it: on a scratch copy that logs the run row, the Builder's run is `model_requested: "sonnet"`.

```
error: 'timed out after 30000 ms waiting for run 1 of wi_… to be ended'
scratch copy: BUILDER {… "role":"builder","kind":"one_shot","state":"executing", … "model_requested":"sonnet" …}
              LAUNCHES [["run_…","session","run"],["run_…","fix","unscripted"]]
```

## What I believe is right

- **M418 (c):** script the resumed run before its turn, e.g. `scriptTurns(fx, next.id, [turnThatSays('Resumed.')])` before line 114, and drop the old run's second script element. Then "(e) the old run gained no turn" still reads the old run.
- **M420 (c):** script the fix item before the tick (`fx.scripted.script(item, [script.complete()])` or a default script). Or read `model_requested` on the run row once it is claimed, without waiting for its end. The ledger row the case reads is written only at the run's end, so the first form is needed if the ledger is what is pinned.

No engine change is needed for either case. The other cases of both files pass on `build/m5-s33`: M418 8 of 9, M420 2 of 3.
