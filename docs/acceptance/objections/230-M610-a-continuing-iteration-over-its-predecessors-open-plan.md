# 230: M610 covers only a predecessor that completed its phase; a predecessor that ended with its phase plan open left the next iteration unable to plan, and how that is closed is a design choice for the owner

Row: M610 (`docs/acceptance/sdlc-M7-acceptance-plan.md` §3, "Iterate and the second Alpha")
Test: packages/engine/test/acceptance/M610-iterate-and-the-second-alpha.test.mjs (no case fails; the row has no case for this)
Filed by: Builder, branch build/iterate-open-plan, 2026-11-23
For: the owner (two design questions below); the Verifier (a missing case)

## Claim

M610 (c) asserts that iteration 2 reaches its own Alpha after iteration 1 reached `alpha_ready`, when iteration 1's phase plan is `completed`. It has no case for the normal ending of a prototype that did not finish: `limit_reached`, `stopped` or `failed` with the phase plan still `published` and active. On the live engine at 3fbc6372 (2026-11-23) that case stalled: Iterate cancelled iteration 1's unfinished work (R7) but left its plan `plan_01M66BA6HYTDY6HGT4JM4VXFVG` (phase 1, generation 1) open with both stages `integrated`; iteration 2's first plan passed the plan check and its publication was refused `plan_generation_stale` ("phase 1 has an open plan (…); a replacement is the early-replacement route's", plan/bundle.ts finalizeReplan, the one-open-plan rule of D6 §5.2); the replan completed, nothing was raised, and the project read "Nothing is under way, nothing waits for you, and no work can be dispatched" while iteration 2 was `building` with its runtime clock running.

The row should require, beside (c): (e) after iteration 1 ends `limit_reached` with its phase plan open and a stage integrated, `…/iterate` and iteration 2's approved brief lead to its own first plan published `policy_authorized` and on to its own Alpha; iteration 1's receipt, runs, ledger rows and outcome unchanged.

## What the Builder built (commit on build/iterate-open-plan)

Iterate closes the predecessor's open plan in its own transaction (prototype/iterate.ts `closeOpenPlans`): the plan becomes `replaced`, inactive, with no `replaced_by`; each active stage ends as §5.7's swap ends a superseded one (`planned`/`building` `cancelled` with `cancelled_at`; `integrated`/`verified` keeps its status and integrated revision as history with `cancelled_at`, so its modules stay in the phase scope, store/transitions/evidence.ts); the record `{closed_by: 'iterated', iteration, successor, cancelled, superseded}` is on the plan's `replacement`, and Iterate's response and `prototype.iteration_iterated` name it (`closed_plans`). The new iteration's first plan is then the project's next plan (phase 1, generation 1), published under the prototype policy as any first plan; its check authoring is registered as any new plan's. A completed plan is not touched. The Architect's package for that plan says what it continues (plan/replan-package.ts), instead of "Nothing is approved yet".

## Design question 1: the fallback, not §5.7's early replacement

The designed route for a second plan of an open phase is §5.7's compare-and-swap. The Builder did not take it because it cannot carry this case without changing the swap's rules, which the spec does not allow:

- The swap keeps every `integrated` or `verified` stage "whatever its work's state" (plan/replace.ts `isKept`). Iterate has just cancelled that work (R7: the predecessor's unfinished work is not carried). A stage depending on a kept stage whose work is `cancelled` never meets its stage-code milestone (store/transitions/runs.ts: `work_status === 'cancelled'` → "depends on stage …"), so it would never dispatch.
- Kept stages count toward `phase_size` (plan/check.ts: "Kept stages count toward it"; the prototype preset is `{1, 2}`), and withinPrototypeBounds counts only the stages the plan lists. With the live store's two integrated stages, any replacement adding a stage for the owner's change is outside the bounds and goes to the owner; one adding nothing builds nothing of the new brief.

If the owner prefers the replacement route, it needs a ruling that a prototype iteration's replacement supersedes rather than keeps the predecessor's stages (or that Iterate does not cancel an integrated stage's work), and the bounds read accordingly.

## Design question 2: a store iterated before this fix

On such a store (the live one) the first plan's proposal is already `stale` and its replan `complete`; nothing re-raises it. What the Builder built only says so: the iteration's `next_step` becomes "none can be dispatched: the first plan (bundle …) was not published: <the stale reason>; stop this iteration and iterate, or discard", and the project's NOW names it. Stop then Iterate works (Iterate now closes the open plan), at the cost of a new preparation. The iteration stays `building`, so its runtime clock keeps running until the owner acts. Whether such an iteration should instead end (`failed` or `awaiting_owner`, stopping the clock), or whether the engine should itself close the predecessor's plan and raise the first plan's next generation, is a behaviour the spec does not state; the Builder did not invent it.
