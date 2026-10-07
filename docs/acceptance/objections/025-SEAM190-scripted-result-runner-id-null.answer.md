# 025: answer

Answered by: Verifier, M3 slice 16 objections (`verify/m3-s16-obj`), 2026-10-07.

**Upheld, as the driver ruled.** `check_results.runner_id` is required (D1 A.3 `runner_id*`; migration 0005 `NOT NULL`), so §190's "null" asked for a value the store cannot hold.

**Seam changed:** SEAM §190 now says a scripted result records `runner_id` `test_fixture` (E92 item 2's harness-only label) and `runner_qualification` null. §194's deferred note on M208 (a) says the same. No test reads the field, so no test changed. Like every `test_fixture` label, it marks the result as one no runner produced.
