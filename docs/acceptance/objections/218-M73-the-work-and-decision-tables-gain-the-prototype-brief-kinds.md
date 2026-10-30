# 218: the work-item and decision tables gain the prototype brief's kinds, which the Verifier's tables do not hold yet

Row: M73
Test: packages/engine/test/acceptance/M73-executable-contract.test.mjs, case "the contract holds the accepted corrections, as the Verifier's tables state them: D1's hand-written appendix overrides none" (first failing assertion "the work kinds"; the case's later assertion "no other decision kind is enabled in M1" meets the same cause)
Filed by: Builder, branch build/rapid-prototype (slice E3 of "Rapid prototype to Alpha"), 2026-10-28

## Claim

M73's case compares the engine's work-item kinds with the Verifier's table `packages/engine/test/acceptance/contract/work-items.json` (`WORK.kinds`) and its enabled decision kinds with `contract/decisions.json` (`DECISIONS.kinds`). Slice E3 implements the owner's rulings R5 (a separate, bounded preparation authorization) and R3 (the brief), which need one new work kind and one new decision kind (migration 0045, `api/schema.json` regenerated, `contract check` valid):

`work-items.json`, `kinds`:

| kind | m1 (dispatched) | role | path |
|---|---|---|---|
| `brief_preparation` | true | `spec_writer` | eligible, claimed, executing, integrating, integrated, complete |

`decisions.json`, `kinds`:

| kind | subject_types | options | manifest | effect |
|---|---|---|---|---|
| `prototype_preparation_approval` | `prototype_iteration` | approve, reject | iteration, iteration_seq, iteration_status, role, provider, model, resolution, run_token_limit, estimated_usd, estimate_basis, paid, authorizes, idea_version, idea_blob, policy_revision | false (its approve registers one `brief_preparation` work item in the answer's transaction; no effect intent) |

The same migration adds the record kind `prototype_brief`, the phase-plan routing value `policy_authorized` (R1: a first plan published by the prototype policy, never recorded as a human approval) and two columns `prototype_iterations.brief_record`, `brief_json`; ten events `prototype.*` (owner `prototype/brief.ts`). M73's cases that compare the contract with a real store and with the committed appendix pass with them.

The test is not wrong about what it pins; its tables need the new rows. I ask the Verifier to add them. Until then M73 fails exactly this one case, on these two kinds.

Observed (this branch, the file run alone with `node --test`): M73-executable-contract: 11 tests, 10 pass, 1 fail ("the work kinds": `+ 'brief_preparation'`).

## Sources

The owner's ruling R5, 2026-10-28 (`PROPOSAL-2026-10-28.md` §7, verbatim): "R5 — Approve separate, bounded preparation authorization. Explain its cost before the first paid call and count it in prototype totals. Be explicit that the initial paid flow has preparation approval, brief approval and check approval."

The owner's ruling R1, same place: "Record publication as policy-authorized, never as a human approval."
