# D6 draft 2 cross-review — Astra

Reviewed against checkout `fbbc706`, D6 draft 2 dated 2026-10-12, under `docs/reviews/D6/sdlc-design-D6-review-brief-astra.md`. This is a design review, not implementation or paid-run authorization. No model, benchmark, sandbox probe, or service-manager operation was run.

References below use these file aliases, always with the applicable section or function:

- **D6:** `docs/design/sdlc-design-D6-idea-to-alpha.md`.
- **Decisions:** `docs/design/sdlc-design-D6-decisions-prep.md`.
- **F:** `docs/foundations/sdlc-framework-foundations-v1.0.md`.
- **E:** `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`, entry number.
- **D1:** `docs/design/sdlc-design-D1-engine-core.md`; **BS:** `docs/spec/M1-build-spec.md` §6; **RN:** `docs/design/sdlc-design-D1-resolution-note.md`.
- **D2:** `docs/design/sdlc-design-D2-backends-and-isolation.md`.
- **D3:** `docs/design/sdlc-design-D3-checks.md`.
- **D4:** `docs/design/sdlc-design-D4-deployment.md`.
- **TPL:** `docs/spec/templates/project-spec-template.md`.
- **CH:** `docs/reviews/predecessors/sdlc-review-claude.md`; **AH:** `docs/reviews/predecessors/sdlc-review-Astra.md`.
- **M1–M4 plans:** `docs/acceptance/sdlc-M1-acceptance-plan-Astra.md`, `sdlc-M2-acceptance-plan.md`, `sdlc-M3-acceptance-plan.md`, and `sdlc-M4-acceptance-plan.md` in the same directory. Row identifiers below refer to those files.
- Source paths beginning `src/` or `migrations/` are relative to `packages/engine/`.

## 1. Verdict

**Approve with the amendments in section 2 applied.** Engine-owned conversations, independent phase check authoring, mechanically checked planning, envelope-limited concurrency and a governed route from either an idea or adopted code to Alpha fit the foundations and Sean's E139 decisions. Draft 2 does not yet join those mechanisms safely: it conflates saved plans with approved plans, leaves changed-spec evidence usable through races, makes T1 nomination depend on verification that requires nomination, and proposes a conformance escape that conflicts with the finding and delivery rules. These have bounded corrections below; none requires another architectural review cycle, provider continuation, a new planning role, or removal of retrofit from M5. After disposition, their remaining precision belongs in the Verifier's tests under E20.

## 2. Blocking objections

### B01. A terminated turn is not necessarily a settled turn

**D6 §§2.1–2.4, C: S01–S07.** `open_idle` is expressly conditioned on domain termination, but the new turn protocol does not also require collection, workspace materialization, reply publication and usage settlement to have reached a durable outcome. A save admitted while collection is still writing the host workspace can snapshot incomplete content; another turn can receive an incomplete transcript or spend before the previous turn's usage is accounted. “Stops the session at that boundary” does not specify the checkpoint and end protocol for budget exhaustion. This is a missing contract, not a claim that current one-shot termination is broken.

**Evidence:** D2 §§1.4, 2.5, 3.2 distinguish termination from collection; `src/store/transitions/runs.ts::finishRun` separately reconciles receipts, collection, grants and leases. E10 requires metered turns and session boundaries; E7 requires durable termination/accounting. D6 S04 only refuses a save in `turn_running`; it cannot catch an early transition to idle.

**Replacement text:**

> A turn becomes `open_idle` only after launch closure and domain termination are established, collection and materialization have a durable terminal outcome, the accepted reply or explicit failure is recorded, and the invocation's usage is recorded, including any unknown remainder. Save, close and next-turn admission use one transactional session-generation check. A save and a turn cannot both acquire the same idle generation. Every next turn revalidates the grant, qualification and cumulative session budget; pending or unknown usage is handled by D2's budget policy, never as zero. Budget exhaustion admits no further turn and closes through the same save-or-record-retained-workspace and end protocol as idle closure. Cancellation and recovery cannot append a late reply, materialize late bytes or charge the same invocation twice into a successor turn. Only engine transitions assign transcript speakers; role text and artifact contents cannot create owner or engine entries.

### B02. Saved intent, approved baseline and registered plan need separate authority

**D6 §§2.4, 3.4, 5.3–5.6, A.3.** Session saves commit checkpoints on the integration branch; §5.5 says the committing finalizer registers stages and runnable work; §3.4 says only approval does so. §5.6 even places plan validation and routing after its integration commit. The initial plan must name approved architecture and roadmap versions that do not exist until that same approval. A literal implementation either deadlocks first approval or makes unapproved/invalid intent current and schedulable. Two proposals also need more than an eventual “second plan refused” after both have changed the branch.

**Evidence:** F §§3.3, 3.10.6; D1 §§7.8, 10.5; `src/store/transitions/finalize.ts::finalizeIntegration` currently invokes `registerPlan` for supplied plans, without D6's new approval distinction. D6 A02 and P06 express different publication moments. CH §3.4 incident 11 is precisely the plan/work correspondence failure this must prevent.

**Replacement text:**

> Checkpoints are draft intent and create no effective baseline, stage or authoring work. All production context packages resolve approved baseline artifacts by their approved immutable bindings; a newer draft file in the checkout cannot replace them. Initial architecture, roadmap and phase-plan approval binds one prospective bundle: the current approved spec and head, all proposed artifact blobs, and the versions that the successful publication will allocate. The engine checks that bundle before accepting approval. Automatic replans undergo the same check and publication protocol without a human answer when routing permits. An authorized journal finalizer publishes the approved bundle and registers its stages and work exactly once. An unapproved or refused checkpoint cannot invoke that finalizer. Publication compares the current baseline and active-plan generation again; competing proposals cannot both become current. Recovery produces either the authorized publication once or a refused/stale proposal, never runnable work from draft intent.

### B03. Automatic routing must be derived from artifacts, not the Architect's summary

**D6 §§5.3–5.4, 5.6; A.3 `plan_checks`.** The routing combines `conformance: within_baseline` and result declarations with computable changes. It does not clearly require computation for every permitted Architect artifact. A replan can change `modules.json`, architectural text, remove an ADR, alter phase dependencies or remove a future phase while reporting no ADR change or requirement move. These cases do not fit the stated automatic/human branches. “Needs a spec change” also cannot rescue an unknown requirement after §5.3 has already refused it.

**Evidence:** F §3.10.6 explicitly rejects agent-claimed conformance as sufficient. D6 §2.5 permits all architecture/ADR/roadmap/phase paths, while §5.4's automatic route does not cover that complete write set. D6 P05 can pass using truthful fixtures even if the implementation trusts false summaries.

**Replacement text:**

> Routing is computed from the proposed artifact tree and the approved bundle. It compares every architecture and module-map artifact, ADR addition/change/deletion, roadmap phase addition/removal, goal, membership, requirement assignment and dependency, and the proposed plan. Role declarations may add uncertainty and cannot suppress a detected change. Automatic registration is limited to a structurally valid next-phase plan whose approved architecture, module map, ADRs and roadmap are unchanged and whose mechanical checks all pass. Baseline-changing proposals route to the applicable approval with the complete diff; unknown requirements are refused and offered through the spec-change workflow, never approved as an invalid plan. A mechanically rebased proposal is rechecked and rerouted against the new bundle. Mechanical conformance establishes these declared structural properties, not the semantic adequacy of arbitrary task prose.

### B04. The declared parsers and plan coverage inputs cannot establish the claimed checks

**D6 §§3.2–3.4, 4.4, 5.3; B.2, B.5.** B.2 parses headers and the index, but the body needs requirement and criterion text, open-question dependencies, module sensitivity and environments. The current index contains criterion IDs, not their meanings. Separately, three independent `validation` arrays are not D3's check-set input: they lack the associations that make coverage applicable to a requirement, tier and gate. Their union can look complete while an individual planned stage has no corresponding validation obligation. The promised prohibition on planning requirements with open questions has no §5.3 check.

**Evidence:** TPL §§4–7, 10; `src/checks/requirement-index.ts` parses the five-column index; `src/checks/scope.ts::computeScope` filters required checks by applicability and acceptance origin before counting criteria and kinds. F §§3.10.6, 5.7 require reference and validation checks. D6 C03 asks for a criterion-text change that B.2 does not define how to read.

**Replacement text:**

> The approved specification has an engine-parsed, versioned representation of requirement and criterion identities and text, sensitivity, human-test/descriptive marks, question-to-requirement dependencies, modules and environment proposals. Appendix B declares the exact syntax for each; prose outside it is not claimed as mechanically interpreted. Unreadable, duplicate or contradictory representations refuse approval. Reordering identified requirements or criteria without changing their values creates no semantic impact. Planning a requirement with an unresolved blocking question is refused; an unassigned question or requirement cannot evade that check by omitting a phase hint. Plan validation records obligations at their applicable stage and phase scopes, including criteria, effective tier, kinds and sensitivity. The engine uses shared coverage primitives with an explicit planned-obligation input; planned entries are not fabricated CheckDefinitions or acceptance evidence. Check authoring must later establish the actual protected required set against those obligations.

### B05. Spec approval invalidates a list, but does not fence the evidence being produced

**D6 §§4.4–4.6.** Four issues are one missing dependency protocol: (1) changing a requirement's statement without changing criterion IDs can leave its checks outside the affected-check list; (2) changing a criterion's text does **not** make its unchanged ID `criterion_unknown`; (3) a result or finding created after impact preview need not be in the stored impact; (4) an old-spec check still running at approval can later return passed. Rediscovering valid IDs and invalidating previously listed rows does not stop that pass from satisfying a current gate. Textual ADR references are a computable dependency set, not proof of complete semantic impact.

**Evidence:** F §3.8 requires impact, invalidation and assessment before reuse. `src/store/transitions/baseline.ts::specRevision` hashes index fields and `text_ref`, not an arbitrary edited requirement/criterion body; `registerRequirementIndex` recomputes index errors. `src/store/transitions/gates.ts` selects results using their existing bindings and invalidation state. D3 §§3.4, 4.5's discovery catches unknown IDs, not changed meanings. D6 C03–C05 omit unchanged-ID/in-flight cases.

**Replacement text:**

> Impact binds the approved and proposed semantic spec digests and the current dependency generations for plans, requirements, checks, findings, results and work. Preview and effect recompute the dependency manifest; a material change makes the answer stale. A requirement-statement change affects its criteria and their checks even when all IDs remain. Textual ADR references and structural mappings are reported as those dependency classes, not as complete semantic analysis. Where semantic independence is not established, affected scope is conservative and the uncertainty is shown for approval. Approval atomically advances a spec-evidence generation, invalidates affected existing evidence and records unresolved check obligations. Queued and running old-generation work cannot provide current acceptance or clear those obligations; its output is retained as history. Gates remain incomplete until a protected correction or explicit assessment establishes the checks' applicability to the changed meanings and fresh deciding evidence is obtained. Rediscovery of an unchanged criterion ID alone clears nothing. Serialization covers pending proposals as well as dispatched runs, or every proposal is independently rebound and rechecked before approval.

### B06. T1 phase completion is circular, and phase checks need execution registration

**D6 §§5.8, 6.3, 7.4; K5; F01–F03.** A T1 phase waits for every stage to be `verified` before nominating the candidate on which those stages can be verified. The optional Builder nomination makes some fixtures pass while the default path stalls. “Checks running after each integration” in §7.4 is also inconsistent with nomination-driven registration. Adding a phase evaluator alone will not execute checks that list only `phase`. Finally §5.8 step 4 requires a phase sign-off at every tier, while step 3 and F02 specify T2/T3.

**Evidence:** E11; D3 §§2.5, 4.2–4.3; `src/checks/scope.ts::SCOPE_KINDS` currently contains `stage` and `alpha_authorize`; `src/store/transitions/finalize.ts::finalizeNomination` initiates candidate verification. D6 F01 repeats the circular precondition.

**Replacement text:**

> At T1, completion of the phase's integrations and required authoring obligations, not prior stage verification, triggers nomination of the current integration revision. The engine registers and executes the required checks for the held stages and the phase scope, including phase-only checks and the declared regression set. It then evaluates stage and phase gates on that candidate. T2/T3 retain stage nominations; phase completion registers any additional phase obligations on the current candidate. Historical stage verification does not substitute for current regression evidence. The phase-verification role sign-off is required at T2/T3 and is not required at T1. Its binding includes the candidate acceptance content, effective protected version, spec and phase-plan generation; supersession cannot transfer it. Phase completion and replan creation occur once for that binding. Ordinary T1 integrations do not claim acceptance-check execution unless they cause an explicit check registration.

### B07. Authoring completion is not protected-check readiness

**D6 §§5.5, 6.2; K7; W04.** Making `check_authoring` behave like `check_correction` releases its dependants on a completed Verifier run, while the proposal can still await approval/application. Deferred criteria contain no named stage in the result contract, although W04 requires one. A second item can be registered without ever becoming runnable or blocking a gate. The `build_first` exception records a reason but omits F §5.1's independent review and gate visibility.

**Evidence:** `src/store/transitions/work-table.ts` gives `check_correction` `RUN_ONLY` states; `src/store/transitions/runs.ts::workAfterRun` completes non-integrating work on a completed run. D1 §7.9 and D3 §3 separate capture from application. F §5.1 names all three exception conditions. Also, adding files under default inputs may change existing checks' fingerprints: D3 §3.1 does not guarantee every later-phase proposal is tightening.

**Replacement text:**

> Phase authoring readiness is distinct from the author run's completion. Builders are released only after the authorized protected version establishing the phase's initial check obligations is applied, or an explicit pre-implementation exception is effective. A captured, rejected or unapplied proposal does not establish readiness. Each deferred criterion records its reason, prerequisite stage/interface, follow-up authoring identity and unresolved obligation; the prerequisite's integration makes that item eligible exactly once. Phase and deployment gates remain incomplete until the applicable actual checks exist and pass. A `build_first` exception records the owner's reason, an independent review and a gate-visible binding to the affected scope; it does not waive acceptance coverage. Proposal classification is always the classifier's computed result, including existing-input fingerprint changes, never an assumed tightening because files were added.

### B08. Early replacement and integrated-stage dependencies need current generations

**D6 §§5.2, 5.5, 5.7, 6.3–6.6; P06, F04, X04.** “Second plan for the open phase is refused” conflicts with replacement. §5.5 models dependencies as work completion; §6.4 releases them at integration; §6.3 again says they are met at verification. §6.6 promises a parked predecessor holds its dependants although its historical integration still exists. Keeping an in-flight stage merely because number, goal and `implements` match ignores changed tasks, validation, modules, ADRs and dependencies. Blindly registering the replacement's stages can duplicate completed work or change delivery calculations.

**Evidence:** F §§3.10.7, 3.10.8; D1 §9.1 derives delivery from the registered stage set. `src/store/transitions/runs.ts::dispatchBlocker` currently requires dependency work `complete`; `src/store/transitions/work.ts::registerPlan` creates new stage/work rows. These are semantic changes, not just adding columns.

**Replacement text:**

> Distinguish dependency milestones: stage-code integration and phase-authoring readiness. Stage-code readiness requires the referenced active stage generation to have integrated code and not to be cancelled or parked; it does not require verification. Already-running dependants remain subject to current findings, supersession and gate checks. Early replacement is an authorized compare-and-swap on the active plan generation, exempt from the ordinary second-plan refusal only through this route. It preserves completed stage identities and history, cancels obsolete unbuilt obligations, and registers only the replacement remainder. A running stage's result is retained for the replacement only when all execution and acceptance inputs are unchanged, including tasks, modules, ADRs, dependency identities, validation and integration obligations. Otherwise its late integration is history and does not fulfill replacement work. Delivery, dispatch and completion use the active obligation set; cancellation cannot erase delivered-code findings or the sensitivity floor. Recovery cannot register the remainder twice.

### B09. The proposed envelope is not the envelope as built

**D6 §6.4, A.7; K2; X05–X08.** The stated inequality compares total maxima to `MemAvailable` alone. The current implementation deliberately adds back the memory currently held by accounted domains; otherwise their consumption is charged twice. Removing only the project run cap leaves the engine-wide `max_concurrent_runs` default of two, so the claimed three-run case at 16 GiB still cannot happen. Per-project check maxima also make a single shared service-check reservation ambiguous when surviving services belong to different projects. Smaller memory limits change qualified profile bindings; D2's volatile storage is charged to the same limit, not free space outside it.

**Evidence:** `src/store/transitions/envelope.ts::envelopeHold` computes `room = MemAvailable + sum(memory.current)` and reserves a check slot; `src/store/transitions/runs.ts::dispatchBlocker` checks the global run count; `src/config/schema.ts` has both engine and project `max_concurrent_runs`. D2 §§2.3, 3.7, 7.2, A.7; D4 §9.2; E126. D6's numerical sums describe an initially idle, otherwise eligible host, not an unconditional admission result.

**Replacement text:**

> Admission preserves the as-built accounting rule: reserve plus the sum of immutable admitted domain maxima, service reservations, self-test reservations and unoccupied shared verification capacity must fit within `MemAvailable` plus the observed current memory held by the domains included in that accounting. Unreadable required observations hold admission. Each new role/check domain uses its project's effective profile maximum and records it at admission; later configuration changes do not resize its reservation. Shared service-check capacity is sufficient for the largest effective check maximum among the services it must serve and is reserved exactly once, with its slot. Both project and engine role-run counts cease to impose an additional admission cap; domain slots, work/session exclusivity and the envelope remain. The profile's memory and writable-storage bounds are mutually valid and included in its qualification identity; changed profiles follow the existing qualification/revocation protocol before real dispatch. The 12/16 GiB examples assume an otherwise idle qualified host, sufficient disk, no additional reservations and enough domain slots.

### B10. A role-controlled origin label is not human confirmation

**D6 §§3.4, 8.1–8.3; K10; R02–R04, R08.** Retrofit decides whether to raise `requirement_confirm` from the role-written `Origin`, whose omitted value defaults to `intended`. Thus changing or omitting a column can remove an individual confirmation. The whole-spec approval is not recorded as that per-requirement confirmation. Full mode also permits unanswered/criterion-less observations to be excluded just like scoped mode, despite requiring a complete descriptive baseline. Conversely §3.4's generic criterion requirement can block the scoped exception entirely.

**Evidence:** E6 requires every descriptive requirement to remain marked reverse-engineered until a human confirms it; full/scoped have different criterion obligations. D6 §8.1 step 2 and §8.2 make `Origin` a role product; R02 requires the legacy default. This is a structural authority gap, without any assumption about model intent.

**Replacement text:**

> Retrofit provenance is engine-owned. A requirement produced from adopted-code analysis remains reverse-engineered and unconfirmed unless an explicit owner action confirms that identified requirement, or the engine binds it to an identified owner-authored requirement already approved. `Origin` is a claim and cannot supply confirmation; omitted or `intended` role labels do not bypass the decision. Consolidated approval records each confirmation separately against the exact proposed requirement text and criteria. Full-baseline approval requires every in-scope descriptive requirement to be confirmed or explicitly withdrawn and to have the required criteria; a defect remains an explicitly recorded pending obligation. Scoped-baseline approval may retain criterion-less descriptive requirements visibly pending, but the engine refuses planning changes to their modules until the ordinary spec-change/confirmation path establishes their criteria. Both modes retain whole-project sensitivity classification. The generic spec-approval check applies these explicit mode rules rather than silently excluding incomplete full-baseline requirements.

### B11. The conformance journey needs a source identity and a completion barrier of its own

**D6 §§8.1, 8.3–8.4; K11; R05, J03.** R05 requires the integration head at phase completion to equal the adoption commit, although bootstrap, spec, plan and protected-check commits have advanced that head. The conformance stage has no `stage_build`, but current nomination holding and stage completion depend on one. It implements “every confirmed requirement,” including confirmed defects that step 3 assigns to later phases; that prematurely delivers them under D1 §9.1. Finally §5.6 replans immediately on the phase gate, whereas E6 requires unchanged-code Alpha **and deployment verification** before planning changes.

**Evidence:** E6; D1 §§7.8, 9.1; D3 §2.2's candidate source plus effective protected tree; `src/store/transitions/finalize.ts::finalizeNomination`, `src/store/transitions/gates.ts::dueStageGates` and `completeStageWork` rely on stage-build work. D6 R05 is unsatisfiable as written, not merely missing a race test.

**Replacement text:**

> Adoption records an immutable source revision A before bootstrap. The first candidate's application source is A; subsequent engine-owned intent and protected commits may advance the integration branch without changing that source. Conformance proves equality of the adopted application-source projection, including modes and paths, not equality of integration HEAD to A. The source projection and excluded engine metadata are defined and checked mechanically. A durable conformance-stage lifecycle replaces the absent Builder work in nomination, ancestry/delivery, verification registration and gate completion; it cannot pass from the absence of stage-build work. It implements only the explicitly approved conformance requirement set, excluding obligations intentionally scheduled for later delivery, while preserving the entire sensitivity floor. Check execution uses A with the effective approved protected tree. Movement of the pinned source binding or an unauthorized application-source change refuses conformance. For adoption only, phase-one completion for purposes of releasing the change-phase replan additionally requires the successful Alpha completion bound to A. Manual policy, failed/unknown deployment or stale verification leaves that barrier closed.

### B12. Moving a failed requirement does not verify its fix

**D6 §8.3, K11, reading 10, R06.** The design says a failing required check keeps the gate unsatisfied, then says moving its requirement lets conformance complete. The existing delivering stage still implements that requirement; changing its roadmap assignment does not undo delivery. Keeping the failed check leaves conformance blocked; dropping it or relabelling the finding to obtain a pass bypasses the acceptance rule. This is not a faithful reading of E6 or F §6.2.

**Evidence:** F §§5.4, 6.1–6.3; D1 §§9.1–9.3; D3 §2.11, especially the exact-criterion finding-resolution rule accepted in E90. E6 says code is unchanged until conformance is established; it does not say a failed confirmed behavior may disappear from acceptance scope. M3 plan M235 is an existing invariant, not a row to relax.

**Replacement text:**

> A `fix` disposition during conformance records an unresolved finding and proposed future remediation; it neither verifies the finding nor removes an existing acceptance obligation. Moving a requirement to another roadmap phase does not make a failed required check pass, change the conformance stage's delivered set, or authorize Alpha. A genuinely incorrect check or specification follows its existing protected/spec-change approval path, with the resulting invalidation; a label or roadmap move is not such an assessment. Existing permitted accept/defer dispositions remain subject to the severity ladder and cannot override a failed required check. If unchanged adopted code cannot satisfy the confirmed conformance baseline, conformance remains blocked and the owner sees that condition. Any additional route permitting source repair before conformance is a separate decision amending E6, not an inferred meaning of `fix`.

Sean's decision, if he wants such an additional route, is listed at the end. The safe blocked outcome is fully specified without it.

### B13. Copying a test entry point does not necessarily protect its acceptance logic

**D6 §8.3, reading 11, R07.** A copied test can import an assertion helper, expectations or test configuration from the original Builder-owned tree. Its protected entry point then runs Builder-controlled acceptance logic. R07 can pass by changing only the original top-level file, missing the helper. Importing the application under test is different from importing the assertions that decide its correctness.

**Evidence:** F §§1, 5.2–5.4; E6; D3 §§1.3–1.4, 3.2, 6 class C. D3's input fingerprint protects declared inputs; it does not turn arbitrary unprotected dependencies into independent acceptance logic. CH §3.4 incident 17 illustrates why merely running a nominal check is insufficient.

**Replacement text:**

> Adoption identifies the test's acceptance logic, expectations, fixtures and runner configuration, not only its entry point. Those acceptance-controlling artifacts are copied into declared protected inputs, or the Verifier replaces them with independent protected logic. An adopted check cannot delegate its acceptance decision to the original mutable test suite or its helpers. The proposal lists this dependency boundary for independent review. Importing application code as the subject under test remains subject to D3's stated limits and is not evidence of protected assertion ownership. A regression case changes an original assertion helper and original expectations after adoption; neither change can weaken the protected check's verdict. No general semantic dependency analyzer is claimed.

### B14. Automatic Alpha must enter at the request, not the authorized-work trigger

**D6 §6.8, K9, D01.** The text identifies raising a `deploy` trigger as making D4's request. In the source those are different layers: `requestDeployment` derives the authorization and evaluates the gate; deploy work consumes an authorization. A scheduler trigger is not a substitute for sealing, binding and authorization. Repeated satisfied-phase observations also need an idempotent request identity after deployment completion, not merely while an attempt is pending.

**Evidence:** D4 §§4.1–4.3, J3/J4; `src/store/transitions/deploy.ts::requestDeployment`; `src/store/transitions/work.ts::observeTrigger` is a generic work-registration operation. M4 plan M303, M305, M306, M336 pin the authorization boundary.

**Replacement text:**

> `on_phase_complete` creates an idempotent engine request through the same production request path as the owner's deploy command, identified by project, phase-completion binding, candidate and environment configuration. That path seals the source, derives and evaluates the authorization, and only then creates authorized deploy work. A phase gate or configured/qualified environment alone never authorizes deployment. Repeated ticks, restart and a completed prior request do not create another request for the same binding. A superseding candidate, configuration or phase evaluation is revalidated under D4 before any effect; failure retains the request outcome and does not turn the scheduler into an unbounded retry policy.

## 3. Non-blocking suggestions

### N01. Make pace a durable interval measurement, and remove unsupported performance assertions

**D6 §§2.2, 7.1–7.7; M01–M02.** The choice to postpone performance measurement is sound; “cache absorbs most,” “near Verity's pace,” and “no cost” for raising the domain cap are not established measurements. A terminal invocation interval includes tools, waiting and provider time, not just model computation. Summing overlapping decision lifetimes double-counts human wait. Ticks with holds are counts, not elapsed idle time. A starting host observation and eligibility/hold intervals cannot be recovered from current rows after a restart unless recorded when they occur. D6 A.3 adds peaks but not all of those observations.

**Evidence:** D1 §§12.2, 13; D2 §3.2 permits domain removal after termination. The two JSON reports named in §7 below establish small-run observations, not role peaks or a cache-hit expectation. CH §3.5 and AH §7 warn against non-equivalent benchmark comparisons.

**Replacement text:**

> Cache savings and throughput are unmeasured until the reports record them. The pace contract declares the durable observation/event underlying each metric, including eligibility and hold intervals, start-host values and peak concurrency. Read memory peaks before domain removal, recording unknown when unavailable. Label launched-to-terminal duration invocation elapsed time. Human wait is the union of relevant blocked intervals within the stage's measured lifetime; decision-hours may be shown separately. Restart gaps and missing endpoints remain unknown or explicitly bounded, never measured zero. Benchmark reports bind fixture revision, starting baseline, endpoint, model, profile and counted human/qualification time; unlike endpoints are not reported as speedup.

### N02. Add a safety-priority case to the event-driven tick, and describe the chain cap accurately

**D6 §§6.5, 7.5, K1/K3, X03/X07.** Coalescing the existing tick-request flag is appropriate. It must not become synchronous recursive dispatch or starve lease renewal, termination, recovery and budget checks during a stream of completions. Also `max_chained_roles` is a per-chain depth cap, not a project-wide invocation budget; fresh plan-stage triggers can reset chain origins. That is acceptable with budgets/repair limits, but “a loop can never run away” attributes too much to 24.

**Evidence:** D1 §§1.5, 8.1 steps 1–4; `src/store/transitions/work.ts::chainBoundary`, `runs.ts::claimDispatch`, `finalize.ts::finalizeNomination`. D6 X07 tests latency and serialization, not safety-task progress.

**Replacement text:**

> Tick requests coalesce and never re-enter the tick. Every tick retains the safety-prerequisite order and yields under its budget even while completions keep requesting another tick. Tests hold work continuously eligible while exercising expiry, cancellation and recovery. The chain cap bounds inherited chain depth; tests identify every new-chain origin and prove the cap can bind independently of a budget. Repair, no-progress, run and project budgets remain separate bounds and are not represented as one aggregate chain counter.

### N03. Correct the source claims and appendix accounting before generating the build plan

**D6 preamble, §§2.7, 3.4, K4/K7/K10, Appendix A/C.** Inspection finds: `registerPlan` already accepts a phase argument (the fixture defaults to 1); `replan` is already dispatchable; `confirmed_by` already exists in migration 0005; the API has refused open/turn/save/close routes, not the advertised show/resume routes; `configureEnvironment` is a fixture-style baseline operation with adapter `none`, not the full D4 configuration path; the requirement index parser alone does not write all of the proposed versioned baseline. S08 still refers to the removed project run limit. Appendix C has **59 distinct D6 rows**, not 60. The preamble cites AH §7.2, but that review has §7 without that subsection.

**Evidence:** `src/store/transitions/work.ts::registerPlan`, `work-table.ts::DISPATCHABLE`, `baseline.ts::configureEnvironment` and `registerRequirementIndex`; `src/testing/fixtures.ts::installFixturePlan`; `src/api/server.ts`; `migrations/0005*`; direct enumeration of D6 C.1 and AH headings.

**Replacement text:**

> “As built” distinguishes reusable implementation from the contract M5 adds. `registerPlan` accepts a phase but lacks production plan validation, dependency milestones and the approval protocol. Session show/resume are new routes. Existing baseline fixture helpers are not production approval authority. The M5 seam reconciles table/status names and versioned text publication with the accepted schema, including refreshing ADR/requirement text used in context packages. S08 tests project session exclusivity, not a removed project run counter. Appendix C contains 59 statements in draft 2; the acceptance plan records its actual revised count.

### N04. Plan the first-toolchain proposal against the actual Verifier contract

**D6 §6.2, W04.** Keeping first toolchain approval separate faithfully applies E139 Q9. But the existing check-writing guide tells the Verifier not to change the governed file or check programs; a new authoring prompt must deliberately permit the proposal D6 asks it to produce. Also later check additions need not be tightening when default inputs include the entire protected tree (B07).

**Evidence:** `src/checks/guide.ts`, especially governed-file and check-command instructions; D3 §§1.3, 3.1; E103/E135's first-try failures. This is an implementation/prompt regression obligation, not another policy decision.

**Replacement text:**

> The phase-authoring context has a distinct result schema and proposal permissions for the governed commands and check programs needed by its obligations. It retains the protected-update route and explicitly says that writing a proposal grants no execution authority. The acceptance cases verify the generated authoring package as well as the resulting proposal, and cover both a later strict addition and an addition that changes an existing default input fingerprint.

## 4. Corrections K1 to K11

K1–K9 remain Sean's decisions; this table judges implementation in the draft, not whether to undo them. “Additional rows” means preserve the existing invariant and add or deliberately migrate cases, not ask the Builder to weaken an accepted test. Row paths are defined above.

| Correction | Draft-2 fidelity / recommendation | Additional accepted-row impact beyond C.2 |
|---|---|---|
| K1 | Faithful direction; N02 pins coalescing and safety priority. | M12, M15, M18 and M71 need event-storm/expiry/cancellation scheduling, not only faster happy-path ticks. Journal finalizers M26/M33 must remain once-only under repeated requests. |
| K2 | Incomplete: B09 corrects accounting, removes the remaining global run cap, binds profile maxima and shared check capacity. | M07's engine cap as well as its project cap; M112–M115 launch/closure with several runs; M133–M134 profile pressure/revocation; M220 and M221 check scheduling/self-test bindings; M319 shared verification capacity across different project maxima. M28's serialized rebase and M43's independence remain. |
| K3 | Faithful policy choice, but “per chain” needs N02's scope. | M09–M12 and M45 boundary manifestations; M234 repair accounting and M236 objection holds across pipelined stages. C.2's “M40-class chain” description is inaccurate: M40 is evidence invalidation in the M1 plan. |
| K4 | Incomplete: B02–B04/B08 define prospective first approval, actual routing, typed obligations, replacement and readiness. “Phase 1 only” is not the current function signature. | M02/M10 trigger identity; M26/M33 finalizer recovery; M38 delivery; M56/M57 combined approvals and fresh reads; M74 fixture confinement. Defaults must not let production callers invoke the fixture bypass. |
| K5 | Incomplete: B06 fixes the deadlock, execution and sign-off scope. | M27 nomination cadence; M38/M44 stage versus deployment scope; M204/M206 phase check registration/sequence; M208 supersession; M229–M232 scope, kinds and sign-off applicability. The phase gate's refusal row is only one affected row. |
| K6 | Faithful choice of engine-held continuation; B01 closes the lifecycle. Separate session qualification remains required despite one-shot invocation mode. | M03/M08/M09 session constraints; M13–M18 session interruption/recovery; M21 save quiescence; M59–M61 per-turn ledger and cumulative budget; M101 qualified-session exception; M129/M131/M132 collection, fresh invocation and redaction; M134–M136 qualification identity and canary evidence. |
| K7 | Incomplete for authoring readiness and all `spec_change` outcomes (B05/B07). Replan is already dispatchable. | M09 per-kind state tables; M10 repeated triggers; M11 bounded failed/rejected authoring/replan repair; M13–M18 cancellation and quarantine for session and new one-shot work; M36/M37 proposal capture versus application. |
| K8 | Faithful extension in principle; B04/B05 supply semantic versions and stale-effect behavior. | M24 registered side refs versus developer refs; M28–M34 side-ref/rebase recovery; M38/M40/M41 delivery, invalidation and reuse; M56/M57 preview consumption; M227/M228 spec-sensitive classification. |
| K9 | Faithful policy intent, wrong source-level entry point unless B14 is applied. | M303/M305/M306/M336 authorization, request replay and capability boundaries; M318/M325 supersession/lease; M323 no accidental automatic retries after failed attempts. Existing M4 deployment evidence is not replaced by a phase pass. |
| K10 | **Accept with variant B10.** Optional legacy syntax is fine; engine-owned provenance and mode-specific confirmation/criteria rules are necessary. | M38/M43 delivered versus descriptive requirements and the floor; M56 batched decisions; M229–M233 scope and index; production adoption cannot rely on fixture status defaults. |
| K11 | **Accept with variant B11; reject the `fix` escape, replace with B12.** A no-Builder conformance lifecycle is sound. Commit equality and finding resolution by phase movement are not. | M26/M27/M38 stage registration, nomination and delivery without Builder work; M42/M50 finding/disposition applicability; M234/M235 repair and exact-criterion resolution must not be weakened; M303/M317 adoption Alpha completion; M33 restart before releasing change planning. |

The mandatory floor is compatible with `autonomy: phase` and concurrent Builders **if these bindings hold**. The ten original F §9.1 items, plus E10's addition, map as follows:

| Floor item | D6 assessment |
|---|---|
| Human spec approval | Retained by §§3.4, 4.5; B02/B05 prevent draft or stale approval from becoming authority. |
| Builder cannot determine acceptance alone | Retained in §6.1; B07/B13 are necessary for initial/adopted checks, and B06 for actual phase execution. |
| Protected changes only through the update process | Retained by §6.2; proposal completion cannot substitute for application (B07). |
| Observed deployment verification | Retained through D4; B14 keeps the automatic request behind that protocol. |
| Reconcile interrupted external operations before retry | D4 retained by §6.1; auto-request replay must not bypass its reconcile/retry rules (B14). |
| Human first-publication/allowlist-widening approval | Publication is out of M5 (§11); phase autonomy grants no publication capability. |
| Human every production go-live | Live is out of M5 (§11); automatic Alpha is not Live authority. |
| Recovery plan before go-live | Live is out of M5 (§11); nothing here satisfies or removes that future obligation. |
| Observed management activation | Management is out of M5 (§11); the phase gate is not management activation. |
| No conversion of failed/missing checks or blocking findings into pass | B05/B06/B10–B12 close the material risks. Plan moves, incomplete confirmations and budget outcomes cannot remove the floor. |
| E10: every model invocation engine-owned, granted and metered | The one-shot-per-turn design preserves this; B01 pins cumulative budgets and settlement. |

A Reviewer signature fixed at claim is safe for its old candidate: it must never be copied to the rebased successor. Sensitivity and inherited findings must also survive plan replacement. These are D1 §§3.4, 9.3, D3 §§2.11, 4.1–4.4 and D4 §§4–5, not new autonomy restrictions. X03's three examples do not alone prove all those boundaries.

## 5. The twelve readings

| Reading | Judgment and reason |
|---|---|
| 1 — blocking questions | **Sound only with B04's phase-entry guard.** TPL §10 permits later open questions; F §3.2 still requires questions blocking the work about to begin to be resolved. Missing phase hints or unresolved project-wide questions cannot make approval vacuously safe. Keep the uncertainty visible and forbid planning the affected work. |
| 2 — initial plan approval | **Sound.** F §3.3's entry bundle and §3.10.6's subsequent automatic conformance route coexist. B02 must make the first prospective bundle internally possible and atomic. |
| 3 — fresh Architect session | **Sound, and now expressly decided.** E139 Q2 fixes one-shot replanning from durable context with one repair. F §3.10.5's purpose is fresh reconstruction, not an idle interactive process. Remove the stale “Q2 asks Sean to confirm.” |
| 4 — checks before implementation | **Sound with B07.** F §5.1 allows later checks for executable interfaces, but not silently dropped obligations or release of Builders merely because a proposal was captured. Its exception has three conditions, not one. |
| 5 — optional Vision | **Sound.** F §§3.2, 4.1 permit a human-created idea; role boundaries still apply when Vision is used. |
| 6 — temporarily unassigned requirements | **Sound as a visible transitional state.** F §§3.8, 3.10.2 permit change workflow, not indefinite silent omission. C06 must clear the gate reason only after an authorized, complete roadmap assigns the requirement. |
| 7 — architecture approval | **Sound.** Human approval in M5 is consistent with F §9.2/E9; a later policy option need not be built now. |
| 8 — T1 nomination | **Intended reading sound; draft sequence not sound.** E11 says nominate at the completion of phase building, before the verification dependent on that nomination. Apply B06; do not create a mandatory Builder nomination to avoid the deadlock. |
| 9 — automatic Alpha request | **Sound.** E139 Q5 authorizes the optional request policy; F's floor retains verification, not a mandatory Alpha command. Apply B14 at the proper request layer. |
| 10 — conformance `fix` | **Not sound.** E6 does not amend F §6.2's unresolved-until-verified rule or the failure of a required check. Keep the block under B12; a repair-before-conformance exception is Sean's decision, not a reading. |
| 11 — adopting tests by copy | **Necessary, not sufficient.** E6 and F §5.2 require independent protected acceptance logic, not merely a protected filename. Apply B13 to helpers, expectations and configuration; retain D3's class-C limits. |
| 12 — per-profile memory | **Sound extension, inaccurate “as built” explanation.** E139 Q4 allows machine-sized admission. B09 preserves the actual accounting and qualifications. Smaller profile maxima are a performance/reliability tradeoff requiring Sean's numerical decision, not evidence that role memory demand has been measured. |

## 6. The test table

D6 Appendix C.1 has **59**, not 60, unique rows. The rows are a useful inventory, but the principal journey tests must go through production approval, registration and gate paths. A harness that installs an approved plan/candidate, manually registers a phase check or manually releases authoring would conceal several objections above. The following table accounts for every row. “Retain” means no distinct false-positive hole found beyond the named boundary cases, not that the test has been executed.

| D6 row(s) | How it could pass while the intended property is false; required strengthening |
|---|---|
| S01 | Domain empty but collection still in flight; hold idle until B01's complete settlement. Include unknown termination/quarantine and recovery. |
| S02 | Two ledger rows exist but session budget resets per turn or a retry double-charges; exhaust a cumulative budget and replay a terminal receipt. |
| S03 | Normal transcript persists but a role reply containing forged `speaker: owner/engine` or an artifact transcript marker is promoted on reconstruction; prove those remain role data. Test failed/replayed turn and append recovery. |
| S04 | Serial save/turn cases pass while concurrent idle readers both win. Barrier the save CAS against turn admission, close and materialization. |
| S05 | Correct decisions appear but work was already registered by an earlier save; assert no effective baseline/work before B02 publication. One consumed member of the first bundle is insufficient. |
| S06 | Timeout happy path loses state on refused save/restart; assert retained bytes, recorded failure, grant/lease cleanup and no late publication. |
| S07 | New run exists but old callbacks can mutate it, or transcript lineage duplicates/omits a turn; resume after crashes at each settlement boundary. |
| S08 | Serial opens pass but a session races one-shot claim; test both orderings under the same project admission guard. Remove the deleted project-counter assertion. |
| S09 | Successful two-turn answer establishes continuation but not save/cancel/accounting; retain this canary and exercise those separately under S01–S08. A passing old entry must become ineligible when its qualified dependency changes. |
| V01 | Retain normal/parse-error case; owner-created idea and accepted Vision output need distinct durable approval bindings. |
| W01 | Header/index validation passes while criterion text or other consumed sections is ambiguous/unparsed; add B04's duplicate ID, mismatch and reordered-criterion cases. |
| W02 | Phase-1 question blocks, but an omitted phase hint or a later plan evades it; test both. Approval binds parsed semantics and blobs, not just index IDs. |
| W03 | Retain whole-diff refusal; cover symlink/path aliases through the existing snapshot suite. |
| W04 | Verifier ends and Builder launches before protected application; pause between capture, approval and application. Reject the proposal. For deferral, execute the named prerequisite and prove follow-up runs once and missing coverage still blocks. Test independent review on `build_first`. |
| A01 | Rows exist but context packages still read old ADR/requirement text or a newer draft; inspect the actual package after two approved revisions. |
| A02 | Two consumed rows but baseline/work appeared after only one, or bundles from two sessions were mixed; use different blobs and preview/effect barriers. |
| A03 | Retain path refusal; spec change hidden in a renamed/deleted artifact must not escape the permitted-write check. |
| A04 | Context fields exist but do not belong to one approved generation; change spec/roadmap/head while the run is active. |
| A05 | One repair in one process, but restart replenishes the allowance or manual re-entry revives an obsolete proposal; pin durable attempt identity and refusal evidence. |
| P01 | Retain bad-reference cases; add duplicate stage identities and references whose existence changes before publication. |
| P02 | Any engine-authored head movement is treated as safe, although it changed approved intent/plan dependencies. Test harmless metadata movement separately from semantically material movement; recheck both. |
| P03 | A moved requirement passes but disappears from the authorized roadmap or acquires two assignments; compare the whole proposed roadmap and require approval before effects. |
| P04 | Complete union of three arrays hides a missing per-scope obligation. Use two differently scoped stages and a raised module tier; verify planned obligations and then actual protected coverage separately. |
| P05 | Only honest `conformance` declarations tested; lie about ADR deletion, module sensitivity, roadmap dependency/goal and architecture edits. Engine-derived routing must win. |
| P06 | Crash test for one run passes while two Architect proposals both commit/register, or an early replacement is refused as a second plan. Barrier two proposals and replay each finalizer; assert one active generation and no duplicate work. |
| C01 | Only active dispatch serialized; a second proposal is approved while the first awaits a decision. Keep one proposal active or prove each answer rebinds correctly. |
| C02 | Retain side-ref isolation and path refusal; side-ref replay/ref movement must retain proposal identity without integrating unauthorized spec bytes. |
| C03 | Adds/removes pass but identical-ID text changes or requirement-body-only changes are missed. Reorder criteria without changing their text: impact must not invent changes. Add explicit/unknown semantic dependency cases. |
| C04 | Listed three bindings stale correctly, but new results, findings, work status or plan generations outside the old impact remain unbound. Change each between preview and effect. |
| C05 | Existing results invalidated, then an old-spec execution finishes passed and restores green. Test queued, running and delayed-result callbacks plus unchanged-ID discovery; no old-generation acceptance. |
| C06 | Retain visible unassigned state; assignment clears the reason only through the approved current roadmap, not an arbitrary row update. |
| X01–X03 | Small serial chains pass while parallel independent stages bypass a `stage` boundary or new triggers reset the advertised hard bound. Test multiple chains, repairs and restart; assert every floor authority, not only three examples. |
| X04 | Integration milestone works normally, but historically integrated/now parked predecessor releases another Builder. Exercise both dispatch-before-park and park-before-dispatch. |
| X05 | Parallelism occurs but a pre-rebase Reviewer sign-off or an old candidate's evidence is copied to the successor. Include rebased protected-path violation, late earlier-stage fix and stale sign-off. |
| X06 | Static `MemAvailable` fixture passes the wrong formula. Vary current usage while preserving total accounted room; test unreadable current memory, mixed project maxima, service reserve, bound-check replacement of reserve, and remaining global cap. |
| X07 | Fast ticks pass while recovery/lease renewal starves; sustained event storm plus overdue safety work and cancellation under the existing latency bound. |
| X08 | Recorded peak comes from the wrong/reused domain or is read after its cgroup is removed; bind identity and observation timing, with unknown on loss. |
| F01 | Harness marks stages verified before testing T1. Start with integrated-only stages, no nomination request, and prove autonomous progress. Include a `phase`-only check and earlier-stage regression on the final candidate. |
| F02 | A phase sign-off exists but belongs to a replaced plan/candidate; refuse it. T1 must complete without the T2/T3 role sign-off. |
| F03 | One completion works, but repeated ticks create replans repeatedly or a later regression retroactively changes history; bind completion identity, preserve history, block stale current effects. Adoption adds B11's Alpha barrier. |
| F04 | Number/goal/implements unchanged but task, validation, ADR or dependency changed; stale integration must not fulfill replacement obligations. Include two concurrent replacements and restart. |
| D01 | Harness seeds authorization before raising the deploy trigger; require the production request path from phase completion, and prove sealing/gate refusal, idempotence after success and no retry storm. |
| D02 | Retain whole-delivered-set test; include cancelled/replaced and conformance stages so delivery cannot be rewritten merely by moving roadmap assignments. |
| M01 | Figures exist but use present host/configuration values for historical runs; restart between endpoints, mutate settings and remove a domain before a read. Require recorded observations or unknown. |
| M02 | One open decision gives the right sum while two overlapping decisions double wall time. Test interval union, partial overlap with the stage and missing/restart endpoints. |
| R01 | Normal pin works but branch changes after observation or before bootstrap; compare-and-swap and retain A. Unknown signals must not become empty/none. |
| R02 | Legacy parser passes but omitted `Origin` bypasses confirmation in retrofit; separate syntax compatibility from authority (B10). |
| R03 | Role cannot call the answer route but can suppress the question by writing `intended`; test omitted/false origin and exact text binding. Full versus scoped incomplete baselines must differ. |
| R04 | Map has labels but a touched descriptive module lacks approved criteria; test plan refusal rather than trusting the replan's voluntary change request. |
| R05 | Current HEAD equality is impossible after required intent commits. Replace with B11's immutable source projection and conformance lifecycle. No Builder/work fixture may secretly supply ordinary stage completion. |
| R06 | Roadmap moves and phase passes while the failing required check/finding disappeared. Reverse that expectation: unresolved failure blocks; no `fix` disposition grants acceptance. |
| R07 | Changing the original top-level test has no effect, but changing an imported helper disables the copied check. Mutate the helper and expectations; the protected check still detects the application defect. |
| R08 | Optional replan request exists, but planning/dispatch proceeds without it or before approval. Touch a descriptive module and require its approved criteria first. |
| J01 | Retain two phases, two stages and spec change; use production paths, no fixture registration of intermediate state. Also run the T1 no-explicit-nomination variant in the scripted lane. |
| J02 | Retain owner-instructed real journey and honest cost report; real success is not a replacement for adversarial scripted races. No run is authorized by this review. |
| J03 | The defect is included in “every confirmed requirement,” then expected pending at Alpha. Separate the approved conformance set from later intended/defect obligations, and include a newly discovered failure that genuinely blocks conformance. Hold phase-two planning until successful Alpha completion. |
| J04 | Retain the small real retrofit journey; state its limited scale and use the corrected conformance contract. The adopted-test dependency attack belongs in the scripted tests, not a hoped-for model discovery. |

**Additional explicit obligations for the M5 acceptance plan:** the seven brief candidates all need named cases: cumulative session budget exhaustion; save/turn/collection races; competing plan publications; semantically unchanged criterion reorder; deferred authoring followed through to actual readiness; adoption pin movement before registration; and pace across restart. Add cancellation/quarantine/recovery at the session turn and approval-publication boundaries, old-spec late check completion, a phase-only check, the conformance Alpha barrier, and auto-deploy replay after prior completion. These are tests of the amendments, not a request for another prose iteration.

## 7. What I verified versus inferred

### Observed this review

I read the brief and the requested foundations/errata, D6, decision sheet, related D1–D4 sections, template files and predecessor sections. I inspected the requested transition source files, index/parser/guide, fixture installer, configuration, refused API routes and migrations 0002/0005/0010/0015/0016. I also followed relevant paths into `work-table.ts`, `checks/scope.ts`, `checks/schema.ts`, the classifier and deployment request code. Commands were file reads, searches, Git status/history identification and a read-only Python enumeration of JSON/document rows; no production transition was executed.

Specific source-supported conclusions:

| Inspection | What it establishes |
|---|---|
| `src/store/transitions/work.ts::registerPlan`; `src/testing/fixtures.ts::installFixturePlan` | Phase is already an argument; fixture use defaults to 1. Production validation/approval/dependency semantics are additions. |
| `src/store/transitions/accept.ts::intendIntegration`; `finalize.ts::finalizeIntegration` | Plans are carried into integration finalization; registering them there needs B02's explicit authority boundary. |
| `src/store/transitions/finalize.ts::finalizeNomination`; `gates.ts::completeStageWork`, `dueStageGates` | Stage-build work connects nomination, ancestry and completion today; “no Builder” requires a conformance lifecycle, not just setting a stage column. |
| `src/store/transitions/runs.ts::dispatchBlocker`, `claimDispatch`, `finishRun`, `workAfterRun` | Current global/project dispatch limits, complete-work dependencies, claim-time content binding, end accounting and run-only work completion are real code paths. |
| `src/store/transitions/envelope.ts::envelopeHold`; `src/config/schema.ts` | Add-back accounting, check slot/memory reservation, engine and project caps, and the present 8 GiB/2-domain defaults. |
| `src/store/transitions/baseline.ts`; `src/checks/requirement-index.ts`; migrations 0005/0010 | Index registration and baseline text helpers are not the entire proposed governed-spec pipeline. `confirmed_by` already exists; semantic criterion bodies need a defined representation. |
| `src/checks/scope.ts`; `src/checks/guide.ts` | Current evaluated workspace scopes and actual coverage inputs; guide restrictions needing a separate authoring package. |
| `src/api/server.ts` session route branch | Refused session routes are only a subset of D6's proposed routes. |
| D6 C.1 enumeration | 59 distinct scenario IDs. |

### Recorded observation

I inspected `docs/acceptance/reports/M3-real-lane/2026-10-09/state.json` and `docs/acceptance/reports/M4-real-lane/2026-10-12/state.json`. The M3 passing-path ledger entries carry the quoted Builder/Verifier/Reviewer/Builder timestamps at 11:55:04, 11:55:30, 11:55:58 and 11:56:18 UTC. The M4 report carries the quoted Verifier and Builder timestamps at 00:52:40 and 00:53:49 UTC. These are stored observations, not runs I repeated; ledger creation timestamps alone are not exact role execution durations. D6 §7's dollar and timing context must retain each report's attempt/endpoint qualification.

CH §3.5 supplies the historical fixture C/D figures and planning-cost comparison; CH §§5.1–5.2 and AH §5.5 describe workflow failures, including misleading “done,” missing human steps and planner thrash. I checked those records as historical evidence, not the predecessor runtimes. AH's benchmark discussion is §7; the requested §7.2 citation does not exist in that file.

### Implemented

The inspected source contains the current journal/finalizer, one-shot role, check, gate, envelope and deployment-request mechanisms cited above. That is evidence of implementation, **not a fresh assertion that all accepted lanes pass at this checkout**. I did not run the acceptance suite: parts use real containment and service-manager resources, which the brief expressly excludes.

### Open/reported

D6 draft 2 reports its new session qualification, phase planning/gating, semantic spec-change workflow, concurrency extensions and retrofit journey as design to build, not measured M5 operation (D6 status, §§10–11). Session cache savings, real-size stage throughput, role peaks at the proposed limits, the two real journeys' cost and owner time remain unestablished by the inspected records. Existing qualification does not automatically qualify the changed profiles or new turn protocol (D2 §§4.1, 7.2; D6 §2.6).

### Recommendation/inference

The interleavings and failure paths in section 2 are deductions from the declared contracts and inspected callers, not reproduced running exploits. Replacement text defines required observable behavior; the Verifier should pin exact schema, reason codes and transition details in the seam under E20. The proposed 4 GiB role, 2 GiB check and four-domain defaults are reasonable **trial defaults**, conditional on valid qualified profiles and recorded peaks; they are not a capacity measurement or promise that two useful real workloads fit. No external browser/API behavior was needed to judge this repo-local design.

## Questions for Sean

1. **A failed unchanged-code conformance:** accept B12's explicit blocked outcome, or authorize a separately specified repair-before-conformance path that amends E6. I recommend keeping the blocked outcome for M5. Do not approve reading 10 as an automatic scope escape; incorrect spec/check corrections already have governed routes. This is the only new policy question my objections expose.
2. **The decision sheet's remaining values:** I recommend N1's 4 GiB/2 GiB trial maxima and N2's cap of 4, subject to B09 and qualification, with no claim of zero operational cost. Recommend N4's 2,000-file threshold as a recommendation only; file count does not establish semantic size or scanning cost. These values remain yours.
3. **Retrofit real-run artifact (Decisions N3):** recommend the small M4-generated repository for the first authorized real journey, with the meaningful dependency/defect adversarial cases in the scripted fixture. Its small size establishes workflow, not large-repository retrofit quality. Choosing it does not authorize running it now.
