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
