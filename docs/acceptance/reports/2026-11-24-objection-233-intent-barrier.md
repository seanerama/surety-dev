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
