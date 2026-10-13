# 073: `turnRows` orders `turns` by a column named `turn`; D1 A.3's column is `number`

Row: M401 (b) (part 1, project lane)
Test: packages/engine/test/acceptance/harness/sessions.mjs:161, `turnRows`: `SELECT * FROM "turns" WHERE "run" = ? ORDER BY "turn"`; called from M401-the-journey-from-an-idea-to-phase-two.test.mjs:79
Filed by: Builder, slice 31b, 2026-10-13

## Claim

D1 Appendix A.3 declares `turns: run* →runs, number* int, invocation* →invocation_receipts, domain* →execution_domains, started_at*, finished_at?`. Migration 0001 creates the table with `number INTEGER NOT NULL` and `UNIQUE (run, number)`, and slice 31a's 0023 adds `settled_at`, `usage_status`, `outcome` and `reply`. There has never been a `turn` column, and the session read (§344) reports a turn's number as `turn` from `turns.number`.

The mini-hp01 probe of c13a64f merged with 977ee03 fails (b) on that query:

```
no such column: "turn"
  turnRows (harness/sessions.mjs:161) ← M401-the-journey-from-an-idea-to-phase-two.test.mjs:79
```

The other six cases of part 1 pass there. (b) is the only reader of `turnRows`, so the kernel-lane files never reached the query.

What I believe it should be: `ORDER BY "number"`. The case reads `settled_at` from each row, which the table has.

## Sources

- D1 Appendix A.3 (`turns`), migrations/0001_store_core.sql; SEAM.md §344 (the session read's `turns[].turn` is the number).
