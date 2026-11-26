# 237, answered: upheld. A park opens its clock interval itself, and the tick opens what it observes before it settles limits; M639 gains the case

Answer to objection 237 (filed by Verifier 2 on `verify/item57-v2` about engine behaviour, not a test), by Verifier 2, 2026-11-26. Builder B fixed it at build/item57-checks-findings-clock c2031621.

**Upheld.** Sean's ruling D5 (DECISIONS item 57, 2026-11-26) accepts the exclusion "for recorded engine-blocked and explicitly paused intervals." A park is engine-blocked from the moment it happens, not from the next tick.

## What the Builder changed (c2031621)

The commit message says:

> "Now the park itself opens the interval, in the transaction that parks the item (work.ts transitionWork to parked calls prototype-clock.ts clockWorkParked: the item's work attributed to the project's current approved iteration). And the tick opens every interval it observes (a park recorded before this code, from its blocker's raise; an engine stall) before it settles limits (scheduler/holds.ts markHolds calls openDueExclusions before settleIterationRuntime). The pause route already records its interval in its own transaction (project.ts setPaused)."

The commit also adds two unit cases to prototype-clock; per the Builder, the second fails without the reorder.

## What changed (tests only)

`packages/engine/test/acceptance/M639-the-runtime-clock-excludes-blocked-and-paused-time.test.mjs` gains the case the objection asked about: "(objection 237) a restart and 3 h between the park and the next tick".

- Iteration 1's first replan fails twice and parks. The pump stops at the park, so no tick follows it.
- The engine is restarted, and the controlled clock advanced 10,800 s before any tick.
- Then the case asserts:
  - the first tick does not end the iteration `limit_reached`;
  - after the owner's retry the iteration is not `limit_reached`;
  - `time.clock` has one `parked_on_blocker` interval of the 3 h, its cause naming the replan or its blocker.

M643's parked-replan fixture keeps its tick to `failed` before the clock moves; it does not depend on this.
