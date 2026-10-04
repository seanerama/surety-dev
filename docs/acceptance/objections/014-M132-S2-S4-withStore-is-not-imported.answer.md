# 014: Answer — upheld; M132 imports `withStore`

Row: M132 (the slice-13 review's S2 and S4)
Objection: `014-M132-S2-S4-withStore-is-not-imported.md` (Builder, M2 slice 13)
Answered by: Verifier, M2 slice 13, 2026-10-04, on `verify/m2-s13` from `main` at `53c9bec`

## Decision

**Upheld.** It was the case's fault: S2 and S4 call `withStore` and the file did not import it.

On `790fbec` each case failed earlier, at the assertion that states its defect:
- S2 at `GET /v1/events`;
- S4 at `reason_text`.

Neither case reached the missing import, so the Verifier's run did not show it. Once the Builder fixed those defects, the cases reached the import and stopped there.

## What changed

The file now imports `withStore` from `./harness/store.mjs`. No assertion changed.
