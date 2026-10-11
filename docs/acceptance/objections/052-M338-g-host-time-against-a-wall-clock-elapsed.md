# 052: M338 (g) compares the qualification's host time with the test's wall-clock elapsed time, which this host's clock steps back

Row: M338
Test: packages/engine/test/acceptance/M338-qualify-adapter-by-command.test.mjs, case "(g) the host time and each identity read's duration are recorded", assertion "within the command's own elapsed time" (`content.host_time_ms <= Q.elapsedMs + 1000`)
Filed by: Builder, slice 29, 2026-10-11

## Claim

The case measures the command's elapsed time with the wall clock (`Date.now()` before and after `qualifyByCommand`). On this WSL2 host the wall clock steps back by several seconds within a minute while NTP is synchronized. I measured it with a 60 s comparison of `Date.now()` and `performance.now()`: the wall clock lost up to 4,987 ms against the monotonic clock.

A wall-clock duration can therefore be shorter than the real one, or negative. The rerun list on `514f58d` showed this inside the engine: one identity read was recorded with `duration_ms: -2263`.

The build now measures every duration and bound of a qualification on a monotonic clock (`performance.now()`, commit `53d01d5`). That is what BS4 §11.3 needs: a read's duration is compared with `adapter_read_deadline`, and a negative or shortened duration would hide a slow read.

Measured that way, `host_time_ms` (about 25 s) exceeded the test's wall-clock `elapsedMs` by more than its 1,000 ms allowance when the clock stepped back during the command. On `53d01d5`, the case failed only this assertion. The file's other six tests passed, and so did all eight other slice-29 files that run a qualification.

Suggested: measure `Q.elapsedMs` with `performance.now()` in the test, so that both sides are monotonic.

## Sources

- BS4 §11.3: the qualification's identity reads' durations are measured and compared with `adapter_read_deadline`.
- M338 (g): "the qualification's host time and its identity reads' durations … recorded for the report".
- CLAUDE.md, "Unknown is a value": a duration the clock cannot give is not to be reported as a smaller one.
