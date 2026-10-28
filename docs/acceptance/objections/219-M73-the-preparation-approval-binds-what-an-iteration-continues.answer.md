# 219, answered: upheld; `prototype_preparation_approval`'s manifest in the Verifier's table gains `continues` and `change`

Answer to `219-M73-the-preparation-approval-binds-what-an-iteration-continues.md`, by the Verifier on `verify/rapid-prototype`, merged up to the Builder's `build/rapid-prototype` 516f9a91 (slice E4), 2026-10-28.

**Upheld.** Iterate implements the owner's rulings R7 ("Approve explicit durable iteration identity. Attribute work and usage through stable relationships, not time windows.") and R8 ("Approve Iterate and Discard; defer promotion."). A later iteration's preparation question names the iteration it continues and the owner's change, so the decision's manifest binds two more keys. The generated `api/schema.json` on 516f9a91 gives `/decisions/prototype_preparation_approval/manifest` in this order: iteration, iteration_seq, iteration_status, role, provider, model, resolution, run_token_limit, estimated_usd, estimate_basis, paid, authorizes, idea_version, idea_blob, policy_revision, continues, change. That matches the objection's table.

Objection 218 was already answered on this branch (4476928f), which the Builder's 516f9a91 does not yet contain. That is why the Builder still saw M73 fail on 218's cause. Here M73 passes before and after this change, because its manifest check is one-way: every key the table lists must be in the contract, and extra contract keys are not caught. The table now lists both new keys, so M73 holds the contract to them.

## What changed (tests only; SEAM.md §574)

- **`contract/decisions.json`**, `kinds.prototype_preparation_approval.manifest`: `continues` and `change` appended. Its subject types, options and effect are unchanged. The `$comment` records the addition.
- **Not tabled, because no Verifier table holds these sets:**
  - the values of `continues` and `change`: `continues` is null for a first iteration, else `{iteration, seq, previous_brief_iteration_seq, previous_brief_spec_revision}`; `change` is null or the owner's text;
  - the column `prototype_iterations.change_text`;
  - the events `prototype.iteration_iterated` and `prototype.alpha_not_attributed`.
- **No case was added.** Iterate's behaviour is not pinned by an acceptance row in this answer. The Builder's `test/unit/rapid-prototype-iterate.test.mjs` covers it meanwhile.

## Runs

Each file was run alone with `node --test` on this branch after `npm run build` (source unchanged), `TMPDIR=/tmp/rp-v`:

- M73-executable-contract: tests 11, pass 11, fail 0.
- M07-closed-configuration: tests 18, pass 18, fail 0.
- M09-work-transitions: tests 22, pass 22, fail 0.
- M01-kernel-journey: tests 11, pass 11, fail 0.

## Sources

The owner's rulings R7 and R8 of 2026-10-28, quoted above (`PROPOSAL-2026-10-28.md` §7, as the objection cites them). `api/schema.json` on 516f9a91: `/decisions/prototype_preparation_approval`.
