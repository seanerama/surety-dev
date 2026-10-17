# 190: M518's observed design puts R1 to R3 on the sum page, which objection 150's ruling no longer makes UI requirements, so the at_alpha check refuses `DESIGN_UNKNOWN_REQUIREMENT`

Row: M518 (b) to (g) (slice 45)
Test: packages/engine/test/acceptance/M518-retrofit-the-observed-design.test.mjs, case "(d), (e) under at_alpha shown and not blocking; (b) the observed products; …"; harness/design/retrofit45.mjs, `observedDesign` (screen S1's `requirements`)
Filed by: Builder, slice 45, 2026-10-17

## Claim

The driver decided objection 150 (E158 item 8): "in the conformance stage only requirements marked `**Surface:** ui` are UI requirements". Slice 45 builds that ruling: a conformance stage adds no UI requirement of the inventory by carrying a `ui` module; only the mark does (`src/design/inventory.ts`, `deriveInventory`).

Shelf marks R5 and R6 only. Its inventory's `ui_requirements` are therefore R5 and R6. But `observedDesign` still writes, for S1:

```js
// The conformance stage carries every module, the web module among
// them, so each requirement it implements is a UI requirement of the
// inventory (D7 §4.2; objection 150): …
requirements: ['R1', 'R2', 'R3', 'R5'],
```

D7 §5.6 clause 2: "every requirement key is a UI requirement of the inventory for that screen's target (`DESIGN_UNKNOWN_REQUIREMENT`)". So the at_alpha save is refused, observed on `build/m6-s45`:

```
(d), (e) not blocking under at_alpha ({"id":"dchk_…","outcome":"refused","reasons":[
  {"code":"DESIGN_UNKNOWN_REQUIREMENT","subjects":{"screen":"S1","target":"web","requirement":"R1"}},
  {"code":"DESIGN_UNKNOWN_REQUIREMENT","subjects":{"screen":"S1","target":"web","requirement":"R2"}},
  {"code":"DESIGN_UNKNOWN_REQUIREMENT","subjects":{"screen":"S1","target":"web","requirement":"R3"}}],
 "notices":[{"code":"DESIGN_INTERFACE_SHAPE_UNKNOWN",…"S1"…},{"code":"DESIGN_INTERFACE_SHAPE_UNKNOWN",…"S2"…},{"code":"DESIGN_CONVENTION_UNKNOWN",…"S2","convention":"browser_back"}]})
```

The notices are as the case expects; only the three refusals stand in the way. SEAM.md §528's last bullet ("A conformance stage over the `web` module makes every requirement it implements a UI requirement… Shelf's observed design maps R1 to R3 to the sum page for that reason") predates the ruling.

**Asked:** S1's `requirements` become `['R5']` (the flow's `requirements` may stay, the check does not read them against the inventory), and §528's last bullet says the ruling.

**Run** (a scratch copy of the acceptance tree under `/tmp/b45/scr`, the Builder's `dist` linked in, only that line of `retrofit45.mjs` changed, `TMPDIR=/tmp/b45`): case 2 of M518 passes whole, (b) to (g) included (the observed design approved with its origin shown, the logo `observed`/`proposed` then effective, the placeholders, phase 1 conformed and complete with R5.2's check failing, no unsatisfied stage or phase evaluation naming R5.2). The tree in the repository is unchanged.

## Sources

- E158 item 8 (objection 150's decision, second half).
- D7 §4.2 ("UI requirements: … that a UI stage implements, or whose subsection carries the mark"); §5.6 clause 2.
- SEAM.md §528, last bullet.
