# 018: M115 (e) sends one tick right after releasing the launcher; the launcher may still be in the domain then, so the quarantine rightly stays

Row: M115 (e) (sandbox lane)
Test: packages/engine/test/acceptance/M115-every-unknown-quarantines.test.mjs, lines 216 to 219 (the release of `launcher.before_placement`, one `tick`, then `assertClearedOnce`, which waits 30 s for the run to end)
Filed by: Builder, M2 slice 14, 2026-10-05

## Claim

The case does three things in a row:
1. it releases the launcher held at `launcher.before_placement`;
2. it sends one tick;
3. it waits 30 s for the run to end.

The case's own engine setting gives a tick interval of 600 s, so no other tick comes during that wait.

The released launcher's first act is to place itself in the domain. Placing after closure is allowed (D2 §3.2), is "not pinned" (SEAM.md §131), and is answered by a refused grant, after which the launcher exits.

Until it has exited, the domain is populated and its launcher is outstanding. The engine must not count that as termination: D2 §3.2 says "populated 0 on a domain whose launcher is outstanding is not termination", and the slice-11 review's S1 pins exactly this.

So if the case's one tick observes before the launcher has gone, the quarantine stays. Nothing re-observes it within the wait, and the case times out.

## Evidence

The case failed 1 time in 3 runs of the file (`m115-7cb7b7d-2`). It passed alone 2 of 2, and the same file passed again in a later run. The failing run's home is kept at `/tmp/claude-1000/-home-smahoney-projects-sdlc-x/fa384943-ed62-4381-ae56-c1ae7b3402e5/scratchpad/s14-build/m115-7cb7b7d-2/tmp/surety-acc-s2-AG1eHg/home` (`store.db`, `engine.log`), with the test output in `../test.log` beside the `tmp/` directory.

Its event sequence:

| seq | time | event | what it shows |
|---|---|---|---|
| 31 | 02:02:16.906 | `run.quarantined` | the run is quarantined |
| 37 | 02:02:17.028 | `domain.placed` | the released launcher placed itself after closure |
| 39 | 02:02:17.063 | `engine.tick` | the case's one tick, 35 ms after the placement |

No `domain.terminated` and no `run.ended` follow. The case's message: "timed out after 30000 ms waiting for run … to be ended".

## Proposed change

- **First option (fixture):** after the release, tick until the run has ended, within the existing 30 s. Or wait for the launcher's exit before the one tick: it is the engine's child, and the test can watch its pid, or the domain's `cgroup.procs` until empty. Then "the next tick clears it" holds by construction.
- **Second option (engine, a design question for Sean or the driver):** the engine requests a tick itself when its own launcher of a quarantined domain exits, so that the next observation comes without waiting for the tick interval. D2 §3.4 says each tick observes again and does not ask for this. I have not built it.
