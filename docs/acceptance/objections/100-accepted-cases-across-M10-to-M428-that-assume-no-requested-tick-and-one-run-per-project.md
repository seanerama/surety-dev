# 100: accepted cases in M09, M10, M12, M15, M16, M26, M43, M403, M405, M406 and M428 assume that nothing ticks between the case's own ticks, or that a project runs one item at a time, which K1 and K2 change

Rows: M09, M10, M12, M15, M16, M26, M43, M403, M405, M406, M428
Filed by: Builder, slice 37, 2026-10-14

## How these were found

The slice-37 at-risk kernel set (84 files) was run on `build/m5-s37`, each file alone. Each file listed here was then rerun at 8aa355a (quarantine fix and validator scope in). The files listed also pass on the base this branch started from: `build/m5-s36` at 30a2886, built in a scratch copy and run file by file. The base's results were M403 9/9, M405 6/6, M406 1/1, M428 5/5, M43 7/7, M15-git-write-deadline 2/2. M09, M10, M12, M15, M16 and M26 also pass on `main` at 0cc869f, where they were accepted.

Where it helped, a failing case's engine home was kept (`SURETY_KEEP_TMP=1`) and its store read. For each case below, the engine does what K1 or K2 says, and the case relies on what they removed. This is the same class as objections 094 and 095. D6's C.2 names M12, M15, M18, M71, M26 and M33 as straddles; the rest here are not named there.

## The cases

**The work-history invariant (M09, M12).** These cases fail on the slice-37 events `work.hold_began` and `work.hold_ended` (SEAM §431: `subject.work_item`, no `from`/`to`). They are no longer hypothetical as in 095:
- `M09-after-integrated` "a stage_build item runs its path as far as verifying…": "work.hold_began (seq 101) of wi_… starts where the previous event ended; path so far eligible".
- `M12-chain-of-roles`, both cases, the same.
The proposal is 095's: `workPath` skips `work.*` events that carry no `to`.

**K2: two items of one project run at once.**
- `M10-trigger-identity` "a new generation stays subject to the project pause and to the one run a project may have": "no second run in a project that has one", `1 !== 0`. The rule it names is the run count K2 removes.
- `M16-quarantine`, four cases ("the role process exited, but the boundary still reports the domain running", "the boundary cannot read membership", "cancellation fails…", and "with the boundary reporting unknown, a stopped role…"): "nothing else of the project is dispatched onto what the run still holds", `1 !== 0`. Each case makes `waiting` eligible before its first tick, so that tick dispatches `waiting` beside the run, before any quarantine exists. Nothing is dispatched onto a quarantined project: 8aa355a restores that rule, and `M14-abandon`, which adds its second item after the quarantine, now passes 14/14. I propose `waiting` be added once the quarantine is observed.
- `M43-severity-tier-and-independence-floors` "a Critical finding blocks…": "timed out after 30000 ms waiting for every run of proj_… to end". The kept store shows the stage's `stage_build` work back in repair after the case's failed `import` result. Its second run is executing with no script (`HOLD_FOREVER`) beside the Reviewer's run, so `waitForIdle` never holds. Before K2 the Reviewer's item ran alone. Objection 030's remedy applies: `repair_attempts_max: 0`, or a script for the repair.
- `M428-the-phase-gate-and-t1-nomination` "(a), (b), (f) T1…": `ordinary` is `null`, expected `{candidates: 0, executions: 0}`. The two stages' Builders run at once, and the pump never sees stage 1 integrated with stage 2 not. The engine behaves as the row wants. In the kept T1 homes there is one `candidate.nominated` (seq 561), followed by both stages' `work.advanced … verifying` (562, 563). The case's sample point no longer exists. I propose the sample be taken at stage 1's `work.advanced → integrated` event, from the store, rather than by polling.

**K1: work made eligible, a run's end or an operation's finalization requests a tick.**
- `M15-deadlines` "a prerequisite step that overruns its budget suppresses that project for the tick…" and "a tick that has used up its budget dispatches nothing more". Also `M15-git-deadline-and-integrity-step` "an integrity step that overruns…". Each case adds its items, then arms the `tick_step` fault. The items' `work_eligible` requests a tick in between, which dispatches them before the fault exists (`1 !== 0`). I propose the fault be armed before the items are added.
- `M15-git-write-deadline-in-a-running-engine`, both cases. The case adds `later` once the run exists. That request makes the next tick's journal step probe the killed write at once. So the commit's attempt is already `reconciled_absent`, and the operation `intended`, when the case reads it as `ambiguous`. In the second case the operation is `finalized` within the three seconds. I propose `later` be added after the case has read each ambiguous state, or with the project paused.
- `M26-plan-and-stage-finalizers`, three cases of the first describe and one of the second. The registered plan's stage work requests a tick and is dispatched, so the stages read `building`, not `planned`. Across a restart, the dispatched runs' worktree operations are reconciled. I propose the project be paused before the plan is registered.
- `M403-close-raises-the-products-decision` (e) and (f). The second session's save finalizes an operation, which requests a tick, and that tick finds the bundle stale (`plan.generation_refused`, its decisions invalidated with `plan_generation_stale: the integration head moved …`). The answer is then refused `plan_generation_stale`, not `decision_stale` or `decision_invalidated`. The refusal is a stale one, under D6 §5.7's own code. I propose `assertStaleAnswer` here accept `plan_generation_stale`.
- `M405-plan-published-by-the-authorized-finalizer` (c). Phase 1's publication makes its `check_authoring` work eligible, and the requested tick dispatches it, with no script. The case's `POST …/sessions` is then refused 409 `session_busy` ("has a one_shot run … verifier … that has not ended"). I propose a script for `check_authoring` (or the project paused) before the publication.
- `M406-a-phase-sign-off-before-a-new-protected-version`. The case expects nothing to tick between the Verifier's sign-off and its approval of the correction ("before any tick, the correction approved"). The run's end requests a tick, and the phase step completes phase 1 on the sign-off first ("the fixture is live: the phase did not complete before the new version took effect"). I propose the case approve the correction while the Verifier still holds, then release it.

## Not in this objection

- `M430-two-replacements-and-a-restart` and `M430-blockers-and-reopened-dispositions` (iii). Under K2 the two replans run at once. The second one's change to `.surety/phases/phase-1.json` conflicts with the first one's integration: `integration_conflict`, parked, so there are never two pending approvals. Whether replans of one project should run one at a time is put to the driver as a design question, not objected here.
- `M429-a-phase-sign-off-on-a-superseded-candidate`: objection 092.
- `M401-the-t1-variant-on-the-scripted-backend`, `M433-old-generation-runs-and-what-resolves-an-obligation`, `M434-an-unassigned-requirement`: they fail on the slice-36 base too (30a2886: M401 2/3, M433 1/3, M434 0/1). They are slice 36's.

## Sources

- D6 K1 and K2; D6 C.2; SEAM §§426, 429, 430, 431.
- Objections 030, 092, 094, 095.
- `store/transitions/tick-requests.ts` `requestOf`; `store/transitions/runs.ts` `dispatchBlocker`.
