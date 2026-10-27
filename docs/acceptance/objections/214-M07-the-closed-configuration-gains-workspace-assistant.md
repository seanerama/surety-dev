# 214: the closed engine configuration gains `workspace_assistant`, which the Verifier's key list does not hold yet

Row: M07, M73
Test: packages/engine/test/acceptance/M07-closed-configuration.test.mjs, case "defaults are inspectable, finite and attributed to their source" ("exactly the closed key set"); packages/engine/test/acceptance/M73-executable-contract.test.mjs, case "the contract holds the accepted corrections, as the Verifier's tables state them: D1's hand-written appendix overrides none" ("the engine configuration keys")
Filed by: Builder, branch build/assistant-usage-account, 2026-10-27

## Claim

Both cases compare the engine's configuration keys with the Verifier's table, `packages/engine/test/acceptance/contract/config.json` (`CONTRACT.engine`). The owner has approved a new engine key, `workspace_assistant`: an object, absent by default, every field required when present and none defaulted (`backend`, `model`, `credential_ref`, `day_limit_billable_tokens`, `turn_limit_billable_tokens`, `turn_deadline_seconds`). The engine now accepts it, shows it on `GET /v1/engine` (`{"value": null, "source": "default"}` when absent) and states it in `api/schema.json`. Both cases fail only on the extra key; every other assertion passes.

The tests are not wrong about what they pin; their table needs the new row. I ask the Verifier to add `workspace_assistant` to `contract/config.json`'s `engine` table with `"default": null` (no `min`/`max`/`default` numbers, so M73's bound loop has nothing to compare), and, if wanted, a WA-cfg row for the block's own refusals (a partial or out-of-range block refused at start, writing nothing; no field defaulted). Until then M07 and M73 each fail exactly one case.

Observed (this branch, each file run alone):
- M07-closed-configuration: 18 tests, 17 pass, 1 fail ("exactly the closed key set": `+ 'workspace_assistant'`).
- M73-executable-contract: 11 tests, 10 pass, 1 fail ("the engine configuration keys": `+ 'workspace_assistant'`).

## Sources

The owner's approval, 2026-10-27 (relayed verbatim in the Builder's brief): "Use Sonnet, 40k tokens per turn and 400k per day as explicit initial configuration, not hidden defaults. … Proceed after B2 integration with the migration, configuration, qualification template and real enablement states."

The assistant design (`usage-account-design-e0303e4.md`, §1.2, "Where the limit lives"): "A new engine `config.json` key, `workspace_assistant`, an object **absent by default** … Fields, **all required, none defaulted** … `GET /v1/engine` shows it with `source: file`."

The design's acceptance rows (§5): "WA-cfg | No block: `unconfigured`, and no real path is reachable. A partial or out-of-range block is refused at start and writes nothing. No field has a default."
