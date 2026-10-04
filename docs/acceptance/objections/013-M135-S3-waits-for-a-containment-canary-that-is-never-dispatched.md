# 013: M135 "S3" waits for the containment canary, which SEAM §148 says is never dispatched once the positive canary has failed

Row: M135 (the slice-13 review's S3)
Test: packages/engine/test/acceptance/M135-qualification-attempt.test.mjs, case "S3 (the slice-13 review): …", line 327 (`await armedCanary(fx, 'containment');`)
Filed by: Builder, M2 slice 13, 2026-10-04

## Claim

The case makes the positive canary's edit a link out of the workspace and requires that canary not to pass. On `build/m2-s13` it does not pass. SEAM §148 then applies: "The first canary that fails ends the attempt `failed` and **no later canary is dispatched**." So no containment canary is ever launched. The case's next line, `armedCanary(fx, 'containment')`, waits for a containment role that never comes:

```
error: `timed out after 120000 ms waiting for the containment canary's role to hold at "armed"`
```

It times out at that line, before its own assertions. M135 (f), whose positive canary fails too, releases nothing (`runToEnd(…, { release: [] })`) and passes on this branch.

The Reviewer's own scratch case for S3 (`review-s13/canary-link.test.mjs`) does the same, and also times out on `build/m2-s13` for this reason.

## Proposed change

Drop the `armedCanary(fx, 'containment')` call in S3 (as M135 (f) does), so the case waits for the attempt to end. The assertions then read the positive canary's `passed` false, the attempt not `succeeded` and no entry, unchanged. If the case should also prove that "the engine reads nothing through the link", the host-side witness can be added directly: the outside file's access time unchanged, or a host FIFO as the link's target that never gets a reader, as M129 (c) does.

## Sources

- SEAM.md §148 ("The outcomes": the first failure stops the attempt).
- M135 (f) (the same shape, passing).
