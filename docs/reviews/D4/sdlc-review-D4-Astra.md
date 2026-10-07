# D4 cross-review — Astra

Reviewed 2026-10-07 in `/home/smahoney/projects/sdlc-x/.claude/worktrees/design-d4`, HEAD `63b28eaf16261f0b0c1fbacb66debc788c8d4ec6`. Subject: D4 revised draft 1. This review authorizes no implementation, spending, or service-manager action.

References below are repository-relative. **D4** = `docs/design/sdlc-design-D4-deployment.md`; **Brief** = `docs/design/sdlc-design-D4-brief.md`; **D3** = `docs/design/sdlc-design-D3-checks.md`; **D2** = `docs/design/sdlc-design-D2-backends-and-isolation.md`; **D1** = `docs/design/sdlc-design-D1-engine-core.md`; **BS1** = `docs/spec/M1-build-spec.md`; **F** = `docs/foundations/sdlc-framework-foundations-v1.0.md`; **E** = `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`; **SEAM** = `packages/engine/test/acceptance/harness/SEAM.md`; **CH** = `docs/reviews/predecessors/sdlc-review-claude.md`; **Probe** = `docs/reviews/D4/feasibility-probe-2026-10-07/`. These aliases name files, not independent sources. Evidence labels retain the meanings in `docs/reviews/D3/sdlc-review-D3-Astra.md` §9.

## 1. Verdict

**Approve with the amendments in section 2 applied.** The architecture is a sound next increment: engine-owned effects, a disposable Alpha target, independently read artifact identity, protected behavioral checks, and separate environment facts. The revisions substantially address RV1–RV6. However, a persistent service introduces authority and secret lifetimes that D2's invocation boundary did not have; D4 still leaves those protocols incomplete. Its reconciliation, retry, verification-round and lease contracts also admit false success or indefinite waits. The eight amendments below close those gaps without adding a cloud adapter, production monitoring, sessions, or another design round. Sean should disposition the architecture choices once; the corresponding counterexamples become M4 acceptance cases under E20. The stand-in probe establishes feasibility, not qualification of the implementation.

## 2. Blocking objections

### B01. A persistent service needs a persistent supervision contract

**D4 sections:** §§3.4, 9.2, 11; J2; A.3–A.4.

**What is wrong.** “A socket the engine reconnects to” does not define how a new incarnation establishes authority over an old init, retrieves its original application identity and exit state, or accounts for the domain before admitting new work. “Recovery never closes or kills” and “ends only through teardown or a later deploy” also omit natural application exit and failed launch. An active launcher/init with an exited application must not become a healthy service. A manager-driven restart must not replay the original grant. These are changes to D2's lifecycle, not merely an additional nullable owner column.

**Evidence — Observed this review / Recommendation/inference.** D2 §§3.2–3.5 require current launch bindings, closure and a fresh challenge; §3.7 charges every running domain to admission. The actual `packages/engine/src/invoke/domain-init.ts` uses inherited stdin/stdout as its control channel (file preamble), reports a single child's PID, and exits after that child's exit and bounded output draining (`child.on('exit')`). It does not offer D4's reconnecting service supervisor. D4 §9.6 explicitly says the probe did not exercise that channel. D4 A.4 omits allocated→terminated and quarantined→terminated for services, which BS1 §6 corrections 1 and 13 require for refused starts and recovered quarantine. The parent-exit counterexample is discussed precisely in §8.3 below; I am not claiming a demonstrated child-identity substitution.

**Proposed replacement text:**

> A service launch is single-use. The unit is configured with automatic restart disabled; neither the manager nor the init restarts the application under a spent grant. The init records one original application identity and its terminal exit observation in trusted, bounded memory for the domain's lifetime. It never substitutes a descendant or another process for that identity. On application exit it records the exit before draining output, closes ingress, and terminates remaining descendants within the domain's closure protocol. Natural exit, refused setup and failed exec are legal service-domain endings; uncertain termination remains quarantined. Service-domain transitions include allocated→terminated and quarantined→terminated on observed closure.
>
> The service control endpoint is distinct from the data relay and inaccessible to application and check code. Reconnection authenticates the recorded domain, unit invocation, init identity and a fresh challenge, and binds the connection to the current engine incarnation under the home lock. Responses identify their domain and supervision generation; stale connections confer no launch or mutation authority. Reconnection recovers the original application identity and exit state rather than discovering a replacement. If these facts cannot be established, supervision is unknown and no verification may pass.
>
> Startup closes outstanding launch authority before accepting launch requests. A request of a previous incarnation is refused even before its row has been visited by recovery. A fresh control connection never reopens a spent launch. Before admitting any new domain, recovery accounts for every surviving or uncertain service domain's resource reservation. Unknown ownership or a restored store that cannot account for observed units blocks affected deployment and admission rather than adopting or stopping those units automatically. Inspection and exact-resource manual recovery remain available.

**Tests:** actual service-profile launch; application exit with a descendant holding the port and with output closed; failed exec; engine crash/reconnect with the same application; stale control connection; unavailable control channel; attempted manager restart with a spent grant; recovered resource accounting; restored-store mismatch. Extend D4-I05/O03/O04/T01. J2 must explicitly carry this lifecycle correction.

### B02. Reconciliation predicates do not cover the whole effect or make absence stable

**D4 sections:** §§2.2–2.4, 4.6, 9.3; Appendix B.

**What is wrong.** The table permits overlapping answers and its read implementation is narrower than its promise. A deploy with `prior` unchanged, no g unit and no grant satisfies `absent` even if an unexpected generation is active: it also satisfies `conflicting`. Teardown says `applied` when no unit exists, although §4.6 includes cgroups, sockets and runtime directories in the effect. Appendix B reads exactly intent/capability names, which cannot discover an unrecorded generation. Closing a launch grant prevents application execution but alone does not settle an outstanding service-manager create/stop job. A late teardown stop has no application-launch check to fence it.

**Evidence — Observed this review / Recommendation/inference.** These are direct counterexamples to D4 §2.4's predicates and Appendix B's named reads. D2 §3.2 requires both closure and establishing that an outstanding launcher cannot enter. The existing journal already separates that prerequisite: `packages/engine/src/journal/driver.ts`, `reconcile()` calls `othersChildrenGone()` before probing. BS1 §6 correction 14 requires positive absence or a bounded remaining effect before retry; F §3.7 requires reconciliation of interrupted effects.

**Proposed replacement text:**

> Reconciliation first establishes a complete, bounded inventory of the environment's recorded resources and exact-prefix unit names, including inactive/failed units and pending manager jobs. Discovery confers no authority to stop a discovered resource. An incomplete inventory or unread required resource yields unknown. A resource outside the frozen attempt's permitted states yields conflicting; these conditions take precedence over applied, absent and partial.
>
> A deploy is absent only if its next unit and domain are absent, no launch was granted, the prior state is exactly unchanged, no unexpected environment resource exists, and no outstanding host request or launcher can subsequently perform that attempt's effect. A deploy is applied only on the authorized unit invocation and original application instance, matching identity, with the required prior termination established. Refusal of a grant is not proof of unit removal. A refused launcher still represented by a unit is pending/partial until bounded cleanup and a new read establish absence; it is never treated as an applied deployment.
>
> Teardown is applied only after closure and observed removal of every resource its effect covers: units, populated domain cgroups, link sockets and runtime directories. Surviving owned resources yield partial; unexpected or uncertain ownership yields conflicting; unread state yields unknown. Absent requires the entire frozen pre-state unchanged and no outstanding stop/cleanup request capable of acting later. No success predicate uses an empty result from a failed query.
>
> Before lease transfer, retry or replacement dispatch, the engine closes launch authority and establishes quiescence of the prior effect's host calls and manager jobs. Killing a CLI or receiving cancellation alone is not quiescence. If it cannot be established, the effect stays ambiguous and no new effect is interleaved.

**Tests:** strengthen D4-A03/A04/O04/O09/O10/O11 with unexpected active generation plus intact prior; no units but residual owned socket/cgroup; incomplete inventory; and delayed manager create/stop after caller cancellation. Prefix listing is read-only; every destructive action still uses positively owned exact resources under §9.5.

### B03. Frozen operation intent cannot also be every retry's exact intent

**D4 sections:** §§2.2, 4.1–4.4, 9.3; J1; Appendix B.

**What is wrong.** Exact unit names are frozen on the operation before its first attempt, but names include a generation allocated per attempt. A permitted second attempt gets a new generation and therefore a name the frozen operation did not hold. After a partial first attempt, its failed unit may also need cleanup although it is neither the original `prior` nor the second attempt's `next`. The existing frozen-input trigger correctly prevents changing the operation to fit the retry. Additionally, a finalizer that performs a fresh identity read while registering checks needs a durable verification identity: trigger dedupe alone does not freeze the read or its verification round.

**Evidence — Observed this review.** D4 §§4.1, 4.2 and 9.3 respectively freeze names, allocate generations and derive names from those generations. `packages/engine/migrations/0003_git_and_journal.sql`, `operations_finalizer_inputs_frozen`, rejects mutation. BS1 §6 correction 14 requires repeated finalizers to return the same receipts, and permits only explicitly bounded remaining effects after partial execution.

**Proposed replacement text:**

> The operation's immutable intent freezes its authorization, source mapping, artifact, configuration, target set and environment identity. Before each attempt's first host call, one transaction allocates its environment generation and freezes a separate immutable attempt intent: exact next-unit names, the prior resource instances it may replace, and any explicitly authorized cleanup of earlier attempts. Its capability and reconciliation probe use that attempt intent. No attempt changes the operation's authorized inputs or silently acquires authority over an unexpected resource.
>
> A partial retry's human preview names the reconciled state and bounded remaining effects. Its dependency manifest binds the operation, attempt, environment and lease generations, configuration, qualification, resource identities and observations used to derive those effects. A changed consequence stales the preview. A retry cannot merely rerun the original stop/start sequence against a different state.
>
> The finalizer records the confirmed effect once and creates or returns one durable verification-round identity. External identity reads and check execution occur outside that transaction against this identity. Replaying the finalizer returns the same receipts and registers no additional round; recovery resumes or explicitly supersedes the round under §5.3.

**Tests:** D4-O03/O05 with two attempts of one operation, including partial cleanup; refusal of a different artifact/configuration on retry; crash before and after finalization; changed partial-retry preview. No amendment to the existing frozen-operation trigger is needed.

### B04. Effect preconditions omit changes that withdraw gate eligibility

**D4 sections:** §4.1; J3–J4.

**What is wrong.** The listed checks establish that a row is still consumed by this operation, but not that the candidate remains eligible under the acceptance and policy evidence that justified issuance. Between authorization and effect a protected tightening can invalidate results, a required rerun can become pending, or a new blocking finding can appear. None is explicitly in §4.1's effect list. “Not superseded” does not establish these facts.

**Evidence — Observed this review / Recommendation/inference.** F §§3.3, 9.1 require passing checks and dispositioned blocking findings. D1 §10.5 and BS1 §6 correction 22 require revalidation of eligibility and the complete consequence. In the checkout, `packages/engine/src/store/transitions/protected.ts`, `finalizeApplication()`, invalidates results, marks evaluations stale and registers new executions; it does not supersede deployment authorizations. `gates.ts`, `issueAuthorization()`, supersedes only earlier *issued* authorizations when a new one issues. D4 supplies no other automatic invalidation that would make its status-only test sufficient. This is a design counterexample, not a reproduced deployment bug in the unbuilt consumer.

**Proposed replacement text:**

> Immediately before each effect, the engine revalidates the issuing gate's current eligibility for the operation's exact candidate and authorization binding, including effective protected version, policy, deciding registrations/results, required sign-offs and approvals, findings and evidence integrity. This read does not issue or consume another authorization. A changed binding or unsatisfied eligibility refuses the effect with EFFECT_PRECONDITION_CHANGED. The durable precondition manifest identifies these dependencies and the environment facts already listed. Registration or invalidation owed by a trigger is a barrier to eligibility; it cannot be bypassed by a previously satisfied evaluation.

**Tests:** add to D4-O02 a protected tightening, pending required rerun, new blocking finding, lost sign-off and expired required evidence between issuance/intent and effect, with no adapter effect call. Positive control: the operation's own expected authorization consumption does not invalidate it.

### B05. Verification rounds need their own durable ordering and pending barrier

**D4 sections:** §§4.2, 5.3–5.5; J7, J9; A.3.

**What is wrong.** Environment generations solve overtaking by another deployment, but not two verifications of the same attempt. The API starts a new trigger generation, performs t0 and then registers checks; until registration, an old verified row may still decide. “The latest row” can also mean completion order, allowing a delayed older round to overwrite a newer round. No durable round binding connects both reads, the required set, recovery and check retry registrations. A protected-version change during a round further needs a precise supersession rule, not relabelling old reads and results with the version effective at insertion.

**Evidence — Observed this review / Recommendation/inference.** D4 §5.3 orders the first external read before registration, and A.3 declares no deciding round identity on verifications. E90 item 1 B03 and D3 §§2.5, 7.1 L7 expressly reject older-pass fallback while newer work is owed. M3 plan row M206 tests completion-order reversal. D4-V08 tests only a different environment generation and misses the same-attempt case.

**Proposed replacement text:**

> A verification request records a durable monotonically ordered round for the operation/attempt and invalidates dependent completion evaluations in its initiating transaction, before t0. The newest registered round decides, regardless of completion order. While it is pending, interrupted, cancelled or quarantined, an earlier verified row cannot satisfy completion. Earlier evidence and historical last_verified remain visible as history.
>
> A round freezes the candidate and source mapping, operation, attempt, environment generation, configuration, protected version and required check set. Both identity reads and every deciding execution/result identify that round. A changed required set or effective protected version supersedes the round and requires a fresh bracket and registrations. Recovery preserves the original bounded retry accounting and records a new deciding round when its bracket must restart. No read or result is relabelled into a later round.
>
> Insertion of a verification and writes to environment projections check both the environment generation and deciding verification round in one transaction. Completion reevaluates all current dependencies and evidence; it does not trust a stored verified label alone. Qualification validity is checked consistently at round start and finalization; a lapse before finalization makes that round unknown and requires a fresh qualified round.

**Tests:** two rounds of one attempt finishing in reverse order; old pass followed by request held before t0; cancelled/quarantined latest round; protected change between reads; recovery and qualification lapse; evidence loss after the verification row. Extend D4-V01/V03/V04/V06/V08.

### B06. Verification and lease release have no complete bounded failure path

**D4 sections:** §§4.1, 4.3–4.6, 5.3, 9.2.

**What is wrong.** Holding the lease through verification is useful, but its release condition assumes verification and completion occur. An effect refused before launch has no verification. A superseded candidate's queued checks are cancelled by D3. A quarantined execution produces no result indefinitely. Infrastructure retry count does not bound waiting for resources, closure or missing registrations. Preempting teardown is specified for an *ambiguous deploy*, not a succeeded effect stuck in verification. Also, admitting persistent services up to the envelope can leave no capacity for the check needed to release the lease.

**Evidence — Observed this review / Recommendation/inference.** D3 §§2.5–2.7 require cancellation of superseded queued checks and no synthetic result on unknown termination. D4 §4.3 says no verification row “until the full set exists”; §5.3 also promises an unknown outcome for missing checks after retries. D2 §3.7 enforces admission without reserving a future check slot. CH §3.4 incident 6 is precisely two individually correct guardrails producing a deadlock.

**Proposed replacement text:**

> Deployment orchestration has a durable deadline and progress state independent of effect success. The deadline bounds admission waiting, verification registration, reads and infrastructure retries, survives restart, and is not renewed by a tick or retry. Reaching it records verification unknown with the missing execution/resource identities; it never synthesizes a check result or claims termination.
>
> Lease disposition is explicit for pre-effect refusal, reconciled failure, verification failure/unknown, superseded candidate, completion refusal and cancellation. A lease is released only after outstanding effects are quiescent and unsafe ingress is closed. Unknown process termination retains the domain's quarantine and reservation even when orchestration has ended; it is not reusable authority. A blocker exposes the cause and permits bounded re-verification, abandonment of completion, or preempting teardown as applicable. Preempting teardown is available during verification as well as during ambiguous deployment.
>
> Service admission reserves the capacity required for at least one serial post-deploy check under the configured envelope, or refuses before stopping the prior service. Recovery restores these reservations before dispatch. The first target never starts a deployment whose own persistent reservation makes its mandatory verification impossible.

**Tests:** effect refused before launch; cancelled superseded check; missing registration; resource starvation; quarantined check; engine restart near the deadline; abandon and teardown during verification. Keep D3's no-result-on-unknown-termination rule intact. Extend D4-O02/O07/O10 and V04.

### B07. Rotation loses the redaction context of the surviving service

**D4 sections:** §§3.2, 7.1–7.4, 9.2–9.3, 11.

**What is wrong.** After restart the engine holds the new secret, while the persistent service still holds the old one. Its old output and new responses can still contain the old raw value. Registering secrets “for as long as [the engine] holds” them no longer screens everything this domain can emit. A post-restart log read or check against the old service can persist that value. The draft also needs an explicit output path that never sends raw service output to the service manager's journal.

**Evidence — Observed this review / Recommendation/inference.** D4 §7.4 explicitly retains the old value in the service until redeploy/teardown. `packages/engine/src/invoke/keys.ts`, `holdSecretFiles()`, reads startup files; `packages/engine/src/records/redact.ts`, `holdSecret()`, retains in-memory values by reference. A restarted process has no old value unless it is explicitly recovered. D2 §2.5 requires raw output to remain on unswappable volatile storage until screening. D4-A09/S01/S03 test these properties separately, not their conjunction.

**Proposed replacement text:**

> Redaction authority is versioned by the secrets actually delivered to each surviving domain, not only the resolver's current references. The trusted init retains that domain's secret/redaction context in protected, unswappable memory while the domain or its capture survives. Raw service output is captured only there; no raw output is forwarded to the unit's standard streams, journaling or other persistent sink. Host-read process fields and error details are untrusted output for publication and pass the same screen.
>
> Before exporting logs, enabling a service link/operator relay, or collecting a check's output from a surviving generation after restart, the engine establishes a complete redaction context for every secret version that generation can emit, through the authenticated trusted-init channel. Values recovered for screening confer no new injection authority and are never persisted. If the context cannot be recovered, these exports and links are refused with an explicit unavailable-redaction condition until the service is safely replaced or torn down; the old bytes are not published under the new redactor. The environment read distinguishes the running configuration/secret version from the newly configured version and reports rotation pending replacement.

**Tests:** rotate S0→S1, restart while the S0 service survives, then emit S0 in new output, a retained capture, a response to a check and mutable process metadata; neither raw nor registered escaped forms reach records, events, responses, unit properties or journal output. Repeat with reconnect unavailable. Extend D4-A09/S01/S03/S04. Encodings outside the registered forms and a compromised operator account remain class C/A respectively; this objection concerns raw secrets the engine itself delivered.

### B08. Artifact construction needs a bounded, canonical mode contract

**D4 sections:** §§3.1, 3.4; A.2, A.7; D4-I01/I02.

**What is wrong.** The digest includes mode, but files become read-only after manifest computation. A Git `100644` file materialized as `0644` and sealed as `0444` cannot be compared literally with its original mode during the target walk. Conversely, omitting mode from the implementation would make byte-only I01 pass while the claimed identity is false. `too_large` and `too_many` have no declared bounds, aggregate artifact admission limit or retention-pressure behavior; an engine projection of untrusted repository contents runs outside the service's resource boundary.

**Evidence — Observed this review / Recommendation/inference.** D4 §3.1 explicitly orders manifest computation before permission changes and hashes `[path,type,mode,size,content hash]`. E90 B01/L6 makes modes part of identity. D3 §2.4 already bounds per-tree and aggregate materialization, and D2 §3.7 requires API and cleanup responsiveness. D4's read deadline and “manifest's entry count” do not bound initial materialization or total retained disk use.

**Proposed replacement text:**

> The artifact manifest uses a declared canonical regular-file mode: 100644 for non-executable source files and 100755 for executable source files. Sealing removes write permission while preserving the executable class; the target reader reconstructs the same canonical class and separately verifies read-only presentation and immutable pathname identity. Ownership, umask and removed write bits do not change the canonical digest. A changed executable class does. The manifest is a complete sorted projection: extra and missing entries, links and special files are refused or differ, never silently omitted.
>
> Artifact preparation has finite declared limits on entries, per-artifact bytes, aggregate admitted/retained bytes and elapsed work. Admission preserves the engine's disk reserve before writing staging data. Exceeding a limit refuses before deployment, removes only unreferenced partial staging, and records the specific bound. Referenced artifacts are not evicted to admit a new one. Materialization and hashing yield within the existing API/tick responsiveness contract. The M4 acceptance seam fixes the numeric defaults and boundary values before implementation.

**Tests:** executable and non-executable files through sealing and target read; host umask variation; added and missing files; byte/entry/aggregate limits, cancellation and interrupted staging cleanup. These are contract tests, not a reason for another architecture round.

## 3. Non-blocking suggestions

### N01. Make observation ordering and acknowledged drift explicit

**D4 §§4.5, 6.2–6.3.** The condition clauses overlap: a down target with open drift fits both down and degraded; acknowledged drift must stay degraded although the listed condition tests only *open* drift. Observations read without a lease also need to reject stale comparisons rather than label an engine-owned replacement out of band. **Evidence — Observed this review:** D3 §5 X1 and E94 item 2 already distinguish unread facts from differences and require a stable registry generation.

**Replacement:**

> Each observation carries its read interval, expected-state revision and environment generation. A stale comparison is retried or retained as historical/unread, never installed as current drift. A read failure is unknown and never creates an out-of-band fact. Conditions use explicit precedence: unread required state → unknown; no environment application active and no unexpected active unit → down; unexpected active resources or unresolved/acknowledged drift → degraded; all expected application instances running with matching identity where read → healthy. The drift fact remains visible beside a down condition. Drift acknowledgment records an unresolved-until-replacement marker; it changes neither expected application identity nor verification eligibility. Re-verification cannot adopt a different instance of the same attempt.

Pin manual restart→acknowledge→read→reverify→authorized replacement, and delayed observation across replacement (D4-N02/N03). Redoing the authorized deployment is an acceptable Alpha recovery; no adopt pathway is needed.

### N02. Keep GETs as stored reads

**D4 §9.3 logs, A.8.** A GET logs route beside an adapter `logs` method could accidentally make a read perform collection and write a record. **Evidence — Observed this review:** D1 §11.3 and SEAM §91/M70 explicitly prohibit adapter calls and writes on reads.

**Replacement:**

> GET environment and logs routes return stored snapshots and existing screened records, with source timestamps. A command or bounded background collection job performs adapter reads and publishes new records. Reading a route never contacts the adapter or refreshes an observation's age. A missing collected log is reported missing/pending, not fetched implicitly.

### N03. Separate feasibility evidence, qualification and milestone tests

**D4 preamble, §§2.6, 9.6, 11.** The probe is useful, but “all four steps” exceeds its exact checks: the init was found by enumeration, not reported/authenticated during launch; the reported PID came through a scratch file, not an isolated control channel. Its parent was inner unshare 1269202, while MainPID was outer unshare 1269201. The script logs most failures rather than asserting them, so exit 0 is not the verdict for each property. The inspected log does show matching hashes, distinct identities, survival and removal. **Evidence — Recorded observation:** Probe `probe.sh`, `observe()` and launch section; `log.txt` 21:24:05.046–05.160 and 21:24:06.192–06.786; `summary.md` limitations. The summary reports an independent cleanup check whose commands/output are not in `log.txt`; label that as reported evidence.

**Replacement:**

> The stand-in probe establishes the recorded host observations only; it does not establish launch-time authentication, PID retention against reuse, init-channel isolation or real-profile recovery. Each class-B property names the qualification case or milestone test that will establish it. Qualification's receipt-loss case is not an engine-crash test. Real-launcher recovery, reconnect and incarnation-scope death require sandbox evidence; host/user-manager reboot behavior remains not claimed unless separately exercised. A case is passed only by explicit assertions and a working control, not the probe script's overall exit status.

Add the necessary cases to qualification where qualification claims them. Do not add a destructive manager-restart probe to this review or silently make it mandatory on Sean's workstation.

### N04. Align the schema and public limitations with the revised body

**D4 §3.1, A.3, Appendix B, §12.2 Q7.** Appendix B still represents `instance` as a string although §3.4 defines a tuple. Frozen attempt intents/round identities require fields after B03/B05. The artifact paragraph still says the mapping is “recorded on the artifact” after separating the cardinalities. Excluding `.surety/` alone does not exclude protected roots elsewhere. `keys.ts`'s CLI parser accepts only three backend references today, so deployment references extend the schema; arbitrary names are not already supported. **Evidence — Observed this review:** these declarations; `packages/engine/src/invoke/keys.ts`, `KEY_REFERENCES`/`parseRefValue()`; D3 §1.1 configurable roots.

**Replacement:**

> The adapter interface uses the application-instance tuple of §3.4 and the immutable attempt and verification bindings of §§4–5. Source mappings are separate records referenced by authority/evidence rows. Artifact exclusion is exactly the declared projection, not a general claim to remove all checks or private assets; a project with protected assets elsewhere must exclude them explicitly for Alpha. Deployment secret references have an explicit validated namespace, distinct from provider references. An enabled operator relay exposes the application to other local users and browser-originated traffic; it exposes no engine token or control endpoint. Its lifetime, generation binding, limits and closure are tested.

This does not implement Beta's export allowlist early; F §7 remains D5's boundary.

## 4. The nine proposed corrections

The accepted-row references below name `docs/acceptance/sdlc-M1-acceptance-plan-Astra.md`, `docs/acceptance/sdlc-M2-acceptance-plan.md`, and `docs/acceptance/sdlc-M3-acceptance-plan.md`. They are migration obligations, not permission for the Builder to edit tests. E92 item 2's precedent is Verifier changes recorded in COVERAGE, without a production compatibility escape.

| Correction | Judgment | Reason and accepted-contract impact |
|---|---|---|
| J1 | Accept with variant | Preserve operation intent and journal atomicity; freeze each attempt separately and make finalization create a durable round (B02–B03). Existing M26/M29–M34 remain valid for git; add deployment cases rather than making git use deployment outcome rules. The current `driver.ts` WAYS table is kind-specific, not a universal partial-retry policy. |
| J2 | Accept with variant | This changes today's kernel and real boundary: migration 0012 permits invocation XOR check ownership, and D2 recovery closes both. Add B01/B06/B07's service lifecycle and accounting; keep M112–M118 and M216 unchanged for role/check domains, and add mixed-owner recovery tests proving that only service domains survive. |
| J3 | Accept with variant | This changes today's public proposal API and idempotency behavior (`gates.ts`, SEAM §75). Repeated requests while the same operation is pending must coalesce; a deliberate request after terminal deployment creates a new generation. Preserve M44's single issuance and M74's seam confinement; route caller-supplied fixture bindings only through `src/testing/`, never an `if harness` bypass in production. |
| J4 | Accept with variant | This changes today's `alpha_authorize`: fixtures use adapter `none`, no real identity method and fixture checks. M01/M44, their shared gate fixtures and M140's real-lane project need explicit Verifier-owned setup changes; M3's authorization journey also needs completion obligations declared. Use labelled qualification facts at the seam while exercising the same gate rule; pin the old insufficient setup as refused. Include B04's pre-effect revalidation. |
| J5 | Accept | F §§3.4, 3.6 distinguish candidate history from environment history. A current verified deployment can update last_verified without advancing a superseded candidate; B05/J9 must still prevent an obsolete round/generation from overwriting it. M70's historical facts stay distinct. |
| J6 | Accept with variant | Add environment-scoped drift and exact ownership/dependency bindings for its decisions, with N01's persistent acknowledgment state. An acknowledgment neither adopts a deployment nor establishes termination; BS1 correction 2 stays intact. |
| J7 | Accept with variant | Require one durably bound round and original application identity, not two arbitrary matching snapshots (B01/B05). Preserve the class-C limitation about runtime-generated code and same-program re-exec; bracketing is not continuous execution attestation. |
| J8 | Accept with variant | A fixed-generation data relay is a legitimate alternative to widening the public proxy's private-address policy. Test that old tunnels close on generation termination, reconnect never retargets them, and the service cannot use the socket as a control endpoint (§8.1 below). M215's ordinary egress restrictions stay in force. |
| J9 | Accept with variant | This changes deployment generation/lease semantics reserved in D1 and adds new selection checks. B05/B06 supply same-attempt round ordering and bounded lease failure paths; preserve M206's registration ordering and M216's quarantine. M1 had no verification consumer to preserve, but M08's “deployment unsupported” case must be narrowed by the Verifier when M4 explicitly enables it. |

J2/J3/J4/J9 all change the kernel contract. M4 must not claim every accepted test remains literally unchanged: M08's milestone boundary necessarily moves; M01/M44/M140 and related fixtures need the new authorization prerequisites. Stage-only behavior, read purity, role/check termination and result honesty must not weaken. D4's production real-adapter path must be exercised outside harness mode; M74 confinement and M221(e)'s refusal principle apply to the new adapter/qualification fixtures too.

## 5. The ten open questions

These are recommendations to Sean, not recorded decisions. Source: D4 §12.2, with the linked mechanisms above.

| Question | Recommendation | Reason, cost or qualification |
|---|---|---|
| Q1 | (a), Alpha only | Proves F §3.7's real effect/verification loop before source publication and production recovery introduce different approvals. Keep D5 explicit. |
| Q2 | (a), local_service | The probe supports this target's feasibility, subject to B01 and actual-profile qualification. Persistent user units and ongoing memory reservations are real operational costs even with no cloud bill. |
| Q3 | (a), operator command | One explicit deployment request is appropriate for the first host effects. Idempotent retries of that request must not become a second deployment. |
| Q4 | (a), projection only | A dependency-free Node reference service can establish the journey without inventing a package/build system. State that common compiled or dependency-installing projects remain unsupported until build execution exists. |
| Q5 | (a), owner-written store versions | Keeps target/secret authority outside role-written source; source mapping still identifies exactly which candidate was projected. Make backup loss and orphaned-service recovery visible under B01. |
| Q6 | Proposed defaults, subject to measured qualification | 512 MiB, 128 tasks, 64 MiB writable, 4,096 inodes and 1 MiB logs are reasonable starting caps, not measurements of sufficient headroom. Sean owns the numbers; reserve check capacity and account for services across restart (B06). |
| Q7 | (a), explicit opt-in relay | Human Alpha feedback needs access. The unstated exposure is other local users and browser requests while open; no engine credentials may traverse it, and generation/closure/port-collision tests are required. |
| Q8 | (a), no rollback in M4 | For disposable, stateless Alpha, teardown and a new authorized deployment suffice. Do not call that a tested production recovery plan. |
| Q9 | (a), at most one automatic retry after proven absence | Accept only with B02/B03's stable absence and frozen attempt semantics. Partial effects still require the human's bounded continuation. |
| Q10 | (a), one final real journey | Closes the gap between fixture-authored and agent-authored deployment checks; rehearse the same journey without a model first. Under $1 is an estimate, not a cap or an authorization: a new token, possible qualification cost, shared subscription usage and Sean's explicit command remain required (E88/E92). |

No recommendation requires another backend, remote host, cloud bill or eBPF. Qualification/recovery testing takes unmeasured host time; “seconds” is not established for the complete suite by the two-second stand-in probe (D4 §§2.6, 9.4).

## 6. Brief conformance

Checked against Brief §3, not copied as an endorsement of D4 §12.3. “Gap” below identifies the missing part even when the question has substantial text.

| Brief question | D4 answer / gap |
|---|---|
| A1, calls and failure classes | §§2.1–2.3, Appendix B; align revised instance/attempt types (N04). |
| A2, reconciliation | §2.4; gap: complete inventory, residual resources and stable absence (B02/B03). |
| A3, qualification | §2.6; gap between class-B claims and actual qualification cases (B01, N03). |
| A4, placement and authority | §§2.5, 9.2; gap: persistent control authority on reconnect (B01). |
| O1, authorization to effect | §4.1; gap: complete current eligibility and attempt intent (B03/B04). |
| O2, crash behavior | §§4.2–4.3; gap: outstanding host effects and real persistent supervision (B01–B03). |
| O3, failure and recovery options | §§4.4, 4.6; open questions Q8/Q9; gap: verification-stuck exit path (B06). |
| O4, concurrency | §4.5/J9; gap: ordering within one attempt and observation races (B05/N01). |
| I1, artifact and mapping | §3.1; open Q4; mapping cardinality fixed; mode/bounds contract missing (B08). |
| I2, configuration | §§3.2–3.3; open Q5; rotation defined, surviving-secret screening missing (B07). |
| I3, target identity | §3.4; gap: durable original-process supervision, actual-profile qualification (B01). |
| V1, environment-bound checks | §§5.1–5.2; J8 explicitly changes proxy reach; relay cases in §8.1. |
| V2, completion | §§5.3, 5.5; gap: rounds, pending barrier and finite unknown (B05/B06). |
| V3, forbidden substitutes for verification | §5.4; RV6 correctly narrows check-quality claims. |
| N1, three facts and freshness | §§6.1–6.2; N01/N02 pin precedence and read purity. |
| N2, environment drift | §6.3/J6; gap: acknowledged drift state and complete inventory (N01/B02). |
| S1, storage and delivery | §§7.1–7.3; gap: old service secret after engine restart (B07). |
| S2, reach and revocation | §§7.4, 11; issuer revocation is distinguished from replacement, but rotation-pending visibility/screening needs B07. |
| R1, Release Operator form | §8.1; engine code is a supported recommendation requiring Sean's adoption. |
| R2, capabilities | §§2.2, 8.2; gap: exact attempt scope and recovery fencing (B01–B03). |
| T1, first safe real target | §§9.1–9.3, 9.5; open Q2; stand-in feasibility recorded, real qualification pending. |
| T2, cost and prerequisites | §§9.4–9.6; open Q6/Q10; complete-suite runtime is estimated, not measured. |
| SC1, Alpha versus Beta/Live | Open Q1, recommended Alpha-only M4. |
| X1, D3 reserved fields | §§5.1, 7.2, 10 X1; round binding and definition schema extensions must accompany J8. |
| X2, enduring effects | §10 X2; stateless, no-egress M4 limitation stated; rejection cases needed. |
| X3, release/candidate rows | §§5.5, 10 X3; Alpha only, no releases/publication; D4-V06 pins it. |

**The three declared departures:** J8 preserves the brief's least-reach purpose better than opening the general proxy to private networks; accept with the relay tests. J2 is necessary to prove recovery of a real surviving deployment, but D2 isolation, closure and accounting still apply; B01 is the missing persistent-lifecycle contract. Length is editorial: the files inspected are 114,199 bytes for D4 and 103,823 for D3. Tighten repetition in draft 2; length is not an architecture objection. Sources: Brief §§4–6; D4 §§9.2, 12.1; D2 §§2.4, 3.2–3.7.

## 7. Incident coverage

Source for every incident: CH §3.4; Switchboard: CH §5.1. All twenty are included to make the limits visible. A proposed mechanism is not a claim that M4 tests already pass.

| Incident | D4 prevention or gap |
|---|---|
| 1, tail-swallowed lint | §5.1 inherits D3 §2.6's own-process verdict; §5.4 correctly admits a badly written wrapper can still hide failure. Required negative behavioral mutant remains necessary. |
| 2, stub-proven enforcement | §§2.6, 9.6 require host evidence. **Gap:** kernel-only crash cases and stand-in feasibility cannot establish actual persistent-service isolation/recovery (B01/N03). |
| 3, unusable external contract hidden by tests | Qualification controls and unread/refused outcomes (§§2.3, 2.6) expose failed prerequisites. Real adapter outside harness and refusal controls must be exercised; no model required for that. |
| 4, contained model cannot perform git | §3.1 projects with engine git; §8 owns deployment effects. No role must escape its sandbox to deliver. |
| 5, contained model cannot reach external control plane | §§2.5, 8 move target control into engine code; §5.2 grants only application-data reach to checks. |
| 6, unknown equals zero / breaker deadlock | §§2.3, 5.3, 6.2 preserve unknown. **Gap:** verification can retain the environment lease indefinitely or starve its own check (B06). Existing ledger semantics are inherited, not retested by a deploy. |
| 7, uncontrolled lifetime/delegation | Release Operator uses no model (§8). **Gap:** persistent init/application lifecycle and resource accounting need B01/B06; finite service resource limits alone are insufficient. |
| 8, boolean CI / duplicated ambiguous write | §§2.3–2.4, 4.1–4.4 separate outcomes and consume once. **Gap:** incomplete reconcile predicates, unsettled host jobs and retry intent mismatch (B02/B03). |
| 9, unreachable equals empty / wrong target | Unknown reads and scoped capabilities (§§2.1–2.4) are correct. **Gap:** exact-intent-only enumeration can miss another generation; empty unit list omits residual resources (B02). |
| 10, approval reruns role or wrong head | §8 spends no model call on deploy approval; §4.1 binds exact mapping/configuration. B03/B04 pin repeated-request identity, preview consequences and current eligibility. |
| 11, unowned side effects/work drift | §8 gives deploy, verify registration and record writes one engine owner; finalizer must create one durable round (B03). |
| 12, delayed check registration parks healthy work | §§5.3–5.5 retain pending evidence. **Gap:** register the verification barrier before external reads and bound waiting (B05/B06); waiting never becomes a pass. |
| 13, trigger replay every tick | §4.2 uses trigger dedupe. B03/B05 additionally prevent finalizer replay or crash recovery from inventing extra rounds and resetting budgets. |
| 14, branch-bound ledger / stale fallback | D4 uses the runtime store and immutable source mapping (§§3–4), inheriting D1 §6 and the accepted ledger. No fallback to a repository file is introduced; B02 prevents analogous target-read fallback. |
| 15, intent output has no commit owner | §3.1 gives artifact creation to the engine and immutable mappings to the store; no role-written untracked deploy artifact is authority. B08 pins interrupted staging cleanup. |
| 16, unknown backend trusted by omission | Adapter qualification required before intent and authorization (§2.6/J4). Every mandatory case/control must pass; N03 prevents claiming properties absent from those cases. |
| 17, vacuous runner/skip as pass | §5.1 inherits D3 runner honesty; §5.3 treats missing/skipped as unknown. §5.4 admits check adequacy remains human/Verifier judgment. No mechanism alone excludes a vacuous exit-zero check. |
| 18, release truth drift | §§3.1, 4.5, 5.3, 6.1 bind mapping, generation and three facts. **Gap:** same-attempt late verification can replace current evidence without B05. Beta/Live release truth stays deferred (§10 X3). |
| 19, security rule hides an unexercised role | §8 explicitly reserves the role name without dispatch; qualification has `not_exercised` (§2.6). Report the actual recovery and relay coverage, not merely a green journey (N03). |
| 20, external calls stall indefinitely | §2.1 bounds calls. **Gap:** repeated bounded calls do not bound verification orchestration or manager-job quiescence (B02/B06). |
| Switchboard, CI and health green while live interface wrong | §§5.1–5.5 require a protected post-deploy behavioral check against the exact generation. Add a reference-service mutant whose identity and health endpoint remain correct while its specified user operation fails; alpha_complete must refuse. The existence of any check named `post_deploy_behavior` is not proof of this lesson (RV6). |

## 8. Test table, reconciliation and identity chain

### 8.1 Rows that can pass while their intended property is false

The following are finite additions/strengthenings for the M4 acceptance plan, not a request for another draft cycle. Kernel means real SQLite/git with scripted target facts; sandbox means the actual service/check profiles, no model. Service-manager cases below are **future tests**, not actions performed by this review.

| Existing row(s) | Insufficient positive result / required counterexample | Lane |
|---|---|---|
| A03/A04 | A table-driven mock can reproduce the table's own wrong answer. Supply prior unchanged plus unexpected active generation, unread inventory, and teardown with no units but residual resources (B02). | kernel + sandbox |
| A06/O03/T01 | All qualification cases can pass without a real engine crash, reconnect or restored admission accounting. Kill the engine at actual-profile placement/grant/started/verification barriers, retain the service, recover authority and reservations, and then finish or refuse honestly (B01/N03). | sandbox |
| O04 | Waiting until the refused unit disappears hides the interval in which it remains failed/inactive or a manager job is pending. Observe that interval; no absent/retry until closure and settled requests (B02). | sandbox |
| O05 | Merely checking “human said retry” misses missing g2 names and leftover g1. Exercise two attempts of one immutable operation and changed partial-retry previews (B03). | kernel + sandbox |
| O02 | Existing listed mutations omit new check registrations, protected tightening, blocking findings and stale approval evidence (B04). | kernel |
| O01/I04 | A single authorization claimed twice does not test two simultaneous deployment requests or a lost HTTP response. Require coalescing while pending and a deliberate new generation only after the earlier deployment is terminal. | kernel |
| V08 | Another deployment's generation guard does not order two verification rounds of one attempt. Reverse their callbacks and hold the latest request before t0 (B05). | kernel |
| V03/V04 | Two matching snapshots with different required versions, missing current output evidence or qualification lapsed midway must not verify. A snapshot comparison also does not establish continuous loaded-code identity (class C). | kernel + sandbox |
| O07/V04 | Short happy checks do not test resource admission starvation, superseded queued execution, unknown closure or a failed effect with no verification. Pin finite orchestration outcome and legal lease disposition (B06). | kernel; sandbox for closure |
| A09/S01/S03 | Each can pass separately while S0 leaks after S1 restart. Combine surviving service, old capture/new output, missing reconnect context and new check output (B07). | sandbox |
| I01/I02 | Byte equality alone misses mode canonicalization, extra paths and unbounded artifact staging/retention (B08). | kernel + filesystem/git; sandbox readback |
| I05/N02 | A healthy init is not a healthy application. Original app exits, descendant keeps the port, output closed; original identity remains terminal, no descendant rebound, no healthy projection (B01). | sandbox |
| V02 | Address refusal alone does not prove an already-open tunnel closes or avoids retargeting on teardown/redeploy. Keep one open across termination; bind connection records to execution, round, operation, attempt, generation and application instance. Service responses are untrusted input to the check; duplex replies do not grant a new reverse-connect/control capability. | sandbox |
| N02/N03 | A manual-restart decision alone misses acknowledged drift, stale reads and unread-versus-changed classification. Exercise N01's full sequence with successful-read controls. | kernel + sandbox |
| T03/T04 | A passing reference project misses Switchboard's lesson. Preserve artifact identity and healthy liveness while breaking a specified live interaction; the protected check and completion must fail. | project; no extra paid run |

**Properties with no adequate dedicated row yet:**

| Property | Acceptance obligation |
|---|---|
| Q7 operator relay | Closed by default; authenticated command; bind only configured loopback; refuse port collision without touching its owner; bounded tunnels; exact generation; explicit close and teardown/crash behavior; no engine token or control reach. Label local-user/browser exposure. |
| `POST …/verify` | B05: durable request barrier, same-attempt rounds, concurrent reruns, failure/cancellation history, protected change and recovery. |
| `identity_observation_every` | Status-only ticks versus every Nth identity read, restart persistence of cadence, source timestamps; status success never refreshes the age of an identity read not performed. |
| Artifact `too_large`/`too_many` | B08: limits, aggregate retention, staging cleanup and responsiveness. |
| Unsupported configuration | Refuse persistent storage, nonempty egress and target count other than one before intent; refuse missing runtime/artifact entrypoint rather than adopting host source. D4 §10 X2 and Appendix B govern. |
| Restart policy | B01: explicit no automatic restart; manual restart cannot obtain a second grant; it is drift/failure, never a recovered authorized instance. |
| Mutable identity metadata | A legitimate Node application changing its title/argv must be reported with the documented strict mismatch, not silently “fixed”; service requirements must say argv stability is required. Secret-bearing metadata is screened (B07). |
| Pure GET logs/environment | N02; exercise outside harness mode and count adapter calls/record writes. |
| Qualifications and fixtures | New scripted deployment/qualification routes unavailable outside harness, M74 lint intact, real adapter negative controls actually executed. |
| Restore/lost store and ownership | Same prefix with missing intent or changed cgroup identity is left untouched and listed. No blanket cleanup; recovered reservations and unsafe dispatch are handled as B01/B02 require. |

### 8.2 Concrete reconcile counterexamples

**Deploy absent versus conflicting:** frozen prior p is still exactly running; g has no unit or grant; unexpected generation x is active. The absent predicate is true, and so is conflicting. Appendix B's reads of “exactly” the intent's names need never find x. Correct outcome: conflicting after complete inventory, not an automatic retry. Source: D4 §2.4, Appendix B; B02.

**Deploy applied versus unknown/conflicting:** g's unit is active with a matching tree and a recorded historical grant, but its current InvocationID/application binding was not established for that grant (a restart is the obvious trigger). “Its launch authorized for this attempt” must mean this exact unit invocation and original application, not a name→attempt lookup. Unread binding is unknown; positively different binding is conflicting. The probe's restart demonstrates changed InvocationID, not authorized re-launch. Source: D4 §§2.4, 3.4, 9.2; Probe `log.txt` 21:24:06.622.

**Teardown applied versus partial:** no unit is loaded, but an owned link socket or runtime directory remains. The table says applied; the full effect did not complete. Correct outcome: partial, or unknown if existence cannot be read. Likewise an outstanding accepted create/stop job makes the apparent empty state insufficient to settle the effect. Source: D4 §§2.4, 4.6, 9.3; B02.

**Teardown absent versus conflicting:** all recorded units remain unchanged, and an extra prefixed unit exists. The absent and conflicting predicates overlap; conflicting must win. Merely enumerating known names makes this invisible. Source: D4 §2.4 and Appendix B.

**Late launcher:** an unauthorized unit that has run no application but is still loaded is not absent under the draft's own rule. Bounded settling/cleanup can turn it into positively absent. It is safe to keep uncertainty while waiting; prematurely raising a human partial-rollout decision for every ordinary refused start is avoidable operational noise, not justification to classify it absent early. Source: D4 §§2.4, 2.6, D4-O04.

### 8.3 Identity-chain assessment

**The ordinary orphan substitution suggested by the brief is not established.** If the init reports and durably retains application namespace PID 2, a forked child has a different PID. Reparenting changes PPid, not that PID. Parent=init plus same runtime/argv is insufficient, but §3.4 also requires the *reported namespace PID*, so the straightforward child cannot satisfy that conjunction. Do not weaken the chain by rediscovering any same-command child at t0. The gap is the unrecorded first-start/exit handshake and whether a later reconnect can replace the original binding; B01 makes it immutable and requires an exit/orphan test. This is reasoning from the specified predicate, not an executed exploit or proof of the full launcher.

**A matching read does not prove the port is served by that particular process.** The original application can remain alive while its descendant serves generated code. It can also load generated JavaScript in the original Node process. Both can coexist with the exact mounted artifact and runtime. D4 §§3.4, 11 class C already limit the claim appropriately: authorized entrypoint and artifact provenance, not continuous code provenance for every response. Keep that limitation; do not quietly turn the identity test into a claim of code attestation. Behavioral checks must test the required interface.

**Process identity must be stable across the multi-read operation.** Hold a stable process reference where available and validate PID/start identity before and after reading executable, arguments, mount identity and tree; a change or inconsistent snapshot is unread/different and never a mixture recorded as a match. Do the same for the init and unit invocation on recovery. An immutable recorded original binding prevents rebinding to a recycled PID; a fresh post-recovery enumeration alone does not. This is a precision obligation of B01/D4-I05, not a request for eBPF.

**False refusals are plausible but not quantified.** Process exit during a read, strict argv comparison against an application that changes its title, readable-program versus execute-only init distinctions, and a large tree exceeding the 10-second default are relevant. The stand-in used neither pivot_root nor the actual non-dumpable init (`packages/engine/src/invoke/domain-init.ts`, preamble). An unread fact stays unknown, never drift; N01 and finite B06 recovery prevent repeated timeouts from becoming either a false incident or an invisible stall. Qualification must show the actual dependency-free reference service completes the journey under admitted load. I found no evidence establishing a false-refusal rate high enough to reject this architecture.

**Same-uid host processes:** D2 §2.1 trusts the operator's own processes outside domains. The new socket must resist untrusted domain processes and other uids, not promise protection against a compromised operator account. Store loss or restored ownership mismatch may legitimately require an exact manual stop outside engine authority; that is acceptable for disposable Alpha if clearly reported, never auto-adopted and never “cleaned” by a prefix kill. Sources: D4 §§4.6, 9.5; D2 §§2.1, 8.

## 9. What I verified versus inferred

| Evidence label | What it covers |
|---|---|
| Observed this review | Read the review brief and owner's brief, D4 revised draft 1 including its 48 Appendix C statements, Probe summary/script/log, E88–E94, the requested D3/D2/D1 and BS1 correction sections, foundations sections, M3 lane/slice plan and M2 not-claimed material, CH incident register and Switchboard account. The review is anchored to this worktree's HEAD, not concurrent work on main. |
| Observed this review | Inspected the named migrations 0001/0003/0005/0006/0012 and relevant functions in `packages/engine/src/store/transitions/{gates,environments,baseline}.ts`, `src/journal/driver.ts`, `src/invoke/keys.ts`, and SEAM §§7, 75, 91. D4's claims about the existing caller-supplied authorization, same-binding dedupe, unbuilt completion gate, frozen journal inputs, fixture-only observation and reserved execution binding are supported. |
| Observed this review | Additionally inspected `src/store/transitions/protected.ts` finalization, `src/invoke/domain-init.ts` channel/start/exit paths and `src/records/redact.ts` in-memory secret handling. These support B01, B04 and B07. Deployment secret references extend the current closed backend-reference parser; the reconnecting service init is new work, not an existing primitive. |
| Recorded observation | Probe `log.txt` supports the specific service-manager and /proc observations summarized in N03. I read it; I did not repeat it. The earlier no-unit /proc probe is described in D4's preamble; its standalone script/raw log are not part of the supplied Probe directory. The independent post-cleanup check is reported by `summary.md`, beyond the cleanup-trap output actually included in `log.txt`. |
| Recorded observation | E88's accepted M2 results, E93/E94's slice results and `M2-not-claimed.md` are historical reports. I did not rerun their suites or treat them as evidence that the new service profile works. |
| Recommendation/inference | Reconciliation counterexamples, same-attempt round races, absent pre-effect dependencies, lease deadlocks, old-secret redaction failure, manifest-mode ambiguity and the proposed replacement contracts are derived from the inspected design/code. They are not claims of reproduced bugs in a D4 implementation. |
| Not verified | Actual service-profile launch/control recovery, isolation under the constructed root, surviving-domain admission, manager-job quiescence, new relay behavior, performance at declared limits, complete adapter qualification, or a real M4 journey. No model, paid call, build, repository test suite, Docker operation, remote-host action, scratch process probe or service-manager command was run for this review. |

As-built distinctions that matter: `gates.ts` still lists alpha_complete in UNBUILT_GATES; migration 0006 stores current observations but does not implement the proposed history/job writer; the journal's current outcome policy varies by git kind; and M3 is still being built at this checkout (E93/E94). These are expected milestone boundaries, not defects to repair as part of this review. D4 must describe additions as additions.

## Questions for Sean

1. **Adopt the J2 variant?** I recommend the bounded persistent-supervisor contract in B01, including no automatic application restart, authenticated reattachment, original-process identity and recovered resource reservations. It replaces the literal “ends only by teardown or later deploy” language while retaining service survival across an engine crash.
2. **Adopt the cross-restart secret policy in B07?** I recommend retaining each live domain's redaction context in its trusted init and recovering it only through authenticated control; if unavailable, withhold logs and links until safe replacement/teardown. Continuing publication with only the newly loaded secret set cannot uphold the existing secret guarantee.
3. **Decide J1–J9 and Q1–Q10 together with the variants in §§4–5.** In particular, record accepted-test migrations and the separate approval needed for Q7's host relay and Q10's paid run. A committed draft or this review does not supply those approvals.

No additional service-manager observation is needed to issue this conditional architecture verdict. The actual-launcher and recovery observations named above belong to the approved M4 qualification/acceptance work; this review requests no permission to create or act on another unit.
