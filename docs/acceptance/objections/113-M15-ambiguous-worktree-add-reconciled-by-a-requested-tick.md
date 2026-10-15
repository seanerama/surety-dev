# 113: M15 ambiguous-git-call-reconciled, case 2: a requested tick reconciles the ambiguous worktree_add before the test completes it by hand

Row: M15
Test: packages/engine/test/acceptance/M15-ambiguous-git-call-reconciled.test.mjs, "a late completion launches nothing: a worktree that turns out complete is adopted…"
Filed by: Builder, slice 37, 2026-10-14

## Observed

The case fails alone on the workstation: "found applied, the operation is finalized (events: intended, ambiguous, failed)". It fails the same way at slice 37's 20d0982, 4144687 and 8886563, built in a scratch worktree and run against their own test files. It passes at `main` (slice 36). The review-round changes and the M53 ruling (journal/driver.ts) are not its cause.

## Mechanism

1. The case kills the worktree_add at its deadline. The operation is ambiguous and the run is given up.
2. The run's end requests a tick (D6 K1, M440 (a)).
3. That tick's journal step (D1 §8.1 step 2) reconciles the ambiguous operation. The probe finds the worktree absent, so the add is withdrawn and the operation is `failed`.
4. Only after that does the test call `letGo()` and add the worktree by hand.
5. The "late completion" the case builds is never observed. Before K1, no tick ran until the test's own `tickUntil`.

## Proposed

The case completes the worktree by hand before anything can request a tick. For example, it holds the scheduler at `scheduler.tick_running` (§441) from the kill until the hand completion, then releases it. Alternatively it pauses the project across that window.

## Sources

- D6 K1; M440 (a); D1 §7.10, §8.1; objections 100, 105 and 111 (K1 straddles).
