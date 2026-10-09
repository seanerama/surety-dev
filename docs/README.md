# Surety documents

The documents moved here from the repository root on 2026-10-01 with their file names unchanged. Older documents refer to each other by bare file name; use this index to find them.

## Read these to build

| Document | Purpose |
|---|---|
| [spec/M1-build-spec.md](spec/M1-build-spec.md) | How M1 was built: scope, roles, corrections to the design, slices, definition of done. Its roles and constraints stay in force. |
| [spec/M2-build-spec.md](spec/M2-build-spec.md) | How M2 is built: one real backend on one small project under D2; the three test lanes; five slices; what is in and out; done. Start here for M2. |
| [spec/handoff-2026-10-04-orchestrator.md](spec/handoff-2026-10-04-orchestrator.md) | **Start here as orchestrator.** The standalone handoff (2026-10-04, build paused): where M2 stands, what happens when Sean resumes, how the build is driven, the safety rules, the hosts and recovery, how Sean works. |
| [spec/orchestrator-prompt.md](spec/orchestrator-prompt.md) | The paste-ready opening prompt for a new orchestrator session. |
| [spec/handoff-2026-10-03.md](spec/handoff-2026-10-03.md) | The previous handoff, superseded; kept for history. |
| [spec/M2-input-triage.md](spec/M2-input-triage.md) | Confirmed by Sean (E48): the eighteen untested behaviours sorted into before a real agent, in M2, and later. |
| [spec/M2-slice-1-hardening.md](spec/M2-slice-1-hardening.md) | The first slice of M2 (built and merged 2026-10-03, E50 to E52): the five gate-integrity entries of the triage, their cases, the procedure and what done means. |
| [spec/M2-slice-2-legibility.md](spec/M2-slice-2-legibility.md) | The second slice of M2 (built and merged 2026-10-03, E53 to E55): bucket B of the triage, the six entries a first real project needs to be usable and legible. |
| [spec/templates/project-spec-template.md](spec/templates/project-spec-template.md) | The specification a project gives Surety: the identifiers the engine registers and the prose around them. |
| [spec/templates/spec-assistant-prompt.md](spec/templates/spec-assistant-prompt.md) | A paste-ready prompt for an assistant that works an idea into that specification with the owner, in the manner of Spec-Driven-Devops's Vision Assistant. |
| [spec/templates/idea-brief-template.md](spec/templates/idea-brief-template.md) | One page the owner fills in before a Spec Assistant session, so the conversation starts from something written. |
| [../.surety/spec/spec.md](../.surety/spec/spec.md) | Surety's own specification, drafted from the template on 2026-10-03: twenty requirements across the eight phases, M1's with the rows that established them, M2's in full. Draft until Sean approves it. |
| [acceptance/sdlc-M1-acceptance-plan-Astra.md](acceptance/sdlc-M1-acceptance-plan-Astra.md) | The 74 acceptance rows M1 passed. |
| [acceptance/sdlc-M2-acceptance-plan.md](acceptance/sdlc-M2-acceptance-plan.md) | The 42 acceptance rows M101 to M142 M2 must pass, in three lanes; adopted 2026-10-03 (E59). |
| [design/sdlc-design-D1-engine-core.md](design/sdlc-design-D1-engine-core.md) | The engine architecture, draft 3. |
| [design/sdlc-design-D2-brief.md](design/sdlc-design-D2-brief.md) | The brief for D2 (backend adapters, control-plane isolation, the execution boundary, the trust table): what it must answer, what it inherits, how it is produced and judged. |
| [design/sdlc-design-D3-brief.md](design/sdlc-design-D3-brief.md) | The brief for D3 (the protected acceptance path, the check runner, the diff classifier, validation scope): what it must answer, what it inherits, how it is produced and judged. |
| [design/sdlc-design-D3-checks.md](design/sdlc-design-D3-checks.md) | D3 draft 1 (E60): closed schemas for the governed set, discovery as a function of a tree, the check runner in D2's sandbox, the diff classifier with its conservative fallback, validation scope; five proposed corrections, seven open questions, 53 test statements. Awaiting Astra's cross-review. |
| [design/sdlc-design-D2-ebpf-note.md](design/sdlc-design-D2-ebpf-note.md) | Companion to D2: an optional eBPF execution observer as qualification evidence, approved as a prototype (E57). |
| [design/sdlc-design-D2-backends-and-isolation.md](design/sdlc-design-D2-backends-and-isolation.md) | D2 draft 2, approved to build (E58): the adapter contract, the namespace sandbox, the cgroup execution boundary with launch closure, the trust table and qualification attempts, the optional observer; ten D1 corrections, 73 test statements. |
| [design/sdlc-design-D1-resolution-note.md](design/sdlc-design-D1-resolution-note.md) | Seven corrections to D1 and the rule that ended prose review. |
| [foundations/sdlc-framework-foundations-v1.0.md](foundations/sdlc-framework-foundations-v1.0.md) | Principles, roles, state model, testing rules. |
| [foundations/sdlc-foundations-v1.1-errata-draft.md](foundations/sdlc-foundations-v1.1-errata-draft.md) | Sean's decisions E1 to E105 amending the foundations. |

## Background and record

| Location | Contents |
|---|---|
| [foundations/sdlc-foundations-v1.1-appendix-b-decision-trail.md](foundations/sdlc-foundations-v1.1-appendix-b-decision-trail.md) | Which question each early decision answered. |
| [foundations/sdlc-idea.md](foundations/sdlc-idea.md) | The original idea, reconstructed. |
| [reviews/predecessors/](reviews/predecessors/) | Two reviews of spec-driven-devops, Verity and the Verity console, including the incident record the design is tested against. |
| [reviews/D1/](reviews/D1/) | The three cross-reviews of D1, the dispositions, and the briefs that requested them. The draft-3 review explains most of the corrections in the build spec. |
| [reviews/D2/](reviews/D2/) | The cross-review brief for D2 draft 1, Astra's review (approve with amendments), and Sean's dispositions (E56). |
| [reviews/D3/](reviews/D3/) | The cross-review brief for D3 draft 1 (for Astra), and her review and its dispositions when they exist. |
| [reviews/surety-progress-journal.md](reviews/surety-progress-journal.md) | Astra's progress journal: dated entries on what is committed and what is only recorded, read independently of the build agents. |
| [architecture/](architecture/) | Astra's architecture whiteboards (business view, full lifecycle, lifecycle build status with and without the eBPF observer), each with the prompt that drew it; build-status data in JSON. |
| [acceptance/reports/M1-report.md](acceptance/reports/M1-report.md) | The M1 acceptance report: the run, versions, qualified load limits, review findings, what is not claimed, and the hands-on walkthrough (`M1-hands-on.sh`). |
| [acceptance/reports/M1-not-claimed.md](acceptance/reports/M1-not-claimed.md) | The 33 cases left unwritten under the lean procedure, classed, so a passing M1 is not read as covering them. |
| [acceptance/reports/M2-not-claimed.md](acceptance/reports/M2-not-claimed.md) | M2's running not-claimed list, grown slice by slice, each item with its row, class and the slice where it is claimed. |
| [acceptance/objections/](acceptance/objections/) | Builder objections to acceptance tests, and the Verifier's answers. |
| [mockup/](mockup/) | The accepted MVP UI design, eight screens. |
| [history/](history/) | A slot for the original design-session documents, not yet recovered. |
