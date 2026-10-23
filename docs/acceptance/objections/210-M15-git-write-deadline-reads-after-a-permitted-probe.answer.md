# 210, answered: the engine keeps the retry/deadline contract; the case read the branch update after a probe the contract permits, because its scheduler barrier could catch a tick that began its journal step with the update in flight

Answer to `210-M15-git-write-deadline-reads-after-a-permitted-probe.md`, by the Verifier on `verify/f33-git-write-deadline`, cut from `a158fe1e` (= `verify/f33-t23`; neither that branch, `build/f33-fix-verifying` nor `main` was moved), 2026-10-23.

**In one paragraph.** The engine does not violate the retry/deadline contract.
- **What the engine did.** In the failing interleaving it killed the held `update-ref` at `git_deadline` and recorded the operation and its one attempt ambiguous. The next journal step to meet the operation probed it (`read refs/heads/main` → `absent`) and recorded the attempt `reconciled_absent`. It then paused at `journal.ref_update.reconciled` before any retry. No second attempt was made: D1 §8.1 step 2, SEAM §45.
- **What the case did.** It read the operation after that probe, which the contract permits.
- **Why.** Its `scheduler.tick_running` barrier, armed after the commit's finalization had been read, sometimes caught a tick other than the commit's own. That tick began its journal step with the update in flight. So the barrier did not hold the scheduler "from the commit's finalization", as SEAM §447 says the case does.
- **What the failure was.** It read `['ambiguous', 'intended', ['reconciled_absent']]`, not a retry journaled early. The `intended` is the operation status derived from a `reconciled_absent` latest attempt.
- **`fixes.ask_unjudged`** does not change the ordering. The same interleaving occurs, naturally and forced, on `bf1ca304`, which lacks it, and on a candidate copy with it removed.
- **The correction is the Verifier's,** in the test's synchronization only. It is made on this branch; the assertion is unchanged.

## 1. What the barrier actually guarantees

**The tick** (`src/scheduler/tick.ts`, identical in this part on both revisions) runs these steps, in order:
1. the prerequisites `recover`, `journal` (`reconcileProject`, then the nomination step, then `ender.retryDue`), `integrity`, each under `withinBudget` (`tick_step_budget`, 5 s by default; a step over budget goes on in the background while the tick continues);
2. `budgets`;
3. `decide()` (gates, the phase, `fixes.ask_unjudged` on the candidate, and the rest);
4. checks, deploy, sessions;
5. **`pausePoint('scheduler.tick_running')`**;
6. select and dispatch;
7. `engine.tick`.

The scheduler runs one tick after another (`loop`; requests coalesce).

**So `scheduler.tick_running` (SEAM §441) guarantees two things:**
- The **first tick to reach that point after the barrier is armed** is held before select. While it is held, no other tick runs, so no new journal step begins.
- That tick has **already run its prerequisite steps**.

**What it does not guarantee:**
- **when** that tick's journal step ran, relative to the branch update's attempt and its kill;
- that the held tick is the commit's.

**The case's assumption.** The case's comment assumed "a tick that ran its journal step while the update was still in flight" leaves the update alone. That assumption fails in the driver (`src/journal/driver.ts`):
- A journal step that finds the update being driven by the integration (`runs/accept.ts`, `journal.withProject(project, () => journal.drive(op))`) waits for the project's journal lock.
- When the kill ends that drive `ambiguous`, the step takes the operation, reconciles it (probe, `reconciled_absent`) and pauses at the reconciled barrier.
- The step is then over budget. The tick goes on and reaches `tick_running` about 5 s after the step began.

## 2. The ordering, traced

**The instrument.** A scratch copy of the case, run up to the read with the case's own calls, recording:
- the test's own marks;
- the store at the read: the journal events, the attempts with their reconciliation reads, and every event;
- in two private, uncommitted instrumented copies of the candidate (one with `fixes.ask_unjudged`, one without), a timestamped log of each tick's phases written by the engine.

Every run's full output is kept (section 6).

**The failing interleaving.** `cand-instr-inflight-f1` (instrumented candidate, forced ordering; times in seconds past 20:08):

| time | who | what |
|---|---|---|
| 00.178 | test | the commit's `reconciled` barrier released |
| 00.226 | engine | commit `finalized` (its finalization requests a tick) |
| 00.237 | engine | the commit's tick: its journal step ends |
| 00.259 | engine | **that tick reaches and passes `tick_running`** (not yet armed), then dispatches `later` (`worktree_add`) |
| 00.375 | engine | it ends; the next tick's journal step finds nothing in flight and it passes `tick_running` at 00.468 |
| 00.457, 00.469 | engine | the branch update intended (by the run's ender) and its attempt started |
| 00.486 | test | `scheduler.tick_running` armed; a tick requested |
| 00.498 | engine | **the tick that will be held begins its journal step: the update is in flight**; it waits for the journal lock |
| 02.483 | engine | the held `update-ref` killed at `git_deadline`: journal `ambiguous`, attempt `ambiguous` |
| 02.507 | engine | **probe**: `read refs/heads/main` → `absent`; attempt `reconciled_absent`; paused at `journal.ref_update.reconciled` (no retry) |
| 05.505 | engine | the journal step over budget; the tick goes on |
| 05.522 | engine | `tick_running` reached and held |
| 05.798 | test | read: `['ambiguous', 'intended', ['reconciled_absent']]`, failing "its one attempt was killed at the deadline" |

**The natural failures.** The same signature appears in every natural failure, all seven of them, on every build (`docs/acceptance/reports/objection-210/natural-runs.tsv`):
- the commit's tick ended 104 to 135 ms after the case armed the barrier, having dispatched `later`, so it had passed `tick_running` before the arming;
- the probe followed the kill by 18 to 67 ms;
- the case reached the barrier 5.2 to 5.6 s after arming (the journal step's budget).

**The passing runs.** In every pass the tick held was one whose journal step ran before the update was in flight:
- usually the commit's own tick, caught in `decide()`;
- in three passes, the tick after it.

The race is between the commit's tick reaching select, about 10 to 20 ms after the finalization when unloaded, and the case's own reads and HTTP call to arm the barrier. Load widens the case's side of it.

**The value in the gate.** The surviving six lines of the comparison run's message show `+ 'intended'` at the outer array's second position, the operation's `status`, with the leading `'ambiguous'` (state) equal. That is exactly the value reproduced here. It is not "a retry attempt already journaled" (attempts `['ambiguous', 'intended']`): no attempt status `intended` exists (`AttemptStatus` in `src/store/transitions/journal.ts`). The gate's full output was not preserved, so its third element (the attempts) cannot be shown from the gate itself.

## 3. `fixes.ask_unjudged`: changes the ordering, or exposes an existing race?

**It exposes an existing race; it does not change the ordering.**

**What the step is.** `fixes.ask_unjudged` is one `engine` call per project in `decide()`. That is after the journal step and before `tick_running`; `bf1ca304`'s `tick.ts` differs from `a158fe1e`'s by exactly those five lines.
- **It touches nothing here.** In this case it selects verifying `fix` items, and the project's `fix` is `integrating` throughout the window. So it reads nothing further, writes nothing, raises nothing and requests no tick (`askUnjudgedFixes`, `src/store/transitions/queue.ts`).
- **It is fast.** In the instrumented copy it takes 0 to 2 ms.
- **It cannot move a journal step.** It can lengthen `decide()` by one store round trip, nothing else.

**The evidence that decides it:**
- **Forced, `inflight2`.** The case's synchronization is kept, and the barrier is armed only once a tick has ended after the update's attempt began. The run fails with the identical value on all four builds: `bf1ca304`, `a158fe1e`, the candidate with the step removed, and the candidate instrumented. It fails on the baseline without the step as on the candidate with it.
- **Natural, unloaded.** The case's own synchronization, bounded runs, each kept, observed the failing interleaving on every build:

| build | `fixes.ask_unjudged` | runs | failed |
|---|---|---|---|
| `bf1ca304` | absent | 5 | 1 |
| `a158fe1e` | present | 6 | 4 |
| `a158fe1e` with it removed | absent | 6 | 1 |
| instrumented `a158fe1e` | present | 7 | 0 |
| instrumented, removed | absent | 7 | 1 |

In all, 4 of 13 runs with the step failed and 3 of 18 without it. These counts do not separate the builds. The comparison's two candidate failures against one baseline pass, under load, are consistent with a timing race. It cannot be established from bounded runs whether the step shifts its frequency, and I do not claim that it does.

## 4. The deciding question

**The test samples state after progress the contract permits. The engine does not violate the retry/deadline contract.**

- **D1 §8.5, SEAM §47 (the deadline).** The write is killed at `git_deadline`, the operation is recorded ambiguous, and nothing is taken for made or failed on the strength of the timer. **Kept:** the journal is `ambiguous` and the attempt `ambiguous` at 02.483, before anything else.
- **D1 §8.1 step 2, SEAM §45, correction 16 (the probe and the retry).** The next journal step probes an ambiguous operation. The attempt is reconciled before anything follows, and a new attempt only after positive reconciliation. **Kept:** the journal step's probe found the ref at its old commit (`absent`), recorded `reconciled_absent`, and paused at the `reconciled` boundary ("Nothing that follows from it has been done: no new attempt has been issued"). There is one attempt in the store.
- **M15's row (dependent dispatch suppressed).** **Kept:** no new run of `later` while the update was unresolved. In the failing runs `later` was dispatched before the update was intended, which §447 permits ("`later` may run while the run's own writes are in flight").
- **Objection 100 / SEAM §447 (the case's own model: hold the scheduler "from the commit's finalization").** **Not implemented by the case:** the hold began after the finalization had been read, so the tick held could be a later one. This is the defect, and it is the test's.

## 5. The correction, and who owns it

**The test's synchronization: the Verifier's.** It is made on this branch, in `packages/engine/test/acceptance/M15-git-write-deadline-in-a-running-engine.test.mjs`, and recorded in SEAM.md §565:
- **Arm both barriers early.** As soon as the commit's `journal.commit_tree.reconciled` barrier is reached, and before the commit's retry is let go, the case arms `scheduler.tick_running` and `journal.ref_update.intent_committed`.
- **Reach both before letting the update go.** The update is then intended and not begun, so every journal step leaves it to its caller (`isFresh`). And a tick is held before select, so no other tick runs.
- **Count the ticks.** The case counts `engine.tick` rows, lets the update go, reads its ambiguity, and asserts that the count is unchanged: no journal step began while the update was in flight or after its kill. It is counted, not dated, because this host's clock is not monotonic (E36). A first version compared timestamps, and a clock step made it report ticks "after" the commit's probe that had ended before it. That is the run `corrected-M15-base-alone.log`, failing on the precondition, not on the assertion. It was replaced.
- **Unchanged:** the assertion `['ambiguous', 'ambiguous', ['ambiguous']]` "the branch update is ambiguous: its one attempt was killed at the deadline", its intent, the branch, the held writes, the windows, the probe, the retry and the end. No timeout or budget was changed.

**The engine: nothing.** No engine change is proposed and no Builder brief is needed.

**Results of the corrected case:**
- **Alone, the whole file:** `a158fe1e` 2/2 (`corrected-M15-cand-alone-2.log`); `bf1ca304` with the corrected file 2/2 (`corrected-M15-base-alone-2.log`).
- **Under bounded load, once per revision:** `node --test --test-concurrency=5` with M15-git-write-deadline, M440-a-storm-of-completions, M15-run-end-fault-matrix, M433-a-failed-correction-and-a-partial-one and M29-ref-update-probe. The corrected case passed 2/2 on both (`loaded-cand.log`, `loaded-base.log`).
  - **Other failures, not investigated (outside Sean's scope):** M440 (e1) failed on both revisions ("23 of 47 items complete"). M29 "ref_update, journal intended, effect found conflicting …" failed on `a158fe1e` only (`confirmed` where `finalized` was expected).
  - Both are in the gate's own failure list. M29's is also a read of a `ref_update` operation before the engine's progress was complete, and may share this kind of cause. That was not established here.
- **The same synchronization, adversarially** (the instrument's `corrected4-delayed`, with the test thread paused 3 s and 6 s after the commit's finalization, the 6 s pause beyond a journal step's budget): the contract's point was read on `bf1ca304` and `a158fe1e` at both delays.

## 6. Commands and preserved output

**Setup.** Everything ran from `~/wt-f33` at `a158fe1e`, and from private copies made with `git archive` into `/tmp/vgw`:
- `base` = `bf1ca304`;
- `noask` = `a158fe1e` with the `fixes.ask_unjudged` line removed;
- `cand-instr` and `noask-instr` = `a158fe1e` with tick-phase logging, with and without that line (`instrument/instr.py`).

Each copy was built with `npm run build`. `TMPDIR=/tmp/vgw/t` throughout, giving engine homes under `/tmp/vgw/t/` (well under 56 bytes). No real lane, no exhaustion lane, no unit, no host change.

**Commands:**
- The instrument: `GWD_ROOT=<checkout> GWD_MODE=<as-is|delayed|inflight|inflight2|corrected|corrected2|corrected3|corrected4-delayed> GWD_TAG=<tag> [GWD_DELAY_MS=<ms>] [GWD_TICK_LOG=<file>] node --test --test-reporter=spec gwd-trace.instrument.mjs > <tag>.log`
- The corrected case: `node --test --test-reporter=spec packages/engine/test/acceptance/M15-git-write-deadline-in-a-running-engine.test.mjs`, in each checkout.
- The loaded run: `node --test --test-concurrency=5 --test-reporter=spec <the five files>`.

**Preserved** in this branch, at `docs/acceptance/reports/objection-210/`. Each file in `runs/` is one run's complete output:
- `runs/`, per run:
  - `<tag>.log`: the full `node --test` output;
  - `<tag>.json`: the marks, the observed value, the barriers and the store's trace at the read;
  - `<tag>.ticks`: the engine's tick-phase log, from the instrumented copies;
- `runs/corrected-M15-*.log` and `runs/loaded-*.log`;
- `natural-runs.tsv` and `all-runs-observed.txt`: the tables above;
- `instrument/`: the scratch instrument and its readers.

The originals are also under `/tmp/vgw/out`.

## 7. What could not be established

- **The gate's own value.** The gate's full assertion output, and so its own third element (the attempts), was not preserved. The reproduced value matches the surviving fragment exactly, and it is the only one consistent with the engine's status derivation.
- **The step's effect on frequency.** Whether `fixes.ask_unjudged` changes how often the race lands on the failing side: bounded samples (4/13 with, 3/18 without) cannot separate it. The ordering is the same with and without it.
- **The early clock-step anomaly.** In one instrumented run the engine's tick log was appended out of time order, and a first, time-based version of the correction's precondition failed on the baseline. A clock step on this host (E36) is the likeliest cause; it was not proven. The correction no longer reads time.
- **The other failures.** M29's and M440's failures under load were not investigated.
