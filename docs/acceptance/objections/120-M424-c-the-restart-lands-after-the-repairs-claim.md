# 120: M424 (c) to (e) places its restart "between the refusal and the repair", which K1 no longer leaves open; when the kill lands after the repair's claim, D1's recovery holds the item and no blocker is raised

Row: M424 (c), (d), (e)
Test: packages/engine/test/acceptance/M424-the-replan-one-shot-and-its-repairs.test.mjs, case "(c) a refused plan fails invalid_result naming the reason; (d) one repair …; (e) a restart replenishes nothing; …"
Filed by: Builder, 2026-10-16, on `fix/m5-test-health` from main 4c0f067, on the driver's instruction

## What fails

The case is intermittent. The driver saw about 1 failure in 5 runs under load. The failure:

```
error: 'the blocker on the replan work was not reached after 12 ticks'
```

To reproduce it I used a scratch copy of the file (imports made absolute, outside the repository) with a delay of 80 ms before `fx.engine.kill()`. Its second run failed this way. The kept store shows:

- 894: the first replan run's `run.ended` (`failed`, `invalid_result`, PLAN_UNKNOWN_REQUIREMENT R9). 895: `work.advanced` integrating → `eligible` (repair due).
- 898 to 900: the repair's `run.created`, `run.claimed`, `work.claimed`. The run end's requested tick (D6 K1) dispatched it at once.
- The case's kill comes here. The case read the first run as ended and then killed the engine.
- 916: at restart, `run.ended` of the repair with `outcome: recovered`, `reason_class: recovered` (`recovery` this incarnation).
- 917: `work.held` from `claimed` to `held`.
- After that there is no third run, no blocker and no open decision about the replan item.

Two other orders pass:

- the kill lands before the repair is dispatched (the order the case means), or
- the kill lands after the repair has also ended and parked.

In two scratch runs that dumped the store before the kill, the dump's own delay let the repair finish first.

## Claim

The engine follows D1 here, and the case's timing assumption no longer holds:

- D1 §16.1 (2): "every non-ended run → `endRun` with outcome `recovered`".
- D1 §4.3: a run's work is `held`, and "`held` leaves only by explicit Resume".
- D1 §15.3: "Resuming a stopped, timed-out, budget-ended, or recovered run creates a new run".

The replan's "one automatic repair, then a blocker" (D6 §5.6; the coordinator's ruling) applies to a repair that fails. A repair recovered at restart never ran its plan, so there is no refusal to raise a blocker about. The item is visibly `held` and waits for the owner's Resume. The restart replenished nothing: two runs, never three.

The case's comment says the restart falls "between the refusal and the repair". Under K1, the first run's end requests the tick that dispatches the repair. The case has no hold that keeps the repair from being dispatched before its kill, so where the kill lands is a race.

Raising a blocker (or any question) for a recovered run's held work, so that it is not a silent hold, would change D1 §4.3 for every kind, not only replan. If that is wanted, it is a design decision for Sean (compare the driver's "never a silent stall" ruling on the real M443 run). I have not built it.

## Proposed

Make the restart fall where the case says it does. Hold the first replan run, pause the project, release the run, kill and restart after it ends, then resume the project:

```js
const held = replanUnknownRequirement();
fx.scripted.kindScript('replan', [{ ...held, steps: [step.hold('gate'), ...held.steps] }, replanUnknownRequirement({ dump: true }), replanUnknownRequirement(), replanUnknownRequirement()]);
await untilReplanHolds(fx, ctx);
await pauseProject(fx.engine, p.id);   // the run's end requests a tick; a paused project dispatches nothing (D1 §8.4)
fx.scripted.release('all');
const first = await tickUntil(… the first replan run to end …);
// … (c)'s assertions; replanRuns(...).length is 1 here …
await fx.engine.kill();
await fx.start();
await resumeProject(fx.engine, p.id);
// … (d), (e) unchanged …
```

This was checked in scratch copies of the file at 4c0f067, 5 runs of the whole file in each row:

| Copy | Delay before the kill | Runs that failed (c) |
|---|---|---|
| The file as it is | 80 ms | 2 of 5 |
| With the change above | 80 ms | 0 of 5 |
| With the change above | none | 0 of 5 |

Five runs of the unmodified file passed here, so the race is rare on an idle workstation. The other order is a legitimate alternative too: accept the recovered branch, the repair `recovered` and the item `held` with no third run, and have the owner's Resume carry it to the refused repair and the blocker. That is the Verifier's call.

## Sources

- D1 §§4.3, 8.4, 15.3, 16.1; D6 §5.6, §12.1 K1; SEAM §§403, 430.
- `store/transitions/runs.ts`, the run-end protocol's `case 'recovered'` (→ `held`).
- `recovery/startup.ts` (step 2).
- Objections 100 and 114 (the same class).
