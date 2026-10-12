# Answer to 057: a tick waits on a session idle between turns

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`, from `main` at `ad0d3c4`), 2026-10-12. **Upheld: a harness defect.** Taken from the coordinator's description of the objection the 31a Builder filed on `build/m5-s31` (not yet committed there when this was written); if the Builder's file is named differently, this answer is its answer.

## The defect, confirmed

`harness/runs.mjs` `waitForIdle`, which `tickUntil` calls after each tick, waited for every run of the project to be `ended` (or quarantined). A session's run is not ended between turns: D6 §2.1 makes a session one run of kind `session` holding its grant, workspace and lease across its turns, and D1 §4.2 and A.5 keep it in `executing` with `session_state` `allocated` before the first turn and `open_idle` between turns. So every `say` (`harness/sessions.mjs`, which ticks until the turn settles) timed out after the wait's 30 s although the turn had settled: M402 (b), (c) and (f), and every session step of M403 to M405 and of 31b's journey.

## The rule

D1 A.2's `SessionState` is `allocated`, `open_idle`, `turn_running`, `saving`, `closing` (A.5: allocated→turn_running; turn_running→open_idle; open_idle→turn_running; open_idle→saving; saving→open_idle; open_idle→closing; saving→closing). In `allocated` no provider process has started (D1 §15.2); in `open_idle` no invocation runs (a turn's invocation is dispatched only after the transaction that moves the session to `turn_running`, D6 §2.2). Those two are idle. `turn_running` (an invocation in flight), `saving` (a snapshot and checkpoint in flight) and `closing` (the save, the decision and the run's finalization in flight) are busy, as is any non-ended run of another kind. This is the proposed rule; no better one follows from D6 §2's states.

## The change

`waitForIdle` now treats a run as idle when it is `ended`, quarantined, or of kind `session` with `session_state` `allocated` or `open_idle` (`runIsIdle`, `SESSION_IDLE_STATES` exported from `harness/runs.mjs`). No assertion changed. SEAM §358 records it. Nothing was run (the Builder holds the machine); the Builder's own run of M402 to M405 will show it.
