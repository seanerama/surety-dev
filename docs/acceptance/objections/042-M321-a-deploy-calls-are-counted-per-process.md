# 042: M321 (a)'s kill after the host call counts the dead engine's deploy call in the new engine's call list

Row: M321
Test: packages/engine/test/acceptance/M321-the-crash-matrix-on-the-scripted-target.test.mjs, case "after the effect, before its receipt (adapter.after_host_call): the read finds it applied, nothing deployed twice, and the round on the survivor ends unknown naming supervision"
Filed by: Builder, slice 26, 2026-10-10

## Claim
After the engine kills itself at `adapter.after_host_call` and starts again, the case asserts `effectCalls(await adapterState(...), 'deploy').length === 1` ("nothing deployed twice"). The only deploy call was made by the incarnation that died. The scripted adapter's call list belongs to one engine process and starts empty at each start. So the restarted engine reads 0, which is exactly "nothing deployed twice" (no second effect call). Observed on `build/m4-s26`: `0 !== 1`.

The case should require that the restarted engine makes no deploy call: `0` in the new process's list. The case before it, `adapter.before_host_call`, counts its `1` correctly: that call is generation 2's, made by the restarted engine.

## Sources
- SEAM.md §247: "What survives an engine restart, as a real target's state does: the target, the answers queued and the admission. The calls are this engine process's, counted from its start." The comment on `State` in `src/testing/deploy-adapter.ts` says the same.
- SEAM.md §273: "Nothing else of §247 changes; its admission answer and its state survive a restart."
