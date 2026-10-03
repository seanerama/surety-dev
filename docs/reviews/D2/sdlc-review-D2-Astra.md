# D2 draft 1 cross-review — Astra

2026-10-03. Reviewed repository HEAD `c25ed5e773f65c596011c9a2b81d58cffc4b03bc`; the last commit changing D2 is `c24e702743cd7642937b00eee12034f7f1a6cd87`. This is the one cross-review requested under E48. Nothing here authorizes implementation, activation of a backend, or model expenditure. Contract details below become acceptance cases, not another prose-review cycle (E20, E31, E48).

Source abbreviations are path citations throughout this report:

- **D2:** [docs/design/sdlc-design-D2-backends-and-isolation.md](../../design/sdlc-design-D2-backends-and-isolation.md), draft 1.
- **Brief:** [docs/design/sdlc-design-D2-brief.md](../../design/sdlc-design-D2-brief.md).
- **D1:** [docs/design/sdlc-design-D1-engine-core.md](../../design/sdlc-design-D1-engine-core.md), with the corrections in **BS:** [docs/spec/M1-build-spec.md](../../spec/M1-build-spec.md).
- **E:** [docs/foundations/sdlc-foundations-v1.1-errata-draft.md](../../foundations/sdlc-foundations-v1.1-errata-draft.md), cited by entry and item. The review's decision baseline is E1–E48.
- **F:** [docs/foundations/sdlc-framework-foundations-v1.0.md](../../foundations/sdlc-framework-foundations-v1.0.md).
- **CH:** [docs/reviews/predecessors/sdlc-review-claude.md](../predecessors/sdlc-review-claude.md); incident numbers refer to §3.4.
- **AH:** [docs/reviews/predecessors/sdlc-review-Astra.md](../predecessors/sdlc-review-Astra.md).
- **M1 report:** [docs/acceptance/reports/M1-report.md](../../acceptance/reports/M1-report.md); **not-claimed:** [docs/acceptance/reports/M1-not-claimed.md](../../acceptance/reports/M1-not-claimed.md).

The review brief refers to the build corrections as BS §4; they are in the current BS §6. D2's preamble correctly references §6.

## 1. Verdict

**Approve with the amendments in section 2 applied.** The choice of namespaces plus a delegated cgroup is appropriate for this host, and the separation of adapter, launcher, boundary and engine is worth keeping. Draft 1 nevertheless overstates several guarantees: an empty cgroup does not fence a delayed launcher; read-only mounts can expose host authority; usage visibility does not establish a budget boundary; and qualification cannot currently bootstrap its own trust entry. There are also concrete regressions or omissions in delegation control, partial accounting, redaction before persistence, and resource containment. These are bounded amendments to this architecture, not reasons to redesign the kernel. Approval remains conditional on Sean's decisions in section 5 and on subsequent qualification through the real sandbox and real-backend lanes; M1's acceptance establishes neither (D2 §§1–4, 7; BS §8; M1 report §1).

## 2. Blocking objections

### B01. Empty is not closed: a launcher can enter after termination was recorded

**D2 §§3.2–3.4; K1; D2-B03–B07, B12.** The launcher starts outside the domain. Stop, a deadline, or recovery can see the domain empty while that launcher can still enter it. Recovery writes `cgroup.kill` to the old supervisor but does not require observing it empty before trusting domain absence. Removal *after* recording termination also leaves a live-engine window. This breaks BS §6 correction 1 and D1 §4.5: a run may be ended, its output collected or its snapshot admitted while a process still has authority to start a writer.

**Evidence — Observed this review.** In a scratch delegated scope on this host, I held a child in the supervisor, observed its destination `populated 0`, wrote `cgroup.kill`, observed `populated 0` again, then released the child. It successfully joined the destination, which became `populated 1`. This is a primitive reproduction, not an exploit against an implemented D2. The kernel defines population as current membership; killing members is not permanent closure to subsequent placement. [Linux 6.6 cgroup v2 documentation](https://www.kernel.org/doc/html/v6.6/admin-guide/cgroup-v2.html).

**Replacement text for §§3.2–3.4:**

> Domain termination requires both closure to future placement and observed emptiness. Before observing termination, the engine MUST revoke launch authorization and establish that every launcher which could enter the domain has exited or can no longer enter it. A placed launcher MUST obtain current authorization, bound to the domain, invocation, incarnation and lease generation, before starting any role process; an ending run never authorizes launch. An unplaced launcher is included in cancellation. `populated 0` by itself does not terminate an allocated domain with an outstanding launcher. Recovery MUST observe every prior supervisor leaf empty, or establish its absence in the verified hierarchy, before relying on domain absence. Failure to establish either closure or emptiness is `unknown` and quarantine. Once termination is recorded, no launcher may recreate or repopulate that domain. Tests pause dispatch before placement and before role launch, apply Stop and crash recovery, and prove that releasing either pause cannot start role code or change an admitted snapshot.

Keep the cgroup mechanism. An implementation may eliminate the placement window or explicitly fence it; a successful `cgroup.kill` return alone does neither. Bind recovery observations to the recorded home, incarnation and actual cgroup hierarchy. Manager unavailability remains `unknown`; a manager restart is not evidence that domains died (D2 §§3.3–3.4; [systemd delegation documentation](https://github.com/systemd/systemd/blob/main/docs/CGROUP_DELEGATION.md)).

### B02. The mount policy can reintroduce authority that the sandbox claims absent

**D2 §§1.3, 2.1–2.3, 2.8, 6 H8/H10, A.7.** `sandbox_read_paths` excludes the engine home and repositories, but not host socket directories, the operator's credentials, or other authority-bearing paths. A read-only bind does not turn a socket into read-only data. Whole `/etc` is also broader than the claim that every other secret is absent, and mounting a whole git directory with three overlays does not specify treatment of `config.worktree`, linked metadata, alternates or arbitrary extra files. The promised absence must constrain the *resolved mount contents*, aliases and inherited descriptors, not just the spelling of a configured path. Widening approval must not grant access to D1 §17.12's control plane.

**Evidence — Observed this review.** A scratch host Unix socket remained connectable through a read-only bind inside `unshare -Urnm`; it returned `host-socket-reached`. Thus a policy path exposing the user bus or another host service can bypass the network isolation. The temporary socket and mount namespace were cleaned up. This matches pathname-socket semantics; abstract-socket isolation does not cover pathname sockets. [Linux unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html). The permitted-path restriction and the stronger absence claims conflict by inspection (D2 §2.3 versus A.7).

**Replacement text for §§2.3/2.8 and A.7:**

> The sandbox exposes data and the explicitly granted egress socket, never host control endpoints. The mount plan MUST resolve sources and validate their contents, submounts and aliases before launch. `sandbox_read_paths` cannot expose the engine's control plane, other workspaces, the developer checkout, operator credential locations, host sockets, host device interfaces or WSL interop, even after policy-widening approval. Only the required, enumerated system configuration files are exposed from `/etc`. Git metadata is an engine-constructed view containing the objects, refs and per-run metadata required for read-only Git operations; credentials, local configuration variants, hooks and paths to other worktrees are not exposed. Host submounts are not inherited implicitly. `/dev/shm` is a new private mount. No host directory, socket, namespace or cgroup descriptor is inherited by the role; the init control channel is not accessible to role code through inheritance or `/proc`. The minimal trusted domain-init/helper code is distinguished from untrusted role processes. Qualification covers the effective mount profile, including permitted extra paths; a changed profile cannot reuse evidence for a weaker or different view.

The accepted ability to read repository objects and refs remains unchanged (F §3.10.8; D2 §8). This objection concerns authority outside that grant, not hiding code from its Builder.

### B03. Egress validation must bind the address actually connected

**D2 §2.4; D2-I07; P8.** Resolving and refusing a private address does not specify that the connect uses the validated address. A second resolution can differ; IPv4-mapped IPv6, mixed answer sets and host-owned addresses are unspecified. P8's `localhost:<engine port>` can be rejected merely because the port is not 443, without exercising address filtering. The current guarantee that a listed name can never lead back to the engine is therefore stronger than the contract (D1 §17.12; Brief I3).

**Evidence — Recommendation/inference from the specified algorithm.** D2 has no connect-time address binding; no implemented proxy was inspected or claimed vulnerable. The defect is the missing relationship between validation and effect, not an assertion that a provider currently returns malicious DNS.

**Replacement text for §2.4:**

> The proxy MUST parse and canonicalize a CONNECT authority before exact allow-list matching; only the specified HTTPS port is accepted. It resolves the name once for an attempt, validates every returned address under one IPv4/IPv6 policy, and connects only to a validated numeric address from that result, without a second name lookup. Loopback, private, link-local, unspecified, multicast, mapped equivalents and addresses belonging to the host are refused; an answer set containing a forbidden address is refused. Retries repeat the full resolution and validation. Resolution, connect, tunnel lifetime, concurrent tunnels and buffered bytes have finite limits. The probe-only private echo exception is bound to one test endpoint and is unavailable to role or qualification-canary traffic. Tests cover rebinding between resolve and connect, mixed answers, IPv6 and mapped forms, and private addresses on port 443, with a working permitted tunnel as control.

CONNECT allow-listing is a destination restriction, not content inspection or provider-request accounting. Authentication, telemetry or update dependencies that need additional hosts must fail visibly and be reviewed; they are not grounds for automatic allow-list expansion (D2 §§2.4, 4.1, 7.2, 8).

### B04. Qualification has no authorized first launch, and its cancellation trigger may occur after completion

**D2 §§1.2, 4.1, 7.2, A.3; D2-T01, T08–T11.** The engine ships no entries; every real launch requires an active entry; qualification's canaries are ordinary real runs; only those canaries create a proposed entry. The receipt's entry reference may be null only for the scripted harness. This is a bootstrap deadlock. The initial egress set also cannot be derived solely from connections a canary has not yet been permitted to make. Separately, cancelling after the first usage observation does not test in-flight cancellation on a backend that emits usage only in its terminal event—the mode §4.6 expressly anticipates. This recreates CH #6's interacting guardrails and AH §5.2's unexercised external contract.

**Replacement text for §§4.1/7.2 and the receipt binding in A.3:**

> Qualification uses a distinct, operator-authorized qualification attempt, not an ordinary project dispatch and not an active trust entry. The attempt binds the binary and help hashes, adapter template, model/authentication mode, active host qualification, engine-owned fixture, candidate egress allow-list, deadline and approved spend policy before any launch. Only the qualification transition can authorize its fixed canaries; this authority cannot dispatch project work or be selected by project policy. Qualification receipts bind the attempt and are charged through the ordinary ledger. Unknown egress destinations are refusals to review, never automatically allowed. A successful attempt creates a proposed trust entry whose evidence includes those bindings; only `trust_activation` can make it active. A replay or changed dependency requires a fresh authorization and cannot repeat paid work silently.
>
> The cancellation canary MUST establish an authenticated, still-running backend and cancel it at an independently observed work barrier before terminal completion, without depending on a usage event. A backend which finishes before the barrier, cannot authenticate or never reaches the barrier has not passed this canary. The test records the cause, observed exit, full-domain termination and partial usage. Every canary has its own finite deadline; a reported spend maximum is identified as a hard cap only where enforcement has been qualified.

This is a narrow qualification capability, not an exception allowing arbitrary unqualified real runs. It needs a new normative correction to D1 §17.11/§15.1 for Sean to approve explicitly (Brief §4).

### B05. Killing descendants does not prevent one-shot delegation failure

**D2 §§4.5–4.6, 7.2, 7.5; D2-T08/T10.** Cgroup ownership prevents descendants from escaping termination. It does not prevent a parent returning a successful result while delegated work is unfinished, or wasting the invocation waiting for a later turn. D2's Codex template does not disable delegation. Claude's capability check is conditional on whether the initial event lists tools; qualification has no mandatory fallback or refusal if it does not. These are the behaviors CH #7 and AH §5.9 require the adapter to address.

**Evidence — Observed this review.** Installed versions are Claude Code 2.1.288 and Codex CLI 0.159.2. `codex features list`, run with a fresh temporary `CODEX_HOME` outside the repository, reported `multi_agent stable true`. This verifies the current feature setting, not actual delegated execution. Claude's help distinguishes available tools from permission pre-approval and exposes an explicit deny option. No model was run.

**Replacement text for §§4.5–4.6/7.2:**

> M2's one-shot templates disable backend-native delegation, scheduling and background continuation. Codex's template includes `--disable multi_agent`; every other exposed delegation feature is explicitly disabled or demonstrated unavailable at the qualified version. Claude's template supplies the role's available-tool set and explicit denial of delegation/scheduling tools supported by that version. Qualification MUST establish that the effective headless tool surface cannot invoke those capabilities; absence of a tool inventory is not passing evidence and requires an executable capability test or refusal. A parent terminal-success event does not establish delegated-task completion. Enabling delegation later requires qualified completion, cancellation and aggregate-usage semantics, not merely cgroup membership.
>
> Each containment attempt is an engine-specified probe action with an independently checkable result. A liveness marker proves only that its write ran. Qualification MUST distinguish an attempted forbidden operation from a model's assertion, a fabricated transcript, a skipped tool and a failure to start. The known-denied action and its permitted control use resolved real targets. A backend that writes the marker and a plausible result without executing the probes fails qualification.

This removes a backend capability; it does not pretend to prevent arbitrary provider API calls by code holding the provider key. That residual capability belongs in the cost and credential limitations of §8.

### B06. Observing per-call usage does not establish a per-call spending boundary

**D2 §§1.5, 4.1–4.2, 5 C4, 8; D2-T05.** `enforceable_boundaries` is derived from `usage_boundary`. A usage event can arrive after the backend has started another request or several parallel requests. Receiving it gives the engine an opportunity to stop, not an admission boundary or a one-model-turn overshoot bound. D1 §13.3 expressly requires that distinction. With CONNECT tunneling and a role-held key, D2 also cannot independently account for arbitrary additional provider requests (D2 §§2.4–2.5).

**Evidence — internal contradiction, Recommendation/inference.** D2 §4.2 infers control from reporting frequency; D1 §13.3 requires a qualified bound or refusal. No live provider behavior is assumed in this objection.

**Replacement text for §§4.1–4.2:**

> Usage reporting granularity and enforceable budget boundaries are independent trust-entry properties. Per-model-call events establish reporting granularity only. `model_turn` is an enforceable boundary only where qualification establishes admission control or a specified maximum number of additional calls, including parallel and delegated calls, after exhaustion becomes observable. Otherwise the finest enforceable boundary is `invocation`, and a policy requiring a finer boundary is refused. Each enforceable boundary records its enforcement mechanism, evidence and overshoot limitation. A deadline limits elapsed execution, not a maximum number of tokens or dollars. Backend-reported usage is attributed evidence, not an independent meter of all traffic allowed by a role-held credential. A required hard spending maximum which this mechanism cannot enforce causes refusal; no confirmation labels an estimate as that maximum.

This accepts the coarse invocation mode as an explicit owner choice. It removes the unsupported promise of a finer one; it does not require a TLS-intercepting proxy for M2.

### B07. Cancelled runs must retain known usage

**D2 §1.5 and D2-A09.** Both require null token fields whenever the engine ends a run. Known observations before cancellation must survive; only the unknown remainder is unknown. Otherwise D2 discards evidence, reduces budget totals, and reverses an accepted kernel behavior (D1 §§13.1–13.3, D1-26; E37 item 3; CH #6/#14).

**Evidence — Implemented and Observed this review.** `packages/engine/src/store/transitions/ledger.ts`, `chargeInvocation()`, folds recorded observations into the original row and sets `usage_complete = false` for engine-ended outcomes without nulling the known normalized fields. Its source comment explicitly preserves what was observed. D2-A09 asks the Verifier to assert the opposite.

**Replacement text for §1.5 and D2-A09:**

> A run with no usage observations has null unknown token fields. A run ended before terminal usage retains all durably observed token and cost values and has `usage_complete = false`; no observed value becomes null solely because the engine ended the run. Usage semantics determine whether observations are cumulative or incremental, and replay never double-counts them. C4's unknown-usage charge is accounted for separately from retained known usage, exactly once per invocation, and a later correction reconciles it without deleting the original evidence. The cancellation test supplies known usage, then cancels before terminal usage, and asserts the known totals, the incomplete flag and the separate unknown allowance after restart and repeated finalization.

### B08. Redaction after collection leaves raw durable files before collection

**D2 §§1.4, 2.3, 2.5, 4.3; D2-I13/T06.** The result and private home are writable directories under the disk-backed engine home. A backend can write a held key there before the collector redacts it; an engine crash leaves those files behind. Excluding `auth.json` from the record and deleting the directory later do not establish that the secret was kept off disk. Nor does redirecting HOME prove that every provider-native file is written there: `/tmp`, output and workspace are also writable. This contradicts the stated protection, especially E37 item 2's raw/escaped-secret rule and D1 §14.2's before-disk redactor.

**Replacement text for §§2.3/2.5/4.3:**

> Provider credential files, the private backend home, temporary provider output and unvalidated result files MUST use bounded volatile storage excluded from swap or another explicitly qualified mechanism that prevents plaintext persistence. Only redacted, validated collection enters durable engine records. A crash before collection may lose volatile output; it MUST NOT leave a raw credential-bearing home or result file in the durable domain directory. Recovery records missing output as missing, never as a successful empty result. Collection admits regular files only, never follows links or opens special files, and applies byte, entry-count and time limits. Credential-bearing files are never retained. Qualification inventories every writable location available to the backend, not only HOME, and records observed persistence locations under the exact template and authentication mode.
>
> A role holding a key can deliberately copy or encode it into workspace content or send it to an allowed host. D2 does not claim prevention of arbitrary secret encoding. Before workspace content or collected output is admitted to durable evidence or Git, registered raw and escaped secret forms MUST be screened, and a hit refuses publication and raises the existing security finding. Any accepted plaintext scratch-storage exception requires Sean's explicit amendment to the existing before-disk rule, with its storage and crash-retention scope stated; post-run deletion is not such an amendment.

The last paragraph distinguishes a feasible registered-detector promise from an impossible promise that a key-holding program cannot encode the key. The architecture must name the actual persistence boundary instead of relying on a collector which runs too late. This does not move `$SURETY_HOME` onto a memory filesystem; E36 item 7 still applies to the durable engine home.

### B09. Memory and process limits do not protect the engine from unbounded disk and supervisor work

**D2 §§2.3–2.4, 3.7, 4.3; P20; D2-B11.** The statement that `memory.max` and `pids.max` prevent a role exhausting the host is false as written. Writable domain directories share the engine's storage; unlimited file creation can exhaust bytes or inodes. Per-domain maxima do not reserve capacity for the engine when several domains run. An unbounded stream or tunnel also consumes resources in the adapter/proxy outside the limited domain; a provider-file byte cap alone does not bound traversal of millions of empty files. These paths can prevent the engine from recording cancellation, preserving the ledger or finishing its tick (D1 §§6.6, 8.5, 13.3; CH #20).

**Replacement text for §3.7 and collection/egress limits:**

> The engine admits concurrent domains only within a host resource envelope that reserves capacity for supervision and the durable store. The qualified profile bounds process count, memory including the chosen swap policy, and writable bytes and inodes; a profile without enforceable writable-storage bounds is refused for real dispatch. The supervisor separately bounds per-domain output parsing, queued bytes, collection entries, egress connections and log growth, because that work is outside the domain's cgroup. Collection and cleanup have deadlines and cannot hold a scheduler tick indefinitely. Reaching a bound triggers cancellation and records incomplete or truncated evidence; it never fabricates complete output. Resource refusal and cancellation MUST remain observable while another domain reaches its limits. Qualification tests each resource independently and concurrent domains together; a process-count failure does not establish a memory or storage bound.

Do not claim protection against every activity by trusted host software. This requirement is to bound the engine's own untrusted workloads, within D2 §2.1's threat model. The kernel documents distinct memory, swap and process controls; none is a disk-capacity quota. [Linux 6.6 cgroup v2 documentation](https://www.kernel.org/doc/html/v6.6/admin-guide/cgroup-v2.html).

## 3. Non-blocking suggestions

These are test-level precision or narrower reporting improvements. They do not require reopening the mechanism choice.

### N01. A heartbeat read after expiry can have been sent before expiry

**D2 §3.5; K5; D2-B09/B10.** A buffered heartbeat read after the engine wakes proves neither fresh init responsiveness nor a live backend; domain membership may consist only of init and forwarder. Conversely, the first wake-up tick can run before a healthy channel callback. E36 item 6 requires preserving a healthy supervised run, not preserving every populated domain.

**Replacement text:**

> Pause recovery uses a bounded fresh challenge-response on the existing init channel, bound to the invocation and lease generation. A queued pre-pause heartbeat is insufficient. The response establishes that the init still supervises the backend and reports any already-observed backend exit. The engine allows the bounded response interval before deciding that the channel is silent, without dispatching replacement work. Re-grant never changes the invocation deadline, restores spent budget, or reverses an ending decision. A backend that remains alive but makes no progress is still bounded by its original deadline.

Pin queued-heartbeat, callback-ordering, dead-backend/live-init and expired-deadline cases beside B09/B10 (D1 §8.5; E36 item 6). “Alive” need not mean productive; a new progress detector is unnecessary.

### N02. Exit class and domain observation need separate, total tests

**D2 §§1.4, 1.6, 3.4; D2-A07/A08.** A process can hit `pids.max`, recover, then exit zero; it can also hit a resource counter before the engine kills it. Several predicates then match. `ExitClass.unknown` after a crash is also different from `DomainObservation.unknown`: the former forbids success, while only the latter prevents collection and ending.

**Replacement text:**

> Exit classification uses a tested precedence for overlapping observations and retains all contributing evidence. An engine cancellation keeps its initiating outcome even if a resource counter also rose. A resource counter increase is recorded whether or not it caused exit; tests state whether the selected policy treats that increase as a run failure. Missing exit evidence never becomes clean. Unknown domain termination forbids collection and finalization; known termination with an unknown backend exit permits redacted unaccepted-output collection and the existing failed/recovered outcome, never completion.

### N03. Current host qualification is not the historical row on an entry

**D2 §§4.1, 7.1, 7.3; A.3/A.4; D2-T04/H03.** Every successful start lapses the previous qualification row, while each trust entry points to the row at qualification. Implementing “active qualification” as a check of that historical row would permanently suspend every entry after the next start, contradicting §7.3. The intent is clear enough for a test rather than another architecture choice.

**Replacement text:**

> `trust_entries.host_qualification` is historical evidence. Dispatch requires a current active qualification for the same host and compatible mechanism/profile, not active status on the historical row. A compatible successful restart restores dispatch without a new paid canary; an incompatible mechanism or launch-profile change requires requalification. Trust-activation preview dependencies include the candidate entry, its full evidence/configuration fingerprint and current host eligibility. The evidence fingerprint includes template, tool capabilities, authentication mode and egress policy, not just transcript record identifiers.

### N04. Make canary diagnostics and qualified capability scope explicit

**D2 §§4.5–4.6, 7.2, 8; D2-T08–T11.** Omitting native schemas avoids the recorded `allOf` failure, but will not by itself prevent the old unhelpful error `"{"` or an unauthenticated lane. A passing one-shot test also says nothing about restoring provider files for session continuation (CH #3; D1 §15.2).

**Replacement text:**

> Canary failures preserve the redacted structured provider error and distinguish authentication failure, proxy refusal, unsupported flag, missing tool action, invalid result and cancellation failure. An unexpected contact is reported with its destination and refusal; it is not silently ignored or allowed. A trust entry records the exact tested template, model/authentication mode and capabilities. One-shot qualification never establishes session continuation. `D2-T07` establishes descendant termination only while sessions remain refused; it does not claim that an actual session reached `open_idle`.

### N05. Keep bootstrap's insecure opt-in out of a normal M2 run

**D2 §§2.1, 2.6, 8; K3; Q6.** Default-off is correct. With it enabled, another uid expressly classified as untrusted can mint the operator token. This is an accepted exposure only if Sean chooses that threat-model exception; the switch is not qualified local-user isolation (E44 item 1).

**Replacement text:**

> M2's qualified production configuration leaves `ui_bootstrap` false. Legacy bootstrap-enabled behavior is available only in explicitly labelled compatibility tests unless the owner separately accepts its local-user impersonation exposure. An engine read and the qualification report state when that exception is in force; they do not claim protection from other local uids. The future UI authentication decision is Q6.

## 4. The nine proposed corrections to D1

| Correction | Judgment | Reason |
|---|---|---|
| K1 | **Accept with a variant.** | Placement before `launched` is necessary but insufficient. Add closure to future placement before termination and a current launch authorization (B01; D2 §§1.1, 3.2–3.4). |
| K2 | **Accept.** | A delegated scope before lock acquisition and visible unqualified startup are appropriate. Recovery must stay conservative when the manager is unavailable; cleanup of an unsuccessful duplicate start must touch only its own scope (D2 §§3.1, 3.4, 7.1; D2-B08/H02). |
| K3 | **Accept.** | Default-off is the right M2 behavior. Change the accepted M1 bootstrap-test setup to opt in explicitly, preserve its existing header/token assertions, and add a default-off case; M2 has no UI requiring this route (D2 §2.6; E39 item 1; N05). |
| K4 | **Accept with a variant.** | A file result after proven termination with clean-exit agreement is sound. Include B01's launch fence, B08's raw-storage rule and N02's distinction between unknown exit and unknown domain termination (D2 §§1.4, 1.6). |
| K5 | **Accept with a variant.** | Preserve E36 item 6 with fresh supervision evidence and unchanged invocation deadline, not merely the time a buffered heartbeat was read (D2 §3.5; N01). |
| K6 | **Accept with a variant.** | Adopt explicit boundary refusal and C4's conservative accounting, but separate reporting from enforcement, preserve partial usage and label estimates honestly (D2 §4.2; B06/B07). |
| K7 | **Accept.** | Human approval for every lowering from Critical is a defensible stricter rule for a real agent. It is a proposed policy change, not a necessary reading of F §6.3: High still blocks without a separate human exception (D2 C2a; E41/E48). |
| K8 | **Accept.** | Bind classification to the current protected baseline and re-check at effect time; until D3 qualifies the classifier, the real Reviewer recommends and the human approves (D2 C2b; D1 §10.5). |
| K9 | **Accept with a variant.** | Namespaces and cgroups can realize the boundary on this host without a dedicated account. Acceptance is conditional on B01–B03 and actual profile qualification; same uid makes accidental visibility particularly consequential (D2 §§2.1–2.3, 3). |

## 5. The seven open questions and four carried decisions

All eleven remain Sean's decisions. These recommendations do not consume an approval or authorize a canary.

| Question | Recommendation and reason |
|---|---|
| Q1 — authentication | **Dedicated API keys.** They keep the engine's authorization separate from an operator subscription and make revocation and provider-side limits clearer. Qualify the actual key-delivery path; do not assume Codex `exec` consumes an environment variable because its name occurs in the binary (D2 §§2.5, 4.5–4.6). |
| Q2 — role-held credential | **Accept for M2 with an explicit limitation.** A key-holding role can make extra calls to an allowed provider, so backend usage cannot be claimed as a complete independent spend meter; use a provider-enforced cap if a hard maximum is required. Defer credential injection until its transport and accounting are qualified (D2 §§2.4–2.5, 8; B06). |
| Q3 — WSL2 | **Eligible to qualify, not qualified by this review.** Linux primitives worked in the limited probes, but the complete sandbox, valid Windows-executable denial, host mounts and recovery still need executable evidence (D2 H1–H10; §8 below). |
| Q4 — filters/LFS/partial clones | **Keep unsupported in M2.** Isolating roles does not contain engine Git's driver execution or lazy network fetches; retain E29 item 1 and E37 items 1/5 until a separate governed execution path exists (D2 §2.7). |
| Q5 — Codex inner sandbox | **Disable it for the externally sandboxed qualified template.** The outer sandbox must carry the guarantee independently; nested-sandbox behavior can be qualified later without making its flags part of today's proof (D2 §4.6; AH §5.2). |
| Q6 — future UI bootstrap | **Defer implementation; prefer a one-time CLI-delivered code when the UI is designed.** `/proc/net/tcp` attribution alone requires a race-resistant connection-ownership protocol which D2 does not supply. Neither option is necessary for default-off M2 (D2 §2.6; N05). |
| Q7 — paid qualification | **Explicit operator command and approval, without automatic spending.** Bind the approval to B04's exact attempt and show the enforceable cap or clearly labelled estimate/overshoot limitation. A binary change may offer qualification but must not run it (D2 §7.2; B06). |
| C1 — Alpha exception | **Accept the existing finding-disposition flow.** A real Reviewer's argument is `claimed` evidence; the human must see immutable, candidate-bound evidence and the unchanged failed-check reasons. Resolve workspace references into retained snapshots/records before approval rather than pointing at mutable or deleted scratch paths (D2 C1; E36 item 5; D1 §§9.3, 10.5, 14.3). |
| C2 — Reviewer powers | **Accept both proposed restrictions, with K7's rationale corrected as above.** Critical downgrades deserve explicit human review, and an old tightening classification cannot authorize a different current change. Neither approval may turn a non-passed check into a pass (D2 C2; D1 §§9.3–9.4, 10.5). |
| C3 — withdraw token access | **Accept, without an unsandboxed production escape hatch.** Keep the existing harness lane labelled as kernel evidence and test the scripted backend through the real boundary for every production isolation claim (D2 C3; BS §8; E25 item 2). |
| C4 — estimated and unknown cost | **Count estimates, displayed separately from reported dollars, and charge the unknown allowance once.** Retain known partial usage, define reconciliation and concurrent reservations in tests, and do not call the estimated component verified expenditure (D2 C4; B06/B07; D1 §§13.1–13.3). |

## 6. Brief conformance

This checks the 26 questions in Brief §3. A section reference means the design answers the question, not that the answer has passed qualification. “Gap” identifies the missing part of that answer.

| Brief question | D2 answer or gap |
|---|---|
| A1 — invocation data | §§1.1–1.2, 4.5–4.6. Argument arrays, fixed prompt, scoped context, constructed environment and cwd specified. Qualification launch authority is a gap, B04. |
| A2 — result/undelivered output | §§1.4, 1.6. File plus terminal-event agreement; gap in stable termination and raw persistence, B01/B08. |
| A3 — usage | §§1.5, 4.2. Gap: known partial tokens are nulled, and reporting is confused with enforcement, B06/B07. |
| A4 — cancellation/exit | §§1.6, 3.2, 3.6. Gap in pre-placement cancellation, B01; precedence and overlapping evidence are N02. |
| A5 — scoped context and visibility | §§1.3, 2.3. Context answered; visibility gap through effective mounts/authority, B02. |
| A6 — Resume/session id | §§1.7–1.8. Fresh invocation by construction; Claude preassigned id, Codex observed id pending canary. |
| I1 — host mechanism | §§2.1–2.2, 6. Open question Q3; mechanism acceptable subject to B01–B03 and qualification. |
| I2 — filesystem view | §2.3. Gap: allowed extra paths, inherited authority, metadata view and raw writable storage, B02/B08. |
| I3 — network | §2.4. Gap: connect-time address binding, B03. Endpoint dependencies remain qualification evidence. |
| I4 — secrets | §§1.2, 2.5, 4.3. Open questions Q1/Q2; gap in before-persistence protection, B08. |
| I5 — bootstrap/threat model | §§2.1, 2.6, 8. Default-off answered by K3; future mechanism is Q6; insecure opt-in must be labelled, N05. |
| I6 — Git configuration/drivers | §§2.3, 2.7. Unsupported status retained, Q4; immutable metadata-view proof needs B02 and corrected P4/P5. |
| I7 — host qualification | §§2.8, 6, 7.1. Gap: profile-specific authority and non-vacuous probes, B02 and §8 below. |
| B1 — boundary lifecycle | §§3.1–3.3. Gap: closure to late placement and supervisor emptiness, B01. |
| B2 — unknown | §3.4. Conservative conditions specified; B01 must also govern later quarantine release. |
| B3 — pause | §3.5. Test precision needed for fresh supervision and unchanged deadlines, N01. |
| B4 — grace/cost | §§1.6, 3.6. Defaults stated; cancellation canary must cancel a live invocation, B04. |
| T1 — trust fields/authority | §§4.1, 7.2–7.3, A.3/A.7. Gap in first qualification authority, B04; historical/current qualification distinction, N03. |
| T2 — two backends | §§4.5–4.6 openly list unknowns. Current Codex delegation default verified here; qualification must disable/verify it, B05. |
| T3 — budget enforceability | §4.2. Gap: observation frequency is not enforcement, B06. |
| T4 — provider-native files | §§1.8, 4.3. Gap in durable raw files, other writable locations and bounded collection, B08/B09. |
| T5 — quiescence/session continuation | §§1.8, 4.4. Session mode refused, correctly. Construction argument depends on B01 and establishes no continuation evidence. |
| C1 — human Alpha exception | §5 C1; decision for Sean, recommendation above. Snapshot mutable evidence before decision consumption. |
| C2 — Reviewer powers | §5 C2, K7/K8; decision for Sean. Both proposed restrictions recommended. |
| C3 — role token access | §5 C3, §2.8; withdrawal specified, conditional on actual isolation proof. |
| C4 — estimated daily cost | §5 C4, K6; decision for Sean. Recommendation above with B06/B07. |

## 7. Incident coverage

All CH §3.4 rows are included to distinguish a D2 gap from a concern already owned by the kernel or deferred to D3. “Designed” is not “qualified.” The two additional AH rows are the requested enforcement and delegation findings.

| Incident | Mechanism, residual gap and scope |
|---|---|
| CH 1 — swallowed checker exit | **D3, not a D2 prevention claim.** D2 §3.8 supplies a boundary; D1 §9.2 still requires runner-established execution and exit. A backend's terminal success is not a check pass. |
| CH 2 — ignored Codex policy / 567 green stubs / inherited credentials | **Gap until qualified.** D2 §§1.2, 2.2–2.8 replace self-enforcement with OS isolation and a constructed environment. B02/B03 close authority paths; corrected probes and B05's executable attempts are required to avoid another vacuous qualification. |
| CH 3 — schema rejection / unauthenticated lane / truncated error | **Partial.** D2 §1.4 removes the native schema channel and §7.2 fails unauthenticated qualification. B04 must make qualification reachable; N04 must preserve structured errors. These are not yet real-binary observations. |
| CH 4 — contained agent could not branch/commit | **Designed.** D2 §§1.3, 2.3 preserve engine-owned Git and read-only role Git; D1 §7 owns commits. Correct P4/P5 and test a linked-worktree `git status`/diff/read against the actual metadata view. |
| CH 5 — contained role could not read/write GitHub | **Designed, external effects deferred.** D2 §1.3 supplies state and §2.4 refuses ungranted network; D1 §§7/10 keep effects with the engine. Do not call an agent's failed external side effect a completed task. |
| CH 6 — unknown cost became zero / breaker deadlock | **Gap.** D2 §1.5/C4 propose honest unknowns and estimates, but B07 otherwise erases known partial usage; B06 overstates boundaries; B04's trust bootstrap deadlocks before a first run. Test refusal without consuming approval and explicit qualification admission. |
| CH 7 — role/lifetime confusion, background delegation, 465k tokens | **Gap.** D2 §§3.1, 4.4 contain descendants, but do not prevent an unfinished delegated workflow being reported complete. B05 must disable and verify one-shot delegation; B06 limits the budget claim. Killing abandoned children is not completion. |
| CH 8 — unknown CI treated as red / duplicated write | **Kernel/D3 and later effects.** D1 §§7.5, 9.2, 10.5 distinguish evidence and journal effects. D2 unknown exit/domain states must retain that separation (N02); it adds no GitHub/CI adapter. |
| CH 9 — unreachable or wrong-repo read became confident empty state | **Partial, mostly kernel/later adapters.** D2 §§1.3, 1.6 supply scoped context and refuse missing terminal success; they do not verify a model's factual claims. Protected execution and external-state observations remain D1 §9.2/D3 responsibilities. |
| CH 10 — approval re-bought the role / trust-zero deadlock | **Inherited kernel protection.** D1 §10.5 consumes a bound result/intent rather than rerunning it. Apply the same rule to paid qualification and trust activation (B04; D2 §4.1); an activation answer must not launch another canary. |
| CH 11 — contained plan could not create issues | **Engine-owned effects; not yet an external integration.** D2 §1.3 gives scoped inputs and §1.4 gives structured outputs; D1 §7 owns their adoption. Network isolation does not itself reconcile proposed work into durable engine work. |
| CH 12 — CI registration delay/skew parked healthy work | **D3/later external checks.** No D2 CI polling contract. D2 §3.5 addresses a different clock problem, supervised lease expiry; N01 must not end healthy runs merely because callbacks arrive after the wake-up tick. |
| CH 13 — plan re-ran every tick | **Inherited scheduler responsibility.** D1 §8 and the accepted M1 journey own work deduplication and completion. D2 qualification must be explicit and replay-safe; host checks must not automatically become paid canaries (D2 §§7.1–7.3; Q7/B04). |
| CH 14 — branch-bound ledger / fail-open errors | **Store architecture retained, accounting gap.** D1 §13/BS §6 and M1 report establish the branch-independent kernel ledger. D2 uses it, but B07 must preserve observations and B09 must protect the ability to record them under resource pressure. |
| CH 15 — intent artifacts had no commit path | **Inherited engine Git.** D1 §7 and D2 §§1.3–1.4 retain the input/output ownership boundary. Every accepted result still needs the kernel's existing validation/commit path; a file existing in `/surety/out` alone is not adoption. |
| CH 16 — new provider trusted by omission | **Designed default refusal.** D2 §§4.1, 7.3 ship no active entries and revoke changed identities. B04's narrow qualification capability must never become an ordinary-dispatch bypass; N03 pins eligibility after restart. |
| CH 17 — vacuous asynchronous tests / skips counted as passes | **Gap in D2's stated evidence.** Three lanes and positive controls are right (Appendix B), but P4/P5/P11 and the containment marker can give no relevant denial evidence. Section 8 below specifies corrected controls; a skipped/inapplicable case is never a passed tested property. |
| CH 18 — release truth drift | **Outside D2.** D2 §8 and Brief §4 exclude publication/promotion. No prevention credit assigned here. |
| CH 19 — canary never exercised intended role | **Partial.** D2 §7.2 requires authentication and a command, but a marker alone is not evidence that every required action ran. B04/B05 require a live cancellation barrier and independently witnessed attempts. |
| CH 20 — 110-minute external-call stall | **Partial.** D2 §§1.6, 3.2, 3.4 bound role lifetime and quarantine uncertain termination. B01 prevents a late launcher bypass; B03/B09 and N01 bound proxy/collection/supervision work outside the role and preserve the original deadline. |
| AH §5.2 — external Codex contract imagined by stubs | **Gap until corrected qualification runs.** Real sandbox tests establish OS enforcement; paid canaries establish the exact headless/auth/tool path. Neither substitutes for the other (D2 §7.2/Appendix B; B02–B05). |
| AH §5.9 — headless delegation outlived parent | **Gap in the proposed template.** The local feature listing confirms Codex delegation remains enabled by default; B05 must disable and verify it. D2 §4.4's eventual daemon death is only one part of the required property. |

D2 §7.5 additionally cites CH §3.7 F-D and §4.3. A private `CODEX_HOME` protects the operator's normal configuration only if the mount/descriptor rules hold; it does not prove no raw provider files reached disk (B02/B08). Default-off bootstrap protects the token route in the production default; enabling it reintroduces the explicitly identified other-uid exposure (D2 §2.6; N05).

## 8. Isolation probes and the 59 contract statements

### 8.1 The twenty probes

All references in this table are to D2 Appendix A.6, with the corresponding §2/§3 property. “Control” must establish that the intended operation and target were usable before the isolation restriction was applied, not merely that some unrelated operation succeeded. Tests can share fixtures; this is not a request for one new file per row (E31).

| Probe | False green, limitation, or required strengthening |
|---|---|
| P1 | A missing host token would make ENOENT meaningless. Create a known sentinel at the actual token path, establish host readability, then deny the role both its host path and plausible aliases; the context read proves only sandbox liveness (D2 §2.3; B02). |
| P2 | Seed each actual target. Listing the workspace proves none of the engine-home targets existed or were attempted; also inspect aliases and inherited descriptors (B02). |
| P3 | Use distinct populated workspaces/checkouts and assert the permitted workspace's identity. An empty fixture or wrong target could pass both sides (D2 §1.3/§2.3). |
| P4 | **Broken as literal worktree paths.** `.git` is a file, so `.git/config` returns ENOTDIR even without isolation. Resolve common/worktree Git paths and test the effective config, including `git config` mutation; require the engine's known config contents on the positive read. Scratch reproduction in §9 (B02). |
| P5 | Same `.git` issue; the literal positive `list .git/hooks` also fails, making the stated probe fail qualification on a correct linked worktree. Resolve the actual hooks path and prove host-side that the fixture permits creation without the sandbox; assert the sandbox's engine-owned empty hooks view (B02). |
| P6 | Good narrow loopback test if the actual listener is independently verified alive. Add `::1` and reachable host-address variants through the proxy; connecting the forwarder does not prove host listener health (D2 §2.4; B03). |
| P7 | Repeats P6's connection denial; useful as a route-specific assertion, not proof of bootstrap-header handling. Keep the separate kernel default-off and opt-in header tests (K3/N05). |
| P8 | `localhost:<engine port>` may fail only the port rule. Test private destinations at 443, mixed answers, IPv6/mapped addresses, rebinding, and a permitted real role-profile tunnel; the probe's exceptional private echo route must not leak to other profiles (B03). |
| P9 | Sound narrow test when both listeners really exist. It says nothing about a pathname socket exposed by a mount; add the B02 host-socket fixture. |
| P10 | Missing host paths produce a vacuous denial; `/dev/null` is no control for their existence. Seed harmless stand-ins or verify actual endpoint existence without invoking it, and test canonical/alternate paths and `/dev/shm` isolation (B02). |
| P11 | **Invalid executable trap.** Two `MZ` bytes do not make a valid Windows program; failure can occur with working interop. Use a known-valid harmless PE image which executes in the authorized host control, or equivalent direct proof of interpreter/handler non-reachability with an executable control. `/bin/true` alone proves neither (D2 H10). |
| P12 | Testing two conventional paths does not prove *every* DrvFs/9p mount absent. Inspect the resulting mount table and aliases/submounts, including any exposed by `/usr` or extra paths; classify unsupported host conditions explicitly (D2 §2.3/H10; B02). |
| P13 | An engine host PID may name an unrelated sandbox-local process, so ESRCH is not a universal expected result. Independently establish that the host sentinel survives; inspect the PID view and test signal/proc access separately. Add init control-channel/proc-fd protection (B02). |
| P14 | Zero effective capabilities and NNP describe this process now; they do not demonstrate absence of inherited descriptors, inaccessible parent namespace authority, or every prohibited operation. Inspect the actual role process after exec and test the forbidden operations; do not claim that new user namespaces must be impossible (B02). |
| P15 | Writing a nonexistent path fails without proving migration denial. Supply the verified real domain/sibling targets in a controlled probe and distinguish not-mounted from a genuine attempted migration. A correct namespace display alone is not a positive migration control (D2 §3.1). |
| P16 | Good membership adversary, but “the listing itself” is circular as the only liveness witness. A descendant signals a barrier after setsid/env clearing/double fork; independently witness membership before kill and inability to write afterward. Include B01's later-arriving launcher separately. |
| P17 | Missing `systemd-run`, a bad command or an absent host user manager all fail. Verify the harmless command works in the authorized host control, then show denial through unavailable host authority in the sandbox; `/bin/true` is insufficient (D2 §2.1/§2.3). |
| P18 | Invalid JSON after accidentally reading the token could still pass a result-validity assertion. Test that no target read occurs, plus FIFO/device/oversize cases with bounded completion. A normal file in another run is a useful acceptance control (D2 §1.4; B08/B09). |
| P19 | Pin every effective protected root and non-Verifier role, including replacement/rename and writable aliases; a single failed write does not establish an immutable subtree. For Verifier, assert proposal-only adoption through engine Git (D2 §2.3; D1 §7.3). |
| P20 | Fork and allocation must be separate, safely capped tests; a PID limit can prevent the allocation test from running. A `pids.events.max` increment alone need not kill the backend. Add aggregate admission, storage and supervisor-output limits, and use host controls that never exhaust the real host (B09; N02). |

### 8.2 Every Appendix B statement

The table accounts for all 59 statements: 12 A, 15 I, 12 B, 11 T, 3 H and 6 C. “Keep” means suitable as a contract subject with the specified controls, not that a test exists or passed.

| Test | Review of the required assertion |
|---|---|
| D2-A01 | Keep. Supply option-shaped hostile task content and verify it remains in the context; inspect executed argv, not the renderer alone (§1.2). |
| D2-A02 | Keep. Seed parent-only sentinel credentials and inspect the actual child environment, including init/forwarder separation (§§1.2, 2.5). |
| D2-A03 | Keep. Assert exact bound context and exclusion/read-only behavior using populated fixtures (§1.3). |
| D2-A04 | Keep. Verify mismatch prevents real launch and charging, while preserving the refusal/receipt evidence (§1.2; D1 §13.1). |
| D2-A05 | Strengthen with B01: termination cannot be observed while a launcher can still enter. Include a surviving writer after backend exit and an unplaced writer precursor. |
| D2-A06 | Keep with a no-read witness and deadline for FIFO/device cases, not merely invalid-result output (P18; B08/B09). |
| D2-A07 | Keep; separate clean exit, ending cause, unknown exit and unknown domain state, and forbid collection during the latter (N02). |
| D2-A08 | Specify precedence for overlapping evidence and resource events without death; six isolated examples alone miss ambiguity (N02). |
| D2-A09 | **Replace.** Preserve known partial usage; null only unknown quantities (B07). |
| D2-A10 | Keep. New receipt/domain/context and no native resume; prove old unaccepted output cannot become current success (§1.7). |
| D2-A11 | Keep. Refuse real session dispatch even if a one-shot entry is active; no silent fallback (§1.8). |
| D2-A12 | Keep. Validate the derived UUID and receipt binding before actual launch, including crash/retry (§1.7). |
| D2-I01 | Strengthen P1 as above; known existing token and aliases (B02). |
| D2-I02 | Strengthen P2; known store/record targets, mount and descriptor authority (B02). |
| D2-I03 | Strengthen P3; distinct populated workspaces and developer checkout (B02). |
| D2-I04 | Correct P4/P5 to resolved Git metadata, then test mutation through Git as well as file access (B02). |
| D2-I05 | Keep the loopback case; add IPv6/host variants as applicable and independent listener health (B03). |
| D2-I06 | Keep as sandbox reachability evidence only; no extra claim about same-origin authentication (K3). |
| D2-I07 | Add numeric-address binding, mixed DNS, retry and bounded proxy behavior; non-probe profiles cannot inherit the echo exemption (B03). |
| D2-I08 | Add pathname sockets through read-only extra paths and a real host control; abstract sockets alone are insufficient (B02). |
| D2-I09 | Correct valid-executable and full mount-view controls; two path checks and an invalid MZ file cannot qualify WSL isolation (P11/P12). |
| D2-I10 | Use host witnesses and the actual role process; no assumption that a host PID is unused in the child namespace (P13/P14). |
| D2-I11 | Keep; add rename/alias cases and prove Verifier changes remain proposals until the protected-version path approves them (P19). |
| D2-I12 | Keep. Route refusal must precede token read; preserve opt-in legacy assertions in explicitly labelled setup (K3/N05). |
| D2-I13 | **Incomplete.** Absence from final records/deletion misses plaintext before collection and after crash. Add storage-boundary and other-writable-location tests (B08). |
| D2-I14 | Keep but add a successful unrelated control paired with a never-attempted negative: this too must fail qualification (B05). |
| D2-I15 | Keep widening-decision behavior; approved widening must still be refused if it exposes forbidden authority (B02). |
| D2-B01 | Add independent descendant barrier and post-kill write witness; membership listing alone is not a control (P16). |
| D2-B02 | Test a real reachable cgroup migration target; absence is a separate isolation property (P15). |
| D2-B03 | **Incomplete.** Placement order alone misses a launcher released after cancellation. Add closure and late-authorization refusal (B01). |
| D2-B04 | Keep TERM/KILL sequencing; assert closure, emptiness and bounded unknown instead of trusting kill's return (B01). |
| D2-B05 | Assert verified hierarchy and closed prior launchers before absence counts. Add user-manager interruption/recovery, not just an engine kill (B01). |
| D2-B06 | Observe prior supervisor empty, then release the delayed-launch barrier and prove no role code can run (B01). |
| D2-B07 | Apply the same closure prerequisites on every quarantine-release tick; absence caused by an unreadable/replaced hierarchy is not termination (B01). |
| D2-B08 | Keep, including similarly named scopes, concurrent startup and failed duplicate-lock startup. Inspect effects on the second engine, not only logs (§3.3). |
| D2-B09 | Add fresh challenge, delayed callback and unchanged deadline; queued heartbeat alone must not pass (N01). |
| D2-B10 | Add live init with exited backend, stale buffered heartbeat and already-exhausted deadline/budget (N01). |
| D2-B11 | Separate each limit and add storage, aggregate and supervisor-pressure cases; one fork failure proves none of those (B09). |
| D2-B12 | Assert removal cannot race an outstanding launcher and no later recreation is possible (B01). |
| D2-T01 | Keep ordinary-dispatch refusal; separately test the tightly bound qualification authority, not a global bypass (B04). |
| D2-T02 | Keep activation authority. Distinguish the approved consume route from a direct status write and test stale activation dependencies (B04/N03). |
| D2-T03 | Keep. Include the effective template/capability/profile fingerprint, not only the CLI help text (B05/N03). |
| D2-T04 | Pin restoration under a new compatible active qualification even though the historical row remains lapsed (N03). |
| D2-T05 | **Strengthen.** A trust entry asserting `model_turn` is not evidence it can enforce it; require enforcement qualification independent of usage frequency (B06). |
| D2-T06 | Add special files, entry/time limits, all writable locations and crash-before-collection; no-follow plus byte cap is insufficient (B08/B09). |
| D2-T07 | Keep descendant containment; do not claim exercised session `open_idle` when session mode is refused (N04). |
| D2-T08 | Assert the exact expected edit/result and effective capabilities, not merely fields filled from any clean transcript. Require B04's valid first-launch path (B05). |
| D2-T09 | **Replace trigger.** Cancel a demonstrably live authenticated backend independently of usage; assert full-domain quiescence and retained partial accounting (B04/B07). |
| D2-T10 | Replace marker/transcript sufficiency with independently witnessed actions against valid targets; a fabricated success report fails (B05; P4/P8/P11 lessons). |
| D2-T11 | Keep. Authentication failure is failed qualification with useful redacted diagnostics; absence of a forbidden side effect is not a pass (N04). |
| D2-H01 | Keep; unsupported or unexercised checks are reported distinctly, never passed by default (§6; P11/P12). |
| D2-H02 | Keep unqualified startup; verify existing domains remain unknown when manager/hierarchy evidence is unavailable (§3.4). |
| D2-H03 | Keep distinct rows; test compatibility/current eligibility versus historical evidence, and bound startup probe work (N03; §7.1). |
| D2-C01 | Keep; add candidate/sensitive-area/status changes between proposal, preview and effect, and retained immutable containment references (§5 C1; D1 §10.5). |
| D2-C02 | Keep if Sean accepts K7; separately test a real Reviewer cannot apply its own proposal (§5 C2a). |
| D2-C03 | Keep; change each classifier dependency between approval and effect, assert no write and no check-pass conversion (§5 C2b). |
| D2-C04 | Keep if Sean accepts C4; use mixed reported/estimated rows, price versions and corrections without erasing provenance (B06/B07). |
| D2-C05 | Specify unknown/incomplete reservation and reconciliation, repeated finalization and concurrent dispatch; it cannot replace known observed spend (B07). |
| D2-C06 | Keep. The qualification path and scripted non-harness path must satisfy it too; a production config flag cannot select the harness boundary (B04; §5 C3). |

### 8.3 Properties without adequate coverage today

These can be added to the nearest rows above, without multiplying test scaffolding:

- **Launch closure across every termination path**, including pre-placement Stop and recovery releasing quarantine: B03–B07/B12 do not currently assert it (B01).
- **Actual mount/profile authority**, including pathnames to host sockets, extra-path aliases/submounts, inherited descriptors, private shared memory, the trusted init channel and complete WSL mount visibility (B02; I01–I11).
- **Proxy connect identity and resource limits**, distinct from hostname/port comparison (B03; I07).
- **First-entry qualification admission, replay protection and activation dependencies**, including the initial reviewed egress set (B04; T01/T02/T08).
- **Verified absence of one-shot delegation** on the actual CLI path, and a cancellation barrier before terminal-only usage (B04/B05; T08–T10).
- **Budget enforcement evidence**, concurrent reservations and retention of known partial usage (B06/B07; A09/T05/C04/C05).
- **Pre-collection/crash secret persistence and collection from all writable locations**, plus bounded traversal of special/empty files (B08/B09; I13/T06).
- **Aggregate memory/swap, writable-storage and outside-domain supervisor pressure**, with ability to record the refusal while pressure exists (B09; B11).
- **User-manager interruption and resumed supervision**, with a verified hierarchy and fresh heartbeat evidence rather than a convenient ENOENT or buffered event (B01/N01; B05/B09/B10).

## 9. What I verified versus inferred

Evidence labels retain AH §2.2's meanings:

- **Observed this review:** source inspection, local help/feature output or a harmless scratch reproduction performed here.
- **Recorded observation:** an existing report or draft records a run which I did not repeat.
- **Implemented:** present source supports a behavior; this alone is not production reliability evidence.
- **Open/reported:** a documented unresolved question or unqualified behavior.
- **Recommendation/inference:** a conclusion or proposed requirement derived from those sources.

| Evidence | What was and was not established |
|---|---|
| **Observed this review — source** | Read the owner brief, D2 draft 1, E36–E48 and the applicable inherited clauses, BS §§6/8, M1 report/not-claimed, the choke point/boundary seam and predecessor findings. References in §§2–8 identify the supporting sections. The present choke point is in `packages/engine/src/invoke/choke.ts`; its direct-spawn/test backend contract is `packages/engine/src/invoke/backend.ts`. `processes.ts` explicitly treats PID/groups/markers as aids, not proof. `packages/engine/src/testing/seam.ts` distinguishes the harness boundary from production. |
| **Implemented — partial accounting** | `packages/engine/src/store/transitions/ledger.ts`, `chargeInvocation()`, retains normalized observed values and marks engine-ended usage incomplete. This is the source basis for B07; I did not rerun the M1 suite. |
| **Recorded observation — M1** | M1 report §§1–2 and its after-acceptance note record the accepted kernel claim and suite results. They qualify no real agent, isolation mechanism or check runner. Existing work under M2 hardening was not edited or re-reviewed here. |
| **Observed this review — CLI versions/help** | Claude Code reports `2.1.288`; Codex reports `0.159.2`. Read local help for the proposed invocation surfaces; the listed template options are present. Help is syntax/capability-description evidence, not proof of proxy handling, authentication, stream semantics, cancellation, persistence or enforcement. |
| **Observed this review — Codex feature setting** | `codex features list` with a fresh temporary `CODEX_HOME` and cwd outside the repository exited 0 and reported `multi_agent stable true`, `multi_agent_v2 stable false`. This closes D2 §4.6's factual “not run” item about the current default; it does not establish runtime denial until the exact headless template is canaried. An attempted top-level use of exec-only ignore flags yielded no useful feature evidence and is not credited. |
| **Observed this review — Git probe** | A temporary real repository and linked worktree had a `.git` file. Literal writes to `.git/config` and `.git/hooks/pre-commit` both returned errno 20, ENOTDIR, while `git config review.probe writable` successfully changed the actual configuration. This demonstrates why P4/P5 need resolved targets. The scratch repository was removed. |
| **Observed this review — namespace/socket probe** | `unshare -Urn true` succeeded. A separate harmless socket probe used `unshare -Urnm`, bound a scratch directory read-only and connected from the new network namespace to its host pathname socket; it received the known marker. The initial attempt was blocked by the tool sandbox, so the successful probe used the approved host execution path. This establishes the primitive in B02, not a complete D2 sandbox escape. |
| **Observed this review — host facts** | The host reports `6.6.87.2-microsoft-standard-WSL2`; the actual cgroup2 mount is writable and has `nsdelegate`; the user manager reports `running`. The tool sandbox presents a read-only cgroup mount and blocks the user bus; those tool restrictions were not misreported as host incapability. |
| **Observed this review — cgroup probe** | In a temporary delegated user scope, a child waited in a supervisor leaf. The domain reported `populated 0` before and after `cgroup.kill`; releasing the child let it enter that domain, which then reported `populated 1`. The child was killed and reaped, its domain removed, and scope cleanup requested. No engine process or other scope was targeted. |
| **Recorded observation — D2 preamble** | The draft records broader namespace, double-fork, migration-denial, scope-survival, network and WSL-interpreter probes. I did not repeat that whole suite, a user-manager restart/logout, a valid Windows executable test, or the absent D2 P1–P20 suite. Its analogues support feasibility, not host qualification. |
| **Observed this review — upstream documentation** | Consulted the Linux 6.6 cgroup v2 documentation, Linux unix(7) and systemd's delegation documentation, linked next to the applicable claims. Conclusions about missing launch closure and socket exposure are additionally supported by local primitive probes. |
| **Open/reported — provider contracts** | HTTPS proxy behavior, exact usage/success events, API-key delivery for Codex, provider-native writes, actual available headless tools, TERM behavior and continuation remain unqualified (D2 §§4.5–4.6). I expect invocation-level accounting to remain the conservative baseline, but that is an inference pending real canaries, not a version claim. |
| **Recommendation/inference — design** | B01–B09 and N01–N05 are normative amendments or test requirements. No actual D2 implementation was claimed exploited. The mount and launch counterexamples show why the written guarantees require stronger contracts. |

No paid benchmark, prompted `codex exec`, `claude -p`, real-agent canary, API activation, deployment or repository mutation was run. No implementation or acceptance test was changed. The only repository file added by this review is this report; the pre-existing untracked `docs/architecture/` directory was left untouched. The OpenAI documentation skill was used for the Codex invocation check, beginning with the installed CLI as required; no model behavior was inferred from the skill.

## Questions for Sean

1. **Decide Q1–Q7 and C1–C4 in section 5.** In particular, acceptance of Q2's role-held credential and coarse invocation budgeting must not be recorded as a guarantee that the engine independently bounds all provider spending (B06).
2. **Approve a narrowly scoped qualification authority as a correction to D1 §17.11/§15.1.** Without it, D2 cannot run the canary needed to create its first trust entry (B04). It must never authorize ordinary project work.
3. **Resolve the raw-storage contract before a real backend receives a key.** My recommendation is B08's bounded volatile provider home/output plus screened publication. If raw plaintext disk scratch is intended instead, explicitly amend the before-disk promise and its crash-retention scope; deletion after collection does not satisfy the current rule (D1 §14.2; E37 item 2).
4. **Keep insecure bootstrap opt-in outside qualified production M2.** If compatibility beyond harness tests is required, record the exception to protection from other local uids explicitly (N05; D2 §2.1/§8).

These are decisions for the disposition record and tests. They are not a request for another D2 prose-review round.
