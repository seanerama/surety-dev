# 031: M234 (g), no_progress: the case's own policy change commits to the integration branch, so the repair's candidate never has the same tree

Row: M234
Test: packages/engine/test/acceptance/M234-the-repair-loop.test.mjs, case "(g) the same failure on an unchanged tree counts toward no_progress_max, which parks the item with a blocker naming the check"
Filed by: Builder, M3 slice 21, 2026-10-08

## Claim
The case builds and nominates candidate 1, then calls `changePolicy(fx.engine, p.id, { no_progress_max: 1 })`, and only then records the failure. The policy change is an engine commit of `.surety/policy.json` on the integration branch ("surety: project policy revision 1"). The repair run is based on that head, so candidate 2 contains the policy commit, and its tree differs from candidate 1's before anything the engine does about progress is reached. The case fails at its own fixture assertion, line 236, "the fixture is live: the repair's candidate has the same tree" (actual `194eda8…`, expected `4b6d048…`).

Observed on `build/m3-s21`, from a scratch probe of the same steps outside the repository: `git diff --stat <c1> <c2>` is `.surety/policy.json | 31 +++`. The log of c2 is the repair's commit over `surety: project policy revision 1` over the first build.

The engine's part is built. The progress key is the candidate's tree with each failed check's (key, exit_status, signaled, deadline_hit). A repeat at `no_progress_max` parks the item with reason `no_progress_max` and `blocker.checks`. The unit test `test/unit/repair-and-findings.test.mjs`, "the same failure on the same tree counts toward no_progress_max", passes.

I believe the case should set `no_progress_max` before the stage is built, for example by changing the policy before `buildAndNominate` (as `builtStage` is factored, before the first Builder run). Candidate 1 then already contains the policy commit, and the repair's candidate can have the same tree. The other nine M234 cases pass on this branch (9 of 10).

## Sources
- D3 §2.10: "the same failure on an unchanged snapshot tree counts toward `no_progress_max`".
- SEAM.md §229, "Instruments": "the repair run rewrites the bytes the candidate already has and asks for the nomination, so the next candidate's tree is the same".
- The policy route commits `.surety/policy.json` (SEAM.md §66; `harness/journal.mjs` `changePolicy`).
