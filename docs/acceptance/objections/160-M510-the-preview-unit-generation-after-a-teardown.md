# 160: M510 (e) names the third preview's unit `g3`, but a teardown before it takes a deployment generation

Row: M510 (e)
Test: packages/engine/test/acceptance/M510-the-preview-on-a-real-unit.test.mjs, case (e), the assertion `'not torn down at the close itself'`
Filed by: Builder, slice 42 (`build/m6-s42`), 2026-10-17

## Claim

Case (e) asks for a second preview (unit `g2`), then `surety design preview --stop` (a teardown operation), then a third preview, and asserts that the third preview runs on

```js
previewUnitName(fx.home, J.env.id, 3)   // surety-<h>-<env id>-g3.service
```

The engine starts it on `surety-<h>-<env id>-g4.service`, observed:

```
not torn down at the close itself
+ actual - expected
  [
+   'surety-0c608248552c-env_01M54JT5TQD79VT3R20DCA3Z3K-g4.service'
-   'surety-0c608248552c-env_01M54JT5TQD79VT3R20DCA3Z3K-g3.service'
  ]
```

The unit's `g<n>` is D4's deployment generation, and SEAM.md §§488 and 499 say the preview's unit is named "as D4 §9.3 names every unit" (objection 135's decision). D4 gives every attempt a new generation from the environment's counter, a teardown's included (`startDeployAttempt`; J9). The capability check uses it as the fence: a capability whose generation is not the environment's current one is refused (`capabilityCheck`, field `generation`). So the `--stop` teardown takes generation 3, and the next deploy is generation 4. The preview's own `generation` (SEAM.md §499, "each preview's generation is the previous one's plus one") is a different counter: the third preview's `design.preview_deployed` says `generation: 3`, as the test asserts two lines earlier, and its `unit` names `g4`.

The case assumes the preview's generation and the unit's suffix are the same number. That holds only while no teardown comes between two previews. The two ways to make the line pass are both changes the Builder should not make:
- name preview units by the preview's counter, not D4's generation. That departs from objection 135's decision, and the adapter's inventory, which reads the generation from the unit's name (`generationOf`), would then disagree with the attempt's;
- let a preview's teardown take no generation. That removes D4's fence for one environment.

**Proposed fix (the test's):** read the third preview's unit from what the engine recorded: `d3.payload.unit` (or the attempt intent's `create_units`). Keep it checked under the guard's prefix with `assertOwnUnit` if wanted. The other unit-name assertions of (b) and (e) hold as written (no teardown comes before `g1` or `g2`).

**Evidence the rest of the row passes.** I ran a scratch copy of the file outside the repository, changed only on that line to `[d3.payload.unit]`. All seven cases passed on `build/m6-s42`: (a) to (g), the three teardowns (`stop`, `ttl`, `approved`) applied, and nothing of the prefix left. The acceptance file is unchanged.

## Sources

- D4 §9.3 (unit names from the deployment generation), §4.2 and J9 (each attempt's generation from the environment's counter; the capability's generation check).
- SEAM.md §488 (objection 135's decision), §499 ("One generation per project"; the unit "as D4 §9.3 names every unit").
- M6 plan §3.4 M510 (e).
