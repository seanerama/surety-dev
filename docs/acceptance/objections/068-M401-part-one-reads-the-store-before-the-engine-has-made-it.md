# 068: M401 part 1's engine reads the store before any engine has created it

Row: M401 (a) to (g), part 1 on the project lane
Test: packages/engine/test/acceptance/harness/journey/project.mjs, `journeyEngine`, `start()`: `const previous = activeQualification(fx.home)?.id ?? null;` runs before the first `fx.start()`
Filed by: Builder, slice 31b, 2026-10-12

## Claim

`journeyEngine(t, guard, { lane: 'project' })` makes the fixture with `sandboxEngine(t, { start: false })`. Its first `start()` calls `activeQualification(fx.home)` to name the qualification row it must not take for this start's self-test. That call opens the home's store before any engine has run in the home, so the store file does not exist yet. better-sqlite3 refuses to open it, and the suite's `before` hook fails in about 100 ms:

```
error: 'unable to open database file'
code: 'SQLITE_CANTOPEN'
  openStore (harness/store.mjs:12:14)
  withStore (harness/store.mjs:20:14)
  activeQualification (harness/checks/execution.mjs:58:15)
  start (harness/journey/project.mjs:66:22)
  journeyEngine (harness/journey/project.mjs:70:9)
```

On this branch (e24f4e2) all 7 tests of `M401-the-journey-from-an-idea-to-phase-two` were cancelled by that hook failure. Nothing launched: no engine, no domain, no unit, and 0 `surety-*` units before and after. Part 2 does not hit this, because its seed starts on the kernel lane (`fx.startKernel()`), and it calls `activeQualification` only in `toProjectLane`, after the store exists.

The fix is the harness's: read the previous qualification as `null` when the home has no store yet (for example, check that the store file exists first, or catch `SQLITE_CANTOPEN` on the first start). No engine change makes the store exist before the engine starts.

I have not run part 2. §356 has the driver start the first project-lane run of the slice, and this run of part 1 ended in the harness before any project-lane effect.

## Sources

- SEAM.md §356 (the project-lane files; the driver starts the first run), §357.
- harness/journey/project.mjs, harness/checks/execution.mjs `activeQualification`.
