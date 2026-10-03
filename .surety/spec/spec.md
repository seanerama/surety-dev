# Surety

**Spec version:** 1
**Status:** draft
**Tier:** T2
**Owner:** Sean Mahoney

*Drafted 2026-10-03 by Sean's assistant from the project spec template (`docs/spec/templates/project-spec-template.md`), the foundations, the errata E1 to E48 and the build plan, as the first use of the template. Everything M1 delivered is written as a requirement with the acceptance rows that established it; M2 is written in full; later phases are written at the level the plan page has them, with their criteria marked as open where no design exists. Sean approves or corrects it; until then nothing here binds.*

## 1. Purpose

Surety is an evidence-gated delivery engine for AI coding agents. A person who uses coding agents to build software cannot read every line they produce; Surety lets that person trust what is delivered without doing so. It plans work from an approved specification, runs agents in roles that check one another, performs every git operation itself, lets a candidate pass a gate only on recorded evidence that its required checks ran and passed, and puts every decision that is a person's to make in front of that person with a preview of what each answer will do. Its first user is its owner, building his own projects, including Surety itself.

## 2. Non-goals

- Surety does not write code, plan or review by itself; it drives agents that do and judges only what it can verify.
- It does not replace the owner's judgement: every mandatory-floor decision (foundations section 5) stays a person's.
- It is not a hosted service; it runs on the owner's machine against local git, graduating to GitHub only at Beta.
- It does not accept a role's word for anything a check can establish, and it never shows an unknown as success.
- It does not deploy, publish or manage anything before the phase that designs it (sections 4, R18 onward).
- It is not a general agent framework, a chat interface to a model, or an IDE plugin.

## 3. Users and situations

**The owner.** One person who owns a software project and uses AI coding agents to build it. Situations: starting a project from an idea; deciding what the next phase delivers; being asked to decide something only a person can (a widening of what the engine may do, a finding's disposition, a go-live); checking what a gate decided and why; stopping work that is going wrong; recovering after a crash, a sleep or a power cut; looking at what was spent.

**The agents.** Headless coding agents (first Claude Code, then Codex CLI) launched by the engine in one of its roles: Architect, Builder, Verifier, Reviewer, later Mechanic. They never use Surety; Surety uses them. Situations: being given a scoped context package and a workspace; producing a structured result; being stopped; being metered.

**A later developer or team.** Someone other than the owner who installs a published build on a clean machine from the published instructions (phase 7). Not a user before that phase.

## 4. Requirements

### R1. A gate passes only on recorded evidence

**Statement.** A candidate satisfies a stage gate or an Alpha-authorization gate only when every check its validation scope requires has a recorded execution, performed by the engine's runner, with exit status zero, bound to that candidate's revision and the protected-check version in force. Nothing a role reports, no approval by a person and no budget event turns a check into passed.

**Rationale.** This is the product. Everything else serves it.

**Sensitive areas:** none

**Acceptance criteria**

- **R1.1** Given a candidate whose required check has no recorded execution, when its gate is evaluated, then the gate is not satisfied and its reasons name the check (plan rows M35 to M39).
- **R1.2** Given a recorded execution under an older protected-check version, when the gate is evaluated under the current version, then that execution does not count (M37, M41).
- **R1.3** Given a gate input the engine cannot read (repository, record), when the gate is evaluated, then it is not satisfied (errata E41 item 2).
- **R1.4** Given a finding of blocking severity on a candidate, when its gate is evaluated, then the gate is blocked until the finding is resolved, excluded by the human owner, or its candidate succeeded by one whose evidence resolves it (M42, M44, E43).

*Delivered by M1 (errata E45), re-verified by every later candidate.*

### R2. The engine performs every git operation

**Statement.** Roles never commit to, merge into or move the integration branch. The engine snapshots a role's workspace, validates the diff against the protected set and the role's permissions, commits it under its own identity with trailers naming the run, integrates it by compare-and-swap, and nominates candidates with references of its own. A change made to the repository behind the engine's back is detected and put to a person before any gate proceeds.

**Rationale.** A gate that could be bypassed by a role writing to git directly would be theatre.

**Sensitive areas:** none

**Acceptance criteria**

- **R2.1** Given a role's workspace with changes, when the run ends, then exactly the validated snapshot tree is committed and the integration branch moves only by compare-and-swap (M19 to M28).
- **R2.2** Given an edit to a protected path in a role's result, when the result is validated, then it is rejected unless it arrived through the protected-check workflow (M28, M35).
- **R2.3** Given a moved or deleted candidate marker or integration branch, when the engine observes it, then the project's gates are blocked until a person resolves the observation (M24, M40).
- **R2.4** Given engine git running against a repository whose configuration names hooks, filters, monitors or remotes, when the engine runs git, then none of those programs runs and no remote is contacted (E25 item 3, E27 item 4, E29 item 1, E37 item 1).
- **R2.5** Given a crash at any point of a git operation, when the engine restarts, then the journal reconciles the operation to done, undone or ambiguous-with-a-decision, never silently repeated (M29 to M34).

*Delivered by M1.*

### R3. Runs are interruptible and recoverable, and unknown stays unknown

**Statement.** Every run is leased, supervised and ended by a protocol that establishes its processes are gone before it is called ended. Stop, Abandon and Resume are explicit. After a kill or a power cut the engine restarts into a state where every run, workspace, journal entry and operation is either terminal or visibly unresolved. A result the engine cannot establish is recorded as unknown, which blocks, and never as clean, empty or success.

**Rationale.** Agents leave processes behind and machines sleep, crash and lose power; the record must still be true afterwards.

**Sensitive areas:** none

**Acceptance criteria**

- **R3.1** Given a run whose role left a process alive, when the run ends, then it is not reported ended until that process is observed gone; if that cannot be established the run is quarantined (M13, M16 to M18).
- **R3.2** Given the engine killed at any point of a run, when it restarts, then every non-ended run is recovered, every lease released or converted to a quarantine reservation, and no duplicate external effect occurs (M18, M30, M67).
- **R3.3** Given writes the disk had not synced when power was lost, when the engine restarts, then it starts, and what it reports as durable is durable (M67, E32 item 1 for what the simulation models).
- **R3.4** Given each way a run can end and a store transaction on that path failing once, when the end is retried, then the durable facts equal those of the same ending with no failure (E28 item 1, M15).

*Delivered by M1.*

### R4. A person's decisions are previewed, answered once, and refused when stale

**Statement.** Every question the engine puts to a person shows what each answer will do. An answer is consumed at most once. If any fact the preview rested on has changed, the answer is refused as out of date and the person sees the fresh preview. The answer "reject" leaves things as they were and closes the question.

**Rationale.** The owner approves what they were shown, never something else.

**Sensitive areas:** authorization

**Acceptance criteria**

- **R4.1** Given an open decision, when it is answered twice, then the second answer is refused as consumed (M45 to M55, M56).
- **R4.2** Given a decision whose preview dependency changed, when it is answered, then the answer is refused as stale, for every fact each kind depends on (M45 to M55; the untested facts are M2 slice 1, section R8).
- **R4.3** Given a decision of a kind that offers "reject", when "reject" is answered, then nothing of the proposed change is applied, the question is closed with the answer recorded, and the same question is not raised again at once (R8.4).
- **R4.4** Given a policy change that widens what the engine may do unasked, when it is made, then it takes effect only after the owner answers the decision it raises (M07, M49).

*R4.1, R4.2 part, R4.4 delivered by M1; R4.2 rest and R4.3 by M2 slice 1.*

### R5. Usage is metered once per invocation and budgets stop work

**Statement.** Every invocation has a receipt and a ledger row, with usage as the provider reports it or an explicit unknown; nothing is estimated as zero. A run or a project whose budget is exhausted stops at the enforceable boundary and waits for a person; resolving it never overrides a required check.

**Rationale.** Real runs cost money; the record of what was spent must be as trustworthy as the record of what was built.

**Sensitive areas:** payments and financial data

**Acceptance criteria**

- **R5.1** Given an invocation, when it ends by any path, then exactly one ledger row exists for it with usage or an explicit unknown (M59 to M62).
- **R5.2** Given a usage observation the store cannot record, when retries are exhausted, then the run is stopped and its usage marked incomplete (E37 item 3; the test is M2 bucket B).
- **R5.3** Given a budget limit reached, when the next check runs, then dispatch for the project pauses with a blocker and no completed paid work is replayed (M12, M61).

*Delivered by M1 except R5.2's test.*

### R6. Records are redacted before they exist, secrets never stored, backups complete or refused

**Statement.** Role output is redacted of every held secret, in raw and encoded forms, before it reaches disk or the API. Secret values exist only inside the engine's resolver between resolution and child start. A backup is complete, with its repositories' commits present, or it says it is not.

**Rationale.** A delivery engine that leaked credentials or restored a false backup would be worse than none.

**Sensitive areas:** secrets and credential handling

**Acceptance criteria**

- **R6.1** Given a role output containing a held secret, raw or JSON-escaped, when the transcript is written and served, then neither form appears (M63, E37 item 2).
- **R6.2** Given the store, records, events, responses, backups and logs, when searched for a secret value, then only references are found (M64, D1 section 17 item 5).
- **R6.3** Given a backup taken while git is busy or a commit is missing, when it completes, then its completeness label is false and restore refuses (M66, E42).

*Delivered by M1.*

### R7. The local API is reachable only by the operator

**Statement.** The engine listens on loopback only, checks the Host and origin of every request, requires its token on every mutation, and lets a fresh browser obtain the token only with positive same-origin evidence. Hostile requests are refused before they reach anything.

**Rationale.** The control plane is the thing a role must never reach (R9).

**Sensitive areas:** authentication

**Acceptance criteria**

- **R7.1** Given a request with a wrong Host, Origin or token, when it arrives, then it is refused before routing and the refusal is audited (M68, M69).
- **R7.2** Given a fresh Chromium or Firefox session, when it opens the UI origin, then it obtains the token through the bootstrap route and no other origin can (M68).
- **R7.3** Given any local process that can reach the loopback port, when it calls the bootstrap route with forged headers, then it cannot obtain the token (open: E44 item 1 accepted the exposure for M1; closed by R9.4).

*R7.1, R7.2 delivered by M1; R7.3 is M2's.*

### R8. Hardening before a real agent

**Statement.** The five behaviours M1 left untested that could let tampered or unverified work through a gate, or defeat a person's decision, are established before any real agent runs (triage bucket A, errata E48 item 1; brief `docs/spec/M2-slice-1-hardening.md`).

**Rationale.** A real agent produces real commits; these are the gaps a real commit could fall through.

**Sensitive areas:** none

**Acceptance criteria**

- **R8.1** Given a candidate whose nomination marker was moved or deleted out of band and not resolved, when its gate is evaluated, then it is blocked (M24).
- **R8.2** Given a Builder's result replayed onto a moved integration branch after a path became protected, when it is validated, then the edit to that path is rejected (M28).
- **R8.3** Given a protected-check correction or a policy widening whose proposal content, approved specification or governed field changed after the preview, when answered, then the answer is refused as stale (M45 to M55).
- **R8.4** Given each of the seven decision kinds offering "reject", when rejected, then the thing is as it was, nothing is applied, and the decision is closed (M49 to M55).
- **R8.5** Given a check result recorded for an earlier candidate and a protected application between, when a later candidate's gate is evaluated, then the result is not reused (M41).

### R9. A real agent runs only in qualified isolation

**Statement.** A role process cannot read or modify the engine's control plane (the engine home, the store, the token file, records, other workspaces, the developer's checkout) and cannot reach the engine's API, including the bootstrap route, while it can reach its provider. A backend, version or mode without qualified isolation on the host is refused for every run. The design is D2 (`docs/design/sdlc-design-D2-brief.md`).

**Rationale.** D1 section 17 item 12 and Astra's first priority for M2 (E46).

**Sensitive areas:** secrets and credential handling; authorization

**Acceptance criteria**

- **R9.1** Given a role process launched by the engine on a qualified host, when it attempts to read the engine home, the store, the token file, a record, another workspace or the developer's checkout, then each read fails and the attempt is observable.
- **R9.2** Given the same process, when it attempts to connect to the engine's loopback port, then the connection is refused or unreachable, and the bootstrap route cannot be reached with any headers (closes R7.3).
- **R9.3** Given a host where the isolation mechanism is absent or unqualified, when any run is dispatched, then it is refused with `isolation_unqualified` and no process starts.
- **R9.4** Given a secret the role must hold, when the run ends, then the secret appears in no transcript, record or provider-native file the engine retains.

### R10. Termination is established by an execution boundary

**Statement.** The engine places every role process in a boundary whose membership cannot be escaped and whose emptiness is observable, including after the engine restarts. A run is ended only when the boundary is observed empty; "unknown" quarantines. A healthy run whose lease expired because the engine was paused is continued if its process is still alive and supervised (E36 item 6).

**Rationale.** M1 established this on a scripted stand-in; D1 corrections (build spec section 4 item 1) require the real thing.

**Sensitive areas:** none

**Acceptance criteria**

- **R10.1** Given a role that starts a daemon, double-forks, changes its process group or re-executes with a clean environment, when the run is ended, then every such process is terminated and the boundary is observed empty before the run is called ended.
- **R10.2** Given the engine killed while a role's processes live, when it restarts, then it finds the boundary non-empty, terminates it, and only then recovers the run; if it cannot observe the boundary the run is quarantined.
- **R10.3** Given a pause longer than the lease lifetime with the role's process alive and supervised by the same engine, when the engine resumes, then the lease is renewed and the run continues; with the process gone, the run is recovered (E36 item 6).

### R11. Backends are qualified by a trust table with recorded evidence

**Statement.** The engine records, per backend, version and mode, what qualifies it: the isolation and boundary mechanism, the budget boundaries it can enforce, whether sessions are qualified, where its provider-native files are and how they are contained, and the evidence for each. Everything without an entry is refused.

**Rationale.** D1 section 17 item 11; Verity's record of a backend ignoring its settings while stub tests stayed green.

**Sensitive areas:** none

**Acceptance criteria**

- **R11.1** Given a backend, version or mode with no trust entry, when a run is dispatched to it, then it is refused with `backend_refused` before any process starts.
- **R11.2** Given a trust entry, when read, then every field names the evidence behind it, and a field with no evidence is "not established", never a default.
- **R11.3** Given a policy requiring a budget boundary the entry says the backend cannot enforce, when the policy is applied, then it is refused rather than approximated (D1 section 13.3).

### R12. One real backend builds one small project through Surety

**Statement.** Claude Code in one-shot mode, qualified under R9 to R11, takes one small project from an approved spec through plan, build, verification, review, the stage gate and an issued Alpha authorization, with the engine making every commit and the ledger showing provider-reported usage. This is M2's end (E46, E48).

**Rationale.** One backend on one small project before expanding capabilities (Astra's fourth priority).

**Sensitive areas:** payments and financial data

**Acceptance criteria**

- **R12.1** Given the small project and its spec, when the journey of plan row M01 is run with the real backend in place of the scripted adapter, then it completes both paths (the clean path and the finding-fix path) with every gate satisfied on recorded evidence.
- **R12.2** Given the completed journey, when the integration branch's history is read, then every commit is the engine's, with run and role trailers, and none is the agent's.
- **R12.3** Given the completed journey, when the ledger is read, then each invocation's usage equals what the provider reported for it, or is an explicit unknown with the reason.
- **R12.4** Given a Stop during a real run, when it is confirmed, then the real process is observed gone before the run is reported ended.

### R13. A person can see why work is blocked and what a gate decided

**Statement.** Through the API a person can read a project's one-line status with the real cause of a refusal, its work items with each blocker's reason and the decision it waits on, a candidate's latest gate evaluation with its reasons, its pending git operations, and one decision by its identifier.

**Rationale.** Astra's third priority: the status line must point at the real problem.

**Sensitive areas:** none

**Acceptance criteria**

- **R13.1** Given a blocked work item, when the work read is called, then it shows the blocker's reason and the decision it waits on (delivered, E47).
- **R13.2** Given a candidate with an evaluation, when the gate read is called, then it returns the outcome, reasons naming their subjects, each required check's state and whether it is stale, without evaluating anything (delivered, E47).
- **R13.3** Given an unreadable repository, an unresolved out-of-band change or a store failure, when the status read is called, then the status line says "refused" with that cause, and "unknown" when it cannot be computed (M70; M2 bucket B).
- **R13.4** Given pending or blocked git operations, when the operations read is called, then each is listed with its state (M2 bucket B).

### R14. Only the human owner approves an Alpha exception for a High finding

**Statement.** A Reviewer may propose that a High finding not block Alpha; only the owner approves or rejects it, through the finding-disposition decision. No role records the exception alone.

**Rationale.** E36 item 5; a real Reviewer agent inherits no power to waive a finding.

**Sensitive areas:** authorization

**Acceptance criteria**

- **R14.1** Given a Reviewer's proposed exception, when no owner answer exists, then the finding still blocks Alpha.
- **R14.2** Given the owner's "approve", when the gate is evaluated, then the exception applies to that candidate and its recorded ancestry only; "reject" leaves the finding blocking.

### R15. A second backend and sessions

**Statement.** Codex CLI is qualified through the same adapter contract and trust table, and interactive sessions (open, turns, save, close, idle timeout) run with the engine saving work only between turns; an interrupted session resumes as a new run with reconstructed context.

**Rationale.** Plan phase 3 (M3); D1 section 15.2.

**Sensitive areas:** payments and financial data

**Acceptance criteria**

- **R15.1** Given Codex CLI with a trust entry, when the M01 journey runs on it, then it completes as in R12.1.
- **R15.2** Given a session, when the engine is killed mid-turn, then on restart the session's last saved state is what the engine reports and the turn is not replayed.
- **R15.3** *Open: the remaining criteria wait on D2's session and quiescence qualification (open question 3).*

### R16. The interface

**Statement.** The eight accepted screens (projects, overview, attention queue, build, gate detail, environments, managed, settings) are built as plain HTML and JavaScript against the engine's API, showing unknown as unknown, never as blank or healthy.

**Rationale.** Plan phase 4; the accepted mockup in `docs/mockup/`.

**Sensitive areas:** authentication

**Acceptance criteria**

- **R16.1** Given a running engine, when each screen is opened, then it shows that engine's real data and the one-word state of each project matches the API's.
- **R16.2** Given a real decision in the attention queue, when answered from the screen, then its stated consequence happens.
- **R16.3** Given a drift between the interface and the published API contract, when the joint tests run, then they fail.

### R17. A real deployment to Alpha

**Statement.** A candidate is carried to a real target by a deployment adapter and the engine verifies what is actually running there by identity and behaviour; an environment shows three separate facts: last verified, last attempted, observed now.

**Rationale.** Plan phase 5 (M4); Surety's own first phase is not complete until something is Alpha Deployed (foundations section 3).

**Sensitive areas:** irreversible external actions

**Acceptance criteria**

- **R17.1** Given an issued Alpha authorization, when the deployment completes, then the completion gate passes only on a verification bound to that attempt.
- **R17.2** Given the deployment broken by hand, when the environment is observed, then it reports degraded or unknown, never healthy.
- **R17.3** *Open: the remaining criteria wait on the deployment adapter design (open question 5).*

### R18. Surety builds Surety

**Statement.** The engine adopts its own repository and further development of Surety runs through it, from the attention queue to a verified deployment.

**Rationale.** Plan phase 6; errata E6.

**Sensitive areas:** none

**Acceptance criteria**

- **R18.1** Given the adoption baseline recorded, when one real change to Surety is taken through Surety, then it reaches a verified deployment with every gate on recorded evidence.
- **R18.2** *Open: the adoption mode and what "deployed" means for Surety (open question 6).*

### R19. Beta: export and publication

**Statement.** A delivery repository is created from an allowlisted export, a build is published, and the published build is installed and verified on a machine other than where it was developed, from the published instructions alone.

**Rationale.** Plan phase 7; foundations deferred trace F04.

**Sensitive areas:** irreversible external actions; secrets and credential handling

**Acceptance criteria**

- **R19.1** Given the first public publication, when attempted, then it waits for the owner's approval of the exact export and destination, and any later widening waits again.
- **R19.2** Given publication succeeded and deployment failed, when the record is read, then it shows two separate facts.
- **R19.3** *Open: criteria for the clean-machine install (open question 7).*

### R20. Live, and managed

**Statement.** A release goes live only with a recorded recovery plan and the owner's approval of one exact authorization; management, if turned on, turns telemetry and reports into evidence-backed issues without a user's raw words reaching an agent's prompt.

**Rationale.** Plan phase 8; mandatory floor items.

**Sensitive areas:** personal data; irreversible external actions

**Acceptance criteria**

- **R20.1** Given no recovery plan on record, when go-live is requested, then it is refused.
- **R20.2** Given a rough user report, when it becomes an issue, then the raw report is stored as a record that never enters a prompt (E5).
- **R20.3** *Open: the Mechanic has no design (open question 8).*

## 5. Requirement index

| Key | Title | Phase | Sensitive areas | Criteria |
|---|---|---|---|---|
| R1 | A gate passes only on recorded evidence | 1 | none | R1.1, R1.2, R1.3, R1.4 |
| R2 | The engine performs every git operation | 1 | none | R2.1, R2.2, R2.3, R2.4, R2.5 |
| R3 | Runs are interruptible and recoverable; unknown stays unknown | 1 | none | R3.1, R3.2, R3.3, R3.4 |
| R4 | Decisions previewed, answered once, refused when stale | 1, 2 | authorization | R4.1, R4.2, R4.3, R4.4 |
| R5 | Usage metered once per invocation; budgets stop work | 1 | payments and financial data | R5.1, R5.2, R5.3 |
| R6 | Records redacted, secrets never stored, backups complete or refused | 1 | secrets and credential handling | R6.1, R6.2, R6.3 |
| R7 | The local API reachable only by the operator | 1, 2 | authentication | R7.1, R7.2, R7.3 |
| R8 | Hardening before a real agent | 2 | none | R8.1, R8.2, R8.3, R8.4, R8.5 |
| R9 | A real agent runs only in qualified isolation | 2 | secrets and credential handling, authorization | R9.1, R9.2, R9.3, R9.4 |
| R10 | Termination established by an execution boundary | 2 | none | R10.1, R10.2, R10.3 |
| R11 | Backends qualified by a trust table with evidence | 2 | none | R11.1, R11.2, R11.3 |
| R12 | One real backend builds one small project | 2 | payments and financial data | R12.1, R12.2, R12.3, R12.4 |
| R13 | A person can see why work is blocked and what a gate decided | 2 | none | R13.1, R13.2, R13.3, R13.4 |
| R14 | Only the owner approves an Alpha exception | 2 | authorization | R14.1, R14.2 |
| R15 | A second backend and sessions | 3 | payments and financial data | R15.1, R15.2, R15.3 |
| R16 | The interface | 4 | authentication | R16.1, R16.2, R16.3 |
| R17 | A real deployment to Alpha | 5 | irreversible external actions | R17.1, R17.2, R17.3 |
| R18 | Surety builds Surety | 6 | none | R18.1, R18.2 |
| R19 | Beta: export and publication | 7 | irreversible external actions, secrets and credential handling | R19.1, R19.2, R19.3 |
| R20 | Live, and managed | 8 | personal data, irreversible external actions | R20.1, R20.2, R20.3 |

Phases follow the build plan page: 1 is M1 (accepted), 2 is M2, 3 is M3 (second agent and sessions), 4 the interface, 5 M4 (Alpha), 6 self-hosting, 7 Beta, 8 Live. The order of 4 and 6 to 8 is a proposal.

## 6. Modules and protected paths

| Module | Paths | Sensitive areas |
|---|---|---|
| store and recovery | `packages/engine/src/store/`, `packages/engine/src/recovery/`, `packages/engine/migrations/` | none |
| git and journal | `packages/engine/src/git/`, `packages/engine/src/journal/` | none |
| runs and scheduling | `packages/engine/src/runs/`, `packages/engine/src/scheduler/` | none |
| projects, protected checks and gates | `packages/engine/src/projects/`, `packages/engine/src/protected/`, `packages/engine/src/gates/` | none |
| decisions | `packages/engine/src/decisions/` | authorization |
| invocation and backends | `packages/engine/src/invoke/` | secrets and credential handling |
| records and redaction | `packages/engine/src/records/` | secrets and credential handling |
| API and contract | `packages/engine/src/api/`, `packages/engine/src/contract/`, `packages/engine/api/` | authentication |
| configuration, token and engine core | `packages/engine/src/config/`, the top-level files of `packages/engine/src/` | secrets and credential handling |
| test seam | `packages/engine/src/testing/` | none |
| interface | `packages/ui/` | authentication |
| acceptance | `packages/engine/test/acceptance/` | none |
| documents | `docs/` | none |

*The modules follow the engine's directories as they are on 2026-10-03 (the ledger lives under `runs/` and `store/`); the Architect refines them. `packages/ui/` is a placeholder until phase 4.*

**Protected paths**

- `.surety/checks/`
- `packages/engine/test/acceptance/`
- `scripts/run-tests.mjs`
- `scripts/check-role-boundary.mjs`
- `.surety/spec/`

## 7. Environments

| Environment | Purpose | Verified means |
|---|---|---|
| alpha | The engine built and started on the owner's machine (this WSL2 host) from the integration branch | `npm test` exits zero on the revision and the hands-on walkthrough (`docs/acceptance/reports/M1-hands-on.sh`, or its successor) completes both paths against the started engine |
| beta | A published build installed on a clean machine from the published instructions alone | The install completes from the instructions, the engine starts, and one project runs end to end (R19) |
| live | The published release in use by its owner for real projects | The go-live authorization's identity and behaviour checks pass on the installed release (R20) |

## 8. Constraints

- Node 22 or later; TypeScript compiled by `tsc` only; ES modules.
- `better-sqlite3` is the engine's only runtime dependency, pinned exactly; every development dependency pinned exactly; a new dependency is the owner's decision.
- Local git first; GitHub only from Beta.
- The API binds to loopback only.
- The first host is this WSL2 machine, without administrator rights; a mechanism that needs them is a host requirement the owner sets up, never a silent fallback.
- Roles never share a session; the role boundary is enforced by path and by script, not by trust.
- Scope is frozen per milestone (E40): a new finding is a decision for the owner or a failing test, never a new draft of the design.
- Astra's review budget is for milestones only.

## 9. Interfaces and data

- **Git repositories** of governed projects: the integration branch, candidate references, workspaces (worktrees), the journal of intended operations. Must persist across engine restarts.
- **Backend command lines:** Claude Code (`claude`) and Codex CLI (`codex`), invoked headlessly with a constructed environment; their structured results, transcripts and usage reports; their provider-native session files (D2 decides containment).
- **The SQLite store** in the engine home: runs, work, leases, ledger, decisions, evaluations, records index; WAL, synchronous FULL; backups to a directory the owner names.
- **The local HTTP API** and its event stream, consumed by the interface and by the owner's tools; the published contract (`packages/engine/api/`).
- **Later:** GitHub (Beta), deployment targets (M4), notification channels, telemetry (Live).

## 10. Open questions

| # | Question | Blocks | Owner |
|---|---|---|---|
| 1 | Which isolation mechanism and which execution boundary on the first host (D2 draft 1 proposes; the choice is Sean's) | R9, R10 | Sean |
| 2 | Is this WSL2 host a qualified host or only a development host | R9, R12 | Sean, after D2 |
| 3 | Session and quiescence qualification per backend | R15 | D2 |
| 4 | Which model and backend fills each role for the first real project | R12 | Sean |
| 5 | The deployment adapter design and the first target | R17 | Sean, then architect |
| 6 | Adoption mode, and what Alpha, Beta and Live mean for a tool installed on one machine | R18 | Sean |
| 7 | Package name, licence, visibility of the delivery repository | R19 | Sean |
| 8 | The Mechanic's design | R20 | later |
| 9 | Surety's own tier: T2 is assumed here; T2 requires Beta before Live unless turned off | all | Sean |
| 10 | Whether an estimated cost counts against the verified daily budget (E32 item 4) | R5 | Sean, in D2 |

## 11. Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-10-03 | First draft, from the template; not yet approved | — |
