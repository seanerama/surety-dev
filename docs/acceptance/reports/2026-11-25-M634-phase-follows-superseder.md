# M634: a T1 phase follows the candidate that superseded its nomination

**Status:** final. Base and on-fix results are recorded below.
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

**Tree:** throwaway branch `tmp/m634-on-fix` (not pushed), which is `423a1e9b` + `git merge --no-edit ebc04791` (the Builder's `build/phase-follows-superseding-candidate`) = merge `a44905f3`, rebuilt with `npm run build` (exit 0).

**How the files were run:** `node --test <file>` from `packages/engine`, one file at a time, with TMPDIR=/tmp/i55v. Every file below is kernel or sandbox lane; none is listed under `real` or `exhaust`.

| File | Tests | Pass | Fail | Time |
|---|---|---|---|---|
| M634-a-t1-phase-follows-the-candidate-that-superseded-its-nomination | 5 | 5 | 0 | 30 s |
| M428-the-phase-gate-and-t1-nomination | 5 | 5 | 0 | 57 s |
| M406-phase-completions-effects-once-per-binding | 6 | 6 | 0 | 33 s |
| M406-a-phase-sign-off-before-a-new-protected-version | 1 | 1 | 0 | 11 s |
| M429-a-phase-sign-off-on-a-superseded-candidate | 1 | 1 | 0 | 14 s |
| M429-a-replacement-at-phase-verification | 1 | 1 | 0 | 10 s |
| M429-phase-verification-and-its-sign-off | 4 | 4 | 0 | 40 s |
| M401-the-journey-from-an-idea-to-phase-two | 7 | 7 | 0 | 168 s |
| M401-the-journey-from-phase-two-to-alpha | 5 | 5 | 0 | 245 s |
| M401-the-t1-variant-on-the-scripted-backend | 3 | 3 | 0 | 19 s |
| M27-nomination-identity-and-cadence | 9 | 9 | 0 | 18 s |

All 47 tests across the 11 files pass. The T1 variant of M401 was not in the brief; I added it because it is the other T1 journey.

M634 on the fix:
- (a), (b), (c) and both halves of (d) pass.
- The recorded nomination keeps `nominated_revision` equal to the first revision and names the followed candidate. The Builder records it as `followed_candidate`/`followed_revision`/`followed_at`; the test asserts only that the id is present, since the row names no field.
- The superseded candidate has no phase evaluation after the superseder's nomination.
- In (c), the intermediate candidate has no phase evaluation.
- The phase-only check `phase-r1` is registered exactly once on the nominated candidate and once on the followed candidate.

A first attempt at this run was stopped by me during its first file (M634), after about a minute: it had been started under a monitor whose 30-minute limit would have cut it short. I then checked: no process of that run was left (process scan by cmdline, cwd and environment), and no home was left under /tmp/i55v. The full run above was started afterwards and ran to its end.

## Boundary check

Against `main`, the check names the two owner paths of the driver's companion `1f8ae2de` (this branch's base). Against that base, the Verifier's commits are inside the role's paths:

```
$ node scripts/check-role-boundary.mjs verifier main verify/m634-phase-follows-superseder
verifier boundary: 2 of 5 changed path(s) on verify/m634-phase-follows-superseder are outside the role's paths
  docs/acceptance/sdlc-M7-acceptance-plan.md
  scripts/run-tests.mjs
$ node scripts/check-role-boundary.mjs verifier 1f8ae2de verify/m634-phase-follows-superseder
verifier boundary: 2 changed path(s) on verify/m634-phase-follows-superseder, all inside the role's paths
```
