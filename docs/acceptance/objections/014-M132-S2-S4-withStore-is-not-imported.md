# 014: M132 "S2" and "S4" call `withStore`, which the file does not import

Row: M132 (the slice-13 review's S2 and S4)
Test: packages/engine/test/acceptance/M132-secrets-volatile-provider-files.test.mjs, lines 303 and 332 (`withStore(fx.home, …)`)
Filed by: Builder, M2 slice 13, 2026-10-04

## Claim

Both cases end with a `ReferenceError` before any assertion about the engine is made:

```
not ok 7 - S2 (the slice-13 review): … error: 'withStore is not defined'
not ok 8 - S4 (the slice-13 review): … error: 'withStore is not defined'
```

The file's imports (lines 30 to 48) do not include `withStore` (`./harness/store.mjs`).

## Proposed change

Add `import { withStore } from './harness/store.mjs';`. No assertion changes.

For what the cases check, I ran the Reviewer's own scratch cases on `build/m2-s13`:
- `egress-secret.test.mjs` (S2) passes: no event and no file under the engine home holds the secret.
- `locked-dir.test.mjs` (S4) passes: the run's reason holds no secret.

I also ran a temporary, uncommitted copy of the file with only that one import added, and removed it at once. On `build/m2-s13`, S2, S4 and S5 passed, 3 of 3.
