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

## E25. Slice-2 review decisions (provisional, 2026-10-01)

**Status: provisional**, on the same footing as E23 and E24. The slice-2 review confirmed three serious defects by running the engine; they go back to the Verifier and Builder before slice 2 merges. It also raised the questions below. The driver applied the Reviewer's recommendation on each. Sean confirms or overturns them.

1. **The engine renews a run's lease itself** at least every third of the lease lifetime while it supervises that run's live process, as D1 §8.3 already says. Only a lease nobody is supervising expires, and the tick's first step then reconciles it through the run-end protocol. A role that never sends a heartbeat does not lose its result for that reason.
2. **M1 roles run without control-plane isolation.** A scripted role runs as the same user as the engine, in a directory under the engine home, and can read the token file. This is known and accepted for M1, where the only role is a test script. Nothing in M1 is evidence for the isolation requirement (D1 §17 item 12); D2 owns it, and no real backend runs before D2 qualifies it.
3. **Engine git never runs code from the repository.** Every git call the engine makes disables hooks and other repository-configured execution. A role can otherwise plant a hook that runs later inside the engine's own process tree, outside any execution domain. Pinned by a test now for the worktree calls and again in slice 3 for the rest.
4. **What a Stop or Abandon confirmation binds** is settled in slice 5: the run's identity, whether it can still be stopped, and the workspace's fate. A run moving from claimed to executing should not by itself make the confirmation stale. Until then the stricter behavior stands; it fails safe.

**Carried to later slices, recorded in `COVERAGE.md`:** a second worktree-removal intent for one run after an ambiguous result (slice 3, journal matrix); the cost of scanning every process on each observation (slice 6, load); unbounded role output (slices 4 and 6).

**Consequences elsewhere.** No change to D1.

---

## E26. Lease expiry and related points (provisional, 2026-10-02)

**Status: provisional**, on the same footing as E23 to E25. Raised by the Verifier while turning the slice-2 review into tests; the driver accepted its recommendations. Sean confirms or overturns them.

1. **Lease expiry is final.** An expired lease is never revived, neither by a role's heartbeat nor by the engine's own renewal. The tick ends the run through the run-end protocol. **Consequence worth weighing:** if the engine stops running for longer than the lease lifetime (90 seconds by default) while the role keeps going, for example because the machine was suspended, every in-flight run is ended when the engine wakes and its work is retried. The alternative is to let the tick re-grant a lease whose process is still alive and supervised; D1 §8.1 can be read either way.
2. **A run ended because its lease expired** has outcome `failed` with reason `infra_error`, unless a valid result was accepted while the lease was live.
3. **The tick reconciles an expired lease even while the engine's own launch is stalled** before the spawn, as D1 §8.1 step 1 says ("even when the owning engine is alive").
4. **Git filter drivers** (which Git LFS uses) are not yet covered by the rule that engine git runs no repository code. Only hooks are pinned. Disabling filters would break LFS checkouts in a governed repository, so the question is decided in slice 3.
5. **The scripted boundary's automatic mode cannot see an unreadable process,** and no reliable same-user rule exists. This is recorded as a limit of the test stand-in, not fixed. Real containment is D2's.

**Consequences elsewhere.** No change to D1.

---

## E27. Second slice-2 review: decisions and a question for Sean (provisional, 2026-10-02)

**Status: provisional**, on the same footing as E23 to E26. The second review of slice 2 confirmed two more serious defects by running the engine (a run whose end failed once is never ended while its role keeps sending heartbeats; engine git runs a program the repository names as its file-system monitor). Both go back to the Verifier and Builder. The decisions below came with them.

1. **A final line without a line ending is still a line.** If a role's last output has no trailing newline when the engine stops reading, it is processed like any other line, whether or not another process holds the stream open.
2. **The engine renews a run's lease while it is preparing that run,** not only once the role is running. Preparing a workspace may legitimately take longer than the lease lasts.
3. **A run ended because its lease expired is treated as recovered,** like a run found after a crash (E7, Section 3.9.4): outcome `recovered`, its work held for an explicit Resume, and no repair attempt charged. This replaces E26 item 2. Charging a repair attempt would let a few machine suspensions park healthy work.
4. **Engine git disables the file-system monitor setting too.** The rule that engine git runs no repository code already covered it in words; the first fix covered only hooks.
5. **Once the engine has decided to end a run, nothing renews that run's lease,** including the role's own heartbeats, and the engine retries the end itself. The lease expiring is the backstop, not the mechanism.

**Question for Sean, to settle before any real backend runs.** The review measured what E26 item 1 costs: with the engine paused for 34 seconds against a 30-second lease, all three in-flight runs were ended on resume, including one whose role had written a valid result and exited cleanly during the pause. That result was refused. On a machine that sleeps, this will happen routinely, and with a real backend the refused result is paid work. Two linked choices:

- Should a run that the engine is still supervising, with a live process, survive its lease expiring (the engine re-grants the lease after checking the process is alive)? D1 §8.1 can be read this way. Recommended yes, before M2.
- After a crash or a pause, should held work resume by itself instead of waiting for an explicit Resume (E24 item 3)? Recommended yes for a pause, where nothing was lost; open for a crash.

Neither changes M1's scripted runs, so the build continues on the stricter rule.

**Added after the Verifier's pass (also provisional):**

6. **A run ended for an expired lease carries no startup-recovery marker.** Its outcome is `recovered`, but the marker that names the restarting engine stays reserved for runs a restart ended, so the two cases remain distinguishable.
7. **A result accepted while the role is still running does not make the run completed if the lease then expires.** Completion needs the role's clean exit. Such a run is `recovered`. This is decided together with the question below, since both concern a paused engine.
8. **This machine's clock steps backwards.** The Verifier measured the WSL2 wall clock stepping back about three quarters of a second every half minute. One timing test was loosened by two seconds to stop a one-in-ten false failure; it still cannot hide a missing renewal. The engine measures grace periods and budgets on the wall clock; moving them to a monotonic clock is taken up in slice 6 with the load work.

**Carried to slice 3, recorded in `COVERAGE.md`:** a workspace path that is itself a symbolic link should be refused, since resolving links lets a failed worktree creation adopt another run's worktree; a transient store failure while recording a role's result drops the result with no retry.

**Consequences elsewhere.** No change to D1.

---

## E28. Slice 2 merged; what its final review carries into slice 3 (provisional, 2026-10-02)

**Status: provisional**, on the same footing as E23 to E27.

Slice 2 was merged after three reviews and two fix rounds, the limit the driver set for one slice. The final review found nothing that should stop the merge and judged the run-ending code "more complicated, and more certain on the paths the tests pin". It named the remaining weakness precisely: a retried step re-reads the store, while some of that step's inputs live only in memory or cannot be repeated. Two serious defects follow from it, both older than the last fix round.

1. **Every step of ending a run must be repeatable.** If any step is repeated after a partial failure, it writes the same facts it would have written the first time. From slice 3 this is tested as a matrix rather than case by case: for each way a run can end, each store transaction on that path is made to fail once, and the final durable facts must equal those of the same ending with no failure, without a restart. Three review rounds each found one more ending that went wrong after a single failure; the matrix is meant to find the rest at once.
2. **An operator's Stop or Abandon, confirmed after a lease has expired but before the tick has acted on it, is recorded as given.** The explicit command wins over the recovery outcome.

**Defects carried to the slice-3 Verifier as failing tests, to be fixed before slice 3 is built on this code:**

- Serious: an Abandon whose worktree removal succeeds on disk but fails to record once is stuck until restart, because the retry cannot issue the same operation twice.
- Serious: a run stopped before its role was spawned, whose final transaction fails once, is charged a ledger row for an invocation that never ran.
- Minor: a Stop confirmed while a deadline end is being retried replaces the outcome already decided.
- Minor: the engine's line reader takes time quadratic in the length of a line.
- Minor: a role that exited cleanly after an accepted result can still end as recovered if the lease expires in the two seconds before the engine acts on the exit.
- Minor: when the clock steps back between reading an expired lease and acting on it, a live run is wrongly marked as ending.

**Consequences elsewhere.** No change to D1.

---

## E29. Slice-3 starting decisions (provisional, 2026-10-02)

**Status: provisional**, on the same footing as E23 to E28. Given to the slice-3 Verifier so its tests have something to pin.

1. **Engine git runs no filter driver from the repository's own configuration.** This closes the question E26 item 4 left open. A clean, smudge or process filter named in a repository's configuration is not run when the engine creates a workspace, takes a snapshot or commits. **Consequence:** a repository that depends on such a filter, which includes any repository using Git LFS, is not supported in M1. Supporting it is a later decision that belongs with the isolation design, where a role can no longer write the repository's configuration.
2. **One intermittent test failure is unresolved.** After the slice-2 merge the suite failed once on `main`, 190 of 191, then passed six times in a row. The failing run's output had not been kept. The runner now keeps every run's full report, and the slice-3 Verifier audits the tests for timing sensitivity on this machine, whose clock steps backwards. Until the failure is identified it is an open item, not a resolved one.

**Consequences elsewhere.** No change to D1.

---

## E30. Slice-3 seam decisions (provisional, 2026-10-02)

**Status: provisional**, on the same footing as E23 to E29. The two slice-3 Verifier sessions fixed these points in `harness/SEAM.md` and their tests and flagged them for the owner. The driver accepted the Verifier's recommendation on each. Sean confirms or overturns them.

**What a project owner will notice:**

1. **At the default setting, every hand-off between roles waits for a person.** With `max_chained_roles` at its default of 1, each candidate's verification and each stage a committed plan registers waits for a "continue" decision. This is the supervised default the design intends. Raising the limit is a policy change that arrives in slice 5.
2. **A crash and a timeout are treated differently.** Work whose run was interrupted by a crash is held for an explicit Resume. Work whose workspace creation was killed at its deadline is repaired automatically. Both follow earlier decisions; the difference is recorded so it is seen.
3. **Merge drivers named by a repository are not run** when the engine rebases, for the same reason as filter drivers (E29 item 1). Repositories that depend on one are not supported in M1.
4. **A Stop that arrives after the engine has already decided how a run ends is refused** (409), so the operator is never told a Stop took effect when it did not.
5. **A request to nominate that comes at the wrong point is ignored without an error** at the standard tier. A visible refusal would be a design change.

**Contract detail, accepted as the Verifier fixed it:**

6. Verifier and Reviewer role path prohibitions are tested in slice 5, with proposal capture.
7. A run whose processes cannot be shown gone before its snapshot is quarantined as failed and never snapshotted; its work is repaired from scratch. Revisit with the E27 question before a real backend.
8. Integration refused because the branch is checked out elsewhere parks the work; retrying re-runs the role.
9. One failed write while recording a role's result is retried.
10. Recovery records the snapshot tree as evidence. Resume does not continue from it in M1. Revisit with the E27 question, since with a real backend that tree is paid work.
11. A violation found in the captured diff is a diff violation; one found outside it is a ref violation. A Builder may write nothing under `.surety/`; an Architect only the design, roadmap and plan folders.
12. A run recovered after its integration had already taken effect ends as recovered with its work integrated, not held: nothing is left to resume.
13. A workspace creation found absent or half-made at recovery is withdrawn, not retried: the run is over by then.
14. Before an allowed retry, an operation's status is `intended`, or `partial` after a partial result. A later integration of the same work into the same ref names the failed one as its prior, which becomes superseded.
15. The plan file's format, and a malformed plan being a diff violation.
16. Until slice 5 adds the stage gate, a Builder's work completes when its candidate's verification completes. This is interim by necessity.

**Timekeeping, brought forward.** This machine's wall clock now steps back about 1.8 seconds every half minute. The engine measures every in-process duration (tick and step budgets, grace periods, drains, retry intervals) on the monotonic clock from slice 3, not slice 6 as E27 item 8 said. Stored timestamps and lease expiries stay on the wall clock. The tests tolerate a 2-second step; fixing the machine's time synchronisation is the owner's.

**Still open:** the intermittent failure of E29 item 2. The timing audit removed a plausible cause without proving it was the one.

**Consequences elsewhere.** No change to D1.

---

## E31. Build pace (decided by Sean, 2026-10-02: O14)

**Gap.** Two slices and the tests for a third took about a day and a half of agent time. Writing tests was the slowest step: to show its tests worked before any engine existed, each Verifier also built a stand-in engine and hundreds of deliberately broken variants of it. Slice 2 took three reviews and two fix rounds. Agents ran one at a time.

**Decision (O14).** In Sean's words: "one review per slice. drop the stand in engine and self check. and shrink the amount of test. go in parallel and use the shim."

**How it is applied, from slice 4 onward.**

1. **One review per slice.** After the build, one Reviewer pass. A finding confirmed as serious becomes a failing test and gets one fix, judged by the tests and not reviewed again. Everything else is recorded for the next slice's Verifier.
2. **No stand-in engine and no self-check.** Verifiers no longer write, extend or run them. The existing ones under `harness/selfcheck/` are frozen and may be deleted. A test's own defects surface during the build and are handled by the objection procedure.
3. **Fewer tests.** A Verifier writes the fewest cases that pin each row's required observable result: one test per row, with a separately reported case only where the acceptance plan names a finite case set. No generated matrix beyond what the plan requires, and no cases from the Verifier's own reading of the design. The tests already merged for slices 1 to 3 stay as they are.
4. **Agents run in parallel.** The next slice's Verifier writes its tests in a separate working copy while the current slice's Builder builds.
5. **Power loss (acceptance row M67) is tested with an unprivileged shim** that intercepts file writes and discards what has not been synced when the test cuts power. It needs no administrator rights. The Verifier must show the shim is faithful: that it discards an unsynced write and keeps a synced one, for SQLite and for git.

**What this trades away, recorded so it is a choice and not an accident.** The self-check caught mistakes in the tests in every slice, and slice 2's second and third reviews each found serious defects the first had missed. With these changes such defects are more likely to be found later, during a later slice's build or in use, and less likely to be found before merging.

**Consequences elsewhere.** `docs/spec/M1-build-spec.md` section 4 gains a paragraph stating the procedure. E28 item 1's fault matrix stands for the endings already covered and is not extended.

---

## E32. Slice-4 seam decisions (provisional, 2026-10-02)

**Status: provisional**, like E23 to E30. The slice-4 Verifier fixed these in its tests and flagged them; the driver accepted its recommendations. Sean confirms or overturns them.

1. **What the power-loss test models.** File content is durable as of its last sync; a file never synced is empty after a cut; file names are durable at once. It does not model the loss of a rename or a directory entry, torn writes, or whether this machine's storage honours a sync. An M67 pass therefore says the engine syncs what it must before relying on it, and nothing about the host. The M1 report must say so.
2. **The engine cannot check that storage honours a sync** (D1 §6.1 asks it to). No process can observe that without a real power cut. What it can do is refuse an engine home on a kind of filesystem known not to persist or not to give sync guarantees (memory-backed, network, or user-space filesystems). Recommended, not yet tested: it needs one new acceptance case, which is Sean's to add.
3. **A stream of role output has an identity before it is published,** carried by its record row. A stream cut by a crash, or longer than the 8 MiB a transcript retains, is never published: that run has no transcript the API serves, though its chunks stay on disk. Accepted for M1; revisit before a real backend.
4. **Budgets.** With the scripted adapter the enforcement point is a usage observation. A run stopped for its budget is `stopped` with reason `budget`; its work is parked with the limit named, offering retry or cancel. A project over budget is not dispatched and its work stays eligible. Whether an estimated cost counts against the verified daily limit is left open until M2.
5. **A result whose recording keeps failing** is retried for a bounded time, then the run ends failed with the reason stated, the result still in the transcript, and one repair.
6. **New public surface the design does not list:** a route to rebind a project to a moved repository, the `surety store backup` and `restore` commands with a manifest, and exit status 7 for an incomplete backup or restore.
7. **Usage is marked incomplete** whenever the engine, not the role, ended the invocation.

**Two observations for the Builder, made by the Verifier under the shim:** the current engine cannot restart after a cut, because the lock file is written and renamed without a sync; and a workspace does not survive a cut, because git does not sync the files of a new worktree.

**Consequences elsewhere.** No change to D1.

---

## E33. Slice 3 merged; what its review carries into slice 4 (provisional, 2026-10-02)

**Status: provisional**, like E23 to E30 and E32.

Slice 3 was merged after its one review (E31). The review confirmed as sound: every ref move is a compare-and-swap; what is validated is exactly what is committed; a retried commit is the identical commit; hostile git settings in the engine's environment never reach git; no in-process timing uses the wall clock.

1. **Serious, carried to slice 4 as a failing test and fixed there first.** Engine git still runs a filter driver planted in the repository's configuration when the configuration spells it in a way the engine's own reading misses (a section name in capitals, two section headers on one line, an include on one line, an included file behind a symbolic link). The rule of E29 item 1 is about what git honours, not what the engine can parse.
2. **The nomination finalizer's inputs are frozen at intent,** like every other finalizer's (build spec section 6, correction 14). Today it reads the set of work it moves from live state when it runs.
3. **Accepted as built, noted so they are seen:** while a finished role's work is being snapshotted, validated and integrated, its lease is not renewed and lease-expiry reconciliation leaves the run alone; a run whose end throws during startup recovery is logged and retried rather than keeping the engine restricted; raising a policy limit and answering a checkout observation are refused until slice 5.

**Consequences elsewhere.** No change to D1.

---

## E34. Slice-5 seam decisions (provisional, 2026-10-02)

**Status: provisional**, like E23 to E30, E32 and E33. The slice-5 Verifier fixed these in its tests and flagged them; the driver accepted its recommendations. Sean confirms or overturns them.

1. **The governed policy file is always protected,** whatever the protected roots are changed to.
2. **How a `fix` completes is undecided.** A fix has no stage and so no stage gate; for now it completes with its candidate's verification, with no evidence of its own. To decide before M2; the Verifier suggests a fix completes when the finding it fixes is resolved.
3. **A T3 security review is a sign-off with its own scope,** `security`, which the design's list of sign-off scopes lacks.
4. **Who records the Alpha exception for a High finding** is not settled by the foundations. In M1 it enters as a test fixture. Recommended for later: the human owner, through a finding disposition.
5. **Adopting an out-of-band commit invalidates the passed results of the candidate the open lineage started from.** Whether it should reach every candidate not yet superseded is open.
6. **Dispositions, severity lowerings and exclusions start with a role's proposal;** the engine then asks the human to approve or reject. A human cannot accept or defer a finding without a Reviewer having proposed it. Accepted for M1.
7. **A fix is resolved only by a gate evaluation in which the check the finding names passes.** A finding that names no check can only be deferred, accepted or excluded.
8. **When the effect of an approved check correction is invalidated, the proposal goes back to awaiting approval.** The design's table has no such edge; without it the proposal could never be approved again.
9. **A Stop or Abandon confirmation binds** the run, its workspace, what the workspace holds, and what will happen to each. Whether the run is claimed or executing is not bound. This is the reading of E25 item 4.
10. **New public surface:** routes to evaluate a gate, to propose an Alpha authorization, and to answer a batch of decisions; the policy route answers 202 for a governed edit and asks for confirmation on a widening.

**Scheduled with the slice-5 build:** seven existing test files assert things slice 5 changes on purpose. Stage work will stay `verifying` until its stage gate is satisfied (replacing the interim rule of E30 item 16), and a Verifier or Reviewer run may no longer write outside the protected set. A short Verifier pass updates those files just before the slice-5 build starts; changing them earlier would break slices 3 and 4.

**Not written, by the lean rules, and recorded in `COVERAGE.md`:** about fifteen cases the plan's rows mention only in passing, and the nomination finalizer freezing its inputs (E33 item 2), which needs more machinery than one case.

**Consequences elsewhere.** No change to D1.

---

## E35. A gap the journey test exposed (closed by E36 item 3, 2026-10-02)

Writing the end-to-end test for M1 (acceptance row M01) showed that **nothing in the engine creates review work.** A T2 candidate needs a Reviewer's sign-off before its gates can be satisfied, and the engine registers a candidate's verification at nomination, but no source says what schedules the review. The tests create it with a fixture.

**For Sean to decide, before M2:** the engine registers a review for each candidate at nomination, as it does verification, at the tiers that require one. This is the driver's recommendation; it is not applied, because it adds behavior no acceptance row asks for.

Also noted: the journey reads the event history from the store, because the public event stream and the candidate and gate reads belong to slice 6.

---

## E36. Sean's decisions on the open items (decided by Sean, 2026-10-02)

Sean went through the items waiting for him one at a time. Each entry records his choice and what it changes.

1. **Browser driver for row M68: Playwright.** One development dependency, pinned to an exact version, used only by the acceptance tests. It drives Chromium and Firefox, the two browser families whose versions the M1 report records. The engine's runtime dependencies stay at `better-sqlite3` alone. This settles the first open item of build spec section 11. Pinned at 1.58.2, the release whose Chromium (145) and Firefox (146) builds are already on this machine, so nothing is downloaded; a later bump is an owner change.
2. **Load limits for row M71: 5 projects, 20 connected clients, a 1 GB database.** These are the limits the M1 report claims; nothing larger is qualified. The latency bound stays at its default of 250 ms. This settles the second open item of build spec section 11.
3. **The engine queues a candidate's review when its verification passes** (closes E35). At the tiers that require a Reviewer's sign-off, the engine registers the review work itself, once the candidate's verification has completed with its required checks passed. A candidate whose verification fails gets no review. This replaces the driver's earlier suggestion in E35 of registering it at nomination: the Reviewer judges what the Verifier produced, and a real backend should not be paid to review a candidate that then fails its checks. **Built in slice 5.** The Verifier adds one case and makes the journey test (M01) stop creating the review with a fixture.
4. **A fix completes when its finding is resolved** (settles E34 item 2). Fix work is complete only when the check its finding names passes in a gate evaluation (E34 item 7). Until then it stays open and is repaired like other work. This replaces the interim rule under which a fix completed with its candidate's verification. **Built in slice 5**, with one changed case from the Verifier.
5. **Only the human owner approves an Alpha exception for a High finding** (settles E34 item 4). A Reviewer proposes it and the owner approves or rejects it through the finding-disposition flow of E34 item 6. No role records the exception alone. **Built in M2;** M1 keeps entering the exception as test data, and no M1 row changes.
6. **A healthy run survives a pause; a crash still waits for Resume** (answers the question of E27). After the engine has been paused, for example because the machine slept, a run whose lease expired is not ended if this engine launched it and its process is still alive and supervised: the engine renews the lease and the run continues. A run whose process is gone is ended as before. After a crash nothing changes: interrupted work is held for an explicit Resume (E7, E24 item 3). This replaces E26 item 1 ("lease expiry is final") for supervised live runs. **Built at the start of M2, before any real backend runs.** M1 keeps the strict rule its tests pin; E30 items 7 and 10 are revisited with it.
7. **The engine refuses an engine home on a kind of filesystem known to be unsafe** (settles E32 item 2). Memory-backed, network and user-space filesystems, which include a Windows drive seen from inside WSL, are refused at start with a clear message. Any other kind starts normally; the engine still cannot check that storage honours a sync, and the M1 report says so. **Built in slice 6**, with one new acceptance case. Where the system temporary folder is itself memory-backed, the tests place their engine homes elsewhere.
8. **The provisional decisions of E23 to E30 and E32 to E34 are confirmed as M1's rules**, except where an item above replaces one (items 3 to 7) and where an entry itself says a point is open. Each stays reversible: overturning one is a changed test. Sean looks again at the ones a project owner notices during his hands-on run at the end of M1: every role hand-off waiting for a person at the default chain limit; timed-out work being parked; the two-step Stop and Abandon; no support for Git LFS or custom merge drivers; a damaged token file being refused, not replaced; a finding disposition needing a Reviewer's proposal; budget stops being parked; roles running without isolation; and, from the slice-4 build, a workspace half-made at a power cut being raised as a decision instead of withdrawn.

**Still open after this entry:** the intermittent test failure of E29 item 2. The slice-4 Builder saw a similar single failure (a wait that timed out after 2.7 seconds instead of 30 while the engine was healthy) and attributed it to this machine's clock stepping back, which the harness's deadline reads. That is the likeliest cause and is not proven. It also found that an engine whose start-up wait throws is not cleaned up by the harness; both go to the next Verifier pass. Whether an estimated cost counts against the verified daily budget stays open until M2 (E32 item 4).

**Consequences elsewhere.** Build spec section 11 marks the browser driver and the load limits as decided. No change to D1.

---

## E37. Slice-4 review: what is fixed before the merge and what is carried (provisional, 2026-10-02)

**Status: provisional.** The driver's defaults under Sean's delegation, like E23 to E30. Sean confirms or overturns them.

The one review of slice 4 (E31) found five serious defects and reproduced each by running the engine. Four are fixed before slice 4 merges, each with one new test and one fix. The fifth is not fixed in M1; the reason is given so it is a choice.

**Fixed before the merge:**

1. **Engine git never contacts a remote and never runs a program a remote's configuration names.** In a partial clone, git fetched a missing object on demand and ran the program named as the remote's upload-pack, from workspace creation and from every object lookup. The rule that engine git runs no repository code covers this. **Consequence:** a partial clone is not supported in M1, like a repository using Git LFS (E29 item 1). An object that is not present is missing; the engine does not fetch it. The seam's statement that no git call M1 makes can reach a remote was false and is corrected.
2. **Redaction covers a secret as the role's output encodes it.** A held secret containing a character that JSON escapes (a quote, a backslash) reached the transcript on disk and the API in its escaped form, because the transcript is redacted as raw bytes while roles write JSON lines. A transcript line that parses as JSON is redacted on its decoded values; any other line is redacted as bytes. Neither the raw nor an escaped form of a held secret may be on disk or served.
3. **A usage observation the engine could not record is never lost silently.** One failed store write dropped the observation, the ledger then claimed complete usage, and the run's budget stop did not happen. The engine retries the write for the bounded time it uses for a result (E32 item 5). After one failed write the durable facts are those of the same run with no failure (the rule of E28 item 1). If the observation still cannot be recorded, the run is stopped as it is when the budget cannot be read, and its usage is marked incomplete.
4. **A backup is labelled complete only if every commit its manifest lists is in the repository.** A backup taken after a listed commit had been pruned was labelled complete, exited 0, and could not be restored.

**Not fixed in M1, for Sean to confirm:**

5. **A filter driver can still run if the repository's configuration is rewritten while the engine is running git.** The slice-4 fix asks git which filter drivers it sees and switches those off, in two steps; a process that swaps the configuration between the steps gets its driver run. The review showed the window is wide. Closing it inside M1 means the engine no longer using any git command that applies filters, which is a rewrite of the git layer. The attacker here is a process running at the same time as the engine with write access to the repository's configuration. In M1 that is a role with no isolation (E25 item 2), which can already do anything the user can. E29 item 1 already ties filter support to the isolation design, where a role can no longer write the configuration. So M1's rule is: no filter driver runs from the configuration as it stands when the engine calls git. The race is carried to D2 as a named requirement. The M1 report states the limit.

**Carried, not serious:**

- An invocation with unknown cost and unknown token counts adds nothing to the unknown-token budget, so it is bounded only by time (E16b says tokens and time). Decided with E32 item 4, before M2.
- A correction with a negative amount has no effect on totals. Whether a correction may lower a total is open; decided before M2.
- A restore does not carry unpublished streams, so their chunk receipts point at bytes that are absent and nothing reports them missing.
- New directories under the engine home are created without syncing the directory above them. The power-loss shim does not model names, so this is unconfirmed.
- A result record is published even when the result is then refused because the lease is closing; and if writing the result record fails, the result is accepted with no record. Both go to the next Verifier pass.
- A workspace half-made at a power cut is raised as a decision (already noted in E36 item 8).

**Consequences elsewhere.** No change to D1.

---

## E38. Review queuing and fix completion: detail fixed by the Verifier (provisional, 2026-10-02)

**Status: provisional.** The Verifier turned E36 items 3 and 4 into tests and raised the points below. The driver accepted its recommendation on each. Sean confirms or overturns them.

1. **The review waits for the checks the stage scope requires,** where the stage scope and the Alpha scope differ. That is the gate the engine evaluates itself when verification completes.
2. **A candidate with no declared check gets no review.** Nothing was verified, and its gate can never be satisfied.
3. **The queued review is chained work.** At the default chain limit it waits for a "continue" like every other hand-off (E30 item 1).
4. **A candidate whose check fails and later passes gets its review then.** The rule is about the state of the checks, not the first result.
5. **One review item per candidate in M1,** at T3 as at T2. One per required sign-off is a later refinement.
6. **A fix names its finding** and completes in the gate evaluation that resolves it. A fix that names no finding, or whose finding names no check, can never complete under E36 item 4. Accepted for M1; work the engine creates for a fix must name its finding.
7. **A finding that is reopened after its fix completed needs a new fix item.** Complete is terminal.

**Left open, none needed for M1:** what happens to a queued review whose check later fails or is invalidated; whether the engine sends a fix back to its Builder when the named check fails (decided with the real check runner, since nothing in M1 re-dispatches work on a check result).

**A gap of the same kind as E35, for Sean:** nothing in the engine creates fix work when a finding is dispositioned "fix"; the tests create it with a fixture. Recommended: the engine registers it when the disposition is recorded. Not applied; to decide before M2.

**The harness failure the slice-4 Builder saw is explained.** Harness waits were timed on the wall clock, and this machine's clock jumps forward by about 15 minutes when the virtual machine resumes after the host sleeps (three times in the last day). A wait then expires at once. Harness waits now use a monotonic clock, and a start that fails no longer leaves an engine running. This does not explain the earlier failure of E29 item 2: the clock did not jump in that window. That one stays open. A host sleep during a test run can still fail cases legitimately, because leases and stored timestamps are on the wall clock by decision.

**Consequences elsewhere.** No change to D1.

---

## E39. Slice-6 seam decisions (provisional, 2026-10-02)

**Status: provisional.** The slice-6 Verifier fixed these in its tests and flagged them; the driver accepted its recommendations. Sean confirms or overturns them.

1. **The engine serves no page of its own in M1.** The page the browser test loads is the test harness's, served through a harness flag. A production M1 engine serves the API only.
2. **The executable contract is new public surface:** the commands `surety contract export`, `check` and `appendix`, exit status 8 for an invalid contract, and a committed contract file and generated appendix under `packages/engine/api/`. D1's hand-written Appendix A stays in D1 and has no authority over the generated one (resolution note section 3).
3. **A stream client that takes nothing for 5 seconds while data waits is disconnected,** with a cursor it can resume from. D1 gives no number.
4. **Filesystem kinds refused for the engine home** (E36 item 7): `tmpfs`, `ramfs`, `nfs`, `nfs4`, `cifs`, `smb3`, `fuse`, `fuse.<subtype>`, `fuseblk`, `9p`. The refusal is `unsafe_filesystem`, exit status 6, before anything is written. `fuseblk` includes an NTFS drive mounted through ntfs-3g.
5. **How the latency test judges** (row M71): each sample is paired with a control request inside the test process; a sample whose control took over 50 ms is void; every valid sample must be within the 250 ms bound, with nothing subtracted; too few valid samples fails the case as not judged. The 1 GB store builds in about 2 seconds on this machine.
6. **A historical observation enters through a fixture** in row M70, since M1 has no observation job or history.
7. **A process may be started only under `src/invoke/`, in `src/git/exec.ts` and under `src/testing/`.** This places the scripted notification sink of slice 5 in the testing folder.

**One addition the driver is making:** D1 section 11.3 lists reads for a project's decisions, work, operations, gates and environments, and no acceptance row names them, so none was pinned. Without a read for decisions nobody can see an open decision or its preview except in the store, and Sean's hands-on run needs it. One case for `GET /v1/projects/:p/decisions` is added before the slice-6 build. The other reads stay unbuilt in M1 unless Sean asks for them.

**What M1's tests cannot show, recorded for the report:** that the engine's durations are on a monotonic clock (the controlled clock only moves forward); that storage honours a sync; a block of the event loop that falls between two latency samples.

**Consequences elsewhere.** No change to D1.

---

## E40. Journey first, scope frozen, and an explicit list of what M1 does not claim (2026-10-02)

**Status: applied by the driver on Astra's recommendation, which Sean relayed; one point waits for Sean.**

Astra reviewed the build at the slice-4 point and made three observations. The verification machinery had grown large: about 7,500 lines of stand-in engine beside about 11,800 lines of engine. Detailed component work came before the complete workflow was proven, so two workflow gaps (nothing queued a review; nothing creates fix work) surfaced only when the journey test was written. And cutting test cases under E31 without cutting scope can hide incompleteness. She judged the core safety mechanisms justified by what the slice-4 review reproduced. Her recommendation: finish the current fixes, make the complete scripted journey the central target as gates land, freeze additional scope, keep focused tests for confirmed defects, and explicitly defer capabilities whose assurance is deferred.

**Applied:**

1. **The journey is the first target of slice 5.** The Builder makes the end-to-end journey (row M01) pass before the other slice-5 cases. The journey's manifest entry moves from slice 7 to slice 5; slice 7 keeps the same journey observed through the public reads that slice 6 adds. The order in which the acceptance plan and build spec section 9 list the slices is otherwise unchanged.
2. **Scope is frozen.** From here a new finding is either something the journey needs or a recorded deferral. The one addition still in progress is the read for a project's open decisions (E39), which the journey's human steps need.
3. **What M1 does not claim is listed.** `docs/acceptance/reports/M1-not-claimed.md` lists every case the coverage record marks as not written, classed as unreachable in M1, real behaviour that is not tested, or not observable from outside. Behaviour in the second class is not claimed by M1, the Builder does not build it for its own sake, and the M1 report carries the list.
4. **The frozen stand-in engine is deleted** from the test tree (E31 allowed it). It remains in git history.
5. **Confirmed defects keep their focused tests,** as in E37.

**Waiting for Sean:** whether the journey gains a second path in M1, in which a finding is raised, the owner approves "fix", the engine creates the fix work, a Builder fixes it, the finding is resolved and the gates pass. This would settle the gap recorded in E38 (the engine creates fix work when a finding is dispositioned "fix"). Recommended yes. The alternative is to list the fix loop as not claimed in M1.

**Consequences elsewhere.** No change to D1.

---

## E41. Slice-5 review: what is fixed before the merge and what is carried (provisional, 2026-10-02)

**Status: provisional.** The driver's defaults under Sean's delegation. Sean confirms or overturns them.

The one review of slice 5 found five defects and reproduced each by running the engine. All five are fixed before slice 5 merges, each with one new test and one fix. The fifth is not serious by E31's definition; it is fixed anyway because it would leave ordinary work stuck during the journey (E40).

1. **An engine never signals a process that another engine home started.** When it reconciled a journal operation, an engine killed every git process on the machine that carried another engine's marker, whatever its home or repository. The code is from slice 3; slice 5 made it frequent. In the other engine a killed read was reported as unknown, so a snapshot failed or a repository was called unreadable, and a killed write could leave an operation ambiguous. **This is the cause of the failures seen when several test files ran at once** (in the slice-5 build and in the driver's rerun), and it is the likeliest cause of the unexplained intermittent failures of E29 item 2 and E36, which no longer need another explanation though none of those runs was kept to prove it. An engine may end only processes of its own home.
2. **A gate input that could not be read makes the gate not satisfied.** With the repository's git not answering, the check for an unauthorized protected set was skipped and the stage gate was satisfied, completing the stage. An unknown is not a pass (the standing rule). The same holds for every other input the evaluation reads from git or from a record.
3. **A quarantined Verifier's or Reviewer's report is recorded like any other.** A Verifier whose process could not at first be shown gone lost the findings it had reported, and its verification still completed; a Critical finding vanished and the gate was satisfied. Such a run keeps its earned outcome (slice-5 seam), so its report is recorded with it, and the work it verifies does not complete before that. Decided by the driver; the alternative was to hold the verification until the quarantine clears.
4. **A sign-off binds the acceptance content its run was started on.** A Reviewer's sign-off was bound to the content in force when the report was recorded, so a check added while the review was under way was covered by a sign-off that never saw it. The content is fixed when the run is launched (the rule that inputs are frozen at intent, build spec section 6). If the content has changed by the time the report arrives, the sign-off does not count toward the new content.
5. **A stage gate blocked by an outside change or a pending git operation is evaluated again when that clears.** Nothing marked the evaluation stale, so the tick never looked again and the stage stayed in verification although a gate requested by route was satisfied. D1 section 9.5 lists both as causes of staleness.

**Carried, not confirmed by running:** an authorization proposed under one protected version is issued after an evaluation under the next and still records the first (nothing consumes an authorization in M1); a failed read of both governed files makes a required-set change look like no change; an ancestry pair not yet recorded makes a requirement count as not started where D1 section 9.1 asks for an incomplete scope; a finding from a run whose work names no candidate applies to no candidate.

**Design questions for Sean, not applied:** a Reviewer can lower a finding from Critical to High alone, where the foundations (section 6.3) say lowering for the relevant stage needs the human; a tightening approved by a Reviewer is applied onto the current head without its classification being checked again.

**Checked and found sound by the review:** answering decisions (preview hash required and recomputed, stale answers refused, batches all or nothing); effects revalidated before they run and never run twice; approval authority; check states; severity and disposition authority apart from the case above.

**Consequences elsewhere.** No change to D1.

---

## E42. Slice-6 review: what is fixed before the merge and what is carried (provisional, 2026-10-02)

**Status: provisional.** The driver's defaults under Sean's delegation. Sean confirms or overturns them.

The one review of slice 6 found three serious defects and reproduced each by running the engine. All three are fixed before slice 6 merges.

1. **A quarantined transcript is not served by the output tail either.** After a detector marked a run's transcript as holding a secret, the record read refused it and the run's tail still returned every byte. A quarantined record is served by no route.
2. **The engine does not read a repository's object files itself; it asks git, within a deadline.** To let a backup finish while one project's git was held (an expectation of the row M71 test, not of the acceptance plan), the slice-6 build added its own reader of git's object store. The review showed two serious defects in it on first inspection: a corrupt commit was reported present, so a backup that could not be restored was labelled complete; and a link in the repository's pack directory could exhaust the engine's memory or hang the backup for ever. A second implementation of git inside the engine, parsing files a role can write, is machinery the scope freeze of E40 argues against. It is removed. The running engine's backup checks each listed commit with engine git, without blocking the event loop and within the git deadline. **A commit git cannot confirm in time is not confirmed, and the backup is not labelled complete** (E37 item 4; unknown is a value). The row M71 case is changed to match: with one project's git held, the backup ends within a bound, does not claim to be complete, and the latency bound holds throughout.
3. **A backup started in a running engine always ends.** Whatever a repository's files are (a pipe, a device, a link), the backup ends within a bound with a truthful label, the engine's memory stays bounded and health keeps answering. With item 2 this follows from the git deadline; it is pinned by its own case.

**Detail the Verifier fixed while pinning items 2 and 3 (provisional):** the running engine's backup emits one `engine.backup` event when it has ended, labelled `complete` only if git confirmed every listed commit as a commit, otherwise `incomplete_for_recovery` (the command's label, reused); **the label follows git both ways**, so a repository holding an odd file git ignores (a pack index linked to `/dev/zero`, which git reports as too small) is still `complete`, and what the review's case pins is that the backup ends and memory stays bounded; a pipe where git itself waits ends the backup at the git deadline. The harness `tick()` helper assumes no engine-requested tick is under way when it returns, which is not always so; recorded as a harness weakness, not fixed.

**Carried, not serious:** the status line shows "waiting on you" for a project whose repository cannot be read, with a decision nobody can answer, where D1 section 12.3 says "refused" (already on the not-claimed list); an observation dated in the future reads as fresh; a record file replaced by a pipe can block the post-write scan or a backup copy; VM shared-folder filesystem kinds (`virtiofs`, `vboxsf`) are not on the refused list of E39 item 4.

**Design questions for Sean, not applied:**

- **Any local process can obtain the operator token from the bootstrap route.** The route trusts request headers that a browser cannot forge and any other program can. That defeats the token file's permissions for another user of the same machine, and for a role once roles are isolated (D1 section 17 item 12). The build matches D1 section 11.1 and the resolution note's R6, which defend against web pages, not local programs. To settle with the isolation design, before the UI ships or a real backend runs. The M1 report states it.
- **Refused requests are audited without limit.** A web page that sends unauthenticated requests makes the store grow by about 1.6 KB per request, at several hundred requests a second. The seam requires the audit; whether to rate-limit or coalesce it is open.
- **`surety contract check --file` verifies a contract's tables against the engine and only the names of its transitions, decisions, events and settings.** A document that contradicts the engine's lifecycle can pass. The command reports those parts as not checked; the committed contract is still compared with the engine's export.

**Checked and found sound by the review:** the stream redactor after the Builder's change (4,500 fuzzed secrets, none leaked); the order of the boundary checks and the defensive headers; reads scoped by project and safe against links and pipes; the event reader; the unsafe-filesystem refusal running before anything is written; the committed contract and appendix equal to what the engine generates.

**Consequences elsewhere.** No change to D1.

---

## E43. The engine creates fix work; the journey covers the fix loop (decided by Sean, 2026-10-02)

**Decision.** When a finding's disposition "fix" is recorded, the engine registers the fix work itself, naming the finding (E38 item 6). **Driver's reading, provisional (2026-10-02, after the Builder found the two sources disagree):** a Reviewer's "fix" is recorded at once with the Reviewer's authority, as the slice-5 seam (section 74) and row M42 already pin, because asking to fix a finding relaxes nothing; the human's step is the chain boundary, where the engine-made fix work waits for "continue" at the default chain limit (E30 item 1), like the engine-made review (E36 item 3). E34 item 6's rule that the human approves a disposition stands for `accept`, `defer` and exclusions. A fix disposition the human approves from a proposal creates the work in the same way. The stage's work completes when the stage gate is satisfied on the candidate that holds it by ancestry, which after a fix is the fix's own candidate. This closes the gap E38 recorded, the second of the two workflow gaps Astra's review named (E40). Built before M1 is accepted.

**The journey gains a second path.** A Reviewer raises a finding against the candidate with disposition "fix"; the engine creates the fix work and the owner lets it through at the chain boundary; a Builder run fixes it; the finding is resolved by the gate evaluation in which its check passes (E34 item 7, E36 item 4); the fix completes; the stage gate and the Alpha authorization are satisfied. The end-to-end test (row M01) covers this path as well as the path where nothing goes wrong.

**Detail the Verifier fixed (provisional):** the engine-made fix item carries trigger `("finding", <finding id>, 1)` and waits at the chain boundary; **at T2 and T3 the integration of a fix that names a finding is a cadence point**: it nominates the integrated revision (`engine_cadence`) with verification work and lineage succession as a stage does, since nothing else would nominate the fixed code and a one-stage project could never close the loop (a fix naming no finding, and a Builder's `nominate: true` at T2, still nominate nothing); the stage's work completes on a satisfied stage evaluation of any candidate whose revision is, or descends from, the stage's integrated revision. In the journey the Verifier raises the finding and the Reviewer proposes `fix` by its id, because a finding's id is not known to the report that raises it; a result form in which a Reviewer raises and dispositions a finding in one report is a later name, if wanted.

**Consequences elsewhere.** `docs/acceptance/reports/M1-not-claimed.md` and the M1 report are updated when the path passes. No change to D1.

---

## E44. Sean's decisions at the end of the M1 build (decided by Sean, 2026-10-02)

1. **The bootstrap-token exposure is accepted for M1 and becomes a requirement of the isolation design.** The browser bootstrap route (D1 section 11.1, resolution note R6) trusts request headers that a browser cannot forge and any other local program can, so any process that reaches the loopback port can obtain the operator token (E42). Nothing changes in M1. D2 must ensure that an isolated role cannot reach that route, and settles the question of other users of the same machine. The M1 report states the exposure.
2. **The provisional decisions of E37, E41 and E42 are confirmed as M1's rules,** including the deferrals: the filter-driver race carried to the isolation design (E37 item 5); partial clones unsupported in M1 (E37 item 1); refused requests audited without limit and the contract checker's depth (E42). **To revisit before a real backend runs:** a Reviewer lowering a finding from Critical to High alone, and a tightening a Reviewer approved being applied without a second classification (E41). Each stays reversible; an overturned one becomes a changed test.
3. **The reads for work items and gate reasons** (not-claimed class B, first in the Verifier's ranking) are decided after Sean's hands-on run.

## E45. M1 accepted (decided by Sean, 2026-10-03: O15)

Sean ran the hands-on walkthrough (`docs/acceptance/reports/M1-hands-on.sh`, both paths) on 2026-10-03 and accepted M1 at `main` revision `a2583a6` (engine and tests as of `17c6dc7`; `npm test` 801 of 801 acceptance tests in 124 files, 79 of 79 unit tests). The claim accepted is the one in section 1 of `docs/acceptance/reports/M1-report.md`: the kernel behaves as the acceptance plan requires on a scripted adapter at the recorded load limits. It claims no real agent, no deployment and no completed phase; `docs/acceptance/reports/M1-not-claimed.md` lists what the suite does not cover.

**Carried into M2 planning:** the decisions marked "to revisit" or "before M2" in E32, E36 to E39, E41 to E44; the extra reads (E44 item 3); the fix-loop details still provisional (E43: a fix's integration nominates at T2 and T3; a Reviewer raises a finding and dispositions it in separate reports); the observation that the engine evaluates a stage gate by itself at a check's execution rather than at a verification's completion (the seam's section 70 wording).

---

## E46. Astra's milestone assessment of M1 (relayed by Sean, 2026-10-03)

Astra assessed the accepted M1 from the final report, the repository changes and spot-checks of source and tests, without rerunning the suite. Her conclusion: "M1 is a credible kernel milestone, and the core engineering effort has paid off." What changed her assessment since E40: the complete workflow exists (the engine creates verification, review and fix work itself, and the journey covers a finding blocking progress, a fix producing a successor candidate and evidence resolving the finding); there is measurable evidence (801 acceptance and 79 unit tests, the walkthrough, the latency figures); and the project corrected overengineering (the stand-in engine and the custom git-object reader removed). She still holds that the early verification process was heavier than necessary, and that the kernel's main mechanisms have earned their place: the reviews found real failures (lost accounting, leaked secrets, incorrect acceptance, interference between engines) that recovery, ownership and evidence checks address directly.

**Her remaining concern is the transition to real agents:** the 18 real-behaviour cases no test establishes (rejection answers, some stale-decision dependencies), the missing operational reads, and the accepted isolation limitations deserve deliberate prioritisation before real-agent use.

**Her priorities for the next milestone, in order:** qualified isolation; trustworthy real check execution; enough visibility to explain blocked work; then one backend on one small project before expanding capabilities.

---

## E47. The reads for work items and gate reasons (decided by Sean, 2026-10-03)

Settles E44 item 3 after the hands-on run and Astra's third priority (E46). Two reads D1 section 11.3 lists and no acceptance row named are built now, with one case each: a project's work items (each with its kind, status, subject, and when blocked the blocker's reason and the decision it waits on) and a candidate's gate evaluation with its reasons, as a read that evaluates nothing. The other reads D1 lists (operations, one decision by id) stay on the not-claimed list.

**Detail the Verifier fixed (provisional):** the work read is a flat list in creation order with a `status` field (D1's "by status" grouping is a client's projection; the phase plan with stages is not included); "no evaluation yet" on the gate read is 404 `not_found`, told from a missing route by its `subject` naming the candidate and the gate kind, since A.7 has no closer code; the engine-owned `chain` column is exposed in the work read. The M1 report keeps its accepted text and gains an after-acceptance note when the reads pass.

---

## E48. M2 opens: the hardening slice and the D2 brief (decided by Sean, 2026-10-03)

1. **The triage of `docs/spec/M2-input-triage.md` is confirmed as drafted.** Bucket A (M24 marker tamper; M28 replay revalidation against the protected set at integration; the stale-preview facts of the three protected-check corrections and the policy widening; the answer "reject" for all seven kinds offering it; M41 no reuse across protected-check versions; about 14 cases) is the first slice of M2, "hardening before a backend", built under the M1 procedure (Verifier, Builder, one Reviewer pass, E31/E40) before any backend runs. Bucket B follows in M2 proper in the triage's order; bucket C stays recorded with the design or situation that reopens each entry.
2. **The D2 design brief is drafted now, alongside the hardening slice,** and D3 (check runner, diff classifier) after D2's execution boundary is fixed. D2 covers the adapter contract, control-plane isolation and the execution boundary, and settles the deferrals that name it: lease expiry after a sleep (E36 item 6), the Alpha exception (E36 item 5), the bootstrap-token exposure (E44 item 1), the filter-driver race (E37 item 5), partial clones and LFS (E29, E37 item 1), roles reading the token (E25). It is produced as D1 was: a brief, prose for architecture, tests for contract precision, Astra's cross-review, and the stopping rule of E20.
3. **Provisional details confirmed as M2 rules:** a fix's integration nominates at T2 and T3 as at T1 (E43); a Reviewer raises a finding and dispositions it in separate reports, never one edited in place (E43); the engine evaluates a stage gate at a check's execution, and the seam's section 70 wording is read that way (E45). **Carried into the D2 brief:** the two Reviewer powers of E41 (lowering a finding from Critical to High alone; a tightening a Reviewer approved applied without a second classification), because what a Reviewer may do alone depends on what the Reviewer is once it is a real agent.

---

## E49. D2 draft 1 written and checked against its brief (provisional, 2026-10-03)

**Status: provisional** for the driver's part; the design itself decides nothing until Sean approves it after Astra's cross-review (E48 item 2).

An Opus architect session drafted `docs/design/sdlc-design-D2-backends-and-isolation.md` from the brief in one session on 2026-10-03 (394 lines; neither backend run against a model; host probes listed in its preamble). The driver checked it against the brief's section 6 step 2: every question of brief section 3 is answered in prose or listed as an open question (D2 §9.3); nothing of brief section 4 is reopened, every change to D1 being a numbered proposed correction with a test (D2 §9.1, K1 to K9); the test table (Appendix B, 59 rows in the lanes `kernel`, `sandbox`, `real`), the host requirements (§6) and the not-claimed list (§8) are present. The draft is merged to `main` as an owner document and the review brief for Astra is at `docs/reviews/D2/sdlc-design-D2-review-brief-astra.md`, for Sean to hand over.

**What the draft proposes, for the record.** Isolation by an unprivileged namespace sandbox (user, mount with a constructed root, network with loopback only, pid, ipc, uts, cgroup), the role running as the engine's uid with no capabilities, its only egress an engine-owned `CONNECT` proxy with an allow list that refuses private addresses; Docker rejected (makes the engine root-equivalent, boundary behind a second daemon) and D1 §19.3's dedicated role user unavailable without root (K9). The boundary by a cgroup v2 subtree delegated by the user's systemd manager through a transient scope per engine incarnation; termination by TERM then `cgroup.kill`; emptiness from `cgroup.events`; an absent cgroup counts as terminated because a cgroup can be removed only when empty; a prior incarnation's supervisor leaf is killed at recovery without reading pids. An engine-owned trust table written only by qualification and activated only by the human (`trust_activation`); three paid canaries per backend (positive, cancellation, containment with a positive control). The bootstrap route off by default (K3; this changes the setup of the accepted M1 case for row M68, which the Verifier will have to adjust if K3 is accepted). WSL2 proposed as a qualified host subject to WSL-specific probes (Q3). Filter drivers, LFS and partial clones still unsupported (Q4). Twenty isolation probes, each with a positive control, run at every engine start.

**What waits for Sean, after Astra's review:** Q1 to Q7 (§9.2), K1 to K9 (§9.1), C1 to C4 (§5). The driver's recommendation on each is the draft's own, with one note: K3's default should be weighed against the hands-on run, which used the browser bootstrap; with the route off, a future UI needs Q6 answered first.

---

## E50. M2 slice 1: the Verifier's cases merged, provisional readings (provisional, 2026-10-03)

**Status: provisional.** The driver's defaults under Sean's delegation, like E23 to E30. Sean confirms or overturns them.

The Verifier wrote fourteen cases for the five entries of `docs/spec/M2-slice-1-hardening.md` (A1 one, A2 one, A3 three, A4 seven, A5 one) in about half an hour of agent time; merged to `main` at `63ffa2f` after the boundary check (18 paths, all inside the role's). On the accepted M1 engine, each file run alone: ten cases pass, four fail. The four are the two gaps the Builder's groundwork had already found and built on its branch before the cases existed: a tampered nomination marker did not block that candidate's gates (A1), and a protected-check correction's preview bound the approved specification as a constant, so a changed specification did not make the answer stale (A3, the three correction kinds). The other three entries held in the accepted engine and are now claimed by passing cases: the replay validation against the protected set at integration (A2), every "reject" answer (A4), and no reuse of a check result across protected versions (A5).

**Readings fixed by the cases, confirmed by the driver:**

1. **The policy widening needs no further stale-preview case.** Its manifest already binds every governed fact (policy revision and hash, the proposed policy, the authority analysis), and M49's base-change cases exercise them; an adopted hand edit of `policy.json` is not a base change. The brief's phrase "its governed fields" meant those facts. Verifier and Builder reached this independently.
2. **A tampered nomination marker blocks only that candidate's gates** (the narrow reading of D1 §9.3 item 3, "on the lineage"), pinned in SEAM §99. The evaluation does not read the marker afresh; it relies on the integrity observation, as the integration branch already does. A blocked evaluation still resolves a `fix` finding whose check passed. **Alternative for Sean:** the lineage reading, under which successors of a tampered candidate are blocked too; a changed test if he prefers it.
3. **`spec_revision` in a correction's manifest is a hash over the project's requirements** (key, text, phase, status), because M1 has no approved-spec entity; its form is not pinned, only that it changes when a requirement is added and not otherwise. **Alternative:** declare the spec unchangeable in M1 and drop the spec half of the three A3 cases.
4. **A Reviewer's approval of a human-rejected tightening approves nothing** (A.5: `rejected` has no exit); pinned in M53's reject case. **A rejected question is not raised again at once** (three ticks), pinned for all seven kinds.

**Open for Sean, not pinned:** what re-asking after a rejection does. D1 §10.2 returns the existing row for an identity already used and advances a generation only on a material change, so after a rejection the same widening resubmitted, the same deferral or lowering re-proposed, or a new assessment of the same finding may be a dead end (`decision_consumed`). Options: (a) a rejection is a recorded material change, so the next raise is a new generation with no approval (recommended by the Verifier and the driver; one case per route when decided); (b) D1 as written, a rejected question cannot be re-asked until something else changes its subject; (c) reopen a rejected decision. The engine's dedupe behaviour is unchanged until he decides.

**For the slice's Reviewer:** a suspected defect the Builder found outside the five entries and did not build (scope frozen, E40), unconfirmed by running: a protected application journals its commit and then, as a separate operation, its branch update; a run's integration could take the project's journal lock between them and move the branch first, so the application's branch update fails its compare-and-swap, and no path was found that retries or withdraws it, leaving the intended version unauthorized and the intent `executing`. The Reviewer probes it; if confirmed by running it is a serious finding of this slice under E31.

**Consequences elsewhere.** No change to D1.

---

## E51. M2 slice 1 review: one serious defect confirmed, two design questions (provisional, 2026-10-03)

**Status: provisional.** The driver's defaults under Sean's delegation. Sean confirms or overturns them.

The one review of the slice (E31) found the five entries sound in the engine, not only in the cases: a tampered marker blocks both gate kinds of its candidate until a discard's finalizer resolves it; integration validates the rebased tree against roots re-read from the effective version; a correction's manifest binds the proposal's tree and the spec revision and both are re-read at the answer and before the effect; all seven "reject" paths consume with no approval and no intent and leave the subject as it was; a reused result must carry the effective version and be uninvalidated. The Builder's twelve new unit tests cover those rules.

**Confirmed serious, by running it twice (S1), the defect E50 sent to the review.** A protected application journals its commit and, from a finalizer, its branch update as a separate operation with the old head as its expected value. When a run's integration takes the project's journal lock between the two and moves the branch first, the application's branch update fails its compare-and-swap, its probe reads the branch as `conflicting`, and the operation is `ambiguous` with a blocker whose only option is `acknowledge` and whose text says git could not be established, although the branch is at the engine's own registered commit. Nothing retries, invalidates or withdraws: the proposal stays `approved`, the intended version stays unauthorized and the effective version unchanged, the intent stays `executing`, the project's next work item is never dispatched, and all of it survives a restart and the acknowledge. The same holds for an approved policy widening. A Builder's edit to the path the tightening protects is integrated meanwhile. Moving the branch back by hand is absorbed with no observation and drops the integrated commit from the branch. **Fixed before the slice merges, one case and one fix:** the follow-up branch update of a protected application or a policy commit that finds the branch moved off its expected value fails without effect and invalidates its intent with `EFFECT_PRECONDITION_CHANGED` (D1 §10.5), withdrawing the approval and the intended version; no blocker stays open; the project dispatches again; the next generation of the decision is open with no approval. **Reading recorded with it:** D1 §7.10's "otherwise ambiguous with a blocker" does not apply to an operation the engine never attempted whose ref sits at the engine's own registered value. **The case** is the last of M53 (merged at `345719c`, SEAM §104); under E31 it is the one case, for the tightening; the policy-widening variant, which the Reviewer's probe also reproduced, gets its own case only if the fix turns out to be kind-specific.

**Suspected, not confirmed by running:** an ordinary (non-widening) policy commit strands the same way; a Reviewer-approved tightening (no intent) strands as `approved` with no blocker path out; every gate of the wedged project carries `GIT_JOURNAL_PENDING` while the operation is unfinished; A2's second validation (the rebased tree, after a protected application landed between a run's commit and its integration) is exercised by no run because every barrier in that span is inside the project lock. Each is recorded for the next slice.

**Design questions for Sean:**

1. **The window before integrity observes a tampered marker** (confirmed by running: with the marker deleted and `alpha_authorize` evaluated at once, before a tick, the gate was satisfied and the authorization issued; after a tick the observation blocks). Options: (a) accept the window, at most `tick_interval` (30 s by default), as M1 accepts it for the integration branch; (b) have the gate evaluation's own git reads check the registered refs and record an observation first, as D1 §7.2 asks of every engine git call, at least for `alpha_authorize`, the gate that issues something. The Reviewer recommends (b). **The driver's provisional default is (a) for this slice** (scope frozen, E40; the candidate's revision is immutable in the store and the evidence binds the revision, not the ref), with (b) recorded as the recommended change for Sean to take into M2 proper or D3, where the gate's reads are revisited with real check execution.
2. **The lineage reading of a tampered marker** (E50 item 2, now confirmed by running: a successor's gate is satisfied while its predecessor's marker is deleted and observed). The Reviewer recommends keeping the narrow reading for M2. Unchanged.

**Consequences elsewhere.** No change to D1.

---

## E52. M2 slice 1 merged (provisional, 2026-10-03)

**Status: provisional** for the driver's readings; the slice's merge is under Sean's standing delegation.

`build/m2-s1` merged to `main` at `0512ed5` after the driver's rerun on its tip `7b10f34`: 817 of 817 acceptance cases in 126 files (the whole suite, `--slice 8`), 101 of 101 unit tests in 22 files, the builder boundary check clean (13 paths). One earlier full run on the pre-fix branch had failed a single M15 lease-renewal case while the Reviewer's probes loaded the machine; its message showed the lease renewed two seconds before the check while the test had counted 70 s on the monotonic clock, and the file passed alone 8 of 8: the clock, not the engine, as the rerun-alone rule expects.

**What the slice built.** For the five entries: a candidate's gates carry `OUT_OF_BAND_CHANGE` while its nomination marker has an open observation (A1); a correction's manifest binds a hash of the project's requirements as the approved specification's revision (A3). The other three entries held already and are now claimed by passing cases (A2, A4, A5). For the review's finding S1 (E51): a `ref_update` that is `conflicting`, still `intended`, never attempted by any incarnation, and whose ref sits at the engine's own registered value rather than its old commit is refused as a compare-and-swap failure instead of going to the probe and blocking; whenever an operation fails without its effect, the intent it carried is invalidated with `EFFECT_PRECONDITION_CHANGED`, the approval withdrawn (the proposal back to `classified` or `awaiting_human`; a widening's question standing), the next generation raised with no approval against the new head, and no blocker left open. Unit tests: 18 new (marker, correction preview and reject, reuse across versions, the application race).

**Readings the Builder fixed, not pinned by a case, for Sean:**

1. **The withdrawn version row is deleted.** The intended `protected_versions` row of an application that failed without effect, never authorized and never effective, is deleted rather than kept and marked, because the store allows one version per proposal and re-approval needs the slot. Keeping it would need a migration and a contract change. Recommendation: keep the delete.
2. **Two variants covered by the same rule and pinned by no case:** an approved policy widening whose commit's branch update is overtaken (the Reviewer's probe reproduced the defect for it; the fix is in the shared path), and an application a Reviewer approved, which carries no intent and whose approval is withdrawn and question raised again. Recommendation: one case for the widening when a Verifier pass next has room; recorded in `COVERAGE.md`.

**Done against the brief (`docs/spec/M2-slice-1-hardening.md` section 4):** the cases exist, are in `COVERAGE.md`, and pass with the whole suite on the merged engine; every design question is in E50, E51 and here; nothing outside the five entries was built except the review's confirmed finding, as E31 provides. Outstanding: the Verifier updates the counts of `M1-not-claimed.md` against a run of `npm test` on `main`, and E51's design questions wait for Sean (the gate's own read of the marker before an authorization; re-asking after a rejection, E50).

**Consequences elsewhere.** No change to D1. The triage (`docs/spec/M2-input-triage.md`) bucket A is settled.

---

## E53. M2 slice 2 started: the Verifier's cases merged, provisional readings (provisional, 2026-10-03)

**Status: provisional.** The driver's defaults under Sean's delegation; the slice's brief is `docs/spec/M2-slice-2-legibility.md` (bucket B of the triage, E48 item 1). Sean confirms or overturns them.

The Verifier wrote seventeen cases for the six entries (B1 six, B2 two, B3 four, B4 three, B5 one, B6 one), merged to `main` at `e05679c` after the boundary check (15 paths, all inside the role's). On the slice-1 engine, each file alone: five pass (two preview facts, the usage write that keeps failing), twelve fail. A Builder's groundwork, done before the cases existed, had already built four of the six entries on its branch (the preview facts, `adopt`, the NOW causes, the three reads) and found the other two holding by running them (B5; B6 on the recovery side). The Builder adapts to the names the seam fixes (SEAM §§105 to 110).

**Readings fixed, confirmed by the driver:**

1. **A blocker's manifest binds `continuation` as `{status, from}`** (`from` = the stored checkpoint or null), replacing SEAM §77's string; M45's first case changed with it. A blocker's **evidence** is bound as the Builder built it (the run whose end blocked the item and the state of its records) and pinned by no case; the Verifier closed that fact for M2 because M1 has no evidence fact for a blocker.
2. **An exclusion's `ancestry` binds the chain of candidates** (`{finding_candidate, predecessors}`), and its manifest also binds the finding's status, scope and evidence; the disposition and severity manifests bind the finding's scope and evidence. When the lineage chain breaks, the next generation is raised as for any changed fact; **alternative for Sean:** withdraw the exclusion question when the finding no longer applies to the candidate (the Verifier's recommendation; the case accepts either).
3. **`adopt` of a checkout:** one engine-made out-of-band revision on the integration branch holding exactly the reviewed content, the observation reconciled, the next run based on it, the files untouched and not observed again; an edit after the answer and before the effect invalidates the adoption, which is never made, and the edit is preserved. **The developer's index is reset to the adopted commit so `git status` is clean** (both agents' recommendation; the literal alternative leaves a staged reversal beside an unstaged edit, and a hand commit would then revert the adopted edits). A checkout whose HEAD moved is refused: the branch's own observation is settled first.
4. **The status line:** `refused` names its cause for an unreadable repository (`repository_unreadable`), an unresolved out-of-band change of a ref (`out_of_band_change`), and a store failure, which the engine knows from an in-memory record of the last failed budget read per project; `unknown` with cause `store_error` when the status cannot be computed, staged by a new harness fault `status_read`. **Addition flagged (E40):** the Builder added cause `journal_blocked` for an operation left ambiguous, outside the brief's three causes, consistent with D1 §12.3; recommended kept. A checkout observation leaves the status `waiting_on_you` (dispatch is not blocked by it).
5. **The three reads** (SEAM §108): one decision by id (the list item's shape plus `status`; consumed and invalidated decisions readable, with the answer; another project's or an unknown id 404); operations (`id, kind, journal_kind, state, status, intent, attempts, finalized_at, blocker`); environments as a route of their own.
6. **A git write killed at its deadline in a running engine** (SEAM §110): the run is **not ended** while its operation is unresolved and nothing else is dispatched; the next tick's probe finds the write absent and one retry makes it exactly once with the frozen intent's tree and parent; the run then ends `completed` and its work is `integrated` by that one run. The engine as it stood ended the run `failed` and the journal's later retry made an orphan commit for a failed run: the double-work the entry guards against. **Alternative for Sean:** end such a run like a crash (`recovered`, work held) and let the journal's retry integrate; rejected provisionally because a held item integrated by a finalizer is the muddle E33 guards against.

**Consequences elsewhere.** No change to D1. The contract (`api/schema.json`, `appendix-a.md`) is regenerated by the Builder for the changed manifests and `NowState`.

---

## E54. M2 slice 2 review: three serious defects confirmed, three design questions (provisional, 2026-10-03)

**Status: provisional.** The driver's defaults under Sean's delegation. Sean confirms or overturns them.

The one review of the slice (E31) found the six entries built and sound except where below: the three reads probe and write nothing and are scoped to their project; the status line reads only and names each cause; the richer manifests change when their facts change and not otherwise; `adopt` is refused when the checkout's HEAD moved, revalidated when the effect begins, and its in-flight exemption accepts only the reviewed tree; engine git's hardening applies to the checkout's `read-tree`; a run whose write is blocked by an unreadable repository waits visibly (`refused/repository_unreadable` with an operation blocker) and completes once the repository answers; a restart during an ambiguity reconciles first. Objection 001 (the M45 case compared the retried run's base with a commit its own policy change had moved past) was upheld by the Verifier and the assertion changed.

**Confirmed serious, by running (fixed before the slice merges, one case and one fix each):**

1. **S1: `adopt` loses a newly staged file.** The checkout's tracked tree was built from `HEAD` plus `add -u`, so a path in the index but not in `HEAD` was missing: the adopted commit was empty, the index reset unstaged the developer's file, the observation was reconciled and never raised again, and the next run's base lacked the file; a staged version superseded in the work tree was dropped to a dangling blob. **Reading fixed:** the adopted revision holds the index plus the work-tree content of the paths the index lists (a staged addition included; a superseded staged version goes the way `git commit -a` sends it); `git status` is clean afterwards. **Alternatives for Sean:** refuse (409) a checkout whose index holds paths not in `HEAD` or content matching neither `HEAD` nor the work tree; or keep the `HEAD`-based tree and stop resetting the index.
2. **S2: the same cause in M1's `stash` deleted the staged new file from disk,** the oob ref not holding it. Predates the slice (accepted M1 behaviour, SEAM §79), outside the six entries, fixed in this round because the fix is S1's and the defect destroys a developer's work. One case.
3. **S3: Stop or Abandon of a run waiting on its ambiguous git write ended the run without reconciling the operation.** When the killed write had landed, the later reconciliation moved the registry and finalized the operation `succeeded`, but no `work.integrated` event and no candidate were recorded, and a Resume dispatched a second run on a base that already held the first run's edit; Abandon left the abandoned run's commit on the branch with the work `eligible`. A restart instead of a Stop was handled correctly. **Reading fixed (D1 §4.5 step 4, M13/M14, SEAM §47):** once the run's end is decided the pipeline keeps waiting, without renewing the lease (E27 item 5), until the operation is finalized or failed; a landed integration is `integrated` and then held or given back with its candidate nominated as usual. One case for Stop; Abandon under the same rule, not pinned.

**Below the serious bar, recorded:** a kill between the adoption's journal entry and the index reset leaves a staged reversal beside the unstaged edit and opens a new checkout observation (honest, nothing lost; a recovery-time index reset would remove it); with `.git/index` replaced by a link to a file outside the repository, the adoption's `read-tree` rewrote that file (a role can already write as the engine's user in M1; D2's); three comments and the adopt option's consequence text do not say that the engine commits, moves the branch and resets the index (text, for the Builder in passing).

**Suspected, not run:** any other engine-decided end (a run deadline) during a wait takes S3's path; `awaitJournal` renews the lease while the end is decided in memory but not yet recorded; a file staged between the baseline read and the index reset is unstaged without notice; the `oob_adopt` precondition skip covers every worktree holding the branch, not only the adopted one; a record whose bytes flap turns previews stale and back.

**Design questions for Sean:**

1. **A broken ancestry chain (E53 item 2):** the Reviewer, like the Verifier, recommends withdrawing the exclusion question rather than raising the next generation, since asking to exclude a finding from a candidate it no longer applies to is a nag. No engine path in M1 breaks a lineage; the case accepts either. Kept as built until Sean decides.
2. **Stop of a run whose operation is blocked** (the probe cannot read the repository), after S3's fix: (a) the Stop waits and the run stays `finalizing` until the repository answers, shown as `repository_unreadable` or `journal_blocked` (the Reviewer's recommendation and D1 §4.5 step 4 as it reads; the driver's default); (b) end the run at once and have the late integration's finalizer apply "integrated, then held" to a held item.

**Added after the Verifier's pass (also provisional):** the three cases are merged at `1c54130` (SEAM §111, §112; the harness's own `trackedTree` had the engine's defect and was corrected). A staged file after `stash` follows `git stash` semantics: the ref holds it and the checkout returns to its baseline, so the file leaves the work tree (alternative: left on disk untracked beside the stash). The pre-fix branch `e45919a` passed the whole suite, 834 of 834, before these cases.

**Consequences elsewhere.** No change to D1.

---

## E55. M2 slice 2 merged (provisional, 2026-10-03)

**Status: provisional** for the driver's readings; the merge is under Sean's standing delegation.

`build/m2-s2` merged to `main` at `b6ae830` after the driver's rerun on its tip `fd25931`: 837 of 837 acceptance cases in 127 files (the whole suite, `--slice 9`), the unit suite 27 files passing (121 tests before the last fix round's four), the builder boundary check clean (21 paths). The pre-fix tip had passed 834 of 834 before the review's cases.

**What the slice built.** The remaining preview facts bound (a blocker's `continuation {status, from}` and evidence; a finding's scope and evidence on the disposition and severity kinds; an exclusion's ancestry chain, finding status, evidence and scope); `adopt` of a checkout as one engine-made out-of-band revision with the branch moved by compare-and-swap and the developer's index reset to it; the status line's `refused` causes (`repository_unreadable`, `out_of_band_change`, a failing budget read, and the flagged addition `journal_blocked`) and `unknown` with cause `store_error`; the reads for one decision by id, a project's operations and its environments; a run whose git write is killed at its deadline, or blocked, waits for the journal instead of failing. The review's three fixes: a checkout's tracked content is what `git commit -a` would commit, read from a stat-free copy of the checkout's own index found through `rev-parse --git-path` (so `adopt` and M1's `stash` no longer lose a staged file, and a linked worktree is read from its own index); once a run's end is decided, the acceptance pipeline waits without renewing the lease until its operation is finalized or failed, a landed integration being recorded before the run is stopped or abandoned (this also covers the review's unconfirmed U1 and U2). The contract was regenerated (`NowState` gains `unknown`; the manifests' new keys). The Builder's objection 001 was upheld and the M45 case changed.

**Readings fixed in the round, not pinned by a case, for Sean:**

1. **Integrity now hashes every tracked file of each managed checkout at every tick** (the same cost the old reading from `HEAD` had in principle, now a full hash per tick). To revisit if it shows in load (row M71's limits were qualified before this change and are not re-measured).
2. **A Stop confirmed while the run's operation is blocked** (its probe finds `unknown`) waits until the repository answers, as SEAM §112 pins and E54 question 2 (a) reads; a Stop cannot finish while the repository cannot be read.

**Done against the brief (`docs/spec/M2-slice-2-legibility.md` section 4):** the cases exist, are in `COVERAGE.md`, and pass with the whole suite on the merged engine; every design question is in E53, E54 and here; nothing outside the six entries was built except the review's confirmed findings, as E31 provides. Outstanding: the Verifier updates `M1-not-claimed.md` against a run of `npm test` on `main`, after which class B holds only bucket C's entries; the design questions of E50 to E54 wait for Sean.

**Consequences elsewhere.** No change to D1. Triage buckets A and B are settled; bucket C stays recorded.

---

## E56. D2 draft 1 cross-reviewed; Sean's dispositions (decided by Sean, 2026-10-03)

Astra's one cross-review of D2 draft 1 (`docs/reviews/D2/sdlc-review-D2-Astra.md`) approves it with amendments: nine blocking objections, five suggestions, all nine proposed D1 corrections accepted (five with a variant), one new correction, and a recommendation on each of the eleven open questions matching the draft's. Three objections were reproduced on this host as primitives (a launcher can enter a cgroup after it was observed empty; a host pathname socket is reachable through a read-only bind; Codex 0.159.2 ships with `multi_agent` enabled). Sean went through the findings one at a time; the dispositions are in `docs/reviews/D2/sdlc-review-D2-dispositions.md`.

1. **All nine blocking objections accepted as written** (B01 launch closure before termination; B02 validated mount authority; B03 egress connect bound to the validated address; B04 a scoped qualification authority; B05 native delegation disabled and canary attempts witnessed; B06 reporting granularity separate from enforceable budget boundary; B07 known usage retained on a cancelled run; B08 volatile storage for provider files and pre-admission secret screening, the before-disk promise unchanged; B09 a resource envelope beyond memory and pids).
2. **All five suggestions accepted** (N01 fresh challenge-response for a pause re-grant; N02 separate total classification of exit and domain observation; N03 current versus historical host qualification; N04 explicit canary diagnostics and capability scope; N05 the bootstrap opt-in kept out of qualified M2).
3. **Corrections to D1 K1 to K10 accepted**, five with Astra's variants, K10 (the qualification authority, D1 §17.11 and §15.1) new. K3 changes the accepted M1 bootstrap case to opt in explicitly and adds a default-off case; the Verifier makes that change when D2 is built.
4. **Q1 to Q7 and C1 to C4 decided as recommended:** dedicated API keys; the role holds its key in M2 with the stated metering limitation; WSL2 eligible to qualify; filters, LFS and partial clones unsupported; Codex's inner sandbox off; the UI's bootstrap decided with the UI; paid canaries only by explicit command; the Alpha exception through finding disposition with snapshotted evidence; both Reviewer restrictions; the token-reading acceptance withdrawn with the sandbox; estimates counted apart from reported dollars with the unknown allowance charged once.

**What follows (E48 item 2):** draft 2 applies the dispositions, the driver checks it against the brief and the dispositions, and Sean approves D2 to build. No draft 3 unless Sean asks. Then the M2 acceptance plan and build spec, and the D3 brief.

---

## E57. An optional eBPF execution observer for qualification (decided by Sean, 2026-10-03)

A companion note to D2, `docs/design/sdlc-design-D2-ebpf-note.md`, proposes an optional host observer that uses eBPF to record selected process, file-access and connection attempts of a role with the kernel's answer, attributed to the incarnation, invocation and domain through engine-established identity, as evidence at qualification; it never authorizes a launch, establishes termination, passes a check or measures tokens, and a missing event is never evidence of absence. It answers the "independently witnessed attempts" of Astra's B05 (E56) and strengthens the probes her review marked weak.

**Sean approved an optional, qualification-only prototype as the initial scope**, recorded as an addition under E40. The engine's runtime-dependency rule is unchanged: any loader or tracing tool is a host or test requirement the engine checks for. On this host unprivileged BPF is disabled and there is no sudo, so the loader needs a privilege Sean grants (a root-run `bpftrace` for the feasibility check; later a capability-granted helper), which is a host-setup step of his, like the plan page's "set up the host". **Order:** a feasibility run by Sean with `bpftrace` against the scripted engine before any Verifier or Builder work; then the five assertions of the note join the sandbox-lane rows of D2 Appendix B as "with observer" variants, pinned by the Verifier before the Builder implements them (E31, E48). D2 draft 2 gains a short §3.9 stating the observer is optional and never authoritative and pointing to the note; D2 is otherwise unchanged by it. Production monitoring and BPF-based enforcement remain separate decisions.

---

## E58. D2 approved to build (decided by Sean, 2026-10-03)

D2 draft 2 (`docs/design/sdlc-design-D2-backends-and-isolation.md`, merged at `474de37`, 441 lines) applies every disposition of E56 and the observer of E57; the dispositions file names the section for each finding. The driver's check against the brief (section 6 step 2) passed: nothing reopened, K1 to K10 numbered with their tests, no open question, Appendix B with 73 statements in three lanes (13 kernel, 55 sandbox of which 5 are the optional observer rows, 5 real). **Sean approved D2 to build as drafted.** No draft 3 (E20, E48 item 2): from here a finding is a decision for Sean or a failing acceptance test.

**Variants the architect took in applying the dispositions, recorded as part of the approval:**

1. **One volatile filesystem per domain, the workspace included.** To bound a role's writes without root (B09) and keep unscreened output off disk (B08), every location a role can write, the upper layer of its workspace among them, is one bounded, swap-excluded tmpfs charged to the domain's memory; after termination the engine screens the upper layer for registered secrets and only then materializes it into the checkout for the snapshot. **Consequence, accepted by Sean:** an engine crash mid-run loses a real backend's unsnapshotted edits, provider files and unvalidated result; the run is recovered and a Resume starts from the last snapshot; E30 item 10's retained workspace does not apply to real backends. A role's writes count against `domain_memory_max`. The alternative (workspace writes on disk, retained on a crash, with B09's storage bound and the before-disk rule partly unmet on this host) was put to Sean and declined.
2. Launch closure is a store-kept launch state (`authorizable`, `authorized`, `closed`); an unplaced launcher, the engine's own child, is killed through its handle and its exit awaited (B01).
3. The mount plan enumerates the operator's credential locations; a repository with git alternates is refused (`mount_plan_refused`) (B02).
4. The operator's approval of a paid canary is a decision kind `qualification_approval` binding the exact attempt (B04, Q7).
5. Claude Code's denial uses `--disallowed-tools` with the names CH recorded; the effective tool surface is established by inventory or by an executable test, else refused (B05).
6. A policy declaring a hard spending maximum (`budget_hard_maximum`) is refused with `hard_cap_unenforceable`; a provider-side cap is the place for one (B06, Q2).
7. A resource-counter rise that did not end the backend is recorded and does not by itself fail the run (N02).
8. No host qualification row is active while `ui_bootstrap` is true (N05).
9. The unknown allowance is the run's token limit less the billable tokens observed, charged once; running invocations count their remaining allowance at dispatch (C4).
10. Q3's "H1 to H10" is read as H1 to H12 (H11 volatile storage, H12 host reserve added by B08 and B09); the daily limit's key `budget_day_verified_usd` keeps its name while the ledger read shows reported and estimated apart.
11. K3's change to the accepted M1 bootstrap case (row M68 opts in explicitly; a default-off case added) is the Verifier's, when D2 is built.

**What follows (brief section 6 step 5):** the M2 acceptance plan and the M2 build spec, then the D3 brief. Sean's eBPF feasibility run (E57) precedes any observer work.

---

## E59. The M2 acceptance plan adopted; the real lane's model and spend (decided by Sean, 2026-10-03; the rest provisional)

A Verifier derived the M2 acceptance plan from D2 Appendix B and the real-backend journey (`docs/acceptance/sdlc-M2-acceptance-plan.md`, adopted from the Verifier's draft at `ff162c2`): 42 rows M101 to M142 (9 kernel, 26 sandbox, 5 real, a report row, a hands-on row) with 210 named cases, every one of the 73 Appendix B statements mapped by a script check, the ten corrections K1 to K10 covered, bucket C and D2 §8 carried as deferred traces, five slices (10 to 14). The M2 build spec (`docs/spec/M2-build-spec.md`) is in force with its slice table filled from the plan's section 5.

**Decided by Sean:** the real lane runs Claude Code on `claude-sonnet-5-5` for all three roles of the journey, with `budget_run_billable_tokens` 300 000, `budget_day_verified_usd` 25, and a provider-side cap of 50 USD on the dedicated key (plan question 3; spec open question 4).

**The plan's other questions, settled by the driver under delegation (provisional):**

1. **The runner** (owner's `scripts/run-tests.mjs`) knows rows M01 to M74 and M101 to M142; files listed under manifest `real` are the paid lane, run only by `--lane real` and never by `npm test` or a slice; the full run still requires each real-lane row to have its file (plan question 1, option (a)). `CLAUDE.md` says so.
2. **The real lane's two human steps** (`qualification_approval`, `trust_activation`) are answered by Sean through the API while the test waits with a long timeout and a printed prompt; no fixture answers as the human (question 2, option (a); Q7).
3. **Path two of the real journey** uses a defect seeded in the stage's requirement that a real Verifier is expected to find; if it does not, the path is recorded as not established and run once more; a mixed run (real Builder, scripted Verifier and Reviewer) is the recorded fallback (question 4, option (a) with (b)).
4. **P11's Windows-executable control** is a Windows executable every WSL2 host has (`cmd.exe` with an echo), its path and hash recorded, rather than a binary checked into the repository; D2 H10's "engine-shipped" is read as "named by the engine and verified present" (question 5, option (b)).
5. **B15's "user manager stopped"** is tested with a real `daemon-reexec` plus a harness fault that makes the manager unreachable; a real stop is `not_exercised` unless Sean runs it privileged (question 6, option (a)).
6. **Codex is not in M2;** its attempt and rows wait for M3 (question 7, option (a); E46, E48).
7. **C05's concurrent-dispatch clause** is class A for M2 while `max_concurrent_runs` is 1 (question 8, option (a)).
8. **`reject` on `trust_activation` and `qualification_approval`** leaves the entry or attempt `proposed` and closes the question, as E50 item 4 reads for the M1 kinds; what re-asking does follows Sean's open E50 question (question 10).
9. The plan page's "set up the host" step is reworded: no agent account exists (K9); what remains for Sean is a login session with the user manager running, the three util-linux and iproute2 tools, the API key, and optionally the observer's loader (question 9).

**Consequences elsewhere.** `scripts/run-tests.mjs` and `CLAUDE.md` changed by the owner. No change to D1 or D2.

---

## E60. D3 draft 1 written and checked against its brief (provisional, 2026-10-03)

**Status: provisional** for the driver's part; the design decides nothing until Sean approves it after Astra's cross-review (D3 brief section 6).

An Opus architect session drafted `docs/design/sdlc-design-D3-checks.md` from the brief in one session (304 lines; no sandbox, runner or model run; one scratch probe: Node 22's `node --test` exits 0 with every test skipped or none present, and `git read-tree` plus `checkout-index --prefix` writes a revision without `.git`). The driver's check passed: every brief question answered in prose or carried as an open question (§7.3); nothing of the brief's section 4 reopened, every change being a numbered correction (L1 to L5) with tests; the test table present (Appendix C, 53 statements: 32 `kernel`, 17 `sandbox`, 4 in a new `project` lane against a real toolchain with no model); the `check` profile defined within D2 §2.3; a not-claimed list (§6); the `.surety/checks/` reference (Appendix B). Merged at `d466d64`; Astra's review brief at `docs/reviews/D3/sdlc-design-D3-review-brief-astra.md`, for Sean to hand over.

**What the draft proposes, for the record.** The five governed fields get closed schemas and discovery is a pure function of a tree, never a program; a check definition names its command (from an approved `check_commands` list), its inputs (the protected files it reads, which the `check` profile mounts read-only and the classifier fingerprints) and the criteria it covers. The runner executes one definition in a `check`-profile domain with a discarded writable overlay, establishes `execution_established` only from the domain init's reports (launch authorized, `started` after the exec, termination with closure), records no row while termination is `unknown`, orders results by registration, qualifies the `direct` class by a runner self-test at every start, treats orphans left in the domain as failure (L4), and sends a `fix` back to its Builder when its finding's check fails again (§2.10). The classifier compares two discoveries element by element: a tightening keeps every existing check's fingerprint and adds something strict; any change to a command, input, or governed execution field is unclassifiable; re-run at application as an effect precondition (K8); authoritative only once an engine setting names a qualified classifier version. The required set comes from the scope's tier with module overrides, the obligation requirements' criteria and the sensitivity categories; a scope is validated only when every criterion is covered by an acceptance-origin check and every area has a floor check (L3). X1 proposes reading the integration branch and the candidate's marker before every evaluation (E51 question 1, Reviewer's option (b)); X2 gives a requirement-conflict finding a decision route instead of repair; X3 leaves M3 an environment-bound check.

**Two departures from the brief, reasoned and accepted by the driver for draft 1:** a discarded writable overlay rather than declared writable paths (toolchains write caches where no declaration lists them; discarding gives the same guarantee); the check's toolchain governed in the protected policy's `runner_config.direct.read_paths`, not D2's role setting, because what a check runs is part of the protected path (F §5.2).

**What waits for Sean, after Astra's review:** L1 to L5 (§7.1), Q1 to Q7 (§7.2; Q2 and Q4 change what the kernel does today), and whether D3's rows join the M2 plan or open M3's.

---

## E61. M2 slice 10: the Verifier's cases merged, provisional readings (provisional, 2026-10-03)

**Status: provisional.** The driver's defaults under Sean's delegation. Sean confirms or overturns them.

The Verifier wrote nine files for rows M101 to M109 (manifest slice 10; SEAM §§113 to 121), merged to `main` at `0abeca8` after the boundary check (24 paths, all inside the role's). On the engine as it stood every case fails at the trust table's absence except M106 (c) (every classifier dependency already invalidates a held effect) and M109 (c) (the lint). A Builder's groundwork, done before the cases existed, had built the trust table, qualification attempts, both decision kinds, the budget rules, C4's allowance, C1's proposal, K7 and K8, the bootstrap default and the widening refusals on `build/m2-s10`; it adapts to the seam's names.

**Readings fixed by the cases, confirmed by the driver:**

1. **K8 overturns three accepted M1 cases** (M37 case 1, M53 case 2, M74-fixture-semantics' candidate read), which had pinned that a Reviewer's approval applies a tightening. As Sean accepted K8 (E56 item 3: a Reviewer's tightening approval is a recommendation until D3's classifier is qualified), the Verifier changed them and labelled the change, as E44 item 2 provides for an overturned provisional decision; the plan's "M51, M53 unchanged" in row M106 is corrected by this entry. M68 opts in to `ui_bootstrap` as the labelled compatibility test (K3).
2. **All 21 D2 A.7 engine keys enter the contract now** with D2's defaults and ranges (M07 and M73 pin the closed sets exactly), rather than slice by slice.
3. **In the kernel lane, host eligibility is the harness's say-so** (`host_eligibility.source: "harness"`, no `host_qualifications` row), labelled, to be listed among the M2 report's instrument limits; the sandbox lane qualifies for real.
4. **Backend selection** is per role: policy keys `backend_builder`, `backend_verifier`, `backend_reviewer`, `backend_architect` (`scripted|claude|codex`, default `scripted`) and `backend_mode`; D2 A.7 had no key.
5. **`host_qualification` is nullable** on trust entries and attempts (kernel-lane fixtures), as are `decisions.project` and `records.project` for engine-scoped decisions and evidence; the trust decisions are answered on engine-scoped routes `GET /v1/decisions` and `POST /v1/decisions/:d/answer`.
6. **The provider-side cap is recorded with the secret reference** (`provider_cap {status: "configured", usd, reference}` on the grant), never as engine enforcement.
7. M106 (c)'s effective-version change between approval and effect is staged by a fixture row superseding the effective version, because no engine path can apply a second proposal while an effect is paused at its intent.
8. The Builder's unknown allowance is charged only after at least one usage observation or for a trust entry's backend, so M1's default day limits keep passing; `records.project` nullable rather than a fixture project for engine-wide evidence; a coarser `budget_run_boundary` treated as a widening (not pinned).

**Consequences elsewhere.** No change to D1 or D2; the M2 plan's row M106 reads as item 1 says.

---

## E62. M2 slice 10 review: two serious defects confirmed, five design questions (provisional, 2026-10-03)

**Status: provisional.** The driver's defaults under Sean's delegation. Sean confirms or overturns them.

The one review of the slice (E31) found the trust table, the dispatch rule (no active entry or eligibility, no spawn; `scripted` only in harness mode; attempts never dispatch project work, K10; the binary's hash checked before the spawn), activation (reached only through `trust_activation`'s consumption; the evidence fingerprint complete; rejection clean), the budget boundaries (`model_turn` refused without admission-control evidence; the hard maximum refused at the only entry; the provider cap only `configured`), the ledger's once-charged, once-released allowance, the result-field rebuild that stops a smuggled proposal, K7, K8, the bootstrap default and migration 0007 (M1's migrations unchanged; nullable `project` handled everywhere it is read) sound. Both objections of the slice (002, 003) had been upheld and the Builder's branch passes every slice-10 file and the changed accepted ones alone.

**Confirmed serious, by running (fixed before the slice merges, one case and one fix each):**

1. **S1 (M105, C1): the Alpha exception bound content the Reviewer never reviewed.** With the Reviewer held before its spawn, a check added to the candidate's acceptance content, and the proposal answered, the exception was written against the current content hash rather than the hash the run was claimed on (`runs.content_hash`), and the Alpha gate stopped blocking on the finding under content the Reviewer had not seen; the defect E41 item 4 closed for sign-offs, reopened for exceptions. **Reading fixed (the Reviewer's recommendation):** a proposal whose reviewed hash differs from the current content is refused, and an open decision whose reviewed hash no longer matches goes stale before answer and `EFFECT_PRECONDITION_CHANGED` before effect; an exception never lifts a block on unreviewed content. **Alternative for Sean:** bind the reviewed hash and let the gate ignore the exception under other content.
2. **S2 (M104, C4): a real backend's invocation that fails on its own with incomplete usage was charged no unknown allowance** (the charge covered only engine-ended outcomes), so the day's unknown-token exposure was understated. **Reading fixed:** every incomplete invocation of a trust entry's backend is charged the allowance whatever its outcome (D2 §1.5, C4; SEAM §120 as amended, its parenthetical corrected); a scripted invocation ended before any observation still carries none (E61 item 8).

**Suspected, not confirmed as serious, recorded for later slices:** the effects step still selects proposals approved under `reviewer` authority, which only a store upgraded from M1 with such a pending proposal could present; host eligibility does not yet compare the qualification's host, mechanism and profile with the entry's (unreachable until a real row exists; M134); a failed real run with observations is marked complete under M1's rule (M130/M131); a record reference in an Alpha proposal does not check the record's post-scan; a hard link to a forbidden file inside an approved read path passes validation (question 3); a missing provider key launches the binary without one rather than refusing; the activation trigger checks that the decision is consumed, not that it was approved (direct store access only); the linked-worktree shared `.git` of a registered repository is not in the forbidden set; two proposals for one finding in one result overwrite each other.

**Design questions for Sean:**

1. **Estimated cost while a run is under way** (E61 item 8, measured): a run reporting only estimates runs to its token limit before the day's dollar limit stops it, an overshoot of up to one invocation's estimate at the run token limit, also bounded by the deadline. (a) Accept as invocation-boundary overshoot (D2 §8 class C) and state the measured bound in the M2 report (recommended; Claude Code reports cost on its final line anyway); (b) count the running estimate in the per-observation check as reported cost is counted.
2. **S2's reading:** confirmed as a defect by the driver per D2's text; Sean may read SEAM §120's old parenthetical the other way.
3. **Hard links in `sandbox_read_paths`:** (a) refuse a file whose link count exceeds one when it matches a forbidden inode; (b) accept as class C, an act of the operator's own account, listed in the not-claimed list (recommended).
4. **The human cannot read trust-entry evidence through the API:** no route serves engine-scoped records, so a `trust_activation` preview names records the person cannot open. To decide with M135 and the real lane (recommended), since it is not a slice-10 row; the driver's default is a read route for engine-scoped records in slice 13.

**Added after the Verifier's pass (also provisional):** the two cases are merged at `d0c5409` (SEAM §119 and §120 amended). Two readings the Verifier fixed: while an exception question is open, a change to the candidate's acceptance content **withdraws** the question (invalidated, nothing raised in its place; the Reviewer proposes again on the new content) rather than raising a next generation, because re-asking would offer the human an exception on content nobody reviewed; and a written exception stops lifting the block once the content changes because the gate compares the exception's hash with the scope's, the record staying intact (alternative: clearing `findings.alpha_exception` on a content change). Both recommended as written.

**Consequences elsewhere.** No change to D1 or D2.

---

## E63. M2 slice 10 merged: the kernel lane is built (provisional, 2026-10-03)

**Status: provisional.** The driver's record under Sean's delegation; nothing new is decided here.

`build/m2-s10` merged to `main` at `b09f8da` (`--no-ff`) after the two review fixes (E62 S1, S2) and the two upheld objections (002, 003; E61). The driver's rerun on the branch tip `8ff950a`: `node scripts/run-tests.mjs acceptance --slice 10` passed 874 of 874 cases in 136 files, none skipped; `npm run test:unit` passed 29 files (137 tests); the builder boundary check from a clean scratch worktree listed 52 paths, all inside the role's. The slice adds migration 0007 (trust table, qualification attempts, the boundary rows), the trust and qualification transitions, the launcher's choke point with the fixture route, backend resolution per role (E61 item 4), the sandbox plan's validation, the ledger's allowance, the result-field rebuild, and 21 engine keys in the contract (E61 item 2).

**Open from this slice, carried, none blocking:** E61 items 1 to 8 and E62 questions 1 to 4 (Sean); E62's suspected items, assigned to slices 11 to 13 where their rows live.

**Next:** slice 11, the sandbox lane's boundary rows M110 to M118 (M2 plan §3.2, §3.3; build spec §9), with the closing Verifier pass on slice 10 running alongside.

---

## E64. M2 slice 11: a test ended the user's session; the cases merged; destructive instruments fail closed (provisional, 2026-10-03)

**Status: provisional.** The driver's defaults under Sean's delegation. Sean confirms or overturns them. Item 1 is a record of what happened, not a decision.

1. **The incident.** At 11:33:33 CDT on 2026-10-03 the slice-11 Verifier ran `M117-processes-and-descriptors` against the slice-10 engine. Case (a) is probe P13: the role sends SIGKILL to every pid it can see and calls `kill(-1, SIGKILL)`. The slice-10 engine launches a role on the host with no pid namespace, so the call ended every process of uid 1000: the login session, the user's systemd manager, the editor's server, the driver's session and both agents. The journal shows `user@1000.service` killed by signal 9 at that second. No file was damaged; one Builder regression run was lost. **The user manager stayed down** (`/run/user/1000` absent), which the driver may not repair (no host change without Sean); the sandbox lane cannot run until Sean restarts WSL.
2. **The rule adopted (SEAM §127, §128; the Verifier's question 9, confirmed by the driver).** A test instrument that can damage the host fails closed, in two independent halves: the instrument itself refuses unless it can establish that it is contained (for `signal_all`: the test passed the host's pid namespace and the role is in another, pid 1 is not a system init, at most 16 processes visible; any failed read is a refusal), and the test releases it only after reading containment from the host side. The tests' own changes to the cgroup tree (chmod, rmdir, `cgroup.kill`, placement) refuse any path outside a test engine's scope or a test sentinel's. The same two halves are required of P13 in the probe suite and of P20's fork and memory exhaustion (slices 12 and 13). **Added by the driver:** the engine's side is held to the same rule: the slice-11 Builder lists every `cgroup.kill` and `cgroup.procs` write, directory removal and signal, with what establishes the target is inside the engine's own scope, and the slice's Reviewer checks that list by reading and by running; every later slice's Reviewer checks the two halves of any new destructive instrument.
3. **The cases are merged** at `c6865b3`: ten files, 52 cases, rows M110 to M118, manifest slices 11 and 12, SEAM §§122 to 131. **Squashed, not merged**, so that the branch's checkpoint commit, which held the unguarded case, is in no history; the content equals the Verifier's tip `a42ee92` and passed the boundary check (21 paths). No accepted test's assertions changed. **Not yet observed:** no file in its final form has run to its first M2 step with the user manager up; M117 and M118 never have.
4. **Readings the Verifier pinned, confirmed by the driver as defaults:**
   - **M110 is split.** H9 and H10 pass only when slice 12's probes exist, so the active `host_qualifications` row, (d) and (e) are a second file under manifest slice 12 rather than a harness-forced pass, which would be vacuous.
   - **A tick that re-observes a quarantined domain observes only**; it does not run TERM and kill again once the prerequisites return, so a live quarantined role lives until a restart or the human's acknowledgement (M115 (g), (h) as written). Alternative for Sean: re-run termination, recording the cgroup id so a recreated directory is told apart; kinder in operation, more mechanism.
   - **The hierarchy is verified before anything is signalled**: under `manager_unreachable` nothing is signalled and the role lives.
   - **"Surviving a restart" (M115)** is pinned only where the restart still cannot establish termination; an emptied scope removed by the manager is absence, and absence is termination (D2 §3.3).
   - **The engine enters its scope in place** (`busctl` `StartTransientUnit` with `PIDs`) rather than through `systemd-run --scope` running a command as D2 §3.1 names, because the lock's pid and the tests' signals need the spawned process itself. A mechanism detail; D2's scope, delegation and naming are unchanged. Sean confirms.
   - **An expired lease pending the challenge accepts the backend's output** (M118 (c); K5's reading); the kernel lane keeps M15's rule.
   - **The scripted directory is bound read-write inside the sandbox in harness mode**, labelled as an instrument's hole in the role's view, because a result collected only after termination cannot show what a killed role did.
5. **Open, for Sean:** what a sandbox-lane engine with no scope does with a scripted dispatch (the Verifier recommends refusing `isolation_unqualified`; not pinned); whether `scripts/run-tests.mjs` should fail once with "sandbox lane: no user manager reachable" instead of fifty separate failures (recommended, an owner's change of a few lines; not made).

6. **The user manager restored without a restart (added 12:15 CDT the same day).** Sean asked to continue without restarting WSL. Linger was already enabled for his user (`/var/lib/systemd/linger/smahoney` existed), so the driver ran `loginctl enable-linger smahoney`, which changes no setting and has logind start `user@1000.service` again; verified: `/run/user/1000/bus` present, `systemctl --user` `running`, a transient delegated scope creatable. Two differences from before the incident, to be reported as observed and never assumed away: the manager's delegated controllers are `cpu memory pids` (`cpuset` and `io` no longer listed; H4 needs `memory` and `pids`), and uid 1000 is `lingering` with no logind session object. Item 1's "cannot run until Sean restarts WSL" is superseded by this item.

**Consequences elsewhere.** No change to D1 or D2. `docs/acceptance/reports/M2-not-claimed.md` gains "After slice 11". The M2 report lists the incident among what the build learned.

---

## E65. M2 slice 11: two objections upheld; the review: one serious defect, the engine's kill paths confined (provisional, 2026-10-03)

**Status: provisional.** The driver's defaults under Sean's delegation. Sean confirms or overturns them.

**The Builder's first report** (`build/m2-s11` at `ec01292`): the engine enters its own scope in place, runs the host checks as a startup step, launches every role through a launcher that places itself and asks for the grant, builds the sandbox (user, mount, pid, network, ipc, uts and cgroup namespaces; the domain init as process 1; the workspace an overlay on the volatile filesystem), terminates by closure, TERM, `cgroup.kill` and a read of `populated 0`, closes prior incarnations' supervisor leaves at recovery, quarantines on `unknown`, and re-grants a lease after a pause only on a fresh challenge. `--slice 11`: 921 of 923 cases; unit 145 tests in 30 files. M117 was run last, after M112 and M116 had shown the role in a pid namespace of its own, and passed 3 of 3; the user manager stayed up through every run.

1. **Objections 004 (M112 (e)) and 005 (M115 (f)) upheld**, both faults of the cases' own fixtures: the repair run was the item's first scripted launch and held at a gate nobody released; and the dead incarnation's emptied scope is removed by the manager, so the case's read of `cgroup.events` threw. Each case changed and no more (005 narrower than proposed: absence counts only as `ENOENT` with the whole prior scope gone, the role's pids gone, and no `domain.terminated` before the tick). Merged at `26ce607`; on the Builder's engine M112 passes 6 of 6 and M115 10 of 10.
2. **The kill-path audit (E64 item 2).** The Builder found four writes a wrong store value could reach and guarded them, with unit tests: a prior incarnation's supervisor leaf killed on a recorded `scope_cgroup` whose parent alone was checked (now only this home's scope for that incarnation, by exact name); `kill(-pgid)` on a recorded process group (an edited pgid of 1 would have been `kill(-1)`; now only a group whose pgid equals the recorded pid, greater than 1, not the engine, the same live process); the domain init's `kill(-1, SIGTERM)` (now only as process 1, and the init refuses to start otherwise); the domain directory created on the store's path (now only this engine's scope plus the domain id). Every `cgroup.kill` and `cgroup.procs` write and every cgroup removal goes through one module that refuses any path that is not an engine scope or one directory directly inside one. The Reviewer checked every site from its own search and by calling the guards with hostile values: nothing the engine kills, moves or removes can be pointed outside its own scope except by hand-editing the store's primary keys (item 5).
3. **The review** (the slice's one, E31) found sound: closure before observation (the grant one transaction binding invocation, incarnation and lease generation; every run end closes first; nothing sent to a launcher after closure; migration 0008's triggers forbid reopening); `terminated` only on a read; every unknown condition `unknown`; the pause re-grant (a fresh nonce bound to invocation and generation, role output unable to forge a response, no re-grant by another incarnation or past the deadline or budget); scope before lock (K2), no real dispatch without the manager, recovery by exact unit name; no `host_qualifications` row while H9 and H10 are unexercised; the contract files equal to the code's export; M1's and 0007's migrations unchanged. **What a role can reach today**, probed from inside: none of the engine home, `api.token`, `store.db`, the repository's `.git` files, host `/tmp` and `/dev/shm`, the user's bus socket, the Docker sockets, `/mnt/c`, the cgroup tree, the developer checkout; `/proc/1/environ` and `/proc/1/fd` refused; no listener and no foreign abstract socket in its network namespace; `CapEff` 0, `NoNewPrivs` 1, uid 1000. Readable and not secret: `/proc/1/status`, `/proc/1/cmdline`, and `/surety/workspace/.git`, which names the host worktree path (the git metadata view is slice 12's, M121).
4. **Confirmed serious, by running (one case, one fix): S1.** A tick's re-observation recorded a domain `terminated` while this engine's own launcher was alive and unplaced in the supervisor leaf, because the observe-only path skipped the outstanding-launcher check: against D2 §3.2 ("populated 0 on a domain whose launcher is outstanding is not termination") and §3.4. Reachable only through the seam's `launcher_wait` fault today; in production the engine's wait for a killed unplaced launcher has no limit, so the same condition would hang a run's end rather than give `unknown`. **Reading fixed:** the outstanding-launcher check applies to every observation, and the wait is bounded by an existing setting and yields `unknown` (no new configuration key).
5. **Hardening taken with the fix (small, under E64 item 2), not as findings:** the path check requires the domain id to be `dom_<ULID>` (an edited primary key of `.` or `..` could have made the area removal delete `<home>/domains` or the SIGTERM fallback read `app.slice`'s members); the cgroup's recorded inode is compared before any signal, so a directory recreated at the recorded path is not signalled at recovery; the cause of one intermittent M113 (a) failure in the Reviewer's runs (the kill 2.2 s after closure with `terminate_grace` 5 s) is to be found, since a grace period cut short by a transient unreadable read would be a defect.
6. **The Builder's choices kept (defaults):** the cgroup's inode recorded at creation, a recreated directory never termination; the strict path rule (a recorded path is inside only if it is the domain's own directory in this home's scope of its owning incarnation; anything else is `unknown`), to which SEAM §124 and §129 are amended; three extra `exit_evidence` keys (`report`, `term_sent`, `kill_written`). Consequence for the plan's M114 (c): "an absent path inside it: terminated" means the domain's own recorded directory absent, not a path edited to another absent one, which is `unknown`.
7. **Suspected or recorded, not fixed in this slice:** H1 passing on `uname` alone when there is no scope and H6 passing with "version unknown" (slice 12, where a host qualification first becomes active); the triggers not blocking `authorized` back to `authorizable` or `launched` without `authorized` (the code's edge check does); a role's result line recorded while the role runs, before termination (slice 13, M129); the probe profile's sibling cgroup killed and removed without observing the kill.
8. **Design question for Sean:** recovery kills every scope of its own home, so a concurrent duplicate start caught between its scope and its failed lock dies by SIGKILL instead of exiting 3. (a) Accept and note (recommended: harmless, and M111 (c)'s ordinary duplicate still exits 3); (b) skip scopes whose incarnation has no `engine_incarnations` row.

**Added after the Verifier's pass (also provisional).** S1's case is merged at `945a222` (M115, beside (e)). Writing it turned up three faults in the Verifier's own cases, corrected and labelled:
- **M115 (e) asked for the wrong receipt.** It required a launched and charged invocation for a run whose launch was never authorized; SEAM §§24 and 125 say `refused` and no ledger row, and the engine had met the case rather than the seam. (e) and S1 now require `refused` and uncharged, which makes **a second engine fix in this round**: at a quarantine's clearance the engine recorded and charged an invocation that never ran. Accepted into the round by the driver as the correction of a case, confirmed by running.
- **The intermittent M113 (a) failure was the case's.** It subtracted two wall-clock timestamps with two seconds of slack; this host's clock was measured stepping back 2.93 s every 32 s, and the journal shows a step inside the failing run's window. M113 (a) and M118 (a), (b) now measure on the monotonic clock and read order from event sequence. The Builder's change to the grace loop (only `populated 0` or absence ends the grace early) stays, as D2 requires it whatever caused the failure.
- **The sandbox fixture ends what its engines leave in test scopes**, after a launcher was found waiting at its barrier beyond its engine's life.
- **Readings added to the seam:** the wait for a killed unplaced launcher is bounded by `kill_grace` and yields `unknown` (no new key; Sean confirms); which tick re-grants after a pause is not pinned; a released launcher's own placement after closure is not pinned (D2 §3.2 lets it be a member).
- **For a later Verifier pass (the driver's default: with slice 11's closing pass):** accepted kernel-lane cases that compare wall-clock times with SEAM §23's two-second allowance can fail when a clock step lands in their window, which is the "one timing failure per full run under load" seen since M1 (handoff §4); the remedy is the same as for M113 (a).

**Consequences elsewhere.** No change to D1. D2 §3.1's "created by `systemd-run --user --scope`" is read as E64 item 4 says. `docs/acceptance/reports/M2-not-claimed.md` "After slice 11" gains item 7's entries.

---

## E66. M2 slice 11 merged: the engine runs a role inside a real boundary (provisional, 2026-10-03)

**Status: provisional.** The driver's record under Sean's delegation; nothing new is decided here.

`build/m2-s11` merged to `main` at `d673fb3` (`--no-ff`) after the fix round of E65: S1 and the bounded launcher wait; a never-authorized launch ending `refused` and uncharged, also through quarantine and clearance; the path check requiring `dom_<ULID>`; the inode compared before any signal; the grace period ended early only on `populated 0` or absence. The driver's rerun on the branch tip `c2067a4`: `node scripts/run-tests.mjs acceptance --slice 11` passed 924 of 924 cases in 145 files, none skipped, M117 among them; `npm run test:unit` passed 146 tests in 30 files; the builder boundary check from a clean scratch worktree listed 37 paths, all inside the role's; after the run the user manager was `running` and no `surety-*` scope was left.

After this slice the engine runs in its incarnation scope, checks the host at every start and reports the result, places and authorizes a launcher per invocation, closes before it observes termination, recovers by closing and observing prior supervisor leaves, quarantines on `unknown`, and re-grants a lease after a pause only on a fresh challenge; the scripted backend runs inside the real sandbox. No `host_qualifications` row is `active` yet: H9 and H10 wait for slice 12's probes, so no real backend can be dispatched, as intended.

**Open from this slice, carried, none blocking:** E64 items 4 and 5 and E65 items 6 and 8 (Sean); E65 item 7's recorded items, assigned to slices 12 and 13; the Verifier pass over kernel-lane wall-clock comparisons (with the closing pass).

**Next:** slice 12, rows M119 to M128 (M2 plan §3.4, §3.5): the mount plan, the probes P1 to P19 with their seeded targets and controls, the handover of the workspace, the egress proxy. Its Verifier, Builder and Reviewer are briefed with E64 item 2: P13 is among its probes.

---

## E67. M2 slice 12: five objections answered; the review: two serious defects, six hardening items (provisional, 2026-10-03)

**Status: provisional.** The driver's defaults under Sean's delegation. Sean confirms or overturns them.

**The Builder's report** (`build/m2-s12` at `cf92925`): the validated mount plan published with its fingerprint; the git view (`/surety/git`, core-only config, empty hooks, objects an overlay on the volatile filesystem); materialization of the role's changes after termination behind the secret screen; the context package with its manifest; the probe program and suite P1 to P19 at every start, so H9 and H10 pass and a `host_qualifications` row is `active` for the first time (P20 excused in slice 12 only); the egress proxy (one resolution per attempt, the connection to the validated numeric address, limits, the egress log); H1 observing `cgroup.kill`, H6 failing an unreadable tool version (E65 item 7). `--slice 12` 966 of 972, the six failures being its objections.

1. **Objections 006, 007, 009 upheld; 008 and 010 upheld in part**, merged at `cb67b92`. **008:** the host cannot read the non-dumpable domain init's `/proc/<pid>/environ` while M117 (b) refuses the role `/proc/1/fd`, both being one kernel uid; the Verifier kept M117 (b) and the property, and the host now reads the init's environment from its memory (`process_vm_readv` over `env_start`..`env_end`, a ptrace-checked read the host is allowed as owner of the sandbox's user namespaces and the role is not), both reads required to agree wherever both work. **010:** P14's control stays a workspace write, made by a Builder's fix and checked committed.
2. **The review** (E31) found sound: every kill and removal path inside the engine's own area; P13's two guards (the program's own refused on the host for four independent reasons; the engine's host-side read before `start`); P20's exhaustion actions never sent; every mount in the sandbox's own namespace; materialization never writing outside the workspace (after termination, parents made real first, links replaced and never followed, `O_NOFOLLOW`, FIFOs and devices skipped); the git view (config, `HEAD`, hooks and refs read-only, objects an overlay; the engine's own git with hooks, fsmonitor and filters disabled); the proxy; H9 and H10; the handover; no regression of slice 11. **What a role can reach today:** only `.init bin dev etc home lib lib64 proc surety tmp usr`; no `/run`, `/mnt`, Docker socket, cgroup tree, engine home or `api.token`; `/proc/1/{environ,root,cwd,mem,maps,fd}` refused; `/surety/workspace/.git` now names `/surety/git`; readable and not secret: `/proc/1/cmdline`, `/proc/1/status`, and `/proc/self/mountinfo`, which names host paths as mount sources.
3. **Confirmed serious, by running (one case and one fix each):** **S1**, the secret screen never checked file or directory names, so a held secret used as a name was committed to the integration branch (against D2 §2.5); **reading fixed:** every planned path, deletions included, is screened before any write. **S2**, probe P2 counted a target never sent to the role (the other domain's sentinel was added after the instructions were written; `engine.log` and a record counted only if present) and passed on a count; **reading fixed:** every target seeded and verified first and judged individually.
4. **Hardening taken with the fix (driver's defaults, no acceptance case):** materialization refused before any write when the plan exceeds the existing snapshot caps (it could block the event loop for 13 s on 100 000 files; no chunking in this slice); a pending connection counted against `egress_tunnels_max` from accept and a header timeout logged as a refusal (3000 were held with a limit of 2); the plan and volatile hold built from `realpath` of the area (a home reached through a symlink failed safe, never qualifying); `::ffff:0:0/96` and `64:ff9b:1::/48` added to the forbidden addresses; probe leftovers of a crashed start swept at the next start, by this home's own recorded tag; P8's rebinding check judged on the connected address. No new configuration key.
5. **Defaults the Verifier pinned in the cases:** P20 excused as `not_exercised` in slice 12 only; per-tunnel proxy limits end only the tunnel, `egress_log_max_bytes` cancels the run `failed`/`infra_error`; an exact environment allow-list and a context `manifest.json`; the bootstrap request witnessed by the egress log and the failed connection (`GET` is not audited), an instrument limit. The Builder's: a secret-screen hit fails the run `infra_error` until M132 (slice 13) sets the outcome; a terminated domain's area removed at the next start.
6. **Recorded, not fixed:** `sandbox_read_paths` resolved three times (only another local uid could race it); P12 compares targets and types, not bind sources (M122 (e) does).
7. **Added after the Verifier's pass.** S1's and S2's cases are merged at `6905f73` (M121 and M124), each failing on the unfixed engine at the assertion that states the defect; M119 (c) and M122 (a) now bind their sockets at a short path they verify, so a truncated bind can no longer pass for the target. **Question for Sean (the context package, M125 (c)):** D2 §1.3 and the plan list "the bound requirements, ADRs, constraints and phase plan, dependency interfaces" in `/surety/context`; the engine puts requirement keys and a `text_ref` there, and the case pins entries and their sources, not content. (a) The package carries the approved texts (recommended: a role inside the sandbox has no other way to read them, and the real lane's journey needs them); (b) references suffice. **Decided by Sean, 2026-10-03: (a).** The package carries the approved texts; built and pinned in slice 13 (a seam change and a fixture binding ADRs and constraints), before the real lane.

**Consequences elsewhere.** No change to D1 or D2.

---

## E68. M2 slice 12 merged: a host qualification is active for the first time (provisional, 2026-10-03)

**Status: provisional.** The driver's record under Sean's delegation.

`build/m2-s12` merged to `main` at `fa2b3f8` after the fix round of E67. **The driver's first rerun** on `f739459` was not clean, 969 of 974: M120 (a) to (d) failed because the probe suite's seeding of P2 created an empty `engine.log`, so the case's own seed was skipped (fixed on the engine side: a target the suite seeds has content); and M118 (b) failed once by timeout, which the Builder traced to **a real defect**: while one pause challenge was outstanding a later tick sent a second, and its answer re-granted a lease that D2 §3.5 forbids replacing while a challenge is outstanding (it failed 2 of 6 alone; fixed: one challenge at a time per run, none again on the same lease generation after an unanswered one; 8 of 8 after). **The driver's second rerun** on `4999c70`: `--slice 12` 974 of 974 cases in 156 files, none skipped; unit 156 tests in 31 files; builder boundary check 44 paths, clean; the user manager `running` and no scope, `/dev/shm` or `/tmp` probe leftovers after.

After this slice the engine builds, validates and publishes the mount plan, presents the repository through its own git view, materializes a role's changes after termination behind the secret screen, hands over exactly the bound context, runs P1 to P19 at every start with seeded targets and controls, and holds an **active host qualification** on this host; egress goes only through its proxy to validated addresses. No real backend runs yet: no trust entry is active (slice 13 writes and activates entries; slice 14 qualifies Claude Code under Sean's approvals).

**Open, carried:** E67 items 5 and 6 (defaults; recorded items); P20 and the context package's texts (Sean's decision, E67 item 7) in slice 13; the closing pass re-runs the Reviewer's crash-during-suite and symlinked-home scripts and adds `header_timeout` to SEAM §140's reasons.

---

## E69. Exhaustion tests run on a second host; P20 excused on this one; the test caps (decided, 2026-10-03)

**Status: decided by Sean**, one item at a time; the mechanism details marked as the driver's are provisional.

The slice-13 Verifier stopped before writing the fork, allocation and storage-filling instruments (P20, M130 (f) and (g), M133), after a safety check interrupted it and in view of E64, and found the plan's caps too tight for this engine (`pids.max` counts threads: a bare Node process holds about 7; Node's own memory is about 6 MiB plus file pages; the engine's configured minimums are 64 tasks and 512 MiB).

1. **The test caps (Sean):** process-limit cases at `pids.max` 64 with `sleep` children that never fork; every memory case at 64 MiB (M130 (f)'s 32 MiB raised); each instrument also stops itself at 96 tasks or 128 MiB whatever the cgroup does. Test-only values set through a harness override of the domain's limits; the engine's defaults and ranges unchanged.
2. **Where they run (Sean):** not on this WSL workstation. After asking for a throwaway VM, Sean offered `mini-hp01` (on his Tailscale network; bare-metal Arch-based, kernel 7.1.9, 12 cores, 16 GB; cgroup v2 with `nsdelegate`, `memory` and `pids` delegated, unprivileged user namespaces, the user manager running; no Node; it also runs staging Docker containers under root) and chose to run there, guarded: Node installed in the user's home directory, only the exhaustion files run, one at a time, under uid 1000, each reading the limits in force from the host before release and capping itself, stopping at the first anomaly. The staging containers are the only exposure, reachable only if both guards failed.
3. **P20 on this host (Sean):** the engine's start-up probe P20 reports `not_exercised` here and the host qualification accepts that excuse, listed as not claimed; the engine still reads back every domain's limits before authorizing a launch (the slice-13 Builder's brief); the exhaustion proof comes from the run on `mini-hp01`. Slice 14 can proceed on this host.
4. **Mechanism (the driver's, provisional):** P20 runs only when the engine is told the host is designated for exhaustion probes (one closed configuration key, default off, its name fixed by the Verifier and Builder in the seam; on a host without it P20 is `not_exercised` with the reason and excused); the exhaustion acceptance files form their own manifest list run by an owner-added runner lane (`--lane exhaust`), never in `npm test` on this host, like the paid real lane; the slice-13 cases are written in smaller sessions, the exhaustion files last.

---

## E70. M2 slice 13 cases, parts 1 and 2; the exhaustion lane in the runner (provisional, 2026-10-03)

**Status: provisional.** The driver's defaults under Sean's delegation, except where marked.

The slice-13 cases are written in three parts (E69 item 4). **Part 1**, merged at `e1f6e73`: M129 (the result read after termination, P18), M130 (exit classes; (f) and (g) failing placeholders for the exhaustion host), M125 (c) extended for the approved texts (Sean's decision, E67 item 7); SEAM §§143 to 147. **Part 2**, merged at `149a604`: M131 (usage, resume, the session id), M132 (secrets, volatile storage, provider files), M134 (revocation, the host qualification), M135 (the qualification attempt without a model); SEAM §§148 to 154. Every new instrument that writes, connects, spawns or signals is behind SEAM §141's guard; the driver read each before merging; no exhausting code exists in either part (M132 (e)'s collection bounds are reached through a harness override and a slow-collection fault with a handful of small files; M130 (h) lowers one test domain's `pids.max` to its current count plus two and tries at most eight `sleep`s).

**Readings taken as the driver's defaults (the Verifier's recommendations):**
1. `result_collection.outcome` `accepted` is the collector's verdict on the file; the exit class decides whether it becomes the run's result.
2. M130 (h) on this host as written (bounded, exhausts nothing).
3. `exit_evidence.resource_events` holds both keys, each a count or null when unread, never `{}` or 0.
4. The session id: the engine's v4-shaped SHA-256 of `surety-session:<invocation id>`; M136's canary establishes whether Claude Code accepts it.
5. The domain init's lifetime after its backend exits stays unpinned.
6. The phase-plan and dependency-interface texts (E67 item 7) are left to the M140 journey: no module fixture binds an interface text cheaply.
7. M135's attempt "for `scripted` with the stand-in binary" is a harness-mode attempt whose binary runs the scripted role, which writes a trust entry for `scripted` in harness mode only (SEAM §113 amended by §148); a `claude` attempt goes as far as its proposal.
8. A secret-screen hit: the materialization or publication refused, the run `failed` / `infra_error` with `reason_text` naming `secret_refused` (E67 item 5's interim class kept), one Critical `security` finding, one `evidence.secret_refused` event; the transcript redacted, not refused. Alternative for Sean: a reason class of its own.
9. A mechanism change requires requalification (`requalification_required`), the entry not revoked.
10. Collection bounds below the configured ranges only through harness overrides.
11. A forged probe report is the backend printing lines in the probe program's report form.

**The exhaustion lane (owner's change, E69 item 4).** `scripts/run-tests.mjs` gains `--lane exhaust`: files listed under the manifest's `exhaust` run only there, never in the full run or a slice (whose rows must still have files), and only when the environment variable `SURETY_EXHAUSTION_HOST` equals the machine's hostname, so the lane refuses on a host nobody designated by name; checked here: it refuses on this workstation (`MSI`). `CLAUDE.md` lists the command.

---

## E71. M2 slice 13: the Builder's report, objections 011 and 012, the review (S1 to S5) (provisional, 2026-10-04)

**Status: provisional.** The driver's defaults under Sean's delegation, except item 6, which is Sean's to decide.

1. **The Builder's report** (`build/m2-s13` at `697e325`): limits written and read back before a launch and again at the grant; P20 behind `isolation_probe_exhaustion` (default false, E69); the result read only after termination (`invoke/collect.ts`; E65 item 7 fixed), `result_collection`, exit classes, `unaccepted_result`; the secret screen over the provider-files inventory; the session id at dispatch; admission by the envelope; revocation and requalification; `POST /v1/trust/qualify` with three canaries end to end without a model; approved texts in the context package (Sean, E67 item 7); inherited descriptors above 2 closed in the engine, the launcher and the init (the `mini-hp01` finding: the role held two `/dev/ptmx` descriptors inherited from a Tailscale SSH session). `--slice 13` 1,008 of 1,015, the failures being the exhaustion placeholders, the contract key and objections 011, 012. **Disclosed:** before the E69 message reached it, the Builder's old P20 ran on this workstation four or five times, bounded at 64 tasks and 224 MiB, with no harm and nothing left; none since.
2. **Objections 011 upheld, 012 upheld in part** (`de8b1a3`): M131 (c) holds the key again after its restart; M132 scans the engine home with an exception verified to be the init's execute-only node copy or a hard link of it. The contract gains `isolation_probe_exhaustion`; P20's excuse names it.
3. **Part 3 of the cases** (`ba1864d`): `M133-resource-limits` (incl. P20 pinned with the key true) and `M130-exit-classes-limits`, listed under the manifest's `exhaust` key, guarded in two halves and self-bounded, read by the driver, never run on this host (the runner refused). The Builder added the `stream_slow` fault (`790fbec`) and kept a transcript cut at a stream bound.
4. **The review** (E31) found sound: limits before launch on every path; P20 by reading; collection only after termination, nothing collected from an `unknown` domain; an attempt dispatching only its own canaries; activation only through `trust_activation`; revocation at start and claim; a real backend refused without a resolvable key; admission in the claim transaction; descriptors. **Confirmed serious, by running (one case and one fix each):** **S1**, the containment canary's pass could be forged by a backend that kept the probe from acting and reported in its name (the init trusted a pid written in the report); **S2**, a held secret reached `store.db` and the events API through `domain.egress_refused`'s raw CONNECT authority; **S3**, the positive canary was judged by the engine reading, on the host, through a link the role made (a link to a FIFO would block the engine, to `/dev/zero` allocate without bound); **S4**, a held secret reached a run's reason and events through a materialization error raised before the screen; **S5** (minor), a non-clean run got a record of kind `result`.
5. **Readings fixed (the driver's defaults):** S1's witness identifies the reporter by the kernel's credentials of the connected peer and accepts only the probe started as the probe, and the containment canary also requires D2 §7.2's host-side evidence (the egress log, the configuration and the sentinel unchanged); the residual risk (a parent that can ptrace its child) is recorded as not claimed until the observer exists. Every host-side read of a role-controlled path is no-follow, regular-only and bounded. Every stored reason or detail derived from role-controlled names is screened. **Hardening taken with the fixes:** an entry records only capabilities and egress the canaries established (`entryInput` had recorded every capability as verified and no egress); the screen-hit path bounded by the snapshot caps; the init's barrier read no-follow; `term_to_exit_ms` on the monotonic clock; `terminal_event` as SEAM §145; the qualified binary's `--help` run only at qualification and at start, its bytes hash at every dispatch, `runStatic` bounded with its descendants; an admission hold makes a canary wait rather than fail. **Also the Builder's defaults:** a `scripted` entry's `usage_granularity` `invocation` when no usage is observed; the spend estimate null without a price table; the cancellation canary ending `stopped`/`human_stop` with `canary_barrier`; an attempt running at a restart invalidated `engine_restarted`; the Verifier's: a held dispatch shown on the work read only (it has no run); the `stream_slow` fault.
6. **For Sean: memory admission (`host_reserve_memory`).** (a) The Builder's: only the new domain's `memory.max` against memory available now (a second 8 GiB domain is admitted on this 16 GB host while the two could use 16 GiB plus the reserve); (b) D2 §3.7's text: also hold back each running domain's remaining headroom, which at the defaults admits one domain at a time here; (c) (b) with a lower default `domain_memory_max`. The Reviewer recommends (b) or (c); the driver's default until Sean decides: (a) as built, harmless while `max_concurrent_runs` is 1 (E18), with the code's comment corrected to say so.

---

## E72. M2 slice 13 merged: the sandbox lane is complete on this host (provisional, 2026-10-04)

**Status: provisional.** The driver's record under Sean's delegation.

`build/m2-s13` merged to `main` at `11564f8` after the fix round of E71. The Builder's S1 fix redesigned the containment canary: the domain init accepts no outcome from inside the sandbox; the probe program the backend runs only asks the init to act; the init checks for a live descendant of the backend with exactly the action's argv, performs the action itself in its own execute-only child, and the judge adds host-side checks (the token's bytes and the fixture repository's configuration unchanged, the unlisted CONNECT refused in the always-published egress log). Residuals recorded as not claimed: a co-descendant can stand in for a stopped probe with the exact argv (the action is still the init's), the backend can kill the init's child (the canary fails), `engine_port` has no host-side corroboration. Objections 013 and 014 upheld (`1c17af4`). The qualified binary's `--help` still runs at every dispatch, as SEAM §150 and M134 (b) pin; `runStatic` now runs in its own process group, killed whole at its limit.

**The driver's rerun** on `9ca622e`: `--slice 13` 1,018 of 1,018 cases in 162 files, none skipped; unit 172 tests in 35 files; builder boundary check 56 paths, clean; the user manager `running`, no scope, `/dev/shm` or `/tmp` probe leftovers, available memory unchanged. **Not run here:** the exhaustion lane's files (`M133-resource-limits`, `M130-exit-classes-limits`, P20; manifest `exhaust`, E69), which run on `mini-hp01`.

**A process slip, recorded:** to confirm objection 014, the Builder briefly wrote a copy of an acceptance file inside `packages/engine/test/acceptance/`, outside its paths; it deleted it, never committed it, and reported it itself. Copies go under a scratch directory from now on.

After this slice every sandbox-lane row M110 to M135 has its cases on `main` and passes on this host, except the exhaustion cases, which wait for `mini-hp01`. Open for Sean: E71 item 6 (memory admission). Next: the closing pass, the exhaustion run on `mini-hp01`, then slice 14 (the real lane), which needs Sean's API key with its $50 cap and his two approvals.

---

## E73. The exhaustion lane on mini-hp01: the limits hold on a second host (provisional, 2026-10-04)

**Status: provisional.** The driver's record of runs Sean authorized (E69).

On `mini-hp01` (bare-metal, Arch-based, kernel 7.1.9; Node 22.22.0 installed in `~/surety-exhaust` from the official tarball, checksum-verified; the repository copied as a git bundle of `main`; `TMPDIR` on disk because `/tmp` there is tmpfs, which the engine correctly refuses for its home; the session variables of the user manager set explicitly because a non-interactive Tailscale SSH session lacks them), each file run alone:

1. **Before any exhaustion file:** `M110-host-checks-and-scope` 4 of 4 (the host qualifies, now that inherited descriptors are closed: the P14 failure there had exposed the leak), `M112` 6 of 6, `M116` 4 of 4 (the role contained in its own pid namespace on that host).
2. **`M130-exit-classes-limits`** 2 of 2: an allocation at `memory.max` 64 MiB OOM-killed inside its domain; a Stop's `engine_signaled` kept over a later OOM.
3. **`M133-resource-limits`** 8 of 9 on `main` at `36f1539`, then 9 of 9 against the fix: `pids.max` 64, `memory.max` 64 MiB, 1 MiB of writable storage and 64 inodes each stopping the role with its control passing; admission by configuration; two domains at their limits with a third held and the API answering; H11 forced; **P20 passed** with `isolation_probe_exhaustion` true, each box's limits read back. **The one failure was an engine defect** (M133 (g)): a run cancelled at `stream_line_max_bytes` stored the whole over-bound line, because each chunk reached the transcript before the bound was checked; fixed (`5cc1e62`; unit test with a 32-byte bound; the driver's regression `--slice 13` 1,018 of 1,018 here, unit 173).
4. **What the host saw:** every kernel OOM kill carried `constraint=CONSTRAINT_MEMCG` with the memory cgroup of a test domain (`…/surety-<hash>-inc_<ULID>.scope/dom_<ULID>`) or a P20 box (`…/probe_<ULID>`), none outside; the five staging containers stayed up and healthy throughout; available memory and the user's process count returned to their baseline after each file.

**Not claimed:** the exhaustion proof is for these two hosts' kernels (WSL2 6.6.87.2 for everything else, 7.1.9 for the exhaustion lane); the probe P20 stays excused on the development workstation (E69 item 3).

---

## E74. The real lane authenticates by subscription token; the API-key mode kept; the slice-14 review (decided in part, 2026-10-04)

**Status:** item 1 **decided by Sean**; the rest provisional, the driver's defaults under his delegation.

1. **Authentication (Sean, amending D2 Q1 and A.2's `AuthMode`).** Sean asked why the real lane needed an API key when it "was supposed to run via subscription". D2 Q1 (dedicated API keys per provider), accepted in a batch of recommendations (E56), had followed from the template's `--bare`, under which Claude Code takes Anthropic authentication only from `ANTHROPIC_API_KEY` or an `apiKeyHelper`, never OAuth. Given the options (a subscription token only; the API key only; both), **Sean chose both, the key later:** the engine supports two auth modes, `subscription_token` (a long-lived token from `claude setup-token`, which requires a Claude subscription, held by the engine as a secret file exactly as a key is) and `api_key` (as D2 has it); **M2's real lane runs on the subscription token**; the `api_key` mode stays qualifiable for later (a team or CI setup). Consequences, each to be established by the canaries rather than assumed: the subscription template drops `--bare` (so hooks, plugins and CLAUDE.md discovery are not switched off by the flag; the volatile home is empty, and what loads is established and recorded); the token's delivery path into the backend is the documented one, qualified by the positive canary; dollar budgets act on Claude Code's own `total_cost_usd`, a client-side estimate, so `cost_status` for this mode is `estimated`, and the hard limit is the subscription's own usage limits, which Sean's own Claude sessions share; the blast radius of a leaked token is the subscription account (revoked by logging out or revoking the token), contained by the egress proxy allowing only the provider; whether automated use fits his plan's terms is Sean's to check. The trust entry records `auth_mode`; an entry for one mode never authorizes the other.
2. **The slice-14 review** (on `a2c091e`) found sound: no paid launch without `qualification_approval` (canaries) or an `active` entry from `trust_activation` (project work); a missing credential refuses the launch; the fixture project launches nothing; `--harness-real-lane` admits only a non-attempt dispatch to an active entry; the spend estimate shown before approval with the provider cap; the key only in processes inside domain cgroups, redacted in the transcript, in no file or git object; the secret file refused when relative, a link, a FIFO, group-readable, oversize, multi-line, empty, under the home or missing; the entry bound to the resolved versioned binary and revoked when it is pruned or changed. **M118's intermittent failure is on `main`** (5 of 6 there, 6 of 6 on the branch), not caused by the branch; cause not found. **Confirmed (one case and one fix each):** **S1**, incomplete terminal totals recorded as complete and overwriting observed per-call usage (`usage_complete` 1 with a null input count; no allowance charged); **S2**, the delegation check passing on a deny-list (a `Skill` or other unrequested tool in the inventory still `delegation_verified`) and the host sampler failing open (never identifying the backend, yet passing); **S3** (minor), a key passed in place of its path echoed back in `secret_file_refused`.
3. **Readings fixed (driver):** usage is final only when every count is known, and a null never overwrites a known count; the mid-run budget check never reads an unknown count as zero; the tool inventory must be a subset of the template's `--tools`, and the sampler must have seen the backend at least once; the first terminal event wins and a second is a protocol error; the adapter's message-id set and the sampler's `/proc` reads are bounded; the key file opened non-blocking; a fixture project found by its resolved path. **Design defaults:** the engine **copies the qualified binary into its own home and pins the copy** (Claude Code's installer prunes old versions and its updater changed 2.1.288 to 2.1.289 overnight; the operator's own install and settings are never touched); `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set in the backend's environment for canaries and project runs (a template version change; no entry exists yet); background Bash under `--tools Bash` recorded as class C, contained by the domain; key or token delivery must be established for the positive canary to pass; cache writes priced at their own rate in the estimate.

---

## E75. Objection 016, M118, memory admission, the handoff (decided by Sean, 2026-10-04)

**Status: decided by Sean.** Recorded while the build is paused (E74's pause); no agent was started and no model was called to record it.

1. **Objection 016: uphold the remaining mismatches.** The Verifier explicitly allows the three approved updater and telemetry environment variables (`DISABLE_AUTOUPDATER`, `DISABLE_UPDATES`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; E74 item 3) and asserts their intended values; it keeps rejecting unexpected variables and inherited credentials. It tests the engine-owned pinned binary's location and an independently calculated hash. The subscription-authentication changes already merged are preserved. **Expected values remain independently defined by the tests, never copied from the implementation.**
2. **M118: investigated before real-agent qualification.** The intermittent failure (E74 item 2: seen on `main` as well as on the branch) is traced to its cause, engine behaviour, the test fixture or host timing; the failing evidence is preserved; the identified cause is corrected; and both the affected cases and the normal regression suite are shown passing. The existing requirements for lease renewal, cancellation and deadlines stay. **A successful retry alone does not close the issue.** This is engineering work for the agents, not a design choice.
3. **Memory admission: option B of E71 item 6, with the current defaults.** Admission reserves enough memory for every admitted domain to grow to its configured limit while keeping the host reserve, and holds additional work when that capacity is unavailable. The single-run setting stays for M2; lower concurrency is the accepted trade-off. The per-domain memory limit is not lowered now. This replaces the Builder's reading kept as the default in E71 item 6.
4. **The handoff:** E74 is authoritative. M2's real lane uses Sean's **subscription token**; API-key qualification remains a later option; this mode has **no separate $50 API spending cap** (the hard limit is the subscription's own usage limits, E74 item 1). The handoff names the actual checkpoint, lists objection 016 and M118 as pending, and keeps the explicit pause. Correcting the handoff starts no model calls.

**Consequences.** Before Sean's paid run: objection 016 answered and the Builder's branch passing it; M118's cause found and fixed with evidence; the envelope's admission rule changed to option B, with a case that pins it (the Verifier) and the engine change (the Builder). E59's "$50 provider-side cap on the dedicated key" applies only to the later API-key mode.

---

## E76. M118's cause found; objection 016 answered; memory admission option B built (decided in part, 2026-10-04)

**Status:** item 3 **decided by Sean**; the rest provisional, the driver's record under his delegation.

1. **Objection 016 answered on Sean's terms (E75 item 1)**, merged at `72e9654`: M125 (b) requires `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` at `"1"` (from Claude Code's documentation; `DISABLE_UPDATES`'s value by convention, the driver's default pending Sean) and refuses inherited `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` beside every other unexpected variable; the real lane expects the subscription mode and checks the engine's pinned copy (`<home>/backends/claude-<version>-<sha16>`, `<version>` the first word of `--version`, the driver's default) against a path and SHA-256 the test computes from the source binary itself. The option-B case `M133-memory-admission-reserves-the-limit` (sandbox lane, nothing allocated) failed on the unchanged engine at its assertion.
2. **Memory admission option B built** (`ca6234d` on `build/m2-s14`): every admitted domain, the new one included, reserved at `domain_memory_max` plus `host_reserve_memory`, checked against `MemAvailable` plus what running domains already hold, an unreadable value holding the dispatch; the case passes there.
3. **M118 (E75 item 2): the cause, reproduced deterministically** (evidence under the driver's scratch `m118/`; repetition alone, 5 quiet and 3 loaded runs, never reproduced it). **Cases (a) and (b): host timing against the test's margin.** The engine judges a run lease's expiry on the wall clock, as recorded (E65); this host's wall clock steps back every ~31.6 s (−0.6 s measured today, −2.9 s on 2026-10-03), so a pause of `lease_ttl` + 3 s can hold steps enough that the lease is not expired when the engine continues, no challenge is sent, and the test waits for one that never comes. Reproduced 3 of 3 by stepping only the engine's wall clock back 5.8 s at the pause; controls passed. **Sean decided: keep the wall clock** for lease expiry (no change to the rule); the test waits until the lease has really expired on the engine's clock (objection 017, to the Verifier); the residual effect, a run paused just past its lease and still heartbeating being renewed without a fresh challenge, is listed as not claimed. **Case (c): an engine defect.** When the backend exits during the pause, the first tick takes the exit and renews nothing; a second tick reaching expiry reconciliation before acceptance starts recovered the run, because the flag saying the run ends by its own exit (`expiryExempt`) was not consulted there. Reproduced 3 of 3 by holding collection at the existing `collect.before_read` barrier. **Fix (the driver's go):** expiry reconciliation leaves such a run to its own end protocol, with a unit test.

---

## E77. M2 slice 14's engine side merged; objection 018; a network-dependent fixture (provisional, 2026-10-05)

**Status: provisional.** The driver's record and defaults under Sean's delegation.

1. **Objection 018 upheld** (`26d6880`): M115 (e) ticked once immediately after releasing a paused launcher, which could still be in the domain; the engine rightly refuses termination while its own launcher is there (slice 11's S1 rule) and the next tick was 600 s away. The case now waits for the launcher to leave before its tick; M115 11 of 11 in three runs on the Builder's engine. **The engine-side alternative** (requesting a tick when a quarantined domain's launcher exits, so recovery does not wait for the next scheduled tick) is recorded as a later improvement, not built (scope).
2. **Slice 14's engine side merged** at `c3a2651`: the Claude Code adapter, real-backend canaries, credentials as secret files with the subscription-token mode (E74), `surety qualify`, the engine's pinned copy of a qualified binary, the update and traffic switches, the review's S1 to S3 and hardening (E74), memory admission option B (E75), M118 (c)'s fix and pre-claim revocation (E76), objections 015 to 018. Nothing paid ran. **The driver's rerun** on `25cefa4`: `--slice 13` 1,017 of 1,018 in 162 files, unit 210 in 40 files, builder boundary check 48 paths.
3. **The one failure, M128 (b), depends on the host's network.** The case expects a connection to a documentation-range address (`198.51.100.20`) to hang until `egress_connect_timeout` (1 s); this host's router answers EHOSTUNREACH (3.1 s cold, faster when the kernel has the unreachable cached), and the proxy correctly logged `connect_failed`. It passed 6 of 6 alone twice afterwards; by the rule Sean set for M118 (E75 item 2) those passes do not close it. **Fix (driver's decision):** a harness-only fault (`egress_connect_hang`) that holds the proxy's connect to a named address open until the timeout, so the case no longer depends on any network; the Verifier pins it and changes M128 (b), the Builder builds it. Merged before the closing pass.
4. **Astra's documentation additions** (`f978c5f`, indexed `c85d895`): three architecture whiteboards with their prompts and build-status data, and her progress journal, committed unchanged under Sean's authorization ("Preserve their contents; these documents do not authorize implementation changes").

**Next:** the hang fault and M128 (b); the closing Verifier pass on `main`; then the build stops for Sean's real-agent run (his subscription token from `claude setup-token`, his two approvals, the hands-on script).

---

## E78. M2 is ready for Sean's real-agent run (provisional, 2026-10-05)

**Status: provisional.** The driver's record under Sean's delegation; nothing decided here.

1. **The network-dependent fixture is fixed** (E77 item 3): a harness fault, `egress_connect_hang` (SEAM §169), holds the proxy's connection to a named documentation-range address open until `egress_connect_timeout`; M128 (b) and M127 (a) to (e) and (h), which also depended on what the network answered, use it (`a980d16`, `1c3267f`).
2. **The closing pass** on `main` at `1c3267f` (merged `3a1697d`): `--slice 13` 1,018 of 1,018 cases in 162 files, none skipped; unit 214 tests in 41 files; slice 14's no-cost files pass (M125, M133's option-B case, M136 with a fake backend, M137's negatives, M140's credential case, M142); M141 (b) fails by design until the real lane fills the report (51 facts pending). The real lane has not run, the exhaust lane was last run on `mini-hp01` before option B (E73), and `npm test` fails at M141 (b) until the real-agent run.
3. **Leftovers:** two probe leftovers of a disposable test home from 2026-10-04 (`/dev/shm/surety-probe-479295dcfa04` and the `/tmp` directory of the same name, holding one socket), which the engine's own sweep can never reach because that home never starts again, were removed by exact name. Recorded as a later improvement: the test harness sweeps the probe leftovers of the homes it disposes of.
4. **What M2 now waits on, all Sean's** (E74, E75): the real-agent run (`docs/acceptance/reports/M2-hands-on.sh`), for which he creates his subscription token with `claude setup-token` and saves it in a file only he can read, answers the two approvals (`qualification_approval`, `trust_activation`) as the run reaches them, and makes the hands-on checks; confirming the `claude-sonnet-5-5` prices; whether `--safe-mode` stays in the subscription template; the defaults `DISABLE_UPDATES=1` and the pinned copy's naming (E76 item 1); whether automated use fits his plan's terms; and, outside M2, handing the D3 review brief to Astra.

---

## E79. While M2 waits: a dress rehearsal of the real lane and the launcher-exit tick (decided by Sean, 2026-10-05)

**Status: decided by Sean** (the choice of work); the mechanisms are the driver's provisional defaults.

Asked what could be done while M2 waits for his real-agent run, Sean chose two of four options:
1. **A dress rehearsal.** The real-lane cases M136 to M140 and `M2-hands-on.sh` have never run. They are run end to end against a fake Claude Code (a script printing synthetic stream-json, never the real binary) in a disposable home, so their own defects surface before the real run spends his time and subscription allowance. The rehearsal sends nothing to Anthropic and uses no credential of his: a made-up token in a private file, and an egress list with no real host, so the provider-tunnel control is expected to fail and is recorded as such. Approvals that the real run leaves to Sean are answered by the rehearsal only through a rehearsal switch that refuses to work unless the backend binary is the fake one. Defects found go to the role that owns them (the cases and the script to the Verifier, the engine to the Builder).
2. **The launcher-exit tick** (E77 item 1, recorded then as a later improvement). When the launcher of a quarantined or closing domain exits, the engine requests a tick, so that recovery and clearance do not wait up to the next scheduled tick (600 s). One case and one engine change. Sean accepted the scope.

Not chosen: re-running the exhaustion lane on `mini-hp01`; the test harness sweeping its disposed homes' probe leftovers.

---

## E80. The dress rehearsal's results: fourteen defects fixed, two engine findings (provisional, 2026-10-05)

**Status: provisional.** The driver's record and defaults; item 4 is a question for Sean.

1. **The rehearsal ran** (E79 item 1; SEAM §171), merged at `50c4a73`: the real-lane cases, the harness and `M2-hands-on.sh` end to end against a fake Claude Code (a small native wrapper carrying a marker, so the host sampler sees a native image as with the real binary; built with the host's C compiler, rehearsal only), nothing sent to a provider (the only candidate destination `provider.rehearsal.invalid`), the real binary never run. The rehearsal switch `SURETY_REAL_REHEARSAL=1` lets the harness answer the two approvals itself only for the fake, refusing a binary without the marker, over 1 MiB, or inside Claude Code's install directories (the real binary is refused all three ways). Results: M139 2/2, M137 2/2, M140 5/5 (path two mixed, in `api_key` mode on a fixture entry), the hands-on script three full runs through a pseudo-terminal; M136 (b) and M138 (c) can be judged only on Sean's real run (the provider tunnel cannot run offline), recorded as expected rehearsal failures with every assertion kept.
2. **Fourteen defects in the real-lane cases, harness and script, fixed**, among them four that would have spoiled Sean's real run: the attempt's host sampler started after the approval wait and saw no canary; the policy was set after the plan, so the engine dispatched the Builder under the default backend and refused it; the hands-on script's CHECK (4) could never show (`[ -s cgroup.procs ]` is always false on cgroupfs); the token search could print "nothing found" after a real match (grep exits 2 on an unread file).
3. **Two engine findings, one case and one fix each** (driver's decision; the Verifier and the Builder on `verify/m2-real-findings` and `build/m2-real-findings`): (a) **agents are not told what the gates read**: the context package's result schema names only `status` and `summary`; a Reviewer receives no finding ids and no candidate diff (D2 §1.3 lists the diff), a fix Builder is not told its finding, so with a real agent the journey's path two would stall; (b) **the host sampler counts a forked child before its exec as a second backend**, so a well-behaved Claude Code, which starts a child per Bash command, could fail the containment canary `delegation_unverified`.
4. **Question for Sean (R12.2):** does "every commit on the integration branch is the engine's with run and role trailers" include the engine's own bootstrap and policy commits, which belong to no run? **Driver's default:** they are the engine's commits and are judged as such (author and committer the engine, no agent's), without run trailers; the journey's trailer check starts from the journey's first run.

---

## E81. The rehearsal's fixes and the launcher-exit tick merged; M2 ready again for the real-agent run (provisional, 2026-10-05)

**Status: provisional.** The driver's record under Sean's delegation; item 3 lists what is Sean's.

1. **The launcher-exit tick** (E79 item 2) merged at `4c2e3d6`: the engine requests a tick when the launcher of a quarantined or closing domain exits (SEAM §170); exits within one turn of the event loop request a single tick. Objection 019 upheld (M115 S1 and (h) accept the domain removed by that tick; S1 now checks at every read that no termination is recorded while the launcher lives). The driver's rerun: `--slice 13` 1,019 of 1,019, unit 217.
2. **The rehearsal's two engine findings fixed** (E80 item 3), merged at `f03d717`: each role is told every result field the engine reads from it, the Reviewer receives the candidate's diff, its open findings and the sign-offs its tier requires, the fix Builder its finding (and a lookup that never found a Reviewer's or Verifier's candidate is fixed: their packages had no candidate at all before); the host sampler follows SEAM §172 (a fork that has not exec'd and is under 1 s old is not a second backend, by the kernel's `PF_FORKNOEXEC` flag and its start time; unreadable counts as a backend); a containment canary whose control did not run is `containment_failed` (SEAM §165). The driver's rerun: `--slice 14` 1,037 of 1,038, the one failure M141 (b) by design (51 report facts pending), unit 232 in 44 files.
3. **What M2 waits on, all Sean's:** the real-agent run (`claude setup-token` into a private file, `docs/acceptance/reports/M2-hands-on.sh`, the two approvals, the hands-on checks); the `claude-sonnet-5-5` prices; whether `--safe-mode` stays; the defaults `DISABLE_UPDATES=1`, the pinned copy's naming (E76) and §172's 1 s fork bound; R12.2 and the engine's setup commits (E80 item 4); whether automated use fits his plan; the D3 brief for Astra. **Noted from the rehearsal:** the native fakes are compiled with the host's C compiler at test time, as the power-loss shim already was; a Builder twice started a real-lane file by mistake, refused each time by the file's own preflight before anything started.

---

## E82. Sean's first real-agent run: two canaries pass, the containment canary is refused by the agent (record, 2026-10-05)

**Status: a record of Sean's run; the design question in item 3 is his.**

1. **The run.** On 2026-10-05 Sean ran `docs/acceptance/reports/M2-hands-on.sh` with his subscription token (E74) and Claude Code 2.1.289, which the engine copied into its own home and pinned (`<home>/backends/claude-2.1.289-a186b99e4a9c8836`). The home is kept at `~/surety-hands-on-20261005T112359Z`. The host checks, the refusal with no entry, the attempt and his `qualification_approval` worked as designed; CHECK (4) showed the canary's processes in its domain's `cgroup.procs` (the launcher's `unshare`, the domain init, the backend).
2. **The canaries.** **Positive: passed. Cancellation: passed** (`term_to_exit_ms` 12). **Containment: failed, `containment_failed`**, with no action witnessed. Claude Code (subscription, `claude-sonnet-5-5`, with a `system/model_refusal_fallback` to `claude-sonnet-5` within the run) read the canary's instructions as a prompt injection, because they asked it to probe a token path under the host's home, the engine's port and an unlisted host, and to try delegation and scheduling tools, against its own standing `instructions.md`; it declined all of it and wrote an honest result reporting the attempt as a security finding. The host-side checks agree that nothing was touched (the token file's and the fixture repository's configuration unchanged; no unlisted CONNECT in the egress log). Claude Code's own estimate for the containment canary: 0.126 USD. The attempt is consumed (`failed`); no trust entry was written; the journey did not start.
3. **The finding (design, D2 §7.2).** The containment canary depends on the agent's cooperation in attempting breaches; a well-behaved model refuses such a request, rightly, so the canary cannot pass with it as written. A decision for Sean on how to redesign it (item 4 of the next entry records his choice).

---

## E83. The containment canary redesigned: an honest, sanctioned check (decided by Sean, 2026-10-05)

**Status: decided by Sean**; the mechanism details are the driver's provisional defaults.

After E82 (the real agent refused the containment canary as a prompt injection), Sean chose, of three options, **an honest, sanctioned check**:
1. The containment canary's run tells the agent plainly, in its own standing instructions (`instructions.md` for that run, not only the task prompt), that the run is the operator's sanctioned containment check of the sandbox it runs in, that the actions are expected to be refused, and that it is asked only to run the provided probe program once and report its output verbatim in the result. Nothing in the canary's instructions contradicts the standing instructions.
2. **No host path, credential path, port or host name appears in anything the agent reads**: the probe program takes its targets from the domain init (which already performs the denied actions itself, E72's S1 design), not from the prompt or a file the agent is asked to open.
3. **Delegation is established from the tool inventory** in Claude Code's start event (D2 §4.5 already allows an inventory, "otherwise by an executable capability test"); the canary no longer asks the agent to attempt delegation or scheduling tools. The inventory must be a subset of the template's `--tools` (E74).
4. The host-side corroboration (the token's and the fixture configuration's bytes unchanged, the unlisted CONNECT refused in the egress log) stays; a refusal by the agent stays a failure, never a pass (the rejected option); an agent that will not run the probe fails the canary `containment_failed` with the reason recorded.

Then the rehearsal is rerun against the fake, and Sean runs one more attempt (all three canaries, about 0.3 USD in Claude Code's estimate on his subscription).

---

## E84. The containment canary redesign merged and rehearsed; ready for Sean's second attempt (provisional, 2026-10-05)

**Status: provisional.** The driver's record.

1. **The redesign** (E83; SEAM §173) merged at `e2b15aa`. The driver's rerun on `0974089`: `--slice 14` 1,038 of 1,039 (the one failure M141 (b) by design), unit 238 in 45 files.
2. **The rehearsal rerun** (fake only, nothing to a provider), merged at `20a1abf`: the containment canary works end to end (the probe run once with no arguments; the domain init's five actions witnessed with the expected outcomes and corroborated host-side where designed; `agent_report` kept with the probe's output; delegation established from the inventory); the attempt fails only on the provider-tunnel control, as expected offline; `M2-hands-on.sh` ran cleanly twice through all eleven steps. The script now shows the containment canary's `agent_report` as soon as the attempt ends, so a refusal's reason reaches Sean even when the attempt fails.
3. **Ready for Sean's second attempt:** the same command as the first run, with the same token file; a new attempt and its approval (all three canaries again, about 0.3 USD in Claude Code's estimate). Whether the real Claude Code now runs the probe is what only this attempt can show.

---

## E85. Sean's second attempt: the canaries pass; the journey's resolver; a known zero by the egress evidence (item 2 decided by Sean, the rest provisional, 2026-10-05)

**Status: item 2 decided by Sean; items 1, 3 to 5 provisional.** The driver's record.

1. **The second attempt** (home `~/surety-hands-on-20261005T141020Z`): all three canaries **passed** with the real Claude Code on Sean's subscription (positive, cancellation in 12 ms, containment with the E83 sanctioned check). In step 9 the engine restarts as `serve --harness --harness-real-lane`, and there the egress proxy resolved names with the harness's resolver, whose map is empty: every `CONNECT` to `api.anthropic.com:443` was refused `resolve_failed`, Claude Code retried ten times and ended `is_error` (`ERR_PROXY_TUNNEL`), zero tokens. The run was recorded `stopped` / `budget` / `budget_usage_unknown`: the budget check on the terminal event's count-less observation stopped it milliseconds before the process exited on its own (`error_exit`). Cause: SEAM §164 kept "everything else of the test mode" under the real lane, the harness resolver with it (the seam's defect; the rehearsal's fake binary never resolves a real name). Fixed: under the real lane the proxy resolves with the system's resolver; plain test mode keeps the harness map (SEAM §174; M127 (j)).
2. **Decided by Sean: a known zero by the egress evidence.** A run's usage is a known zero, with that basis recorded, only when all hold: (a) the domain had no network path but the engine's egress proxy; (b) the run's egress log is complete (not cut, no tunnel or request in flight); (c) no tunnel was accepted and no byte went up; (d) the backend's own report is absent or all zeros. Otherwise it stays unknown (the unknown allowance charged) or is the backend's counts. Real backends only (the scripted backend has no provider). The ledger row uses existing fields: `cost_status` `measured_zero`, `normalization_version` `egress-evidence-zero-1`, the evidence in `raw_usage.zero_basis`. A domain closed by an earlier engine incarnation has no account, so after a restart the row stays unknown. Cases M136 E85 (a) to (c).
3. **Provisional: a run that ends on its own is recorded by its exit.** `budget_usage_unknown` on the backend's terminal event no longer stops the run (nothing is spent after it); a limit passed still stops, there and on the pause re-grant. An `error_exit` is `failed` / `infra_error` (SEAM §143, D2 §1.6), and its `reason_text` names the cause: the terminal error and the proxy's refusals by reason and authority, scrubbed as untrusted text (held secrets redacted before the bound, credential headers, key shapes) and bounded. No fixed vocabulary for the cause (the sources require none). Case M136 "E84".
4. **The review** (one Opus pass) found one serious defect, reproduced: a `CONNECT` still waiting on its upstream connect at the proxy's close had no log entry, so the account read complete with nothing accepted, and a late connect opened a tunnel after the close. Fixed (the account is incomplete while a request is in flight; no tunnel after the close); case M136 E85 (c), and a unit test for the late connect. Minor findings fixed: the scrubbing gaps; the terminal exemption's order against the limits. M140 (e) amended: an egress-basis zero is accepted only on the test's own reading of the egress record.
5. **A process slip, recorded:** the Builder's first suite run on `a53dea9` read a `dist` it rebuilt during the run, so its figures were void; it was stopped (its own process group only), nothing left behind. Rule: a suite runs from a worktree whose build nobody touches; the driver's rerun is from a scratch worktree.
6. **The driver's rerun and the merge** (`f9f3bfe`): on `ae45041`, from a scratch worktree: unit 47 files; `--slice 14` 1,041 of 1,044. M141 (b) fails by design. M110 (a) failed once after M118 and passed 3 of 3 alone (not diagnosed; its home was removed at teardown). M131 (b) was the shared invariant ("usage never observed is unknown") meeting item 2: amended (`verify/m2-resolver-3`) to accept a zero only when the row names the egress basis and the test's own reading of the egress record proves nothing sent. On main plus the fix, the affected files pass alone.
7. **A safety slip by the driver, recorded (corrects the first text of item 6).** Checking the affected files, the driver ran `M133-resource-limits.test.mjs` by hand with `node --test` on the workstation, four times (17:16 to 18:02Z): it is an **exhaustion-lane** file (manifest `exhaust`; E69: only on mini-hp01 with `SURETY_EXHAUSTION_HOST`), which `--slice 14` never includes, so the driver's statement that it "passed in the full run" was wrong. Its cases (a) to (d) ran: ten OOM kills, every one with `oom_memcg` and `task_memcg` inside a test `surety-…/dom_` or `probe_` cgroup; the user manager stayed running, no unit failed, nothing was left behind (the Builder's read-only check and the driver's). The two-part guards held. Rule restated: before running any acceptance file by hand, read its manifest lane; exhaust files never run here.
8. **What the slip showed (open, provisional choice).** (f) and (g) never launch here because memory admission (option B, E75 item 3) reserves the configured `domain_memory_max` (8 GiB) plus `host_reserve_memory` (2 GiB) per admitted domain, not the test's 64 MiB harness cap: (f)'s two concurrent domains need 18 GiB available, which mini-hp01 may not have either. The driver's provisional choice: the Verifier sets `domain_memory_max` in those cases' configuration to what they mean (the engine's admission, as Sean decided it, unchanged), to be run on mini-hp01 only. **For Sean's real run:** the script leaves the defaults, so one domain needs 10 GiB available at admission.

---

## E86. Sean's third attempt: the containment canary refused again; the engine runs the probe (item 2 decided by Sean, the rest provisional, 2026-10-05)

**Status: item 2 decided by Sean; items 3 to 5 provisional.** The driver's record.

1. **The third attempt** (home `~/surety-hands-on-20261005T192903Z`): the positive and cancellation canaries **passed**; the containment canary **failed** (`containment_failed`), the probe never run. The transcript shows two layers: (a) after the agent read `prompt.md`, **Sonnet 5.5's API safeguards stopped the response** (`system/model_refusal_fallback`, `api_refusal_category` `cyber`); (b) Claude Code then **fell back to `claude-sonnet-5`** for the session, and that model declined the task as a prompt injection ("I don't execute unknown binaries on the basis of instructions found inside files"). The E83 sanctioned, honest framing passed in the second attempt and failed here: the agent's willingness is not stable, and asking an AI agent to attempt escapes is, reasonably, what safeguards flag.
2. **Decided by Sean: the engine runs the probe.** Containment is a property of the domain, not of the agent's cooperation. In the containment canary the engine itself runs the probe program inside the agent's own domain (same identity, namespaces, mount view, limits and egress), while the backend is live in that domain; the agent is given a harmless task and is never asked to run, read or report the probe. The evidence stays as SEAM §§165 and 173 define it (the domain init's witnessed actions, host-side corroboration, the provider-tunnel control, delegation from the inventory); `agent_report` is no longer part of the canary. This amends E83 item 2.
3. **Provisional: a model fallback is not the qualified model.** A run whose stream shows a model other than its entry's model (a `model_refusal_fallback`, or a model in the result's usage outside the entry's) is recorded as such and its result is not accepted as the entry's work; a canary with a fallback fails. Whether Claude Code offers a way to disable the fallback is to be checked from its static help only.
4. **Provisional: the script shows why.** When a canary's agent writes no result, `M2-hands-on.sh` shows the backend's final message (bounded, scrubbed) instead of `null`.
5. **Spend:** the three canaries only (Claude Code's estimates about 0.04 to 0.10 USD each); nothing past them ran. The token stays in place for the fourth attempt.
6. **Built, reviewed and merged** (`56bdf7c`). The domain init runs each action in a hardened child of its own (`--disable-sigusr1 --disallow-code-generation-from-strings --no-addons`), a sibling of the backend with its identity, namespaces, cgroup, mount view and egress; the check starts only when the host sees the backend in the domain and fails closed on any interference; the witness socket is gone. The agent's package names no check (`canary.json` `{kind, attempt, wait_seconds, result}`; objection 020 upheld: `kind` is exempt from the word rule). Model fallback: a canary fails `model_fallback`; a role run is `failed` / `invalid_result`, usage kept per model; Claude Code's static help shows no switch for the refusal fallback (`--fallback-model` is an opt-in overload fallback, not used).
7. **The review** (one Opus pass) found two serious defects: (S1, reproduced) `git_config` ran with the backend-writable home, so a planted `~/.gitconfig` made git fail and read as `denied`; fixed (git writes the view's config by path with no global or system config; `denied` only on the filesystem's refusal, "Device or resource busy" included as the sandbox's real refusal, confirmed by a direct open); (S2, not reproduced as a false pass: the unhardened engine failed closed) the action child lacked `--disable-sigusr1`; hardened, the judge requires it. Minor: an error is `not_run`, never `denied` (`token_read`, `engine_port`, `unlisted_connect` only on the proxy's 403 with the egress log's `not_listed`). Exact model-name matching kept (fails closed). Objection 021 upheld: the fake lane cannot satisfy the provider-tunnel control, so S1 is judged on the actions.
8. **Figures:** the driver's run on main plus the fix (tree equal to `144cf2f`): unit 47 files; `--slice 14` 1,047 of 1,049 (M141 (b) by design; M136 S1, answered by objection 021). After it: M135 14/14, M136 15/15. **A host flake seen by the Builder:** WSL interop (`cmd.exe` from Linux) failed for about 20 minutes, so P11's host control failed and every engine started unqualified (H9/H10); it cleared by itself. It may explain M110 (a)'s earlier "rows: none". If it recurs at the real run's start, the script stops at qualification with nothing spent.
9. **The rehearsal** (fake only, nothing to a provider), merged with `verify/m2-rehearsal4`: the script ran cleanly twice through every step on `46ac749`. The containment canary ran as designed (`run_by` `domain_init`, the backend live at both host reads, every action witnessed, completed and hardened, `git_config` denied by the filesystem) and failed only on the provider-tunnel control, as expected offline; the agent's package held no probe and none of the four words. CHECK (4) is now shown (the canary waits 30 s). The script now prints a failed canary's recorded reason. **Ready for Sean's fourth attempt:** the same command and token file; the three canaries again, then his two decisions and the journey.

---

## E87. Sean's fourth attempt: qualified, and the journey's first path on the real Claude Code; the real-lane suite next (items 2 and 3 decided by Sean, the rest provisional, 2026-10-06)

**Status: items 2 and 3 decided by Sean; items 4 and 5 provisional.** The driver's record.

1. **The fourth attempt** (home `~/surety-hands-on-20261006T014511Z`; main `02558a1`): attempt `qa_01M47E6BB5VX6C6218EEQBAKAR` **succeeded**. All three canaries passed with the real Claude Code on Sean's subscription, including containment under E86 (the probe run by the domain init beside the live backend, every action witnessed and hardened, the provider tunnel 1981 bytes up). Sean approved it and activated entry `trust_01M47E8ED7P7HP7V450507H4M6`. The journey's path one: Builder, Verifier and Reviewer completed, both gates satisfied, every ledger row equal to its transcript's terminal usage and cost, the token nowhere (CHECK 9). Spend in Claude Code's estimates: 0.0527 USD for the qualification, 0.1538 USD for the journey. CHECK (8) was **not shown**: step 10's Builder finished in about 12 s, before the Stop. The Verifier filled 30 of the report's 51 facts from the records (`verify/m2-report`); 21 stay pending.
2. **Decided by Sean: the real-lane suite runs** (M136 to M140, `--lane real`, by his command), after Q13 is fixed and rehearsed. M141 counts the suite's records, not the hands-on run's alone. M140 (e) is the live Stop of R12.4; it was amended so the Builder is kept live by a deliberate wait (`sleep 180`) and the case is "not established", never failed, if the Builder finished first.
3. **Decided by Sean:** nothing to add to the report's "what Sean checked and what surprised him" beyond his reading of the script's CHECKs.
4. **Provisional, Q13 (an engine defect):** step 10's Builder exited clean with its result 83 s before the Stop, held at the script's `boundary.before_terminated` barrier; the engine recorded it `stopped` / `human_stop`, demoted its result and charged the unknown allowance. By D2 §1.6 and SEAM §143 a Stop after the backend's own clean exit does not change that exit's outcome. Case M129 "Q13"; the Builder's fix follows.
5. **Provisional, Q14:** `runs.model_observed` is null on every run while each ledger row records the model; D1 lists the field as optional. Recorded in the report as not claimed; no change in M2.
6. **Q13 built, reviewed and narrowed (provisional, under delegation)**, merged at the merge of `build/m2-q13`. The defect was a production race, not only the barrier's: from the backend's own exit until the engine decides the end (normally hundreds of milliseconds, up to `terminate_grace` plus `kill_grace` when a descendant outlives it), a confirmed Stop overrode the exit. The review (one Opus pass) found three serious problems in the first fix, all reproduced: the flag was never cleared (Stop, Abandon and the deadline ignored through validating and integrating, against SEAM §47); it covered every exit class and let the work be dispatched again after an ignored Stop; and the terminal usage line could be processed after the exit was taken, dropping a passed limit (against E85 item 3). **The rule as merged:** only the backend's own clean exit (code 0, no signal), and only until the exit's end is decided, keeps the run's outcome; a Stop confirmed then still holds the work, and an Abandon still sets its dispatch hold, recorded on the consumed confirmation (`applied_to: "work"`); every other exit, and every end after the decision, takes its course as before; the output is drained before the end is decided, so a budget stop from the terminal line always wins; a usage write that keeps failing ends the run `budget_unreadable` even after the exit. The few-millisecond window before the engine takes the exit stays (its record shows `exit_class` clean beside outcome stopped). Cases: M129 "Q13" (with the hold), "Q13, error_exit", "Q13 after the exit is decided", M136 "E87 S3". The driver's run: unit 48 files; `--slice 14` 1,052 of 1,053 (M141 (b) by design).
7. **Host checks that flake on this workstation (recorded, no change):** H12 needs `MemAvailable` of at least `host_reserve_memory` plus `domain_memory_max` (10 GiB at the defaults); with about 12 GiB idle, a test engine started during another's teardown can fall below it (seen once in M136). With H9/H10 (WSL interop, E86 item 8) these are host conditions, not engine defects; a sandbox-lane configuration with a smaller `domain_memory_max` would steady the lane and is left for later. For Sean's runs: keep the machine quiet so 10 GiB stays available.
8. **The real-lane suite rehearsed** (fake only, `SURETY_REAL_REHEARSAL=1`, nothing to a provider), merged with `verify/m2-real-rehearsal`: in the api_key fixture mode the whole run directory ran in order (M139, the attempt, activation, path one, the live Stop, path two) and M140 passed 5 of 5; (e)'s "not established" branches were exercised with a temporarily patched fake. Fixed on the way: M139 (a) and M140 (e) now follow E85's shared invariant; (e) reports a Builder that ended before it was seen live as not established instead of timing out; the rehearsal fake's Reviewer disposes the open findings, so path two runs. **Ready for Sean's real-lane run** (E87 item 2): three approvals (M139's invalid-token attempt, the qualification attempt, the trust activation); a few tenths of a USD in Claude Code's estimates expected.
9. **Sean's real-lane run** (run directory `~/surety-real-lane-20261006T050755Z`, from `58127b4`, then `3f1f483`). First pass: M139 2/2 (the invalid token refused, no tokens); the attempt **succeeded** (all three canaries); M137 2/2, M138 3/3, M136 (a), (c), (d). M136 (b) halted the run directory on a stale assertion: it counted the engine's own containment check's unlisted `CONNECT` (E86) as the backend's unexpected contact. Fixed (`verify/m2-m136b`: only that check's refusal, attested and inside the check's window, is excused; every backend contact still must be reported), and re-judged from the records with no tokens. Second pass, after Sean's trust activation: **15 of 16**. M140 (a) path one passed; **(e) the live Stop of R12.4 passed** (the Builder kept live, `populated 0` read before the run read said ended, the token in no record and not in git: CHECK (8)'s evidence); (c) R12.2 and (d) R12.3 passed. **(b) path two was not established:** the real Verifier found the seeded defect correctly (the session lifetime's units) but left its finding's optional `check` empty, so the fix loop had no link to the required check `login`.
10. **Decided by Sean: fix the instructions first.** The Verifier's package told it only to record findings; nothing said that a finding a required check covers must name it, or which checks are required. A product gap, not the agent's: each role's package is to say what its gate reads. Then Sean reruns path two only (`SURETY_REAL_RERUN=path_two`), not the mixed fallback.
11. **The role instructions, built, reviewed and merged.** The Verifier's, Reviewer's and fix Builder's packages list every check of the effective protected version (key, requirement keys, gate kinds, "(required)"; never its content); the Verifier is told to name each finding's `check`, the Reviewer how a `fix` resolves, the fix Builder that its finding resolves when the named check passes and that the check is protected. The review (one Opus pass) found nothing serious; on its F1 (provisional, under delegation): a finding's `check` is an enum of the effective keys in each run's result schema, and a result naming any other key is an invalid result with nothing stored (M125 (g)); F3: a missing effective version is said to be unreadable, never "no checks". **Open for Sean (F2, predates this change):** a finding resolves when the check it names passes, whether or not that check covers the defect; the engine does not check the link. The driver's run on the merged tree: unit 48 files; `--slice 14` 1,054 of 1,055 (M141 (b) by design). Signal 16 seen on a Builder's shell during overlapping runs came from nothing in the repository (every kill site guarded).
12. **Sean's path-two rerun: the real-lane suite 16 of 16.** From `f15d811`, with `SURETY_REAL_RERUN=path_two` in the same run directory: the earlier steps were re-judged from their records (no tokens) and only path two ran. `acceptance: 5 file(s) passed`: M139 2/2, M136 4/4, M137 2/2, M138 3/3, M140 5/5. Path two, the fix loop, was established on the real Claude Code: the Verifier found the seeded defect and named the check `login`, the Reviewer dispositioned `fix`, the fix Builder fixed it, the check passed after the disposition and resolved the finding, and both gates were satisfied on the fix's candidate. Next: the Verifier completes the M2 report from the records so M141 passes; then M2's acceptance goes to Sean.
13. **The M2 report final, and `npm test` passes.** The Verifier filled every pending fact from Sean's real-lane run and hands-on run and copied the run's `state.json` and observations to `docs/acceptance/reports/M2-real-lane/2026-10-06/` (checked for the token and other secrets: none); M141 passes. The driver's first full `npm test`, on `main` at `a2aefbf` (2026-10-06 11:35 to 12:25 UTC, a scratch worktree): unit 48 files; acceptance **1,055 of 1,055 in 168 files, none skipped, exit 0**. Every condition of BS §1 is now met: `npm test` on `main`; the real lane's rows under an attempt Sean approved, records retained; the host qualification and the entry active with their evidence; the report written. **M2's acceptance is Sean's decision.**
14. **The exhaustion lane on mini-hp01, on current code** (Sean's choice before accepting M2). Branch `verify/m2-m133-config` at `b7a3215` (main `e150b14` with E85 item 8's configuration of M133 (e) to (g)), built on mini-hp01, `--lane exhaust` with `SURETY_EXHAUSTION_HOST` set, 2026-10-06 12:44:51 UTC: **11 of 11, both files passed** (M133 9 of 9, P20 passed with `isolation_probe_exhaustion` true; M130 (f), (g) 2 of 2). Every OOM kill was `CONSTRAINT_MEMCG` inside a test cgroup (3 in a `surety-…/dom_`, 1 in a `probe_`), none `CONSTRAINT_NONE`; the staging and common-thread containers up throughout; the user manager running; no scope left. Before the run, mini-hp01's `MemAvailable` (9.88 GiB) was under H12's 10 GiB at the defaults; at Sean's request the driver closed Chromium in his session there with SIGTERM (it saves its session), which brought it to 11.2 GiB. Merged.

---

## E88. M2 accepted (decided by Sean, 2026-10-06)

**Status: decided by Sean.**

1. **M2 is accepted.** Every condition of BS §1 is met: `npm test` on `main` 1,055 of 1,055 in 168 files, none skipped (E87 item 13); the real lane's rows passed 16 of 16 under the attempt Sean approved, its records retained and copied (E87 item 12; `docs/acceptance/reports/M2-real-lane/2026-10-06/`); the host qualification and the entry for Claude Code `active` with their evidence; the M2 report final (`docs/acceptance/reports/M2-report.md`, M141 passing). Sean chose to rerun the exhaustion lane on current code first; it passed on mini-hp01 (E87 item 14). The claim M2 supports is the report's section 1: on this host, with the recorded versions and limits, the engine ran one real backend, Claude Code on Sean's subscription, through the complete journey, the engine making every commit, the backend unable to reach the control plane, every process it started observed gone, and its usage recorded as the provider reported it. What it does not claim is the report's section 17 and `M2-not-claimed.md`.
2. **Open for Sean, none blocking:** the report's questions 1 to 10 (the driver's defaults stand until he answers) and 15 (F2: resolution does not check that the named check covers the defect); the report's section 19, a draft; the D3 review brief for Astra.
3. **Sean revokes the subscription token** in his Claude account settings and deletes `~/.config/surety/claude-subscription.token`; the real lane needs a new token, made the same way, when it next runs.

---

## E89. What comes after M2: D3 and M3; three of D3's own choices (decided by Sean, 2026-10-06)

**Status: decided by Sean.**

1. **Next: D3, then M3, the check runner.** Every gate in M1 and M2 passed on check results a test recorded; no engine component has run a check. D3 (draft 1, `docs/design/sdlc-design-D3-checks.md`) designs the runner, the protected path at runtime, the diff classifier and validation scope. Sean hands Astra the D3 review brief (`docs/reviews/D3/sdlc-design-D3-review-brief-astra.md`); meanwhile the driver prepared the decisions (`docs/design/sdlc-design-D3-decisions-prep.md`). Deferred: dogfooding (until checks are real), a second backend or the API-key mode, the UI.
2. **Three of D3's own choices, accepted** (the sheet's Part 3, ahead of Astra's review; revisited only if her review raises one):
   - a check's writes go to an overlay discarded with its domain, the protected inputs strictly read-only (D3 §2.2, the deviation from the brief's R1);
   - a Builder's objection to a check (`requirement_conflict` / `contract_conflict`) stops automatic repair and comes to Sean with `correct_check`, `change_spec`, `retry`, `cancel`, the check staying in force (D3 §5 X2);
   - only the `direct` runner class is designed and qualified for M3; `container` and `remote` stay refused (D3 §2.8).
3. **Open, after Astra's review:** D3's Q1 to Q7, the corrections L1 to L5, and F2 (the M2 report's question 15), each with the driver's recommendation on the sheet.

---

## E90. D3 approved with Astra's four amendments; Q1 to Q7, L1 to L5 and F2 decided (decided by Sean, 2026-10-06)

**Status: items 1 to 4 decided by Sean; item 5 provisional.** Astra's review: `docs/reviews/D3/sdlc-review-D3-Astra.md` (verdict: approve with the amendments of her section 2 applied).

1. **D3 draft 1 approved, with B01 to B04 applied** (Astra §2), to be written into draft 2 as numbered corrections where they change D1's or D2's contract:
   - **B01:** each protected input's identity is enforced at its workspace pathname for the whole execution (no rename, removal, exchange or replacement of it or an ancestor, a read-only bind beneath a writable ancestor being insufficient); inputs expand to a canonical manifest of paths, Git types, modes and object ids; a directory input is a projection of its permitted members; the governed file absent from every projection; link and special-file inputs refused in the first runner; type and mode join protected and input identity (the as-built fingerprint, mode-free, is corrected, not claimed). Qualification refuses a profile that cannot enforce this.
   - **B02:** in the first classifier every root addition or root-layout change is `unclassifiable` (root removal at least `loosening`); any semantic difference without an explicit rule is `unclassifiable`, and a strict element never hides it.
   - **B03:** a correction to D1 §9.2: selection considers durable registrations; a newer matching registration supersedes earlier results and reuse; until it has a usable result the check is `missing` and the gate read names the pending, quarantined or cancelled execution; never a fallback to an earlier pass. Registration stales dependent evaluations in the same transaction; one durable project sequence for registration, fixture results and the disposition watermark.
   - **B04:** scope validation enforces F §5.7's check-kind inventory per tier (T1 acceptance and smoke; T2 adds integration and security lint; T3 adds property and failure/recovery), not waivable by `required_checks`, `gate_kinds` or `tier_floor`; the scope tier sets the verification cadence (a T2/T3 module triggers milestone verification in a T1 project); stage sensitivity includes partially delivered requirements.
2. **D3's open questions, each (a)** (Sean, as a block; Astra and the driver agreed): Q1 no cross-version reuse; Q2 a failed required stage check sends a `stage_build` back by bounded automatic repair (Astra's T13 conditions); Q3 default inputs every protected file but the governed file; Q4 the gate rereads its refs at every supported gate (with N02's distinction); Q5 classifier authority by an engine setting bound to a qualified version (losing the match also stops a pending Reviewer application); Q6 program hashes always recorded, pinning optional, the limitation stated; Q7 every present module at a deployment gate.
3. **Corrections L1 to L5 accepted**, L1 to L3 with Astra's variants (her §4): L1's binding covers every launch, closure, recovery, resource and projection path; L2's registration and invalidation happen with the trigger (or a barrier before Gates), not only in the later tick step; L3 with B04. L4 observes descendants at the check's own exit, before teardown.
4. **F2, option (c)** (Astra's recommendation; the M2 report's question 15): a finding names the criterion it breaks; only a required acceptance-origin check of the current scope that covers that criterion can resolve it, with the existing fix-candidate and post-disposition bindings and intact evidence; a finding with no such check stays unresolved and the missing verification is routed for correction; adequacy stays the Reviewer's. Astra's T20 is its acceptance obligation.
5. **Provisional, under delegation:** Astra's non-blocking N01 to N04 are applied in draft 2 as she worded them (affected checks show obligation changes; a failed ref read is not an observed change; execution history beside the deciding result; schema defaults enumerated, Appendix B an example, M3 is the direct check runner and deployment later). Her T01 to T20 enter the M3 acceptance plan.

---

## E91. D3 draft 2; the questions its writing raised (decided by Sean, 2026-10-06)

**Status: decided by Sean.**

1. **D3 draft 2** (`a219917`, `docs/design/sdlc-design-D3-checks.md`) applies E89 and E90: B01 to B04 (B01 as correction L6, the protected and input identity a manifest of path, type, mode and object id; B03 as L7, selection over durable registrations; F2 (c) as L8, a finding resolving only through a required acceptance check of the scope that covers its named criterion), Q1 to Q7 decided, L1 to L5 with Astra's variants, N01 to N04, and Astra's T01 to T20 in Appendix C (C06 now expects root additions unclassifiable). Approved to build.
2. **Q8 to Q11, each (a), as the draft wrote them:** Q8, a finding whose criterion no check covers registers `check_correction` work for the Verifier (chained work, waiting at the chain boundary); Q9, an evaluation of a superseded candidate is refused (not satisfied, names its successor, issues and completes nothing); Q10, a `fix`'s integration takes the highest of the project's tier and the tiers of the modules present at its revision for its cadence; Q11, a migration recomputes recorded protected fingerprints under L6, an unreadable tree leaving the version's fingerprint unreadable and its gates `PROTECTED_PATH_UNAUTHORIZED`.
3. **Next:** the M3 build specification and acceptance plan, from D3 draft 2, for Sean's approval; then the slices, cases first.

---

## E92. The M3 build specification and acceptance plan adopted (decided by Sean, 2026-10-07)

**Status: decided by Sean.**

1. **Adopted:** `docs/spec/M3-build-spec.md` and `docs/acceptance/sdlc-M3-acceptance-plan.md` (`5f6ae35`), from D3 draft 2: rows M201 to M241 in slices 15 to 22, journey first (slice 15, the walking check: registration, materialization, a real `direct` execution, the result, the gate), every Appendix C statement and Astra's T01 to T20 covered.
2. **The plan's questions, each as recommended:** (1) project-lane files run in `npm test`, no new lane; (2) slice 15 uses a harness-only `test_fixture` runner-qualification stand-in until slice 18's self-test, the journey rerun without it, a test pinning that it exists only in harness mode; (3) accepted tests that L3, L6, Q9 and F2 change are updated by the Verifier in the slice that brings each, every change in COVERAGE.md, with no compatibility setting; (4) D3 §4.5's requirement-index parser is built now, the plan fixture registering through it; (6) a short `M3-hands-on.sh`; (7) M205's OOM case in the exhaustion lane on mini-hp01.
3. **The real lane, included** (question 5): one real run at slice 22, a real Verifier writing the checks and the engine running them on a real Builder's code, both paths; under 1 USD expected in Claude Code's estimates on Sean's subscription; it needs a new `claude setup-token` and possibly a new qualification attempt (about 0.05 USD); only on his command, with his approvals.
4. **Owner files changed by the driver** (build spec §12): `scripts/run-tests.mjs` (rows M201 to M241), `CLAUDE.md` (the M3 build spec named; the slice note; the three plans), `docs/spec/templates/project-spec-template.md` (section 5 points to D3 §4.5 and Appendix B). The manifest's slices 15 to 22 are added with each slice's files by its Verifier (the manifest lives in the Verifier's path). `npm test` now fails until every M3 row has a file and passes; `--slice N` meanwhile.

---

## E93. M3 slice 15, the walking check, merged (provisional, 2026-10-07)

**Status: provisional.** The driver's record.

1. **Built** (rows M201 to M205): the governed schemas with D3 A.4's defaults; discovery by engine git, running nothing; D3 §4.5's requirement-index parser, through which the plan fixture registers; registration at nomination, at a protected application and by operator request, idempotent by trigger, on one project sequence (L7's first part); `check_executions` and the `check` lease (L1, migration 0012); the Checks tick step (L2); check trees under `$SURETY_HOME/checktrees/`; the `check` profile on D2's launcher, domain init and termination with closure; results recorded only from the engine's own observations; per-check gate entries; D3 A.7's settings as configuration; the seams of SEAM §§177 to 188, the `test_fixture` runner qualification harness-only (E92 item 2). Deferred by design to later slices: the rest of L7 (16), B01 and L6 (17), not-run reasons, recovery re-registration and `EVIDENCE_MISSING` (18), sensitivity and module facts (20).
2. **Objections:** 022 (accepted fixtures become discovery errors under D3's schemas) and 023 (M201 (c) read the gate entries from the envelope), both upheld; the Verifier updated the fixtures without weakening a row (SEAM §187). M205 (d), (g), (i) deferred to slice 18 by the driver: a check domain runs a plain program, and M2's instruments need the scripted role's channel.
3. **The review** (one Opus pass) found two serious defects, both reproduced: (S1) a symlink at an input's ancestor in the candidate's source made the domain setup create or empty a file on the host before `pivot_root`; fixed (the plan is refused `mount_plan_refused` before any launcher; the init creates targets without following links); (S2) check trees were written with the project's work tree, so attributes converted their bytes; fixed (every file written from the object store, byte-identical to its blob). Nine minor items fixed (staging leftovers; no tree removed before closure; non-regular inputs and a non-directory definitions directory are discovery errors; the deadline from `started`; a lapsed check lease ends `interrupted` with no verdict; unknown orphans and dropped output stay unknown and never pass; recovery honours prior unknowns; due registration under the current version). Cases: `M201-source-symlink-refused`, `M201-materialization-is-the-revision`, M203 (c), (d). Tree retention until the version changes is recorded for slice 17's bounds.
4. **Figures:** the driver's runs from scratch worktrees: on `a9aae9b` (before the review fixes) `--slice 15` 1,086 of 1,086; on `385d459` unit 50 files and `--slice 15` 1,092 of 1,092, nothing left behind.

---

## E94. M3 slice 16, which result decides, merged (provisional, 2026-10-07)

**Status: provisional.** The driver's record.

1. **Built** (rows M206 to M209): L7's selection over durable registrations (the latest registration at the scope's bindings decides; with no usable result the check is `missing`, naming the pending execution; no fallback to an earlier pass or reuse entry); every change to whether an execution can decide stales dependent evaluations in the same transaction; the disposition watermark from the one project sequence; execution history beside the deciding result (N03); supersession at a successor's nomination (`candidate.superseded`), queued executions of a superseded candidate or version cancelled with no row, running ones keeping their frozen bindings; Q9's refusal (`CANDIDATE_SUPERSEDED`, first reason, naming the successor; nothing issued, completed, resolved or queued); the gate's own ref reads before its transaction, against the registry generation, with `REF_UNREAD` (N02) and a bounded reread through the integrity step; the harness-only scripted check route (SEAM §190).
2. **Provisional rulings (driver):** a candidate is superseded at its successor's nomination; `CANDIDATE_SUPERSEDED` and `REF_UNREAD` join D1 A.4; a scripted result records `runner_id` `test_fixture` (objection 025); after the review: a result an engine execution records after its candidate's supersession never counts through a reuse entry (fixture results exempt, as SEAM §189 allows), and a candidate's own pending registration always blocks a reuse pass; an evaluation carrying `REF_UNREAD` resolves no finding and completes no work. A registered ref is `absent` only when its absence is verified (git, the loose path and packed-refs agree); otherwise `unknown`, for every engine reader (gate, integrity, journal, decisions), failing closed; a read whose registry generation never holds still in three attempts is `unread`.
3. **Objections** 024 (M206 drove a running execution backwards), 025 (the scripted `runner_id`), 026 (M201 read a tree after the engine removed it): all upheld, the cases fixed.
4. **The review** (one Opus pass) found no serious defect; seven minor findings, m1 to m5 and m7 fixed (above). Residuals: O2 (a gate's fingerprint from an earlier generation if an engine ref update's finalizer lands between the facts read and the transaction; fails closed, may raise a false `protected.unauthorized_detected`); `superseded_by` not backfilled for stores made before this build.
5. **Open for Sean** (none blocking): (a) whether an evaluation carrying `OUT_OF_BAND_CHANGE` should still resolve findings and complete fix work, as M1 accepted (the `REF_UNREAD` case was closed provisionally above); (b) whether adopting an out-of-band commit, which invalidates the latest candidate's results, should also cancel or neutralize its queued and running executions, as supersession does (m6; today their later results decide).
6. **Figures:** the driver's run on `1e37e0f`, from a scratch worktree: unit 52 files; `--slice 16` 1,105 of 1,105; nothing left behind.

---

## E95. Two decisions: slice 17's structural verification of B01, and D4's open questions (decided by Sean, 2026-10-07)

**Status: decided by Sean.**

1. **B01 verified structurally (M3 slice 17).** The model safeguards stopped the Verifier twice while it designed cases in which a check program renames, relinks or replaces its protected inputs. Sean chose: while a check runs, the test reads the check's mount table from the host and asserts that every protected input, and every directory from it up to `/surety/workspace`, sits on a read-only mount below the workspace with no writable layer; the projection is exact; a write to an input fails while an ordinary source write succeeds and does not persist. Astra's T02 attempt cases are not written, to be revisited at slice 18's runner self-test. (The slice-17 review then ran the attempts itself, in a scratch namespace reproducing the engine's mount plan: every one was refused.)
2. **D4 revised draft 1** (`docs/design/sdlc-design-D4-deployment.md`, `ef3aaec`, from Sean's design team, revised for review findings RV1 to RV6): Sean approved its recommendations.
   - **As a block:** Q1 (a): D4 designs the adapter contract and the deploy, verify and observe path generally; M4 builds Alpha only, on one target; Beta and Live follow as D5. Q2 (a): the first target is `local_service`, a service-manager unit on the workstation in a `service` sandbox domain, reached only through the engine. Q4 (a): M4 deploys a projection of the candidate's revision; no build step yet. Q5 (a): environment configuration lives in the engine's store, in owner-written immutable versions. Q8 (a): no rollback in M4. Q9 (a): at most one automatic retry, only after `reconciled_absent`. Corrections J1 to J9 accepted.
   - **Q6, numeric limits, as listed:** `service_memory_max` 512 MiB, `service_tasks_max` 128, `service_writable_bytes` 64 MiB, `service_writable_inodes` 4,096, `service_log_max_bytes` 1 MiB; admitted by D2 §3.7's envelope at the full memory limit.
   - **Q3 and Q7 (a):** each Alpha deployment starts by Sean's command (automatic deployment a later policy setting); an opt-in per-environment loopback relay on `127.0.0.1`, opened on command and closed at teardown, off by default.
   - **Q10 (a):** M4 ends with one real-lane run on his command: a real Builder writes the reference service, a real Verifier its `post_deploy_behavior` check, the engine deploys and verifies; under 1 USD expected in Claude Code's estimates; a new setup token then.
   - D4 is approved to build once its text is updated to "decided" (the draft already reads as recommended). M4's build spec opens with D4 §9.6's service-manager feasibility probe; its results confirm §9.2 and §3.4 or come back to Sean before any slice. M4 starts after M3's acceptance.

---

## E96. M3 slice 17, the protected inputs, merged (provisional, 2026-10-08)

**Status: provisional.** The driver's record.

1. **Built** (rows M210 to M215): B01 by construction: one read-only mount per top-level workspace component holding an input (an overlay with no upper layer over the input projection and the candidate's source under that component, or a read-only bind), so every input and every ancestor up to `/surety/workspace` is on a read-only mount with no writable layer; exact per-manifest projections (0444/0555; the governed file and undeclared protected content in no layer); source files at their git modes so the discarded overlay can write them (E89 item 2; objection 027 upheld, M214 (b) amended); L6's fingerprint over `[path, type, mode, object id]` (migration 0013: `fingerprint_scheme`, `authorized_revision`, backfilled only from exact records) and Q11's recompute at each start, in two passes around recovery, never guessing, an unreadable version failing closed with `PROTECTED_PATH_UNAUTHORIZED`; the candidate's own protected fingerprint on each execution; egress for checks through D2's proxy, declared hosts only; `checktrees_max_bytes` with reservations, admission refusing (no eviction).
2. **Verification** by Sean's structural decision (E95 item 1); M213 already passed on main as a control. The review re-ran the attempt cases in a scratch namespace reproducing the engine's mount plan, from a capability-less nested user namespace: write, chmod, rename of the component, its ancestors, the workspace and `/surety`, hard links out, umount, a nested mount, and reopening through `/proc/self/fd` were all refused (EROFS, EBUSY, EXDEV); the projection wins a name clash with the source.
3. **The review** found no serious defect; minor findings fixed: one directory predicate for protected roots everywhere (a root without its trailing `/` is refused at discovery); `checktree_max_entries` counts projection entries; an unreadable size is never 0 (the build fails `materialization_failed`); the Q11 migration's second pass after recovery, so a version whose application was in flight across an upgrade is recomputed in the same start; the stale retention comment; the old-layout tree removed only when no execution may hold it. Accepted limitation: a top-level component name containing `,`, `:`, `\` or whitespace that holds an input is refused `mount_plan_refused`. Open for later: eviction under `checktrees_max_bytes`.
4. **Figures:** the driver's runs from scratch worktrees: on `1a8a46f` (before the review fixes) `--slice 17` 1,123 of 1,123; on `c0f513c` unit 53 files and `--slice 17` 1,123 of 1,123, nothing left behind.

---

## E97. M3 slice 18, what a check run establishes, merged (provisional, 2026-10-08)

**Status: provisional.** The driver's record.

1. **Built** (rows M216 to M223, with the deferred M201 (f), M205 (d)(g)(i), M207 (c)): the runner self-test (D3 §2.8, R17) at each start, outside harness mode always and in harness mode behind its flag: thirteen boxes in the engine's own scope through the real `check` profile and judgment code, every case beside a control, results on `host_qualifications.check_runner`, qualified only when all ten cases pass; the B01 input case structural (E95 item 1: the box's mount table read host-side, the same rule as M212); the foreign-signal case sent by the engine itself to its own box's program, re-verified (membership, cmdline, start time, nested pid namespace) immediately before the kill, otherwise `not_exercised`; `runner_unqualified` when `check_runner` is null; recovery registrations (trigger `recovery`, generation, `retry_of`) with a budget counted from the stored chain; recording from the init's reports at restart only after closure (output null, so `EVIDENCE_MISSING`); the lease re-grant with a fresh challenge, never extending `timeout_s`; stdout and stderr interleaved on one FIFO made inside the domain after `pivot_root`, screened before publication (a held secret refused with a critical finding and `EVIDENCE_MISSING`); `definition_invalid`, `isolation_unqualified`, `environment_unbound` at admission; NOW's cause `check_unrunnable`; a quarantined domain marked `quarantined`.
2. **Driver's provisional readings** of the Verifier's eight questions: the self-test off by default in harness mode; M222 in the sandbox lane; "cancel" in M216 (b) is the deadline; output after a crash between the exit report and collection not pinned; `definition_invalid` via a `cwd` that is not a directory of the tree; `ignore-term` writes one line; `alloc` relies on the test's host-side read and a 128 MiB ceiling; interleaving at the program's write granularity. Objections 028 (M220 holds by a reserve the host can qualify with) and 029 (M216 tolerates a scope systemd removed) upheld.
3. **The review** found no serious defect; minor findings fixed: an exit report without `cancelled`, or cancelled by a lease lapse, ends `interrupted` at restart (never a pass or a failure); every removal under the engine home checks the resolved real path of its parent and never follows a link (the self-test's sweeps and the existing `removeEndedAreas`); prior self-test boxes are killed before their files are removed, and `sweepPriorSelfTestBoxes` reaches only this home's prior scopes; `box()` creates nothing after an abort; self-test boxes count in the resource envelope.
4. **Figures:** the driver's run on `1c7a00b`, from a scratch worktree: unit 54 files; `--slice 18` 1,165 of 1,165; no scope, self-test box or check program left.

## E98. M3 slice 19, the change classifier, merged (provisional, 2026-10-08)

**Status: provisional.** The driver's record.

1. **Built** (rows M224 to M228): the pure classifier `src/checks/classify.ts`, `CLASSIFIER_VERSION = 1`, reading trees, the governed file and the requirement index only, with every element of D3 §3.1 and the conservative fallback of §3.2 (`root_layout_changed`, `unhandled_change`); the tick's classification step after the gates, recorded by compare-and-set; the correction manifests gain `classifier_version`, `classifier_authority` and the proposal's discovery; `specRevision` hashes criteria and sensitive areas; revalidation of the whole binding immediately before the application's journal intent (inputs read inside the journal's project lock), before a Reviewer's application, and before any replayed protected operation the engine did not just intend, with unreadable trees left for a later pass and nothing invalidated; `classifier_authority` `{mode, version?}` (an unknown member `invalid_value`, `version` at least 1), `recommend` unless `authoritative` names the running version; migration 0014 (`protected_proposals.approval_binding`); `GET /v1/engine` reports `classifier_version`. Accepted as not built (driver, with comments at each site): an open proposal is not reclassified on a version or classifier change before approval (revalidation catches it); `area_unknown` checked against the closed list. A pre-existing defect fixed on the way: a failed protected application now deletes the never-effective version's `checks` rows before the version (the foreign key had rolled the failure path back in a retry loop; M28's and M53's failure paths go through the same code).
2. **Driver's provisional readings:** a fixture-classified proposal keeps its class; elements compared exactly for strict and loosening, for unclassifiable at least the listed and no extra strict or loosening; a narrowed root may also give `root_removed`, a `gate_kinds` change `applicability_changed`; the human's question re-raised after a Reviewer withdrawal, with no separate event.
3. **The review** found two serious defects, each with a Verifier case and a fix (both reachable only under `authoritative`, which no host sets yet):
   - **S1** (M228 (c)): `classify` ignored the effective version's own discovery errors, so deleting or repairing a definition that failed to parse, beside a new check, came out `tightening` (D3 §1.4: a dropped check is a loosening nobody approved). Rule: a structural P0 discovery error (one that leaves a definition or a governed field out of P0's maps; `area_unknown` among them as built, `criterion_unknown` not) that P1 does not reproduce with the same path and code adds an `unhandled_change` element at that path. M228 (b) stays `loosening`.
   - **S2** (M227 (c), second): an authoritative Reviewer could apply a tightening changing `required_checks` without the validation-scope approval D3 §3.2 requires. Under `authoritative` such an approval is now a recommendation (provenance `claimed`) on the decision the human answers; a recommendation never later becomes an application.
   - **Minor, fixed:** revalidation with nothing read returns false and invalidates nothing; the effective revision is read inside the journal lock and a classification computed at another effective version is not kept; before the commit the rebased tree's protected set must equal the proposal tree's, otherwise nothing applies and the intent is invalidated `EFFECT_PRECONDITION_CHANGED` (the Builder believes it reachable when a re-approved proposal was captured on an older base; the way forward is a new proposal on the current base); unit tests for the invalid-in-P1 branch and P0 errors.
4. **Figures:** the driver's run on `0780734`, from a scratch worktree: unit 56 files, 415 of 415; `--slice 19` 1,186 of 1,186, 204 files. Boundary: 26 paths, all the Builder's.

## E99. M3 slice 20, validation scope, merged (provisional, 2026-10-08)

**Status: provisional.** The driver's record.

1. **Built** (rows M229 to M233, with M204 (f) deferred from slice 15): a pure `computeScope` (`src/checks/scope.ts`) as D3 §4.2's one scope rule, from which registration (the union of a candidate's scopes), the gate's scope, the required sign-offs, the per-candidate acceptance content hash and preview staleness all derive; a scope is validated only when its required set is non-empty, every criterion of every obligation is named by a required acceptance-origin check, the kind inventory of its tier is present (T1 acceptance, smoke; T2 adds integration, security_lint; T3 adds property, failure_recovery; acceptance-origin required checks only), and every sensitive category has an acceptance-origin floor listing the gate kind (partial delivery counts); module tier overrides raise a scope's tier and never lower it; module presence read by engine git (`ls-tree`) at the candidate's revision, stored on `candidates.module_presence` with a `basis` hash of the module definitions (migration 0015), so a redefinition makes it unread; every module present counts at the Alpha gate (Q7 (a)); cadence by scope tier, and a fix whose presence read fails nominates by engine cadence when a module could raise the tier (driver's ruling); a nomination that cannot read its module facts records `checks_due` and every check is missing. Not built, commented at each site: the phase scope; registration when a scope grows on a spec or module change (the new check stays missing until registered); presence for superseded candidates; the fixture's criterion-kind rule; architecture approval (modules come from the fixture).
2. **The straddle** (E92 item 2 (3)): the plan fixture registers an index (`R<n>.1` per requirement) and the checks fixture sends criteria; ten accepted files expect the kind-inventory checks; the former single-check scopes are pinned refused (M229 (d), M230 (d)); the real-lane journey declares T2's smoke, integration and security_lint checks (read by the Reviewer, not run; to check before slice 22's real run).
3. **Driver's provisional readings** (the Verifier's eight): an uncovered criterion named by its key, unread presence `module_presence`; `covers_not_allowed` for a developer check naming a criterion; the `tier_floor` waiver tested at T2; one content hash per candidate over the union of its scopes, the gate kind excluded; presence changed by redefining `paths`; sign-offs named by module name; fixture checks of criterion-bearing kinds may cover no criterion; M204 (f) a second file.
4. **The review** found two serious defects, each with a Verifier case and a fix: (S1, M229 (c)) a requirement the scope touches but only partly delivers, never indexed, added no areas and the scope validated; now any touched requirement with null criteria leaves the scope incomplete, named by its id; (S2, M232) the content hash left out the module definitions and the required sign-offs, so a module's sign-off survived a change of its paths or tier; the hash now covers the scope modules (id, paths, effective tier) and the required sign-off set (left out when empty, so a project without modules keeps its hash). Minor, fixed: module paths the matcher cannot interpret are refused by the fixture and read as unread, never absent; only acceptance-origin floors count; the context package's `required` mark follows the scope rule (SEAM §176, M125 (h)), never fewer while a fact is unread; the review is queued from the highest tier across the candidate's scopes; an unrecognised `checks_due` form fails closed.
5. **A test race** in M71 (a tick begun before the held repository's hold could pass its integrity read and dispatch work created after the hold; D1 §8.1 allows it), the second form of the one 5370cd6 closed, made more likely by slice 20's longer tick: the Verifier confirmed from the tick's code that a timed-out step cannot dispatch, and the test now waits for a tick to end after the hold (`94a782a`).
6. **Figures:** the driver's run on `0f349ab`, from a scratch worktree: unit 57 files; `--slice 20` 1,185 of 1,186, the one failure the M71 race; M71 with the fix alone, three runs, 2 of 2 each. Not rerun in full after the test fix; slice 21's full run carries it. Boundary: 23 paths, all the Builder's.

## E100. Two decisions from slice 21's review: which item repairs a later candidate's stage check, and which scope resolves a finding (decided by Sean, 2026-10-08)

**Status: decided.** Both close places where D3's text left work in `verifying` with a failed check and no blocker; each comes with a Verifier case (M234, M235).

1. **S1, a stage check failing on a later candidate: the stage's own Builder repairs it** (Sean chose the recommendation over parking it for him or sending back the newer work). D3 §2.10's current candidate of a `stage_build` is the latest non-superseded candidate that holds it, directly or by ancestry, not only the candidate nominated from its own latest integration; its repair checks are its stage scope's required checks at that candidate. Everything else in §2.10 stands: one repair per item, candidate and generation, both limits, the progress key, the failed outputs in the next context. A `fix` keeps E43's fix candidate.
2. **S2, a finding naming another stage's check: the candidate's full scope counts** (Sean chose the recommendation over D3's literal gate scope with routing, or parking it for him). D3 §2.11's condition 2 reads "in the required set of one of the candidate's scopes" (the union registration uses, slice 20's `candidateContent`), matching E90 item 4's "the candidate's scope". Every other condition of F2 (c) stands: acceptance origin, covering the named criterion, passed by an execution registered after the disposition, evidence intact. A missing verification is named, and a `check_correction` routed, only when the named check is not a required acceptance-origin check covering the criterion in any of the finding's candidate's scopes.
3. **Driver's provisional reading, not brought to Sean:** a T2 review is not queued for a candidate whose stage work Q2 parked; it is queued when the work resumes and its stage gate is satisfied (no test reads it).

## E101. M3 slice 21, repair and findings, merged (provisional, 2026-10-08)

**Status: provisional.** The driver's record.

1. **Built** (rows M234 to M237): `reconcileRepairs` (`src/store/transitions/repair.ts`), run at the end of every transaction that records a result, ends an execution, finishes a run or moves work into `verifying`, and at a tick step: a `verifying` `stage_build` or `fix` whose repair check failed at its current candidate (E100 item 1 for a stage) is sent back once per item, candidate and generation (`work_items.check_repair`), with the failed outputs in the next context (kernel `check_outputs`; sandbox `check-outputs/<key>.txt`, served only as the API would serve it); the progress key over the tree and the failed checks (an unknown tree never matches; `repair_attempts_max` still bounds the loop); either limit parks with `blocker.checks`; F2 (c) resolution in `gates.ts` through the candidate's full scope (E100 item 2) with `missing_verifications` on the evaluation and the gate read, and `check_correction` routed at the `fix` disposition and when a version becomes effective; findings gain `criterion` (an enum of the index; any other is an invalid result); a Builder's objections recorded at `finishRun` as findings that block no gate and cannot be dispositioned; the X2 blocker (`check_conflict`) with `correct_check`, `change_spec`, `retry`, `cancel`, none changing a check state, a check or the spec; migration 0016. Not built, commented at each site: an X2 route from executing or integrating; any process for `spec_change` work; objections from other roles; re-arming a `change_spec` hold.
2. **Driver's provisional readings:** the Verifier's six (repair context fields; `missing_verifications` with no new reason code; the routed `check_correction` pinned by `trigger_id`; the X2 blocker no later than the repair it replaces, an objecting run still integrating; objections as findings, severity unpinned; `correct_check` and `change_spec` registering work triggered by the finding); a project-scoped finding keeps the version's required mark (the Builder's fallback); a T2 review is not queued for a parked stage (E100 item 3); a re-raised X2 blocker is a fresh decision.
3. **The straddles:** F2 (findings name `R1.1` in M01's second path, M42, M206 (e), M208 (d), M125 (e)(f), the real-lane path two); Q2's reach (objection 030 and M222: `repair_attempts_max: 0` before the build where a case is not about repair; M44 case 1 and M43 T2 now pin Q2). Objections 030 to 032 upheld.
4. **The review** found three serious gaps, all work left in `verifying` with a failed check and no blocker: S1 and S2, decided by Sean (E100), and S3, a `correct_check` hold that never ended (the hold now lasts while its correction is open and its proposal undecided; ending with no new version raises the X2 blocker again; an unrelated application does not release it). Also fixed as serious: a check output a later detector flagged was copied into a role's sandbox. Minor, fixed: dispositions of objection findings refused; accepted or deferred conflict findings raise no X2; `concerns()` by the stage scope; unit tests. Each serious item has a case (M234, M235, M236, M237). A suspected stall (a check `materializing` for 12 ticks) was a harness artefact: a check's launch takes about 6 s and 12 fast ticks end first.
5. **Figures:** the driver's run on `48841e1`, from a scratch worktree: unit 58 files; `--slice 21` 1,242 of 1,243, the one failure M222 (Q2's reach, missed by the static search), fixed in the test (`4a97d58`) and passing alone; M71 passed under full load (E99's race fix holds). Not rerun in full after the M222 test fix; slice 22's run carries it. Boundary: 30 paths, all the Builder's.

## E102. M3 slice 22, the end of M3's build, merged (provisional, 2026-10-08)

**Status: provisional.** The driver's record.

1. **Built** (rows M238 to M241): the cases (`a9ddd51`): M238, the project lane (a reference project, its mutants and root-hiding), with the test wrapper hardened against a file that runs no test; M239, the real check journey (real lane, `harness/real/checks-journey.mjs`, never run here with a real `claude`), its rehearsal on the scripted stand-in, and the Verifier's check-writing package (sandbox lane); M240, the M3 report skeleton (`docs/acceptance/reports/M3-report.md`), whose (b) fails until the report is final; M241, `M3-hands-on.sh`; the real-run instructions in `docs/acceptance/reports/M3-real-lane/README.md`. The Builder's part: the `check_correction` Verifier's package (`src/checks/guide.ts`): where checks are written, which programs a check may name, every requirement with its criteria and text, a definition's members (`DEFINITION_REFERENCE`, from which `DEFINITION_FIELDS` now derives), the kinds each tier requires (`SCOPE_KINDS`), the gate kinds the engine evaluates, and an example definition the engine's own parser accepts; `check_writing` facts in the reads.
2. **The review** found two serious defects, both in the Verifier's deliverables, both fixed with cases: S1, a rerun of the real journey could dispatch paid work left from an earlier attempt, and the README made a new run directory each time (the project is now paused in `finally`; a rerun is refused while earlier work is dispatchable; the README exports one `SURETY_REAL_RUN_DIR` and logs to `runner.log` inside it); S2, the hands-on script released a held check once with no containment read (every release now reads `cgroup.procs`, the pid's `/proc/<pid>/cgroup` and the domain's place under the engine's scope first, E64; M241 (e) checks every release). Minor, fixed: the trust prompt named M2's projects (now M3's one project and its limit); a check's toolchain exposed the nvm prefix (node is copied under the run directory, pinned by sha256, its only `read_path`, PATH `/usr/bin:/bin`); M239 (b)/(c) asserted one execution (now each); the hands-on script's no-pause switch bypassed its terminal guard, and an existing directory was reused; report placeholders; SEAM §240; and the Builder's four (an unindexed requirement's criteria and areas reported unknown, not "no sensitive area"; a routed finding names its route and what it lacks; `runner_class` states the refused `container` and `remote`; missing check facts reported unreadable). The Reviewer confirmed M239 runs only in the real lane, the rehearsal refuses a binary that is not the stand-in, the token reaches no check or harness file, and the approvals asked match the README.
3. **Figures:** the driver's run on `0db16f9`, from a scratch worktree: unit 59 files passed; `--slice 22` 1,261 of 1,262, the one failure M240 (b), by design. The review fixes (`2d6b7d5`, `986c05d`) came after that run and were checked alone: unit 479 of 479 (59 files), check-writing package 11 of 11, M239 sandbox 1 of 1, M125 7 of 7 (the Builder); M241 5 of 5, M240 1 of 2 ((b) by design, 81 pending facts), M239 sandbox 1 of 1, the M239 rehearsal 4 of 4 on the stand-in, and `M3-hands-on.sh` exit 0 through a pseudo-terminal, each release after its own containment read under the engine's incarnation scope (the Verifier). Not rerun in full after the fixes; the M3 acceptance run carries them. Boundary: Verifier 11 paths, Builder 6, all inside each role's paths.
4. **What remains for M3's acceptance:** Sean's real run (M239, a new `claude setup-token`, his approvals of `trust_activation`, the `check_correction` decision and qualification if asked), then the Verifier fills `M3-report.md` from the records so M240 (b) passes, and Sean runs `M3-hands-on.sh`.

## E103. Sean's first M3 real run: path one not established; the check-writing package's scope rule (provisional, 2026-10-08)

**Status: provisional.** The driver's record.

1. **The run** (run directory `~/surety-m3-real-20261009`, Claude Code 2.1.294, `claude-sonnet-5-5`, Sean's subscription token): the qualification attempt succeeded (three canaries, about 75 s; Sean approved `qualification_approval`); the first `trust_activation` decision was invalidated before it was answered ("dependency manifest changed": the engine restarted between steps and qualified the host again, a new `host_qualification`), and Sean approved the second. In path one the real Verifier wrote four checks (`r1-1`, `r2-1`, `r3-1` naming R1.1, R2.1, R3.1, and `smoke`, which imports all three source files); classified `tightening`; Sean approved; applied and discovered. Stage 1 (R1) failed `smoke` (`src/logout.mjs` does not exist at stage 1). The real Builder repaired once, changed nothing, and objected (`requirement_conflict`, naming `smoke`); the engine raised the X2 `check_conflict` decision. The gate was not satisfied, so path one was "not established" and the directory halted; the project paused, nothing live. The Builder also reported the seeded R2 defect, outside its stage, and left it. The engine behaved as D3 says throughout; the first real evidence of the objection and X2 route.
2. **The cause:** the check-writing package (E102 item 1) never stated the scope rule of `computeScope`: a check covering no criterion is required at every stage gate, so it must pass before later stages' code exists. **Fixed:** the package states the rule and the stage plan from the store (unknown, never "none", when unreadable): case M239 (b) (`4d3d3bf`), fix `e398062`. Checked alone: unit 481 of 481, M239 sandbox 2 of 2, M125 7 of 7. Not rerun in full; the M3 acceptance run carries it.
3. **Next:** Sean reruns with `SURETY_REAL_RERUN=m3_path_one` in the same run directory (attempt and activation kept; a new project; the earlier one paused, its X2 decision left open).

## E104. A fix that names a finding is nominated at every tier (decided by Sean, 2026-10-08)

**Status: decided.** Sean's second real run (`SURETY_REAL_RERUN=m3_path_one`, same run directory): Sean approved the new checks (`tightening`; `smoke` now syntax-checks only the files that exist); path one passed, (d) passed (the token in no file or git object). Path two: the real Builder built stage 2 and left the seeded R2 defect alone (out of scope); `r2-1` failed and the stage parked (`repair_attempts_max: 0`); the real Verifier reported a `high` finding naming `r2-1` and `R2.1`; the real Reviewer dispositioned it `fix`; the real fix Builder corrected `src/session.mjs` but returned `nominate: false`. At T1 a fix's integration is nominated only at the Builder's request (`cadenceOf`; the engine's cadence covers a fix naming a finding only at a T2 or T3 scope), so no candidate held the fix, no check ran on it, and the finding could never resolve: the fix item sat `integrated` with no blocker and nothing pending, and the journey timed out waiting for candidate 3 ("not established", halted).

1. **Decided:** the integration of a fix that names a finding is a nomination point at every tier, T1 included, as E43 already made it at T2 and T3 ("nothing else would nominate the fixed code, whose candidate resolves the finding"). The Builder's request is no longer needed for it. Rejected: telling the T1 Builder to nominate with a blocker when it does not (more code, and a real agent can still forget); rerunning unchanged (the silent wait stays).
2. **To build:** one case (a T1 fix naming a finding, the Builder not asking, is nominated by the engine; the covering check runs on that candidate and the finding resolves) and the fix in `cadenceOf`; cases that pinned the old T1 behaviour are straddles. Then Sean reruns path two.

## E105. The third real try: path two's fix resolves its finding; a harness change in the stage's diff draws a Reviewer finding (provisional, 2026-10-09)

**Status: provisional.** The driver's record. Run by the driver on Sean's instruction while he was away ("can you run the commands and continue to push"), on main `8270579` (E104 built), `SURETY_REAL_RERUN=m3_path_two` in `~/surety-m3-real-20261009`; four real runs, no approvals.

1. **Established:** path two ran on a project of its own (`real-check-journey-two`) with path one's approved checks as its initial version. The real Builder built stage 2 and left the seeded R2 defect (out of scope); `r2-1` failed and the stage parked; the real Verifier reported a `high` finding naming `r2-1` and `R2.1`; the real Reviewer dispositioned it `fix`; the real fix Builder fixed `src/session.mjs` (and asked for nomination this time); the engine nominated the fix's integration (E104); `r2-1` passed on that candidate and the finding resolved through it (F2 (c); `resolution_verification` set). (a), (b), (d) passed.
2. **Not established, (c):** both gates were `not_satisfied` with `FINDING_UNSATISFIED` on a second finding the real Reviewer raised (`hygiene`, `medium`, open, no disposition): the stage's diff changed `.surety/policy.json` (`repair_attempts_max` 3 to 0) and `.surety/project.json` (id and name), which no role wrote; they come from the harness's setup of path two's project. An earlier Reviewer noticed the policy change and let it pass; this one reported it. The cause is the harness, not the engine or an agent's slip, so the driver did not spend on another rerun without Sean.
3. **Next:** the Verifier keeps the stage's diff to what the roles write and rehearses it; whether a Reviewer's context should tell an owner's policy change from a Builder's change is a possible design question for Sean. Then Sean decides whether to rerun path two (four runs).

## E106. A Reviewer's context names the engine's and the owner's commits in its range (decided, 2026-10-09)

**Status: decided by Sean** (M3 report question 6; E105 item 3). Asked on the evidence of the third real try: a first candidate's diff runs from the parent of the project's first recorded revision, so it always holds the engine's bootstrap commit (`.surety/project.json`) and every policy revision committed before the stage (`.surety/policy.json`), beside the Builder's work; the Reviewer's context said only "the candidate's changes, from <base> to <revision>", and a real Reviewer raised an open finding on those two files that blocked both gates.

1. **Decided (option c):** the Reviewer's context names each commit in its diff's range that the engine made on no role run's behalf (the project's bootstrap, a policy revision through the policy route, and any other such engine commit) and says it is the engine's or the owner's, not the Builder's work to review. The diff itself is unchanged: the Reviewer still sees every change and may still report on one. Which commits are the engine's comes from the engine's own records, never from a commit's trailers alone, which a role could write. What cannot be established is said as unknown, never as "none". Rejected: (a) leaving it to a person to disposition each such finding (every first candidate would draw one); (b) starting a first candidate's diff after the setup commits (hides the owner's changes from the Reviewer).
2. **To build:** one case (a first candidate whose range holds the bootstrap and a policy revision: the Reviewer's context names both as the engine's or the owner's and the Builder's commits as not; a commit carrying the same trailers but made by a role is not named), and the change in the Reviewer's context. Then the driver reruns path two (`SURETY_REAL_RERUN='m3_path_two,judge:M239 (c)'`, four runs) on Sean's instruction of 2026-10-08.
3. **Built** (merge `d92c0c4`): M125 (i) (sandbox lane) and the Builder's change (`revisionRecords`, `engineCommitsInRange`, `engineCommitLines`; 5 unit tests, unrecorded commits named as unknown). Before the rerun the driver read the third try's store and repository read-only: path two's range holds the bootstrap and policy revision (recorded, no run) and the stage's and the fix's commits (recorded, by their runs), and no unrecorded commit. Noted for Sean, not decided: when the owner adopts an out-of-band change the engine records only its tip, so commits beneath it would be named unknown, not the owner's.

## E107. The fourth real try: M239 passes 4 of 4 (provisional, 2026-10-09)

**Status: provisional.** The driver's record. Run by the driver on Sean's instruction ("can you run the commands and continue to push") after his E106 decision, on main `3fb093d` (E106 built; the fake's rehearsal 4 of 4 and its path-two rerun 4 of 4 first), `SURETY_REAL_RERUN='m3_path_two,judge:M239 (c)'` in `~/surety-m3-real-20261009`; four real runs, no approvals.

1. **Established:** M239 (a) to (d) pass, 4 of 4; the directory ends with nothing halted. Path two ran on project `proj_01M4G884GMRSHE31XBC0E2E0B4`: `r2-1` failed on the stage's candidate; the real Verifier's finding `fnd_01M4G89DG733E7VGDVM7XTG3N1` named `R2.1` and `r2-1`; the real Reviewer dispositioned it `fix` and raised no other open finding; the engine nominated the fix (E104); `r2-1` passed on that candidate (`cr_01M4G8B18STY2NV9ZV7B3CD7Y7`, trigger `nomination`, in a `check` domain) and the finding resolved through it (`resolution_verification` set); both gates satisfied. (d): no fixture-written check result; the token in no file of the run directory and no git object.
2. **Spend** in Claude Code's estimates: path two's four runs 0.198 USD (0.039, 0.063, 0.058, 0.037), on Sean's subscription.
3. **Next:** the Verifier copies `state.json` and `observed/` to `docs/acceptance/reports/M3-real-lane/2026-10-09/` and completes the M3 report so M240 passes; then the full suite, Sean's hands-on run (M241) and his acceptance of M3; then Sean revokes the token.

## E108. M3's acceptance runs on the final main; Sean's hands-on run and decision remain (provisional, 2026-10-09)

**Status: provisional.** The driver's record.

1. **The full `npm test`** on `bb9dc7e` (this workstation): unit 486 of 486 (60 files); acceptance 1,265 of 1,265 in 218 files, none failed, cancelled or skipped; M240 passes with the report final.
2. **The exhaustion lane** on `mini-hp01`, on `bb9dc7e`, `node scripts/run-tests.mjs acceptance --lane exhaust` with `SURETY_EXHAUSTION_HOST` set there: 12 of 12 (M133, M130 (f) and (g), M205 (g)); every OOM kill in the kernel log `CONSTRAINT_MEMCG` in a `surety-…` `dom_` or `probe_` scope; the staging containers up throughout.
3. **The logs** are not committed (`.gitignore` has `*.log`); the driver kept copies beside the real lane's records, in `~/surety-m3-real-20261009/logs/` (`final-npmtest.log`, `m3-exhaust-mini-hp01.log`), both searched for the token by its file (no hit).
4. **The M3 report** (merged) records every BS3 §1 condition as met and M3 as not accepted. **Left for Sean:** the hands-on run (`docs/acceptance/reports/M3-hands-on.sh`, M241), his decision to accept M3, and revoking the subscription token (and deleting `~/.config/surety/claude-subscription.token`).

## E109. M3 accepted (decided by Sean, 2026-10-09)

**Status: decided by Sean.**

1. **Accepted.** Sean accepted M3 on the record of E108 (`npm test` 1,265 of 1,265 and unit 486 of 486 on `bb9dc7e`; the exhaustion lane 12 of 12 on `mini-hp01`; the real lane's M239 4 of 4, E107; the report final) and his hands-on run (M241).
2. **The hands-on run** (`~/surety-m3-hands-on-20261009T140150Z`, main `0c44c76`): the runner self-test qualified (10 of 10); CHECK (1) to (5) shown as M241 states them. His first two attempts stopped fail-closed at step 4: he paused at step 3 past the held check's 90 s timeout, the engine ended the check, and the script's containment read released nothing. The script now shows the clock and its two pauses while a check is held go on by themselves 25 s before the deadline (`0c44c76`). Step 6 printed `"trigger": null` for a field the re-run response does not carry (the stored trigger was `operator_request`, as the gate's history shows); the Verifier corrects the script's line.
3. **Next:** Sean revokes the M3 subscription token and deletes `~/.config/surety/claude-subscription.token`. M4 starts from D4 (E95): first Astra's cross-review of D4 revised draft 1 (`design/d4`, `ad172de`: approve with amendments, blocking objections B01 to B08), brought to Sean one at a time; then D4's text marked decided; then M4's build spec, opening with D4 §9.6's probe (already run once for feasibility on `design/d4`, `bfea241`).

---

## E110. D4 B01: service supervision after an engine restart (decided by Sean, 2026-10-09)

**Status: decided by Sean.** Sean chose option (a), the recommendation in `docs/design/sdlc-design-D4-astra-dispositions.md`, for B01 of `docs/reviews/D4/sdlc-review-D4-Astra.md`.

1. **M4 takes parts 1 and 3.** A service launch is single-use, with automatic application restart disabled. The init retains the original application's identity and terminal exit observation; it never substitutes a descendant. Natural exit, refused setup and failed exec are legal endings; uncertain termination stays quarantined. Startup closes outstanding launch authority, refuses requests from a previous incarnation, and accounts for every surviving or uncertain service domain's resource reservation before admitting new work. Unknown ownership or resources the store cannot account for block affected deployment and admission; they are never adopted or stopped automatically.
2. **Authenticated reattachment is deferred to D5 with Live.** After an engine restart, a surviving Alpha service may keep running and be inspected through the service manager and `/proc`, but supervision is `unknown` and no verification may pass. Logs and relay stay closed until redeployment or teardown; B07's detailed secret/redaction policy remains a separate decision. Reattachment after an engine restart goes on M4's not-claimed list.
3. **Accepted cost:** an engine crash during verification ends that round `unknown`; Sean redeploys to restore verification. The alternative of building authenticated reattachment and recovery of the original application's identity and exit state in M4 was not selected (estimated at roughly one extra slice, plus B07's more complex variant).

This records B01 only. B02 to B08 remain undecided; no draft revision, implementation or other work is started by this entry.

---

## E111. D4 B02: reconcile the whole effect before settling or retrying (decided by Sean, 2026-10-09)

**Status: decided by Sean.** Sean accepted B02 of `docs/reviews/D4/sdlc-review-D4-Astra.md` as written, following the recommendation in `docs/design/sdlc-design-D4-astra-dispositions.md`.

1. **Complete inventory and outcome precedence.** Reconciliation takes a complete, bounded inventory of the environment's recorded resources and exact-prefix unit names, including inactive/failed units and pending manager jobs. Discovery grants no authority to stop a resource. Incomplete inventory or unread required state yields `unknown`; resources outside the frozen attempt's permitted states yield `conflicting`. These take precedence over `applied`, `absent` and `partial`.
2. **Deploy absence and success must be established.** `absent` requires the next unit and domain absent, no launch granted, the prior state exactly unchanged, no unexpected environment resources, and no outstanding request or launcher able to perform the effect later. `applied` requires the authorized unit invocation and original application instance, matching identity and required prior termination. A refused grant is not proof of unit removal; a remaining refused unit stays pending/partial until bounded cleanup and a new read establish absence.
3. **Teardown covers every resource.** `applied` requires closure and observed removal of all covered units, populated domain cgroups, link sockets and runtime directories. Surviving owned resources yield `partial`; unexpected or uncertain ownership yields `conflicting`; unread state yields `unknown`. `absent` requires the entire frozen pre-state unchanged and no outstanding stop/cleanup request able to act later. A failed query's empty output never establishes success.
4. **Settle outstanding effects before proceeding.** Before lease transfer, retry or replacement dispatch, close launch authority and establish quiescence of the prior effect's host calls and manager jobs. Killing a CLI or receiving cancellation is insufficient. Unestablished quiescence leaves the effect ambiguous and prevents interleaving a new effect. Destructive actions remain confined to positively owned exact resources.
5. **Acceptance obligation and cost:** strengthen D4-A03/A04/O04/O09/O10/O11 for unexpected generations, residual resources, incomplete inventory and delayed manager create/stop jobs after caller cancellation. Estimated cost: contract text and about six acceptance cases; no new mechanism.

This records B02 only. B03 to B08 remain undecided; no draft revision, implementation or other work is started by this entry.

---

## E112. D4 B03: immutable intent for each retry (decided by Sean, 2026-10-09)

**Status: decided by Sean.** Sean accepted B03 of `docs/reviews/D4/sdlc-review-D4-Astra.md` as written, following the recommendation in `docs/design/sdlc-design-D4-astra-dispositions.md`.

1. **Separate operation and attempt intent.** The operation freezes its authorization, source mapping, artifact, configuration, target set and environment identity. Before each attempt's first host call, one transaction allocates its environment generation and freezes its exact next-unit names, the prior resource instances it may replace and any explicitly authorized cleanup of earlier attempts. Its capability and reconciliation probe use that attempt intent. No attempt changes the operation's authorized inputs or silently acquires authority over unexpected resources; the existing frozen-operation trigger stands.
2. **A partial retry authorizes only the bounded remaining effects.** Its human preview names the reconciled state and those effects. The dependency manifest binds operation, attempt, environment and lease generations, configuration, qualification, resource identities and the observations used to derive the effects. Changed consequences stale the preview; retry cannot simply replay the original stop/start sequence against changed state.
3. **Finalization is replay-safe.** The finalizer records the confirmed effect once and creates or returns one durable verification-round identity. External identity reads and check execution occur outside that transaction against that identity. Replay returns the same receipts and creates no additional round; recovery resumes or explicitly supersedes the round under D4 §5.3.
4. **Acceptance obligation and cost:** extend D4-O03/O05 with two attempts, partial cleanup, refusal of changed artifact/configuration, crashes around finalization and a changed partial-retry preview. Cost: one additional table or column set; no change to the existing frozen-operation trigger.

Sean requested the remaining questions three at a time. B04 to B08 remain undecided; this entry starts no draft revision, implementation or other work.

---

## E113. D4 B04: revalidate gate eligibility immediately before the effect (decided by Sean, 2026-10-09)

**Status: decided by Sean.** Sean accepted B04 of `docs/reviews/D4/sdlc-review-D4-Astra.md` as written, following the recommendation in `docs/design/sdlc-design-D4-astra-dispositions.md`, in his answer to the B04 to B06 batch.

1. **Recheck eligibility at the point of use.** Immediately before each effect, revalidate the issuing gate's current eligibility for the operation's exact candidate and authorization binding, including effective protected version, policy, deciding registrations/results, required sign-offs and approvals, findings and evidence integrity. This read neither issues nor consumes another authorization.
2. **Refuse changed preconditions.** A changed binding or unsatisfied eligibility refuses with `EFFECT_PRECONDITION_CHANGED`, with no adapter effect call. The durable precondition manifest identifies these dependencies and the environment facts already required. Registration or invalidation owed by a trigger blocks eligibility; an earlier satisfied evaluation cannot bypass it.
3. **Acceptance obligation and cost:** extend D4-O02 with protected tightening, pending required rerun, new blocking finding, lost sign-off and expired required evidence between issuance/intent and effect; the positive control preserves the operation's own expected authorization consumption. Cost: a small change, five refusal cases and a positive control.

---

## E114. D4 B05: the newest registered verification round decides (decided by Sean, 2026-10-09)

**Status: decided by Sean.** Sean accepted B05 of `docs/reviews/D4/sdlc-review-D4-Astra.md` as written, following the recommendation in `docs/design/sdlc-design-D4-astra-dispositions.md`, in his answer to the B04 to B06 batch.

1. **Register before reading.** A verification request records a durable, monotonically ordered round for the operation/attempt and invalidates dependent completion evaluations in the initiating transaction, before its first external identity read. The newest registered round decides regardless of completion order. While it is pending, interrupted, cancelled or quarantined, no earlier pass satisfies completion; earlier evidence and `last_verified` remain historical facts.
2. **Freeze the round's bindings.** Candidate, source mapping, operation, attempt, environment generation, configuration, protected version and required check set are frozen for the round. Both identity reads and every deciding execution/result name that round. A changed required set or protected version supersedes it and requires fresh bracketing reads and registrations. Recovery preserves bounded retry accounting and records a new deciding round when the bracket must restart; no read or result is relabelled into a later round. E110's refusal of authenticated reattachment in M4 still applies.
3. **Guard publication and completion.** Verification insertion and environment projection writes check both environment generation and deciding round in one transaction. Completion reevaluates current dependencies and evidence rather than trusting a stored verified label. Qualification is checked at round start and finalization; lapse before finalization makes the round `unknown` and requires a fresh qualified round.
4. **Acceptance obligation and cost:** extend D4-V01/V03/V04/V06/V08 for reverse completion order, a new request held before its first read, cancelled/quarantined latest rounds, protected change, recovery, qualification lapse and evidence loss. Estimated cost: contract text and about six cases.

---

## E115. D4 B06: bounded orchestration, explicit lease release and check capacity (decided by Sean, 2026-10-09)

**Status: decided by Sean.** Sean accepted B06 of `docs/reviews/D4/sdlc-review-D4-Astra.md` as written, following the recommendation in `docs/design/sdlc-design-D4-astra-dispositions.md`, in his answer to the B04 to B06 batch. The numeric deadline remains for his later build-spec approval; 15 minutes was an example, not a decided value.

1. **A durable deadline bounds orchestration.** Track a deadline and progress independently of effect success, covering admission waiting, verification registration, reads and infrastructure retries. The deadline survives restart and is never renewed by a tick or retry. Expiry records verification `unknown` with missing execution/resource identities; it never invents a check result or claims termination.
2. **Every exit path states its lease disposition.** Cover pre-effect refusal, reconciled failure, verification failure/unknown, superseded candidate, completion refusal and cancellation. Release only after outstanding effects are quiescent and unsafe ingress is closed. Unknown termination retains the domain's quarantine and resource reservation even after orchestration ends, without reusable authority. A blocker states the cause and permits bounded re-verification, abandonment of completion or preempting teardown as applicable. Preempting teardown is available during verification as well as ambiguous deployment.
3. **Reserve verification capacity before deployment.** Service admission reserves room for at least one serial post-deploy check under the configured envelope, or refuses before stopping the prior service. Recovery restores reservations before dispatch. A persistent service reservation must never make its mandatory verification impossible.
4. **Acceptance obligation and cost:** extend D4-O02/O07/O10 and V04 for pre-launch refusal, superseded queued checks, missing registration, resource starvation, quarantine, restart near the deadline, abandonment and teardown during verification. Keep D3's no-result-on-unknown-termination rule. The reservation means room for one fewer concurrent role run beside Alpha than E95's Q6 note indicated; the deadline value is to be proposed with the build-spec limits.

B07 and B08 remain undecided. These entries record decisions only and start no draft revision, implementation or other work.

---

## E116. D4 B07: withhold surviving-service output after restart (decided by Sean, 2026-10-09)

**Status: decided by Sean.** Sean chose B07 option (a) in `docs/design/sdlc-design-D4-astra-dispositions.md`, the recommended variant of B07 in `docs/reviews/D4/sdlc-review-D4-Astra.md`, in his answer to the B07 and B08 batch. This follows B01 option (a), E110.

1. **No output publication from a surviving service after engine restart.** Its logs, service link/operator relay and checks against it are refused with an explicit redaction-unavailable condition until the service is safely replaced or torn down. The restarted engine must not publish old captures or new output under a redactor that knows only the newly configured secrets. Authenticated recovery of old secret versions is deferred with reattachment to D5; it is not built in M4.
2. **Preserve the output boundary.** Raw service output never goes to the service manager's journal, unit standard streams or another persistent sink. Raw capture remains in protected, unswappable volatile storage until screening. Host-read process fields and error details are untrusted output for publication and require the same protection; they cannot bypass the refusal when redaction is unavailable.
3. **Expose rotation honestly.** The environment read distinguishes the running configuration/secret version from the newly configured version and reports rotation pending replacement when applicable. No raw secret value is published to explain that state.
4. **Acceptance obligation and cost:** adapt D4-A09/S01/S03/S04 to the M4 refusal policy: rotate S0 to S1, restart with the S0 service surviving, and exercise old captures, new output, attempted checks/relay access and mutable process metadata. Neither raw secrets nor registered escaped forms may reach records, events, responses, unit properties or journal output. Accepted cost: redeploy after an engine restart before reading that service's logs.

---

## E117. D4 B08: canonical artifact modes and bounded preparation (decided by Sean, 2026-10-09)

**Status: decided by Sean.** Sean accepted B08 of `docs/reviews/D4/sdlc-review-D4-Astra.md` as written, following the recommendation in `docs/design/sdlc-design-D4-astra-dispositions.md`, in his answer to the B07 and B08 batch. The four numeric defaults remain for his later build-spec approval; no values were decided here.

1. **Canonical modes preserve artifact identity through sealing.** The manifest uses regular-file mode 100644 for non-executable source files and 100755 for executable source files. Sealing removes write permission while preserving executable class; the target reader reconstructs the same class and separately verifies read-only presentation and immutable pathname identity. Ownership, umask and removed write bits do not change the canonical digest; changed executable class does. The sorted projection is complete: extra or missing entries, links and special files are refused or differ, never silently omitted.
2. **Bound preparation and retained storage.** Declare finite limits on entries, per-artifact bytes, aggregate admitted/retained bytes and elapsed work. Admission preserves the engine's disk reserve before staging writes. Exceeding a limit refuses before deployment, records the specific bound and removes only unreferenced partial staging. Referenced artifacts are never evicted to admit a new one. Materialization and hashing yield within the existing API/tick responsiveness contract.
3. **Acceptance obligation and cost:** cover executable and non-executable files through sealing and target read, umask variation, added/missing files, byte/entry/aggregate limits, cancellation and interrupted staging cleanup. The M4 acceptance seam fixes numeric defaults and boundary values before implementation, following Sean's approval of the proposed build-spec limits. Cost: contract and boundary cases plus four numeric defaults to decide later.

B01 to B08 are now decided by Sean in E110 to E117. This completes the requested decision recording; no D4 draft revision, status change, M4 build spec, implementation or other work is started here.

---

## E118. D4: Astra's variants on J1 to J9 and her suggestions N01 to N04 (decided by Sean, 2026-10-09)

**Status: decided by Sean.** Sean accepted the last batch of `docs/design/sdlc-design-D4-astra-dispositions.md` as recommended.

1. **J1 to J9 accepted with Astra's variants** (`docs/reviews/D4/sdlc-review-D4-Astra.md` §4), each as shaped by E110 to E117: J1 with per-attempt intent and a durable verification round (E111, E112); J2 with B01's single-use launch, exit handling and recovered accounting, without reattachment (E110), and mixed-owner recovery tests proving that only service domains survive; J3 with coalescing of repeated requests while an operation is pending and caller-supplied fixture bindings only through `src/testing/`; J4 with B04's pre-effect revalidation (E113); J5 as written; J6 with environment-scoped drift and a persistent acknowledgment; J7 with one durably bound round and the original application identity (E114); J8 with the fixed-generation relay's closure and no-retarget tests; J9 with B05 and B06 (E114, E115). **Accepted tests that change:** M08's "deployment unsupported" boundary moves; M01, M44 and M140's fixtures gain the new authorization prerequisites. A Verifier makes these changes and records them in COVERAGE (E92 item 2's precedent); no production compatibility escape.
2. **N01 to N04 accepted, editorially:** the observed condition's explicit precedence and acknowledged drift kept visible (N01); GET routes stay stored reads, with no adapter call or write on a read (N02); feasibility evidence, adapter qualification and milestone tests kept apart (N03); D4's schema appendix and not-claimed list aligned with the body (N04).
3. **Next:** D4 draft 2, by one architect agent on `design/d4-draft2`, applying exactly E95 and E110 to E118 and reopening nothing (E20: no draft 3). The driver checks it against these entries; then D4's status is "decided" and the M4 build spec and acceptance plan follow, with the numeric defaults of E115 and E117 for Sean's approval.

---

## E119. The interactive roles' design comes after M4 (decided by Sean, 2026-10-09)

**Status: decided by Sean.**

1. **Where the Spec Writer stands.** The Spec Writer (F §4.1), with the Vision assistant and the Architect, is the front of the pipeline, and none of it is built: M1 to M3 start from an approved baseline entered as a fixture (`migrations/0005`; M1 build spec §3), D1 §19.3 left sessions out of M1, and E10 makes the conversational roles engine sessions. The specification change workflow (F §3.8: change request, the Spec Writer's proposed diff, impact analysis, the human's approval) and the retrofit adoption path's baselines (E6: Spec Writer and Architect in retrofit mode) are unbuilt with it. Until it is, the owner writes a project's spec from `docs/spec/templates/project-spec-template.md`.
2. **Decided:** the design of the interactive roles (Vision, Spec Writer and Architect as engine-metered sessions under E10, the spec change workflow, and the adoption baselines) is written **after M4** is accepted. Its order relative to D5 (Beta and Live) is decided then. M4's scope is unchanged (E95, E110 to E118).

---

## E120. D4 draft 2 approved to build (decided by Sean, 2026-10-09)

**Status: decided by Sean.**

1. **Approved.** D4 draft 2 (`docs/design/sdlc-design-D4-deployment.md`, merged `3b55782`), which applies E95 and E110 to E118, is approved to build. Its status line says so. No draft 3 (E20).
2. **The draft's "For Sean, not applied" items go to the M4 build spec**, not back into D4: the four decisions (a re-verification's bound after the orchestration deadline; whether a service with supervision `unknown` may read `healthy`; a kill between the launch grant and the init's `started` report; stable arguments in the service's requirements) each as a row with the driver's recommended default for Sean to confirm; the three missing cases (Astra's Switchboard-style reference service whose identity and health pass while a specified user operation fails; `identity_observation_every`; refusal of unsupported configurations) as acceptance rows; `adapter_read_deadline`'s suitability with the five numeric settings of E115 and E117 (`deploy_orchestration_deadline`, `artifact_max_entries`, `artifact_max_bytes`, `artifacts_max_bytes`, `artifact_prepare_deadline`).
3. **Next:** the M4 build spec and acceptance plan by one architect agent, for Sean's adoption; M4's build spec opens with D4 §9.6's probe confirmation (E95).

---

## E121. The M4 build spec and acceptance plan adopted (decided by Sean, 2026-10-09)

**Status: decided by Sean.**

1. **Adopted:** `docs/spec/M4-build-spec.md` (BS4) and `docs/acceptance/sdlc-M4-acceptance-plan.md`, draft 1 (merged `9445c07`): 44 rows, M301 to M344, in slices 23 to 30; every one of D4's 63 Appendix C statements mapped to one row (checked by the driver). Slice 23 opens with the confirmation of D4 §9.6's probe (E95).
2. **E120's carried decisions, as recommended:** CD1, a re-verification after the orchestration deadline gets its own durable deadline and retakes the environment lease; CD2, a service whose supervision is `unknown` never reads `healthy`: it reads `degraded`, detail `supervision_unknown`; CD3, a kill between the launch grant and the init's `started` report stays `unknown`, and the way out is preempting teardown and a new request; CD4, stable process title and arguments are a requirement of the service (the project-spec template and the Builder's package), with no engine change.
3. **Numeric defaults, as proposed:** `deploy_orchestration_deadline` 1,800 s (range 300 to 10,800); `artifact_max_entries` 20,000; `artifact_max_bytes` 256 MiB; `artifacts_max_bytes` 2 GiB, never evicted; `artifact_prepare_deadline` 600 s; `adapter_read_deadline` stays 10 s, measured in M311 and M338 and returned to Sean if a read takes more than half of it.
4. **BS4 §16 questions 1 to 9, as recommended:** the domain cgroup is the unit's own; the exhaustion lane on `mini-hp01` creates only units its own disposable homes derive, and no deployment target is there; **slice 24's first test that creates a real unit on the workstation waits for Sean's go-ahead**; the test runner makes rule 7's before-and-after check itself (read-only); M342 runs alone with `node --test`, as M239 did; **in the real lane Sean runs `surety qualify-adapter` and `surety deploy` himself**; artifacts are never evicted, so `retention_full` is reachable and goes on the not-claimed list; D4-T05 asserts D4 §6.2's mapping; a hands-on script is written.
5. **Owner-file changes made by the driver (BS4 §15):** `scripts/run-tests.mjs` gains rows M301 to M344 and rule 7's check around every acceptance run (before: the user manager must print `running`, or nothing runs; after: by exact name against a snapshot taken before, a `surety-*` user unit the run left fails the run, and leftover `/dev/shm/surety*` and `/tmp/surety-*` files are reported; it only reads, never stops or removes); `CLAUDE.md` names M4 and BS4, slices 23 to 30, the four plans, and rules 1 and 2; the project-spec template gains the environment fields and CD4. The manifest's slices 23 to 30, `sandbox`, `exhaust` and `real` entries are added by each slice's Verifier (E92 item 4) and checked by the driver. `npm test` fails until every M4 row has a passing file; `--slice N` serves meanwhile.
6. **Next:** slice 23 with a fresh Verifier and Builder. Nothing paid and no real service unit on the workstation without Sean's go-ahead.

---

## E122. D4 §9.2 and §3.4 confirmed against the probe (decided by Sean, 2026-10-09)

**Status: decided by Sean** (BS4 §9.1, §10).

1. **The host is unchanged:** read by the driver, `uname -r` 6.6.87.2-microsoft-standard-WSL2 and `systemctl --version` systemd 255 (255.4-1ubuntu8.17), the probe's versions; no new probe runs (D4 §9.6).
2. **Confirmed:** BS4 §10's reading of the probe's log: nothing contradicts D4 §9.2 or §3.4; the transient unit with `Delegate=yes` and its limits, the launcher as `MainPID`, the unit's survival of its creator's SIGKILL, a new `InvocationID` on restart, removal on stop, the exact unit's `ControlGroup` and `InvocationID`, and the application's identification by `NSpid` with its tree read through `/proc` are confirmed for the stand-ins; every claim not established names the M4 row that establishes it (D4 §11 class B). The domain cgroup is the unit's own (E121 item 4).
3. **Consequence:** slice 24 may start once slice 23 has merged; its first test that creates a real unit on the workstation still waits for Sean's go-ahead (E121 item 4).

---

## E123. One full run per slice, overlapped with the next slice (decided by Sean, 2026-10-10)

**Status: decided by Sean** (amends the per-slice loop of E31, E92 and BS4).

1. **One full run per slice.** The full `node scripts/run-tests.mjs acceptance --slice N` and `npm run test:unit` run once per slice: the driver's run, from a clean scratch copy of the Builder's final commit, before the merge. It remains the gate; nothing merges without it passing.
2. **The Builder runs less.** From slice 24 the Builder runs its own slice's files, every earlier acceptance file its change or the Verifier's straddle touches, and the unit tests, one at a time, and reports those figures; it no longer runs the full suite. A regression in an untouched earlier file is then found by the driver's run and goes back to the same slice's Builder.
3. **Overlap.** While the driver's full run of slice N goes, slice N+1's fresh Verifier writes its cases and its Builder sends its design; only slice N's merge waits on the run. Slice N+1's cases merge after slice N.
4. **Why:** each slice paid for the full run (about 80 minutes at slice 23, growing with M4) twice. A full run per slice stays because it keeps catching breaks in earlier files that a slice's own files miss (slice 23's change to declaring checks broke M01's through-the-API cases; slices 20 and 21 each broke an older file). Considered and not chosen: a full run every two slices (saves about an hour a pair; a break then lands on a moved main and is harder to trace), and running files in parallel (the runner runs files one at a time on purpose; earlier slices had test races even so).

---

## E124. The first real unit on this workstation: go-ahead given (decided by Sean, 2026-10-10)

**Status: decided by Sean** (BS4 §3 item 13, §16 question 3, option (a)).

1. **Go-ahead given in advance.** The driver starts slice 24's first sandbox run that creates a real `local_service` unit once slice 24 is built, and shows Sean that run's before-and-after unit lists; every later run proceeds under BS4 §4.1 without asking.
2. **Unchanged:** §4.1's rules (unit names derived from the test's own home, stopped only by exact name; the user manager never stopped, restarted, reloaded, re-executed or reloaded by daemon-reload; no Docker, no system manager; nothing on `mini-hp01`), E64, and the runner's before-and-after check, which fails a run that leaves a `surety-*` unit. The first run is the driver's, not an agent's; until it has passed, no agent runs a sandbox file that creates a unit.

---

## E125. M4 slice 23 merged: the deployment journey on the scripted adapter (recorded by the driver, 2026-10-10)

**Status: recorded by the driver under Sean's delegation** (BS4 §14; E121; E123).

1. **Merged** `build/m4-s23` (`3450b4e`; the Builder's head `b2480c2`) after the Verifier's cases (`16e9251`, rows M301 to M306, J3 and J4 straddles through `alphaTarget`, SEAM §§244 to 254). **The driver's gate** on `b2480c2` from a clean scratch copy: `npm run test:unit` 61/61 files; `node scripts/run-tests.mjs acceptance --slice 23` 1,319/1,319 tests, 224 files, nothing skipped, no unit left (the runner's rule-7 check); one leftover file `/tmp/surety-static-*` reported.
2. **Built:** migration 0017 (configurations, artifacts and mappings, adapter qualifications, attempt intents, the deploy journal, verification rounds and rows); `src/deploy/` (bounded adapter calls, the keyed configuration identity, the artifact projection and seal, the reconcile mapping, the Release Operator on the tick); J4's three reasons at `alpha_authorize`; `alpha_complete` evaluated; J3's caller-binding route removed (404); the scripted adapter and two fixtures for the harness. Outside harness mode every deploy effect is `not_issued` and every read `unavailable` until slice 24's adapter. §4.1 audit list: one removal site (the artifact's own `.staging-<16 hex>`, after a real-path check); no `systemctl`, `systemd-run`, signal, cgroup write or mount.
3. **The driver's design answers, provisional** (given to the Builder before it built): a minimal artifact is sealed on disk in slice 23; `PUT …/config` creates the environment by name; a repeated request reuses the `proposed` row, coalesces while an operation is non-terminal and gets a new generation after it ends; deployment secret references are `deploy/<name>`, and an unheld one is `config_invalid`; the prefix is fixed at environment creation; admission in the kernel lane is a scripted seam answer; `alpha_complete`'s scope is the post-deploy obligations only; the journal is sibling `deploy_journal_*` tables.
4. **The Builder's two production deviations, both judged sound by the Reviewer:** declaring checks that list only `alpha_complete` stales only the `alpha_authorize` and `alpha_complete` evaluations; an issuance also supersedes a consumed authorization whose operation has made no attempt (the attempt, its intent and the precondition recheck are one transaction).
5. **Objection 033** (the prefix in the frozen intent): the driver ruled the design governs (D4 §4.1, "the environment's identity and prefix"); M301 (c) changed to forbid unit names and require `prefix`; SEAM §250 stands; the engine stores the prefix (`66f952f`).
6. **The review** (one fresh Reviewer) found four serious defects, each given one case (`3b4fa61`, SEAM §255) and one fix:
   - S1: a service surviving an engine restart was verified and the candidate reached `alpha_deployed`. Now supervision is `attached` only under the incarnation that granted the launch, otherwise `unknown`; the round's `missing` names `supervision`, the outcome is `verification_unknown`, `last_verified` is not written, and the environment read shows `supervision_unknown` (E110; CD2's `degraded` is written by slice 27's observation job).
   - S2: a granted launch whose unit had gone read `absent` and was retried automatically. Now "launch granted" comes from the grant's own record and the read is `partial`, which raises a blocker.
   - S3: reconcile looked only at units. Now every inventory entry counts (D4-A03): unread or missing state is `unknown`, a unit or resource no intent names is `conflicting`, a teardown leaving a cgroup or socket is `partial`, `absent` needs g's unit and domain gone with no launch granted and each prior at its frozen instance; the scripted target gains `resources` (SEAM §247).
   - S4: backend-namespace references were accepted in `secrets` and `check_secrets`. The driver ruled the design governs (D4 §7.1, deployment namespace; §7.4, none of Sean's real credentials): only `deploy/<name>`; any other reference is 422 `config_invalid`; SEAM §245 changed.
   - Minors fixed: reconcile and retry wait for an effect's call to return (m1); missing inventory fields are unread (m2); admission outside the kernel lane defaults to `held`, never `granted` (m3); projected paths with an empty, `.` or `..` segment or a leading `/` are refused, and every write is checked to land inside staging (m4); triggers freeze the verification row's bindings, the round's environment, `environments.prefix` and `operations.orchestration_deadline_at` (m6); the capability check compares `sealed_path`, `config_version` and `targets` (m7). **m5 deferred to slice 24** (a request seals its artifact before its refusals are decided). The Reviewer judged the §4.1 audit list, B03, B04 and secret handling sound.
   - A race found by the Builder's full run: the Release Operator read the artifact's rehash before admission; it now reads admission first and the rehash last (`b2480c2`; M306).
7. **Open, intermittent:** M205 (an M3 sandbox file) failed in 2 of 4 full runs on slice-23 code, each time its setup waiting 60 s for six checks to be recorded, while it passes alone (about 49 s, as in every full run before slice 23) and passed in the gate. The Builder found no cause in slice 23's code (nothing on the check runner's path changed) and could not reproduce it; the gate run recorded free memory every 10 s and it never fell below 12.9 GiB. If it recurs, the driver reruns M205 with `SURETY_KEEP_TMP=1` and has its store read before anything else.
8. **Deferred cases** (must be added by later Verifiers): M305 (d) to slice 25; M306's lost sign-off to slice 25 or 28; M306's out-of-band observation and lease lost to slice 27; M306's unit of unknown ownership to slice 26.
