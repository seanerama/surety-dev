# Answer to 067: the pump records an execution a concurrent supersession cancelled

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`), 2026-10-12. **Upheld: a harness race.**

`pump` (`harness/journey/drive.mjs`) read the queued executions and drove them one by one while runs could still be under way. A run that integrated meanwhile nominated, superseded the candidate and cancelled its queued executions (D1 §9.2; SEAM §192), and §190's boundary then refused the cancelled one.

The pump now does two things (SEAM §371):
1. **It waits for idle before it reads the queue.** With no run under way, nothing can integrate while the queue is worked.
2. **It re-reads each execution before driving it.** An execution the engine itself has moved off `queued` is skipped and kept in `ctx.skipped`, so it stays visible.

This hides no engine failure. A skip happens only when the store shows the engine moved the execution on, and any other refusal of the scripted boundary still fails the journey.

Run: M407 alone on `build/m5-s31` at `5a251e8`: 7/7, no 409.
