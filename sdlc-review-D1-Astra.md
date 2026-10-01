# D1 cross-review — Astra

Review date: 2026-09-30. Document reviewed: `sdlc-design-D1-engine-core.md`, Draft 1, introduced in `d25ad76`; review checkout `5772766`. This is an architectural cross-review, not implementation authorization. Only this requested review file was written.

Citation shorthand throughout: **D1** = `sdlc-design-D1-engine-core.md`; **F** = `sdlc-framework-foundations-v1.0.md`; **E** = `sdlc-foundations-v1.1-errata-draft.md`; **B** = `sdlc-foundations-v1.1-appendix-b-decision-trail.md`; **A** = `sdlc-review-Astra.md`; **C** = `sdlc-review-claude.md`. Section numbers after those keys refer to those files. Verity paths in §8 are relative to `/home/smahoney/projects/verity-framework`; console paths are relative to `/home/smahoney/projects/verity-console`. Evidence labels retain A §2.2's meanings; a design requirement is never labeled Implemented.

## 1. Verdict

**Reject with reasons.** D1 has the right ownership boundaries and is compatible with Sean's O8–O10 decisions, but its operative requirements do not yet establish the guarantees it claims: the gate admits incomplete scope and inadequate dispositions, protected proposals fall through to ordinary integration, durable receipts can disappear on power loss, retries have contradictory identities, stopping can release authority while processes survive, and terminal-only accounting cannot support recovery or live budgets. Several of the twenty incidents would therefore recur under a literal implementation. The amendments below define a repairable D1; D2 and D3 can supply their mechanisms, but cannot be asked to repair contradictory D1 contracts. This verdict does not reopen any errata decision. [Observed this review; Recommendation/inference: D1 §§4–16, 19.2–19.3; E E1–E17.]

## 2. Blocking objections

### B01. The gate has no complete, current acceptance scope

**D1 sections:** 3.3, 9.1–9.5.

**What is wrong and evidence.** §9.2 iterates whatever checks happen to exist and be applicable; zero applicable checks makes §9.3(3) vacuously true. Neither coverage of delivered requirements nor the tier/sensitivity floor is validated. §9.3(6)'s T2-versus-T3 wording also risks dropping T2's candidate sign-off at T3, which inherits T2. Applicability “by kind and phase” is not a recorded scope. Checks use the candidate's nominated protected version indefinitely, although E12 requires the current protected version and E13 invalidates affected evidence after correction. Merely matching *a* ProtectedVersion row accepts historical authorization. §9.2's query by the current revision cannot discover an older-revision result to label stale, and exit 0 is listed before the deadline veto. [Observed this review: D1 §§3.3, 9.2–9.5; F §§3.8, 3.10.4, 5.2, 5.6–5.7; E E8, E12–E13; A §10 A20; C §3.4 incident 17.]

**Proposed replacement text — replace §9.2 and qualify §9.3(1), (3), (6):**

> Each evaluation MUST name a recorded acceptance scope: candidate source revision, applicable approved baseline and architecture, policy revision, effective protected version, gate kind, phase or stage, delivered requirement ids, sensitivity categories, required check ids, required sign-offs, and environment/artifact where applicable. The engine MUST validate this scope against the tier's cumulative obligations, module overrides, sensitivity floor, and delivered requirements before evaluating results. Missing, empty, uncertain, or uncovered required scope produces `ACCEPTANCE_SCOPE_INCOMPLETE`; an empty required-check set never satisfies a gate. Undelivered requirements remain pending and are not counted as passed.
>
> The effective protected version MUST be the currently authorized version applicable to this scope, not merely any historically recorded fingerprint. The source and protected assets executed MUST be identified by immutable revisions or bundle hashes. A protected update MUST invalidate affected results and evaluations before another gate can pass. Where applying the update changes the candidate's source revision, the engine MUST nominate a new candidate; it MUST NOT rewrite the old candidate's identity or transfer its approvals. D3 MUST specify how the runner materializes the exact source/protected-assets pair.
>
> A required check is `missing` if no execution record exists; `stale` if the available result does not match the complete evaluation binding; `skipped` if execution was not established; `failed` if a deadline was hit, the process was signaled, or its exit status is nonzero or absent after execution; and `passed` only if execution was established, no deadline was hit, and the directly observed check-process exit status is zero. Result selection MUST include runner, environment, and artifact bindings where applicable and have a deterministic execution ordering. No approval, finding disposition, scope omission, or result summary assigns `passed`.
>
> T2 requires candidate-level Reviewer sign-off. T3 inherits that sign-off and additionally requires per-module sign-offs and a clear security review. Each sign-off MUST bind the reviewed revision and scope. Changing a scope dependency MUST invalidate the evaluation; retaining evidence requires the applicability assessment in Foundations §3.8.

### B02. “Has a disposition” does not implement the findings rules

**D1 sections:** 3.4, 9.3(4)–(5), 10.5.

**What is wrong and evidence.** A Medium finding with `disposition=fix` satisfies the literal predicate without verification. A defer lacks mandatory issue/authority checks; merely checking that its target has not passed omits reevaluation at every subsequent gate. The Alpha High exception needs recorded containment and testing purpose, but Finding has no such evidence. Severity history records a downgrade without requiring the asymmetric authority rule. Conversely, “no Finding … is blocking” does not explicitly exclude a verified resolved finding and could block it forever. A project-level Critical secret finding (§14.2) also cannot fit the mandatory candidate/source-run fields, and a new candidate can lose unresolved findings because the predicate examines only rows on that candidate. [Observed this review: D1 §§3.4, 9.3; F §§6.1–6.3; E E12; `mockup/Attention.dc.html`, F-212 options.]

**Proposed replacement text — replace §9.3(4)–(5) and add to Finding transitions:**

> Findings MUST support project, lineage, and candidate scopes and engine-origin findings without a source Run. A new candidate MUST inherit the applicability of unresolved findings unless an engine-recorded assessment establishes that they no longer apply; nomination alone never drops them. Finding transitions MUST enforce Foundations §§6.1–6.3. Proposed severity and effective severity are distinct; every effective change records its actor and authority. Any role may raise severity; only the human owner may lower a finding out of blocking range for the gate concerned; other downgrades require the Reviewer or human owner. No severity change changes a required-check result.
>
> A resolved finding MUST carry engine-observed verification of the fix applicable to this candidate. `fix` alone leaves the finding open and unsatisfied. A nonblocking open finding satisfies the disposition requirement only through an authorized `defer` with a linked issue, target, and reevaluation for this gate, or a human `accept` with a documented risk decision. Low deferral may be authorized by the Reviewer; Medium deferral requires the human owner. Expired or unreviewed deferrals block. A blocking finding cannot be deferred or accepted to satisfy a gate.
>
> An Alpha High exception MUST record evidence of environmental containment and the testing purpose. It MUST be refused for a sensitive-area finding and MUST NOT override a non-passed required check. Unknown sensitivity or missing exception evidence leaves High blocking. Verified resolved findings do not block solely because of their historical severity.

### B03. Deployment authorization and deployment completion are conflated

**D1 sections:** 3.5, 4.3, 9.3(7)–(9), 19.2.

**What is wrong and evidence.** Deployment verification is a mandatory input to the only gate function, yet the Release Operator needs satisfied gates *before* deploying. “Runs after deploy” is display copy, not an executable pre-deploy authorization. Looking up any verified row for `(environment,candidate)` can reuse verification from an earlier operation after a different artifact/configuration or failed attempt. Identity compares “revision” without distinguishing development SHA from delivery commit/artifact—the accepted Environments screen deliberately shows different SHAs. No required fields ensure at least one passed behavioral check, the correct protected version, or complete target coverage. [Observed this review: D1 §§3.5, 4.3, 9.3; F §§3.3, 3.7, 7.7; E E3; `mockup/Environments.dc.html`, release v1.4.0 and host c.]

**Proposed replacement text — add §9.7 and replace §9.3(7):**

> **Deployment authorization and completion.** The engine MUST evaluate a pre-deploy authorization using all applicable pre-deploy obligations, including revision-bound approvals, artifact mapping, export/publication requirements, and the recovery plan where required. This authorizes one identified deployment Operation; it never advances candidate progress. The post-deploy evaluation additionally requires a DeploymentVerification bound to that Operation, environment, target set, artifact digest, source/delivery mapping, configuration identity, and effective protected version. Historical verification of the same candidate is not sufficient for a new attempt.
>
> `verified` requires a matching readable deployed identity and at least one required external-interface behavioral check, all required post-deploy checks passed through the protected path, and verified coverage of the operation's target set. An unreadable required target remains Unknown. The engine MUST define the expected identity through the approved source-to-artifact mapping, not assume development and delivery SHAs are equal. Only a satisfied post-deploy evaluation advances the candidate and replaces `last_verified`. Failure or ambiguity updates `attempted` and `observed` without erasing historical verification.

### B04. A protected proposal falls through into the ordinary commit path

**D1 sections:** 5.2, 7.3–7.5, 7.8.

**What is wrong and evidence.** §7.3 step 2 says a Verifier proposal never integrates directly; its unconditional final paragraph then commits and integrates the passing workspace. No separate return state, approval-to-application transition, or crash ordering closes that path. Changing `protected_paths` by generic policy confirmation can also exclude previously protected assets without the E13 correction process. Checkpoints need a stable snapshot while the role is still writing; validation followed by staging mutable files does not prove that the committed diff was validated. [Observed this review: D1 §§5.2, 7.3–7.5; F §§5.2–5.3; E E2, E13.]

**Proposed replacement text — replace §7.3's final paragraph and amend §5.2:**

> A Verifier protected-change run MUST terminate validation by writing an immutable proposal containing its base, exact proposed tree/diff hash, affected checks, spec rationale, and classification request. It MUST NOT enter ordinary integration, including through checkpoint or intent-artifact paths. A forbidden application-source change rejects the entire run; proposal capture is not partial acceptance of a prohibited diff.
>
> Only `applyProtectedProposal` may apply an approved protected change. It MUST validate the proposal hash and base, enforce E13 approver authority and validation-scope approval, durably record the authorization and intended ProtectedVersion before the git effect, apply the exact approved change through the git operation journal, and finalize the version and evidence invalidation before gates or new runs can use it. Recovery MUST complete or block that operation; it MUST NOT expose an applied protected tree with no authorized version record.
>
> Changes to protected roots, commands, discovery, runner configuration, result collection, or required membership are protected changes regardless of which file contains them. Generic policy confirmation does not replace E13 approval. Unknown classification routes to the human.
>
> Every commit, including a checkpoint, MUST be made from an immutable snapshot captured after writers are quiesced. The engine MUST validate and commit the same tree, and verify the resulting commit's parent and tree. A checkpoint records a working revision without nomination or automatic integration. Remaining role work continues in a controlled workspace based on that checkpoint.

### B05. Git integrity lacks an ownership registry and a crash-safe receipt

**D1 sections:** 6.3, 7.1–7.7, 16.

**What is wrong and evidence.** “Tracked branch” is undefined; HEAD-only checks miss manual edits to tracked files, and storing expected HEAD *after every operation* could bless a concurrent foreign move. A crash after fast-forward but before recording expected HEAD is misclassified as an out-of-band change; local git writes have no Operation kind or reconciliation specification despite §6.3. `for-each-ref` before/after includes unrelated feature branches, engine nomination tags, and other concurrent engine work. A detached worktree shares refs with the main repository, and its detached HEAD can move without a named ref changing. [Observed this review: D1 §§3.3, 3.5–3.6, 7.3–7.7, 16; E E2, E10; A §§5.6–5.7, §10 A08/A16; B §B.4 A16.]

**Proposed replacement text — replace §7.6 and add to §7.5:**

> Each project MUST register its engine-owned integration and lineage refs, immutable nomination refs, and recovery refs, with expected object ids. The engine MUST separately record the checked-out worktrees and index/tree baselines it owns. Developer feature branches outside that registry are not gate inputs and MUST NOT be reset, adopted, or treated as engine corruption merely because they change. Joining engine-owned history requires explicit adoption or an authorized engine integration.
>
> Repository integrity MUST inspect registered ref identities and unauthorized index/worktree changes on managed checkouts. Missing/deleted refs and unreadable repositories are blocking observations, not new expected values. `surety/cand/*` and `surety/oob/*` are engine-owned audited refs; known journaled writes to them are expected, while unauthorized moves remain detectable. They are not blanket-ignore namespaces.
>
> Every engine git mutation MUST have a durable journal entry with operation id, intended old/new ref or tree, run and lease generation where applicable, and completion state. Integration MUST update a ref by compare-and-swap against its recorded old oid. Expected HEAD advances only to the journaled new oid. On restart the engine MUST reconcile pending git effects before out-of-band detection or redispatch: matching new oid completes the receipt, matching old oid permits a controlled retry, and any other value blocks reconciliation. Unreachable pending commits MUST be retained until reconciled.
>
> Role validation MUST include detached HEAD, index, repository metadata, and the exact proposed tree. Concurrent authorized engine changes MUST be reconciled against the journal rather than attributed to the role by a repository-wide before/after ref comparison. A role cannot obtain git authority by restoring refs before the comparison; D2 containment must enforce the prohibition before canonical repository access.

### B06. The selected SQLite durability does not meet the power-loss promise

**D1 sections:** 6.1, 6.3, 6.5, 14.1, 16.2.

**What is wrong and evidence.** WAL with `synchronous=NORMAL` protects consistency but can lose committed transactions after power loss. Losing the operation intent after its external effect defeats §2.5, §16.2, and A18. SQLite transactions also do not atomically persist files in `records/`; a row/hash is not a durability protocol. Default backups exclude the evidence needed to restore approvals and evaluations. [Observed this review: D1 cited sections; F §3.7; E E7/E16c; A §10 A18. External primary source: [SQLite PRAGMA synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous), FULL/NORMAL discussion.]

**Proposed replacement text — replace the durability clauses in §§6.1, 6.5, 14.1:**

> The store MUST use WAL with `synchronous=FULL`. A successful durable commit of an operation intent MUST precede its external effect. The qualified storage/filesystem must honor the required synchronization; unsupported storage is refused. Process-kill tests and power-loss durability tests are separate evidence.
>
> A Record MUST be redacted into a private temporary file, flushed and durably published under an immutable name before a transaction may reference its hash. Publication and directory durability MUST be covered by the qualified filesystem protocol. Recovery MUST detect orphan files and missing/corrupt referenced files; missing evidence blocks dependent gates instead of being treated as an empty record. Streaming records MUST have durable chunk or offset receipts so recovery can distinguish retained output from an unknown remainder.
>
> A recovery backup MUST include a consistent database snapshot, all records referenced by that snapshot, and a manifest of required repository objects and hashes. Referenced objects MUST be pinned against git garbage collection or included in the recovery package. A database-only copy MUST be labeled incomplete for recovery. Restore MUST verify references before dispatch, and portability MUST include explicit repository/secret-reference rebinding without copying secret values.

### B07. Retry identity is contradictory, and notifications are unjournaled effects

**D1 sections:** 2.5, 3.5, 4.4, 6.2–6.3, 10.4, 16.1.

**What is wrong and evidence.** §2.5 includes attempt number in the idempotency key, §4.4 requires retries to reuse that key, and §6.2 makes the key unique across separate Operation rows. These cannot all hold. §4.4 also permits retry after any reconciliation, including confirmed success. §16.1 omits already-ambiguous operations from its enumeration despite §1.4. Escalation sets `escalated_at` and sends exactly one message without a durable delivery operation; crash ordering either loses or repeats it. [Observed this review: D1 cited sections; F §3.7; E E7/E9; C §3.4 incidents 8/20; A §10 A12/A13/A18.]

**Proposed replacement text — replace §§2.5 and 4.4, extend §10.4:**

> A logical effect MUST have one durable identity and idempotency key independent of transport attempt number. Attempts MUST be distinct child records with a unique `(effect_id, attempt_number)` constraint. An ambiguous or timed-out attempt MUST be reconciled before another attempt. Confirmed success completes the logical effect and forbids another execution. Confirmed absence permits retry with the same key. Partial completion permits only the reconciled remaining scope; a newly chosen rollback or changed effect receives a new logical identity linked to the prior effect.
>
> Startup and tick recovery MUST enumerate recorded, in-flight, and ambiguous effects. An unreadable outcome remains ambiguous and blocks conflicting actions. Failed results that do not prove absence also require reconciliation. Operation types MUST cover local git effects and external notifications in addition to publication/deployment.
>
> Escalation MUST create a uniquely keyed notification in a durable outbox in the same transaction as the escalation event. Delivery is tracked separately. Adapters MUST state their idempotency/reconciliation capability; if delivery cannot be established, it remains unknown and the engine MUST NOT claim exactly-once delivery or blindly retry. D1-14 MUST include crashes before and after notification delivery.

### B08. Fences are useful, but the holder and stop protocol are insufficient

**D1 sections:** 3.2, 4.1, 4.5, 7.5, 8.3, 16.1.

**What is wrong and evidence.** The Lease holder is the engine pid, while recovery uses it as the run process pid. There is no persisted child process identity or start time, although §16.1 assumes both. An orphan from a prior engine cannot literally be a child of the new engine. Fencing rejects only a “higher” token; a released/expired same-token run can still pass that predicate. The integration lease requires kind/resource fields and no mandatory Run, but the schema has neither. Most seriously, §4.5 permits declaring Stop complete, releasing the lease, and discarding a workspace with a surviving process. Database revocation does not remove already-injected credentials from that process. Normal completed/failed ends also lack an explicit common cleanup transition. [Observed this review: D1 cited sections; F §§3.9, 4.2; E E1/E7; C §3.4 incident 7.]

**Proposed replacement text — replace §§8.3 and 16.1(1), amend §4.5:**

> A Lease MUST identify a resource, owner engine incarnation, monotonically increasing resource generation, expiry, and release state. Run leases and integration leases are distinct resource kinds. A run's process ownership record MUST separately persist its process-group or containment identity, pid/start identity, and descendants as required by D2. A pid alone never establishes ownership.
>
> Every callback or transition on behalf of a run MUST require exact generation equality, an unexpired unreleased lease, a live grant, and a permitted Run state. External effects MUST pass the same check at dispatch and use a journaled operation; a database fence does not cancel an effect already issued. Late callbacks from stopped or superseded runs are rejected even if no newer token exists.
>
> Every run end MUST finalize usage, workspace disposition, grant revocation, lease release, and operation reconciliation through one idempotent cleanup protocol. Stop first prevents new effects, cancels and confirms termination of the owned process tree, and reconciles issued effects or records them ambiguous with the dependent resources blocked. If death cannot be established, cleanup remains pending, the affected workspace/resources are quarantined, and dispatch on them is refused. The engine MUST NOT claim a completed Stop or discard/reuse the workspace while an owned process can still write it. D2 must qualify a containment mechanism that can enforce termination and capability expiry; emitting `orphan_process` is not that mechanism.
>
> Recovery MUST inspect all nonterminal runs, including runs without a completed Lease receipt, against the prior engine incarnation and persisted containment identity. It MUST terminate owned surviving descendants without relying on current parentage, and MUST never kill an unrelated reused pid. Recovered work follows the same cleanup protocol.

This keeps a small fencing mechanism. It does **not** establish correctness for a future second worker: that would additionally require a real distributed ownership and external-effect fencing design. [Recommendation/inference: D1 §8.3.]

### B09. Deadlines neither preempt synchronous work nor permit skipping safety prerequisites

**D1 sections:** 1.4, 6.1, 8.1, 8.5, 11.3, 18 D1-20.

**What is wrong and evidence.** `better-sqlite3` calls on the HTTP thread are synchronous. D1 does not say whether git uses asynchronous spawn; long git is harmless to the event loop only if it does. Timers cannot interrupt synchronous work; abandoning a promise also does not cancel its child or prevent late writes. Continuing after repository-integrity or budget steps time out may dispatch work whose prerequisites were never checked. SSE clients and large reads have no backpressure limits. Startup cannot return its promised 503 before the API listener exists. [Observed this review: D1 cited sections; E E7; C §3.4 incident 20. Primary source: [Node child-process documentation](https://nodejs.org/api/child_process.html#synchronous-process-creation), synchronous versus asynchronous execution.]

**Proposed replacement text — replace §8.5 and qualify §§1.4, 6.1, 8.1:**

> The HTTP loop MUST NOT execute synchronous child-process calls or unbounded file/hash/serialization work. Git and adapters MUST use asynchronous, owned subprocesses with bounded output. The single synchronous SQLite connection MUST be owned by a dedicated store worker within the engine process, with a bounded command queue and short transactions; no transaction remains open across git, adapters, or SSE delivery. Expensive scans and export/backup work MUST be chunked or isolated so they cannot prevent Stop admission or liveness responses.
>
> A deadline MUST cancel the step's owned work or mark issued writes ambiguous, invalidate its generation, and reject its late state-changing completion. An overrun of a safety prerequisite makes dependent dispatch/effects ineligible; independent project work, decisions, and recovery may continue. One total tick/recovery budget and per-resource budgets MUST bound iteration over many projects and operations. Dispatch launches work without waiting for the model run to finish.
>
> SSE subscriptions MUST use bounded per-client queues and replay cursors, release database snapshots before network writes, and disconnect slow consumers with a resumable cursor. The API listener MUST start in a restricted `engine_starting` mode before recovery if startup 503 responses are promised; only health/status is available until recovery establishes safety.
>
> D1-20 MUST hold a real git child open and attach a slow SSE consumer while verifying that status and Stop requests are admitted within the configured API latency bound. A second case MUST expire the integrity step and prove that no dependent dispatch occurs, including after its late completion.

The dedicated worker changes placement, not O9's stack, SQLite choice, dependency limit, or single-writer rule. [Recommendation/inference: E E17/O9.]

### B10. Trigger deduplication and work-state progression leave repeat dispatch paths

**D1 sections:** 3.2, 4.2, 7.3, 8.1–8.2.

**What is wrong and evidence.** `trigger.consumed` is set only at successful outcome. Repeated trigger observations while the first item is running/parked can create more items; no unique trigger constraint is specified. Ordinary git integration happens in §7.3 before WorkItem verification, but §4.2 permits `integrated` only after a gate and integration, with no completion path for successful replans or intent-only work. No transition releases a claimed item after preflight refusal. Human Stop returns work to eligible and can restart it on the next tick. “Repeated unchanged findings” has no progress key, typed contract-conflict outcome, or bounded automatic-retry rule. [Observed this review: D1 cited sections; F §5.8; E E7; C §3.4 incidents 6, 11, 13; A §10 A09–A11.]

**Proposed replacement text — add to §§4.2 and 8.2:**

> A trigger MUST have a stable source identity and semantic generation with a unique `(project, trigger_id, generation)` constraint. Observation creates or returns its one WorkItem, including while it is claimed, executing, parked, or awaiting a decision. Successful completion consumes the trigger atomically with durable outputs; retries remain attempts of that same WorkItem.
>
> WorkItem state MUST distinguish source integration from completion of required verification. Each kind MUST define its successful terminal transition, including intent-only work, and its preflight-refusal transition. No claimed item is left without an owned active attempt or a visible blocking reason. Scheduler selection MUST enforce every recorded decision dependency and autonomy boundary, not only `out_of_band_change`.
>
> Human Stop MUST retain work in a stopped/parked state until explicit resume. Abandon MUST discard only after confirmed termination and return the item to its recorded prior state without silently redispatching it. Resume creates a new Run linked to the old Run after revision, evidence, approval, and capability checks.
>
> Repair uses typed findings and a bounded attempt count. The engine MUST record the source/evidence change that constitutes progress; repeated unchanged findings consume the configured no-progress limit and park the item. A requirement/contract conflict routes to objection or baseline review without repeatedly buying code repairs. D1 acceptance tests MUST cover all four paths and duplicate triggers before completion, after refusal, and after restart.

### B11. Accounting cannot be terminal-only, and a “turn” needs one meaning

**D1 sections:** 3.6, 4.5, 13, 15.1–15.2.

**What is wrong and evidence.** §15.1 opens then writes a ledger row; §13.1 writes it only at termination; §6.2 makes rows immutable. There is no durable dispatch receipt or incremental usage record. Killing the engine can lose all usage reported before the terminal transaction, and the Build screen's live billable/context totals have no source. A one-shot CLI run can contain many model turns, but budget checks occur only at dispatch or between user session turns; “one turn overshoot” becomes a whole 45-minute run. Required numeric fields have no honest representation of unknown token counts. [Observed this review: D1 cited sections; E E7/E10/E16b; C §3.4 incidents 6/7/14; `mockup/Build.dc.html`, Budget and turn 23 of 80.]

**Proposed replacement text — replace §13.1 and qualify §13.3:**

> Before any model dispatch the engine MUST durably record an invocation receipt identifying run, turn where applicable, provider, requested model, grant, budget, and dispatch status. Provider usage observations MUST be appended durably as they arrive, with sequence/cumulative semantics sufficient to avoid double counting. One immutable terminal LedgerRow per invocation is derived idempotently from those observations and the final report; a unique invocation key prevents duplicate finalization. Later recovered usage is an append-only correction linked to that row, never an overwrite.
>
> Unknown tokens and unknown cost MUST be nullable/explicitly unknown, never normalized to measured zero. Cost status and usage completeness are separate. No dispatch is a distinct projection fact; it is not a provider-reported zero. Live budget/context displays derive from durable usage observations with timestamps and an unknown remainder. Raw provider usage and normalization version MUST be retained, with cache reads separate per E16b.
>
> Budget policy MUST name whether a boundary is a model turn, a user session turn, or a whole backend invocation. Adapters MUST qualify their usage and cancellation boundaries. Where turn-boundary enforcement is unavailable, the engine MUST disclose that limitation and apply a qualified hard bound or refuse a policy requiring a one-model-turn overshoot bound; it MUST NOT silently promise that bound for a multi-turn invocation. Budget exhaustion stops at the enforceable boundary, parks the item, and pauses dispatch as required by E7. Resolving the blocker MUST NOT override required checks or replay completed paid work.

### B12. Decision identity, stale-answer checks, and consequences are incomplete

**D1 sections:** 3.4, 4.6, 9.5–9.6, 10, 11.4.

**What is wrong and evidence.** Two `blocker` questions for different WorkItems can collide: `binds` lacks WorkItem, run, requirement, and other subject identities. Conversely, a changed timestamp or evidence order can change `evidence_hash` and evade dedupe. Uniqueness only among open rows permits asking an already consumed question again. §10.5 checks the displayed hash against its stored value, not against current evidence/policy/result state; stale marking on a later tick leaves a consumption window. Consequences for Stop, triage, adoption, rollback, and budgets cannot be derived solely from gate reason deltas. Applying git/policy changes inside the answer transaction conflicts with §6.3's external-effect protocol. Several E9 inventory decisions are missing (initial spec approval, idea acceptance, Abandon, Reactivate), and policy confirmation bypasses the attention queue. [Observed this review: D1 cited sections; E E9/P9, E10, E13; F §§3.7, 3.8; A §10 A07/A08; C §3.4 incident 10.]

**Proposed replacement text — replace §§10.2 and 10.5, amend §9.6:**

> Decision identity MUST be `(project, decision_kind, subject_type, subject_id, semantic_generation, gate_or_action_scope)`. Each kind MUST define its required subject and binding schema, including WorkItem, run, requirement, operation, and proposal identities where applicable. One semantic question MUST resolve to its existing open or consumed decision until a recorded material change creates a new generation. Evidence hashing MUST canonicalize ordering and omit presentation timestamps while retaining material evidence content and applicability. Changed material evidence invalidates the old generation; cosmetic changes do not re-ask it.
>
> The preview MUST be produced by the owning engine transition in dry-run form, returning the full effect plan, blockers, gate delta where applicable, and a hash of every material dependency. The same transition validates and consumes the plan. Adapter descriptions may supply observed target detail, but MUST NOT determine authorization or promise consequences the engine cannot enforce.
>
> Answering MUST compare the client's preview hash with a fresh transactional read of all bound state, including policy, protected delta, result hash, operation status, and evidence applicability. A revision is immutable; invalidation means the applicable subject or dependency changed, not that a candidate SHA was edited. An unchanged parked result is consumed without another model invocation. A stale answer has no effect.
>
> The consume transaction records separate decisions/approvals and durable effect intents atomically. External effects run afterward through their journals. Batch answers MUST be evaluated as a combined effect plan and refused if they conflict; all-or-nothing refers to local intent consumption, not guaranteed atomicity of multiple external systems. Publication/go-live approvals MUST record the exact protected-version delta shown to the human.
>
> The Decision inventory MUST cover every human decision in E9 and its subsequent amendments. Stop, Abandon, Reactivate, initial spec approval, and authority-widening policy changes MUST use that queue and preview protocol; convenience routes may create or consume those decisions but cannot bypass them.

### B13. Observed environment condition has neither a refresh job nor an expiry rule

**D1 sections:** 3.5, 8.1, 11.3, 12.2–12.3, 18 D1-20.

**What is wrong and evidence.** Reads correctly avoid adapters, but the tick algorithm never performs routine environment observations—only operation reconciliation. A healthy value can remain indefinitely after monitoring stops. Top-level `observed_at` is defined as the time inputs were read from SQLite; D1-20 reinforces that timestamp, which can make old monitoring look new. `source=adapter` is ambiguous for a cached observation. [Observed this review: D1 cited sections; F P8/§3.6; E E3; `mockup/README.md`, fact ages; `mockup/Environments.dc.html`, host c Unknown; C §3.4 incident 9.]

**Proposed replacement text — add a scheduler observation task and replace §11.3 timestamp semantics:**

> The scheduler MUST own bounded environment-observation jobs independent of deployment reconciliation, with configured cadence, per-environment freshness bound, last successful observation, last attempted read, error class, and next due time. Jobs share the engine's read/concurrency budget; opening more clients never adds adapter reads. An expired or unreadable current condition is Unknown, while the prior successful reading remains visible as historical evidence. Retired environments remain explicitly frozen at their final observation.
>
> Every response MUST distinguish `served_at`/snapshot sequence from each fact's `observed_at`, source, and freshness. Reading a row MUST NOT refresh its observation timestamp. Cached adapter facts retain adapter provenance and the actual read time. NOW may report refusal to act while separate fact fields remain Unknown; a known refusal is not evidence of the environment's condition. D1-20 MUST assert that repeated GETs do not advance source observation times and that missed observation deadlines produce Unknown without altering `last_verified`.

Thirty seconds is an acceptable default *sampling interval* for this local MVP if the age and freshness limit are visible. It is not a thirty-second guarantee of current truth, and urgent monitoring may need a separate cadence later. [Recommendation/inference: F P8/§3.6; E E5; D1 §1.5.]

### B14. The browser boundary omits defenses already established in the console

**D1 sections:** 11.1, 11.4, 17.

**What is wrong and evidence.** Exact Host allowlisting closes the ordinary foreign-host DNS-rebinding path, provided it is enforced on every request before routing. “Origin is loopback” is weaker than exact self origin including scheme/port. D1 omits absolute-form authority checks, `100 Continue` handling, no-CORS policy, defensive response headers, untrusted DOM/link rules, output limits, path lookup rules, and a token bootstrap for the UI. Token protection on mutations alone is not same-user child isolation: an agent able to read `api.token` and reach the API can act as the operator. Argument arrays prevent shell expansion but not option injection. [Observed this review: D1 §§7.1, 11.1, 17; console `docs/security-invariants.md` §§1–5, `lib/host.cjs`, `lib/csrf.cjs`; C §4.3 DNS-rebinding/input-hardening incident. Full 21-item comparison in §8.]

**Proposed replacement text — extend §§11.1 and 17:**

> Host and absolute-form request-target authorities MUST match the exact configured self-authority allowlist before routing, body reads, filesystem access, or `100 Continue`. A present Origin or Referer MUST match an exact self origin including scheme and port; `null`, malformed, and foreign origins are refused. Present browser fetch metadata MUST be consistent with same-origin use. Origin-less CLI requests require the bearer token. Token comparison MUST be length-checked and constant-time. No CORS access is granted.
>
> The API/UI hosting contract MUST define same-origin token bootstrap and keep tokens out of URLs, persistent browser storage, event payloads, and logs. Responses MUST use no-sniff, no-referrer, no-store for sensitive data, and frame denial; the UI MUST have a restrictive CSP, render untrusted content as text, and allow only approved link schemes. Error paths and rejected requests receive the same headers and redaction. Records/tails are returned only through scoped engine-owned identifiers with realpath containment and size/output limits. Unknown command/field values are refused; arguments that may be option-shaped require validated syntax or an explicit argument terminator.
>
> Engine home, store, token, journals, and canonical git metadata MUST be outside every role's writable/readable control-plane authority except expressly scoped record content. D2 MUST qualify isolation that prevents an agent from reading the operator token or impersonating an authenticated client; absence refuses unattended dispatch. Directory/file permissions and redaction apply to backups, events, responses, and logs as well as transcript files. No request or streaming callback may crash the engine; failed audit persistence on a mutation refuses that mutation.

### B15. Session turns and interrupted-run resume have no complete state contract

**D1 sections:** 3.2, 4.1, 8.4–8.5, 11.4, 15.2.

**What is wrong and evidence.** Run has no state column despite §4.1's state machine. Session open/idle/turn-running/saving/closing states are absent. A session needs a WorkItem, base revision, lease, and workspace, but `session.open(project,role)` does not establish them. Ordinary `invoke` appears to finish a Run on every turn. Project `/resume` only clears Pause; it does not implement F §3.9's fresh run, context, capabilities, evidence checks, and operation reconciliation. Native CLI continuation within an active session must not become resumption of a stopped run's old authority. [Observed this review: D1 cited sections; F §3.9; E E7/E10; A §10 A17.]

**Proposed replacement text — replace §15.2 and extend the Run model:**

> Run MUST persist its legal state separately from its terminal outcome. Session runs MUST define open-idle, turn-running, saving, closing, and terminal states, with one active Turn at a time. Opening a session creates its work subject, base revision, scoped workspace, grant, lease, idle deadline, and qualified backend-session binding. A Turn completion writes invocation/result/usage records but does not terminate the parent Run. Turn and session resource limits are separate. Explicit save and session end commit allowed artifacts through the same validated git path; failure to save remains visible with the workspace retained.
>
> Native continuation MUST use the exact recorded provider session/thread id, never an ambient “last session” selector. Each turn MUST recheck authority, version/mode qualification, budget, source applicability, and current evidence. D2 MUST qualify the continuation invocation independently, including containment, credential construction, accounting semantics, result capture, and provider session-file handling.
>
> Resuming a stopped, timed-out, budget-ended, or recovered run MUST create a new Run and fresh provider context reconstructed from durable engine records, linked by `parent_run`, with newly scoped capabilities. It MUST reverify revision and approvals/evidence and reconcile interrupted effects before dispatch. It MUST NOT resume the old provider session as a substitute for these steps. An unqualified native continuation mode is refused; any context-replay mode is separately named and qualified.

### B16. M1 is called the walking skeleton while removing its mandatory completion gate

**D1 sections:** 19.2–19.3.

**What is wrong and evidence.** M1 includes an Alpha gate “minus deployment verification,” defers environments/external operations, and is simultaneously named the completed phase-one walking skeleton. E4 requires actual Alpha deployment and E3 verification at every tier; a passing self-test alone does not satisfy them. D1 may stage implementation, but cannot label the preliminary loop as E4-complete. Its M1 entity list also omits Finding, SignOff, PolicyRevision, and Operation even though its gates, budgets, and journaled git transitions need those inputs. [Observed this review: D1 §§19.2–19.3; E E3/E4/E6; F §3.10.4; B §B.2 E4.]

**Proposed replacement text — replace §19.3 and the Alpha qualification in §19.2:**

> M1 is the preliminary engine execution loop. Its schema MUST include the findings, sign-offs, policy, and local operation records required by its actual transitions; an unavailable dependency remains unsatisfied rather than being bypassed. It may compute a stage gate and an incomplete Alpha evaluation, but MUST NOT report AlphaDeployed or phase-one completion without deployment verification. Surety's walking-skeleton phase remains open until a real minimal deployment target exercises the complete Alpha authorization, deployment operation, identity read, and required external-interface behavioral check through the protected path. It also completes the phase-one Beta obligations when required by project policy. A self-test process exit is supporting evidence, not deployment verification. Dogfood adoption, if used, MUST first establish the applicable E6 baseline and conformance path.

## 3. Non-blocking suggestions

### N01. Strengthen D1-02 so it proves the claim it names

**D1 section:** 18 D1-02. **Issue/evidence:** comparing ledger and event rows after a branch switch proves those rows survived that manipulation; it does not establish correct API totals, deduplication, continued budget enforcement, recovery, or separation from all source worktrees. The scenario can also intentionally trigger OOB protection, which should not be confused with store loss. [Observed this review: D1 §§6, 7.6, 13, 18; A §10 A06; C §3.4 incident 14.]

**Proposed replacement text:**

> D1-02 MUST record known usage across multiple attempts, retain a stopped attempt and unknown usage, switch/rebase/squash source history, restart the engine, and read history and totals through the API. Assert stable invocation identities, exactly-once totals, unchanged budget refusal, readable referenced records, and no runtime data in tracked trees. Run both authorized journaled git changes and an out-of-band change: the latter blocks affected gates but does not hide history or alter spend. Repeat with a linked worktree and relocated repository path after explicit rebinding.

### N02. Make the schema and closed enumerations mechanically consistent

**D1 sections:** 2.1, 3, 4, 6.2, 11.5, 12.1, 14.3. **Issue/evidence:** Lineage/SpecRevision/ArchitectureRevision/RoadmapRevision/PhasePlan/Module/Record/Approval ids lack listed prefixes; `record.expired` is emitted but absent from the closed event set; `integration_conflict`, `diff_violation`, `ref_violation`, and an Origin refusal lack matching API-code treatment; Record.path is required yet later null; §6.2's blanket id/project/created_at fields disagree with several tables. Sections 1.6/17(12) also literally prohibit committing anything under engine home, while §7.3 puts committable source workspaces there. These are editorially repairable once the blocking contracts are settled. [Observed this review: D1 cited sections.]

**Proposed replacement text:**

> Before D1 approval, its entity/state/event/error appendix MUST enumerate every persisted field, id type, nullability, legal transition, and code referenced in the document. Internal reason classes and public error codes MUST have an explicit mapping. A schema consistency check MUST fail on undeclared fields, event types, transition states, or required foreign-key cycles without a transaction-safe creation protocol. The engine-home export prohibition applies to control-plane records/secrets, not the validated project source snapshots deliberately held in engine-owned workspaces. Lineage succession MUST link candidates through `started_from_candidate`; a later nomination does not require membership in the already closed lineage.

### N03. Name UI contract additions without importing mockup fiction into state

**D1 sections:** 11–12. **Issue/evidence:** the API has useful core projections but lacks named access to working lineage, checkpoints, records/output evidence, detailed operations, roadmap traceability, management issues/activation, and some management commands. Later-owned features can remain deferred, but their API contracts need an owner. The mockup itself is inconsistent: Main says Ready alongside a running Verifier; Build says Running with three open decisions; Gate displays pv-19 passes while pv-19 is proposed. These are not grounds to corrupt the engine model. [Observed this review: `mockup/{Main,Build,Gate,Managed,Environments}.dc.html`; D1 §§3.7, 11.3–11.4, 12.3.]

**Proposed replacement text:**

> The API contract suite MUST map every accepted screen to engine projections and commands, with explicit ownership for deferred fields/routes. It MUST cover working lineage/checkpoints, roadmap and requirement status, evidence record access, operation timelines/reconciliation, per-invocation liveness/usage, protected-version review deltas, and management activation/intake controls. A mockup example inconsistent with the durable model is corrected in its fixture; it does not authorize an extra lifecycle state or fabricated evidence. NOW has one engine-defined project priority everywhere; a screen may separately title its local execution panel “Running.”

### N04. Preserve test provenance when porting O10 assets

**D1 section:** 19.1. **Issue/evidence:** O10 specifies selective ports with tests, but D1's layout never identifies their provenance or distinguishes legacy risk classification from D3's tightening classifier. The source distinction is verified in §8. [Observed this review: E E17/O10; C §8; D1 §19.1.]

**Proposed replacement text:**

> Every port MUST record upstream path, commit, retained tests, semantic adaptations, and its new owning contract. Legacy low-risk diff classification MUST NOT be treated as evidence that a protected correction tightens acceptance. Pure policy logic MUST be separated from legacy git/GitHub acquisition and state mutation; core store, scheduler, API, gate, and git remain clean-room under O10. Qualification records name real binary, OS, mode, containment, and positive/negative evidence; ported stub tests alone never create trust entries.

### N05. Retention must cover all live evidence links and multi-chunk redaction

**D1 sections:** 14.1–14.3, 17(5). **Issue/evidence:** retention lists selected referencing entities but omits open Decisions and run/work artifacts; stream chunk boundaries can split a literal secret; a same-pattern post-scan cannot discover every secret omitted from that pattern set. §17(5)'s “only inside invoke” contradicts §14.2 resolving values in the redactor. [Observed this review: D1 cited sections; E E16c.]

**Proposed replacement text:**

> Retention MUST follow all live references, including Decisions, Runs, WorkItems, proposals, and recovery receipts; a referenced record is never expired by age alone. Stream redaction MUST match secrets across chunk boundaries before bytes reach disk, SSE, logs, or events. The pattern registry and secret resolver are engine-internal services available to invocation and redaction; their values never become durable output. Post-scan cleanliness means no registered detector matched, not proof that no secret exists. Newly discovered secret patterns trigger a bounded rescan and Critical findings for affected stored records, with dependent evidence quarantined until resolved.

## 4. Recommendations on D1 §20's eight open questions

1. **Store scope:** Keep one store per engine home. Project portability needs a verified export/import closure—records, repository objects, identity remapping, and secret-reference rebinding—not JSONL alone; B06 specifies that closure. [Recommendation/inference: D1 §§6.5, 20.1; E E14.]
2. **Nomination tags — Sean's decision:** Keep them as immutable, journaled engine-owned refs, with globally unambiguous candidate numbers within each project repository. Do not “ignore” their namespace: validate authorized writes and detect unauthorized moves (B05). [Recommendation/inference: D1 §§7.6–7.7, 20.2; E E11.]
3. **Integration branch/adoption — Sean's decision:** Default to the repository's explicitly selected integration branch and record its exact current commit as the adoption baseline, including unpushed commits, with human-visible provenance. Unpushed is not unauthorized at initial adoption; subsequent unrecorded changes are, and a dirty checkout needs a separately recorded import/disposition before mutation. [Recommendation/inference: D1 §20.3; E E6/E10.]
4. **Concurrency — Sean's decision:** Keep one active run per project through M1–M3, with bounded parallelism across projects. Later permit concurrent read-only Verifier execution and Reviewer work on immutable candidate inputs; check authoring/proposal application and shared git refs still need serialization and fences. [Recommendation/inference: D1 §§7.3–7.5, 8.1, 20.4; B04/B05/B08.]
5. **Consequence generation:** Fixed templates suffice for a complete typed effect plan, not gate reason deltas alone. Keep consequence authority in the owning engine transition; an adapter may describe observed deployment targets but must not be the policy oracle (B12). [Recommendation/inference: D1 §§9.6, 20.5; E E9/E12.]
6. **Session continuation:** Native sessions are realistic on both CLI families, but neither session mode is qualified by the retained one-shot canaries; do not silently fall back. Make reconstructed-context turns a separate explicit mode only if needed, subject to the same permissions/accounting qualification and the fresh-run resume rule (B15); exact historical evidence is in §8. [Recorded observation; Recommendation/inference: C §3.7; D1 §20.6; E E1/E10.]
7. **Event retention:** Keep append-only events without deletion for v1, with paginated replay, bounded SSE, database-size telemetry, and backup/restore checks. Revisit archival from measurements; indefinite retention must not imply unbounded GETs or memory buffers. [Recommendation/inference: D1 §§6.5, 11.3, 12.1, 20.7; E E16c.]
8. **Repository location — Sean's decision:** Evolve `sdlc-x` into Surety's development repository and preserve this git history, moving documents with recorded renames when implementation is authorized. A separate design repository would introduce another synchronization boundary without a requirement for it; this recommendation authorizes no move now. [Recommendation/inference: D1 §20.8; E E15/E17; git chronology in §8.]

## 5. Errata conformance table

This table assesses **design coverage**, not implementation. The reference for each row is E's corresponding entry; B §B.2 is the reconstructed input trail (it predates E17 and has no E17 row).

| Errata | D1 coverage and remaining gap |
|---|---|
| E1 Backend contract | §§3.2, 5.5, 7.3, 15.1, 17(11) reserve the right seam. D2 legitimately owns trust/capability/real-binary qualification. Gap in D1: process/control-plane isolation and complete stop contract, B08/B14. |
| E2 Engine performs git | §§7.1–7.8, 15.2. Gap: proposal fallthrough, checkpoint snapshot safety, canonical ref ownership, durable local git receipts, B04/B05. |
| E3 Deployment verification | §§3.5, 4.3, 9.3(7). Gap: pre/post authorization, exact operation/artifact/target binding, minimum nonempty behavior proof, B03; adapter implementation later. |
| E4 Walking skeleton | §19.3 cites it. **Gap:** §19.2 omits deployment verification and no explicit phase-one completion predicate enforces Alpha/Beta obligations; B16. |
| E5 Mechanic triage | §§3.1, 3.7, 10.1/10.4, 14.4. Named/deferred, not implemented: triage mechanics, sanitized intent contract, sensitive-area routing, dedupe/caps later. B12/B14 protect the D1 boundary. |
| E6 Adoption | §§3.1, 3.7, 11.4. Named/deferred: claim-versus-reality analysis and conformance workflow. Gap in executable baseline/identity bootstrap: §7.2 requires `.surety/project.json` before normal calls; adoption must create/register it through a bounded bootstrap transaction. |
| E7 Interruption/stop/resume | §§4.5, 8, 16. Gap: process identities, orphan containment, common cleanup, budget-stop and fresh-run resume, B08–B11/B15. |
| E8 Check judgment | §§3.3, 9.2–9.4, 17(8), D1-09. D3 owns actual runner qualification. Gap: empty scope, exact applicability, deadline precedence, B01. |
| E9 Human decisions | §§3.4, 10–12. Gap: full inventory, semantic dedupe, stale dependency validation, general effect preview, durable escalation, B07/B12. |
| E10 Sessions and development integrity | §§7.6, 11.4, 15. Gap: dirty worktrees, registry, session state/resume/turn metering, B05/B11/B15. |
| E11 Nomination | §§2.3, 3.3, 7.7, D1-18. Broadly represented. Gap: lineage successor semantics and crash-safe nomination/tag journal; §4.3 says a later candidate on the “same lineage” though §7.7 closes it at nomination. B05/N02. |
| E12 Engine gate function | §§9–10. Correct authority; incomplete scope/findings/deployment/approval predicates and dependencies, B01–B03/B12. |
| E13 Asymmetric corrections | §§3.3, 7.3(2), 11.3 gates route. D3 owns classifier. Gap: protected proposal/application protocol, current version semantics, policy-root loophole, approval's durable delta acknowledgment, B01/B04/B12. |
| E14 Product shape / O8 | §§1, 6, 11–12, 19.1. Conforms to the chosen service/monorepo shape. Gap: explicit import-graph enforcement and joint engine/UI behavioral contract tests; schema-pin alone is not both. B09/N03. |
| E15 Provenance | D1 header names its inputs; repository history records them. B and history reconstruction exist. Standing practice, not an engine feature; D1 decisions still need recorded cross-review dispositions before approval. |
| E16 Retire, budgets, records | Retire: §§3.1, 4.2, 11.4 cite the rule, but concrete disable/freeze/reactivate transition remains deferred. Budgets/records: §§13–14. Gaps: durable incremental usage, honest boundaries, records/backup closure, B06/B11/N05. |
| E17 Stack and reuse / O9–O10 | §§6.1, 19.1 follow O9. Core is a new design as O10 requires. Gap: explicit selective-port/test provenance and regression-corpus placement; paths exist but some advertised “pure modules” require extraction, §8/N04. |

## 6. Scenario coverage: A01–A25

Source for every scenario: A §10. A D1 test id means a **specified test**, not a test executed or proved. “Gap” is used where D1 claims coverage but the scenario is materially narrower.

| Scenario | Coverage | Assessment |
|---|---|---|
| A01 Sound spec on each backend | D2 + later | Backend real-binary lane plus planning/baseline workflow. D1 has entities but no full sound-spec scenario. |
| A02 Vague spec | later | Baseline/spec workflow must park named gaps and resume the same request; not a D1 scenario. |
| A03 Unknown config key | D2 | §15.1 reserves refusal before spend; real flag/policy qualification required. |
| A04 Unauthenticated negative containment test | D2 | Positive liveness/auth control is a real-binary test obligation; no D1 fake proves it. |
| A05 Same role twice | D1-01 | Distinct Runs serve attempt identity. Extend explicit assertions to results/workspaces as well as transcripts/ledger. |
| A06 Branch-independent usage/history | D1-02, partial | Rows unchanged is narrower than visible/deduplicated history and continuing budget enforcement; N01. |
| A07 Consume parked review without re-invocation | **gap** | D1-03 tests only second-answer refusal. Add no-model-spawn, immutable result revalidation, unchanged head/policy, and atomic consumption; B12. |
| A08 Head changes during review/after approval | **gap** | D1-04 models a candidate “moving,” though identity is immutable; does not test the examined tree or movement after approval/before effect. B05/B12. |
| A09 Bounded small repair | **gap** | §4.2 names repair counts but no scenario pins progress, increment, repair handoff, or exhaustion. B10. |
| A10 Contract conflict escalates | **gap** | No typed conflict/repair distinction or scenario; B10. |
| A11 Successful trigger does not replan | D1-05 | Covers consumed trigger; extend to duplicate observations before completion and after restart, B10. |
| A12 Completed work, response lost | **gap** | D1-06 covers an Operation receipt, not completed model artifacts lost before Run completion or reconciliation before another invocation. B05/B11/B12. |
| A13 Ambiguous GitHub write | D1-06 + later | Scripted reconciliation shape in D1; real delivery adapter later. Retry schema currently contradictory, B07. |
| A14 GitHub unavailable/unauthorized | later | GitHub delivery/observation contract; D1 must preserve Unknown/error classes, B13. |
| A15 Late CI / clock differences | later | CI delivery adapter must define bounded pending and honest timeout; local check runner alone does not cover it. |
| A16 Two projects, hostile ambient git | D1-07, partial | Adds hostile env, but must assert both projects' exact targets and all engine git paths; B05. |
| A17 Cancel then restart | D1-08, partial | Add ungraceful kill, surviving descendants, reused pid, late callback, and explicit fresh resume; B08/B15. |
| A18 Power loss after effect | **gap** | D1-06's process kill does not prove power-loss durability; §6.1 contradicts it. B06/B07. |
| A19 Many tabs/fleet read budget | **gap** | Event streams avoid substrate polling but no scenario measures bounded queues, replay, shared reads, or worker capacity; B09/B13. |
| A20 Empty/skipped/stale checks | D1-09 + D3, partial | Skip/missing/old pv included; empty check set and wrong source/runner/environment missing. B01. |
| A21 Shell text / escaping path | D1-10 + D2 | Literal prompt/`../` case specified; include symlinks, metadata and snapshot races in containment qualification. B04/B05/B14. |
| A22 New CLI delegation capability | D2 | §15.1 trust-table refusal is the seam, not evidence of actual new-tool denial. |
| A23 Supervised plan/build boundary | **gap** | Selection priority does not define allowed chaining or a tested supervised launch boundary; B10/N03. |
| A24 Publication succeeds, deployment fails | later | §§3.5, 4.3, 9.3 reserve separate facts. Add actual partial rollout/reconciliation scenario with B03's binding. |
| A25 Local prototype graduates | later | Export/promotion/adoption designs must pin gate-definition replay, identity/history retention, and stronger policy. E6 adoption is not itself a graduation implementation. |

## 7. Incident coverage: Claude's twenty incidents

Source for incident descriptions and historical outcomes: C §3.4, **Recorded observation**. Prevention below is a D1 design assessment, **Recommendation/inference**, never a claim that Surety already prevents an incident. Partial coverage is explicitly marked as a gap.

| # | Incident | D1 mechanism or gap |
|---|---|---|
| 1 | Tail-swallowed lint | §9.2 engine-observed exit status and §17(8); E8 is the right rule. D3 must qualify the actual direct process, tool failure configuration, and nonvacuous runner. B01 closes scope/timeout holes. |
| 2 | Codex enforcement no-op; inherited credentials | §§5.5, 7.3, 15.1, 17(4)/(11) require constructed env, validation, and qualification. **Gap until D2:** tested containment and real-binary capability refusal; B14 adds control-plane isolation. |
| 3 | Headless Codex zero success; schema/auth/error bugs | §15.1 validates results and transcript contradictions, but **gap until D2:** actual argv/schema compatibility, nested error normalization, authenticated positive and negative lanes. Current drivers/canaries are reusable evidence (§8), not new qualification. |
| 4 | Read-only sandbox prevents branch/commit | §§7.1–7.5 assign git to engine, resolving ownership. B04/B05 required for safe exact-diff integration; D2 must deny role git without preventing engine git. |
| 5 | Sandbox cannot make GitHub reads/comment | §§7.1, 7.2, 15.1 put git/adapter effects and context assembly in engine. **Gap at adapter seam:** structured allowed effect requests and scoped engine-read snapshots must be specified in D2/later delivery design; roles must not be told to call GitHub. |
| 6 | Unknown cost treated as zero; breaker deadlock | §§13.1–13.3 separate unknown and expose a blocker. **Gap:** terminal-only usage, no defined budget-blocker resolution transaction, and possible retry of paid work; B10–B12. A refusal must not consume unrelated approval. |
| 7 | Context bloat, wrong role builds, delegation into void | One role per Run (§3.2), grants, deadlines, and process ownership (§§8/15). **Gap:** orphan exception contradicts ownership, lease identity is wrong, and one-shot turn limits are unclear; B08/B11/B15 plus D2 delegation qualification. |
| 8 | No-CI treated as red; duplicate summary trips breaker | Five check states (§9.2) prevent Boolean collapse for local checks. **Gap:** write idempotency schema conflicts, B07; late/no remote CI remains a later adapter obligation. No-progress counting must exclude duplicate reports, B10. |
| 9 | Unreachable GitHub appears empty; wrong repo | Execution context (§7.2), fail-closed store (§6.6), provenance (§11.3). **Gap:** stale observations and missing refresh/error behavior, B13; shared two-project targeting test needs stronger assertions. |
| 10 | Approval re-buys review or never advances | Single-use decisions and Approval.result_hash (§§3.4/10.5) are appropriate. **Gap:** no no-redispatch test, incomplete current dependency check, and no general consequence/effect transaction; B12. |
| 11 | Plan artifacts never become work items | Engine-owned intent commits (§7.8), WorkItems (§3.2). **Gap:** explicit plan-artifact-to-Stage/WorkItem registration and successful intent-work transition; B10. Files being committed does not by itself make tasks schedulable. |
| 12 | Just-opened PR prematurely gated on CI | **gap, later adapter:** D1 has no CI-registration grace/pending state. This need not block a local-only D1 milestone, but must not be claimed covered by `missing` alone. |
| 13 | Same request replans every tick | §8.2 + D1-05 consume the successful trigger. **Gap before completion/refusal:** no stable unique trigger receipt; B10. |
| 14 | Branch-bound ledger and fail-open fallback | §§1.6, 6.6, 13 place accounting outside source and refuse store failures; D1-02/D1-13. **Gap:** crash durability/live usage and complete visibility test; B06/B11/N01. |
| 15 | Intent artifacts uncommitted for 42 days | §7.8 explicitly gives engine ownership. **Gap:** journaled git completion, artifact pointer durability, and WorkItem success path; B05/B10. |
| 16 | New provider gains trust by denylist omission | §15.1 and §17(11) refuse absent backend/version/mode entries. Correct D1 seam; D2 must own the table and actual qualification, not accept driver self-declaration. |
| 17 | Async runner vacuous pass; skip as pass | §9.2 rejects skipped checks and requires execution signal. **Gap until D3:** vacuous async runner behavior must be tested; empty scope currently passes, B01. |
| 18 | Release truth split across two homes | §§3.5/12.2 give one Release mapping and separate publication/staging/live facts. Correct authority; **gap until later design:** mapping creation/reconciliation and export integrity, with B03/B07 required. |
| 19 | No-self-feeding hides plan role | Attention/blocked-while-open (§10), explicit WorkItems (§3.2), and E5 reserved triage entities (§3.7). **Gap:** intake eligibility/refusal visibility and positive plan-dispatch test; later triage must not silently discard same-operator intake. |
| 20 | Network outage stalls worker for 110 minutes | §§7.1/8.5 name deadlines. **Gap:** async placement, actual cancellation, stale callback exclusion, bounded aggregate recovery, and fail-closed dependent dispatch; B09. A timer alone does not solve it. |

## 8. What I verified versus inferred

### 8.1 Evidence and limits

**Observed this review.** Read F, E, B, D1, then `mockup/README.md` and all eight `.dc.html` files in the requested order; inspected A's evidence method, scenarios and verification record and C's incident register, backend discussion and asset inventory. Read mockup source/content, not a rendered browser session. The documents' git order is `ea4987d` (foundations), `77f6da2` (E1–E16/trail), `fa02bbc` (mockup), `d25ad76` (O9/O10/D1), `5772766` (brief). B §§B.2–B.4 reconstruct input provenance and explicitly defer A05/A14–A16/A19 and OS qualification; they do not prove that D1 closes those items. C-R28 and C-R29 remain process obligations, not demonstrated by D1's dogfood paragraph. [Paths: B §§B.2–B.4; D1 §§18–19.]

**Observed this review.** Verity framework HEAD remains `45344bbd6e83f8ee5f0a0c0b6856c464a98d0c7f`; console HEAD remains `741ccf3a9977eb4c60016a52509f8949bda88711`, matching A §2.1. Inspected the named source functions below, console `docs/security-invariants.md`, `lib/host.cjs`, and `lib/csrf.cjs`. Existing documents/source in all repositories were left untouched. No model benchmark, model invocation, deployment, test suite, security canary, or remote mutation was run.

**Recorded observation.** Prior real CLI findings come from framework `docs/dev/codex-headless-canary-results-0.154.0.md` (2026-09-24; Ubuntu 24.04.3/WSL2, Node 22.22.0), `feature-assessments/headless-no-delegation-assessment.md` (2026-09-25), C §3.7, and A §§5/12. Their original scopes and caveats remain in force. I do not claim to have rerun those canaries or to have personally performed the historical sessions recorded by another agent.

**Implemented.** Existing Verity/console mechanisms have source at the inspected commits—for example `trust.approvalConsequence`, both `normalizeUsage` functions, the production classification matcher, and console Host/CSRF guards. This label applies only to that existing code. Surety has no implementation under review, and the port has not occurred. [Paths/functions in §8.2 and §8.4.]

**Open/reported.** Historical issue references in A §§5–6/13 (including review-head binding, intent publication, redaction, repository identity, and read budgets) are retained reports; their current remote tracker status was not re-queried. Where the present D1 text independently exhibits a problem, the objection rests on that text instead of assuming an old issue is still open.

**Recommendation/inference.** All proposed amendment text, selected implementation placement, and verdict judgments are architectural deductions. Power-loss durability and Node event-loop distinctions were checked against official SQLite/Node documentation cited in B06/B09; no power-cut reproduction or event-loop benchmark was performed. The original review's test totals in A §12 were not rerun and are not new evidence here.

### 8.2 O10 port inventory: paths and actual semantics

C §8 abbreviates `agents/...` to `verity/bin/lib/agents/...`, and abbreviates bare helper filenames to `verity/bin/lib/...`; that is how I resolved them. Literal repository-root `agents/claude.cjs` is not the intended path. All O10 source assets below exist at those resolved paths; there is no missing driver or named core helper. The more important corrections concern what those functions do.

| O10 asset / C §8 reference | Verified source path and function | Verified supporting tests / limits |
|---|---|---|
| Coordinator, registry, result contract | `verity/bin/lib/agent-exec.cjs`; `verity/bin/lib/agents/index.cjs`; `verity/bin/lib/agents/result-contract.cjs`; `contracts/agent-result.md` | `tests/agent-exec.test.cjs`, `tests/agents-codex.test.cjs`, `tests/fixtures/agents/README.md` exist. No file named `tests/provider-contract.test.cjs`; C §3.7's “provider-contract test suite” is a conceptual description, not that literal filename. |
| Claude driver | `verity/bin/lib/agents/claude.cjs`, notably `buildArgv`, `normalizeUsage`, `normalizeResult` | Claude coordinator tests are in `tests/agent-exec.test.cjs`; no `tests/agents-claude.test.cjs`. No automated real-Claude lane was identified; C §3.7 already records this gap. |
| Codex driver and features | `verity/bin/lib/agents/codex.cjs`; `verity/bin/lib/agents/codex-features.cjs` | `tests/agents-codex.test.cjs`, `tests/codex-features.test.cjs`, `tests/real-codex.test.cjs`; dated real canaries exist. Tests were inspected/listed, not run. |
| Containment/passlist/policy/trust adjuncts | `verity/bin/lib/agents/{invariants,workspace,policy,tiers}.cjs`; `codex.cjs:childEnv`; `contracts/role-capability-policy.md` | `tests/provider-trust-tiers.test.cjs` exists. These are adaptation inputs to D2, not permission to import the old authority model intact. |
| Approval consequence | `verity/bin/lib/trust.cjs:approvalConsequence` (line 331); `verity/worker/index.cjs:{parkRecordMismatch,judgeApprovalEvent,pushesSince}` (lines 1237/1309/1434) | `tests/trust.test.cjs`, `tests/parked-resume.test.cjs` exist. `approvalConsequence` is pure but returns legacy merge/resume/re-review categories; D1 needs the broader typed effect plan in B12. |
| Diff classification | `verity/bin/lib/trust.cjs:classify` (line 168); `verity/bin/lib/substrate-local.cjs:localPrDiff` (line 806) | `tests/trust.test.cjs` exists. These helpers perform git/GitHub acquisition; they are **not both pure functions**. Classification is path/size/check-based low-versus-high risk, not an E13 tightening/loosening proof. Extract the reusable rules; D3's semantic classifier remains new work. |
| Usage normalization | `verity/bin/lib/agents/claude.cjs:normalizeUsage` (line 351); `verity/bin/lib/agents/codex.cjs:normalizeUsage` (line 822); ledger helpers in `verity/bin/lib/usage.cjs` | `tests/usage.test.cjs` and driver/coordinator tests exist. There is no separately named usage-normalization module in C §8. Claude's function folds cache reads into `tokens.in`; Codex's missing usage produces numeric zeros with unknown dollars. A verbatim port would contradict E16b/B11. |
| Promotion allowlist / matcher | `verity/bin/lib/classification.cjs:{parseClassification,compile,resolve}`; `verity/bin/lib/promotion-config.cjs`; `verity/bin/lib/promotion.cjs`; `.verity/production-content-classification.yml` | `tests/production-classification.test.cjs`, `tests/promotion{,-propose,-verify,-finalize}.test.cjs` exist. Matcher fails on unmatched paths and equal-specificity ambiguity; promotion itself is orchestration, not a pure function. Port the chosen matcher/rules, not the old core. |
| Regression corpus | `docs/adr/`, `feature-assessments/`, `docs/dev/codex-headless-canary-results-0.146.0.md`, `docs/dev/codex-headless-canary-results-0.154.0.md`, `benchmark/`, `tests/fixtures/agents/` | Directories/files exist. Preserve provenance and caveats; C §8's benchmark fixtures and assessments are historical evidence, not acceptance results for Surety. |

This is an O10 implementation clarification, **not an objection to O10**. Selective ports with adapted tests remain the decision. No source module at C §8's resolved O10 paths was found missing; the two missing test filenames above were checked as possible interpretations, not filenames actually promised by C §8.

### 8.3 Session feasibility at the recorded versions

**Codex 0.154.0 — Observed this review:** ran only `/home/smahoney/.codex/packages/standalone/releases/0.154.0-x86_64-unknown-linux-musl/bin/codex exec resume --help`. It exposes `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`, explicit session UUID, stdin prompt via `-`, JSON output, last-message output, and config/feature switches. Thus native headless continuation is not inherently unavailable at the last canaried version. The resume help is not identical to initial `exec` help; launch containment/configuration must be qualified on that subcommand rather than copied by assumption. [Primary documentation corroboration, not historical qualification: [OpenAI non-interactive mode, “Resume a non-interactive session”](https://learn.chatgpt.com/docs/non-interactive-mode).]

**Codex — Recorded observation / limitation:** the September 24 canary is for one-shot `agent-exec`; it does not qualify resumed-turn isolation, accounting, transcript identity, or permission persistence. C §3.7 records config writes despite `--ignore-user-config`, making session storage/control-plane isolation a concrete D2 concern. `--last` is inappropriate in a multi-project engine; persist the exact thread id. No resumed model call was made. [Framework `docs/dev/codex-headless-canary-results-0.154.0.md`, Effective policy/Sanitized argv; `verity/bin/lib/agents/codex.cjs`.]

**Claude — Recommendation/inference with explicit version limit:** continuation by explicit `--resume <id>` and print-mode streaming input are realistic candidates for D2. The retained driver at `verity/bin/lib/agents/claude.cjs:buildArgv` only implements one-shot print invocations, and the retained 2.1.281 observations concern headless execution/delegation, not an engine-mediated multi-turn session canary. The old 2.1.281 binary is not retained in the inspected local versions directory. The installed binary resolves to `/home/smahoney/.local/share/claude/versions/2.1.286`; its `--version` and `--help` advertise `--resume`, `--session-id`, `--input-format stream-json`, and session persistence controls. That observation is **not evidence of identical 2.1.281 behavior**. [Framework driver and `feature-assessments/headless-no-delegation-assessment.md` §§Claim/reality, Review on PR #285; C §3.7.]

On both backends, the right conclusion is “feasible mechanism, unqualified session contract,” not “qualified because one-shot passed.” `mockup/Settings.dc.html`'s invented Claude session qualification date is a consumer example, not canary evidence. D1 must retain E10's refusal until D2 records the actual positive/negative continuation evidence. Provider-native raw session files also need D2's redaction, retention, and containment treatment; D1's transcript redactor alone does not govern them. [E E1/E10/E16c; D1 §15.2; B15.]

### 8.4 All 21 console security invariants compared

Numbers below follow the order of bullets in console `docs/security-invariants.md` §§1–5, which has 21 invariants. This is a source/design comparison, not a fresh security test. D1 need not preserve obsolete spawn-per-read or fleet.json implementations; it needs their applicable guarantees.

| # | Console invariant | D1 disposition |
|---|---|---|
| 1 | Loopback bind | Present, §§1.2/11.1/17(1). |
| 2 | Host first, every route, absolute-form and 100 Continue | Host core present; HTTP edge paths unspecified. B14. |
| 3 | Exact self-origin CSRF before body; timing-safe token | Weaker loopback-origin wording and unspecified token comparison/bootstrap. B14. |
| 4 | Defensive headers, strict CSP, no CORS | Missing from D1; assign server/UI contract now, implement with UI. B14. |
| 5 | Enforced body caps with clean refusal | Limits named §11.1; streamed/lying length, early refusal, and no-side-effect tests still needed. B14. |
| 6 | DOM text-only rendering | UI-owned later; no D1 API contract safeguard yet. B14. |
| 7 | Safe link schemes | UI-owned later; explicitly carry forward. B14. |
| 8 | No request/callback crashes process | Missing explicit isolation requirement. B14. |
| 9 | Fixed command registry, no shell | D1 typed routes and argv arrays preserve the pattern (§§7.1/11.4/17(3)); do not reintroduce arbitrary command endpoints. |
| 10 | No option/flag injection | Not established by argv arrays; argument validation/terminators needed. B14. |
| 11 | Process/output/concurrency bounds | Partial §§7.1/8; output, SSE and cancellation gaps. B08/B09. |
| 12 | UI never merges/calls model | Present by O8 and §§1.1/15.3, but import-graph/joint contract enforcement needs N03. |
| 13 | Redact before responses/launch/audit | Record/log redaction stated §§14/17; response/event/SSE paths and chunk safety need B14/N05. |
| 14 | Server-owned paths | Execution context §7.2 helps; adoption is an intentional authorized path-input exception. Record/route containment must be specified, B14. |
| 15 | Upload sandbox, atomic writes, caps | Request cap exists; no upload persistence protocol. Record durability/path rules B06/B14 apply. |
| 16 | Realpath, regular-file, bounded preview | Missing for resolved evidence records/tails; B14. |
| 17 | Managed config keys, validated atomic writes | §11.4 validates policy but lacks a closed writable-field schema and cross-store/git commit protocol; B04/B05/B12. |
| 18 | Fleet shape + membership before every action/read | Project registry replaces fleet.json; nested project/entity ownership checks must be explicit for every route, not inferred from URL shape. B14's scoped identifiers. |
| 19 | Validated clone per target, ambient identity excluded | Strongly represented by §7.2 and D1-07; strengthen two-project, linked-worktree/ref assertions, B05. |
| 20 | No stored credentials; token only in process | Deliberately changed: D1 has a persistent 0600 operator token and secret references. Acceptable for the selected service shape only with private engine home, bootstrap/rotation policy and D2 agent isolation, B14. |
| 21 | Every mutation attributed and audited | Present §11.1, but durability/redaction/failure handling need B06/B14; engine events should identify authenticated actor and request/operation identity. |

### 8.5 Accepted UI as an API consumer

The examples do not authorize new states or weaker gates. This matrix identifies the contract needed to serve each accepted file; it does not require later adapters to be implemented in D1. [Source: `mockup/README.md`, screen-to-foundations table; D1 §§11–12.]

| Consumer | Usable D1 surface | Missing/ambiguous contract |
|---|---|---|
| `mockup/Main.dc.html` | `/engine`, `/projects` | Aggregate decision age/escalation, explicit no-dispatch/unknown totals, consistent NOW priority; B11/B13/N03. |
| `mockup/Overview.dc.html` | `/projects/:p` | Roadmap/requirement provenance and complete spend attribution; frozen/stale observations and candidate succession semantics. |
| `mockup/Attention.dc.html` | Decisions list/detail/answer/batch | General effect previews, canonical dedupe, exact protected delta and operation dependencies; B07/B12. |
| `mockup/Build.dc.html` | `/work`, `/runs/:r`, `/tail`, Stop/Pause/Abandon | Live model-turn/usage observations, lineage/checkpoint detail, fresh resume, action consequence binding; B10/B11/B15/N03. |
| `mockup/Gate.dc.html` | Candidate gate route | Complete acceptance scope, reason/satisfier truth, historical versus effective protected versions, output/evidence access; B01–B04. |
| `mockup/Environments.dc.html` | Environments/releases | Detailed operation/history/recovery-plan data and per-host observation freshness; B03/B07/B13. |
| `mockup/Managed.dc.html` | Project management fields; deferred §3.7 | Explicit later API for activation evidence, issue records/raw-report read, triage, pause Mechanic/disable management. Raw reports never become model context. |
| `mockup/Settings.dc.html` | Policy GET/POST; engine trust entries | Closed field schema, queue-mediated confirmations, target/secret-reference config ownership, backend session qualification evidence; B04/B12/B14/B15. |

### Questions for Sean

No answer is needed before judging this draft: the blockers follow from recorded decisions or internal contradictions. Your reserved decisions are D1 §20 questions 2, 3, 4, and 8; recommendations are in §4 above. I have no separate request to reconsider O8, O9, O10, or any other errata decision.
