# 234: M07 and M73 compare against the Verifier's contract fixtures, which do not yet hold the additions the owner's rulings of 2026-11-26 require

Rows: M07 (`M07-project-bootstrap-and-policy.test.mjs`), M73 (`M73-executable-contract.test.mjs`)
Fixtures: `packages/engine/test/acceptance/contract/config.json` (`CONTRACT.project`), `packages/engine/test/acceptance/harness/decisions.mjs` (`DECISIONS.kinds`)
Filed by: Builder, branch build/item57-brief-delegation (DECISIONS item 57, the owner's rulings D1 to D8 and WO1 Q1 of 2026-11-26), commit 1 ("0053: ..."), 2026-11-26
For: the Verifier of rows M638 and M644 (fixture additions; no assertion changes, no design question)

## Claim

Both files are right; their expectations are read from the Verifier's fixtures ("Tests read expectations from this file, never from the engine"), and the fixtures predate two additions the rulings make, as the slice plan (`SLICE-PLAN-rulings.md` §B "Migration 0053", "S5 / D4", "D8"; Builder A's brief item 3) settles them:

1. D4: a new decision kind `deployment_target_approval` (a deployment to an environment other than the one the approved brief names; enabled, manifest `iteration, candidate, candidate_revision, environment, environment_name, adapter, adapter_version, port, exposure_note, config, config_identity, brief_target, origin, consequence, policy_revision`, target 14,400 s as `rollout_partial`).
2. D8: four project keys, the opt-in preparation allowance: `prototype_preparation_allowance` (enum `off`, `per_iteration`; default `off`; widening `later`), `prototype_preparation_model` (`<provider>/<model>`, type `provider_model`, no default; any change widens while the allowance is granted), `prototype_preparation_run_tokens` (1,500,000 within 10,000 to 50,000,000, integer; raising widens), `prototype_preparation_usd_estimated` (15 within 0 to 10,000, not an integer; raising widens).

## Evidence (this branch's commit 1, `node --test`, scripted only)

- `M73-executable-contract.test.mjs`: 12 tests, 11 pass, 1 fail: "the contract holds the accepted corrections …: no other decision kind is enabled in M1" (`deployment_target_approval` enabled, not in `DECISIONS.kinds`).
- `M07-project-bootstrap-and-policy.test.mjs`: 5 tests, 3 pass, 2 fail: "the effective policy is the schema defaults …" and "… the schema defaults are in effect" (the effective policy holds `prototype_preparation_allowance: 'off'`, `prototype_preparation_run_tokens: 1500000`, `prototype_preparation_usd_estimated: 15`; `prototype_preparation_model` has no default and is absent, as every key without one).
- Unchanged and passing on the same commit: M05-migrations 6/6, M07-closed-configuration 18/18, M108-widening-settings 3/3, M49-policy-widening-manifest 5/5, M47-stop-confirm-manifest 3/3.

## Proposed correction (the Verifier's files)

- `harness/decisions.mjs`: `deployment_target_approval` among `DECISIONS.kinds`, with its manifest keys and target as above.
- `contract/config.json`: the four D8 keys under `project`, with defaults, ranges and widening as above, and a sentence in `$comment` citing DECISIONS item 57 (D8).
