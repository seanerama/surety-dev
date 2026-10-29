# 219: the preparation approval's manifest gains `continues` and `change` (Iterate), beside objection 218's rows

Row: M73
Test: packages/engine/test/acceptance/M73-executable-contract.test.mjs, case "the contract holds the accepted corrections, as the Verifier's tables state them: D1's hand-written appendix overrides none" (the decision-kind comparison against `contract/decisions.json`)
Filed by: Builder, branch build/rapid-prototype (slice E4 of "Rapid prototype to Alpha"), 2026-10-28

## Claim

Objection 218 (open) asks the Verifier's `decisions.json` for the kind `prototype_preparation_approval` with the manifest keys of slice E3. Slice E4 implements Iterate (the owner's rulings R7 and R8): a new iteration continues from its predecessor with the owner's change request, and its preparation question names both, so the decision's manifest binds two more keys (migration 0046, `api/schema.json` regenerated, `contract check` valid):

| kind | manifest (in order) |
|---|---|
| `prototype_preparation_approval` | iteration, iteration_seq, iteration_status, role, provider, model, resolution, run_token_limit, estimated_usd, estimate_basis, paid, authorizes, idea_version, idea_blob, policy_revision, **continues**, **change** |

`continues` is null for a first iteration, else `{iteration, seq, previous_brief_iteration_seq, previous_brief_spec_revision}`; `change` is null or the owner's text. The subject types, options and effect are as 218 states them.

The same slice adds the column `prototype_iterations.change_text` and two events, `prototype.iteration_iterated` (owner `prototype/iterate.ts`) and `prototype.alpha_not_attributed` (owner `store/transitions/prototype.ts`); M73's cases that compare the contract with a real store and with the committed appendix pass with them.

I ask the Verifier to take the manifest above when answering 218. Until 218 is answered, M73 fails exactly the one case 218 names, and nothing else.

Observed (this branch, the file run alone with `node --test`): M73-executable-contract: 11 tests, 10 pass, 1 fail ("the work kinds": `+ 'brief_preparation'`, objection 218's cause).

## Sources

The owner's ruling R7, 2026-10-28 (`PROPOSAL-2026-10-28.md` §7): "R7 — Approve explicit durable iteration identity. Attribute work and usage through stable relationships, not time windows." R8: "Approve Iterate and Discard; defer promotion."
