# 156: M533 (e) and M532 (f) say a Designer turn while two Builders of the project are in flight; the day limit refuses the turn, and the refusal closes the session

Row: M533 (also M532)
Test: packages/engine/test/acceptance/M533-selection-and-its-floor.test.mjs, case "(e) a later revision widening the selection: …"; packages/engine/test/acceptance/M532-the-designer-beside-one-shot-runs.test.mjs, case "(f) …"
Filed by: Builder, slice 41, 2026-10-17

## Claim

This is partly a test fault and partly a design question for Sean.

**What happens.** In M533 (e), (b)'s approval made the design ready, and the UI stages' Builders dispatch. The case then opens a Designer session and says its first turn. When the turn is admitted, two UI Builders are in flight. Each has nothing observed yet, so each reserves its whole `budget_run_billable_tokens` (1,500,000) against `budget_day_unknown_tokens` (2,000,000). That is D1 §13.3 as built: `exhaustedLimits(…, { dispatch: true })`, at turn admission in `sessions/session.ts` as at one-shot dispatch. Reserved 3,000,000 > 2,000,000, so the turn is refused, and B01's protocol then closes the session `budget_exhausted`:

```
✖ (e) … AssertionError: POST …/turns admits the owner's message (SEAM.md §344)
  (→ 409 {"code":"budget_exhausted","reason":"Project proj_… has passed budget_day_unknown_tokens; the session admits no further turn.", … "limits":["budget_day_unknown_tokens"]})
```

What the turn's admission counted was dumped from the store at the refusal, using a scratch copy of the file outside the repository, `/tmp/b41/scratch/m533.mjs`. The invocations under way, with no ledger row:

```
[{"role":"builder","kind":"one_shot","state":"claimed","budget_snapshot":"{\"budget_run_billable_tokens\":1500000,…}"},
 {"role":"builder","kind":"one_shot","state":"claimed","budget_snapshot":"{\"budget_run_billable_tokens\":1500000,…}"}]
```

Nothing had been charged: every ledger row had `unknown_allowance_tokens` null. Waiting for every run of the project to end before the session opened does not help. The UI stages' Builders are dispatched again between `waitForIdle` and the turn's POST, so this is a race the case cannot win.

M532 (f) runs the same way: the later Designer session's turn is said while stages 2 and 3's Builders are dispatched. It was refused the same way on slice 40's build: `budget_exhausted`, "passed budget_day_unknown_tokens". It passed in both of my runs on this slice's build, so it depends on timing.

**Why it is the test's as built.** Each case expects a Designer turn admitted while two one-shots of the same project are in flight under the default limits. D1 §13.3's day limit, as built and accepted, admits no new invocation while the day's reservations pass `budget_day_unknown_tokens`. The cases change neither the limit nor the timing. Raising the limit is a widening, and the policy route asks for its confirmation (`confirm_required`, observed in the scratch copy), so a case that raises it must confirm it. A case could:

- raise `budget_day_unknown_tokens` through its confirmation before the UI stages are released, say to 20,000,000; or
- say the turn before the design is approved, which M532 (f) cannot do, because it pins Builders launched beside a newer checkpoint.

**The design question for Sean.** G12 (D7 §3.1) says one-shots dispatch while the Designer session is open, and the session's turns are admitted "like any run". A one-shot whose dispatch would pass the day limit is held until the reservations clear. A Designer turn is refused 409 instead, and the refusal closes the whole session `budget_exhausted` (B01), though its own budget is not spent. Under the defaults, two one-shots in flight are enough. My change in this slice makes it more so (SEAM.md §491). A Designer turn's reservation is now its session budget, `designer_session_budget_billable_tokens` (3,000,000), because that is the most it can spend before it is stopped. While a Designer turn is in flight, no one-shot of the project passes the day check under the defaults. The options:

- (a) hold a turn's dispatch on the day's reservations as a one-shot's is held, and close only on the session's own budget;
- (b) refuse the turn but keep the session open;
- (c) keep it as built and raise `budget_day_unknown_tokens` for designed projects.

This is not a Builder's choice. Until it is decided, I have built none of them.

## Sources

- D1 §13.3 and `store/transitions/ledger.ts` `daySpend` / `exhaustedLimits` (`runningAllowanceTokens`, counted with `dispatch: true`).
- `sessions/session.ts` (turn admission, `exhaustedLimits(…, { check: true, dispatch: true })`); `api/server.ts` (a `budget_exhausted` refusal of a turn closes the session by the protocol, B01).
- D7 §3.1 (G12): "each turn admitted by the envelope as a `role` domain at `role_memory_max` like any run"; §3.2 (the Designer's 3,000,000-token budget, double the run budget).
- SEAM.md §491 (the Designer's budget in place of the run budget).
