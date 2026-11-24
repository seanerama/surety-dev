# 233: M626 (a) and M616 (e) read the approved state with only the scheduler held, but the answer's own effect applies the proposal off the scheduler

Row: M626 (a), M616 (e) (`docs/acceptance/sdlc-M7-acceptance-plan.md` §3e; DECISIONS item 47's timing fix, merged in 60319f5f)
Test: packages/engine/test/acceptance/M626-the-file-serving-check-beside-its-environment.test.mjs, "(a) approved: approved by the owner, not yet applied" (and (a)'s readiness, NOW and request cases that read `J.approved`); packages/engine/test/acceptance/M616-deployment-compatibility-and-readiness.test.mjs, "(e) approved and not yet applied: still blocked, no decision, no deploy"
Filed by: Builder, branch build/unit-test-tick-barrier (DECISIONS item 50), 2026-11-24
For: the Verifier (a timing correction; no assertion changes, no design question)

## Claim

Item 47's fix holds the scheduler at `scheduler.tick_running` around the owner's answer and the reads of the `approved` state, on the reading that "the approval's application is a tick's (through the journal)" (M626's comment). It is not only a tick's. Consuming a `check_correction_tightening` approval records a `protected_application` effect intent, and the answer's own effect runs it at once, off the scheduler: `runtime.ts` (an `effect` with an intent → `services.effect(intent)`, not awaited, then a tick requested), `engine.ts` (`effect: (intent) => effects.run(intent)`), `decisions/effects.ts` (`execute` → `applyProposal` through the journal). A held tick does not stop it, so the proposal can be `applied` before the reads under the hold, and the strict `approved` assertions then fail under load. Nothing asserted is wrong; the hold does not cover what it is meant to cover.

The seam that does cover it exists: the barrier `intent.recorded` (SEAM.md section 76: "fires after the consuming transaction and before the preconditions are read again"; `decisions/effects.ts` `execute`: `if (row.status === 'pending') await pausePoint('intent.recorded')`). Armed before the answer and waited for before the reads, released after them, it holds the application between the answer and the reads; the tick's own effects step joins the same run (`Effects.run` returns the running promise), so it waits there too.

## Evidence (probes, not committed; copies outside the repository, deleted after)

Each copy of the file at 60319f5f has one injected line right after `await consume(fx, p.id, J.decision, 'approve');` inside `held(...)`: a 3 s wait, **no tick requested**.

- M626, `--test-name-pattern "M626 \(a\)"`: 9 tests, 5 pass, 4 fail: "(a) approved: approved by the owner, not yet applied" (`expected 'approved'`, `actual 'applied'`), and the (a) readiness, NOW and request cases that read `J.approved`.
- M616, `--test-name-pattern "M616 \(e\) a static page"`: 10 tests, 9 pass, 1 fail: "(e) approved and not yet applied: still blocked, no decision, no deploy" (`read before the version is applied (applied)`).

The same mechanism in the kernel-lane unit test `serving-check-visibility.test.mjs` (item 50): with the scheduler held and a 3 s wait after the answer, `approved` read `present`; with `intent.recorded` also held, it passes (this branch's commit).

## Proposed correction (the Verifier's file; no assertion changes)

Inside the existing `held(...)` around the answer: `armBarrier(fx.engine, 'intent.recorded', 'pause')` before `consume(...)`; wait until the engine waits there; take the reads; release `intent.recorded` (then `held` releases the tick as now). `J.approvedStatus` is then `approved` where it is read, and the `tickUntil(... 'applied')` after the release takes it on as today.
