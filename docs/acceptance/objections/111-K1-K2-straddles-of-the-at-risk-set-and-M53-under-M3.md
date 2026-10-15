# 111: K1/K2 straddles in the at-risk set (M11, M21, M27, M229, M115, M209), and M53 case 8 under the review's M3

Rows: M11, M21, M27, M229, M115, M209, M53
Filed by: Builder, slice 37, 2026-10-14 (the driver's ruling: one objection for these)

## How they were told apart from regressions

Each file below was run alone on the workstation twice:
- at `build/m5-s37` 17195cf;
- at 20d0982, built in a scratch worktree and run against its own test files.

The failures are the same at both. The review-round changes did not cause them. Each assumes no requested tick (D6 K1), or one run per project (D6 K2). SEAM §437 lists neither as migrated.

## The cases and their mechanisms

1. **M11-repair-limits, case 1** ("work whose every run fails is launched once plus the permitted repairs, then parks with its cause"). It times out waiting for the item to be `eligible`. A run's end requests a tick (K1, M440 (a)). That tick claims the repair, so the test's poll misses the item's brief `eligible`.
2. **M21-quiescent-snapshot-and-checkpoint, both cases.** After the checkpointing run ends, the item is read `claimed`, not `eligible`. The run_ended tick dispatches the continuation at once. This is the same mechanism as objection 110 (M74). The same fix applies: pause the project before the run ends, read, then resume.
3. **M27-nomination-identity-and-cadence, case 1** ("a second stage integrated after a nomination…"): `2 !== 1`. Under K1/K2 a requested tick nominates, or a second integration lands, before the test reads the single candidate it expects.
4. **M229 (c), case 2** (R1 indexed, the control): `not_satisfied` with `GIT_JOURNAL_PENDING`. A journal operation of the project is in flight when the gate is evaluated: a requested tick's nomination, or another run's integration. The evaluation is right to refuse. The case should evaluate once the project's journal is idle.
5. **M115 (a) and S1** ("nothing else of the project is dispatched"): `1 !== 0`. Under K2 the case's `waiting` review is dispatched beside the held item as soon as it is eligible, before the Stop. One run per project no longer holds it back. After the quarantine, nothing more of the project is dispatched. The engine also now holds the project's dispatch while one of its runs is finalizing with a domain whose termination is not established (kept at the driver's ruling). The case should create `waiting` after the quarantine is recorded, or pause the project until then.
6. **M209 (b)** ("a failed read is not an observed change (N02)"). The gate route requests a tick (K1, cause `api`). That tick's integrity step (D1 §8.1 step 3) runs while `holdGit` holds the repository, and records it as not readable (`out_of_band_changes`, subject `repository`), which is D1 §7.6's behaviour. A later evaluation then names OUT_OF_BAND_CHANGE. The pre-dispatch recheck no longer adds to this: since 01470fb its failed read is `unknown`, which holds dispatch and records nothing. The case should hold git with the scheduler paused (the barrier `scheduler.tick_running`), so that no tick's integrity step meets the held repository.

## M53 case 8, under the review's M3

M53 case 8 builds this interleaving: the integration moves the branch between the protected application's commit and its branch update. Under the review's M3 (the driver's ruling), every engine writer of the integration ref holds the project's journal and integration lease, from its read of the head to its drive. The protected application now does so too (`decisions/effects.ts` `applyHeld`), so an engine integration can no longer land inside it. The case waits on `journal.commit_tree.intent_committed` behind the integration's held step and times out.

The protection the case tests still matters for an out-of-band move. I propose this, at the driver's ruling:
- At the `commit_tree` barrier, the case moves the branch by hand (an out-of-band commit), then releases.
- The application's branch update fails its compare-and-swap without effect.
- The effect is invalidated, and the approval and its intended version are withdrawn.
- No blocker is open, and the question is asked again against the new head.

The hand move is itself an out-of-band change. Integrity records it, and its adopt/discard question (`out_of_band_change`) follows under D1 §7.6. So "nothing is left blocked" should exclude that decision, or the case should adopt the move first.

## Sources

- D6 K1, K2; SEAM §437; M440 (a); objections 100, 105, 110.
- The slice-37 review's M3; D1 §7.6, §8.1.
