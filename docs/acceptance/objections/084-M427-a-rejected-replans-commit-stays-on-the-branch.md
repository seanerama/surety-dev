# 084: M427's variants run in sequence on one branch, so the rejected "ADR-001 deleted" commit leaves ADR-001 out of every later replan's tree

Row: M427
Test: packages/engine/test/acceptance/M427-plan-routing-from-the-artifacts.test.mjs, case "(b) every baseline change routes to the owner whatever the declarations; (d) …"
Filed by: Builder, slice 35, 2026-10-13

## Claim

The variants are one project's replans, each rejected in turn. A replan's commit is an intent revision on the integration branch (D6 §5.6), and a rejection does not remove it: "the saves stay committed as checkpoints with no effect" (the bundle decisions' `reject` consequence, as built since slice 31).

The "ADR-001 deleted" variant's commit deletes `.surety/adrs/ADR-001.md` from the branch. The next variant, "a module's sensitivity changed", runs in a workspace at that head. `replan35` writes only the files the variant changes, so the proposed tree has no ADR-001, while its stages (`sensitiveStages`) cite ADR-001. The engine reads the proposed tree, as D6 §5.3 clause 1 says ("every ADR key exists under `.surety/adrs/` in the proposed tree"). It refuses `PLAN_UNKNOWN_ADR (ADR-001)`, and its computed diff would also show ADR-001 deleted. The test expects `plan_approval` with only the module change.

The engine can't tell this proposal from one that deletes ADR-001 on purpose. Both trees lack the file. The scripted Architect is the one that leaves it out: a real one starts from its package, which holds every approved ADR (`adrs/`). It also starts from a branch that carries the rejected deletion.

I see two ways out, and either is Sean's or the driver's to choose:
1. **(Recommended)** The test's replan writes the approved artifacts back beside its own change after a rejected variant: at least ADR-001, the module map, the architecture text and the roadmap. Or each variant runs on a fresh project.
2. The engine restores the Architect's paths to the approved blobs when a replan's proposal is rejected. That would be a new engine commit through the journal on every rejection, and no row or source asks for it.

## Sources

- D6 §5.3 clause 1: "every ADR key exists under `.surety/adrs/` in the proposed tree (`PLAN_UNKNOWN_ADR`)".
- D6 §5.4: routing "computed from the proposed artifact tree against the bundle".
- D6 §5.6: "Its commit is an `intent` revision on the integration branch".
- The decisions' preview (`sessions/decisions.ts`): `reject`: "The bundle is refused; the saves stay committed as checkpoints with no effect."
