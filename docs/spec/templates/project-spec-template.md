# Project specification template

This is the document Surety works from. A person writes it for a new project, or the Spec Writer role produces it from an idea and the person approves it. Once approved it is the **approved baseline** (foundations section 3): every plan, every check and every gate traces back to it, and changing it follows the specification change workflow (foundations section 3.8).

The engine reads this document at every save, but only in the exact forms this template fixes (D6 Appendix B.2): the header fields; in section 4, each requirement's heading, its statement, its criteria, its sensitive areas and its marks; the index of section 5; the module table of section 6; the environment subsections of section 7; the open questions of section 10; and, in retrofit, the claims table of section 12. From those it builds the specification's **semantic representation** and reports every defect (a row that does not parse, a requirement without a row, a duplicate key, a requirement with no criteria and no mark) as its next entry to whoever is writing. Keep those parts exactly in the shape shown; everything else is prose for people and is not interpreted.

**How it feeds Surety**

| In this document | What the engine makes of it |
|---|---|
| Tier (T1, T2, T3) | The project's default validation scope (foundations section 5.7). |
| Each requirement `R<n>` | One requirement row, keyed `R<n>`. The heading is `### R<n>` or `### R<n>. <title>`; the first paragraph under it is the requirement's statement, read as text. Delivery is computed per candidate; a requirement no phase has delivered stays visibly pending. A key never changes; a key that disappears is recorded `withdrawn`, never deleted. |
| Each acceptance criterion `R<n>.<m>` | A list item beginning with the key; the rest of the item is the criterion's text, also read. It is the statement one executable check must establish. The Verifier writes that check under `.surety/checks/`, naming the criterion and the requirement it covers; the gate counts the check's recorded execution, never a role's word. |
| Sensitive areas on a requirement | The sensitivity floor (foundations section 5.6): the area's required checks apply whatever the tier. Values are from the closed list, by identifier (section 4). |
| `**Human test.**` and `**Descriptive.**` | The marks for a requirement with no criteria. Without criteria or a mark the requirement is uncertain, cannot be validated and blocks approval; `**Human test.**` says the owner accepts a human test for it; `**Descriptive.**` is retrofit's mark for a requirement described from the code that has no criteria yet. |
| `**Targets:**`, `**Cross-platform:**` and `**Surface:** ui` | The platforms the product is for (`web`, `android`, `ios`, `macos`, `windows`, `linux`), a product decision the approval fixes; whether they share branding and workflows; and which requirements are user-interface requirements, optionally for some targets only. With design on and a `ui` module, a spec without `**Targets:**` cannot be planned (D7 §4.1, G3). The Architect chooses the UI technology beneath each target, never the targets. |
| Modules and their paths | The module map the Architect refines; sensitive areas on a module gate triage. |
| Protected paths | Paths only the protected-check workflow may change (foundations section 5.3). |
| Environments | The targets a deployment gate can name, each with the fields the deployment adapter needs (D4). |
| Phases (roadmap hint) | The Architect's starting point. Moving a requirement between phases is a roadmap revision, not a spec change. |
| Origin (section 5, optional) | `intended` (the default, and what a five-column index means) or `observed`, the retrofit mark for a requirement described from existing code. Syntax and a claim, never a confirmation: the owner confirms each such requirement explicitly at approval (D6 §8.2, K10). |
| Open questions `Q<k>` | Each blocks the requirements whose keys it cites. The Architect may not plan a blocked requirement; a question blocking a phase-1 requirement, or one whose phase cannot be told, blocks approval (D6 reading 1). |
| Claims and reality (section 12) | In retrofit, each claim the repository makes about itself, what was observed, and the requirement it became; the owner confirms those requirements at approval (D6 §8, K10). |

Copy everything below this line into `.surety/spec/spec.md` of the project and fill it in. Text in *[brackets]* is instruction; delete it. Keep the heading levels and the key formats: `R<n>` for a requirement, `R<n>.<m>` for its acceptance criteria, `Q<k>` for an open question.

---

# [Project name]

**Spec version:** 1 *[integer; a new version for every approved change]*
**Status:** draft | approved *[the engine records who approved it and when]*
**Tier:** T2 *[T1 prototype, T2 standard, T3 critical; see foundations section 5.7. Pick the tier for the project as a whole; sensitive areas raise the floor regardless]*
**Owner:** [name]
**Targets:** web *[one or more of `web`, `android`, `ios`, `macos`, `windows`, `linux`, comma-separated; needed when the product has a user interface; the engine assumes none]*
**Cross-platform:** yes *[optional; only with two or more targets: they share branding and workflows, and every platform-specific difference is stated in the design. Delete the line otherwise]*

## 1. Purpose

*[Two to five sentences. What the product does, for whom, and why it is worth building. Written for someone who has not heard of it.]*

## 2. Non-goals

*[What this project deliberately does not do, so that nobody plans or builds it. One line each.]*

- [Non-goal]

## 3. Users and situations

*[Who uses it and in what situation. One short paragraph per kind of user. Name the situations the requirements below refer to.]*

## 4. Requirements

*[One subsection per requirement, in exactly this shape, because the engine reads it (D6 Appendix B.2):*

- *the heading is `### R<n>` or `### R<n>. <title>`; the key `R<n>` never changes once approved, and a requirement that is withdrawn keeps its key and is marked withdrawn;*
- *the first paragraph under the heading is the requirement's **statement**: what must be true, written as behaviour someone can observe, not a design;*
- *the line `**Sensitive areas:**` names the areas it touches, comma-separated, by identifier from the closed list of foundations section 5.6: `authentication`, `authorization`, `payments_financial_data` (payments and financial data), `personal_data`, `secrets_credentials` (secrets and credential handling), `data_migrations_destructive` (data migrations and destructive data operations), `irreversible_external_actions`. `none` is a valid value and must be stated;*
- *each acceptance criterion is a list item beginning with its key `R<n>.<m>`, the rest of the item being the criterion: a single checkable statement that one check can establish;*
- *a requirement with no criteria carries, on a line of its own, the mark `**Human test.**` (the owner accepts a human test for it; say in the prose after the mark what a person does and sees) or, in retrofit only, `**Descriptive.**` (described from the code, no criteria yet; see section 12). Without criteria or a mark the engine reports the requirement uncertain and blocks approval;*
- *a requirement whose behaviour the user sees on a screen may carry, on a line of its own, `**Surface:** ui`, or `**Surface:** ui (android, ios)` to name only some of the header's targets. It makes the requirement a user-interface requirement before any plan exists (D7 §4.2, G3); a requirement a UI stage implements is one anyway.*

*The rationale and any other prose are for people and are not read.]*

### R1. [Short title]

*[The statement: what the product must do, observable, not a design. This first paragraph is what the engine reads as the requirement.]*

**Rationale.** *[Why. One or two sentences.]*

**Sensitive areas:** none

**Acceptance criteria**

- R1.1 *[Given …, when …, then …; one check can establish it]*
- R1.2 *[…]*

### R2. [Short title]

*[The statement.]*

**Rationale.**

**Sensitive areas:** authentication

**Acceptance criteria**

- R2.1
- R2.2

### R3. [Short title]

*[The statement.]*

**Rationale.**

**Sensitive areas:** none

**Human test.**

*[What a person does and what they see. A requirement with no criteria cannot be validated by a check; this mark records that the owner accepts that for this requirement.]*

## 5. Requirement index

*[One row per requirement. This table is what the engine registers; keep it complete and consistent with section 4: every `R<n>` of section 4 has a row and every row a subsection, and a criterion listed in one and absent from the other is a contradiction that blocks approval. Phase is a hint for the Architect's roadmap. The engine parses the table exactly (D3 §4.5, extended by D6 K10): key `R<n>`; sensitive areas by identifier from the closed list, or `none`; criteria `R<n>.<m>`, comma-separated, each of its own requirement's key and none repeated, empty for a marked requirement. The sixth column, `Origin`, is optional: the five-column table is still valid and means `intended` for every row. `observed` marks a requirement a retrofit session described from the existing code (D6 §8.2). Origin is syntax and a claim, never a confirmation: every retrofit-produced requirement is confirmed by the owner's explicit decision at approval, whatever this column says. A row that does not parse refuses the spec's approval and names the row. How the Verifier declares checks under `.surety/checks/` is shown in D3 Appendix B.]*

| Key | Title | Phase | Sensitive areas | Criteria | Origin |
|---|---|---|---|---|---|
| R1 | [title] | 1 | none | R1.1, R1.2 | intended |
| R2 | [title] | 1 | authentication | R2.1, R2.2 | intended |
| R3 | [title] | 2 | none |  | intended |

## 6. Modules and protected paths

*[The parts of the codebase as the owner sees them. The Architect may split or rename them in the architecture, which is a separate approved document; what is fixed here is which areas are sensitive and which paths are protected. The engine reads the table in exactly these columns; paths comma-separated, sensitive areas by identifier or `none`.]*

| Module | Paths | Sensitive areas |
|---|---|---|
| [name] | `src/[area]/` | none |
| [name] | `src/auth/` | authentication, secrets_credentials |

**Protected paths** *[changed only through the protected-check workflow; the checks directory is always protected]*

- `.surety/checks/`
- [other path]

## 7. Environments

*[Where candidates are deployed and tested. One subsection per environment, headed by its name; the engine reads each subsection's fields (D4; M4). Alpha is the first target a candidate can be authorized for. Say what the environment is for and what counts as a deployment there being verified (foundations section 3.6).]*

### alpha

- **Purpose:** [internal test target]
- **Verified means:** [the health check and the smoke checks pass against it]
- **Target:** [the adapter and its target, for example `local_service`, target `app`]
- **Runtime and start command:** [for example `node src/server.mjs`; the service is the revision's tracked files as they are, with no build or install step (D4 Q4)]
- **Port:** [the environment variable the service listens on, for example `PORT`; the engine assigns the value]
- **Excluded from the artifact:** [`artifact.exclude`: paths not deployed. It must name any protected root outside `.surety/` (D4 §3.1)]
- **Required post-deploy behaviour check:** [the specified user operation the `post_deploy_behavior` check exercises against the running service, and what counts as success. A health or version endpoint alone is not a behaviour check]
- **Stable arguments:** the service must not change its process title or command-line arguments while it runs; the engine identifies the running service by them (CD4, E121)

## 8. Constraints

*[Things that bound every design: platforms, languages, data residency, budgets, dates, dependencies that must or must not be used. One line each.]*

- [Constraint]

## 9. Interfaces and data

*[Only what the requirements depend on: external systems, inputs and outputs, data that must persist. Formats belong in the architecture unless a requirement fixes one.]*

## 10. Open questions

*[One list item per question, keyed `Q<k>`; the engine reads the list. Each is either a decision for the owner or a question a requirement must answer before it can be planned. Cite in the item the keys of the requirements it blocks: every `R<n>` the item names is read as blocked by it. An optional trailing `(phase n)` says which phase the question must be settled before. A spec with open questions can be approved, with two exceptions (D6 reading 1): a question blocking a requirement the phase hint of section 5 places in phase 1, and a question with no `(phase n)` on it or blocking a requirement with no phase in section 5 (B04: a missing hint cannot make approval vacuously safe), each block approval. The Architect may not plan a requirement whose question is open.]*

- Q1 [question] Blocks R2. Owner: [name]. (phase 1)

## 11. Change log

*[Written by the engine (D6 §3.4, §4.5): on each approval it writes the row for the approved version in one engine commit, replacing a row with that version if one is there. A session leaves this table as it is.]*

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | [date] | First approved version | [name] |

## 12. Claims and reality

*[Retrofit only (D6 §8; K10); delete this section for a new project. One row per claim the repository makes about itself (a README, a changelog, a CI file, a release note, a comment) that the session set against the code: where the claim is made, what it says, what was observed, and the requirement it became, or `none`. The engine reads the table in exactly these columns. Observed is what the session saw, never what it inferred; a claim that was not checked says `not checked`, and a requirement built on one carries the `**Descriptive.**` mark until it has criteria. The owner confirms each requirement this table fed before the spec is approved.]*

| Source | Claim | Observed | Requirement |
|---|---|---|---|
| `README.md`, Usage | [what it says the software does] | [what the code does, or `not checked`] | R1 |
