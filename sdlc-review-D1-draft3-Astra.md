# D1 draft-3 cross-review — Astra

**Reviewed:** 2026-10-01. `sdlc-design-D1-engine-core.md`, Draft 3, at `35bc38b`.
**Scope:** Architecture review against the retained sources. No implementation authorization. Existing project files and both Verity repositories were left unchanged; this review is the requested output.

Reference keys used throughout:

- **D1:** `sdlc-design-D1-engine-core.md` at the reviewed commit.
- **DR:** `sdlc-review-D1-dispositions.md`, especially “Draft-2 findings → draft 3” and “Draft-2 open questions.”
- **R2:** `sdlc-review-D1-draft2-Astra.md`; **R1:** `sdlc-review-D1-Astra.md`.
- **F:** `sdlc-framework-foundations-v1.0.md`.
- **E:** `sdlc-foundations-v1.1-errata-draft.md`, entries E1–E19.
- **Trail:** `sdlc-foundations-v1.1-appendix-b-decision-trail.md`.
- **AH:** `sdlc-review-Astra.md`; **CH:** `sdlc-review-claude.md`.

Section references prefixed by those keys name these files, not an earlier draft. Evidence labels retain AH §2.2's meanings. Statements about D1 mechanisms are design assessments, not claims of implemented or passing behavior.

## 1. Verdict

**Reject with reasons.** Draft 3 closes B02's inheritance semantics and B04's snapshot/proposal contract, but ten of the twelve reviewed items still have an operative gap; two additional blockers concern E19's absent human-decision route and the new field-level protected fingerprint. The checker really reports zero findings. Nevertheless, the declared contracts can reject legitimate Builder output, leave confirmed git effects unfinalized, strand ordinary recovery transitions, deadlock go-live approval, and bootstrap no browser token under the default page policy. Process-group and environment-marker discovery also cannot establish the termination guarantee on which snapshots and ended runs depend. These are concrete contract contradictions, not requests to reconsider Sean's decisions or implement D2/D3 inside D1. [Observed this review; Recommendation/inference: D1 §§2.7, 4.5, 7.3–7.10, 9.3–9.6, 11.1, A.5/A.8; findings below.]

## 2. Blocking objections and closure of the twelve reviewed items

“Closed” means the original design objection is answered. A separate blocker may still prevent implementing that contract correctly. The five items already closed in R2—B06, B07, B09, B13, B16—are not silently reopened; specific regressions affecting their paths are identified under the relevant current item.

| Item | Draft-3 judgment | Principal D1 anchors |
|---|---|---|
| B01 | Still open | §§9.1–9.2; A.3 |
| B02 | Closed; E19 decision-route omission is new B18 | §§3.3–3.4, 9.3(5), 9.5; A.5 |
| B03 | Still open | §§3.4, 9.3, 9.6; A.5/A.8 |
| B04 | Closed; termination implementation remains B08, fingerprint representation is new B19 | §§4.1, 5.2, 7.3, 7.9 |
| B05 | Still open | §§7.3, 7.5–7.6, 7.10; A.3/A.5 |
| B08 | Still open | §§2.7, 4.5, 16.1 |
| B10 | Still open | §§4.3, 8.4; A.5 WorkItem |
| B11 | Still open | §§2.6, 6.2; A.3 invocation_receipts |
| B12 | Still open | §§9.7, 10.5; A.8 |
| B14 | Still open | §§11.1, 17(2); D1-29 |
| B15 | Still open | §§4.1–4.2, 7.3–7.4, 15.2; A.5 |
| B17 | Still open | §§6.4, 7.6, 7.9, 9, 16; Appendix A |

### B01 — Still open: delivery and phase completion need different predicates

**What is repaired.** D1 §9.1 now explicitly requires a required check for every delivered requirement; an applicability record cannot replace that check. Section 9.2 correctly orders missing, stale, execution establishment, deadline/signal/exit, and selects by execution sequence. A later matching failure beats an earlier matching pass. **To the specific question: a delivered requirement with no required check cannot legitimately pass the draft's §9.1 coverage predicate.** That part of DR B01 is implemented. [Observed this review: D1 §§3.3, 9.1–9.3; D1-09; E E8/E12.]

**Remaining defect and evidence.** The literal “every stage listing it” predicate labels a requirement delivered when no stage lists it: universal quantification over an empty set is true. More materially, §9.1 uses delivered scope for all gate kinds but does not restore R2 B01's requirement that a **phase** gate cover all assigned phase obligations. A partially implemented requirement can be excluded from a phase gate while the delivered requirements and floor checks pass. That is valid for a mid-project deployment scope, but not phase completion. F §§3.10.2, 3.10.4, 3.10.6 make that distinction mandatory. Check-result invalidation and reuse representation remain B17, rather than another alleged missing→passed escape. [Observed this review; Recommendation/inference: D1 §9.1 and A.3 acceptance_scopes/stages; R2 §2 B01.]

**Replacement for the delivery and phase-scope clauses in §9.1:**

> Delivery is derived from the nonempty set of implementation obligations in the candidate's pinned approved plan bindings. No implementing stage means `not_started`; some integrated obligations means `partial`; all obligations integrated at or before the candidate revision means `delivered`. Missing or inconsistent plan bindings prevent scope validation. Delivery never means verified satisfaction.
>
> A `phase` evaluation MUST identify the phase plan and include every requirement and integration obligation assigned to that phase, plus affected regressions, irrespective of delivery status. It cannot satisfy phase completion while an assigned implementation obligation remains incomplete. A deployment evaluation uses delivered requirements plus its independently required release obligations. Each scope derives check membership from the protected definitions and the applicable `gate_kinds`; post-deployment execution is required for completion, not as a prerequisite to the first deployment authorization. Every in-scope requirement MUST have required acceptance coverage. Add cases with zero implementing stages and a phase whose requirement is only partially implemented.

### B02 — Closed: findings survive both disposition and lineage succession

The relevant changes are substantive: §9.3(5) includes open **and** dispositioned findings, follows `started_from_candidate` ancestry, and binds deferral reevaluation to this evaluation; §§9.5/A.5 reopen invalidated resolutions. Section 3.4 records the Verifier/independent Reviewer/human division Sean decided in E19. D1-24 now exercises different successor lineages. I close the original inheritance and disposition-query objection. **B18 separately identifies the missing queue route for exercising E19's human authority.** [Observed this review: cited D1 sections, DR B02, E E19; R2 §2 B02.]

**Replacement text:** none for the closed inheritance rules; apply B18's addition without changing E19's authority.

### B03 — Still open: authorization creation is circular, and supersession is not an eligibility test

**What is repaired.** Completion takes a named operation; DeploymentVerification binds its current attempt and deployment generation; Beta requires successful publication of the exact delivery output. A verification from an earlier attempt of the same operation cannot satisfy §9.6 as now written. [Observed this review: D1 §§2.5, 3.4, 9.1, 9.6, A.3; D1-25.]

**Remaining defects and evidence:**

1. **First go-live cannot authorize.** Section 9.3(7) requires the consumed go-live approval for `live_authorize`. A.8 makes that decision's subject the deployment authorization. Sections 3.4/9.6 create that authorization **only after** `live_authorize` is satisfied. There is no prospective authorization state or other row to approve. This reproduces CH §3.4 incident 10's unfinishable approval path.
2. **Consumed authorizations cannot be superseded under A.5.** Section 3.4 says a later authorization supersedes the earlier one for the same candidate/environment; A.5 permits only `issued→superseded`, not `consumed→superseded`. Section 9.6 checks current attempt/generation **within an operation**, not whether that operation's authorization is still current. An old operation can retain its matching verification after a new authorization/operation replaces it. The old consumed approval still satisfies §9.3's stated binding rule. No explicit predicate forbids this.
3. **The sign-off hash can still differ across authorize/complete.** Section 3.4 hashes `required_check_ids`. Those include completion-only post-deploy checks (§3.3), so excluding `gate_kind` from the hash does not make the two contents equal. D1-25's successful path is not established by that hash definition.

[Observed this review; Recommendation/inference: D1 §§3.3–3.4, 9.3(6)–(7), 9.6, A.3/A.5/A.8; F §§3.3, 3.7, 7.7; R2 §2 B03.]

**Replacement for authorization lifecycle and its gate bindings:**

> The engine first records an immutable prospective deployment authorization, with status `proposed`, binding candidate, environment, artifact and source/delivery mapping, configuration, exact targets, policy, protected version, recovery plan, and a generation. Its issuance evaluation is nullable until issuance. The go-live decision binds that prospective authorization. A satisfied authorization evaluation atomically changes `proposed→issued` and records its evaluation; no effect may consume a proposed authorization. The operation consumes an issued authorization exactly once.
>
> A.5 MUST permit `proposed→issued`, `proposed→superseded`, `issued→consumed`, `issued→superseded`, and `consumed→superseded`. Supersession preserves historical receipts and verification but removes current execution/completion authority. A later authorization generation invalidates dependent unexecuted intents and current-completion eligibility for earlier authorizations in its scope.
>
> Authorization consumption and completion MUST join the named operation, its authorization, candidate, environment, targets, artifact/mapping, configuration, policy, and protected version. All MUST agree with the evaluated scope. Completion requires the operation's authorization to be the current non-superseded consumed authorization for that scope, as well as the matching current attempt/generation verification. A go-live approval for another environment or a superseded authorization cannot satisfy either transition. Historical candidate progress and `last_verified` history are not erased.
>
> Define the candidate review-content binding independently of the gate-specific execution set. The same immutable reviewed content MUST yield the same sign-off binding for authorization and completion; completion-only execution results are separate mandatory gate inputs. The binding MUST retain the reviewed source, approved baseline, protected definitions and acceptance obligations. D1-25 MUST exercise the first go-live from no authorization row, wrong-environment authorization, supersession after consumption, and a completion that adds post-deploy checks without buying another content review or go-live approval.

These additions require the corresponding fields/states and transition events in A.2–A.8; a second untyped approval path would not repair the cycle.

### B04 — Closed: the proposal branch and snapshot admission contract are now explicit

D1 §7.3 requires zero live domain processes and the workspace lease; live checkpoints are refused. Sections 5.2/7.3 classify governed policy fields as well as protected roots. A protected-only Verifier diff becomes an intermediate proposal and cannot reach the ordinary commit path; §7.9 authorizes application through its finalizer. These close the original proposal fallthrough and permissive snapshot-admission rules. There is no textual permission to merge a captured proposal directly. [Observed this review: D1 §§4.1, 5.2, 7.3, 7.9; D1-21/22/35; DR B04.]

That conclusion depends on implementing termination correctly (B08), replaying the application finalizer (B05), and representing the field-level fingerprint (new B19). The interval between git application and SQLite finalization has an intended ProtectedVersion row and must remain gate-blocked; it is not permission to call the applied tree already authorized. [Recommendation/inference: D1 §§7.9, 9.3(2)–(3); D1-22.]

**Replacement text:** none for the closed proposal branching rule; apply those dependent amendments.

### B05 — Still open: legitimate writes, integration checkouts, and journal recovery disagree

**Sections and evidence:** D1 §§7.2–7.10, A.3/A.5; E E2/E10; CH §3.4 incidents 4, 11, 15.

The active-workspace exclusion in §7.6 correctly prevents the **tick** from treating ordinary role writes as OOB. But §7.3(4) requires *every managed checkout baseline* to equal its post-run state and rejects any managed checkout the role altered. The role's own workspace is a managed checkout, and its baseline now includes tracked content. A lawful Builder edit therefore passes step 1 and fails step 4. The exclusion must extend to the validator's metadata-versus-content comparison; it cannot exempt the whole checkout from validation.

Section 7.5 advances an integration ref with `update-ref` but declares no matching update of a checked-out integration branch's index/files. In a harmless temporary repository I verified the consequence: HEAD moved to the new commit, the file retained the old contents, and both status and `diff-index HEAD` reported a change. Section 7.6 then sees an engine-created dirty integration checkout. Conversely, resetting that checkout without a fresh content comparison would erase a developer edit. The document must choose a journaled owned-checkout protocol or forbid the unsupported configuration; adoption currently permits it. [Observed this review: scratch result in §8.1; D1 §§7.2, 7.5–7.6.]

Recovery has three specific gaps:

- §7.10 excludes `confirmed` entries from enumeration, although D1-18/19 require recovery after confirmation and before finalization. “The same finalizer runs” is not a schedule for those skipped entries.
- An effect can be present while its durable state is still `intended` or `ambiguous`; only `applied and matching→confirmed` is defined. A.5 also has no recovery exit from `ambiguous`. A matching probe must recover the missing applied receipt, not demand that the lost receipt already exist.
- Commit, worktree-add, and worktree-remove have probes named, but no complete absent/partial/applied/conflicting outcome tables. For example, a commit object present without its required keep ref is a recoverable partial sequence, not the old ref value. Finalizer idempotence is required in prose, but its frozen semantic inputs and domain-receipt identities are not declared. Recomputing a plan or nomination from current mutable state cannot be that finalizer.

[Observed this review: D1 §§6.3, 7.7–7.10, 16.1–16.2, A.3 git_journal_events, A.5 Journal; D1-18/19/22/23.]

**Replacement for §7.3(4) and additions to §§7.5–7.10:**

> Snapshot validation MUST compare registered refs and other managed checkouts against their recorded expectations. For the owned run workspace, permitted file-content changes are judged by the captured diff; its HEAD, index outside the engine's snapshot operation, git metadata, identity file, and unauthorized paths remain invariant. Authorized file edits alone MUST NOT produce `ref_violation` or an out-of-band observation.
>
> Updating a checked-out integration branch MUST account for its index and tracked working files. Before effect dispatch, capture and validate their exact expected state; preserve any intervening external edit and block. The journal MUST describe the resulting ref, index, and working-tree states and recovery of partial application. The engine MUST NOT advance the checkout baseline until all owned effects are reconciled. If that protocol is unavailable, integration into a checked-out managed branch is refused before moving its ref. An ordinary successful integration MUST leave a supported managed integration checkout clean; a pre-existing or racing developer edit MUST remain visible and preserved.
>
> Recovery MUST enumerate all non-finalized journal operations, including confirmed operations awaiting their finalizer. A confirmed operation runs only its finalizer, never its external effect again. For intended, applied, and ambiguous entries, a probe classifies the effect as absent, applied, partial, conflicting, or unknown independently of whether an applied receipt survived. Observed application appends the missing recovery facts and proceeds to confirmation/finalization through declared A.5 transitions.
>
> Each journal kind MUST specify all five probe outcomes, the exact immutable probe inputs, and any safely resumable partial sequence. Commit creation includes object identity and keep-ref publication; worktree operations include the owned path and git metadata. Unknown or conflicting observations block. A retry requires positively reconciled absence or an explicitly bounded remaining effect; it is not inferred from a missing receipt.
>
> Every intent MUST persist or immutably reference its finalizer kind/version and exact semantic inputs before the external effect. Domain receipts MUST be unique on that operation and their semantic identity. The finalizer writes receipts and `finalized` atomically; repeating it returns those same receipts without generating new candidate/stage/version identities or consulting a newer plan. Extend D1-18/19/22/23 across every journal kind, including confirmation-before-finalizer, effect-before-applied-receipt, and duplicate finalization after dependent state changes.

### B08 — Still open: the proposed discovery baseline cannot prove absence of writers

**What is repaired:** prelaunch domain allocation, pid-null ownership, cleanup authority, explicit descendant termination, and quarantine reservations all answer real parts of R2 B08. Fencing is appropriate for late callbacks and restart in a single process; D1 §1.2 correctly disclaims a second-worker guarantee. [Observed this review: D1 §§2.7, 3.2, 4.5, 8.3, 16.1.]

**Remaining defect:** process groups plus environment markers are useful discovery aids, not an ownership boundary. A descendant can start a new session/process group and exec with a constructed environment that omits the marker. `/proc/<pid>/environ` describes the currently executed program's initial environment and is subject to ptrace access checks; it is not an immutable ancestry label. Simply calling `unsetenv` is not the counterexample—the new exec with a clean environment is. A scan also needs to handle concurrent fork/exit and unreadable processes without treating them as absence. [Recommendation/inference, supported by primary references: [Linux proc_pid_environ(5)](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html), [setsid(2)](https://man7.org/linux/man-pages/man2/setsid.2.html); D1 §§2.7, 4.5(2), 16.1.]

This host reports WSL2 Linux 6.6.87.2, cgroup v2, uid 1000, and Yama ptrace scope 1. Those observations do **not** establish that the engine can enumerate a future dedicated role user's environment, manage a delegated cgroup, or stop container-owned tasks. D1 §19.3 expects a dedicated role user, making the cross-identity question material. D2 must qualify it before the first real backend, not only before adding containers. [Observed this review: read-only host inspection; D1 §§17(12), 19.3; E E1/E7.]

There is also a direct escape in §4.1: a run may end when termination is established **or the operator resolves quarantine**. Section 4.5 demands termination. A human acknowledgement is not evidence that the process cannot write. Finally, the only described termination protocol is inside finalization, while §7.3 needs it *before* validation; session turn-end needs the same operation without ending the Run. [Observed this review: D1 §§4.1, 4.5, 7.3, 15.2; A.5.]

**Replacement for the domain baseline and termination admission rules:**

> Environment markers and process-group membership are diagnostic discovery aids. They MUST NOT alone establish that a domain is empty. D2 qualification MUST supply a durable engine-controlled execution boundary whose membership cannot be escaped by changing environment, session, process group, or parent, and whose complete termination can be observed after engine restart. Until that capability is qualified, the backend/mode is refused for real runs.
>
> The domain is durably registered and bound to that boundary before project/model work is allowed to execute. Termination verification MUST cover descendants, delegated tasks, cross-identity visibility, concurrent process creation, and backend/container-owned writers. Permission errors or loss of the containment authority mean unknown termination and quarantine, not zero processes. PID/start-time checks prevent signaling a reused PID; newly discovered owned processes require independently verified membership and a fresh start-time identity before signaling.
>
> Domain termination is a reusable engine operation invoked before one-shot snapshot admission, before a session turn becomes `open_idle`, and idempotently by `endRun`. No transition to ended, no snapshot, no resource reuse, and no workspace discard is allowed while owned write authority may survive. An operator may request quarantine recovery, but only observed termination or independently verified permanent removal of all write authority can complete it; acknowledgement alone cannot.
>
> D1-08 MUST include clean-environment exec, a new process group/session, an unreadable process, a fork during cancellation, and crash before the launch receipt. D2 MUST add container-runtime restart/reconciliation, namespace-crossing descendants, and delegated-task cancellation before qualifying those modes.

An engine-owned cgroup with nondelegable membership, tree-wide termination and observed emptiness is a plausible Linux mechanism; it is not qualified by the mere presence of cgroup2fs. Kernel documentation describes `cgroup.kill` and the recursive `populated` indicator. Container-runtime-created tasks must also belong to the recovered boundary. [Recommendation/inference: [Linux cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html), “Core Interface Files” and “[Un]populated Notification”; D1 §2.7.]

### B10 — Still open: the common WorkItem table permits the wrong paths and omits required ones

**What is repaired:** succeeded-only operation completion, Alpha conformance, repair counters, semantic progress keys, held Stop, and typed conflict routing are explicit. D1-31/37 now cover the missing success/limit cases. [Observed this review: D1 §§4.3, 13.3, A.5; DR B10.]

**Remaining defect and evidence:** A.5 calls its common edges applicable to **every** kind. Thus an intent-only `spec_change` or `triage_accept` can leave `awaiting_decision` for executing/integrating/verifying, although its kind's path is eligible→awaiting_decision→complete. A review can similarly enter integration. Conversely, §4.3 says Stop from any status owning a run becomes held, but A.5 has no `integrated→held` or `awaiting_decision→held`; a run may still be finalizing after integration or awaiting a decision. Those states also lack the stated Abandon restoration. “Restore prior_status” is not equivalent to the table's unconditional restoration to eligible. [Observed this review: D1 §§4.3, 7.5, 8.4, 11.5; A.5 WorkItem.]

**Replacement for A.5's common-transition clause:**

> Common transitions are templates restricted to states reachable for that WorkItem kind and to the named cause. They do not introduce integration or verification into a kind that has no such work. Returning from `awaiting_decision` MUST restore the stored blocked continuation allowed by that kind; intent-only work completes through its authorized intent transition and never enters a model execution path merely because a decision was answered.
>
> For each nonterminal kind/state that may still own a run, declare Stop→held and Abandon→the recorded permitted prior state, with cleanup and dispatch hold as preconditions. This includes integrated and awaiting_decision when ownership persists. Held work resumes only by an explicit Resume. No new trigger may dispatch onto resources still owned or quarantined by the old run. A.3 MUST represent the blocked continuation/restoration information that these transitions use.
>
> Tests MUST traverse Stop and Abandon from every reachable owning state, reject common edges incompatible with the kind, and show that a failed/superseded operation or a mere decision answer cannot complete operation-backed work.

### B11 — Still open: nullable invocation uniqueness does not enforce one-shot identity

The original correction-row and immutable-receipt defects are fixed: partial original-row uniqueness, delta corrections, status observations and per-turn finalization now agree. However, §6.2 enforces receipt uniqueness on `(run, turn)`, and A.3 makes `turn` null for one-shot runs. SQLite permits multiple rows with the same run and null turn under that constraint. I verified this with an in-memory SQLite database: two such receipts were accepted. The idempotency promise in §2.6 therefore lacks the claimed store constraint precisely for the one-shot lane. [Observed this review: D1 §§2.6, 6.2, 13.1, A.3 invocation_receipts; in-memory reproduction §8.1; CH §3.4 incidents 6/14.]

**Replacement for the receipt constraints in §6.2:**

> Invocation receipts MUST enforce `UNIQUE(run) WHERE turn IS NULL` for one-shot runs and `UNIQUE(turn) WHERE turn IS NOT NULL` for session turns. Creation MUST verify that the turn belongs to the same run and that RunKind agrees with nullability. Allocation and create-or-read occur in one transaction before any launch, and a repeated one-shot allocation returns the existing invocation. D1-26 MUST attempt duplicate allocation for both a null-turn run and a session turn, including after restart, and assert one receipt and no second launch.

### B12 — Still open: the closed manifests omit mutable material dependencies

**Sections:** D1 §§9.7, 10.5 and A.8. Binding option plans, transition version, time-based eligibility and execution-time preconditions is correct. The problem is that A.8's declared input lists are still smaller than the transitions they authorize. Recomputing eligibility does not necessarily detect a material change when both the old and new situations remain eligible. [Observed this review; Recommendation/inference: cited sections; R2 §2 B12; E E9/E12/E13.]

| A.8 family | Missing dependency or comparison with a concrete consequence |
|---|---|
| Baseline approvals | Current parent baseline/spec/architecture/roadmap and source bindings, proposal content and impact-analysis identity. Approving a still-eligible proposal against a different current parent must not silently rebase the decision. |
| Protected correction | Proposal base/current integration revision, approved spec and applicable architecture/scope approval, classification/authority, and proposal status. The same tree/diff and policy do not establish that the approved correction still applies to the current source and requirements. |
| Finding disposition/severity | Finding status, current disposition/resolution/applicability, sensitivity and relevant gate scope, acceptance-content binding, evidence and authority. The listed severity/revision/defer-target/policy tuple omits facts used by §9.3 and E19. |
| Blocker | The blocker cause, dependent evidence and permitted continuation/effect. A subject can stay parked while the reason and appropriate remedy change. |
| OOB reconciliation | A fresh observation of the actual ref or checkout, with content/index/metadata identity, not just stored `expected`/`found`. A developer can edit the checkout again after the preview while the stored row stays unchanged; no ref CAS protects those newer working-file bytes. |
| Partial rollout | Exact authorization identity/currentness, remaining scope and configuration/target binding, observation identity and expiry. Operation status and attempt identity alone do not establish the same approved remaining action. |
| Publication/allowlist | Exact candidate, export content/digest/mapping, destination repository and visibility, protected delta and its human-reviewed baseline, and current authorization. “Export validation” and release/allowlist version need defined value types, not an unspecified Boolean or stable row id whose contents may change. |
| Go-live | B03's prospective authorization content/current generation, applicable policy/protected version, and freshness/eligibility for its exact environment/targets. A consumed authorization's status must not accidentally stale its own authorized effect, nor may a superseded one survive. |
| Management/triage/adoption/requirement | Split the grouped row into actual per-kind manifests. Adoption requires the pinned repository identity/revision, selected mode and observed signals; triage requires current issue/requirement/module/sensitivity and disposition. Their later owning designs must close these before enabling effects. |
| Stop/Abandon | Invocation/turn and domain identities/generations, workspace identity/current base and the disposition consequence. Session RunState may remain executing while one turn/domain is replaced by another. |
| Retire/Reactivate | Relevant in-flight operations, sessions, management jobs and environment-record generations, in addition to baseline and open work. These determine what retirement freezes or stops. |
| Policy widening | Expected current policy revision/hash plus the proposed full policy content and authority analysis. An unchanged proposed diff cannot be applied over a concurrently changed base by overwriting it. |

These are not all requests for extra human approvals. They are values the existing approval must be unable to drift across. Immutable referenced content can bind its components by a verified hash; a mutable row id cannot. [Recommendation/inference: D1 A.3/A.8 and the corresponding §§7, 9, 10, 11.4 transitions.]

**Replacement for the manifest completeness and execution clauses:**

> A.8 MUST declare typed per-kind manifests containing the material dependencies listed in this review's B12 table. An immutable record hash may bind nested values; a mutable reference MUST include its revision/generation and any semantic expiry. Reserved later-design decisions remain non-executable until their manifests are complete. The engine MUST fail closed if a transition reads an eligibility or consequence dependency absent from its manifest.
>
> Answer validation MUST recompute the full option effect plan and eligibility from current dependencies and current time, compare the canonical plan and dependency binding to the preview, and refuse changed content even if the action remains eligible. Stored external observations MUST be refreshed or independently validated under the owning effect's concurrency protocol; rereading the same store row is not a fresh external read.
>
> Effect intents MUST bind expected pre-effect state after the atomic local consumption changes. They MUST distinguish expected changes caused by their own consumption from unrelated changes; consumption cannot either invalidate its own legitimate effect or exempt later external changes. Immediately before dispatch, revalidate the full binding, including current authorization and policy. For a checkout effect, compare the exact current HEAD/index/working content and preserve any intervening edit. For targets without atomic conditional execution, the adapter MUST declare its reconciliation boundary and MUST NOT claim that a local hash prevents an external race.
>
> D1-04/15 MUST cover a dependency changing while the action remains eligible, a new edit after an OOB preview, a changed publication artifact/destination, and an authorized effect whose own consumption changes a bound status. Each negative case MUST assert no effect; the positive case MUST execute once.

### B14 — Still open: the bootstrap evidence rule conflicts with the page's referrer policy

The no-token GET exception, all-mode isolation, streamed body caps, regular-file checks and audit-before-effect rules close the corresponding draft-2 holes. Exact Host/absolute-target checking before routing addresses the console's DNS-rebinding class. [Observed this review: D1 §§11.1, 17(1)–(2)/(12)–(14); console `docs/security-invariants.md` §1; full mapping in §8.3 below.]

But §11.1 requires both `Sec-Fetch-Site: same-origin` and Origin/Referer for bootstrap, while serving the UI with `Referrer-Policy: no-referrer`. A normal same-origin GET fetch does not acquire an Origin header from the Fetch algorithm, and the page policy suppresses Referer. Thus the default request from the actual page fails the stated predicate. This is a standards-based counterexample, not a freshly executed browser test. [Recommendation/inference: D1 §11.1/D1-29; [Fetch §3.2, Origin](https://fetch.spec.whatwg.org/#origin-header); [Referrer Policy §3.1](https://w3c.github.io/webappsec-referrer-policy/#referrer-policy-no-referrer).]

The conjunction is suitably restrictive **when those signals are actually present**. A browser or privacy setting sending neither must fail closed; accepting missing evidence is not the necessary repair. The request protocol must intentionally produce the evidence on supported browsers. [Recommendation/inference: same sources; D1 §§11.1, 17(2).]

Also scope the token rule explicitly around delivery of the initial UI shell. If “every origin-less request” includes the first top-level document navigation, a fresh browser cannot load the code that performs bootstrap. D1 does not declare a static-shell exception. This can be repaired without exposing any project data or token. [Recommendation/inference: D1 §§11.1–11.3, 17(2).]

**Addition to §11.1 and D1-29:**

> The UI MUST request bootstrap with an explicitly declared same-origin request referrer policy that supplies the same-origin Referer required by this endpoint, while retaining the page's no-referrer default for other destinations. The request MUST use the exact self origin and MUST NOT follow a redirect to another origin. A bootstrap lacking the required positive browser evidence is refused with `origin_refused` and returns no token; the UI displays an actionable unsupported-browser/privacy-setting error. No token is placed in a URL, persistent browser storage, or the error response, and ordinary clients continue to use the private token file.
>
> Enumerated static UI-shell and asset routes may load without a token after Host/target and contradictory-origin checks; they contain no token, project data or mutable authority. This exception permits an initial top-level navigation without same-origin referrer evidence and does not extend to API reads, bootstrap or mutations. The browser suite MUST begin with that initial navigation, not a preloaded test page. The authenticated streaming client MUST also support the declared token rule without putting the token in a URL.
>
> D1-29 MUST start from the served page with its actual headers, an empty browser session, and no injected token or fabricated security headers. It MUST exercise a supported Chromium-family browser and Firefox through bootstrap, one authenticated read and one mutation. Missing Origin and Referer, missing/foreign fetch metadata, foreign Host/absolute authority, and contradictory signals MUST all fail without token disclosure. The tested browser versions and request behavior are qualification evidence, not inferred from an HTTP mock.

This selects an explicit per-request policy repair; it does not require weakening the server's positive-evidence predicate.

### B15 — Still open: the session lifecycle cannot perform its declared terminal paths

**What is repaired:** first-turn provider-id capture, per-turn invocation/domain identity, reusable save returning to idle, current workspace base, and fresh-run resume are all explicit. The CLI continuation mechanism remains a D2 qualification prerequisite, not an assumed permanently live provider process. [Observed this review: D1 §§3.2, 4.2, 7.4, 15.2–15.3; DR B15.]

**Remaining defects and evidence:** `allocated` is SessionState, not RunState, yet §15.2 says it allocates the run “(allocated)” and §4.2 puts all session states within executing while §4.1 reaches executing on launch. More consequentially, A.5 has no allocated→closing or turn_running→closing path, despite close/Stop/timeout/recovery being required; it has no failed-save exit except ordinary saving→idle/closing with unspecified safety guards. `open_idle` requires no process, but turn completion never names the pre-idle termination/usage protocol. Finally, normal `session.close` goes directly to finalizing/endRun, which retains the workspace but never saves it; E10 expressly requires committing session artifacts at session end. [Observed this review: D1 §§4.1–4.2, 4.5, 15.2, A.5; E E10; R2 §2 B15.]

**Replacement for the session lifecycle clauses:**

> `session.open` creates a Run through created→claimed with `session_state = allocated`; it launches no provider invocation. The first turn moves the Run claimed→executing and the session allocated→turn_running. A turn may become open_idle only after its domain has confirmed termination, its result and usage have durable receipts, and no owned effect can continue writing. This uses the reusable domain-finalization operation and does not end the session Run.
>
> A.5 MUST include allocated→closing and turn_running→closing, in addition to the existing idle/saving closing paths, with cancellation and recovery guards. Closing an allocated session creates no invocation or ledger row. Stop, Abandon, timeout and recovery close admission to further turns before terminating domains. A failed save stays non-dispatchable until its exact journal operation is finalized or reconciled; then it returns to an explicitly resumable idle state or closes with the recorded failure.
>
> Normal human close of a session with unsaved permitted artifacts MUST run the same quiescent snapshot/checkpoint path as explicit Save before finalizing the Run. Interrupted close, Stop and recovery retain known work for explicit recovery; Abandon discards only after termination. A save/close cannot run the one-shot integration/completion path accidentally. D1-30 MUST include close before the first turn, Stop during an active turn, close with unsaved artifacts, failed save, and restart at each save/close boundary.

### B17 — Still open: lexical consistency is real, but several declared transitions and facts remain impossible

I independently ran the committed checker: exit 0, `D1 consistency: 0 finding(s)`. Its advertised lexical limits are acknowledged; I am not treating a lexical check as an attempted semantic proof. However, even its R3 state-membership claim misses the common WorkItem paragraph: an in-memory mutation from `held→eligible` to `held→undeclared_test_state` still returned zero findings. No document or script was changed for that probe. [Observed this review: `scripts/d1-consistency.mjs`, R3 block; D1 Appendix A introduction/A.5; §8.1 below.]

The following are remaining semantic schema discrepancies, apart from those already owned by B03/B05/B10/B15/B18/B19:

| Body contract | Appendix contradiction or missing representation | Required reconciliation |
|---|---|---|
| §16.1 recovers every non-ended Run through endRun. | A.5 has no created→finalizing. §4.1 sets outcome exactly once, but §16.1 says recovery sets recovered even for a Run already finalizing with completed/failed/etc. | Admit recovery from created; preserve an already recorded terminal cause and record recovery separately. Do not overwrite outcome or strand the Run. |
| §§4.1/4.5 allow quarantine eventually to resolve after confirmed termination. | Domain A.5 has no quarantined→terminated. | Add the observed-termination transition; no acknowledgement shortcut (B08). |
| §7.10 reconciles ambiguous journal effects and retries absent effects. | Journal A.5 gives ambiguous no outgoing transition; intended application whose receipt was lost has no explicit recovered-applied path. | Define recovery transitions and receipt ownership for all probe outcomes (B05). |
| §4.4/A.5 derive status from the latest attempt and permit retries after reconciliation. | Attempt A.5 cannot reconcile a recorded failed attempt; new attempts are permitted only after reconciled_absent/partial. The first attempt has no explicit exception to that permission rule; reconciled_absent with another attempt permitted has no derived operation status. | State first-attempt admission, reconciliation of failed/uncertain attempts, and a total operation-status derivation including the interval before an allowed retry. Never equate failed with proven absence. |
| §§7.6/7.9 invalidate check results; §9.2 must not revive them. | A.3 check_results has no invalidation/supersession representation; §9.2 selects a matching older row without checking invalidation. | Declare durable result invalidations and make selection reject them. Test same-binding evidence invalidated by OOB adoption and later reevaluation. Evaluation.stale alone does not invalidate its source result. |
| §9.1 reuses identified evidence with differing baseline bindings. | §9.2 first collects only `(check,candidate)` rows, excluding an explicitly referenced prior-candidate result; A.3 evidence_reuse points to a generic Record, with no typed approval/status/applicability binding. | Define the typed reuse assessment and eligible referenced result set, preserving all required binding constraints. Reuse must not be a broad OR bypass for wrong environment, runner, or protected version. Declare a later owner and disable reuse until then if deferred. |
| §6.4 says the applied migration list is a table. | No migration-history table is declared in A.1/A.3. | Declare the table and its immutable migration identity/checksum/ordering, or explicitly scope engine metadata out of A's claim and define it elsewhere in D1. |
| §11.1 allows the API port/self-authority to be configured; §§7.1/7.3 require git deadlines/output and snapshot caps; E9 makes decision-class aging targets configurable. | A.9 is the closed configuration schema, but contains neither the authority/port configuration nor the stated git/output/snapshot limits or decision-target configuration. | Declare their values, limits and ownership; distinguish constants from writable policy and defaults in A.8 from configurable overrides. |
| §§7.5/19.3 and E18 require one active Run per project through M3. | A.9 gives the project `max_concurrent_runs` range 1–8; §8.1 dispatches to that configured maximum. | Restrict the project value to 1 in the through-M3 profile; values above 1 are not an authorized v1 configuration in that profile. |
| §14.1 inserts a Record only after stream fsync/rename/publication, but also writes streaming chunk receipts for crash recovery. | A.3 stream_chunk_receipts requires a Record FK; a long-running stream has no declared parent Record yet. | Define the prepublication stream identity and receipt publication protocol, or publish immutable chunk Records with a manifest. A chunk receipt may refer only to durable retained bytes; a prepublication stream cannot be ordinary gate evidence. |

[Observed this review; Recommendation/inference: D1 sections and A entries in each row; E E7/E10/E18; R2 §2 B17.]

**Replacement for the remaining Appendix A consistency obligation:**

> Appendix A and the body MUST admit the positive lifecycle and crash traces in the preceding discrepancy table with the same types, creation order, guards and persistent facts. Each row MUST have an explicit owning transition; generic event payloads and projection-only fields do not supply missing authoritative state. Reserved later-design types MUST remain unusable for gate satisfaction or effects until defined.
>
> The checker MUST validate every state token in every A.5 edge, including common transitions and every element of a chained transition, against its own enum. Its output MUST identify that it checks lexical declarations only. Separately, a trace matrix MUST enumerate each required normal, refusal, cancellation, quarantine and recovery path against A.5, including creation-time nullability/FKs and finalizer inputs. A positive normal path and its crash variants MUST be internally satisfiable before an implementation is checked against this appendix.

### B18 — New: E19's human exclusion approval has no legal queue kind

**Sections:** D1 §§3.4, 9.3(5), 10.1, 11.4, A.2/A.8; E E19, “Consequences elsewhere.”

E19 explicitly adds the human decision authorizing exclusion of a blocking inherited finding. D1 has the assessment and `authorized_by`, but no matching DecisionKind/A.8 row or command route. Section 10.1 permits raising **only** A.8 kinds; the API's human answer route consumes those decisions. `finding_disposition` and `severity_lower` have different subjects/bindings and do not authorize excluding an assessment. Recording an arbitrary actor string directly would bypass E9's single queue. This is an omission in applying Sean's decision, not an objection to that decision. [Observed this review: cited sections; DR B02/Q4.]

**Addition to A.2/A.8 and §10.1:**

> Add `finding_applicability_exclusion` to DecisionKind. Its subject and approval bind the exact applicability assessment, finding, and successor candidate. Its manifest binds the assessment evidence/reason/status, proposing Verifier and independent assessing Reviewer runs, candidate ancestry and acceptance content, current finding severity/disposition/sensitivity, protected and policy versions, and the determination of whether the finding blocks any gate kind for that candidate. Approval may move assessed→approved only with the human owner's authorization when E19 requires it; rejection moves assessed→rejected. Both actions use the attention queue and record the approval or rejection provenance. Changed dependencies invalidate the preview.
>
> A test MUST prove that an assessed agent proposal alone never excludes a blocking finding, that the new human decision excludes it only for the bound candidate, and that a changed assessment or candidate cannot reuse that approval.

The same closed inventory should give human approval of a **tightening** correction an explicit kind/binding: §7.9 allows it but A.8 lists only loosening and unclassifiable corrections. Do not relabel a known tightening as unclassifiable merely to reach a human route. [Observed this review: D1 §7.9/A.8; E E9/E13.]

### B19 — New: a path/blob fingerprint cannot express the governed policy fields

**Sections:** D1 §§2.4, 5.2, 7.3, 7.9, 11.4; A.9.

Section 5.2 newly defines part of the protected set as selected **fields** in `.surety/policy.json`. Section 2.4 still defines the fingerprint solely as `(path, blob id)`. If that includes the policy blob, changing a non-governed budget changes the protected fingerprint despite §11.4 permitting the ordinary policy path. If it omits the blob, governed fields are not covered. No canonical field projection or separate protected policy artifact is declared. The new distinction is sound; its hash contract is not yet implementable as stated. [Observed this review; Recommendation/inference: cited sections; F §5.2; E E13/E16b.]

**Replacement for §2.4's fingerprint definition:**

> The protected fingerprint hashes a versioned canonical representation containing: the sorted protected file path/blob pairs; the canonical values of every governed policy field in §5.2 under explicit field keys; and the protected-set definition used to enumerate them. Canonicalization MUST define absent/default values, JSON key order, and path normalization. Nongoverned fields in the same policy file are excluded from this field projection unless the entire file is intentionally within a protected root.
>
> Validation computes the governed delta using the authorized old set and proposed new set; changing the roots cannot hide a removed protected obligation. An ordinary budget-only policy change MUST leave the protected fingerprint unchanged. A runner/required-check/root change MUST change it and require the protected-proposal route. A combined policy edit MUST preserve both governed and nongoverned values through the separately authorized operations, without applying an unapproved governed field as a side effect of the ordinary commit. Pin these cases in D1-12/35 and D3's classifier tests.

## 3. Non-blocking suggestions

### N01 — Closed: branch-independent store scenario is now meaningful

D1-02 states counts/totals before branch/history changes and tests API visibility, budget refusal, restart, linked worktree, rebinding and referenced records afterward. That is an adequate design-level test of the claimed branch independence. It is not a result from running Surety. [Observed this review: D1 §18 D1-02; DR N01; R2 §3 N01.]

**Replacement text:** none.

### N02 — Keep the lexical checker, but make its claim precise

The checker is useful for accidental identifiers. It merges all field names into one global set, accepts enum values when mentioned anywhere in selected prose, and does not assign each use to an entity or producer. Therefore a name declared on the wrong table can pass; an event appearing in an inventory is not proof of an executable owning transition. The missing common-edge check is a verified lexical defect, handled in B17. [Observed this review: `scripts/d1-consistency.mjs`, declaration parsing, `known`, R1/R2/R3; D1 Appendix A.]

**Suggested addition to the checker contract:**

> Zero lexical findings means the declared identifier checks passed; it does not certify field ownership, transition reachability, manifest completeness, or gate soundness. Checker regression fixtures MUST include invalid common edges, invalid final states in chained edges, and a body reference assigned to the wrong entity. The latter remains a documented unsupported check until entity-qualified parsing exists.

### N03 — Closed: fixture follow-ups and expanded latency requirement

`mockup/Gate.dc.html` now names five blockers and routes an applied protected correction to successor candidate c-0422. `mockup/Main.dc.html` distinguishes No dispatch from measured zero. `mockup/README.md` records the second fixture pass. D1 §§11.2/18 now require the import boundary and the expanded D1-20 load. The screens remain API consumers; their existence does not repair the bootstrap or gate-binding defects above. [Observed this review: those paths; D1 §§6.1, 11.2, 18 D1-20/33; DR N03.]

**Optional addition to D1-20:**

> Record health-response latency, Stop-request admission latency, and time to confirmed process termination separately. Meeting the first two does not report a stopped Run before the termination invariant holds. Report store queue depth and transaction duration at the qualified load.

The worker-default variant is acceptable; the expanded test, rather than a placement slogan, is the requirement. A timer on the main event loop does not preempt a synchronous call; the qualification must include the busy-store case already named. [Recommendation/inference: D1 §§6.1, 8.5, D1-20; DR Q1.]

### N04 — Closed: reuse provenance, with a useful accounting-fold addition

The required upstream commit, retained tests, adaptations and corpus limitations are now recorded by §19.2. The O10 modules exist at the resolved paths in §8.2. [Observed this review: D1 §§13.2, 19.2; DR N04; CH §8.]

**Suggested addition to §13.1:**

> Specify the ledger fold for a partial original row, later known token/cost deltas, and the transition from incomplete to complete usage. Null remains unknown rather than numeric zero; each correction is applied once. Include a worked fixture with cumulative provider observations, an interrupted invocation and a later correction, and assert both totals and remaining uncertainty.

This would pin the new delta protocol more clearly without reopening the repaired original-row constraint. [Recommendation/inference: D1 §§3.6, 13.1, A.3 ledger_rows; D1-26.]

### N05 — Retention rule closed; streamed publication remains B17

D1 §14.3 now retains records referenced by pending intents, decisions and journals as well as conventional evidence. Cross-chunk redaction and rescans remain explicit. The parent-record/chunk-publication ordering needs B17; the retention policy itself answers the prior suggestion. [Observed this review: D1 §§14.1–14.3, A.3; D1-16; R2 §3 N05.]

**Optional addition:**

> Retention tests MUST prove that a pending effect prevents expiry and that a post-scan hit blocks use of previously satisfied dependent evidence until the quarantine is resolved.

### N06 — New: keep the remaining fixtures aligned with the no-live-checkpoint decision

The requested Main/Gate corrections are present. A broader consumer check finds `mockup/Build.dc.html` still showing a running one-shot invocation with two checkpoints and a live checkpoint request in its tail. Draft 3 permits that request but refuses the snapshot while writers remain; its one-shot checkpoint continues in a new Run. This is fixture wording to update, not a reason to weaken Sean's accepted Q2 disposition. [Observed this review: `mockup/Build.dc.html`, Running and Lineage panels; D1 §§7.3–7.4; DR Q2.]

**Suggested replacement requirement:**

> Build fixtures MUST distinguish a checkpoint request from an accepted checkpoint. Under the v1 no-live-snapshot rule, accepted one-shot checkpoints are linked to their ended Runs, and continued work displays the successor Run identity. An active request is shown pending until the engine establishes quiescence and validates its snapshot.

## 4. D1 §20: resolved questions

There are no open questions in D1 §20, and I do not invent another decision round. The original eight questions remain resolved; the four draft-2 decisions are assessed here. [Observed this review: DR “Draft-2 open questions”; D1 §20; E E18/E19.]

| Decision | Assessment |
|---|---|
| Q1 Store worker default; D1-20 governs alternatives | Accepted. The expanded workload is the right requirement and does not change O9. Health/Stop responsiveness still needs implementation evidence. [D1 §§6.1, 18 D1-20.] |
| Q2 Refuse live snapshots; termination or process-free idle only | Accepted. B08/B15 require an enforceable meaning for “zero processes” and an executable path to idle; they do not reverse the decision. [D1 §§7.3, 15.2.] |
| Q3 Derive delivery from integrated implementation obligations | Accepted. B01 supplies the nonempty-set boundary and preserves the separate phase-completion obligation. [D1 §9.1; F §3.10.4.] |
| Q4 Verifier proposes, independent Reviewer assesses, human authorizes removal of any blocking inherited finding | Accepted as Sean's decision. The inheritance rule is closed under B02; B18 supplies its missing human-decision route. [E E19; D1 §§3.4, 9.3(5), A.8.] |

## 5. Errata conformance table

One row per E1–E17, plus E18/E19 used by this draft. These are design mappings. Trail §§B.1–B.4 maps the historical reasons; it does not itself prove incident prevention.

| Entry | Draft-3 location / gap |
|---|---|
| E1 Backend contract | §§15.1–15.4, 17(4)/(11)/(12), 19.3. Explicit real-backend isolation qualification is correct. **Gap:** B08's domain guarantee must be a prerequisite; D2 owns mechanisms and real-binary evidence. |
| E2 Engine performs git | §§7.1–7.10. Correct ownership and proposal branch. **Gap:** own-workspace rejection, integration checkout protocol and recoverable finalizers, B05; fingerprint B19. |
| E3 Deployment verification | §§3.4, 9.6, A.3; D1-25. Identity, protected behavior and current attempt/generation are represented. **Gap:** authorization lifecycle/currentness, B03. |
| E4 Walking skeleton | §19.3 correctly keeps M1 preliminary and the skeleton open through M3's applicable deployment obligations. **Gap:** executable phase-completion scope, B01; later plan design must enforce the phase-one shape. |
| E5 Mechanic triage | §§3.1, 3.7, 11.3, 14.4; reserved entities correctly have no operational authority. Detailed intake/triage remains later; complete its A.8 manifests before enabling it, B12. |
| E6 Adoption | §§3.1, 4.3, 19.3; conformance requires alpha_complete. Exact adoption baseline follows E18. Detailed analysis remains later; bootstrap/finalizer and lifecycle gaps B05/B17 still matter. |
| E7 Interruption/stop/resume | §§2.7, 4.5, 8.3–8.5, 15.3, 16. **Gaps:** complete writer ownership, legal cleanup states, and one-shot receipt uniqueness, B08/B10/B11/B17. |
| E8 Check judgment | §§3.3, 9.1–9.3, 17(8); D1-09. Only engine-established successful execution passes. **Gap:** result invalidation/reuse representation, B17; nonvacuous runner behavior is D3. |
| E9 Decisions | §§9.7, 10–12, A.8. Queue/dedupe/batching/aging are present. **Gaps:** complete manifests and missing E19/human-tightening routes, B12/B18. |
| E10 Sessions and development integrity | §§7.2–7.6, 15.2–15.3. **Gaps:** integration/owned-workspace distinction and session close/idle states, B05/B08/B15. |
| E11 Nomination | §§2.3, 3.3, 7.7; D1-18. Immutable candidates, tags and ancestry preserved. **Gap:** nomination finalizer recovery after confirmation, B05. |
| E12 Gate function | §§9.1–9.7. Open/dispositioned findings and all five input families are explicit. **Gaps:** phase scope, authorization cycle/currentness, invalidation and dependency completeness, B01/B03/B12/B17. |
| E13 Protected corrections | §§5.2, 7.3, 7.9. Authority split and protected-only proposal are present. **Gaps:** durable application, approval manifest/inventory, field fingerprint, B05/B12/B18/B19. D3 still owns classification/materialization. |
| E14 Product shape/O8 | §§1, 6, 11–12, 19.1. One service, two packages, engine-owned scheduling, public boundary and joint suite conform. **Gap:** executable browser bootstrap, B14. |
| E15 Provenance | Header, DR, commit history, §19.2 and this review preserve the trail. No historical intermediate acceptance is newly inferred; lexical success is distinguished from semantic closure. |
| E16 Retirement, budgets, records | §§10.1, 13–14. Retirement disables management/freezes observations; unknown/no-dispatch distinction and redaction are explicit. **Gaps:** retirement manifest, receipt uniqueness, durable chunk-parent protocol, B11/B12/B17. |
| E17 Stack/reuse/O9–O10 | §§6.1, 13.2, 19.1–19.2 conform. Modules exist and adaptations are required; §8.2 records the inspection. No stack or reuse-policy objection. |
| E18 Repository/O11 and D1 decisions | §§3.1, 7.2/7.5/7.7, 19.1 preserve repository/history, exact baseline and immutable tags. **Gap:** A.9's project concurrency range conflicts with the through-M3 value, B17. |
| E19 Finding-exclusion authority | §§3.4, 9.3(5), A.3/A.5 implement the assessed exclusion rule. **Gap:** no legal human decision kind/manifest, B18. |

## 6. Scenario coverage: A01–A25

Source for each row: AH §10. D1 numbers refer to proposed scenarios in D1 §18, not tests run in this review. A deferred owner is not an automatic D1 objection; “gap” identifies an unclosed contract or missing assertion.

| ID | Scenario | Draft-3 coverage / qualification |
|---|---|---|
| A01 | Sound spec on both backends | **D2 + later**; engine artifact/work registration §§7.8/19.3 and D1-32 supply part of the path. Full journey still needs real backends and plan workflow. |
| A02 | Vague spec | **Later** spec workflow; named gaps and continuation of the same request are not exercised by D1 scenarios. |
| A03 | Unknown config accepted by runtime | **D2**; §15.1 refuses unsupported qualification. Positive enforcement probes remain required. |
| A04 | Negative test never authenticates | **D2**; no D1 fake-adapter result can replace the positive liveness/auth control. |
| A05 | Repeat the same role; distinct attempts/usage | **D1-01/26**; distinct run/invocation identity is the new design's mapping. **Gap:** one-shot uniqueness B11. |
| A06 | Branch changes preserve full accounting | **D1-02**, now a strong design scenario; accounting correctness also depends on B11. |
| A07 | Consume completed parked review once | **D1-03/15** explicitly prohibit relaunch; **gap:** bindings and positive approval path B03/B12. |
| A08 | Head changes during/after review | **D1-04/19**; **gap:** complete source/checkout preconditions and finalization B05/B12. |
| A09 | Bounded small correction | **D1-31** now includes no-progress, hard attempt limit, and successful small repair; WorkItem paths need B10. |
| A10 | Contract conflict escalates | **D1-31**, typed FindingCategory and §4.3 route. No additional D1 scenario gap. |
| A11 | Completed planning trigger stays visible | **D1-05**, now explicitly includes observation after success; §8.2 returns without creating work. |
| A12 | Work done but response lost | **D1-32/06**; **gap:** artifact/domain finalizer recovery B05/B08/B17. |
| A13 | External write times out after application | **D1-06 + later** target adapter; B05/B17 must make local recovery states executable. |
| A14 | Unavailable/unauthorized GitHub | **Later**, as Trail §B.4 records. D1-28 covers observation expiry, not remote authorization/error classification. |
| A15 | Late CI or clock skew | **Later**, as Trail §B.4 records. D1 does not implement a remote registration grace window. |
| A16 | Two repos and hostile git environment | **D1-07**; explicit contexts/constructed env are present; checkout effects still B05. |
| A17 | Cancel/restart descendants and usage | **D1-08/26** cover more crash points. **Gap:** unescapable ownership, visibility failure and complete state paths, B08/B10/B11/B17. |
| A18 | Power loss after effect before receipt | **D1-23/19/22**, now names the applied-before-receipt point. **Gap:** confirmed/intended/ambiguous recovery B05/B17. |
| A19 | Multiple tabs preserve worker capacity | **D1-20/33** explicitly measure bounded queues, adapter read count and load responsiveness. Actual qualification outstanding. |
| A20 | Empty tests, skips, stale source | **D1-09** covers the states; **gap:** invalidated evidence selection and phase completeness B01/B17. D3 owns actual runner honesty. |
| A21 | Shell metacharacters and escaping output | **D1-10**, plus **D2/D3** containment/materialization. Snapshot/termination must meet B05/B08. |
| A22 | New CLI delegation/scheduling capability | **D2**, enforced refusal seam §§15.1/17(11). Marker scanning cannot be the qualification proof, B08. |
| A23 | Supervised project respects plan/build boundary | **D1-34** covers chaining; **D2 + later** for the real fresh-project journey. |
| A24 | Publish succeeds; deployment fails | **D1-25 + later** deployment/export design; release and runtime facts are distinct (§§3.5/9.6). **Gap:** add explicit retained-publication/failed-deployment assertions, and repair B03. |
| A25 | Prototype graduates without losing identity/history | **Later**, with D1-02/07/25 as supporting parts. Complete export, promotion and stronger-policy replay are deliberately deferred. |

## 7. Incident coverage: CH §3.4 incidents 1–20

This table distinguishes a specified prevention mechanism from verified implementation. Historical incident facts are **Recorded observation** from CH §3.4; the mappings and gaps are **Observed this review / Recommendation/inference** against the cited D1 sections. D2/D3/later gaps are retained visibly rather than credited to D1 as completed prevention.

| # | Historical incident | Draft-3 prevention mechanism or gap |
|---|---|---|
| 1 | Tail-swallowed lint; failing checker called clean | §§9.2/17(8) require established execution and successful exit, with output separate; D1-09. **D3 gap:** qualify direct per-check process execution and dishonest/wrapped runners. No D1 approval can turn skipped/failed into passed. |
| 2 | Codex enforcement no-op despite 567 green stubs | §§15.1/17(11)–(12)/19.3 refuse missing trust/isolation at every autonomy setting; engine validation §7.3. **D2 gap:** real positive/negative enforcement and credential tests. **D1 gap B08:** ownership markers are escapable; **B05:** validator rejects lawful content. |
| 3 | Headless Codex 0% success; unauthenticated lane | Backend/version/mode qualification and no silent fallback §§15.1–15.2. **D2 gap:** schema/error normalization and an authenticated positive control. Historical canaries are retained, not rerun or treated as qualification of Surety. |
| 4 | Sandbox made git branching/committing impossible | Engine owns git §§7.1–7.5; role supplies file edits. Correct authority separation. **Gap B05:** its own workspace is rejected by §7.3(4), and checked-out integration branches are dirtied by ref-only integration. The intended repair can still fail on the normal path. |
| 5 | Sandbox networking broke comments/state reads | Engine context/effect ownership §§1.1, 7.2, 15.1; clients never call adapters §11.3. **D2/later gap:** real capability/effect allowlist and remote adapters. Fixed context and engine-side effects answer the ownership error. |
| 6 | Unknown cost became $0; budget/approval deadlock | Nullable usage, distinct cost status, no-dispatch projection, fail-closed store and per-boundary budgets §§6.6/13; D1-02/13/26. **Gap B11:** null-turn duplicates undermine accounting; **B03/B12:** approval path can still deadlock or stale incorrectly. Test resolving budget refusal without re-buying completed work. |
| 7 | Context bloat, wrong-role inline work, delegation into void | One role/run, deadlines, fresh-run resume and per-turn domains §§3.2/4.5/15. **Gap B08:** escaped/unreadable descendants may survive a false empty-domain result; operator quarantine resolution is an unsafe alternative. **B15:** idle/closing paths incomplete. D2 must prove delegation denial or ownership. |
| 8 | No CI read as red; duplicate summary tripped breaker | Five check states, logical operation/attempt identity, Unknown notifications and bounded progress §§2.5/4.3/9.2/10.4. **Gap B17:** retry/reconciliation states are incomplete. Remote CI pending/absence remains later; no missing evidence is counted as passed. |
| 9 | Unreachable GitHub looked empty; wrong-repo read | Explicit context with stripped ambient overrides §7.2, source-age/expiry §11.3, D1-07/28. Local read ownership is improved. **Gap B05:** integrity/reconciliation of actual checkout state; remote unavailable/unauthorized classifications remain later. |
| 10 | Approval bought the same review repeatedly or never merged | Decisions consume once, exact effect plans, D1-03 asserts no adapter launch. **Gap B03:** first go-live requires an authorization that does not yet exist; **B12:** manifests can miss changed consequences. The “never finished” failure remains a direct contract counterexample. |
| 11 | Plan files never became work items | §7.8 integration finalizer atomically registers stages/work. **Gap B05:** confirmed entries skipped at restart can leave the plan committed without its schedulable receipts; **B10/B17:** legal continuation/creation rules incomplete. |
| 12 | Healthy new PR prematurely parked for absent CI | **Gap, later remote adapter.** D1 has honest check/Unknown vocabulary but no registration grace/skew protocol. Trail §B.4 correctly assigns A14/A15 to that later design; do not count this incident prevented yet. |
| 13 | Visible request replanned every tick | Unique trigger tuple §6.2, terminal create-or-return §8.2, and D1-05 including post-success observation close the original scheduler error at design level. Finalizer reliability B05 is still needed so successful planning actually reaches its registered terminal result. |
| 14 | Branch-bound usage lost; stale fallback under-enforced budget | Engine-home SQLite, FULL durability, fail-closed reads §§1.6/6.1/6.6, strong D1-02. The branch-bound-store mechanism is repaired. **Gap B11:** database uniqueness still permits duplicate one-shot receipts; accounting identity must survive recovery without a second dispatch or count. |
| 15 | Intent outputs remained uncommitted for 42 days | Explicit engine intent commit/registration §7.8. **Gap B05:** ordinary validation/finalization can fail; **B15:** session close never invokes the required save, so unsaved session artifacts remain only retained workspace files. |
| 16 | New provider got maximum trust by omission | §§15.1/17(11)/19.3 refuse absent backend/version/mode and require isolation before real use. Correct design mechanism. D2 must populate only qualified entries; no fallback trust is allowed. |
| 17 | Async tests passed vacuously; skip counted as pass | Execution-established/exit checks and nonempty coverage §§9.1–9.2; D1-09. **D3 gap:** actual runner must await, distinguish skips and reject vacuity. **D1 gap B17:** invalidated result reuse must not restore an obsolete pass. |
| 18 | Release truth drifted across dev/delivery homes | Entity projections and explicit release mapping §§3.5/9.6/12.2; publication-success predicate restored. **Gap B03:** old authorization/operation can remain current-completion eligible; later promotion must populate mappings from actual effects, not mirrors. |
| 19 | No-self-feeding silently hid plan intake | Visible decisions/blockers, engine plan registration and supervised boundary §§7.8/10/D1-34. **Gap, later intake/Mechanic design:** positive same-operator intake and explicit denied-intake explanation are not tested by D1. Preserve this as a required real journey. |
| 20 | Network outage stalled worker about 110 minutes | Async git, deadlines, bounded tick prerequisites and load scenario §§7.1/8.1/8.5; D1-20. Correct scheduling direction. **Gap B08:** termination/ownership proof; **B17:** recovery must have legal exits. A returned timeout is not proof that the writer stopped. |

The repeat cost risks are concentrated in ordinary git acceptance/finalization (4, 11, 15), incomplete cancellation (7, 20), and approval/accounting semantics (6, 10, 14). These gaps are deductions from the current contracts, not claims that draft-3 implementation tests failed. [Recommendation/inference: B03/B05/B08/B11/B12/B15/B17 above.]

## 8. What I verified versus inferred

### 8.1 Evidence record and limits

**Observed this review:** read DR first; E19 second; all of D1 Draft 3 including Appendix A third; then inspected and ran `scripts/d1-consistency.mjs`; then read the Main/Gate fixture follow-ups and README. Subsequently read the visible content of the other six fixtures for consumer consistency. Revisited F, the other errata, Trail, the earlier reviews and original scenario/incident inventories for the mappings. Git HEAD is `35bc38b`; its predecessor `498459f` records R2 and `357548d` is draft 2. Initial working-tree status was clean.

**Observed this review:** the requested checker returned exactly `D1 consistency: 0 finding(s)` with exit 0. Two additional inputs were supplied in memory through `/dev/stdin`, without editing its source or D1: an invalid common WorkItem transition was missed; an entity-qualified `runs.snapshot_tree` reference was rejected as an undeclared event. The latter illustrates its lexical namespace handling, not a defect in an existing D1 token. Source inspection confirms that field ownership is not checked.

**Observed this review:** an in-memory SQLite 3.45.1 table with `UNIQUE(run,turn)` accepted two different receipt ids for the same run and null turn. This tests the stated SQL constraint, not Surety allocation code. A disposable repository under `/tmp` showed that `git update-ref` on a checked-out branch moves HEAD but leaves old working content/index, reported as modified by status and diff-index. The scratch directory was removed after the probe; no reviewed repository was used for mutations.

**Observed this review:** read-only host inspection returned Linux `6.6.87.2-microsoft-standard-WSL2`, uid 1000, `cgroup2fs`, and ptrace scope 1. No process-kill/cgroup/container qualification was performed. Primary Linux and web-platform specifications were consulted for the process-marker and browser-header conclusions; links appear at those findings. No environment contents, credentials or token files were printed.

**Recorded observation:** previous CLI help/canary distinctions remain as recorded in R2 §8.1 and R1 §8: Codex 0.154.0 continuation help and Claude 2.1.286 help are not the retained Claude 2.1.281 canary. I did not invoke either model CLI or rerun a continuation canary. D1's per-turn-process session shape is plausible, but the provider's retained context, background tasks, files and cancellation must be qualified by D2 before eligibility. The fixture's displayed qualification dates are invented UI data, not new evidence. [CH §3.7; `mockup/README.md`; D1 §§15.2/19.3.]

**Implemented:** this label applies only to existing inspected Verity/console source. Framework HEAD remains `45344bbd6e83f8ee5f0a0c0b6856c464a98d0c7f`; console HEAD remains `741ccf3a9977eb4c60016a52509f8949bda88711`. Path existence and selected function bodies were rechecked. No existing source was edited and no Verity test suite was run.

**Open/reported:** historical issue/assessment status in AH and CH was not refreshed from remote trackers. Those reports establish retained incidents and prior observations, not current issue state.

**Recommendation/inference:** the verdict, failure traces, closure decisions, pasteable amendments and coverage judgments are deductions from the cited design. They are not empirical Surety failures: no engine implementation is supplied here. No paid model call, benchmark, real-agent canary, deployment, publication, browser automation, process-kill drill or power-loss simulation was run. The only persistent repository write is this requested review file.

### 8.2 O10 path verification

All paths below were present. They are relative to `/home/smahoney/projects/verity-framework`; CH §8's abbreviated `agents/...` paths resolve under `verity/bin/lib/agents/`, and bare helper filenames under `verity/bin/lib/`. O10 selects a narrower set than CH's entire keep/adapt inventory; this table checks that selected set and its supporting contracts/tests.

| Port area | Rechecked source/test paths and boundary |
|---|---|
| Driver seam/result contract | `verity/bin/lib/agent-exec.cjs`, `verity/bin/lib/agents/index.cjs`, `verity/bin/lib/agents/result-contract.cjs`, `contracts/agent-result.md`. |
| Drivers/feature matrix | `verity/bin/lib/agents/claude.cjs`, `codex.cjs`, `codex-features.cjs` in the same directory. |
| Containment/policy/trust adjuncts | `verity/bin/lib/agents/invariants.cjs`, `workspace.cjs`, `policy.cjs`, `tiers.cjs`; `contracts/role-capability-policy.md`. Existence is not Surety qualification. |
| Approval consequence | `verity/bin/lib/trust.cjs:331`, `approvalConsequence`; `verity/worker/index.cjs` exists for the related helpers CH names. Adapt to D1 decisions, not old GitHub approval transport. |
| Diff classification | `verity/bin/lib/trust.cjs:168`, `classify`; `verity/bin/lib/substrate-local.cjs:806`, `localPrDiff`. Existing risk classification/acquisition is not D3's semantic tightening proof. |
| Usage normalization | `verity/bin/lib/agents/claude.cjs:351`, `codex.cjs:822`; `verity/bin/lib/usage.cjs`. Inspected normalizers still fold Claude cache reads into input and use zero tokens for absent Codex usage. D1 §13.2 correctly requires adaptation. |
| Promotion allowlist | `verity/bin/lib/classification.cjs`, `promotion-config.cjs`, `promotion.cjs`; `.verity/production-content-classification.yml`. Extract the intended rules behind the new contracts. |
| Supporting tests/corpus entry | `tests/agent-exec.test.cjs`, `agents-codex.test.cjs`, `trust.test.cjs`, `usage.test.cjs`, `production-classification.test.cjs`, `promotion.test.cjs`, `real-codex.test.cjs`; `tests/fixtures/agents/README.md`. All exist; none executed here. |

**Missing named O10 source paths: none after resolving CH's documented abbreviations.** The prior reviews' warning about hypothetical `tests/provider-contract.test.cjs` and `tests/agents-claude.test.cjs` remains a warning not to invent test filenames, not a missing asset promised by O10. [Observed this review: filesystem inspection; Recorded observation: R1 §8.2/R2 §8.2; E E17; CH §8.]

### 8.3 Recheck against the console's 21 security invariants

Source: `/home/smahoney/projects/verity-console/docs/security-invariants.md`, bullets of §§1–5 in order. “Present” means D1 requires it; no Surety security tests have run. The existing console's trusted-local-operator assumption does not exempt Surety's role processes from §17(12).

| # | Console invariant | Draft-3 assessment |
|---|---|---|
| 1 | Loopback only | Present, §§1.2/11.1. Bind remains 127.0.0.1. |
| 2 | Host/absolute authority/100 Continue first | Present, §11.1; addresses the rebinding class. Declare the configurable self-authority in A.9, B17. |
| 3 | Exact-origin/token CSRF before body | Present for ordinary requests. **Gap B14:** the positive bootstrap client protocol must work with the served page headers. |
| 4 | Headers/CSP/no CORS | Present on errors as well, §§11.1/17(13). B14 resolves the bootstrap/referrer interaction. |
| 5 | Body caps; no parsing/effect after refusal | Present, §11.1 includes counting, deadlines and declared-length early refusal. |
| 6 | Untrusted DOM content as text | Present, §11.1; later UI suite must pin it. |
| 7 | Safe link schemes | Present, §11.1 resolves relative links before applying scheme rules. |
| 8 | Request/callback cannot crash engine | Present, §§11.1/17(14). |
| 9 | Fixed command paths; no shell strings | Present architecture, §§7.1/11.4/15.4. Actual API/adapter command schemas still need implementation validation. |
| 10 | No option injection | Present, §§7.1/17(3). |
| 11 | Bounded subprocesses/output/concurrency | Present intent, §§7.1/8/11.3. **Gaps B08/B17:** complete ownership and declared operating bounds; timeout alone does not end a writer. |
| 12 | UI never merges/calls a model | Present, §§1.1/11.2/15.4; import-boundary suite now explicit. |
| 13 | Redaction before response/audit | Present, §§11.1/14.2/17(5). Streaming publication ordering is B17. |
| 14 | Server-owned file paths | Present scoped Record ids, §11.3. Project creation/adoption is an intentional authorized repository-selection boundary, not an arbitrary record-read path. |
| 15 | Upload sandbox/atomicity/caps | Core requirements §§11.1/14.1 are present; no upload command is enabled in §11.4. A future route must keep server-allocated record destinations. |
| 16 | Regular-file/realpath/bounded previews | Explicit regular-file, device/FIFO and substitution denial now present, §11.1. |
| 17 | Closed, validated atomic config edits | §§11.4/6.3/7 provide the intended route. **Gaps B12/B17/B19:** stale base, missing config declarations and protected-field fingerprint. |
| 18 | Project membership on reads and commands | Explicitly present, §§11.1/11.3. |
| 19 | Correct clone and target context | Present, §§7.1–7.2 and D1-07. **Gap B05:** checkout synchronization/validation; B12 target binding. |
| 20 | No credential/token exposure | Intentional change to a private durable API token is declared; all-mode role isolation now mandatory, §§11.1/17(12). **B14** must make bootstrap usable without an unsafe fallback; **D2** must qualify isolation. |
| 21 | Audited attributable mutations | Present, §§11.1/12.1; audit commits with intent before effects and failure refuses mutation. |

### Questions for Sean

None required to judge this draft. The amendments implement existing foundations, errata and accepted review decisions. O8–O11, E18 and E19 are not reopened; mechanism qualification and a coherent transition/schema contract belong to the design work, not a new product-policy vote.
