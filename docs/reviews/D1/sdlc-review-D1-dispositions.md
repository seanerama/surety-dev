# D1 Cross-Review Dispositions

**Draft 1 review:** `sdlc-review-D1-Astra.md` (reject; 16 blocking, 5 non-blocking). Applied in draft 2.
**Draft 2 review:** `sdlc-review-D1-draft2-Astra.md` (reject; 5 closed, 11 still open, 1 new blocker B17). Applied in draft 3.
**Dispositions by:** Claude. Product decisions by Sean recorded where marked.
**Legend:** Closed = Astra marked it closed in her draft-2 review. Applied = the draft-3 change that answers her still-open finding, with the section that implements it.

## Draft-2 findings → draft 3

| # | Draft-2 status | Draft-3 disposition and location |
|---|---|---|
| B01 Gate scope | Still open | Applied. Evidence reuse only justifies a specific result and never replaces a check (§9.1); delivery derived from integrated stages at the pinned revision, never phase start (§9.1, Q3); selection order is none→missing, non-matching→stale, then latest matching by `execution_seq` (§9.2); scope carries `source_revision` and `runner_classes` (A.3). D1-09 extended. |
| B02 Findings | Still open | Applied. Evaluation covers `open` and `dispositioned` (§9.3(5)); applicability follows `started_from_candidate` ancestry, not lineage equality (§3.3, §9.3); `applicability_assessments` entity with Verifier/Reviewer/human authority (§3.4, E19, Q4); `reevaluations` keyed by evaluation id (§3.4, §9.3); invalidated resolution reopens (§9.5, A.5). D1-24 extended. |
| B03 Deployment | Still open | Applied. `deployment_authorizations` entity; `evaluateGate` takes `operation` for completion kinds; verification bound to attempt and `deployment_generation` (§3.4, §9.1, §9.6); Beta publication predicate restored (`PUBLICATION_NOT_SUCCEEDED`, §9.6); approvals bind the governed subject and sign-offs bind `acceptance_content_hash`, so one go-live approval serves authorize and complete (§3.4, §9.3(6)–(7), A.8). D1-25 extended. |
| B04 Proposals | Still open | Applied. Snapshot admitted only with zero live processes in the domain and the workspace lease (§7.3, Q2); live checkpoints refused in v1; protected changes classified by the governed set including policy fields (§5.2, §7.3 step 2); human policy edits become proposals (§7.9, §11.4); proposal capture is an intermediate state with the commit path unreachable (§4.1, §7.3). D1-21, D1-35. |
| B05 Git integrity | Still open | Applied. `managed_checkouts` with tracked-tree baseline; integrity reads tracked content; active workspaces excluded; typed `IntegritySubject` with per-subject dispositions (§7.2, §7.6); immutable `git_journal_events` plus `git_journal_state` projection; probes and domain finalizers per `JournalKind`; confirmed is not finalized (§3.5, §7.10). D1-18, D1-19, D1-36. |
| B06 Durability | Closed | Chunk receipts now a declared table (`stream_chunk_receipts`, A.3). |
| B07 Retry identity | Closed | Attempt-to-operation status derivation stated in A.5. |
| B08 Process ownership | Still open | Applied. `execution_domains` allocated before launch with an environment marker and process group; enumeration by marker, never parent pid (§2.7); ownership written with pid null before spawn (§3.2, §15.1); parent exit never establishes termination (§4.5 step 2); preflight refusal goes through `endRun` (§4.1); `cleanup_authority` distinct from role authority (§3.2, §8.3); quarantine reservation is a distinct lease kind; recovery enumerates `allocated` domains (§16.1). D1-08 extended. |
| B09 Event loop | Closed with variant | D1-20 workload expanded per N03 (§6.1, §18). |
| B10 Work state | Still open | Applied. A.5 is the single transition table and §4 references it; operation-backed kinds complete only on `succeeded`; conformance only on `alpha_complete`; `held` status for Stop; `dispatch_hold` on Abandon; `repair_attempts` increments atomically; progress-key fields defined; `FindingCategory` for typed conflicts (§4.3, A.2, A.5). D1-31, D1-37. |
| B11 Accounting | Still open | Applied. Invocation id allocated before dispatch and shared (§2.6); immutable receipt plus `invocation_status_observations` (§3.6); `UNIQUE(invocation) WHERE corrects IS NULL` and `(invocation, correction_seq)` (§6.2); sessions finalize per turn with no session row (§13.1). D1-26 extended. |
| B12 Decisions | Still open | Applied. Per-kind `dependency_manifest` (A.8); `preview_hash` over identity, option set, plan hashes, schema version, manifest values including deadlines (§3.4, §9.7); fresh-read recomputation with current time (§10.5); `effect_intents` with preconditions revalidated immediately before execution and target-side CAS (§3.4, §10.5). D1-04, D1-15, D1-27 extended. |
| B13 Observation | Closed | `observation_history` now a declared table. |
| B14 Boundary | Still open | Applied. `GET /v1/token/bootstrap` is read-only with positive same-origin evidence and no token (§11.1, §17.2); body caps distinguish declared length from counted bytes (§11.1); isolation required for every run at every autonomy setting, `isolation_unqualified` (§15.1, §17.12); Referer parsed as origin, link resolution, regular-file checks, audit before effect (§11.1). D1-29 extended. |
| B15 Sessions | Still open | Applied. `allocated` state; first turn creates the provider session and captures its id; per-turn invocation and domain; save returns to `open_idle` and never takes the termination path; `current_base` tracked separately from `base_revision` (§3.2, §4.2, §7.4, §15.2). D1-30 extended. |
| B16 M1 labeling | Closed | Isolation prerequisite for any real backend added to §19.3. |
| B17 Appendix | New blocker | Applied. Appendix A rewritten first with every entity, field, nested key, enumeration, transition, event, reason, error, decision kind, and configuration key; body written against it; every enum value and event named by its owning transition in the body; `scripts/d1-consistency.mjs` checks both directions and its clean run is recorded below. Specific items: journal split into immutable events plus mutable state; ledger uniqueness partial; `EventType` alias; `→capability_grants`; `released_at IS NULL`; decision unique on `kind`; success outcome `completed`; `proposal_captured` intermediate; quarantine stays finalizing; A.5 single table; `assessment` kind; attempt-to-operation mapping; scope `source_revision` and `runner_classes`; approval subject binding; verification attempt and generation; `managed_checkouts`, `observation_history`, `stream_chunk_receipts`, `invocation_status_observations`; `FindingCategory`; `applicability_assessments`; A.9 configuration; incarnation written to the lock file before the store; `pending_bootstrap`; `RecordKind` variants; `InvocationStatus`; `Role`; `ActorKind`. `oob_dev_repo_change` removed; `withdrawn` removed; `superseded`, `sending`, `stale` given derivations. D1-38. |
| N01 | Closed | D1-02 states counts before and asserts after. |
| N02 | Elevated to B17 | See B17. |
| N03 | Partly closed | Import-boundary enforcement in the joint suite (§11.2); D1-20 workload expanded; Gate fixture now shows five blockers and the successor candidate c-0422 after a protected correction; Main fixture labels no dispatch as "No dispatch", never "measured zero". |
| N04 | Closed | Regression-corpus provenance sentence added (§19.2). |
| N05 | Substantially closed | Chunk and reference schema declared; retention covers pending intents (§14.3). |

## Draft-2 open questions

| Q | Decided by | Decision |
|---|---|---|
| Q1 Store worker placement | Claude, per Astra | Worker is the default; a main-thread placement is eligible only under the expanded D1-20 workload and its declared limits (§6.1) |
| Q2 Session snapshot quiescence | Claude, per Astra | Live checkpoints refused in v1; snapshots only at confirmed termination or `open_idle`, which owns no process (§7.3) |
| Q3 Delivered requirements | Claude, per Astra | Delivered iff every implementing stage is integrated at or before the candidate's revision; partial shown separately; release obligations in scope regardless (§9.1) |
| Q4 Finding-exclusion authority | **Sean** (E19) | Verifier proposes; independent Reviewer assesses; human authorizes any exclusion that removes a finding blocking any gate (§3.4, §9.3) |

## Draft-1 findings (for the record)

All sixteen blocking objections and five suggestions from the draft-1 review were accepted and applied in draft 2; the draft-2 review's section 2 records which were closed there and which remained open. The eight draft-1 open questions were resolved as recorded in draft 2 §20 and E18.

## Consistency checker

`node scripts/d1-consistency.mjs sdlc-design-D1-engine-core.md` on the committed draft 3:

```
D1 consistency: 0 finding(s)

Run on 2026-09-30 against the draft-3 text at the commit that adds this file. Rules checked: R1 body identifiers declared; R2 declarations owned; R3 A.5 states in their enumerations; R4 A.8 and DecisionKind agree; R5 foreign keys name declared tables. The check is lexical; semantic agreement between body and appendix is what the cross-review is for.
```
