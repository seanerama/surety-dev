# 218, answered: upheld; the Verifier's work and decision tables gain `brief_preparation` and `prototype_preparation_approval`

Answer to `218-M73-the-work-and-decision-tables-gain-the-prototype-brief-kinds.md`, by the Verifier on `verify/rapid-prototype`, merged up to the Builder's `build/rapid-prototype` c24dd523, 2026-10-28.

**Upheld.** The two kinds implement the owner's ruling R5 of 2026-10-28, verbatim: "Approve separate, bounded preparation authorization. Explain its cost before the first paid call and count it in prototype totals. Be explicit that the initial paid flow has preparation approval, brief approval and check approval." The rows the Builder asks for match the generated `api/schema.json` on c24dd523:
- `work_items.kinds.brief_preparation`: `m1` true, role `spec_writer`, path eligible → complete through integrating and integrated.
- `decisions.prototype_preparation_approval`: enabled, with the fifteen manifest keys the objection lists.

M73's case compares these two tables with the contract, and the tables were the only reason it failed. With the rows added, M73 passes.

## What changed (tests only; SEAM.md §573)

- **`contract/work-items.json`**, `kinds`: `brief_preparation`: `{ "m1": true, "role": "spec_writer", "path": ["eligible", "claimed", "executing", "integrating", "integrated", "complete"] }`. This is `replan`'s path. The `$comment` records it.
- **`contract/decisions.json`**, `kinds`: `prototype_preparation_approval`, with:
  - `subject_types` `["prototype_iteration"]`;
  - `options` approve and reject;
  - `manifest`: iteration, iteration_seq, iteration_status, role, provider, model, resolution, run_token_limit, estimated_usd, estimate_basis, paid, authorizes, idea_version, idea_blob, policy_revision;
  - `effect` false: its approve registers the work item in the answer's transaction, with no effect intent.

  The `$comment` records it.
- **Not tabled, because no Verifier table holds these sets:** the record kind `prototype_brief`, the phase-plan routing value `policy_authorized` and the ten `prototype.*` events. M73's cases that compare the contract with a real store and with the committed appendix already pass with them.
- **Not added:** a `decision_target_defaults` row for the new kind. The contract gives it 172800 s. M07-closed-configuration checks only the kinds the table lists, so the table already omits some kinds, `rollout_partial` among them. No row requires it here.
- **No case was added.** The preparation approval's question, its approve and reject, the run's one-shot rule, the brief and the policy-authorized first plan are not pinned by an acceptance row in this answer. The Builder's `test/unit/rapid-prototype-brief.test.mjs` covers them meanwhile.

## Runs

Each file was run alone with `node --test` on this branch after `npm run build` (source unchanged), `TMPDIR=/tmp/rp-v`:

- M73-executable-contract: tests 11, pass 11, fail 0.
- M07-project-bootstrap-and-policy: tests 5, pass 5, fail 0.
- M01-kernel-journey: tests 11, pass 11, fail 0.
- M422-the-spec-approvals-floor: tests 14, pass 14, fail 0.
- M405-plan-published-by-the-authorized-finalizer: tests 6, pass 6, fail 0.
- M09-work-transitions, which generates cases from the work table: tests 22, pass 22, fail 0.

## Sources

The owner's ruling R5 of 2026-10-28, quoted above, and R1, "Record publication as policy-authorized, never as a human approval." (`PROPOSAL-2026-10-28.md` §7, as the objection cites them). `api/schema.json` on c24dd523: `/work_items/kinds/brief_preparation` and `/decisions/prototype_preparation_approval`.
