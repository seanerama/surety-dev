# D1. Engine Core: Entities, Runtime Store, API, Scheduler, Events

**Status:** Draft 3 for cross-review by the second architect. Not approved. Draft 2 was rejected with eleven objections still open and one new blocker (`sdlc-review-D1-draft2-Astra.md`); every item is dispositioned in `sdlc-review-D1-dispositions.md` and applied here. Appendix A was written first and the body against it; `scripts/d1-consistency.mjs` checks the two in both directions and its clean run is recorded in the dispositions file. This draft stands alone; it does not refer the reader to earlier drafts for any requirement.
**Depends on:** Foundations v1.0 with errata E1–E19 (`sdlc-foundations-v1.1-errata-draft.md`), decisions O8–O11.
**Scope:** The engine's durable model and the mechanisms every other design document builds on. Appendix A is the authoritative enumeration of every persisted entity, field, enumeration, transition, event, reason code, error code, decision kind, and configuration key this document references. Where the body and Appendix A could disagree, Appendix A governs and the body is wrong.
**Out of scope:** D2 backend adapter contract, containment and control-plane isolation mechanism, trust table, session and quiescence qualification. D3 protected acceptance path, check runner, source-and-protected-assets materialization, diff classifier. Later: deployment adapters, export and promotion, Mechanic, adoption analysis, UI package.
**Conventions:** "MUST" is a requirement a test pins. "SHOULD" is a default policy may change. References in parentheses are to Foundations v1.0 (F), an errata entry (E), or an objection in Astra's reviews (B01–B17, N01–N05).

---

## 1. Process model

**1.1 One engine, many projects.** A single engine process per host (`surety serve`) owns: the runtime store, the scheduler, every process any run spawns, every git operation on every registered repository, every model invocation, and every external effect. The CLI (`surety`), the UI, and any automation are clients of the engine's local API and hold no state (O8).

**1.2 Loopback, single operator.** The API binds to `127.0.0.1` only. v1 serves one operator. The lease and fencing design makes crash recovery correct; it does not claim correctness for a second concurrent worker, which would need a distributed ownership design this document does not contain (B08).

**1.3 Single writer, one incarnation.** Each start writes `{incarnation_id, pid, started_at, host_boot_id}` into `engine.lock` **before** the store is opened, then persists the same record as an `engine_incarnations` row once the store is open (B17). A second `surety serve` refuses with `engine_locked`.

**1.4 Startup sequence** (B09). (1) Write the lock and incarnation. (2) Start the API listener in `restricted` mode (`EngineMode`): only `GET /v1/health` and `GET /v1/engine` answer; everything else returns `503 engine_starting` with the current step. (3) Open the store, run pending migrations in one transaction, persist the incarnation row. (4) Recovery (§16). (5) Repository integrity for every registered repository (§7.6). (6) Lift the listener to `full`, emitting `engine.mode_changed`. (7) Start the scheduler, emitting `engine.started`. A failure in steps 3–5 leaves the listener restricted with the failing step readable; the engine does not dispatch.

**1.5 Tick.** One tick every `tick_interval`; a tick requested through the API sets a flag the loop consumes and never runs scheduler logic in the requester's call. One tick at a time, bounded by `tick_budget` with per-step `tick_step_budget` (A.9).

**1.6 Engine home.** `$SURETY_HOME` holds `store.db`, `records/`, `workspaces/`, `backups/`, `engine.lock`, `api.token`, `engine.log`. Control-plane material (store, records, token, journal, logs) is never committed to any repository and is never readable by a role process (§17.12). `workspaces/` holds engine-owned worktrees of project source and is the one thing under the engine home that is committed, through the engine's git path (N02).

---

## 2. Identity

**2.1 Global ids.** Every entity has a 26-character time-ordered id with the type prefix in A.1.

**2.2 Human numbers.** Per project, candidates, runs, operations, decisions, findings, protected versions, proposals, and work items carry a sequence number (`seq`): `c-0421`, `r-1193`, `op-7731`, `d-88`, `F-212`, `pv-19`, `p-7`, `w-61`. Sequences never reuse a number; `seq_counters` on the project is the source.

**2.3 Revisions are git SHAs.** A revision is immutable. Nothing "moves" a revision; what changes is which revision a subject binds to (B12).

**2.4 Protected versions** (B01). `pv-N` is a sequence number plus the `fingerprint`: SHA-256 of the sorted `(path, blob id)` list over the governed protected set (§5.2). A `protected_versions` row is `authorized` only when written by `applyProtectedProposal` (§7.9) or project bootstrap (`ChangeKind` `initial`). The **effective protected version** for an evaluation is the authorized version whose `effective_from` precedes the evaluation and which has no `superseded_by`; never "any row whose fingerprint matches."

**2.5 Effects and attempts** (B07, B03). Every repository mutation and external effect is an `operations` row with one `idempotency_key`, `sha256(kind, target, subject, semantic_generation)`, independent of attempts; each execution is an `operation_attempts` row unique on `(operation, attempt_number)`. The operation is committed before its first attempt is issued. `OperationKind` values and their owners: `git_ref_update`, `git_commit`, `git_worktree` (§7.5, §7.3, §7.10); `publish`, `deploy`, `rollback`, `teardown` (§9.6 and the deployment-adapter design); `issue_file`, `issue_update` (the Mechanic design, reserved here); `notify` (§10.4). Deployment operations carry `deployment_generation`, incremented on every new attempt or target-set change.

**2.6 Invocations** (B11). Every model dispatch has one `invocation_receipts` id allocated by the scheduler before dispatch, idempotently per `(run, turn)`. Scheduler, invoke, process ownership, usage, and finalization reference that id; nothing else identifies a dispatch. `RunKind` is `one_shot` (one invocation per run) or `session` (one invocation per turn, §15.2).

**2.7 Execution domains** (B08). Every invocation runs inside an `execution_domains` row allocated **before** launch (`DomainStatus` `allocated`). The constructed child environment carries `SURETY_DOMAIN=<id>` and `SURETY_INVOCATION=<id>`; the child is spawned into a new process group, after which the domain is `launched`. Live processes of a domain are enumerated by process-group membership and by the environment marker (Linux: `/proc/*/environ`, qualified per OS in D2), never by parent pid. D2 containment may add a stronger identity (`containment_id`); the marker is the baseline. Domains end `terminated` (§4.5) or `quarantined` (§4.5 step 3).

---

## 3. Entity model

A.3 lists every field. This section states what each entity is for and the rules that bind it.

### 3.1 Project and baseline

- **projects.** `tier` (`Tier` T1, T2, T3 per F §5.7); `dev_repo_path`; `integration_branch`; `delivery_repo`; `baseline_state` (`BaselineState`: `idea`, `spec_ready`, `retired` per F §3.2 and E16a) with `prior_baseline_state` for reactivate; `registration_state` (`RegistrationState`: `pending_bootstrap` until `.surety/project.json` and the first journaled commit are confirmed, then `registered`, B17); `adoption` with `AdoptionMode` `full` or `scoped` (E6); `management` with `ManagementMode` `live` or `live_managed`, `ManagementHealth` `healthy`, `degraded`, or `unknown`, and `TriagePolicy` `manual` or `gated` (E5); `policy_revision`; `paused`. **Bootstrap** writes the project as `pending_bootstrap`, journals the commit creating `.surety/project.json`, and the finalizer (§7.10) sets `registered` and emits `project.registered`. `project.created` and `project.adopted` are emitted by the create and adopt transitions; adoption records the exact current commit of the selected integration branch, unpushed commits included (E18).
- **spec_revisions, architecture_revisions, modules, roadmap_revisions, phase_plans.** Pointers to committed content plus approval; their approval transitions emit `baseline.spec_approved`, `baseline.architecture_approved`, `baseline.roadmap_revised`, `baseline.plan_approved`, and `baseline.plan_refused` (F §3.10.6 mechanical plan check). Modules carry `sensitive_areas` for the floor (F §5.6) and gated triage (E5).
- **requirements.** Key, spec revision, assigned phase, `status` (`RequirementStatus`: `pending`, `verified`, `descriptive_unverified` per F §3.10.2 and E6). Delivery is not a field on the requirement; it is computed per candidate at scope time (§9.1) as `DeliveryStatus` `not_started`, `partial`, or `delivered`.
- **stages.** Phase plan, number, goal, modules, requirement ids, `implements` (requirement ids whose implementation obligation this stage carries), `status` (`StageStatus`: `planned`, `building`, `integrated`, `verified`), `integrated_revision`, work item.

### 3.2 Work, runs, sessions, process ownership

- **work_items** (B10). `kind` (`WorkItemKind`), subject refs, `status` (`WorkItemStatus`), blocker, `depends_on`, trigger identity `(trigger_source, trigger_id, trigger_generation)` unique per project, `trigger_consumed_at`, `repair_attempts`, `no_progress_count`, `progress_key`, `preflight_refusals`, `prior_status`, `dispatch_hold`. Legal transitions per kind are in A.5 only; §4 references that table and has no second one.
- **runs** (B08, B15). One role per run (`Role`: `vision`, `spec_writer`, `architect`, `builder`, `verifier`, `reviewer`, `release_operator`, `mechanic`, per F §4.1). `state` (`RunState`), `outcome` (`RunOutcome`), `reason_class` (`RunReasonClass`), `session_state` (`SessionState`, session kind only), backend, version, models, grant, workspace, `base_revision` (immutable original base), `deadline_at`, `parent_run`, `provider_session_id` (captured from the first turn), `quarantined`.
- **turns.** One per session turn, each with its own invocation, execution domain, and process ownership. One active turn per session.
- **execution_domains.** As §2.7.
- **process_ownership** (B08). Domain, invocation, incarnation, `pgid`, `pid`, `pid_start_time`, `containment_id`, `descendants`, `termination_confirmed_at`. Written with pid null before spawn and completed after spawn; a crash between the two leaves a domain `allocated` whose processes recovery finds by marker.
- **capability_grants, workspaces, leases.** Grants carry `capabilities`, `env_allowlist`, `secret_refs` (names only). Workspaces carry `base_revision` (original), `current_base` (advances on each checkpoint or save), `checkpoints`, `snapshot_tree`, `disposition` (`WorkspaceDisposition`: `active`, `retained`, `quarantined`, `discarded`). Leases carry `resource_kind` (`LeaseKind`: `run`, `integration`, `workspace`, `quarantine`), `resource_id`, `owner_incarnation`, `generation`, `expires_at`, `released_at`, `closing`, `cleanup_authority` (B08).

### 3.3 Revisions, candidates, protected path

- **revisions.** `sha`, lineage, `parent_sha`, `kind` (`RevisionKind`: `working`, `checkpoint`, `engine_commit`, `nominated`, `out_of_band`, `protected`, `intent`), `created_by_run`. Emitted as `revision.recorded`.
- **lineages.** `branch`, `started_from_candidate`, `open`. A lineage closes at nomination; the successor candidate links `started_from_candidate`; ancestry is the chain of those links (B02).
- **candidates.** Nominated revision, lineage, `nominated_by` (`NominatedBy`: `engine_cadence` at the F §5.6 cadence, `builder_request` at T1), spec and architecture revisions, `nominated_protected_version` (historical fact), `progress` (`CandidateProgress`), `superseded_by`. Events `candidate.nominated`, `candidate.advanced`, `candidate.superseded`.
- **protected_proposals** (B04). `proposed_by` (`ProposedBy`: `verifier_run` from §7.3, `human` from §11.4), base, `tree_id`, `diff_hash`, `affected_checks`, `rationale` record, requested and classified `ChangeKind` (`initial`, `tightening`, `loosening`, `unclassifiable`), `status` (`ProposalStatus`: `captured`, `classified`, `awaiting_human`, `approved`, `applied`, `rejected`), approver and `Authority` (`role`, `reviewer`, `human`), `resulting_version`. Events `protected.proposed`, `protected.classified`, `protected.approved`, `protected.rejected`, `protected.applied`.
- **protected_versions.** `fingerprint`, `check_ids`, `change_kind`, proposal, approver, `applied_by_operation`, `authorized`, `effective_from`, `superseded_by`. A repository fingerprint matching no authorized row emits `protected.unauthorized_detected`.
- **checks.** `key`, protected version, `kind` (`CheckKind`), `required`, `gate_kinds` it applies to, `tier_floor`, definition path and hash, requirement ids, sensitive areas, phase. `CheckKind` ownership: `acceptance`, `smoke` (T1 and above), `integration`, `security_lint` (T2 and above), `property`, `failure_recovery` (T3) per F §5.7; `sensitivity_floor` per F §5.6; `post_deploy_identity` and `post_deploy_behavior` for completion gates (§9.6).
- **check_results** (B01). Bindings: check, candidate, `source_revision`, protected version, `runner_class` (`RunnerClass`: `direct`, `container`, `remote`, per F §10 gate runners), `runner_id`, environment, `artifact_digest`; `execution_seq` (monotonic per project, assigned by the runner registration transaction); `execution_established`, `signaled`, `deadline_hit`, `exit_status`; `output` record. State (`CheckState`) is derived at evaluation (§9.2) and stored on the evaluation. Emitted as `check.result`.

### 3.4 Scope, gates, authorizations, findings, sign-offs, decisions

- **acceptance_scopes** (B01, B03). Candidate, `gate_kind`, `operation` and `attempt` (completion gates only), phase or stage, spec, architecture, policy, `effective_protected_version`, `source_revision`, `delivered_requirement_ids`, `partial_requirement_ids`, `sensitivity_categories`, `required_check_ids`, `runner_classes` per check, `required_signoffs`, environment, artifact digest, `evidence_reuse` entries (a check result plus its F §3.8 applicability record), `validated`, `scope_hash`, and `acceptance_content_hash` = hash(source revision, protected fingerprint, delivered requirement ids, required check ids, sensitivity categories), which excludes gate kind, environment, and operation so that one review sign-off serves authorization and completion. Emitted as `gate.scope_built`.
- **gate_evaluations.** Scope, `gate_kind` (`GateKind`: `stage`, `phase`, `alpha_authorize`, `alpha_complete`, `beta_authorize`, `beta_complete`, `live_authorize`, `live_complete`), inputs snapshot and hash, `check_states`, `outcome` (`EvalOutcome`: `satisfied`, `not_satisfied`), `reasons` (A.4), `satisfiers`, `stale`. Emitted as `gate.evaluated`.
- **deployment_authorizations** (B03). Created by a satisfied `*_authorize` evaluation: candidate, environment, `artifact_digest`, `source_delivery_mapping`, `config_identity`, `target_set`, policy revision, protected version, evaluation, `status` (`AuthorizationStatus`: `issued`, `consumed` when a deploy operation references it, `superseded` when a later authorization for the same candidate and environment is issued). Events `authorization.issued`, `authorization.consumed`, `authorization.superseded`.
- **deployment_verifications** (B03). Operation, attempt, `deployment_generation`, environment, target set, artifact digest, mapping, configuration identity, protected version, `identity_reads`, `behavioral_results`, `outcome` (`DeployVerificationOutcome`: `verified`, `unknown`, `failed`), `invalidated_at`. A new attempt or target-set change invalidates prior verifications for that operation. Emitted as `environment.verified`.
- **findings** (B02). `scope` (`FindingScope`: `project`, `lineage`, `candidate`), subject, candidate, `source_run` (nullable for engine-origin findings such as §14.2), `category` (`FindingCategory`: `defect`, `requirement_conflict`, `contract_conflict`, `security`, `hygiene`), `proposed_severity` and `effective_severity` (`Severity`: `critical`, `high`, `medium`, `low` per F §6.3) with `severity_history`, `sensitive_area`, `status` (`FindingStatus`: `open`, `dispositioned`, `resolved`), `disposition` (`Disposition`: `fix`, `defer`, `accept` per F §6.2) with `disposition_authority`, `linked_issue`, `defer_target`, `reevaluations` (per evaluation id, not per gate kind), `alpha_exception` evidence, `resolution_verification`. Events `finding.raised`, `finding.severity_changed`, `finding.dispositioned`, `finding.resolved`, `finding.reopened`.
- **applicability_assessments** (B02, E19). Finding, candidate, `proposed_by_run` (Verifier), `assessed_by_run` (independent Reviewer), `authorized_by` (human; required when the exclusion would remove a finding that blocks any gate kind for the candidate), `evidence` record, `reason`, `status` (`AssessmentStatus`: `proposed`, `assessed`, `approved`, `rejected`). Only an `approved` assessment excludes a finding from a candidate. Events `assessment.proposed`, `assessment.assessed`, `assessment.approved`, `assessment.rejected`.
- **signoffs.** Candidate, revision, role, `scope` (`SignOffScope`: `candidate`, `module`), run, `acceptance_content_hash`. An input, not a decision. Emitted as `signoff.recorded`.
- **decisions** (B12). Identity `(project, kind, subject_type, subject_id, semantic_generation, scope)`; `kind` (`DecisionKind`, one row each in A.8); question; `options` each with an effect plan and `plan_hash`; `dependency_manifest` instance (A.8 per kind); `transition_schema_version`; `preview_hash` over the identity, the option set, each plan hash, the schema version, and every manifest value including semantic deadlines; `evidence` with `Provenance` (`observed` engine-read, `claimed` agent-produced, `configured` policy echo); `blocked_while_open`; `raised_at`, `target_seconds`, `escalated_at`, `batch_key`; `status` (`DecisionStatus`: `open`, `answered`, `consumed`, `invalidated`); `answer`; `invalidated_reason`. Events `decision.raised`, `decision.escalated`, `decision.answered`, `decision.consumed`, `decision.invalidated`.
- **approvals.** Decision, actor, consequence text, `subject_type` and `subject_id` (baseline version, candidate acceptance content hash, or deployment authorization, A.8), `acceptance_content_hash` where applicable, `result_hash`, policy revision, `protected_delta_shown`, `consumed_at`.
- **effect_intents** (B12). Recorded at consumption: decision, approval, operation, `preconditions` (manifest values at consumption), `status` (`IntentStatus`: `pending`, `executing`, `done`, `invalidated`), `invalidated_reason`. Events `intent.recorded`, `intent.executing`, `intent.done`, `intent.invalidated`.

### 3.5 Operations, journal, checkouts, environments, releases

- **operations, operation_attempts** (B07, B03). As §2.5; `status` (`OperationStatus`) derived per A.5; `remaining_scope`; `linked_prior`; `authorization` (deploy only); `deadline_at`; `finalized_at` (the domain finalizer ran). Attempt `status` (`AttemptStatus`). Events `operation.intended`, `operation.attempt_started`, `operation.succeeded`, `operation.failed`, `operation.partial`, `operation.ambiguous`, `operation.reconciled`, `operation.finalized`.
- **git_journal_events, git_journal_state** (B05, B17). Events are immutable facts `(operation, seq, journal_kind, event_kind, payload)`; state is a mutable projection updated only in the same transaction as a new event. `JournalKind`: `ref_update`, `commit_tree`, `worktree_add`, `worktree_remove`. `JournalEventKind` and `JournalState`: `intended`, `applied`, `confirmed`, `failed`, `ambiguous`, `finalized`. Each journal kind declares its effect probe and domain finalizer (§7.10). Events `git.journal_intended`, `git.journal_applied`, `git.journal_confirmed`, `git.journal_ambiguous`, `git.journal_finalized`.
- **ref_registry, managed_checkouts** (B05). Registered refs with `kind` (`RefKind`: `integration`, `lineage`, `nomination`, `recovery`, `oob`, `keep`), `expected_oid`, `immutable`. Managed checkouts with `kind` (`CheckoutKind`: `integration_worktree`, `run_workspace`), `baseline` `{head, index_hash, tracked_tree_hash}`, `owner_run`.
- **notification_intents** (B07). Source, `channel` (`Channel`: `in_app`, `email`, `webex`, `webhook` per F §8 and O4), unique `key`, `status` (`NotificationStatus`: `queued` on creation, `sending` while an attempt is in flight, `delivered`, `failed`, `unknown` when delivery cannot be established), `attempts`. Events `notification.queued`, `notification.sending`, `notification.delivered`, `notification.failed`, `notification.unknown`.
- **environments, environment_records, observation_history, observation_jobs** (B13, B17). The current observation on the record carries `condition` (`ObservedCondition`: `healthy`, `degraded`, `down`, `unknown`), `observed_at`, source, `freshness` (`Freshness`: `fresh`, `stale` past half the bound, `expired` past the bound), `expires_at`; every observation is appended to `observation_history`. Events `environment.observed`, `environment.observation_missed`, `environment.attempt`.
- **releases.** Version, candidate, `delivery_commit`, `artifact_digest`, `source_artifact_mapping`, `config_identity`, promotion record (reserved), `allowlist_version`, `states` with the four separate facts (`ReleaseStateFact`: `prepared`, `published`, `staged`, `live`), `recovery_plan` record. Events `release.prepared`, `release.published`, `release.staged`, `release.live`.

### 3.6 Invocation, ledger, policy, records, events

- **invocation_receipts** (B11). Immutable intent: run, turn, provider, requested model, grant, `budget_snapshot`. Emitted as `invocation.receipt`. Status evolves only through **invocation_status_observations** (`InvocationStatus`: `dispatch_started`, `refused`, `launched`, `ended`, `unknown`), emitted as `invocation.status`.
- **usage_observations, ledger_rows** (B11). Observations carry `semantics` (`UsageSemantics`: `cumulative` or `delta`, declared per adapter) and are emitted as `invocation.usage`. One original terminal ledger row per invocation (`UNIQUE(invocation) WHERE corrects IS NULL`); corrections are delta rows with `(invocation, correction_seq)` unique; totals apply each exactly once. Token fields nullable; null means unknown. `cost_status` (`CostStatus`): `reported`, `estimated` (from a price table whose version is recorded in `normalization_version`), `unknown`, `measured_zero` (a dispatched invocation that reported zero). Events `ledger.row`, `ledger.correction`.
- **policy_revisions.** Pointer to the committed policy blob, `diff_summary`, `widens_authority`, `committed`, confirming decision. Emitted as `policy.changed`.
- **records, stream_chunk_receipts** (B06, N05). `kind` (`RecordKind`: `transcript`, `tool_output`, `check_output`, `result`, `raw_user_report`, `parked_result`, `proposal_rationale`, `assessment_evidence`, `containment_evidence`, `recovery_plan`), `path` (null after expiry), `sha256`, `bytes`, `redaction_version`, `published`, `post_scan` (`PostScan`: `pending` until the scan runs, `clean`, `hit`), `post_scan_finding`, `retain_until`. Chunk receipts carry `offset`, `length`, `sha256` per published chunk. Events `record.written`, `record.expired`, `record.secret_found`, `record.missing`.
- **out_of_band_changes** (B05). `subject_kind` (`IntegritySubject`: `ref`, `checkout`, `repository`), ref or checkout, expected, found, `disposition` (`OobDisposition`: `discard`, `adopt`, `stash`), decision. Events `repo.out_of_band`, `repo.reconciled`.
- **events.** Monotonic `seq`, `type` (`EventType`, A.6), subject refs, `actor_kind` (`ActorKind`: `engine`, `human`, `run`), `actor_id`, `request_id`, operation, payload, `tx`. Append-only.
- **config.** Engine and per-project keys with declared defaults and ranges (A.9).

### 3.7 Deferred entities

`mechanic_issues`, `triage_dispositions`, `product_intent_contracts`, `adoption_analyses`, `export_records`, `promotion_records` are reserved in A.1 with no fields and no operational authority until their owning document exists (B17). `export_records` and `promotion_records` are referenced by §9.6 only as the rows a later design will populate.

---

## 4. State machines

**A.5 is the only transition table.** This section explains the rules those tables encode; it adds no transitions.

**4.1 Run.** created → claimed → executing → validating → (finalizing | proposal_captured → finalizing) → ended, with `run.created`, `run.claimed`, `run.started`, `run.validating`, `run.proposal_captured`, `run.finalizing`, `run.ended` emitted at each step and `run.heartbeat` on each lease renewal. `outcome` is set exactly once, on entering finalizing: the successful validation path sets `completed`; proposal capture sets `completed`; failed validation (`reason_class` `diff_violation`, `ref_violation`, `invalid_result`), an adapter infrastructure error (`infra_error`), or integration conflict (`integration_conflict`) sets `failed`; preflight refusal (`preflight_refused`) sets `refused`; deadline sets `timed_out` (`deadline`); Stop sets `stopped` (`human_stop`); Abandon sets `abandoned` (`human_abandon`); recovery sets `recovered` (`recovered`); budget exhaustion at an enforceable boundary sets `stopped` (`budget`); a run with no failure records `none`. **Every** path into ended goes through `endRun` (§4.5), including preflight refusal after a lease or grant was issued (B08). A run whose domain termination cannot be established stays in finalizing with `quarantined = true` and emits `run.quarantined`; it never reaches ended until termination is established or the operator resolves the quarantine.

**4.2 Session.** Within executing, `session_state` moves `allocated` (emitting `session.allocated`) → `turn_running` (first turn, which creates the provider session and captures its id; `session.turn_started`) → `open_idle` (`session.turn_ended`) ⇄ `turn_running`; `open_idle` → `saving` → `open_idle` (`session.saved`); `open_idle` or `saving` → `closing` → run finalizing (`session.closed`). Each turn is its own invocation with its own execution domain; an idle session owns no process and is represented explicitly (B15).

**4.3 WorkItem** (B10). Per-kind tables in A.5, with `work.created`, `work.claimed`, `work.advanced`, `work.integrated`, `work.complete`, `work.held`, `work.resumed`, `work.parked`, `work.cancelled` emitted by the corresponding transitions. Rules they encode: an operation-backed kind completes only when its operation is `succeeded`; `conformance` completes only when `alpha_complete` is satisfied for the adopted baseline (E6); Stop from any status that owns a run moves the item to `held` once cleanup is established, and `held` leaves only by explicit Resume; Abandon restores `prior_status` with `dispatch_hold = true`, cleared only by explicit Resume or a new trigger generation; every automatic re-dispatch after a failed outcome increments `repair_attempts` atomically and parks at `repair_attempts_max`; `preflight_refusals` parks at `preflight_refusals_max`; the progress key is hash(snapshot tree, sorted set of (category, check key, normalized finding message hash)), excluding timestamps and finding ids, and an unchanged key increments `no_progress_count`, parking at `no_progress_max`; a finding of category `requirement_conflict` or `contract_conflict` routes to objection or baseline review instead of another repair; duplicate terminal callbacks are idempotent on invocation id.

**4.4 Candidate, operation, decision, finding, proposal, assessment, journal, domain, authorization.** Tables in A.5. Operation status derives from its latest attempt per A.5; an operation is `superseded` only when a linked successor operation is recorded (`linked_prior`). A finding whose resolution evidence is invalidated returns to `open` (B02).

**4.5 Run end protocol** (B08). `endRun(run)` is idempotent and is the only path from finalizing to ended:

1. Mark the run lease `closing`; the store rejects further role effects and late success callbacks for that generation; cleanup transitions carrying `cleanup_authority` remain allowed to append usage, reconcile issued effects, and finalize disposition.
2. Establish domain termination: enumerate live processes of the run's execution domains by process group and marker (§2.7); send TERM, wait `terminate_grace`, send KILL, wait `kill_grace`; D2 containment, where present, must confirm termination and capability expiry. **Parent exit never establishes termination, including on normal completion.** On success each domain becomes `terminated` and `termination_confirmed_at` is set (`domain.terminated`).
3. If any live process remains: the run stays finalizing with `quarantined = true`, every unterminated domain becomes `quarantined` (`domain.quarantined`), the workspace becomes `quarantined`, the run lease is converted to a `quarantine` reservation (not an execution lease), a `blocker` decision names the processes, and `engine.quarantine` is emitted. Nothing is released or discarded.
4. Reconcile issued effects: any attempt the run issued that is `started` becomes `ambiguous` and is reconciled (§16); unresolvable ones block their dependent resources.
5. Finalize usage: append the terminal invocation status observation (`ended`, or `unknown` when it cannot be established) and derive the ledger row for each of the run's invocations that lacks one; a launch that never occurred records `refused` and no row; a launch whose usage cannot be established records a row with nulls and `usage_complete = false`.
6. Dispose the workspace: `retained` for completed, failed, timed_out, stopped, recovered; `discarded` for abandoned.
7. Revoke the grant, release the lease, set state ended, emit `run.ended`. One transaction.

**4.6 Decision** (B12). open → answered → consumed in one transaction with the recording of effect intents; open → invalidated when any value in its dependency manifest changes or a time-based condition expires; invalidation raises the next semantic generation if the question still applies.

---

## 5. What lives where

**5.1 In the project's git repository** (F §7.1): source; `.surety/spec/`, `.surety/adrs/`, `.surety/architecture/`, `.surety/roadmap/`, `.surety/phases/`, `.surety/checks/`, `.surety/policy.json`, `.surety/project.json`. The engine commits every one of these (E2).

**5.2 The governed protected set** (B04). The protected set is every file under the protected roots (`protected_paths`, default `[".surety/checks/"]`) **and** the governed fields of `.surety/policy.json`: `protected_paths`, `check_commands`, `check_discovery`, `runner_config`, `result_collection`, `required_checks`. The fingerprint (§2.4) covers both. Any change to the governed set, by any author and in any file, is a protected change and follows §7.9; generic policy confirmation never substitutes.

**5.3 In the runtime store** (§6): everything in §3. **5.4 In `records/`** (§14). **5.5 Nowhere:** secret values. The pattern registry and secret resolver are engine-internal services used by invocation and redaction (N05); values never become durable output.

---

## 6. Runtime store

**6.1 Engine and durability** (B06, B09). SQLite, WAL mode, `synchronous=FULL`, foreign keys on. Driver `better-sqlite3`, pinned, the engine package's only runtime dependency (O9), behind one store interface so Node's built-in module can replace it later. The connection is owned by a store worker (`worker_thread`) with a bounded command queue; the request path and the scheduler submit short transactions and never hold one across a git call, an adapter call, or a stream write. The worker is the default placement; a main-thread placement is eligible only under the expanded qualification in D1-20 and only within its declared operating limits (N03, Q1). The qualified storage must honor fsync; an engine home on a filesystem that does not is refused at startup.

**6.2 Constraints.** Uniqueness: `(project, seq)` per sequenced entity; `idempotency_key` on operations; `(operation, attempt_number)`; `(project, trigger_source, trigger_id, trigger_generation)`; `(project, kind, subject_type, subject_id, semantic_generation, scope)` on decisions across all statuses; `(project, branch) WHERE open` on lineages; `(resource_kind, resource_id) WHERE released_at IS NULL` on leases; `ledger_rows(invocation) WHERE corrects IS NULL`; `(invocation, correction_seq)` on correction rows; `(run, turn)` on invocation receipts; `(operation, seq)` on journal events. Append-only at the database level (triggers refuse UPDATE and DELETE): `ledger_rows`, `usage_observations`, `invocation_receipts`, `invocation_status_observations`, `git_journal_events`, `stream_chunk_receipts`, `observation_history`, `events`.

**6.3 Transitions are functions.** No code outside `engine/store/transitions/` writes to the store. Each transition takes current rows and an intent, checks A.5, performs its writes and appends its event rows in one transaction, and returns the new rows. A transition that produces an effect records the operation and journal intent in its transaction; the effect runs after commit; a second transition records the outcome and runs the domain finalizer (§7.10). External reads that precede a transition carry source identity, generation, and observed-at into it (B12).

**6.4 Migrations.** Numbered SQL files applied in order in one transaction at startup; the applied list is a table; a failing migration stops startup in restricted mode with the file named. Downgrade is unsupported; backups are the rollback.

**6.5 Backup and export** (B06). `surety store backup` writes a consistent snapshot through the online backup API **plus** every record the snapshot references **plus** a manifest of referenced git objects and hashes; referenced commits are pinned against garbage collection by `surety/keep/<n>` refs in the registry. A database-only copy is labeled `incomplete_for_recovery`. Restore verifies every reference before the engine leaves restricted mode. The scheduler runs a backup daily (`engine.backup`) and keeps `backup_keep` copies. `surety store export` writes JSONL plus the same closure; `import` requires explicit repository and secret-reference rebinding without copying values.

**6.6 Fail closed.** Any store error during a budget check, gate computation, lease operation, decision consumption, or journal write fails that operation with `store_error`. There is no fallback to a cached or file value.

---

## 7. Git operations

**7.1 The engine performs git** (E2). Every git command is spawned asynchronously with an argument array, never a shell string; arguments that could be option-shaped are validated or placed after `--` (B14). The child environment is constructed, stripping `GIT_*`, `GH_*`, and editor variables (A16), with explicit `--git-dir` and `--work-tree` from the execution context. Output is bounded. Every invocation has a deadline (default 60 s; clone and fetch 600 s); on expiry the child is killed and the operation is marked `ambiguous` if it could have written. An unreadable repository is `repo_unreadable`.

**7.2 Execution context and registries** (B05). One resolved object per run and per engine git or adapter call, named in every audit record: `{project, repo_root, git_dir, worktree_path, branch, base_sha, delivery_substrate, credential_scope, child_env, registry_snapshot, checkout_baselines}`. Resolution validates the paths, that `.surety/project.json` matches the project, and that every registered ref currently has its expected oid; a mismatch is an integrity observation (§7.6), not a new expected value. **Registered refs** (`RefKind`): the `integration` branch; `lineage` refs; immutable `nomination` refs `surety/cand/<seq>` (E18); `recovery` refs; `oob` refs `surety/oob/<n>`; `keep` refs `surety/keep/<n>`. **Managed checkouts** (`CheckoutKind`): the `integration_worktree` (the developer's checkout of the integration branch, if any) and every `run_workspace`. Developer branches outside the registry are never gate inputs, never reset, never adopted.

**7.3 Workspace lifecycle and snapshot** (B04). `git worktree add --detach <ws> <current_base>` (journaled as `worktree_add`, operation kind `git_worktree`); the protected set is materialized read-only where D2 supports it. **Snapshot admission** requires that the run's execution domains have zero live processes (§2.7) and that the engine holds the `workspace` lease; for a one-shot run that is after confirmed termination; for a session that is `open_idle`, which by construction owns no process. Live checkpoints while a process may write are refused in v1 (Q2). The snapshot is `git add -A` into a temporary index and `git write-tree`, recording `snapshot_tree`; validation and commit use that tree id. Validation against `current_base`:

1. **Role prohibitions** (F §4.1): any prohibited path rejects the run whole (`diff_violation`).
2. **Protected set** (B04): the diff is partitioned by the governed execution path in §5.2 into protected, source, and other-intent changes. For every role except the Verifier, any protected change rejects. For the Verifier, a diff consisting of **exactly** protected changes is captured as a `protected_proposals` row with `proposed_by = verifier_run` and the run enters `proposal_captured`; protected plus any other change rejects whole.
3. **Containment**: no symlink resolving outside; no `..`; nothing under `.git`; no change to `.surety/project.json`; worktree HEAD detached at `current_base`; index and metadata unchanged except by the engine's snapshot.
4. **Refs and checkouts**: the registry snapshot and checkout baselines must equal their post-run state, reconciled against the journal for the engine's own concurrent writes; any registered ref or managed checkout the role altered rejects (`ref_violation`).
5. **Size and kind caps** per policy.

On pass, `git commit-tree` with parent `current_base` (journaled as `commit_tree`, operation kind `git_commit`), verify parent and tree, record the revision as `engine_commit`, journal the integration (§7.5). The ordinary commit path is unreachable from `proposal_captured`.

**7.4 Checkpoints and commit messages.** A role's structured result may request `checkpoint: true`; the final snapshot is then committed as a `checkpoint` revision on the lineage, `current_base` advances, and the work item continues with a new run from that checkpoint. Session saves (§15.2) are checkpoints taken at `open_idle`. After every checkpoint the engine records the workspace's new `current_base`, and later validation compares against it while the run's original `base_revision` is preserved (B15). First line: `w-61 stage 6: export service and CSV endpoint`; trailers `Surety-Run`, `Surety-Role`, `Surety-Base`, `Surety-WorkItem`, `Surety-Kind`.

**7.5 Integration through the journal** (B05). Serial per project through M3 (E18). Under the `integration` lease: journal event `intended` for `{ref, old_oid, new_oid}` with the `git_ref_update` operation in one transaction; `git update-ref <ref> <new> <old>` (compare-and-swap); journal event `applied`; probe and `confirmed`; domain finalizer (§7.10) and `finalized`. If the base is behind HEAD, the engine rebases in a scratch worktree, re-runs §7.3 validation on the rebased tree, and journals that commit instead. A CAS failure is `integration_conflict`: the run ends failed and the item parks; no agent resolves it.

**7.6 Repository integrity** (B05). After journal recovery (§7.10), for every project: read each registered ref's oid; for each managed checkout, read HEAD, index hash, and the tracked-tree hash (`git diff-index` against HEAD, staged and unstaged). A `run_workspace` owned by an active run is evaluated by its snapshot validator, never classified here. Observations with a typed subject (`IntegritySubject`): **ref** (oid matches neither expected nor a journaled new oid; or deleted), **checkout** (integration worktree dirty or on an unexpected HEAD), **repository** (unreadable). Each produces an `out_of_band_changes` row and emits `repo.out_of_band`, with the `OobDisposition` options legal for its subject: ref → `discard` (journaled CAS reset, stray commits kept on `surety/oob/<n>`) or `adopt` (record the stray commits as `out_of_band` revisions, invalidate every evaluation and result on the lineage, open a new lineage); checkout → `stash` (engine commits the dirty tree to `surety/oob/<n>` and restores the baseline) or `adopt`; repository → none, blocked until readable. All block affected gates; none advances an expected value. Consumption emits `repo.reconciled`.

**7.7 Nomination** (E11). Journaled: the candidate row, the immutable `nomination` ref, the lineage close and reopen, all written by the finalizer after the ref write is confirmed. A Builder's nomination request at T1 is a structured result field; the engine performs it.

**7.8 Intent artifacts.** Role outputs under `.surety/...` are committed through §7.3 and §7.5 as `intent` revisions; the integration finalizer registers stages and work items from a plan atomically, so a committed plan is schedulable by construction (incident 11).

**7.9 Applying a protected proposal** (B04, E13). The only writer of an authorized version. Proposals come from a Verifier run (§7.3 step 2) or from a human policy edit to a governed field (§11.4), which the engine turns into a proposal with `proposed_by = human`, classified by D3 into `tightening`, `loosening`, or `unclassifiable`. Authority: tightening → Reviewer run or human; loosening or unclassifiable → human through `check_correction_loosening` or `check_correction_unclassifiable`; a change to `required_checks` also follows the validation-scope route (F §3.3). Application: one transaction records the authorization, the intended version with `authorized = false`, the journal intent, and the operation; the commit applies through §7.5 as a `protected` revision; the finalizer sets `authorized = true` and `effective_from`, supersedes the prior version, invalidates dependent evaluations and results, and emits `protected.applied`. The next nomination is a new candidate.

**7.10 Journal recovery and domain finalizers** (B05). Each `JournalKind` declares a probe and a finalizer. Probes: `ref_update` reads the ref; `commit_tree` checks the object exists and is reachable from a `keep` ref; `worktree_add` and `worktree_remove` check the worktree list and metadata. On restart and at every tick before integrity or dispatch: every operation whose journal state is not `confirmed`, `finalized`, or `failed` is probed; `applied` and matching → `confirmed`; old value present → one controlled retry as a new attempt; otherwise `ambiguous` with a `blocker`. **A confirmed probe is not completion.** Completion is the finalizer, keyed on operation id and idempotent, which writes the domain receipts the operation exists for: registry expectation, work item `integrated`, stage status, candidate and lineage rows, protected version authorization and invalidations, plan registration, project `registered`. The same finalizer runs after ordinary execution and after recovery; the journal state becomes `finalized` and `finalized_at` is set only when it has run.

---

## 8. Scheduler and leases

**8.1 Tick** (B09, B13, B08). Each step has `tick_step_budget`; the tick has `tick_budget`. Steps 1–4 are **safety prerequisites**: if any overruns or fails for a project, that project's dispatch and integration are ineligible for this tick while decisions, recovery, and other projects continue.

1. **Recover:** leases past `expires_at` are reconciled by establishing domain liveness (§2.7) even when the owning engine is alive; dead domains → §4.5.
2. **Journal and effects:** §7.10; then every operation `in_progress` past its attempt deadline or `ambiguous` → adapter reconciliation. No retry here.
3. **Repository integrity:** §7.6.
4. **Budgets:** per-project day and unknown-token bounds computed from observations (§13.3).
5. **Observe environments:** every `observation_jobs` row past `next_due` (its `cadence_s` defaults from `observation_cadence`) → one bounded adapter read; write the current observation with `observed_at`, source, and `expires_at` from `observation_freshness_bound`; append to history; a failed or absent read past the bound sets `unknown` and emits `environment.observation_missed`.
6. **Decisions:** age; escalate past `target_seconds` (`decision.escalated` plus a `notification_intents` row); invalidate on changed manifest values or expired conditions.
7. **Gates:** recompute stale evaluations.
8. **Select:** for each eligible project, in priority verification due → builds → replans → other, oldest first; skip items with unmet `depends_on`, any open decision in their `blocked_while_open` set, `dispatch_hold`, status `held`, a failed budget check, or a chaining boundary reached under `max_chained_roles` (D1-34).
9. **Dispatch:** up to `max_concurrent_runs` (engine and per-project): allocate the invocation id and execution domain, write ownership with pid null, create run, lease, grant, receipt, execution context, then launch asynchronously and return; the tick never waits for a model run.
10. **Heartbeat:** `engine.tick`.

**8.2 Triggers** (B10). Create-or-return across every non-terminal status; re-observation of a consumed trigger in a terminal item creates nothing and raises no error (A11).

**8.3 Leases and fencing** (B08). Every transition or adapter callback on behalf of a run presents `(run, generation)`; the store accepts it only if the generation is **equal** to the current one, the lease is unexpired and unreleased, the grant is live, and the run state permits the write. `closing` rejects role effects and late success callbacks; transitions with `cleanup_authority` remain allowed. `quarantine` reservations are a distinct resource kind and are never reusable execution authority. Renewal on every adapter heartbeat and at least every `lease_ttl/3`.

**8.4 Pause, Stop, Abandon, Resume** (E7, B10). Project `paused` makes step 8 skip the project (`project.paused`, `project.resumed`). Stop and Abandon act on one run through §4.5 and are admitted at any time, including mid-tick. Stop leaves the work item `held`; Resume is explicit and creates a new run (§15.3). Abandon returns the item to `prior_status` with `dispatch_hold` only after confirmed termination.

**8.5 Deadlines** (B09). Every run, adapter call, git call, tick step, and recovery loop carries a deadline. A deadline on owned work **cancels** it: the child is killed, issued writes are marked `ambiguous`, the generation is closed, and any late completion is rejected by §8.3. Role run deadlines are `deadline_builder`, `deadline_verifier`, `deadline_reviewer`, `deadline_architect`; sessions idle out at `session_idle_timeout`.

---

## 9. Gate function

**9.1 Scope first** (B01, Q3). `evaluateGate(project, candidate, gate_kind, environment?, operation?)`; `operation` is required for `*_complete` kinds and refused otherwise. Scope construction uses the candidate's immutable revision and the approved plan bindings. A requirement is **delivered** iff every stage listing it in `implements` has an `integrated_revision` that is an ancestor of, or equal to, the candidate's revision; **partial** iff some but not all; else **not started**. Delivery is recorded per candidate on the scope, never by phase start. Release-required obligations (`sensitivity_floor`, `smoke`, and post-deploy checks) are in scope regardless of delivery. Required checks derive from tier (cumulative), module overrides, and the floor; every delivered requirement must map to at least one required check. **Evidence reuse** under F §3.8 is recorded as `evidence_reuse` entries that let a specific result whose spec or architecture binding differs count as matching; it never substitutes for a required check and never waives a result. Any missing, empty, uncertain, or uncovered element yields `ACCEPTANCE_SCOPE_INCOMPLETE` (public code `scope_incomplete`). An empty required-check set never satisfies a gate.

**9.2 Check state assignment** (B01, E8). For each required check: (1) collect every `check_results` row for `(check, candidate)`; none → **missing**. (2) Keep those whose complete bindings match the scope: `source_revision`, effective protected version, `runner_class`, environment and artifact digest where the kind requires them, or an approved `evidence_reuse` entry; none → **stale**. (3) Select the matching row with the highest `execution_seq`. (4) `execution_established = false` → **skipped**; `deadline_hit` or `signaled` or `exit_status` null or nonzero → **failed**; else **passed**. Precedence is as listed; ordering is by `execution_seq`, never by timestamp.

**9.3 Inputs**, all required, in order: (1) scope complete; (2) protected path authorized and effective (`PROTECTED_PATH_UNAUTHORIZED`, `PROTECTED_VERSION_NOT_EFFECTIVE`); (3) no out-of-band change and no pending journal on the lineage (`OUT_OF_BAND_CHANGE`, `GIT_JOURNAL_PENDING`); (4) every required check passed (`CHECK_NOT_PASSED`); (5) **findings** (B02): over every finding with status `open` or `dispositioned` whose applicability includes this candidate, where applicability is: `project` scope → always; `lineage` or `candidate` scope → the originating candidate and every successor reached through `started_from_candidate`, unless an `approved` assessment excludes this candidate. Blocking under F §6.1 → `FINDING_BLOCKING`; the Alpha High exception requires recorded containment evidence and testing purpose, is refused in a sensitive area, and never overrides a non-passed check. Nonblocking is satisfied only by `defer` with authority matching the current effective severity (Reviewer for low, human for medium per O3), a linked issue, an unexpired target, and a `reevaluations` entry for **this evaluation** (written by the evaluation itself after those checks hold), or by human `accept`; `fix` is unsatisfied until a `resolution_verification` applicable to this candidate exists (`FINDING_UNSATISFIED`, `FINDING_DEFER_EXPIRED`); (6) sign-offs the tier requires, bound to `acceptance_content_hash`: T2 Reviewer at candidate scope; T3 additionally per module and a clear security review (`SIGNOFF_MISSING`); (7) approvals: each required approval is a consumed decision whose approval binds the governed subject per A.8: baseline approvals bind the baseline version; candidate-level approvals bind `acceptance_content_hash`; deployment approvals bind the `deployment_authorizations` row, so one go-live approval serves `live_authorize` and `live_complete` without transferring to another candidate (`APPROVAL_MISSING`); (8) referenced evidence records exist and verify (`EVIDENCE_MISSING`); (9) deployment obligations per §9.6. `outcome` is `satisfied` iff no reason was produced, else `not_satisfied`; `satisfiers` derive from reasons by fixed templates.

**9.4 Severity transitions** (F §6.3, B02). Any role may raise `effective_severity` (`finding.severity_changed`); lowering out of blocking range for the gate concerned requires the human; other downgrades require the Reviewer or human; every change records actor and `Authority`. No severity change alters a check state.

**9.5 Staleness.** Any write to a check result, finding, sign-off, deployment verification, protected version, out-of-band change, journal entry, policy revision, or a decision bound to the candidate marks its evaluations `stale`; an invalidated resolution verification returns the finding to `open` (`finding.reopened`); a scope-dependency change invalidates the evaluation, and retaining evidence across a baseline change requires the F §3.8 applicability record.

**9.6 Deployment authorization and completion** (B03). `beta_authorize` additionally requires an `export_records` row validated for the exact candidate revision and `allowlist_version` (`EXPORT_NOT_VALIDATED`) and a recorded `source_artifact_mapping` (`ARTIFACT_MAPPING_MISSING`); `live_authorize` requires the `recovery_plan` record (`RECOVERY_PLAN_MISSING`). A satisfied `*_authorize` creates one `deployment_authorizations` row (`authorization.issued`); it never advances progress. The deploy operation references that authorization (`authorization.consumed`). `beta_complete` additionally requires the `publish` operation for the exact delivery revision and artifact to be `succeeded` (`PUBLICATION_NOT_SUCCEEDED`); a `publication_first_visibility` decision must be consumed before any visibility-changing operation is recorded, so completion can never retroactively authorize disclosure. `*_complete` requires a `deployment_verifications` row bound to the named operation, its **current attempt and `deployment_generation`**, environment, full target set, artifact digest, mapping, configuration identity, and effective protected version, with outcome `verified`: every required target's identity read matches the mapping, at least one required `post_deploy_behavior` check passed, every required `post_deploy_identity` and `post_deploy_behavior` check passed. Prior verifications of the same operation are invalidated by any later attempt or target change; per-target evidence may be retained only through an `evidence_reuse` entry covering the later attempt's effects. Reasons: `DEPLOY_OPERATION_MISSING`, `DEPLOY_VERIFICATION_MISSING`, `DEPLOY_VERIFICATION_UNKNOWN`, `DEPLOY_VERIFICATION_FAILED`. Only a satisfied completion advances progress (`candidate.advanced`) and writes `last_verified`; failure or unknown writes `attempted` and the current observation (`environment.attempt`) and never erases history.

**9.7 Effect plans and previews** (B12). Each decision kind declares a dependency manifest (A.8). The owning transition in dry-run mode returns the effect plan, its `plan_hash`, blockers, the gate delta where a gate is involved, and the manifest values; the `preview_hash` covers the decision identity, the option set and each plan hash, `transition_schema_version`, and every manifest value including semantic deadlines. Presentation order and served-at are excluded.

---

## 10. Attention queue

**10.1 Raising.** Only transition functions raise decisions (`decision.raised`), only for kinds in A.8, each with a fixed question template, option set, binding schema, and `target_seconds` default. Stop (`stop_confirm`), Abandon (`abandon_confirm`), Reactivate (`reactivate`), Retire (`retire`), idea acceptance (`idea_accept`), spec approval (`spec_approval`), and authority-widening policy changes (`policy_widening`) all go through the queue; the CLI and UI routes for them create and consume these decisions and cannot bypass them (B12). Retire disables the Mechanic, clears management mode, freezes each environment record (`frozen_at`), and emits `project.retired`; reactivate restores `prior_baseline_state` and emits `project.reactivated` (E16a).

**10.2 Identity, never twice** (B12). Identity is `(project, kind, subject_type, subject_id, semantic_generation, scope)`, unique across all statuses. A raise with an existing identity returns the existing row. `semantic_generation` advances only on a recorded material change to the subject. Evidence hashing canonicalizes ordering and excludes presentation timestamps.

**10.3 Consolidation.** Decisions sharing `(candidate, revision, gate_kind)` share a `batch_key` and present as one item; each is consumed as its own row. Batch answers are evaluated as a combined effect plan and refused if the plans conflict; all-or-nothing refers to local intent consumption.

**10.4 Aging and escalation** (B07). An open decision past `target_seconds` gets `escalated_at` and a `notification_intents` row (`notify` operation) with key `(decision, generation)` in the same transaction. Delivery is a separate journaled attempt; a channel that cannot confirm delivery leaves the intent `unknown`, and the engine never claims exactly-once delivery. Urgent Mechanic escalations bypass the target (F §8).

**10.5 Answering and executing** (B12). The answer carries the `preview_hash`. The transition recomputes the owning transition's eligibility with the current time and current rows, re-reads every manifest value, and refuses `decision_stale` on any difference; `decision_consumed` if not open; `decision_invalidated` if a bound subject reached a terminal state by another path. Consumed decisions record the approval and `effect_intents` with their preconditions and the authorization consumed (`intent.recorded`). **Immediately before each effect runs** (`intent.executing`), the engine revalidates the intent's preconditions against current rows and uses target-side conditional execution where available (git CAS; adapters declare their conditional capability and reconciliation guarantee); a changed precondition sets the intent `invalidated` with `EFFECT_PRECONDITION_CHANGED` (`intent.invalidated`) and raises the next decision generation; the approval is never transferred. Completed intents emit `intent.done`.

**10.6 Blocked-while-open.** Each decision records the work items, gate, and operation it holds; §8.1 step 8 honours the set.

---

## 11. Local API

**11.1 Transport and boundary** (B14). HTTP/1.1 on `127.0.0.1:7227` (configurable); server-sent events for streams. Before routing, body reads, filesystem access, or `100 Continue`: the `Host` header and any absolute-form request target must equal the exact configured self-authority (`host_refused`); a present `Origin` or `Referer`, parsed as an origin, must equal the exact self origin including scheme and port (`null`, malformed, or foreign refused with `origin_refused`); present fetch-metadata headers must be consistent with same-origin use. No CORS. Mutations and every origin-less request require `X-Surety-Token` equal to `api.token` (0600, created at first start, rotated by `surety token rotate`), compared length-checked and constant-time (`token_required`, `token_invalid`). **`GET /v1/token/bootstrap`** is the one read-only exception: it requires no token, enforces the exact Host and target checks, requires positive same-origin browser evidence (`Sec-Fetch-Site: same-origin` and an `Origin` or `Referer` whose parsed origin equals the self origin), refuses any contradictory or cross-origin signal, grants no CORS, answers `no-store`, returns the token only on that path, and authorizes nothing else; origin-less clients read the private file. Responses carry `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and frame denial, on error paths too; the UI ships a restrictive CSP, renders untrusted content as text, resolves relative links before applying scheme rules, and allows only `https:`, `http:` to loopback, and relative links. Body caps: a declared `Content-Length` over `body_cap` (`upload_cap` on upload routes) is refused before the body is consumed (`payload_too_large`); chunked or mismatched bodies are byte-counted under `request_body_deadline` and bounded buffers, and crossing the cap aborts parsing and any effect with a consistent error and audit record. Unknown fields are refused (`unknown_field`). Record reads open only the expected regular file, reject devices, FIFOs, and symlink substitutions, verify project ownership for reads and commands alike (`not_found` otherwise), and enforce byte and time limits. Every mutating request, including refusals, writes an `api.act` event with the token redacted, committed with the command intent before any effect is dispatched; if the audit write fails, the mutation is refused (`audit_failed`). No request or stream callback may crash the engine. Tokens never appear in URLs, browser storage, event payloads, or logs.

**11.2 Versioning and schema.** All routes under `/v1/`. `packages/engine/api/schema.json` is the contract; the UI package imports generated types; a contract-pin test fails on drift; a joint engine-plus-UI behavioral suite exercises every accepted screen against a live engine and enforces that the UI package imports only the engine's published API types (N03, O8).

**11.3 Reads** (B13). Every response carries `served_at` and the store snapshot sequence. Every fact that reflects a reading carries its own `observed_at`, source, `Provenance`, and `Freshness`. Reading never refreshes an observation timestamp. Reads never call adapters. Record and tail content is returned only through engine-scoped identifiers; every nested route verifies that the entity belongs to the project in the path.

| Route | Returns |
|---|---|
| `GET /v1/health` | restricted-mode safe liveness |
| `GET /v1/engine` | version, incarnation, mode, uptime, tick timing, leases, backends qualified (D2), store size, last backup and its completeness label |
| `GET /v1/token/bootstrap` | §11.1 |
| `GET /v1/projects` | lifecycle, NOW, open decisions with oldest age and escalation state, running run summary, spend today (verified and unknown separately; no dispatch shown as such) |
| `GET /v1/projects/:p` | combined projection: NOW, baseline, roadmap and requirement status, candidates (nominated only, with succession), environments (three facts with freshness), management, execution status, spend attribution |
| `GET /v1/projects/:p/decisions`, `/:d` | open decisions consolidated by batch key, options with effect plans and the preview hash, evidence resolved to records |
| `GET /v1/projects/:p/candidates/:c` | candidate, lineage, working revisions and checkpoints, latest evaluation per gate kind |
| `GET /v1/projects/:p/candidates/:c/gates/:kind` | evaluation with scope, reasons, satisfiers, per-check states and output records, historical versus effective protected version, protected-version delta since the last human-reviewed version |
| `GET /v1/projects/:p/work` | work items by status, phase plan with stages, blockers |
| `GET /v1/projects/:p/runs/:r` | run with state, liveness, domain and ownership summary, workspace, grant names, receipts, status and usage observations |
| `GET /v1/projects/:p/runs/:r/tail` | SSE: captured output from an offset, bounded per-client queue; slow consumers disconnected with a cursor (`slow_consumer`) |
| `GET /v1/projects/:p/operations`, `/:o` | operations with attempts, journal events and state, reconciliation reads |
| `GET /v1/projects/:p/environments` | environment records with per-target observations, history, and freshness; observation jobs; operations in flight |
| `GET /v1/projects/:p/releases` | releases with their four state facts, mappings, recovery plans |
| `GET /v1/projects/:p/ledger?day=` | ledger rows with corrections, per-role totals, verified and unknown separately |
| `GET /v1/projects/:p/records/:id` | a record's content through its scoped id |
| `GET /v1/projects/:p/policy` | effective policy, revision, the closed writable-field schema (A.9 project scope) |
| `GET /v1/projects/:p/management` | deferred owner: activation evidence, issues, triage (E5 document) |
| `GET /v1/events?since=<seq>&project=` | SSE: replay from `seq` with a resumable cursor, bounded queue |

**11.4 Commands.** Each is one transition; each returns the resulting rows and events. Convenience routes for decisions create and consume the corresponding decision rather than bypassing the queue.

| Route | Effect |
|---|---|
| `POST /v1/projects`, `POST /v1/projects/adopt` | bootstrap transaction (§3.1); adoption records the baseline commit and raises `adoption_mode` |
| `POST /v1/projects/:p/tick` | set the tick flag |
| `POST /v1/projects/:p/pause`, `/resume` | project pause flag only |
| `POST /v1/projects/:p/retire`, `/reactivate` | raise and, with confirmation, consume `retire` / `reactivate` |
| `POST /v1/projects/:p/decisions/:d/answer` | §10.5 with `{option, note?, preview_hash}` |
| `POST /v1/projects/:p/decisions/answer-batch` | §10.3 |
| `POST /v1/projects/:p/runs/:r/stop`, `/abandon` | raise and consume `stop_confirm` / `abandon_confirm` with the preview hash; §4.5 |
| `POST /v1/projects/:p/work/:w/resume`, `/cancel` | A.5; resume creates a new run per §15.3 |
| `POST /v1/projects/:p/policy` | closed field schema (A.9 project scope); unknown fields refused; validated full object; diff computed and partitioned: governed protected fields (§5.2) become a `protected_proposals` row routed through §7.9; other widening changes raise `policy_widening` and return `confirm_required` with the preview hash; non-widening changes commit through §7.3 and §7.5 and record a policy revision |
| `POST /v1/projects/:p/sessions`, `.../:r/turns`, `.../:r/save`, `.../:r/close` | §15.2 |
| `POST /v1/projects/:p/spec/change-requests` | starts F §3.8 and raises `spec_change` |

**11.5 Errors.** Every refusal is `{code, reason, what_to_do, subject}` with a code from A.7; `illegal_transition` for any transition A.5 does not list; `quarantined` for an action on a quarantined resource; `out_of_band_change` for an action blocked by §7.6.

**11.6 CLI.** `surety` is a thin client over the same routes with `--json`. `surety store …` commands refuse to run while an engine holds the lock.

---

## 12. Event log and projections

**12.1 Events.** Append-only, store-wide monotonic `seq`, written in the same transaction as the change they describe. Types are the closed set in A.6; every type is named in this document by the transition that emits it (§§1–11, 13–16), and adding one is an amendment. Each event names `actor_kind`, `actor_id`, and `request_id` or operation (B14).

**12.2 Projections derive from entities, not from events.** `GET /v1/projects/:p` is computed from current rows in one snapshot read; the event log is the audit trail and the live feed.

**12.3 NOW** (`NowState`). Exactly one of, by fixed priority: `refused` (the engine cannot act on this project: repository unreadable, integrity blocked, store error, quarantine) → `waiting_on_you` (any open decision) → `running` (any run executing) → `ready` (eligible work and dispatch possible next tick) → `idle`. `unknown` replaces all of these only when the store snapshot itself fails. A refusal is about the engine's ability to act; environment facts stay `unknown` independently (B13). A screen may title its local execution panel "Running" while NOW says otherwise (N03). The projection carries `primary_action` and a one-sentence `reason` generated from the same inputs.

**12.4 Execution status.** Runs by state, sessions open, paused flag, blockers, quarantines, last and next tick.

---

## 13. Ledger and budgets

**13.1 Identity and rows** (B11). One invocation id per dispatch (§2.6). Immutable receipt; status by observations; one original ledger row per invocation; corrections as deltas; unknown tokens null; `measured_zero` is a cost status for a dispatched invocation that reported zero; "no dispatch" is a projection fact with no row. Session finalization reconciles turn invocations and creates no row for the session itself. D1-26 covers correction insertion, repeated finalization, refusal before launch, and session close after finalized turns.

**13.2 Normalization.** `billable_in` excludes cache reads; `cached_in` is separate; `raw_usage` and `normalization_version` retained. Verity's Claude normalizer folds cache reads into input and its Codex normalizer emits zeros for missing usage; neither is ported verbatim (N04).

**13.3 Budget boundaries** (B11, E16b). Limits: `budget_run_billable_tokens`, `budget_day_verified_usd`, `budget_day_unknown_tokens`. Policy names each limit's boundary: model turn, user session turn, or whole invocation. Adapters declare which boundaries they can enforce; where a one-model-turn overshoot bound is unavailable for a multi-turn one-shot invocation, the engine records that limitation on the trust entry (D2) and either applies a qualified hard bound or refuses a policy that requires the finer boundary. Checks run at dispatch, between session turns, and on every usage observation; exhaustion stops at the enforceable boundary through §4.5, parks the item, raises a `blocker`, and pauses dispatch for the project (`budget_exhausted`). Resolving the blocker never overrides a required check and never replays completed paid work. A store error during a check is a refusal (§6.6).

---

## 14. Records, redaction, retention

**14.1 Durable write path** (B06). `records.write(kind, stream)`: stream through the redactor into a private temporary file in `records/`, fsync, rename to its immutable name, fsync the directory, then insert the record row with the hash in a transaction (`record.written`). A transaction may reference a record only after `published`. Streaming records write `stream_chunk_receipts` so recovery can distinguish retained output from an unknown remainder.

**14.2 Redactor** (N05). Matches provider patterns and every resolved secret reference across chunk boundaries before bytes reach disk, the event stream, logs, or responses; `redaction_version` is recorded. A post-write scan with the same set runs on stored bytes; a `hit` raises a `security` finding of severity `critical` scoped to the project with `source_run` null (`record.secret_found`). `clean` means no registered detector matched. A newly registered pattern triggers a bounded rescan of stored records; hits quarantine dependent evidence until resolved.

**14.3 Retention.** A record is retained while any finding, approval, gate evaluation, deployment verification, release, open decision, non-terminal run or work item, proposal, pending journal entry, or pending effect intent references it. Unreferenced records expire after `record_retention_days`; the row is kept with `path = null` (`record.expired`). Recovery detects orphan files and missing or corrupt referenced files (`record.missing`); missing evidence yields `EVIDENCE_MISSING` on dependent gates, never an empty record.

**14.4 Never in prompts.** Records enter an agent's context only through the engine's scoped context package (F §3.10.8); `raw_user_report` records never do (E5). Provider-native session files are D2's to redact, retain, and contain.

---

## 15. Model-invocation choke point

**15.1 One function.** `invoke(invocation)`: resolve the execution context; check lease generation, grant, and run state; select the adapter from the trust table and refuse an unqualified backend, version, or mode (`backend_refused`) or one without qualified control-plane isolation (`isolation_unqualified`, §17.12); construct the child environment with the domain and invocation markers and resolved secrets; the receipt already exists (§2.6); append `dispatch_started`; write process ownership with pid null; spawn into a new process group; complete ownership and append `launched`; stream usage observations; enforce the deadline by cancellation; collect and validate the structured result against its schema and the transcript (`invalid_result` on contradiction); return to the run's transition.

**15.2 Sessions** (B15). `session.open` allocates the run (`allocated`), work subject, workspace, grant, run lease, and idle deadline; no provider process starts. The first `session.turn` creates the provider session and durably captures `provider_session_id` before the turn completes; later turns use exactly that id, never an ambient "last session" selector. Each turn is its own invocation and domain. `session.save` runs the snapshot and checkpoint path (§7.3, §7.4) at `open_idle` and returns to `open_idle`; it never takes the run termination path; a failed save leaves the workspace retained and the failure visible, and no new turn may start until the save's git operation is finalized or reconciled. `session.close` enters `closing` then run finalizing then `endRun`. Idle and invocation deadlines are separate. Session mode on a backend is refused until D2 records continuation and quiescence evidence; no silent fallback.

**15.3 Resume is a new run** (F §3.9). Resuming a stopped, timed-out, budget-ended, or recovered run creates a new run linked by `parent_run`, with a fresh provider context reconstructed from durable records, newly scoped capabilities, re-verified revision and approvals, and reconciled effects, before dispatch (`work.resumed`). The old provider session is never resumed as a substitute.

**15.4 No other path.** A repository lint test fails on any spawn of a backend binary outside `engine/invoke/`.

---

## 16. Crash recovery

**16.1 At startup** (B08, B05), in restricted mode: (1) enumerate execution domains not `terminated`, including `allocated` ones with no pid, and find their live processes by marker and process group; terminate owned processes; never signal a pid whose recorded start time does not match; (2) every non-ended run → `endRun` with outcome `recovered` (quarantine where termination cannot be established); (3) journal probes and finalizers (§7.10); (4) operations and attempts reconciled; unreadable outcomes stay `ambiguous` with a `blocker`; (5) records audited (§14.3); (6) workspaces of ended runs retained; (7) evaluations stale; (8) integrity (§7.6).

**16.2 Invariant** (A17, A18). After a kill or power loss at any point: no reusable execution authority exists (every lease released or converted to a `quarantine` reservation), no grant live, every invocation has a receipt and either a ledger row or an explicit `unknown`, every workspace retained or quarantined, every journal entry `finalized`, retried once, or blocking, every operation terminal or `ambiguous` with a decision, and no duplicate external effect. Process-kill tests and power-loss tests are separate evidence (D1-23).

---

## 17. Security invariants

Each is pinned by a test named after it.

1. Loopback bind; Host and absolute-form authority checked before routing on every request.
2. Exact self-origin, parsed as an origin, for any present Origin or Referer; no CORS; token on every mutation and on every origin-less request except `GET /v1/token/bootstrap`, which requires positive same-origin evidence instead; constant-time comparison.
3. Prompts and arguments reach every child as data; option-shaped arguments validated or terminated.
4. Child environments constructed from the grant; the engine's environment never inherited.
5. Secret values exist only inside the engine's resolver between resolution and child start or redaction; store, records, events, responses, backups, and logs hold references only.
6. Snapshot-based diff validation enforces path, symlink, metadata, index, detached-HEAD, registered-ref, and managed-checkout integrity for every role.
7. Every repository mutation and external effect has a journaled intent before execution and is reconciled before any retry.
8. Only a `passed` check state, derived by §9.2 from a runner-established execution with exit status zero, satisfies a gate; nothing writes `passed`.
9. A decision is consumed at most once; a changed preview dependency makes it stale; an effect whose preconditions changed is invalidated, never transferred.
10. Ledger rows, usage observations, receipts, status observations, journal events, chunk receipts, observation history, and events are append-only at the database level.
11. The engine refuses any backend, version, or mode without a trust-table entry.
12. **Every** role process, in every mode and at every autonomy setting, is prevented from reading or modifying the control plane or impersonating the operator; a backend or mode without qualified isolation is refused for any run (`isolation_unqualified`); D2 owns the mechanism and its qualification. Authorized bootstrap and secret references never grant role access to the operator token.
13. Defensive response headers on every response, including errors; the UI's CSP is restrictive.
14. No request or stream callback can crash the engine; a failed audit write refuses the mutation.

---

## 18. Acceptance scenarios

Integration tests against a real SQLite store, real git repositories in temp directories, and a scripted fake adapter. Real-binary lanes are D2's. "Kill" means SIGKILL of the engine; "power loss" means a filesystem-level simulation that discards unsynced writes.

| ID | Scenario | Required result |
|---|---|---|
| D1-01 | Same role dispatched twice | Distinct run ids, invocations, receipts, domains, transcripts, results, workspaces, ledger rows (A05) |
| D1-02 | Known usage across attempts, a stopped attempt with unknown remainder, then branch switch, rebase, squash, engine restart, read through the API, with a linked worktree and relocated repository after rebinding; expected invocation count and totals stated before and asserted after | Stable invocation identities, exactly-once totals with no duplicate correction application, unchanged budget refusal, readable referenced records, no runtime data in tracked trees; an out-of-band change blocks gates without hiding history (A06, N01) |
| D1-03 | Answer a decision twice; answer a consumed parked review | Second refused `decision_consumed`; one approval; no adapter launch on consumption (A07) |
| D1-04 | Changed policy, protected delta, target configuration, expired deferral, and a same-operation new attempt between preview, answer, and execution; head moves after approval and before effect | Decision stale or invalidated; new generation raised; old answer has no effect; the effect never runs on changed preconditions (A08, B12) |
| D1-05 | Trigger observed before completion, after refusal, after restart, and after success | One work item throughout; no error on the post-success observation (A11, B10) |
| D1-06 | Kill between operation intent and outcome | Ambiguous, reconciled by adapter read, no duplicate effect (A12, A13) |
| D1-07 | Two projects, hostile ambient `GIT_DIR`, `GH_REPO`, cwd | Every git call uses its own context; both targets asserted; ambient values absent (A16) |
| D1-08 | Stop during build; kill; restart; surviving descendant; reused pid; late callback; crash between domain allocation and ownership completion; parent exited while a child writes | Descendants found by marker and terminated; reused pid untouched; late callback rejected; quarantine when termination unconfirmed; the allocated-only domain is recovered; resume creates a new run (A17, B08) |
| D1-09 | Runner reports not-executed; no result; results at old source, old protected version, wrong runner class, wrong environment; a later execution at the same bindings fails after an earlier pass; empty required set | skipped, missing, stale ×4, failed (latest by `execution_seq`), `ACCEPTANCE_SCOPE_INCOMPLETE`; gate not satisfied (A20, B01) |
| D1-10 | Shell metacharacters in prompt; result path `../outside`; symlink out; snapshot taken only after confirmed termination | Prompt literal; `diff_violation`; the snapshot tree is what is validated and committed (A21, B04) |
| D1-11 | Human commit on the integration branch; a developer branch moves | Integration branch: detected, gates blocked, decision, discard or adopt journaled. Developer branch: no effect |
| D1-12 | Protected roots changed without an authorized version; policy edit to a governed field | `PROTECTED_PATH_UNAUTHORIZED`; the policy edit becomes a proposal and cannot apply through generic confirmation (B04) |
| D1-13 | Store error during budget check | `store_error`; nothing dispatched |
| D1-14 | Decision past target; kill before and after notification delivery | Escalated once; the notification intent is delivered once or marked `unknown`; never duplicated |
| D1-15 | Option previews | Effect plan equals what consumption writes; hash mismatch is `decision_stale`; precondition change before execution invalidates the intent |
| D1-16 | Secret in a transcript split across chunks and across a multibyte boundary; new pattern registered later | Redacted before disk; post-scan clean; rescan raises a critical finding and quarantines dependents |
| D1-17 | Second `surety serve` | `engine_locked` with incarnation; first engine unaffected |
| D1-18 | Nomination at stage completion (T2) and on Builder request (T1); kill after the probe matches but before the finalizer | Candidate, immutable ref, lineage succession written by the finalizer on restart; Builder cannot nominate at T2 (B05) |
| D1-19 | Integration with moved HEAD; CAS failure; kill after update-ref before confirmation; kill after confirmation before the finalizer | Rebase and re-validate; `integration_conflict` parks; journal confirms and finalizes on restart with no out-of-band false positive (B05) |
| D1-20 | Git child held open, a slow SSE consumer attached, the qualified maximum store size, a busy store connection, gate recomputation, restricted mode during migration, backup work, large paginated replay, record hashing | `GET /v1/health` and Stop admitted within `api_latency_bound`; an expired integrity step prevents dependent dispatch including after late completion (B09, N03) |
| D1-21 | Verifier diff touching only the protected set; another touching protected and source | First ends `proposal_captured` with no commit anywhere; second rejected whole (B04) |
| D1-22 | Apply an approved proposal; kill between authorization and application; kill between application and finalization | Recovery completes or blocks; no applied protected tree without an authorized version (B04) |
| D1-23 | Power loss after an effect's intent, after a record publication, and after an effect applied but before its receipt | Intent present on restart; record either fully published or absent; applied effect discovered by probe and not repeated (B06, A18) |
| D1-24 | Fix disposition; defer without authority; medium defer by Reviewer; high at alpha without exception evidence; two successive nominations into different lineages; an already-dispositioned finding whose later-stage severity blocks | `FINDING_UNSATISFIED`; refused; refused; `FINDING_BLOCKING`; inherited through ancestry and evaluated; evaluated despite `dispositioned` (B02) |
| D1-25 | Alpha authorize satisfied, deploy operation recorded, verification bound to a different operation; same operation, different attempt, stale verification; multiple operations on one candidate; authorize-to-complete without a second go-live approval | `*_complete` not satisfied in the first two; the right operation selected in the third; completion satisfied on the same approval in the fourth (B03) |
| D1-26 | Kill mid-invocation after usage observations; correction insertion; repeated finalization; refusal before launch; session close after finalized turns | Observations present; one original row with `usage_complete = false` and null unknowns; corrections inserted and applied once; finalization idempotent; refused invocation has no row; close creates no row (B11) |
| D1-27 | Two blockers on different work items; same question with reordered evidence; same question re-raised after consumption without a material change | Distinct identities; one identity; existing consumed row returned (B12) |
| D1-28 | Observation job misses its freshness bound; repeated GETs | Condition `unknown` with history visible; `observed_at` unchanged by reads (B13) |
| D1-29 | Host, Origin, Referer, fetch-metadata, token, body-cap matrix; fresh browser bootstrap; hostile bootstrap requests | Each refusal before routing or body read; headers on every response; bootstrap succeeds only with positive same-origin evidence (B14) |
| D1-30 | Session: initial id capture, two turns with distinct processes, two saves, continuation after save, idle timeout, restart during save, Stop from open_idle; resume of a stopped run | States as §4.2 and §15.2; new run with fresh context on resume (B15) |
| D1-31 | Repair loop: unchanged finding twice; changed-progress repairs reaching `repair_attempts_max`; a successful small repair; typed `contract_conflict` | Parked at `no_progress_max`; parked at the attempt limit; completes; conflict routes to objection without a repair run (A09, A10, B10) |
| D1-32 | Completed work, response lost before run completion | Snapshot and receipts recovered; reconciled before any new invocation (A12) |
| D1-33 | Twenty event-stream clients, one slow; measured adapter-read count under load | Bounded queues; slow client disconnected with cursor; adapter reads unchanged by client count (A19) |
| D1-34 | Supervised policy with `max_chained_roles` | Dispatch stops at the boundary; the next step is a decision (A23) |
| D1-35 | Human edit to a governed policy field | Becomes a proposal; cannot apply through generic confirmation (B04) |
| D1-36 | Dirty integration worktree with unchanged HEAD and index; unreadable repository | Checkout subject with `stash` and `adopt`; repository subject with no reset offered (B05) |
| D1-37 | Operation terminal as failed; conformance work item before and after `alpha_complete` | Never completes the work item; conformance completes only after (B10) |
| D1-38 | `scripts/d1-consistency.mjs` on the committed document and the engine's schema | Zero findings (B17) |

---

## 19. Repository layout and build order

**19.1 Layout** (O8, O9, O11). This directory becomes the Surety development repository, history preserved; documents move under `docs/` with recorded renames when implementation is authorized.

```
surety/
  package.json                 workspaces: packages/*; pinned deps; node >= 22
  packages/engine/
    package.json               bin: surety; dep: better-sqlite3 (pinned)
    src/store/                 schema, migrations, worker, transitions/
    src/git/                   context, registry, snapshot, validation, journal, integration, integrity
    src/scheduler/             tick, leases, triggers, observation jobs
    src/gate/                  scope, evaluate, reasons, effect plans
    src/decisions/
    src/invoke/                choke point; adapters/ (D2); ports/ with provenance
    src/records/
    src/ledger/
    src/api/                   server, routes, schema.json, cli/
    src/recovery/
    test/                      D1-01…D1-38; real git; scripted fake adapter
  packages/ui/
    public/                    zero-build HTML/JS; generated api types
  scripts/                     d1-consistency.mjs and later checkers
  docs/
```

**19.2 Ports** (N04). Every ported module records upstream path, commit, retained tests, semantic adaptations, and its new owning contract. Legacy risk classification is not evidence of tightening; pure rules are extracted from acquisition code; qualification records name real binary, OS, mode, containment, and evidence. The regression corpus index records each retained fixture's originating commit and qualification limitations separately from Surety's own results.

**19.3 Milestones** (B16). **M1 is the preliminary engine loop**, not the walking skeleton. M1 needs: the store and transitions for every entity its paths touch, including findings, sign-offs, policy revisions, operations, journal, registry, and managed checkouts; git §7 complete; scheduler §8 with one run per project; gate function §9 for `stage` and `alpha_authorize`; decisions for `check_correction_loosening`, `check_correction_unclassifiable`, `finding_disposition`, `blocker`, `out_of_band_change`, `stop_confirm`, `abandon_confirm`, `policy_widening`; API reads and commands above except sessions, management, and releases; events; ledger with receipts and observations; records; invoke one-shot; recovery. M1 runs on the scripted adapter only. M1 may compute a stage gate and an alpha authorization; it MUST NOT report `alpha_deployed` or phase-one completion. **Surety's walking-skeleton phase stays open until M3** exercises a real minimal deployment target through alpha authorization, a journaled deploy operation, identity read, and a required `post_deploy_behavior` check through the protected path, plus the phase-one Beta obligations if policy requires them. A real backend enters at the first D2a qualification, which must include the control-plane isolation mechanism (§17.12), expected on this host to be a dedicated unprivileged user for role processes. M2 adds Codex through the same contract, real-binary lanes for both backends, and the kill and power-loss scenarios. Dogfooding Surety on itself first establishes the E6 baseline and conformance path.

---

## 20. Open questions

Resolved from draft 2, with Astra's recommendations adopted: Q1 worker default with D1-20 as the requirement and N03's expanded workload; Q2 live checkpoints refused until D2 proves quiescence, snapshots at confirmed termination or `open_idle`; Q3 delivery derived from integrated stages at the pinned revision; Q4 Verifier proposes, independent Reviewer assesses, human authorizes any exclusion that removes a blocking finding (E19, decided by Sean).

Open for draft 3: none. Residual items become draft 4 dispositions.

---

## Appendix A. Schema and closed enumerations

`scripts/d1-consistency.mjs` parses this appendix and the body and fails on: any identifier the body uses in code spans that A does not declare; any enumeration value, reason code, error code, event, decision kind, or configuration key A declares that neither the body nor A.3, A.5, or A.8 references; any A.5 state not in its enumeration; any A.8 kind not in `DecisionKind` or vice versa; any foreign key naming an undeclared table. The engine's own test suite runs the same checker against `schema.json`, migrations, and transition functions (B17).

### A.1 Id prefixes

| Prefix | Entity | Prefix | Entity |
|---|---|---|---|
| `inc_` | engine_incarnations | `proj_` | projects |
| `spec_` | spec_revisions | `arch_` | architecture_revisions |
| `mod_` | modules | `road_` | roadmap_revisions |
| `plan_` | phase_plans | `req_` | requirements |
| `stage_` | stages | `wi_` | work_items |
| `run_` | runs | `turn_` | turns |
| `dom_` | execution_domains | `proc_` | process_ownership |
| `grant_` | capability_grants | `ws_` | workspaces |
| `lease_` | leases | `rev_` | revisions |
| `lin_` | lineages | `cand_` | candidates |
| `prop_` | protected_proposals | `pv_` | protected_versions |
| `chk_` | checks | `cr_` | check_results |
| `scope_` | acceptance_scopes | `gate_` | gate_evaluations |
| `dauth_` | deployment_authorizations | `dv_` | deployment_verifications |
| `fnd_` | findings | `appl_` | applicability_assessments |
| `so_` | signoffs | `dec_` | decisions |
| `appr_` | approvals | `eff_` | effect_intents |
| `op_` | operations | `att_` | operation_attempts |
| `gje_` | git_journal_events | `gjs_` | git_journal_state |
| `ref_` | ref_registry | `mc_` | managed_checkouts |
| `ntf_` | notification_intents | `env_` | environments |
| `envr_` | environment_records | `obsh_` | observation_history |
| `obsj_` | observation_jobs | `rel_` | releases |
| `inv_` | invocation_receipts | `iso_` | invocation_status_observations |
| `uo_` | usage_observations | `led_` | ledger_rows |
| `pol_` | policy_revisions | `rec_` | records |
| `chunk_` | stream_chunk_receipts | `oob_` | out_of_band_changes |
| `ev_` | events | `cfg_` | config |
| `mi_` | mechanic_issues (reserved) | `tri_` | triage_dispositions (reserved) |
| `pic_` | product_intent_contracts (reserved) | `adopt_` | adoption_analyses (reserved) |
| `exp_` | export_records (reserved) | `prom_` | promotion_records (reserved) |

### A.2 Enumerations

- **Tier:** T1, T2, T3.
- **BaselineState:** idea, spec_ready, retired.
- **RegistrationState:** pending_bootstrap, registered.
- **ManagementMode:** live, live_managed.
- **ManagementHealth:** healthy, degraded, unknown.
- **TriagePolicy:** manual, gated.
- **AdoptionMode:** full, scoped.
- **RequirementStatus:** pending, verified, descriptive_unverified.
- **DeliveryStatus:** not_started, partial, delivered.
- **StageStatus:** planned, building, integrated, verified.
- **WorkItemKind:** stage_build, fix, verification, review, phase_verification, replan, assessment, spec_change, check_correction, triage_accept, export, publish, deploy, rollback, adoption_baseline, conformance.
- **WorkItemStatus:** eligible, claimed, executing, integrating, integrated, verifying, complete, awaiting_decision, held, parked, cancelled.
- **RunKind:** one_shot, session.
- **RunState:** created, claimed, executing, validating, proposal_captured, finalizing, ended.
- **SessionState:** allocated, open_idle, turn_running, saving, closing.
- **RunOutcome:** completed, failed, refused, timed_out, stopped, abandoned, recovered.
- **RunReasonClass:** diff_violation, ref_violation, invalid_result, infra_error, preflight_refused, deadline, integration_conflict, budget, human_stop, human_abandon, recovered, none.
- **Role:** vision, spec_writer, architect, builder, verifier, reviewer, release_operator, mechanic.
- **DomainStatus:** allocated, launched, terminated, quarantined.
- **WorkspaceDisposition:** active, retained, quarantined, discarded.
- **LeaseKind:** run, integration, workspace, quarantine.
- **RevisionKind:** working, checkpoint, engine_commit, nominated, out_of_band, protected, intent.
- **CandidateProgress:** developing, alpha_deployed, beta_deployed, live.
- **NominatedBy:** engine_cadence, builder_request.
- **ProposalStatus:** captured, classified, awaiting_human, approved, applied, rejected.
- **ChangeKind:** initial, tightening, loosening, unclassifiable.
- **ProposedBy:** verifier_run, human.
- **CheckKind:** acceptance, smoke, sensitivity_floor, integration, post_deploy_identity, post_deploy_behavior, security_lint, property, failure_recovery.
- **CheckState:** passed, failed, missing, skipped, stale.
- **RunnerClass:** direct, container, remote.
- **GateKind:** stage, phase, alpha_authorize, alpha_complete, beta_authorize, beta_complete, live_authorize, live_complete.
- **EvalOutcome:** satisfied, not_satisfied.
- **AuthorizationStatus:** issued, consumed, superseded.
- **FindingScope:** project, lineage, candidate.
- **FindingStatus:** open, dispositioned, resolved.
- **FindingCategory:** defect, requirement_conflict, contract_conflict, security, hygiene.
- **Disposition:** fix, defer, accept.
- **Severity:** critical, high, medium, low.
- **Authority:** role, reviewer, human.
- **AssessmentStatus:** proposed, assessed, approved, rejected.
- **SignOffScope:** candidate, module.
- **DecisionKind:** idea_accept, spec_approval, spec_change, architecture_approval, plan_approval, check_correction_loosening, check_correction_unclassifiable, finding_disposition, severity_lower, blocker, out_of_band_change, rollout_partial, publication_first_visibility, publication_subsequent, allowlist_widening, go_live, management_opt_in, triage, adoption_mode, requirement_confirm, stop_confirm, abandon_confirm, retire, reactivate, policy_widening.
- **DecisionStatus:** open, answered, consumed, invalidated.
- **IntentStatus:** pending, executing, done, invalidated.
- **OperationKind:** git_ref_update, git_commit, git_worktree, publish, deploy, rollback, teardown, issue_file, issue_update, notify.
- **OperationStatus:** intended, in_progress, succeeded, failed, partial, ambiguous, superseded.
- **AttemptStatus:** started, succeeded, failed, ambiguous, reconciled_succeeded, reconciled_absent, reconciled_partial.
- **JournalKind:** ref_update, commit_tree, worktree_add, worktree_remove.
- **JournalEventKind:** intended, applied, confirmed, failed, ambiguous, finalized.
- **JournalState:** intended, applied, confirmed, failed, ambiguous, finalized.
- **RefKind:** integration, lineage, nomination, recovery, oob, keep.
- **CheckoutKind:** integration_worktree, run_workspace.
- **IntegritySubject:** ref, checkout, repository.
- **OobDisposition:** discard, adopt, stash.
- **NotificationStatus:** queued, sending, delivered, failed, unknown.
- **Channel:** in_app, email, webex, webhook.
- **ObservedCondition:** healthy, degraded, down, unknown.
- **Freshness:** fresh, stale, expired.
- **DeployVerificationOutcome:** verified, unknown, failed.
- **ReleaseStateFact:** prepared, published, staged, live.
- **InvocationStatus:** dispatch_started, refused, launched, ended, unknown.
- **CostStatus:** reported, estimated, unknown, measured_zero.
- **UsageSemantics:** cumulative, delta.
- **RecordKind:** transcript, tool_output, check_output, result, raw_user_report, parked_result, proposal_rationale, assessment_evidence, containment_evidence, recovery_plan.
- **PostScan:** clean, hit, pending.
- **Provenance:** observed, claimed, configured.
- **NowState:** refused, waiting_on_you, running, ready, idle, unknown.
- **EngineMode:** restricted, full.
- **ActorKind:** engine, human, run.
- **EventType:** the values in A.6.

### A.3 Tables and fields

Notation: `name: type`; `?` nullable; `=Enum` one of A.2; `→table` foreign key to a declared table; `[]` JSON array of the stated shape; `{}` JSON object with the stated keys. Every table has `id` and `created_at`; every project-scoped table has `project →projects`. `*` = required at creation.

- **engine_incarnations:** `pid*`, `started_at*`, `host_boot_id*`, `ended_at?`.
- **projects:** `name*`, `tier* =Tier`, `dev_repo_path*`, `integration_branch*`, `delivery_repo? {url, visibility, adoption_baseline_commit}`, `baseline_state* =BaselineState`, `prior_baseline_state? =BaselineState`, `registration_state* =RegistrationState`, `adoption? {mode =AdoptionMode, pinned_revision, size_signals{}, deployment_evidence[]}`, `management* {mode =ManagementMode, health =ManagementHealth, activation_evidence →records?, triage_policy =TriagePolicy}`, `policy_revision →policy_revisions?`, `paused* bool`, `seq_counters* {}`.
- **spec_revisions:** `version* int`, `git_path*`, `git_blob*`, `approved_by*`, `approved_at*`, `supersedes →spec_revisions?`.
- **architecture_revisions:** `version* int`, `spec_revision* →spec_revisions`, `git_paths* []`, `approved_by*`, `approved_at*`.
- **modules:** `architecture_revision* →architecture_revisions`, `name*`, `paths* []`, `sensitive_areas []`, `tier_override? =Tier`.
- **roadmap_revisions:** `version* int`, `architecture_revision* →architecture_revisions`, `git_path*`, `phases* [{number, goal, modules[], requirement_ids[], depends_on[]}]`.
- **phase_plans:** `roadmap_revision* →roadmap_revisions`, `phase_number* int`, `prepared_against_spec* →spec_revisions`, `prepared_against_revision* sha`, `git_path*`, `approved_by?`, `approved_at?`.
- **requirements:** `spec_revision* →spec_revisions`, `key*`, `text_ref*`, `assigned_phase? int`, `status* =RequirementStatus`, `verified_by →gate_evaluations?`, `confirmed_by?`.
- **stages:** `phase_plan* →phase_plans`, `number* int`, `goal*`, `modules* []`, `requirement_ids* []`, `implements* []`, `status* =StageStatus`, `integrated_revision? sha`, `work_item →work_items?`.
- **work_items:** `seq* int`, `kind* =WorkItemKind`, `subject* {stage →stages?, candidate →candidates?, finding →findings?, decision →decisions?, proposal →protected_proposals?, operation →operations?}`, `status* =WorkItemStatus`, `blocker? {reason, raised_at, decision →decisions}`, `depends_on [→work_items]`, `trigger_source*`, `trigger_id*`, `trigger_generation* int`, `trigger_consumed_at?`, `repair_attempts* int`, `no_progress_count* int`, `progress_key?`, `preflight_refusals* int`, `prior_status? =WorkItemStatus`, `dispatch_hold* bool`.
- **runs:** `seq* int`, `work_item* →work_items`, `role* =Role`, `kind* =RunKind`, `state* =RunState`, `session_state? =SessionState`, `outcome? =RunOutcome`, `reason_class? =RunReasonClass`, `reason_text?`, `backend*`, `backend_version*`, `model_requested*`, `model_observed?`, `grant →capability_grants?`, `workspace →workspaces?`, `base_revision* sha`, `deadline_at*`, `started_at?`, `finished_at?`, `parent_run →runs?`, `provider_session_id?`, `result →records?`, `transcript →records?`, `quarantined* bool`.
- **turns:** `run* →runs`, `number* int`, `invocation* →invocation_receipts`, `domain* →execution_domains`, `started_at*`, `finished_at?`.
- **execution_domains:** `run* →runs`, `invocation* →invocation_receipts`, `status* =DomainStatus`.
- **process_ownership:** `domain* →execution_domains`, `invocation* →invocation_receipts`, `incarnation* →engine_incarnations`, `pgid?`, `pid?`, `pid_start_time?`, `containment_id?`, `descendants []`, `termination_confirmed_at?`.
- **capability_grants:** `run* →runs`, `capabilities* []`, `env_allowlist* []`, `secret_refs []`, `issued_at*`, `expires_at*`, `revoked_at?`.
- **workspaces:** `run* →runs`, `path*`, `base_revision* sha`, `current_base* sha`, `disposition* =WorkspaceDisposition`, `checkpoints [→revisions]`, `snapshot_tree? oid`, `disposed_at?`.
- **leases:** `resource_kind* =LeaseKind`, `resource_id*`, `owner_incarnation* →engine_incarnations`, `generation* int`, `acquired_at*`, `renewed_at*`, `expires_at*`, `released_at?`, `closing* bool`, `cleanup_authority* bool`.
- **revisions:** `sha*`, `lineage* →lineages`, `parent_sha?`, `kind* =RevisionKind`, `created_by_run →runs?`, `recorded_at*`.
- **lineages:** `branch*`, `started_from_candidate →candidates?`, `open* bool`.
- **candidates:** `seq* int`, `revision* sha`, `lineage* →lineages`, `nominated_at*`, `nominated_by* =NominatedBy`, `spec_revision* →spec_revisions`, `architecture_revision* →architecture_revisions`, `nominated_protected_version* →protected_versions`, `progress* =CandidateProgress`, `superseded_by →candidates?`.
- **protected_proposals:** `seq* int`, `proposed_by* =ProposedBy`, `run →runs?`, `base_revision* sha`, `tree_id* oid`, `diff_hash*`, `affected_checks* [→checks]`, `rationale* →records`, `requested_change_kind* =ChangeKind`, `classified_change_kind? =ChangeKind`, `status* =ProposalStatus`, `approver?`, `approver_authority? =Authority`, `resulting_version →protected_versions?`.
- **protected_versions:** `seq* int`, `fingerprint*`, `check_ids* [→checks]`, `change_kind* =ChangeKind`, `proposal →protected_proposals?`, `approved_by*`, `approver_authority* =Authority`, `approved_at*`, `applied_by_operation →operations?`, `authorized* bool`, `effective_from?`, `superseded_by →protected_versions?`.
- **checks:** `key*`, `protected_version* →protected_versions`, `kind* =CheckKind`, `required* bool`, `gate_kinds* [=GateKind]`, `tier_floor? =Tier`, `definition_path*`, `definition_hash*`, `requirement_ids [→requirements]`, `sensitive_areas []`, `phase? int`.
- **check_results:** `check* →checks`, `candidate* →candidates`, `source_revision* sha`, `protected_version* →protected_versions`, `runner_class* =RunnerClass`, `runner_id*`, `environment →environments?`, `artifact_digest?`, `execution_seq* int`, `execution_established* bool`, `signaled* bool`, `deadline_hit* bool`, `exit_status? int`, `output →records?`, `started_at?`, `finished_at?`.
- **acceptance_scopes:** `candidate* →candidates`, `gate_kind* =GateKind`, `operation →operations?`, `attempt →operation_attempts?`, `phase? int`, `stage →stages?`, `spec_revision* →spec_revisions`, `architecture_revision* →architecture_revisions`, `policy_revision* →policy_revisions`, `effective_protected_version* →protected_versions`, `source_revision* sha`, `delivered_requirement_ids* [→requirements]`, `partial_requirement_ids* [→requirements]`, `sensitivity_categories* []`, `required_check_ids* [→checks]`, `runner_classes* {check_id: =RunnerClass}`, `required_signoffs* [{role =Role, scope =SignOffScope}]`, `environment →environments?`, `artifact_digest?`, `evidence_reuse [{check_result →check_results, applicability →records}]`, `validated* bool`, `scope_hash*`, `acceptance_content_hash*`.
- **gate_evaluations:** `scope* →acceptance_scopes`, `candidate* →candidates`, `gate_kind* =GateKind`, `computed_at*`, `inputs_hash*`, `inputs_snapshot* {}`, `check_states* {check_id: =CheckState}`, `outcome* =EvalOutcome`, `reasons* [{code, subjects[]}]`, `satisfiers* []`, `stale* bool`.
- **deployment_authorizations:** `candidate* →candidates`, `environment* →environments`, `artifact_digest*`, `source_delivery_mapping* {dev_revision, delivery_commit, artifact_digest}`, `config_identity*`, `target_set* []`, `policy_revision* →policy_revisions`, `protected_version* →protected_versions`, `evaluation* →gate_evaluations`, `status* =AuthorizationStatus`.
- **deployment_verifications:** `operation* →operations`, `attempt* →operation_attempts`, `deployment_generation* int`, `environment* →environments`, `target_set* []`, `artifact_digest*`, `source_delivery_mapping* {dev_revision, delivery_commit, artifact_digest}`, `config_identity*`, `protected_version* →protected_versions`, `identity_reads* [{target, expected, read, match, at}]`, `behavioral_results* [→check_results]`, `outcome* =DeployVerificationOutcome`, `computed_at*`, `invalidated_at?`.
- **findings:** `seq* int`, `scope* =FindingScope`, `subject_id*`, `candidate →candidates?`, `source_run →runs?`, `source_role? =Role`, `category* =FindingCategory`, `proposed_severity* =Severity`, `effective_severity* =Severity`, `severity_history* [{actor, authority =Authority, from =Severity, to =Severity, at}]`, `sensitive_area?`, `status* =FindingStatus`, `disposition? =Disposition`, `disposition_authority? =Authority`, `disposition_by?`, `disposition_at?`, `linked_issue?`, `defer_target?`, `reevaluations [{evaluation →gate_evaluations, effective_severity =Severity, at}]`, `alpha_exception? {containment_evidence →records, testing_purpose}`, `resolution_verification? {evaluation →gate_evaluations, check_result →check_results}`.
- **applicability_assessments:** `finding* →findings`, `candidate* →candidates`, `proposed_by_run* →runs`, `assessed_by_run →runs?`, `authorized_by?`, `evidence* →records`, `reason*`, `status* =AssessmentStatus`.
- **signoffs:** `candidate* →candidates`, `revision* sha`, `role* =Role`, `scope* =SignOffScope`, `module?`, `run* →runs`, `acceptance_content_hash*`, `recorded_at*`.
- **decisions:** `seq* int`, `kind* =DecisionKind`, `subject_type*`, `subject_id*`, `semantic_generation* int`, `scope*`, `question*`, `options* [{key, label, effect_plan{}, plan_hash, consequence_text}]`, `dependency_manifest* {}`, `transition_schema_version* int`, `preview_hash*`, `evidence* [{record →records, provenance =Provenance}]`, `blocked_while_open* {work_items[→work_items], gate →gate_evaluations?, operation →operations?}`, `raised_at*`, `target_seconds* int`, `escalated_at?`, `batch_key?`, `status* =DecisionStatus`, `answer? {option, note, actor, at}`, `consumed_at?`, `invalidated_reason?`.
- **approvals:** `decision* →decisions`, `actor*`, `consequence*`, `subject_type*`, `subject_id*`, `acceptance_content_hash?`, `result_hash?`, `policy_revision* →policy_revisions`, `protected_delta_shown? [→protected_versions]`, `consumed_at*`.
- **effect_intents:** `decision* →decisions`, `approval →approvals?`, `operation* →operations`, `preconditions* {}`, `status* =IntentStatus`, `invalidated_reason?`.
- **operations:** `seq* int`, `kind* =OperationKind`, `target* {environment →environments?, repo?, ref?, channel? =Channel}`, `subject* {candidate →candidates?, artifact_digest?, release →releases?, issue?, decision →decisions?}`, `idempotency_key*`, `semantic_generation* int`, `deployment_generation? int`, `status* =OperationStatus`, `remaining_scope? {}`, `linked_prior →operations?`, `authorization →deployment_authorizations?`, `deadline_at*`, `finalized_at?`.
- **operation_attempts:** `operation* →operations`, `attempt_number* int`, `status* =AttemptStatus`, `started_at*`, `finished_at?`, `timeline* [{at, event, detail}]`, `reconciliation_reads [{at, read, result}]`.
- **git_journal_events:** `operation* →operations`, `seq* int`, `journal_kind* =JournalKind`, `event_kind* =JournalEventKind`, `payload* {repo, ref?, tree?, old_oid?, new_oid?, run →runs?, lease_generation?, confirmed_oid?}`.
- **git_journal_state:** `operation* →operations`, `journal_kind* =JournalKind`, `state* =JournalState`, `last_event_seq* int`.
- **ref_registry:** `ref*`, `kind* =RefKind`, `expected_oid*`, `immutable* bool`.
- **managed_checkouts:** `kind* =CheckoutKind`, `path*`, `baseline* {head, index_hash, tracked_tree_hash}`, `owner_run →runs?`.
- **notification_intents:** `source* {decision →decisions?, issue?}`, `channel* =Channel`, `key*`, `status* =NotificationStatus`, `attempts* int`.
- **environments:** `name*`, `adapter*`, `adapter_config_ref*`, `verify_spec* {identity_method, behavioral_check_ids[→checks], target_set[]}`.
- **environment_records:** `environment* →environments`, `last_verified? {candidate →candidates, artifact_digest, at, verification →deployment_verifications}`, `attempted? {operation →operations, outcome, at}`, `observed* {condition =ObservedCondition, detail, observed_at?, source, freshness =Freshness, expires_at?}`, `frozen_at?`.
- **observation_history:** `environment* →environments`, `observed_at*`, `source*`, `condition* =ObservedCondition`, `detail?`.
- **observation_jobs:** `environment* →environments`, `cadence_s* int`, `next_due*`, `last_success_at?`, `last_attempt_at?`, `error_class?`.
- **releases:** `version*`, `candidate* →candidates`, `delivery_commit?`, `artifact_digest?`, `source_artifact_mapping? {dev_revision, delivery_commit, artifact_digest}`, `config_identity?`, `promotion_record →promotion_records?`, `allowlist_version?`, `states* {prepared?, published?, staged?, live?}`, `recovery_plan →records?`.
- **invocation_receipts:** `run* →runs`, `turn →turns?`, `provider*`, `model_requested*`, `grant* →capability_grants`, `budget_snapshot* {}`.
- **invocation_status_observations:** `invocation* →invocation_receipts`, `seq* int`, `status* =InvocationStatus`, `at*`.
- **usage_observations:** `invocation* →invocation_receipts`, `seq* int`, `semantics* =UsageSemantics`, `raw* {}`, `at*`.
- **ledger_rows:** `invocation* →invocation_receipts`, `run* →runs`, `turn →turns?`, `role* =Role`, `provider*`, `model_requested*`, `model_observed?`, `raw_usage* {}`, `normalization_version*`, `billable_in? int`, `cached_in? int`, `out? int`, `usage_complete* bool`, `cost_status* =CostStatus`, `cost_usd?`, `day_utc*`, `corrects →ledger_rows?`, `correction_seq? int`.
- **policy_revisions:** `revision* int`, `git_path*`, `git_blob*`, `changed_by*`, `changed_at*`, `diff_summary*`, `widens_authority* bool`, `committed* bool`, `decision →decisions?`.
- **records:** `kind* =RecordKind`, `path?`, `sha256*`, `bytes* int`, `redaction_version*`, `published* bool`, `post_scan* =PostScan`, `post_scan_finding →findings?`, `retain_until?`.
- **stream_chunk_receipts:** `record* →records`, `offset* int`, `length* int`, `sha256*`.
- **out_of_band_changes:** `subject_kind* =IntegritySubject`, `ref →ref_registry?`, `checkout →managed_checkouts?`, `expected*`, `found?`, `detected_at*`, `disposition? =OobDisposition`, `decision* →decisions`.
- **events:** `seq* int`, `at*`, `type* =EventType`, `subject* {}`, `actor_kind* =ActorKind`, `actor_id?`, `request_id?`, `operation →operations?`, `payload* {}`, `tx*`.
- **config:** `scope*`, `project →projects?`, `key*`, `value*`, `revision* int`.
- **mechanic_issues, triage_dispositions, product_intent_contracts, adoption_analyses, export_records, promotion_records:** reserved; no fields until their owning design.

### A.4 Gate reason codes

`ACCEPTANCE_SCOPE_INCOMPLETE`, `PROTECTED_PATH_UNAUTHORIZED`, `PROTECTED_VERSION_NOT_EFFECTIVE`, `OUT_OF_BAND_CHANGE`, `GIT_JOURNAL_PENDING`, `CHECK_NOT_PASSED`, `FINDING_BLOCKING`, `FINDING_UNSATISFIED`, `FINDING_DEFER_EXPIRED`, `SIGNOFF_MISSING`, `APPROVAL_MISSING`, `EVIDENCE_MISSING`, `EXPORT_NOT_VALIDATED`, `ARTIFACT_MAPPING_MISSING`, `PUBLICATION_NOT_SUCCEEDED`, `RECOVERY_PLAN_MISSING`, `DEPLOY_OPERATION_MISSING`, `DEPLOY_VERIFICATION_MISSING`, `DEPLOY_VERIFICATION_UNKNOWN`, `DEPLOY_VERIFICATION_FAILED`. Effect-intent invalidation reason (not a gate reason): `EFFECT_PRECONDITION_CHANGED`.

### A.5 Transition tables

**Run state** (`RunState`): created→claimed; claimed→executing; claimed→finalizing; executing→validating; executing→finalizing; validating→finalizing; validating→proposal_captured; proposal_captured→finalizing; finalizing→ended; finalizing→finalizing.

**Session state** (`SessionState`): allocated→turn_running; turn_running→open_idle; open_idle→turn_running; open_idle→saving; saving→open_idle; open_idle→closing; saving→closing.

**WorkItem** (`WorkItemStatus`), by kind:

| Kind | Transitions |
|---|---|
| stage_build, fix | eligible→claimed→executing→integrating→integrated→verifying→complete |
| verification, review, phase_verification, check_correction | eligible→claimed→executing→complete |
| replan, assessment, adoption_baseline | eligible→claimed→executing→integrating→integrated→complete |
| conformance | eligible→claimed→executing→integrating→integrated→verifying→complete |
| spec_change, triage_accept | eligible→awaiting_decision→complete |
| export, publish, deploy, rollback | eligible→claimed→executing→complete |

Common to every kind: claimed→eligible; claimed→parked; executing→eligible; integrating→eligible; verifying→eligible; executing→parked; integrating→parked; verifying→parked; executing→awaiting_decision; integrating→awaiting_decision; verifying→awaiting_decision; awaiting_decision→executing; awaiting_decision→integrating; awaiting_decision→verifying; claimed→held; executing→held; integrating→held; verifying→held; held→eligible; parked→eligible; eligible→cancelled; claimed→cancelled; executing→cancelled; integrating→cancelled; integrated→cancelled; verifying→cancelled; awaiting_decision→cancelled; held→cancelled; parked→cancelled. Abandon restores `prior_status` (eligible or earlier) and is listed above as the →eligible transitions with `dispatch_hold`. Terminal: complete, cancelled.

**Candidate** (`CandidateProgress`): developing→alpha_deployed; alpha_deployed→beta_deployed; beta_deployed→live.

**Attempt** (`AttemptStatus`): started→succeeded; started→failed; started→ambiguous; ambiguous→reconciled_succeeded; ambiguous→reconciled_absent; ambiguous→reconciled_partial. Operation status derivation: no attempt → intended; latest attempt started → in_progress; latest succeeded or reconciled_succeeded → succeeded; latest failed or reconciled_absent with no further attempt permitted → failed; latest reconciled_partial → partial; latest ambiguous → ambiguous; linked successor recorded → superseded. New attempt permitted only after reconciled_absent or reconciled_partial.

**Decision** (`DecisionStatus`): open→answered; answered→consumed; open→invalidated.

**Intent** (`IntentStatus`): pending→executing; executing→done; pending→invalidated; executing→invalidated.

**Finding** (`FindingStatus`): open→dispositioned; dispositioned→resolved; open→resolved; resolved→open; dispositioned→dispositioned.

**Proposal** (`ProposalStatus`): captured→classified; classified→awaiting_human; classified→approved; awaiting_human→approved; awaiting_human→rejected; classified→rejected; approved→applied.

**Assessment** (`AssessmentStatus`): proposed→assessed; assessed→approved; assessed→rejected; proposed→rejected.

**Journal** (`JournalState`): intended→applied; applied→confirmed; confirmed→finalized; intended→failed; applied→ambiguous; intended→ambiguous.

**Domain** (`DomainStatus`): allocated→launched; launched→terminated; allocated→terminated; launched→quarantined; allocated→quarantined.

**Authorization** (`AuthorizationStatus`): issued→consumed; issued→superseded.

### A.6 Event types

`engine.started`, `engine.tick`, `engine.backup`, `engine.quarantine`, `engine.mode_changed`, `api.act`, `project.created`, `project.adopted`, `project.registered`, `project.paused`, `project.resumed`, `project.retired`, `project.reactivated`, `baseline.spec_approved`, `baseline.architecture_approved`, `baseline.roadmap_revised`, `baseline.plan_approved`, `baseline.plan_refused`, `work.created`, `work.claimed`, `work.advanced`, `work.held`, `work.resumed`, `work.parked`, `work.cancelled`, `work.integrated`, `work.complete`, `run.created`, `run.claimed`, `run.started`, `run.heartbeat`, `run.validating`, `run.proposal_captured`, `run.finalizing`, `run.ended`, `run.quarantined`, `session.allocated`, `session.turn_started`, `session.turn_ended`, `session.saved`, `session.closed`, `domain.terminated`, `domain.quarantined`, `revision.recorded`, `candidate.nominated`, `candidate.advanced`, `candidate.superseded`, `protected.proposed`, `protected.classified`, `protected.approved`, `protected.applied`, `protected.rejected`, `protected.unauthorized_detected`, `check.result`, `gate.scope_built`, `gate.evaluated`, `authorization.issued`, `authorization.consumed`, `authorization.superseded`, `finding.raised`, `finding.severity_changed`, `finding.dispositioned`, `finding.resolved`, `finding.reopened`, `assessment.proposed`, `assessment.assessed`, `assessment.approved`, `assessment.rejected`, `signoff.recorded`, `decision.raised`, `decision.escalated`, `decision.answered`, `decision.consumed`, `decision.invalidated`, `intent.recorded`, `intent.executing`, `intent.done`, `intent.invalidated`, `operation.intended`, `operation.attempt_started`, `operation.succeeded`, `operation.failed`, `operation.partial`, `operation.ambiguous`, `operation.reconciled`, `operation.finalized`, `git.journal_intended`, `git.journal_applied`, `git.journal_confirmed`, `git.journal_ambiguous`, `git.journal_finalized`, `repo.out_of_band`, `repo.reconciled`, `environment.observed`, `environment.observation_missed`, `environment.verified`, `environment.attempt`, `release.prepared`, `release.published`, `release.staged`, `release.live`, `invocation.receipt`, `invocation.status`, `invocation.usage`, `ledger.row`, `ledger.correction`, `policy.changed`, `record.written`, `record.expired`, `record.secret_found`, `record.missing`, `notification.queued`, `notification.sending`, `notification.delivered`, `notification.failed`, `notification.unknown`.

### A.7 Error codes and reason-class mapping

Public codes: `illegal_transition`, `decision_stale`, `decision_consumed`, `decision_invalidated`, `confirm_required`, `store_error`, `engine_starting`, `engine_locked`, `backend_refused`, `isolation_unqualified`, `budget_exhausted`, `repo_unreadable`, `out_of_band_change`, `quarantined`, `host_refused`, `origin_refused`, `token_required`, `token_invalid`, `payload_too_large`, `unknown_field`, `not_found`, `audit_failed`, `diff_violation`, `ref_violation`, `integration_conflict`, `invalid_result`, `scope_incomplete`, `slow_consumer`.

| RunReasonClass | Disposition |
|---|---|
| diff_violation, ref_violation, invalid_result, integration_conflict | public code of the same name on the run's API representation |
| preflight_refused | `backend_refused` or `isolation_unqualified` per the refusal |
| budget | `budget_exhausted` |
| deadline, infra_error, human_stop, human_abandon, recovered, none | reported on the run only; never an API error |

### A.8 Decision kinds: subject, binding, manifest

| Kind | Subject | Approval binds | Dependency manifest | Default target |
|---|---|---|---|---|
| idea_accept, spec_approval, spec_change, architecture_approval, plan_approval | the baseline revision | baseline version | baseline version, policy revision | approvals 2 d; spec_change 3 d |
| check_correction_loosening, check_correction_unclassifiable | protected_proposal | proposal diff hash | proposal tree and diff hash, effective protected version, policy revision | 1 d |
| finding_disposition, severity_lower | finding | acceptance_content_hash of the candidate | finding effective severity, candidate revision, defer target, policy revision | 1 d |
| blocker | work_item or operation or run | none | subject status, quarantine state | 4 h |
| out_of_band_change | out_of_band_change | none | subject kind, expected, found | 4 h |
| rollout_partial | operation | deployment_authorization | operation status, attempt, deployment generation, target observations with generations | 30 m |
| publication_first_visibility, publication_subsequent, allowlist_widening | release or allowlist version | release version or allowlist version | export validation, allowlist version, policy revision | 2 d |
| go_live | deployment_authorization | deployment_authorization | authorization status, recovery plan, protected delta shown | 2 d |
| management_opt_in, triage, adoption_mode, requirement_confirm | project, mechanic_issue, project, requirement | project state | activation evidence, triage policy, issue evidence, requirement text | 2 d |
| stop_confirm, abandon_confirm | run | none | run state, domain status, workspace disposition | none |
| retire, reactivate | project | project state | baseline state, management mode, open work | 2 d |
| policy_widening | policy_revision | policy revision | diff hash, widens_authority | 2 d |

### A.9 Configuration schema

| Key | Scope | Default | Range |
|---|---|---|---|
| `tick_interval` | engine | 30 s | 5–600 s |
| `tick_budget` | engine | 20 s | 5–300 s |
| `tick_step_budget` | engine | 5 s | 1–60 s |
| `lease_ttl` | engine | 90 s | 30–600 s |
| `terminate_grace` | engine | 10 s | 1–60 s |
| `kill_grace` | engine | 5 s | 1–30 s |
| `api_latency_bound` | engine | 250 ms | 50–2000 ms |
| `request_body_deadline` | engine | 10 s | 1–60 s |
| `body_cap`, `upload_cap` | engine | 1 MB, 8 MB | fixed |
| `backup_keep` | engine | 14 | 1–365 |
| `max_concurrent_runs` | engine, project | 2, 1 | 1–8 |
| `max_chained_roles` | project | 1 | 1–6 |
| `preflight_refusals_max` | project | 3 | 1–10 |
| `repair_attempts_max` | project | 3 | 0–10 |
| `no_progress_max` | project | 2 | 1–5 |
| `deadline_builder`, `deadline_verifier`, `deadline_reviewer`, `deadline_architect` | project | 45 m, 30 m, 20 m, 30 m | 5–180 m |
| `session_idle_timeout` | project | 20 m | 1–120 m |
| `record_retention_days` | project | 90 | 7–3650 |
| `observation_cadence` | project | 30 s | 10–3600 s |
| `observation_freshness_bound` | project | 90 s | 30–86400 s |
| `budget_run_billable_tokens` | project | 1,500,000 | 10,000–50,000,000 |
| `budget_day_verified_usd` | project | 40 | 0–10,000 |
| `budget_day_unknown_tokens` | project | 2,000,000 | 0–100,000,000 |
| `protected_paths` | project | `[".surety/checks/"]` | governed, §5.2 |
| `check_commands`, `check_discovery`, `runner_config`, `result_collection`, `required_checks` | project | per D3 | governed, §5.2 |

### A.10 Projection-only fields

Fields that appear in API responses but are computed, never persisted: `served_at` (time the snapshot was read), `snapshot_seq` (the events sequence at that read), `primary_action` and `reason` on the NOW projection (§12.3), per-fact `observed_at`, `source`, `provenance`, and `freshness` on read responses (§11.3), and `delivery` per requirement on a candidate's scope projection (§9.1).
