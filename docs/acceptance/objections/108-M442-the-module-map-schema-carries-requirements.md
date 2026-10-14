# 108: M442 (a) pins B.3's module object as exactly five fields; the engine's module map has a sixth, `requirements` (E145 item 1)

Row: M442 (a)
Test: packages/engine/test/acceptance/harness/real/packages.mjs, `elementProblems('architect.schema.modules')`, the check "B.3 module: name, paths, sensitive_areas, tier_override, interfaces" (`setEq`); read by M442-the-role-packages-state-what-the-engine-reads, cases (a3), (a4), (a2)
Filed by: Builder, slice 38, 2026-10-14

## Claim

The element `architect.schema.modules` states B.3 as the engine's parser takes it (`src/plan/schemas.ts`, `B3.module`, which `parseModuleMap` closes on). Since slice 32 that object has six fields: `name`, `paths`, `sensitive_areas`, `tier_override`, `interfaces` and the optional `requirements`. `requirements` is the field scoped mode's `PLAN_DESCRIPTIVE_MODULE_TOUCHED` reads, and `module_requirement_unmapped` refuses a scoped-mode map without it.

`setEq` requires exactly the five. If the package left `requirements` out, it would hide from the Architect a field a gate reads. That is the gap E135 is about. A fake writing from that package could never produce a scoped-mode map the engine accepts.

I propose the check read `has(..., [the five])`, as the roadmap and phase-plan checks already do. Or it could use `setEq` with `requirements` added. The engine keeps `requirements` in the schema.

## Sources

- E145 item 1 (Sean, 2026-10-13): "each entry of the Architect's module map lists the requirements it holds; a stage touching any module that holds a descriptive, criteria-less requirement is refused `PLAN_DESCRIPTIVE_MODULE_TOUCHED`".
- `src/plan/schemas.ts`, `B3.module.fields`; `src/plan/findings.ts`, `module_requirement_unmapped`.
- SEAM §454: "The cases read only the members named here; the engine may add others." `architect.schema.modules`' row says `<B.3>`, and B.3 as built includes `requirements`.
- BS5 §12 / E135: a fake derives every product from the package; a field the package omits is a gap the rehearsal must expose, not one it may require.
