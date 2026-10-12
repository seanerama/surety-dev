# 061: M12's `autonomy: step` migration commits a policy revision, which moves the base the fixture then asserts against

Row: M12
Test: packages/engine/test/acceptance/M12-chain-of-roles.test.mjs, `nominatedStage` (both cases of "M12 chaining stops at max_chained_roles"), and the case of "M12 what is not a chain"; harness/gitruns.mjs `addStagedProject`
Filed by: Builder, slice 31a, 2026-10-12

## Claim

Slice 31a's migration (SEAM.md §348) has `nominatedStage` call `addStagedProject(fx, { tier: 'T2', autonomy: 'step' })`. That helper makes the project with `addGitProject` and then changes its policy (`changePolicy(…, { autonomy })`). A policy change is a journaled commit of `.surety/policy.json` on the integration branch (D1 §11.4, as built since M1), so the head moves past `project.base`. `nominatedStage` then calls `assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true })`. The Builder's run is based on the head when it was claimed, which is the policy revision's commit, not `project.base`. The case fails before reaching anything it is about:

```
run run_…: the revision's kind and parent
+   parent_sha: '2aca24c…'   (the policy revision's commit)
-   parent_sha: '01d63e2…'   (project.base, before it)
```

All three M12-chain-of-roles cases fail this way on this branch.

What I believe the fixture should require: the run's parent is the integration head at the run's claim. That is, read the base after the policy change (`refOid` of the integration ref once `addStagedProject` returns), or return it from `addStagedProject` when it changes the policy. Other migrated cases that pair `autonomy` with an `assertCommitted(…, { parent: project.base })` would need the same change.

## Sources

- SEAM.md §348: "pins `autonomy: step` on its project before the work exists, through `changePolicy`".
- harness/gitruns.mjs `addStagedProject`: `if (autonomy !== undefined) await changePolicy(fx.engine, project.id, { autonomy });`.
- D1 §7.4 / SEAM.md §27: a policy change commits `.surety/policy.json` on the integration branch; a run's base is the commit the registry expects the branch at when the run is claimed.
