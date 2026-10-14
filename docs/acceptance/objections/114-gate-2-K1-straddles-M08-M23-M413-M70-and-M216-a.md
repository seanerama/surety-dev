# 114: Gate 2's K1 straddles (M08 cases 3 and 4, M23, M413 (d) ×2, M70 case 1), and M216 (a)'s flaky fixture

Rows: M08, M23, M413, M70, M216
Filed by: Builder, slice 37, 2026-10-14 (gate 2 at 2af0adb on mini-hp01; reruns alone on the workstation)

## How these were told apart

M08 and M23 pass at f767609 and 4144687. They fail at 01470fb and every head since, including ff3118b. Bisected in scratch worktrees, the engine change that exposed them is the tick's nomination step no longer writing an integration lease row on every tick (M303 (a), the driver's ruling). Every other change in 01470fb was reverted one at a time without effect: the finalizing-domain hold, the recovery's wait, and the validator's scope. The lease row slowed each tick enough to hide the cases' K1 assumption. Each case below assumes no tick runs between two of its steps. Under D6 K1 a run's end, a decision's answer and the route itself each request one (M440 (a)), and SEAM §437 migrated none of these.

## The cases and their mechanisms

1. **M08-scheduler-capability-refusals, cases 3 and 4** ("a dispatch is refused before launch with backend_refused").
   - What happens: the refused run's end requests a tick, and that tick dispatches the item again, refused again.
   - Case 3: `preflight_refusals` reads 2, not 1.
   - Case 4: the item never rests `eligible` for the test's 30 s wait. It is redispatched and refused until `preflight_refusals_max` parks it.
   - Proposed: read the refusal with the project paused after the first refusal, or count `>= 1` with each refusal a run that ended `refused`.
2. **M23-partial-clone-no-remote** ("timed out … waiting for run 5 … to be ended").
   - What happens: after the refused run, each failed run's end requests a tick that dispatches the next repair. Runs 2 to 4 fail on the absent blob, and the item parks `repair_attempts_max` before the test writes the blob by hand. Kept store: four runs `failed infra_error`, the item `parked`.
   - Proposed: pause the project after the first refused run, supply the blob, then resume.
3. **M413 (d), both cases** (CONFORMANCE_SOURCE_MOVED not found). `afterChange` takes the last stage-gate evaluation with any reasons, including one made by a requested tick before the change.
   - Case 5 (`[]`): the stage conformed before the change was adopted, and a conformed stage's gate is never due again.
   - Case 6 (`["CHECK_NOT_PASSED"]`): the evaluation read was made before the tampering.
   - Both pass alone on the workstation and fail alone on mini-hp01.
   - Proposed: hold the conformance stage's checks (or pause the project) until after the change, and read the first evaluation after the change's event sequence.
4. **M70 case 1** ("reading writes nothing": `host.observed`). The first tick of a project in an incarnation records the host observation (`pace.observe_host`, D6 §7.6). A tick requested by the case's own setup routes lands inside the "reading writes nothing" window. It passes alone here.
   - Proposed: take the before/after seqs after a tick has run for the project (or with the scheduler held at `scheduler.tick_running`), or exclude `host.observed` from the comparison.
5. **M216 (a)** ("from materializing … quarantined"). This one is not K1: it fails alone at f767609 as well. The flaky part is environmental.
   - At f767609: "timed out … waiting for the execution to be quarantined".
   - At ff3118b: the gate's read shows the check `skipped`, not `missing` with the quarantined execution.
   - In the kept store the execution's domain reads `terminated` with its observation `terminated`, not `unknown`. The case's own comment names this mechanism (objection 029): recovery's kill can empty the killed engine's scope, and the user manager then removes the scope with the domain's directory, so the restart observes termination and nothing quarantines.
   - Proposed: make the case's unknown independent of the scope's removal. For example, keep the domain's directory present-and-unreadable through the restart, or accept the terminated branch as the alternative outcome it is.

## Also seen at gate 2, passing alone here

M66 case 5, M27 case 1, and M15-ambiguous-git-call-reconciled case 2 (after objection 113) pass alone on the workstation at ff3118b.

## Sources

- D6 K1, §7.6; M440 (a); SEAM §437, §441; objections 029, 100, 105, 111, 113.
