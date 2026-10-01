# D1. Engine Core: Entities, Runtime Store, API, Scheduler, Events

**Status:** Draft 1 for cross-review by the second architect. Not approved.
**Depends on:** Foundations v1.0 with errata E1–E17 (`sdlc-foundations-v1.1-errata-draft.md`), decisions O8 (product shape), O9 (stack), O10 (reuse).
**Scope:** The engine's durable model and the mechanisms every other design document builds on: identities, entities and their state machines, the runtime store, git operations, the scheduler and leases, the gate function, the attention queue, the local API, the event log, the ledger, records and redaction, the model-invocation choke point, and crash recovery.
**Out of scope:** D2 backend adapter contract, containment, trust table. D3 protected acceptance path, check runner, diff classifier. Later: deployment adapters, export and promotion, Mechanic, adoption tooling, UI package.
**Conventions:** "MUST" is a requirement a test pins. "SHOULD" is a default that policy may change. Section references in parentheses are to Foundations v1.0 or an errata entry.

---

## 1. Process model

**1.1 One engine, many projects.** A single engine process per host (`surety serve`) owns: the runtime store, the scheduler, every child process any run spawns, every git operation on every tracked repository, every model invocation, and every external operation. The CLI (`surety`), the UI, and any automation are clients of the engine's local API and hold no state (O8).

**1.2 Loopback, single operator.** The API binds to `127.0.0.1` only. v1 serves one operator. Multi-operator is deferred (O8).

**1.3 Single writer.** The engine process is the only writer to the runtime store. Startup takes an exclusive lock file in the engine home; a second `surety serve` refuses with a structured error naming the holder's pid and start time.

**1.4 Startup sequence.** (1) Acquire the lock. (2) Open the store, run pending migrations inside one transaction. (3) Recovery (§16): bring every run whose lease is held but whose process is gone to the Stop end state; reconcile every operation left `in_flight` or `ambiguous`. (4) Re-verify the expected HEAD of every tracked branch (§7.6). (5) Start the API. (6) Start the scheduler. Clients connecting during steps 2–4 receive `503 engine_starting` with the step name.

**1.5 Tick.** The scheduler runs one tick every `tick_interval` seconds (default 30). A tick requested by cron, the CLI, or the UI is the same tick: it sets a flag the loop consumes; it never runs scheduler logic in the requester's call. One tick runs at a time.

**1.6 Engine home.** `$SURETY_HOME` (default `~/.surety/`) holds: `store.db` (SQLite), `records/` (transcripts, tool output, captured check output, as files), `backups/`, `engine.lock`, `api.token`, `engine.log`. Nothing under the engine home is ever committed to any repository. Project repositories hold only what Foundations §7.1 names: code, checks, spec, ADRs, roadmap, phase plans, policy.

---

## 2. Identity

**2.1 Global ids.** Every entity has a 26-character time-ordered id (ULID) with a type prefix: `proj_`, `cand_`, `run_`, `turn_`, `ws_`, `rev_`, `pv_`, `chk_`, `cr_`, `gate_`, `fnd_`, `so_`, `dec_`, `op_`, `env_`, `dv_`, `rel_`, `led_`, `lease_`, `ev_`, `pol_`, `grant_`, `oob_`, `wi_`, `stage_`, `req_`.

**2.2 Human numbers.** Within a project, candidates, runs, operations, decisions, findings, protected versions, and work items also carry a per-project sequence number assigned at creation, rendered as `c-0421`, `r-1193`, `op-7731`, `d-88`, `F-212`, `pv-19`, `w-61`. Sequences never reuse a number. The global id is authoritative; the human number is a display and CLI convenience that resolves to exactly one id within a project.

**2.3 Revisions are git SHAs.** A revision is identified by its full commit SHA. The store records the SHA and the lineage it belongs to; git holds the content.

**2.4 Protected versions.** A protected version (`pv-N`) is the per-project sequence number plus the fingerprint: the SHA-256 of the sorted list of `(path, git blob id)` for every file under the protected path roots named in the project policy (§5.2). Any change to that list is a new fingerprint. A fingerprint that does not match a recorded protected version blocks every gate (§5.2).

**2.5 Operation identity.** Every external effect gets an `op_` id and an idempotency key recorded in the store, in a committed transaction, **before** the effect is attempted (§3.7). The key is deterministic for the intended effect: `sha256(kind, target, candidate_or_artifact, attempt_number)`. Adapters receive the key and pass it to any external system that accepts one.

---

## 3. Entity model

Every entity below is a table in the store (§6). Fields marked `*` are required at creation. Timestamps are UTC, millisecond precision. `ref` means a store id; `file ref` means a path under `records/` plus the file's SHA-256.

### 3.1 Project and baseline

| Entity | Key fields | Notes |
|---|---|---|
| **Project** | `id*`, `seq_counters`, `name*`, `tier*` (T1/T2/T3), `dev_repo_path*`, `delivery_repo` (nullable: remote url, visibility private/public, adoption baseline commit), `baseline_state*` (Idea, SpecReady, Retired), `prior_baseline_state` (for Reactivate), `adoption` (nullable: mode full/scoped, pinned revision, size signals, deployment evidence), `management` (mode Live/LiveManaged, health Healthy/Degraded/Unknown, activation evidence ref, triage policy manual/gated), `policy_revision` ref, `paused` bool, `created_at*` | §3.2, §3.5, E6, E16a. Retired is terminal until a human Reactivate. |
| **SpecRevision** | `id*`, `project*`, `version*` (int), `git_path*`, `git_blob*`, `approved_by*`, `approved_at*`, `supersedes` | Content lives in git; the store holds the pointer and approval. A change request produces a new revision only on human approval (§3.8). |
| **ArchitectureRevision** | `id*`, `project*`, `version*`, `spec_revision*`, `git_paths*` (ADRs, module map, sensitivity classification), `approved_by*` (human or `policy:prototype`), `approved_at*` | §3.3, O6. The module map and sensitive-area classification are parsed into **Module** rows. |
| **Module** | `id*`, `project*`, `architecture_revision*`, `name*`, `paths*` (globs), `sensitive_areas` (set of the seven O1 categories), `tier_override` | Drives the sensitivity floor (§5.6) and gated triage (E5). |
| **RoadmapRevision** | `id*`, `project*`, `version*`, `architecture_revision*`, `git_path*`, `phases*` (ordered: number, goal, modules, requirement ids, depends_on) | §3.10.1. Every revision recorded. |
| **PhasePlan** | `id*`, `project*`, `roadmap_revision*`, `phase_number*`, `prepared_against_spec*`, `prepared_against_revision*` (SHA), `git_path*`, `approved_by*` (human, or `engine:within-baseline` per §3.10.6), `stage ids` | §3.10.1, §3.10.6. The engine's mechanical plan check (§3.10.6) runs before `approved_by` is set. |
| **Requirement** | `id*`, `project*`, `spec_revision*`, `key*` (e.g. R-22), `text_ref*`, `assigned_phase`, `status*` (pending, verified, descriptive_unverified), `verified_by` (gate evaluation ref), `confirmed_by` (human, for descriptive) | §3.10.2, E6. `pending` is rendered as pending, never as failed or passed. |
| **Stage** | `id*`, `project*`, `phase_plan*`, `number*`, `goal*`, `modules*`, `requirement ids*`, `status*` (planned, building, integrated, verified), `work_item` ref | §3.10.1, O7. |

### 3.2 Work and runs

| Entity | Key fields | Notes |
|---|---|---|
| **WorkItem** | `id*`, `project*`, `seq*`, `kind*` (stage_build, verification, review, phase_verification, replan, spec_change, check_correction, triage_accept, export, publish, deploy, rollback, adoption_baseline, conformance), `subject` refs (stage, candidate, finding, decision), `status*` (eligible, claimed, executing, verifying, awaiting_decision, integrated, parked, cancelled), `blocker` (nullable: reason, raised_at), `depends_on` (work item ids), `trigger` (what created it; consumed flag), `repair_attempts` (int), `created_at*` | Astra §9.1. A WorkItem is the unit the scheduler dispatches. `trigger.consumed` is set atomically with the WorkItem's successful outcome so the same trigger never dispatches twice (planner-thrash fix, Astra §5.5). |
| **Run** | `id*`, `project*`, `seq*`, `work_item*`, `role*`, `kind*` (one_shot, session), `backend*`, `backend_version*`, `model_requested*`, `model_observed`, `grant*` ref, `workspace` ref, `base_revision*` (SHA), `lease` ref, `parent_run` (for resume), `started_at`, `heartbeat_at`, `deadline_at*`, `finished_at`, `outcome` (completed, failed, refused, timed_out, stopped, abandoned, recovered_stopped), `reason_class`, `reason_text`, `result` file ref (structured result), `transcript` file ref, `usage_status` (reported, partial, unknown), `created_at*` | §3.9, §4.2, E7, E10. One run holds one role (§4.2). `recovered_stopped` is the outcome §16 assigns to a run found dead at startup. |
| **Turn** | `id*`, `run*` (kind session), `number*`, `started_at*`, `finished_at`, `ledger_row*` ref, `transcript_offset` | E10. Sessions meter per turn. |
| **CapabilityGrant** | `id*`, `run*`, `capabilities*` (set, D2 vocabulary), `env_allowlist*` (variable names), `secret_refs` (names only), `issued_at*`, `expires_at*`, `revoked_at` | E1, §3.9.3. Revoked on any run end, including crash recovery. Values of secrets never appear here. |
| **Workspace** | `id*`, `run*`, `path*`, `base_revision*`, `disposition*` (active, retained, discarded), `checkpoints` (revision ids), `validated_diff` file ref, `disposed_at` | E2, E7. Retained on Stop; discarded on Abandon. |
| **Lease** | `id*`, `run*`, `holder_pid*`, `fence*` (monotonic int), `acquired_at*`, `renewed_at*`, `expires_at*`, `released_at` | §8.3. |

### 3.3 Revisions, candidates, protected path

| Entity | Key fields | Notes |
|---|---|---|
| **Revision** | `id*`, `project*`, `sha*`, `lineage*` ref, `parent_sha`, `kind*` (working, checkpoint, engine_commit, nominated, out_of_band), `created_by_run`, `recorded_at*` | E11. The store records every commit the engine makes or observes on tracked branches. |
| **Lineage** | `id*`, `project*`, `started_from_candidate` (nullable), `branch*`, `open*` bool | E11. A lineage opens at the first working revision after a nomination and closes at the next nomination. |
| **Candidate** | `id*`, `project*`, `seq*`, `revision*` (SHA), `lineage*`, `nominated_at*`, `nominated_by` (engine:cadence, builder_request), `spec_revision*`, `architecture_revision*`, `protected_version*` ref, `progress*` (Developing, AlphaDeployed, BetaDeployed, Live), `superseded_by` | §3.3, §3.4, E11. Progress never moves backward (§3.8). |
| **ProtectedVersion** | `id*`, `project*`, `seq*`, `fingerprint*`, `check ids*`, `change_kind*` (initial, tightening, loosening, unclassifiable), `proposed_by_run`, `approved_by*` (reviewer run id, or human), `approved_at*`, `supersedes` | §5.2, §5.3, E13. A fingerprint observed in the repository that matches no row here is **unauthorized** and blocks gates. |
| **Check** | `id*`, `project*`, `key*` (AC-14), `protected_version*`, `kind*` (acceptance, smoke, sensitivity_floor, integration, post_deploy_identity, post_deploy_behavior, security_lint, property, failure_recovery), `required*` bool, `definition_path*`, `definition_hash*`, `requirement ids`, `sensitive_areas`, `phase` | §5.2, §5.6, §5.7, E3. Which checks are required is part of the protected version. |
| **CheckResult** | `id*`, `check*`, `candidate*`, `revision*` (SHA), `protected_version*`, `runner_id*`, `environment` (nullable), `exit_status` (nullable), `state*` (passed, failed, missing, skipped, stale), `started_at`, `finished_at`, `output` file ref, `deadline_hit` bool | E8. State is assigned by §9.2; nothing else writes it. |

### 3.4 Gates, findings, sign-offs, decisions

| Entity | Key fields | Notes |
|---|---|---|
| **GateEvaluation** | `id*`, `project*`, `candidate*`, `gate_kind*` (stage, phase, alpha, beta, live), `environment` (for deployment gates), `computed_at*`, `inputs_hash*`, `inputs_snapshot*` (json), `outcome*` (satisfied, not_satisfied), `reasons*` (list of §9.4 codes with subjects), `satisfiers*` (list of what would satisfy), `stale` bool | E12. Recomputed when any input changes; prior evaluations are kept. |
| **Finding** | `id*`, `project*`, `seq*`, `candidate*`, `source_run*`, `source_role*`, `severity_proposed*`, `severity_current*`, `severity_history` (actor, from, to, at), `sensitive_area` (nullable), `status*` (open, dispositioned, resolved), `disposition` (fix, defer, accept), `disposition_by`, `disposition_at`, `linked_issue`, `defer_target`, `resolved_by` (gate evaluation ref) | §6. Blocking is computed per gate by §9, never stored. |
| **SignOff** | `id*`, `candidate*`, `revision*`, `role*`, `scope*` (candidate, module:<name>), `run*`, `recorded_at*` | §5.7, E12. An input, not a decision. |
| **Decision** | `id*`, `project*`, `seq*`, `kind*` (rollout_partial, finding_disposition, check_correction_loosening, check_correction_unclassifiable, severity_lower, spec_change, architecture_approval, plan_approval, publication_first_visibility, publication_subsequent, allowlist_widening, go_live, management_opt_in, triage, adoption_mode, requirement_confirm, blocker, out_of_band_change, stop_confirm, retire), `question*`, `options*` (list: key, label, consequence_text, consequence_computed json), `binds*` (candidate, revision, gate_kind, operation, finding, protected_version, policy_revision: whichever apply), `evidence*` (refs with provenance observed/claimed/configured), `evidence_hash*`, `blocked_while_open*` (text + refs), `raised_at*`, `target_seconds*`, `escalated_at`, `batch_key` (nullable), `status*` (open, answered, consumed, invalidated), `answer` (option key, note, actor, at), `consumed_at`, `invalidated_reason` | P9, E9. Dedupe key: `(project, kind, binds, evidence_hash)`; an open decision with the same key is never raised twice. |
| **Approval** | `id*`, `decision*`, `actor*`, `consequence*` (text as shown), `revision*`, `result_hash` (parked result hash where one exists), `policy_revision*`, `consumed_at*` | §3.7, Astra §9.7. Written in the same transaction that consumes the decision; one per decision. |

### 3.5 Operations, environments, releases

| Entity | Key fields | Notes |
|---|---|---|
| **Operation** | `id*`, `project*`, `seq*`, `kind*` (push, publish, deploy, rollback, teardown, issue_file, issue_update), `target*` (environment or repo), `subject*` (candidate, artifact, issue), `idempotency_key*`, `recorded_at*`, `started_at`, `finished_at`, `status*` (recorded, in_flight, succeeded, failed, partial, ambiguous, reconciled_succeeded, reconciled_failed, reconciled_partial), `timeline*` (list of at, event, detail), `reconciliation_reads` (list of at, adapter read, result), `attempt*` (int), `deadline_at*` | §3.7, E7. Status leaves `ambiguous` only through a reconciliation read. |
| **Environment** | `id*`, `project*`, `name*` (alpha, staging, production, or custom), `adapter*`, `adapter_config_ref*` (references only), `verify_spec*` (identity read method, behavioral check ids) | §3.6, E3, §10 adapters. |
| **EnvironmentRecord** | `environment*`, `last_verified` (candidate, artifact digest, at, deployment_verification ref), `attempted` (operation ref, outcome, at), `observed` (condition Healthy/Degraded/Down/Unknown, detail, at, source), `frozen_at` (Retired) | §3.6. A failed attempt never writes `last_verified`. `observed.condition` is Unknown whenever the adapter cannot read. |
| **DeploymentVerification** | `id*`, `environment*`, `candidate*`, `operation*`, `identity` (expected revision, read revision, match bool, at), `behavioral` (check result ids), `outcome*` (verified, unknown, failed), `computed_at*` | E3. Written only from engine-run checks through the protected path. |
| **Release** | `id*`, `project*`, `version*`, `candidate*`, `delivery_commit`, `artifact_digest`, `promotion_record` ref, `allowlist_version`, `states` (prepared, published, staged, live: each with at and operation), `recovery_plan` ref | §7.7, Astra §5.13: prepared, published, staged, live are separate facts. |

### 3.6 Ledger, policy, records, events

| Entity | Key fields | Notes |
|---|---|---|
| **LedgerRow** | `id*`, `project*`, `run*`, `turn` (nullable), `role*`, `provider*`, `model_requested*`, `model_observed`, `raw_usage*` (json as reported), `billable_in*`, `cached_in*`, `out*`, `cost_status*` (reported, estimated, unknown, measured_zero), `cost_usd`, `day_utc*`, `recorded_at*` | E16b. Immutable. `measured_zero` is written only for a run that dispatched and reported zero; "no dispatch" has no row. |
| **PolicyRevision** | `id*`, `project*`, `revision*` (int), `git_path*`, `git_blob*`, `changed_by*`, `changed_at*`, `diff_summary*`, `widens_authority*` bool, `committed*` bool | Astra §9.7. The effective policy is the committed file at the recorded blob; the store holds history. |
| **Record** | `id*`, `project*`, `kind*` (transcript, tool_output, check_output, result, raw_user_report, parked_result), `path*` (under `records/`), `sha256*`, `bytes*`, `redaction_version*`, `post_scan` (clean, finding ref), `referenced_by` (counted), `retain_until` | E16c. |
| **OutOfBandChange** | `id*`, `project*`, `branch*`, `expected_sha*`, `found_sha*`, `detected_at*`, `disposition` (discard, adopt), `decision*` ref | E10 §7.8. |
| **Event** | `seq*` (monotonic, store-wide), `id*`, `at*`, `project`, `type*`, `subject*` (refs), `actor*` (engine, human:<name>, run:<id>), `payload*` (json), `tx*` (transaction id) | §12. Append-only. |

### 3.7 Deferred entities

**MechanicIssue**, **TriageDisposition**, **ProductIntentContract** (E5), **AdoptionAnalysis** (E6), **ExportRecord** and **PromotionRecord** (§7) are named here so ids and foreign keys reserve their place; their fields are specified in the documents that own them.

---

## 4. State machines

Each transition is a named function in the engine (§6.3). The tables list the only legal transitions. Anything not listed is refused with `illegal_transition`.

**4.1 Run**

| From | To | Trigger | Writes |
|---|---|---|---|
| created | claimed | scheduler acquires lease | Lease, CapabilityGrant |
| claimed | executing | adapter launch confirmed (process started) | `started_at`, Workspace active |
| executing | executing | heartbeat | `heartbeat_at`, Lease renewed |
| executing | validating | adapter returns structured result | result Record |
| validating | completed | diff validation passes (§7.3) | engine commit(s), Revision rows, WorkItem advance |
| validating | failed | diff validation fails, or result invalid | `reason_class` (diff_violation, invalid_result, …) |
| executing | failed | adapter reports infra error, or result contradicts transcript | `reason_class` |
| executing | timed_out | `deadline_at` passed | process tree terminated, then as Stop |
| created, claimed | refused | adapter preflight refuses (E1 invariant 3) | `reason_class`, no model spend |
| executing, validating | stopped | human Stop | §4.5 end state, Workspace retained |
| executing, validating | abandoned | human Abandon | §4.5 end state, Workspace discarded |
| any non-terminal | recovered_stopped | startup recovery (§16) | §4.5 end state |

Terminal: completed, failed, refused, timed_out, stopped, abandoned, recovered_stopped. A terminal run never changes again.

**4.2 WorkItem**

| From | To | Trigger |
|---|---|---|
| eligible | claimed | scheduler selects it |
| claimed | executing | its Run reaches executing |
| executing | verifying | Run completed and the item's kind calls for verification next |
| executing, verifying | awaiting_decision | a Decision was raised that blocks this item |
| awaiting_decision | executing / verifying / eligible | the Decision is consumed (per its consequence) |
| verifying | integrated | gate satisfied and engine integration committed |
| executing, verifying | eligible | Run failed or stopped and `repair_attempts` < policy max |
| executing, verifying | parked | repair attempts exhausted, repeated unchanged findings, or budget exhausted (§5.8 blocker) |
| any non-terminal | cancelled | human cancels, or project Retired |
| parked | eligible | human resolves the blocker |

**4.3 Candidate progress:** Developing → AlphaDeployed → BetaDeployed → Live, each only through a satisfied GateEvaluation of the matching kind **and** a verified DeploymentVerification for deployment gates (§3.3, E3). No backward transition exists. `superseded_by` is set when a later candidate on the same lineage is nominated; it does not change progress.

**4.4 Operation:** recorded → in_flight → (succeeded | failed | partial | ambiguous). `ambiguous` → reconciled_succeeded | reconciled_failed | reconciled_partial, only by a reconciliation read. A retry is a **new** Operation with `attempt + 1` and the same idempotency key, created only after the prior one is reconciled or failed (§3.7).

**4.5 Stop end state** (E7 §3.9.2). Reached by Stop, Abandon, timed_out, and recovery. The engine, in order: terminates the run's process group and waits for exit with a bounded deadline, then kills; writes a LedgerRow from whatever usage the adapter reported with `cost_status` as appropriate and `usage_status = partial|unknown`; sets Workspace disposition; revokes the CapabilityGrant; releases the Lease; marks any Operation the run was waiting on as `ambiguous` if it was in flight; writes the Run outcome; emits events. All in one transaction except the process termination, which precedes it. If the process cannot be confirmed dead within the deadline, the Run is still moved to the end state and an `orphan_process` event is emitted with the pid for the operator.

**4.6 Decision:** open → answered → consumed (same transaction as the consequence's writes). open → invalidated when any bound revision moves, bound evidence hash changes, or the subject reaches a terminal state by another path; invalidation re-raises a fresh Decision if the question still applies. open → open with `escalated_at` when age exceeds `target_seconds`.

---

## 5. What lives where

**5.1 In the project's git repository** (committed, canonical, §7.1): source; `.surety/spec/` (spec revisions); `.surety/adrs/`; `.surety/architecture/` (module map, sensitivity classification); `.surety/roadmap/`; `.surety/phases/`; `.surety/checks/` (the protected path roots; D3); `.surety/policy.json`; `.surety/project.json` (project id, name, tier; the identity lock). The engine commits every one of these (E2); no role has a commit path.

**5.2 Protected path roots** are listed in `.surety/policy.json` under `protected_paths` and default to `[".surety/checks/"]`. The fingerprint (§2.4) covers every file under those roots. Changing `protected_paths` itself is a policy change that widens or narrows authority and requires human confirmation.

**5.3 In the runtime store** (§6): everything in §3. Never committed. Backed up (§6.5).

**5.4 In `records/`:** transcripts, tool output, check output, structured results, parked results, raw user reports. Redacted at write (§14). Referenced from the store by path and hash.

**5.5 Nowhere:** secret values. The store and records hold secret **references** (names). Resolution happens inside the engine at dispatch (D2) and the resolved value is handed to the child process through the constructed environment and nothing else.

---

## 6. Runtime store

**6.1 Engine.** SQLite, WAL mode, `synchronous=NORMAL`, foreign keys on, one connection owned by the engine process. Driver: `better-sqlite3`, pinned, the engine package's only runtime dependency (O9). The store module exposes one interface (`open`, `transaction`, `migrate`, `backup`, `exportJsonl`) so the driver can be replaced by Node's built-in SQLite module when it is stable.

**6.2 Schema.** One table per entity in §3 with the listed fields, plus `events`. Every table has `id TEXT PRIMARY KEY`, `project TEXT` (indexed), `created_at`. Unique constraints: `(project, seq)` per sequenced entity; `operations.idempotency_key`; `(decision.project, decision.dedupe_key) WHERE status='open'`; `lineages (project, branch) WHERE open=1`; `leases.run`. `ledger_rows` and `events` have no UPDATE or DELETE path in the engine; a database trigger refuses both.

**6.3 Transitions are functions.** No code outside `engine/store/transitions/` writes to the store. Each transition function: takes the current entity row(s) and an intent; checks the legal-transition table (§4); performs all writes and appends its Event rows **inside one transaction**; returns the new rows. A transition that would touch an external system (git, adapter, process) performs the external step **before** the transaction for reads, and records an Operation **before** the external step for writes (§2.5), then commits the outcome after. Crash between the Operation record and the outcome commit leaves the Operation `recorded`/`in_flight`, which §16 reconciles.

**6.4 Migrations.** Numbered SQL files applied in order inside one transaction at startup; the applied list is a table. A migration that cannot apply stops startup with the failing file named. Downgrade is not supported; backups are the rollback.

**6.5 Backup and export.** `surety store backup` uses the SQLite online backup API to write `backups/store-<utc>.db`; the scheduler runs it daily at a configurable hour and keeps N (default 14). `surety store export` writes every table as JSONL for portability. Neither includes `records/` by default; `--with-records` copies them. A fresh engine home does not inherit another's store; migration between hosts is backup plus records copy.

**6.6 Fail closed.** Any store error during a budget check, gate computation, lease operation, or decision consumption fails the operation with `store_error`. There is no fallback to a cached or file-based value (ADR-0036 lesson).

---

## 7. Git operations

**7.1 The engine performs git** (E2). Every git command is spawned by the engine with an argument array, never a shell string, with a constructed environment that strips `GIT_*`, `GH_*`, and editor variables (Astra A16), and with an explicit `--git-dir` and `--work-tree` resolved from the **execution context** (§7.2). A deadline applies to every git invocation (default 60 s; clone and fetch 600 s).

**7.2 Execution context.** One resolved object is built per run and per engine-initiated git or adapter call, and every audit record names it: `{project, repo_root, git_dir, worktree_path, branch, base_sha, delivery_substrate, credential_scope, child_env}`. It is resolved once from the Project row and the policy, validated (paths exist, `repo_root` is a git repository whose `.surety/project.json` id matches the Project), and refused if any field cannot be resolved. Ambient cwd and ambient environment never enter it.

**7.3 Workspace lifecycle.** For every run that may edit files: `git worktree add --detach <ws_path> <base_sha>` under the engine home's `workspaces/<run id>/`; the protected path roots are materialized read-only where the backend supports it (D2); the run executes; on result, the engine computes `git diff --no-ext-diff base..working-tree` plus untracked files, then validates:

1. **Role prohibitions** (§4.1, E2): paths the role may not modify are compared against the diff; any hit rejects the run whole with `diff_violation` and the offending paths.
2. **Protected path**: for every role except the Verifier acting under a §5.3 proposal, any change under `protected_paths` rejects. For the Verifier, the change is captured as a **proposal** (D3) and never committed to the integration branch directly.
3. **Containment**: no symlink pointing outside the worktree; no path containing `..`; no change to `.git`; no change to `.surety/project.json`.
4. **Refs**: `git for-each-ref` before and after must match; any ref the role created or moved rejects (`ref_violation`).
5. **Size and kind caps** per policy (default 50 MB diff, binaries allowed only under paths policy lists).

On pass, the engine stages and commits in the worktree with a structured message (§7.4), records a Revision (`engine_commit`), and integrates (§7.5). On fail, the worktree is retained for inspection, the Run fails, and the WorkItem returns to eligible or parks per §4.2.

**7.4 Commit messages.** First line from the role's structured result (the role proposes; the engine prefixes the work item): `w-61 stage 6: export service and CSV endpoint`. Trailers always present: `Surety-Run: r-1193`, `Surety-Role: builder`, `Surety-Base: <sha>`, `Surety-WorkItem: w-61`, `Surety-Kind: engine_commit|checkpoint|intent`. A checkpoint's first line is `checkpoint r-1193: <role summary>`.

**7.5 Integration.** Serial per project in v1 (Astra §4.3). Under the project's release lock (an in-process mutex plus a `leases` row of kind `integration`), the engine: re-verifies the integration branch HEAD equals the recorded expected HEAD (§7.6); fast-forwards if the base is HEAD; otherwise rebases the run's commits onto HEAD in a scratch worktree, re-runs diff validation on the rebased result, and fast-forwards. A rebase conflict fails the run with `integration_conflict` and the WorkItem returns to eligible with a note; no agent resolves conflicts in v1. After integration the engine records the new expected HEAD.

**7.6 Out-of-band detection** (E10 §7.8). After every engine git operation the engine stores `expected_head[branch]`. At every tick, before any dispatch or integration on a project, and before any gate computation, the engine reads the real HEAD of each tracked branch. A mismatch writes an OutOfBandChange, raises a Decision (`out_of_band_change`) with options discard (reset the branch to the expected SHA, keeping the stray commits on a `surety/oob/<n>` ref) or adopt (record the stray commits as `out_of_band` Revisions, invalidate every GateEvaluation and CheckResult on the affected lineage, open a new lineage), and blocks every gate on that lineage until consumed.

**7.7 Nomination** (E11). The engine nominates at the §5.6 cadence by: recording the Candidate with the current protected version; tagging `surety/cand/<seq>` at the SHA (a convenience; the store row is authoritative); closing the open lineage and opening the next one at the next working revision. A Builder's nomination request at T1 is a structured result field; the engine, not the Builder, performs it.

**7.8 Intent artifacts.** Spec drafts, ADRs, roadmaps, phase plans, assessments, and Mechanic records produced by roles are written in the role's workspace under `.surety/...` and committed by the engine as `Surety-Kind: intent` on the integration branch, after the same validation (§7.3) with the role's own path allowances (ADR-0033 lesson).

---

## 8. Scheduler and leases

**8.1 Tick algorithm.** One tick, in order, each step bounded by a deadline:

1. **Recover** (cheap): any Lease whose `expires_at` passed and whose process is not alive → Stop end state (§4.5).
2. **Reconcile**: every Operation `ambiguous` or `in_flight` past its deadline → adapter `reconcile(op)` → status update. Never retries inside this step.
3. **Repository integrity**: §7.6 for every project not Retired.
4. **Decisions**: age every open Decision; escalate those past target (§10.4); invalidate those whose bindings moved (§4.6).
5. **Gates**: recompute any GateEvaluation marked stale (§9.5).
6. **Select**: for each project not paused and not Retired, in priority order: WorkItems whose kind is a verification due (stage, candidate, phase) → builds → replans → everything else; within a class, oldest eligible first. Skip any item whose `depends_on` are not integrated, whose project has an open blocker Decision of kind `out_of_band_change`, or whose budget check (§13.3) fails.
7. **Dispatch**: up to `max_concurrent_runs` (default 1 per project, 2 engine-wide) selected items → create Run, acquire Lease, issue CapabilityGrant, build execution context, call the adapter (D2). Dispatch failures (preflight refusal) write the Run as `refused` with no spend.
8. **Heartbeat**: emit `engine.tick` with counts and the next tick time.

**8.2 Eligibility is computed, never prompted.** A trigger (a spec approval, a stage reaching eligible, a finding needing fix) creates a WorkItem once; the WorkItem's `trigger.consumed` is set in the same transaction as its successful outcome. A trigger that is already consumed creates nothing (Astra §5.5, A11).

**8.3 Leases.** A Lease carries a fencing token (monotonic per project). Adapters and transition functions that act on behalf of a run receive the token and the store refuses any write for a run whose current lease token is higher (a replaced holder cannot apply late effects, Astra §9.5). Renewal happens on every adapter heartbeat and at least every `lease_ttl/3` (default ttl 90 s). The engine's own process is the only holder in v1; the mechanism exists so that recovery and any future second worker are correct by construction.

**8.4 Pause and Stop** (E7). Project `paused` makes step 6 skip the project; running work completes. Stop and Abandon act on one Run through §4.5 and are available through the API at any time, including during a tick.

**8.5 Deadlines.** Every Run has `deadline_at` from policy per role (defaults: Builder 45 m, Verifier 30 m, Reviewer 20 m, Architect 30 m, sessions idle-timeout 20 m). Every adapter call and every git call has a deadline. Every tick step has a deadline; a step that overruns is abandoned for this tick, logged, and the tick continues with the next step so a slow adapter cannot stall decisions or recovery.

---

## 9. Gate function

**9.1 Signature.** `evaluateGate(project, candidate, gate_kind, environment?) → GateEvaluation`. Pure over a snapshot of store rows read in one transaction; the snapshot and its hash are stored on the evaluation. Deterministic: same snapshot, same result.

**9.2 Check state assignment** (E8). For each Check `required` in the candidate's protected version and applicable to `gate_kind` (by kind and phase):

- No CheckResult for `(check, candidate.revision)` → **missing**.
- Latest CheckResult's `protected_version` ≠ candidate's protected version, or its `revision` ≠ candidate's revision → **stale**.
- Latest CheckResult's runner reported "not executed" → **skipped**.
- Latest CheckResult has `exit_status` 0 → **passed**; any other exit status, or `deadline_hit` → **failed**.

The check runner (D3) writes `exit_status` and the raw runner report; this function derives `state`. A runner whose report cannot distinguish executed from not executed is rejected at runner registration (D3), so **skipped** here always comes from an explicit runner signal.

**9.3 Inputs evaluated**, in order, all required:

1. Protected version authorized: the repository's current fingerprint for the candidate's revision matches a ProtectedVersion row. Else `PROTECTED_PATH_UNAUTHORIZED`.
2. No open OutOfBandChange on the lineage. Else `OUT_OF_BAND_CHANGE`.
3. Every applicable required Check is **passed**. Else one `CHECK_NOT_PASSED(check, state)` per check.
4. No Finding on the candidate is blocking for this gate kind under §6.1 (severity ladder, Alpha exception, sensitivity floor). Else `FINDING_BLOCKING(finding, severity)`.
5. Every nonblocking Finding has a recorded disposition, and no deferred Finding's `defer_target` has passed. Else `FINDING_UNDISPOSITIONED(finding)` or `FINDING_DEFER_EXPIRED(finding)`.
6. Every SignOff the tier requires for this gate (§5.7: Reviewer candidate-level at T2; per-module at T3; security review at T3) exists for `candidate.revision`. Else `SIGNOFF_MISSING(role, scope)`.
7. For `alpha`, `beta`, `live`: a DeploymentVerification for `(environment, candidate)` with outcome verified. Else `DEPLOY_VERIFICATION_MISSING` or `DEPLOY_VERIFICATION_FAILED(detail)`. (At evaluation time before a deploy this reason is expected; the UI renders it as "runs after deploy".)
8. Every human approval the floor or policy requires for this gate (§9.1, §7.5, §3.3) is a consumed Decision bound to `candidate.revision`. Else `APPROVAL_MISSING(kind)`.
9. For `beta`: export validated and publication Operation succeeded for this candidate. For `live`: a recorded recovery plan. Else `EXPORT_NOT_VALIDATED`, `PUBLICATION_NOT_SUCCEEDED`, `RECOVERY_PLAN_MISSING`.

`outcome = satisfied` iff the reason list is empty.

**9.4 Reason codes** are the closed set above. Each carries its subject ids. The `satisfiers` list is derived from reasons by a fixed mapping ("AC-14 passes, or its correction is approved and re-run" for `CHECK_NOT_PASSED` with an open loosening proposal; "re-run at pv-19" for stale; and so on). The UI renders both lists verbatim.

**9.5 Staleness and recomputation.** Any write to a CheckResult, Finding, SignOff, DeploymentVerification, ProtectedVersion, OutOfBandChange, or Decision bound to the candidate marks the candidate's evaluations stale; the next tick, and any API read of the gate, recomputes. Evaluations are retained; the UI shows the latest and may show history.

**9.6 Consequences use the same function.** A Decision's `consequence_computed` for each option is produced by evaluating the gate against a hypothetical snapshot with that option applied (for example, a disposition recorded, or a protected version approved). The text shown to the human is generated from the resulting reason delta, never hand-written per screen (E12, console lesson).

---

## 10. Attention queue

**10.1 Raising.** Only transition functions raise Decisions, and only for the kinds enumerated in §3.4. Each kind has a fixed question template, a fixed option set, a `target_seconds` from policy per kind (defaults: rollout 30 m, blocker 4 h, finding disposition 1 d, check correction 1 d, approvals 2 d, spec change 3 d), and a binding rule (which refs it binds to). The `evidence` list carries each ref with its provenance tag: `observed` (engine-read), `claimed` (agent-produced), `configured` (policy echo).

**10.2 Never twice.** The dedupe key `(project, kind, binds, evidence_hash)` is unique among open Decisions. A transition that would raise a duplicate attaches nothing and returns the existing Decision.

**10.3 Consolidation** (E9). Decisions that bind to the same `(candidate, revision, gate_kind)` share a `batch_key` and are presented as one item with sub-decisions; each is answered and consumed as its own row. Independent Decisions may be answered in one API call (§11.5) and are consumed in one transaction only if all succeed.

**10.4 Aging and escalation.** At each tick, an open Decision past `target_seconds` gets `escalated_at` set and an `decision.escalated` event; the project's external channel (Section 8 channel: email, Webex, or webhook) receives one notification per escalation, never repeated for the same Decision. Urgent Mechanic escalations bypass the target and notify immediately (§8).

**10.5 Answering** (§3.7, Astra §9.7). An answer names the Decision id, the option key, an optional note, and the `evidence_hash` the client displayed. The transition: checks `status = open`; checks the supplied hash equals the stored hash (else `decision_stale`, and the client must re-read); checks every bound revision still equals the recorded one (else invalidates and returns `decision_invalidated`); writes the Approval row where the kind is an approval; applies the consequence through the owning transition (disposition, protected version approval, operation creation, policy change…); marks the Decision consumed; emits events. One transaction. A second answer to a consumed Decision is refused with `decision_consumed` and performs nothing (A07).

**10.6 Blocked-while-open.** Each Decision records what it blocks: the WorkItems moved to `awaiting_decision`, the gate it holds, the Operation it holds. The queue item shows that list; §8.1 step 6 honours it.

---

## 11. Local API

**11.1 Transport.** HTTP/1.1 on `127.0.0.1:7227` (configurable). Server-sent events for streams. JSON bodies, `Content-Length` required, body cap 1 MB (spec upload endpoints 8 MB). `Host` must be `127.0.0.1`, `localhost`, or `[::1]` with the configured port; anything else is refused before routing (DNS-rebinding lesson). Mutating requests require the `X-Surety-Token` header equal to the contents of `api.token` (mode 0600, generated at first start) **and** an `Origin` header that is absent or loopback. Every mutating request writes an audit event (`api.act`) including refusals, with the token redacted.

**11.2 Versioning.** All routes under `/v1/`. The response schema is the file `packages/engine/api/schema.json`; the UI package imports its generated types; a contract-pin test fails if a route's output drifts from the schema (console lesson: the contract is mirrored locally).

**11.3 Reads.** Every read response carries `observed_at` (when the engine read its inputs), `source` (`store`, `derived`, `adapter:<name>`), and for each field that reflects a reading, a provenance tag `observed | claimed | configured`. Reads never trigger adapter calls; they serve the store. The scheduler is what reads adapters.

| Route | Returns |
|---|---|
| `GET /v1/engine` | version, uptime, tick interval, next tick, leases held, backends qualified (from D2), store size, last backup |
| `GET /v1/projects` | list with lifecycle, NOW state, open decision count, running run summary, spend today |
| `GET /v1/projects/:p` | the combined projection: NOW (§12.3), baseline, candidates (nominated only), environments (three facts each), management, execution status, spend |
| `GET /v1/projects/:p/decisions` | open Decisions, consolidated by `batch_key`, each with options and computed consequences |
| `GET /v1/projects/:p/decisions/:d` | one Decision with evidence refs resolved to records |
| `GET /v1/projects/:p/candidates/:c` | candidate, lineage, latest evaluations per gate kind |
| `GET /v1/projects/:p/candidates/:c/gates/:kind` | GateEvaluation with reasons, satisfiers, inputs snapshot, protected-version delta since last human-reviewed version (E13) |
| `GET /v1/projects/:p/work` | WorkItems by status, phase plan with stages |
| `GET /v1/projects/:p/runs/:r` | Run with liveness (elapsed, last activity age, turn, budget used), workspace, grant (names only) |
| `GET /v1/projects/:p/runs/:r/tail` | SSE: engine-captured output tail, from offset |
| `GET /v1/projects/:p/environments` | EnvironmentRecords with host detail where the adapter supplies it, operations in flight |
| `GET /v1/projects/:p/releases` | Releases with their four states |
| `GET /v1/projects/:p/ledger?day=` | LedgerRows and per-role totals; verified and unknown reported separately |
| `GET /v1/projects/:p/policy` | effective policy, revision, committed flag |
| `GET /v1/events?since=<seq>&project=` | SSE: Event rows from `seq`, then live. Reconnect with the last seq |

**11.4 Commands.** Each is one transition function; each response returns the resulting rows and the events emitted.

| Route | Effect |
|---|---|
| `POST /v1/projects` | create from an idea record; `POST /v1/projects/adopt` with repo path and mode (E6) |
| `POST /v1/projects/:p/tick` | request a tick (flag only) |
| `POST /v1/projects/:p/pause`, `/resume` | §8.4 |
| `POST /v1/projects/:p/retire`, `/reactivate` | E16a, raises the `retire` Decision first |
| `POST /v1/projects/:p/decisions/:d/answer` | §10.5; body `{option, note?, evidence_hash}` |
| `POST /v1/projects/:p/decisions/answer-batch` | list of the above; all-or-nothing |
| `POST /v1/projects/:p/runs/:r/stop`, `/abandon` | §4.5; body `{confirm_consequence: "<text shown>"}` must equal the engine's consequence text for this run |
| `POST /v1/projects/:p/work/:w/cancel` | §4.2 |
| `POST /v1/projects/:p/policy` | full policy object; the engine validates, computes the diff, and if `widens_authority` returns `409 confirm_required` with the diff until the request carries `confirm: <diff hash>`; on success commits the file (E2) and records a PolicyRevision |
| `POST /v1/projects/:p/sessions` | open a session Run for an interactive role (E10); `POST …/sessions/:r/turns` sends a turn; `POST …/sessions/:r/close` |
| `POST /v1/projects/:p/spec/change-requests` | starts the §3.8 workflow (Spec Writer session, impact analysis, Decision) |

**11.5 Errors.** Every refusal is `{code, reason, what_to_do, subject}` with a closed set of codes (`illegal_transition`, `decision_stale`, `decision_consumed`, `decision_invalidated`, `confirm_required`, `store_error`, `engine_starting`, `backend_refused`, `budget_exhausted`, `repo_unreadable`, `out_of_band_change`, `host_refused`, `token_required`). HTTP status is secondary to `code`.

**11.6 CLI.** `surety` is a thin client over the same routes: `surety status`, `surety decisions`, `surety answer d-88 rollback`, `surety stop r-1193`, `surety tick`, `surety policy set …`, `surety serve`, `surety store backup|export`. It prints JSON with `--json`, else a readable projection of the same fields. It never reads the store directly except `surety store …` commands, which refuse to run while an engine holds the lock.

---

## 12. Event log and projections

**12.1 Events.** Append-only, store-wide monotonic `seq`, written in the same transaction as the change they describe. Types (closed set, extended by amendment): `project.created|adopted|paused|resumed|retired|reactivated`, `baseline.spec_approved|architecture_approved|roadmap_revised|plan_approved|plan_refused`, `work.created|claimed|advanced|parked|cancelled|integrated`, `run.created|claimed|started|heartbeat|validating|completed|failed|refused|timed_out|stopped|abandoned|recovered`, `revision.recorded`, `candidate.nominated|advanced|superseded`, `protected.proposed|approved|unauthorized_detected`, `check.result`, `gate.evaluated`, `finding.raised|severity_changed|dispositioned|resolved`, `signoff.recorded`, `decision.raised|escalated|answered|consumed|invalidated`, `operation.recorded|started|succeeded|failed|partial|ambiguous|reconciled`, `environment.observed|verified|attempt`, `release.prepared|published|staged|live`, `ledger.row`, `policy.changed`, `repo.out_of_band|reconciled`, `record.written|secret_found`, `engine.started|tick|backup|orphan_process`, `api.act`.

**12.2 Projections derive from entities, not from events.** `GET /v1/projects/:p` is computed from current rows in one read transaction; the event log is the audit trail and the UI's live feed, not the state. Every projection names its inputs and their `observed_at`.

**12.3 NOW.** Exactly one of, by fixed priority (console lesson): `refused` (the engine cannot act on this project: repo unreadable, store error, out-of-band change unresolved) → `waiting_on_you` (any open Decision) → `running` (any Run executing) → `ready` (eligible work exists and dispatch is possible at the next tick) → `idle` (nothing eligible). `unknown` replaces any of these when the store read itself fails, and `loading` is a client-side state only. The projection carries `primary_action` (the engine's chosen next action for the human, with its route and consequence text) and `reason` (one sentence generated from the same inputs).

**12.4 Execution status** (§3.1) is a separate field set: runs by state, sessions open, paused flag, blockers, last tick, next tick.

---

## 13. Ledger and budgets

**13.1 Rows.** One LedgerRow per one-shot Run and per session Turn, written in the Run's or Turn's terminal transaction, or in the Stop end state with `usage_status` reflecting what was reported. `cost_status`: `reported` when the provider gives a figure; `estimated` when the adapter computes from a published price table with the table version recorded; `unknown` when neither; `measured_zero` only for a dispatched run that reported zero.

**13.2 Normalization.** `billable_in` excludes cache reads; `cached_in` is reported separately; `out` is output tokens. The raw usage object is kept verbatim. Totals shown anywhere present verified and unknown separately and never sum unknown as zero.

**13.3 Budget checks** (E16b). At dispatch and between session turns: per-run billable limit, per-day verified-dollar limit, per-day unknown-token bound, repair attempts per WorkItem. A failed check refuses dispatch (`budget_exhausted`), stops a session at the turn boundary, and parks the WorkItem with a blocker Decision. Checks are soft: a run already executing is not interrupted by a budget; its deadline bounds it. A store error during a check is a refusal, never a pass (§6.6).

---

## 14. Records, redaction, retention

**14.1 Write path.** Every transcript, tool output, check output, structured result, and raw user report passes through one `records.write(kind, stream)` function that: streams through the redactor; writes to `records/<project>/<run or subject>/<kind>-<n>`; computes the SHA-256; inserts the Record row; emits `record.written`.

**14.2 Redactor.** Pattern set per configured provider (API key shapes, OAuth token shapes) plus every secret **reference name** the engine holds resolved to its value at write time inside the engine only, matched literally and replaced with `[redacted:<ref name>]`. The pattern set version is recorded on the Record. A post-write scan with the same set runs on the stored bytes; a hit raises a Critical Finding on the project (E16c) and emits `record.secret_found`.

**14.3 Retention.** A Record is retained while any Finding, Approval, GateEvaluation, DeploymentVerification, or Release references it. `retain_until` is set from policy for unreferenced records (default 90 days). A daily job deletes expired records and emits `record.expired`; the Record row is kept with `path = null`.

**14.4 Never in prompts.** Records enter an agent's context only through the engine's scoped context package (§3.10.8); raw user reports never do (E5).

---

## 15. Model-invocation choke point

**15.1 One function.** `invoke(run, prompt_package) → result` in `engine/invoke/`. It: builds the execution context (§7.2); resolves the CapabilityGrant; selects the adapter from the trust table (D2) and refuses if the backend, version, and mode are not qualified (E1); constructs the child environment from the grant's allowlist with secrets resolved (§5.5); opens the ledger row; starts the transcript Record; launches through the adapter with the prompt delivered as data (stdin or file, never a shell string; A21); forwards heartbeats to the Lease; enforces the deadline; collects the structured result; validates it against the result schema and against the transcript (a success claim that contradicts a transcript failure is `invalid_result`); writes the ledger row; closes records; returns.

**15.2 Sessions** (E10). `session.open(project, role)` creates a Run of kind session, grant, and context once. `session.turn(run, input)` performs one invocation through the same path with the backend's session-continuation mechanism (D2), writing a Turn and a LedgerRow. `session.close` commits intent artifacts (§7.8), revokes the grant, releases the lease, and ends the Run. Idle timeout closes it from the scheduler.

**15.3 No other path.** The UI and CLI cannot invoke a backend. Any code path that spawns `claude` or `codex` outside `engine/invoke/` fails a repository lint test.

---

## 16. Crash recovery

**16.1 At startup** (§1.4 step 3), in one pass:

1. For every Run with a Lease row not released: read `holder_pid`; if the pid is not alive, or is alive but is not a child of this engine (pid reuse check by start time), apply the Stop end state (§4.5) with outcome `recovered_stopped`. If the pid is a live child from a previous engine instance (possible only on an unclean restart of the engine with children orphaned), terminate it first.
2. For every Operation `in_flight` or `recorded` without a terminal status: mark `ambiguous`, then call the adapter's `reconcile(op)` with a deadline; apply the result (`reconciled_*`). If the adapter cannot read, the Operation stays `ambiguous` and a `blocker` Decision is raised naming it; nothing retries.
3. For every Workspace `active` whose Run is now terminal: set disposition `retained` and emit an event; nothing is deleted at startup.
4. Mark every GateEvaluation stale; recompute lazily.
5. Re-verify expected HEADs (§7.6).

**16.2 Invariant tested by scenario A17 and A18:** after a kill of the engine at any point during a run, during an integration, or during an operation, a restart results in: no lease held, no grant live, a ledger row for the run with the correct `usage_status`, the workspace retained, every operation either terminal or `ambiguous` with a Decision, and no duplicate external effect.

---

## 17. Security invariants

Each is pinned by a test named after it.

1. The API binds to loopback only; `Host` not in the allowlist is refused before routing.
2. Mutations require the token and a loopback or absent `Origin`.
3. Prompts and arguments reach every child process as data; no shell string is ever built from role, user, or record content.
4. Child environments are constructed from the grant's allowlist; the engine's own environment is never inherited.
5. Secret values exist only inside `invoke` between resolution and child start; the store, records, events, API responses, and logs contain references only, and the redactor is applied to every record and every log line.
6. Diff application enforces path containment, symlink containment, ref immutability, and protected-path exclusion for every role.
7. Every external effect has an Operation recorded before execution and is reconciled before any retry.
8. Only passed check results satisfy a gate; no API, policy, or transition can write `passed`.
9. A Decision is consumed at most once; a stale or moved Decision cannot be consumed.
10. Ledger rows and events are append-only at the database level.
11. The engine refuses any backend, version, or mode without a trust-table entry.
12. Nothing under the engine home is ever written into a project repository.

---

## 18. Acceptance scenarios for D1

Each becomes an integration test against a real SQLite store, real git repositories in temp dirs, and a fake adapter that scripts process behavior (real-binary lanes are D2's).

| ID | Scenario | Required result |
|---|---|---|
| D1-01 | Two runs of the same role in one tick | Distinct `run_` ids, transcripts, ledger rows (A05) |
| D1-02 | Branch switch, rebase, squash after several runs | Ledger and events unchanged; store is branch-independent (A06) |
| D1-03 | Answer a Decision twice | Second answer refused `decision_consumed`; one Approval row (A07) |
| D1-04 | Candidate revision moves after a Decision is raised | Decision invalidated, re-raised if still applicable; old answer cannot apply (A08) |
| D1-05 | Trigger that already produced a WorkItem fires again | No second WorkItem (A11) |
| D1-06 | Engine killed between Operation record and outcome | On restart: ambiguous, reconciled by adapter read, no duplicate effect (A12, A13, A18) |
| D1-07 | Ambient `GIT_DIR`, `GH_REPO`, cwd set hostile | Every git call uses the execution context; audit names it; ambient values absent from child env (A16) |
| D1-08 | Stop during build, then engine restart | Process tree gone, lease released, grant revoked, ledger row with partial usage, workspace retained (A17) |
| D1-09 | Check runner reports not-executed; another check has no result; another ran at an old pv | States skipped, missing, stale; gate not satisfied with three reasons (A20) |
| D1-10 | Prompt containing shell metacharacters and a result naming `../outside` | Prompt arrives literally; diff rejected `diff_violation` (A21) |
| D1-11 | Direct commit to the integration branch by a human | Detected at next tick; gates blocked; Decision raised; discard restores expected HEAD, adopt opens a lineage and invalidates evidence |
| D1-12 | Fingerprint of protected path changed without a ProtectedVersion row | Every gate reports `PROTECTED_PATH_UNAUTHORIZED` |
| D1-13 | Store error during budget check | Dispatch refused `store_error`; nothing runs |
| D1-14 | Decision past target | `escalated_at` set once; one external notification; not repeated |
| D1-15 | Consequence text for each option | Equals the gate function's reason delta; no screen-specific text |
| D1-16 | Secret value present in a transcript | Redacted at write; post-scan clean; a seeded post-scan hit raises a Critical Finding |
| D1-17 | Second `surety serve` | Refused with holder pid; first engine unaffected |
| D1-18 | Nomination at stage completion (T2) and on Builder request (T1) | Candidate recorded with pv; lineage closed and reopened; tag present; Builder cannot nominate at T2 |
| D1-19 | Integration when HEAD moved since base | Rebase in scratch worktree, re-validation, fast-forward; conflict fails the run without agent involvement |
| D1-20 | API read while scheduler tick is mid-step | Read serves the store; no adapter call; `observed_at` reflects the read |

---

## 19. Repository layout and build order

**19.1 Layout** (O8, O9):

```
surety/
  package.json                 workspaces: packages/*; pinned deps; node >= 22
  packages/engine/
    package.json               bin: surety; dep: better-sqlite3 (pinned); dev: typescript, test runner
    src/store/                 schema, migrations, transitions/
    src/git/                   execution context, workspace, validation, integration, oob
    src/scheduler/             tick, leases, eligibility
    src/gate/                  evaluateGate, reason codes, satisfiers
    src/decisions/             raise, consolidate, age, answer
    src/invoke/                the choke point; adapters/ (D2)
    src/records/               write path, redactor, retention
    src/ledger/
    src/api/                   server, routes, schema.json, cli/
    src/recovery/
    test/                      unit + integration (D1-01…D1-20) with temp git repos and a scripted fake adapter
  packages/ui/
    public/                    hand-written HTML/JS, zero build; imports api/schema types via a generated .d.ts
  docs/                        foundations, errata, D1…, mockup/
```

**19.2 What M1 needs from D1.** Store with migrations and transitions for Project, WorkItem, Run, Workspace, Lease, CapabilityGrant, Revision, Lineage, Candidate, ProtectedVersion, Check, CheckResult, GateEvaluation, Decision, Approval, LedgerRow, Record, Event; git §7.1–7.7 without export; scheduler §8 with `max_concurrent_runs = 1`; gate function §9 for `stage` and `alpha` kinds minus deployment verification; decisions §10 for `check_correction_*`, `finding_disposition`, `blocker`, `out_of_band_change`, `stop_confirm`; API §11 reads for projects, decisions, candidates, gates, runs, tail, events, and commands for tick, pause, answer, stop, abandon; events §12; ledger §13; records §14; invoke §15 for one-shot only; recovery §16. Deferred to M2/M3: sessions, operations with external effect, environments, releases, retire.

**19.3 Dogfood.** The `surety/` repository is itself a Surety project from the first commit that the engine can run against: `.surety/project.json`, a one-check protected path (the engine's own test suite as the first required check, judged by exit status), and phase one of its roadmap defined as the walking skeleton M1 (E4).

---

## 20. Open questions for cross-review

1. **Store scope.** One store per engine home (chosen) versus one per project. Per-engine simplifies the API and multi-project views; per-project would make a project portable by copying one directory. A `surety store export --project` covers portability; is that enough?
2. **Nomination tags.** Writing `surety/cand/<seq>` tags into the project repository is a convenience that also makes nominations visible to anyone reading the repo with plain git. It adds refs the out-of-band detector must ignore. Keep or drop?
3. **Integration branch name.** `main` by default, configurable. Should the engine refuse to adopt a repository whose integration branch has unverified unpushed commits, or record them as the adoption baseline (E6 says baseline)?
4. **Concurrency.** `max_concurrent_runs` default 1 per project. Verifier and Reviewer could run concurrently on the same candidate since neither writes source; is the serial default worth the simplicity for M1 through M3?
5. **Consequence text generation.** §9.6 derives text from reason deltas. Is a fixed template per reason code sufficient, or does any Decision kind need text the gate function cannot produce (rollout decisions bind an Operation, not a gate)? Proposal: operation-bound decisions use the adapter's `describe(op, option)` with the same discipline.
6. **Session continuation.** §15.2 assumes D2 can continue a session on both backends under engine control. If one backend cannot, sessions on it are refused by the trust table; is a fallback (re-send context per turn) wanted for that backend?
7. **Event retention.** Events are append-only forever in v1. A cap or archival rule may be needed; proposal: none until measured.
8. **Where this repository lives.** Does `sdlc-x/` become the `surety/` development repository (docs move to `docs/`), or does code start in a new repository with this one as its design record?
