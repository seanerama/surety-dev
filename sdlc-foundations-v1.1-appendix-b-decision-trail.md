# Appendix B. Decision Trail

**Status:** Reconstructed 2026-09-30 from the two retained reviews. The interactive exchange between the architects (v0.1, the Architect Review Proposal, the cross-reviews, the v0.2 review, the Section 3.10 review) was not retained on disk; see errata E15. This appendix records the **input side** only: which review findings each foundations section answers, and which question each decision settled. It does not record what was contested or conceded.

**Citation keys.** `C-R#` and `C-D#` are requirements and open decisions in `sdlc-review-claude.md` §7. `C-L#` is a numbered lesson in its §1. `C-§` is a section of that review. `A-§` is a section of `sdlc-review-Astra.md`; `A-A##` is one of its acceptance scenarios in §10; `A-Q#` is the nth open question in its §11.3.

---

## B.1 Foundations v1.0 sections and the findings they answer

| v1.0 section | Answers | Primary evidence cited by the reviews |
|---|---|---|
| 1 Background | C-§1, C-§2.7, C-§3.6; A-§1 | SDD self-grading (Switchboard D4, D7, D8); Verity's unbounded testing, GitHub dependency, Actions cost, 16-role overlap |
| P1 Builder cannot determine acceptance alone | C-L3, C-R4, C-R6; A-§1 "a completion message is a claim" | DB-mocked tests green over a prod bug; UX test done as CSS math; HTMX 472-byte stub |
| P2 Engine is the only authority on state | C-L1, C-L4, C-R1, C-R8; A-§5.1, A-§9.1 | STATE.md at "Design, 44%" through 18 releases; reviewer approve wired as merge (ADR-0014) |
| P3 Assurance mandatory, ceremony scales | C-R5; A-§1, A-§8.1 item 12, A-§8.3 | Verity cost sinks were planner thrash and gate deadlocks, not test volume; ADR-0028 proportional gating |
| P4 Every role is an enforced boundary | C-L8, C-R9, C-R11; A-§5.3, A-§8.2 "contradictory responsibilities" | Codex `exec` ignoring permission profiles; planner denied GitHub but required to open issues |
| P5 Local-first, framework-owned pipeline | C-R18, C-§6.8; A-§5.12, A-§9.11 | Actions cost on private repos; branch protection paywalled; Fresh substrate shipped, graduation not |
| P6 One canonical source of code | C-R20; A-§5.13 | Release truth drifted with two homes (ADR-0034); prod running from the dev checkout (steer-it revisit) |
| P7 Testing stops when required checks pass | C-R4; A-§9.6 | Verity "testing had no stopping point"; unbounded rework request #91 |
| P8 Records never claim more than observed | C-L5, C-R1; A-§6.5, A-§8.1 item 7 | No-CI read as red; unreachable GitHub read as empty; unknown cost as $0; fabricated circuit state |
| 3.1 Separate dimensions | C-R2; A-§5.13, A-§6.3 | Lifecycle vs attention state conflated in console NOW panel; release/publish/deploy conflated |
| 3.2 Baseline states | C-R1, C-R25 | Spec pointer, not pasted text, is what work items reference (operator-init contract) |
| 3.3 Candidate lifecycle | C-R1, C-R3, C-D1; A-§9.11 | Staging/beta naming collision; Live as projection of dev (ADR-0015–0023) |
| 3.4 State scope | C-R1; A-§9.4 | Approvals name a revision; moved head invalidates (issue #298) |
| 3.5 Management mode | C-R21, C-§5.3 | Agent Keep maintainer interview 2026-08-04: read-only helpdesk companion |
| 3.6 Environment records | C-L5, C-R1; A-§6.5, A-A24 | Attempted vs verified deploy; publish succeeded, deploy failed |
| 3.7 Transition and operation rules | C-L10, C-L11, C-R12; A-§5.10, A-§9.7, A-A12, A-A13, A-A18 | Timed-out write retried → duplicate comment (stage 112); approval consumed parked result (ADR-0014) |
| 3.8 Backward movement and spec changes | C-R25; A-§9.4, A-A08 | Spec as versioned append-only artifact; PR head changes during review |
| 3.9 Pause and resume | C-R9; A-§9.5, A-A17 | Executor lifetime one stage (ADR-0004); fresh capabilities on resume |
| 3.10 Phased planning | C-§2.5 "Scale, three kinds", C-§3.5; A-§5.5, A-A11; O5 | Planner planned all stages; planner thrash 54% of a run (stage 73); "plan quality depends on a decided architecture" |
| 4.1 Role contracts | C-R8, C-R24; A-§8.2, A-§11.2 "sixteen-role roster" | 16 roles the most-cited confusion; role-to-purpose table needed (stage 104) |
| 4.2 Role rules | C-L8, C-R9; A-§4.3 | Fresh context per unit of work; delegation enforced by dispatcher (stage 92, 109) |
| 5.1 Independence rule | C-R6; A-§4.4 | Acceptance criteria before code; prompt framing alone is not independence |
| 5.2 Protected acceptance execution path | C-L2, C-R4; A-§9.9 | Gate definition single-sourced; SHA-pinned gate records |
| 5.3 Updating protected checks | C-R6 | Objection, not workaround; spec-grounded corrections |
| 5.4 Developer tests | C-§2.5 "agent-written tests" | Sixteen DB-mocked tests green while every bulk import would fail |
| 5.5 Model diversity | C-R26; A-§4.4, A-§7 | Each backend caught what the other missed; fixed assignment not established as optimal |
| 5.6 Validation scope and sensitivity floor | C-R5; O1, O7 | Proportional gating by lifecycle state (ADR-0028) |
| 5.7 Risk tiers | C-R5; A-§8.1 item 12 | Local prototypes and deployed systems need different integration policies |
| 5.8 Stopping, budgets, blockers | C-R17, C-§6.7; A-§9.6, A-§9.8 | Breaker deadlocks (stages 21–32); no-progress breaker; bounded rework |
| 6 Findings | A-§9.6; O2, O3 | Typed review outcomes with durable findings; approval and repair are different transitions |
| 7 Repositories and releases | C-R18, C-R19, C-R20, C-§3.3; A-§5.13, A-§9.11, A-A25 | Promotion pipeline shipped 7 releases without a leak; graduation designed, never built (ADR-0028) |
| 8 Mechanic | C-R21, C-R22, C-R23, C-§5.3; O4 | Observe-and-report only in v1; filing cap; escalation channel |
| 9 Autonomy and ceremony | C-R5, C-R15; A-§9.7 | Mandatory floor vs configurable; settings already in the engine |
| 10 Deferred work | C-§8 asset inventory; A-§11.1 build order | Keep/adapt/drop verdicts per asset; narrow loop first |
| 11 Decision record | see B.3 | |

## B.2 Errata v1.1 entries and the findings they answer

| Errata | Answers | Primary evidence |
|---|---|---|
| E1 Backend contract | C-R11, C-R27, C-L9, C-§3.7, C-§6.4; A-§5.2, A-§5.3, A-§9.3, A-A03, A-A04, A-A22 | Codex enforcement no-op with 567 stub tests green; child env inherited every credential; Claude never-prompting tools (465k tokens); provider denylist of one (ADR-0031); `-c` absorbs unknown keys |
| E2 Engine performs git | C-R8, C-L4; A-§5.1, A-§9.4, A-A21 | ADR-0012/0013; intent artifacts ownerless 42 days (ADR-0033); forged commits carried on push (issue #311); v2 shell interpolation |
| E3 Deployment verification | C-L2, C-§2.5, C-§5.1; A-§9.9, A-A20, A-A24 | Every hotfix passed CI and health and shipped broken; smoke accepted "degraded"; version string unchanged across 5 releases |
| E4 Walking skeleton | C-L7, C-§2.7 item 2; A-§9.9 | Nine stages done before CI ran; Verity 1.0 certified on verity-skeleton-demo |
| E5 Mechanic triage | C-R22, C-R23, C-D4; C-§5.3 | No-self-feeding rule; prompt-injection path user text → issue → code; sanitized product-intent contract |
| E6 Adopting an existing project | A-Q1, A-§9.10, A-A25; C-§2.2 (Retrofit Planner), C-§5.1 (Switchboard switched to Verity) | First supported journey question; Verity adopted Switchboard mid-life |
| E7 Interruption, stop, resume | A-§5.9, A-§5.10, A-§9.5, A-A17, A-A18; C-L10 | Killed ticks left lock, dirty branch, no usage row; 110-minute stall with no deadlines; crash bypasses `finally` (ADR-0036) |
| E8 Check judgment and gate states | C-R7, C-L6; A-§9.9, A-A20 | Tail-swallowed lint twice; runner never awaited; skip counted as pass (stage 99) |
| E9 Human decisions | C-R13, C-R14, C-L12, C-§6.6; A-§6.3, A-§9.10 | steer-it 25 judged / 0 ratified; console first session abandoned after six blockers; gate copy false for its config (stage 111) |
| E10 Interactive sessions | C-R10, C-§6.3; A-§9.8 | Only `agent-exec` wrote the ledger; interactive sessions unmeasured |
| E11 Candidate nomination | A-§9.1 (Attempt / WorkItem entities); C-R1 | Request vs plan vs attempt distinction; O7 cadence |
| E12 Gate function explicit | C-R14; A-§5.7, A-§9.7 | Reviewer approve wired as merge; consequence computed by the same function the engine uses |
| E13 Asymmetric check corrections | C-R6; A-§4.4; pattern from O2/6.3 | Self-grading return path; "anyone raises, human lowers" worked for severity |
| E14 Product shape (O8) | C-D5; A-§6.7, A-Q2, A-§9.10 | Console scheduler proposal vs thin-UI; spawn-per-call polling exhausted rate limit; four engine asks unfiled 37 days |
| E15 Provenance | C-R30, C-L15; A-§5.15 | Decisions without reasons get relitigated; docs as another stale state store |
| E16a Retired state | C-D2 | Terminal state missing |
| E16b Budget semantics | C-R17; A-§9.8 | Per-run ceiling tripped on cache reads; Codex cost unknown, never $0 |
| E16c Records, redaction, retention | C-R16, C-§6.9; A-Q8 | GitHub token in a chat transcript; superadmin password published; history scrubbed on day 3 |

## B.3 Decisions O1–O8 and the question each settled

| # | Question | Where the question came from |
|---|---|---|
| O1 | Which behaviors can a tier label never downgrade? | C-R5 proportional gating needed a floor it could not lower; Switchboard SSRF, path traversal, login JSON leak |
| O2 | What do Critical/High/Medium/Low mean, and who may change them? | A-§9.6 typed findings; "no reclassification workaround" needed an assignment rule |
| O3 | Who may defer a nonblocking finding? | C-R13 human load vs assurance; Reviewer defers Low, human defers Medium |
| O4 | How many issues may the Mechanic file, and how does it escalate? | C-R22 bounded filing; Agent Keep open question on dedup; escalation channels |
| O5 | What does "SDD did not scale" mean? | C-§2.5 "Scale, three kinds": stage count, lifecycle shape, context; resolved as planning scale → rolling-wave phases |
| O6 | Who defines module boundaries? | steer-it "imports nothing from siblings"; A-§8.2 ambient-state leaks; sensitivity floor needs a module map |
| O7 | How often does verification run? | C-R4 "keep independence, drop volume"; A-§8.1 item 12 risk-proportional workflow |
| O8 | One product or UI over engine; service or CLI; single or multi-operator? | C-D5; A-§6.7; A-Q2; console five invariants |

## B.4 Review findings not addressed in foundations, with disposition

| Finding | Disposition |
|---|---|
| C-R28 Run the real thing early (benchmark harness, throwaway projects) | Process practice, not a foundations rule. Carry into the detailed-design plan as a first-month obligation. |
| C-R29 Build the revisit habit in | Process practice. Carry into detailed design as a scheduled role or engine job. |
| C-D3 Minimum telemetry contract per deployment target | Open. Section 10 deployment adapters must define it; prerequisite for the 3.5 activation gate. |
| A-A05 Same role twice in one run → distinct attempt IDs | Implied by E7 process ownership and E14 runtime store; make explicit in detailed design (attempt identity). |
| A-A14, A-A15 GitHub unavailable; CI registers late | Detailed design for the GitHub substrate after graduation; 3.6 Unknown and the gate states (E8) give the vocabulary. |
| A-A16 Hostile ambient git overrides | E1 constructed environment covers the child; the engine's own git calls need the same discipline. Astra §6.2's "resolved execution context object" should be a named detailed-design entity. |
| A-A19 Read budget across tabs and fleet | E14 event stream removes substrate polling locally; a read budget is still needed once GitHub is a target. |
| A-Q5 Which OS and runtime versions are qualified | E1 trust table carries version; OS qualification is a detailed-design matrix. |
| C-§8 asset inventory keep/adapt/drop | Input to the detailed-design reuse plan, not to foundations. |
