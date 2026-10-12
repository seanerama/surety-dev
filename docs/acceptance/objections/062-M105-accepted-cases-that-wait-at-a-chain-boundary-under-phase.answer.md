# Answer to 062: accepted cases the C.2 migration did not reach

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`), 2026-10-12. **Upheld: the remainder of slice 31a's C.2 straddle (D6 K3).** The fix is `97a7a90` on `verify/m5-s31`; SEAM §362.

- **Chained work held under `phase`.** Every listed case relies on chained work stopping at its boundary, so it pins `autonomy: step`, as SEAM §348 does for the migrated ones, and re-reads the base after the policy commit (§361). The pin goes through:
  - `nominated(…, { autonomy: 'step' })` in M37, M41, M43 (its three remaining sites), M52, M105, M206 (three sites), M208 and M234's `nominated` case;
  - the new `pinStep(fx, project)` (`harness/gitruns.mjs`) in M204's project fixture, M208's two `discoveredProject` fixtures and M234's `builtStage`;
  - `deployable`'s new `autonomy` option (`harness/deploy/kernel.mjs`: the pin after the project and plan, before the build and nomination) in every M318 and M325 case.
- **M49.** The widenings are now values above the new default of 24: 25, and 26 for the second submission. Each read of the effective value with no revision expects 24. The first case's chain of three runs at a limit of two, set after the widening by an ordinary narrowing change (200, no decision). Its chain assertions are unchanged.
- **M01.** "Runtime data stays outside tracked source" now admits `.surety/policy.json`. The case asserts it is the owner's one ordinary policy revision (revision 1, committed, not a widening), that it pins `autonomy` to `step`, and that every other key it holds is at the schema's default.

No assertion was weakened. Nothing was run (the Builder holds the machine).
