# M2 slice 1: hardening before a backend

**Status:** owner's brief, 2026-10-03, decided by Sean (errata E48 item 1). Governs the first slice of M2. Read with `docs/spec/M1-build-spec.md`, whose roles, rules and corrections to the design stay in force; this document adds only what the slice needs.

## 1. What the slice is

Bucket A of `docs/spec/M2-input-triage.md`: the five entries of `docs/acceptance/reports/M1-not-claimed.md` (class B) that could let unverified or tampered work through a gate, or defeat a person's decision, once a real agent produces real commits. The slice settles each of them with a test and, where the engine does not already behave as required, a build. Nothing else is in the slice. No backend, no isolation work, no new reads, no new decision kind: those are D2's, D3's and bucket B's.

| Entry | Plan rows | Required behaviour (from the plan, D1 and the errata) | Cases, about |
|---|---|---|---|
| A1 | M24 | While a candidate's **nomination marker** has been moved or deleted out of band and the observation is unresolved, that candidate's gates are blocked (`OUT_OF_BAND_CHANGE`, D1 §9.3). The project-level rule for the integration branch is tested; the candidate's own ref is not (`COVERAGE.md` row M24, and the slice-5 note on M24/M40/M44). | 1 |
| A2 | M28 | A Builder's result replayed onto a moved integration branch is **validated again against the protected set in force at integration**, and rejected if it now touches a path that became protected after the run's base (D1 §7.3 validation, §7.5). The tests establish only that the replayed commit holds exactly what it should (`COVERAGE.md` row M28, "a rebased tree that fails validation"). | 1 |
| A3 | M45 to M55, part | A decision's answer is **refused as out of date** when any fact its preview rested on has changed, for the facts not yet tested on the four kinds that change what the engine may do to code: the three protected-check corrections (`check_correction_tightening`, `check_correction_loosening`, `check_correction_unclassifiable`: the proposal's content and the approved specification) and the policy widening (its governed fields). `COVERAGE.md` rows M45 to M55, the note on untested preview facts. | about 4 |
| A4 | M49 to M55 | The answer **`reject`** leaves things as they were and closes the question, for all seven kinds that offer it: the policy widening, a finding's disposition, a severity lowering, a finding exclusion, and the three protected-check corrections. "As they were" means: the proposal, finding, policy or exclusion is in the state it was in before the decision was raised, or in an explicit rejected state the design names; no part of the change is applied; the same question is not raised again at once; the decision is closed with the answer recorded. | 7 |
| A5 | M41 | A check result recorded for an earlier candidate is **not reused** for a later candidate when the protected checks were changed (a protected application landed) between the two; the gate of the later candidate sees the check as not established, never as passed on the old result (D1 §7.9 "invalidates dependent evaluations and results", §9). | 1 |

About 14 cases. Each is the fewest cases that establish the entry (E31). A case that passes on the accepted engine is still written: it turns an unclaimed behaviour into a claimed one, which is the point of the slice.

## 2. What governs

In this order where they disagree: the errata E36 to E48; `docs/spec/M1-build-spec.md` section 4 (corrections to the design); `docs/design/sdlc-design-D1-resolution-note.md`; `docs/design/sdlc-design-D1-engine-core.md`; the acceptance plan rows named above; `packages/engine/test/acceptance/harness/SEAM.md` (the test contract, sections 1 to 98, which a new case extends and never contradicts without saying so).

Where a design document is silent on an A4 "reject" outcome, the Verifier pins the least surprising reading (the thing is as it was; the decision is closed) and marks it "not pinned" in the seam where the detail does not matter. A reading that would need a new decision kind, a new state or a new route is not a test: it is a question for Sean in the Verifier's report.

## 3. Procedure

The M1 procedure under E31 and E40, unchanged:

1. **Verifier** (branch `verify/m2-s1`) writes the cases: into the existing row files where a row file exists, or into new files listed under a new slice `"8"` in `manifest.json`. Updates `COVERAGE.md` (each case moves from "not written" to its file) and `SEAM.md` (new sections after §98), and runs each touched file once against the accepted engine, reporting what passes and what fails and at which assertion. Reports to the driver: the cases, the files, the run results, and any question for Sean.
2. **Builder** (branch `build/m2-s1`, started at the same time, messaged when the tests reach `main`) makes the failing cases pass under the design, with unit tests where the design fixes a rule the acceptance test only samples. The Builder never edits an acceptance test; an objection goes in `docs/acceptance/objections/`.
3. **One Reviewer pass** over the merged slice, reproducing anything it calls serious by running the engine. A confirmed serious finding gets one Verifier case and one Builder fix, judged by the tests, no second review (E31).
4. The driver reruns `node scripts/run-tests.mjs acceptance --slice 8` (the whole suite), `npm run test:unit` and the boundary check before each merge, and records the slice in the errata.

## 4. Done

- The 14 or so cases exist, are listed in `COVERAGE.md` against their files, and pass with the whole suite (`npm test`, exit 0) on the merged engine.
- `docs/acceptance/reports/M1-not-claimed.md` gains a note that the five entries are now claimed and by which cases; the counts are updated.
- Every design question the slice raised is in the errata as a decision of Sean's or a recorded deferral.
- Scope unchanged: anything found that is not one of the five entries is recorded, not built (E40).
