# SDLC harness review — Astra

**Review date:** September 30, 2026  
**Purpose:** Historical evidence and design lessons for a new agent-first SDLC harness using Claude Code and Codex as coding backends. This is input to a future specification, not that specification or an implementation authorization.  
**Author:** Codex / Astra review

**Reading route:** §1 gives the conclusions; §§3–7 preserve the history and evidence; §§9–11 translate the lessons into specification inputs; §§12–14 record verification, remaining concerns, and sources.

## 1. Main conclusions

The strongest asset in these projects is the accumulated evidence about what fails between a model producing work and a system reliably delivering that work. Preserve that evidence and the deterministic mechanisms it justified. Do not simply reproduce the role roster, Markdown conventions, GitHub labels, or Console screens.

The projects show a clear progression:

1. **Spec-Driven DevOps 1.x:** organize work into specialized roles, dependency graphs, contracts, and automatic handoffs.
2. **The local SDD v2 experiment:** introduce typed agent messages, a central orchestrator, routing, pipelines, and result aggregation.
3. **Verity:** move lifecycle authority into deterministic code; derive integration state from artifacts; enforce gates; add provider adapters, a worker, and real benchmarks.
4. **Verity Console:** expose that engine to an operator, revealing deficiencies in repository identity, live state, cancellation, API budgets, and the meaning of controls.

The most consequential recurring failures were **false completion, missing or misleading evidence, and lifecycle ownership gaps**. Examples include a workflow blocked by a display string; a successful-looking provider comparison in which later roles never ran; a planner that repeatedly replanned an already planned request; plans left uncommitted; usage records lost on abandoned branches; approvals that purchased a new review instead of consuming the reviewed result; and a fleet view reading one repository's local policy while naming another repository.

The new harness should therefore begin with a durable execution model, explicit authority, and acceptance evidence. Claude Code and Codex should be interchangeable executors where their verified capabilities permit it. Neither should implicitly own scheduling, durable workflow state, approval semantics, or release authority.

The record also argues against excessive ceremony. Verity's later local substrate recognizes that GitHub round trips and per-stage human gates can dominate an early prototype. Keep verification mandatory, but make integration and approval policy proportional to the project phase and consequences.

### Highest-value lessons to carry into the specification

| Lesson | Historical evidence | Implication |
|---|---|---|
| A model's completion message is a claim | SDD v2 marks responses successful; Verity canaries and benchmarks exposed missing downstream work | Verify artifacts, tests, and transitions independently |
| The harness must own durable progress | Repeated planning, uncommitted intent artifacts, branch-bound usage | Give every artifact and transition one owner and a durable record |
| A provider adapter is an executable contract | Verity's first Codex implementation used ineffective configuration and mismatched event fields | Probe the real invocation path, positive and negative cases, before claiming support |
| Approval must refer to an immutable result | Repeated unknown-cost reviews changed verdicts; review-head binding remains incomplete | Bind approvals to result, source head, policy, and acceptance evidence |
| Observability must not compete with work | Console polling exhausted the shared GitHub allowance | Use one projection, caching, event delivery, and an explicit read budget |
| Repository identity includes local execution context | Console fleet combined target GitHub data with ambient checkout state | Resolve and validate repository, clone, worktree, environment, and credentials together |
| Scheduling and cancellation are product capabilities | Headless agents delegated and exited; killed workers left locks and no usage row | The engine owns child lifetimes, cancellation, recovery, and scheduler coordination |
| Benchmarks must grade delivered work | Early Codex N=3 comparison was void; later ledger undercount distorted scorecards | Compare equivalent outcomes and preserve complete per-attempt evidence |
| Good gates can become unusable gates | Human approval could not advance work; tiny review fixes required manual transport | Provide tested resume and bounded rework paths |
| Product usability is part of completion | Design ownership was absent; Console needed a clearer current-action view and first-run path | Give UX, visual design, and browser acceptance explicit ownership |

## 2. Scope, provenance, and limits

### 2.1 Repositories actually reviewed

| Project | Reviewed source | Snapshot | History available |
|---|---|---|---|
| Verity framework | `/home/smahoney/projects/verity-framework`; origin is **`seanerama/verity-dev`** | `45344bbd6e83f8ee5f0a0c0b6856c464a98d0c7f`; package 1.8.0 | 326 reachable commits; June 7–September 29; 115 tracked stage specs, 38 ADRs, 12 contract Markdown files, 98 test files |
| Verity Console | `/home/smahoney/projects/verity-console`; origin `seanerama/verity-console` | `741ccf3a9977eb4c60016a52509f8949bda88711`; package 0.2.1 | 106 reachable commits; August 5–September 30; 51 tracked stage specs, 14 tracked ADRs, 70 test files |
| Public SDD | Fresh read-only review clone of the requested [GitHub repository](https://github.com/seanerama/spec-driven-devops) | `1adf049308664552a61ce8140f81a6bfceb475aa`; package 1.4.0 | 15 commits; March 2–May 28; GitHub reports a later June 7 push timestamp |
| Local SDD v2 | `/home/smahoney/projects/spec-driven-devops-v2` | `3301452ceadc0d93f444563a2c2da4882ad0ed2f`; package 2.0.0-alpha.6; local `master` | 31 reachable commits; March 2–April 7; includes 1.x ancestry and the April 7 experiment |

The local folder named `verity-framework` is the development repository. The public production repository is a separately promoted projection. Its tags and releases have a different authority from development tags. Confusing these repositories would distort the release history.

The local SDD v2 branch and public SDD main share ancestor `44d323f` (1.3.1). The public repository subsequently received dependency pinning, workflow-path normalization, and sequential stage delegation; the local experiment proceeded separately. **Do not assume v2 includes the later v1.4 fixes, or that the public repository contains v2.** The local v2 refactor plan is untracked and its unchecked boxes do not accurately summarize the implemented April 7 commits.

Console had **15 pre-existing changed/untracked paths** at review time: modifications to four design/ADR documents and eleven untracked documents, including stages 52–57, ADRs 0015–0017, an assessment, and engine requests. These are valuable evidence of intended direction, but they are **not shipped functionality at the reviewed HEAD**. They were preserved unchanged.

### 2.2 Evidence method

Reviewed Git histories, implementation modules, role prompts, tests, ADRs, contracts, stage specifications, benchmark reports, canary results, revisit audits, and feature assessments. Queried the live GitHub issue/PR listings for all three remotes: 317 framework entries, 131 Console entries, and zero SDD entries were returned. These totals include both issues and PRs, and are not defect counts. Follow-up issue bodies were read for the most relevant current gaps.

Evidence labels used in this report:

- **Observed this review:** source inspection, read-only GitHub query, local test execution, or a harmless scratch reproduction performed for this report.
- **Recorded observation:** a dated canary, benchmark, or review records an actual run. It was not rerun here unless explicitly stated.
- **Implemented:** a commit and present code support the change; this does not by itself establish production reliability.
- **Open/reported:** a current issue or assessment documents a remaining concern. Some open issues retain already-fixed subitems.
- **Recommendation/inference:** a proposed design conclusion drawn from the record.

No paid model benchmark, GitHub write, deployment, release, or real-agent security canary was launched for this review. Provider flags and behavior described below are **historical observations at the recorded versions**, not assertions that the latest external CLI behaves identically. The report does not establish model rankings or current provider prices.

The public SDD README was checked through the supplied URL; substantive history and code analysis used the Git clone. Verity's design documents explicitly describe it as a clean-room conceptual successor to SDD 1.4. This report does not infer a code-level ancestry beyond what Git and those documents establish. [F01]

## 3. Historical chronology

| Period | Development | What it taught |
|---|---|---|
| March 2–7 | VibeOps becomes Spec-Driven DevOps; package, commands, internals, and output directory renamed | Identity changes propagate through installation, prompts, state, and documentation |
| April 6 | Public SDD security role receives third-party framing | Self-review bias was recognized, but prompt framing alone is not independent verification |
| April 7 | Local v2 builds typed contracts, orchestrator, classifier, adapters, pipelines, aggregation; switches adapters from CLI to APIs; adds standalone CLI and autopilot | A central orchestration seam is useful, but a generic chat API wrapper is not equivalent to a coding-agent runtime |
| April 23–May 28 | Public SDD adds dependency pinning, fixes workflow path parsing, and makes stage execution sequential with isolated contexts | Machine state needs canonical values; fresh context need not imply parallel edits |
| June 7–9 | Verity implements identity, scaffolding, derived state, build/review, release, security, operations, UI smoke, and adapters | The deterministic delivery engine becomes the center of the design |
| June 10–13 | Autonomy fork adds policy, scanner, locks, worker, usage, trust ladder, Actions driver, and subscription authentication | Headless operation introduces distributed-state and credential concerns beyond prompt orchestration |
| July 25–28 | Knowing spike rejected; autonomy reunified into framework; 1.0 certification; executor lifetime limited to one stage | Reject an integration on evidence; constrain context lifetime |
| July 29–August 4 | Codex support followed by real-runtime remediation, containment, engine-owned Git/GitHub, unknown-cost and gate-resume fixes | Stub-correct adapters can be operationally wrong; permissions and workflow side effects must be designed together |
| August 4 | Dev/prod split and promotion machinery; operator JSON contracts | Publication needs explicit authority and provenance; UI should consume engine contracts |
| August 5–18 | Console builds read views, controls, fleet, benchmarks, then a current-action panel and live hints | Operator needs are an effective integration test of engine semantics |
| August 10–13 | Real comparative benchmarks uncover provisioning, work-item, CI registration, clock-skew, planning, and branch-base defects | Run the whole pipeline, inspect resulting repositories, and instrument unexplained behavior |
| August 19–21 | Local delivery substrate and direct/local-container/remote/Actions gate runners | Delivery substrate and verification location are separate dimensions |
| August 27–September 8 | Runtime truth stamping, publish truth, context discipline, provider trust tiers, revisit role | Release metadata, capability assertions, and documentation need ongoing reconciliation |
| September 22–24 | Revisit findings become fixes: intent commits, release derivation, runner honesty, contract pinning, scaffold hygiene, go-live dispositions | A structured audit can turn accumulated drift into a tractable backlog |
| September 25–28 | Larger runs expose usage loss, headless delegation, unbounded calls; fixes add branch-independent usage, denial mechanisms, deadlines, parked review resume, no blind write retries | Reliable autonomy is mostly lifecycle engineering around uncertain execution |
| September 29–30 | Engine init/intake/spec-soundness and Console project creation ship; real E2E reveals tick chaining, stale reads, invisible running state, cancellation leftovers, and API pressure | Onboarding must be tested as a complete user journey across engine and UI |

## 4. Spec-Driven DevOps: successes and limits

### 4.1 What the public 1.x project established

SDD introduced a useful vocabulary: vision, architecture, design, planning, stage execution, review/testing, deployment, operations, retrofit, and feature intake. Its deterministic dependency engine supports new/existing paths, OR dependencies, replacement of bootstrap roles for existing projects, and event-triggered roles. Configuration separates defaults, user settings, and project settings. The installer renders commands for multiple hosts. [S01]

These are useful **workflow and packaging successes**. They are not evidence that all installed runtimes execute identically or that an entire deployed system was validated on each runtime. The distinction matters for the new harness: portable prompts are one layer of portability; execution, permissions, auth, events, and interruption are separate layers.

### 4.2 Failure: display text became invalid machine state

On May 28, commit `056c106` fixed an initialization stall. `STATE.md` contained a human label such as `Existing Project`, while the dependency engine required `existing`. Four reading sites merely lowercased the text, producing `existing project`, which matched no path. All relevant role checks could therefore refuse execution. The fix centralized normalization and corrected a test that had encoded the wrong output; assertions grew from 110 to 120. [S02]

**Lesson:** prose can render state, but should not be its authoritative encoding. Use a validated enum and stable identifiers. If Markdown is an input format, parse it into a canonical typed object and reject unsupported values before scheduling.

### 4.3 Success: sequential stages with fresh execution contexts

Commit `75a3461` changed the Stage Manager to delegate one stage at a time, merge it, then start the next from the integrated result. The manager keeps file lists and summaries instead of accumulating full code. The workflow explicitly explains that context isolation supplies the primary benefit; concurrent stages touching shared files add merge overhead. Hosts without the delegation mechanism use an inline fallback. [S03]

**Carry forward:** the unit of work should be a bounded stage or repair attempt with a fresh context. Default to serial integration. Later concurrency should require isolated workspaces, dependency analysis, and revalidation against the integration head.

**Do not copy literally:** the historical runtime fallback table and `Task` spelling. Verity subsequently demonstrated that interactive delegation and headless child lifetime are different problems.

### 4.4 Security review framing: useful intent, limited proof

Commit `938e230` frames the security auditor as an independent third party. This is evidence that self-review bias was considered; it does not establish that the bias was eliminated. A fresh review context, immutable diff, acceptance rubric, and independent tests give the framing something enforceable to work with. Provider diversity is a hypothesis to benchmark, not proof of independence. [S04]

### 4.5 Local v2: good seams, unfinished delivery semantics

The April 7 history implements the refactor plan in eight stages: TypeScript and contracts; core migration; orchestrator; classifier; adapters; pipelines; aggregation/error handling; and integration tests. Later commits change providers to APIs, add Gemini/Ollama and setup, restore a Claude CLI mode, and add a standalone/autopilot experience.

Useful components include runtime task/result validation, a configurable routing table, sequential/parallel/conditional pipeline composition, context passing, retry bookkeeping, and explicit partial results. These are better seams than hard-coding agent calls throughout application logic. However, inspection found several important limits. [S05]

| Finding at local v2 HEAD | Evidence | Lesson |
|---|---|---|
| `CodexAdapter` is an OpenAI chat-completions client, defaulting to a historical `gpt-4o` identifier; it does not invoke Codex CLI | `src/agents/codex.ts` | Name adapters by actual transport/runtime; a model response cannot stand in for repository execution |
| Claude defaults to the Messages API; CLI mode is optional | `src/agents/claude-code.ts` | Model provider and coding runtime are separate choices |
| A returned response can become `success` without artifact/test verification | Both adapters; Codex derives some flags from prose regexes | Result parsing and result acceptance are separate responsibilities |
| Confidence values are constants such as 0.85 or 0.9 | Both adapters | Do not present fixed values as calibrated confidence |
| Standalone prompts say tools are unavailable, then autopilot asks the model to read prior output files | `prompt-loader.ts`, `conversation.ts` | Context must actually be loaded by the engine; asking for inaccessible files does not supply it |
| Standalone `runRole` accepts but does not use `_args`; completion-hook errors print a finished/state-update-skipped message | `runner.ts` | Argument forwarding and persistence failures need explicit contracts |
| Pipeline context accumulates previous result outputs | `pipeline/context.ts` | Prefer bounded evidence references and selected excerpts to unbounded history copying |
| Default routing reserves generation/refactoring for Claude and security/review for Codex | `orchestrator/router.ts` | Keep routing configurable; the requested new system should permit either backend to write code |

Two implementation defects were **reproduced safely in temporary directories during this review**:

1. `writeFiles(projectDir, ...)` accepts `../outside.txt` and writes above the project directory. It resolves a path without a containment check. The scratch probe created only a disposable sibling marker.
2. Claude CLI mode interpolates prompt text into `execSync` with a shell and escapes only double quotes. A literal command-substitution expression in a prompt was expanded before reaching a fake CLI. No real Claude process or model was invoked.

These are reasons to reuse ideas rather than copy the v2 execution/writer code unchanged. Use argument arrays and stdin for prompts; validate path containment, symlinks, protected paths, and allowed effects before applying output. [S06]

The v2 tests include stub-based E2E coverage, which proves orchestration logic under those stubs. They do not establish real agent lifecycle behavior. The test runner also prints its global result before separately counted asynchronous suites finish. The observed run completed successfully, but the headline count is not the complete suite count. See §12.

## 5. Verity: the strongest lessons from operational history

### 5.1 Success: move lifecycle authority into the engine

Verity's original design separates model judgment from deterministic operations, fixes project identity early, derives integration state, and makes CI and observable behavior part of completion. Its stage/contract/ADR structure provides unusually good historical traceability: a finding can often be followed through assessment, decision, stage, PR, regression test, and later canary. [F01]

The July/August Codex work made the boundary concrete. ADR-0012 moves Git lifecycle operations to Verity. ADR-0013 moves GitHub writes to Verity. The model can propose files and structured effects; the engine checks and applies them. This resolves a structural contradiction: a sandboxed role cannot both lack GitHub credentials and be required to create the lifecycle objects on which the next role depends. [F02]

**Recommendation:** make the engine the sole owner of commits, work-item registration, PR creation, gate transitions, approvals, merges, and releases. Give model output an explicit proposal contract. Preserve that distinction even when a trusted interactive runtime could technically perform the operation itself.

### 5.2 Failure: the first Codex seam passed tests for an imagined external contract

The v1.1.0 integration shipped July 29. The accepted readiness review identified nonbinding configuration, incorrect isolation flags, a wrong event discriminator (`item.item_type` versus `item.type`), and an unsupported rationale for the version floor. The July 30 real-CLI spike then showed that the proposed enforcement design itself needed revision. [F03]

Recorded at Codex CLI 0.146.0:

- The headless `exec` path did not apply the permission profiles assumed by the integration.
- A filesystem rule spelling that appeared to deny writes did not override a workspace write grant in the tested path.
- Rules for bare Git/GitHub commands did not match shell-wrapped execution.
- A malformed configuration stopped execution entirely, initially resembling a successful denial test because the target file was absent.
- Isolating the configuration/auth root could also remove authentication and make the test incapable of exercising the boundary.

The project responded with feature-based version evidence, explicit capability gaps, environment shaping, post-run checks, and disposable workspaces whose diffs are validated before merge-back. It also had to remove the initially added `--output-schema` path after a real canary exposed incompatibility; independent result validation remained essential. [F03], [F04]

**General lesson:** accepting a configuration key is not proof that it governs execution. A negative test needs proof the attempted action actually ran. A positive test needs proof permitted work still works. Test the exact headless entry point, auth arrangement, OS, tool path, and version being claimed.

### 5.3 Success with limits: containment and capability honesty

The strongest containment idea is to give the agent an isolated work area, preserve relevant protected material as read context, and validate the entire proposed change before anything reaches the authoritative checkout. Simply hiding `.verity/` backfired: the model recreated missing identity files, and merge-back then rejected its work. Supplying that material as protected context fixed the mismatch. [F05]

Containment is not equivalent to universal restriction. Revoking an environment token does not prove all credential access is impossible; checking Git refs after a run does not undo every side effect; a minimum version is not a current certification stamp.

The September 24 canary on 0.154.0 revalidated several containment properties but explicitly **did not rerun the supervised worker chain**. It recorded missing failed-command events in the retained JSON stream, argument loss for roles lacking `$ARGUMENTS`, workspace cleanup residue, and auth-root configuration changes. Its readiness decision supported bounded human-driven headless use with caveats and **refused unattended readiness certification** for that canary. Stage 103 subsequently fixed argument forwarding on both drivers. It did not resolve every canary limitation. [F06]

Do not flatten this history into either “Codex does not work” or “Codex autonomy is proven.” Support is a matrix of runtime version, mode, capability, environment, and evidence.

### 5.4 Failure: work-item reconciliation took eight stages to become a usable chain

The August 11 sequence is particularly useful for the new spec. All of these defects appeared while exercising a real pipeline after earlier fixes had passed unit tests. [F05]

| Stage | Defect | Correction |
|---|---|---|
| 63 | Contained planner could not create GitHub stage issues | Worker owns idempotent work-item reconciliation |
| 64 | Reconciliation existed but policy was not forwarded to dispatch | Wire configuration through the actual worker path |
| 65 | Reconciliation ran only after success, but denied legacy side effects made the planner report failure | Inspect/reconcile eligible persisted output on the relevant failure path |
| 66 | Prompt still treated role-owned issue creation as mandatory | Remove that conflicting responsibility from the role |
| 67 | Issue creation failed on missing non-Verity labels and errors were swallowed | Provision required labels and surface failures |
| 68 | Newly opened PR reached inspection before CI registered | Add bounded pending/grace semantics |
| 69 | Operator projection omitted the clock input used by grace logic | Thread the same decision inputs through all consumers |
| 70 | Local clock lag made a new PR appear future-dated | Tolerate bounded skew; instrument actual timestamps |

**Lesson:** acceptance must traverse configuration → dispatch → provider → durable artifacts → side effects → projection → next decision. Testing each module separately cannot prove that path is connected.

### 5.5 Failure: planner thrash was partly a scheduler bug

An initial interpretation blamed heavy planning and prompted the planner to emit a thinner backlog. Live validation did not solve the problem. A later assessment traced repeated planning to the worker: the request stayed eligible, its scanner tier outranked builds, and the worker synthesized another plan without checking whether stages already existed. Planning consumed approximately 54% of the examined run's tokens; repeated plans were unnecessary. [F07]

Stage 73 retired the request trigger after successful planning and added a stage-existence guard. Stage 74 separately increased build turn headroom. These addressed different causes. A smaller prompt or a larger limit could not substitute for a correct transition.

**New-spec requirement:** distinguish an intake request from a plan revision and a build attempt. A successful plan must atomically establish its durable artifacts and mark the request consumed. Replanning requires new intent, invalidated assumptions, or an explicit transition.

### 5.6 Failure: disabling model Git writes left intent artifacts without an owner

The September revisit audits found plans, contracts, ADRs, assessments, and even revisit reports sitting uncommitted. Work-item creation had an owner, but persisting the files those work-items referred to did not. Stage 96 introduced engine-owned commits for intent artifacts from roles with `git_write:false`. [F08]

The September 25 benchmark still reproduced uncommitted plans because the new paths depended on policy switches that were off for that run. Stage 114 later enabled intent commits and work-item reconciliation in init's starter policy. **Implemented functionality is not necessarily an effective default.**

There is a remaining safety concern: issue #311 records that the intent-artifact push can carry pre-existing/forged local commits along with the engine's intended commit under its ref-store assumptions. This does not invalidate the ownership decision; it shows why the engine must validate the exact base and exact diff it publishes. [I311]

### 5.7 Failure and success: approval must consume a result

Early unknown-cost approval re-ran the model. One canary reviewed the same PR three times, consumed roughly 138k, 144k, and 154k input tokens, produced duplicate comments, and changed verdicts. The operator approved one result but execution used another. ADR-0014 and stage 31 introduced persisted results and zero-new-model-cost resume. [F09]

The same problem reappeared for completed review results parked at `review:merge`, a category the original decision had treated differently. Stage 111 extended resume and made trust-0 approval capable of completing a merge with an approve verdict and green checks. Console then needed to remove its old hard-coded “approval does not merge” statement. [F09], [C02]

**Lesson:** define approval around an immutable proposed effect and supporting evidence, not around a label or a broad role name. Test the entire approval → resume → revalidation → effect path for every gate class.

**Remaining gap:** issue #298 documents that a reviewer can read a changing live PR while the engine records head SHAs around the run. Those checks do not prove exactly which tree the verdict examined. A pinned review checkout/diff is the structural solution. Same-user mutation of parked-result files is also noted. [I298]

### 5.8 Failure: usage stored in branch history disappeared from the scorecard

In the September 25 D run, final-checkout accounting showed about 2.49M input tokens rather than 5.59M, with the plan row missing. In the A run, the scorecard retained only 5 of 14 rows, approximately 36% of reconstructed input usage. Usage commits lived on stage branches that later branch switching and squash integration abandoned. [F05]

Stage 108 and ADR-0036 moved the live ledger into the Git directory as branch-independent runtime state, added recovery from prior commits, and removed per-branch usage commits. The decision explicitly rejects an in-memory save/restore solution because a crash can bypass `finally`. [F10]

**Carry forward:** execution history, metering, leases, and parked results belong in durable runtime storage outside the changing source tree. Give each invocation an ID; deduplicate on it. Define backup/export because a fresh clone does not inherit a local Git-directory ledger.

**Related unresolved evidence problem:** the same benchmark reported that repeated builds within one run overwrote `<run>/build.jsonl`. Use per-attempt transcript identities, not merely run-plus-role filenames.

### 5.9 Failure: headless delegation outlived its parent turn

A September 25 headless Claude build launched background agents, attempted a wakeup, and returned waiting for a later notification. The one-shot process had no later turn, and no work was committed. The proposed quick fix—remove `Task` from the allowlist—was experimentally disproven: the recorded runtime still allowed non-prompting tools. An explicit deny mechanism was required. [F11]

Stage 109 added deterministic headless denial and corresponding prompt guidance. Review also corrected an unsupported assertion that Codex had no delegation feature, adding a Codex mechanism. Open issues #286 and #287 show why a fixed list can still lag new tool/feature names.

**Recommendation:** let the harness own every execution process. A backend can delegate only if the adapter can track, await, cancel, and account for the descendants. Otherwise remove that capability in a verified way. Interactive orchestration guidance must not be reused unchanged for headless execution.

### 5.10 Failure: budget checks did not bound blocking subprocesses

The heavy September benchmark lost roughly 110 minutes to a local network outage. The record could not identify the exact blocking call because tick output was not retained. Source inspection found unbounded `gh` and Git subprocesses; model timeouts and between-role checks did not bound them. Stage 110 added deadlines to the relevant external calls, retained tick logs, and made the benchmark wait offline instead of spending ticks. [F12]

Stage 112 then addressed the next reliability class: timing out a write does not prove it failed, so retrying can duplicate comments or other effects. It distinguished ambiguous outcomes and used rereads where supported. Issue #301 still records unrecognized GraphQL 5xx/EOF shapes and transcript-redaction gaps. [I301]

**Recommendation:** give every read, write, model invocation, whole attempt, and recovery loop a deadline. Retrying reads and retrying side effects are different policies. On ambiguous writes, reconcile the remote state using an operation identity before deciding whether to retry.

### 5.11 Success: reject an attractive integration using measured evidence

The July Knowing spike measured an actual pinned release against three repositories and historical PRs. Its findings included 126,616 estimated context tokens versus 20,074 for the scripted grep/read baseline; 5/15 versus 15/15 required context items; zero selected tests against 42 reference test files; and serious integrity/recovery failures. The integration received a NO-GO. [F13]

The later amendment is as valuable as the rejection: it corrected the initial emphasis on CommonJS support and noted that the brownfield arm also lost on both cost and retrieval quality. It proposed a genuinely large brownfield repository for any future scale claim, after recovery and silent-failure defects were addressed.

**Lesson:** evaluate retrieval, memory, graph indexing, and test selection against representative work and a simple baseline. Establish a rejection condition before adopting the dependency. Preserve caveats: these were small, single-environment experiments with estimated tokens and scripted ground truth, not a universal verdict on graph retrieval.

### 5.12 Success with unfinished migration: local delivery and independent gate runners

Stages 79–85 add a local substrate; stages 86–89 separate where gates run from where work is tracked. A project can use local Git delivery while gates execute directly, in a local container workflow, or on a named remote runner. This disentangles three concerns that the new spec should model independently: coding backend, delivery substrate, and verification runner. [F14]

The Fresh lifecycle preserves stage discipline, defined gates, exit-code judgment, SHA-bound evidence, and engine-owned integration. It reduces per-stage GitHub ceremony for early work. **Graduation remains a designed later step, not a shipped verb**, as the amended ADR explicitly states.

### 5.13 Release engineering: provenance succeeds; multiple truth sources drift

The dev/prod split introduced an allowlisted production projection, verification, protected promotion PRs, promotion records, and production-owned authoritative tags. It preserved development evidence while limiting published content. Projection verification caught tests that depended on private fixtures/documents, prompting separation of development-only checks and a hermeticity guard. [F15]

But runtime metadata remained at 1.1.0 after 1.2/1.3 promotions until stage 91 moved stamping into finalize. Later, state/release derivation still consulted a development tag rather than the production promotion record; stage 97 corrected the authority. The September revisit also recorded a publishing dry run waiting on an environment approval for 22 days. [F08], [F15]

**Lesson:** represent source prepared, promotion proposed, production merged, tag created, artifact published, and runtime deployed as different states. A release command must not imply all happened. Every external approval needs an identifiable owner and visible waiting state. The current checkout reports runtime 1.8.0; this review did not independently verify its npm artifact bytes.

### 5.14 Success: fresh-project bootstrap and an actionable spec gate

Stages 113–115 move fresh-project creation behind one engine operation, register trusted intake for a single identity, expose pending requests, and park an unsound specification with named gaps. The subsequent real Console-driven E2E recorded two private repositories created in about 18 seconds each; a sound spec produced three stages and a contract, while a vague spec parked with six gaps and no stages. [I315]

That is a concrete product success: the harness could distinguish a buildable request from one requiring answers and explain the difference. The same run exposed unexpected role chaining and missing live-state/cancellation behavior. Preserve both conclusions. A soundness gate is useful only when the user can revise the spec and resume through a supported path.

### 5.15 Failure and correction: process documentation can become another stale state store

The September revisit found frozen contract prose disagreeing with result vocabulary and missing emitted fields, implemented ADRs still marked Proposed, open tracker items with merged fixes, and test lanes outside the normal gate. Stages 99–100 improved test-runner honesty and contract-surface pinning; later documentation/tracker changes reconciled part of the drift. [F08]

These are useful corrective practices, but pinning documented key names does not prove full behavioral compatibility. The new system should generate schema/reference material where possible, test producer and consumer together, and record an ADR's acceptance separately from implementation, rollout, and qualification status. Test runners themselves also need failure-path tests: Verity had to stop treating a returned Promise or a skipped check as a pass.

## 6. Verity Console: product and integration lessons

### 6.1 Success: a thin operator surface over a defined engine contract

Console's initial architecture is a local loopback server using a fixed subprocess command registry. It reads operator JSON contracts and invokes named engine actions rather than accepting arbitrary commands or implementing an alternate trust ladder. Mutating routes add origin/token protection and audit records. This is a useful authority boundary to preserve. [C01]

The Console also solved visual-design ownership locally: ADR-0003 makes its Architect responsible for a versioned design guide and makes visual conformance reviewable. Framework issue #92 remains broader than that local resolution. SDD had a designer role; Verity's lack of a universal owner demonstrates that removing a role without assigning its responsibility leaves a real product gap. [C03]

### 6.2 Failure: the screen matched the API but the API described the wrong checkout

The September 28 canary returned **DO NOT PROMOTE** despite 921 passing tests at that historical commit. Fleet reads and cross-repository run-once used the Console's working directory. `--repo` changed GitHub requests, but local stages, policy, and usage still came from the ambient checkout. A throwaway repository displayed the Console project's backlog and could execute under its policy. Comparing the UI with the same incorrectly scoped API initially looked consistent. [C04]

Stage 40 changed fleet entries to include validated local clone paths and launched every target's engine command with its own cwd and repository environment. The rerun compared each view against commands run from the correct clone and inspected the actual process cwd/environment. This verified the boundary that the original test oracle had missed.

**Remaining concern:** Console issue #94 records that inherited `GIT_*` and `GH_HOST` overrides can still defeat otherwise correct cwd targeting. Engine issue #303 separately asks the engine to refuse or warn when remote target and local checkout disagree. [C94], [I303]

**New-spec requirement:** one resolved execution-context object must contain repository identity, clone/worktree root, source revision, delivery substrate, credential scope, and a sanitized child environment. Every command and audit record should use that object.

### 6.3 Failure: launch success was presented as execution progress

Originally, run-once returned an accepted response and instructed the user to watch Runs. A manual-mode worker could exit immediately before creating a ledger row, while the Console discarded its output. The promised result never appeared. Stage 41 retained per-launch logs/results and surfaced terminal outcomes. [C04]

Later E2E exposed a related problem: one tick may chain several roles, but the UI implied one action. Engine init omitted a smaller chaining limit, so “start” could plan and begin building. Console stage 46 corrected the copy and added local launch tracking; an engine starter-policy change remained an ask. [I315], [C05]

**Lesson:** distinguish accepted, queued, running, yielded, completed, cancelled, and failed. “One tick” is an implementation detail unless its actual consequence is clear. If the product promises plan review before coding, make that an explicit workflow transition rather than relying on a tick count.

### 6.4 Failure: an observability client exhausted a shared operational resource

Mission Control polled every five seconds. Snapshot, work, and gates independently fetched GitHub data; one view generated at least nine GraphQL requests per poll before additional gate reads. The E2E record measured approximately 108 calls per minute and an exhausted shared allowance. Other sessions shared that identity, so the issue appropriately qualifies attribution rather than claiming a perfectly isolated experiment. [C06]

Stages 48–49 added a shared 30-second server cache, mutation invalidation, escalating backoff, hidden-tab pause, in-flight guards, and truthful source-age display. The assessment estimates approximately 1,080 calls/hour/repository at that TTL before additional consumers; that remains substantial. Engine issue #317 asks for a combined projection from one fetch and structured failure/reset information. [I317]

**Lesson:** “live” is not “fetch everything independently and continuously.” Set a resource budget for observability. Cache by resolved target and relevant policy, invalidate on known mutations, identify stale data, and reserve capacity for the worker. A future event stream should come from authoritative engine events, not inferred log activity.

### 6.5 Failure: unavailable, idle, paused, and empty were conflated

Current engine source still returns `[]` from `operator work` on an offline snapshot. With a readable non-manual policy but unreadable GitHub labels, `computeAutonomy` can report a closed circuit. GitHub-side worker fields also lack a reliable current-run source. These are concrete examples where comments promising honest unknowns exceed what the output shape communicates. [I316]

Console has mitigations, but cannot recover information the engine does not expose. Its open issues include a failure banner that suggests waiting for errors that may actually require reauthentication, and stale or misleading state across screens.

**Recommendation:** make knowledge status part of each projection: observed value, observation time, evidence source, freshness, and failure class. `unknown`, `empty`, `blocked`, `paused`, `offline`, and `idle` must be distinct. Normal dependency waiting should not look like an incident.

### 6.6 Success: browser and process tests found defects unit projections missed

The canary caught a 413 response lost when the server destroyed the socket too early. Stage 42 corrected response ordering and early size rejection; the recorded browser recheck exercised 35 oversized uploads successfully. Earlier fixes addressed CSS overriding `[hidden]`, synchronous subprocesses freezing the server, slow feature discovery, stale controls, and loading states. [C04]

The initial release was cleared with explicit waivers for some unexercised real gate/running/benchmark criteria. Those waivers are legitimate historical decisions, **not passes**. Preserve the test/waiver distinction in any future readiness dashboard.

### 6.7 Current plans reveal the missing engine product surface

Uncommitted Console stages 52–57 propose Live, Settings, a scheduler, autonomous project start, and a spec-answers screen. The associated engine request document lists gaps that are directly relevant to the new system: [C07]

- Per-role provider/model settings are read by the worker but not writable through the intended scalar setter.
- A durable worker loop/heartbeat and authoritative run-state API are missing.
- Clean signal handling and cancellation are missing; stopped runs can leave locks until TTL, a changed branch, and no usage record.
- There is no authoritative lifecycle event feed.
- There is no engine spec-update operation for resuming an unsound specification.
- Circuit controls need an issue number; worker and snapshot do not use exactly the same circuit rule.
- A total project spend cap is absent; existing limits are mostly daily/per-run.
- Usage rows contain model/provider information that run projections do not fully expose.
- Policy writes are local, cwd-relative, and uncommitted unless handled separately.
- Immediate execution after circuit close can see stale remote labels.

The proposed Console scheduler is understandable as a way to complete the user journey, but creates tension with the original thin-UI architecture. **For the new harness, put scheduling, pause/cancel, heartbeat, and recovery in the engine from the beginning.** Let the Console request them through the same API used by CLI and automation.

## 7. What the model comparisons actually support

The benchmark findings are useful precisely because they invalidate simplistic conclusions. Most comparisons have N=1, differ in delivered work, and stop at a gate rather than a completed application. Tokens include provider-specific caching/accounting behavior; Codex dollar cost is unknown in the recorded integration. [F05]

| Experiment | Recorded result | Defensible interpretation |
|---|---|---|
| Fixture D, early Codex N=3 | Looked roughly 5× leaner, but pipeline did not cleanly reach equivalent work-item/build/review execution | **Invalid comparison**; exclude from provider ranking |
| Fixture D, valid Codex run | 490 seconds and ~859k tokens to the review gate | Useful functioning sample after the wiring fixes; N=1 |
| Fixture C, N=1 each | Codex 477s / ~931k input; Claude 857s / ~3.43M input; recorded grades 15/20 and 20/20 | Speed/token savings coexisted with different planning/hygiene quality |
| Fixture A, August, N=1 each | Codex built two stages versus Claude one; ~995k versus ~4.9M input; grades 15/20 versus 19/20 | Claude scheduler/planning waste materially confounded the result |
| D, changing only planner to Sonnet | Recorded total cost increased about 17% and time about 33% | A cheaper planner can create more expensive downstream work; one comparison does not establish a general ranking |
| September 25 D | Two stages auto-merged; final docs review gated; reconstructed ~5.59M input, reported verified $6.16 | Real unattended integration progress; original scorecard undercounted |
| September 25 A | Several early stages integrated; later physics review found substantive problems; network outage and accounting loss | Valuable stress evidence, not a clean efficiency benchmark or completed product |

The September A prose is internally inconsistent: it says stages 1–6 merged, then identifies stage 6's PR as receiving `request_changes`. The dispatch table lists seven builds and six reviews. This review does **not** use that prose to certify an exact merged-stage count. Resolve against per-PR and per-attempt records before using it in a quantitative baseline.

The A fixture also changed from a URL shortener to a physics game in August. The findings document retains its earlier fixture table. Comparisons need the **fixture commit/hash**, not merely “fixture A.”

Other useful observations:

- Codex over-applied default-off switches to foundational persistence in two recorded fixtures, violating the desired first-run behavior. This is a prompt/scope-adherence regression case worth retaining; it is not a permanent model characteristic.
- Codex's apparent over-decomposition on bare-spec C did not recur on architecture-seeded A. Context quality changes outcomes.
- Both systems could produce reviews that agreed with the observed artifact; a Codex review caught committed bytecode and a later Claude review caught game-level defects.
- A fixed “Claude builds, Codex reviews” assignment is not established as optimal. The user's new system should support Claude→Codex, Codex→Claude, and same-provider/fresh-context combinations as benchmark variants.
- Historical local-model experiments showed a working tool loop on one Codex/Ollama path but high latency, no reported prompt-cache hits, missing final messages, and uncommitted artifacts. Treat local execution as a separate capability/performance profile, not a free substitute for a cloud-backed executor. [F16]

## 8. Cross-project patterns: what succeeded and what repeatedly failed

### 8.1 Practices worth preserving

1. **Small stages with traceable acceptance.** The later Verity history makes it possible to explain why a mechanism exists and which defect it addresses.
2. **A deterministic next-action engine.** Model judgment should select implementation details, not redefine whether a completed request remains eligible.
3. **Fresh executor contexts.** Keep the orchestrator small and source-linked; pass bounded task context.
4. **Explicit contracts and independent result validation.** Useful across provider, engine, UI, and publication boundaries.
5. **Engine-owned side effects.** This reconciles restricted agents with a complete delivery workflow.
6. **Real canaries and artifact grading.** Several of the most valuable improvements followed evidence that contradicted passing tests or attractive metrics.
7. **Unknown as a real state.** Unknown cost, unavailable remote state, and missing CI must not become zero, empty, or green.
8. **Single-source gate definitions judged by exit status.** Preserve tested revision and runner provenance.
9. **Persisted approvals/results.** Human decisions should not require purchasing nondeterministic computation again.
10. **Revisit audits.** Compare claims, code, tests, releases, and tracker state after a period of inactivity.
11. **Evidence-based rejection.** The Knowing NO-GO saved an integration from becoming a foundational dependency without demonstrated value.
12. **Risk-proportional workflow.** Local prototypes and deployed systems need different integration policies while retaining meaningful verification.

### 8.2 Repeated failure mechanisms

| Mechanism | Examples | Structural remedy |
|---|---|---|
| Prose substitutes for typed state | SDD workflow path; role output markers; parsed stage dependencies | Versioned schema and canonical parser; prose as a view |
| Prompts compensate for engine bugs | Thin-plan prompt attempted to fix repeated scheduling | Trace the transition; fix deterministic eligibility |
| Feature exists but is not effective | Reconcile flag, clock input, intent-commit default | One full-path acceptance test per capability |
| Roles inherit contradictory responsibilities | Planner denied GitHub but required to open issues; map role read-only but required to write | Capability/required-effect compatibility check before launch |
| Ambient state leaks into execution | cwd/`GH_REPO`, Git environment overrides, branch-dependent usage | Resolved execution context plus isolated runtime storage |
| Retry substitutes for recovery | Approval reruns, ambiguous GitHub writes | Persist result and operation identity; reconcile before retry |
| Control name hides its consequence | Run once chains roles; approve can merge; manual mode shown as circuit open | Separate concepts; render engine-declared consequences |
| “Done” is a summary rather than an artifact | Invalid benchmark wins, empty test scope, green hygiene-only CI | Inspect actual output, required checks, and acceptance evidence |
| New runtime capabilities silently widen behavior | Delegation/scheduling tools and feature-name changes | Versioned capability manifest, probes, conservative defaults |
| Multiple truth sources drift | ADRs versus schemas, dev tags versus prod releases, cache receipt time versus evidence age | Explicit authority and generated projections with provenance |
| Audit records are treated as disposable logs | Parked result cleanup risk, overwritten repeated-role transcripts | Durable evidence references and retention tied to live workflow objects |

### 8.3 Where ceremony became a cost

The repository's discipline generated useful evidence, but also many assessments, stage documents, contracts, ADR amendments, and tracker follow-ups for changes that sometimes fixed wiring rather than design. The evidence does not quantify documentation cost, so this is an inference rather than a measured productivity claim.

For a new system, preserve traceability while reducing duplicated authoring. A machine-readable task record can generate a stage view, status projection, and audit entry. Reserve ADRs for actual architectural choices. A display-only correction should not require the same ceremony as a new merge-authority boundary. Accepted decisions should link to implementation and validation status automatically.

## 9. Proposed requirements for the next specification

These are recommendations derived from the review, not claims that the current projects implement them.

### 9.1 Engine-owned execution model

Define durable entities for **Project, SpecRevision, WorkItem, Attempt, Artifact, GateResult, Review, Approval, Operation, Release, and Event**. Separate a human request from its plan and from each attempt to execute the plan. Give every attempt a unique ID even when the same role runs twice in one tick.

A minimal attempt should bind:

```text
project_id, work_item_id, attempt_id, parent_attempt_id
spec_revision, contract_revision, source_base_sha, source_head_sha
runtime, runtime_version, model_requested, model_observed
policy_revision, capability_profile, workspace_id
started_at, heartbeat_at, finished_at, deadline
outcome, reason_class, artifact_refs, verification_refs
usage_raw, usage_normalized, cost_status
```

Use explicit transitions such as `eligible → claimed → executing → verifying → reviewed → awaiting_approval → integrated`. Include `needs_answers`, `needs_rework`, `escalated`, `cancelled`, `timed_out`, and `unknown_external_outcome` where applicable. A clean process exit and a successful work-item transition are different observations.

### 9.2 Durable state with source-controlled intent

Keep specs, contracts, approved policy, and source in Git. Keep leases, attempts, events, usage, effect receipts, and parked results in a transactional runtime store outside branch switching. For a local first version, an embedded database is a reasonable candidate; the history establishes the required properties, not a specific database choice.

Required properties: atomic transitions, uniqueness/idempotency keys, crash recovery, resumable evidence, safe migrations, backup/export, and a clear distinction between authoritative events and cached remote projections. Do not claim a local database automatically solves distributed GitHub consistency.

### 9.3 Claude Code and Codex adapter contract

Each backend should implement preflight, capability discovery, launch, streamed event normalization, result collection, cancellation, and cleanup. Use a tested process interface; pin or qualify supported versions and environments. Prompts travel as data, not shell code.

Separate these dimensions:

| Dimension | Examples |
|---|---|
| Coding runtime | Claude Code, Codex |
| Model selection | Requested identifier and independently observed identifier, when available |
| Authentication | Subscription/session auth, API credentials; scoped by adapter |
| Execution mode | Interactive, bounded headless, managed descendants |
| Delivery substrate | Local Git, GitHub |
| Verification runner | Direct process, container, remote runner, CI service |
| Project phase | Prototype, pre-release, operated production |
| Authority | File proposal, external read, privileged operation, merge/release permission |

Do not let adding a provider enum grant authority. Do not require both runtimes to expose identical native features: declare capability differences and either adapt them or refuse unsupported policies before spending model work.

### 9.4 Workspaces and integration

Start each attempt from a known source revision in an isolated worktree or equivalent workspace. Provide relevant policy/contracts as read context. Collect and validate the proposed diff, including protected paths, unexpected artifacts, symlinks, and ref changes. The engine commits and integrates against a checked base.

Reviews inspect a pinned diff/tree. Gate results, review verdicts, and approvals all name that revision. Integration checks that the reviewed revision still matches the proposed head. A changed base/head requires the specified revalidation path. Preserve pre-existing user work and never use a blanket reset as routine recovery.

### 9.5 Scheduling, liveness, and cancellation

The engine owns one scheduling mechanism, even if cron, a Console, or a service requests ticks. Use leases with renewal and ownership/fencing so an expired worker cannot continue applying effects after a replacement starts. Expose queue state and heartbeat through a stable API.

Cancellation should stop managed descendants, record known usage and unknown portions, preserve recoverable work, release or explicitly abandon the lease, and report the workspace disposition. SIGKILL/power-loss recovery must work without a graceful handler. “Pause new work” and “cancel current work” are separate operations.

### 9.6 Typed, bounded review and rework

Define at least `approve`, `request_changes`, and `escalate`, with durable findings referencing acceptance criteria and the reviewed revision. A code defect can trigger a bounded repair attempt with exact findings. A contract/architecture conflict parks for a decision. Bound retries by work item, elapsed time, and usage; detect repeated unchanged findings/no-progress diffs.

The existing open rework-loop request #91 is strong evidence of operator friction. Avoid implementing an unbounded “keep asking until approved” loop. Approval and repair are different transitions.

### 9.7 Approvals and policies

An approval record should bind the actor, exact proposed consequence, project, result hash, reviewed head, policy revision, and expiry/staleness rules. Consume it once. Resume an unchanged completed result without another model call. State what happens if evidence is missing or stale.

Policy changes should resolve the project root, validate the full effective object, show changed authority/budget, and record whether the change is local-only or committed. Use one policy contract for CLI and Console. Configuration editing must preserve fields it does not manage, as Console stage 29 learned.

### 9.8 Metering and budgets

Record raw provider usage plus normalized input, cached input, output, and any available additional categories. Keep requested versus observed model identity distinct. Separate provider-reported value, estimate, unknown, and a measured zero from no dispatch.

Support per-attempt time limits, project/day limits, and maximum repair attempts. A between-dispatch budget check is a soft stop with possible overshoot; state that explicitly. A hard cap needs a backend mechanism or an external enforcement boundary. Unknown cost may be bounded by tokens/time under an explicit policy, but must never be displayed as free.

### 9.9 Verification and readiness

Make a non-empty executable gate set part of the first usable project slice. A gate record names the source SHA, definition hash, runner, environment, exit code, and evidence. Treat missing, skipped, stale, waived, and passed as separate states. Browser acceptance should inspect behavior and visible states, not only DOM projection functions.

Keep real-runtime contract tests separate from deterministic unit tests, but make them required evidence before expanding runtime readiness. Negative capability cases need an attempted action and a positive liveness/control case. Never count an auth/config startup failure as proof of containment.

### 9.10 Operator API and UI

Provide a combined versioned project projection with current run, queue, gates, resource usage, evidence age, and structured failures. The CLI and Console should consume the same transition semantics. Keep the UI free of its own scheduling/trust logic.

The first user journey should be: choose/create project → supply spec → resolve gaps → inspect/approve intended scope when policy requires → start → observe current work → review/repair/approve → inspect a working result. Make the consequence of Start explicit. Provide a direct spec revision/resume path; do not strand the user at a named gap without a supported way to resolve it.

### 9.11 Release and lifecycle policy

Allow a lightweight local phase with real gates. Define graduation before claiming it exists: source export, identity mapping, work-item replay, full verification, security/operability review, and rollback. Keep source release, artifact publication, and deployment distinct. Waivers need scope, owner, rationale, and a revisit trigger.

## 10. Acceptance scenarios to seed the new spec

These scenarios convert the historical lessons into testable behavior. They should run through the public engine API wherever possible.

| ID | Scenario | Required result |
|---|---|---|
| A01 | Sound spec on each coding backend | Durable plan, registered work items, committed artifacts; next eligible work is deterministic |
| A02 | Vague spec | Named actionable gaps; no invented plan; spec revision can resume the same request |
| A03 | Runtime accepts an unknown config key | Preflight cannot infer enforcement from exit 0; unsupported policy is refused or explicitly qualified |
| A04 | Negative containment test never authenticates | Test is invalid/failed, never a successful denial |
| A05 | Same role dispatched twice in one run | Distinct attempt IDs, transcripts, results, and usage rows survive |
| A06 | Branch switch/squash merge after several attempts | Full usage and execution history remain visible and deduplicated |
| A07 | Approve a completed parked review | No new model invocation; unchanged result is revalidated and consumed once |
| A08 | PR head changes during review or after approval | Original verdict cannot authorize the changed head; explicit revalidation required |
| A09 | Review requests a small code correction | Bounded repair uses durable findings; exhaustion parks with a clear reason |
| A10 | Review identifies a contract conflict | Escalation rather than repeated code repair |
| A11 | Request remains visible after successful planning | It does not trigger another identical planning run |
| A12 | Work completed but response/connection lost | Recovery reconciles artifacts and effects before another invocation |
| A13 | GitHub write times out after application | No duplicate effect; result is reconciled or remains explicitly unknown |
| A14 | GitHub unavailable or unauthorized | Work/circuit/CI are unknown where unreadable; error class guides recovery |
| A15 | CI appears late or clocks differ | Bounded pending state, then verified checks or an honest unresolved gate |
| A16 | Two projects plus hostile ambient Git overrides | Each action stays in its validated target, or launch is refused |
| A17 | Cancel during build; then restart harness | Descendants stop; lease and usage recover; source work is retained with a known disposition |
| A18 | Power loss after effect but before local receipt | Idempotent recovery discovers the effect and does not repeat it |
| A19 | Several Console tabs and a fleet are open | Measured read budget stays bounded; worker capacity is preserved |
| A20 | Empty test list, skipped browser lane, stale test SHA | None becomes a passing acceptance gate |
| A21 | Prompt contains shell metacharacters; model emits an escaping path | Prompt is literal data; output cannot escape the workspace |
| A22 | New CLI adds a delegation/scheduling capability | Version/capability qualification detects it; unattended authority does not silently expand |
| A23 | User starts a supervised fresh project | The declared plan/build boundary is respected and shown before launch |
| A24 | Publish succeeds but deployment does not | Release and runtime states remain distinct; recovery identifies the remaining step |
| A25 | Local-only prototype graduates | Same gate definitions replay, history/identity are preserved, and stronger policy activates |

## 11. Suggested implementation order and reuse decisions

### 11.1 Build a complete narrow loop first

1. Define typed entities, transitions, authority, and one project execution context.
2. Implement durable attempts/events, workspace isolation, and one gate runner.
3. Prove one real backend can take one stage from known base to verified diff and engine-owned integration.
4. Add the second backend through the same contract and run equivalent positive/negative cases.
5. Implement persisted review, approval, bounded repair, cancellation, and crash recovery.
6. Add the minimal Console using engine-owned run state and actions.
7. Exercise fresh-spec and existing-repository journeys with both backends.
8. Add GitHub delivery/reconciliation, publication, and broader fleet behavior once the narrow loop is stable.

This is a recommended sequence, not a decision to exclude GitHub from the MVP. If remote PR delivery is the first intended use case, introduce that substrate in step 3 while retaining the same explicit boundaries.

### 11.2 Reuse, adapt, or replace

| Existing asset | Disposition | Reason |
|---|---|---|
| SDD role purposes and new/existing workflow distinctions | Reuse as product vocabulary | Useful separation of responsibilities |
| SDD mutable Markdown state as authoritative runtime storage | Replace | Proven parsing fragility and weak lifecycle semantics |
| Local v2 task/result and pipeline abstractions | Adapt | Good seams; need evidence, revision, capability, usage, and durable-effect fields |
| Local v2 shell invocation and output writer | Replace | Scratch-reproduced shell expansion and path escape |
| Verity assessments, ADRs, canaries, benchmark fixtures | Preserve as a regression corpus | Highest-value accumulated evidence |
| Verity provider adapters | Mine selectively, then requalify | Valuable mechanisms but historical assumptions and open capability gaps |
| Engine-owned Git/GitHub and isolated diff validation | Preserve the design | Solves the central authority mismatch |
| GitHub labels as sole workflow control plane | Reduce to a projection/integration mechanism | Latency, stale reads, hidden state, and resume semantics proved costly |
| Parked-result resume and SHA-bound gates | Strengthen | Add immutable review input and result binding |
| Per-branch usage history | Retire | Known data-loss/accounting defect |
| Operator JSON contracts | Adapt | Useful UI seam; add combined read, events, current-run truth, cancellation |
| Console fixed registry, input checks, audit, browser tests | Reuse patterns | Strong boundary and practical regression coverage |
| Console-side scheduler/live-log inference | Avoid as the final architecture | Duplicates orchestration and cannot authoritatively observe external runs |
| Dev/prod projection machinery | Optional | Valuable if private development/public distribution is a requirement; otherwise avoid the extra release authority layer |
| Sixteen-role roster as mandatory pipeline | Do not mandate | Role count is not a success criterion; start with the roles needed for a proven vertical slice |

### 11.3 Decisions still needed before a buildable specification

- What is the first supported journey: local prototype, private GitHub delivery, or existing production repository?
- Must the initial product be local single-operator, or do durable remote workers/multiple operators matter immediately?
- Is plan approval mandatory, optional by policy, or absent in autonomous mode?
- What is the minimum completion bar: verified PR, locally running app, staging deploy, or production release?
- What authority may each backend receive, and which supported OS/runtime versions must be qualified?
- Which costs must be bounded absolutely versus reported with possible overshoot?
- Which operations require human approval, and which bounded rework loops may run without it?
- What is the retention/privacy policy for raw transcripts, parked results, and sensitive tool output?
- Is private-development/public-projection distribution a real requirement for the new system?
- What evidence is required before a new model/runtime combination becomes eligible for unattended work?

These are product/operating decisions to settle in the future spec. They did not block this historical review.

## 12. Verification performed for this report

Environment: local Linux workspace, Node **v22.22.0**. Existing project files were not edited. Framework was clean before and after; Console's pre-existing design work and the local v2 untracked plan were preserved. The public SDD clone and temporary logs were placed under `/tmp/sdlc-review-astra/`.

| Check | Observed result | What it does and does not prove |
|---|---|---|
| Framework `npm test`, real Codex and production-baseline lanes disabled | **1,729 passed, 8 skipped, 0 failed** | Current deterministic regression suite passes. Does not revalidate real runtime enforcement, production artifact equality, or a whole live delivery loop |
| Console `npm test` | **1,211 passed, 0 failed** | Current suite passed, including available real-browser new-project/first-run cases against a fake engine; no real project creation or model run |
| Public SDD 1.4 `npm test` | **120 assertions passed, 0 failed** | Dependency/configuration/state unit assertions pass; not four-runtime equivalence |
| Local SDD v2 `npm test` | Exit 0; headline **220 passed, 0 failed**, with additional separately counted suites reporting success | Runner has fragmented accounting; its headline is not an aggregate of all suites |
| Local SDD v2 `npm run typecheck` | Exit 0 | TypeScript typecheck passes; does not establish runtime safety |
| v2 output-writer scratch probe | Parent traversal succeeded outside the scratch project | Confirms missing containment at that writer boundary |
| v2 Claude CLI scratch probe with fake executable | Shell command substitution in prompt was expanded | Confirms prompt is interpreted by a shell before reaching the runtime |
| GitHub issue/PR inventory and selected issue bodies | Read successfully as of review date | Current tracker evidence; an open umbrella issue does not mean all subitems remain unfixed |
| Git source/history inspection | Revisions and chronology recorded in §2 | Establishes implementation history, not actual adoption or production reliability |

The framework's eight skips were six real-Codex cases, the real production-projection baseline check, and actionlint because it was unavailable. Test logs include expected error output from negative cases; those were not suite failures.

Console's browser tests ran because a local Playwright installation was available. Its source can register a no-op test labeled `SKIPPED` when that dependency is absent, and the runner has no separate skip tally. That fallback was **not** what happened in this run, but it is another reason future readiness should expose skipped lanes explicitly.

Local v2 asynchronous suites report and enforce their own failures, but start outside a single awaited suite controller. The fact that they completed here should not be rewritten as a claim that the runner's early summary is comprehensive.

The detailed historical metrics above come from repository reports, not new experiments. No attempt was made to reproduce all historical incidents, audit all code, enumerate every PR discussion, or prove current Claude/Codex security boundaries. This is a selective, evidence-led historical review with targeted implementation checks.

## 13. Remaining concerns at the reviewed snapshots

This is a prioritized design-input list, not a request to patch these repositories during this task. Issue status was checked September 30; source inspection was used for the principal mechanisms. Preserve the distinction between a confirmed mechanism and a reported follow-up.

| Priority for new design | Concern | Status/evidence |
|---|---|---|
| Foundational | Reviews are not bound by construction to the exact source head examined | Open framework [#298][I298]; live PR reads versus pinned input |
| Foundational | Intent-artifact publication can carry unintended local commits under ref-store assumptions | Open framework [#311][I311]; reproduced in prior review, with runtime limitations documented |
| Foundational | Stop/cancel leaves locks, checkout state, and accounting incomplete | Framework [#315][I315]; uncommitted Console E3 proposal |
| Foundational | Engine remote reads can fabricate empty/closed/idle facts | Framework [#316][I316]; relevant current source inspected |
| Foundational | Headless capability denial lags newly available tools/features | Framework [#286](https://github.com/seanerama/verity-dev/issues/286), [#287](https://github.com/seanerama/verity-dev/issues/287) |
| Foundational | Fleet can inherit Git overrides that invalidate target isolation | Console [#94][C94]; current reviewer reproduction is in issue |
| High | Ambiguous GitHub errors and transcript redaction are incompletely handled | Framework [#301][I301] |
| High | No engine-owned live heartbeat/run-state and continuous loop | Framework [#294](https://github.com/seanerama/verity-dev/issues/294); worker rejects `--watch` |
| High | No bounded review→build correction loop | Framework [#91](https://github.com/seanerama/verity-dev/issues/91); escalation was implemented separately |
| High | Engine reads duplicate GitHub fetches and omit structured failure detail | Framework [#317][I317]; Console cache mitigates frequency only |
| High | Remote/local repository identity can disagree | Framework [#303][I303]; Console clone validation is not an engine-wide fix |
| High | Fresh init may plan and build in one tick; current-run visibility weak | Framework [#315][I315]; Console improves copy/tracking without changing core lifecycle |
| Medium | Circuit close followed immediately by read can see stale labels | Framework [#314](https://github.com/seanerama/verity-dev/issues/314); did not recur in one later E2E sample |
| Medium | Historical Codex role/capability contradictions remain tracked | Framework [#41](https://github.com/seanerama/verity-dev/issues/41), [#53](https://github.com/seanerama/verity-dev/issues/53), [#201](https://github.com/seanerama/verity-dev/issues/201); do not infer all reproduce on every current runtime |
| Medium | Graduation is not implemented | ADR-0028 explicitly says so |
| Medium | Visual-design ownership is only locally resolved | Framework [#92](https://github.com/seanerama/verity-dev/issues/92); Console ADR-0003 |
| Medium | UI refinements and security/availability follow-ups remain | Console open issue set includes queue/caching, inherited environment, process cleanup, HTTP edges, and stale-state concerns |

Also distinguish **policy permits execution** from **evidence certifies readiness**. The framework's provider trust table permits worker selection and merge authority for Codex with tier-2 requirements, while the September 24 canary's own readiness conclusion remained limited. A new system should connect capability eligibility to recorded qualification evidence rather than allowing those two records to drift.

## 14. Source guide and traceability

Local links are relative to this report's `~/projects/` location. GitHub commit links pin public SDD evidence; development-repository issue links may require repository access. Historical source documents can contain stale “open” lists or old version labels; this report reconciles the material findings against later commits and current issues where stated.

### SDD sources

- **[S01]** Public SDD source at the reviewed revision: role registry, graph/state/config implementation, commands, installer, and tests. Useful for the original workflow model.
- **[S02]** May 28 workflow-path fix: explicit failure description, four read sites, regression tests.
- **[S03]** Sequential isolated-stage workflow: rationale, context boundary, integration order, historical runtime fallback.
- **[S04]** Security auditor framing change: evidence of intent, not an efficacy study.
- **[S05]** Local v2 README and implementation tree: typed orchestrator/pipeline experiment. Pair with [local refactor plan](spec-driven-devops-v2/spec-driven-devops-refactor.md), which is untracked and not an implementation-status oracle.
- **[S06]** v2 writer boundary. Also inspect [Claude adapter](spec-driven-devops-v2/src/agents/claude-code.ts), [Codex adapter](spec-driven-devops-v2/src/agents/codex.ts), [standalone runner](spec-driven-devops-v2/src/standalone/runner.ts), [prompt loader](spec-driven-devops-v2/src/standalone/prompt-loader.ts), and [conversation transport](spec-driven-devops-v2/src/standalone/conversation.ts).

### Framework sources

- **[F01]** Original framework design: conceptual succession, deterministic engine, derived state, artifact ownership, lifecycle, and verification intent. Treat its implementation-status header as historical.
- **[F02]** Engine-owned GitHub effects. Companion: [ADR-0012, engine-owned Git](verity-framework/docs/adr/0012-model-edits-files-verity-performs-git-the-write-boundary-under.md).
- **[F03]** Real 0.146.0 enforcement spike. Companion: [accepted readiness findings](verity-framework/codex-readiness-findings.md).
- **[F04]** Initial real-CLI canary and remediation evidence. Companions: [run 5](verity-framework/codex-headless-canary-results-1.1.0-run5.md), [run 6/6b](verity-framework/codex-headless-canary-results-1.1.0-run6.md).
- **[F05]** Consolidated benchmark findings: invalid comparisons, wiring sequence, model results, grading, and September accounting/liveness failures. Its older open-item and fixture-description sections are not current status.
- **[F06]** September 24 canary on 0.154.0: measured behavior, unrun worker chain, telemetry gaps, and bounded readiness conclusion.
- **[F07]** Repeated-planning root cause: separates scheduler waste from stage size and build turn limits.
- **[F08]** September 22 revisit: release truth, stalled follow-through, claim/reality audit, and proposals. Companion: [September 8 revisit](verity-framework/docs/revisit/2026-09-08-revisit.md). Later fixes are in Git stages 96–107.
- **[F09]** Parked-result resume and September amendment for completed reviews/trust-0 merge semantics.
- **[F10]** Branch-independent usage ADR, including the crash-window rationale and storage amendment.
- **[F11]** Headless-delegation assessment, real probes, and review correction of Codex capability assumptions.
- **[F12]** Bounded external calls: what was known about the outage, what could not be determined, and scope of the correction.
- **[F13]** Knowing spike and amendment: measurements, rejection, methodological limits, revised re-entry conditions.
- **[F14]** Proportional gating/Fresh lifecycle. Companions: [delivery substrate ADR](verity-framework/docs/adr/0029-github-is-a-delivery-substrate-driver-local-git-engine-mode-is.md), [gate runner ADR](verity-framework/docs/adr/0030-gate-execution-is-a-runner-choice-localhost-named-remote-or-git.md).
- **[F15]** Dev/prod split plan. Companions: [release authority ADR](verity-framework/docs/adr/0019-release-authority-splits-authoritative-version-tags-exist-only.md), [split-aware derivation ADR](verity-framework/docs/adr/0034-when-the-dev-prod-split-is-active-dev-side-release-truth-is-the.md), [promotion records](verity-framework/.verity/promotions/).
- **[F16]** Historical local Codex/Ollama findings: working versus failing tool paths, latency, accounting, and missing completion feedback.

Additional implementation anchors: [worker](verity-framework/verity/worker/index.cjs), [operator projections](verity-framework/verity/bin/lib/operator.cjs), [trust/merge logic](verity-framework/verity/bin/lib/trust.cjs), [provider trust table](verity-framework/verity/bin/lib/agents/tiers.cjs), [intent artifact writer](verity-framework/verity/bin/lib/agents/intent-artifacts.cjs), [usage ledger](verity-framework/verity/bin/lib/usage.cjs), [test runner](verity-framework/scripts/run-tests.cjs).

### Console sources

- **[C01]** Console architecture and fixed engine seam. Companion: [fixed-command registry ADR](verity-console/docs/adr/0002-fixed-command-registry.md).
- **[C02]** Approval-copy correction after engine semantics changed.
- **[C03]** Local visual-design ownership decision.
- **[C04]** September 28/29 canary, reruns, fixes, and explicit waivers. Read addenda as well as the opening FAIL verdict.
- **[C05]** E2E follow-up assessment for tick chaining, launch state, unreadable data, and new-project behavior.
- **[C06]** Read-budget incident and fix assessment. Companion: [original measured issue #118](https://github.com/seanerama/verity-console/issues/118), [read-cache ADR](verity-console/docs/adr/0014-engine-reads-that-hit-github-are-served-from-a-short-shared-cac.md).
- **[C07]** Uncommitted autonomous UI assessment. Companion: [uncommitted engine requests E1–E13](verity-console/docs/engine-requests-autonomous-ui.md). Both describe plans/gaps, not shipped stages 52–57.
- **[C94]** Fleet environment-override follow-up.

Additional implementation/verification anchors: [server](verity-console/server.cjs), [view model](verity-console/public/view-model.js), [test runner](verity-console/scripts/run-tests.cjs), [real-browser tests](verity-console/tests/new-project-ui-browser.test.cjs), [v0.2.1 human test script](verity-console/docs/verify/v0.2.1-human-test.md), [release history](verity-console/CHANGELOG.md).

### Evidence needed before drawing stronger conclusions

To turn this report into a trustworthy new-system baseline, preserve fixture hashes, exact runtime versions, sanitized raw events, attempt-level usage, reviewed SHAs, gate records, and final artifact grading in one durable bundle. Then run equivalent Claude and Codex journeys through the same harness version, including failure recovery. The historical record provides the regression cases; it does not yet provide a statistically controlled, current cross-backend performance comparison.

[S01]: https://github.com/seanerama/spec-driven-devops/tree/1adf049308664552a61ce8140f81a6bfceb475aa
[S02]: https://github.com/seanerama/spec-driven-devops/commit/056c106e351a857a7db9a4bcf7fb718c319c0315
[S03]: https://github.com/seanerama/spec-driven-devops/blob/1adf049308664552a61ce8140f81a6bfceb475aa/sdd/workflows/orchestrate-build.md
[S04]: https://github.com/seanerama/spec-driven-devops/commit/938e2309ab4da99d2f1f095f704b843c987d5e17
[S05]: spec-driven-devops-v2/README.md
[S06]: spec-driven-devops-v2/src/standalone/output-writer.ts
[F01]: verity-framework/docs/framework-spec.md
[F02]: verity-framework/docs/adr/0013-model-computes-verity-talks-to-github-extending-the-adr-0012-wr.md
[F03]: verity-framework/docs/dev/codex-enforcement-spike-0.146.0.md
[F04]: verity-framework/docs/dev/codex-headless-canary-results-0.146.0.md
[F05]: verity-framework/benchmark/benchmark-findings.md
[F06]: verity-framework/docs/dev/codex-headless-canary-results-0.154.0.md
[F07]: verity-framework/feature-assessments/retire-plan-trigger-assessment.md
[F08]: verity-framework/docs/revisit/2026-09-22-revisit.md
[F09]: verity-framework/docs/adr/0014-an-approval-consumes-the-parked-result-gate-pauses-persist-role.md
[F10]: verity-framework/docs/adr/0036-usage-ledger-is-branch-independent-runtime-state-not-committed.md
[F11]: verity-framework/feature-assessments/headless-no-delegation-assessment.md
[F12]: verity-framework/feature-assessments/bounded-external-calls-and-tick-logs-assessment.md
[F13]: verity-framework/docs/dev/knowing-spike-report.md
[F14]: verity-framework/docs/adr/0028-proportional-gating-the-fresh-to-graduation-to-sdlc-lifecycle.md
[F15]: verity-framework/docs/dev/dev-prod-split/plan.md
[F16]: verity-framework/codex-ollama-local-findings.md
[C01]: verity-console/docs/architecture.md
[C02]: verity-console/feature-assessments/approve-consequence-copy-assessment.md
[C03]: verity-console/docs/adr/0003-design-ownership.md
[C04]: verity-console/docs/canary-v1-results-2026-09-28.md
[C05]: verity-console/feature-assessments/e2e-111-fixes-assessment.md
[C06]: verity-console/feature-assessments/read-budget-118-assessment.md
[C07]: verity-console/feature-assessments/autonomous-console-ui-assessment.md
[C94]: https://github.com/seanerama/verity-console/issues/94
[I298]: https://github.com/seanerama/verity-dev/issues/298
[I301]: https://github.com/seanerama/verity-dev/issues/301
[I303]: https://github.com/seanerama/verity-dev/issues/303
[I311]: https://github.com/seanerama/verity-dev/issues/311
[I315]: https://github.com/seanerama/verity-dev/issues/315
[I316]: https://github.com/seanerama/verity-dev/issues/316
[I317]: https://github.com/seanerama/verity-dev/issues/317
