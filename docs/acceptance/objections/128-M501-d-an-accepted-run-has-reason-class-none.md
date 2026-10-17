# 128: M501 (d) expects `reason_class` null for an accepted run; the engine records `none`

Row: M501
Test: packages/engine/test/acceptance/M501-the-module-maps-new-fields.test.mjs, case "(d) a Builder's result with asset_bindings (empty) and without: both accepted; an unknown field in a binding refused naming it"
Filed by: Builder, slice 40, 2026-10-17

## Claim

The case asserts an accepted `fix` run ends `['completed', null]`:

```js
assert.deepEqual([a.outcome, a.reason_class], ['completed', null], `with asset_bindings: accepted (${a.reason_text})`);
assert.deepEqual([b.outcome, b.reason_class], ['completed', null], `without: accepted (${b.reason_text})`);
```

Since M1 an accepted run ends with `reason_class` `none`, never null: `runs.reason_class` is a closed enumeration whose "no reason" member is `none` (migration 0001), and the accepted-run assertions of earlier rows read exactly that, for instance:

- M231 (a fix, as here): `assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none'], 'the fixture is live: the fix was accepted …')`;
- M201: `['completed', 'none']`, "the Builder's run was accepted";
- M129, M128, M136, M11: `['completed', 'none']`.

So the two accepted runs of (d) fail on `'none' !== null` while what the case is about holds: both results (with `asset_bindings: []` and without) are accepted, and the third (a binding with the unknown field `colour`) is refused `invalid_result` naming `colour`, which passes. The fix is the test's: `['completed', 'none']`. Changing the engine to record null would break every row above.

## Sources

- migrations/0001_store_core.sql: `runs.reason_class` CHECK (… 'none' …).
- M231, M201, M129: an accepted run is `['completed', 'none']`.

## Verifier's answer

Verifier, `verify/m6-s40b` from `main` `a33c06d`, 2026-10-17. **Upheld; the test is changed.**

`runs.reason_class` is a closed enumeration. Its "no reason" member is `'none'` (`migrations/0001_store_core.sql`: `CHECK (reason_class IN (…, 'recovered', 'none'))`). Every accepted row that reads an accepted run reads `['completed', 'none']`: M201 (three files), M231, M130, M205, M15, M223 and others. The case's `null` was the Verifier's slip. It is not a reading of D7 or B.17, neither of which says anything about the reason of an accepted run.

**The change.** The two accepted runs of (d) now assert `['completed', 'none']`. The third, a binding with the unknown field `colour`, still asserts `['failed', 'invalid_result']` naming `colour`. Nothing else of M501 changed.

**Run** against the Builder's engine (a scratch worktree of `231b6d1`, `TMPDIR=/tmp/v40b`, the file alone): **M501 15/15**. SEAM §530.

## Sources

- `migrations/0001_store_core.sql`, `runs.reason_class`.
- M231 (`scope-modules-tier-and-cadence`), M201 (`check-journey-path-one`, `source-symlink-refused`, `materialization-is-the-revision`), M130 (`exit-classes`): `['completed', 'none']`.
