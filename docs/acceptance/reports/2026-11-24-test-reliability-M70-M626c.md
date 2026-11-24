# Test reliability: M70 and M626 (c) under concurrent execution (Verifier report, 2026-11-24)

**Item.** DECISIONS item 47. Sean, 2026-11-24: "Track the M70 and M626(c) concurrent failures as a separate test-reliability item. They reproduced on main under concurrency. Keep that evidence alongside the passing serial results and preserve the assertions when fixing the timing."

**Branch.** `verify/test-reliability-m70-m626c`, cut from engine main 203674cf. The test changes are commit 1f86f7c5 (M70, M626) and commit d9913fdd (M616, the extension below). The engine is unchanged, and no harness file was changed.

**Evidence.** All logs and the run status lines are in `~/surety-evidence/batch-2026-11-24/item-47-test-reliability/` (`status.log` plus one `<label>.log` per run). Main's reproductions stay where they were: `~/surety-evidence/batch-2026-11-24/items-43-44/m70-concurrency-main/`.

**Host.** The workstation (WSL2), Node v22.22.0, `TMPDIR=/tmp/rel-v`. Concurrent runs used `node --test --test-concurrency=4 --test-reporter=tap` over M70, M616, M626, M625 (a service serving a directory), M409 (adoption records) and M614, from `packages/engine`. None of the six files is listed under manifest `real` or `exhaust`.

## The causes

Both failures come from objection 114's mechanism (SEAM.md §461; D6 K1). A route asks for a tick, and that tick goes through every project of the engine in turn (`scheduler/tick.ts` `tick` → `decide` per project). When the host is loaded, a tick that an earlier step asked for can still be running when a test takes its snapshot or makes its read. It then writes, inside the test's window, something that step caused.

**M70, the gate read, "after six gate reads: no stored row changed".**
- The case creates a second project, `other`, after pausing its own project. It then records a result and evaluations; each of these asks for a tick.
- On main (run1) and here (`before-conc-1`) the diff is one extra row: a `host_observations` row, `trigger: project_start`, for `other`. It was written about 0.1 s after the snapshot (main: snapshot after 02.233, row at 02.259; here: row at 55.864).
- In main's log, the same tick wrote the own project's `check_repair` at 02.201, before the snapshot, and then reached `other`'s `decide` after it. One tick straddled the snapshot.
- So the "sibling" is the case's own second project in the same engine. Each test file has its own engine home.

**M626 (c), "(c) awaiting_decision …" and "(c) blocked …".**
- A proposal's question is raised by a tick: `classifyDue` in `decide`, `scheduler/tick.ts` around line 242.
- Writing the configuration asks for a tick at once (K1). On main (run2) that tick ran between `writeConfig` and the three reads. The reads expected to see `proposed` with `decision` null, but saw `awaiting_decision` with the decision named.
- That `proposed` held at all was only timing.
- (a) and (b) read `proposed` the same way, and (a) also reads `approved, not applied` the same way: the approval's application is the next tick's. They carry the same race, though no run has caught them.

## The change

### M70 (`M70-scoped-reads-and-now.test.mjs`)

`quiet(fx, { settle })` is now async. Before it takes the snapshot it does two things:
1. With `settle`, it runs `tick(engine, settle)`. That is two rounds, and the second begins after every request made so far, so a tick already running when it is asked for cannot count.
2. It waits until every project in the store has its host observation of the engine's current incarnation (the incarnation whose `ended_at` is null), read from the store.

The comparison itself is unchanged:
- the same engine-wide `dumpStore`, with the same three exclusions (`events`, `engine_incarnations`, `leases`);
- the same "no event but `run.heartbeat` / `engine.tick`" check;
- the same "no role launched" check.

The scheduler stays live in the window. A tick that a read caused would still be caught.

How each caller now opens its window:

| Case | `settle` | Other change |
|---|---|---|
| Work read | `other` | Its earlier `tick(engine, other, { rounds: 1 })` is kept. |
| Gate read | its paused project | The `count` of recorded evaluations is now taken after the settle and before the reads. "No evaluation was recorded by a read" still compares counts around the six reads. |
| One decision by id | `mine` | The settle covers the tick the unconfirmed Stop asked for. |
| Operations | none | Project B's integration is held at its journal barrier for the reads, so only the observations are waited for. |
| Environments | `mine` | `before` (the stored observation) is taken after the settle. |

The NOW case is unchanged: it already holds the scheduler at `scheduler.tick_running` for its window.

### M626 (`M626-the-file-serving-check-beside-its-environment.test.mjs`)

A new `held(fx, project, body)` works like this:
1. It arms `scheduler.tick_running` (pause), asks for a tick, and waits until the engine waits at the barrier. The barrier comes after the tick's prerequisite and Gates steps and before select (SEAM.md §441: "while it holds, the API answers and no other tick runs").
2. It runs the step and its reads.
3. It releases the barrier.

The held tick has already passed `classifyDue` before the configuration exists. No other tick can begin until release. So nothing can classify the proposal, or apply the approval, between the step and its reads. After release, the next tick moves the state on, and `openDecision` / `tickUntil` read the next state as before.

Where it is used:
- (a): the configuration write, the `proposed` reads and the request at `proposed`; then, separately, the answer `approve`, the proposal status, the `approved` reads and the request at `approved`.
- (b): the configuration write and the `proposed` reads.
- (c): the configuration write and the `proposed` reads.

## Why no assertion is weaker

- Neither diff changes an `assert` line. `git diff 203674cf 1f86f7c5` touches only setup, comments and the order of two statements in M70's gate read.
- **M626 (c)** still proves each state where it holds:
  - `proposed` with `decision` null and `holds_deployment` true, readiness `blocked` `serving_check_pending` with `decision` null, read under the hold;
  - `awaiting_decision` with the decision named and readiness `decision` the same id, read after the next tick raised it.

  Neither read accepts "either".
- **M626 (a) and (b):** the same holds for `proposed`. (a)'s `approved` is now read where the approval has been recorded and no tick can yet have applied it, which is what its `approvedStatus === 'approved'` check already required.
- **M70:** "reading writes nothing" still compares every table engine-wide, with the scheduler live. What changed is only that the window opens after the writes the fixture's own earlier steps asked for have landed. It does not scope the comparison down, and it does not drop a table.

## Proof that the hold is the cause and the cure (a probe, not committed)

I made two temporary copies of the M626 file, ran them with `--test-name-pattern "M626 \(c\)"`, and then deleted them. Each copy had the same injection right after `writeConfig` in (c): `requestTick` and then 3 s of waiting. That forces what the loaded host did.

| Copy | Result | Log |
|---|---|---|
| Main's file (203674cf) | 2 tests, 0 pass, 2 fail | `probe-old.log` |
| Fixed file (1f86f7c5) | 2 tests, 2 pass, 0 fail | `probe-new.log` |

The main copy's first failure is exactly main's run2 failure:
```
{"kind":"post_deploy_serving","check":null,"proposal":"prop_01M876AVDHRYDCNAZSNED9ZK8Q","decision":"dec_01M876AVH8CQ3MGKFAA1TC4AT2","declared":{"mode":"static","root":".","entry":"index.html"},"holds_deployment":true,"state":"awaiting_decision",...}
+ actual - expected
  [
+   'awaiting_decision',
+   'dec_01M876AVH8CQ3MGKFAA1TC4AT2',
-   'proposed',
-   null,
    true
  ]
```
In the fixed copy the requested tick and the 3 s wait fall inside the hold, and `proposed` is read.

## All runs

`status.log`, as recorded. HEAD 203674cf is before the fix; 1f86f7c5 is after. `dirty=2` marks the two edited files before they were committed.

| Run | When (UTC) | HEAD | Tests | Pass | Fail |
|---|---|---|---|---|---|
| before-conc-1 (six files, concurrency 4) | 16:20:27 to 16:21:12 | 203674cf | 123 | 122 | 1: M70 the gate read |
| trial-M626 (alone, uncommitted edit) | 16:22:02 | 203674cf + edit | 18 | 18 | 0 |
| trial-M70 (alone, uncommitted edit) | 16:22:27 | 203674cf + edit | 21 | 21 | 0 |
| after-M70-alone-1 | 16:23:08 | 1f86f7c5 | 21 | 21 | 0 |
| after-M626-alone-1 | 16:23:41 | 1f86f7c5 | 18 | 18 | 0 |
| after-M70-alone-2 | 16:24:06 | 1f86f7c5 | 21 | 21 | 0 |
| after-M626-alone-2 | 16:24:29 | 1f86f7c5 | 18 | 18 | 0 |
| after-M70-alone-3 | 16:24:56 | 1f86f7c5 | 21 | 21 | 0 |
| after-M626-alone-3 | 16:25:19 | 1f86f7c5 | 18 | 18 | 0 |
| after-conc-1 | 16:25:49 to 16:26:41 | 1f86f7c5 | 123 | 123 | 0 |
| after-conc-2 | 16:26:41 to 16:27:32 | 1f86f7c5 | 123 | 123 | 0 |
| **after-conc-3** | 16:27:32 to 16:28:22 | 1f86f7c5 | 123 | 122 | **1: M616 (e)** (below) |
| after-conc-4 | 16:28:45 to 16:29:36 | 1f86f7c5 | 123 | 123 | 0 |
| after-conc-5 | 16:29:36 to 16:30:29 | 1f86f7c5 | 123 | 123 | 0 |

Notes on the runs:
- **Before the fix**, here: M70's gate read failed with the same `host_observations` / `project_start` row of `other`. M626 (c) did not fail in this one run. Its before is main's run2 and the deterministic probe above.
- **Extra concurrent runs:** after-conc-4 and after-conc-5 were extra. I ran them after the M616 failure for more data on M70 and M626, not to replace that run. All five are counted.
- **Timestamps:** `after-M626-alone-3`'s start (16:25:19) is earlier than `after-M70-alone-3`'s recorded end (16:25:22), although the runs were sequential. The workstation's clock stepped; I report the times as recorded.
- **Totals after the fix:**
  - M70: 3/3 alone and 5/5 concurrent.
  - M626: 3/3 alone and 5/5 concurrent.
  - The six-file set: 4 of 5 concurrent runs fully green.

### The failure in after-conc-3, verbatim (M616, not one of the two files)

```
not ok 8 - (e) complete, configured where it can be hosted, its required behavioural check missing: blocked, required_check_missing kind:post_deploy_behavior, no decision, no primary action
  location: '.../M616-deployment-compatibility-and-readiness.test.mjs:193:3'
  error: |-
    {"state":"waiting_on_you","primary_action":"answer_decision","reason":"One decision is waiting for your answer. The planned build and its automated gates are complete.","cause":null}
    + actual - expected
    + 'waiting_on_you'
    - 'build_complete'
```

- **What the log shows:** the readiness assertions before it in the same case passed (`blocked`, the blocker, `decision` null). Only NOW differed: one decision was open.
- **What I infer, without having checked it:**
  - M616's fixture writes `alpha` in static mode, then in service mode, and reads after the second write (`M616…test.mjs` lines 116 to 119). Writing the static configuration plausibly captures the engine's serving-check proposal.
  - A tick that ran between the two writes would then have raised its `check_correction_tightening` question. That is M626's mechanism, in a third file.
  - The run's store was removed at teardown, so I cannot name the decision.
- **Status (as first written):** not fixed here, because it is outside item 47's two files. The coordinator then extended item 47 to M616; the probe confirmed the mechanism and d9913fdd fixes it (see the extension below). It passed in the other four concurrent runs, and it did not fail in main's two runs. It is a candidate for the same treatment: hold the scheduler from before the static write through the `inService` read. Whether to include it is the driver's call.

## Extension: M616 (the coordinator's message, 2026-11-24; the driver extended item 47 to it)

The coordinator ruled that the after-conc-3 failure is the same race and asked for the same treatment in M616. The test change is commit d9913fdd. No assertion line changed: `git diff 1f86f7c5 d9913fdd` touches no `assert`. The engine and the harness are unchanged.

**Cause.** M616's first block, (a), (d), (e) on a browser app, writes `alpha` in static mode, reads (`inStatic`), then writes it in service mode and reads again (`inService`).
- Both reads expect NOW `build_complete`.
- The static configuration captures the engine's serving-check proposal, and its write asks for a tick (K1).
- A tick that runs before either read raises the proposal's question, so NOW reads `waiting_on_you` / `answer_decision`.

The static page's (e) block has the same exposure in two places, though no run caught it:
- `proposed` after its static configuration, with "its question not yet raised" and NOW `build_complete`;
- `approved and not yet applied` after the answer.

**Probe (not committed; `probe616-old.log`, `probe616-new.log`).** I injected the same `requestTick` plus a 3 s wait right after the static configuration in the first block, and ran with `--test-name-pattern "M616 \(a\), \(d\), \(e\) a browser app"`.

| Copy | Result |
|---|---|
| The file before this change (1f86f7c5) | 8 tests, 6 pass, 2 fail |
| The fixed file (d9913fdd) | 8 tests, 8 pass, 0 fail |

In the 1f86f7c5 copy, the failures were:
- `not ok 7` ("configured where it cannot be hosted", `inStatic`);
- `not ok 8`, the after-conc-3 case, with the identical text `{"state":"waiting_on_you","primary_action":"answer_decision","reason":"One decision is waiting for your answer. The planned build and its automated gates are complete.","cause":null}` / `+ 'waiting_on_you'` `- 'build_complete'`.

This confirms the mechanism, a tick between the static configuration and the reads. I did not read which decision was open; that it is the serving-check question is inferred from the engine's flow.

**Change.** M616 gets the same `held(fx, project, body)` as M626: arm `scheduler.tick_running`, ask for a tick, wait at the barrier, run the step and its reads, release. It is used around:
- the first block's static configuration, `inStatic`, service configuration and `inService`;
- the static page's static configuration, the engine proposals and the `proposed` read;
- the static page's answer `approve`, the `approved` read and `approvedStatus`.

These steps were left unchanged:
- (b) and (c): they read only compatibility, which is evaluated by the configuration write itself and which no tick moves.
- The publication, building and completion reads: no tick moves those states without the scripted runs the fixture drives.
- The `applied` read: the checks wait for `recordChecks`.
- The "neither present nor proposed" block: it reads after `tickUntil` has settled the rejection.

**Why no assertion is weaker.** Each state is read where it holds:
- `unsupported` and `blocked required_check_missing` with NOW `build_complete`, before any tick can raise the static configuration's question;
- `proposed` with no decision;
- `approved, not applied`.

After the hold is released, `openDecision` / `tickUntil` read the following states as before.

**Runs** (`status.log`; HEAD d9913fdd, clean tree):

| Run | When (UTC) | Tests | Pass | Fail |
|---|---|---|---|---|
| trial-M616 (alone, uncommitted edit on ea91b40e) | 16:33:08 | 23 | 23 | 0 |
| m616fix-M616-alone-1 | 16:34:08 | 23 | 23 | 0 |
| m616fix-M616-alone-2 | 16:34:37 | 23 | 23 | 0 |
| m616fix-M616-alone-3 | 16:35:03 | 23 | 23 | 0 |
| m616fix-conc-1 (six files, concurrency 4) | 16:35:32 to 16:36:22 | 123 | 123 | 0 |
| m616fix-conc-2 | 16:36:22 to 16:37:09 | 123 | 123 | 0 |
| m616fix-conc-3 | 16:37:09 to 16:37:55 | 123 | 123 | 0 |
| m616fix-conc-4 | 16:37:55 to 16:38:42 | 123 | 123 | 0 |
| m616fix-conc-5 | 16:38:42 to 16:39:29 | 123 | 123 | 0 |

Runs 4 and 5 record `dirty=1`: this report was being edited in the worktree while they ran. Both test files and the engine were at d9913fdd.

**Totals on d9913fdd:**
- M616 alone: 3 of 3 runs green (23/23 each).
- The six-file set at concurrency 4: 5 of 5 runs green (123/123 each).

Over all ten concurrent runs after the M70/M626 fix (five on 1f86f7c5, five on d9913fdd), the one failure is after-conc-3's M616 (e), recorded above.

The five earlier concurrent runs on 1f86f7c5, including after-conc-3's M616 (e) failure, stand as recorded above.

## What is not claimed

- No run on mini-hp01, and no full gate. These are only the 6-file set and the two files alone, on the workstation.
- No claim that M70 or M626 can never fail under concurrency:
  - five concurrent runs after the fix is a sample;
  - M70's settle assumes a settled tick asks for no further tick that writes;
  - the operations case waits only for the observations.
- M70's NOW case, the decisions read and the observation-age case were not changed. NOW already holds the scheduler; the other two have no "nothing written" window.
- Not shown here: a deterministic reproduction of M70's straddle (only the before run and main's run1); M626 (c) failing on this host before the fix, other than by the probe.
- M616 (e) (after-conc-3): its mechanism is confirmed by the probe, and it is fixed in d9913fdd (the extension above). Which decision was open in after-conc-3 was not read, because the store was removed at teardown.
- M616 (b), (c) and the rejected-proposal block were not changed, for the reasons given above.
- No engine or harness seam was missing, so no objection was filed.
