# 091: M438 (d) and M437 (e) need more than two runs of one project at once, which the day budget's reservation of each run under way refuses at the default budgets

Row: M438 (also M437, M440)
Test: packages/engine/test/acceptance/M438-the-envelope-as-built.test.mjs, case "(d) max_concurrent_domains 4 caps on the kernel lane with no envelope scripted"; packages/engine/test/acceptance/M437-pipelining-and-parallel-builds.test.mjs, case "(e) integrations released together serialize; three runs of one project at once; …"; packages/engine/test/acceptance/M440-a-storm-of-completions.test.mjs, every case's `assertSustained`
Filed by: Builder, slice 37, 2026-10-14

## Claim

D6 K2 removes the run counts; the project's day budget stays a bound of its own (D6 §6.5: "the project by its day budget (D1 §13.3); each is a separate bound"). As built (`src/store/transitions/ledger.ts` `daySpend`, `exhaustedLimits`, both unchanged by slice 37), a dispatch is refused `budget exhausted` while the day's unknown-cost tokens, the allowances charged, and the allowance reserved by every invocation under way (its `budget_run_billable_tokens`, 1,500,000 by default) together pass `budget_day_unknown_tokens` (2,000,000 by default). So with the defaults a project has at most two runs under way at once: with two running, 3,000,000 > 2,000,000 and the third waits, whatever the envelope and the slots admit.

(d) adds five held items to one project and waits for four to run: two run and the other three stay eligible, no hold shown (observed on `build/m5-s37` at 181cf5c; a scratch copy listing the items' runs at each of twelve ticks shows two `executing` and three with no run throughout, both domains `memory_max` 4 GiB). (e) asks for three runs of one project at once (stages 1 and 3 and a fix) and would meet the same bound.

(e) observed on `build/m5-s37` at 7969756: "a third run of the project: not reached within 120 rounds". M440 (e1) to (e5) observed the same day: (e2), (e3) and (e4) pass every assertion before their `assertSustained` (the renewals, the expiry's run-end protocol, the Stop), and every case's `assertSustained` fails with 22 to 34 of about 50 items complete ((e1) and (e5) call it before their other assertions): one project's items arrive four a second and, two at a time, cannot all complete. A scratch storm of the same shape (one project, an item every 250 ms for 15 s) completed 26 to 34 of about 50 at the default budgets and 35 to 38 of about 50 with `budget_run_billable_tokens` 10,000 (so the budget admits the four slots), on this workstation, after slice 37 made the tick prepare its claimed runs side by side and the integrity step read retained checkouts side by side. So the budget is one bound the storm meets, and the tick's own time is another (a tick here takes 0.3 to 1.3 s: the integrity step's re-reading of every retained run workspace of the project, D1 §8.1 step 3, grows with the storm); the second is reported to the driver, not proposed here as a test change.

The slot cap (D6 K2; the ruling Q2) is not what the cases reach, so they do not pin it. I propose each raises the project's `budget_day_unknown_tokens` (a widening, confirmed by the owner as M436 (c) does for its budgets) or lowers `budget_run_billable_tokens` (not a widening), so that the budget admits the runs the case needs; or spreads the runs over projects, as M12 does for the slot cap. A decision for Sean instead, if K2 means the day budget's reservation should not count the scripted backend's invocations: the engine would change, not the test.

## Sources

- D6 §6.5 ("the project by its day budget (D1 §13.3); each is a separate bound, and none is represented as one aggregate chain counter").
- `src/store/transitions/ledger.ts` `daySpend` ("Invocations under way … runningAllowanceTokens"), `exhaustedLimits`; `src/store/transitions/runs.ts` `dispatchBlocker` ("budget exhausted").
- `src/config/schema.ts`: `budget_run_billable_tokens` 1,500,000; `budget_day_unknown_tokens` 2,000,000.
