# 145: during a `later` deferral, is there an open question naming the held stages?

Row: M512 (c) and (h) (slice 44); related to objection 126
Test: packages/engine/test/acceptance/M512-design-due-and-no-silent-stalls.test.mjs, case "(c) later: …"
Filed by: Verifier, slice 44, 2026-10-17 (a question for Sean, not a Builder's objection)

## Claim

D7 §11 says two things that meet on the `later` option, as objection 126 found for `open`:

1. "No design hold exists without an open owner question naming it." M512 (h) pins this as an invariant over every held UI stage. BS6 §4.1 rule 25 adds that a journey with nothing runnable, nothing in flight and no open owner question fails at once.
2. `later` "re-raises at a target time the owner gives, at most `design_due_max_defer`, default 7 d".

D1 consumes a decision when it is answered. If `later` consumes `design_due` and a new one is raised only at the owner's time, then for up to `design_due_max_defer` the held UI stages are named by no open question. With the API stages done, the project then has nothing runnable, nothing in flight and nothing asked, which is the state (1) and rule 25 forbid. D7 does not say whether the deferral keeps the question open, for example as the same question with a "not before" time, or whether the owner's own answer stands in for the question during the deferral.

The slice-40 Builder's work in progress (`build/m6-s40` at `c8257a6`, `src/design/due.ts`) consumes the question and raises nothing until the time passes.

What slice 44 pins, without deciding it:

- the owner gives the time as `until`;
- a time past the bound is refused, naming `design_due_max_defer`, and the question stays open;
- a time within the bound is accepted;
- once the engine's clock passes the time, an open `design_due` names the held stages, raised at or after that time;
- the invariant is asserted at the case's end, after the re-raise, as M512 (h) says ("asserted at each case's end").

Between the answer and the owner's time the test asserts neither that a question is open nor that none is.

**Asked:** during a `later` deferral, does `design_due` stay open (deferred, its escalation and re-raise moved to the owner's time), or is the project allowed to hold UI stages with no open question until that time? If the first, M512 (c) should also assert the open question during the deferral; if the second, rule 25 and the real-lane runner need an exception for a deferral the owner chose.

## Sources

- D7 §11: "D7's rule: **no design hold exists without an open owner question naming it**"; "**`later`** (re-raises at a target time the owner gives, at most `design_due_max_defer`, default 7 d)".
- M6 plan §3.6 M512 (c): "`later` within and past `design_due_max_defer` (lowered)", "re-raised at the owner's time, a time past the bound refused"; (h): "at no point a held stage without an open `design_due` naming it (an invariant asserted at each case's end)".
- BS6 §4.1 rule 25.
- Objection 126 (the same question for `open`).
