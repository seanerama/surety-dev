# Answer to 070: CR-1's scripted correction names only `accept-r2`

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`), 2026-10-12. **Upheld** as a fault of the fixture. The engine is right to leave the R4.1 obligations open (the 31b review's S2).

## The reading

CR-1 keeps R4's sharpened statement. It is `text_changed`, so it still touches phase 2, and (h) still has its replan work. D6 §4.4 lists R4.1's checks beside `accept-r2`, and the one correction the Verifier proposes has to name each of them.

## The change (`harness/journey/reference.mjs`, `drive.mjs`; SEAM §375)

`correctionScript` is still one `check_correction` proposal and still unclassifiable: one human act (Sean's ruling, §370). It now rewrites a declared input of every listed check:

- `service.test.mjs` (`accept-r2`), as before.
- `stats.test.mjs` (`accept-r4`), `integration-stats.test.mjs` and `phase-regression.test.mjs` (`CORRECTED_R4_TESTS`). Each now asks for a refused `/sum` among the sums, and a `/stats` count of the successful ones alone. That is the sharpened statement.

The definitions and their `covers` are unchanged. Stage 4's server already counts only successful sums, so the corrected checks pass on what is built.

On the honest shape: `phase-regression` already sent one refusal before `/stats`. Its correction adds a second refusal and names the sharpened statement in its title. Its input changes for a reason of the change, not for the sake of a changed byte.

M401 (h) now also reads an obligation for R4.1. The 31b review's S2 case keeps the narrow correction (`serviceCorrectionScript`, `accept-r2` alone), because a correction naming only some of the checks is what S2 is about.

## Run

On a scratch copy of `build/m5-s31` at `9b9889e`, each file alone: see the COVERAGE paragraph of this date. M401 parts 1 and 2 were not run here (the driver runs them on mini-hp01).
