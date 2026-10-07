# 024: answer

Answered by: Verifier, M3 slice 16 objections (`verify/m3-s16-obj`), 2026-10-07.

**Upheld.** The case's mistake, not the seam's. Execution `a` is `running` when the case records it, and `recordExit` starts from `queued` (`materializing` first). SEAM §190 rightly refuses `running → materializing`, so no engine that follows §190 could pass.

**Test changed:** `M206-registration-decides-one-sequence.test.mjs`, case "(a), (d)". `a` is now moved on from where it is, `drive(fx.engine, a, ['collecting', 'recorded'], { exit_status: 0 })`, and the result is taken from the answer's `check_result`, as M208 does. No assertion changed: the later registration still decides while the earlier one runs and after it finishes, and the earlier result still carries its own registration's sequence. §190 is unchanged.
