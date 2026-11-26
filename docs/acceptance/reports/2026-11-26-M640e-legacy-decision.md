# M640 (e) as amended: a legacy decision in the decision read, the list and the receipt (slice 50, kernel lane)

Verifier, item 62, 2026-11-26. Branch `verify/item62-legacy-answers` on base 48bec481. The contract is row M640 (e) as amended on the driver's companion c9e7bccc (M7 plan §3j, the text after "amended 2026-11-26"); that row text is not on this branch. Files ran with `node --test` after `npm run build`. Scripted providers only. TMPDIR was private (/tmp/i62v).

## What changed

`packages/engine/test/acceptance/M640-the-brief-the-receipt-and-the-delegation-record.test.mjs`. Tests (a) to (d) are unchanged, apart from one thing: the preparation answer now carries a note. The old single (e) test is now three tests:

1. **The legacy answer in the single decision read.** The read serves its option, note, actor kind (`human`), `at` and `consumed_at` exactly as stored, with `delegation: null, basis: 'not_recorded'` added to the answer. Nothing in the read is `performed_by` owner or an agent.
2. **The decisions list and the receipt.** Whatever the list serves of the decision agrees with the read. The receipt's owner_answers entry serves the recorded option and `consumed_at`, with `delegation: null, basis: 'not_recorded'`. `{delegation, basis}` is deep-equal between the read and the receipt. No owner click is inferred.
3. **The post-0053 answers.** A plain answer (the check correction) serves `{performed_by: 'owner'}` with `basis: 'recorded'`. The delegated brief answer serves its stored delegation with `basis: 'recorded'`. The decision read and the receipt agree on each. Only the legacy answer is `not_recorded`.

## The legacy row: how it was made

No store written by a pre-0053 engine is among this tree's fixtures. The contract fixtures of 0053 (objection 234) are JSON contract files, and the test tree holds no `.db`. So the row's second method is used:

1. This engine records the preparation answer: a plain answer with a note.
2. The engine is stopped.
3. Through better-sqlite3, `delegation` is removed from that one `decisions.answer` (`json_remove`) and that one `approvals.delegation` is set to NULL. This is what migration 0053 leaves on every earlier row.
4. Both rows are read before and after the write. The test asserts every other column is unchanged and that the stored answer is exactly `{option, note, actor, at}`.
5. The engine is started again.

This is the file's only store write.

## Readings

- **"added":** `delegation` and `basis` are keys of the served `answer`, as they are keys of a receipt entry.
- **"timestamp":** the answer's `at` and the decision's `consumed_at`. The receipt serves `consumed_at`.
- **"the decisions list":** GET …/decisions, which lists only open decisions. On both trees it serves no entry for the answered legacy decision, so that check holds vacuously: the list can serve no performer for it.

## Results

| Tree | File | Result |
|---|---|---|
| base 48bec481 + b56a11fa | M640 | 4/7. All three (e) tests fail. (e1): the read's answer is `{option, note, actor, at}` with no delegation or basis. (e2): `{delegation, basis}` is undefined/undefined in the read but null/`not_recorded` in the receipt. (e3): the plain answer's read has `delegation {performed_by: owner}` but no `basis`. (a) to (d) pass. |
| tmp/i62v-on-fix c39a2638 (= b56a11fa + Builder 8d63a1a9) | M640 | 7/7, three runs |
| same | M635 / M641 / M642 | 5/5 / 5/5 / 6/7 first run, then 7/7 in 12 reruns |
| same | M636 / M637 / M638 / M639 / M643 / M644 / M645 / M646 (kernel) | 10/10 / 7/7 / 6/6 / 7/7 / 7/7 / 7/7 / 6/6 / 10/10, once each |

Sandbox files of slice 50 (M611, M613, M625, M646 print) were not run.

**M642 unknown:** one failure in 13 runs. The failing case's name and output were not captured; the loop kept counts only. M642 does not read decisions.

No objection was filed. No assertion was weakened.
