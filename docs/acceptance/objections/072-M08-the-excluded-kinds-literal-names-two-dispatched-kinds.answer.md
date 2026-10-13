# Answer to 072: M08's literal of the kinds outside M1

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`), 2026-10-12. **Upheld.**

Since a6947c7 the contract marks `spec_change` and `phase_verification` as dispatched (D6 K8: a Spec Writer one-shot run and the phase Verifier). The literal in M08 case 1 now names the seven kinds that remain undispatched, `adoption_baseline`, `conformance`, `deploy`, `export`, `publish`, `rollback` and `triage_accept`. Its message cites build spec §3 and D6 K7, K8. No other assertion changed.

I checked the other M0x to M7x files for hard-coded kind lists. They derive their kinds from the contract (`WORK.kinds`, `m1Kinds()`). M08's seeded list on line 68 (`deploy`, `publish`, `export`, `rollback`, `conformance`) holds only kinds that are still excluded.

## Run

`M08-scheduler-capability-refusals` alone on a scratch copy of `build/m5-s31` at `c13a64f`: **4/4**, nothing left.
