# D1 draft-2 cross-review — Astra

**Reviewed:** 2026-09-30, `sdlc-design-D1-engine-core.md` Draft 2 at `357548d`.
**Scope:** Architectural review only. No implementation authorization, implementation edits, paid calls, or model canaries. The only write is this requested review file.

References: **D1** = `sdlc-design-D1-engine-core.md`; **DR** = `sdlc-review-D1-dispositions.md`; **R1** = `sdlc-review-D1-Astra.md`; **F** = `sdlc-framework-foundations-v1.0.md`; **E** = `sdlc-foundations-v1.1-errata-draft.md`; **B** = `sdlc-foundations-v1.1-appendix-b-decision-trail.md`; **Astra history** = `sdlc-review-Astra.md`; **Claude history** = `sdlc-review-claude.md`. Section identifiers below refer to these paths. The evidence labels retain Astra history §2.2's definitions.

## 1. Verdict

**Reject with reasons.** Draft 2 makes substantial corrections and closes five original objections, including the store-worker placement variant, but eleven remain open in their operative contracts. In particular, the new authoritative appendix cannot persist several required transitions, findings can disappear through status or lineage changes, deployment completion lacks attempt identity and publication enforcement, and process ownership still has a launch-receipt window and a parent-exit shortcut. The dispositions accurately describe the intended repairs; they do not establish that the resulting body and schema agree. I accept O11 and the three recorded Sean decisions in E18 without qualification or reopening them. [Observed this review; Recommendation/inference: DR blocking table; D1 §§4–16 and Appendix A; E E18.]

## 2. Original blocking objections and new blockers

“Closed” means the original design objection is answered, not that an implementation or acceptance test has passed. Cross-cutting Appendix A inconsistencies are collected in **B17**, rather than counting every missing field as another objection.

### B01 — Still open: scope and check-selection loopholes

**Draft-2 sections:** §§2.4, 3.4, 9.1–9.3, A.3; D1-09. **Disposition:** DR B01 says accepted.

Empty scope, deadline precedence, effective protected version, and cumulative T3 obligations are repaired. However, §9.1 maps each delivered requirement to a required check **or an applicability assessment**. F §3.8 permits justified evidence reuse; it does not let an assessment substitute for required acceptance evidence. Phase-start assignment also labels not-yet-integrated functionality “delivered.” Finally §9.2 selects an exact-match result, then says “no matching result → missing” before the mismatched-result → stale rule. The latter cannot classify the wrong-environment/old-version cases as D1-09 requires. An older matching pass can also hide a newer invalidating execution unless authoritative execution selection is defined. [Observed this review: D1 cited sections; F §§3.8, 3.10.2–3.10.4, 5.6–5.7; E E8/E12.]

**Replacement for §9.1's delivered-set and coverage clauses, and §9.2 selection:**

> Scope construction MUST use the candidate's immutable source and approved plan bindings. A requirement is included in the delivered scope only when its declared implementation obligations are integrated into that candidate, or the release scope explicitly requires it. Phase start alone does not establish delivery. Required release obligations MUST NOT be omitted merely because implementation is incomplete; they remain unsatisfied. Partial implementation MUST be represented separately from verified satisfaction. Phase completion requires all assigned phase obligations; subsequent roadmap edits cannot rewrite a prior candidate's scope.
>
> Every in-scope requirement MUST have the required acceptance coverage. An applicability assessment may justify reuse of identified execution evidence under Foundations §3.8; it MUST NOT replace a required check or waive its result. Uncertain delivery, sensitivity, or coverage blocks scope validation.
>
> Result selection MUST first determine whether relevant execution evidence exists. No evidence is `missing`; existing evidence whose bindings do not match is `stale`. Only an authoritative execution whose complete bindings match may then be classified as skipped, failed, or passed. The engine MUST record a deterministic execution order and invalidation relationship; a superseded or invalidated pass cannot be recovered by filtering out newer nonmatching evidence. Ties in timestamps MUST NOT change the selected result. D1-09 MUST pin old-source, old-version, wrong-runner, wrong-environment, and later-invalidating-execution cases.

The remaining scope-hash problem affects sign-offs and approvals too; see B03/B12 and B17.

### B02 — Still open: status and lineage transitions can shed findings

**Draft-2 sections:** §§3.3–3.4, 9.3(5), 9.4, A.2–A.3; D1-24. **Disposition:** DR B02 says accepted.

The authority, verified-fix, Alpha-exception, and project-origin rules are substantially improved. But §9.3(5) evaluates only **open** findings while A.2 has a separate `dispositioned` status. A `fix` changed to dispositioned—or a deferred finding later becoming blocking—can fall out of the query. Inheritance is limited to a later candidate “on the same lineage,” while every nomination closes a lineage and subsequent work opens another. D1-24 repeats the same-lineage assumption, so it does not catch that loss. Deferral reevaluation is stored by **gate kind**, allowing an old `beta_authorize` reevaluation to satisfy a later evaluation at the same kind. [Observed this review: D1 cited sections; F §§6.1–6.3; E E11/E12; R1 B02.]

**Replacement for finding applicability and §9.3(5):**

> Gate evaluation MUST include every applicable Finding that lacks verified resolution, including statuses open and dispositioned. A disposition never removes a finding from severity or applicability evaluation. `fix` remains unsatisfied until its resolution evidence is applicable and engine-observed. Resolved findings whose evidence is invalidated MUST again be evaluated as unresolved.
>
> Applicability MUST propagate through the candidate/lineage ancestry chain, following `started_from_candidate`, rather than requiring equal lineage ids. Project findings apply throughout their recorded scope. Nomination, branching into the successor lineage, or changing status alone never drops a finding. Applicability exclusions MUST be candidate-bound assessed records with actor, authority, evidence, reason, and review status; the authority rule is specified in §20 question 4's disposition.
>
> Deferral reevaluation MUST bind the particular candidate and gate evaluation context, including effective severity, sensitivity, target, and scope revision. A gate-kind label alone is insufficient. D1-24 MUST cover two successive nominations into different lineages and an already-dispositioned finding whose later-stage severity is blocking.

### B03 — Still open: completion needs the particular attempt and the missing publication condition

**Draft-2 sections:** §§3.5, 4.3–4.4, 9.3, 9.6, A.3–A.4; D1-25. **Disposition:** DR B03 says accepted.

The authorize/complete split is correct. A verification for a **different Operation** is now forbidden, as D1-25 tests. But retries are attempts of the **same Operation**, and DeploymentVerification has no attempt or deployment-generation field. A verification from before a later partial retry can therefore have all the listed bindings and still describe obsolete observed execution. Furthermore, `evaluateGate` takes no Operation, AcceptanceScope has none, and the deployment operation's subject is an untyped object: “that Operation” is not a resolvable binding rule. Finally, §9.6 dropped the Beta publication-success condition; `PUBLICATION_NOT_SUCCEEDED` exists in A.4 without an enforcing predicate. [Observed this review: D1 cited sections; F §§3.3, 3.7, 7.2, 7.7; E E3/E12.]

A second failure blocks progress: scope hashes include `gate_kind`, but §9.3 requires sign-offs and all approvals to match the current scope hash. `live_authorize` and `live_complete` necessarily have different scope hashes. A go-live approval for authorization cannot satisfy completion under literal equality. Baseline approvals made before a candidate exists likewise cannot all be candidate-and-gate-scope approvals. [Observed this review: D1 §§3.1, 9.1, 9.3(6)–(7), A.3 acceptance_scopes/approvals/signoffs; F §§3.2–3.3.]

**Replacement for §9.6 and associated bindings:**

> Deployment evaluation MUST receive an explicit Operation and deployment generation for completion; the engine MUST NOT select an arbitrary prior Operation for the candidate. Authorization creates one immutable DeploymentAuthorization binding candidate, artifact/mapping, configuration, environment, target set, policy, protected version, and the authorization evaluation. Each attempt records its scope and execution generation. DeploymentVerification MUST bind the verified attempt or explicitly assessed aggregate of attempts and its observation generation. A later attempt or target mutation invalidates prior current-completion evidence until reconciled and reverified. Previously verified per-target evidence may be retained only through an explicit applicability assessment covering the later attempt's effects.
>
> Beta authorization/completion MUST enforce the required successful publication and export-validation facts for the exact approved delivery revision and artifact. A failed, missing, partial, or ambiguous required publication cannot establish Beta. Export/publication authorization MUST also precede any public-visibility effect; a completion check after publication cannot retroactively authorize disclosure. The corresponding reason codes in Appendix A.4 MUST have explicit predicates.
>
> Approval and sign-off bindings MUST match their governed subject: baseline approvals bind baseline versions; candidate review binds the immutable reviewed acceptance content; deployment approval binds the DeploymentAuthorization. Authorization and completion may have different evaluation hashes while consuming the same applicable human authorization. This does not transfer approvals to another candidate. D1-25 MUST include same-Operation/different-attempt stale verification, multiple Operations on one candidate, and a successful authorize-to-complete path without a second go-live approval.

### B04 — Still open: immutable trees help, but quiescence and protected-change classification remain incomplete

**Draft-2 sections:** §§4.1, 5.2, 7.3–7.4, 7.9, 15.2; D1-21/22. **Disposition:** DR B04 says accepted.

An immutable tree and a separate proposal/apply route repair the principal fallthrough intention. Yet §7.3 admits a snapshot when a one-shot parent exits or at a session turn boundary, neither of which by itself proves all writers stopped; §4.5's own descendant problem is B08. Snapshot creation is itself a traversal, so validation of the resulting immutable tree does not prove it represented a coherent quiescent workspace. Also §5.2 makes roots-list/runner changes protected even outside the roots, while §7.3 tests **roots** and requires a Verifier proposal to touch roots “and nothing else.” A legitimate protected policy change cannot consistently use that route. [Observed this review: D1 cited sections; F §§5.2–5.3; E E2/E13; R1 B04.]

**Replacement for the snapshot precondition and protected branch of §7.3:**

> Snapshot admission MUST require an adapter-qualified quiescence acknowledgment covering every process and delegated task capable of writing the workspace, and an engine-held exclusive snapshot lease. Parent exit or a reported turn boundary alone is not sufficient. The lease/quiescence interval MUST cover tree capture and any engine rebase/reset needed before the role resumes. Until a backend/mode can establish that interval, live checkpoints and session saves are refused; a snapshot may be taken after confirmed termination of all writers.
>
> Validation MUST classify protected changes by the full governed execution path in §5.2, including protected metadata outside root directories. A Verifier proposal may contain exactly the protected change set authorized for that proposal, including governed policy fields; any application-source or other prohibited change rejects the run whole. Capturing a proposal is an intermediate Run state, followed by normal finalization and ended/completed, with no source commit. The ordinary commit path MUST be unreachable from proposal capture. Session save applies the snapshot without ending the session Run; only close or another terminal cause enters endRun.

### B05 — Still open: integrity and recovery do not yet cover the actual objects they own

**Draft-2 sections:** §§3.5, 7.2–7.10, 16.1, A.3. **Disposition:** DR B05 says accepted.

Registered refs, CAS updates, and excluding developer branches are correct. But §7.6 reads HEAD, index, and metadata without explicitly reading tracked working-file content; an unstaged edit can leave all three unchanged. “Modified managed checkout” also needs to exclude authorized role writes in an active workspace, otherwise legitimate Builder work is an OOB change at the next tick. No managed-checkout baseline table identifies either case. Ref-based discard cannot discard a dirty file or reconcile an unreadable repository, and OutOfBandChange requires a RefRegistry row for every kind of integrity failure. [Observed this review: D1 §§7.6, A.3 out_of_band_changes; E E10.]

Journal recovery always reads a ref, although `git_commit` and tree entries may have `ref = null`; worktree creation and other metadata mutations are also covered by the blanket “every git mutation” promise. §7.10 marks a ref-matching journal confirmed without specifying replay of its dependent candidate, protected-version, registry, and work-item receipts. A confirmed ref alone is not the committed domain transition. [Observed this review: D1 §§2.5, 6.3, 7.3, 7.7, 7.9–7.10, A.3 git_journal; D1-18/19/22.]

**Replacement for integrity subject/recovery clauses:**

> Managed checkouts MUST have typed registry entries for their expected HEAD, index, tracked-file baseline, and active workspace ownership. Integrity reads MUST compare tracked working-file content as well as refs and metadata. Writes permitted to an active run's workspace are evaluated by its snapshot validator, not classified as external edits merely because the workspace is dirty. Unauthorized edits to a managed integration checkout block its affected scope even if HEAD and index are unchanged.
>
> Integrity observations MUST identify their subject kind: ref, checkout tree/index/metadata, or repository availability. Reconciliation options MUST apply to that subject. The engine MUST NOT offer a ref reset as a purported fix for a missing repository or silently erase unrelated working files.
>
> Each journal kind MUST define its effect probe and domain finalizer. Commit/tree intents verify the intended object and its reachability; ref intents verify old/new oid; workspace mutations verify their owned metadata. Reconciliation of an applied effect MUST atomically finalize all associated domain receipts, including registry expectations, nominations, protected-version application, and Stage/WorkItem registration, before declaring that logical operation complete. The same finalizer is used after ordinary execution and restart. A ref match alone never bypasses it.

Append-only journal representation is additionally blocked by B17.

### B06 — Closed: durability policy and recovery closure

**Draft-2 sections:** §§6.1, 6.5, 14.1, 16.2; D1-23. **Disposition:** accepted.

FULL synchronization, fsync/rename publication, referenced-object retention, verified restore, and separate kill/power-loss evidence address the original objection. Filesystem qualification and actual power-loss tests remain implementation obligations; this review did not perform them. Appendix A still needs the promised chunk-receipt representation (B17), but the durability ordering itself is now explicit. [Observed this review: D1 cited sections; R1 B06; E E7/E16c.]

### B07 — Closed: logical-effect versus retry identity

**Draft-2 sections:** §§2.5, 3.5, 4.4, 10.4, 16.1; A.2–A.3. **Disposition:** accepted.

The operation's key no longer changes with attempt number; attempts have their own unique identity; retry requires reconciled absence/remaining scope; notifications have durable intents and can stay Unknown. This closes the original identity contradiction and no-blind-retry requirement. Operation-to-attempt status mapping and outbox ownership still need the Appendix A corrections in B17; stale deployment evidence across attempts is separately B03. [Observed this review: D1 cited sections; R1 B07; F §3.7.]

### B08 — Still open: parent exit and missing launch receipts can hide living writers

**Draft-2 sections:** §§3.2, 4.1, 4.5, 8.1/8.3, 15.1, 16.1–16.2. **Disposition:** DR B08 says accepted.

Quarantine instead of a falsely successful Stop is the right repair. But §4.5 confirms absence by the recorded pid/start time, then calls termination “trivially satisfied” for normal completion because the process exited. A child/grandchild can outlive that parent. There is also a launch window: §15.1 launches, then records ProcessOwnership. A crash between those steps leaves a running child that §16.1 cannot identify from a nonexistent ownership row. Recovery “whether or not its lease receipt completed” does not solve this. [Observed this review: D1 cited sections; E E7; Claude history §3.4 incident 7.]

The claimed→ended preflight-refusal path in §4.1 also bypasses endRun after the lease/grant were issued. The closing-generation rule refuses *every* write on behalf of the run before cleanup needs to store usage and effect reconciliation. It needs an engine-cleanup authority distinction. §16.2 also promises no lease held after restart, while §4.5(3) deliberately retains the quarantine lease. Lease-expiry recovery checks the owner engine's liveness, which does not establish whether the run/children are healthy. [Observed this review: D1 §§4.5, 8.1(1), 8.3, 16.2.]

**Replacement for termination admission and recovery obligations:**

> Before any child is allowed to execute model or project work, the engine MUST durably register a recoverable execution domain with an ownership id that restart can enumerate independently of parent pid. The launch protocol MUST prevent an unrecorded process from beginning authorized work. ProcessOwnership MUST cover every invocation and owned subprocess, including session continuations and engine-side git/adapter processes, with pid/start identities subordinate to that domain.
>
> Every outcome, including preflight refusal after a lease/grant was issued, MUST pass the idempotent cleanup finalizer; no claimed→ended shortcut may leave authority or a lease live. EndRun MUST establish that all writers and delegated tasks in the execution domain have terminated or permanently lost write/effect authority. Parent exit alone never establishes termination, including normal completion. Failure to establish domain termination leaves the Run finalizing and its resources quarantined. No successful completion, proposal completion, or discard bypasses this requirement.
>
> Closing a generation rejects further role effects and late success callbacks. Engine-owned cleanup transitions remain authorized to append usage, reconcile already-issued effects, and finalize disposition idempotently. They cannot issue new role effects. Recovery MUST distinguish released execution leases from quarantine reservations; its invariant is no reusable execution authority, with unresolved containment explicitly quarantined. Expired run leases are reconciled even when the engine owner remains alive.

### B09 — Closed with the variant noted: placement is a means; responsiveness is the contract

**Draft-2 sections:** §§1.4, 6.1, 7.1, 8.1/8.5, 11.3; D1-20/33. **Disposition:** accepted, variant.

The default worker, asynchronous git, bounded queues, and suppression of dependent dispatch after a failed prerequisite answer the original objection. A main-thread implementation is not inherently disallowed by O9. I accept the variant as a design choice, but D1-20 as currently written stresses git and SSE, not SQLite; passing that single setup is insufficient evidence to change placement. Expand its qualification workload as N03 below before allowing the alternative. [Recommendation/inference: D1 cited sections; E E17/O9; R1 B09.]

### B10 — Still open: success, Stop, Abandon, and repair do not have one legal work-state graph

**Draft-2 sections:** §§3.2, 4.1–4.2, 7.8, 8.2/8.4, A.5; D1-05/31. **Disposition:** DR B10 says accepted.

Unique trigger identity and atomic plan-to-work registration repair the planner-thrash and ownerless-work intentions. But §4 says its tables list the only legal transitions while A.5 adds executing→complete and awaiting_decision→complete paths absent from §4.2. A.5 calls export/deploy work successful when an Operation is **terminal**, which includes failed and superseded states. `conformance` succeeds after integration alone, contrary to E6's acceptance/deployment requirement. Stop is admitted during validation, but WorkItem can already be integrating/verifying and only executing→stopped is declared. Abandon restores eligible status, so the next tick can immediately re-buy the abandoned work. Finally `repair_attempts` is never specified to increment, and failure returns to eligible after a first outcome that is never set for the successful validating→finalizing path. [Observed this review: D1 cited sections; E E6/E7; F §5.8; R1 B10.]

**Replacement for the precedence and affected transition rules:**

> One authoritative transition table MUST govern each WorkItem kind and Run state; §4 and Appendix A MUST reference that same table. Successful validating→finalizing explicitly selects outcome completed. Proposal, verification, review, and intent-only paths MUST reach their declared terminal states without fictitious source integration. A terminal failed/ambiguous/superseded Operation never implies successful work completion. Conformance completes only after its E6 acceptance and deployment obligations are satisfied.
>
> Stop from any non-ended state that owns work MUST move that work into a held state once cleanup is established; it remains ineligible until explicit Resume. Abandon restores the recorded prior work state with a durable dispatch hold, cleared only by an explicit new-work/resume action. Cancellation or retirement while a run owns the item MUST initiate cleanup and cannot permit replacement work on its resources before termination or quarantine.
>
> Each automatic repair dispatch MUST atomically increment the bounded repair counter. The engine MUST define the semantic fields of the progress key, excluding new timestamps and replacement finding ids when the finding is substantively unchanged. Duplicate terminal callbacks cannot increment twice or dispatch twice. Requirement/contract conflict is a typed finding category, not free-text pattern matching.

### B11 — Still open: correction rows and dispatch receipts cannot satisfy the declared constraints

**Draft-2 sections:** §§3.6, 4.1/4.5, 6.2, 8.1(9), 13.1, 15.1–15.2, A.3. **Disposition:** DR B11 says accepted.

Receipts and incremental usage are the correct repair. But `ledger_rows.invocation` is unique for **all** ledger rows, while later corrections are additional rows in that table with the same required invocation. The correction insert fails. Receipts are append-only yet have `dispatch_status` without an enum or separate status-observation protocol. §4.1, §8.1(9), and §15.1 each write a receipt; nothing binds those operations to one invocation id. A session has a receipt per turn, whereas §4.5 still derives “the LedgerRow” for the run. [Observed this review: D1 cited sections; E E7/E10/E16b; Claude history §3.4 incidents 6/14.]

**Replacement for receipt/ledger identity and constraints:**

> The engine MUST allocate one invocation id before dispatch. Scheduler, invoke, Turn, ProcessOwnership, usage, and finalization MUST reference that same id; repeated prelaunch calls create-or-read it idempotently. An immutable receipt records intent. Dispatch-start, refusal, and terminal outcome are separate append-only observations keyed to that invocation, with a declared state derivation; they do not mutate the receipt.
>
> Exactly one original terminal LedgerRow is permitted per invocation, enforced by a unique constraint limited to rows with `corrects IS NULL`. Corrections MUST link that original row and have their own unique observation/generation identity. The schema MUST define whether corrections are deltas or replacements and totals MUST apply them exactly once. Finalizing a session reconciles its actual turn invocations; opening or closing an idle session does not create a fictitious paid invocation or a second terminal row for completed turns.
>
> A launch that never occurred is recorded as no dispatch, with no claimed provider usage. A launch whose occurrence or usage cannot be established after a crash remains explicitly unknown. D1-26 MUST cover correction insertion, repeated finalization, refusal before launch, and session close after multiple already-finalized turns.

### B12 — Still open: “every material dependency” lacks a complete effect-consumption binding

**Draft-2 sections:** §§3.4, 6.3, 9.7, 10.2–10.5, A.3; D1-04/15/27. **Disposition:** DR B12 says accepted.

Semantic identity and transactional fresh-read comparison are good repairs. The remaining problem is what the hash actually includes and when it remains sufficient. Options each contain an effect plan, but a Decision has one hash with no defined relationship to the selected option, option content, actor authority, or owning transition version. No closed dependency manifest exists. Time-based validity can expire without any stored row changing. Git/adapter facts were read before the transaction (§6.3); an outside ref or deployment change after that read is not caught merely by re-reading the same stored observation. A consumed Decision can sit as an effect intent while policy, protected scope, or environment generations change. D1-04 promises suppression of a changed-head effect but no general execution-time revalidation implements that promise. [Observed this review: D1 cited sections; F §3.7; E E9/E12/E13; R1 B12.]

**Replacement for preview and execution validation:**

> Each decision kind MUST declare a material-dependency schema. The preview binds the canonical decision identity, selected option or complete option set, effect-plan payload/hash and transition schema version, subject/revision/result hashes, applicable policy and authority, acceptance-content and protected-delta bindings, relevant operation/attempt/resource generations, and evidence applicability/freshness constraints. Evidence presentation ordering and served-at timestamps are excluded; semantic deadlines and expiry conditions are not.
>
> Answer validation MUST recompute the owning transition's eligibility predicates using the current time as well as current rows, then compare the preview binding and plan. External observations MUST carry source identities/generations and freshness bounds; stale observations cannot silently count as a fresh read. An effect intent records its preconditions and the exact authorization consumed.
>
> Immediately before an effect, the engine MUST revalidate those preconditions and use target-side conditional execution where available, such as git CAS. Changed preconditions block or invalidate the intent without transferring the approval. If an external target cannot enforce a condition atomically, its adapter contract MUST define reconciliation and the claimed guarantee; local hash equality is not proof of an unchanged external world. D1-04/15 MUST exercise changed policy, protected delta, target configuration, expired deferral, and same-Operation new attempt between preview, answer, and execution.

### B13 — Closed: observation ownership and truthful source age

**Draft-2 sections:** §§3.5, 8.1(5), 11.3, 12.3; D1-28. **Disposition:** accepted.

ObservationJob, source observation time distinct from served time, expiry to Unknown, and retained historical readings answer the original request. Appendix A still needs storage for the historical observations it promises (B17). Freshness must also be evaluated at action time as B12 requires; GETs must never manufacture a new observation. [Observed this review: D1 cited sections; F P8/§3.6; R1 B13.]

### B14 — Still open: token bootstrap is circular and isolation has a weaker exception

**Draft-2 sections:** §§1.6, 11.1/11.4, 17(2)/(12); D1-29. **Disposition:** accepted, isolation assigned to D2.

The ordinary browser protections from the 21-invariant table are largely present. However, the UI obtains its token through `POST /v1/token/bootstrap`, while §11.1 requires the token on mutations and §17(2) additionally requires it on origin-less requests. There is no explicit bootstrap exception or alternative read-only route, so a fresh UI cannot obtain its first token under the declared rules. Section 11.4 lists bootstrap among transition commands; if it is intended to be read-only rather than a mutation, that distinction and its authentication rule must be explicit. An unspecified exemption would become a security-critical implementation guess. Body caps also cannot be enforced “before reading” an unknown-length stream; only known excessive declared length can be refused that early. [Observed this review: D1 cited sections; console `docs/security-invariants.md` §1 and `lib/csrf.cjs`; R1 §8.4.]

Separately, §1.6 forbids role access to control-plane material, but §17(12) refuses missing isolation only **above supervised**. Human initiation does not make a model role mechanically unable to read the token or reach the engine. The E1 guarantee applies to every backend/run; this is not a permitted autonomy-floor reduction. [Observed this review: D1 §§1.6, 17(12); F P4; E E1/E2/E10.]

**Replacement for bootstrap and isolation clauses:**

> Token bootstrap MUST be an explicitly named read-only same-origin endpoint that does not require possession of the token it returns. It MUST enforce the exact Host/target checks and positive same-origin browser request evidence, refuse contradictory or cross-origin signals, grant no CORS, use no-store, and return no token to ordinary origin-less API clients. CLI clients obtain the token from the private engine file. The bootstrap exception applies only to that endpoint and does not authorize mutations; D1-29 MUST test a fresh browser session and hostile bootstrap requests. All ordinary origin-less API requests follow the token rule in §17.
>
> Known excessive Content-Length is refused before consuming the body. All bodies, including chunked or mismatched-length bodies, MUST be byte-counted under bounded request deadlines and buffers; crossing the cap refuses further parsing or effect dispatch. The implementation MUST define safe connection termination and consistent error/audit behavior.
>
> Every role process, including a supervised session, MUST be prevented from reading or modifying the engine control plane or impersonating the operator. A backend/mode without qualified isolation is refused for such a run regardless of autonomy setting. D2 owns the mechanism and qualification, not an exception to this requirement. Authorized bootstrap/secret references never grant role access to the operator token.

### B15 — Still open: session state, snapshot base, and invocation lifetime disagree

**Draft-2 sections:** §§4.1, 7.3–7.4, 15.1–15.3, A.3; D1-30. **Disposition:** DR B15 says accepted.

Fresh Run identity on interrupted-run resume is repaired. Within a live session, however, §15.2 opens directly in executing while §4.1 requires claimed→executing on adapter launch; it requires the exact provider session id before the first invocation can establish one. The state sketch only has `open_idle ⇄ turn_running → saving → closing`, while save is intended to return to an open session. A save calls §7.3, which normally commits and proceeds toward ending the Run; repeated saves still require detached HEAD at `base_sha` after §7.4 has rebased the workspace onto a checkpoint. ProcessOwnership is per Run even when continuations create different processes. [Observed this review: D1 cited sections; E E10; R1 B15.]

**Replacement for session lifecycle rules:**

> Session creation MUST distinguish an allocated engine session from a launched provider invocation. The initial Turn starts a new provider session and durably captures its returned id; only subsequent turns use that id. Each invocation has its own process-ownership and accounting identity within the session's recoverable execution domain. An idle session with no process is represented explicitly and is not a running child.
>
> Session transitions MUST include open_idle→turn_running→open_idle, open_idle→saving→open_idle, and open_idle/saving→closing→finalizing→ended, with explicit failure, timeout, Stop, and Abandon paths. Saving calls a reusable snapshot/apply operation; it MUST NOT take the one-shot Run termination path. After each checkpoint/save, the engine MUST record the new expected workspace HEAD, base tree, and outstanding delta, preserving the Run's immutable original base separately. Subsequent validation compares against the current recorded workspace base and the full authorized change history. Failed saves retain a visible recoverable state and cannot permit a new turn to race an unfinished git operation.
>
> Session idle deadline and active invocation deadline are separate. Open idle state does not consume a fake invocation or grant unbounded authority. D1-30 MUST include initial id capture, two turns with distinct child processes, two saves, continuation after save, idle timeout, and restart during save.

Backend quiescence remains independently required by B04; neither CLI's turn marker establishes it without D2 evidence.

### B16 — Closed: M1 no longer claims the walking skeleton

**Draft-2 section:** §19.3. **Disposition:** accepted.

M1 is explicitly preliminary, cannot claim Alpha deployment or phase-one completion, and the required entities and later real deployment verification are named. The skeleton remains open through the applicable Alpha/Beta obligations. This closes the original labeling/floor objection. Conformance's contradictory terminal path in A.5 must still be corrected under B10; M1 real model use cannot precede E1 qualification merely because the real-binary lanes are described under M2. [Observed this review: D1 §19.3; E E1/E3/E4/E6; R1 B16.]

### B17 — New blocker: the authoritative appendix cannot implement the body as written

**Draft-2 sections:** §§4, 6.2, 7.5/7.10, 9–16, Appendix A. **Evidence:** direct body-to-appendix inspection, supplemented by a lexical occurrence check. The proposed future schema parser checks implementation against A, not A against the body; both must be consistent before implementation. This is N02 elevated by Draft 2's new authoritative-schema claim. [Observed this review: D1 scope header, Appendix A introduction; DR N02.]

| Contradiction or omission | Body / appendix anchors | Consequence |
|---|---|---|
| GitJournal is append-only with UPDATE refused, yet a journal entry advances intended→applied→confirmed/ambiguous. No journal-event sequence/fold or separate mutable projection is declared. | §§6.2, 7.5, 7.10; A.3 git_journal | Ordinary integration cannot record its outcome under the stated representation. |
| Ledger corrections conflict with unconditional invocation uniqueness; immutable receipt status has no evolution protocol. | §§6.2, 13.1; A.3 ledger_rows/invocation_receipts | Accounting repair cannot be inserted; B11 supplies the correction. |
| `=EventType` appears in A.3 but is not declared in A.2 (A.6 needs an explicit enum alias). `→Grant` targets no A.1 entity; intended entity is CapabilityGrant. Several arrows have no target. | A.1–A.3, A.6 | The promised typed schema is not mechanically resolvable. |
| `released` used in the lease uniqueness predicate is undeclared; A.3 has `released_at`. `decision_kind` in the unique tuple differs from the table's `kind`. | §6.2; A.3 leases/decisions | Constraints cannot be applied literally. |
| Successful Run finalization has no outcome; proposal capture is both intermediate and “ends ... state=proposal_captured”; finalizing→ended says “or quarantines” while §4.5 correctly forbids that. | §§4.1, 4.5, 7.3; D1-21 | Different implementations can report incompatible end states. |
| WorkItem success paths in A.5 are absent from the purported exhaustive §4.2; `assessment`/intent-only are described as kinds but absent from WorkItemKind. | §§4.2, 7.8; A.2/A.5 | Valid work becomes illegal, or implementations invent transitions. |
| Operation reconciliation yields attempt names `reconciled_absent/partial`, while OperationStatus expects `failed/partial/...`; shorthand `absent` is not AttemptStatus. No explicit mapping exists. | §4.4; A.2 | The logical-operation retry state is ambiguous despite corrected effect identity. |
| Scope needs source revision and runner class, but AcceptanceScope lacks them. CheckResult has runner_id without runner-class mapping. Approval has no explicit content-scope hash or authorization id. | §§9.1–9.3, A.3 | The demanded binding comparisons are incomplete; B01/B03. |
| DeploymentVerification has no attempt/generation; operation target/subject and configuration/mapping schemas are untyped. | §§3.5, 9.6; A.3 | Stale-attempt and wrong-target proof is not represented; B03. |
| Managed-checkout baseline/ownership, observation history, and durable streaming chunk receipts have no declared entities or typed structures. | §§7.6, 8.1(5), 14.1; A.1/A.3 | Required integrity, historical conditions, and partial-stream recovery lack storage. Events are an audit trail, not the defined projection store (§12.2). |
| Progress depends on a typed requirement/contract conflict; Finding has no type/category. Applicability assessment is only a Record ref without declared authority/review schema. | §§3.4, 4.2; A.3 findings | Conflict routing and exclusion authority cannot be pinned by the appendix; B02/B10. |
| Tick/lease/termination/API-latency limits and policy chaining/budget limits are used but have no authoritative configuration schema or complete defaults/ranges. | §§1.5, 4.5, 8, 13.3, D1-20/34; A | A “closed writable-field schema” is promised by §11.4 but not defined here. |
| Engine incarnation is “recorded” before opening/migrating its store; bootstrap needs Project identity before normal context resolution can validate its identity file. | §§1.4, 3.1, 7.2; A.3 | Startup/bootstrap need explicit pre-store and pending-registration states, not a supposed cross-git/SQLite transaction. |
| Record kind lacks check/disposition/scope/assessment evidence variants or a documented generic typed-record schema. `dispatch_status`, `role`, actor, authority and many JSON objects remain open strings/objects. | §§3.4, 9, 14; A.2–A.3 | A claims to enumerate every state/field, but important transitions remain behind untyped payloads. D2 capability vocabulary may be deferred explicitly; D1's own dependency bindings cannot. |

**Declared but unowned/unused audit.** `PUBLICATION_NOT_SUCCEEDED` is the consequential unused reason (B03). `oob_dev_repo_change` duplicates the body's `out_of_band_change` with no distinct owner; `OperationStatus.superseded`, ProposalStatus `withdrawn`, NotificationStatus `sending`, and Freshness `stale` lack transition/derivation rules. A.7 omits mappings or explicit non-API dispositions for RunReasonClass `infra_error`, `human_stop`, `human_abandon`, `recovered`, and `none`. `RecordKind.proposal` is plausible but its byte-record linkage is unspecified. A.6 has many reasonable reserved audit events; absence of their exact spelling in prose alone is **not** proof they are dead. Every such event needs an owning transition or an explicit deferred reservation. [Observed this review: D1 §§7.6, 10.1, A.2–A.7.]

**Proposed replacement for Appendix A's authority/check contract and journal representation:**

> Appendix A MUST enumerate the types and transition ownership of every D1-persisted fact, including nested binding/plan objects, engine/project policy, snapshot/chunk receipts, integrity subjects, observation history, invocation status observations, and deployment generations. Deliberately deferred types MUST name their owning design and MUST NOT be used to satisfy an implemented gate until that contract exists. Unused enum values/events MUST be either assigned a transition/derivation or explicitly reserved without operational authority; accidental aliases are removed.
>
> Append-only GitJournal entries MUST be facts with `(operation, sequence, event_kind, payload)` and unique sequence identity. A declared current-state projection is derived from those facts and may be updated only transactionally with the new fact. Alternatively an explicitly mutable journal-state table may be paired with immutable journal events; the chosen representation MUST be consistent with §6.2 and all recovery algorithms. A single row whose state is updated MUST NOT also be declared immutable.
>
> A consistency check MUST compare the body contracts, Appendix A, API schema, migrations, and transitions in both directions. It MUST validate field/type/FK names, enum membership, legal state transitions, unique constraints, nullability/creation order, producer/consumer ownership, and error/reason mapping. Event records and generic JSON do not excuse undeclared D1 state. Positive lifecycle traces and crash traces MUST satisfy the same constraints. Every discrepancy in the review's B17 table MUST be resolved or explicitly scoped out before D1 approval.

## 3. Non-blocking suggestions

These include the five original suggestions' dispositions as requested by the continuing brief.

### N01 — Closed: branch-independent-store scenario

**D1 section:** D1-02, §§6.5/13. **Evidence:** DR N01; R1 N01. The rewritten scenario now checks API visibility, totals, budget refusal, restart, linked worktrees, rebinding, and OOB separation. That is an adequate design test, subject to actually running it later.

**Optional amendment:**

> D1-02 MUST state its expected invocation count and token/cost totals before source-history mutations and assert those same values afterward, with no duplicate correction application.

### N02 — Not closed: schema consistency is now B17

**D1 section:** Appendix A. **Evidence:** DR N02 says accepted, but B17 records direct inconsistencies. This is a blocker in Draft 2 because the appendix is authoritative, rather than another request to polish names.

**Amendment:** apply B17's replacement text and reconcile its inventory; do not merely adjust the future parser to accept both spellings.

### N03 — Partly closed: UI fixes are real; broaden responsiveness qualification

**D1 sections:** §§6.1, 11.2, 12.3; D1-20/33. **Evidence:** the diffs in `mockup/{Main,Build,Gate}.dc.html` match `mockup/README.md`'s correction note. Added routes and a joint behavioral suite cover the main consumer omissions from R1 N03. Import-graph enforcement from O8 is still not explicitly pinned.

**Amendment:**

> The joint contract suite MUST enforce the UI package's public-engine-API-only import boundary. D1-20 MUST additionally exercise the qualified maximum store size, an occupied/busy store connection, gate recomputation, migration/restricted mode, backup/checkpoint work, large paginated replay, and record hashing, while health and Stop admission meet the configured latency bound. An alternative main-thread placement is eligible only under those declared operating limits; changing them reopens qualification. Failure keeps the default store-worker placement.

**Fixture follow-up:** `mockup/Gate.dc.html` still says “four things” and then adds a fifth sign-off; it offers pv-19 approval/rerun on the current candidate although §7.9 now requires a new candidate for the protected commit. `mockup/Main.dc.html` still labels no dispatch “measured zero.” These are consumer-copy inconsistencies, not permission to weaken D1. [Observed this review: those files; D1 §§7.9, 13.1.]

**Amendment:**

> Gate fixtures MUST show the successor candidate after applying a source-changing protected correction; no-dispatch examples MUST label that fact separately from a provider-reported measured zero. Fixture blockers and their displayed count MUST agree with the evaluation.

### N04 — Closed: port provenance

**D1 sections:** §§13.2, 19.2. **Evidence:** DR N04 and verification notes; rechecked paths in §8 below. The distinction between legacy risk classification and E13 tightening, and the two normalization adaptations, is now explicit.

**Optional amendment:**

> The regression corpus index MUST record the originating repository commit and the qualification limitations of each retained fixture/report, separately from Surety's new qualification results.

### N05 — Substantially closed: streaming redaction and reference retention

**D1 sections:** §§5.5, 14.1–14.4. **Evidence:** DR N05; R1 N05. Cross-chunk matching, new-pattern rescans, quarantine, and broad live references are present. Complete chunk/reference schema is B17.

**Optional amendment:**

> Redaction tests MUST include multibyte/chunk splits and known secret values crossing the maximum retained stream boundary. Retention tests MUST prove that a pending effect or open decision prevents expiry and that a post-scan quarantine cannot be bypassed by a previously satisfied evaluation.

## 4. D1 §20: the four new questions

The original eight questions are resolved in DR and D1 §20's opening paragraph. I do not reopen them; E18 records Sean's O11/tag/adoption/concurrency decisions.

| Question | Recommendation and reasoning |
|---|---|
| Q1 Store-worker placement | **Accept the variant in principle; keep the worker default.** A main-thread alternative may stay only after the expanded D1-20 qualification in N03, because holding an asynchronous git child open does not exercise synchronous store contention. This preserves O9 and judges responsiveness by evidence. [D1 §§6.1, 18 D1-20; E E17.] |
| Q2 Session snapshot quiescence | **Refuse live saves/checkpoints until D2 proves all writers quiescent.** A turn boundary or parent exit is a candidate synchronization point, not proof that descendants or background work cannot write; require the B04 execution-domain/lease protocol and a negative background-writer test. [D1 §§7.3, 15.2; E E1/E7.] |
| Q3 Delivered requirements | **Derive delivery from integrated implementation obligations at the candidate's pinned revision, not phase start.** Keep required release scope independently binding so “not delivered” cannot become a way to omit required release checks; B01 also separates partial delivery from verified satisfaction. [D1 §9.1; F §§3.10.2–3.10.4.] |
| Q4 Finding inheritance assessment | **Verifier proposes; independent Reviewer evaluates technical applicability; only the human authorizes an exclusion that would remove an otherwise blocking inherited finding.** The engine records/applies the decision and may prove a narrowly defined mechanical non-applicability predicate, but an agent-authored assessment alone must not function as severity lowering or a check waiver. Record this new authority choice before treating B02 as closed. [D1 §3.4; F §§6.1–6.3; E E12.] |

## 5. Errata conformance table

One row per E1–E17 as in the original brief, plus E18 because Draft 2 explicitly depends on it. These are design mappings, not implementation claims. The sources are the corresponding entries of E; B §§B.2–B.4 supplies the historical input trail, not proof of closure.

| Entry | Draft-2 implementation location / gap |
|---|---|
| E1 Backend contract | §§15.1–15.4, 17(4)/(11)/(12); D2 owns real qualification. **Gap:** supervised isolation exception and ownership launch window, B08/B14. |
| E2 Engine performs git | §§7.1–7.10. Correct authority; **gaps:** quiescence, full protected-change classification, complete journal/checkout representation, B04/B05/B17. |
| E3 Deployment verification | §§3.5, 9.6. Correct identity/behavior floor and authorize/complete split; **gap:** attempt generation and executable operation binding, B03. |
| E4 Walking skeleton | §19.3 correctly keeps M1 preliminary and phase one open until deployment obligations. Plan/phase enforcement remains later; no early completion may come through A.5 conformance, B10. |
| E5 Mechanic triage | §§3.1, 3.7, 11.3 management, 14.4; deliberately deferred to Mechanic design. D1 names the seam and excludes raw reports from prompts. |
| E6 Adoption | §3.1 records exact current commit, §19.3 conformance. **Gap:** A.5 conformance terminal path and bootstrap schema/order; B10/B17. Detailed adoption analysis remains later. |
| E7 Interruption/stop/resume | §§4.5, 8, 15.3, 16. Major repair; **gaps:** domain termination, durable prelaunch ownership, Stop/Abandon state transitions, B08/B10. |
| E8 Check judgment | §9.2, D1-09. Empty-set and deadline rules repaired; **gap:** stale/missing selection and applicability-assessment escape, B01. Actual runner honesty remains D3. |
| E9 Human decisions | §§9.7, 10–12. Queue inventory and semantic dedupe repaired; **gap:** complete preview/effect binding and typed schemas, B12/B17. |
| E10 Sessions and development integrity | §§7.6, 15.2–15.3. **Gaps:** active-workspace/OOB distinction, dirty tracked files, session save/launch states and isolation, B05/B14/B15. |
| E11 Nomination | §§2.3, 3.3, 7.7; D1-18. Immutable candidate identity represented; successor lineage must preserve findings and recovery receipts, B02/B05. |
| E12 Engine gate function | §§9.1–9.7. Correct decision owner; **gaps:** dispositioned findings, scope applicability, authorization hash compatibility, publication predicate, B01–B03/B12. |
| E13 Protected corrections | §§5.2, 7.9, 11.3. Asymmetric authority retained; **gap:** full protected metadata diff route and durable finalization, B04/B05/B17. Semantic classifier remains D3. |
| E14 Product shape / O8 | §§1, 6, 11–12, 19.1. Conforms; worker variant acceptable. Public-package import-graph enforcement should be pinned explicitly, N03. |
| E15 Provenance | Header, DR, recorded git history; previous decisions preserved. Draft-2 discrepancies need a new disposition record, not revision of historical acceptance claims. |
| E16 Retire/budgets/records | §§13–14, 11.4 retire/reactivate. Redaction/retention and metering architecture improved; **gap:** corrections, invocation identities, schema, and cancellation/retirement cleanup, B10/B11/B17. Detailed retirement transition still must disable management/freeze records per E16a. |
| E17 Stack/reuse / O9–O10 | §§6.1, 13.2, 19.1–19.2. Conforms to the selected stack and selective ports. Source locations and adaptation cautions verified in §8. |
| E18 Repository / O11 and D1 decisions | §§3.1, 7.2/7.5/7.7, 19.1, 20. Matches Sean's repository, immutable-tag, exact-adoption-baseline, and serial-per-project-through-M3 decisions. No objection. |

## 6. Scenario coverage: A01–A25

Source for every scenario: Astra history §10. A D1 number is a specified scenario, not an executed test. “Partial” means the scenario needs the stated additional assertions; D2/D3/later are valid owners rather than automatic D1 objections.

| Scenario | Draft-2 coverage | Assessment |
|---|---|---|
| A01 Sound spec on both backends | D2 + later | §§7.8/19.3 provide engine-owned plan registration; full spec-to-plan real-backend journey remains later. |
| A02 Vague spec | later | Baseline/spec workflow must preserve actionable gaps and request identity; no full D1 scenario. |
| A03 Unknown config accepted | D2 | §15.1 refusal seam; actual unsupported-policy probe required. |
| A04 Negative test never authenticates | D2 | Positive liveness/auth control remains a real-binary obligation. |
| A05 Same role twice | D1-01 | Explicit distinct runs, receipts, outputs, workspaces, ledger. B11 must make receipt uniqueness implementable. |
| A06 History survives branch changes | D1-02 | Substantially complete design scenario now; no new execution evidence. |
| A07 Consume parked review once, no new model | D1-03 | No-adapter-launch assertion now explicit; B12 supplies complete applicability validation. |
| A08 Head changes during/after review | D1-04, partial | Before-effect head change included; add proof that the reviewed input tree itself was pinned and actual effect preconditions are rechecked. B05/B12. |
| A09 Bounded correction | D1-31, partial | No-progress case exists; add changed-progress repairs reaching the hard attempt limit and successful small repair. B10. |
| A10 Contract conflict escalates | D1-31 | Correct requested behavior; Finding category missing in A.3, B17. |
| A11 Consumed request never replans | D1-05, partial | Pre-completion/refusal/restart are covered; explicitly retain the original post-success trigger replay case. §3.2 currently says returns existing only in nonterminal states, while uniqueness spans all. |
| A12 Work completed, response lost | D1-32 plus D1-06 | Correct new artifact/receipt recovery scenario; B05/B08/B11 must make it executable. |
| A13 Applied GitHub write times out | D1-06 + later | Logical retry rules repaired; real external adapter qualification remains later. |
| A14 GitHub unavailable/unauthorized | later | Environment/engine Unknown vocabulary exists; delivery read/error semantics remain later. |
| A15 Late CI / skew | later | No premature success allowed; bounded remote-registration pending state is not a D1 implementation. |
| A16 Two repos plus hostile git overrides | D1-07 | Both targets now explicitly asserted. Checkout registry/journal coverage still B05. |
| A17 Cancel/restart descendants and usage | D1-08, partial | Good negative cases; add launch-before-ownership-record crash and parent-exited/child-writing completion, B08. |
| A18 Power loss after effect | D1-23 plus D1-19/22, partial | FULL policy and separate simulation now specified. Add explicit effect-applied/receipt-uncommitted power-loss point, not only after intent and record publication. B05/B17. |
| A19 Many tabs/fleet bounded reads | D1-20/33, partial | Event clients and slow-consumer handling specified; include measured adapter-read count and database replay workload, N03. |
| A20 Empty/skipped/stale checks | D1-09 | Cases now named; literal §9.2 cannot return the required stale outcomes, B01. |
| A21 Literal prompt / escaping path | D1-10 + D2 | Symlink and snapshot-race cases added; quiescence domain evidence required, B04. |
| A22 New runtime delegation capability | D2 | Trust-table absence refuses; no fake-adapter scenario establishes real denial. |
| A23 Supervised plan/build boundary | D1-34 | Correct scenario; policy chaining fields and decision ownership need A definitions, B17. |
| A24 Publish succeeds, deployment fails | later, with D1-25 partial | Separate state facts remain correct; add partial retry and same-Operation stale verification plus publication enforcement, B03. |
| A25 Local prototype graduates | later | Export/replay/stronger-policy transition remains deferred; adoption is not graduation. |

## 7. Incident coverage: Claude's twenty incidents

Historical source: Claude history §3.4, **Recorded observation**. All prevention assessments are about the Draft-2 design, **Recommendation/inference**. None claims an executed Surety test.

| # | Historical incident | Draft-2 prevention or gap |
|---|---|---|
| 1 | Tail-swallowed lint | §§9.2/17(8) still require directly observed execution/exit and deadline veto; D3 must qualify the actual runner/tool failure configuration. **Gap:** scope assessment cannot substitute for required execution, B01. |
| 2 | Codex permission no-op, inherited credentials | §§7.3, 15.1, 17(4)/(11) put policy, environment construction and validation in engine. **Gap:** §17(12)'s supervised isolation exception weakens the floor, B14; D2 real-binary qualification remains mandatory. |
| 3 | Headless Codex 0% success, invalid schema/auth/error handling | §15.1 owns preflight and result/transcript validation. **D2 gap:** actual argv, authentication liveness and negative controls, error normalization. Port provenance helps but is not qualification. |
| 4 | Read-only sandbox cannot commit/branch | Engine git ownership §§7.1–7.5 directly addresses it. **Gap:** coherent workspace/snapshot/journal path, B04/B05/B17; do not solve that by giving the role git authority. |
| 5 | Sandbox cannot read GitHub or post review | Engine context/effects ownership §§1.1/7.2/15.1 is correct. D2/later delivery must define the allowed structured effect channel and snapshots; roles must not be instructed to perform the unavailable side effect. |
| 6 | Unknown cost=$0; breaker blocks approval path | Nullable usage, observations, boundary enforcement and explicit blockers §§13.1–13.3 are major repairs. **Gap:** correction/receipt schema and incompatible gate-approval hashes can still wedge the workflow, B03/B11/B12. Test a budget blocker resolved without consuming unrelated approval or repeating paid work. |
| 7 | Context bloat, inline wrong-role work, delegation into void | One role/run, turn/run boundaries, grants, deadlines, quarantine §§3.2/4.5/15. **Gap:** parent-exit shortcut and pre-receipt launch window permit surviving unowned writers, B08; session lifecycle B15 and real delegation denial D2. |
| 8 | No-CI treated as red; duplicate summary trips breaker | Five check states plus logical Operation/Attempt identity §§2.5/4.4/9.2. **Gap:** stale selection B01 and semantic no-progress counting B10; remote CI absence/pending remains later. Notification Unknown handling is now honest (§10.4). |
| 9 | Unreachable GitHub looks empty; wrong repository | Scoped context §7.2, observation jobs §8.1(5), timestamps §11.3, D1-07/28. Correct mechanism; **gap:** checkout/integrity subject schema B05/B17. Remote failures must retain their later adapter error classes. |
| 10 | Approval re-buys review or cannot merge | D1-03 explicitly forbids model relaunch; §10.5 consumes once. **Gap:** approval/sign-off scope equality across authorize/complete can make a valid approval unusable, and external preconditions are not completely bound, B03/B12. |
| 11 | Plan files never become schedulable work | §7.8 now atomically registers Stage/WorkItem rows on integration confirmation. **Gap:** journal recovery must replay that domain finalizer and valid work transitions must agree, B05/B10/B17. |
| 12 | Newly opened PR prematurely gated on CI | **Gap, later adapter:** no CI-registration grace/skew design yet. D1 does not claim to implement that remote lane; missing/Unknown must never be converted to passed. |
| 13 | Same request replans each tick | Unique trigger tuple §6.2 and create-or-return §§3.2/8.2 close the primary race. Explicit terminal-item replay semantics and hard repair counting still need B10/§6 A11 follow-up; successful trigger re-observation must not be an insert error or another plan. |
| 14 | Branch-bound ledger; stale fail-open fallback | Engine-home store, FULL durability, fail-closed reads §§1.6/6.1/6.6; stronger D1-02. **Gap:** unconditional correction uniqueness and receipt protocol can still lose/reject accounting, B11. |
| 15 | Intent outputs remain uncommitted | Engine commit/registration §7.8 addresses ownership directly. **Gap:** append-only journal conflict and complete recovery finalization, B05/B17; successful one-shot outcome/work transitions B10. |
| 16 | New provider gains max trust by omission | §§15.1/17(11) correctly refuse absent backend/version/mode entries. D2 owns evidence and table authority. M1 cannot use an unqualified real backend pending M2 (§19.3). |
| 17 | Async tests pass vacuously; skips counted as pass | §9.2 execution signal plus nonempty scope and D1-09. **Gap:** stale-selection contradiction and assessment escape B01; D3 must prove nonvacuous awaited execution and no skipped-as-passed behavior. |
| 18 | Release truth drifts across two repositories | Release mappings and entity-derived projections §§3.5/12.2 are correct authority. **Gap:** Beta publication predicate is absent and retry verification lacks generation, B03. Later promotion must populate the mapping from actual effects. |
| 19 | No-self-feeding silently hides plan work | Queue/blockers, explicit plan registration, and supervised boundary test §§7.8/10/D1-34 improve visibility. **Gap, later intake/Mechanic design:** positive same-operator intake and denied-intake explanation; no D1 scenario yet exercises the original intake rule. |
| 20 | Network outage stalls worker ~110 minutes | Asynchronous git, total tick budget, failed-prerequisite suppression, cancellation §§7.1/8.1/8.5, D1-20. Original architectural deadline gap substantially closed. **Remaining gap:** cleanup/owned-process recovery B08 and realistic store-load responsiveness qualification N03. |

The most expensive recurring failure classes are now explicitly named, but they are not all prevented by the draft: incident 10's approval deadlock and incident 14's accounting loss have new concrete schema/binding failure paths, not merely missing test breadth. [Recommendation/inference: D1 §§6.2, 9.3, 13.1, A.3; B03/B11 above.]

## 8. What I verified versus inferred

### 8.1 Evidence record

**Observed this review.** Read DR first, E18 second, all of D1 Draft 2 including Appendix A third, then `mockup/README.md` and the corrected Main/Build/Gate fixture changes against the previously reviewed source. Read the original review's item/coverage records and re-read Claude history §3.4, Astra history §10, and console `docs/security-invariants.md`. D1 is at commit `357548d`; its preceding review commit is `7b15b0a`. No prior source file was edited.

**Observed this review.** Conducted a manual body-to-appendix audit and a small read-only lexical occurrence check for named policy variables, reason/error codes, and representative fields. It confirmed, for example, that `tick_budget`, `api_latency_bound`, `terminate_grace`, and `kill_grace` have no Appendix A declarations. The lexical check is not a parser or proof of exhaustiveness: many codes are described semantically without being spelled in the body. B17 distinguishes actual contradictions from merely unowned/reserved names.

**Observed this review.** Rechecked O10 source/test paths and function locations at framework HEAD `45344bbd6e83f8ee5f0a0c0b6856c464a98d0c7f`; console HEAD remains `741ccf3a9977eb4c60016a52509f8949bda88711`. Neither source repository was modified. No tests, process-kill drills, power-loss simulation, HTTP probe, model benchmark, CLI continuation, or paid call was run in this review.

**Recorded observation.** Historical CLI/canary results and incident costs remain those in the retained reports referenced by R1 §8 and Claude history §§3.4/3.7. The earlier `codex exec resume --help` observation was at 0.154.0; the earlier local Claude help observation was at 2.1.286, not the retained canary's 2.1.281. DR's verification notes preserve that distinction. Nothing in this review newly qualifies session mode or quiescence on either backend.

**Implemented.** This label applies only to inspected existing Verity/console source at the commits above. D1/Appendix A and D1-01–34 are proposed contracts/test scenarios; they are not an implementation, passing tests, or proof of incident prevention.

**Open/reported.** Prior tracker gaps mentioned in Astra history §13 remain historical reports for this review; I did not re-query remote issue status. Current objections stand on Draft 2's text and retained source, not assumed current tracker state.

**Recommendation/inference.** Verdicts, counterexample traces, amendment text, authority recommendations, and worker-placement qualification requirements are deductions from the cited contracts. I did not empirically reproduce those failure paths in Surety, because no implementation was supplied for review. O8–O11 and all E18 decisions are treated as fixed inputs.

### 8.2 O10 source/path verification

Paths below are relative to `/home/smahoney/projects/verity-framework`, as in Claude history §8. Its `agents/...` abbreviations resolve under `verity/bin/lib/agents/`, and bare helper names under `verity/bin/lib/`. All named O10 source assets in this table were present; none was missing.

| Port area | Verified paths / actual reusable boundary |
|---|---|
| Backend seam and contracts | `verity/bin/lib/agent-exec.cjs`, `verity/bin/lib/agents/index.cjs`, `verity/bin/lib/agents/result-contract.cjs`, `contracts/agent-result.md`. |
| Claude and Codex | `verity/bin/lib/agents/{claude,codex,codex-features}.cjs`; both `normalizeUsage` functions still exist. D1 §13.2 correctly rejects a verbatim normalization port. |
| Containment, policy, trust adjuncts | `verity/bin/lib/agents/{invariants,workspace,policy,tiers}.cjs`; D2 adapts/requalifies rather than inheriting trust. |
| Approval consequences | `verity/bin/lib/trust.cjs:approvalConsequence` (line 331); supporting approval helpers live in `verity/worker/index.cjs`, which exists. The old function is a policy input, not a complete substitute for D1 effect plans. |
| Diff classification | `verity/bin/lib/trust.cjs:classify` (line 168), `verity/bin/lib/substrate-local.cjs:localPrDiff` (line 806). Their I/O/policy distinction is retained in DR; these are not an existing E13 semantic tightening classifier. |
| Usage | Driver normalizers and `verity/bin/lib/usage.cjs`; accounting policy/schema must adapt to nullable unknowns, observations and corrections. |
| Promotion allowlist | `verity/bin/lib/{classification,promotion-config,promotion}.cjs`, `.verity/production-content-classification.yml`; extract the matcher/governance rules, not the old engine core. |
| Supporting tests rechecked | `tests/{agent-exec,agents-codex,trust,usage,production-classification,promotion,real-codex}.test.cjs` all exist. They were not run. |

R1 §8.2 already established that there is no literal `tests/provider-contract.test.cjs` or `tests/agents-claude.test.cjs`; those were possible test-suite interpretations, not source files promised by Claude history §8. Draft 2 does not rely on those filenames. D1 §19.2's provenance/adaptation requirement is appropriate.

### 8.3 Draft 2 against all 21 console invariants

Source: `/home/smahoney/projects/verity-console/docs/security-invariants.md`, bullets in §§1–5 in order; the earlier mapping is R1 §8.4. “Present” below means a design requirement exists, not that a browser test passed.

| # | Console invariant | Draft-2 assessment |
|---|---|---|
| 1 | Loopback bind | Present, §§1.2/11.1. |
| 2 | Host first, absolute-form target, 100 Continue | Present, §11.1. Exact self-authority configuration must be schema-defined under B17. |
| 3 | Exact-origin/token CSRF before body | Present in principle, §11.1; bootstrap and ordinary-origin-less rules need B14. Referer comparison must use its parsed origin, not reject every URL containing a path. |
| 4 | Headers/CSP/no CORS | Present, §§11.1/17(13). Error paths included. |
| 5 | Enforced body caps and no effects on refusal | Present intent; impossible “before reading” rule for unknown streamed length corrected in B14. Add bounded body time/buffer behavior. |
| 6 | Untrusted DOM data as text | Present, §11.1. UI tests still later. |
| 7 | Safe URL schemes | Present, §11.1; resolve relative/protocol-relative links before scheme/authority validation so syntax cannot bypass the allowlist. |
| 8 | Request/callback cannot crash process | Present, §§11.1/17(14). |
| 9 | Fixed commands, no shell | Present, §§7.1/11.4/15.4/17(3); closed API command schemas required. |
| 10 | No option injection | Present, §7.1; validate or terminate option-shaped arguments. |
| 11 | Subprocess/output/concurrency bounds | Present architecture §§7.1/8/11.3; ownership B08 and config limits B17 remain material. |
| 12 | UI never merges/calls model | Present ownership §§1.1/15.4; import-graph test still N03. |
| 13 | Redaction before response/audit | Present, §§14.2/17(5). No fresh redaction tests run. |
| 14 | Server-owned paths | Scoped ids and containment present §11.3; adoption is an intentional authorized input boundary needing typed bootstrap. |
| 15 | Upload sandbox/atomicity/caps | Durable Record write and caps §§11.1/14.1 supply core behavior; upload destinations must be server-allocated typed records, not request paths. |
| 16 | Regular-file, realpath, bounded preview | Realpath/size present §11.3; add explicit regular-file/no-device/no-FIFO validation and safe file-open checks, not realpath alone. |
| 17 | Managed config keys, engine validation, atomic writes | Closed schema promised §11.4; actual fields/protocol remain B05/B17. |
| 18 | Registered project membership everywhere | Nested entity/project ownership explicitly checked §11.3. Commands must apply that same rule; the guarantee must not be confined to read handlers. |
| 19 | Validated clone and target environment | Present §§7.1–7.2 and D1-07; dirty checkout and lifecycle receipts B05. |
| 20 | No stored credentials/token exposure | Deliberate service-token change remains acceptable with private file, correct bootstrap and role isolation; B14 closes remaining holes. |
| 21 | Audited attributable mutations | Present §§11.1/12.1; audit must be durably committed before effect dispatch. An intent carrying its request identity supplies crash attribution, including denied requests. |

**Additional pasteable clarification for §11.1/11.3:**

> Referer checks compare the parsed origin against the exact self-origin set. Link validation resolves relative references before applying scheme/authority rules. Record content reads MUST open only the expected regular file, reject devices/FIFOs and symlink substitutions, verify project ownership for both reads and commands, and enforce bounded byte/time limits. Request audit identity MUST be committed with the command intent before any external effect.

### Questions for Sean

Please record the authority choice for D1 §20 Q4 before B02 is closed: my recommendation is Verifier proposal, independent Reviewer assessment, and human authorization when excluding the finding removes an otherwise blocking inherited obligation. Q1–Q3 have concrete recommendations in §4; no answer is required to establish the defects reported here. No O8–O11 or E18 decision needs reconsideration.
