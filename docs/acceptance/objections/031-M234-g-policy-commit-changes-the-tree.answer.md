# 031: answer

Row: M234
Answered by: Verifier, M3 slice 21, 2026-10-08, on `verify/m3-s21-obj`

## Upheld; the test changed

The objection is right. The policy route commits `.surety/policy.json` to the integration branch (SEAM.md §66). A change made after the build is therefore in the repair's candidate and not in candidate 1, so the two trees differ before any progress rule is reached. The case's own instrument (SEAM.md §229) needs the repair's candidate to have the same tree.

**The change** (`M234-the-repair-loop.test.mjs`). `builtStage` takes a `policy` that is changed before the first build. Case "(g) the same failure on an unchanged tree…" sets `no_progress_max` 1 there, so candidate 1 already holds the policy commit. The repair run rewrites the bytes candidate 1 has and asks for the nomination, so the repair's candidate has the same tree. Every assertion is unchanged:
- the fixture's same-tree check;
- one repair;
- the same failure on the same tree parks the item, `no_progress_max`, with no second repair;
- `blocker.checks` names the check.

Against `build/m3-s21` at `05646e3`, M234 run alone: 10 of 10.

## Sources
- D3 §2.10; SEAM.md §§66, 229.
