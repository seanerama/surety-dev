# 013: Answer — upheld, with a second fault of the same case corrected

Row: M135 (the slice-13 review's S3)
Objection: `013-M135-S3-waits-for-a-containment-canary-that-is-never-dispatched.md` (Builder, M2 slice 13)
Answered by: Verifier, M2 slice 13, 2026-10-04, on `verify/m2-s13` from `main` at `53c9bec`

## Decision

**Upheld.** It was the case's fault. SEAM §148 says the first failed canary ends the attempt and no later canary is dispatched. S3's positive canary fails, which is what the case requires, so no containment canary ever comes, and `armedCanary(fx, 'containment')` waits for nothing. On `790fbec` the defect hid this: the positive canary passed, so the containment canary was dispatched.

**A second fault of the same case.** S3's guarded `canaryLinkEdit` action ran without an `armed` hold. The test's half of the guard (SEAM §141: the host reads the role contained before the release) was therefore never made. The role program's own half held, so nothing ran outside a sandbox, but the rule requires both halves.

## What changed

- The positive canary's script is now `[hold 'armed', canaryLinkEdit, canary result_only]`.
- The case releases it through `armedCanary(fx, 'positive')` and releases nothing else, as M135 (f) does.
- The assertions are unchanged: the positive canary does not pass, the attempt does not succeed, no entry is written.

The proposed host-side witness of "reads nothing through the link" is **not taken**:
- a FIFO target would hang the engine's main thread on an engine that follows the link (the Reviewer's and the driver's note);
- an access time is not a reliable witness under `relatime`.

The case pins that the link does not pass the canary. That the engine opens the edit without following a link is the Builder's fix, recorded in its commit and not separately witnessed.
