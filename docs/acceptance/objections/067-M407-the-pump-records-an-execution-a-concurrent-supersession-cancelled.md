# 067: the journey pump records the exit of an execution that a concurrent supersession has cancelled

Row: M407 (b) (seen there); any journey file whose pump starts while runs are live
Test: packages/engine/test/acceptance/harness/journey/drive.mjs, `pump`: `for (const x of queuedExecutions(fx.home, project)) await recordExit(fx.engine, x.id, exits(x));`
Filed by: Builder, slice 31b, 2026-10-12

## Claim

`pump` lists the queued executions, then drives each one through §190's boundary in turn. It does not wait for the engine to be idle first. M407 (b)'s pump starts after `tick(…, {rounds: 3})` with no `waitForIdle`, while phase 2's runs are live, because phase 2 now proceeds with no human act (objection 064). A Builder run then integrates, and its finalizer's nomination (`engine_cadence`) supersedes the candidate whose executions the pump has just listed. D1 §9.2 and SEAM.md §192 cancel the superseded candidate's queued executions. The pump's next step answers 409:

```
the scripted check boundary moves cx_… to materializing (SEAM.md §190)
(body: {"code":"illegal_transition","reason":"A check execution in cancelled cannot move to materializing in one step." …})
```

I saw this in two of three runs of M407 on this branch. Event order from one of them: `work.integrated`, then `candidate.nominated` (`engine_cadence`), then `candidate.superseded` and `check.cancelled` (`from: queued`), all at 16.481. The pump's step on the cancelled execution came after that, and the Builder run's `run.finalizing` followed at 16.498.

The engine is doing what D1 asks. The race is in the harness. Two fixes would remove it: the pump waits for idle before it reads the queue, or it skips an execution that is no longer `queued` when its turn comes. On a scratch copy whose pump re-reads the queue before each execution, the 409 did not recur.

## Sources

- D1 §9.2; SEAM.md §192 (a superseded candidate's queued executions cancelled), §190 (the scripted check boundary).
