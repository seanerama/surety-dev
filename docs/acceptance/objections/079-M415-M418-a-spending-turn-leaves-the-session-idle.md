# 079: M415 (f) and M418 (b) need the session idle after the turn that spends its budget, which ruling M5 closes at once

Rows: M415 (f), M418 (b)
Tests:
- packages/engine/test/acceptance/M415-a-session-is-a-run-of-settled-turns.test.mjs:96, `await sayAndSettle(fx, p.id, run.id, 'Spend.')`
- packages/engine/test/acceptance/M418-idle-timeout-budget-exhaustion-and-resume.test.mjs:91, the same call
- both through packages/engine/test/acceptance/harness/sessions.mjs:108, `assert.equal(done.read.run.session_state, 'open_idle', 'the session is idle again')`

Filed by: Builder, slice 33 review fixes, 2026-10-13

## What happens

The slice-33 review's M5, as the driver ruled it (D1 §13.3 "between session turns"; D6 §2.4):

> a settlement that leaves the cumulative budget spent closes the session at once by the idle protocol. Keep the refusal path.

On `build/m5-s33` at 4212bed the engine does exactly this. The first turn spends 9,990 + 10 = 10,000 billable tokens of `budget_run_billable_tokens` 10,000 and settles. Its settlement finds the budget spent and closes the session by the idle protocol: save, `closing`, then the end protocol with reason class `budget` and public code `budget_exhausted`.

The two cases then use `sayAndSettle` for the spending turn. It requires the session to be `open_idle` when it reads the settled turn. By then the session is already `closing`, so the step before the case's own assertions fails:

```
not ok 1 - (b) budget exhaustion between turns: no further turn admitted; closed budget_exhausted through the end protocol
  error: |-
    the session is idle again
    + actual - expected
    + 'closing'
    - 'open_idle'
```

M415 (f) fails the same way, in the sandbox lane.

What the cases go on to assert does hold: no further turn is admitted, and the run ends with reason class `budget` and code `budget_exhausted`. A turn posted after this settlement is refused 409, because the session is closing or has ended. The refusal path (409 `budget_exhausted` on a turn posted to an idle, spent session) is kept, as the ruling says.

## What I believe is right

Settle the spending turn with `say`, not `sayAndSettle`, and check that the turn settled. `say` accepts a settled turn whatever the session's state. Or read the turn's `state: 'settled'` without asking for `open_idle`. The rest of each case reads what the row requires. No engine change is needed, and the engine is not bent to leave a spent session idle against M5.
