# 215: the pause point `assistant.before_spawn` is reached by the engine but is not one of the seam's barrier names, so no test can arm it

Row: M554
Test: packages/engine/test/acceptance/M554-the-assistant-recovery.test.mjs, case "(c) kernel lane: a turn completes on the scripted boundary; one killed at assistant.before_spawn is ended refused at the next start, nothing charged or launched, never replayed (needs objection 215)"
Filed by: Verifier, branch verify/assistant-rows (from engine main 600b6e88), 2026-10-27

## Claim

This objection runs the other way from most: it is the Verifier's, against the engine's seam, not against a test.

`src/invoke/assistant-turn.ts` (the kernel lane's path, `AssistantTurns.kernel`) awaits `pausePoint('assistant.before_spawn')` after a turn was dispatched (`dispatch_started`) and its context package was written, and before its backend is spawned. The Builder's record names it as the harness's handle on that moment ("pause point `assistant.before_spawn`", RECORD.md of batch-2026-10-27b, and the driver's brief for these rows). But `src/testing/seam.ts` does not list `assistant.before_spawn` in `MAIN_BARRIERS` (nor in any list that makes up `BARRIER_NAMES`), so:

- `surety serve --harness --harness-barrier assistant.before_spawn=kill` exits 2: "unknown barrier or action in --harness-barrier assistant.before_spawn=kill" (observed, M554 (c) on 600b6e88);
- `POST /v1/harness/barriers {"name": "assistant.before_spawn", "action": "kill"}` is refused 400 `invalid_value` ("Unknown barrier or action"; `armBarrier`, seam.ts).

`pausePoint` only fires for a name in its registry, and only those two routes put a name there. The pause point therefore never fires in any engine, and the case it exists for (a turn the engine was killed in before anything was spawned: recovery ends it `refused`, reason `recovered`, no ledger row, the reservation released, never replayed; `AssistantTurns.recover`, "A turn that never launched is ended `refused`") cannot be reached by a test.

I ask the Builder to add `assistant.before_spawn` to the seam's main-thread barrier names (as `launch.before_spawn` is for a run), so both routes accept it with `pause` and `kill`. Until then M554 (c) fails at the engine's start; its other two cases are unaffected.

Observed (600b6e88, the file run alone): M554 3 tests, 1 pass, 2 fail: (b) by design (the usability batch's new behaviour, not on 600b6e88); (c) "engine exited code=2 … unknown barrier or action in --harness-barrier assistant.before_spawn=kill", after its first part (a kernel-lane turn completing on the scripted boundary) had passed.

## Sources

`packages/engine/src/invoke/assistant-turn.ts`, `AssistantTurns.kernel`: `await pausePoint('assistant.before_spawn');` followed by `if (turn.decided !== null) { … return this.end(c.invocation, { ...turn.decided, outcome: 'refused' }); }` and the spawn.

`packages/engine/src/testing/seam.ts`: `pausePoint(name)` "if (!entry || entry.state !== 'armed') return;"; `parseBarrier`: "if (!BARRIER_NAMES.includes(name)) return null;"; `armBarrier`: "if (typeof name !== 'string' || !(MAIN_BARRIERS.includes(name) || LAUNCHER_BARRIERS.includes(name)) …) throw new Refusal(400, 'invalid_value', 'Unknown barrier or action.' …".

The assistant design (usage-account-design-e0303e4.md) §4, last row: "Engine killed mid-turn | `recovered` at start (D1 §16.1) | row as observed + allowance | … **never replayed**"; and `AssistantTurns.recover`'s comment: "A turn that never launched is ended `refused` (nothing was spent)."

SEAM.md §7 (Confinement) and §33 (barriers armed while the engine runs): a barrier is a name the seam lists; a name the engine reaches that the seam does not list is a pause point nobody can use.
