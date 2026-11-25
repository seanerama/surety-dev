# M634: a T1 phase follows the candidate that superseded its nomination

**Status:** DRAFT. The base results are recorded below. The on-fix results are pending until the driver passes on the Builder's commit.
**Row:** M7 plan §3i M634 (DECISIONS item 55), kernel lane, slice 49.
**Test:** `packages/engine/test/acceptance/M634-a-t1-phase-follows-the-candidate-that-superseded-its-nomination.test.mjs`, commit `17cadef9` on `verify/m634-phase-follows-superseder`.
**Base:** `1f8ae2de` (engine main `de1334cf` + row M634), built.

## Fixture

- **Journey.** The reference journey at T1 under `autonomy: phase` on the scripted backend (`journey35`, as used in M428 (a) and M406 at T1). Both stages integrate and the phase nominates once.
- **Finding.** The phase candidate's Verifier is the first `verification` launch, scripted. It raises a Low defect naming `R1.1` / `accept-r1` on that candidate.
- **Owner's answer.** T1 queues no review, so the finding is owed to the owner as a `finding_disposition` question (scope `disposition_owed`). The test answers `fix`, as the owner did in production.
- **The fix.** The fix's Builder is the scripted `fix` kind and writes `NOTES.md`. Its integration nominates the superseder by cadence.
- **Check results.** Every check result comes from the scripted boundary, with exit 0.
- **No fixture writes** to the store, and the test files no objection.
- **(c)** The Verifier raises two findings (`R1.1`/`accept-r1` and `R2.1`/`accept-r2`). The owner fixes the first, and then the second once the intermediate candidate exists. The intermediate candidate's check results are withheld at the scripted boundary, so nothing is evaluated on it before the second fix supersedes it. The row's "the intermediate one gets no phase evaluation" requires exactly this timing.
- **(d)** Phase 1's authoring gains a phase-only check, `phase-r1` (gate_kinds `[phase]`, covering R1.1), varied the same way M428 (e) varies the authoring. Without it, phase 1 has no phase-only check, and the row's "no second registration of the phase-only checks" would be vacuous.

## Results on the base (1f8ae2de)

`node --test` run on the file alone, with TMPDIR=/tmp/i55v: **tests 5, pass 1, fail 4** (2 min 19 s).

| Case | Base | What fails |
|---|---|---|
| (b) the stall does not persist | FAIL | "a phase evaluation of the superseding candidate cand_…92MH within 8 ticks after its checks were recorded; none exists". The superseded candidate's latest phase evaluation is `{"outcome":"not_satisfied","stale":0,"reasons":[{"code":"CANDIDATE_SUPERSEDED","subjects":["cand_…92MH"]}]}`. This is the production record of 14:15:59Z. Its two earlier evaluations are FINDING_UNSATISFIED, now stale. |
| (a) completes on the superseder | FAIL | "phase 1 to complete on the superseding candidate …: not reached within 150 rounds". |
| (c) two supersessions | FAIL | Both fixes integrated and the third candidate was nominated, but "phase 1 to complete on the newest candidate …: not reached within 150 rounds". The gate is still read on the first candidate. |
| (d) the nomination exactly once | PASS | There are two candidates (the phase's and the fix's). The phase's revision was nominated once, `nomination_due` is null, `phase-r1` was registered once on the nominated candidate, and on the superseder at most once (0 on the base). |
| (d) M406's effects on the followed candidate | FAIL | "phase 1 to complete on the superseding candidate …: not reached within 150 rounds". |

So the base reproduces the defect: (a), (b), (c) and the completion half of (d) fail, while the first-nomination-once half of (d) passes.

## Results on the fix

Pending (the Builder's `build/phase-follows-superseding-candidate`).

## Boundary check

Pending.
