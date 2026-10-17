# 129: M505 (l) reads `checks.covers`, a column the store has never had

Row: M505
Test: packages/engine/test/acceptance/M505-readiness-and-the-batch.test.mjs, case (l) (human tests assigned to a completed phase)
Filed by: Builder, slice 40, 2026-10-17

## Claim

The case's last group of assertions reads:

```js
const covering = rows(fx.home, 'SELECT "covers" FROM "checks" WHERE "project" = ?', p.id).filter(…);
assert.deepEqual(covering, [], 'no check covers a human test');
```

`checks` has no `covers` column: a definition's `covers` (D3 A.4) is stored as the check's `criteria` (and `requirement_ids`), its whole definition in `definition` (migrations 0016 onward; the schema at 0031 lists `id, created_at, project, key, protected_version, kind, required, gate_kinds, tier_floor, definition_path, definition_hash, requirement_ids, sensitive_areas, phase, runner_class, requires, origin, criteria, definition, input_manifest`). The statement is refused, so the case throws before its own assertion; observed: `error: 'no such column: "covers" - should this be a string literal in single-quotes?'`. Every assertion of (l) before that line passes (the batch approved, web's human test assigned to completed phase 1, both human tests `pending`).

The fix is the test's: read `"criteria"` (or `json_extract("definition", '$.covers')`) for the check's covered criteria. No engine change can add the column without a migration no row asks for.

## Sources

- The store's `checks` table (migration 0016 and later; the schema dump at 0031).
- D3 A.4: `covers: {criteria: [...]}` of a check definition.

## Verifier's answer

Verifier, `verify/m6-s40b` from `main` `a33c06d`, 2026-10-17. **Upheld; the test is changed, and made stronger.**

`checks` has no `covers` column (migration 0005's table, plus 0012's `origin`, `criteria`, `definition` and `input_manifest`). A definition's `covers` (D3 A.4) is stored three ways: as `criteria` (criterion ids, `R<n>.<m>`, as M125 reads them), as `requirement_ids`, and whole in `definition`. The case read a column that never existed, so it threw before its own assertion.

**The change.** "No check covers a human test" now reads all three. A check counts as covering if any of these names a human-test requirement's key, or a criterion of it (`<key>.<n>`): its `criteria`; its `requirement_ids`; or its `definition`'s `covers.criteria`. The assertion is that no check of the project does, and a failure lists the covering checks' keys. The old line read one field that does not exist. The new one reads all three places a coverage can be recorded. Everything else of (l) is unchanged.

**Run** against the Builder's engine (a scratch worktree of `231b6d1`, `TMPDIR=/tmp/v40b`, the whole file alone, three times): **14/14, 13/14 and 14/14**. (l) passed in all three runs. (i) passed in all nine whole-file runs made with `settledBatch`: these three, three before `assertSaved` was added, and three instrumented ones. The one failure is (g): its later Designer save was refused 409 `integration_conflict`, which is the engine's (see "M505 (i)" below). SEAM §521.

### M505 (i), the intermittent failure (the coordinator's question)

**Decided: the case waits for the phase authoring to settle before it answers. The row does not expect the re-raise.**

The Builder's account holds. A diagnostic copy of the (g) path (not committed) ran on `231b6d1` eight times. Each time, when the batch was first raised, phase 1's `check_correction_unclassifiable` (the authoring proposal) was already consumed, and the batch's first `spec_change` had already been **invalidated** and raised again. The authoring's application moves the effective protected version, which the batch's `spec_change` manifest binds (M5's `SPEC_CHANGE_KEYS`, `protected_version`; D6 §4.4). If that application lands between the owner's answer and the effect, the effect is refused (D1 §4.6). The `spec_change`'s withdrawal then raises the whole batch again (`reraiseDesignBatch`, D7 §7.4), so (i)'s pump for the approved revision ran out its ticks.

That re-raise is correct behaviour, but row (i) is about the undeterminable assignment, not about it. Of E156 Q3's bindings, the roadmap and plan versions, (j) already pins the re-raise. So nothing is weakened by keeping the race out of (i):
- **`settledBatch(fx, ctx)`** pumps until three things hold, and only then returns the batch open at that moment: no `check_authoring` work of the project is in flight; no question the pump answers is open; and no effect intent of the project's other decisions is `pending` or `executing`.
- The cases that answer the batch for its effect use it: (d) twice, (h), (i), (k), (l). (a), (c), (e), (f), (g) and (j) are unchanged. (j) needs a publication between the raise and the answer, or between the answer and the effect.
- Every assertion of those cases stands as it was. (i) still reads android's `phase` null with a reason on the preview, android's human test unassigned after approval, and web's assigned to phase 1.

**A second source of flakiness, found here, is the engine's.** Across those nine runs, (g) failed in four. Twice it failed as "design_approval stale … [200, false]". Twice, once the save's status was asserted, it failed at the save itself. The answer was accepted because the later Designer save had been **refused** 409 `integration_conflict` ("the integration branch is at …, not at the session's checkpoint base …"): the head had moved during the session, through the authoring's application or a backend stage's integration. Since the save was refused, nothing the approval binds had moved. D7 §3.1 (G12) and SEAM §492 require such a save to be rebased and re-validated, and M532 (c) pins that. The refusal is E147 item 4's, which stays only for Vision, Spec Writer and Architect saves. The test is not changed to avoid it. Instead, every Designer save in M505 now asserts 200 (`assertSaved`), so the failure names its cause. The Builder must rebase a Designer save behind its base; until then, any M505 case whose Designer session overlaps an integration can fail this way. In one instrumented run, (j)'s first case also failed with "the batch to be raised: not reached within 40 ticks". Its cause was not captured, and a refused save in the first Designer session would explain it. SEAM §521.

## Sources

- `migrations/0005_protected_gates_decisions.sql` (`CREATE TABLE checks`), `migrations/0012_check_executions.sql` (`criteria`, `definition`).
- D3 A.4: `covers: {criteria: [...]}`; M125 (`handover`) reads `criteria` as criterion ids.
