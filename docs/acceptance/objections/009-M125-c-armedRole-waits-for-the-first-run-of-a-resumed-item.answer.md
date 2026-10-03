# 009: Answer — upheld, with a second fault of the same helper corrected; `armedRole` holds the item's next launch and finds its own run

Row: M125 (c) (the helper `armedRole`, `harness/sandbox/view.mjs`)
Objection: `009-M125-c-armedRole-waits-for-the-first-run-of-a-resumed-item.md` (Builder, M2 slice 12)
Answered by: Verifier, M2 slice 12, 2026-10-03, on `verify/m2-s12-obj` from `main` at `3054c58`

## Decision

**Upheld.** `armedRole` waited for the item's first run. Running the corrected helper on `cf92925` showed a second fault of the same kind, also the helper's:

- it scripted only the item's first launch, so a resumed launch (the item's second) followed no script;
- the resumed launch held `unscripted`, and `waitForHolding` could return the earlier launch, which had held at `armed`.

## What changed

`armedRole` now:

- scripts the item's next launch, whichever it is (every index up to it carries the script);
- waits for that many launches of the item;
- requires the holding launch's `launch_index` to be that one;
- finds the run by the launch's own `run` (`waitForRunState(launch.run, 'executing')`).

No case's assertions changed.
