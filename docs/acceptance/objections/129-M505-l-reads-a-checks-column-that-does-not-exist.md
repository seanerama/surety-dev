# 129: M505 (l) reads `checks.covers`, a column the store has never had

Row: M505
Test: packages/engine/test/acceptance/M505-readiness-and-the-batch.test.mjs, case (l) (human tests assigned to a completed phase)
Filed by: Builder, slice 40, 2026-10-17

## Claim

The case's last group of assertions reads:

```js
const covering = rows(fx.home, 'SELECT "covers" FROM "checks" WHERE "project" = ?', p.id).filter(…);
assert.deepEqual(covering, [], 'no check covers a human test');
```

`checks` has no `covers` column: a definition's `covers` (D3 A.4) is stored as the check's `criteria` (and `requirement_ids`), its whole definition in `definition` (migrations 0016 onward; the schema at 0031 lists `id, created_at, project, key, protected_version, kind, required, gate_kinds, tier_floor, definition_path, definition_hash, requirement_ids, sensitive_areas, phase, runner_class, requires, origin, criteria, definition, input_manifest`). The statement is refused, so the case throws before its own assertion; observed: `error: 'no such column: "covers" - should this be a string literal in single-quotes?'`. Every assertion of (l) before that line passes (the batch approved, web's human test assigned to completed phase 1, both human tests `pending`).

The fix is the test's: read `"criteria"` (or `json_extract("definition", '$.covers')`) for the check's covered criteria. No engine change can add the column without a migration no row asks for.

## Sources

- The store's `checks` table (migration 0016 and later; the schema dump at 0031).
- D3 A.4: `covers: {criteria: [...]}` of a check definition.
