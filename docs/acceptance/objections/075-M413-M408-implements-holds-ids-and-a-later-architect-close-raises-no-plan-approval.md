# 075: M413 (e) and M408 (c) read `stages.implements` as requirement keys; M413 (f)'s roadmap move expects a `plan_approval` that a later Architect session does not raise; M414 (d)'s last replans plan outside phase 2's modules and against spec version 1

Rows: M413 (e), M413 (f), the roadmap-move case; M408 (c); M414 (d)
Tests:
- packages/engine/test/acceptance/M413-the-conformance-stage.test.mjs:205-209 ("(e) the stage implements the confirmed set of phase 1, not the defect")
- packages/engine/test/acceptance/M413-the-conformance-stage.test.mjs:229-251 ("(f) a roadmap revision moving the failing requirement to phase 2 changes nothing")
- packages/engine/test/acceptance/M414-evidence-rules-dependency-boundary-scoped-mode.test.mjs:104-140 ("(d) scoped mode … after the owner approves its criteria, pending, and the plan passes")
- packages/engine/test/acceptance/M408-the-retrofit-journey.test.mjs:160-167 ("(c) phase 1 one conformance stage …"), by inspection: it is a project-lane file and was not run here.

Filed by: Builder, slice 32, 2026-10-12

## 1. `stages.implements` holds requirement ids, not keys

M413 (e) asserts `JSON.parse(stage.implements).sort()` deep-equals `['R1', 'R2', 'R3']`. M408 (c) asserts `[...stages[0].implements].sort()` deep-equals the same keys, through `stagesOfPlan`, which parses the column and does not map it. Since slice 31 the column holds requirement ids, as SEAM.md §70 says and objection 066 settled. M407 reads it that way: "`implements` holds requirement ids, §70; objection 066", mapped with `keyOf`. The publication writes ids through `requirementIds` in plan/bundle.ts, as it does for any stage.

The test's own fixture is live: the stage implements three requirements, R1 to R3, and not R4. Only the form of the comparison is wrong. On build/m5-s32 at d3bb2eb, M413 run alone (8 of 10 pass; these two fail):

```
not ok 7 - (e) the stage implements the confirmed set of phase 1, not the defect
  error: |-
    + actual - expected
    +   'req_01M4SEKKXR4Q8HS7HYYFKJW5JT',
    +   'req_01M4SEKKXR4Q8HS7HYYFKJW5JV',
    +   'req_01M4SEKKXR4Q8HS7HYYFKJW5JW'
    -   'R1',
    -   'R2',
    -   'R3'
```

What I believe the assertions should be: map each id to its key (`requirementsOf(home, project)` gives `id → key`, as M407's `keyOf` does), then compare with `['R1', 'R2', 'R3']`. The "delivered set unchanged" comparison in M413 (f) compares ids with ids and is fine as written.

## 2. A later Architect session with a plan already open raises `architecture_approval` alone

The roadmap-move case writes a second Architect session's files. It deletes `phase-1.json` and `phase-1.md` from what the turn writes. Phase 1's plan file is still in the tree from the first session, unchanged. The case then calls `retrofitArchitectSession` with the default `answer: 'both'`, which asserts that the close raised `plan_approval`.

The close's bundle carries no changed plan, so its `phase_number` is null. A null phase is an architecture-only bundle, "a later Architect session, D6 §3.4", as migration 0023 annotates `plan_bundles.phase_number`. M404 (e) pins that behaviour in slice 31. Raising `plan_approval` here would ask the owner to publish a second plan for phase 1 while phase 1's plan is open, which `registerPlan` refuses with `plan_generation_stale` (D6 §5.2; K4). The engine therefore raises `architecture_approval` alone:

```
not ok 10 - (f) a roadmap revision moving the failing requirement to phase 2 changes nothing: verdict, delivered set and gate; no Alpha
  error: 'the close raised plan_approval ({"run":{…},"saved":null,"decisions":[{"id":"dec_…","kind":"architecture_approval","batch_key":"rec_…"}]})'
```

To establish what the rest of the case would show, I ran a scratch probe outside the acceptance tree. It is not an acceptance file, and it is not committed. The probe repeats the case step by step, with `answer: 'none'`, and then answers `architecture_approval` `approve` as the owner. The close answered 200 with `["architecture_approval"]`. Roadmap revision 2 was recorded (versions `[1, 2]`). The conformance stage's `implements` was unchanged, and the last stage gate was not satisfied. The owner's deployment request for c-1 answered 409 with no authorization issued. The probe passed, 1 of 1. Every observable the row names holds. Only the helper's expectation of a second decision does not.

What I believe the case should do: call `retrofitArchitectSession(..., { files, answer: 'none' })`, then consume the raised `architecture_approval` with `approve`, then go on as written.

## 3. M414 (d): the replans that should pass are refused by the fixture, for two reasons the row does not test

The case's architect writes `roadmapJson({ phase1: ['R2', 'R3'], phase2: ['R1', 'R4'] })`. Its phase 2 has `modules: ['service']` (products.mjs `roadmapJson`). Every replan the case scripts writes a phase-2 stage with `modules: ['lib', 'service']`. Clause 3 of the plan check refuses a stage module outside its phase (`PLAN_MODULE_OUTSIDE_PHASE`, `stage 2:lib`). This is a slice-31 reason, not a retrofit one, and it refuses all four replans whatever R1's state.

The third and fourth replans, the ones meant to pass after the owner approved R1's criteria, also write `phasePlan(2, { revision: '__HEAD__' })`, whose `prepared_against.spec_version` defaults to 1. The approved change made version 2, so the check refuses them `PLAN_STALE_BASELINE` (`spec_version 1 (approved 2)`), clause 2.

The engine's part of the row holds. I ran a scratch probe of the case, not committed and outside the acceptance tree, against this branch after the fix below:
- **As written:** two refusals carry `PLAN_DESCRIPTIVE_MODULE_TOUCHED`, the replan's request is an ordinary `spec_change_requests` row, and R1 becomes `pending` once the owner approves it. The later replans are refused `PLAN_STALE_BASELINE` and `PLAN_MODULE_OUTSIDE_PHASE`, and phase 2 is never published (the case's last assertion).
- **With phase 2's roadmap modules `['lib', 'service']`:** the later replans are refused `PLAN_STALE_BASELINE` alone.
- **With both fixed** (those modules, and the third and fourth replans prepared against `spec_version: 2`): the plan checks are `refused [PLAN_DESCRIPTIVE_MODULE_TOUCHED]`, `refused [PLAN_DESCRIPTIVE_MODULE_TOUCHED]`, then `passed`. Phase 2 is published, and the probe passes.

What I believe the case should do: give phase 2 of its roadmap the modules `['lib', 'service']`, and prepare the replans that follow the approved change against `spec_version: 2`.

The fix this probe needed in the engine is in the branch (`src/store/transitions/runs.ts`). A replan refused while the requests for criteria its result made are still open waits for the owner's decision on them, through a `spec_change_requests` milestone, and spends no repair attempt. Without that, the case's four scripted replans exhaust the repair budget before the owner approves the request, and the replan parks behind a blocker.

## Sources

- SEAM.md §70; objection 066 (`implements` holds requirement ids); M407's `keyOf`.
- D6 §5.3 clauses 2 and 3; §8.3 (the replan's requests, approved by the owner); products.mjs `roadmapJson`, `phasePlan`.
- D6 §3.4 (a later Architect session's architecture-only approval), §5.2, K4 (one open plan; `plan_generation_stale`); migration 0023's `plan_bundles.phase_number` comment; M404 (e).
