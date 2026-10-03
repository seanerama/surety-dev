# M2 slice 2: a first real project is usable and legible

**Status:** owner's brief, 2026-10-03, drafted by the driver under Sean's delegation after slice 1 merged (errata E52). Scope is bucket B of `docs/spec/M2-input-triage.md`, which Sean confirmed as M2's (E48 item 1: "Bucket B follows in M2 proper in the triage's order"). Governed as slice 1 was: `docs/spec/M1-build-spec.md` for roles and rules, `docs/spec/M2-slice-1-hardening.md` for the procedure, this document for what the slice is. Nothing here depends on D2; the slice can be built while D2 is cross-reviewed.

## 1. What the slice is

The six entries of bucket B: behaviours a person driving a first real project would meet, none a gate-integrity risk. Each is settled with a test and, where the engine does not already behave as required, a build. In the triage's order:

| Entry | Plan rows | Required behaviour | Cases, about |
|---|---|---|---|
| B1 | M45 to M55, rest | The remaining preview facts make an answer **stale** when changed: for a blocked item (`blocker`) its evidence and its stored continuation; for a finding (`finding_disposition`, `severity_lower`, `finding_applicability_exclusion`) its status, its evidence and its scope; for an exclusion, the candidate's ancestry. The `COVERAGE.md` note under rows M45 to M55 lists them. | about 7 |
| B2 | M25, M46 | The answer **`adopt`** to a checkout observation (edits found in the developer's checkout of the integration branch) takes those edits as the new starting point: they are committed by the engine as an out-of-band revision, the branch moves to include them, the observation is resolved, and the project dispatches again. Today the answer is offered and refused 501. D1 §7.6 and §7.8 govern; "as the new starting point" means the next run's base includes them, and nothing of the developer's edits is lost or duplicated. | 2 |
| B3 | M70 | The project's **one-line status** shows `refused` when the repository cannot be read, when an out-of-band change is unresolved, and when the store fails; `unknown` when the status cannot be computed. Rows M24, M25 and M61 pin what those states are; the status line must name the cause. | 3 or 4 |
| B4 | M70 | The remaining **reads** D1 §11.3 lists: a project's git operations (`GET /v1/projects/:p/operations`, each with its kind, state, intent and attempts, pending and blocked ones included), one decision by its identifier (`GET /v1/projects/:p/decisions/:d`, the same shape as the list's item with its preview and options), and the environments as a route of their own (`GET /v1/projects/:p/environments`). Reads evaluate nothing. One case each, in the manner of E47. | 3 |
| B5 | M61 | A usage observation the engine still cannot record after the bounded retry **stops the run** as a run whose budget cannot be read is stopped, and marks the run's usage incomplete (E37 item 3, decided; untested). One case with a store that keeps failing for that write. | 1 |
| B6 | M15 | A git **commit or branch update that overruns its time limit** while the engine runs is recorded with an unknown result and blocks the project until the journal has established what git did (D1 §7.5, §7.10). Needs the harness to hold only git writes; the recovery side is tested. | 1 |

About 17 cases. Fewest cases per entry (E31). A case that passes on the merged engine is still written.

## 2. What governs

As slice 1 section 2: errata E36 to E52; the build spec section 4; the resolution note; D1; the plan rows; `SEAM.md` §§1 to 104, extended, never contradicted without saying so. For B2 the Verifier pins the least surprising reading of "adopt" where D1 is silent (the edits become one engine-made commit on the integration branch, attributed as out-of-band, with the developer's checkout left as it was) and lists any reading that would need a new state, route or field as a question for Sean. For B4 the Verifier fixes the route shapes in the seam, as it did for the work and gate reads (§98), with the fewest fields a person needs.

## 3. Procedure

Slice 1's, unchanged: Verifier on `verify/m2-s2` (new files under manifest slice `"9"`, or cases in existing row files), Builder on `build/m2-s2` started at the same time and messaged when the cases reach `main`, one Reviewer pass, one case and one fix per confirmed serious finding, the driver's full rerun (`--slice 9`) before each merge, every decision in the errata.

## 4. Done

- The cases exist, are in `COVERAGE.md`, and pass with the whole suite on the merged engine.
- `M1-not-claimed.md` says the six entries are claimed and by which cases; the counts are updated. Class B then holds only bucket C's entries.
- Every design question the slice raised is in the errata.
- Nothing outside the six entries is built (E40), except a review finding confirmed by running (E31).
