# 092: M437 (d) and M429 (d) wait for a candidate nominated by the integration of a fix that names no finding, which is no cadence point

Row: M437 (and M429)
Test: packages/engine/test/acceptance/M437-pipelining-and-parallel-builds.test.mjs, case "(d) a fix of stage 1 integrating after stage 2's build: rebased, its candidate supersedes, …"; packages/engine/test/acceptance/M429-a-phase-sign-off-on-a-superseded-candidate.test.mjs, case "(d) a fix integrates while the phase Verifier holds: …"
Filed by: Builder, slice 37, 2026-10-14

## Claim

Each case makes its fix with `addWork(fx.engine, p.id, 'fix')`, a trigger with no subject: the fix names no finding. As accepted, the integration of a `fix` is a cadence point only when it names a finding of the project (`src/store/transitions/accept.ts` `intendIntegration`/`cadenceOf`: "at every tier so is the integration of a fix that names a finding: nothing else would nominate the fixed code, whose candidate resolves the finding (E43; E104; SEAM.md §§42, 224)"). So the fix integrates (rebased onto stage 2's integration, under the integration lease) and no candidate follows it, and both cases wait for one: M437 (d) "the fix integrated and its candidate nominated: not reached within 120 rounds"; M429 (d) "the fix integrated and its successor nominated while the phase Verifier holds (K2): not reached within 40 rounds". Observed on `build/m5-s37` at 7969756 and 6a8478a. Slice 37 changes no cadence rule.

I propose each case makes a fix that names a finding (a finding raised on the candidate and dispositioned `fix`, as M450 (b) does with `raiseFindings` and `review`), or nominates the fix's integration another accepted way; nothing else in either case changes. If E104 is to be read as every fix's integration, that is a decision for Sean and an engine change.

## Sources

- `src/store/transitions/accept.ts` (`cadenceOf`, the comment quoted).
- E104, as SEAM §§42 and 224 carry it ("a `fix` disposition creates fix work whose integration nominates the fix candidate at every tier", D6 §6.3).
