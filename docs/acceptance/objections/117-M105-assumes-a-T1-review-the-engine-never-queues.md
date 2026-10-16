# 117: M105 (and M42, M50) assume a review of a T1 candidate that the engine never queues, so a T1 Verifier's finding cannot be put to the owner

Row: M105 (also M42, M50)
Test: packages/engine/test/acceptance/M105-alpha-exception-proposal.test.mjs, every case (a) to (g), through its shared setup; M42-findings-dispositions-and-inherited-applicability.test.mjs, "a Reviewer's fix disposition is recorded at once …"; M50-finding-disposition-manifest.test.mjs, cases 2, 4 and 5
Filed by: Builder, 2026-10-16, on `fix/m5-owed-finding` from main 1cac7e9, on the driver's instruction

## Background

The real M444 run (a T1 retrofit) stalled silently. A phase-2 Architect replan raised fnd_01M5113S2NR9E4909DW831ZT8Y, a project-scope, High contract_conflict with no candidate. It held the stage and phase gates (FINDING_BLOCKING), and no one was asked about it. The engine asked the owner (finding_disposition, scope disposition_owed; store/transitions/findings.ts askUndispositioned) only after the engine's review of the finding's candidate had reported.

The driver ruled that an open finding with no disposition is owed to the owner whenever no review will come to disposition it:

- (a) a review reported after it, as before;
- (b) it names no candidate;
- (c) its source is not a role whose findings a review dispositions;
- (d) the tier queues no engine review for the candidate.

## Claim

(d) is the driver's intended rule. The engine queues E36 item 3's review only at T2 and above (gates.ts queueReview: `TIER_RANK[candidateContent(...).tier] < 2` returns early). So no review will ever come to a T1 candidate, and a T1 Verifier's candidate-scoped finding with no disposition is owed to the owner at once.

These tests assume the opposite. Each drives a Reviewer on a T1 candidate through the harness (`raiseFindings` and `review`, test-made review work items), which the engine itself never queues at T1. Each expects the owner not to be asked meanwhile:

- **M105.** A Verifier fixture raises a High with no sensitive area, a Medium and a sensitive High on a T1 candidate. A Reviewer fixture later proposes alpha_exception. The ticks between them run the sweep with no review work item of the candidate. Under (d), the owner is asked about all three. With (d) built, M105 failed 7 of 7 cases: case (a) found two open finding_disposition decisions where it wanted one, and case (b) found decisions where it wanted none.
- **M42 and M50.** Both failed under (d) as first stated. They passed under a narrowing the driver accepted: a review "will come" if the tier queues one or a review work item of the candidate already exists. M105's setup raises its findings before any review work item exists, so the narrowing does not save it.

On the driver's instruction, (d) is not built at this commit; (a), (b) and (c) are. **The latent stall remains until a Verifier rules:** a T1 project's Verifier finding on a candidate, with no disposition, holds the gates it blocks and asks no one, because no review will come at T1.

## Proposed

Either:

1. Move M105's project to T2, where the engine queues the review that proposes the Alpha exception (and M42's and M50's, if their Reviewer is meant to be the engine's review); or
2. Let M105 accept the owed question alongside the alpha_exception one: one open finding_disposition of scope disposition_owed per undispositioned finding, raised before the Reviewer's proposal, and the alpha_exception decision beside it. Likewise M42 case 6 (a question was asked before the Reviewer's fix) and M50 cases 2, 4 and 5 (count only the proposal-scope decision).

Once a Verifier has ruled, the Builder adds (d): owed when the candidate's tier queues no engine review under the effective version (the rule queueReview applies). An unread tier waits.

## Sources

- The driver's rulings on the real M444 run (2026-10-16): (a) to (d); the accepted narrowing; "Option 1 now, with the objection filed as well".
- gates.ts queueReview: "The engine queues the review a tier requires (E36 item 3; E38; SEAM.md §70): at T2 and T3".
- checks/scope.ts signoffsOf: "T2 a Reviewer's at candidate scope; T3 also one per scope module".
- The driver's ruling on the real M443 run (a7c1470): never a silent stall.

## Ruling (Verifier, 2026-10-16, on `verify/m5-objections-117-120` from main a44a9c3)

**Upheld; SEAM §466.**

- **(d) is right by design.** The engine queues a candidate's review only at a tier that requires a Reviewer's sign-off (E36 item 3; SEAM §70: "At T1, which requires no sign-off, none is registered"). At T1 no review will come, so an open, undispositioned finding on a T1 candidate is owed to the owner at once.
- **What "no review will come" means here** (as the driver accepted it):
  - the candidate's tier under the effective version queues no review (the tier rule of `queueReview`, not its check-state conditions); and
  - no `review` work item of the candidate exists, in any state.
  - With the tier unread, the finding waits.
- The Builder may now build (d).
- **M105 changed, by the second remedy.** Every read is now of the proposal's own decisions, scope `alpha_exception`.
  - Where the row says no decision ((b), (c), S1 A), the case requires no `alpha_exception` decision, and no decision about the finding of any scope except `disposition_owed`.
  - The owed question is neither required nor counted, so M105 holds whether or not (d) is built.
- **The first remedy (T2) was not taken**, for two reasons:
  - M105's successor candidate is a fixture fix nominated on its Builder's request, which T2 refuses (SEAM §42).
  - At T2 the engine's own verification and review items would run beside the fixture's.
- **M42 and M50 are not changed.** Their Reviewer fixtures' `review` work items are on the candidate before the sweep reads the findings, so under this reading no owed question is raised.
