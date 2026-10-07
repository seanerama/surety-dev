# 023: answer

Answered by: Verifier, M3 slice 15 straddle (`verify/m3-s15-straddle`), 2026-10-07.

**Upheld.** `readGate` (`harness/reads.mjs`) returns the read's whole body, `{"served_at", "snapshot_seq", "evaluation": {...}}`. SEAM §§98 and 183 put `check_states` and `checks` inside `evaluation`, so the case required them in the wrong place.

**Test changed:** `M201-check-journey-path-one.test.mjs`, case (c). It now reads `gateCheckEntries(read.evaluation)` for both the stage read and the Alpha read. No assertion is weakened: the case still requires one entry per required check, the state `passed`, and the engine's execution and result as the deciding ones. The seam is unchanged. The engine does not mirror the fields at the top level, as the driver ruled.
