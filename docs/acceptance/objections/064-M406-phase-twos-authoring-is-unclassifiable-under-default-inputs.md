# 064: phase 2's check authoring is classified `unclassifiable`, not a tightening, because phase 1's checks use default inputs

Row: M406, M407, M401 (every journey that reaches phase 2's authoring)
Test: packages/engine/test/acceptance/harness/journey/reference.mjs, `CHECK_DEFS[1]` and `authoringFiles(2)`; SEAM.md §351 ("Phase 2's authoring is a tightening, applied by the Reviewer's `proposal_approval` under `authoritative` (`review_auto`), no human act")
Filed by: Builder, slice 31b, 2026-10-12

## Claim

Phase 1's check definitions declare no `inputs`, so each check's inputs default to the whole protected tree. Phase 2's authoring adds new protected files (`tally.test.mjs`, `stats.test.mjs`, `phase-regression.test.mjs` and their definitions). Under default inputs, every new protected file changes the fingerprint of every default-input check, and D3 §3.1 makes such a change `unclassifiable`. The engine classifies it that way: the proposal lands `awaiting_human` with a `check_correction_unclassifiable` decision, no Reviewer approves it, and the harness answers it as a second human act.

On a scratch copy of 5db0b99's fixtures, the journey completes both phases. Phase 2's proposal reads:

```
[{"reason":"input_changed","check":"accept-r1"},{"reason":"input_changed","check":"accept-r2"},{"reason":"input_changed","check":"integration"},{"reason":"input_changed","check":"integration-lib"},{"reason":"input_changed","check":"lint"},{"reason":"input_changed","check":"operation"},{"reason":"input_changed","check":"smoke"}]
```

`ctx.humanActs` then lists `check_correction_unclassifiable` twice. M406 (a) ("no human act within the phase but the toolchain proposal"), M401 (g) and the T1 variant's human-act list all expect only the first.

What I believe the fixture should hold: phase 1's checks declare `inputs` (each its own program, the wrapper and its test file). Phase 2's new files then lie outside every existing check's inputs, and the proposal is a strict addition: a tightening, which the Reviewer approves under `authoritative`. That is D3 §3.1's "declared inputs are what make the remaining tightenings provable".

## Sources

- D3 §3.1: "under default inputs any new protected file changes every default-input check's [fingerprint], and the proposal is unclassifiable (Q3)"; "a new check whose files lie outside every existing check's inputs leaves their fingerprints unchanged".
- SEAM.md §351 on phase 2's authoring being a tightening.
