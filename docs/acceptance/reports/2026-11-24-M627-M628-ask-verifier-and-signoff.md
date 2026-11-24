# M627 and M628: the owner asks for the missing check; waiting for Reviewer sign-off (Verifier report, 2026-11-24)

**Branch.** `verify/m627-m628-ask-verifier-signoff`, cut from 90722773 (engine main 67ec2492 plus the driver's companion adding rows M627 and M628 in §3f, ROWS and manifest slice 49). The driver's companion 8b74035b came in while I worked: M627 (a)'s issued request follows the Reviewer's sign-off where the tier requires it; M628 (a)'s `primary_action` is never `deploy` (null, or `tick` while the queued review is eligible and not yet dispatched).

**Engine.** This branch carries the **pre-fix** engine. The Builder's change is 4ce3dffd (item 43) and a9971627 (item 44) on `build/ask-verifier-and-signoff`; the post-fix run used a9971627, which this branch has not merged.

**Source.** DECISIONS items 43 and 44, Sean 2026-11-24 (quoted in the plan's §3f heading and in each file's header).

## Files

- `packages/engine/test/acceptance/M627-the-owner-asks-for-the-missing-check.test.mjs`: new; kernel lane, slice 49; 12 tests in 3 groups, cases (a) to (d).
- `packages/engine/test/acceptance/M628-waiting-for-reviewer-sign-off.test.mjs`: new; kernel lane, slice 49; 7 tests in 2 groups, cases (a) and (b).
- `docs/acceptance/objections/232-M627-the-consequence-text-names-the-backend-not-the-configured-model.md`: new.
- No harness file was changed.

## The fixtures

Both files use M626's Node service: M616's browser-app variant of the design journey's reference project, its Builder's tree a `node_service` serving `web/`, built to its phase's completion on the kernel lane through the owner's routes.

- **M627** configures `alpha` in service mode with **no** `serving`, so no serving-check proposal of the engine's stands beside the Verifier's. The project is created with `model_verifier: 'sonnet-m627-verifier'`, a name no default carries. After the build the Verifier's script for every later `check_authoring` launch writes the behavioural check (M626's `operation`), waits at a hold, and proposes it (`tightening`).
- **M628 (a)** is M626 (a): the project has its required `post_deploy_behavior` check; `alpha` declares `serving {root: web, entry: index.html}`; the engine's serving check is proposed, approved, applied and the candidate's checks pass again. The applied version renews the acceptance content the T2 Reviewer sign-off binds, so the candidate then lacks only that sign-off. The Reviewer's script then waits at a hold before `review_auto` signs off.
- **M628 (b)** is M626 (b) taken one step further: no behavioural check; the serving check approved and applied. A request then has `ACCEPTANCE_SCOPE_INCOMPLETE kind:post_deploy_behavior` beside `SIGNOFF_MISSING`.

## What each case asserts

### M627 (a): manual policy, blocked → ask → review → ready → deploy
- **Before:** readiness `blocked`, `blocker {required_check_missing, kind:post_deploy_behavior}`, `primary_action` null; `authoring {state: 'none'}` with `work_item`, `run`, `proposal`, `decision` null and `offer {method: 'POST', path: /v1/projects/:p/environments/alpha/request-checks, consequence_text}`; the text names "Verifier" and the model configured for it, read as the project's `model_verifier`, which the Verifier's run records as `model_requested` (asserted too).
- **The request:** 202 `{work_item, state: 'queued', reused: false, requested_by: 'human', proposal: null, decision: null}`; exactly one `check_authoring`, trigger `authoring_gap`, its evidence `deployment {gate: alpha_authorize, environment: alpha, missing {kinds: [post_deploy_behavior], criteria: [], areas: []}}` and `requested_by: human`.
- **Nothing deployed:** no `deployment_requests` row with `requested_by human`, no deploy operation, no deploy work item, no issued or consumed authorization: after the request and again through the authoring up to the approval.
- **Again:** at `queued`, `running` and `awaiting_review`: 202, the same work item, `reused: true`, the state of the moment (and at `awaiting_review` the proposal and decision); still one work item; no run while queued, one run after.
- **The project read's `authoring`:** `queued` (`work_item`), `running` (the held run), `awaiting_review` (the Verifier's proposal and its open check-correction decision); `blocked` with the same blocker throughout, `offer` null, `primary_action` never `deploy`.
- **The approval:** every read after it that carries `authoring` reads `applied`; `blocked` after it only for `required_check_missing` or `checks_running` (`{what: checks_running, subject: null}`); then `ready` with `primary_action` `deploy`. The deployment request then issued (201, authorization `issued`); a first refusal is allowed only for `SIGNOFF_MISSING` alone with `subject.review` queued or running (8b74035b).

### M627 (b): on_phase_complete, the policy's authoring reused
The project is created under `alpha_deploy: on_phase_complete`, `deploy_auto_retries_max: 0`. After the configuration is written the policy's request (at a tick) is refused for the gap and the Verifier is asked; its run holds. The owner's request, twice: 202, `reused: true`, `requested_by: 'policy'`, the policy's work item, state `queued` or `running`; still that one work item; no owner deployment request; the readiness's `authoring` names it with `offer` null.

### M627 (c): refusals
- `alpha` configured before any candidate: 409 `no_candidate` with a reason, nothing queued.
- The service with its behavioural check, readiness `ready`: 409 `nothing_missing` with a reason, no authoring, nothing queued.

### M627 (d): the act; reads queue nothing
In each group the route's `api.act` events, in order, are exactly one per owner request: actor `human`, method POST, the route's path, the status answered. In (a) and (c), the project read, `GET …/environments`, `GET …/environments/alpha`, `GET …/work` and `GET …/decisions`, taken twice, leave the project's work item count unchanged.

### M628 (a): the sign-off alone
- **Fixture:** readiness `ready` before the request; no review of the deployment's yet.
- **The request:** 409 `authorization_not_issued`, reasons exactly `[SIGNOFF_MISSING]`, `subject.review {state: 'queued', work_item}` naming the one `review` work item (trigger `verification`, the candidate) whose evidence is the `alpha_authorize` gate's.
- **The readiness** after the request (`queued` or `running`) and while the Reviewer's run holds (`running`, the run named): `blocked`, `blocker {signoff_pending, SIGNOFF_MISSING}`, `review {state, work_item, run}` (`run` null while queued), the reason beginning "Waiting for Reviewer sign-off"; `primary_action` null, or `tick` only while the review is `queued` (8b74035b); the NOW sentence names the wait (matched without case: it reads "… It cannot be deployed to alpha yet: waiting for Reviewer sign-off: …").
- **Again, while queued and while running:** 409, `[SIGNOFF_MISSING]`, `subject.review` the same work item at `queued`/`running` and `running`; still one review; one run of it.
- **Signed off:** `ready`, no blocker, `primary_action` `deploy`; the request again issued (201).

### M628 (b): the sign-off beside another lasting reason
The request: 409 with both `SIGNOFF_MISSING` and `ACCEPTANCE_SCOPE_INCOMPLETE`; no `subject.review`; no review asked. The readiness: `blocked`, `blocker {required_check_missing, kind:post_deploy_behavior}`, no `review`, its reason not "Waiting for Reviewer sign-off".

## Results

All runs `node --test <file>` one file at a time (serially, per the Builder's note on concurrency), `TMPDIR=/tmp/avb-v`.

### Pre-fix: engine at 90722773, this worktree

| File | Passed | Failed |
|---|---|---|
| M627 | 3 / 12 | 9 |
| M628 | 4 / 7 | 3 |

- **M627.** The route answered 404 `not_found` ("No route …/request-checks exists in this engine") to every request; the readiness was `blocked required_check_missing` with no `authoring`. The (a) flow therefore stopped at the first request, and every (a), (b) and (c) assertion after it failed for that reason. The 3 passes are the three (d) tests: the engine already audits every POST, 404s included, with actor `human`, so (d) alone shows little before the fix. (b)'s fixture held: the policy's refused request queued the `authoring_gap` item.
- **M628.** The first refusal had `[SIGNOFF_MISSING]` and queued the review but carried no `subject.review`; the readiness stayed `ready` (NOW `ready`/`tick`). Passing: the fixture, the sign-off then 201 (today's behaviour), and both (b) tests (today a refusal with the sign-off beside the gap carries no `subject.review`; (b) guards the change's reach).

The M628 counts were taken again after my change to its NOW assertion (below): same 4 of 7.

### Post-fix: throwaway worktree `/tmp/avb-v/vgate`

Branch `gate/tmp-m627-verify`: my branch head merged with the Builder's a9971627 (which contains 4ce3dffd). The Builder's diff touches only `packages/engine/src/` and `packages/engine/test/unit/`. Built, then each file run serially. The worktree and branch have since been removed (`git worktree remove`, then `git branch -D`).

**Gate run 1 (my branch at 2a19d320, which takes in 8b74035b).**

| File | Passed | Failed |
|---|---|---|
| M627 | 10 / 12 | 2 |
| M628 | 6 / 7 | 1 |

- **M628 (a), the NOW sentence: my assertion.** It matched "Waiting for Reviewer sign-off" with a capital W; the engine names it mid-sentence ("… It cannot be deployed to alpha yet: waiting for Reviewer sign-off: …"). Matched without case now.
- **M627 (c), `no_candidate`: my fixture.** I asked on `alpha` before it was ever configured; the engine answered 404 `not_found` ("No environment \"alpha\" exists here"): a spec-named environment has no `prefix` until its first configuration, and the route, as a deployment request does, deploys to none such. The row's case is "no current candidate", so `alpha` is now configured before the request.
- **M627 (a), the consequence text: a disagreement, objection 232.** It reads "Queues a Verifier check-authoring run on the configured model scripted: …"; the project's `model_verifier` is `sonnet-m627-verifier`. I added a read of the Verifier's run's `model_requested`, which is `sonnet-m627-verifier`.

Corrected in 4285843c.

**Gate run 2 (final: my branch at 4285843c merged with a9971627).**

| File | Passed | Failed | Cancelled | Skipped | Todo |
|---|---|---|---|---|---|
| M627 | 11 / 12 | 1 | 0 | 0 | 0 |
| M628 | 7 / 7 | 0 | 0 | 0 | 0 |
| M626 | 18 / 18 | 0 | 0 | 0 | 0 |
| M616 | 23 / 23 | 0 | 0 | 0 | 0 |
| M625 (kernel file, `M625-a-service-serving-a-directory`) | 43 / 43 | 0 | 0 | 0 | 0 |

The M627 failure is the consequence text's model (objection 232): "names the model configured for the Verifier, sonnet-m627-verifier (Queues a Verifier check-authoring run on the configured model scripted: …)". The diagnostic in the same test: "the Verifier's run requests the model sonnet-m627-verifier".

Observed on the final tree (diagnostics):
- `work_item` is served as the id string.
- M627 (a) after the approval: `[blocked, checks_running, authoring applied]`, then `[ready, no blocker, no authoring]`; the deployment requests `[409 SIGNOFF_MISSING (subject.review present), 201]`.
- M627 (b): the owner's answer `{state: 'running', reused: true, requested_by: 'policy'}`.
- M628 (a): NOW after the request `ready`/`tick` (the review eligible, not yet dispatched); while the Reviewer's run holds, `running`/null.

**Gate run 3 (objection 232 resolved: my branch at e0636bdf merged with the Builder's 3a10e290, which follows a9971627; same throwaway pattern, removed after).** 3a10e290 touches `src/store/projections.ts` and two unit files: the consequence text names the model the Verifier's run records (`model_verifier` first, the backend's only when absent; the backend in brackets).

| File | Passed | Failed | Cancelled | Skipped | Todo |
|---|---|---|---|---|---|
| M627 | 12 / 12 | 0 | 0 | 0 | 0 |
| M628 | 7 / 7 | 0 | 0 | 0 | 0 |
| M626 | 18 / 18 | 0 | 0 | 0 | 0 |
| M616 | 23 / 23 | 0 | 0 | 0 | 0 |

The consequence text observed: "Queues a Verifier check-authoring run on the configured model sonnet-m627-verifier (scripted): it writes the missing post_deploy_behavior check as a proposal you review; nothing is deployed."; the Verifier's run requested `sonnet-m627-verifier`. M625's kernel file was not run again on this tree (43 / 43 on gate run 2; 3a10e290 changes only the offer's text).

`M625-a-python-service-on-a-real-unit` (sandbox lane, a real unit) was not run. No real-lane or exhaust-lane file was run, and no model was called.

## Readings

1. **`work_item`** in the route's answer is read as the work item's id; the test accepts the id or `{id}` and prints which (the id).
2. **"one run"** in M627 (a) is read once the authoring has started: none while queued, exactly one after, whatever the repeats.
3. **"applied"** in M627 (a) is read on every read after the approval that carries `authoring` (the Builder attaches it from approval on, and beside `checks_running` after application).
4. **M627 (b), the policy's request** leaves no `deployment_requests` row while the authoring it asked for is under way: such a refusal settles like `*_PENDING` (deploy.ts). The test shows the policy's ask by the `authoring_gap` item existing before any owner act, its evidence the `alpha_authorize` gate's.
5. **M627 (c) `no_candidate`** is read with the environment configured. An environment never configured answers 404 `not_found` on this route, as on a deployment request; not in the row, not asserted.
6. **"configured model"** is read as the project's `model_verifier`, the model the Verifier's run records it requests. The Builder first read it as the model the role's backend resolves to (`scripted` in this lane): objection 232. The driver's resolution, for the owner's confirmation, takes the model the run records; the Builder's 3a10e290 does so, and M627 passes 12 / 12 on it.
7. **M628 "queued" in the first refusal** is the state at the answer; the read after may say `queued` or `running`.
8. **M628 (b)'s other lasting reason** is the missing behavioural check: an unqualified adapter refuses a request but the readiness does not name it today, so it could not show "the readiness names the other blocker".

## Not claimed

- `authoring` `awaiting_review` for a parked authoring naming its blocker decision; a new generation after an ended authoring with the gap remaining; `not_hostable`; `offer` null for `kind:post_deploy_serving`; the backend-refused consequence text.
- `review.state` `awaiting_owner`.
- The console's journeys (DECISIONS items 43 and 44): the console repository's and Sean's visual acceptance.

## Objections

232: M627 (a)'s consequence text names the scripted backend's model, not the model configured for the Verifier. Resolved by the driver for the owner's confirmation (the model the run records); fixed in the Builder's 3a10e290; M627 12 / 12 on it.
