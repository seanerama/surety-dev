# 015: M136 (d) and M140 (d) compare the ledger with the main loop's usage; M138 (b) allows no `delegation_unverified`

Rows: M136 (d), M140 (d), M138 (b) (real lane; SEAM.md §§161, 165)
Tests:
- packages/engine/test/acceptance/M136-positive-canary.test.mjs, line 186 (`assert.equal(row.out, t.usage.output_tokens, …)`)
- packages/engine/test/acceptance/M140-real-backend-journey.test.mjs, line 175 (the same comparison per run)
- packages/engine/test/acceptance/M138-containment-canary.test.mjs, lines 92 to 94 (`passed` exactly by the actions and controls; `containment_failed` otherwise)
Filed by: Builder, M2 slice 14, 2026-10-04

Neither part has been run (the real lane runs only by Sean's command). Both are about what the cases will assert of a correct engine.

## Claim 1: the terminal `usage` is the main loop's only; the ledger takes every model call

SEAM.md §161 reads Claude Code's normalization from the result event's `usage` (`out` = `usage.output_tokens`, and so on), and M136 (d) and M140 (d) require `row.out` to equal `usage.output_tokens` wherever the terminal event carries it.

The Claude Code documentation (Agent SDK reference, TypeScript, `SDKResultMessage`, read for 2.1.289) says otherwise of that field:

> `usage`: main agent loop only. Excludes subagent and auxiliary model calls, and is per-turn in streaming-input sessions. Prefer `modelUsage` for token/cost accounting.
> `modelUsage`: per-model totals for every model call made through the query pipeline during this `query()` call, including the main loop, subagents, and internal calls such as compaction and Workflow agents.
> `total_cost_usd`: cumulative estimated cost in USD, covering the same calls as `modelUsage`.

The engine's adapter (`src/invoke/adapters/claude.ts`) therefore takes the terminal tokens from `modelUsage`, summed over its models, where the result carries it, and from `usage` only where it does not (`usage_scope` `all_models` or `main_loop` in the observation). This keeps three things true together:
- the tokens and the reported cost cover the same calls;
- `budget_run_billable_tokens` counts every call the key paid for;
- nothing billed is left out of the ledger.

With `usage` instead, any auxiliary call (compaction; anything Claude Code runs on a second model) would be charged in `total_cost_usd` and missing from the tokens, so the run limit would undercount.

On a run with one model and no auxiliary call the two agree, and the cases pass either way. Where they differ, the cases as written fail a correct engine.

**Proposed change.** In M136 (d) and M140 (d), compare `row.out` with the sum of `modelUsage[*].outputTokens` when the terminal event carries `modelUsage`, and with `usage.output_tokens` only when it does not. Add the same rule for `billable_in` (`inputTokens + cacheCreationInputTokens`) if the cases compare it. Amend SEAM.md §161's mapping to name `modelUsage` first.

## Claim 2: a containment canary whose actions hold but whose delegation is not shown absent fails `delegation_unverified`, not `containment_failed`

M138 (b) requires `k.canary.passed` to equal "every action witnessed and passed, and every control ran", and `failure_class` `containment_failed` whenever it did not pass.

The containment canary is where D2 §7.2 puts "delegate and schedule through the backend's own tools". D2 §4.5 says of the capability test: "no inventory and no test is a refusal, never a pass". D2 A.2 has the class `delegation_unverified`. M136 (c) requires `delegation_unverified` and the attempt failed.

The engine judges the tool surface once, at the containment canary:
- the inventories of every canary's `system`/`init`;
- the instructed attempts at delegation, scheduling and background tools;
- the host's samples of `cgroup.procs`.

A canary whose actions and controls all pass, but whose delegation is not shown absent, does not pass, with `failure_class` `delegation_unverified`, and the attempt fails. M138 (b) as written calls that a wrong verdict: `passed` false where its rule says true, and a class other than `containment_failed`.

**Proposed change.** In M138 (b), let `byRule` also require that the entry or the canary's evidence shows delegation verified (`k.evidence.capabilities.delegation_verified`). When the actions and controls pass but that does not, require `failure_class` `delegation_unverified`.
