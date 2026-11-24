# M629 and the M628 (a) amendment: the requested model named before model work is approved; `review.decision` (Verifier report, 2026-11-24)

**Branch.** `verify/m629-preparation-approval-model`, cut from c7a72ff9 (engine main 203674cf plus the driver's companion: row M629 and the M628 (a) amendment in the M7 plan §3g, `'M629'` in ROWS, the file in manifest slice 49). The driver's second companion dab00ab6 (row M629 (b) amended: a role-model change while the approval is open re-asks it as a new generation) came in after my first commit 0362c499; (b) was amended to it in 5be428e0.

**Engine.** This branch carries the **pre-fix** engine. The Builder's change is eb609c89 (item 45) and d532d558 (item 46) on `build/preparation-approval-model`; the post-fix gate used d532d558, which this branch has not merged.

**Source.** DECISIONS items 45 and 46 (Sean 2026-11-24 ~16:00Z, quoted in the plan's §3g heading and in each file's header); objection 232 and the owner's confirmation.

## Files

- `packages/engine/test/acceptance/M629-the-requested-model-named-before-approval.test.mjs`: new; kernel lane, slice 49; 6 tests in 2 groups, cases (a) to (f).
- `packages/engine/test/acceptance/M628-waiting-for-reviewer-sign-off.test.mjs`: amended for row M628 (a) as amended (DECISIONS item 46): `review.decision` asserted null while queued and running in (a), and a new group (2 tests) in which the review awaits the owner. 9 tests in 3 groups (was 7 in 2).
- No harness file was changed. No objection filed.

## The fixtures

- **M629 (a), (b), (d), (e)** is one rapid prototype (`POST /v1/projects/new`, the scripted backend, the prototype harness's default scripts). **(c)** is a second prototype on the same engine.
- **M629 (f)** is M627 (a)'s Node service under manual policy (the design journey's Pantry, M616's browser-app variant, built to its phase's completion; `alpha` in service mode with no `serving`), created with `model_verifier: 'sonnet-m629-verifier-1'`.
- **M628 (a) amended** is M628 (a)'s fixture (M626 (a): the service with its behavioural check, the engine's serving check applied, the candidate lacking only the T2 Reviewer sign-off) on its own engine and port 18683, with a Reviewer script that completes with no sign-off and no finding.

## Readings this file makes

1. **"Raised at creation" (M629 (a)).** `POST /v1/projects/new` takes no policy, so the preparation role's `model_spec_writer` at creation is the schema default, `opus`, read by the test from the effective policy (never written into it); it differs from the scripted backend's own model, `scripted`. The models used later (`opus-m629-b`, `opus-m629-c`, `opus-m629-c-switched`, the other roles' `*-m629-*`) are names no default carries.
2. **(b), as amended (dab00ab6).** The new generation is read at once after the policy change, with no tick and no `…/prepare`. "The moved fields recorded" is read as the earlier decision's `decision.invalidated` event's `changed` paths (decisions.ts `manifestChanges`), `.model` among them; the new decision is asserted to be the same kind about the same iteration in the next `semantic_generation`. Before the change of `model_spec_writer`, (b) changes the other three build roles' models (so (e) has four distinct models); that moves no model of the preparation role, so the question is then read after a tick and, when none is open (the kind's refresh invalidates it and raises none), asked again by the owner's `POST …/iterations/:i/prepare` (the route M602 (c), (d) and the harness's `tightened` use). Both runs (pre- and post-fix) took the `…/prepare` path there.
3. **"Before dispatch" (M629 (c)).** The approval's own answer requests a tick, so the test pauses the project (`POST …/pause`; a paused project's eligible work is not dispatched, runs.ts `dispatchBlocker`) before approving, changes the role's model, then resumes and ticks three times. Observed pre-fix: the hold worked (no run while paused).
4. **"Says why" (M629 (c)).** The reason is accepted in the new decision's question, or the iteration read's `outcome.reason` or `outcome.next_step`: a text naming the model now requested (B) and either the model the earlier approval was given for (A) or its decision id.
5. **The brief's role list (M629 (e)).** Read per role: each of the four build roles (`spec_writer`, `architect`, `verifier`, `builder`) named by exactly one entry (`roles` includes it, or `role` is it), its requested model in `model` and its backend in `provider` (or `backend`). The expected model is the effective policy's `model_<role>` read just before the approval the preparation ran under.
6. **The provider-reported model.** The kernel lane has such a report: the scripted provider's usage line may carry `model`, which the ledger keeps as `model_observed` (store/transitions/ledger.ts `normalize`) and the run as `runs.model_observed`. (b)'s preparation run reports `opus-m629-reported-by-provider`; (b) and (d) assert it is kept beside `model_requested`, on the run and on its ledger rows, and unchanged after a later model change. The invocation receipt has no observed-model column; it is not claimed there.
7. **(f).** The Verifier's model is changed once (`sonnet-m629-verifier-2`) before the offer is read again, so the text must follow the policy; the owner's request is then made and the run held: its `model_requested` must be the model the offer named, its `backend` `scripted`.
8. **M628 (a) amended, `awaiting_owner`.** The harness can park the review behind a decision: a Reviewer that signs nothing and raises nothing parks its review work (`review_signoff_missing`) behind a `blocker` decision about the work item (findings.ts `recordReport`). The case asserts `review {state: 'awaiting_owner', work_item, decision: <that open blocker's id>}`, the reason still beginning "Waiting for Reviewer sign-off", `primary_action` not `deploy`; and `decision` null while the review was queued.

## Pre-fix run (this branch's engine, c7a72ff9)

This run was of 0362c499's files, before (b) was amended; the amended (b) was not run against the pre-fix engine (it stops, as before, at the first assertion naming A, the manifest naming `scripted`). Run alone, one file at a time, `node --test --test-concurrency=1`, `TMPDIR=/tmp/pam-v`, after `npm ci` and `npm run build`.

**M629: 1 of 6 passed, 5 failed**, each for the defect the row names:

| Test | Result | Observed |
|---|---|---|
| (a) | fail | the manifest's `model` is `scripted` (the backend's), expected `opus` (the role's policy model); the question reads "on scripted model scripted". |
| (b) (before the amendment) | fail | at "the spec_writer's model unchanged: the question still names A": the manifest names `scripted`. |
| (d) | fail | depends on (b)'s recorded approval (not reached). |
| (e) | fail | depends on (b) (not reached). |
| (c) | fail | **a run was dispatched requesting B under the approval given for A**: `run_… brief_preparation model_requested opus-m629-c-switched`, its work item under the decision whose manifest named `scripted`. |
| (f) | pass | "Queues a Verifier check-authoring run on the configured model sonnet-m629-verifier-2 (scripted): …"; the held run requested `sonnet-m629-verifier-2`, backend `scripted` (the request-checks offer already reads the requested model since 3a10e290). |

To check (b), (d) and (e)'s mechanics were sound before the Builder's change, a throwaway copy of the pre-amendment file (not committed, deleted after) with only the four model-naming assertions disabled was run on the same engine: (b) passed — the old answer was refused 409 `decision_stale`; the re-read was asked by the owner's `…/prepare`; one `brief_preparation` run with `model_requested` `opus-m629-b`, backend `scripted`, `model_observed` `opus-m629-reported-by-provider` on the run and its ledger row; (d) failed only on "still naming B" (the consumed manifest names `scripted`); (e) passed with the model check disabled, the served list being `[{"provider":"scripted","model":"scripted","roles":["spec_writer","architect","verifier","builder"]}]` (one entry; every role given the backend's model).

**M628 (amended): 6 of 9 passed, 3 failed**, each for the missing `review.decision`:
- (a) readiness, after the request: `review {state: 'queued', work_item, run: null}` has no `decision`.
- (a) amended, before the Reviewer ran: the same.
- (a) amended, the review parked: the review work parked (`review_signoff_missing`, its blocker naming `dec_…`, one open `blocker` decision about it); readiness `review {state: 'awaiting_owner', work_item, run}` with no `decision`. The rest held: `blocked`, `signoff_pending`, the reason "Waiting for Reviewer sign-off: … waits for your answer; …".

## Post-fix gate

Throwaway worktree `/tmp/pam-v/vgate`, branch `gate/tmp-m629-verify`: this branch's 5be428e0 (dab00ab6 and the amended (b) on 0362c499) merged with the Builder's d532d558 (merge f3cdbe36, no conflict); `npm ci`, `npm run build`; each file run alone with `node --test --test-concurrency=1`, `TMPDIR=/tmp/pam-v`, in this order. The worktree was then removed with `git worktree remove` and the branch deleted.

| File | Tests | Pass | Fail |
|---|---|---|---|
| M629-the-requested-model-named-before-approval | 6 | 6 | 0 |
| M628-waiting-for-reviewer-sign-off | 9 | 9 | 0 |
| M627-the-owner-asks-for-the-missing-check | 12 | 12 | 0 |
| M602-preparation-is-authorized-before-it-runs | 4 | 4 | 0 |
| M605-agent-runs-roles-and-model-calls | 4 | 4 | 0 |
| M606-accounting-completeness | 9 | 9 | 0 |
| M603-the-brief | 5 | 5 | 0 |

49 of 49 tests in 7 files. No test was changed for the gate.

What was observed (from the tests' diagnostics):
- **(a)** manifest `{"role":"spec_writer","model":"opus","provider":"scripted","resolution":"scripted"}`; the question adds "The model it requests, which the run records as its requested model, is opus; the backend is scripted." Its earlier sentence still reads "It runs the Spec Writer (role spec_writer) on scripted model opus", which M602 (a) asserts (`/Spec Writer \(role spec_writer\) on scripted model /`); noted, not a failure of either row.
- **(b)** the earlier decision `invalidated` ("dependency manifest changed"), its `decision.invalidated` `changed` `[".model", ".policy_revision"]`, its manifest still naming `opus`; the answer to it 409 `decision_invalidated`; the new generation (g3) open at once naming `opus-m629-b`; the old hash on it 409 `decision_stale`; approved: one `brief_preparation` run, `model_requested` `opus-m629-b`, backend `scripted`, `model_observed` `opus-m629-reported-by-provider` on the run and its ledger row; its receipt `scripted` / `opus-m629-b`.
- **(c)** while paused, the approval made one work item and no run; after the change and resume: no run; a new approval naming `opus-m629-c-switched`, its question beginning "… You are asked again: your approval (decision …) authorized a run requesting model opus, but the spec_writer role now requests model opus-m629-c-switched, so no run was dispatched under it."; the iteration `preparing`, next step "approve preparation or discard", its reason naming both models and the decision; the earlier decision consumed, its manifest naming `opus`; answered: one run requesting `opus-m629-c-switched` under the new decision. (The cancelled work item's `work.cancelled` cause is the Builder's report; the test does not assert it.)
- **(d)** after `model_spec_writer` → `opus-m629-c`: the consumed decision, the invalidated earlier generation, the creation-time question, the run, its receipts and ledger rows identical to what was read before.
- **(e)** `brief.models`: `[{provider: scripted, model: opus-m629-b, roles: [spec_writer]}, {scripted, opus-m629-architect, [architect]}, {scripted, sonnet-m629-verifier, [verifier]}, {scripted, sonnet-m629-builder, [builder]}]`.
- **(f)** the consequence text names `sonnet-m629-verifier-1`, then after the change `sonnet-m629-verifier-2` ("… on the configured model sonnet-m629-verifier-2 (scripted) …"); request-checks 202; the held run requested `sonnet-m629-verifier-2`, backend `scripted`.
- **M628 (a) amended** `review {state: awaiting_owner, work_item, run, decision: dec_…}`, the decision the parked review's open blocker; `decision` null while queued and running.
