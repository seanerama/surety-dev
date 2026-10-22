# 208: M15's run-end fault matrix compares `scheduler.tick_requested` counts between a faulted and a no-fault ending, and they differ (17 against 19) in isolated runs on an idle host

Row: M15 (the run-end fault matrix, M1), cases "a preflight refusal after a lease was issued; the transaction that <X> fails once: the same facts as with no fault, without a restart"
Test: packages/engine/test/acceptance/M15-run-end-fault-matrix.test.mjs, test group 3 "M15 ending a run is repeatable: a preflight refusal after a lease was issued", cases 2 to 6
Filed by: the driver on Sean's instruction, 2026-10-22, as a **Verifier investigation** (not a Builder objection: no engine change is proposed and no test is claimed wrong; the Verifier answers in `208-M15-tick-request-count-differs-alone.answer.md`). Errata E179 item 6 records the observation and Sean's bounded validation exception.

## What was observed

At revision `f8c27db3` (main after the fast-forward merge of `verify/f29-alpha-handover`; the branch changes nothing M15 executes), M15 run alone, serially, with `node --test --test-concurrency=1`:

| Host | Run | Result | Failed cases |
|---|---|---|---|
| mini-hp01 | 1 | 87/87 | |
| mini-hp01 | 2 | 86/87 | `work.advanced` fails once |
| mini-hp01 | 3 | 82/87 | `invocation.status`, `run.finalizing`, `domain.terminated`, `run.ended`, `work.advanced` each fail once |
| mini-hp01 | 4 | 87/87 | |
| mini-hp01 | 5 | 87/87 | |
| workstation | 1 | 87/87 | |
| workstation | 2 | 87/87 | |

In the preceding three-worker gate at the same revision the `run.finalizing` case failed once under load (440 files, 2,416 passed, 5 failed).

In every failed case the assertion is the fault matrix's "the final durable facts differ from those of the same ending with no fault", and the diff is a single counter: `events['scheduler.tick_requested']` 17 in the faulted ending against 19 in the no-fault ending (round 2), or 19 against 17 (round 3). Every other compared fact (work items and their paths, `preflight_refusals`, decisions, runs, every other event count) was equal. mini-hp01 was idle: load average 0.75, 0.93, 0.69; 11.9 GB available; no other engine or gate running. Node v22.22.0 on both hosts.

Logs: `~/s7-1020/gate-f29b-logs/f29b-alone{,2,3,4,5}-M15-run-end-fault-matrix.log` and `workstation-M15-round{1,2}.log` on the workstation; `~/gate-logs/f29b-alone*` on mini-hp01. M15 had failed in earlier three-worker gates and passed three of three alone each time (E170 item 2, E171 item 1, E178 item 6); this is its first recorded failure alone.

## Questions for the Verifier

1. **Is the tick-request count a required invariant of the fault matrix?** D1's fault model (foundations §4 and D1 A, the run-end transactions and their repeatability) requires the same durable facts after a once-failing transaction as with no fault. Is the number of `scheduler.tick_requested` events a durable fact the design fixes, or an artefact of when the scheduler's requested ticks (K1, E-slice 37) land relative to the recovery step? Cite the design text that decides it.
2. **Is the comparison synchronised correctly?** Does the test read both endings' facts after the engine has settled (no requested tick pending, no recovery owed), or can a tick requested during the ending be counted in one run and not the other? If the test's settling condition is the gap, the correction is to the test's synchronisation, not to the assertion's content.
3. **Does the same failure occur on the pre-change baseline?** Run M15 alone, repeatedly (at least five times on mini-hp01), at `db143fe3` and at `f92a0990`, with the same procedure (`~/rerun-alone.sh`), and record every result. The merge candidate changed nothing M15 executes; the baseline result decides whether this is a latent nondeterminism of the kernel or of the test.
4. If the count is a required invariant and the comparison is synchronised, the finding is the Builder's: the engine's tick requesting is not deterministic under a once-failing ending transaction, and it is a failing acceptance test. If the count is not an invariant, say what the fault matrix should compare instead and change the test with a failing case first.

**Do not weaken the assertion merely to obtain a pass** (Sean's instruction of 2026-10-22). Removing `scheduler.tick_requested` from the comparison without a source that says it is not an invariant is a weakening.

## Sources

- D1 A (engine core): the run-end transactions, each repeatable, "the same durable facts" after a once-failing transaction; the scheduler's requested ticks (E-slice 37, K1).
- M1 acceptance plan row M15: the run-end fault matrix.
- Errata E170 item 2, E171 item 1, E178 item 6 (M15 under load, passing alone), E179 item 6 (this observation and the exception).
