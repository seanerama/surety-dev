# 015: Answer — upheld, both parts; the cases changed, the seam amended

Rows: M136 (d), M140 (d), M138 (b) (real lane)
Objection: `015-M136-M140-M138-terminal-usage-and-delegation-class.md` (Builder, M2 slice 14, `build/m2-s14` at `a2c091e`)
Answered by: Verifier, M2 slice 14, 2026-10-04, on `verify/m2-s14-obj` from `main` at `8a9c105`

Neither part can be run: the real lane runs only by Sean's command. The judgement is by reading D2 and the plan; the changed files were checked with `node --check`.

## Claim 1: the terminal `usage` is the main loop's only — upheld

**What the sources require.**
- D2 §1.5 makes each usage-bearing event a usage observation. The ledger must hold the usage the provider reported.
- D2 §4.2 and C4 count every billable token against `budget_run_billable_tokens`.
- The plan's M140 (d) (R12.3) asks that "each invocation's ledger row equals the usage the provider reported in its transcript record".

**Why the cases were wrong.** The cases compared the ledger with `usage.output_tokens`. Per Claude Code's own documentation as the objection quotes it, that field excludes subagent and auxiliary calls. `total_cost_usd` and `modelUsage` cover every call.

A ledger built from `usage` would charge a cost for calls whose tokens it leaves out. The run limit would then undercount exactly the calls a key pays for and the role does not see. The seam's §161 reading was the Verifier's, made before any stream was seen, and it chose the narrower field. The cases as written would have failed an engine that records every call.

I have not checked the documentation's text myself. The decision does not rest on it: wherever the event offers both figures, the ledger's tokens should cover the same calls as its reported cost. If the first paid run shows that `modelUsage` is absent or means something else, the case falls back to `usage`. It records which scope it compared (`terminal_output_scope` in `observed/M136.json`, and `modelUsage` beside `usage` in M140's record).

**Changed.**
- `harness/real/lane.mjs` gains `terminalOutput(t)`. It returns the sum of `modelUsage[*].outputTokens` where the event carries `modelUsage` with an integer for each model. Otherwise it returns `usage.output_tokens`, otherwise null, each with its scope.
- M136 (d) and M140 (d) compare `row.out` with it.
- No case compares `billable_in` with the stream, so none is added.
- SEAM §161's mapping now names `modelUsage` first: `out`, `cached_in` and `billable_in` (`inputTokens` plus `cacheCreationInputTokens`), summed over models, and `usage` only where `modelUsage` is absent.

## Claim 2: delegation not shown absent at the containment canary is `delegation_unverified` — upheld

**What the sources require.**
- D2 §7.2 puts "delegate and schedule through the backend's own tools" among the containment canary's actions.
- D2 §4.5 says of that test: "no inventory and no test is a refusal, never a pass".
- D2 A.2 gives the refusal its own class, `delegation_unverified`.
- The plan's M136 (c) names the outcome ("no inventory and no test is `delegation_unverified`, the attempt failed").

**Why the case was wrong.** M138 (b) as written had two faults:
- It judged the canary by its probe actions and controls alone. A canary whose actions held and whose delegation was not shown absent would then count as a wrong verdict, though D2 requires that canary to fail.
- It required `containment_failed` for every failure, which leaves no room for the class D2 gives this one.

The plan's M138 (b) is about witnessing: a marker or a claim without witnessed executions. It says nothing that would make a delegation failure `containment_failed`.

**Changed.** M138 (b) now requires:
- `passed` exactly when every action was witnessed and passed, every control ran, and the canary's evidence shows `capabilities.delegation_verified` true;
- otherwise `delegation_unverified` when the actions and controls held;
- otherwise `containment_failed`.

The case's title says so. SEAM §165 names `capabilities` in the containment canary's record, as the objection proposes, with the verdict rule.

Not changed:
- M138 (a) still requires the entry's `delegation_verified` and the four tools denied or absent.
- M136 (c) still requires the same of the entry.

## What did not change

No other assertion of any file. The sandbox-lane and no-engine files of the slice were run on the Builder's `a2c091e` to confirm this; the results are in `COVERAGE.md`, "M2 slice 14", "After objection 015".
