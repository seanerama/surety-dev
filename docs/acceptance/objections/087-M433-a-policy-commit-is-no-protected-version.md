# 087: M433 (g) waits for a new protected version after a policy commit, but a policy commit makes none

Row: M433
Test: packages/engine/test/acceptance/M433-old-generation-runs-and-what-resolves-an-obligation.test.mjs, case "(f) queued, running and late runs finish passed under the old generation and decide nothing; (g) …"
Filed by: Builder, slice 36, 2026-10-13

## Claim

Case (g) tests "a rediscovery clears nothing" with `ownerPolicy(fx, p.id, { deadline_reviewer: 900 })`, then `pumpHolding(... effectiveVersion(...).id !== effective.id ...)`, which waits for a new effective protected version. The engine never makes one from a policy commit. `.surety/policy.json` is the project's policy (`policy_revisions`, the `policy` finalizer in `store/transitions/finalize.ts`), not a protected path. A protected version is recorded only at a project's start (`recordInitialVersion`) and when an approved protected proposal is applied (`store/transitions/protected.ts`). So the case fails with "the new protected version: not reached within 10 rounds". This was observed on `build/m5-s36` at 642c578 (log below). The same commit is what M433 (a) uses as "a protected change", and there it passes through the decision's `policy_revision` binding, not through `protected_version`.

What follows the wait passes on this branch. A scratch copy of the file, with the wait replaced by three pump rounds and every other line unchanged, passes 3/3 on `build/m5-s36` at c270dfa. That covers the obligations still open after the policy commit, a generation-2 pass that leaves `ACCEPTANCE_SCOPE_INCOMPLETE`, accept-r2 `resolved_by` the applied version, integration `resolved_by` the assessment, and fresh evidence deciding.

I propose one of:
- (g) makes its rediscovery with a protected change that leaves the listed checks alone. An example is an owner-approved correction proposal that touches another check's test, which is what D3 §3.4's rediscovery is, with the wait kept.
- (g) keeps the policy commit, drops the wait, and asserts that the obligations stay open afterwards (as the next line does).

## Sources

- D6 §4.5: "Rediscovery of an unchanged criterion ID clears nothing."
- SEAM §422: "A rediscovery (a new protected version that leaves the check alone) resolves nothing."
- `store/transitions/protected.ts`: the two `INSERT INTO "protected_versions"` sites, `recordInitialVersion` and the application of an approved proposal.
