# 237: the tick settles the runtime limit before it records a park, so a park the tick has not yet seen is charged to the limit

Row: M639 (D5), and M643 (e) which composes it
Test: none fails on it; M643's parked-replan fixture ticks until the iteration reads `failed` before the controlled clock moves (M643's header says so)
Filed by: Verifier 2, item 57 rulings batch, 2026-11-26 (engine behaviour the Verifier believes wrong, per the batch brief; not an objection to a test)

## Claim
On build/item57-checks-findings-clock (8834f07e, S6), `scheduler/holds.ts` runs `settleIterationRuntime(tx)` (l.37) before `syncIterationStatuses(tx)` (l.40). The `parked_on_blocker` interval is opened by the sync (backdated to the park: `from_at` the park's time), so on the first tick after a park the runtime check still reads the iteration `building` with no exclusion. Observed (M643 (d) fixture before the fixture change, A+B heads): a replan parked after its repair, the controlled clock advanced 6 h before any tick; the next tick recorded iteration 2 `limit_reached` "runtime: prototype_runtime_seconds 2700 passed (21601 s since the brief was approved …, not counting 0 s excluded (paused))", although the iteration had been parked on its blocker for all but a few seconds of it. In production this is the case of an engine stopped (or a tick not run) between a park and the next tick: the excluded time is charged and the iteration ends limit_reached.

## What I ask
A decision for the driver/Sean, not a test change: either the tick records the intervals (status sync) before it settles the runtime, or the runtime check reads a parked item of the iteration as an open `parked_on_blocker` interval from the park; and whether M639 gains a case (a restart, or the clock advanced, between the park and the next tick).

## Sources
- Sean's ruling D5 (DECISIONS item 57): "Accept for recorded engine-blocked and explicitly paused intervals."
- packages/engine/src/scheduler/holds.ts l.37, l.40 (order); store/transitions/prototype-clock.ts (interval opened at the sync, from_at the park).
