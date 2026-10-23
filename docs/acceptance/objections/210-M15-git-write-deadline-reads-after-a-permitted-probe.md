# 210: M15's git-write-deadline case reads the branch update after a probe the contract permits, and fails "its one attempt was killed at the deadline" when its scheduler barrier catches the wrong tick

Row: M15 ("possible writes become ambiguous, dependent integration/dispatch stays suppressed"); D1 §§7.1, 7.5, 7.10, 8.1 step 2, 8.5; SEAM.md §§45, 47, 441, 447
Test: packages/engine/test/acceptance/M15-git-write-deadline-in-a-running-engine.test.mjs, case "the commit object write and then the branch update, each held past git_deadline: …", assertion "the branch update is ambiguous: its one attempt was killed at the deadline"
Filed by: the Verifier, 2026-10-23, as a **Verifier investigation** at the driver's request, while Sean holds the merge of `a158fe1e` (`verify/f33-t23`). The answer is `210-M15-git-write-deadline-reads-after-a-permitted-probe.answer.md`.

## What was observed

- **Failures under load.** The assertion failed twice at `a158fe1e` under three-worker load on mini-hp01: the full gate at 18:19Z, and the bounded comparison run at 19:09Z.
- **Not on the baseline.** It did not fail on the baseline `bf1ca304` in the same comparison: one run per revision, the same 29 files, the same queue order, `TMPDIR=/var/tmp`.
- **Alone, it passed.** The file passed 2/2 when run alone once.
- **Output truncated.** The comparison runner kept only the first six lines of each assertion message. The gate's full assertion output was not preserved.

The logs are read-only in `/tmp/f33-cmp-evidence/`:
- `f33-acc.log` (the gate)
- `f33-cmp-cand-acc.log`
- `f33-cmp-base-acc.log`
- `f33-alone-*.log`
- `f33-cmp-set.txt` (the 29 files)

The surviving fragment of the comparison run's message:

```
      the branch update is ambiguous: its one attempt was killed at the deadline
      + actual - expected

        [
          'ambiguous',
      +   'intended',
```

## Sean's instruction (verbatim)

"Hold the merge for a focused investigation of M15 git-write-deadline only. Determine what the test's scheduler barrier actually guarantees, why a retry can be journaled before the assertion, and whether fixes.ask_unjudged changes that ordering or merely exposes an existing race. Preserve complete assertion output for this investigation. Do not weaken the assertion, increase timeouts to obtain a pass, or repeatedly rerun until green. Prefer a controlled reproduction or ordering trace over another full gate. The deciding question is whether the engine violates the retry/deadline contract, or the test samples state after legitimately permitted progress. Bring that distinction back with evidence and any proposed correction."

## Questions

1. What does the case's `armBarrier(engine, 'scheduler.tick_running', 'pause')` after `requestTick` guarantee? Trace the ordering: events, tick steps, barrier arming, the kill at `git_deadline`, the probe, the retry.
2. Where does the new tick step `fixes.ask_unjudged` sit relative to the journal step and the barrier? Does it change the ordering, or merely shift timing so that an existing race shows?
3. Does the engine violate the retry/deadline contract, or does the test sample state after progress the contract permits?
4. What is the correction, and who owns it?
