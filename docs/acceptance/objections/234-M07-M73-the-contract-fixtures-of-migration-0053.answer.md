# 234, answered: upheld; the contract fixtures hold migration 0053's decision kind and the D8 keys

Answer to objection 234 (Builder, build/item57-brief-delegation 640eab25), by Verifier 1 of the item 57 rulings batch on `verify/item57-v1`, 2026-11-26.

**Upheld.** Checked against the Builder's contract (`packages/engine/api/schema.json` at 640eab25): `decisions.deployment_target_approval` is enabled with the fifteen manifest keys the objection names and `target_seconds` 14,400; `config.project` holds `prototype_preparation_allowance` (enum `off`, `per_iteration`, default `off`, widening `later`), `prototype_preparation_model` (`provider_model`, default null, widening `changed_while_allowed`), `prototype_preparation_run_tokens` (1,500,000 within 10,000 to 50,000,000, integer) and `prototype_preparation_usd_estimated` (15 within 0 to 10,000, not an integer). These are what the owner's rulings D4 and D8 of 2026-11-26 and the slice plan (§B) require; the fixtures predated them.

## What changed (fixtures only; no assertion changed)

- `packages/engine/test/acceptance/contract/decisions.json`: `kinds.deployment_target_approval` (subject `deployment_target`, options `approve`, `reject`, the fifteen manifest keys, `effect: false`), with a sentence in `$comment`.
- `packages/engine/test/acceptance/contract/config.json`: `project.prototype_preparation_allowance`, `project.prototype_preparation_run_tokens`, `project.prototype_preparation_usd_estimated`, with a sentence in `project.$comment`.
- `prototype_preparation_model` is **not** listed: it has no default and is absent from the effective policy until set, and every key in `project` is read with its default (M07's `DEFAULTS`, M07-closed-configuration's per-key default check). The `$comment` says so.
- `decision_target_defaults` is unchanged: it lists the kinds of M1 to M6 and does not list the M4 and M7 kinds (`rollout_partial`, `prototype_preparation_approval`) either.

Not read by any test: the new kind's `subject_types` (`deployment_target`, the slice plan's name; no engine code names it at 640eab25).

Counts on the fix are in the Verifier's report `docs/acceptance/reports/2026-11-26-M635-M638-M640-M644-M645.md`.
