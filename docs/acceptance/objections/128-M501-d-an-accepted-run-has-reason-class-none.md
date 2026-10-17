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
