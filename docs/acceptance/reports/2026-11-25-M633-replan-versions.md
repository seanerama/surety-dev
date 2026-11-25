# M633: a later iteration's replan names the versions its publication allocates

Verifier, 2026-11-25. Row M633 (M7 plan §3i; DECISIONS item 52). Kernel lane only; no real model, nothing paid.

- Branch `verify/m633-replan-versions`: the test (c34ddc9f), the (a) text assertions tightened against the fix's wording (30237882), this report.
- Base: 507f0049 (engine main 2bbcb6b5 + the driver's companion adding the row).
- Fix: the Builder's 2b975d9e (`build/replan-versions`), merged `--no-ff` onto the Verifier's tip on a throwaway local branch `tmp/m633-on-fix` (576561fb; never pushed, never merged into the verify branch).
- File: `packages/engine/test/acceptance/M633-a-later-iterations-replan-names-the-allocated-versions.test.mjs`.

## Results

| Case | Base 507f0049 | Base + 2b975d9e |
|---|---|---|
| (a) the package states the allocated versions, the rule, the gloss, the prose | fail | pass |
| (b) plan written as stated, phase 2 added, architecture unchanged: published | fail | pass |
| (c) the same with architecture.md changed: architecture 2, roadmap 2 naming 2 | fail | pass |
| (d) the reproduction: approved versions with phase 2 added, refused | pass | pass |
| (e) parked, retry, dispatched once, published, building, its build; Alpha untouched | fail | pass |
| (f) first plans and the phase-1-again plan: stated = published | fail | pass |
| **Total** | **1/6** | **6/6** |

Other files on base + 2b975d9e: M610-iterate-and-the-second-alpha 6/6, M424-the-replan-one-shot-and-its-repairs 2/2, and M442-the-role-packages-state-what-the-engine-reads 11/11 (run because the `architect.prepared_against` element and the PLAN_STALE_BASELINE gloss changed). On the base, M610 6/6 and M424 2/2.

## Base failure texts

- (a): the versions stated for a commit that adds phase 2, architecture unchanged, were `{spec_version 2, architecture_version 1, roadmap_version 1, roadmap.json version 1, roadmap.json architecture_version 1}` against the check's `{2, 1, 2, 2, 1}`. Element rule: "A replan's plan names the approved specification's version, the approved architecture and roadmap versions, and revision, …; roadmap.json keeps the approved version unless you revise it, which goes to the owner." No `*_if_changed` key.
- (b): `the plan check refused phase 2: PLAN_STALE_BASELINE (roadmap.json version 1 (bundle 2), roadmap_version 1 (bundle 2))`. This is the production first attempt's refusal (run_01M88MKN561EY2CXGMYJ00RPD3).
- (c): `the plan check refused phase 2: PLAN_STALE_BASELINE (architecture_version 1 (bundle 2), roadmap.json architecture_version 1 (bundle 2), roadmap.json version 1 (bundle 2), roadmap_version 1 (bundle 2))`. This is the production repair's refusal (run_01M88MRDBQYTEZVFS89T0MW6Y6).
- (d), both trees: run `failed` `invalid_result`, reason `the plan check refused phase 2: PLAN_STALE_BASELINE (roadmap.json version 1 (bundle 2), roadmap_version 1 (bundle 2))`; a `plan_checks` row `refused`. The check is unchanged.
- (e): on the base everything up to the retry's run passed: the repair refused too, the item `parked` with blocker reason `repair_attempts_max`, one open blocker offering `retry`, `retry` answered with the project paused, the item `eligible` and not dispatched, and iteration 1's environment unchanged. The retry's run, scripted from the stated facts, was refused: `PLAN_STALE_BASELINE (roadmap.json version 1 (bundle 2), roadmap_version 1 (bundle 2))`.
- (f): the first plans of all four apps stated what they were published with (architecture 1, roadmap 1, from the first-plan prose; `facts` is null for a first plan). The phase-1-again plan (M610 (e)'s path: R4 added to phase 1, so the roadmap changes) stated roadmap 1 while its publication carried roadmap 2. **The defect is not only on the phase > 1 path**: the `phase === 1 && approved` branch had the same contradiction. The driver expected (f) to pass on the base. It does not, and the Builder's 2b975d9e covers this branch.

## How the package is read, and how the plan "as stated" is scripted

Every replan launch dumps its context package first (`context_dump`, as in M442 and M424). `statedVersions` reads the `architect.prepared_against` element. A key's next version is used when the commit changes that file: `roadmap_version_if_changed` or `architecture_version_if_changed`, beside `facts` or inside it. Otherwise the test uses `facts`. A changed roadmap.json carries the stated roadmap version and the stated architecture version. Where `facts` is null (a first plan), the prose's numbers and the generation's spec version are used.

The scripted backend has no step that derives a plan from its own package at run time. `copy_context` and `plan_from_open_plan` do not write `prepared_against` versions from the package. So the package is read on the test side. App A's first iteration-2 replan run is (d)'s plan, and its package is (a)'s. The versions it states are derived for the phase-2 commit with and without an architecture change. The Architects of App B (b), App C (c) and App A's retry (e) are scripted with those versions. Each of those runs dumps its own package, and the test asserts that package states the same versions. The revision is the exception: it is each workspace's HEAD, substituted at run time, and asserted equal to the published plan's `prepared_against_revision`. So each published plan is exactly what its own package states.

## Readings and test-side choices

- The test's kind scripts follow launch ordinals shared by every app of one engine. Each case resets the kinds to their defaults before it scripts anything. Every app is paused and left idle after each case (`afterEach`), pass or fail. Without this, a failed case's unconsumed script was taken by the next app (observed while writing the test).
- (e): the project is paused across the owner's `retry` answer. That shows the item `eligible` with no dispatch before the resume, without a sleep. It then pumps until iteration 2's stage build ends, and stops before any deployment.
- (e): iteration 1's environment is compared at every pump step of (a), (e) and the parked and retry points. The comparison covers `current_generation`, `deployment_generation`, `current_config`, `relay`, `teardown_requested_at`, the project's deployment requests, its deploy and teardown operations, and the scripted adapter's deploy and teardown call counts. The relay is null throughout. The kernel lane's scripted adapter runs no service to relay to (M337 is in the sandbox lane), so the relay is compared as it is, null before and after.
- (c): architecture.md is the changed file (not modules.json). The pump would answer `architecture_approval` or `plan_approval` if the plan were routed to the owner, because the row asks only "published" for (c). The routing (c) took is not asserted.
- (a) text assertions, written before the fix and then tightened against its wording where the row allows:
  - The rule names roadmap.json, what changes the architecture, each `*_if_changed` key the element carries, and the next version.
  - The PLAN_STALE_BASELINE gloss says the next version, for both roadmap and architecture.
  - The prose names `roadmap version 2`, `architecture version 1`, the changed architecture version within the same clause (the fix's form "architecture version 1 (2 if you change …)"), and PLAN_STALE_BASELINE.
  - One relaxation, made after seeing the fix: the first version of the architecture-change regex allowed no digit between "architecture version" and the 2, so it missed that form. It now matches within one clause (`[^.]{0,80}`). The base fails (a) earlier, at the stated-versions assertion, either way.
- No fixture writes: every state was reached through the owner's routes and the scripted roles.

## Not done

No sandbox, real or exhaustion lane. No full slice run (one full run per slice is the driver's). No objection filed.
