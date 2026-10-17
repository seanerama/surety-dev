# 146: M442 (a2), (a3) and (a4) pin M5's B.3 module and interface fields; D7 extends B.3

(Filed as 129a, slice 40's block 125 to 129 being used; renumbered 146 by the Verifier at the coordinator's instruction, 2026-10-17.)

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

## Verifier's answer

Verifier, `verify/m6-s40b` from `main` `a33c06d`, 2026-10-17. **Upheld; the harness is changed. Recorded as BS6 §9.3's straddle of M5's packages (M442).**

The two rows conflicted. D7 G1 extends B.3: modules gain `surface`, `targets`, `platform_permissions` and `asset_paths`, and interfaces gain `consumed_by`, `request`, `response` and `errors` (D7 §4.1, the G table, B.8, B.17). M501 makes the engine read them at the Architect's save, and SEAM §454 requires the package to state every element the engine reads. M442's `setEq` against M5's members alone forbade that. BS6 §9.3 names M442 among the accepted rows D7's corrections reach (under G9, and through G2's reasons). So this is the Verifier's straddle change, and the former case is kept.

**The change** (`harness/real/packages.mjs`, case `architect.schema.modules`):
- The module's members must be **exactly** M5's six (`B3_MODULE_M5`: `name`, `paths`, `sensitive_areas`, `tier_override`, `interfaces`, `requirements`; E145 item 1, still each stated) **and** D7's four (`B3_MODULE_D7`). The interface's members must be exactly M5's four and D7's four. It is still `setEq`, not `has`: a member beyond M5 and D7 still fails.
- The check is tighter than before, not looser. It now also pins D7's sub-shapes, which the package must state because the engine reads them: `surface` `ui | api | cli | library | none` (D7 §1); `targets[]` `{target, ui_technology, form_factors}`, with D7 §4.1's six targets and eight UI technologies as enums; `platform_permissions[]` `{target, permission, why}`; `asset_paths[]` `{slot, variant, target, path}` (B.17); `errors[]` `{code, when}`.
- Unchanged: the top level `{version, modules, mapping_from_spec}`, the interface `kind` enum, the mapping, and "every object closed" (B.8's `properties` is described as a map, never an open object, as the objection says).

**Run** against the Builder's engine (a scratch worktree of `231b6d1`, `TMPDIR=/tmp/v40b`, each file alone): **M442-the-role-packages-state-what-the-engine-reads 10/10**; **M442-the-rehearsal-plays-from-the-package 42/42**, **M442-the-rehearsal-with-the-packages-whole 3/3** (both import the changed module). On `main` `a33c06d` (the M5 engine, without D7's members) the changed role-packages file is 7/10, failing (a2), (a3) and (a4) only at the D7 lines, as a straddle written before its engine should. As a check that the new lines are read: with one expectation spoiled in a scratch copy (`errors[]` given a third member), the file failed 3 cases ((a2), (a3), (a4)) at that line, and the copy was then restored. Recorded in COVERAGE (slice 40's section, "the straddle of M442") and SEAM §521.

## Sources

- D7 §4.1, the G table (G1), B.8, B.17; M6 plan §3.2 M501.
- BS6 §9.3 (M442 among the accepted rows D7's corrections reach).
- SEAM §454 (every element the engine reads is stated); E145 item 1.
