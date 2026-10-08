# 030: Accepted rows that record a failed result while work is verifying now take Q2's repair, and their scripted Builder holds the run slot

Row: M234 (Q2's reach, SEAM.md §234; COVERAGE.md, "M3 slice 21", the question for Sean), over accepted rows M42, M43, M44, M51, M105, M106, M206, M207, M223
Test: the files and cases listed below
Filed by: Builder, M3 slice 21, 2026-10-08

## Claim
With D3 §2.10 built (Q2 (a); SEAM.md §§228, 229), a failed result recorded for the current candidate of a `stage_build` or `fix` in `verifying` sends that item back to its Builder in the recording transaction. That includes a fixture result, which SEAM.md §228 treats as recorded. The accepted cases below record such a failure and do not expect a repair. The repaired item is dispatched again, and in the kernel lane its scripted Builder has no script, so it holds the project's one run slot. The case then times out at the next `tickUntil` that waits for every run to end ("timed out after 30000 ms waiting for every run of <project> to end"). In M206 (e) under a completing script, the repair run integrates and moves the stage's integrated revision, so the check leaves the scope.

Each file below was run alone on `build/m3-s21`. For the control, the same files were run against a temporary build whose `reconcileRepair` returned at once. That changed nothing else of the slice, was never committed, and was reverted and rebuilt afterwards. Under the control every listed case passes. Two further controls used scratch copies outside the repository:
- M42 with a completing default script: 7 of 7.
- M206 with `repair_attempts_max` 0 set after the nomination, so Q2 parks and does not repair: (e) passes.
So each failure below comes from Q2 sending work back, not from another defect.

| File | Case | Failed result recorded on the verifying item's current candidate | On this branch | With the repair off |
|---|---|---|---|---|
| `M42-findings-dispositions-and-inherited-applicability.test.mjs` | the fourth, "a fix is resolved by a verification on the candidate that holds it …" | line 163, `regress` exit 1 on candidate 1 (the stage verifying); stalls in the next `raiseFindings` (`acceptedRun`) | 6/7 | 7/7 |
| `M43-severity-tier-and-independence-floors.test.mjs` | "T2: the candidate's review is queued by the engine once its verification has completed …" | line 237, `login` exit 1; "the engine to queue the candidate's review was not reached after 4 ticks" | 6/7 | 7/7 |
| `M44-stage-gate-versus-alpha-authorization.test.mjs` | "a stage's work is complete only when its stage gate is satisfied …" | line 78, `login` exit 1 | 5/6 | 6/6 |
| `M51-severity-lower-manifest.test.mjs` | all six cases (the shared fixture) | line 29, `import` exit 1 | 0/6 | 6/6 |
| `M105-alpha-exception-proposal.test.mjs` | all six cases, (a) to (f) (the shared fixture) | line 65, `import` exit 1 | 1/7 (the other case passes) | 7/7 |
| `M106-reviewer-powers.test.mjs` | (a) and (d) | line 45, `import` exit 1 (the shared fixture) | 2/4 | 4/4 |
| `M206-registration-decides-one-sequence.test.mjs` | (e) | line 135, `own` exit 1; stalls in `raiseFindings` | 2/3 | 3/3 |
| `M207-reuse-bounded-history-beside-the-result.test.mjs` | (c)/(b), the one case | lines 43 and 45, the nomination's execution and a second registration exit 1 | 0/1 | 1/1 |
| `M223-a-real-projects-toolchain.test.mjs` (project lane) | the one case, (a)/(c)/(b) | line 96, the fix's Builder writes `BROKEN_SUM`; the acceptance check fails with the real runner while the fix is verifying, so the fix is sent back with no second script | 0/1 | 1/1 |

Named by the Verifier's static search and run alone here, passing on this branch with Q2 built: M39 (7/7), M70 (21/21), `M207-the-infrastructure-retry-beside-the-request` (1/1), `M218-evidence-missing-apart-from-the-finding` (1/1), M205 `what-establishes-a-result` (7/7), M205 `a-foreign-signal-and-forged-reports` (2/2), M217 (4/4), M218 `output-and-evidence-presence` (5/5), M219 (3/3). Not run: M205's OOM file (exhaust lane).

I believe these cases should be updated as COVERAGE.md's option (a) proposes: give their engines a completing default script, or set `repair_attempts_max` 0 where a case does not read the repair. The engine should not be narrowed: D3 §2.10 applies the repair to "a `fix` item and to a `stage_build` item in `verifying`" whatever recorded the result, and SEAM.md §228 makes a fixture result a recorded result.

## Sources
- D3 §2.10: "in every transition that records a result, ends an execution or moves the item into `verifying`, and at each tick, if the item is `verifying`, some repair check's state at the current candidate … is `failed`, and no repair has been taken …, the engine sends the item back".
- E90 item 2 (Q2 (a)); SEAM.md §228, "A fixture result is a recorded result"; SEAM.md §234, "Q2's reach over the accepted rows".
- SEAM.md §13: a scripted role with no script holds until it is killed.
