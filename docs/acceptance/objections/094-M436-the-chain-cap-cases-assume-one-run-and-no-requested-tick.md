# 094: M436 (c)'s two cases assume stage 1 runs alone and that a stage's work waits for a tick the test requests, which K2 and K1 change

Row: M436
Test: packages/engine/test/acceptance/M436-the-autonomy-profiles.test.mjs, cases "(c) the cap on chain depth alone, with the budgets high: …" and "(c) the repair budget binds separately: …"
Filed by: Builder, slice 37, 2026-10-14

## Claim

**The first case** makes two stages with `addStagedProject(fx, { stages: 2 })` (no `depends_on` between them), scripts both, runs stage 1 to its end and takes `waitForCandidates(…)[0]` as stage 1's candidate, expecting its verification's `chain_origin` to be stage 1's plan trigger. Under K2 the two stages' Builders run at once (the case's own comment: stage 2 "a chain of its own, not held by stage 1's"), so the first candidate is whichever integration finalized first: twice observed on `build/m5-s37` (7969756, then d69c9ac with each integration's nomination made under the integration lease) it was stage 2's, whose verification names stage 2's origin (`trigger_id … 2F`, expected `… 2E`). The engine names each verification's own origin; the case reads the wrong candidate.

**The second case** makes a one-stage project, then changes its policy (`repair_attempts_max: 0`, a commit and a revision), and only then scripts the stage's work (`script.crash(3)`). K1 makes the plan fixture's new eligible work request a tick (`work_eligible`, M440 (a) pins it), so the stage's Builder is dispatched while the policy change is in flight, before it is scripted; the role program then follows no script of its own (`HOLD_FOREVER`), and `runToEnd` times out: "timed out after 60000 ms waiting for run 1 of wi_… to be ended" (observed twice, same revisions). Before K1 nothing ticked between the fixture and the case's own `tick`.

I propose the first case makes stage 2 depend on stage 1 (or holds stage 2's Builder until stage 1's candidate is read), and the second scripts the stage's work before anything can tick (`fx.scripted.kindScript('stage_build', …)` or `defaultScript` before `addStagedProject`), or pauses the project until it is scripted; nothing else changes. The same hazard is open to any accepted case that creates work and awaits something before scripting it; the driver has the list of what I ran (my report).

## Sources

- D6 K1 ("a transition that makes work eligible … sets the same flag, so the next tick follows at once"); SEAM §430 (`work_eligible`).
- D6 K2 (no run count at either scope); SEAM §429's reading for independent stages.
- `harness/scripted/child.mjs` `chooseScript` (`HOLD_FOREVER` for a launch with no script).
