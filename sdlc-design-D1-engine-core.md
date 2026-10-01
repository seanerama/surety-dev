# D1. Engine Core: Entities, Runtime Store, API, Scheduler, Events

**Status:** Draft 2 for cross-review by the second architect. Not approved. Draft 1 was rejected with sixteen blocking objections (`sdlc-review-D1-Astra.md`); every objection and suggestion is dispositioned in `sdlc-review-D1-dispositions.md` and applied here.
**Depends on:** Foundations v1.0 with errata E1–E18 (`sdlc-foundations-v1.1-errata-draft.md`), decisions O8 (product shape), O9 (stack), O10 (reuse), O11 (repository).
**Scope:** The engine's durable model and the mechanisms every other design document builds on: identities, entities and their state machines, the runtime store, git operations, the scheduler and leases, the gate function, the attention queue, the local API, the event log, the ledger, records and redaction, the model-invocation choke point, and crash recovery. Appendix A is the authoritative enumeration of every persisted field, state, event, reason code, and error code this document references.
**Out of scope:** D2 backend adapter contract, containment and control-plane isolation, trust table, session qualification. D3 protected acceptance path, check runner, source-and-protected-assets materialization, diff classifier. Later: deployment adapters, export and promotion, Mechanic, adoption tooling, UI package.
**Conventions:** "MUST" is a requirement a test pins. "SHOULD" is a default policy may change. Section references in parentheses are to Foundations v1.0, an errata entry, or an objection in Astra's review (B01–B16, N01–N05).

---

## 1. Process model

**1.1 One engine, many projects.** A single engine process per host (`surety serve`) owns: the runtime store, the scheduler, every child process any run spawns, every git operation on every registered repository, every model invocation, and every external effect. The CLI (`surety`), the UI, and any automation are clients of the engine's local API and hold no state (O8).

**1.2 Loopback, single operator.** The API binds to `127.0.0.1` only. v1 serves one operator. Multi-operator is deferred (O8). The lease and fencing design in §8.3 makes crash recovery correct; it does **not** claim correctness for a second concurrent worker, which would need a distributed ownership design this document does not contain (B08).

**1.3 Single writer, one incarnation.** The engine process is the only writer to the runtime store. Each start records an **engine incarnation** (`inc_` id, pid, start time, host boot id). Startup takes an exclusive lock file in the engine home; a second `surety serve` refuses with `engine_locked` naming the holder's incarnation.

**1.4 Startup sequence** (B09). (1) Acquire the lock and record the incarnation. (2) Start the API listener in **restricted mode**: only `GET /v1/engine` and `GET /v1/health` answer; everything else returns `503 engine_starting` with the current step. (3) Open the store, run pending migrations inside one transaction. (4) Recovery (§16). (5) Repository integrity for every registered repository (§7.6). (6) Lift the listener to full mode. (7) Start the scheduler. A failure in steps 3–5 leaves the listener in restricted mode with the failing step and reason readable; the engine does not dispatch.

**1.5 Tick.** The scheduler runs one tick every `tick_interval` seconds (default 30). A tick requested by cron, the CLI, or the UI is the same tick: it sets a flag the loop consumes; it never runs scheduler logic in the requester's call. One tick runs at a time. A tick has a total budget (`tick_budget`, default 20 s) and per-step budgets (§8.5).

**1.6 Engine home.** `$SURETY_HOME` (default `~/.surety/`) holds: `store.db` (SQLite), `records/` (transcripts, tool output, check output, results, raw reports), `workspaces/` (engine-owned worktrees holding validated project source snapshots), `backups/`, `engine.lock`, `api.token`, `engine.log`. Control-plane material (store, records, token, journals, logs) is never committed to any repository and is never readable by a role process (§17). Workspaces are project source and are the one thing under the engine home that is meant to be committed, through the engine's git path (N02).

---

## 2. Identity

**2.1 Global ids.** Every entity has a 26-character time-ordered id (ULID) with the type prefix listed in Appendix A.1. No entity exists without one.

**2.2 Human numbers.** Within a project, candidates, runs, operations, decisions, findings, protected versions, proposals, and work items carry a per-project sequence number assigned at creation: `c-0421`, `r-1193`, `op-7731`, `d-88`, `F-212`, `pv-19`, `p-7`, `w-61`. Sequences never reuse a number. The global id is authoritative; the human number resolves to exactly one id within a project.

**2.3 Revisions are git SHAs.** A revision is identified by its full commit SHA. A revision is immutable; nothing in this document "moves" a revision. What changes is which revision a subject binds to, and that is what invalidation (§10.5) refers to (B12).

**2.4 Protected versions** (B01). A protected version (`pv-N`) is a per-project sequence number plus a fingerprint: the SHA-256 of the sorted list of `(path, git blob id)` for every file under the protected roots (§5.2). Any change to that list is a new fingerprint. A ProtectedVersion row is **authorized** only when written by `applyProtectedProposal` (§7.9) or by project bootstrap (`initial`). The **effective protected version** for an evaluation is the authorized version applicable to the evaluation's scope at evaluation time (§9.1), never "any row whose fingerprint matches." A repository tree whose fingerprint matches no authorized row is `PROTECTED_PATH_UNAUTHORIZED`.

**2.5 Effects and attempts** (B07). Every external or repository-mutating effect is a logical **Operation** with one durable identity (`op_`) and one idempotency key, `sha256(kind, target, subject, semantic_generation)`, independent of transport attempts. Each execution is an **OperationAttempt** child row, unique on `(operation, attempt_number)`. An Operation is recorded in a committed transaction **before** its first attempt is issued. Adapters receive the key and pass it to any external system that accepts one. Operation kinds include local git ref updates and notifications, not only publication and deployment (Appendix A.3).

---

## 3. Entity model

Appendix A lists every field with type and nullability. This section explains what each entity is for and the rules that bind it. `ref` means a store id; `file ref` means a Record id (§14).

### 3.1 Project and baseline

- **Project.** Tier, development repository root, integration branch name, delivery repository (nullable), baseline state (Idea, SpecReady, Retired) with the prior state kept for Reactivate, adoption record, management record (mode, health, activation evidence, triage policy), policy revision, paused flag. Registered refs (§7.2) and managed checkouts belong to the project. **Bootstrap** creates `.surety/project.json` in the repository and the Project row in one bootstrap transaction with a journaled git commit (§7.10); adoption (E6) uses the same bootstrap, recording the exact current commit of the selected integration branch, unpushed commits included, as the adoption baseline (Q3, decided by Sean).
- **SpecRevision, ArchitectureRevision, RoadmapRevision, PhasePlan.** Pointers to committed content plus approval. Content lives in git. The architecture's module map and sensitive-area classification are parsed into **Module** rows, which drive the sensitivity floor (F §5.6) and gated triage (E5).
- **Requirement.** Key, spec revision, assigned phase, status (pending, verified, descriptive_unverified), verifying evaluation, confirming human. Pending renders as pending, never as failed or passed (F §3.10.2).
- **Stage.** Phase plan, number, goal, modules, requirement ids, status (planned, building, integrated, verified), work item.

### 3.2 Work, runs, sessions, process ownership

- **WorkItem** (B10). Kind, subject refs, status (Appendix A.2 `WorkItemStatus`), blocker, dependencies, repair attempt count, no-progress count, and a **trigger identity**: `(trigger_source, trigger_id, trigger_generation)` unique per project. Observing a trigger creates its one WorkItem or returns the existing one in any non-terminal status. The trigger is consumed atomically with the item's successful terminal transition. Each kind declares its successful terminal transition and its preflight-refusal transition (Appendix A.5).
- **Run** (B08, B15). One role per run. Persists `state` (Appendix A.2 `RunState`) separately from `outcome` (`RunOutcome`). Carries work item, kind (one_shot, session), backend, backend version, model requested and observed, grant, workspace, base revision, deadline, parent run (resume lineage), result and transcript records, usage completeness. A session run additionally persists `session_state` and the exact provider session id.
- **Turn.** One per session turn; one active turn per session at a time; links its invocation receipt.
- **ProcessOwnership** (B08). Per run: process group id, pid and process start time, containment identity from D2 where present, descendants as reported by D2, owning engine incarnation, `termination_confirmed_at`. A pid alone never establishes ownership.
- **CapabilityGrant.** Capabilities (D2 vocabulary), environment allowlist, secret reference names, issued and expiry, revoked. Values never appear.
- **Workspace.** Path under `workspaces/`, base revision, disposition (active, retained, quarantined, discarded), checkpoints, validated snapshot tree id.
- **Lease** (B08). Resource kind (run, integration, workspace), resource id, owner incarnation, **generation** (monotonic per resource), expiry, released. Run leases and integration leases are distinct resources.

### 3.3 Revisions, candidates, protected path

- **Revision.** SHA, lineage, parent SHA, kind (working, checkpoint, engine_commit, nominated, out_of_band), creating run.
- **Lineage** (N02). Branch, `started_from_candidate`, open flag. A lineage opens at the first working revision after a nomination and closes at the next nomination; the new candidate's lineage link is `started_from_candidate`, and a later nomination does not require membership in the already closed lineage.
- **Candidate.** Nominated revision, lineage, nominated-at, nominated-by, spec and architecture revisions, `nominated_protected_version` (historical fact), progress (`CandidateProgress`), superseded_by. Progress never moves backward.
- **ProtectedProposal** (B04). A Verifier run that changed the protected roots terminates in this entity, not in a commit: base revision, proposed tree id, diff hash, affected check ids, spec rationale, requested classification, status (`ProposalStatus`), classifier result (D3), approver, resulting ProtectedVersion.
- **ProtectedVersion.** Sequence, fingerprint, check ids, change kind (initial, tightening, loosening, unclassifiable), proposal, approver and authority, `applied_by_operation`, `effective_from`, `superseded_by`, `authorized` flag.
- **Check.** Key, protected version, kind (Appendix A.2 `CheckKind`), required flag, gate kinds it applies to, tier floor, definition path and hash, requirement ids, sensitive areas, phase.
- **CheckResult** (B01). Check, candidate, source revision, protected version, runner, environment, artifact digest, `execution_established` (runner signal that the process ran), `signaled`, `deadline_hit`, `exit_status` (nullable), captured output record, timing. `state` is derived by §9.2 at evaluation time and stored on the evaluation, not on the result.

### 3.4 Scope, gates, findings, sign-offs, decisions

- **AcceptanceScope** (B01). Candidate, gate kind, phase or stage, spec revision, architecture revision, policy revision, effective protected version, delivered requirement ids, sensitivity categories touched, required check ids, required sign-offs, environment and artifact digest where applicable, `validated` flag, scope hash. Built and validated by §9.1 before any result is read.
- **GateEvaluation.** Scope, gate kind (`GateKind`, which distinguishes authorization from completion for deployment gates), computed-at, inputs snapshot and hash, outcome, reasons (Appendix A.4), satisfiers, stale flag.
- **Finding** (B02). Scope (project, lineage, candidate) and subject; source run nullable for engine-origin findings; proposed severity and **effective severity** with a history of (actor, authority, from, to, at); sensitive area; status (open, dispositioned, resolved); disposition (fix, defer, accept) with authority, linked issue, defer target, and the gate kinds at which it has been re-evaluated; Alpha-exception evidence (containment evidence record, testing purpose); resolution verification (an evaluation or check result that observed the fix). Applicability to a later candidate on the same lineage is inherited unless an engine-recorded assessment says otherwise.
- **SignOff.** Candidate, revision, role, scope (candidate, module), run, recorded-at, scope hash of what was reviewed. An input, not a decision.
- **Decision** (B12). Identity `(project, kind, subject_type, subject_id, semantic_generation, scope)`; question; options with an **effect plan** each (§10.2); binds; evidence refs with provenance; `preview_hash` over every material dependency; blocked-while-open; raised, target, escalated, batch key; status; answer; consumed-at; invalidation reason. Kinds are the closed set in Appendix A.2 `DecisionKind`, which covers every row of the E9 inventory.
- **Approval.** Decision, actor, consequence text as shown, revision, result hash, policy revision, protected-version delta shown (for publication and go-live), consumed-at. One per decision, same transaction.

### 3.5 Operations, environments, releases

- **Operation** and **OperationAttempt** (B07). As §2.5. Kinds: git_ref_update, git_commit, publish, deploy, rollback, teardown, issue_file, issue_update, notify. Status (`OperationStatus`) leaves `ambiguous` only through a reconciliation read. Partial completion records the remaining scope; a rollback or changed effect is a new Operation linked to the prior one.
- **GitJournal** (B05). One entry per engine git mutation: operation, repository, ref or tree, intended old oid, intended new oid, run and lease generation, state (`JournalState`), confirmed oid.
- **RefRegistry** (B05). Per project: ref name, kind (integration, lineage, nomination, recovery, oob), expected oid, immutable flag. Only registered refs are gate inputs or integrity subjects.
- **NotificationIntent** (B07). Outbox row: escalation or urgent source, channel, unique key, status (`NotificationStatus`), attempts.
- **Environment.** Name, adapter, config reference, verify spec (identity read method, behavioral check ids, target set definition).
- **EnvironmentRecord** (B13). `last_verified` (candidate, artifact digest, at, verification ref), `attempted` (operation, outcome, at), `observed` (condition, detail, `observed_at`, source, freshness bound, expires-at), frozen-at.
- **ObservationJob** (B13). Per environment: cadence, next due, last successful observation, last attempted read, error class.
- **DeploymentVerification** (B03). Operation, environment, target set, artifact digest, source-to-delivery mapping, configuration identity, effective protected version, identity reads per target, behavioral check results, outcome (verified, unknown, failed).
- **Release.** Version, candidate, delivery commit, artifact digest, source-to-artifact mapping, configuration identity, promotion record, allowlist version, four separate state facts (prepared, published, staged, live), recovery plan.

### 3.6 Invocation, ledger, policy, records, events

- **InvocationReceipt** (B11). Written before any model dispatch: run, turn, provider, requested model, grant, budget snapshot, dispatch status.
- **UsageObservation** (B11). Appended as provider usage arrives: invocation, sequence, cumulative or delta semantics flag, raw payload, at.
- **LedgerRow.** One immutable terminal row per invocation, derived from its observations and final report; unique on invocation. Billable input, cached input, output are **nullable** and null means unknown; `usage_complete` flag; cost status (reported, estimated, unknown) and cost; corrections are append-only rows linked to the original.
- **PolicyRevision.** Pointer to the committed policy blob, diff summary, `widens_authority`, committed flag, the decision that confirmed it.
- **Record** (B06, N05). Kind, path (null after expiry), hash, bytes, redaction version, durable-published flag, post-scan result, retain-until. Referenced-by is computed, not stored.
- **OutOfBandChange.** Registered ref, expected oid, found oid, detected-at, disposition, decision.
- **Event.** Monotonic sequence, type (Appendix A.6), subject refs, actor, payload, transaction id. Append-only.

### 3.7 Deferred entities

**MechanicIssue**, **TriageDisposition**, **ProductIntentContract** (E5), **AdoptionAnalysis** (E6), **ExportRecord**, **PromotionRecord** (F §7) are reserved in Appendix A.1 so ids and foreign keys have a place; their fields belong to the documents that own them.

---

## 4. State machines

Each transition is a named function (§6.3). The tables list the only legal transitions. Anything else is refused with `illegal_transition`.

**4.1 Run.** `state` moves: created → claimed → executing → validating → (finalizing | proposal_captured → finalizing) → ended. `outcome` is set once, in the transition to ended. Sessions add `session_state` within executing: open_idle ⇄ turn_running → saving → closing.

| From | To | Trigger | Outcome |
|---|---|---|---|
| created | claimed | scheduler acquires the run lease, issues the grant, writes the invocation receipt | |
| claimed | executing | adapter launch confirmed; ProcessOwnership written | |
| claimed | ended | adapter preflight refuses (E1) | refused |
| executing | executing | heartbeat renews the lease | |
| executing | validating | adapter returns a structured result | |
| validating | proposal_captured | role is Verifier and the diff touches protected roots only (§7.3) | |
| validating | finalizing | diff validation passed; snapshot committed and journaled | |
| validating | finalizing | diff validation failed or result invalid | failed |
| executing | finalizing | adapter infra error, or result contradicts transcript | failed |
| executing, validating | finalizing | `deadline_at` passed | timed_out |
| executing, validating | finalizing | human Stop | stopped |
| executing, validating | finalizing | human Abandon | abandoned |
| any non-ended | finalizing | startup recovery (§16) | recovered |
| proposal_captured | finalizing | proposal row written | completed |
| finalizing | ended | §4.5 end protocol completes, or quarantines | as set |

**4.2 WorkItem** (B10).

| From | To | Trigger |
|---|---|---|
| eligible | claimed | scheduler selects it |
| claimed | executing | its Run reaches executing |
| claimed | eligible | its Run ended refused; refusal recorded on the item; after `preflight_refusals_max` (default 3) → parked |
| executing | integrating | Run finalizing with validated snapshot |
| integrating | integrated | journaled integration confirmed (§7.5) |
| integrated | verifying | the kind requires verification (stage build, fix) |
| integrated | complete | the kind does not (replan, intent-only, proposal capture) |
| verifying | complete | the kind's gate is satisfied |
| executing, verifying | awaiting_decision | a Decision that blocks this item was raised |
| awaiting_decision | prior status | the Decision is consumed and its effect plan says continue |
| executing, integrating, verifying | eligible | Run ended failed or timed_out and `repair_attempts` < policy max; progress key recorded |
| executing, integrating, verifying | parked | repair attempts exhausted, no-progress limit reached, budget exhausted, or integration conflict |
| executing | stopped | human Stop; remains stopped until explicit Resume |
| stopped | eligible | human Resume (creates a new Run per §15.3) |
| executing | prior status before claim | human Abandon after confirmed termination |
| any non-terminal | cancelled | human cancels, or project Retired |
| parked | eligible | human resolves the blocker |

Terminal: complete, cancelled. **Progress key.** On every failed or stopped end, the engine records the hash of (source tree, findings set) that the attempt produced; a repeat with an unchanged key increments `no_progress_count`, which parks the item at `no_progress_max` (default 2). A finding typed as a requirement or contract conflict (D3 typed findings) routes to objection or baseline review instead of another repair.

**4.3 Candidate progress.** developing → alpha_deployed → beta_deployed → live, each only through a satisfied **completion** evaluation of the matching gate kind (§9.6). No backward transition. `superseded_by` is set when a later candidate is nominated with `started_from_candidate` pointing here.

**4.4 Operation and attempts** (B07). Operation: intended → in_progress → (succeeded | failed | partial | ambiguous); ambiguous → the reconciled outcome of its last attempt; partial may spawn a new attempt for the remaining scope only. Attempt: started → (succeeded | failed | ambiguous) → reconciled_succeeded | reconciled_absent | reconciled_partial. A new attempt is permitted only after the prior attempt is reconciled and only when its reconciled state is `absent` or `partial`. Confirmed success forbids another attempt.

**4.5 Run end protocol** (B08). One idempotent protition `endRun(run)` is the only path from finalizing to ended, for every outcome. In order:

1. **Prevent new effects.** Mark the run's lease generation as closing; the store refuses any further write on behalf of this generation (§8.3).
2. **Terminate.** Send TERM to the process group recorded in ProcessOwnership; wait `terminate_grace` (default 10 s); send KILL; wait `kill_grace` (default 5 s); confirm by pid-and-start-time absence. D2 containment, where present, is asked to confirm termination and capability expiry.
3. **If termination is not confirmed:** the run stays in finalizing with `quarantined = true`, the workspace disposition becomes quarantined, dispatch on that workspace and on the item is refused, a `blocker` Decision is raised naming the pid, and an `engine.quarantine` event is emitted. The run is **not** reported ended. No lease is released and no workspace is discarded while an owned process may still write.
4. **Reconcile issued effects.** Any Operation attempt the run issued that is `started` becomes `ambiguous` and is reconciled (§16.2) before continuing; unresolvable ones block their dependent resources.
5. **Finalize usage.** Derive the LedgerRow from the invocation receipt and all usage observations; unknown fields stay null; `usage_complete` reflects whether a final report arrived.
6. **Dispose workspace.** Retained for completed, failed, timed_out, stopped, recovered; discarded for abandoned.
7. **Revoke the grant, release the lease, write the outcome, emit events.** One transaction.

Normal completion runs the same protocol; steps 2–3 are trivially satisfied by the already-exited process.

**4.6 Decision** (B12). open → answered → consumed, in one transaction with the recording of effect intents; open → invalidated when any material dependency in its preview hash changes (revision binding, policy revision, protected delta, operation status, evidence applicability); invalidation raises the next semantic generation if the question still applies; open → open with `escalated_at` and a NotificationIntent when age exceeds target.

---

## 5. What lives where

**5.1 In the project's git repository** (F §7.1): source; `.surety/spec/`, `.surety/adrs/`, `.surety/architecture/`, `.surety/roadmap/`, `.surety/phases/`, `.surety/checks/` (protected roots), `.surety/policy.json`, `.surety/project.json`. The engine commits every one of these (E2).

**5.2 Protected changes are protected regardless of file** (B04). The protected roots default to `[".surety/checks/"]`. A change to the roots list, to check commands, discovery rules, runner configuration, result collection, or to which checks are required, is a protected change and follows §7.9 even when the edited file is `.surety/policy.json`. Generic policy confirmation (§11.4) does not replace E13 approval.

**5.3 In the runtime store:** everything in §3. **5.4 In `records/`:** §14. **5.5 Nowhere:** secret values. The pattern registry and secret resolver are engine-internal services used by invocation and redaction (N05); values never become durable output.

---

## 6. Runtime store

**6.1 Engine and durability** (B06, B09). SQLite, WAL mode, **`synchronous=FULL`**, foreign keys on. Driver `better-sqlite3`, pinned, the engine package's only runtime dependency (O9), behind one store interface so Node's built-in module can replace it later. The store connection is owned by a **store worker** (a `worker_thread` inside the engine process) with a bounded command queue; the request path and the scheduler submit short transactions to it and never hold a transaction across a git call, an adapter call, or an event-stream write. This placement is the default because it is the simplest way to satisfy D1-20; the test, not the placement, is the requirement. The qualified storage must honor fsync; an engine home on a filesystem that does not is refused at startup.

**6.2 Schema.** Appendix A. Uniqueness: `(project, seq)` per sequenced entity; `operations.idempotency_key`; `(operation, attempt_number)`; `(project, trigger_source, trigger_id, trigger_generation)`; `(project, decision_kind, subject_type, subject_id, semantic_generation, scope)` across open **and consumed** decisions; `(lineage.project, lineage.branch) WHERE open`; `(lease.resource_kind, lease.resource_id) WHERE NOT released`; `ledger_rows.invocation`. `ledger_rows`, `usage_observations`, `events`, `git_journal`, and `invocation_receipts` have no UPDATE or DELETE path; database triggers refuse both.

**6.3 Transitions are functions.** No code outside `engine/store/transitions/` writes to the store. Each transition takes current rows and an intent, checks the legal-transition tables (§4), performs its writes and appends its Event rows in one transaction, and returns the new rows. **Ordering with effects:** a transition that produces an effect records the Operation (and for git, the GitJournal entry) as an intent in its transaction; the effect runs **after** commit through its journal; a second transition records the outcome. Crash between the two leaves an intent that §16 reconciles. Reads that precede a transition (adapter reads, git reads) happen before the transaction and their observed-at is carried into it.

**6.4 Migrations.** Numbered SQL files applied in order in one transaction at startup; the applied list is a table; a failing migration stops startup in restricted mode. Downgrade is unsupported; backups are the rollback.

**6.5 Backup and export** (B06). `surety store backup` writes a consistent snapshot through the online backup API **plus** every record the snapshot references **plus** a manifest of referenced git objects and hashes; referenced commits are pinned against garbage collection by `surety/keep/*` refs in the registry. A database-only copy is labeled `incomplete_for_recovery`. Restore verifies every reference before the engine leaves restricted mode. `surety store export` writes JSONL plus the same closure, and `import` requires explicit repository and secret-reference rebinding without copying values.

**6.6 Fail closed.** Any store error during a budget check, gate computation, lease operation, decision consumption, or journal write fails that operation with `store_error`. There is no fallback to a cached or file value.

---

## 7. Git operations

**7.1 The engine performs git** (E2). Every git command is spawned asynchronously by the engine with an argument array, never a shell string; arguments that could be option-shaped are validated or placed after `--` (B14). The child environment is constructed, stripping `GIT_*`, `GH_*`, and editor variables (A16), with explicit `--git-dir` and `--work-tree` from the execution context. Output is bounded. Every invocation has a deadline (default 60 s; clone and fetch 600 s); on expiry the child is killed and the operation is marked ambiguous if it could have written.

**7.2 Execution context and ref registry** (B05). One resolved object per run and per engine git or adapter call, named in every audit record: `{project, repo_root, git_dir, worktree_path, branch, base_sha, delivery_substrate, credential_scope, child_env, registry_snapshot}`. Resolution validates the paths, that `.surety/project.json` matches the Project, and that every registered ref currently has its expected oid; a mismatch is an integrity observation (§7.6), not a new expected value. **Registered refs:** the integration branch; lineage refs; nomination refs `surety/cand/<seq>` (immutable, Q2 decided by Sean); recovery refs `surety/oob/<n>` and `surety/keep/<n>`. Developer branches outside the registry are not gate inputs, are never reset or adopted by the engine, and their movement is not an integrity failure.

**7.3 Workspace lifecycle** (B04). For every run that may edit files: `git worktree add --detach <ws_path> <base_sha>` under `workspaces/<run>/`; the protected roots are materialized read-only where D2 supports it. When the role's process has exited (one-shot) or the adapter has quiesced the role at a turn boundary (session, D2), the engine takes a **snapshot**: `git add -A` into a temporary index and `git write-tree`, recording the tree id. All validation and the commit use that tree id; a later diff between the tree and the working directory is irrelevant. Validation of the snapshot tree against `base_sha`:

1. **Role prohibitions** (F §4.1, E2): any path the role may not modify rejects the run whole with `diff_violation`.
2. **Protected roots:** for every role except the Verifier, any change under a protected root rejects. For the **Verifier**, a diff touching protected roots **and nothing else** is captured as a ProtectedProposal (status captured) and the run ends `completed` with `state = proposal_captured`; it is never committed anywhere. A Verifier diff that touches protected roots and application source rejects whole.
3. **Containment:** no symlink resolving outside the worktree; no `..` segments; no change under `.git`; no change to `.surety/project.json`; worktree HEAD still detached at `base_sha`; index and repository metadata unchanged except by the engine's own snapshot.
4. **Refs:** the registry snapshot taken at context resolution must equal the registry state after the run, reconciled against the GitJournal for the engine's own concurrent journaled writes (B05). Any registered ref the role moved rejects with `ref_violation`. D2 is responsible for denying role git authority before this check; this check is the backstop.
5. **Size and kind caps** per policy.

On pass, the engine commits the snapshot tree with `git commit-tree` (parent `base_sha`), verifies the resulting commit's parent and tree, records a Revision, and proceeds to integration (§7.5). On fail, the worktree is retained, the Run ends failed, and the WorkItem follows §4.2.

**7.4 Checkpoints and commit messages.** A checkpoint is a snapshot (§7.3) committed on the lineage branch as a working revision, never nominated, never integrated. The role's remaining work continues in a workspace rebased onto the checkpoint. First line: `w-61 stage 6: export service and CSV endpoint`; trailers `Surety-Run`, `Surety-Role`, `Surety-Base`, `Surety-WorkItem`, `Surety-Kind: engine_commit|checkpoint|intent|protected`.

**7.5 Integration through the journal** (B05). Serial per project through M3 (Q4, decided by Sean). Under the integration lease: write a GitJournal entry `{ref: integration branch, old: expected_oid, new: candidate_commit, state: intended}` and the Operation (`git_ref_update`) in one transaction; then `git update-ref <ref> <new> <old>` (compare-and-swap); then record `applied` and the confirmed oid; the RefRegistry's expected oid advances only to the journaled new oid. If the base is behind HEAD, the engine rebases in a scratch worktree, re-runs §7.3 validation on the rebased tree, and journals that commit instead. A CAS failure is `integration_conflict`: the run ends failed, the item parks, no agent resolves it.

**7.6 Repository integrity** (B05). At startup, at every tick before dispatch or integration on a project, and before any evaluation: for every registered ref, read its oid; for every managed checkout, read HEAD, index, and metadata. First reconcile pending GitJournal entries (§7.10). Then: a registered ref whose oid matches neither its expected oid nor a journaled new oid, a deleted registered ref, an unreadable repository, or a modified managed checkout is an **OutOfBandChange**: it blocks every gate on the affected lineage, raises an `out_of_band_change` Decision with options discard (journaled reset to the expected oid, stray commits kept on `surety/oob/<n>`) and adopt (record the stray commits as out_of_band revisions, invalidate every evaluation and result on the lineage, open a new lineage), and never advances an expected value.

**7.7 Nomination** (E11). Journaled: the Candidate row, the immutable `surety/cand/<seq>` ref, the lineage close and reopen, all in one transaction with the GitJournal intent, then the ref write, then confirmation. A Builder's nomination request at T1 is a structured result field; the engine performs it.

**7.8 Intent artifacts.** Role outputs under `.surety/...` are committed by the engine as `Surety-Kind: intent` through §7.3 and §7.5. The WorkItem kinds that produce only intent (replan, assessment) reach `complete` at integration (§4.2). Plan artifacts become Stage and WorkItem rows in the same transaction that confirms their integration, so a committed plan is schedulable by construction (incident 11).

**7.9 Applying a protected proposal** (B04, E13). Only `applyProtectedProposal` writes an authorized ProtectedVersion. It: verifies the proposal's base and tree hash still apply; enforces E13 authority (tightening: Reviewer run or human; loosening or unclassifiable: human, through the `check_correction_*` Decision); for a change to the required set, requires the validation-scope approval route; records in one transaction the authorization, the intended ProtectedVersion (`authorized = false`), the GitJournal intent, and the Operation; applies the exact approved tree as a `Surety-Kind: protected` commit on the integration branch through §7.5; then in a second transaction sets `authorized = true`, `effective_from`, supersedes the prior version, invalidates every evaluation and result that depended on the old version, and emits `protected.applied`. Because the commit changes the integration branch, the next nomination produces a new candidate; the old candidate keeps its identity and loses no approvals, but its evaluations are stale.

**7.10 Journal recovery.** Before any integrity check or dispatch, every GitJournal entry not in `confirmed` or `failed` is reconciled by reading the ref: equal to the new oid → confirmed; equal to the old oid → the intent may be retried once under a new attempt; anything else → `ambiguous`, blocking the lineage with a `blocker` Decision. Commits reachable only from pending entries are pinned by `surety/keep/*` until reconciled.

---

## 8. Scheduler and leases

**8.1 Tick algorithm** (B09, B13). Each step has a budget; the tick has a total budget. Steps 1–4 are **safety prerequisites**: if any overruns or fails for a project, that project's dispatch and integration are ineligible for this tick, while decisions, recovery, and other projects continue.

1. **Recover:** leases past expiry whose owner is not a live process of this incarnation → §4.5.
2. **Journal and effects:** §7.10; then every Operation `in_progress` past its attempt deadline or `ambiguous` → adapter `reconcile`. No retry here.
3. **Repository integrity:** §7.6.
4. **Budgets:** per-project day and unknown-token bounds computed from observations.
5. **Observe environments:** every ObservationJob past `next_due` → one bounded adapter read; write `observed` with `observed_at`, source, and expiry; a failed or absent read past the freshness bound sets condition Unknown while the previous reading stays visible as history.
6. **Decisions:** age, escalate (NotificationIntent), invalidate on changed preview dependencies.
7. **Gates:** recompute stale evaluations.
8. **Select:** for each eligible project, in priority: verification due → builds → replans → other; oldest first; skip items with unmet dependencies, any open Decision in their blocked-while-open set, an open autonomy boundary (policy chaining limits), or a failed budget check.
9. **Dispatch:** up to `max_concurrent_runs` (default 1 per project, 2 engine-wide): create Run, lease, grant, invocation receipt, execution context, then launch asynchronously and return; the tick never waits for a model run.
10. **Heartbeat:** `engine.tick`.

**8.2 Triggers** (B10). As §3.2. A trigger observed while its WorkItem is claimed, executing, parked, stopped, or awaiting a decision returns that item and creates nothing.

**8.3 Leases and fencing** (B08). A Lease names a resource kind and id, the owner incarnation, a generation, expiry, and release. Every transition or adapter callback on behalf of a run must present `(run, generation)`; the store accepts it only if the generation is **equal** to the current one, the lease is unexpired and unreleased, the grant is live, and the Run state permits the write. Late callbacks from superseded, stopped, or closing generations are rejected even when no newer generation exists. External effects pass the same check at dispatch and are journaled; a database fence does not cancel an effect already issued, which is why §4.5 reconciles issued effects. Renewal on heartbeat and at least every `lease_ttl/3` (default ttl 90 s).

**8.4 Pause, Stop, Abandon, Resume** (E7, B10). Project pause skips step 8. Stop and Abandon act on one Run through §4.5 and are admitted at any time, including mid-tick. Stop leaves the WorkItem `stopped`; Resume is explicit and creates a new Run (§15.3). Abandon returns the item to its pre-claim status only after confirmed termination.

**8.5 Deadlines** (B09). Every Run, adapter call, git call, tick step, and recovery loop carries a deadline. A deadline on owned work **cancels** it: the child is killed, issued writes are marked ambiguous, the generation is closed, and any late completion is rejected by §8.3. Role run defaults: Builder 45 m, Verifier 30 m, Reviewer 20 m, Architect 30 m; session idle 20 m.

---

## 9. Gate function

**9.1 Scope first** (B01). `evaluateGate(project, candidate, gate_kind, environment?)` begins by building an AcceptanceScope: the candidate's revision, spec and architecture revisions, policy revision, the **effective** protected version (§2.4), phase or stage, delivered requirement ids (those the roadmap assigns to phases completed or in progress up to this candidate), sensitivity categories of every module the candidate's lineage touched, the required check ids derived from tier (cumulative: T3 includes T2 includes T1), module overrides, and sensitivity floor, the required sign-offs, and environment and artifact digest for deployment gates. The scope is validated: every required check id must exist in the effective protected version; every delivered requirement must map to at least one required check or a recorded applicability assessment; the sensitivity floor must be covered. Any missing, empty, or uncovered element yields `ACCEPTANCE_SCOPE_INCOMPLETE` and the evaluation stops. **An empty required-check set never satisfies a gate.** Undelivered requirements remain pending and are neither passed nor failed.

**9.2 Check state assignment** (B01, E8). For each required check in the scope, select the CheckResult whose bindings match the scope exactly: check, candidate, source revision, effective protected version, runner class, environment and artifact digest where the check kind requires them; latest by `finished_at`. Then:

- no matching result → **missing**;
- a result exists for this check and candidate but with different bindings → **stale**;
- `execution_established = false` → **skipped**;
- `deadline_hit` or `signaled` or `exit_status` null or nonzero → **failed**;
- `execution_established` and no deadline and `exit_status = 0` → **passed**.

Precedence is as listed. The runner (D3) writes the raw fields; only this function derives the state, and it records the state on the evaluation. A runner that cannot report `execution_established` is refused at registration.

**9.3 Inputs evaluated**, all required, in order:

1. Scope complete (§9.1).
2. Protected path authorized: the repository's fingerprint at the candidate's revision equals an authorized ProtectedVersion, and that version is the effective one for this scope. Else `PROTECTED_PATH_UNAUTHORIZED` or `PROTECTED_VERSION_NOT_EFFECTIVE`.
3. No OutOfBandChange and no pending GitJournal entry on the lineage. Else `OUT_OF_BAND_CHANGE` or `GIT_JOURNAL_PENDING`.
4. Every required check **passed**. Else `CHECK_NOT_PASSED(check, state)` each.
5. **Findings** (B02). Over every open Finding whose scope includes this candidate (project, its lineage, or itself, with inherited applicability):
   - blocking under F §6.1 for this gate kind, severity ladder and sensitivity floor applied → `FINDING_BLOCKING`. A High finding at `alpha_*` is nonblocking only with recorded containment evidence and testing purpose, never in a sensitive area, and never over a non-passed check.
   - nonblocking: satisfied only by (a) `defer` with authority (Reviewer for Low, human for Medium), a linked issue, a target not yet passed, and a recorded re-evaluation at this gate kind; or (b) human `accept` with a documented risk decision. `fix` leaves it unsatisfied until a resolution verification applicable to this candidate exists. Else `FINDING_UNSATISFIED` or `FINDING_DEFER_EXPIRED`.
   - resolved findings with verification do not block.
6. Every SignOff the tier requires, bound to this revision and a scope hash equal to the current scope: T2 Reviewer at candidate level; T3 additionally per module and a clear security review. Else `SIGNOFF_MISSING`.
7. Every required human approval is a consumed Decision bound to this revision and this scope hash. Else `APPROVAL_MISSING(kind)`.
8. Referenced evidence records exist and verify (§14). Else `EVIDENCE_MISSING`.
9. Deployment-gate obligations per §9.6.

`outcome = satisfied` iff no reason was produced. Reason codes are the closed set in Appendix A.4; each carries subject ids; satisfiers derive from reasons by fixed templates.

**9.4 Severity transitions** (B02) are transition functions, not fields: any role may raise effective severity; lowering out of blocking range for the gate concerned requires the human; other downgrades require the Reviewer or human; every change records actor and authority. No severity change alters a check state.

**9.5 Staleness.** Any write to a CheckResult, Finding, SignOff, DeploymentVerification, ProtectedVersion, OutOfBandChange, GitJournal, PolicyRevision, or a Decision bound to the candidate marks its evaluations stale. Changing any scope dependency invalidates the evaluation; retaining evidence across a baseline change requires the applicability assessment in F §3.8.

**9.6 Deployment authorization and completion** (B03). For alpha, beta, and live, there are two gate kinds. `*_authorize` evaluates inputs 1–8 plus, for beta, export validated and the source-to-artifact mapping recorded, and for live, the recovery plan. A satisfied authorization permits the engine to record **one** deploy Operation for that candidate, artifact, and environment; it never advances progress. `*_complete` evaluates inputs 1–8 plus a DeploymentVerification bound to **that** Operation, environment, full target set, artifact digest, source-to-delivery mapping, configuration identity, and effective protected version, with outcome verified: every required target's identity read matches the expected identity from the approved mapping, at least one required external-interface behavioral check passed, and every required post-deploy check passed through the protected path. A historical verification of the same candidate is not sufficient. Only a satisfied completion advances progress and writes `last_verified`; failure or Unknown writes `attempted` and `observed` and never erases history.

**9.7 Effect plans** (B12). A Decision's options are previewed by calling the owning transition in **dry-run** mode, which returns the full effect plan (rows it would write, Operations it would intend, gate delta where a gate is involved, blockers) and a preview hash over every material dependency. The same transition validates and consumes the plan. Adapters may supply observed target detail for the text; they never determine authorization.

---

## 10. Attention queue

**10.1 Raising.** Only transition functions raise Decisions, only for kinds in Appendix A.2 `DecisionKind`, each with a fixed question template, option set, binding schema, and `target_seconds` policy default (rollout 30 m, blocker 4 h, finding disposition 1 d, check correction 1 d, approvals 2 d, spec change 3 d). Stop, Abandon, Reactivate, Retire, initial spec approval, idea acceptance, and authority-widening policy changes all go through the queue; the CLI and UI routes for them create and consume these Decisions and cannot bypass them (B12).

**10.2 Identity, never twice** (B12). Identity is `(project, kind, subject_type, subject_id, semantic_generation, scope)`, unique across open and consumed rows. A raise with an existing identity returns the existing row. `semantic_generation` advances only on a recorded material change to the subject. Evidence hashing canonicalizes ordering and excludes presentation timestamps.

**10.3 Consolidation.** Decisions sharing `(candidate, revision, gate_kind)` share a `batch_key` and present as one item; each is consumed as its own row. Batch answers are evaluated as a combined effect plan and refused if the plans conflict; all-or-nothing refers to local intent consumption.

**10.4 Aging and escalation** (B07). An open Decision past target gets `escalated_at` and a NotificationIntent with key `(decision, generation)` in the same transaction. Delivery is a separate journaled attempt; a channel that cannot confirm delivery leaves the intent `unknown`, and the engine never claims exactly-once delivery.

**10.5 Answering** (B12). The client sends the decision id, option, note, and the `preview_hash` it displayed. The transition, in one transaction: re-reads every material dependency and recomputes the hash; refuses `decision_stale` on mismatch; refuses `decision_consumed` if not open; writes the Approval where applicable; records the effect plan's rows and Operation intents; marks the Decision consumed; emits events. External effects run afterward through their journals. An unchanged parked result is consumed without any model invocation; the test for this asserts no adapter launch (A07).

**10.6 Blocked-while-open.** Each Decision records the WorkItems, gate, and Operation it holds; §8.1 step 8 honours the set.

---

## 11. Local API

**11.1 Transport and boundary** (B14). HTTP/1.1 on `127.0.0.1:7227` (configurable); server-sent events for streams. Before routing, body reads, filesystem access, or `100 Continue`: the `Host` header and any absolute-form request target must equal the exact configured self-authority; a present `Origin` or `Referer` must equal the exact self origin including scheme and port (`null`, malformed, or foreign refused with `origin_refused`); present fetch-metadata headers must be consistent with same-origin use. No CORS. Mutations require `X-Surety-Token` equal to `api.token` (0600, created at first start, rotated by `surety token rotate`), compared length-checked and constant-time; origin-less CLI requests require it too. Responses carry `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and frame denial; the UI ships a restrictive CSP, renders untrusted content as text, and allows only `https:`, `http:` to loopback, and relative links. Body cap 1 MB (uploads 8 MB) enforced before reading, including streamed and mismatched lengths. Every mutating request, including refusals, writes an `api.act` event with the token redacted; if the audit write fails, the mutation is refused (`audit_failed`). No request or stream callback may crash the engine. Tokens never appear in URLs, browser storage, event payloads, or logs; the UI obtains its token through a same-origin bootstrap route.

**11.2 Versioning and schema.** All routes under `/v1/`. `packages/engine/api/schema.json` is the contract; the UI package imports generated types; a contract-pin test fails on drift; a joint engine-plus-UI behavioral test suite exercises every accepted screen against a live engine (N03, E14).

**11.3 Reads** (B13). Every response carries `served_at` and the store snapshot sequence. Every fact that reflects a reading carries its own `observed_at`, `source`, provenance (`observed | claimed | configured`), and freshness state. Reading never refreshes an observation timestamp. Reads never call adapters. Record and tail content is returned only through engine-scoped identifiers with realpath containment and size limits; every nested route verifies that the entity belongs to the project in the path.

| Route | Returns |
|---|---|
| `GET /v1/health` | restricted-mode safe liveness |
| `GET /v1/engine` | version, incarnation, mode, uptime, tick timing, leases, backends qualified (D2), store size, last backup and its completeness label |
| `GET /v1/projects` | lifecycle, NOW, open decisions with oldest age and escalation state, running run summary, spend today (verified and unknown separately, no-dispatch shown as such) |
| `GET /v1/projects/:p` | combined projection: NOW, baseline, roadmap and requirement status, candidates (nominated only, with succession), environments (three facts with freshness), management, execution status, spend attribution |
| `GET /v1/projects/:p/decisions`, `/:d` | open decisions consolidated by batch key, options with effect plans and preview hash, evidence resolved to records |
| `GET /v1/projects/:p/candidates/:c` | candidate, lineage, working revisions and checkpoints, latest evaluation per gate kind |
| `GET /v1/projects/:p/candidates/:c/gates/:kind` | evaluation with scope, reasons, satisfiers, per-check states and output records, historical versus effective protected version, protected-version delta since last human-reviewed version |
| `GET /v1/projects/:p/work` | work items by status, phase plan with stages, blockers |
| `GET /v1/projects/:p/runs/:r` | run with state, liveness, process ownership summary, workspace, grant names, invocation receipts and live usage observations |
| `GET /v1/projects/:p/runs/:r/tail` | SSE: captured output from an offset, bounded per-client queue |
| `GET /v1/projects/:p/operations`, `/:o` | operations with attempts, journal entries, reconciliation reads |
| `GET /v1/projects/:p/environments` | environment records with per-target observations and freshness, observation jobs, operations in flight |
| `GET /v1/projects/:p/releases` | releases with their four state facts, mappings, recovery plans |
| `GET /v1/projects/:p/ledger?day=` | ledger rows with corrections, per-role totals, verified and unknown separately |
| `GET /v1/projects/:p/records/:id` | a record's content through its scoped id |
| `GET /v1/projects/:p/policy` | effective policy, revision, closed writable-field schema |
| `GET /v1/projects/:p/management` | deferred owner: activation evidence, issues, triage (E5 document) |
| `GET /v1/events?since=<seq>&project=` | SSE: replay from `seq` with a resumable cursor, bounded queue; slow consumers are disconnected with the cursor |

**11.4 Commands.** Each is one transition; each returns the resulting rows and events. Convenience routes for decisions create and consume the corresponding Decision rather than bypassing the queue.

| Route | Effect |
|---|---|
| `POST /v1/projects`, `POST /v1/projects/adopt` | bootstrap transaction (§3.1); adoption records the baseline commit |
| `POST /v1/projects/:p/tick` | set the tick flag |
| `POST /v1/projects/:p/pause`, `/resume` | project pause flag only |
| `POST /v1/projects/:p/retire`, `/reactivate` | raise and, with confirmation, consume the `retire` / `reactivate` Decision |
| `POST /v1/projects/:p/decisions/:d/answer` | §10.5 with `{option, note?, preview_hash}` |
| `POST /v1/projects/:p/decisions/answer-batch` | §10.3 |
| `POST /v1/projects/:p/runs/:r/stop`, `/abandon` | raise and consume `stop_confirm` / `abandon_confirm` with the preview hash; §4.5 |
| `POST /v1/projects/:p/work/:w/resume`, `/cancel` | §4.2; resume creates a new Run per §15.3 |
| `POST /v1/projects/:p/policy` | closed field schema; unknown fields refused; validated full object; diff computed; a widening change raises a `policy_widening` Decision and returns `confirm_required` with its preview hash; on consumption the engine commits the file through §7.3 and §7.5 and records the PolicyRevision; protected-change fields route to §7.9 instead |
| `POST /v1/projects/:p/sessions`, `.../:r/turns`, `.../:r/save`, `.../:r/close` | §15.2 |
| `POST /v1/projects/:p/spec/change-requests` | starts F §3.8 |
| `POST /v1/token/bootstrap` | same-origin UI token bootstrap |

**11.5 Errors.** Every refusal is `{code, reason, what_to_do, subject}` with a code from Appendix A.7, which also maps every internal reason class to its public code.

**11.6 CLI.** `surety` is a thin client over the same routes with `--json`. `surety store …` commands refuse to run while an engine holds the lock.

---

## 12. Event log and projections

**12.1 Events.** Append-only, store-wide monotonic `seq`, written in the same transaction as the change they describe. Types are the closed set in Appendix A.6; adding one is an amendment. Each event names the authenticated actor and the request or operation identity (B14).

**12.2 Projections derive from entities, not from events.** `GET /v1/projects/:p` is computed from current rows in one snapshot read; the event log is the audit trail and the live feed.

**12.3 NOW.** Exactly one of, by fixed priority: `refused` (the engine cannot act on this project: repository unreadable, integrity blocked, store error, quarantine) → `waiting_on_you` (any open Decision) → `running` (any Run executing) → `ready` (eligible work and dispatch possible next tick) → `idle`. `unknown` replaces all of these only when the store snapshot itself fails. A refusal is about the engine's ability to act; environment facts stay Unknown independently (B13). A screen may title its local execution panel "Running" while NOW says otherwise (N03). The projection carries `primary_action` and a one-sentence `reason` generated from the same inputs.

**12.4 Execution status.** Runs by state, sessions open, paused flag, blockers, quarantines, last and next tick.

---

## 13. Ledger and budgets

**13.1 Receipts, observations, rows** (B11). Before dispatch: InvocationReceipt. During: UsageObservation rows as the adapter reports usage, with cumulative-or-delta semantics declared per adapter so totals never double count. At end: one LedgerRow derived idempotently from the receipt, observations, and final report, unique per invocation. Unknown token counts are null, never zero; `measured_zero` is not a token value but a cost status for a dispatched invocation that reported zero; "no dispatch" is a projection fact with no row. Later recovered usage is an append-only correction.

**13.2 Normalization.** `billable_in` excludes cache reads; `cached_in` is separate; raw payload and normalization version retained. The Claude normalizer in Verity folds cache reads into input and the Codex normalizer emits zeros for missing usage; neither is ported verbatim (N04, §8.2 of Astra's review).

**13.3 Budget checks and boundaries** (B11, E16b). Policy names each limit's boundary: model turn, user session turn, or whole invocation. Adapters declare which boundaries they can enforce; where a one-model-turn overshoot bound is unavailable for a multi-turn one-shot invocation, the engine records that limitation on the trust entry (D2) and either applies a qualified hard bound (deadline, token cap the backend honours) or refuses a policy that requires the finer boundary. Checks run at dispatch, between session turns, and on every usage observation; exhaustion stops at the enforceable boundary through §4.5, parks the item, raises a `blocker` Decision, and pauses dispatch for the project. Resolving the blocker never overrides a required check and never replays completed paid work. A store error during a check is a refusal.

---

## 14. Records, redaction, retention

**14.1 Durable write path** (B06). `records.write(kind, stream)`: stream through the redactor into a private temporary file in `records/`, fsync, rename to its immutable name, fsync the directory, then insert the Record row with the hash in a transaction. A transaction may reference a record only after publication. Streaming records write durable chunk receipts (offset, hash) so recovery can distinguish retained output from an unknown remainder.

**14.2 Redactor** (N05). Matches provider patterns and every resolved secret reference across chunk boundaries before bytes reach disk, the event stream, logs, or responses. The pattern version is recorded. A post-write scan with the same set runs on stored bytes; a hit raises a Critical Finding scoped to the project and emits `record.secret_found`. Cleanliness means no registered detector matched. A newly registered pattern triggers a bounded rescan of stored records; hits quarantine dependent evidence until resolved.

**14.3 Retention.** A Record is retained while any Finding, Approval, GateEvaluation, DeploymentVerification, Release, open Decision, non-terminal Run or WorkItem, ProtectedProposal, or pending journal entry references it. Unreferenced records expire per policy (default 90 days); the row is kept with `path = null` and `record.expired` is emitted. Recovery detects orphan files and missing or corrupt referenced files; missing evidence yields `EVIDENCE_MISSING` on dependent gates, never an empty record.

**14.4 Never in prompts.** Records enter an agent's context only through the engine's scoped context package (F §3.10.8); raw user reports never do (E5). Provider-native session files are D2's to redact, retain, and contain.

---

## 15. Model-invocation choke point

**15.1 One function.** `invoke(run, prompt_package)` in `engine/invoke/`: builds the execution context; checks lease generation, grant, state; selects the adapter from the trust table and refuses an unqualified backend, version, or mode (E1); constructs the child environment from the grant with secrets resolved inside the engine only; writes the InvocationReceipt; starts the transcript record; launches asynchronously with the prompt as data (stdin or file); records ProcessOwnership; forwards heartbeats and usage observations; enforces the deadline by cancellation; collects and validates the structured result against its schema and the transcript (`invalid_result` on contradiction); returns to the run's transition.

**15.2 Sessions** (B15). `session.open(project, role, subject)` creates the WorkItem subject, base revision, scoped workspace, grant, run lease, idle deadline, and the D2-qualified provider session binding; the Run enters executing with `session_state = open_idle`. `session.turn` requires open_idle, rechecks authority, qualification, budget, source applicability, and current evidence, sets turn_running, invokes with the **exact recorded provider session id** (never an ambient "last session" selector), writes Turn, receipt, observations, and a per-turn LedgerRow, and returns to open_idle; it never ends the parent Run. `session.save` and `session.close` enter saving, commit allowed artifacts through §7.3 and §7.5, and on close enter closing then §4.5. A failed save leaves the workspace retained and the failure visible. Session mode on a backend is refused until D2 records positive and negative continuation evidence; any context-replay fallback is a separately named and qualified mode, never silent.

**15.3 Resume is a new run** (F §3.9, B15). Resuming a stopped, timed-out, budget-ended, or recovered run creates a new Run linked by `parent_run`, with a fresh provider context reconstructed from durable records, newly scoped capabilities, re-verified revision and approvals, and reconciled effects, before dispatch. The old provider session is never resumed as a substitute.

**15.4 No other path.** A repository lint test fails on any spawn of a backend binary outside `engine/invoke/`.

---

## 16. Crash recovery

**16.1 At startup** (§1.4 step 4), in restricted mode:

1. **Runs.** Every Run not ended, whether or not its lease receipt completed: compare ProcessOwnership against the prior incarnation and host boot id; terminate owned surviving descendants by process group and containment identity without relying on current parentage; never signal a pid whose recorded start time does not match. Then §4.5 with outcome `recovered`; unconfirmed termination quarantines as §4.5 step 3.
2. **Journal.** §7.10 for every repository.
3. **Operations.** Every Operation `intended`, `in_progress`, or `ambiguous`, and every attempt `started` or `ambiguous`: reconcile through the adapter with a deadline; unreadable outcomes stay ambiguous with a `blocker` Decision; nothing retries.
4. **Records.** Detect orphan files and missing or corrupt referenced records; mark dependents.
5. **Workspaces.** Any `active` workspace whose run is ended becomes retained; nothing is deleted.
6. **Evaluations.** All marked stale.
7. **Integrity.** §7.6.

**16.2 Invariant** (A17, A18). After a process kill or a power loss at any point during a run, an integration, a protected application, or an operation, a restart results in: no lease held, no grant live, a ledger row or a quarantine for every started invocation with honest unknowns, every workspace retained or quarantined, every journal entry confirmed, retried once, or blocking, every operation terminal or ambiguous with a Decision, and no duplicate external effect. Process-kill tests and power-loss tests are separate evidence (D1-23).

---

## 17. Security invariants

Each is pinned by a test named after it.

1. Loopback bind; Host and absolute-form authority checked before routing on every request.
2. Exact self-origin for any present Origin or Referer; no CORS; token required on mutations and on origin-less requests, compared constant-time.
3. Prompts and arguments reach every child as data; option-shaped arguments validated or terminated.
4. Child environments constructed from the grant; the engine's environment never inherited.
5. Secret values exist only inside the engine's resolver between resolution and child start or redaction; store, records, events, responses, backups, and logs hold references only.
6. Snapshot-based diff validation enforces path, symlink, metadata, index, detached-HEAD, and registered-ref integrity for every role.
7. Every repository mutation and external effect has a journaled intent before execution and is reconciled before any retry.
8. Only a passed check state, derived by §9.2 from a runner-established execution with exit status zero, satisfies a gate; nothing writes `passed`.
9. A Decision is consumed at most once; a changed preview dependency makes it stale.
10. Ledger rows, usage observations, receipts, journal entries, and events are append-only at the database level.
11. The engine refuses any backend, version, or mode without a trust-table entry.
12. Control-plane material under the engine home is never written to a project repository and is not readable by role processes; D2 qualifies the isolation mechanism, and autonomy above supervised is refused on a backend whose trust entry lacks it.
13. Defensive response headers on every response, including errors; the UI's CSP is restrictive.
14. No request or stream callback can crash the engine; a failed audit write refuses the mutation.

---

## 18. Acceptance scenarios for D1

Integration tests against a real SQLite store, real git repositories in temp directories, and a scripted fake adapter. Real-binary lanes are D2's. "Kill" means SIGKILL of the engine; "power loss" means a filesystem-level simulation that discards unsynced writes.

| ID | Scenario | Required result |
|---|---|---|
| D1-01 | Same role dispatched twice | Distinct run ids, receipts, transcripts, results, workspaces, ledger rows (A05) |
| D1-02 | Usage across attempts, a stopped attempt with unknown remainder, then branch switch, rebase, squash, engine restart, read through the API, with a linked worktree and relocated repository after rebinding | Stable invocation identities, exactly-once totals, unchanged budget refusal, readable referenced records, no runtime data in tracked trees; an out-of-band change blocks gates without hiding history (A06, N01) |
| D1-03 | Answer a Decision twice; answer a consumed parked review | Second refused `decision_consumed`; one Approval; no adapter launch on consumption (A07) |
| D1-04 | Material dependency changes after a Decision is raised; the head moves after approval and before effect | Decision stale or invalidated; new generation raised; old answer has no effect; the effect never runs on the changed head (A08) |
| D1-05 | Trigger observed before completion, after refusal, after restart | One WorkItem throughout (A11, B10) |
| D1-06 | Kill between Operation intent and outcome | Ambiguous, reconciled by adapter read, no duplicate effect (A12, A13) |
| D1-07 | Two projects, hostile ambient `GIT_DIR`, `GH_REPO`, cwd | Every git call uses its own context; both targets asserted; ambient values absent (A16) |
| D1-08 | Stop during build; kill; restart; surviving descendant; reused pid; late callback | Descendants terminated by group; reused pid untouched; late callback rejected; quarantine when termination unconfirmed; resume creates a new Run (A17) |
| D1-09 | Runner reports not-executed; a check has no result; another ran at a different protected version; a required check set is empty; a result exists for the wrong environment | skipped, missing, stale, `ACCEPTANCE_SCOPE_INCOMPLETE`, stale respectively; gate not satisfied (A20) |
| D1-10 | Shell metacharacters in prompt; result path `../outside`; symlink out; snapshot race | Prompt literal; `diff_violation`; snapshot tree is what is validated and committed (A21) |
| D1-11 | Human commit on the integration branch; a developer branch moves | Integration branch: detected, gates blocked, Decision, discard or adopt journaled. Developer branch: no effect |
| D1-12 | Protected roots changed without an authorized version; policy edit to `protected_paths` | `PROTECTED_PATH_UNAUTHORIZED`; the policy edit routes to §7.9 |
| D1-13 | Store error during budget check | `store_error`; nothing dispatched |
| D1-14 | Decision past target; kill before and after notification delivery | Escalated once; NotificationIntent delivered once or marked unknown; never duplicated |
| D1-15 | Option previews | Effect plan equals what consumption writes; hash mismatch is `decision_stale` |
| D1-16 | Secret in a transcript split across chunks; new pattern registered later | Redacted before disk; post-scan clean; rescan raises a Critical Finding and quarantines dependents |
| D1-17 | Second `surety serve` | `engine_locked` with incarnation; first engine unaffected |
| D1-18 | Nomination at stage completion (T2) and on Builder request (T1); kill mid-nomination | Candidate, immutable ref, lineage succession journaled and recovered; Builder cannot nominate at T2 |
| D1-19 | Integration with moved HEAD; CAS failure; kill after update-ref before confirmation | Rebase and re-validate; `integration_conflict` parks; journal confirms on restart with no out-of-band false positive |
| D1-20 | Git child held open and a slow SSE consumer attached | `GET /v1/health` and Stop admitted within `api_latency_bound` (default 250 ms); an expired integrity step prevents dependent dispatch including after late completion (B09) |
| D1-21 | Verifier diff touching protected roots; another touching roots and source | First ends `proposal_captured` with no commit anywhere; second rejected whole (B04) |
| D1-22 | Apply an approved proposal; kill between authorization and application; kill between application and finalization | Recovery completes or blocks; no applied protected tree without an authorized version (B04) |
| D1-23 | Power loss after an effect's intent and after a record publication | Intent present on restart; record either fully published or absent, never referenced-but-missing (B06) |
| D1-24 | Fix disposition; defer without authority; Medium defer by Reviewer; High at alpha without exception evidence; finding from a prior candidate on the lineage | `FINDING_UNSATISFIED`; refused; refused; `FINDING_BLOCKING`; inherited and evaluated (B02) |
| D1-25 | Alpha authorize satisfied, deploy operation recorded, verification bound to a different operation | `*_complete` not satisfied; progress unchanged; `last_verified` unchanged (B03) |
| D1-26 | Kill mid-invocation after usage observations | Observations present; ledger row with `usage_complete = false` and null unknowns (B11) |
| D1-27 | Two blockers on different work items; same question with reordered evidence | Distinct identities; one identity (B12) |
| D1-28 | Observation job misses its freshness bound; repeated GETs | Condition Unknown with history visible; `observed_at` unchanged by reads (B13) |
| D1-29 | Host, Origin, Referer, fetch-metadata, token, body-cap matrix | Each refusal before routing or body read; headers on every response (B14) |
| D1-30 | Session open, turn, idle timeout, save failure, close; resume of a stopped run | States as §15.2; new Run with fresh context on resume (B15) |
| D1-31 | Repair loop: unchanged finding twice; typed contract conflict | Parked at no-progress limit; conflict routes to objection without a repair run (A09, A10) |
| D1-32 | Completed work, response lost before Run completion | Snapshot and receipts recovered; reconciled before any new invocation (A12) |
| D1-33 | Twenty event-stream clients, one slow | Bounded queues; slow client disconnected with cursor; worker dispatch unaffected (A19) |
| D1-34 | Supervised policy with a chaining limit | Dispatch stops at the boundary; the next step is a Decision (A23) |

---

## 19. Repository layout and build order

**19.1 Layout** (O8, O9, O11). This directory becomes the Surety development repository, history preserved; documents move under `docs/` with recorded renames when implementation is authorized (Q8, decided by Sean).

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
    src/invoke/                choke point; adapters/ (D2); ports/ with provenance (N04)
    src/records/
    src/ledger/
    src/api/                   server, routes, schema.json, cli/
    src/recovery/
    test/                      D1-01…D1-34; real git; scripted fake adapter
  packages/ui/
    public/                    zero-build HTML/JS; generated api types
  docs/
```

**19.2 Ports** (N04). Every ported module records upstream path, commit, retained tests, semantic adaptations, and its new owning contract. Legacy risk classification is not evidence of tightening; pure rules are extracted from acquisition code; qualification records name real binary, OS, mode, containment, and evidence.

**19.3 Milestones** (B16). **M1 is the preliminary engine loop**, not the walking skeleton. M1 needs: the store and transitions for every entity its paths touch, including Finding, SignOff, PolicyRevision, Operation, GitJournal, RefRegistry; git §7 complete; scheduler §8 with one run per project; gate function §9 for `stage` and `alpha_authorize`; decisions for `check_correction_*`, `finding_disposition`, `blocker`, `out_of_band_change`, `stop_confirm`, `abandon_confirm`, `policy_widening`; API reads and commands above except sessions, management, releases; events; ledger with receipts and observations; records; invoke one-shot; recovery. M1 may compute a stage gate and an alpha authorization; it MUST NOT report `alpha_deployed` or phase-one completion. **Surety's walking-skeleton phase stays open until M3** exercises a real minimal deployment target through alpha authorization, a journaled deploy operation, identity read, and a required external-interface behavioral check through the protected path, plus the phase-one Beta obligations if policy requires them. M2 adds Codex through the same contract, real-binary lanes for both backends, and the kill and power-loss scenarios. Dogfooding Surety on itself first establishes the E6 baseline and conformance path.

---

## 20. Open questions

Resolved from draft 1, with Astra's recommendations adopted: (1) one store per engine home with the export closure of §6.5; (2) nomination tags kept as immutable registered refs, decided by Sean; (3) adoption baseline is the exact current commit, unpushed included, decided by Sean; (4) one active run per project through M3, decided by Sean; (5) effect plans from owning transitions, adapters describe only; (6) sessions feasible on both backends but unqualified, no silent fallback; (7) events append-only, paginated replay, size telemetry; (8) this repository becomes Surety's, decided by Sean (O11).

Open for draft 2 review:

1. **Store worker placement.** §6.1 makes the worker thread the default and D1-20 the requirement. If a main-thread placement passes D1-20 in M1, may it stay?
2. **Snapshot of a running session at a turn boundary.** §7.3 relies on D2 quiescing the role. Is a turn boundary a sufficient quiescence point on both backends, or must checkpoints in sessions be refused until proven?
3. **Delivered requirements.** §9.1 derives them from roadmap phase assignment. Should a candidate deployed mid-phase count the phase's requirements as delivered only when its stages are integrated, or at phase start?
4. **Finding inheritance assessment.** §3.4 inherits unresolved findings across candidates unless an engine-recorded assessment says otherwise. Who may record that assessment: the Verifier in a fresh session, the Reviewer, or only a human?

---

## Appendix A. Schema and closed enumerations

A consistency check in the engine's test suite parses this appendix and fails on any field, state, event, reason code, or error code used in `schema.json`, migrations, or transitions that is not declared here, and on any declared transition whose states are not in the enumerations (N02).

### A.1 Id prefixes

| Prefix | Entity | Prefix | Entity |
|---|---|---|---|
| `inc_` | EngineIncarnation | `proj_` | Project |
| `spec_` | SpecRevision | `arch_` | ArchitectureRevision |
| `mod_` | Module | `road_` | RoadmapRevision |
| `plan_` | PhasePlan | `req_` | Requirement |
| `stage_` | Stage | `wi_` | WorkItem |
| `run_` | Run | `turn_` | Turn |
| `proc_` | ProcessOwnership | `grant_` | CapabilityGrant |
| `ws_` | Workspace | `lease_` | Lease |
| `rev_` | Revision | `lin_` | Lineage |
| `cand_` | Candidate | `prop_` | ProtectedProposal |
| `pv_` | ProtectedVersion | `chk_` | Check |
| `cr_` | CheckResult | `scope_` | AcceptanceScope |
| `gate_` | GateEvaluation | `fnd_` | Finding |
| `so_` | SignOff | `dec_` | Decision |
| `appr_` | Approval | `op_` | Operation |
| `att_` | OperationAttempt | `gj_` | GitJournal |
| `ref_` | RefRegistry | `ntf_` | NotificationIntent |
| `env_` | Environment | `envr_` | EnvironmentRecord |
| `obsj_` | ObservationJob | `dv_` | DeploymentVerification |
| `rel_` | Release | `inv_` | InvocationReceipt |
| `uo_` | UsageObservation | `led_` | LedgerRow |
| `pol_` | PolicyRevision | `rec_` | Record |
| `oob_` | OutOfBandChange | `ev_` | Event |
| `mi_` | MechanicIssue (deferred) | `tri_` | TriageDisposition (deferred) |
| `pic_` | ProductIntentContract (deferred) | `adopt_` | AdoptionAnalysis (deferred) |
| `exp_` | ExportRecord (deferred) | `prom_` | PromotionRecord (deferred) |

### A.2 Enumerations

- **Tier:** T1, T2, T3.
- **BaselineState:** idea, spec_ready, retired.
- **ManagementMode:** live, live_managed. **ManagementHealth:** healthy, degraded, unknown. **TriagePolicy:** manual, gated.
- **AdoptionMode:** full, scoped.
- **RequirementStatus:** pending, verified, descriptive_unverified.
- **StageStatus:** planned, building, integrated, verified.
- **WorkItemKind:** stage_build, verification, review, phase_verification, replan, spec_change, check_correction, triage_accept, export, publish, deploy, rollback, adoption_baseline, conformance, fix.
- **WorkItemStatus:** eligible, claimed, executing, integrating, integrated, verifying, complete, awaiting_decision, stopped, parked, cancelled.
- **RunKind:** one_shot, session. **RunState:** created, claimed, executing, validating, proposal_captured, finalizing, ended. **SessionState:** open_idle, turn_running, saving, closing. **RunOutcome:** completed, failed, refused, timed_out, stopped, abandoned, recovered. **RunReasonClass:** diff_violation, ref_violation, invalid_result, infra_error, preflight_refused, deadline, integration_conflict, budget, human_stop, human_abandon, recovered, none.
- **WorkspaceDisposition:** active, retained, quarantined, discarded.
- **LeaseKind:** run, integration, workspace.
- **RevisionKind:** working, checkpoint, engine_commit, nominated, out_of_band, protected, intent.
- **CandidateProgress:** developing, alpha_deployed, beta_deployed, live. **NominatedBy:** engine_cadence, builder_request.
- **ProposalStatus:** captured, classified, awaiting_human, approved, applied, rejected, withdrawn. **ChangeKind:** initial, tightening, loosening, unclassifiable.
- **CheckKind:** acceptance, smoke, sensitivity_floor, integration, post_deploy_identity, post_deploy_behavior, security_lint, property, failure_recovery. **CheckState:** passed, failed, missing, skipped, stale.
- **GateKind:** stage, phase, alpha_authorize, alpha_complete, beta_authorize, beta_complete, live_authorize, live_complete. **EvalOutcome:** satisfied, not_satisfied.
- **FindingScope:** project, lineage, candidate. **FindingStatus:** open, dispositioned, resolved. **Disposition:** fix, defer, accept. **Severity:** critical, high, medium, low. **SeverityAuthority:** role, reviewer, human.
- **SignOffScope:** candidate, module.
- **DecisionKind:** idea_accept, spec_approval, spec_change, architecture_approval, plan_approval, check_correction_loosening, check_correction_unclassifiable, finding_disposition, severity_lower, blocker, out_of_band_change, rollout_partial, publication_first_visibility, publication_subsequent, allowlist_widening, go_live, management_opt_in, triage, adoption_mode, requirement_confirm, stop_confirm, abandon_confirm, retire, reactivate, policy_widening, oob_dev_repo_change. **DecisionStatus:** open, answered, consumed, invalidated.
- **OperationKind:** git_ref_update, git_commit, publish, deploy, rollback, teardown, issue_file, issue_update, notify. **OperationStatus:** intended, in_progress, succeeded, failed, partial, ambiguous, superseded. **AttemptStatus:** started, succeeded, failed, ambiguous, reconciled_succeeded, reconciled_absent, reconciled_partial.
- **JournalState:** intended, applied, confirmed, failed, ambiguous. **RefKind:** integration, lineage, nomination, recovery, oob, keep.
- **NotificationStatus:** queued, sending, delivered, failed, unknown. **Channel:** in_app, email, webex, webhook.
- **ObservedCondition:** healthy, degraded, down, unknown. **Freshness:** fresh, stale, expired.
- **DeployVerificationOutcome:** verified, unknown, failed.
- **ReleaseStateFact:** prepared, published, staged, live.
- **CostStatus:** reported, estimated, unknown, measured_zero. **UsageSemantics:** cumulative, delta.
- **RecordKind:** transcript, tool_output, check_output, result, raw_user_report, parked_result, proposal. **PostScan:** clean, hit, pending.
- **Provenance:** observed, claimed, configured.
- **NowState:** refused, waiting_on_you, running, ready, idle, unknown.
- **EngineMode:** restricted, full.

### A.3 Tables and fields

Notation: `name: type` ; `?` = nullable ; `=Enum` = one of A.2 ; `→X` = foreign key ; `[ ]` = JSON array ; `{ }` = JSON object. Every table has `id`, `created_at`; every project-scoped table has `project →Project` indexed. Fields marked `*` are required at creation.

- **engine_incarnations:** `id*`, `pid*`, `started_at*`, `host_boot_id*`, `ended_at?`.
- **projects:** `name*`, `tier* =Tier`, `dev_repo_path*`, `integration_branch*`, `delivery_repo? {url, visibility, adoption_baseline_commit}`, `baseline_state* =BaselineState`, `prior_baseline_state?`, `adoption? {mode =AdoptionMode, pinned_revision, size_signals{}, deployment_evidence[]}`, `management {mode =ManagementMode, health =ManagementHealth, activation_evidence →Record?, triage_policy =TriagePolicy}`, `policy_revision →PolicyRevision?`, `paused* bool`, `seq_counters* {}`.
- **spec_revisions:** `version* int`, `git_path*`, `git_blob*`, `approved_by*`, `approved_at*`, `supersedes →SpecRevision?`.
- **architecture_revisions:** `version*`, `spec_revision* →`, `git_paths* []`, `approved_by*`, `approved_at*`.
- **modules:** `architecture_revision* →`, `name*`, `paths* []`, `sensitive_areas []`, `tier_override? =Tier`.
- **roadmap_revisions:** `version*`, `architecture_revision* →`, `git_path*`, `phases* [{number, goal, modules[], requirement_ids[], depends_on[]}]`.
- **phase_plans:** `roadmap_revision* →`, `phase_number*`, `prepared_against_spec* →SpecRevision`, `prepared_against_revision* sha`, `git_path*`, `approved_by?`, `approved_at?`.
- **requirements:** `spec_revision* →`, `key*`, `text_ref*`, `assigned_phase? int`, `status* =RequirementStatus`, `verified_by →GateEvaluation?`, `confirmed_by?`.
- **stages:** `phase_plan* →`, `number*`, `goal*`, `modules* []`, `requirement_ids* []`, `status* =StageStatus`, `work_item →WorkItem?`.
- **work_items:** `seq*`, `kind* =WorkItemKind`, `subject {stage?, candidate?, finding?, decision?, proposal?}`, `status* =WorkItemStatus`, `blocker? {reason, raised_at, decision →}`, `depends_on []`, `trigger_source*`, `trigger_id*`, `trigger_generation* int`, `trigger_consumed_at?`, `repair_attempts* int`, `no_progress_count* int`, `progress_key?`, `preflight_refusals* int`, `prior_status?`.
- **runs:** `seq*`, `work_item* →`, `role*`, `kind* =RunKind`, `state* =RunState`, `session_state? =SessionState`, `outcome? =RunOutcome`, `reason_class? =RunReasonClass`, `reason_text?`, `backend*`, `backend_version*`, `model_requested*`, `model_observed?`, `grant →Grant?`, `workspace →Workspace?`, `base_revision* sha`, `deadline_at*`, `started_at?`, `heartbeat_at?`, `finished_at?`, `parent_run →Run?`, `provider_session_id?`, `result →Record?`, `transcript →Record?`, `usage_complete? bool`, `quarantined* bool`.
- **turns:** `run* →`, `number*`, `invocation* →InvocationReceipt`, `started_at*`, `finished_at?`, `transcript_offset?`.
- **process_ownership:** `run* →`, `incarnation* →`, `pgid*`, `pid*`, `pid_start_time*`, `containment_id?`, `descendants []`, `termination_confirmed_at?`.
- **capability_grants:** `run* →`, `capabilities* []`, `env_allowlist* []`, `secret_refs []`, `issued_at*`, `expires_at*`, `revoked_at?`.
- **workspaces:** `run* →`, `path*`, `base_revision* sha`, `disposition* =WorkspaceDisposition`, `checkpoints [→Revision]`, `snapshot_tree? oid`, `disposed_at?`.
- **leases:** `resource_kind* =LeaseKind`, `resource_id*`, `owner_incarnation* →`, `generation* int`, `acquired_at*`, `renewed_at*`, `expires_at*`, `released_at?`, `closing* bool`.
- **revisions:** `sha*`, `lineage* →`, `parent_sha?`, `kind* =RevisionKind`, `created_by_run →Run?`, `recorded_at*`.
- **lineages:** `branch*`, `started_from_candidate →Candidate?`, `open* bool`.
- **candidates:** `seq*`, `revision* sha`, `lineage* →`, `nominated_at*`, `nominated_by* =NominatedBy`, `spec_revision* →`, `architecture_revision* →`, `nominated_protected_version* →`, `progress* =CandidateProgress`, `superseded_by →Candidate?`.
- **protected_proposals:** `seq*`, `run* →`, `base_revision* sha`, `tree_id* oid`, `diff_hash*`, `affected_checks* []`, `rationale* →Record`, `requested_change_kind* =ChangeKind`, `classified_change_kind? =ChangeKind`, `status* =ProposalStatus`, `approver?`, `approver_authority? =SeverityAuthority`, `resulting_version →ProtectedVersion?`.
- **protected_versions:** `seq*`, `fingerprint*`, `check_ids* []`, `change_kind* =ChangeKind`, `proposal →ProtectedProposal?`, `approved_by*`, `approver_authority* =SeverityAuthority`, `approved_at*`, `applied_by_operation →Operation?`, `authorized* bool`, `effective_from?`, `superseded_by →ProtectedVersion?`.
- **checks:** `key*`, `protected_version* →`, `kind* =CheckKind`, `required* bool`, `gate_kinds* []`, `tier_floor? =Tier`, `definition_path*`, `definition_hash*`, `requirement_ids []`, `sensitive_areas []`, `phase? int`.
- **check_results:** `check* →`, `candidate* →`, `revision* sha`, `protected_version* →`, `runner_id*`, `environment →Environment?`, `artifact_digest?`, `execution_established* bool`, `signaled* bool`, `deadline_hit* bool`, `exit_status? int`, `output →Record?`, `started_at?`, `finished_at?`.
- **acceptance_scopes:** `candidate* →`, `gate_kind* =GateKind`, `phase? int`, `stage →Stage?`, `spec_revision* →`, `architecture_revision* →`, `policy_revision* →`, `effective_protected_version* →`, `delivered_requirement_ids* []`, `sensitivity_categories* []`, `required_check_ids* []`, `required_signoffs* []`, `environment →Environment?`, `artifact_digest?`, `validated* bool`, `scope_hash*`.
- **gate_evaluations:** `scope* →`, `candidate* →`, `gate_kind* =GateKind`, `computed_at*`, `inputs_hash*`, `inputs_snapshot* {}`, `check_states* {check_id: =CheckState}`, `outcome* =EvalOutcome`, `reasons* []`, `satisfiers* []`, `stale* bool`.
- **findings:** `seq*`, `scope* =FindingScope`, `subject_id*`, `candidate →Candidate?`, `source_run →Run?`, `source_role?`, `proposed_severity* =Severity`, `effective_severity* =Severity`, `severity_history* [{actor, authority, from, to, at}]`, `sensitive_area?`, `status* =FindingStatus`, `disposition? =Disposition`, `disposition_authority? =SeverityAuthority`, `disposition_by?`, `disposition_at?`, `linked_issue?`, `defer_target?`, `reevaluated_at_gates []`, `alpha_exception? {containment_evidence →Record, testing_purpose}`, `resolution_verification? {evaluation →, check_result →}`, `applicability_assessment →Record?`.
- **signoffs:** `candidate* →`, `revision* sha`, `role*`, `scope* =SignOffScope`, `module?`, `run* →`, `scope_hash*`, `recorded_at*`.
- **decisions:** `seq*`, `kind* =DecisionKind`, `subject_type*`, `subject_id*`, `semantic_generation* int`, `scope*`, `question*`, `options* [{key, label, effect_plan{}, consequence_text}]`, `binds* {}`, `evidence* [{record →, provenance =Provenance}]`, `preview_hash*`, `blocked_while_open* {work_items[], gate?, operation?}`, `raised_at*`, `target_seconds*`, `escalated_at?`, `batch_key?`, `status* =DecisionStatus`, `answer? {option, note, actor, at}`, `consumed_at?`, `invalidated_reason?`.
- **approvals:** `decision* →`, `actor*`, `consequence*`, `revision* sha`, `result_hash?`, `policy_revision* →`, `protected_delta_shown? []`, `consumed_at*`.
- **operations:** `seq*`, `kind* =OperationKind`, `target*`, `subject* {}`, `idempotency_key*`, `semantic_generation* int`, `status* =OperationStatus`, `remaining_scope? {}`, `linked_prior →Operation?`, `deadline_at*`, `recorded_at*`.
- **operation_attempts:** `operation* →`, `attempt_number* int`, `status* =AttemptStatus`, `started_at*`, `finished_at?`, `timeline* []`, `reconciliation_reads []`.
- **git_journal:** `operation* →`, `repo*`, `ref?`, `tree? oid`, `old_oid?`, `new_oid*`, `run →Run?`, `lease_generation? int`, `state* =JournalState`, `confirmed_oid?`.
- **ref_registry:** `ref*`, `kind* =RefKind`, `expected_oid*`, `immutable* bool`.
- **notification_intents:** `source* {decision?, issue?}`, `channel* =Channel`, `key*`, `status* =NotificationStatus`, `attempts* int`.
- **environments:** `name*`, `adapter*`, `adapter_config_ref*`, `verify_spec* {identity_method, behavioral_check_ids[], target_set}`.
- **environment_records:** `environment* →`, `last_verified? {candidate →, artifact_digest, at, verification →}`, `attempted? {operation →, outcome, at}`, `observed* {condition =ObservedCondition, detail, observed_at?, source, freshness_bound_s, expires_at?}`, `frozen_at?`.
- **observation_jobs:** `environment* →`, `cadence_s*`, `next_due*`, `last_success_at?`, `last_attempt_at?`, `error_class?`.
- **deployment_verifications:** `operation* →`, `environment* →`, `target_set* []`, `artifact_digest*`, `source_delivery_mapping* {}`, `config_identity*`, `protected_version* →`, `identity_reads* [{target, expected, read, match, at}]`, `behavioral_results* [→CheckResult]`, `outcome* =DeployVerificationOutcome`, `computed_at*`.
- **releases:** `version*`, `candidate* →`, `delivery_commit?`, `artifact_digest?`, `source_artifact_mapping? {}`, `config_identity?`, `promotion_record →?`, `allowlist_version?`, `states* {prepared?, published?, staged?, live?}`, `recovery_plan →Record?`.
- **invocation_receipts:** `run* →`, `turn →Turn?`, `provider*`, `model_requested*`, `grant* →`, `budget_snapshot* {}`, `dispatch_status*`.
- **usage_observations:** `invocation* →`, `seq* int`, `semantics* =UsageSemantics`, `raw* {}`, `at*`.
- **ledger_rows:** `invocation* →`, `run* →`, `turn →Turn?`, `role*`, `provider*`, `model_requested*`, `model_observed?`, `raw_usage* {}`, `normalization_version*`, `billable_in? int`, `cached_in? int`, `out? int`, `usage_complete* bool`, `cost_status* =CostStatus`, `cost_usd?`, `day_utc*`, `corrects →LedgerRow?`.
- **policy_revisions:** `revision* int`, `git_path*`, `git_blob*`, `changed_by*`, `changed_at*`, `diff_summary*`, `widens_authority* bool`, `committed* bool`, `decision →Decision?`.
- **records:** `kind* =RecordKind`, `path?`, `sha256*`, `bytes*`, `redaction_version*`, `published* bool`, `post_scan* =PostScan`, `post_scan_finding →Finding?`, `retain_until?`.
- **out_of_band_changes:** `ref* →RefRegistry`, `expected_oid*`, `found_oid?`, `detected_at*`, `disposition?`, `decision* →`.
- **events:** `seq* int`, `at*`, `type* =EventType`, `subject* {}`, `actor*`, `request_id?`, `operation →?`, `payload* {}`, `tx*`.

### A.4 Gate reason codes

`ACCEPTANCE_SCOPE_INCOMPLETE`, `PROTECTED_PATH_UNAUTHORIZED`, `PROTECTED_VERSION_NOT_EFFECTIVE`, `OUT_OF_BAND_CHANGE`, `GIT_JOURNAL_PENDING`, `CHECK_NOT_PASSED(check, state)`, `FINDING_BLOCKING(finding, severity)`, `FINDING_UNSATISFIED(finding)`, `FINDING_DEFER_EXPIRED(finding)`, `SIGNOFF_MISSING(role, scope)`, `APPROVAL_MISSING(kind)`, `EVIDENCE_MISSING(record)`, `EXPORT_NOT_VALIDATED`, `ARTIFACT_MAPPING_MISSING`, `PUBLICATION_NOT_SUCCEEDED`, `RECOVERY_PLAN_MISSING`, `DEPLOY_OPERATION_MISSING`, `DEPLOY_VERIFICATION_MISSING(operation)`, `DEPLOY_VERIFICATION_UNKNOWN(target)`, `DEPLOY_VERIFICATION_FAILED(detail)`.

### A.5 Work item kinds: terminal and refusal transitions

| Kind | Success path | Preflight refusal |
|---|---|---|
| stage_build, fix | integrating → integrated → verifying → complete | claimed → eligible, parked after `preflight_refusals_max` |
| verification, review, phase_verification | executing → complete (writes results or sign-off) | same |
| replan, adoption_baseline, conformance | integrating → integrated → complete | same |
| check_correction | executing → complete (proposal captured) | same |
| spec_change, triage_accept | awaiting_decision → complete | n/a |
| export, publish, deploy, rollback | executing → complete when the Operation is terminal | same |

### A.6 Event types

`engine.started|tick|backup|quarantine|mode_changed`, `api.act`, `project.created|adopted|paused|resumed|retired|reactivated`, `baseline.spec_approved|architecture_approved|roadmap_revised|plan_approved|plan_refused`, `work.created|claimed|advanced|stopped|resumed|parked|cancelled|integrated|complete`, `run.created|claimed|started|heartbeat|validating|proposal_captured|finalizing|ended|quarantined`, `session.opened|turn_started|turn_ended|saved|closed`, `revision.recorded`, `candidate.nominated|advanced|superseded`, `protected.proposed|classified|approved|applied|rejected|unauthorized_detected`, `check.result`, `gate.scope_built|evaluated`, `finding.raised|severity_changed|dispositioned|resolved`, `signoff.recorded`, `decision.raised|escalated|answered|consumed|invalidated`, `operation.intended|attempt_started|succeeded|failed|partial|ambiguous|reconciled`, `git.journal_intended|applied|confirmed|ambiguous`, `repo.out_of_band|reconciled`, `environment.observed|observation_missed|verified|attempt`, `release.prepared|published|staged|live`, `invocation.receipt|usage`, `ledger.row|correction`, `policy.changed`, `record.written|expired|secret_found|missing`, `notification.queued|delivered|failed|unknown`.

### A.7 Error codes and reason-class mapping

Public codes: `illegal_transition`, `decision_stale`, `decision_consumed`, `decision_invalidated`, `confirm_required`, `store_error`, `engine_starting`, `engine_locked`, `backend_refused`, `budget_exhausted`, `repo_unreadable`, `out_of_band_change`, `quarantined`, `host_refused`, `origin_refused`, `token_required`, `token_invalid`, `payload_too_large`, `unknown_field`, `not_found`, `audit_failed`, `diff_violation`, `ref_violation`, `integration_conflict`, `invalid_result`, `scope_incomplete`, `slow_consumer`.

| Internal reason class | Public code |
|---|---|
| diff_violation, ref_violation, invalid_result, integration_conflict | same name |
| preflight_refused | backend_refused |
| deadline | reported on the run, not as an API error |
| budget | budget_exhausted |
| store failure anywhere | store_error |
| lease generation mismatch | illegal_transition |
