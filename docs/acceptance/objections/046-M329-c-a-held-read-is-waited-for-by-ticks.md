# 046: M329 (c)'s "read past its deadline" waits for the observation by a count of ticks, which the observation no longer holds

Row: M329
Test: packages/engine/test/acceptance/M329-the-observation-job-on-the-scripted-target.test.mjs, case "a read past its deadline and a manager not answering: each unknown with environment.observation_missed, never the previous value, and no out-of-band fact; read again: healthy"
Filed by: Builder, slice 27, 2026-10-10

## Claim
The case queues a `hang` answer for the observation job's `status` read with `adapter_read_deadline` 1 s, then calls `observe(ctx)`, which advances the clock and asks for at most 6 rounds of two ticks (`tickUntil`, `max: 6`) until a new `observation_history` row exists. The observation runs off the tick (the driver's ruling on the slice-27 design, answer 7; SEAM.md §291 "An observation's reads hold no tick"), so the 12 kernel ticks can finish while the held read is still waiting for its 1 s deadline; the run on build/m4-s27 failed with "an observation of alpha was not reached after 6 ticks" (2.6 s for the whole case). The row is due after the read's deadline, outside the ticks the case counts.

What the engine does is what the row asks: the read is cancelled at its deadline, the observation is recorded `unknown` with `environment.observation_missed`, and no out-of-band row is written. The case should wait for the row by time, for at least `adapter_read_deadline` plus a margin (for example `waitFor` on the history with a timeout of some seconds after the ticks), not by a count of ticks that the observation does not hold. The "manager not answering" half of the same loop (`failure`, no hang) was not reached; the freshness-bound case beside it passes.

## Sources
- The driver's answer 7 to the slice-27 design: "The observer's own loop ... never awaited by the tick."
- SEAM.md §291: "An observation's reads hold no tick † ... while one waits on a held read (§247's `hold`), the engine's ticks and the Release Operator go on."
- The coordinator's ruling relayed with slice 27's cases: "The observer runs off the tick, as already ruled."
- M329 (d)'s second case depends on the same property (a held observation read while ticks and a deploy go on).
