# 129a: M442 (a2), (a3) and (a4) pin M5's B.3 module and interface fields; D7 extends B.3

(Numbered 129a: slice 40's block, 125 to 129, is used. The coordinator may renumber it.)

Row: M442 (a2), (a3), (a4) (slice 38's harness, read by M6's branches)
Test: packages/engine/test/acceptance/M442-the-role-packages-state-what-the-engine-reads.test.mjs; the check in harness/real/packages.mjs, case `architect.schema.modules`
Filed by: Builder, slice 40, 2026-10-17

## Claim

The harness requires the Architect's package to state B.3's module and interface objects with exactly M5's members:

```js
want(setEq(propsAt(s, ['modules', '[]']), ['name', 'paths', 'sensitive_areas', 'tier_override', 'interfaces', 'requirements']), 'B.3 module: …');
want(setEq(propsAt(s, ['modules', '[]', 'interfaces', '[]']), ['name', 'kind', 'path', 'description']), 'B.3 interface: …');
```

D7 extends B.3 (D7 §4.1, Appendix B.3 and B.8; M501): a module gains `surface`, `targets` (with `ui_technology`, `form_factors`), `platform_permissions` and `asset_paths`; an interface gains `consumed_by`, `request`, `response` and `errors`, each a B.8 shape. The engine reads all of them at the Architect's save (M501 (a) to (c) pin the findings on each), so the package states them, as SEAM.md §454 asks of every element the engine reads ("every element the engine reads is stated"). With the package stating them, `setEq` fails on the added members only; every other assertion of (a2), (a3) and (a4) passes. Observed on `build/m6-s40` after slice 39's merge:

```
- architect.schema.modules: B.3 module: name, paths, sensitive_areas, tier_override, interfaces, requirements (E145 item 1) (got …)
- architect.schema.modules: B.3 interface: name, kind, path, description (got …)
```

The two rows cannot both hold: M501 needs the Architect told the D7 fields, M442 forbids it. The fix is the harness's: under M6, the module's members are M5's plus D7's four, the interface's M5's plus D7's four (or `has` in place of `setEq` for those two lines). The objects stay closed (the harness's `openObjects` check passes: B.8's `properties` is described as a map, never an open object).

## Sources

- D7 §4.1 and Appendix B.3, B.8 (the module map's new fields and the shape grammar).
- M6 plan §3.2 M501 (a) to (d).
- harness/SEAM.md §454 (every element the engine reads is stated).
