# 110: M74 fixture semantics case 2 reads "no successor yet" after the run's end, which under K1 requests the tick that dispatches the successor

Row: M74
Test: packages/engine/test/acceptance/M74-fixture-semantics.test.mjs, "an accepted one-shot checkpoint is linked to its ended run, and the work that continues from it shows the successor run, once there is one"
Filed by: Builder, slice 37, 2026-10-14

## Claim

On `build/m5-s37` at 4144687 the case fails alone:

```
the checkpoint belongs to an ended run, and no successor is claimed before one exists
+ 'run_01M4XSSDAPC1GFCAJECC968EYX'
- null
```

The first run ends with an accepted checkpoint, and its item becomes eligible again. Under D6 K1 the run's end requests a tick (`scheduler.tick_requested`, cause `run_ended`; M440 (a)). That tick dispatches the continuation within `tick_budget`, with no request from the test. So `successor_run` is already set when the test reads the first run after `runToEnd`. This is a K1 straddle, like those of objections 100 and 105. The engine does what M440 (a) requires.

I propose the case read the first run before its end is observed, or hold the continuation (for example, pause the project before the run ends and resume it after the read). Then assert `successor_run` null, then the successor once it runs.

## Sources

- D6 K1; M440 (a); objections 100 and 105 (K1/K2 straddles).
