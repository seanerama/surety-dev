# Project specification template

This is the document Surety works from. A person writes it for a new project, or the Spec Writer role produces it from an idea and the person approves it. Once approved it is the **approved baseline** (foundations section 3): every plan, every check and every gate traces back to it, and changing it follows the specification change workflow (foundations section 3.8).

The engine does not read prose. It reads the **identifiers** this template fixes: the project's tier, its requirement keys, the acceptance criteria under each requirement, the sensitive areas each touches, the modules and protected paths, and the environments. Keep those exactly in the shape shown; everything else is for people.

**How it feeds Surety**

| In this document | What the engine makes of it |
|---|---|
| Tier (T1, T2, T3) | The project's default validation scope (foundations section 5.7). |
| Each requirement `R<n>` | One requirement row, keyed `R<n>`, with its text anchored by the heading. Delivery is computed per candidate; a requirement no phase has delivered stays visibly pending. |
| Each acceptance criterion `R<n>.<m>` | The statement one executable check must establish. The Verifier writes that check under `.surety/checks/`, naming the criterion and the requirement it covers; the gate counts the check's recorded execution, never a role's word. |
| Sensitive areas on a requirement | The sensitivity floor (foundations section 5.6): the area's required checks apply whatever the tier. |
| Modules and their paths | The module map the Architect refines; sensitive areas on a module gate triage. |
| Protected paths | Paths only the protected-check workflow may change (foundations section 5.3). |
| Environments | The targets a deployment gate can name. M1 deploys nothing; the names are still fixed here. |
| Phases (roadmap hint) | The Architect's starting point. Moving a requirement between phases is a roadmap revision, not a spec change. |

Copy everything below this line into `.surety/spec/spec.md` of the project and fill it in. Text in *[brackets]* is instruction; delete it. Keep the heading levels and the key formats: `R<n>` for a requirement, `R<n>.<m>` for its acceptance criteria.

---

# [Project name]

**Spec version:** 1 *[integer; a new version for every approved change]*
**Status:** draft | approved *[the engine records who approved it and when]*
**Tier:** T2 *[T1 prototype, T2 standard, T3 critical; see foundations section 5.7. Pick the tier for the project as a whole; sensitive areas raise the floor regardless]*
**Owner:** [name]

## 1. Purpose

*[Two to five sentences. What the product does, for whom, and why it is worth building. Written for someone who has not heard of it.]*

## 2. Non-goals

*[What this project deliberately does not do, so that nobody plans or builds it. One line each.]*

- [Non-goal]

## 3. Users and situations

*[Who uses it and in what situation. One short paragraph per kind of user. Name the situations the requirements below refer to.]*

## 4. Requirements

*[One subsection per requirement. The key `R<n>` never changes once approved; a requirement that is withdrawn keeps its key and is marked withdrawn. Under each: what must be true, written as behaviour someone can observe, then its acceptance criteria, each one a single checkable statement with its own key. Say which sensitive areas it touches, from the fixed list of foundations section 5.6: authentication; authorization; payments and financial data; personal data; secrets and credential handling; data migrations and destructive data operations; irreversible external actions. "None" is a valid value and must be stated.]*

### R1. [Short title]

**Statement.** *[What the product must do. Observable, not a design.]*

**Rationale.** *[Why. One or two sentences.]*

**Sensitive areas:** none

**Acceptance criteria**

- **R1.1** *[Given … when … then …; one check can establish it]*
- **R1.2** *[…]*

### R2. [Short title]

**Statement.**

**Rationale.**

**Sensitive areas:** authentication

**Acceptance criteria**

- **R2.1**
- **R2.2**

## 5. Requirement index

*[One row per requirement. This table is what the engine registers; keep it complete and consistent with section 4. Phase is a hint for the Architect's roadmap. The engine parses it exactly (D3 §4.5): key `R<n>`; sensitive areas from the fixed list, or `none`; criteria `R<n>.<m>`, comma-separated, each of its own requirement's key and none repeated. A row that does not parse refuses the spec's approval and names the row. Each project check names the criteria it covers and each finding the criterion it breaks; a requirement with no criteria is uncertain and cannot be validated. How the Verifier declares checks under `.surety/checks/` is shown in D3 Appendix B.]*

| Key | Title | Phase | Sensitive areas | Criteria |
|---|---|---|---|---|
| R1 | [title] | 1 | none | R1.1, R1.2 |
| R2 | [title] | 1 | authentication | R2.1, R2.2 |

## 6. Modules and protected paths

*[The parts of the codebase as the owner sees them. The Architect may split or rename them in the architecture, which is a separate approved document; what is fixed here is which areas are sensitive and which paths are protected.]*

| Module | Paths | Sensitive areas |
|---|---|---|
| [name] | `src/[area]/` | none |
| [name] | `src/auth/` | authentication, secrets |

**Protected paths** *[changed only through the protected-check workflow; the checks directory is always protected]*

- `.surety/checks/`
- [other path]

## 7. Environments

*[Where candidates are deployed and tested. Name each; say what it is for and what counts as a deployment there being verified (foundations section 3.6). Alpha is the first target a candidate can be authorized for.]*

| Environment | Purpose | Verified means |
|---|---|---|
| alpha | [internal test target] | [the health check and the smoke checks pass against it] |

*[For each environment Surety deploys to (D4; M4), also give:]*

- **Target:** [the adapter and its target, for example `local_service`, target `app`].
- **Runtime and start command:** [for example `node src/server.mjs`; the service is the revision's tracked files as they are, with no build or install step (D4 Q4)].
- **Port:** [the environment variable the service listens on, for example `PORT`; the engine assigns the value].
- **Excluded from the artifact:** [`artifact.exclude`: paths not deployed. It must name any protected root outside `.surety/` (D4 §3.1).]
- **Required post-deploy behaviour check:** [the specified user operation the `post_deploy_behavior` check exercises against the running service, and what counts as success. A health or version endpoint alone is not a behaviour check.]
- **Stable arguments:** the service must not change its process title or command-line arguments while it runs; the engine identifies the running service by them (CD4, E121).

## 8. Constraints

*[Things that bound every design: platforms, languages, data residency, budgets, dates, dependencies that must or must not be used. One line each.]*

- [Constraint]

## 9. Interfaces and data

*[Only what the requirements depend on: external systems, inputs and outputs, data that must persist. Formats belong in the architecture unless a requirement fixes one.]*

## 10. Open questions

*[Each is either a decision for the owner or a question a requirement must answer before it can be planned. A spec with open questions can be approved; the Architect may not plan a requirement whose question is open.]*

| # | Question | Blocks | Owner |
|---|---|---|---|
| 1 | [question] | R2 | [name] |

## 11. Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | [date] | First approved version | [name] |
