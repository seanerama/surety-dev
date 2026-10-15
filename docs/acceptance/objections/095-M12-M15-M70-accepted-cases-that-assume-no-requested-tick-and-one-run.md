# 095: accepted cases of M12, M15 and M70 assume a project's second item waits for the test's tick and runs alone, which K1 and K2 change; and `workPath` reads the hold events as transitions

Rows: M12, M15, M70 (and the work-history invariant used by M15, M18 and others)
Tests:
- packages/engine/test/acceptance/M12-scheduling-boundaries.test.mjs, case "pausing lets the run under way finish and holds back what would follow it"
- packages/engine/test/acceptance/M15-decided-outcome-stands.test.mjs, case "the Stop is refused with illegal_transition, the run ends timed_out and the work is parked behind the deadline blocker"
- packages/engine/test/acceptance/M70-scoped-reads-and-now.test.mjs, six cases (listed below)
- packages/engine/test/acceptance/harness/invariants.mjs, `workPath`
Filed by: Builder, slice 37, 2026-10-14

## Claim

Each file was run alone on `build/m5-s37` (after e05f45b, with `work.dispatched` removed). Results: M12-scheduling-boundaries 7/8, M15-decided-outcome-stands 3/4, M70 15/21. M15-lease-supervision 8/8 and M71-latency 2/2 now pass.

**M12, the pause case.** `first` (held at `gate`) and `next` are both eligible when the case calls `tick`. Under K2 (no run count at project scope) that tick dispatches both, before the pause. So "nothing new is dispatched while paused" finds `next`'s run (`1 !== 0`). The engine dispatched it before the pause, not during it. I propose `next` is added after the pause, or after `first` is holding with the project paused. A second case, "concurrency across projects is bounded by the domain slots", failed once on an earlier run with an interval overlap of 2: the domain terminates, freeing its slot, before `run.ended` is recorded. It passed this time. I have not pinned that case down further.

**M15, decided outcome.** The case arms 8 `before_event` faults on `run.finalizing`, with no subject. `next` (verification) is added while `first` is executing. Under K1 its creation requests a tick, and under K2 that tick dispatches `next` beside `first`. `next` completes at once, and its own `run.finalizing` attempts use up the faults. So `first` records its end within the 2.5 s window: "(ended, timed_out) … the engine attempted it more than 8 times". `before_event` takes no subject (`testing/seam.ts`), so I propose `next` be added after `first`'s end is recorded, or the project be paused once `first` is executing.

**M70, six cases.** Each one creates eligible work with a fixture or route, then asserts nothing is dispatched until the case ticks:
- "NOW is one state per project…" and "the execution facts stay true…": "the ready project has no run under way" finds a claimed run.
- "reading changes nothing and calls no adapter…": "the last read gives the facts the first one gave". A requested tick dispatched between the reads.
- "a project's work items are listed…": the other project's item is `claimed`, not `eligible`.
- "a candidate's gate read…": "after six gate reads: no stored row changed". A new run, domain, grant and worktree operation appeared between the reads.
- "an unresolved out-of-band change of the integration branch…": `addItem` requests a tick (`work_eligible`) before `commitOnRef` moves the branch, so the item is dispatched before the move is observed (`runsOf … 1`, expected 0).

Before K1, nothing ticked between a fixture and the case's own `tick`. D6's C.2 names M12, M15, M18, M71, M26 and M33 as K1 straddles, but not M70. I propose these cases pause the project (or hold the item) while their fixture is built, or make the work after the state they read is in place. The engine follows D6 K1 ("a transition that makes work eligible … requests a tick"; SEAM §430 `work_eligible`, pinned by M440 (a)).

**The work-history invariant.** The slice-37 events `work.hold_began`, `work.hold_ended` and `work.dependency_met` carry `subject.work_item` and no `from`/`to`. `workPath` reads every `work.%` event as a transition, so `assertWorkHistory` fails on any item that was held or waited on a dependency ("… starts where the previous event ended"). No case I ran hit it this time, but an M15 or M18 case whose second item waits behind the envelope would. I propose `workPath` skip `work.*` events that carry no `to`.

## Sources

- D6 K1 and K2; D6 C.2 (the straddle list); SEAM §§426, 429, 430.
- Objection 094 (the same K1 hazard in M436).
- `store/transitions/tick-requests.ts` `requestOf` (the causes that request a tick).
