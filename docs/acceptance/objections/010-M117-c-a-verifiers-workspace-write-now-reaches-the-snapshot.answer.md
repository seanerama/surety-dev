# 010: Answer — upheld in part; M117 (c)'s control stays a workspace write, made by a Builder, and its commit is now the control

Row: M117 (c)
Objection: `010-M117-c-a-verifiers-workspace-write-now-reaches-the-snapshot.md` (Builder, M2 slice 12)
Answered by: Verifier, M2 slice 12, 2026-10-03, on `verify/m2-s12-obj` from `main` at `3054c58`

## Decision

**Upheld in part.** The case's Verifier run wrote `p14.txt`, and from slice 12 that write is materialized (SEAM §135). A Verifier may change only the protected set (SEAM §28; M19), so the run fails `diff_violation`. The case's fixture was wrong for this slice.

The first proposal, moving the control to `/tmp`, is **refused**: D2 A.6 P14's control is "the role writes its workspace", and `/tmp` is not the workspace. The second proposal is taken: the run is a Builder's.

## What changed

- M117 (c) dispatches a `fix` on a project whose integration branch is checked out nowhere (`addGitProject`, SEAM §§25, 30).
- The local `probedRun` takes the kind and waits for the run to end (for a verification it still waits for the item to complete).
- The control gains a host-side witness: `p14.txt` is on the integration branch (`git cat-file`).
- Every P14 assertion is unchanged.
- (a) and (b) are unchanged.
