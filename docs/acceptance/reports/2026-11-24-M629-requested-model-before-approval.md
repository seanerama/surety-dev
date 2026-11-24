# M629 and the M628 (a) amendment: the requested model named before model work is approved; `review.decision` (Verifier report, 2026-11-24)

**Branch.** `verify/m629-preparation-approval-model`, cut from c7a72ff9 (engine main 203674cf plus the driver's companion: row M629 and the M628 (a) amendment in the M7 plan §3g, `'M629'` in ROWS, the file in manifest slice 49).

**Engine.** This branch carries the **pre-fix** engine. The Builder's change comes on `build/preparation-approval-model`; its post-fix gate is recorded below once run.

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
2. **"The re-read" (M629 (b)).** The kind is `reraise: false`: the engine's decision refresh invalidates the open preparation question when its manifest moves and raises none. The re-read is the open question after the next tick; when none is open, the owner's `POST …/iterations/:i/prepare` asks it again (the route M602 (c), (d) and the harness's `tightened` use), and that question is the re-read. On the pre-fix engine it was the latter both times; the test reports which.
3. **"Before dispatch" (M629 (c)).** The approval's own answer requests a tick, so the test pauses the project (`POST …/pause`; a paused project's eligible work is not dispatched, runs.ts `dispatchBlocker`) before approving, changes the role's model, then resumes and ticks three times. Observed pre-fix: the hold worked (no run while paused).
4. **"Says why" (M629 (c)).** The reason is accepted in the new decision's question, or the iteration read's `outcome.reason` or `outcome.next_step`: a text naming the model now requested (B) and either the model the earlier approval was given for (A) or its decision id.
5. **The brief's role list (M629 (e)).** Read per role: each of the four build roles (`spec_writer`, `architect`, `verifier`, `builder`) named by exactly one entry (`roles` includes it, or `role` is it), its requested model in `model` and its backend in `provider` (or `backend`). The expected model is the effective policy's `model_<role>` read just before the approval the preparation ran under.
6. **The provider-reported model.** The kernel lane has such a report: the scripted provider's usage line may carry `model`, which the ledger keeps as `model_observed` (store/transitions/ledger.ts `normalize`) and the run as `runs.model_observed`. (b)'s preparation run reports `opus-m629-reported-by-provider`; (b) and (d) assert it is kept beside `model_requested`, on the run and on its ledger rows, and unchanged after a later model change. The invocation receipt has no observed-model column; it is not claimed there.
7. **(f).** The Verifier's model is changed once (`sonnet-m629-verifier-2`) before the offer is read again, so the text must follow the policy; the owner's request is then made and the run held: its `model_requested` must be the model the offer named, its `backend` `scripted`.
8. **M628 (a) amended, `awaiting_owner`.** The harness can park the review behind a decision: a Reviewer that signs nothing and raises nothing parks its review work (`review_signoff_missing`) behind a `blocker` decision about the work item (findings.ts `recordReport`). The case asserts `review {state: 'awaiting_owner', work_item, decision: <that open blocker's id>}`, the reason still beginning "Waiting for Reviewer sign-off", `primary_action` not `deploy`; and `decision` null while the review was queued.

## Pre-fix run (this branch's engine, c7a72ff9)

Run alone, one file at a time, `node --test --test-concurrency=1`, `TMPDIR=/tmp/pam-v`, after `npm ci` and `npm run build`.

**M629: 1 of 6 passed, 5 failed**, each for the defect the row names:

| Test | Result | Observed |
|---|---|---|
| (a) | fail | the manifest's `model` is `scripted` (the backend's), expected `opus` (the role's policy model); the question reads "on scripted model scripted". |
| (b) | fail | at "the spec_writer's model unchanged: the question still names A": the manifest names `scripted`. |
| (d) | fail | depends on (b)'s recorded approval (not reached). |
| (e) | fail | depends on (b) (not reached). |
| (c) | fail | **a run was dispatched requesting B under the approval given for A**: `run_… brief_preparation model_requested opus-m629-c-switched`, its work item under the decision whose manifest named `scripted`. |
| (f) | pass | "Queues a Verifier check-authoring run on the configured model sonnet-m629-verifier-2 (scripted): …"; the held run requested `sonnet-m629-verifier-2`, backend `scripted` (the request-checks offer already reads the requested model since 3a10e290). |

To check (b), (d) and (e)'s mechanics are sound before the Builder's change, a throwaway copy (not committed, deleted after) with only the four model-naming assertions disabled was run on the same engine: (b) passed — the old answer was refused 409 `decision_stale`; the re-read was asked by the owner's `…/prepare`; one `brief_preparation` run with `model_requested` `opus-m629-b`, backend `scripted`, `model_observed` `opus-m629-reported-by-provider` on the run and its ledger row; (d) failed only on "still naming B" (the consumed manifest names `scripted`); (e) passed with the model check disabled, the served list being `[{"provider":"scripted","model":"scripted","roles":["spec_writer","architect","verifier","builder"]}]` (one entry; every role given the backend's model).

**M628 (amended): 6 of 9 passed, 3 failed**, each for the missing `review.decision`:
- (a) readiness, after the request: `review {state: 'queued', work_item, run: null}` has no `decision`.
- (a) amended, before the Reviewer ran: the same.
- (a) amended, the review parked: the review work parked (`review_signoff_missing`, its blocker naming `dec_…`, one open `blocker` decision about it); readiness `review {state: 'awaiting_owner', work_item, run}` with no `decision`. The rest held: `blocked`, `signoff_pending`, the reason "Waiting for Reviewer sign-off: … waits for your answer; …".

## Post-fix gate

Pending the Builder's commit on `build/preparation-approval-model`.
