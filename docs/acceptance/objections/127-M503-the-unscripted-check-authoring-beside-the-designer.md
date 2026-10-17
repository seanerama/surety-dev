# 127: M503 (a), (b) and (d) leave phase 1's check authoring unscripted; its launch holds forever beside the Designer

Row: M503
Test: packages/engine/test/acceptance/M503-the-designers-paths-and-everyone-elses.test.mjs, cases (a), (b) and (d)
Filed by: Builder, slice 40, 2026-10-17

## Claim

Each of the three cases publishes Pantry's plan (`toPublished`) and opens a Designer session. Publication registers phase 1's `check_authoring` (D6 §4.1), and under G12 (D7 §3.2: the Designer runs beside the project's one-shot runs) the engine dispatches it beside the session. The cases set no script for it and no default script, so on the scripted backend its launch is held forever (objection 078's pattern; SEAM.md §2449, §2504). The harness's wait for every run of the project to end then times out after 30 s:

```
not ok 1 - (a) ...  error: 'timed out after 30000 ms waiting for every run of proj_… to end'
not ok 2 - (b) ...  error: 'timed out after 30000 ms waiting for every run of proj_… to end'
not ok 3 - (d) ...  error: 'timed out after 30000 ms waiting for every run of proj_… to end'
```

Every assertion of the cases' own subject (the save refused whole, `diff_violation` / `DESIGN_INVENTORY_MODIFIED`, naming the path, nothing committed, the session idle, the refusal the next turn's engine entry) passes before the wait; case (c), which scripts its one-shots, passes.

Without G12 the cases would fail differently: the session could not open beside the dispatched one-shot (`session_busy`), or would race it. Either way the fix is the test's: a default script that ends at once (`fx.scripted.defaultScript(script.crash())`, or `designScripts(fx)`) before the Designer opens, as SEAM.md §2449 did for M239 and M342. The engine's behaviour (the one-shot dispatched beside the Designer) is G12's.

## Sources

- D7 §3.2 (G12): the Designer session runs beside the project's one-shot runs.
- D6 §4.1: phase authoring registered at publication.
- harness/SEAM.md §2449 and §2504: the same pattern, fixed in the cases by a default script.

## Verifier's answer

Verifier, `verify/m6-s40b` from `main` `a33c06d`, 2026-10-17. **Upheld; the test is changed.**

The claim is right. Under `design: both` (`DESIGN_POLICY`), publication registers phase 1's `check_authoring` (D6 §4.1). G12 (D7 §3.1; SEAM §492) dispatches it beside the Designer session, and the cases scripted no launch of it, so it followed the scripted program's `HOLD_FOREVER` (`harness/scripted/child.mjs`, `chooseScript`). One correction to the account: the cases do not reach their own assertions before the wait. On `build/m6-s40` at `231b6d1`, run unchanged, (a), (b) and (d) each time out in the **first** `sayAndSettle` of `refusedDesignerSave` (line 59), before the save. M503 was 3/6 (`timed out after 30000 ms waiting for every run of proj_… to end`).

**The change.** The three cases now publish through `publishedPantry(fx)`. It sets `fx.scripted.defaultScript(script.crash())` **before** `toPublished`, so no launch of the project is ever unscripted, whenever the engine dispatches it. The authoring launch, and any repair of it, end at once without a candidate, so nothing reaches `.surety/checks/` or a check domain. This is SEAM §454's fix for M239 and M342. Nothing the cases assert changed: the save refused whole with `diff_violation` or `DESIGN_INVENTORY_MODIFIED`, naming the path, nothing committed, the session `open_idle`, and the refusal as the next turn's engine entry. The authoring run beside the Designer is G12's, and M532 pins it.

**Run** against the Builder's engine (a detached scratch worktree of `231b6d1`, `npm install`, `npm run build`, `TMPDIR=/tmp/v40b`, the file alone with `node --test`): **M503 6/6** (it was 3/6 unchanged). SEAM §530.

## Sources

- D6 §4.1 (phase authoring registered at publication); D7 §3.1, G12; SEAM §492.
- `harness/scripted/child.mjs`: "With no script at all the program holds until it is killed".
- SEAM §454 (M239, M342: the same pattern, the same fix).
