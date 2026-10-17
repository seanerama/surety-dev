# 126: answering `design_due` `open` cannot both consume the question and keep a held stage named by an open one

Row: M536 (the invariant at every step), M512 (c), (h) (slice 44)
Test: packages/engine/test/acceptance/M536-the-design-journey-on-the-scripted-backend.test.mjs, every case's closing `assertNoSilentHold`
Filed by: Verifier, slice 40, 2026-10-16 (a question for Sean, not a Builder's objection)

## Claim

D7 §11 states two things that meet on the `open` option:

1. "No design hold exists without an open owner question naming it", which M512 (h) pins as an invariant over every held UI stage, and M536 (l) over the journey.
2. `design_due`'s options are `open`, `waive`, `policy_off`, `later`; `open` "allocates the Designer session … no process starts until the owner's first turn".

D1 consumes a decision when it is answered. If `open` consumes `design_due`, the UI stages stay held `design_pending` through the whole Designer session and the batch with no open question naming them, which (1) forbids. D7 does not say whether `open` leaves the question open (re-raised naming the session) or whether the open session and later the open `design_approval` count as the question.

What slice 40 pins, without deciding it: the journey opens the Designer session by the owner's own command (`surety session open designer`, `POST …/sessions {role: designer}`, which the question names as the exact command, D7 §11), never by answering `design_due`; and while any UI stage is held `design_pending` or `design_stale`, exactly one `design_due` is open and its `evidence.held_stages` names it (SEAM.md §485). Under that pin `design_due` stays open through the session and the batch and is closed by the engine only when no stage it names is held any more (the design ready, or waived, or the policy off), which is not answering it (D7 §11, last item). Slice 44 (M512 (c)) pins the `open` option itself and needs the decision.

**Asked:** does answering `open` keep `design_due` open (its subjects unchanged, the allocated session recorded on it), or close it while another open question (the session, then `design_approval`) is taken to name the holds?

## Sources

- D7 §11: "D7's rule: **no design hold exists without an open owner question naming it**"; "**`open`** (allocates the Designer session, D6 §2.1: no process starts until the owner's first turn)"; "The engine never answers `design_due`".
- D7 §1 "Human acts the design adds: opening the Designer session (or answering `design_due` otherwise)".
- M6 plan §3.6 M512 (h): "at no point a held stage without an open `design_due` naming it (an invariant asserted at each case's end)".
