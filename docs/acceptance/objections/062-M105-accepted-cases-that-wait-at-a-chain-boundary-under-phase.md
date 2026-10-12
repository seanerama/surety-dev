# 062: accepted cases the C.2 migration did not reach

Row: M37, M41, M43, M52, M105, M204, M206, M208, M234, M318, M325 (kernel files), and M49, M01
Test: the files named below, as on `main` at e9a0420's merge
Filed by: Builder, slice 31a, 2026-10-12

## Claim

D6 K3 makes `autonomy: phase` the project default and `max_chained_roles` 24. SEAM.md §348 migrated the cases that assert the boundary, but these were not migrated and fail on this branch.

**Chained work dispatched, then held with no script.** Under `phase`, work a run's outcome created is dispatched with no human step. The commonest case is a nomination's `verification` (chain 1). These files script only the run they are about, so the chained run's role has no script and holds until it is killed. The next `tickUntil` then times out in `waitForIdle`. On a scratch copy of M105 the live run was a `verifier` one-shot on `verification` work, chain 1, trigger `nomination`, `executing`. Failing cases by file:

- M37-apply-approved-protected-proposal: 3
- M41-typed-evidence-reuse: 1, plus 4 cancelled
- M43-severity-tier-and-independence-floors: 4
- M52-finding-applicability-exclusion-manifest: 5
- M105-alpha-exception-proposal: 7
- M204-triggers-registration-frozen-discovery: 5
- M206-registration-decides-one-sequence: 2
- M208-frozen-bindings-and-supersession: 3
- M234-the-repair-loop: 7
- M318-the-generation-guard: 2
- M325-the-lease-and-the-orchestration-deadline: 11

**M49-policy-widening-manifest, 4 cases.** The cases submit `{max_chained_roles: 2}` and expect `policy_widening` (409 `confirm_required`), with the effective value 1 before approval. With the default now 24, 2 narrows and is committed at once (`200 !== 409`). The cases need a value above 24 and the new default.

**M01-kernel-journey, "runtime data stays outside tracked source".** With the step pin (harness/journey.mjs), the integration branch also gains `.surety/policy.json`, which the case's "identity file and the Builder's edit" set does not list.

What I believe these cases should require: as SEAM.md §348 does for the migrated ones, either pin `autonomy: step` where the case is about one run, or script the chained runs the `phase` profile now dispatches. For M49, widen above the new default. For M01, include the policy revision the pin commits.

## Sources

- D6 §6.5, K3; A.7: `autonomy` default `phase`; `max_chained_roles` 24 within 1 to 64.
- SEAM.md §348: "Every accepted case that lets chained work through a boundary with `continue`, or asserts the boundary, now pins `autonomy: step`".
- harness/scripted/child.mjs header: "With no script at all the program holds until it is killed".
