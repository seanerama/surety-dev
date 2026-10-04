# 017: M118 (a) and (b) assume a pause of `lease_ttl + 3` s always expires the lease on the engine's clock; this host's clock steps take that margin away

Row: M118 (a), (b) (sandbox lane; the intermittent failure of E74 item 2 and E75 item 2)
Test: packages/engine/test/acceptance/M118-pause-regrant.test.mjs, line 38 (`const PAUSE_MS = (LEASE_TTL + 3) * 1000;`) and `pause()` (lines 61 to 67), as (a) and (b) use them
Filed by: Builder, M2 slice 14, 2026-10-04

## Claim

A pause of `lease_ttl + 3` s (33 s at the contract's minimum TTL) does not always expire the run lease as the engine judges it.

**The rule the engine follows.** Lease expiries are judged on the wall clock, by the decided rule: "in-process durations on the monotonic clock; stored timestamps and lease expiries stay on the wall clock; the tests tolerate a 2-second step". The engine's expiry check and the store's `expires_at` both use it.

**What this host's clock does.** Its time synchronisation steps the wall clock back about every 31.6 s:
- the journal logs "Clock change detected" at that interval;
- E65 measured steps of 2.93 s, and I measured −620 ms on 2026-10-04.

**How the margin is lost.** A 33 s pause holds one step, sometimes two. With two steps of 2.9 s, the wall clock shows about 27 s of pause. The lease then ends `age + 27` s after its last renewal, where `age` is how long before the stop that renewal happened. That is short of 30 s whenever `age` is under 3 s. In (b) the role heartbeats every 500 ms, so `age` is always under 0.5 s.

**So the lease is not expired when the engine continues, and nothing happens that the case waits for:**
- No fresh challenge, so no `run.lease_regranted`: (a) "timed out after 30000 ms waiting for run.lease_regranted".
- No expiry reconciliation, and no further tick due for 600 s: (b) "timed out after 60000 ms waiting for run … to be ended".
- The role's heartbeats and the engine's renewals go on extending a lease that, by the rule, never lapsed.

These are the recorded failures, on `main` and on the Builder's branch, a different case each time.

## The reproduction (deterministic)

Everything is under `/tmp/claude-1000/-home-smahoney-projects-sdlc-x/fa384943-ed62-4381-ae56-c1ae7b3402e5/scratchpad/m118/`:

**The instrument:**
- `repro/clockstep.cjs` steps the engine's wall clock back, in every thread, by the milliseconds written to `repro/step-ms`. The monotonic clock is untouched.
- `repro/engine-wrapper.mjs` loads it into the engine and its store worker. The harness's `SURETY_WITNESS_ENGINE` points at the wrapper.
- `repro/M118-clockstep.test.mjs` is a copy of the case. It writes `SCRATCH_STEP_MS` into the step file when it stops the engine, which emulates the host's step inside the pause. Nothing else of the case changed.
- `repro/run.sh` runs one copy and keeps its evidence.

**Results** (`repro/summary.txt`):

| Runs | Step | (a) | (b) |
|---|---|---|---|
| `step5800-1`, `-2`, `-3` | 5800 ms (two steps of 2.9 s) | failed 3 of 3, the message above | failed 3 of 3, the message above |
| `step0-1`, `-2` (alternating with the above) | 0 | passed 2 of 2 | passed 2 of 2 |

**What each run directory keeps:**
- the test's output and its `SCRATCH:` lines, with the stop time and the step;
- `clock.log`, the host's wall clock beside `/proc/uptime` every 250 ms;
- under `tmp/`, the kept engine homes: `engine.log`, and `store.db` with the event sequence and the lease row.

In a failing (b), `step5800-1/tmp/surety-acc-s2-FDcVOX/home/store.db` shows `run.heartbeat` renewals continuing after the pause, the lease renewed through `2026-10-04T23:32:01.698Z` on the engine's clock, no challenge, and the run still `executing` when the test gave up.

Repetition alone did not reproduce it today: 5 of 5 quiet and 3 of 3 under a concurrent slice-9 suite (`run-1..5`, `load-run-1..3`, `summary.txt`). Today's steps are too small.

## Proposed change

**First option (preferred):** wait until the lease is expired on the engine's own clock, instead of pausing for a fixed margin. While the engine is stopped, poll until the stored `expires_at` has passed on the host's wall clock, plus a small margin, before the SIGCONT. The host's wall clock is the engine's, since they are one machine. The pause then outlasts the lease by the clock that judges it, whatever steps fall inside it. The case's own assertions about "after the pause" (`afterThePause`) keep their midpoint rule.

**Second option:** `PAUSE_MS = (LEASE_TTL + 10) * 1000`. That covers two steps of the size E65 measured, with room to spare. It is still a fixed margin, which a larger step would defeat.

Case (c)'s "recovered" was not this. It was an engine defect, fixed on `build/m2-s14` (`c7d533b`), with a unit test and the scratch case (c') (`repro/cprime-*`: 3 of 3 failed before the fix, 3 of 3 passed after). Cases (d) to (g) are not affected by this objection.
