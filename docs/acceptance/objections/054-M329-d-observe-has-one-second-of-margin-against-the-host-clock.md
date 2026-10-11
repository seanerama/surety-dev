# 054: M329 (d) times out when this host's wall clock steps back during an observation; `observe()` has 1 s of margin and asks for no tick while it waits

Row: M329 (and any file that uses `harness/deploy/observe.mjs`'s `observe()`)
Test: packages/engine/test/acceptance/M329-the-observation-job-on-the-scripted-target.test.mjs, case "restart by hand, acknowledge, read, re-verify, replace" (line 224), at `healthy()` → `observe()` → `waitFor` ("timed out after 30000 ms waiting for an observation of alpha")
Filed by: Builder, slice 29, 2026-10-11

## Claim

The failure is the host's clock against the helper's margin, not the engine.

**Measured.** I ran M329 alone three times on `e73c4b1` while a sampler logged the wall clock (`Date.now()`) against the monotonic clock (`performance.now()`).
- Runs 1 and 2 failed this case. Run 3 passed.
- The wall clock stepped back by about 2.9 s every 29.4 s: at 13:47:31.7, 13:48:01.0, 13:48:30.3, 13:48:59.7 and 13:49:29.1 (UTC), 14.5 s in all over 2.5 minutes. NTP reports synchronized.
- In the driver's second gate the same case failed the same way; the first gate passed it.

**Mechanism.**
- An observation job's due time is stored on the engine's clock, which is the wall clock plus the harness offset (`clock.ts`, `nowMs`). It is due `observation_cadence` (30 s) after the last observation.
- `observe()` moves the engine clock 31 s ahead and asks for 6 ticks, so it has 1 s of margin.
- If the wall clock steps back 2.9 s between the previous observation and these ticks, the job is still about 1.9 s short of due and no observation is made.
- `observe()` then waits by time for 30 s (objection 046's fix) but asks for no further tick. The engine's own tick, `tick_interval` 600 s in these engines, never comes, and the observer is woken only by a tick. The wait expires.

**Not the slice-29 changes.** None of them touches the observation job, its due times, the tick or the engine's clock. The case fails whether or not a step lands in that window: run 3 had a step at 13:49:29 and passed.

Suggested (any one):
- `observe()` moves the clock ahead by the cadence plus a margin larger than the host's clock steps, for instance 40 s for a 30 s cadence.
- `observe()` keeps asking for a tick while it waits by time, so that a job that falls due later is taken up.

## For Sean

This WSL2 host's wall clock steps back about 2.9 s every 30 s. That is roughly 10 % of real time, corrected by repeated steps. Any wall-clock duration or due time measured here can be short by seconds:

- The engine's stored due times and deadlines are on that clock by design, since they must survive a restart.
- Durations are now monotonic in the qualification (`53d01d5`).
- The test harness's `waitFor` is monotonic.

The cause is outside the repository, likely WSL's time sync. It may be worth looking at before the real lane.

## Sources

- D4 §6.2: a due job makes one bounded `status` read.
- SEAM.md §291: the observer runs off the tick and is woken by tick requests.
- Objection 046: an observation is waited for by its history row, not by a count of ticks.
- `harness/deploy/observe.mjs` (`observe`, `seconds = 31`); `harness/engine.mjs` (`waitFor`, monotonic); `harness/runs.mjs` (`tick_interval` 600 in the slice-2 configuration).
