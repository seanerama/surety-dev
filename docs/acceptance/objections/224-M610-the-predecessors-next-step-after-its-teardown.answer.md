# 224, answered: upheld; M610 (a) compares the historical outcome and reads `next_step` after the teardown as current guidance

Answer to `224-M610-the-predecessors-next-step-after-its-teardown.md`, by the Verifier on `verify/alpha-preview`, from `integration/alpha-preview` 2d086dfa, 2026-10-29.

**Upheld.** The owner ruled on 2026-10-29: "Keep historical deployment evidence separate from current availability. Teardown or replacement must remove any claim that the old candidate is currently available." The M7 plan's M611 (e), as amended on `main` 14b87e91, says how `next_step` is read: "the predecessor's served `next_step` no longer `open_alpha` (objection 224: `next_step` is current guidance, not history)".

## What changed (tests only; SEAM.md §579)

`packages/engine/test/acceptance/M610-iterate-and-the-second-alpha.test.mjs`, case (a) "on a running iteration, … the predecessor untouched":

- `usage`, `owner_approvals`, `plan`, `brief` and `limitations` are still compared whole with the read taken before the teardown.
- `outcome` is no longer compared whole. Its history is compared: `status` and `reason` unchanged, and the same members.
- `next_step` is read as current guidance:
  - before the teardown it is `open_alpha`;
  - after the finalized teardown it is the engine's guidance that the Alpha is no longer deployed, fixed in the Verifier's table as `contract/prototype.json` `next_steps.alpha_gone` ("its Alpha is no longer deployed (torn down or replaced): iterate from the current iteration, or discard");
  - the iteration read's `iteration.next_step` and the list's `iterations[].next_step` serve the same.
- New beside it: `alpha.current_state` is `torn_down` and `alpha.current` is null.
- The assertion that follows it is unchanged: status, `alpha_at`, candidate and deployment request kept.

The replacement's side of the same reading (`current_state` `replaced`, `next_step` `alpha_gone`) is in the new kernel file `M611-replacement-and-ended-observations-on-the-scripted-target` (row M611 (e)).

## The intermittent failure of the same file

"the iteration failed with a run still under way: not reached in 60 ticks", in case (a) "an ended iteration with a one-shot run of the project still under way", is the harness's, not the engine's (SEAM.md §579). Two stage builds dispatched on one tick chose their scripts from the kind's array by counting the log before either had logged its launch, so both could take the holding script and nothing failed. Probed with the case repeated: before the fix, both launches held in 2 of 3 rounds; after it (each launch claims its ordinal exclusively, `harness/scripted/child.mjs`), 8 of 8 rounds passed. No engine change is asked for.

## Runs

`node --test --test-concurrency=1 --test-timeout=600000`, file alone, `TMPDIR=/tmp/vfy`, after `npm run build`: M610-iterate-and-the-second-alpha: tests 5, pass 5, fail 0.
