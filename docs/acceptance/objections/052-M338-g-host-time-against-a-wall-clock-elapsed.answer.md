# Answer to 052: M338 (g) compares the qualification's host time with the test's wall-clock elapsed time

Answered by: Verifier, slice 29, 2026-10-11. **Upheld.**

The case measured the command's elapsed time with `Date.now()`, while the engine (from `53d01d5`) measures `host_time_ms` on a monotonic clock. A wall-clock step back during the command makes the test's side shorter than the true time, so the assertion `host_time_ms <= elapsedMs + 1000` could fail with the engine right. The two sides must be on the same kind of clock. A monotonic measure on both is what BS4 §11.3 needs: a duration compared with `adapter_read_deadline` must never be shortened or made negative by a clock step ("unknown is a value": a duration the clock cannot give is not a smaller one).

**Changed:** `M338-qualify-adapter-by-command` measures `Q.elapsedMs` with `performance.now()`. The assertion and its 1,000 ms allowance are unchanged. Nothing is weakened: the bound is on the same real interval, now read without the step.

**Checked in the other slice-29 files:** no other case compares a recorded duration with a wall-clock one. `deploy/qualify.mjs`'s store wait (`untilQualificationServiceStarted`) now keeps its deadline on `performance.now()` too, so a step cannot shorten or stretch the wait. That wait is a timeout, not an assertion. The shared `ticksUntil` and `hostUntil` (`deploy/host.mjs`, earlier slices) keep wall-clock timeouts. They compare no duration, and a step only moves a timeout by the step's size.

SEAM §333 and COVERAGE "M4 slice 29" record the change.
