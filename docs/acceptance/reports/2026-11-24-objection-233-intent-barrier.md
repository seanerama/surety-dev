# Objection 233: the held answer now holds the application (Verifier report, 2026-11-24)

**Item.** Objection 233 (Builder, from DECISIONS item 50): item 47's hold at `scheduler.tick_running` around the owner's answer in M626 (a) and M616 (e) holds the tick, but the answer's own effect applies the approved proposal at once, off the scheduler (`runtime.ts` `afterCommit` → `services.effect`, not awaited; `decisions/effects.ts` `execute` → `applyProposal`), so the "approved, not yet applied" reads could see `applied` / `present`.

**Branch.** `verify/m626-m616-intent-barrier`, from engine main 60319f5f. Test change: commit 8052cf4c. The objection file is the Builder's commit 24f31f84, cherry-picked (b6841231), with the resolution appended. Engine and harness unchanged.

**Evidence.** `~/surety-evidence/batch-2026-11-24/objection-233-intent-barrier/` (`status.log` plus one `<label>.log` per run, TAP).

**Host.** The workstation (WSL2), Node v22.22.0, `TMPDIR=/tmp/ibv-v`, run from `packages/engine`. None of the six files is listed under manifest `real` or `exhaust`.

## The change

Inside the existing `held(fx, project, body)` around the answer, in both files:
1. `armBarrier(fx.engine, 'intent.recorded', 'pause')`;
2. `consume(fx, p.id, J.decision, 'approve')`;
3. `reached(fx, 'intent.recorded', …)`: the effect waits between its consuming transaction and its revalidation (SEAM.md §76);
4. the `approved` reads (M626 (a): `approvedStatus`, the three reads, the request at `approved`; M616 (e): `approved`, `approvedStatus`);
5. `releaseBarrier(fx.engine, 'intent.recorded')` in a `finally`; `held` then releases the tick as before, and `tickUntil(... 'applied')` takes the state on.

Why this point reads `approved`: the human's approval is recorded on the proposal in the consuming transaction (`approveProposal`, `store/transitions/protected.ts`), before the barrier. Why awaiting the answer first does not deadlock: `afterAnswer` (`decisions/answer.ts`) awaits only `spec_approval_application` intents, not this effect.

`git diff 60319f5f 8052cf4c` touches no `assert` line.

M627, M628 and M629 were read for the same pattern and left unchanged: M627's read after its approval accepts either state (`authoring` reads `applied` for `approved` and `applied` alike); M628 reads nothing between its answer and `applied`; M629's answers are preparation approvals whose reads follow pumps or a paused project.

## Probe (not committed; copies outside the repository, deleted after)

Each copy: one injected line right after `consume(...)` inside `held(...)`, a 3 s wait, no tick requested (the Builder's probe). Imports pointed at the worktree's harness.

| Run | Copy | Pattern | Tests | Pass | Fail |
|---|---|---|---|---|---|
| probe-main-M626 | 60319f5f | `M626 \(a\)` | 9 | 5 | 4 |
| probe-fixed-M626 | fixed | `M626 \(a\)` | 9 | 9 | 0 |
| probe-main-M616 | 60319f5f | `M616 \(e\) a static page` | 10 | 9 | 1 |
| probe-fixed-M616 | fixed | `M616 \(e\) a static page` | 10 | 10 | 0 |

The main copies fail as the objection says:
- M626: `not ok 4 - (a) approved: approved by the owner, not yet applied` (`read while the proposal is approved and not applied (applied)`, `+ 'applied' - 'approved'`), and `not ok 6` (readiness), `not ok 7` (NOW), `not ok 8` (the requests), which read `J.approved`.
- M616: `not ok 6 - (e) approved and not yet applied: still blocked, no decision, no deploy` (`read before the version is applied (applied)`).

The fixed copies were made from the working tree before the commit; their content is 8052cf4c's.

## All runs (`status.log`)

| Run | When (UTC) | HEAD | Tests | Pass | Fail |
|---|---|---|---|---|---|
| probe-main-M626 | 18:42:05 | 60319f5f copy | 9 | 5 | 4 |
| probe-fixed-M626 | 18:42:13 | fixed copy | 9 | 9 | 0 |
| probe-main-M616 | 18:42:24 | 60319f5f copy | 10 | 9 | 1 |
| probe-fixed-M616 | 18:42:39 | fixed copy | 10 | 10 | 0 |
| M626-alone-1 | 18:43:04 | 8052cf4c | 18 | 18 | 0 |
| M616-alone-1 | 18:43:26 | 8052cf4c | 23 | 23 | 0 |
| M626-alone-2 | 18:43:47 | 8052cf4c | 18 | 18 | 0 |
| M616-alone-2 | 18:44:12 | 8052cf4c | 23 | 23 | 0 |
| M626-alone-3 | 18:44:33 | 8052cf4c | 18 | 18 | 0 |
| M616-alone-3 | 18:44:55 | 8052cf4c | 23 | 23 | 0 |
| conc-1 (six files, concurrency 4) | 18:45:20 to 18:46:09 | 8052cf4c | 123 | 123 | 0 |
| conc-2 | 18:46:09 to 18:46:54 | 8052cf4c | 123 | 123 | 0 |
| conc-3 | 18:46:54 to 18:47:38 | 8052cf4c | 123 | 123 | 0 |

The six files: `M70-scoped-reads-and-now`, `M616-deployment-compatibility-and-readiness`, `M626-the-file-serving-check-beside-its-environment`, `M625-a-service-serving-a-directory`, `M409-adoption-records-and-the-immutable-source`, `M614-serving-verification-of-a-static-site`.

## What is not claimed

- No run on mini-hp01 and no full gate; only the probe, the two files alone and the six-file set, on the workstation.
- Three concurrent runs are a sample; the probe is the deterministic evidence.
- No engine or harness seam was missing: `intent.recorded` exists (SEAM.md §76).

## Addendum: M70's `quiet()` wait timed out (the coordinator's finding, 2026-11-24)

**The finding.** In the local gate of 83385e88 (main 144a1ac8's tree, 4d56d2da and 01724f2b), M70 run alone read 20/21. The failing test was "the three reads that were left" (2), the operations case: `timed out after 30000 ms waiting for every project's host observation of this incarnation (its first tick done) before the snapshot`, at `quiet(fx)`. The case took 32.8 s, which is the fixture plus the whole 30 s wait: the condition never became true. Log: `~/surety-evidence/batch-2026-11-24/items-48-49/gate-local-83385e88/M70-fail-run1.log`. The two concurrent runs of that gate passed (123/123 each).

**The cause.** `quiet()`'s wait (item 47) named the current incarnation as `SELECT "id" FROM "engine_incarnations" WHERE "ended_at" IS NULL ORDER BY "started_at" DESC, rowid DESC LIMIT 1`.
- The operations case is the only `quiet()` caller whose engine is restarted. `killedAt` kills the first engine (SIGKILL at `ref_update`/`intent_committed`) and `fx.start()` starts a second. The killed engine never ends its row, so **two** rows have `ended_at` null. In a diagnostic run they started 1.28 s apart (`19:00:07.901`, `19:00:09.180`).
- This host's wall clock steps back. Measured now against the monotonic clock: **−2.93 s every ~29.3 s** (`19:01:30.839Z` −2930 ms, `19:02:00.183Z` −2934 ms). SEAM.md §23 recorded 0.74 to 0.78 s when it was written. `journalctl` shows `systemd-resolved` "Clock change detected" every ~29 s throughout the gate's window, including 12:57:36 and 12:58:05 CST, the minute in which M70's log was written. I did not pin the exact second the operations case ran.
- A step between the two starts gives the restart a `started_at` up to ~1.6 s earlier than the killed engine's. The query then names the **killed** incarnation. Project A has an observation there (its `project_start`). Project B, the case's second project, is created after the restart and is observed only in the new incarnation (its `project_start` in the tick that dispatches its run). So the wait asks for an observation that can never be written, and it times out after exactly 30 s. With a 1.3 s gap and a step every 29.3 s, about 1 run in 20 to 25 is exposed. That fits "passed in the two earlier gates and in item 47's runs".
- **Which project was missing in the gate's run is inferred, not read**: B, by the mechanism above and the probe below. The store was removed at teardown, and the timeout message did not name the project.

**What it is not: the barrier's timing.** Project B is observed in the `decide` step of the tick that dispatches its run. `decide` runs for every project before that tick's select and dispatch (`scheduler/tick.ts`). So B's observation is written before its run exists, and therefore before its integration can reach the held `ref_update`/`intent_committed` barrier. The diagnostic run shows this order: B created at 09.586, observed at 09.644, and its dispatching tick recorded at 09.766. A's observation of the new incarnation is written by the restarted engine's first tick, at 09.531. Holding B's integration costs later ticks up to `tick_step_budget` in B's journal step, but `decide`, and so the observation, still runs in them.

**The change** (commit d09a36a5, `M70-scoped-reads-and-now.test.mjs` only).
- `quiet()` takes the incarnation the engine itself reports: `GET /v1/engine` `incarnation` (SEAM.md §4: the row's `id` is the lock's `incarnation_id`, and the route reports it).
- It waits until every project has a `host_observations` row of that incarnation. A fixture check that the route names an incarnation is added before the wait.
- Nothing else changed: the snapshot, the engine-wide comparison (the same three exclusions), the event check, the launch check, the callers and every `assert` about the engine.

**Probe** (copies outside the repository, deleted after). Right after `await fx.start()` in the operations case, I set the killed incarnation's `started_at` to the restart's plus 2.93 s. That is what a 2.93 s backward step between the two starts produces. I ran `--test-name-pattern "git operations are listed"`:

| Run | Copy | Tests | Pass | Fail |
|---|---|---|---|---|
| probe70-main | 60319f5f's M70 | 1 | 0 | 1: `timed out after 30000 ms waiting for every project's host observation of this incarnation (its first tick done) before the snapshot`, word for word the gate's |
| probe70-fixed | d09a36a5's M70 | 1 | 1 | 0 |

**Runs** at d09a36a5, clean tree (`status.log`):

| Run | When (UTC) | Tests | Pass | Fail |
|---|---|---|---|---|
| M70-alone-1 | 19:03:47 | 21 | 21 | 0 |
| M70-alone-2 | 19:04:07 | 21 | 21 | 0 |
| M70-alone-3 | 19:04:28 | 21 | 21 | 0 |
| m70fix-conc-1 (six files, concurrency 4) | 19:04:51 to 19:05:32 | 123 | 123 | 0 |
| m70fix-conc-2 | 19:05:32 to 19:06:16 | 123 | 123 | 0 |
| m70fix-conc-3 | 19:06:16 to 19:06:57 | 123 | 123 | 0 |

The probe copies were made from the working tree before the commit; the fixed copy's content is d09a36a5's.

**Not claimed / for Sean.**
- No run on mini-hp01 and no full gate.
- The measured step (2.93 s) is larger than the two seconds of slack SEAM.md §23 allows for comparisons with a controlled-clock `now`. Whether other cases that compare wall-clock timestamps are exposed is not examined here. SEAM.md is the owner's document, and this is noted only as an observation.
