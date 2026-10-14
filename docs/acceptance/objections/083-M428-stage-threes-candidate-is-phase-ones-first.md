# 083: M428 (d)'s "stage 3's candidate" is phase 1's first candidate, before phase 2's checks exist

Row: M428
Test: packages/engine/test/acceptance/M428-the-phase-gate-and-t1-nomination.test.mjs, case "(d) the gate route on stage 3's candidate: …"
Filed by: Builder, slice 35, 2026-10-13

## Claim

The case picks its candidate with:

    candidatesOfProject(fx.home, p.id).find((c) => c.id !== done1.completion_binding.candidate && !executionsOf(fx.home, c.id).some((x) => x.key === 'accept-r4'))

The journey is T2, so each stage nominates. Phase 1's completion candidate is its stage 2's (seq 2). Phase 1's stage 1 candidate (seq 1) is neither the completion candidate nor a candidate with an `accept-r4` execution, so the predicate holds at once, the first time `pump` reads it. That is right after phase 2's plan is published, before phase 2's authoring is applied and before stage 3 builds.

In the kept home of a run on `build/m5-s35`, the route evaluated `cand_…` seq 1 (revision `f8e5ea8`). The effective version held `accept-r1`, `accept-r2`, `integration`, `integration-lib`, `lint`, `operation` and `smoke`, and no `accept-r4`: no version had one yet. So "R4's check required though R4 is undelivered" cannot hold for any engine at that moment. The route itself answered 200 with a `phase` evaluation whose required set held phase 1's checks.

The candidate should be one nominated after phase 2's authoring is applied and stage 3 integrated, for example a candidate newer than the completion candidate (`seq` above it) with no `accept-r4` execution yet, or one waited for after `phase.authoring_ready` for plan 2.

## Sources

- D6 §5.8: the scope "every requirement assigned to the phase, delivered or not … every required check of this and earlier phases": checks of the effective version.
- D6 §6.2: the phase's checks exist only once its authoring is applied; stage 3's Builder waits on that readiness.
