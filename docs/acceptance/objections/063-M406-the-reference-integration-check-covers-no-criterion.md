# 063: the reference project's `integration` check covers no criterion, so phase 1's authoring cannot be approved

Row: M406, M407, M401 (every journey that applies phase 1's check authoring)
Test: packages/engine/test/acceptance/harness/journey/reference.mjs, `CHECK_DEFS[1]['.surety/checks/defs/integration.json']`
Filed by: Builder, slice 31b, 2026-10-12

## Claim

Phase 1's authoring writes `integration.json` as `{kind: 'integration', command, timeout_s, gate_kinds}`. It has no `origin`, so it is acceptance-origin, and it has no `covers`. D3 §1.3 requires an acceptance-origin check of kind `acceptance`, `integration`, `property` or `failure_recovery` to name at least one criterion. Discovery therefore reports `.surety/checks/defs/integration.json#/covers` as an error.

The `check_correction_unclassifiable` decision's `approve` then carries the blocker `CHECK_DEFINITION_INVALID`, and the harness's answer is refused 409 on every tick. Phase 1 never becomes ready, so no journey passes step 5. On this branch the proposal's classification reads:

```
{"reason":"discovery_error","path":".surety/checks/defs/integration.json#/covers"}
```

What I believe the fixture should hold: give `integration` a criterion it checks, for example `covers: { criteria: ['R2.1'] }` (its program asks `/sum?a=1&b=1` through the service). A developer-origin check would not do: only an acceptance-origin check supplies a kind of T2's inventory (D3 §4.3), and `integration` is one. With that one change on a scratch copy, the journey's authoring is approved and phase 1 goes on. I am checking the rest of 31b on that copy until the fixture changes.

## Sources

- D3 §1.3, the `covers` row: "an acceptance-origin check of kind `acceptance`, `integration`, `property` or `failure_recovery` names at least one criterion".
- src/checks/schema.ts: `COVERING_KINDS = ['acceptance', 'integration', 'property', 'failure_recovery']`, and `/covers` is invalid when such a check names none.
