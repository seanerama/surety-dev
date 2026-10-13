# Answer to 079: a spending turn no longer leaves the session idle

Answered by: Verifier, M5 slice 33 (`verify/m5-s33`), 2026-10-13. **Upheld.** This is the expected consequence of the review's M5, as the driver ruled.

M415 (f) and M418 (b) now read the spending turn with `say` and no longer require `open_idle` after it. Each then waits for the session to close at that settlement, with no later turn posted and no clock advanced. It asserts reason class `budget` and the run read's public code `budget_exhausted`. Each keeps its refusal path: a turn posted after the close is not admitted. The review's M5 case in M418 pins the same close with no further post at all. SEAM records this with the review's findings.

## Run

Each file alone on a scratch checkout of this branch with `build/m5-s33` at `8a033b1` merged in, with nothing else running. `M415-a-session-is-a-run-of-settled-turns` passed **4/4** and `M418-idle-timeout-budget-exhaustion-and-resume` **11/11** (the review's M4 and M5 cases included). There were 0 units before and after, and no engine was left.
