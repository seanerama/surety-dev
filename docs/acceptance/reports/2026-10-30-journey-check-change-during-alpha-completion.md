# The journey harness answered a check change during an Alpha completion (2026-10-30)

Verifier report. Branch `verify/journey-tightening-order`, off main `3fbc6372`. Harness change: commit `79984691`. The finding is Builder C2k's, recorded as DECISIONS item 35 (RECORD-builder-c2k.md, addendum on M441).

## The finding

`M441-the-pace-read-after-the-journey` sometimes stopped in its `before()` hook. The error was "a candidate to be alpha_deployed: not reached within 80 ticks" (`harness/journey/drive.mjs`, `pump`). Every failing run has the same owner acts, in order:

1. check_correction_unclassifiable approve
2. spec_change_request submit
3. **check_correction_tightening approve**
4. spec_change approve
5. check_correction_unclassifiable approve

## Mechanism (confirmed)

I confirmed it by reading `drive.mjs` and `src/store/transitions/classification.ts`, and with a scratch instrumented copy of the test. The copy is outside the repo, at `/tmp/vjh/diag/m441diag.test.mjs`.

1. Phase 1 completes. Under policy, `alpha_authorize` is satisfied and a deploy work item is created. The engine claims it in the same tick and it goes to `executing`.
2. The deploy's verification round then takes wall time: two identity reads about 1.15 s apart. The work item stays `executing` until `alpha_complete` is recorded, and only then goes to `complete`, with cause `alpha_complete`. If completion is refused, it goes to `awaiting_decision` behind a blocker.
3. `pump` waits only for runs (`waitForIdle`), and no run is under way during that round. So the pump keeps reading open decisions and ticking while the round is in flight.
4. Inside that window, the Verifier's phase-2 authoring proposal is classified a tightening. That raises a `check_correction_tightening` question for the owner.
   - Under `classifier_authority: authoritative`, which M441 sets, the Reviewer's approval normally withdraws that question within the same tick ("approved by the Reviewer under authoritative").
   - If the pump reads the question before that happens, it approves it as the owner (`ROUTED_KINDS`).
5. The owner's approval applies a new protected version before `alpha_complete` is evaluated. Completion is then refused (CHECK_NOT_PASSED, DEPLOY_VERIFICATION_MISSING ×2, SIGNOFF_MISSING), and the deploy waits behind a `blocker`.
6. Phase 2's deploy then fails at once. `alphaReady` scripts one deploy answer, and phase 1 used it. This also happens in passing runs: the test passes there because phase 1's candidate reached `alpha_deployed`.
7. So no candidate reaches `alpha_deployed`.

Instrumented run d3 shows the window directly:
- 18:37:42.034: the tightening question is raised.
- 18:37:42.054: the fixed pump reads it while deploy work `wi_…PEGYZC` is `executing`, and defers it.
- 18:37:42.071: `alpha_complete` is satisfied and the candidate is `alpha_deployed`.
- 18:37:43.305: the Reviewer approves and the question is withdrawn.

Without the change, the pump would have approved at .054. That is the failing sequence.

## The change (harness only; no assertion touched)

The change is in `harness/journey/drive.mjs`, inside `pump`. It does not answer a routed check-change question while the project's deploy work is `claimed` or `executing`. The check-change kinds are `check_correction_unclassifiable`, `check_correction_tightening` and `check_correction_loosening`. The question is answered on a later round, once the completion has settled, unless the Reviewer has withdrawn it by then.

- A deferral is recorded in `ctx.deferred`, and the kernel-lane stall message names it.
- `eligible` deploy work is not counted. The engine claims a requested deploy in the tick that requests it, and counting an item that stays eligible could hold an answer indefinitely.
- The rule covers every check-change kind, not only tightening, because any approved correction makes a new protected version.
- The scripted deploy answer is unchanged. Making it survive a retried deploy was not needed, and could hide a refused completion.

No test file, tick budget or assertion changed. The other answer loops were not changed and not examined for this race: `review31b.pumpNoIdle`, `held543`, `change36` and `exec37/autonomy.pumpSome`.

## Results (this workstation, private TMPDIR /tmp/vjh, one file at a time, MemAvailable at least 10 GiB before each run)

### M441-the-pace-read-after-the-journey: 25 interleaved pairs

Each pair ran the same build in the same worktree. Only `drive.mjs` was swapped between main's version and the fixed one, alternating which went first. Runs were 18:38Z to 18:54Z.

| Harness | Pass | Fail | Duration |
|---|---|---|---|
| fixed (79984691) | 25 | 0 | 16.6–19.2 s |
| main (3fbc6372) | 22 | 3 (pairs 2, 8, 22) | 16.7–24.2 s |

- All three main failures have the Builder's signature: "not reached within 80 ticks", with check_correction_tightening approved as the third owner act.
- Fisher's exact test on 0/25 against 3/25 gives p ≈ 0.23 (two-sided). The before/after rates alone do not establish the fix.
- What does establish it is the mechanism above together with the instrumented runs.

### Instrumented copy with the fixed harness: 13 runs, 13 passed

- 1 run deferred the tightening while the deploy was `executing` (d3). That run passed.
- In the other 12, the Reviewer withdrew the question before the pump read it.
- In no run did the owner answer the tightening.

### Other journey files, once each with the fixed harness: 21 files, 21 passed, none skipped

The other two M441 files:
- M441-the-pace-read-from-recorded-observations: 10/10
- M441-the-peak-across-a-restart-on-the-real-boundary: 1/1. This is a sandbox-lane file, not real or exhaust.

Every kernel-lane, non-sandbox file that imports the journey harness and calls `alphaReady` or `alphaDeployed`, which are the files where the deferral can act:

| File | Passed |
|---|---|
| M401-the-t1-variant-on-the-scripted-backend | 3/3 |
| M406-phase-completions-effects-once-per-binding | 6/6 |
| M407-alpha-under-policy-enters-at-the-request | 7/7 |
| M407-an-unexpected-preparation-error | 2/2 |
| M413-a-fix-after-conformance-creates-no-work | 1/1 |
| M413-the-conformance-stage | 10/10 |
| M433-a-change-after-the-final-phase-schedules-a-replan | 8/8 |
| M435-the-proposal-class-and-the-coverage | 3/3 |
| M436-the-floor-under-phase | 3/3 |
| M442-the-rehearsal-with-the-packages-whole | 3/3 |
| M442-the-role-packages-state-what-the-engine-reads | 11/11 |
| M450-deferred-authoring-and-the-exception | 3/3 |
| M512-design-due-and-no-silent-stalls | 21/21 |
| M513-the-policy-and-its-keys | 5/5 |
| M517-a-design-change-after-the-final-phase | 6/6 |
| M518-retrofit-the-observed-design | 2/2 |
| M530-no-self-staleness | 6/6 |
| M604-one-brief-approval-authorizes-the-build | 6/6 |
| M612-the-receipt-and-the-untouched-planned-workflow | 4/4 |

Logs are in `/tmp/vjh/loop1/` (the pairs, with `results.txt`), `/tmp/vjh/regress/` and `/tmp/vjh/diag/`.

## A design question for Sean (not decided here)

The engine does not order a protected-version change against an Alpha completion that is in flight. Any approval applied during the verification round refuses the completion: the owner's approval, or the Reviewer's under `authoritative`. The deploy then waits behind a blocker and is not re-verified under the new version.

The harness now waits, as a careful owner would. The Reviewer's own approval can still land in that window:
- In instrumented run d2, the Reviewer approved at 18:37:22.954 and `alpha_complete` was evaluated at 22.964, 10 ms later.
- The application followed at 23.235, so the completion held, but only by timing.

Whether the engine should handle this is a design decision for Sean. The options are:
- hold an approved check change until the completion settles;
- re-verify under the new version;
- keep today's refusal, which is then the intended contract.

If Sean wants today's behaviour to be the contract, a row could pin it down. This is not a Builder defect report.

## Not verified

- The project lane. `pump`'s deferral also applies there, but no project-lane or sandbox journey file was run apart from M441-the-peak-across-a-restart. Not run: M401-the-journey-from-an-idea-to-phase-two, M401-the-journey-from-phase-two-to-alpha, M408 ×2, M436-the-phase-profile-on-the-project-lane, M510, M516, M520-…-through-the-preview-unit, M536.
- The journey files that use `pump` without reaching an Alpha deploy (about 100 files). The deferral cannot act there because no deploy work exists, so they were not run.
- mini-hp01. Everything here ran on the workstation only.
- The full suite. No `--slice` sweep and no `npm test` was run.
- A rate claim. 25 pairs do not establish a statistically significant before/after difference on their own.
