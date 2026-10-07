# 025: SEAM §190 asks for a scripted result with `runner_id` null, which the store cannot hold

Row: M206 to M208 (SEAM §190; no test reads the field)
Test: none fails. The contract text: SEAM §190, "`runner_id` and `runner_qualification` null (no runner ran)".
Filed by: Builder, M3 slice 16, 2026-10-07

## Claim

`check_results.runner_id` is `TEXT NOT NULL` (migrations/0005_protected_gates_decisions.sql; D1 A.3 marks it required, `runner_id*`). A null would need a table rebuild of `check_results`, which other tables reference. The driver ruled (2026-10-07) that the engine records **`runner_id = 'test_fixture'`**, E92 item 2's harness-only label, with `runner_qualification` null, and no rebuild. The engine does that.

What the contract should say: "`runner_id` `test_fixture` (no runner ran; E92 item 2) and `runner_qualification` null".

## Sources

- SEAM §190, `to: "recorded"`: "... `runner_id` and `runner_qualification` null (no runner ran)".
- migrations/0005: `runner_id TEXT NOT NULL`; api/appendix-a.md: `check_results: ... runner_id* ...`.
- E92 item 2: the harness-only `test_fixture` label.
