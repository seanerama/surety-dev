# 082: M425 (e) reads "the active plan" as the first active row, which after phase 1's completion is phase 1's plan

Row: M425
Test: packages/engine/test/acceptance/M425-plan-references-and-approvals.test.mjs, case "(e) an ADR the routed plan references deleted by a competing proposal published first: 409 plan_generation_stale, the cause naming PLAN_UNKNOWN_ADR ADR-002"
Filed by: Builder, slice 35, 2026-10-13

## Claim

Everything (e) pins passes on `build/m5-s35`: the 409 `plan_generation_stale`, the cause naming `PLAN_UNKNOWN_ADR ADR-002`, and one phase-2 plan published (B's). The last assertion fails:

    assert.equal(activePlan(fx.home, p.id).id, publishedB.id);

`harness/journey/drive.mjs` `activePlan` returns the first `phase_plans` row by `rowid` whose `active` is 1. A completed plan keeps `active` 1: it is still its phase's active generation, and its `completion_binding` names that generation. The accepted cases read it that way. M406 (`M406-a-phase-sign-off-before-a-new-protected-version`) finds phase 1's completed plan with `active === 1` and then reads its `completed_at`. M407 (i) finds phase 2's active plan after its completion. So once phase 1 completes, `activePlan` returns phase 1's plan, never B's phase-2 plan, whatever the engine does.

The test should require that B's plan is the active generation of phase 2, for example `planOfPhase(fx.home, p.id, 2).find(active).id === publishedB.id`. That is what (e) means ("one phase-2 plan published, B's"), and it does not depend on the project's other phases.

## Sources

- D6 §5.2: "the plan's **active generation** (`phase_plans.generation`, A.3; B08)": a generation is a plan's, so each phase has one.
- D6 §5.8: completion binds `{candidate, acceptance_hash, protected_version, spec_revision, generation}`, the completed generation's.
- M406 and M407 (i) as accepted read a completed plan as `active`.
