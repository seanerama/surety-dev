# M626 and the amended M616 (e): the file-serving check beside its environment (Verifier report, 2026-11-24)

**Branch.** `verify/m626-serving-check-visibility`, cut from 68bf0bbd (engine main 3a45199c plus the driver's companion commit adding row M626, the M616 (e) amendment, ROWS and the slice-49 manifest entry). Two more driver companions came in while I worked: 242d6b7f, which spells out the M616 (e) amendment for a static site whose serving check is neither present nor proposed, and 0355f858, which spells out M626 (a)'s `primary_action` and `checks_running` window.

**Engine.** This branch carries the **pre-fix** engine. The Builder's change is 5ef829ac on `build/serving-check-visibility`, which this branch has not merged.

**Source.** DECISIONS item 42, Sean 2026-11-24: "The pending proposal should be visible. For a service that declares serving, show its check status beside the relevant environment in the project read and Everyday Workspace. … Keep Deploy available whenever the engine would accept the request. A pending proposal alone adds no deployment gate. If the required behavioral check is missing, name that as the blocker."

## Files

- `packages/engine/test/acceptance/M626-the-file-serving-check-beside-its-environment.test.mjs`: new; kernel lane, slice 49, cases (a) to (e). 18 tests in 4 groups.
- `packages/engine/test/acceptance/M616-deployment-compatibility-and-readiness.test.mjs`: amended to the M616 (e) amendment (68bf0bbd, made explicit in 242d6b7f). Every other assertion is unchanged.
- No harness file was changed. The manifest, ROWS and the plan are the driver's.

## The fixture

**Project.** Every project is M616's browser-app variant of the design journey's reference project (`harness/deploy/static-journey.mjs`). Each one reaches its published plan through the owner's routes and is built to its phase's completion on the kernel lane.

**A Python service can't be the fixture.** I first tried the M625 Python service (`server.py` with `public/`). Its tree has no package.json start script and no root `index.html`, so it reads `output_kind unknown`. Its environment is then `unknown`, never `hostable`, and its readiness can never be `ready`. In service mode, local_service hosts only `node_service` (`deploy/capabilities.ts`).

**The service used instead.** It is M616's page with these additions:
- a package.json start script, which makes it `node_service`;
- `web/index.html`, the served directory, under the module's own `web/` path;
- `web/server.mjs`, the configuration's start program. A request refuses a start program that is not a file of the sealed artifact (422 `config_invalid` naming `start.1`, observed).

It is configured in service mode with `serving: {root: 'web', entry: 'index.html'}`.

**The behavioural check for (a) and (d).** The Verifier's phase-1 authoring is M616's four checks plus a required `post_deploy_behavior` check of the `alpha_complete` scope. It is modelled on the design reference's `operation` check, and its input is listed file by file, so the engine's proposal still classifies as a tightening.

**The static site for (c).** M616's `STATIC_PAGE_BUILT`, configured in static mode with `static: {root: '.', entry: 'index.html'}` written out in full. Because the values are explicit, `declared` cannot pass on a default.

**The three reads.** Each `serving_check` is asserted on the project read's `environments[]`, on `GET …/environments` and on `GET …/environments/:e`. It must be present on all three and identical across them.

## What each case asserts

### (a) A service declaring serving, its behavioural check required

**`serving_check` at each state of the proposal:**
- **`proposed`:** the engine's proposal named, `decision` null, `check` null.
- **`awaiting_decision`:** the open `check_correction_tightening` decision named.
- **`approved`:** read while the proposal's stored status is `approved`, `decision` null.
- **`present`:** the effective version's `post_deploy_serving` key (`surety-static-serving`). This is read twice: while the candidate's checks run again, and after they pass.
- **At every state:** `declared` is `{mode: 'service', root: 'web', entry: 'index.html'}` and `holds_deployment` is false.

**Readiness:**
- It is `ready` at proposed, awaiting_decision, approved and present.
- Its reason starts "The environment alpha can host this output (Node service) …", mentions the serving check, and differs between `proposed` and `present`.
- It has no `blocker`. Its `follows` never lists `deployment_checks_authoring` or `request_again`.
- In the window after application, readiness is either `ready`, or `blocked` with `{what: 'checks_running', subject: null}` and a reason naming the running checks.

**`primary_action`:**
- At proposed, approved and present: `deploy`, with NOW `build_complete` and the sentence "It is ready to request deployment to alpha (Node service, local_service service mode)".
- While the decision is open: NOW is `waiting_on_you` with `answer_decision` (row as amended in 0355f858).

**A deployment request at every step:**
- At proposed, awaiting_decision and approved, the request is refused `authorization_not_issued`. Its reasons are only `ADAPTER_UNQUALIFIED`, plus, at the approval instant, `GIT_JOURNAL_PENDING`. Nothing in them names `post_deploy_serving`, and there is no scope gap.
- At present, with the adapter now qualified, the request is issued (201, authorization `issued`). The first request may be refused `SIGNOFF_MISSING` alone (see the readings below), and the test then requests again after a tick.

**(d), the project already having the check.** Environment `beta`, a service configuration declaring no serving, reads `present`, `declared` null, `check` the same key, `holds_deployment` false.

### (b) A service declaring serving, no behavioural check

**Readiness**, at both proposed and awaiting_decision:
- `blocked`, `blocker {what: 'required_check_missing', subject: 'kind:post_deploy_behavior'}`, `decision` null (the serving check's decision does not settle it).
- The reason names the behavioural check (`post_deploy_behavior` or "behavioural") and the Verifier.

**NOW at proposed:** `build_complete`, `primary_action` null, and the sentence after "The planned build and its automated gates are complete." names the behavioural check. While the decision is open, `primary_action` is not `deploy`.

**`serving_check`:** `proposed`, then `awaiting_decision`, with the same proposal and decision. `declared` is the service's; `holds_deployment` is false.

**The request:**
- The adapter is qualified first, so the refusal carries only the gap. The request is refused `authorization_not_issued` with `ACCEPTANCE_SCOPE_INCOMPLETE ['kind:post_deploy_behavior']`, and nothing names the serving check.
- Exactly one `check_authoring` with `trigger_source authoring_gap` is queued. Its evidence is gate `alpha_authorize`, environment `alpha`, missing `{kinds: ['post_deploy_behavior'], criteria: [], areas: []}`.
- `what_to_do` says the checks are "being authored". There was none before the request.

### (c) A static site in static mode, the engine's proposal pending

- **`serving_check`:** `awaiting_decision`, the decision and proposal named, `holds_deployment` true, `declared` `{mode: 'static', root: '.', entry: 'index.html'}`. Before the question is raised: `proposed`, `decision` null, `holds_deployment` true.
- **Readiness:** `blocked`, `blocker {what: 'serving_check_pending', subject: 'kind:post_deploy_serving'}`, `decision` the same id. At proposed: `blocked`, the same blocker, `decision` null.

### (d) A service configuration declaring no serving

- Nothing is proposed.
- `serving_check` is `not_proposed`, with `declared`, `proposal`, `decision` and `check` all null and `holds_deployment` false.
- The reason says the configuration declares no serving root and entry. It is asserted to mention serving and to match `/declares? no serving|no serving root|does not declare/i`; the exact sentence was not printed.
- With its behavioural check in place, readiness is `ready` and `primary_action` is `deploy`.

### (e) No configuration

- `serving_check` is null on all three reads, both at the plan's publication and after the build.
- Otherwise the entry is as today:
  - the list entries keep `id`, `name`, `state` and `observed`;
  - `GET …/environments/:e` keeps its stored read (`observed`, `conditions`, `supervision`).

### Everywhere

- Every non-null `serving_check` has all eight fields, `kind` `post_deploy_serving`, a boolean `holds_deployment`, a non-empty reason, and a state from item 42's list.
- `unread` is not exercised: the kernel lane gives no way to make these facts unreadable. This is not claimed.

### M616 (e), amended

- **Node service without a behavioural check:** `blocked`, blocker `required_check_missing kind:post_deploy_behavior`, `decision` null, the reason and the NOW sentence naming the behavioural check, `primary_action` null. Previously this test asserted `ready`, `deploy` and `follows [deployment_checks_authoring, …]`.
- **Static page's pending serving check** (proposed, awaiting decision, approved and not applied): blocker `serving_check_pending kind:post_deploy_serving`.
- **Static page with checks running:** blocker `{what: 'checks_running', subject: null}`.
- **Static page whose proposal was rejected:**
  - `blocked`, blocker `required_check_missing kind:post_deploy_serving`, `decision` null, the reason saying it is proposed again when the static configuration is written, `primary_action` null (per 242d6b7f).
  - This replaces the `ready` result with `follows ['serving_check_proposal', …]`.
- **Every `ready` result in the static group:** checked to have no `deployment_checks_authoring` or `request_again` in `follows`.

## Results

### Pre-fix: engine at 68bf0bbd, this worktree, `node --test` per file

**First run (tests as committed in ad24931e).**
- **M626: 5 of 18 passed, 13 failed.**
  - 10 tests fail because no environment entry has `serving_check`; the entries carry only `id, name, state, observed`.
  - (a): readiness is `ready`, but its reason does not mention the serving check.
  - (b): readiness is `ready` with `follows` still listing `deployment_checks_authoring` and `request_again`, not `blocked`; `primary_action` is `deploy`, not null.
  - (c): readiness is `blocked` with no `blocker`.
  - The 5 passes are tests whose assertions the change does not touch: the (a) fixture, (a) `primary_action`, (a) requests, the (b) request and queued authoring, and the (d) readiness.
- **M616: 18 of 23 passed, 5 failed.**
  - The Node service reads `ready`, not `blocked`.
  - The proposed, awaiting-decision and approved static cases lack the `serving_check_pending` blocker.
  - The running-checks case lacks the `checks_running` blocker.

**Rerun after every change to the tests below.** M626 still 5 of 18 passed, 13 failed, for the same reasons. M616 17 of 23 passed, 6 failed: the sixth is the rejected-proposal static page, which reads `ready` where 242d6b7f requires `blocked`.

### Post-fix: throwaway worktree `/tmp/scv-v/vgate`

The gate worktree was on branch `gate/tmp-m626-verify`: my branch head merged with the Builder's 5ef829ac. The Builder's diff touches only `src/api/server.ts`, `src/deploy/compatibility.ts`, `src/store/projections.ts` and two unit test files. The tree was built, then `node --test` was run per file. The worktree and branch have since been removed (`git worktree remove`, then `git branch -D`).

**Gate run 1 (my branch at 33ced1ac).**

| File | Passed | Failed |
|---|---|---|
| M626 | 16 / 18 | 2 |
| M616 | 22 / 23 | 1 |
| M625 | 43 / 43 | 0 |
| M613 | 8 / 8 | 0 |
| M614 | 10 / 10 | 0 |

All three failures were wrong assertions of mine. The engine was doing what the row says:
- **M626 (a), the checks_running window.** I had asserted that the reason does not mention the serving check. The row requires the reason to state the serving check's state for any configuration declaring serving, and the engine's reason does that: "…the candidate's automated checks are running (0 of 4 completed); it can be requested once they pass. The engine's file-serving check surety-static-serving is in place …; for a service it does not hold the deployment …". The test now asserts that the reason names the running checks.
- **M626 (e).** I had expected a `state` key on every read. `GET …/environments/:e` has never served one (the stored environment read, SEAM.md §255). The "as today" check is now done per read.
- **M616, the rejected proposal.** I had copied the old `/can be deployed|is verified|is open/i`. "is open" matched "no proposal of the engine's for it is open" in a correct sentence. The pattern is narrowed to the preview being open, and the sentence's "It cannot be deployed to alpha yet: " is asserted.

Corrected in 5b44dd60.

**Gate run 2.**

| File | Passed | Failed |
|---|---|---|
| M626 | 17 / 18 | 1 |
| M616 | 23 / 23 | 0 |
| M625 | 43 / 43 | 0 |
| M613 | 8 / 8 | 0 |
| M614 | 10 / 10 | 0 |

The M626 failure was in (b), "serving_check beside the environment". It was a race in my test, not a disagreement with the engine:
- The project read showed `proposed` with `decision` null, and `GET …/environments/:e` showed `awaiting_decision` with the decision named.
- The engine had ticked between the two reads. It requests a tick itself when a run ends or an effect asks for one (`runtime.ts`).
- Each read was right for its own moment.

The fix (my branch 11c2427b):
- The three reads are now taken again until a project read taken after them matches the one taken before (the environment's `serving_check`, the readiness and NOW), so all three describe one moment.
- Before each configuration is written, the project's runs are allowed to end, with one quiet tick, so the `proposed` state is read before any tick raises its question.

**Gate run 3 (final tree: merge 4c539c35, my branch at 11c2427b).**

| File | Passed | Failed | Cancelled | Skipped | Todo |
|---|---|---|---|---|---|
| M626 | 18 / 18 | 0 | 0 | 0 | 0 |
| M616 | 23 / 23 | 0 | 0 | 0 | 0 |
| M625 | 43 / 43 | 0 | 0 | 0 | 0 |
| M613 | 8 / 8 | 0 | 0 | 0 | 0 |
| M614 | 10 / 10 | 0 | 0 | 0 | 0 |

**Repeats on the final tree.** M626 was run twice more: 18 of 18 passed both times. In the three green runs, the (a) diagnostics showed:
- the journal operation at the approval instant was `commit_tree`, in state `applied` or `intended`;
- at present, the first request was refused `SIGNOFF_MISSING` alone, and the second, after one tick, was issued (201).

No real-lane or exhaust-lane file was run, and no model was called. The kernel lane starts no unit.

## Readings

These are readings of the rows, now explicit in 0355f858 and 242d6b7f where marked:

1. **(a) "ready throughout"** is read at each state of the proposal. Applying the check makes the candidate's checks run again (as in M616 (e)), and during that window `blocked`/`checks_running` is allowed (0355f858).
2. **(a) `primary_action` `deploy`** is read where no decision is open. While the proposal's decision is open, it is `answer_decision` (0355f858).
3. **(a) "a deployment request admitted at every step."** Until `present`, the adapter is left unqualified, so no deployment runs in the middle of the sequence. A refusal for `ADAPTER_UNQUALIFIED` is "a reason other than the serving check". So is `GIT_JOURNAL_PENDING` at the approval instant: it names the `commit_tree` operation applying the approved version, and it settles at the next tick (D6 K2).
4. **(a) at `present`, readiness is `ready`, but the first qualified request is refused `SIGNOFF_MISSING`.** The applied version changes the content the candidate's Reviewer sign-off binds. The refusal queues the Reviewer (`alpha-review.ts`), and the request is issued one tick later. Item 42's readiness has no sign-off blocker, so `ready` here means "a request now is admitted to the route that ends in issue" rather than "issued at once". I'm noting this for Sean, not filing it as an objection: the row lists the blockers, and a sign-off blocker is not among them.
5. **(b) "the Verifier's authoring queued exactly as today"** is read as the existing `alpha-gap.ts` route: one `check_authoring` with `trigger_source authoring_gap` and the gap in its evidence, and `what_to_do` saying the checks are being authored. The adapter is qualified so the gap is the refusal's only reason. That route is queued only when nothing else lasting holds the request.
6. **The (b) moment for `primary_action` null** is the `proposed` read, where no decision is open. Once the serving check's question is open, NOW ranks it first, as in (a).

## The Builder's readings, checked against the rows

- **`holds_deployment`.** It is true for a static site in static mode only when the effective version has no required `post_deploy_behavior` check of `alpha_complete`, and false for design-preview and qualification environments. This agrees with the row's "its absence refuses a request": the gate accepts the behavioural check for a static site (`deploymentRequirementMet`). Not exercised here; (c) has no behavioural check and reads true.
- **A missing required check is named before running checks.** Consistent with the amended M616 (e). Not separately exercised: no project here has both at once.
- **No effective protected version reads `unread`** (for a static site, `blocked` with `checks_unread`). This agrees with "`unread` when the facts cannot be read, never `not_proposed`". Not exercised.
- **A static site with a pending proposal and a required behavioural check has `follows ['deployment','verification']`.** Consistent with `holds_deployment` false. Not exercised.

## Not claimed

- The `unread` state of `serving_check`, and readiness `checks_unread`.
- `holds_deployment` false for a static site that also has a behavioural check.
- Design-preview and qualification environments.
- The console's rendering. Per the row, that is the console repository's and Sean's visual acceptance.

## Objections

None. The disagreement I expected to file as objection 232 (the rejected-proposal static page) was settled by the driver's companion 242d6b7f before the post-fix run.
