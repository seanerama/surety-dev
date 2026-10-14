# 091: M438 (d) and M437 (e) need more than two runs of one project at once, which the day budget's reservation of each run under way refuses at the default budgets

Row: M438 (also M437)
Test: packages/engine/test/acceptance/M438-the-envelope-as-built.test.mjs, case "(d) max_concurrent_domains 4 caps on the kernel lane with no envelope scripted"; packages/engine/test/acceptance/M437-pipelining-and-parallel-builds.test.mjs, case "(e) integrations released together serialize; three runs of one project at once; …"
Filed by: Builder, slice 37, 2026-10-14

## Claim

D6 K2 removes the run counts; the project's day budget stays a bound of its own (D6 §6.5: "the project by its day budget (D1 §13.3); each is a separate bound"). As built (`src/store/transitions/ledger.ts` `daySpend`, `exhaustedLimits`, both unchanged by slice 37), a dispatch is refused `budget exhausted` while the day's unknown-cost tokens, the allowances charged, and the allowance reserved by every invocation under way (its `budget_run_billable_tokens`, 1,500,000 by default) together pass `budget_day_unknown_tokens` (2,000,000 by default). So with the defaults a project has at most two runs under way at once: with two running, 3,000,000 > 2,000,000 and the third waits, whatever the envelope and the slots admit.

(d) adds five held items to one project and waits for four to run: two run and the other three stay eligible, no hold shown (observed on `build/m5-s37` at 181cf5c; a scratch copy listing the items' runs at each of twelve ticks shows two `executing` and three with no run throughout, both domains `memory_max` 4 GiB). (e) asks for three runs of one project at once (stages 1 and 3 and a fix) and would meet the same bound.

The slot cap (D6 K2; the ruling Q2) is not what the cases reach, so they do not pin it. I propose each raises the project's `budget_day_unknown_tokens` (a widening, confirmed by the owner as M436 (c) does for its budgets) or lowers `budget_run_billable_tokens` (not a widening), so that the budget admits the runs the case needs; or spreads the runs over projects, as M12 does for the slot cap. A decision for Sean instead, if K2 means the day budget's reservation should not count the scripted backend's invocations: the engine would change, not the test.

## Sources

- D6 §6.5 ("the project by its day budget (D1 §13.3); each is a separate bound, and none is represented as one aggregate chain counter").
- `src/store/transitions/ledger.ts` `daySpend` ("Invocations under way … runningAllowanceTokens"), `exhaustedLimits`; `src/store/transitions/runs.ts` `dispatchBlocker` ("budget exhausted").
- `src/config/schema.ts`: `budget_run_billable_tokens` 1,500,000; `budget_day_unknown_tokens` 2,000,000.
