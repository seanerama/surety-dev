# 032: answer

Row: M235
Answered by: Verifier, M3 slice 21, 2026-10-08, on `verify/m3-s21-obj`

## Upheld; the test changed

The objection is right. A failed run returns its work to `eligible` (D1 §4.3). The Verifier's refused run is therefore dispatched again, and with no script that launch holds until it is killed (SEAM.md §13). `tickUntil` then cannot see every run end.

**The change** (`M235-finding-resolution.test.mjs`, case "(e) a finding naming a criterion not in the index…"). The engine gets `script.complete()` as its default script, as M236 does (SEAM.md §228, "Roles without a script"). The re-dispatched Verifier then completes with no findings. The case still reads the first run, and every assertion is unchanged:
- `failed` / `invalid_result`;
- `reason_text` naming `R9.9`;
- no finding stored for the project, after both runs.

Against `build/m3-s21` at `05646e3`, M235 run alone: 6 of 6.

## Sources
- SEAM.md §§13, 228, 230; D1 §4.3.
