# Agentic SDLC Framework: Foundations

**Status:** v1.0. Foundation agreed by both architects; Sean's policy decisions recorded.
**Sources:** *Foundations* v0.1 (Claude), *Architect Review Proposal* (second architect), both cross-reviews, the second architect's final positions, her review of v0.2, Sean's decisions on the open policies, and her review of Section 3.10.
**Decision authority:** Sean. This document records what both architects agree on. Sean's decisions on the open policies in Section 11 are separate from that agreement.

**Agreement status:** Both architects accept every section of this document, including Section 3.10 with the second architect's clarifications incorporated. Sean's policy decisions are recorded in Section 11 and applied throughout. Detailed design (Section 10) can now begin.

---

## 1. Background

**Spec-Driven DevOps (SDD)** was fast and good for MVPs. Its core failure was that tests written by the coding agents were the *sole* acceptance evidence, so passing them proved little about whether the code met the requirements. (Builder-written tests are not invalid in themselves; this framework uses them as supporting evidence.) SDD also had no post-deployment maintenance story, and it did not scale to large projects: on projects of 20+ stages, the planner planned every stage up front instead of planning in phases, so plans went stale as the build diverged from them.

**Verity** added independent testing and lifecycle management. It failed because testing had no stopping point, GitHub was mandatory, GitHub Actions on private repos was too expensive, and role boundaries overlapped.

**Goal:** Keep SDD's speed and Verity's assurance. Remove SDD's self-grading and Verity's uniform over-testing. Remove any dependency on paid CI.

---

## 2. Principles

**P1. The Builder cannot determine acceptance alone.**
Protected expectations, separate verification execution, and engine-observed results are mandatory at every risk tier.

**P2. The engine is the only authority on state.**
Agents submit work and evidence. The engine verifies gates, observes execution, and records transitions. Agent claims never satisfy a gate.

**P3. Assurance is mandatory; ceremony scales with risk.**
There is a fixed assurance floor that no tier, policy, or approval can lower. Everything above that floor is configurable workflow and scales with risk.

**P4. Every role is an enforced permission boundary.**
Roles have defined inputs, outputs, and prohibitions. Enforcement is mechanical, not prompt-based.

**P5. Local-first; the framework owns its pipeline.**
Development and testing run on a private local repository with a framework-owned runner. GitHub is a delivery target from first Beta publication onward. GitHub Actions are optional.

**P6. One canonical source of code.**
Production code changes originate in the private development repository. The delivery repository is produced from it by a controlled export.

**P7. Testing stops when required checks pass.**
Expansion requires new evidence of a concrete risk, a recorded reason, and a bounded scope.

**P8. Records never claim more than was observed.**
What was last verified, what was attempted, and what is currently observed are recorded separately. Unknown conditions remain visibly unknown.

---

## 3. State Model

### 3.1 Separate dimensions

The framework represents these independently. Collapsing any two of them produces the bugs found in v0.1.

| Dimension | What it tracks | Example values |
|---|---|---|
| **Project baseline** | The approved idea, spec, and architecture that releases are built against. | Idea, Spec Ready; baseline version numbers |
| **Candidate progress** | How far an identified candidate revision has passed through the lifecycle gates. | Developing, Alpha Deployed, Beta Deployed, Live |
| **Environment records** | For each environment: last verified deployment, any attempted deployment, and the currently observed condition. | Production: last verified v1.3; attempted v1.4 (partial); observed Degraded |
| **Management mode** | Whether a verified Mechanic is active on production, and its health. | Live, Live Managed; management health Healthy / Degraded / Unknown |
| **Execution and health status** | Operational condition of runs, operations, and deployments. | Running, Failed, Blocked, Paused, Degraded, Unknown |

A project can be Live Managed on v1.3 while a new candidate is in Developing. Developing a new candidate never demotes the existing Live release.

### 3.2 Baseline states

| Display name | Meaning | Entry gate |
|---|---|---|
| **Idea** | Problem and intended outcome recorded. | Human creates or accepts the idea. |
| **Spec Ready** | Versioned requirements and acceptance criteria ready for architecture. | Human approves scope and acceptance criteria; blocking questions resolved. |

Later candidates may reuse an approved baseline and start directly in Developing, provided the baseline still covers the change. Otherwise, the baseline is revised first (Section 3.8).

### 3.3 Candidate lifecycle

| Display name | Meaning | Entry gate |
|---|---|---|
| **Developing** | Architecture accepted; implementation underway on this candidate. | Architect supplies ADRs, task plan, and validation scope; architecture approved (human, or automated under an approved prototype policy; see Section 9). |
| **Alpha Deployed** | This candidate passed the Alpha deployment gate. | Required checks pass; blocking findings resolved (Section 6); Release Operator deploys the exact candidate; deployment verified by observation. |
| **Beta Deployed** | This candidate's delivery revision passed the Beta deployment gate. | Alpha feedback resolved or dispositioned; export validated; publication approved (Section 7.5); staging deployment verified by observation. |
| **Live** | This candidate's approved artifact passed the production deployment gate. | Beta acceptance complete; recovery plan recorded; **human go-live approval**; production deployment verified by observation. |

"Beta" names the milestone; "staging" names the environment. Public source visibility and public app availability are separate events.

### 3.4 State scope (resolves former O1)

This defines what the states mean without choosing schemas or enum names.

- **Candidate progress belongs to an identified candidate revision.** "Alpha Deployed" means *that candidate* successfully passed the Alpha deployment gate. It is a fact about the candidate's history, not a claim about what the Alpha environment is running now.
- **Environment records are separate.** Each environment independently records its deployments and their current health (Section 3.6).
- **Source changes create a new candidate.** Changing source produces a new candidate revision starting in Developing. The previous candidate's history and deployed references are preserved.
- **Evidence may be reused only through a documented applicability assessment** (Section 3.8). **Approvals never transfer automatically** between candidates.

### 3.5 Management mode

Live Managed is an operating mode, not a lifecycle state. Management is a human opt-in, not an approval required for each release. **Opting in alone does not establish Live Managed.**

**Activation gate.** Before initial activation, the engine verifies by observation:
- Telemetry access to production.
- Report intake from users and bug reports.
- Issue filing into the development project.
- The Mechanic's scoped permissions (and the absence of any broader ones).
- The escalation route to the human owner.

Only then does the project enter Live Managed. Later monitoring failures change **management health**, not release history. Disabling the Mechanic returns the project to Live.

### 3.6 Environment records

Each environment keeps three things separate:

- **Last verified deployment:** the most recent deployment that passed observed verification. A failed deployment never replaces it.
- **Attempted deployment:** any deployment in progress, failed, or partially applied, with its outcome.
- **Observed condition:** what monitoring currently shows, including Unknown.

The last verified reference must never be read as "currently running." For example, production may have last verified v1.3 while an attempted v1.4 rollout is partially running and unhealthy. The record shows all three facts. When the engine cannot determine the condition, it records Unknown and displays it as Unknown.

### 3.7 Transition and operation rules

- The engine alone records transitions. The UI operates the same engine.
- Every transition records the candidate, spec version, source revision, evidence, and approving actor.
- Approvals and evidence bind to an identified revision.
- Transitions verify the current candidate identity and apply exactly once under a release lock.
- **Deployment states require observed deployment verification.** Passing tests alone never establish Alpha Deployed, Beta Deployed, or Live.
- **External operations are identifiable and safely retryable.** A release lock alone cannot guarantee exactly-once effects in an external system such as GitHub or a cloud provider. Each publication and deployment is an operation with a durable identity recorded before execution. Before any retry, the engine reconciles whether the operation already took effect, so a crash never produces a duplicate publication or deployment.

### 3.8 Backward movement and specification changes

| Trigger | Result |
|---|---|
| Source change at any stage | New candidate revision starts in Developing. The previous candidate's history is preserved. |
| Spec or acceptance-criteria change | Baseline revised via the workflow below; affected work continues as new candidates in Developing. |
| Defect found in Beta or Live | Issue filed in development; fix ships as a new candidate through normal gates. Deployed releases are not demoted. |
| Mechanic report | Issue filed in development (Section 8). Management mode unchanged. |
| Recovery needed in production | Rollback selects a previously approved release and verifies recovery (Section 7.7). |

**Specification change workflow:**
1. A change request is submitted against the current spec version.
2. The Spec Writer produces a proposed diff.
3. The engine runs impact analysis: affected acceptance criteria, checks, ADRs, tasks, and evidence.
4. The human approves or rejects with the impact visible **before** approving.
5. On approval, the spec version increments and affected artifacts and evidence are invalidated.

**Evidence reuse requires a documented applicability assessment.** Per-module analysis is useful, but "unaffected module" alone cannot justify keeping evidence. The assessment considers shared dependencies, interfaces, configuration, and migrations. Each retained piece of evidence carries a recorded reason it still applies.

### 3.9 Pause and resume

Runs can be interrupted by budget exhaustion, a blocker, a crash, or a manual pause. On resume:

1. **New run, linked history.** The resumed work starts a fresh session with a new run identity, linked to the interrupted run.
2. **Context from durable records.** The session's context is reconstructed from engine records, not carried over from the interrupted session.
3. **Fresh capabilities.** The interrupted run's capabilities are revoked or allowed to expire. The new run receives freshly scoped capabilities. Durable secrets stay in protected storage throughout and never pass to an agent as part of resumption.
4. **Candidate identity re-verified.** The source revision must match the one the run was working on.
5. **Approvals and evidence re-checked.** Anything invalidated during the pause is treated as invalid.
6. **Interrupted operations reconciled.** For any publication or deployment in flight, the engine determines whether it already took effect (Section 3.7) before retrying or proceeding.

If any step fails, the run does not resume. The engine records why and returns the work to the appropriate state.

### 3.10 Phased planning

**Problem this solves.** SDD's planner planned all stages of a large project at once. On 20+ stage projects, later stages were planned against assumptions that were no longer true by the time the build reached them.

#### 3.10.1 Two levels of plan

The Architect plans at two levels of detail:

- **Roadmap (coarse, whole project).** Produced initially with the architecture and approved with it. It lists all phases, the goal of each, the modules each touches, dependencies between phases, and which approved requirements each phase is planned to deliver. The roadmap is **versioned**; each revision is recorded.
- **Phase plan (detailed, one phase at a time).** Produced only for the next phase. It breaks that phase into build stages (milestones) with tasks, validation scope, and integration obligations. Default phase size is 3–5 stages, configurable per project. Each phase plan records the **baseline version and source revision** it was prepared against.

#### 3.10.2 Requirements traceability

The approved specification and acceptance criteria always cover the **whole project**. Phasing never narrows them.

- Every approved requirement is traceable to its planned phase and, once verified, to its verification evidence.
- Requirements not yet implemented remain **visibly pending**. They are never treated as satisfied because the current phase passed.
- Moving a requirement between phases is allowed within the approved baseline and is recorded visibly as a roadmap revision.
- Removing or changing a requirement follows the specification change workflow (Section 3.8).

#### 3.10.3 Pre-implementation checks per phase

Section 5.1 applies phase by phase:

- Detailed independent checks for the **upcoming phase** are prepared before that phase's implementation begins, with Section 5.1's controlled exceptions.
- Executable checks for future phases are **not** required up front. Requiring them would recreate the planning problem this section solves.
- Acceptance criteria for future phases already exist in the approved spec; only their executable checks are deferred to the phase that implements them.

#### 3.10.4 Phase verification vs. release acceptance

These are different things, and neither substitutes for the other.

- **Phase verification** runs at each phase boundary. It covers the requirements and integration obligations assigned to that phase, plus regressions in anything the phase affected. Passing it establishes that **the phase is complete**.
- **Phase completion does not establish** acceptance of the whole application or permission to deploy.
- **Deployment gates** (Section 3.3) still require their own defined acceptance scope. A candidate deployed to Alpha mid-project is accepted against the requirements delivered so far, with remaining requirements shown as pending, not failed and not passed.

This prevents phased planning from either demanding the finished application after phase one or quietly treating unfinished requirements as satisfied.

#### 3.10.5 Replanning cycle

At the end of each phase:

1. Phase verification runs (Section 3.10.4).
2. The Architect runs in a fresh session with context built from durable records: the approved baseline, ADRs, current roadmap version, current code, and the phase's findings and evidence. It does not inherit the previous planning session's context.
3. The Architect produces the next phase plan and may propose a roadmap revision.
4. The engine checks the plan mechanically (Section 3.10.6).

#### 3.10.6 What the engine checks

An agent's claim that a plan conforms to the baseline is never sufficient. The engine mechanically checks:

- **References:** every requirement, ADR, module, and interface the plan cites exists in the recorded baseline and source revision.
- **Approvals:** the baseline and architecture versions the plan depends on are approved and current.
- **Dependencies:** the plan's phase and module dependencies are consistent with the roadmap and the current state of earlier phases.
- **Validation obligations:** every requirement assigned to the phase has required checks planned, including sensitivity-floor checks (Section 5.6).

**Approval routing.** A plan that passes these checks and stays within the approved baseline and architecture proceeds without human approval. A plan that changes phase goals, adds or alters ADRs, needs a spec change, or whose conformance is **uncertain** goes through the existing review and approval route (architecture approval policy, or the spec change workflow in Section 3.8).

#### 3.10.7 Early replanning

The Architect replans before the phase ends when:

- A spec change is approved that affects the current or later phases.
- A blocker (Section 5.8) shows the current plan is unworkable.
- An objection that the plan, not a check, is wrong has been **assessed and upheld**. Filing an objection alone does not trigger replanning, so repeated objections cannot keep restarting planning.
- A cross-module effect is discovered that the current plan does not account for.

Every early replan records the triggering evidence and which tasks, assumptions, and checks became stale.

#### 3.10.8 Context scoping

**Initial context is scoped to** what the run needs: the relevant approved requirements, ADRs, project-wide constraints, the current phase plan, and the interfaces of dependency modules.

Runs are **not restricted to** that package. Builder and Verifier runs may request additional context and inspect affected dependencies through their permitted tools. The scoped package reduces irrelevant material; it must never hide cross-module effects. Discovered effects feed into the existing impact analysis (Section 3.8) and early replanning (Section 3.10.7) rules.

---

## 4. Roles

### 4.1 Role contracts

| Role | Input → Output | May | May not |
|---|---|---|---|
| **Human owner** | Approves spec, architecture (unless automated by policy), first publication, go-live; opts in to management. | Decide scope; accept documented **nonblocking** risks; approve check corrections; authorize deferrals per project policy. | Bypass required checks or accept blocking findings by approval. |
| **Vision assistant** | Conversation → idea record | Collaborate with the human on the idea. | Write spec, architecture, code, or checks. |
| **Spec Writer** | Idea, change requests → versioned spec with acceptance criteria; proposed diffs | Propose spec content and revisions. | Approve its own spec; write architecture, code, or checks. |
| **Architect** | Approved spec → ADRs, architecture, diagrams, module map, phase roadmap, detailed phase plans, proposed validation scope | Define module boundaries; propose baseline changes; replan at phase boundaries. | Approve its own proposals; change an approved requirement silently; write code or acceptance checks. |
| **Builder** | Approved plan → implementation, developer tests, explanation of changes | Write in the development worktree; write, run, and configure developer tests; file objections to acceptance checks. | Edit, skip, or disable acceptance checks; alter the protected acceptance execution path; change gate policy; approve its own work; publish; deploy. |
| **Verifier** | Approved requirements + fixed candidate → acceptance checks, verification results, findings, gate verdict | Author acceptance checks (the Test Author responsibility); propose check corrections; inspect code read-only. | Modify application source; approve its own check corrections; repair the app; deploy. |
| **Reviewer** | Candidate, ADRs, checks, tests → review findings | Assess code quality, architecture conformance, and test adequacy; approve check corrections against the spec. | Modify any reviewed artifact. |
| **Release Operator** | Approved candidate + satisfied gates → export, release mapping, publication, deployment, recovery records | Execute authorized publication and deployment operations through scoped capabilities. | Waive checks; alter code; supply its own independent verdict. |
| **Mechanic** | Production telemetry, user reports → evidence-backed issues in development | Read telemetry; create and update development issues. | Change code, infrastructure, or release state. |
| **Framework engine** | Artifacts, evidence, approvals, policy → recorded decisions and authorized actions | Enforce permissions, gates, budgets, transitions, and operation identity. | Accept agent statements as execution evidence. |

The Builder writes developer tests. The Builder never writes, edits, or controls acceptance checks or their execution path.

### 4.2 Role rules

- **One run holds one role.** Changing role requires a new run with that role's permissions.
- **Responsibilities, not permanent agents.** Test authoring and review are distinct responsibilities. They need not be permanently running agents or mandatory sessions for every small task. Verification may cover a coherent batch of changes or a whole candidate.
- **Self-review requires a fresh session.** When a role reviews an artifact it authored, the review runs in a fresh session with the appropriate restrictions.
- **Least privilege.** The engine grants only the capabilities the current task and environment need.
- **Objection, not workaround.** A role that believes an artifact it cannot write is wrong files an objection to the owning role.
- **Accountability.** Specialists may support a role, but the named role remains accountable for its handoff.

---

## 5. Testing

### 5.1 Independence rule

> Acceptance criteria and the initial independent checks are established before implementation by default. Exceptions require a recorded reason, an independent review, and visibility at the gate.

Additional checks may be introduced when interfaces become executable or new evidence reveals missing cases. New checks are added through the protected update process (Section 5.3).

On phased projects, this rule applies to each upcoming phase rather than to the whole project at once (Section 3.10.3).

### 5.2 Protected acceptance execution path

Two paths are kept distinct:

- **Protected acceptance execution path:** acceptance check files and expectations, their commands, discovery rules, runner configuration, and result collection. The Builder cannot alter any of it.
- **Builder-owned developer-test configuration:** developer tests and their own configuration. The Builder maintains these freely. Changes here never touch the protected path and never trigger a protected-path block.

The engine records a **protected version** (a fingerprint of the protected path) and verifies it before every gate. Any change not made through Section 5.3 blocks the gate.

### 5.3 Updating protected checks

Legitimate corrections and newly authorized checks change the protected version. They follow one process:

1. **Trigger.** The Builder files an objection to a check, or new evidence shows a missing case. An objected check stays in force; the Builder cannot change or skip it.
2. **Proposal.** The Verifier drafts the correction or addition in a fresh session.
3. **Approval.** The **Reviewer or the human owner** approves the diff against the approved spec. The reason must be grounded in that spec. The Verifier cannot approve its own proposal.
4. **Record.** The engine records a new protected version.
5. **Invalidate and rerun.** Affected evidence is invalidated and verification reruns.

If the objection shows the **requirement** is wrong, not the check, it becomes a spec change (Section 3.8) and needs human approval of the spec revision. Unresolved disagreement becomes a visible blocker for human review (Section 5.8). Unauthorized changes to the protected path still block the gate.

### 5.4 Developer tests

Builder-owned developer tests may contribute evidence and may be required to pass. They never substitute for independent acceptance checks.

### 5.5 Model diversity

Using different models for the Builder and Verifier is a configurable recommendation. It is not the independence mechanism and not a prerequisite. Separate runs, permissions, and engine-observed evidence establish independence even when the same model is used.

### 5.6 Validation scope

Scope comes from two sources:

- **Risk tier** (project default, module overrides) sets the default scope.
- **Change-specific scope** adjusts it. Defaults may be inferred and recorded automatically, then expanded for identified risks.

**Sensitivity floor.** A tier label never downgrades sensitive behavior below its required floor. A prototype that touches a sensitive area gets that area's required checks regardless of tier.

**Sensitive areas (decided, O1):**
- Authentication
- Authorization
- Payments and financial data
- Personal data
- Secrets and credential handling
- Data migrations and destructive data operations
- Irreversible external actions, such as sending emails or messages on a user's behalf

**Verification cadence (decided, O7).** Verification runs at least once per candidate before any deployment gate, at every tier. For T2 and T3, it also runs at the end of each build stage (milestone) in the phase plan. T1 may verify once at candidate level. Every tier runs phase verification at each phase boundary before replanning (Section 3.10.4). Phase verification establishes phase completion only; deployment gates keep their own acceptance scope.

### 5.7 Risk tiers

| Tier | Typical use | Required checks | Stops when |
|---|---|---|---|
| **T1 Prototype** | MVPs, demos | Acceptance checks; smoke tests; sensitivity-floor checks for any sensitive area touched | All T1 required checks pass; no blocking findings |
| **T2 Standard** | Most apps | T1 + integration tests; security lint; Reviewer sign-off at candidate level | All T2 required checks pass; Reviewer sign-off recorded; no blocking findings |
| **T3 Critical** | Payments, auth, PII, irreversible operations | T2 + property/fuzz tests; security review; failure and recovery checks; per-module Reviewer sign-off | All T3 required checks pass; security review clear; all required sign-offs recorded; no blocking findings |

### 5.8 Stopping, budgets, and blockers

- **Completion:** Work is complete when required checks pass and blocking findings are resolved. Optional testing must answer a stated concern.
- **Expansion:** Requires new evidence of a concrete risk, a recorded reason, and bounded scope.
- **Budgets:** Limits on time, tokens, and repair attempts govern permission to continue. Exhaustion pauses work (Section 3.9). It does not invalidate completed evidence, and it never turns a failed or missing check into a pass.
- **Blockers:** Repeated findings without progress, exhausted budgets, or unresolved disagreement produce a visible blocker for human review.

---

## 6. Findings

### 6.1 Blocking vs. nonblocking

A **blocking finding** prevents promotion and cannot be accepted by approval. A **nonblocking finding** requires a controlled disposition (Section 6.2) before promotion. Requirements tighten as a candidate moves toward the public and never loosen.

**Default severity ladder:**

| Severity | Alpha Deployed | Beta Deployed | Live |
|---|---|---|---|
| **Critical** | Blocking | Blocking | Blocking |
| **High** | Blocking, unless the Alpha exception applies | Blocking | Blocking |
| **Medium** | Nonblocking with disposition | Nonblocking with disposition | Nonblocking with disposition |
| **Low** | Nonblocking with disposition | Nonblocking with disposition | Nonblocking with disposition |

**Alpha exception for High findings.** A High finding may be nonblocking at Alpha only when both conditions hold:
- Its consequences are contained by the test environment.
- The testing purpose for deploying with it is recorded.

The exception never overrides a failed required check or the sensitivity floor. A High finding in a sensitive area stays blocking.

**Always blocking, at every stage:** any failed or missing required check.

**No reclassification workaround.** Changing a finding's severity cannot be used to get around a blocking finding. Reclassification is recorded and follows the assignment rules in Section 6.3.

### 6.2 Controlled disposition

Every nonblocking finding gets one recorded disposition before promotion:

- **Fix:** A planned disposition only. The finding stays open until the fix is **verified**. Planning a fix does not resolve it.
- **Defer:** Requires a linked issue, a target, and an authorized disposition. The Reviewer may defer Low findings; Medium findings require the human owner (decided, O3). A deferred finding is re-evaluated at each later gate and cannot silently age past one.
- **Accept:** Requires the human owner's documented risk decision.

### 6.3 Severity definitions and assignment (decided, O2)

| Severity | Definition |
|---|---|
| **Critical** | Data loss or corruption; security exposure; or the core flow is unusable with no workaround. |
| **High** | A core feature is broken or produces wrong results; or a security weakness exists that has not been exploited. |
| **Medium** | A non-core feature is broken or degraded, and a workaround exists. |
| **Low** | Cosmetic or minor. |

**Assignment is asymmetric:**
- The Verifier, Reviewer, and Mechanic propose severity.
- Any role may raise a finding's severity.
- Lowering a finding out of blocking range for the relevant stage requires the human owner.
- Other downgrades (for example, Medium to Low) may be made by the Reviewer.

This enforces the no-reclassification-workaround rule without adding approvals to the common case.

---

## 7. Repositories and Releases

### 7.1 Structure

- **Development repository:** private, local, canonical. It holds code, checks, spec, ADRs, and all framework records.
- **Delivery repository:** created on GitHub at first Beta publication with fresh history. Later releases add commits to its existing history. Private development history is never merged into it.

### 7.2 Export

1. **Freeze the candidate.** Identify its exact revision, approved spec version, validation results, and human testing disposition.
2. **Export by allowlist** into a fresh private workspace. Include application code, dependencies, public test assets, licenses, and public documentation. Exclude development history, internal PR material, agent instructions, private plans, private acceptance assets, and secrets.
3. **Validate the export.** Scan for excluded or sensitive content. Build and run required acceptance checks against the exported application. Validation covers intended file additions, changes, and deletions.
4. **Publish** per Section 7.5, as an identified operation (Section 3.7). A failed publication leaves the candidate unpromoted.

### 7.3 The allowlist is a governed artifact

The export allowlist is versioned in the development repository, reviewed when changed, and recorded in every promotion record.

### 7.4 Public vs. private test assets

Required checks must validate the exported application. Their files do not necessarily ship. Private acceptance checks run against the export without publishing fixtures or internal operational details. All required validation remains mandatory regardless of which test files are public.

### 7.5 Publication approval

| Publication | Approval |
|---|---|
| **First public source publication** | Human approval at every tier. |
| **Subsequent Beta publications within the approved allowlist** | Configurable approval rules. |
| **Any widening of what becomes public** | Renewed review and explicit human authorization. |

### 7.6 Delivery repository integrity

Unexpected edits in the delivery repository block promotion and trigger reconciliation. They are never silently overwritten. The human either discards them or brings the changes into development, after which normal promotion resumes.

### 7.7 Artifacts, mapping, and recovery

- Beta and Live refer to the approved delivery revision and artifact. Live deploys the same artifact as Beta where possible.
- A rebuild or re-export for Live cannot silently introduce a different candidate. Changed inputs are recorded and affected verification is renewed.
- Each promotion privately links the development revision, delivery commit, artifact, evidence, approvals, and deployment operations.
- Partial failures are recorded as they happen. If publication succeeds and staging fails, the published revision is retained, deployment is retried after reconciliation (Section 3.7), and Beta Deployed is not claimed until staging is verified.
- Go-live requires a recorded recovery plan covering configuration and data migrations. Rollback selects a previously approved release and verifies recovery.

---

## 8. Mechanic

**Activation:** Governed by the activation gate in Section 3.5.

**Permissions:** Read production telemetry and user reports. Create and update issues in the development project. Nothing else.

**Behavior:**
- **Deduplication:** New observations are matched against open issues and appended as evidence rather than filed as duplicates.
- **Triage:** Every issue carries a proposed severity (Section 6.3) and supporting evidence.
- **Filing limits (decided, O4):** Default 10 new routine issues per project per day, configurable. Evidence appended to existing issues does not count toward the cap.
- **Urgent observations** bypass the cap and escalate immediately. Urgent means any of: meets the Critical definition; loss of availability; a sharp error-rate spike; any security signal.
- **Escalation:** Urgent observations notify the human owner through an in-app notification plus one external channel, chosen in project settings. Supported channels: **email** (default), **Webex**, and **custom app** via a generic webhook. The custom-app channel receives a structured payload (project, severity, summary, evidence link, issue link) so any in-house app can consume it.

Fixes follow the normal path: Developing → Alpha Deployed → Beta Deployed → Live.

---

## 9. Autonomy and Ceremony

### 9.1 Mandatory floor (every tier, every autonomy setting)

- Human approval of the project spec.
- The Builder cannot determine acceptance alone: protected expectations, separate verification execution, engine-observed results.
- Protected-check changes only through the approved update process.
- Observed deployment verification for every deployment state.
- Reconciliation of interrupted external operations before retry.
- Human approval of first public source publication, and of any widening of the public allowlist.
- Human approval of every production go-live.
- Recorded recovery plan before go-live.
- Observed verification of the management activation gate.
- No approval, reclassification, or budget outcome converts a failed or missing required check, or a blocking finding, into a pass.

### 9.2 Configurable above the floor

- Architecture approval: human, or automated under an approved prototype policy.
- Subsequent Beta publications within the approved allowlist.
- Validation scope inference and batching of verification.
- Model assignment per role, including model diversity.
- Budgets for time, tokens, and repair attempts.
- Management mode: human opt-in, subject to the activation gate.
- Phase size (default 3–5 build stages).
- Mechanic filing cap and external escalation channel.

Autonomy may schedule and execute eligible work within role contracts. It never removes items on the mandatory floor.

---

## 10. Deferred Work

Execution and permission boundaries come first. These follow afterward:

- **Test runner** and the event stream the Build view consumes.
- **Storage:** durable engine records, operation identities, and secrets storage and injection without passing through agent context.
- **Settings:** per-role model selection, autonomy policy, deployment targets, budgets.
- **Deployment adapters:** a common interface (deploy, status, logs, teardown, verify, reconcile) for local, Tailscale servers, AWS, and Azure. Every adapter must support reconciling whether an operation took effect.
- **UI:** must reflect the separate dimensions in Section 3.1, including last verified, attempted, and observed conditions per environment, with Unknown shown as Unknown. The project screen shows multiple candidates and environments at once.
- **Cost visibility:** spend per stage and per role.

---

## 11. Decision Record

Sean's decisions on the open policies, applied in the sections listed.

| # | Decision | Outcome | Applied in |
|---|---|---|---|
| **O1** | Sensitivity-floor categories | Authentication, authorization, payments and financial data, personal data, secrets and credential handling, data migrations and destructive data operations, irreversible external actions. | 5.6 |
| **O2** | Severity definitions and assignment | Four-level definitions; asymmetric assignment (anyone raises; human owner required to lower out of blocking range). | 6.3 |
| **O3** | Deferral authority | Reviewer may defer Low; Medium requires the human owner. | 6.2 |
| **O4** | Mechanic limits and escalation | 10 routine issues/day default; defined urgency criteria bypass the cap; in-app plus one external channel: email (default), Webex, or custom app via webhook. | 8 |
| **O5** | Meaning of "scale" | Planning scale on 20+ stage projects. Addressed by rolling-wave phased planning, agreed by both architects. | 1, 3.10 |
| **O6** | Module boundary ownership | Architect defines modules and maps features to them; approved with the architecture. | 3.10, 4.1 |
| **O7** | Verification cadence | Once per candidate at every tier; per milestone for T2/T3; at every phase boundary. | 5.6 |

**Nothing remains open in the foundation.** Next is detailed design (Section 10).
