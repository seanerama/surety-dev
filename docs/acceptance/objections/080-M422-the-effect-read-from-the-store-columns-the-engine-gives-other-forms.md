# 080: M422 (b) reads the criteria and the "no adapter" from store columns whose forms are M3's and M4's, not the forms the row names

Row: M422 (b)
Test: packages/engine/test/acceptance/M422-the-spec-approvals-floor.test.mjs, case "(b) the effect: …", lines 99 and 105:
- `assert.deepEqual(row.criteria, r.criteria.map((c) => ({ id: c.id, text: c.text })), …)`, where `row` comes from `requirementsOf` (harness/journey/drive.mjs:176, `SELECT * FROM "requirements"`, the `criteria` column);
- `assert.equal(envs[0].adapter ?? null, null, 'with no adapter')`, where `envs` comes from `environmentsOf` (`SELECT * FROM "environments"`).

Filed by: Builder, slice 34, 2026-10-13

## Claim

The row asks for "`requirements` with criteria text and areas" and "environments by name with no adapter". The engine records both. The case reads them from two columns whose forms were fixed before M5 and which other code reads:

- **`requirements.criteria`** holds the criterion IDs (`["R1.1"]`). It has since D3's index (M233, `registerRequirementIndex`). The coverage primitive, the check definitions' `criterion_unknown` discovery, the scope rule, the gates and `knownCriteria` all read it as a list of IDs. Slice 31 put the criteria with their text beside it, in **`requirements.criteria_text`** (`[{"id": "R1.1", "text": "…"}]`, migration 0023). `GET /v1/projects/:p/spec` serves that form as `criteria: [{id, text}]`, which is SEAM §346's contract for the spec read. Rewriting `criteria` into objects would break every one of those readers. The case should read `criteria_text`, or `GET …/spec`'s `requirements[].criteria`.
- **`environments.adapter`** is `NOT NULL` (migration 0005, M4). An environment recorded from TPL §7 with no adapter carries `'none'`, slice 31's value, and `GET …/spec` serves it as `adapter: "none"`. `adapter ?? null` can never be `null`. The case should accept `'none'` as "no adapter". The alternative is a migration rebuilding `environments` with a nullable adapter, which every M4 deployment reader would then have to treat as unknown. The row does not need that.

Everything else in (b) holds on `build/m5-s34`. I ran a scratch copy of the case, outside the acceptance tree, with only these two reads changed: the first to `criteria_text`, the second to `'none'`. It passes. That covers the intent `done` before the 200, the engine's commit on the checkpoint, the §11 row, `git_blob` the committed blob, the save's digest, modules, `spec_ready`, `spec_evidence_generation` 1 and one `baseline.spec_approved`.

## Sources

- M5 plan, M422 (b): "`spec_revisions` 1 with `git_blob` and `semantic_digest`, `requirements` with criteria text and areas, `modules` from TPL §6, environments by name with no adapter".
- SEAM.md §346: "`GET /v1/projects/:p/spec` † → `{… "requirements": [{key, text, criteria: [{id, text}], sensitive_areas, assigned_phase, status, human_test}], "modules": [...], "environments": [{name, adapter}], …}`".
- migrations/0005_protected_gates_decisions.sql, `environments`: `adapter TEXT NOT NULL`.
- migrations/0023_sessions_and_planning.sql: `ALTER TABLE requirements ADD COLUMN criteria_text TEXT;`.
