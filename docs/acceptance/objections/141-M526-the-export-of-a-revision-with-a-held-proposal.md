# 141: whether the export of an approved revision holding a held proposal carries its file

Row: M526 (c) (and M511 (c), M520 (d), SEAM §501)
Test: packages/engine/test/acceptance/M526-the-effective-asset-set.test.mjs (the export's observation is left out pending this objection)
Filed by: Verifier, slice 43, 2026-10-17 (a question for Sean, not a Builder's objection)

## Claim

The M6 plan's M526 (c) lists "the export of the approved revision" among the projections in which "the held or pending proposal's digest" must appear in none.

But the export is pinned elsewhere as the design tree itself:

- D7 A.8: `GET …/design/export?revision=` is "the tree as an archive, with `SIMULATIONS.txt`".
- SEAM §501 (slice 42), which M511 (c) and M520 (d) test, says `surety design export` "writes the design tree at the revision", and the approved export is compared with `design_revisions.tree_blob`, the git tree of `.surety/design/` at that revision.

A design revision approved with its logo held carries the held proposal in its tree, in `assets/` and in `assets/manifest.json`, `proposed`. D7 §6.4: "held ones stay `proposed` in the manifest until a later asset-only approval". So under §501 the export of that approved revision holds the held file's bytes and digest, and M526 (c)'s reading of the export cannot hold at the same time.

D7 §6.4's rule ("the Builder package, the check runner and every projection read only that record, never the manifest's latest files") reads naturally as about the effective set's projections, such as `GET …/design`'s `effective_assets`. The export is the design as drawn, for the owner and his tools, and is not an asset source of the build. That reading is the test's for now: M526 asserts the packages, the checks' asset inputs and `GET …/design`, and does not assert the export.

The choice is Sean's:

- (a) the export is the tree (§501 stands); M526 (c)'s "the export of the approved revision" is struck from the plan's projections;
- (b) the export of a revision omits held and pending proposals' files and lists only effective assets, which changes SEAM §501, M511 (c)'s `tree_blob` comparison and M520 (d);
- (c) the export carries the tree as it is and adds an `EFFECTIVE.txt` (or similar) naming the effective set, so that a reader can tell held files from effective ones.

## Sources

- M6 plan §3.5 M526 (c).
- D7 §6.4, §5.7 ("`surety design export`"), A.8.
- SEAM §501; M511 (c); M520 (d).
