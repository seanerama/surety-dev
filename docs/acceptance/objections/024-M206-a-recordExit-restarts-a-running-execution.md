# 024: M206 (a), (d) steps an execution already `running` back through `materializing`

Row: M206 (a), (d)
Test: packages/engine/test/acceptance/M206-registration-decides-one-sequence.test.mjs, case "(a), (d) two registrations of the same bindings, the later recorded first, ...": `await drive(fx.engine, a, TO_RUNNING);` then, later, `const ra = await recordExit(fx.engine, a, 0);`
Filed by: Builder, M3 slice 16, 2026-10-07

## Claim

`recordExit` (harness/checks/selection.mjs) drives `TO_RECORDED`, which is `['materializing', 'running', 'collecting', 'recorded']`, starting with `materializing`. Execution `a` is already `running` when the case calls it, so its first step asks for `running → materializing`. SEAM §190 makes that step a **409** `illegal_transition` ("Any other step ... is 409"), and `stepExecution` asserts 200 and `status === 'materializing'`. No engine that follows §190 can pass. Observed: `409 {"code":"illegal_transition", ... "status":"running","to":"materializing"}` at line 116.

What the test should require: move `a` on from where it is, e.g. `await drive(fx.engine, a, ['collecting', 'recorded'], { exit_status: 0 })` and take `check_result` from the answer (as M208 does), or give `recordExit` a starting status.

## Sources

- SEAM §190's table: `running` → `collecting`, `quarantined`, `interrupted` only; "Any other step (from a terminal status, skipping a status, ...) is **409** `illegal_transition`, and nothing changes."
- harness/checks/selection.mjs: `export const TO_RECORDED = Object.freeze(['materializing', 'running', 'collecting', 'recorded']);` and `recordExit` → `drive(engine, execution, TO_RECORDED, ...)`.
