# D6: Astra's cross-review, the dispositions

**Status:** prepared by the D6 designer (no Builder, Verifier or Reviewer role), 2026-10-12, on branch `design/d6-3`, after Sean's decision to apply her section 2 (**E141** item 1: "approve with the amendments of her section 2 applied; D6 draft 3 applies them"). Source: `docs/reviews/D6/sdlc-review-D6-Astra.md` (her verdict: **approve with B01 to B14 applied**; non-blocking N01 to N04; notes on K1 to K11, the twelve readings and the test table; three questions). In D4's form (`sdlc-design-D4-astra-dispositions.md`), with one difference: Sean has already decided to apply her amendments, so each item below records **what was done and where**, not a choice for him. Every item is **accepted as written** and applied in D6 draft 3 (`sdlc-design-D6-idea-to-alpha.md`), in the M5 build spec and in the M5 acceptance plan; no narrower reading was needed. One question is Sean's (§Questions), and the design is complete without its answer.

**How to read the items.** Each names the problem in plain terms, where draft 3 applies the fix, and the Appendix C statements that pin it (an `(amended)` statement keeps its ID; a `(new)` one is added). None adds a backend, a host, a cloud cost or a dependency. The amendments with the most engine work are B01 (turn settlement and the idle generation), B02 (the prospective bundle and the publishing finalizer), B05 (the spec-evidence generation and check obligations), B06 (T1 phase nomination and phase-scope check execution), B09 (the as-built envelope accounting with recorded maxima) and B11 (the conformance lifecycle and source projection); each is bounded contract text plus acceptance cases, as she said.

---

## B01. A terminated turn is not necessarily a settled turn

**The problem.** Draft 2 made a session idle when the turn's domain had terminated, but collection, workspace materialization, the reply and the usage row might still be in flight; a save could snapshot incomplete content, a next turn could spend before the last was accounted, and budget exhaustion had no end protocol.

**Accepted.** §2.1 defines settlement (termination, collection and materialization terminal, reply or failure recorded, usage recorded with any unknown remainder) and the idle generation; §2.4 makes save, close and next-turn admission one compare-and-swap on that generation (`session_generation_stale`), revalidates grant, qualification and cumulative budget per turn, and closes budget exhaustion through the idle protocol; §2.3 makes `speaker` and `turn` engine-assigned only. A.3 (`idle_generation`, `usage_status`), A.5 (the turn's transitions), A.6. Statements: `D6-S10` (new), `D6-S01` to `D6-S07` amended.

## B02. Saved intent, approved baseline and registered plan need separate authority

**The problem.** Checkpoints committed on the integration branch and the finalizer registered plans from any commit, so unapproved intent could become schedulable and the first approval, which needs versions that do not exist yet, could deadlock.

**Accepted.** §2.4: a checkpoint is draft intent with no effect. §3.4: the approval binds one prospective bundle (approved spec and head, proposed blobs, versions to be allocated), checked before acceptance. §3.5: packages resolve approved bindings, never a newer checkpoint. §5.5: publication only by the authorized finalizer, once, re-comparing baseline and active generation (`plan_generation_stale`); `finalizeIntegration`'s present `registerPlan` call gains the authority check. §1 steps 4 and 9. A.3 (`phase_plans.generation`, `active`, `bundle`, `published_at`), A.5. Statements: `D6-A06` (new), `D6-S05`, `D6-A01`, `D6-A02`, `D6-P06` amended.

## B03. Automatic routing must be derived from artifacts, not the Architect's summary

**The problem.** Routing used `conformance: within_baseline` and the role's declarations; a replan could delete an ADR or change a module's sensitivity while declaring nothing.

**Accepted.** §5.4: routing computed from the diff of every architecture, module-map, ADR and roadmap artifact against the bundle, recorded on `plan_checks`; declarations add uncertainty only; automatic registration limited to an unchanged baseline and passing checks; baseline-changing proposals route with the complete diff; an unknown requirement is refused and offered the spec-change workflow. §5.3 clause 2: a rebased proposal is rechecked and rerouted. A.3 (`changes_architecture`, `changes_adrs`, `changes_roadmap`). Statements: `D6-P05` amended (lying declarations), `D6-P02` amended (harmless versus material head movement).

## B04. The declared parsers and plan coverage inputs cannot establish the claimed checks

**The problem.** The engine parsed the index (criterion IDs) but the body carries the text; three `validation` arrays unioned could hide a missing per-scope obligation; the "no planning with open questions" rule had no check.

**Accepted.** §3.2 and B.2: a semantic representation parsed from declared syntax (statements, criterion text, marks, question dependencies, modules, environments), `semantic_digest`, duplicates and contradictions refusing approval, reorder without value change neutral. §3.4: approval binds the semantics. §5.3 clause 1: `PLAN_QUESTION_OPEN`, no escape by omitting a phase hint; clause 4: planned obligations per stage and phase scope with effective tier, D3's coverage primitive on an explicit planned-obligation input, no fabricated definitions. A.3 (`spec_semantics`, `planned_obligations`), A.4, A.6. Statements: `D6-W05`, `D6-P07` (new); `D6-W01`, `D6-W02`, `D6-P04` amended.

## B05. Spec approval invalidates a list, but does not fence the evidence being produced

**The problem.** A requirement's statement could change with every criterion ID unchanged and leave its checks outside the list; an old-spec check still running could later pass and satisfy a current gate; the impact bound no dependency generations.

**Accepted.** §4.1: `spec_evidence_generation`. §4.2: one proposal pending at a time. §4.4: the impact binds both semantic digests and the dependency manifest (plans, requirements, checks, findings, results, work); a statement change affects its criteria and checks; textual and structural classes reported as such; conservative scope shown uncertain. §4.5: the generation advances at approval; `check_obligations` recorded; old-generation runs give history, never current acceptance; resolution by a protected correction or the Verifier's recorded applicability assessment plus fresh evidence; rediscovery clears nothing. §4.6 aligned. A.3, A.4 (`EVIDENCE_GENERATION_STALE`). Statements: `D6-C01`, `D6-C03`, `D6-C04`, `D6-C05` amended.

## B06. T1 phase completion is circular, and phase checks need execution registration

**The problem.** A T1 phase waited for every stage to be `verified` before nominating the candidate the stages are verified on; `phase`-only checks would not execute; the sign-off was required at every tier in one sentence and at T2/T3 in another.

**Accepted.** §5.8 rewritten: at T1 the completion of integrations and authoring obligations nominates, then the engine registers and executes stage and phase checks (phase-only checks and the regression set) on that candidate and evaluates the gates; at T2/T3 stage nominations stay and phase obligations are added on the current candidate; historical verification is not current regression evidence; the sign-off is T2/T3 only, bound to content, protected version, spec revision and plan generation; completion once per binding; ordinary T1 integrations claim no check execution. §1 step 8, §6.3, §7.4 aligned; K5 gives `SCOPE_KINDS` `phase`. Reading 8 restated. Statements: `D6-F01`, `D6-F02`, `D6-F03` amended; `D6-J01` gains the T1 no-nomination variant.

## B07. Authoring completion is not protected-check readiness

**The problem.** `check_authoring` behaving as `check_correction` released Builders when the Verifier's run completed, with the proposal possibly unapplied; deferred criteria named no prerequisite; `build_first` lacked F §5.1's review and gate visibility; additions were assumed tightening.

**Accepted.** §6.2: authoring readiness is the applied protected version or an effective exception, never the run's completion; deferred criteria recorded as obligations with reason, prerequisite and follow-up identity, eligible exactly once; `AUTHORING_INCOMPLETE` on phase and deployment gates until actual checks exist and pass; `build_first` with reason, independent review and gate-visible binding, waiving no coverage; classification always computed. §1 step 5. A.3 (`authoring_ready_at`), A.4. Statements: `D6-W06` (new), `D6-W04` amended.

## B08. Early replacement and integrated-stage dependencies need current generations

**The problem.** "Second plan refused" conflicted with replacement; dependencies were modelled three ways; a parked predecessor with a historical integration would release its dependants; "kept if unchanged by number, goal and implements" ignored tasks, validation, ADRs and dependencies.

**Accepted.** §6.4: two milestones, stage-code readiness (active generation integrated, not cancelled or parked) and authoring readiness; `dispatchBlocker`'s `complete` requirement replaced. §5.2 and §5.7: replacement as a compare-and-swap on the active plan generation, the one exemption from the second-plan refusal; completed identities kept, unbuilt obligations cancelled, only the remainder registered; a running stage retained only with every execution and acceptance input unchanged; delivery from the active obligation set; recovery registers once. §6.3, §6.6 aligned. A.3 (`stages.generation`, `execution_inputs_digest`, `parked_at`). Statements: `D6-X04`, `D6-F04`, `D6-P06`, `D6-D02` amended.

## B09. The proposed envelope is not the envelope as built

**The problem.** Draft 2's inequality compared maxima to `MemAvailable` alone, omitting the as-built add-back of the accounted domains' current memory; it removed the project run cap but not the engine-wide one, so the three-run example could not happen; shared check capacity was ambiguous across projects; smaller maxima change qualified profiles.

**Accepted.** §6.4 restates the as-built rule (`envelopeHold`) with the add-back, unreadable observations holding, maxima recorded at admission and never resized, shared capacity sized to the largest effective check maximum and reserved once with its slot, both run counts ceasing to cap, and the examples labelled as an idle eligible host. §2.6: profile bounds in the qualification identity. K2 and A.7 (engine `max_concurrent_runs` refused as a setting). Reading 12 corrected. Statements: `D6-X09` (new); `D6-X06`, `D6-X05`, `D6-X08`, `D6-S08` amended.

## B10. A role-controlled origin label is not human confirmation

**The problem.** Confirmation was raised from the role-written `Origin`, whose omission defaulted to `intended`, so a role could remove a requirement from confirmation; full mode allowed exclusions like scoped mode.

**Accepted.** §8.1 step 2: provenance engine-owned; every retrofit-produced requirement is reverse-engineered and unconfirmed until an explicit owner action or a binding to an approved owner-authored requirement; `Origin` is syntax and a claim (§8.2); confirmations bound to exact text and criteria; explicit mode rules, full mode blocking approval until each is confirmed or withdrawn with criteria, scoped mode leaving criterion-less ones visibly pending and refusing plans that touch their modules (`PLAN_DESCRIPTIVE_MODULE_TOUCHED`); the generic check applies them. §3.4, §8.3 aligned. Statements: `D6-R09` (new); `D6-R02`, `D6-R03`, `D6-R04`, `D6-R08` amended.

## B11. The conformance journey needs a source identity and a completion barrier of its own

**The problem.** `D6-R05` required the integration head at phase completion to equal the adoption commit, which bootstrap, spec, plan and protected commits make impossible; the conformance stage had no stage-build work for nomination and completion to hang on; it implemented confirmed defects; and the replan fired on the phase gate, where E6 requires Alpha and deployment verification first.

**Accepted.** §8.1 step 1: the immutable source revision A pinned by compare-and-swap before bootstrap (`adoption_branch_moved`). Step 3: the stage implements the approved conformance set only. Step 5: a durable conformance lifecycle (A.5) standing in for stage-build work; conformance as equality of the application-source projection to A, not HEAD; `CONFORMANCE_SOURCE_MOVED`. Step 6: the Alpha barrier before the change-phase replan (`CONFORMANCE_ALPHA_PENDING`), closed under `manual` until the owner deploys, and on failed, unknown or stale verification. §5.6, §8.3, §8.4, K11. Statements: `D6-R10` (new); `D6-R01`, `D6-R05`, `D6-F03`, `D6-J03` amended.

## B12. Moving a failed requirement does not verify its fix

**The problem.** Draft 2 read E6 as letting a conformance-phase `fix` move the failing requirement to the next phase so conformance could complete; the delivering stage still implements it, and the move would convert a failed required check into a pass (M235's invariant).

**Accepted, and reading 10 reversed.** §8.1 step 5 and §8.3: `fix` records the unresolved finding and the proposed remediation, verifies nothing, removes no obligation; a roadmap move changes neither verdict, delivered set nor gate; `accept` and `defer` under the ladder cannot override a failed required check; the governed ways out are a protected correction or a spec change with their invalidation; otherwise conformance stays blocked and visible. A known defect leaves the conformance set only by the owner's `defect` answer at confirmation, before the set is fixed (this is how the scripted journey's false README claim is handled). K11, §11 class B (the repair route not built), §12.3. Statements: `D6-R06` amended and reversed (`conformance-fix-blocks`), `D6-J03` amended. Her question 1 is the one question for Sean below.

## B13. Copying a test entry point does not necessarily protect its acceptance logic

**The problem.** A copied test could import its assertion helper or expectations from the Builder-owned tree; the original test's change would not disturb it, but the helper's would.

**Accepted.** §8.3: adoption identifies the acceptance logic, expectations, fixtures, helpers and runner configuration; they are copied with imports rewritten or replaced by independent protected logic; the proposal records the dependency boundary (`dependency_boundary`, B.7); an adopted check cannot delegate to the original suite; the engine refuses an import outside the protected root other than a declared `application` entry; no general analyzer claimed. Reading 11 qualified. Statements: `D6-R07` amended (the helper and expectations mutated after adoption), `D6-J03`, `D6-J04`.

## B14. Automatic Alpha must enter at the request, not the authorized-work trigger

**The problem.** Draft 2 had the policy raise the `deploy` trigger, a generic work registration, where `requestDeployment` is the layer that seals, derives and evaluates the authorization; idempotence after completion was unstated.

**Accepted.** §6.8: `on_phase_complete` creates an idempotent request through `requestDeployment`, keyed by project, phase-completion binding, candidate and environment configuration; the path seals, authorizes and only then creates deploy work; a gate or environment alone authorizes nothing; no second request for a completed key; a new key for a superseding candidate or configuration, revalidated under D4; no retry policy. §1 step 12, §9, K9. A.3 (`deployment_requests.request_key`). Statements: `D6-D01` amended.

---

## The non-blocking suggestions

- **N01 (pace as durable intervals; no unsupported performance claims). Accepted.** §2.2 ("cache absorbs most" withdrawn), §6.4 (no "no cost"), §7.1, §7.2 (invocation elapsed time; the two reports' timestamps labelled stored observations), §7.5 retitled, §7.6 (each figure's durable observation declared; eligibility and hold intervals as events; peaks read before removal; human wait as a union; restart gaps unknown; host observations recorded at start; benchmark bindings), §11 class B. A.3 (`work_items.held`, `host_observations`). Statements: `D6-M01`, `D6-M02`, `D6-X08` amended.
- **N02 (tick safety priority; chain cap described accurately). Accepted.** §6.5 (`max_chained_roles` bounds inherited depth, is not a budget; budgets separate), §7.2, §9, K1, K3. Statements: `D6-X07`, `D6-X03` amended; C.2 for M12, M15, M18, M71, M26, M33.
- **N03 (source claims and appendix accounting). Accepted.** Preamble corrected (`registerPlan` takes a phase; `replan` dispatchable; `confirmed_by` exists; open, turn, save and close are the refused routes, show and resume new; `configureEnvironment` a fixture-style operation; the index parser not the whole baseline); `D6-S08` no longer cites a run counter; Appendix C counted (59 in draft 2, 67 now); AH §7, not §7.2; §3.5 names the `baseline_texts` refresh. K4, K7, K10 rows corrected.
- **N04 (first-toolchain proposal against the actual Verifier contract). Accepted.** §6.2 and B.7: a distinct phase-authoring package and result schema with governed-change permissions, the protected-update route kept, "a proposal grants no execution authority" stated; cases on the generated package, a strict addition and a fingerprint-changing addition. Statements: `D6-W04`, `D6-W06`; row M442 verifies the package.

## Her notes on K1 to K11

All accepted into §12.1's table (each row now carries its B and N amendments) and into C.2, which lists every additional accepted row she named per correction, with the "M40-class" description corrected to M12's `max_chained_roles` case. K10 and K11 are accepted with her variants (B10; B11 and B12, the `fix` escape rejected).

## Her notes on the twelve readings

Applied in §12.2: reading 1 gains B04's phase-entry guard; reading 2 notes B02; reading 3 drops "Q2 asks Sean to confirm" (decided, E139); reading 4 notes B07's three conditions; reading 5 names the two approval bindings; reading 6 clears the reason only through an approved complete roadmap; reading 8's draft sequence is replaced by B06's; reading 9 enters at D4's request layer; **reading 10 is reversed** (B12); reading 11 is necessary not sufficient (B13); reading 12 corrects the as-built explanation (B09) and labels the maxima a numerical tradeoff.

## Her test table

Every row's strengthening is in the statement's `(amended)` text or in a new statement, as C.1 lists; her seven brief candidates and the additional obligations (cumulative budget exhaustion `D6-S02`/`S10`; save, turn and collection races `D6-S04`/`S10`; competing publications `D6-P06`/`A06`; unchanged criterion reorder `D6-C03`/`W01`; deferred authoring to readiness `D6-W06`; adoption pin movement `D6-R01`; pace across restart `D6-M01`; cancellation and recovery at turn and publication boundaries `D6-S07`/`A06`; old-spec late completion `D6-C05`; a phase-only check `D6-F01`; the conformance Alpha barrier `D6-R10`; auto-deploy replay after completion `D6-D01`) each have a named case in the M5 plan.

---

## Questions for Sean

1. **A repair-before-conformance route** (Astra's question 1; B12). Draft 3 builds the safe outcome: an adopted project whose unchanged code fails its confirmed baseline stays blocked, visibly, with the governed corrections (a protected correction of a wrong check, a spec change of a wrong confirmation) as the ways out, and a known defect excluded from the conformance set only by the owner's `defect` answer at confirmation. A route that lets a Builder repair source before conformance is established would amend E6. **Recommendation: do not add it in M5**; decide it, if ever, on the first real retrofit's evidence (`D6-J04`). Cost of the recommendation: a retrofit whose confirmations were wrong is corrected by a spec change, one more owner act, rather than by a build.

Her questions 2 (the numerics) and 3 (the retrofit artifact) are decided: E140 N1 to N4 and E141 item 3, as she recommended. Nothing else in the review is Sean's to decide.

## After this

1. D6 draft 3 is the text to approve (BS5 §9.1: the slice-31 gate is Sean's errata entry approving draft 3); no draft 4 (E20).
2. The M5 build spec and acceptance plan are updated to draft 3 in the same commit: 67 statements mapped, BS5 §16's questions marked decided (E141), seven rows added (M447 to M453), eight slices kept.
