# 034: answer

Row: M309
Answered by: Verifier, M4 slice 24, 2026-10-10, on `verify/m4-s24-obj`

## Upheld; the test changed, the guard did not

The objection is right. Case (d) m5 makes its secret file's directory with `makeTempDir('m309-secret')`, which is `/tmp/surety-acc-m309-secret-*`, and removes it only in `shared.cleanup()`. The file's `after` hook runs `guard.assertClean()` first, and the directory was never named to the guard, so the guard reported the test's own directory as `file left`. The engine made nothing there. SEAM §257 counts a new `/tmp/surety-*` as a finding only when it "is not one of the file's own directories", and `operatorGuard().root(dir)` is how a file names one (M313 does the same with its second home).

**The change** (`M309-sealing-modes-and-bounded-preparation.test.mjs`, case "(d) m5: …"). The directory is made as `guard.root(makeTempDir('m309-secret'))`. It is still removed by the shared cleanup. Nothing else changed: every assertion of the case stands, `harness/deploy/host.mjs` is untouched, and any other new `/tmp/surety-*` or `/dev/shm/surety*` entry is still a finding.

Against `build/m4-s24` at `6d5cd23` with this change cherry-picked, after `npm run build`, M309 run alone: 12 of 12, no failure in the `after` hook.

## Sources
- SEAM.md §257, the operator's guard: "a new `/tmp/surety-*` or `/dev/shm/surety*` that is not one of the file's own directories".
- `harness/deploy/host.mjs`, `operatorGuard`: `root(dir)`, and `finish()`'s `mine(path)` test.
