# 090: M438 (a), (e), (f) and M133's per-profile cases change the policy of a project whose integration branch is checked out in its own repository, which the engine refuses to move

Row: M438 (and M133, slice 37's straddle)
Test: packages/engine/test/acceptance/M438-the-envelope-as-built.test.mjs, cases "(a) 12 GiB available …" (its second half), "(e) the defaults; …", "(f) role_memory_max changed while a domain is admitted …"; packages/engine/test/acceptance/M133-memory-admission-reserves-the-limit.test.mjs, both cases (the straddle's `changePolicy` of `role_memory_max`)
Filed by: Builder, slice 37, 2026-10-14

## Claim

Each case makes its project with `addProject` (`harness/runs.mjs`), whose repository comes from `makeRepo` (`harness/git.mjs`): `git init -b main` and a commit, so the repository's primary worktree has `main`, the project's integration branch, checked out. Each then calls `changePolicy`, whose commit the engine makes and then moves `main` onto by a journaled ref update. The journal's precondition refuses to move an integration branch that a worktree the engine does not own has checked out (`src/journal/effects.ts` `precondition`, `branchCheckedOutAt`; RN R5: "Nothing else may move a checked-out integration branch"), so the ref update fails from `intended` with no attempt, and the policy revision never becomes effective. The cases fail with "timed out after 30000 ms waiting for policy revision 1 of proj_… to be effective".

Observed on `build/m5-s37` at 181cf5c (`M438-the-envelope-as-built` 3/7): (a) at its second engine's `changePolicy(fx2.engine, q, { role_memory_max: 8 GiB })`; (e) at `changePolicy(fx.engine, p, { role_memory_max: 3 GiB })`; (f) likewise. A scratch case doing only `addProject` then `POST …/policy {repair_attempts_max: 2}` shows the same: the policy's `commit_tree` finalized, its `ref_update` `failed` from `intended`, revision 1 never effective. The engine's refusal is accepted behaviour, not slice 37's: the older files that change a policy make their project with `addGitProject` (`harness/gitruns.mjs`, primary worktree detached), for example `M130-exit-classes` and `M441-the-pace-read-from-recorded-observations` (f).

I propose those cases make the project whose policy they change with `addGitProject` (or `makeProjectRepo` with `primary: 'detached'`), and change nothing else.

## Sources

- `src/journal/effects.ts` `precondition` and `branchCheckedOutAt`; RN R5 as quoted there.
- `harness/git.mjs` `makeRepo`; `harness/gitruns.mjs` `addGitProject` (`primary = 'detached'`).
