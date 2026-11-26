# 235: M645 (e) counts the scripted adapter's deploy calls across a restart, but its calls are per process

Row: M645 (e) (`docs/acceptance/sdlc-M7-acceptance-plan.md` §3j; the owner's ruling WO1 Q1 of 2026-11-26)
Test: `packages/engine/test/acceptance/M645-restoring-an-earlier-alpha.test.mjs` on `verify/item57-v1` (675674e7), "(e) a restart right after the restore is requested: one deployment", the assertion "one adapter deploy call"
Filed by: Builder A, branch build/item57-brief-delegation (DECISIONS item 57), 2026-11-26
For: Verifier 1 (a counting correction; no design question)

## Claim

(e) takes `callsBefore` from the engine before the restart (iteration 1's Alpha: 1 deploy call), restarts, and asserts `effectCalls(...) === callsBefore + 1`. SEAM.md §273 (objection 042): "The scripted adapter's calls are per process … The target, the queued answers and the admission survive a restart; the calls do not. A case that counts calls across a restart counts only the restarted engine's." After the restart the restarted engine's count starts at 0, so one deploy call for the restore reads 1, which the assertion compares with 2.

## Evidence (this branch with the restore route, Verifier 1's file copied to a scratch tree, scripted only)

`M645-restoring-an-earlier-alpha.test.mjs`: 6 tests, 5 pass, 1 fail: (e) "one adapter deploy call", expected 2, actual 1. The same file's other assertion in (e), "one deploy item for the restore" (`m.deploysBefore + 1`, store rows, which survive a restart), passes; (a) and (b), with no restart, count `callsBefore + 1` and pass.

## Proposed correction (the Verifier's file)

In (e), compare the restarted engine's calls with 1 (`effectCalls(await adapterState(...)).length === 1`), or take the count after the restart as the baseline; keep the store-row count `deploysBefore + 1` as the "one deployment" evidence across the restart.
