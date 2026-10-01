# Foundations v1.1 Errata: Working Draft

**Status:** Draft. Decisions recorded as Sean makes them during review of v1.0 against the two historical reviews. Not yet cross-reviewed by the second architect.
**Source:** Review session 2026-09-30. Findings from `sdlc-review-claude.md` and `sdlc-review-Astra.md` checked against `sdlc-framework-foundations-v1.0.md`.

Each entry records: the gap, the decision, the proposed amendment text, and where it lands in v1.0.

---

## E1. Backend layer (decided: option B plus one floor item)

**Gap.** v1.0 never names Claude Code or Codex. Section 10 has no deferred-work line for backend adapters. The reviews tie five incidents to this layer: Codex `exec` ignoring permission config while stub tests stayed green; the Codex child inheriting every credential; Claude never-prompting tools running despite an allowlist; unknown config keys silently absorbed; a new runtime landing at maximum trust by denylist omission.

**Decision.** Add a backend invariants section under Roles, one line in Section 10, and one outcome-shaped item in the 9.1 floor. Keep CLI flags and version numbers out of foundations.

**Proposed text, new Section 4.3 "Backend contract":**

> Coding backends (the runtimes that execute a role's session) are interchangeable executors behind one engine-owned contract. Five invariants hold for every backend:
>
> 1. **The engine owns the guarantee.** A role's prohibitions are enforced by engine-side containment and post-run validation of the workspace, never by the backend's own permission configuration alone.
> 2. **Trust is an explicit allowlist.** A backend, and each version of it, is eligible for unattended work only through a recorded trust-table entry. Absence refuses; it never grants.
> 3. **Refuse, never ignore.** A backend that cannot implement a capability the run requires causes the engine to refuse the run before any model spend. Unsupported policy is never silently dropped.
> 4. **The child environment is constructed, not inherited.** Each run receives an allowlisted environment scoped to its capabilities. Credentials enter only through that allowlist.
> 5. **Real-binary verification precedes eligibility.** Stub-verified behavior is not evidence. Every supported backend version is qualified against the actual binary, positive and negative cases, before its trust-table entry is recorded.
>
> Detailed design keeps these dimensions separate: coding runtime, model, authentication, execution mode, delivery substrate, verification runner, project phase, and authority (Astra review §9.3).

**Proposed addition to Section 9.1 floor:**

> - No backend or backend version is eligible for unattended work without a recorded trust-table entry backed by real-binary verification.

**Proposed addition to Section 10:**

> - **Backend adapters:** a common driver contract (preflight, capability discovery, launch, event normalization, result collection, cancellation, cleanup), the trust table, per-backend containment, and real-binary test lanes for every supported backend.

---

## E2. Who performs git (decided: option A, engine performs all git)

**Gap.** Section 4.1 lets the Builder "write in the development worktree" but never assigns staging, committing, branching, or integration. Verity ADR-0012 and ADR-0013 settled this after a read-only sandbox broke branching and a denied network broke the reviewer's comment. Both reviews name engine-performed git as the most reused pattern in the record, and the Astra review says to keep it even when a trusted interactive runtime could perform the operation itself.

**Decision.** The engine performs every version-control operation. Roles edit files in an isolated workspace and return a structured result. A checkpoint affordance gives the Builder save points without git authority. Prohibitions are enforced by post-run validation in every case.

**Proposed text, new bullets in Section 4.2 Role rules:**

> - **The engine performs git.** No role runs version-control operations. A role edits files in an isolated workspace prepared by the engine from a known base revision and returns a structured result. The engine validates the resulting diff and refs, then stages, commits, branches, and integrates. Every commit is therefore an engine record with a known base and exact diff. This holds for every role and every backend, including interactive sessions.
> - **Checkpoints.** A role may ask the engine to record a checkpoint of its workspace. The engine performs and validates a checkpoint exactly as it does any other commit. Checkpoints give a role intermediate save points; they confer no git authority.
> - **Prohibitions are enforced twice.** Where a backend supports pre-emptive capability denial, the engine applies it. In every case, the engine validates the workspace diff and refs after the run against the role's prohibitions in Section 4.1. A run whose diff violates its role's prohibitions is rejected whole; there is no partial acceptance. This is what makes "may not modify application source" true on a backend whose own file restrictions do not bind.

**Consequences elsewhere.** Section 4.1 Builder "May not" gains "run version-control operations." Section 3.7's operation identity applies to every engine-performed push and merge. Spec Writer, Architect, Verifier, and Mechanic artifacts are committed by the engine, closing the ownerless-artifact gap Verity carried for 42 days (ADR-0033). The Release Operator directs publication; the engine performs the push as an identified operation.

---

## E3. Deployment verification defined (decided: option A)

**Gap.** Sections 3.3, 3.6, and 9.1 rest on "verified by observation" without a minimum. Switchboard's hotfix treadmill passed CI and a health check every time and still shipped broken: a substring-grepping verifier, a smoke script that accepted "degraded," a 472-byte placeholder bundle, a version string unchanged across five releases. Steer-it's dashboard passed tests on synthetic events while real clicks did nothing.

**Decision.** Define deployment verification as identity plus behavior, executed by the engine through the protected acceptance path, recorded on the environment record. Health and liveness are prerequisites, never sufficient.

**Proposed text, new Section 3.11 "Deployment verification":**

> A deployment is verified only when the engine observes all three of the following against the deployed instance:
>
> 1. **Identity.** The deployed instance reports its revision, and that revision matches the candidate's approved artifact. A deployment whose identity cannot be read is Unknown, not verified.
> 2. **Behavior.** At least one required acceptance check drives the deployed instance through its external interface (HTTP, UI, CLI, or equivalent) and observes the expected behavior. Health endpoints and process liveness are prerequisites for this check; passing them alone never establishes verification.
> 3. **Execution.** The engine runs these checks through the protected acceptance execution path (Section 5.2) and records the result on the environment record (Section 3.6). The deployment tool's own success report, and any agent's claim, never satisfy this section.
>
> The number and depth of post-deployment behavioral checks scale with validation scope (Section 5.6). The minimum of one identity check and one behavioral check holds at every tier and is part of the mandatory floor (Section 9.1).

**Consequences elsewhere.** Section 3.3 entry gates for Alpha Deployed, Beta Deployed, and Live cite 3.11. Section 9.1 "Observed deployment verification for every deployment state" gains "as defined in Section 3.11." Section 10 deployment adapters: the `verify` operation must support identity read and behavioral check execution against the target environment, including reachability for Tailscale hosts and cloud targets. Scaffolding must expose revision identity from the first candidate.

---

## E4. Walking skeleton (decided: option D)

**Gap.** Section 3.10 lets the Architect plan phase one as features. Nine Switchboard stages were marked done before CI had ever run green; the trivy tag bug, the HTMX stub, the registry identity mismatch, and the database wiring would all have surfaced on a one-route app. Verity certified its own 1.0 on a walking skeleton demo. Astra review §9.9: a non-empty executable gate set is part of the first usable slice.

**Decision.** Phase one of every roadmap is a walking skeleton. At every tier it must reach Alpha Deployed (floor). At T2 and T3 the default is that it also reaches Beta Deployed; T1 may configure the Beta requirement off. The 3.10.6 mechanical plan check enforces the phase-one shape. The delivery repository may start private so that a skeleton Beta does not force public publication.

**Proposed text, new Section 3.10.9 "Phase one is a walking skeleton":**

> The first phase of every roadmap delivers the smallest slice that exercises every gate the project will use: one real path through every architectural layer the ADRs name, the protected acceptance execution path with at least one behavioral check, and deployment verification (Section 3.11) on the Alpha environment. Phase one is complete only when its candidate is Alpha Deployed. This holds at every tier.
>
> At T2 and T3, phase one also carries the candidate through export, Beta publication, and staging deployment verification by default, so that the export allowlist and delivery pipeline are proven while there is little to leak. A T1 project may configure the Beta requirement off for phase one.
>
> The engine's plan check (Section 3.10.6) verifies that phase one cites a deployable slice, plans at least one behavioral check, and names Alpha Deployed (and Beta Deployed where required) as its completion gate. For a project whose deployment adapter defines no runtime environment, such as a library, "deployed" means the adapter's equivalent: built, published to the configured target, and verified there.

**Consequences elsewhere.** Section 7.1: the delivery repository is created at first Beta publication and **may be private**; making it public is the separate event governed by 7.5. Section 7.5: rename the first row to "First public source visibility" to remove the conflation with first Beta publication. Section 9.1 floor: add "Phase one of every roadmap reaches Alpha Deployed before feature phases begin." Section 9.2 configurable: add "Phase-one Beta requirement (default on at T2 and T3)." Existing-project adoption needs its own variant of this rule; see E6.

---

## E5. Mechanic triage gate (decided: B + C + D with one floor item)

**Gap.** Section 8 files Mechanic issues into development; 3.8 routes them straight to work; 3.3 permits automated architecture approval under a prototype policy; 7.5 makes subsequent Beta publications configurable. At T1 a production user's report can become a published Beta with no human reading it. This is the self-feeding loop the no-self-feeding rule exists to prevent and a prompt-injection path from user text to code (Claude review R22, R23). Section 8 also uses "Triage" to mean severity proposal, which collides with the new meaning.

**Decision.** A triage disposition is mandatory before any Mechanic issue becomes work (floor). Sensitive-area and out-of-baseline issues always require a human disposition (floor). Above the floor, the project's management policy chooses manual or gated triage, default manual, recorded at management activation. Raw user-report text never enters an agent prompt. A sanitized product-intent contract gives the Mechanic its definition of intended behavior.

**Proposed text, Section 8, replace the "Triage" bullet and add a "Triage" subsection:**

> - **Severity proposal:** Every issue carries a proposed severity (Section 6.3) and supporting evidence.
>
> **Triage.** A Mechanic-filed issue becomes work only through a recorded triage disposition: accept as work item, reject, merge into an existing issue, or defer with a target. Two triage policies exist:
>
> - **Manual (default).** Every disposition is made by the human owner.
> - **Gated.** The engine mechanically checks that the issue cites an existing approved requirement, needs no specification change, touches no sensitive area (Section 5.6) according to the module map, and carries telemetry or log evidence beyond user-supplied text. An intake assessment in a fresh session records a claim-versus-reality table. Issues passing both may be accepted as work under the project's autonomy policy. Any issue failing either check goes to the human owner.
>
> Under either policy, an issue that touches a sensitive area or falls outside the approved baseline requires a human disposition. The triage policy is chosen by the human owner and recorded at management activation (Section 3.5).
>
> **Untrusted input.** Raw user-report text is untrusted data. The engine stores it, shows it to humans, and never includes it in any agent prompt. Downstream roles see the Mechanic's structured record only: observed behavior, expected behavior per the product-intent contract, telemetry references, and proposed severity.

**Proposed addition to Section 9.1 floor:**

> - A Mechanic-filed issue never becomes work without a recorded triage disposition. Issues touching a sensitive area or outside the approved baseline require a human disposition.

**Consequences elsewhere.** Section 3.5 activation gate gains "the triage policy is recorded." Section 3.8 "Mechanic report" row becomes "Issue filed in development; becomes work only through triage (Section 8). Management mode unchanged." Section 9.2 configurable gains "Mechanic triage policy (manual or gated; default manual)." Section 10 gains "**Product-intent contract:** a sanitized statement of intended behavior, derived from the approved spec without private development records, that the Mechanic reads to distinguish defects from intended behavior."

---

## E6. Adopting an existing project (decided: two modes, A for small pre-deployment repos, C for substantial or production repos)

**Gap.** Every lifecycle in v1.0 starts at Idea. SDD had a Retrofit Planner; Verity adopted Switchboard mid-life and built itself under its own rules. Astra review §11.3 asks whether the first supported journey includes an existing production repository. v1.0 has no entry gate, no answer for a baseline that was never approved, no environment record for deployments the engine never performed, and no handling for a repo that is already public.

**Decision.** Add an adoption path with two baseline modes. **Full baseline** (reverse-engineer a complete spec before any change) for small codebases not yet deployed. **Scoped baseline** (whole-project module map and sensitivity classification up front; detailed acceptance criteria per phase as changes touch modules) for substantial or production codebases. The human owner chooses the mode at adoption; the engine records the choice and the size and deployment signals it observed. Both modes require the same conformance phase and satisfy the same floor. No new roles: Spec Writer and Architect take code as input instead of an idea.

**Proposed text, new Section 3.12 "Adopting an existing project":**

> An existing repository enters the lifecycle through adoption. The engine pins the repository at a recorded revision as the development repository (or, for an already public repository, clones it into a new private development repository and designates the public one as the delivery repository with its history retained). That revision is the first candidate.
>
> **Baseline modes.** The human owner chooses one at adoption; the engine records the choice with the codebase size and any existing deployment evidence it observed.
>
> - **Full baseline.** The Spec Writer and Architect, in retrofit mode, produce a complete descriptive specification, module map, sensitive-area classification, and ADRs from the code, each with a claim-versus-reality table. The human approves the result as Spec Ready. Intended for small codebases not yet deployed, where a complete baseline is cheap and its assurance is worth the most.
> - **Scoped baseline.** The Architect produces the whole-project module map and sensitive-area classification so that the sensitivity floor (Section 5.6) applies from day one. Detailed acceptance criteria are written per phase as changes touch modules, following Section 3.10.3. Requirements for untouched modules are recorded as **descriptive, unverified** and remain visibly pending under Section 3.10.2. Intended for substantial or production codebases.
>
> Every descriptive requirement is marked as reverse-engineered in every projection until a human confirms it as intended behavior, so that an existing defect is never silently promoted to a requirement.
>
> **Conformance phase.** Phase one of an adopted project (Section 3.10.9) carries the code unchanged through the protected acceptance path, Alpha deployment, and deployment verification (Section 3.11). No change is planned until conformance is established.
>
> **Existing records.** Environment records for deployments the engine did not perform start as Unknown. Existing releases are recorded as external and unverified. Existing tests are Builder-owned developer tests until the Verifier adopts specific ones into the protected path through Section 5.3. For an adopted public repository, delivery-repository reconciliation (Section 7.6) starts from the recorded adoption baseline commit.

**Consequences elsewhere.** Section 3.2 baseline states gain an entry note: "or established by adoption (Section 3.12)." Section 7.1: "fresh history" applies only to delivery repositories the framework creates; an adopted public repository keeps its history. Section 9.2 configurable gains "adoption baseline mode and the size threshold that drives its default recommendation." Section 10 gains "**Adoption tooling:** retrofit analysis producing the module map, sensitivity classification, and descriptive specification with claim-versus-reality tables." Dogfood note: adopting sdlc-x's predecessor repositories is a natural first exercise of this path.

---

## E7. Interruption, stop, and resume (decided: option C)

**Gap.** Section 3.9 lists interruption causes and specifies resume only. Nothing says what stopping does to the process tree, usage row, workspace, lease, or in-flight operations. Record: killed ticks left a lock label, a dirty branch, and no usage row; a headless build spawned sub-agents and exited with 465k tokens spent and nothing committed; a network outage stalled the worker 110 minutes because no external call had a deadline. Astra review §9.5: pause-new-work and cancel-current-work are separate operations; power-loss recovery must not depend on a graceful handler.

**Decision.** Restructure 3.9 into four parts: three named operations, what stopping records, the existing resume steps, and ungraceful-termination recovery. Deadlines on every run, external call, and recovery loop. The engine owns every process a run spawns. One floor item.

**Proposed text, Section 3.9 retitled "Interruption, stop, and resume":**

> **3.9.1 Operations.** Three operations exist and are never conflated:
> - **Pause.** The engine stops dispatching new work. Running work completes normally.
> - **Stop.** The engine terminates the running run now. The workspace is retained as a checkpoint.
> - **Abandon.** Stop, then discard the workspace. The work item returns to its prior state.
>
> **3.9.2 What stopping records.** On Stop or Abandon the engine: terminates the entire process tree the run spawned; records usage as observed by the backend plus an explicit unknown remainder where the backend did not report; records the workspace disposition (retained or discarded); revokes the run's capabilities and releases its lease; and reconciles any publication or deployment in flight (Section 3.7) before recording the run's outcome. The run's outcome is recorded as stopped or abandoned, never as failed or passed.
>
> **3.9.3 Resume.** [existing 3.9 steps 1–6 unchanged]
>
> **3.9.4 Ungraceful termination.** A crash, kill signal, or power loss bypasses every handler. On its next start the engine detects runs whose lease is held but whose process is gone, and brings each to the same end state as Stop: usage reconciled from durable records with the unknown remainder marked, capabilities revoked, lease released, in-flight operations reconciled, workspace retained. Resume then follows 3.9.3 if the work continues.
>
> **3.9.5 Deadlines and process ownership.** Every run, every external call the engine makes, and every recovery loop carries a deadline. A deadline expiring on a read fails the read; a deadline expiring on a write marks the outcome ambiguous and triggers reconciliation (Section 3.7) before any retry. The engine owns every process a run spawns. A backend may delegate to descendant processes only where its adapter can track, await, cancel, and account for them; otherwise the engine denies delegation in a verified way before the run starts (Section 4.3).

**Proposed addition to Section 9.1 floor:**

> - Stopping a run, by any means including crash, never loses recorded usage and never leaves a lease held or a capability live.

**Consequences elsewhere.** Section 3.1 execution status values gain Stopped and Abandoned. Section 5.8 budgets: "Exhaustion pauses work" becomes "Exhaustion stops the run (3.9.2) and pauses dispatch." Section 10 event stream: run heartbeat and process-tree identity are required outputs. Section 10 UI: Pause, Stop, and Abandon each state their consequence in the engine's terms before confirmation.

---

## E8. Check judgment and gate-record states (decided: B + C, no waiver state)

**Gap.** Section 5.2 defines the protected path and P2 says results are engine-observed, but nothing says how a check is judged. The record has three failures of this one rule: a lint failure swallowed because a pipeline's exit status is its last command's (five errors merged as clean); the same class after a linter version change in a worktree; a test runner that passed unawaited async tests vacuously and counted skips as passes. Astra review §9.9: missing, skipped, stale, waived, and passed must be distinct.

**Decision.** The engine judges every check by the exit status of the check's own process, spawned and observed directly. Gate records carry one of five states; only passed satisfies a gate. There is no waiver state for required checks: the only way to stop requiring a check is the Section 5.3 protected update, which is recorded and visible. One floor item.

**Proposed text, addition to Section 5.2:**

> **Judgment.** The engine judges a check solely by the exit status of the check's own process. The engine spawns that process directly and observes its exit; it never judges through a shell pipeline, by parsing output, or from a wrapper's or an agent's summary. Output is captured separately as evidence. The check definition, which is part of the protected path, configures the tool to fail on every condition the check requires; a tool that exits zero on a condition the check cares about is misconfigured, and correcting it follows Section 5.3.
>
> **Gate record.** Every required-check result is exactly one of: **passed**, **failed**, **missing** (did not run), **skipped** (the runner reported it as not executed), or **stale** (ran against a different source revision or protected version than the gate is evaluating). Only passed satisfies a gate. The record names the source revision, protected version, runner identity, environment, exit status, and captured output. A runner that cannot distinguish a skipped check from a passed one is not a valid runner for required checks.
>
> **No waivers.** There is no waiver state for a required check. Removing or relaxing a requirement is a protected update (Section 5.3), approved against the spec and visible at every later gate.

**Proposed addition to Section 9.1 floor:**

> - Required checks are judged by the engine from the exit status of the check process, never from output, a pipeline, or any summary. Only a passed result satisfies a gate.

**Consequences elsewhere.** Section 6.1 "Always blocking: any failed or missing required check" becomes "any required check whose result is not passed." Section 10 test runner: must emit per-check exit status and the five-state classification, and must itself be tested for vacuous-pass and skip-as-pass behavior. Section 10 gate runners: the same committed check definition executes identically under every runner (direct, container, remote), so a runner difference can never change a verdict.

---

## E9. Human decisions: principle, queue, consolidation, aging, inventory (decided: E + A + B + C + appendix)

**Gap.** v1.0 plus E1–E8 define eighteen distinct human decision types and say nothing about how they are presented, batched, or tracked. Record: steer-it ended with 25 judged items and 0 ratified; the console's first session was abandoned after six blockers; Verity's plan role went unexercised because a single-account rule silently dropped requests. Claude review lesson 12: human steps must be cheap, batchable, and visible, or they become the step that never runs.

**Decision.** Add principle P9. Require one attention queue in the UI with a fixed item schema. The engine consolidates decisions bound to the same revision and gate into one item while recording each separately. Each gate class has a configurable time-to-decision target; aged items escalate through the Section 8 external channel. Maintain the inventory below as an appendix that every future amendment must update.

**Proposed text, new principle in Section 2:**

> **P9. Human decisions are few, informed, and visible.**
> The engine requests a human decision only through the attention queue. Every request states what is asked, the consequence of each answer in the engine's terms, the evidence, and the revision it binds to. The engine never asks the same question twice for the same revision and evidence. Related decisions bound to one revision and gate are presented together and recorded separately.

**Proposed addition to Section 10 UI:**

> - **Attention queue.** One queue holds every pending human decision. Each item carries: the question; the consequence of each available answer, computed by the same engine function that will apply it; the evidence; the candidate, revision, and gate it binds to; when it was raised; and what remains blocked while it is unanswered. One primary action per item. Independent items may be answered as a batch. The queue shows per-item age against the gate class's time-to-decision target; items past target escalate through the project's external channel (Section 8).

**Proposed addition to Section 9.2 configurable:**

> - Time-to-decision target per gate class (aging and escalation thresholds).

**Proposed new Appendix A, "Human decision inventory":**

| Source | Decision | Floor? |
|---|---|---|
| 3.2 | Create or accept the idea | No |
| 3.2 | Approve the spec | Yes |
| 3.3 | Approve architecture (unless prototype policy automates) | No |
| 3.10.6 | Approve plans that change goals, alter ADRs, or have uncertain conformance | No |
| 3.8 | Approve a spec change | Yes (spec approval) |
| 5.3 | Approve a check correction when the Reviewer does not | No |
| 6.2 | Defer a Medium finding; Accept any finding | No |
| 6.3 | Lower a severity out of blocking range | No |
| 5.8 | Resolve a blocker | No |
| 7.5 | First public source visibility; any allowlist widening | Yes |
| 7.5 | Subsequent Beta publication, if configured | No |
| 7.6 | Reconcile unexpected delivery-repository edits | No |
| 3.3 | Go-live, with recorded recovery plan | Yes |
| 3.5 | Opt in to management; choose triage policy | No |
| 8 | Respond to urgent Mechanic escalation | No |
| 8 (E5) | Triage a Mechanic issue under manual policy; sensitive or out-of-baseline under any policy | Partly |
| 3.12 (E6) | Choose adoption mode; confirm a descriptive requirement as intended | No |
| 3.9 (E7) | Confirm Stop or Abandon | No |

Every amendment that adds, removes, or re-routes a human decision updates this table.

---

## E10. Interactive roles run as engine sessions (decided: option C, with floor item and integrity rule)

**Gap.** Vision assistant and Spec Writer are conversational, but nothing says a conversation is a run. Verity metered only headless dispatches, so half its cost picture was missing (Claude review R10). A prohibition on an interactive role (Vision "may not write spec, architecture, code, or checks") is enforceable only on a session the engine mediates (P4).

**Decision.** Every model invocation goes through the engine. Interactive roles run as a distinct run kind, the session. One floor item. One integrity rule for out-of-band changes to the development repository.

**Proposed text, addition to Section 4.2 Role rules:**

> - **Every model invocation is a run.** The engine performs every model invocation with a role, a capability grant, a budget, and a ledger row. No screen, script, or role calls a backend directly.
> - **Sessions.** An interactive role runs as a session: a sequence of turns under one role and one capability grant. Each turn is metered to the ledger with its provider and model. A session ends on human close, budget exhaustion, or idle timeout; its capabilities expire with it. The engine commits a session's artifacts (idea record, spec draft, change request) on explicit save and at session end (Section 4.2, "The engine performs git"). Resuming a session follows Section 3.9.3. Session mode is qualified in the backend trust table separately from one-shot mode (Section 4.3).

**Proposed addition to Section 9.1 floor:**

> - Every model invocation is performed by the engine with a role, a capability grant, a budget, and a ledger row.

**Proposed text, new Section 7.8 "Development repository integrity":**

> The development repository is canonical and engine-written. A change that did not originate in an engine run (a direct commit, an external tool, a manual edit on a tracked branch) is detected at the next engine operation and blocks every gate on the affected lineage until the human owner reconciles it: discard it, or adopt it as a recorded out-of-band change with the affected evidence invalidated. The engine never silently absorbs an out-of-band change, in the same way Section 7.6 treats the delivery repository.

**Consequences elsewhere.** Section 10 cost visibility: spend per role includes session turns; the UI shows session spend live. Section 10 backend adapters: session support (multi-turn under engine control) is a qualified capability per backend and version. Section 3.1 execution status gains "Session open." Appendix A (E9): "Reconcile out-of-band development-repository change" is added as a human decision, not floor.

---

## E11. Candidate granularity and nomination (decided: option D)

**Gap.** Section 3.4 and the 3.8 table say any source change creates a new candidate. Read literally, every commit (and every E2 checkpoint) is a candidate, which collides with O7's "once per candidate" cadence, empties Developing of meaning, and turns the multi-candidate UI into a commit log.

**Decision.** Two terms. A **revision** is any commit. A **candidate** is a revision the engine has nominated for verification. Working revisions before nomination carry no gate status and make no claims. After nomination, any source change begins a new lineage. Checkpoints are never candidates. Terminology pass across 3.1, 3.4, 3.7, 3.8, and 3.10.4.

**Proposed text, Section 3.4, replace the third bullet and add a fourth:**

> - **Revisions and candidates are different things.** A revision is any commit in the development repository. A candidate is a revision the engine has **nominated** for verification. Commits made before nomination are working revisions on the next candidate's lineage: they are recorded, they carry no gate status, and no claim is made about them. A checkpoint (Section 4.2) is always a working revision.
> - **Nomination.** The engine nominates a revision as a candidate when the verification cadence (Section 5.6) calls for it: at build-stage completion for T2 and T3; at phase completion, or on the Builder's request, for T1; and always before any deployment gate. Nomination is an engine event that records the revision, the baseline version, and the protected version it will be verified against. Once a revision is nominated, any later source change starts a new lineage; the nominated candidate's history and evidence are preserved, and approvals never transfer (Section 3.8).

**Consequences elsewhere.** Section 3.1 candidate-progress row: "an identified candidate" becomes "a nominated revision (Section 3.4)." Section 3.8 table first row: "Source change at any stage" becomes "Source change after nomination." Section 3.10.4: "A candidate deployed to Alpha mid-project" unchanged; it already refers to a nominated revision. Section 5.6 verification cadence: "once per candidate" now reads unambiguously. Section 10 UI: the project screen lists candidates, not revisions; working revisions appear only in a lineage view.

---

## E12. No role emits a gate outcome; the gate function is explicit (decided: A + C)

**Gap.** Section 4.1 lists "verification results" and "gate verdict" among the Verifier's outputs. P2 says the engine is the only authority and agent claims never satisfy a gate; E8 has the engine run and judge checks. Verity ADR-0014: a reviewer "approve" that was wired as a merge became a paid trap. Any output named "verdict" invites that wiring.

**Decision.** Reword the Verifier's and Reviewer's outputs as inputs. Add an explicit gate-computation bullet to 3.7 enumerating every input the engine evaluates. The Reviewer's one real decision, approving a check correction in 5.3, is kept as a deliberate delegation.

**Proposed text, Section 4.1, Verifier row "Input → Output":**

> Approved requirements + nominated candidate → acceptance checks; findings with proposed severity; verification report (a claim under P8, never evidence)

**Proposed text, Section 4.1, Reviewer row "Input → Output":**

> Candidate, ADRs, checks, tests → review findings with proposed severity; revision-bound sign-off (an input to the gate, not a decision)

**Proposed text, new bullet in Section 3.7:**

> - **Gate computation.** The engine alone computes every gate outcome, from recorded inputs only: (1) every required check's gate record (Section 5.2) is **passed** at the candidate's revision and the current protected version; (2) no finding is blocking for this stage under Section 6.1, and every nonblocking finding has a recorded disposition under Section 6.2; (3) every sign-off the tier requires (Section 5.7) is recorded against this revision; (4) for a deployment gate, deployment verification (Section 3.11) is recorded against this environment and revision; (5) every human approval the floor or policy requires is recorded against this revision. No role emits a gate outcome. The consequence the UI shows for any action is computed by this same function.

**Consequences elsewhere.** Section 4.1 Release Operator "may not supply its own independent verdict" is unchanged and now consistent. Section 10 UI: button copy and confirm dialogs derive from the gate function, never from hand-written text. Any future amendment that adds a gate input adds it to this bullet.

---

## E13. Asymmetric approval of protected-check corrections (decided: option E)

**Gap.** Section 5.3 lets the Reviewer approve a check correction. At T1 no human is required anywhere in the path Builder objects → Verifier drafts → Reviewer approves, so three agent sessions can rewrite the protected path. This is the one route by which self-grading could return. Section 6.3 already solved the same shape for severity with an asymmetric rule. Separately, nothing in 4.1 forbids the Verifier from moving a check out of the required set, which is validation scope and belongs to the Architect's approved proposal.

**Decision.** Agents may approve corrections that add or tighten. Only a human may approve corrections that loosen. The engine classifies the diff; unclassifiable corrections route to the human. Every protected-version change since the last human-reviewed version is listed at publication and go-live as part of what the human approves.

**Proposed text, Section 5.3, replace step 3:**

> 3. **Approval, asymmetric.** The engine classifies the proposed diff:
>    - **Tightening or adding:** new checks, new assertions, narrower accepted ranges, additional coverage of an acceptance criterion. The Reviewer or the human owner may approve, in a fresh session, with a reason grounded in the approved spec.
>    - **Loosening:** removing a check or an assertion, widening an accepted range, reducing coverage of an acceptance criterion, marking a check optional, or moving a check out of the required set. **Only the human owner may approve.**
>    - **Unclassifiable:** anything the engine cannot classify as strictly tightening routes to the human owner.
>
>    The Verifier never approves its own proposal. A correction that moves a check out of the required set is also a validation-scope change and follows the architecture approval route (Section 3.3).

**Proposed text, addition to Section 5.3 after step 5:**

> **Delta at human gates.** At every publication approval (Section 7.5) and go-live approval (Section 3.3), the engine lists every protected-version change recorded since the last version a human reviewed, with each change's classification and approver. The human's approval at that gate records that the delta was seen.

**Consequences elsewhere.** Section 4.1 Reviewer "May": "approve tightening check corrections against the spec." Section 4.1 Verifier "May not" gains "change which checks are required." Appendix A (E9) gains "Approve a loosening or unclassifiable check correction" (not floor). Section 10 test runner / protected path: the diff classifier is a detailed-design item; its conservative fallback is part of the contract.

---

## E14. Product shape (decided: option C, recorded as O8)

**Gap.** Section 3.7 says the UI operates the same engine; nothing says whether this is one product owning its engine or a UI over a reusable engine with frozen contracts. Record from the two-repo arrangement: separation bought hygiene and drift detection but produced contract ceremony, drift invisible to unit tests, four engine asks unfiled for 37 days, and a spawn-per-call polling model that exhausted a shared rate limit. E7, E9, and E10 already assume a heartbeat, an event stream, sessions, and a queue, none of which a spawn-per-call CLI provides.

**Decision (O8).** One repository, two packages. An engine package with a public API and a UI package that imports only that API, with the boundary enforced by the package import graph and one contract test suite that runs both together. The engine package is publishable on its own. Two companion decisions: the engine runs as a long-running local service with a local API, and it owns the one scheduling mechanism regardless of who requests a tick; v1 is single-operator and loopback-only, with multi-operator deferred.

**Proposed text, Section 11, new row:**

> | **O8** | Product shape | One repository, two packages: engine (public API, publishable alone) and UI (imports only that API; boundary enforced by the package graph; one contract suite runs both). Engine is a long-running local service owning scheduling; CLI, UI, and automation are clients. v1 is single-operator, loopback-only; multi-operator deferred. | 3.7, 10 |

**Proposed text, addition to Section 10, before the existing list:**

> **Shape (decided, O8).** The engine is a long-running local service exposing one local API. The CLI, the UI, and any automation are clients of that API; none holds state, decides transitions, calls a backend, or performs git. The engine owns the single scheduling mechanism; a tick requested by cron, the UI, or the CLI is the same tick. The UI is loopback-only and serves one operator in v1. Every item below is designed against this shape.

**Consequences elsewhere.** Section 10 UI: subscribes to the engine's event stream; never polls a substrate. Section 10 storage: the engine's durable records live in a transactional runtime store outside the source tree (Astra review §9.2), with backup and export defined. E1 backend adapters live in the engine package. The console's five invariants (not a second state machine; not a merge path; not a model caller; not required; loopback only) are adopted for the UI package verbatim.

---

## E15. Provenance (decided: A where recoverable, C regardless, D as standing practice)

**Gap.** The v1.0 header cites seven inputs (Foundations v0.1, the Architect Review Proposal, both cross-reviews, the second architect's final positions, her review of v0.2, her review of Section 3.10). None exist on disk anywhere under ~/projects; the only other copies of anything are the two reviews one level up, byte-identical. `sdlc-idea.md` is 0 bytes. The directory is not a git repository. v1.0's claim that both architects accept every section is therefore unverifiable, and the reviews are explicit that decisions without recorded reasons get relitigated.

**Decision.**
- **A.** Sean locates and exports whatever originating sessions survive into `history/` here, in order, with dates.
- **C.** Claude builds a decision-trail appendix mapping each v1.0 section to the review items it answered (R-numbers, acceptance scenarios, §9 requirements) and each O-decision to its question; restores `sdlc-idea.md` from the Claude review's §7 restatement of the rough spec, marked as reconstructed.
- **D.** From v1.1 onward every amendment is recorded with triggering evidence, options, decision, and reason (this file is the first). `git init` in this directory before v1.1 is cut, so the amendment is the first recorded diff.

**Proposed text, v1.1 header addition:**

> **Provenance.** The intermediate documents cited above were produced in interactive sessions and were not retained on disk at v1.0. Appendix B reconstructs the input-side trail from the two retained reviews. Any recovered originals are filed under `history/`. From v1.1, every amendment is recorded in the errata log with its evidence, options, and reason, and this document is versioned in git.

**Consequences elsewhere.** New Appendix B, "Decision trail" (to be generated). `sdlc-idea.md` restored with a "reconstructed from review §7" header. Section 11 gains a sentence: "Decisions O1–O8 were made in sessions whose transcripts are not retained; the question each answered is recorded in Appendix B."

---

## E16. Three smaller omissions (decided: A1, B1, C1)

### E16a. Retired state (decided: A1)

**Gap.** Section 3.2 has nothing after Live except management mode. A finished or abandoned project has nowhere to go and the Mechanic keeps filing against it (Claude review D2).

**Proposed text, Section 3.2, new row:**

> | **Retired** | The project is closed. No new candidates may be nominated. | Human decision. On entry the engine disables the Mechanic, clears management mode, freezes each environment record with its final observed condition, and leaves the delivery repository untouched. A human Reactivate returns the project to its prior baseline state. |

**Consequences elsewhere.** Appendix A gains "Retire a project; Reactivate a project" (not floor). Section 8: a retired project files nothing.

### E16b. Budget semantics (decided: B1)

**Gap.** Section 5.8 limits "time, tokens, and repair attempts" without saying what a token is. Verity's per-run ceiling counted prompt-cache reads, so one Sonnet build tripped a two-million limit on an accounting artifact (Claude review R17; Astra review §9.8). Codex reports tokens with no dollar figure.

**Proposed text, addition to Section 5.8 Budgets:**

> Budgets are expressed in **billable tokens** as the provider reports them, with cache reads recorded separately and shown alongside; in **wall time**; and in **repair attempts**. Budget checks run between turns and between dispatches and are **soft**: one turn of overshoot is possible unless the backend offers a hard mechanism the adapter has qualified (Section 4.3), in which case the hard limit is also applied. **Unknown cost** is bounded by tokens and time under explicit policy and is never recorded or displayed as zero or free. Every ledger row records the provider, the model requested, the model observed where available, raw provider usage, and the normalized billable figure, and distinguishes a reported value, an estimate, an unknown, and a measured zero from no dispatch. The UI shows billable and total-context figures side by side.

### E16c. Records, redaction, and retention (decided: C1)

**Gap.** Transcripts, parked results, and tool output are where secrets leak (Switchboard's GitHub token in a chat transcript). Section 7.2's export exclusions name secrets but not transcripts or engine records. Nothing says when records are redacted or how long they live (Astra review §11.3).

**Proposed text, new Section 3.13 "Records, redaction, and retention":**

> Transcripts, parked results, tool output, and raw user reports are engine records in the durable store, never files in the source tree. The engine **redacts at write time** using patterns for every configured provider and every secret reference it holds (Section 4.3, constructed environment). A secret found in a stored record after write is a **Critical** finding (Section 6.3). Records are retained at least as long as any evidence, approval, or open finding references them; retention beyond that is project policy (Section 9.2). Transcripts and engine records are never exported (Section 7.2) and never enter any agent prompt except as the engine's own scoped context package (Section 3.10.8).

**Consequences elsewhere.** Section 7.2 step 2 exclusions gain "transcripts and engine records." Section 9.2 configurable gains "record retention beyond the referenced period." Section 10 storage gains "redaction pattern registry per provider; secret-reference list."

---

## Summary of floor additions (Section 9.1) across E1–E16

- No backend or backend version is eligible for unattended work without a recorded trust-table entry backed by real-binary verification. (E1)
- Observed deployment verification for every deployment state, as defined in Section 3.11. (E3, amends existing item)
- Phase one of every roadmap reaches Alpha Deployed before feature phases begin. (E4)
- A Mechanic-filed issue never becomes work without a recorded triage disposition; sensitive-area and out-of-baseline issues require a human disposition. (E5)
- Stopping a run, by any means including crash, never loses recorded usage and never leaves a lease held or a capability live. (E7)
- Required checks are judged by the engine from the exit status of the check process; only a passed result satisfies a gate. (E8)
- Every model invocation is performed by the engine with a role, a capability grant, a budget, and a ledger row. (E10)

## New or retitled sections across E1–E16

| Section | Title | Source |
|---|---|---|
| P9 | Human decisions are few, informed, and visible | E9 |
| 3.9 | Interruption, stop, and resume (retitled; 3.9.1–3.9.5) | E7 |
| 3.10.9 | Phase one is a walking skeleton | E4 |
| 3.11 | Deployment verification | E3 |
| 3.12 | Adopting an existing project | E6 |
| 3.13 | Records, redaction, and retention | E16c |
| 4.3 | Backend contract | E1 |
| 7.8 | Development repository integrity | E10 |
| 11 / O8 | Product shape | E14 |
| Appendix A | Human decision inventory | E9 |
| Appendix B | Decision trail | E15 |

## E17. Stack and reuse (decided: O9, O10)

**Decision (O9, stack).** Node with TypeScript for the engine package, compiled with `tsc` only, no bundler. Two-package monorepo per O8: `engine` (public API, CLI bin, publishable alone) and `ui` (hand-written HTML and JS, zero build step, imports only the engine's published API schema). Runtime store is SQLite. Every dependency pinned; the engine's runtime dependencies are the SQLite driver and nothing else. Variant allowed: JSDoc-typed JavaScript checked by the TypeScript compiler, if a build step proves unwanted.

**Decision (O10, reuse).** Clean-room engine core (entities, store, API, scheduler, gate function, git). Verity's backend drivers and a small set of pure-function modules (approval consequence, diff classification, usage normalization, promotion allowlist) are ported behind the new adapter contract with their tests, then requalified against real binaries. The two permission vocabularies Verity never reconciled are unified in the port. Verity's assessments, ADRs, canaries, and benchmark fixtures are preserved as a regression corpus.

**Proposed text, Section 11, new rows:**

> | **O9** | Implementation stack | Node + TypeScript engine (tsc only), zero-build UI, SQLite runtime store, pinned dependencies, SQLite driver as the only runtime dependency. | 10 |
> | **O10** | Reuse of Verity | Clean-room core; backend drivers and pure-function modules ported and requalified; Verity records kept as regression corpus. | 10 |

**Mockup accepted.** The eight-screen MVP UI mockup (mockup/) was accepted the same day; UI refinement deferred until the narrow loop runs.

---

## E18. Repository and D1 cross-review decisions (decided: O11 plus three D1 decisions)

**Decision (O11, repository).** This directory (`sdlc-x`) becomes the Surety development repository with its git history preserved. Documents move under `docs/` with recorded renames when implementation is authorized. No separate design repository.

**D1 decisions reserved to Sean, recorded 2026-09-30 after Astra's cross-review of draft 1:**
- Nomination tags are kept, as immutable engine-owned refs registered and audited by the integrity check (D1 §7.2, §7.7).
- Adoption records the exact current commit of the selected integration branch as the baseline, unpushed commits included; later unrecorded changes are out-of-band (D1 §3.1, E6).
- One active run per project through M3; bounded parallelism across projects (D1 §7.5, §8.1).

**Proposed text, Section 11, new row:**

> | **O11** | Repository | `sdlc-x` becomes the Surety development repository, history preserved; docs move under `docs/` when implementation is authorized. | 10, 19 |

---

## E19. Authority over inherited-finding exclusions (decided by Sean, 2026-09-30)

**Gap.** D1 inherits unresolved findings across successor candidates (E11 lineage succession). Someone must be able to record that a finding no longer applies to a candidate, and that record must not become a severity-lowering or check-waiver path (Astra draft-2 review, Q4).

**Decision.** An applicability assessment is proposed by the Verifier in a fresh session, assessed for technical applicability by an independent Reviewer run, and takes effect only when approved. If excluding the finding would remove a finding that blocks any gate kind for that candidate, the human owner must authorize the approval. The engine records and applies the decision; an agent-authored assessment alone never excludes a finding.

**Proposed text, Section 6.2 addition:**

> **Applicability across candidates.** An unresolved finding applies to every successor candidate on its lineage chain until an applicability assessment excludes it. The Verifier proposes the assessment; an independent Reviewer assesses it; a finding that would otherwise block any gate for the candidate may be excluded only with the human owner's authorization. Exclusion never changes a severity and never waives a required check.

**Consequences elsewhere.** Appendix A (E9) gains "Authorize an applicability assessment that removes a blocking inherited finding" (not floor). D1 §3.4 and §9.3(5) implement it.

---

## E20. Design-review method and stopping rule (decided by Sean, 2026-10-01: O12)

**Gap.** D1 went through three cross-review rounds (16 blockers; 12 open; 12 open). Round-three findings were correct and were implementation-level contract defects found by execution (a SQL null-uniqueness hole, a git working-tree side effect, a browser header interaction). Prose iteration had no stopping point, which is the failure the foundations attribute to Verity's testing (Section 1) and which P7 forbids for testing.

**Decision (O12).** Detailed design is reviewed in two layers. **Architecture** (ownership boundaries, mechanisms, invariants, decisions) is settled in prose and cross-reviewed. **Contract precision** (constraints, transition edges, recovery outcomes, manifests) is settled in executable form: the Verifier writes acceptance tests first, the Builder implements against real SQLite and real git, and the schema and transition tables in the repository are the contract from which any appendix is generated. A design document is done when no open item is architecture-level and every contract-level item is a Verifier-owned test. New findings are classified the same way.

**D1 decision recorded with it.** v1 rule: the integration branch is engine-owned and must not be checked out in any worktree the engine does not own; the engine refuses integration otherwise. A checkout-updating protocol is deferred.

**Proposed text, Section 10, opening paragraph addition:**

> Detailed design settles architecture in cross-reviewed prose and contract precision in Verifier-owned acceptance tests written before implementation. A design document is complete when no open item is architecture-level and every contract-level item is a test.

---

## E21. Who builds M1 (decided by Sean, 2026-10-01: O13)

**Gap.** The resolution note (§4) named Astra as Verifier, writing each slice's acceptance tests before the Builder implements it, with Claude Code as Builder. Astra approved building M1 and delivered the acceptance plan, a trace matrix of 74 rows. The executable tests do not exist yet.

**Decision (O13).** In Sean's words: "Astra will not be building this project. Claude will." Claude performs the M1 build.

**How it is applied.** The Verifier role passes to Claude along with the Builder role. The independence rule (Section 5.1) is kept by separation, not by using a different model, as Section 5.5 already allows: the Verifier, the Builder and the Reviewer are separate sessions that never share context; each writes only its own paths; a script checks those paths before every merge; and the acceptance suite's exit status is the judgment. Astra's acceptance plan remains the inventory of what must be tested, and the rule that tests are written before implementation is unchanged. Astra's cross-reviews are reserved for milestones because her budget is limited. `docs/spec/M1-build-spec.md` section 4 carries the working procedure.

**Confirmed by Sean, 2026-10-01.** "Claude writes the test and Astra reviews (sometimes). We have a budget constraint with Astra so it will be used at milestones only." The reading above stands. Astra's cross-reviews are reserved for milestones, not for individual slices.

**Consequences elsewhere.** The resolution note §4 and the acceptance plan's "Owner: Astra, acting as Verifier" line are read with this entry. Neither file is edited.

---

## E22. Slice-1 seam decisions (decided by Sean, 2026-10-01)

**Gap.** Writing the slice-1 acceptance tests, the Verifier had to fix five points the sources left open and flagged them as touching design. They are recorded in `packages/engine/test/acceptance/harness/SEAM.md`; Sean accepted all five.

**Decisions.**

1. **Engine settings live in a file.** Engine-scope configuration is read once, at startup, from `$SURETY_HOME/config.json`, before the lock is taken. The API port must be known before the store opens (D1 §1.4), so it cannot live only in the store. Changing an engine setting means restarting the engine. D1's `config` table (A.3) holds no engine-scope setting; project settings stay in each project's policy file. Runtime-changeable engine settings would be a new decision with its own test.
2. **The health route requires the token.** D1 §11.1 and §17(2) are confirmed as written: `GET /v1/token/bootstrap` is the only route answered without a token. The `surety` command reads the token file. A tokenless liveness route for an outside monitor would be a new decision with its own test.
3. **Boundary tests start in slice 1.** The Host, token and audit cases of acceptance row M69 are listed under slice 1, where that behavior is first built. The rest of the row stays in slice 6.
4. **Pause and resume are built in slice 1.** They are the smallest real command with which to test that a failed write leaves nothing half-done (row M04).
5. **Tables that later slices use are created in slice 1,** because rows M03 and M04 write to them. When a later slice changes one of them, that slice's Verifier updates the shared seed helper in the same branch.

**Consequences elsewhere.** `docs/spec/M1-build-spec.md` section 9 lists the M69 cases under slice 1. No change to D1.

---

## E23. Slice-1 review decisions (provisional, 2026-10-01)

**Status: provisional.** On 2026-10-01 Sean told the driver session to "drive this as far as you can" and to merge on his behalf, without answering the questions the slice-1 review had raised. The driver applied its own recommendation on each as a default so the build could continue. Every item below is reversible: Sean confirms or overturns it when he returns, and an overturned item becomes a changed test.

**From the Reviewer's six design questions:**

1. **Startup steps that are not built yet.** `recovery` and `integrity` may be reported as completed in slice 1, because a normal engine has no project until slice 3. Slices 2 and 3 must show each step doing real work, with a restart test that has state to recover and a violation to find. Recorded in `COVERAGE.md`.
2. **Audit in restricted mode.** No refusal issued while the engine is in restricted mode needs an audit event. The store may not be open, and nothing can take effect in that mode.
3. **Effective policy.** A project's effective policy is the policy revision the engine has recorded. With none recorded it is the schema defaults, reported with no revision. A policy file committed in the repository but never recorded by the engine is not effective. Slice 3 pins what project setup does with a pre-existing file.
4. **Test-mode code is confined to one folder.** Everything that exists only for the test harness lives under `packages/engine/src/testing/`. Production source may import the seam module and call its functions, and the command-line entry point parses the harness flags. Nothing else asks whether harness mode is on. A source-inspection test enforces it.
5. **The migration runner is a named exception** to the rule that only transition functions write to the store. It is the only one. A fixture installer in the testing folder therefore writes through a transition function.
6. **Refusing a filesystem that does not honour sync** (D1 §6.1) is deferred to slice 4, to be decided with the power-loss test. Until then it is an open item, not a met requirement.

**From the Verifier's follow-up questions:**

7. **A refused start leaves the lock exactly as it found it.** A start refused for its configuration or its token file takes no lock and writes nothing under the engine home.
8. **A malformed token file is refused, not replaced.** A token file that is empty or too short gets the same refusal as one with unsafe permissions. The engine never rotates the operator's token on its own. Creating the token must be atomic so an interrupted first start cannot leave a malformed file. Not yet pinned by a test; the next Verifier pass adds one.
9. **`100 Continue` ordering** is pinned only for the Host check, as D1 §11.1 lists it. Whether a missing token is refused before `100 Continue` stays unpinned.
10. **A request with no Host header** currently gets a bare 400 from the HTTP library rather than the engine's refusal body. The status is right; the body shape is deferred to slice 6.

**From the second review, of the fix pass:**

11. **A start that fails before listening always says why.** Any failure before the listener starts, including an environmental one (an unwritable engine home, a path of the wrong kind, a filesystem without hard links), writes the same one-line refusal as the other startup refusals and exits with a defined status. It never ends in an uncaught error and a stack trace. Not yet pinned by a test; the next Verifier pass adds one.
12. **Two defects carried to the next Verifier pass rather than holding the slice-1 merge:** a named pipe placed at `api.token` hangs startup instead of being refused; and a request with an `Expect` value other than `100-continue` is answered by the HTTP library before the Host check and without an audit record. Neither lets a request take effect without the Host and token checks.

**Consequences elsewhere.** `packages/engine/test/acceptance/harness/SEAM.md` and `COVERAGE.md` carry the test-side detail. No change to D1.

---

## E24. Slice-2 seam decisions (provisional, 2026-10-01)

**Status: provisional**, on the same footing as E23. The slice-2 Verifier fixed these points in `harness/SEAM.md` and its tests and flagged them for the owner. The driver accepted the Verifier's recommendation on each. Sean confirms or overturns them.

1. **A chain of roles.** A run is chained when it is dispatched for work that a previous run's outcome created. Work created by a fixture or a person, a repair re-dispatch, and a Resume are not chained. Without this reading the default `max_chained_roles = 1` would stop every second run. Tested from slice 3.
2. **Work whose run timed out is parked** with a blocker naming the deadline. It is neither held nor repaired automatically.
3. **Work whose run was recovered after a crash is held** and needs an explicit Resume. This follows E7's Section 3.9.4 (a crash ends in the same state as Stop). Consequence worth knowing: after an engine crash, nothing restarts on its own.
4. **Repair count.** An item that always fails is launched once plus `repair_attempts_max` times, so a limit of zero means no repair.
5. **An `assessment` run is performed by the Architect role.** Not yet tested; to be settled before slice 3.
6. **A new trigger generation creates new work and does not lift the dispatch hold** on the abandoned item it replaces.
7. **Exit status 6** for a start that fails before listening, with code `home_unusable` or `listen_failed`. A directory where `store.db` should be is not an exit: the engine stays up in restricted mode and reports the failed step, as D1 §1.4 says.
8. **A well-formed token** is at least 32 visible ASCII characters. Anything else, including an interior space or tab, is refused. The interior-whitespace case is not yet tested.
9. **An unknown `Expect` value** is refused with 417 and code `expect_refused`, after the Host and token checks, and is audited.
10. **Stop and Abandon are two requests.** The first returns the decision and its preview hash; the second, carrying the hash, performs it.
11. **The Verifier's stand-in engine stays in the test tree** through the slice-2 build. It shows the tests can be passed and that each catches a defect. It is not the engine and not a design; the Builder must not copy it in place of building to D1.

Also accepted without a decision being needed: answering a blocker is tested in slice 2 only on an item parked at its repair limit; leaving `awaiting_decision` through the queue is tested in slice 5.

**Consequences elsewhere.** The build spec's layout now shows the scripted adapter under `src/testing/`, as E23 item 4 requires. No change to D1.

---
