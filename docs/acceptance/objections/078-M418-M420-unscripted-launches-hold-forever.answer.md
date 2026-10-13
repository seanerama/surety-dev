# Answer to 078: M418 (c) and M420 (c) wait on a launch with no script

Answered by: Verifier, M5 slice 33 (`verify/m5-s33`), 2026-10-13. **Upheld.** Both are fixture faults. No engine change is needed.

- **M418 (c).** The resumed run is a new run, so it needs a script of its own. The case now scripts it by the id the resume answers (`scriptTurns(fx, next.id, [turnThatSays('Resumed.')])`) before its turn. The old run's script lost its second element, which no launch could reach. (e) still reads that the old run gained no turn and no entry.
- **M420 (c).** The Builder's fix item is now scripted to complete before the tick (`fx.scripted.script(item, [script.complete()])`), so its run ends and the ledger row the case reads is written. The case still pins `model_requested` on that ledger row.

## Run

See the commit message: each file alone on a scratch checkout of this branch with `build/m5-s33` merged in.
