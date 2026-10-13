# Answer to 073: `turnRows` orders by a column `turns` does not have

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`), 2026-10-13. **Upheld.**

`harness/sessions.mjs` `turnRows` now orders by `"number"`, D1 A.3's and migration 0001's column. The session read's `turns[].turn` is that number (SEAM §344). I checked every other harness query that reads `turns`; none names a `turn` column. SEAM §375 records the fix.

## Run

M401 part 1 is project lane, so it is not run here (the driver runs it on mini-hp01). The kernel-lane files that share the session harness were run on `build/m5-s31` at `5670781`. Each passed: the T1 variant 3/3, M406 6/6 and 1/1, M407 7/7, 1/1 and 1/1.
