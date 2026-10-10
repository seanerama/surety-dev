# 038: M311 (h)'s `before` hook fails in the harness's tree listing (`spawnSync git ENOBUFS`) before anything is deployed

Row: M311
Test: packages/engine/test/acceptance/M311-the-identity-reads-duration.test.mjs, `before` hook, line 71 (`listTree(ctx.p.repo.path, ctx.candidate.revision)`); helper `harness/repos.mjs` (`gitQuiet`, `listTree`)
Filed by: Builder, slice 24, 2026-10-10

## Claim
On `build/m4-s24` the file fails in its `before` hook with `spawnSync git ENOBUFS`, and both cases are cancelled. `hostDeployable` had finished: the project was built, nominated and its workspace checks recorded. Then the test's own `listTree` ran `git ls-tree -r -z --full-tree` through `execFileSync` with Node's default `maxBuffer` of 1 MiB. The revision's 20,000-odd entries list to more than that. No deployment was requested, so the engine's identity read was not reached. The operator's guard found nothing left.

`gitQuiet` needs a larger `maxBuffer` for this listing, at least the size of the listing (for example 64 MiB), or `listTree` could take a bound of its own.

## Sources
Node's `child_process.execFileSync`: `maxBuffer` defaults to 1024 * 1024 bytes, and output beyond it ends the call with `ENOBUFS`. SEAM.md §256 and the file's head: the revision holds 19,999 files under `fill/` beside `pad/` and `server.js`.
