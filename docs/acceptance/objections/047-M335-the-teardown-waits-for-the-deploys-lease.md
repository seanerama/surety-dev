# 047: M335's teardown case asks for an ordinary teardown while the deploy's round still holds the environment lease, so no teardown attempt can start

Row: M335
Test: packages/engine/test/acceptance/M335-the-capability-on-the-scripted-target.test.mjs, case "a teardown's capability naming a unit outside its intent: refused before any host call, the running unit left as it was"
Filed by: Builder, slice 28, 2026-10-11

## Claim

The case deploys and waits only for the attempt to be `succeeded`. Then it asks for an ordinary teardown (`POST …/teardown` with `{}`) and waits up to 16 ticks for the teardown's attempt to end. But the deploy's verification round is still open: it registered its `behaves` check, and the case never records an exit for it. So the deploy operation keeps the environment lease (`orchestration_stage` `verification`), and the teardown is never intended. On build/m4-s28 at the time of filing, the store shows the deploy `succeeded` at stage `verification`, `teardown_requested_at` set, and no teardown operation after 16 ticks. The case fails at "the teardown's attempt with the forged stop_units to end was not reached after 16 ticks", before any capability is presented.

The case should let the deploy's round end before it asks for the teardown. For example, `recordExit(fx.engine, execution.id, 1)` on the round's check, then wait for the round's row, as `deployAndSettle` does in M333 and `deployToRound` plus `recordExit` do in M336 (a). Alternatively, it should ask for the preempting teardown (`{"preempt": true}`), which takes the lease earlier (D4 §4.6). Either way the forged `stop_units` reaches `adapterCall`, which this build refuses before any host call, naming `stop_units`.

## Sources

- D4 §4.6, last sentence: "An ordinary teardown waits for the environment lease."
- D4 §4.1, "The intent": the environment lease is "held from the intent until the operation's verification is computed and its completion evaluated, or until §4.7's rule for its way out releases it (RV2; AR B06); only the operator's preempting teardown takes it earlier (§4.6)."
- SEAM.md §296: the preempting teardown is the way to take the environment from an operation in flight.
