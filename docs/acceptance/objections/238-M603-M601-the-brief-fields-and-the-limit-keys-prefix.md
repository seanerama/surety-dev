# 236: M603 (c) pins the brief's fields at their pre-item-57 list, and M601 (d) counts every `prototype_` project key as a limit key

Rows: M603 (c) (`M603-the-brief.test.mjs`), M601 (d) (`M601-the-mode-and-its-preset.test.mjs`)
Fixtures: `packages/engine/test/acceptance/contract/prototype.json` (`brief_fields`, `engine_fields`), `packages/engine/test/acceptance/harness/prototype.mjs` (`LIMIT_KEYS`)
Filed by: Builder A, branch build/item57-brief-delegation (DECISIONS item 57), 2026-11-26
For: Verifier 1 (fixture corrections; no assertion changes, no design question)

## Claim

1. M640 (a) (the owner's row, ruling D7/S7) has the brief state what one approval authorizes: `required_checks`, `repairs` and the plan bounds beside `target` and `preparation`. The engine's brief therefore has three more engine-filled fields, in this order: `version, prepared_at, app, for, experience, included, objectives, mocked, left_out, assumptions, limitations, constraints, target, models, estimates, preparation, limits, required_checks, repairs, plan_bounds, stop_conditions` (prototype/brief.ts BRIEF_FIELDS; `engine_fields` gains `required_checks, repairs, plan_bounds`, which the model sending is refused like every engine field). `contract/prototype.json` still lists the earlier eighteen. A brief recorded before is served with the three as null and `brief_absent {fields, basis: not_in_brief_version}` beside it (not inside the brief).
2. `LIMIT_KEYS` is every contract project key starting `prototype_`. Ruling D8's four allowance keys (named in Builder A's brief, objection 234's resolution) share the prefix, so M601 (d)'s "five prototype limit keys" counts nine. The five limit keys are unchanged (config/schema.ts PROTOTYPE_LIMIT_KEYS).

## Evidence (this branch at the S7 to Q1 commits, Verifier 1's acceptance tree at 675674e7 copied to a scratch tree, scripted only)

- M603: 5 tests, 4 pass, 1 fail: (c) "exactly the brief's fields, in its order" (the record holds required_checks, repairs, plan_bounds).
- M601: 4 tests, 3 pass, 1 fail: (d) "five prototype limit keys in the contract table" (nine listed).

## Proposed correction (the Verifier's files)

- `contract/prototype.json`: `brief_fields` and `engine_fields` as in (1).
- `harness/prototype.mjs`: `LIMIT_KEYS` the five keys named (or the `prototype_` keys excluding `prototype_preparation_*`).
