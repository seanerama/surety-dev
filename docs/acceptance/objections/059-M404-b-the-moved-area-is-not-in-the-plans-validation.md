# 059: M404 (b)'s "moved" map puts secrets_credentials on lib, and its plan does not validate it, so the plan check refuses the close

Row: M404
Test: packages/engine/test/acceptance/M404-the-architects-products-registered.test.mjs, case "(b) a module map dropping a TPL §6 sensitive area from every module is refused as architecture naming the area; a map moving it between modules is accepted"
Filed by: Builder, slice 31a, 2026-10-12

## Claim

The second session of the case closes with `BAD_ARCHITECTURE.area_moved`: `modules.json` moves `secrets_credentials` from `service` to `lib`. Every other file is the reference's, including `phase-1.json` from `STAGES[1]`, where stage 1 (`modules: ['lib']`) has `validation.sensitive_areas: []`. The case requires the close to be accepted and the bundle published (`assert.ok(moved.published)`).

D6 §5.3 clause 4 refuses that plan. Every sensitive area of the phase's modules must be in the `validation.sensitive_areas` of a stage touching that module (`PLAN_AREA_UNVALIDATED`). With the area on `lib`, stage 1 touches `lib` and does not validate it. The engine refuses the close as §3.4 says ("raised only after the mechanical check passed"):

```
422 plan_refused: PLAN_AREA_UNVALIDATED (stage 1:secrets_credentials)
```

What I believe the case should require: the "moved" bundle's plan validates the moved area where it now sits. For example, give stage 1 `validation.sensitive_areas: ['secrets_credentials']` through `architectSession`'s `plan` option, plus the kinds a `secrets_credentials` floor needs if the Verifier pins any. The assertions about where the area sits after publication can stay. The case's first half, the dropped area refused as `architecture_area_dropped`, passes as written.

## Sources

- D6 §5.3 clause 4: "every sensitive area of those requirements and of the phase's modules is in the `validation.sensitive_areas` of a stage touching that module (`PLAN_AREA_UNVALIDATED`)".
- D6 §3.4: "`plan_approval` for phase 1, raised only after the mechanical check passed (a failing check returns to the session as the engine's entry, and close is refused until it passes or the owner closes with `--refuse`)".
- SEAM.md §344: "An Architect close whose products do not pass §346's parse or §5.3's check is refused 422 `plan_refused`".
