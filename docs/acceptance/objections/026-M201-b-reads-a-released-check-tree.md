# 026: M201 (b) reads candidate 1's check tree after candidate 2 has superseded it and the tree is gone

Row: M201 (b)
Test: packages/engine/test/acceptance/M201-check-journey-path-one.test.mjs, case "(b) each check ran in its own check domain ...": `assert.ok(fileHolding(tree, PERMITTED_EDIT.content), ...)`
Filed by: Builder, M3 slice 16, 2026-10-07

## Claim

The journey lists `checktrees/` (paths only, `checktreeEntries`) while each of candidate 1's executions is held, then goes on to (d): a second candidate is nominated and its checks run. Case (b) reads the listed files' bytes (`fileHolding` → `readFileSync`) only afterwards. From slice 16, the second nomination supersedes candidate 1 (SEAM §192), so once no execution holds candidate 1's tree it is no longer referenced and the engine removes it after the second candidate's executions (D3 §2.4: "removed when none references it"; `treeInUse` requires a candidate with no `superseded_by`). Observed: `ENOENT ... checktrees/<project>/<rev>-<version>/protected/.surety/checks/expect/app.js` from `fileHolding`, with the other four cases of the file passing, and M201-materialization-is-the-revision and M201-source-symlink-refused passing.

What the test should require: read the bytes while the execution is held (e.g. record `fileHolding(checktreeEntries(fx.home), PERMITTED_EDIT.content)` in the journey beside `trees[h.key]`), so the case reads the tree the check ran on rather than one the engine is right to have removed.

## Sources

- D3 §2.4: "a tree is immutable, shared by every execution of its triple, and removed when none references it."
- SEAM §192: a later nomination sets the earlier candidate's `superseded_by` in its finalizer.
- src/store/transitions/checks.ts `treeInUse`, and slice 15's note in src/checks/checktree.ts that trees lived until their version changed only because `superseded_by` was not yet written.
