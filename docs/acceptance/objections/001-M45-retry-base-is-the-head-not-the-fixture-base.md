# 001: the retried run's base is the integration branch's head, which the case's own policy change moved; `project.base` is the commit before it

Row: M45
Test: packages/engine/test/acceptance/M45-blocker-manifest.test.mjs, case "the stored continuation changes while the subject stays parked: the old preview is stale, nothing is resumed, and the next generation binds the continuation as it now is", the last assertion (line 132)
Filed by: Builder, M2 slice 2, 2026-10-03

## Claim

The case's last assertion requires `resumed.base_revision === project.base`, the commit the fixture repository's integration branch was at when `addGitProject` returned. Before the work is created, the case calls `changePolicy(fx.engine, project.id, { repair_attempts_max: 0 })`. A policy change is committed to `.surety/policy.json` on the integration branch through the journal (SEAM.md §27), so the branch, and the registry's expected commit, move from `project.base` to the policy commit. After that, "the integration branch's head" is the policy commit, not `project.base`.

So the engine does what SEAM.md §105 and the case's own message say ("a `retry` on it starts a run whose `base_revision` is the integration branch's head"; "the retried run starts from the integration branch's head, as the answered preview said, not from the checkpoint"). The assertion compares that head with the wrong commit and fails: actual `54f41d7…` (the policy commit in that run), expected `0a9680a…` (`project.base`).

A scratch run of the same staging, kept outside the repository, printed:

- `project.base` 3663031…; the branch after `changePolicy` e91b817…; the registry's expected commit e91b817…
- the first run's `base_revision` e91b817… (the head); the second run's d91e8fd…, the checkpoint.

The assertion should compare with the integration branch's head at the moment of the retry, for example `registryOf(fx.home, project.id)[project.repo.ref].expected_oid` or `refOid(project.repo.path, project.repo.ref)` read before `consume`. Or it should compare with the first run's `base_revision` (`runsOf(fx.home, item)[0].base_revision`), which is that head, since nothing moved the branch between the two runs. Either keeps what the case pins: the retried run does not start from the checkpoint.

Every other assertion of the case passes on `build/m2-s2` (the earlier preview binds `{status: 'eligible', from: <checkpoint>}`, the answer is stale after the store change, the item stays parked with two runs, the next generation binds `{status: 'eligible', from: null}`, and the retry is consumed and runs to its end).

## Sources

- SEAM.md §27: a policy change "commits `.surety/policy.json` through the journal" onto the integration branch.
- SEAM.md §105: "a `retry` on it starts a run whose `base_revision` is the integration branch's head."
- D1 §7.4 and `claimDispatch`: a run's base is the checkpoint its work continues from, or else the commit the registry expects the integration branch at.
