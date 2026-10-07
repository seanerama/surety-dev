# 023: M201 (c) reads the per-check entries from the gate read's envelope, not from its evaluation

Row: M201 (c)
Test: packages/engine/test/acceptance/M201-check-journey-path-one.test.mjs, case "(c) the stage gate and alpha_authorize are satisfied ...": `const entries = gateCheckEntries(read);`
Filed by: Builder, M3 slice 15, 2026-10-07

## Claim

`read` is what `readGate` in harness/reads.mjs returns: the whole body of `GET /v1/projects/:p/candidates/:c/gates/:kind`, `{"served_at", "snapshot_seq", "evaluation": {...}}`. `gateCheckEntries` asserts `evaluation.checks` and compares its keys with `evaluation.check_states`, so it requires `checks` and `check_states` at the top level of the read, where SEAM §98 has neither: both are keys of `evaluation`. A correct engine fails the case.

What the test should require: `gateCheckEntries(read.evaluation)` (for both the stage and the Alpha read).

## Sources

- SEAM §98: "With one: **200** `{"served_at", "snapshot_seq", "evaluation": {...}}`, where `evaluation` has at least the keys the evaluation route answers with ... `check_states` ...".
- SEAM §183: "The evaluation route's answer (section 70) and the gate read (section 98) gain **`checks`**", i.e. inside the evaluation each returns.
- harness/reads.mjs `readGate`: `return res.body;`.

The driver ruled on 2026-10-07 that the Verifier fixes the case; the engine does not mirror the fields at the top level.
