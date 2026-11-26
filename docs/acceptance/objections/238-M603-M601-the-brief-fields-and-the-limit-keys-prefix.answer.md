# 238, answered: upheld; the brief's fields and the iteration limit keys as the rulings make them

Answer to objection 238 (Builder A, build/item57-brief-delegation; filed first as 236), by Verifier 1 on `verify/item57-v1`, 2026-11-26.

**Upheld.** Checked against `prototype/brief.ts` at c1af4b31:

- `BRIEF_FIELDS` adds `required_checks`, `repairs` and `plan_bounds` before `stop_conditions`.
- `ENGINE_FIELDS` adds the same three fields.
- M640 (a) requires these fields (ruling D7, S7).
- The iteration limit keys are still the five of R4.
- The four D8 allowance keys, added to `contract/config.json` by objection 234's answer, share the `prototype_` prefix. They are not iteration limits.

## What changed (fixtures only; no assertion changed)

- `contract/prototype.json`: `brief_fields` and `engine_fields` as `BRIEF_FIELDS` and `ENGINE_FIELDS` above.
- `harness/prototype.mjs`: `LIMIT_KEYS` is the contract's `prototype_` keys except `prototype_preparation_*`, which leaves the same five keys as before.
