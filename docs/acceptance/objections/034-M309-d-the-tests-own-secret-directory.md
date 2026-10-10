# 034: M309's operator's guard reports the test's own secret directory as left

Row: M309
Test: packages/engine/test/acceptance/M309-sealing-modes-and-bounded-preparation.test.mjs, the file's `after` hook (`guard.assertClean()`), through case "(d) m5: a request not authorized, a coalesced request and one refused for config_secrets_changed …"
Filed by: Builder, slice 24, 2026-10-10

## Claim
All twelve cases of the file pass on `build/m4-s24`, but the file fails in its `after` hook:

```
+ [
+   'file left: /tmp/surety-acc-m309-secret-hOgzai'
+ ]
```

Case (d) m5 makes `/tmp/surety-acc-m309-secret-*` with `makeTempDir('m309-secret')` and registers its removal with `shared.context.after(...)`. That removal runs in `shared.cleanup()`, which the file's `after` hook calls only after `guard.assertClean()`. The directory is never passed to `guard.root(dir)`, so the operator's guard reports it as a new `/tmp/surety-*` entry the file left. The engine creates nothing under `/tmp/surety-*`. The test should register the directory with the guard (`guard.root(makeTempDir('m309-secret'))`), or remove it before the guard's after-check.

## Sources
SEAM.md §257, the operator's guard: "a new `/tmp/surety-*` or `/dev/shm/surety*` that is not one of the file's own directories" is a finding; `root(dir)` names "a directory of the file's own under /tmp" (`harness/deploy/host.mjs`, `operatorGuard`).
