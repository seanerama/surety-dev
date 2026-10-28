# 217: the project configuration gains the five prototype limit keys, which the Verifier's key list does not hold yet

Row: M73, M07, M01
Test: packages/engine/test/acceptance/M73-executable-contract.test.mjs, case "the contract holds the accepted corrections, as the Verifier's tables state them: D1's hand-written appendix overrides none" ("the project configuration keys"); packages/engine/test/acceptance/M07-project-bootstrap-and-policy.test.mjs, cases "M07 the effective policy is the revision the engine recorded" ("the effective policy is the schema defaults, whatever the file in the repository says") and "M07 a valid project policy change / is committed through the journal, recorded as a revision, and reported as effective; a second change is the next revision" ("and the schema defaults are in effect"); packages/engine/test/acceptance/M01-kernel-journey.test.mjs, case "runtime data stays outside tracked source" ("<key> is a project key", over the committed `.surety/policy.json`, which holds the whole effective policy as every policy commit does)
Filed by: Builder, branch build/rapid-prototype (slice E1 of "Rapid prototype to Alpha"), 2026-10-28

## Claim

M73's case compares the engine's project configuration keys, and M07's two cases compare a project's effective policy (`DEFAULTS`, built from the same table), with the Verifier's table, `packages/engine/test/acceptance/contract/config.json` (`CONTRACT.project`). The owner has approved five new project policy keys as editable prototype defaults (ruling R4 of 2026-10-28), now in `config/schema.ts` `PROJECT_POLICY` and stated in `api/schema.json`:

| key | default | min | max | integer | unit |
|---|---|---|---|---|---|
| `prototype_budget_tokens` | 1500000 | 10000 | 50000000 | yes | billable tokens |
| `prototype_budget_usd_estimated` | 15 | 0 | 10000 | no | usd (estimated, a threshold) |
| `prototype_runtime_seconds` | 2700 | 300 | 86400 | yes | seconds, approval to Alpha |
| `prototype_repairs_per_stage` | 2 | 0 | 10 | yes | repairs |
| `prototype_repairs_per_iteration` | 4 | 0 | 40 | yes | repairs |

Each widens when raised, as the budget keys do. Each case below fails only on the five keys; every other assertion of its file passes. The test is not wrong about what it pins; its table needs the new rows. I ask the Verifier to add them to `contract/config.json`'s `project` table with the values above (and, if wanted, a row for their refusals and widening, which the Builder's developer test `test/unit/rapid-prototype.test.mjs` covers meanwhile). Until then M73 fails exactly this one case, M07-project-bootstrap-and-policy these two and M01-kernel-journey this one, each only on the five keys.

The same change adds a table (`prototype_iterations`), two columns (`projects.mode`, `runs.iteration`), two enumerations (`ExecutionMode`, `IterationStatus`) and three events (`prototype.iteration_created`, `prototype.iteration_alpha_ready`, `candidate.alpha_withdrawn`); M73's cases that compare the contract with a real store and the committed appendix pass with them.

Observed (this branch, each file run alone with `node --test`):
- M07-project-bootstrap-and-policy: 5 tests, 3 pass, 2 fail (each diff only `+ prototype_budget_tokens: 1500000`, `+ prototype_budget_usd_estimated: 15`, `+ prototype_repairs_per_iteration: 4`, `+ prototype_repairs_per_stage: 2`, `+ prototype_runtime_seconds: 2700`).
- M01-kernel-journey: 11 tests, 10 pass, 1 fail ("prototype_budget_tokens is a project key", actual false).
- M73-executable-contract: 11 tests, 10 pass, 1 fail ("the project configuration keys": `+ 'prototype_budget_tokens'`, `+ 'prototype_budget_usd_estimated'`, `+ 'prototype_repairs_per_iteration'`, `+ 'prototype_repairs_per_stage'`, `+ 'prototype_runtime_seconds'`).

## Sources

The owner's ruling R4, 2026-10-28 (`PROPOSAL-2026-10-28.md` §7, verbatim): "R4 — Accept the proposed values as editable prototype defaults: 1.5 million billable tokens, $15 estimated spend, 45 minutes, two repairs per stage and four per iteration. These are configuration defaults, not authorization for a paid demonstration."

The owner's ruling R7, same place: "R7 — Approve explicit durable iteration identity. Attribute work and usage through stable relationships, not time windows."

The proposal's R7 consequence (§5): "One migration, M73 contract update, a MAIN backup before the switch."
