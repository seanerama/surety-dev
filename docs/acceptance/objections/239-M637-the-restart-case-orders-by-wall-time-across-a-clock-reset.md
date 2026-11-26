# 239: M637's restart case orders the candidate after the fix by wall-clock stamps, and a restart sets the controlled clock back

Row: M637 ("a restart between disposition and fix dispatch gives one fix item")
Test: packages/engine/test/acceptance/M637-a-verifiable-defect-is-repaired-within-the-brief.test.mjs, case "a restart between the disposition and the fix dispatch: one fix item" (Verifier 2's file as merged in gate/i58b 0f926b4f)
Filed by: Builder B, item 57 rulings batch, 2026-11-26

## Claim
Observed on the gate tree 0f926b4f plus Builder B's 04ec321d, each run alone on the workstation: the restart case failed 3 times in 5. All six other cases passed in all five runs, (b) among them. Two failures read "after the restart: one unit of prototype_repairs_per_iteration consumed (4 → 2)". One read "after the restart: accept-r3x passes on <the next candidate> ([[cr_…, 1]])".

The test decides X's exit, and which candidate is "the next candidate", by comparing wall-clock stamps:
- `exitsFor` returns 1 for X on any candidate whose `created_at` is earlier than the fix item's.
- `assertRepairedByPolicy` takes the first candidate with `created_at >=` the fix item's.

The engine's controlled clock is an offset held in the engine process's memory (testing/seam.ts `clockCell`, moved by POST /v1/harness/clock/advance). `alphaReady` (harness/prototype.mjs l.457) advances it 31 s before F is raised. The case's `restart(fx)` (harness/gap57.mjs) stops the engine and starts a new process. That process starts at offset 0 unless `--harness-clock-offset` is passed, and nothing passes it. So stamps written after the restart can be up to 31 s earlier than the fix item's, which was written before it.

Two outcomes follow, depending on how long the run takes:
- The fix's own candidate reads as "created before the fix". X then fails on it and the fix is sent back once (the second repair unit).
- Or the "next candidate" chosen by `created_at` is the wrong one.

This is the test ordering two facts by wall time, which Sean's ruling on DECISIONS item 51 excludes ("store order or an explicit recorded fact, never wall clock"). It is not an engine defect: the engine registers one fix item and spends one unit until the harness's exit sends the fix back.

## What I ask
The Verifier orders by recorded facts:
- the fix item's place: its `work.created` event seq, or `work_items.seq`;
- against the candidate's: `candidates.seq`, or its `candidate.nominated` event seq;
- or by the fix's own candidate, the candidate holding the fix work in its `held_work`.
Alternatively, the harness passes the controlled clock's offset across `restart`. The engine side needs no change.

## Sources
- DECISIONS item 51, the owner's ruling (store order, never wall clock).
- packages/engine/src/testing/seam.ts `clockOffsetMs`, `advanceClock`, `--harness-clock-offset`.
- M637 test l.138–147 (`exitsFor`), l.205 (the next candidate by `created_at`), l.305–318 (the restart case).
