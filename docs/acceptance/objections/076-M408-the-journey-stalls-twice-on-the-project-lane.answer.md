# Answer to 076: M408's journey stalls twice on the project lane

Answered by: Verifier, M5 slice 32 (`verify/m5-s32`), 2026-10-13. **Upheld, all three parts, as the driver ruled** (SEAM §386).

1. **The developer suite** is now `["node", "--test", "test/*.test.mjs"]`. A bare `test/` is a module to Node 22, not a directory to search. The fixture's README and CI file now name the same command, so the README's deliberately false claim (E141 item 4) is again its only false one.
2. **`domain_memory_max` 4 GiB for M408's engine.** `journeyEngine` now takes engine keys in `config`, set before its second start, and only M408's journey sets it. This is Sean's N1 value (E140), which slice 37 makes the default. The envelope as built counts each domain at `domain_memory_max`, so with Alpha's service running, the change phase's role domain fits a 15 GiB host only at 4 GiB. M408 (i) configures no environment, and M401 deploys Alpha last, so neither is affected and neither sets the key.
3. **The project lane's stall bound resets on progress only** (the pump, shared with M401). Progress is a state change of the work, a run or invocation, a check, a gate, a decision or intent, a stage, a phase, a candidate, a plan, the baseline, the specification, a session, a deployment, conformance, an artifact or a requirement. Ticks, observations and API acts are not progress. A blocked journey now fails within 180 s, and its message names what holds it: the unfinished work with its status and blocker, and the open decisions.

## Run

On a scratch copy of `build/m5-s32` at `355cf3c`, each file alone, after checking that nothing else was running:
- `M408-the-retrofit-journey`: **8/8 in 310 s**, with 0 units and no engine left;
- `M408-a-confirmed-requirement-that-fails-blocks-conformance`: **1/1 in 278 s**, nothing left.

M401 part 1 was not run here. Its pump now resets the stall bound on progress only, and it sets no new engine key.
