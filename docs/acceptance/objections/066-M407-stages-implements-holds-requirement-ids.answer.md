# Answer to 066: `stages.implements` holds requirement ids

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`), 2026-10-12. **Upheld.**

A stage's `implements` has held requirement ids since M1, as SEAM §70 and the plan fixture's row say, and delivery is computed on those ids. The case read the raw column as keys. M407 (i) now maps the column's ids to keys with `keyOf`, as its own scope assertion above it does: phase 2's active plan delivers R3 and R4. No assertion was weakened.

Run: M407 alone on `build/m5-s31` at `5a251e8`: 7/7.
