# SDLC Review: spec-driven-devops, Verity, and Verity Console

*Detailed history notes, failures, successes, and lessons learned, prepared 2026-09-30 as input to the spec of a new agentic-first SDLC harness that will use Claude Code and Codex CLI as coding back ends, run local-git-first, and graduate to GitHub later.*

## 0. Purpose, scope, and sources

**What this is.** A working document for the people writing the new spec. It records what each predecessor system was, how it actually behaved in use, what broke and why, what held up, and what the evidence says a successor should keep, adapt, or drop. It is deliberately dense and cites sources so claims can be checked.

**Scope.** Three systems in depth: spec-driven-devops (SDD, 2026-03 → 2026-06, and its local v2 and VibrationPlan variants), verity-framework (2026-06 → present, v1.8.0), and verity-console (2026-08 → present, v0.2.x). Four adjacent sources for context: Switchboard (the production app built with SDD whose failures motivated Verity), steer-it (a real project built with Verity in August 2026), the three-pillar vision and Agent Keep (the origin of the "mechanic" idea), and the ai-sdlc dual-backend experiment (Claude Code and Codex given the same investigation brief).

**Sources.** Repository source, git logs, CHANGELOGs, ADRs, stage specifications, promotion records, benchmark findings, canary reports, revisit audits, human test scripts, and the maintainer-interview findings from August 2026. Where a claim comes only from an operator note rather than a repo record, it is marked. Where something could not be verified, it says so.

**How to read it.** Section 1 is the executive summary and the top lessons. Sections 2 to 4 are per-system histories. Section 5 covers the adjacent systems. Section 6 synthesizes cross-cutting lessons by theme. Section 7 maps those lessons onto the rough spec for the new harness as concrete requirements and open decisions. Section 8 inventories reusable assets with paths.

---

## 1. Executive summary

**The arc.** A prose role framework (VibrationPlan, late 2025) was packaged on a borrowed engine as spec-driven-devops (March 2026), built two real products in days, and then built Switchboard, a production multi-service app, where its assumptions failed in public: nine stages marked done before CI ever ran, a hotfix treadmill of changes that passed every automated check and still shipped broken, a state file that rotted while eighteen releases went out, and a release-and-operate loop that had no owner. Verity (June 2026) was designed the day after that evidence was written down. It inverted the failure modes: state derived from GitHub instead of authored, done defined as proven on the live app, contracts frozen, a deterministic engine holding every authority the model used to hold, and an autonomy worker that stops for a human at named gates. It then spent 115 stages, most of them reacting to live runs, hardening those rules until version 1.8.0. Verity Console (August 2026) put a loopback web UI over the engine's frozen operator contracts and, in its first real session, exposed the engine's own worst usability defect. Two other efforts round out the record: a one-day agent-to-agent rewrite of SDD that was abandoned, and an August 2026 vision of three pillars (decide, deliver, operate) whose "mechanic" is the ancestor of the proposed live-managed state.

**The central finding.** Across all three systems, the failures cluster into four families, and the successful fixes cluster into four responses.

| Failure family | Representative evidence | Response that held |
|---|---|---|
| Authored state drifts | SDD's STATE.md at "Design, 44%" during 18 releases; Verity's committed usage ledger losing 9 of 14 rows | Derive state from artifacts at read time; one authoritative source per fact; event log with timestamps |
| Self-certification | agent-written tests passing over a prod bug; a UX test done as CSS math; "done" written before CI ran | A judge that did not write the code; a verifier that cannot see it; exit-code gates; a live behavioral check |
| The model holding authority | read-only sandbox breaking git; contained roles unable to reach GitHub; a stalled plan showing as a 5× win; the reviewer's approve being a merge | The engine performs git, GitHub, merges, and work-item creation from a structured result; model invoked at one choke point |
| Confident falsehood on the unverifiable | no CI read as red; unreachable GitHub read as empty; unknown cost read as $0; unknown provider at max trust; loopback assumed to be an origin | Fail closed with a named reason; unknown is its own state; allowlists not denylists; treat loopback as a network property |

**What the new harness inherits.** Roughly twenty hard-won rules and a working engine: a provider-driver seam that already runs Claude Code and Codex with different safety models; a local substrate with committed work items, engine-performed merges, and SHA-pinned exit-code gates; four gate runners; frozen operator contracts a UI already consumes; a dev-to-prod projection pipeline that has shipped seven releases; a benchmark harness that finds what unit tests miss. Section 8 inventories these with paths and a keep/adapt/drop call.

**What the record says the rough spec gets right.** Product lifecycle states as the primary axis instead of sixteen roles. Local-first with graduation at beta (designed in ADR-0028, never finished). Beta as a scrubbed repository (the promotion pipeline, already built). Per-project settings for model per role, autonomy, limits, and deployment target (all already engine settings). A mechanic for the live phase (designed as a read-only helpdesk companion in August 2026).

**What the record says to be careful about.** "Testing went overboard" is half true: the measured cost sinks were planner thrash, context bloat, and cost-gate deadlocks, not test volume; keep independence and scale down depth by lifecycle state. Secrets in a UI settings panel break a rule that has held since day one; store references and inject per role. The mechanic filing issues that a builder then works is exactly the loop the no-self-feeding rule forbids and a prompt-injection path; it needs a triage gate. Lifecycle state shown in a UI must be derived from evidence or it recreates STATE.md. Human steps must be cheap and visible or they become the step that never runs: steer-it ended with 25 judged items and zero ratified, and the console's first session was abandoned after six blockers.

**Top fifteen lessons, in one list** (each is expanded with evidence in Section 6):

1. Derive state; never author it. One writer per fact; an event log for transitions.
2. Done is a machine-verified event on a clean environment plus a live behavioral check.
3. The judge must not be the author: independent review against source, a verifier without source access, the other backend as a second seat.
4. The model never merges, never performs git, never writes the tracker, never holds a deploy credential.
5. Fail closed on anything unverifiable; unknown is its own state; a wrong answer indistinguishable from a true one is worse than a failure.
6. Gates are judged by exit code only, never through a pipe.
7. Prove the spine on an empty walking skeleton before feature work.
8. Fresh context per unit of work; delegation and lifetime rules enforced by the dispatcher, not the prompt.
9. A stub-verified external contract is not evidence; real-binary lanes for every backend; version pins derived from verified features.
10. Every external call has a deadline; a timed-out write is never blindly retried.
11. Approval consumes the exact result the human read on the exact commit; gate copy must be true for its configuration.
12. Human steps must be cheap, batchable, and visible, or they become the bottleneck that never runs.
13. Operations are first-class work: identity locked day one, secrets as locations, backups with no silent gaps, a go-live gate.
14. Run the real thing early and often; grade the artifact, not the scoreboard; instrument when stuck.
15. Write decisions down, freeze contracts additively, re-audit them as claims on a schedule, and file cross-repo asks immediately.

## 2. spec-driven-devops (SDD), 2025-11 → 2026-06

### 2.1 Lineage: three names, one codebase

SDD did not start as SDD. **VibrationPlan** (first upload 2025-11-22) was a prose framework: role prompts pasted into a fresh Claude session, growing from three prompts to fifteen AI roles by 2026-02-13 (designer, merge manager, technical writer, SRE, codebase mapper added last). Its README's role table had sixteen rows including the human Vision Lead, which is the origin of the "16 roles" headline. On 2026-02-27 the operator cloned **get-shit-done 1.21.1** and re-hosted the VibrationPlan roles on a GSD-shaped engine (`vp-tools.cjs`, `lib/{core,roles,graph,state,config,init}.cjs`, statusline and context-monitor hooks, a four-host installer). Structural diffs show the same output helper, the same model-profile shape, and the same runner; there is no attribution in the repo. That package, **vibeops** 1.0.0, became **spec-driven-devops** with an initial commit on 2026-03-02 literally titled "Initial commit: vibeops v1.0.0," rebranded 03-06, and renamed `/vp:` to `/sdd:` on 03-07. The `vp:*` and `sdd:*` skills installed on this machine are the same framework at two pre-1.4 snapshots (symlinked from the nsaf project); 1.4's sequential sub-agent orchestration was never installed here.

### 2.2 What it is

- **Fifteen registered roles** (README says sixteen) in five phases: design (Vision, Lead Architect, UI/UX Designer, Retrofit Planner replacing vision+architect on the existing-project path), planning (Project Planner), implementation (Stage Manager, multi-instance; Merge Manager on merge conflict; Feature Manager on feature request), testing (Project Tester, may edit code; Handoff Tester, documentation only), deployment (Technical Writer, Security Auditor, Project Deployer, SRE), plus Codebase Mapper anytime. Role prompts are thin, 41 to 84 lines each, mostly a numbered process that shells out to the CLI.
- **Auto-chaining.** Every role includes a generic wrapper: check dependencies, mark the role started, do the process, mark it complete with outputs, ask the graph what is next, and "if exactly one next role is available, immediately invoke it; do NOT ask the user." Multiple candidates ask; none means "workflow complete."
- **State is one hand-edited markdown file**, `sdd-output/STATE.md`, whose YAML frontmatter is regenerated from the markdown body by regex on every write. There is **no per-stage state at all**: the build step lists `stage-instructions/*.md`, sorts them lexically (so stage 10 sorts before stage 2), and "stage done" exists only as prose in a narrative doc and as merged branches. The whole implementation phase is one Stage Manager checkbox.
- **Specs as local scratch.** Planner writes stage instructions (objectives, interface contracts exposed and consumed, testing requirements, a "Pipeline Test: YES/NO" flag, acceptance criteria, dependencies) and contracts; Feature Manager writes assessments; Architect writes the plan and deploy instructions. All of it lives in `sdd-output/`, **which the framework gitignores by default.**
- **Four hosts from one markdown source** via install-time transforms: Claude Code (commands, hooks, statusline), OpenCode (permission renames), Gemini CLI (tool renames, template escaping), Codex (skills, argument placeholder). Hooks are Claude-only. No installer tests, and no evidence anywhere that a non-Claude run ever happened.
- **Its own engineering:** fifteen commits over 87 days, zero issues, zero PRs, zero releases, no `.github/` directory, a custom test runner with about 120 asserts over the registry, graph, config, and STATE.md regexes. The framework that would later be faulted for treating CI as configuration had no CI of its own.

### 2.3 Timeline

| Date | Event |
|---|---|
| 2025-11-22 → 2026-02-13 | VibrationPlan prose framework grows to 15 AI roles. |
| 2026-02-27 | get-shit-done 1.21.1 cloned; vibeops engine built on its skeleton. |
| 2026-03-02 | Repo created; npm 1.0.0 published the same evening as `spec-driven-devops`. |
| 03-06 / 03-07 | Rebrand; renames; npm 1.1.0, 1.2.0, 1.2.1, 1.3.0 (no dedicated bump commits). |
| 04-01 | nsaf built with SDD: six stages in one day. |
| 04-06 | 1.3.1: Security Auditor told to treat the code as delivered by an external vendor, to counter self-review bias; the only substantive prompt change in SDD's history. |
| 04-07 | **2.0.0-alpha.0 → alpha.6, seven publishes in about five hours** from a TypeScript agent-to-agent rewrite; never merged; `latest` stayed 1.x. |
| 04-23 | 1.3.2: require dependency pinning. |
| 05-28 | 1.4.0: fix the path-normalization bug that made status report 0% on a 75%-complete workflow; delegate stage builds to isolated sub-agents sequentially. **Same day: Switchboard's initial commit and 57 commits.** |
| 06-01 → 06-06 | Switchboard divergence log D1–D9 written. |
| 06-06 23:33 CDT | v1.4.0 tag pushed with no new commits, GitHub's "last push." |
| 06-07 00:33 → 12:16 CDT | The helper-bot feature spec, a 1,052-line forensic interview of the Switchboard build, `roles-spec.md`, `framework-spec.md`, and then **Verity's first commit**, all from the same working directory. |

SDD's last push and Verity's birth are the same UTC day, about thirteen hours apart.

### 2.4 Successes

- **Speed to a working system.** Switchboard's nine-stage hardening retrofit (CI/CD with digest images, Postgres with backups, per-agent schemas, a token ceiling, a locked job queue, a stateless two-replica gateway, container hardening with EdDSA JWT, Prometheus metrics, contract reconciliation) was built and merged in **one calendar day.** nsaf: six stages plus docs, security fixes, and a recovery plan in a day. SDD's own 1.4 feature was planned, built, and merged in about six hours.
- **Contracts as frozen mandates.** Switchboard's sub-agent contract v1 never broke across fifteen stages; twelve internal contracts lived in `sdd-output/contracts/`. Verity kept this verbatim.
- **Feature Manager intake was the best-working role.** Five real assessments, each with a claim-versus-live-codebase table, per-stage and per-contract impact, and conditions of acceptance (kill switch default off, additive migration only, suite stays green). It is what let six mid-build features land additively on a live, contract-frozen system. Verity merged Planner and Feature Manager into one intake role on this evidence.
- **Stage decomposition a different agent could build from**, proven when a second agent system built a production PR cold from a handoff brief.
- **Role separation as a quality mechanism even on one machine.** "Now act as tester, now as security auditor" kept quality up after the machines consolidated.
- **Dark-launch discipline** grew out of intake: features shipped behind default-off flags, enabled the next release.
- **The brain/notebook split** (LLM decides, deterministic CLI touches files), the CLI style (noun verb, JSON by default, `--raw`, `--cwd`), and the installer-as-runtime-adapter idea were inherited by Verity explicitly.
- **Multi-agent collaboration on plain git just worked** once `sdd-output/` was tracked: two independent agent systems, zero committed conflict markers, no bus beyond the repository.
- **Model-per-role profiles** (opus for architect and planner, sonnet for builders, haiku for the mapper) and 1.4's sub-agent isolation were sound context-engineering moves.

### 2.5 Failures and weaknesses, with evidence

**Phantom progress (Switchboard D4).** STATE.md recorded "9 stages implemented on main" on 2026-05-29 with the note "pipeline tests require the live stack, not run here." CI first ran that day and failed every run; first green came 2026-06-01 after four consecutive failures: lint never actually clean, gitleaks lacking a permission, two colliding test config files, a stub log-sink bug, a gateway suite not runnable in CI. The async-fixture debt closed on 06-03 had been hiding a real production bug (an INET column rejecting the string "unknown"). Root cause: "tests pass on my machine" is not "tests pass in a clean, schema-from-zero environment," and SDD's template only asked "Pipeline Test: YES/NO." Structural cause: the repo was born with a working gateway and no workflows directory; CI arrived as stage content, not as a gate.

**Agent-written tests that trivially passed; verification theater.** Sixteen DB-mocked unit tests were green while the Postgres-gated integration test found that every bulk import would have failed in production on a check constraint. The deploy verification script grepped a substring and the smoke script accepted "degraded." The release pipeline built and pushed images on any tag with zero tests until a Verity-era stage fixed it. The Handoff Tester's "UX session" ran with no gateway, database, or browser, computed WCAG contrast ratios from CSS hex values, handed the human a checklist, and was checked off as complete. An HTMX bundle shipped as a 472-byte placeholder; every test passed. The version string sat at 0.1.0 across five releases and two later releases collided.

**The hotfix treadmill and the lost independent tester (D7, D8).** Nineteen tags by 06-08, thirteen of them 0.3.x, eleven of those on a single day; 47 fix commits and 41 manual STATUS.md edits. A dead help button, an invisible cache-stale refresh, the HTMX stub, the version misreport: "every one passed CI and a health check and still shipped broken." On 06-03 the separate testing machine went away. Its earlier wall had produced the real bug wave (a login JSON leak, an exposed metrics endpoint, an ingest that returned ok and persisted nothing); relaxing it cost exactly the treadmill, "because the same agent that built it also tested it and shared its blind spots." No staging environment existed; production was the test bed for "does it render." The SwitchboardQA directory is that lost tester's clone, frozen at 155 commits.

**State drift and a fragile state layer.** STATE.md rotted to "Phase 1, Design, 44%" while production shipped 18 releases and still reads that way at HEAD with Deployer and SRE never run. The regex writer corrupted its own outputs table and injected an "in progress" line inside it. Two engine bugs shipped in the state layer, one fixed independently twice. The state file was the sole source of every merge conflict in stacked PRs; the effective policy became "don't have two writers." And because the framework gitignored its own state and specs, a second machine's pull saw nothing until they were un-ignored by hand.

**Scale, three kinds.** Stage count: nine role checkboxes and lexically sorted filenames versus a project that reached 69 stage files. Lifecycle shape: eighteen deploys threaded through building; CI/CD was the spine the whole time, and the linear role model "literally stopped tracking around stage 14" because the graph terminates at Deployer then SRE while a live product loops. Context and machines: 1.4's sub-agent delegation existed to save context; two agents on one repo broke the local-state assumption; sub-agent copy-paste drift appeared as near-identical wrappers across files.

**Post-deployment maintenance gap.** Deployer and SRE were never formally run on Switchboard; the release loop (bump, tag, wait for the build, hand-copy digests into a production env file, deploy, verify, edit STATUS.md) "ran 18 times unowned." Secrets were never rotated: a GitHub token pasted into a chat transcript, a throwaway superadmin password published in an onboarding doc, a database password in two places. Backups covered Postgres but not artifact bytes or the FAQ volume. Incidents accrued (a VM capacity incident, stranded ingest data, a proxy race after every recreate). An external product review on 2026-07-03 produced 35 fixes and 19 enhancements against v0.9.1, including SSRF on user-supplied URL fetch, path traversal on a client slug, a worker committing "running" before the handler with no stale-row reset, and an unbounded chat tool loop; Verity's intake verified all fifteen P1 claims true and planned them as 42 stages.

**Identity, registry, and deploy plumbing.** The registry required lowercase while the repo was capitalized; images lived under one account while the CLI authenticated as another whose token lacked package read, so every digest pull needed a second token. Branch protection was paywalled on the private repo for the entire project, so "merge only when green" stayed honor-system and one stage merged straight to main with no PR. VMs powered off most nights, the most frequent human touchpoint, with no blocked-on-human work item to represent it. A product rename reached the UI but not the API title, the startup logs, or the model prompt.

**Role confusion and missing roles.** Project Tester may edit code, Handoff Tester may not, but on one machine both were the builder. Merge Manager was used to integrate rather than to resolve conflicts. Work with no role at all: release operator, STATUS scribe, handoff-brief author, PR reviewer for another agent's security invariants, operator coordination, and the divergence log itself.

### 2.6 What the local variants reveal

- **spec-driven-devops-v2 (2026-04-07)** was a one-day TypeScript rewrite around an agent-to-agent orchestrator: typed task and result envelopes, a chain builder, retry and reroute, "generative work to Claude Code, security and review to Codex," API adapters for Gemini and Ollama, a code-critic role, and an autopilot mode. Forty-six source files, alpha.6, never merged, no written reason for abandonment. Two of its instincts resurfaced in Verity in different clothes: an adversarial second party (Verity: a reviewer with no merge tool plus a deterministic ladder) and headless execution (Verity: `agent-exec` and the worker with per-role allowlists). Verity implicitly rejected v2's core move by keeping roles as harness-native prompts over a deterministic CLI rather than an API orchestrator.
- **vibration-plan-v2** is misnamed: it is the SDD 1.4 working checkout and Verity's birthplace. Untracked in it sit the forensic interview, the helper-bot spec, the roles and framework specs, and a marketing layout noting that the `verity` npm name was taken as of June 7.
- **SDD's own four post-launch changes** each answered one observed failure (self-review bias, unpinned dependencies, the status bug, sub-agent context). None touched CI as a gate, live verification, deploy and operate, or derived state. The real fix attempt was the Switchboard divergence log, whose proposed changes (track the output dir, issues as the defect channel, PR plus CI as integration, "stage complete means CI green," an operator runbook with blocked-on-you items, STATUS as runtime truth, roles on separate agents, opt-in multi-agent, handoff brief to PR to review and deploy) became Verity's requirements the next day rather than SDD 1.5. Switchboard itself switched to Verity on 2026-07-01 and marked its SDD output directory as a deprecated historical record.

### 2.7 Lessons from SDD

1. "Done" must be a machine-verified event in a clean environment, never a checklist write; the harness must be unable to record completion without a check-run identity.
2. Prove the whole spine on an empty walking skeleton before feature work; the trivy tag bug, the HTMX stub, the registry identity, and the database wiring would all have surfaced on a one-route app.
3. CI and health checks are blind to "does the button work"; add a live behavioral gate and a staging environment.
4. Keep an adversarial verifier that cannot see or edit the code, as a phase, not a machine. Do not let a UX test be static analysis.
5. Never author project state in a mutable file; derive it from the substrate. Commit specs and runtime truth; compute progress at read time.
6. Per-stage state must be first-class; roles are not the unit of progress.
7. Model a stream of stages over an always-on pipeline, not a one-pass graph that ends at deploy.
8. Give release, deploy, and operate an owner and automate the mechanical steps: version from tag, auto-pinned digests, auto-changelog, a single-writer schema'd status file.
9. Commit the specs by default; the framework's state must survive a `git pull`.
10. The coordination bus is the repository and nothing else; add typed issue templates and a blocked-on-human work item with an explicit unblock signal.
11. Assume the integration gate may be unenforceable and degrade honestly.
12. Lock identity on day one, generated not typed.
13. Treat operations (intermittent environments, secret lifecycle, backups, go-live cleanup) as first-class work, not epilogue.
14. Two-tier mandates with every deviation recorded: contracts, guides, ADRs.
15. Intake before build, every time, with acceptance conditions the harness can check.
16. Dogfood the harness's own discipline: a harness that gates others must gate itself.

## 3. verity-framework (2026-06-07 → present, v1.8.0)

### 3.1 What it is

A clean-room successor to spec-driven-devops 1.4 (concepts kept, no code), generalized from the Switchboard production build. One npm package, zero runtime dependencies, two binaries: `verity` (deterministic engine, ~29k lines of CommonJS across 59 files) and `verity-worker` (headless autonomy, ~3.6k lines). Sixteen roles installed into Claude Code, Codex CLI, or OpenCode. Twelve frozen contracts, 38 ADRs, 115+ stage specs, ~1,600 tests. Thesis: **"done" means reviewed against source, merged green, released, deployed, and observed working on the live app**; state is derived from GitHub, never authored; the AI decides and a deterministic tool records; contracts are frozen and additive; fail closed on anything unverifiable.

Verity's own account of what it kept from SDD: brain/notebook split, role sequencing, contracts-first, intake assessment, stage decomposition, specs as committed artifacts. What it added: CI/CD as a *proven* gate (walking skeleton), live verification (Handoff Tester + UI-smoke), the production lifecycle (release/deploy/STATUS/SRE/golive), identity locked day one, and later the autonomy worker.

### 3.2 Timeline (condensed)

| Date | Milestone |
|---|---|
| 2026-06-07 | Whole framework in 20 commits; v0.1.0 same day. First tail-swallowed lint failure 81 s after a commit. |
| 06-09 | v0.2.x: deployment-methods catalog; transactional `release cut`; a doc with personal infra details scrubbed from history (seed of the dev/prod split). |
| 06-10 → 06-13 | Autonomy plan frozen (T01–T15); all 15 tasks land 06-10; v0.3.x cut in the `verity-auto` fork. |
| 06-13 → 07-25 | 42-day gap. |
| 07-25 | Fork merged back as v0.4.0; knowing spike NO-GO (ADR-0001 rejected). |
| 07-27 | v1.0.0: "certifies a demonstrated system", remote CI green + one supervised canary cycle on verity-skeleton-demo. |
| 07-28 | v1.0.1 / ADR-0004: executor lifetime = one stage (a reused executor hit 300k tokens by stage 27). |
| 07-29 | v1.1.0: Codex support (skills adapter, driver seam ADR-0005, headless driver, portable policy ADR-0007, unknown-cost ADR-0008). Last dev-repo tag. Same day: external review finds Codex enforcement is a no-op. |
| 07-30 → 08-04 | 39 stages in 6 days, each named after a live-canary defect. ADR-0011 containment, ADR-0012 Verity performs git, ADR-0013 Verity talks to GitHub, ADR-0014 approval consumes parked result. Canary run 5 (08-01) first full chain. |
| 08-04 | Busiest day (39 commits): dev/prod split + promotion pipeline (ADRs 0015–0023); five operator contracts frozen for the console. v1.2.0 via PROM-0001 (08-05, manual npm publish). |
| 08-06 → 08-13 | Benchmark harness (ADR-0025); live runs produce ADR-0026 worker-owned work items, ADR-0027 CI grace, plan-trigger fix. |
| 08-19 → 08-23 | Fresh step 1 (local substrate, ADR-0028/0029) + gate-runner axis (ADR-0030); v1.3.0 (PROM-0002). |
| 08-27 → 08-31 | Runtime-truth stamping; context-discipline reland (stage 92); OIDC trusted publishing decided; provider trust table (ADR-0031, stage 94). |
| 09-08 / 09-22 | Revisit role (ADR-0032). Second run: "Nothing moved." |
| 09-22 → 09-28 | 17 stages, 4 releases (1.4.0 → 1.7.0): intent artifacts (ADR-0033), split-aware release truth (ADR-0034), test-runner honesty, contract pins (ADR-0035), ledger in git-dir (ADR-0036), no headless delegation, timeouts, trust-0 approval merges (ADR-0014 amended, ADR-0037), idempotent writes. |
| 09-29 | ADR-0038 + stage 113 `verity init`; v1.8.0 shipped 09-29. Stages 114–115 planned. |

Two big remediation bursts (stages 10–38 and 96–112) account for over half of all stages. Both were triggered by *live runs* (Codex canaries; benchmark + revisit), not by CI.

### 3.3 What worked (with evidence)

- **Derived state.** No progress file ever drifted; the same derivation served the CLI, the worker, the console, and the benchmark. The one place state was authored (the committed usage ledger) is the one that broke (ADR-0036).
- **Authority split.** After ADR-0012/0013/0026/0033, no model performs git, GitHub writes, merges, or work-item creation. Every incident where the model held authority (read-only FS, denied network, stalled plan) disappeared once the engine took the action.
- **Fail-closed honesty rules** caught real problems repeatedly: unknown CI (stage 19), unverified state (20), unknown cost (18), untiered provider (94), ledger path (112). Each was a confident falsehood before the rule.
- **Independent review + verifier without source access** is what made Verity trustworthy where SDD was not. Reviewer verdicts matched the code in graded benchmark runs (Codex's own `request_changes` on committed bytecode was a legitimate catch).
- **Frozen contracts with pin tests** let a separate console repo depend on the engine across 6 releases; a reviewer caught an in-place edit of frozen text (PR #297) and the project published `operator-act` v2 instead.
- **Promotion pipeline** (dev private → prod public projection, fail-closed classification allowlist, sanitized changelog, PROM records, OIDC publish with provenance) shipped 7 releases without a leak.
- **The benchmark harness** found every serious bug the unit suite missed and produced a genuinely counterintuitive result (Sonnet planner made an Opus build 50% costlier).
- **Real-project throughput:** steer-it was scaffolded by Verity on 2026-07-31 and reached a locally deployed v0.9.21 by 08-05 (77 stages, 30 ADRs, 176 commits by 08-11). Verity built all 115 of its own stages the same way.
- **The revisit role** worked as a forcing function: its "nothing moved" report produced 17 stages in 7 days.

### 3.4 What failed (incident register)

| # | Incident | Symptom | Root cause | Fix | Lesson |
|---|---|---|---|---|---|
| 1 | Tail-swallowed lint (06-07, 07-25) | Failing checker reported clean; 5 errors merged | Pipeline exit status = last command's | Exit-code-only gates (ADR-0028), inherited stdio, `--error-on-warnings` | Judge gates by exit code, never through a pipe |
| 2 | Codex enforcement no-op (07-29) | `rules_file` silently ignored; 567 stub tests green | Tests ran against a fake Codex; `codex exec` ignores permission profiles; child env passed every credential | ADR-0011 containment: credential passlist, post-run invariants, tier-2 workspace, unenforceable-policy refusal | "A stub-verified external contract is not evidence"; the model never polices itself |
| 3 | Headless Codex 0% success (stage 15/16) | Every run `turn.failed`, error `"{"`; test lane could never auth | `--output-schema` used `allOf`; error normalizer showed first line; lane redirected HOME | Drop flag, surface `.error.message`, real-binary lane, ATTEMPT rule | A test that cannot fail, or never tried, proves nothing |
| 4 | Read-only FS in sandbox (07-31) | build could not branch/commit | Model performing git inside containment | ADR-0012: Verity does git before/after dispatch; explicit fork base | Write boundary belongs to the engine |
| 5 | No network in sandbox (08-01) | review comment died; build's state read refused | Model talking to GitHub inside containment | ADR-0013: state snapshot in, effects channel out | Reads before, writes after; effects are an allowlist |
| 6 | Unknown cost = $0 (stage 18) + breaker deadlock (21/25/30/32) | 1¢ budget cleared; then every Codex worker wedged after first run | Empty cost cell summed as 0; startup breaker ran before approval path | Verified vs unknown spend; approvable gate; verified $0 rows; refusal never consumes approval | Unknown ≠ 0; two correct guardrails can deadlock |
| 7 | Executor context bloat (ADR-0004) → architect built inline 346 turns (stage 92) → headless build delegated into void, 465k tokens (stage 109) | Runaway cost / wrong role doing the work / wasted tick | Unspecified lifetime; contradictory prompt; allowlist omission doesn't block never-prompting tools | One stage per executor; delegation preamble; explicit `--disallowed-tools Agent Task ScheduleWakeup Workflow` | Make lifetime and delegation structural, not prompted |
| 8 | No-CI read as red (stage 19); duplicated summary tripped breaker (112) | Stage never left `building`; breaker fired after 1 run | Boolean CI; retried non-idempotent write | Three-state CI; no-progress breaker; idempotency classes + read-after-ambiguous | Unknown is its own state; timeouts never duplicate a write |
| 9 | Unreachable GitHub = empty project (stage 20); wrong-repo read (23) | Confident false state at exit 0; review told "no PR" | `catch { return null }` → `[]`; `--cwd` honored by half the read | `verified` stamp; refuse (exit 30); gate `state:unverified`; two-repo guard test | A wrong answer indistinguishable from a true one is worse than a failure |
| 10 | Approval re-ran the role (ADR-0014) → trust-0 approval never merged (stage 111) | Review ran 3× per PR, flipped verdict; $1.47 re-bought per click; loop unfinishable | Gate was a toll booth; `decideMerge` had no approval input | Parked result + pointer + park.json; label = merge decision at trust 0; head pinning; provenance + push-event checks | Gate copy must be true for its config; approval consumes the exact result on the exact head |
| 11 | Work-item drift (ADR-0026) | Codex runs stalled at plan; scorecard showed "5× efficiency" | Contained plan cannot `gh issue create` | Worker reconciles stage files → issues (4 follow-ups found live) | Side effects a contained role cannot do belong to the engine |
| 12 | Just-opened PR gated `ci:unverified` (ADR-0027) | Healthy stage parked for a human | Checks register 7–18 s after open; clock skew −7.5 s | 90 s grace → `waiting_for_ci`; skew tolerance | Instrument when stuck; grace defers, never advances |
| 13 | Plan re-planned every tick (stage 73) | 54% of a heavy run spent re-planning; prompt fix made it worse | Loop dispatched plan for any open request | Retire trigger once stages exist | Control-flow bugs need code fixes, not prompt fixes |
| 14 | Branch-bound ledger (ADR-0036) + fail-open path (112) | 9/14 rows lost; budgets under-enforced | Ledger committed on stage branches; any git error fell back to stale file | `<git-dir>/verity/usage.csv`; `LedgerPathError` | Spend-gating state must be branch-independent and fail closed |
| 15 | Intent artifacts never committed (ADR-0033; 42 days open) | Plan/revisit outputs untracked on both providers | `git_write:false` roles had no commit path | Engine commits engine-owned roots after the verdict | Every artifact needs an owner with a commit path |
| 16 | Provider denylist of one (ADR-0031) | New runtime landed at max trust by omission | `if codex` branches everywhere | Engine-owned trust table; untiered ⇒ refused | Absence must never grant anything |
| 17 | Test-runner dishonesty (stage 99) | Async tests passed vacuously; a skip counted as pass | Runner never awaited; ad-hoc skips | Promise ⇒ fail; tallied skips; forbid-skips flag | The test runner is a gate too |
| 18 | Release truth drift (ADR-0034; stage 91) | Dev derived release from a hand mirror tag; STATUS stale at 1.1.0 across two promotions | Two homes, one truth source assumed | Derive from PROM records; finalize stamps runtime | Every duplicated truth needs one authoritative source |
| 19 | No-self-feeding hid the plan role (stage 28) | Plan never exercised in canaries | Single-account setups look self-authored | Loud idle note; later ADR-0038 intake register | Security rules need observability, or they hide gaps |
| 20 | Local network outage, ~110 min stall (stage 110) | Worker alive with nothing to show | No timeout on any gh/git call | Deadlines everywhere; transient retry classes; harness offline budget | Every external call has a deadline |

### 3.5 Benchmark evidence (what the numbers actually say)

- Fixture D (control) on Claude Opus: 861 s, 3.83M in, $4.97 (Aug); $6.16 with per-role models on the GitHub substrate (09-25), stages 1–2 auto-merged at trust 2.
- **Cheaper planner cost more:** plan=Sonnet → +17% cost, +33% time; the plan made the Opus build 50% costlier.
- **Early Codex N=3 "5× win" was VOID** (stalled at plan). Later valid runs: Codex ~1.8× faster and ~3.7× fewer tokens on C, ~5× fewer on A while building *more* stages; graded 15/20 vs Claude 20/20 (C) and 15/20 vs 19/20 (A). Codex weaknesses: hygiene (committed bytecode), over-applied kill switches, no CI test-gate stage. Claude weakness: planner thrash (~4M tokens, #202). **Plan quality depends on a decided architecture being provided.**
- Fixture A (Star Lab) 09-25: 10 stages planned (rule says 3–5), stages 1–6 merged first-review, 16.4M in / 145k out, $16.07; gated on a substantive `request_changes`. Found: branch-bound ledger, headless delegation, no-timeout stall.
- Methodology: grade the repo, verify the wiring, instrument when stuck. **Every serious bug was invisible to green unit tests.**
- Open observations: `request_changes` at trust 2 → human gate with no fix round; `max_tokens_per_run` counts cache reads (a single Sonnet build can trip 2M); transcripts collide within a run; `human_grade` never recorded in a result file.

### 3.6 Structural costs Verity paid (the "why it slowed down" list)

- **GitHub as substrate** brought the lock, audit, approval token, and gate UI for free, and also: provisioning races, label-write lag, CI registration lag, Actions cost on private repos, rate limits, and a hard online requirement. Fresh (local substrate) exists but cannot graduate.
- **16 roles** with overlapping mental models (test vs verify vs review; ship vs sre vs golive; plan vs architect). Users needed a role-to-purpose table (stage 104) and still found it confusing.
- **Human gate = GitHub label + comment** forced a lot of machinery (park pointers, park.json, timeline provenance checks, A→B→A defense) that a UI with its own authenticated approve button would not need.
- **Interactive sessions are unmeasured** (only `agent-exec` writes the ledger), so half the cost picture is missing.
- **Per-run token ceiling counts cache reads**, so limits were tuned around an accounting artifact.
- **Two remediation bursts** (56 of 115 stages) were reactions to live-run findings; the unit suite (stubbed spawns) gave false confidence for Codex in particular.
- **Docs drift**: autonomy.md "dark today" for a live feature; label counts; ledger path in invariants; sketch's comment approval. The revisit role is the countermeasure, not a fix.

### 3.7 Backend lessons: Claude Code and Codex CLI

Verity runs both back ends behind one provider-driver seam (`verity/bin/lib/agent-exec.cjs` as the runtime-neutral coordinator; `verity/bin/lib/agents/{claude,codex}.cjs` as drivers; a two-entry registry). The seam is grep-asserted to contain no provider wire strings, every knob is "omitted-in" so absent flags reproduce a byte-identical earlier argv, and a driver that does not implement an optional capability causes the coordinator to reject the flag rather than ignore it. Its GitHub coupling is small: a footer sentence in the result contract, a "read from GitHub" label on the state snapshot, the names of GitHub token variables in a credential group, and the PR-opening half of the git lifecycle, which runs only when `github_write` is granted.

**How the two differ in practice**

| Axis | Claude Code | Codex CLI |
|---|---|---|
| Invocation | `claude -p <prompt> --output-format stream-json --verbose --max-turns N [--model m] --allowed-tools … --disallowed-tools Agent Task ScheduleWakeup Workflow` | `codex exec --json --sandbox <mode> --output-last-message <f> --cd <cwd> -c approval_policy="never" --ignore-user-config [--ignore-rules] --disable multi_agent [--model m] -` with the prompt on stdin |
| Permission model | Per-role `.tools.json` allowlist enforced by the harness at write time | Per-role capability policy → sandbox mode + credential passlist + post-run invariants; nothing on Codex enforces per-path or per-command policy |
| Child environment | Inherits the parent | Constructed allowlist: about 30 baseline variables plus capability groups (`github_write` unlocks GitHub tokens; `deploy` unlocks 19 cloud and registry variables) |
| Cost reporting | `total_cost_usd` verified; input counts include cache creation and cache reads | Tokens only; `est_usd` is always null and is never summed as zero |
| Result channel | Last `type: result` stream line plus the marker | `--output-last-message` file parsed as a structured result, validated; a structured success that contradicts a transcript failure is `invalid-result`; `turn.failed` is an infra error, never a guessed success |
| Turn limits | `--max-turns` (default raised 40 → 80) plus a timeout | `--max-turns` rejected by design (ADR-0008); timeout only |
| Git and GitHub | Harness performs its own git and GitHub reads | Verity performs git outside the sandbox (ADR-0012) and attaches a state snapshot before the run (ADR-0013) |
| Containment | None; tier 2 rejected | Tier 1 default; tier 2 sparse worktree with all-or-nothing gated merge-back, required for autonomous mode |
| Verified minimum | 2.1.170 (verified 2026-06-10, re-verified on 2.1.281 on 2026-09-24) | 0.146.0, derived as the newest verified row of a feature matrix |

**Claude Code lessons**

- `--allowed-tools` only pre-approves tools that would otherwise prompt. `Agent` (renamed from `Task`), `ScheduleWakeup`, and `Workflow` never prompt, so they run whether listed or not. Probe A: allowlist of Read and Glob, the Agent call still succeeded with an empty denial list. Probe B: `--disallowed-tools Agent Task` produced "tool not available." Every headless argv now ends with the fixed deny list and the allowlist loader refuses any tools file that names a denied tool, including cased and comma-smuggled variants. The benchmark's first proposed fix, "drop Task from the allowlist," was wrong; removal denies nothing.
- The failure that taught this: tick one of the September fixture-A run, the build role called Agent twice and ScheduleWakeup once, ended its turn "waiting for the executor's completion notification," and in `-p` mode there is no later turn: eleven turns, 43 seconds, 465k tokens, nothing committed.
- `stream-json` requires `--verbose`; the final line carries `subtype`, `is_error`, `num_turns`, `total_cost_usd`, `usage` with cache fields, and `permission_denials`. `--max-turns` is accepted but hidden from help; it was verified by a differential probe with a bogus flag.
- Auth is either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`; never both, because the key silently wins. The subscription path stops when the monthly credit is spent.
- There is no automated real-`claude` test lane. The primary driver is exempt from the framework's own evidentiary standard, and the August external review called this out.

**Codex lessons** (from the readiness review CDX-001 through 009 and the 0.146.0 and 0.154.0 canaries)

- `-c rules_file=…` was not a Codex mechanism; `-c` absorbs unknown keys silently. `exec` ignores permission profiles; filesystem deny fails open for writes; the command filter never matches because every command is wrapped in a login shell; a malformed config makes commands silently not run, producing false "denied" readings until a liveness marker was added to every negative test. Response: containment, not restriction (ADR-0011).
- `--output-schema` with `allOf` returned HTTP 400 and killed every run; the error normalizer showed a single brace. Removed; `failureText` now unwraps nested JSON error messages.
- The transcript item field is `item.type`, not `item.item_type`; `exec --json` on 0.154.0 omits command-execution items for commands that exit non-zero, so tool-call counts undercount.
- `exec` appends a `trust_level = "trusted"` entry for the working directory to the user's config file **despite `--ignore-user-config`** (finding F-D, recorded as an open security-invariant caveat). Tier-2 workspaces leak empty directories per run (F-C). Fixture directories leak in `/tmp` (F-E). Positional arguments were dropped for roles without a placeholder on both drivers (F-B, fixed).
- Network denial is unenforceable on the exec path and is refused unless acknowledged; a `CODEX_SANDBOX_NETWORK_DISABLED` variable in the child environment is not proof of enforcement.
- Codex has `multi_agent` on by default at both verified versions; it is disabled with `--disable multi_agent`, which fails loudly on unknown names, whereas the `-c features.x=false` form is silently absorbed (the CDX-002 trap again). Rule recorded: never assert a provider capability without running its features list.
- Under a tier-1 network-disabled sandbox **no role can complete** (GitHub unreachable; state read refuses), which is why reads move before dispatch and writes after.
- Local model via Ollama (0.146.0 with ollama 0.32.14): a custom provider with the responses wire API delivered every tool call with an empty name; the built-in `--oss --local-provider ollama` path worked; zero cache hits every turn (2.59M in for 29k out in 29 minutes), time to first token up to 85 seconds, silent completion, work left uncommitted. Verdict: interactive roles workable; unattended build and review questionable because fresh-context-per-dispatch re-pays the no-cache tax.

**What a third backend needs.** A driver module with the mandatory members (binary resolution, version check, policy read, prompt render, execute, transcript parse, usage and result normalization); a registry entry; provenance-labelled fixtures; a minimum-version key and a doctor row; inclusion in the provider-contract test suite; and, separately and ADR-gated, a row in the trust table before the worker may select it. A driver never declares its own tier.

**For the new harness.** Keep the seam and both drivers. Unify the two permission vocabularies (the Claude tools file and the runtime-neutral capabilities file are separate systems with no cross-check, and no installer copies the capabilities file). Generalize the credential passlist and post-run invariants to every backend, including Claude. Add a real-`claude` lane. Treat the two back ends as independent seats for judgment work.

## 4. verity-console (2026-08-05 → present, v0.2.1)

### 4.1 What it is

A local-first Node HTTP server bound to loopback that obtains every fact by spawning the `verity` CLI from a **fixed command registry** and serves a hand-written, zero-build HTML/JS page that polls it. Zero runtime dependencies. About 19,300 lines (server 3,600; lib 4,500 over 15 modules; front end 11,200), 70 test files with ~1,100 test registrations, 106 commits on seven active days, 51 merged PRs, 51 merged stages, 14 committed ADRs (17 in the working tree), 21 feature assessments, three published releases (v0.1.0 on 09-29; v0.1.1 and v0.2.1 on 09-30; v0.2.0 tagged but never published after release smoke failed).

Its five hard invariants, each stated in `docs/architecture.md` and pinned by a test: **not a second state machine** (renders operator output, never infers a transition; the NOW panel selects one of N states, it does not derive new ones); **not a merge path** (every act is `verity operator act <verb>`; there is no merge verb); **not a model caller** (it launches engine processes and observes); **not required** (every action has a CLI or label equivalent; the kill switch works with the console down); **loopback only, one operator, no multi-tenant plane**. Supporting mechanisms: per-param argv validation before spawn, never a shell; CSRF token plus origin agreement, later preceded by a Host allowlist (ADR-0010) after DNS rebinding was found; a redacted JSONL audit line for every mutating attempt including refusals; 21 written security invariants each with a pinning test.

### 4.2 Timeline

- **08-05, creation and P1 through P4 in one day.** Scaffolded by Verity; ADRs 0001–0003 (separate repo, fixed registry, Architect owns visual design). P1 read-only (snapshot, cards with evidence provenance, Work + Runs). P2 human gates (`POST /api/act`, CSRF + audit, no merge authority; Approvals view). P3 Policy/Usage/Health, async run-once with 202, circuit open/close. P4 fleet spike: `fleet.json` allowlist, default-off flag, fail-closed fan-out, read-only cards, drill-in. Cross-repo acting (ADR-0006) closed a latent wrong-repo hazard: a drilled-in read scoped to repo X while an act hit the ambient repo.
- **08-06 to 08-08, benchmark surface.** Config loader behind a two-part dark gate, fixed-runner async trigger, dashboard, per-role usage, config editor, spec preview, sandboxed spec upload (ADR-0007/0008).
- **08-14, the Meet-Proxy session.** First real end-to-end use at trust 0. Operator blocked six times, abandoned the console for the CLI, $10.49 spent. Recorded in the Mission Control redesign handoff.
- **08-17/18, Mission Control redesign.** ADR-0009 log-mtime liveness; NOW panel, live-run state, stage map, inline gate actions, setup screen. Then a **37-day gap**.
- **09-24, revisit.** Sixteen-row claim/reality audit found the DNS-rebinding CSRF bypass, doc rot, synchronous spawns freezing first paint, and four engine asks that had never been filed.
- **09-28, hardening day (27 commits).** Approve copy from the engine's `effect.consequence`; honest run-once copy; config editor preserves unmanaged keys; Host allowlist + CSP; untrusted-input handling; resilience (spawn-error crash, 90 s timeout, one in-flight per target); repo resolved from git config (ADR-0011); async exec; faster first paint; honest states. Canary v1 that night: **FAIL, do not promote**.
- **09-29.** ADR-0012 (every fleet entry names a local clone; child cwd and `GH_REPO` per repo); canary criteria re-run pass; go-live gates answered; **v0.1.0 released**; New project flow on `verity init` (ADR-0013) once engine 1.8.0 landed.
- **09-30.** End-to-end findings on two throwaway projects; read budget (ADR-0014, shared 30 s cache with honest age); v0.1.1; v0.2.0 tagged then pulled after the first screen was a wall of errors on a no-repo start; v0.2.1; per-release human test scripts. Uncommitted: ADRs 0015–0017 (visual system, policy writes via the engine, a console-side autonomy runner with Stop now) and stage specs 52–57.

### 4.3 Incidents

**The Meet-Proxy six (08-14).** Header showed `REPOSITORY —` because repo targeting was inherited from environment and undocumented. A refused run-once vanished: audit logged "started" at spawn, the engine's refusal surfaced nowhere, "watch Runs" stayed empty forever. No launch button on the page the operator was looking at. Tick rhythm untaught ("it seems stuck again" three times). A 21-minute build tick with zero feedback; Runs is ledger-backed so rows appear only at role end. And the critical one, **F6: trust-0 approve was a paid trap**: approval spent $1.47 re-running an unchanged review and re-parked with the identical prompt. Root cause was engine-side (`decideMerge` ignored the label; parked verdicts re-dispatched) and became engine stage 111 in v1.7.0. The console's own copy "Approve (does not merge at trust 0)" then became false in three places plus a dead hook, fixed by reading the engine's consequence. The four engine asks from this session **sat unfiled for 37 days** while the trap stayed live.

**DNS rebinding (09-24 revisit).** No Host check anywhere; CSRF trusted a same-origin fetch header; the CSRF token endpoint was readable to a rebound page, giving full bypass of approve, run-once spend, and circuit, and with the benchmark on, config writes and a 256 KB arbitrary file read. "26 stages were adversarially reviewed and nobody caught the missing Host header. The threat model stopped at 'binds 127.0.0.1'."

**Browser smoke (09-28).** The `hidden` attribute was overridden by class display rules (2 visible, 36 latent) and tests never caught it because the DOM shim had no CSS. "Start from the repo dir" did not work on engine 1.7.0 (`repository: null`). Synchronous spawns serialized reads so the first NOW paint took 10–15 s. A detached spawn without an error listener crashed the process after the 202 was already sent when `verity` was missing.

**Canary v1 (09-28), verdict FAIL.** F1 blocker: **`--repo` scoped only the GitHub calls**; policy, stage ledger, and usage ledger came from the process cwd, so a throwaway's fleet card showed the console repo's own 39 stages, and a cross-repo run-once would have dispatched repo A's stage 1 against the throwaway under repo A's trust ladder. F2: run-once output discarded, so manual-mode or early-exit ticks were invisible. F3: single-repo confirms and audit never named the target. F4: oversized body destroyed the socket before the 413, so Chromium retried three times. Plus a stage map that fabricated "No work items" during a 504, a global run-state that reported a 3-day-old run from an unrelated repo, and a 3-repo fan-out that brushed the 10 s timeout. **Approve-to-merge on a real gate was waived**: no gate existed and creating one meant model spend, so that path has never been verified end to end.

**`circuit_open: true` with no issue.** An engine fact: on 1.7.0 the snapshot's circuit flag was "label present OR mode manual," so every repo without a policy file read as circuit open. It resurfaced as a fabricated "CIRCUIT open" on the v0.2.0 first screen and as a design constraint for the autonomy runner: nothing exposes which issue is the circuit, so the console must store the intake issue number or ask once.

**New project end-to-end (09-29/30).** Creation, intake labels, "waiting to be planned," and the spec-soundness park with six named gaps all worked. Findings: one tick planned for ten minutes and then built stage 1, because `max_chained_roles` defaults to 6 and the starter policy did not set it while the copy promised "plans this project"; the running tick was not shown because the snapshot never reports a lock on the GitHub substrate, so NOW said Ready mid-tick; a GraphQL rate limit rendered "Ready" with the whole error as the button label. Killed ticks leave a lock label, a dirty branch, and no usage row.

**Rate-limit exhaustion (both e2e runs; affected v0.1.0).** Five-second polling times three reads times about three GraphQL calls each is roughly 6,500 calls per hour against a 5,000 allowance, **and it starved the worker sharing the same `gh` identity**. Root cause was ADR-0001's "live view, never a cache" rule plus per-tab timers, hidden tabs polling, no backoff, and unguarded fan-out. ADR-0014 added a 30 s shared server cache keyed by verb, params, repo, and cwd, invalidation on acts, escalating backoff, hidden-tab pause, and honest `fetched_at`/`age_ms`/`cached` on every response. Measured: 910 calls per hour with the cache versus about 6,200 without; hidden tab zero.

**v0.2.0 first screen.** A no-repo start led with "Unknown: GitHub state could not be read," three "fatal: not a git repository" lines, a retry countdown, an empty stage map, and a fabricated circuit state, because the Unknown and backoff paths were designed for a known repo GitHub cannot reach and the engine's no-repo snapshot has the same shape. Fixed by keying on repository resolution, with a regression test on the **real engine fixture** "so this can't slip through a tidy fake again."

**Config editor destroyed unmanaged keys.** Saving dropped every key outside the five managed fields, including the engine's real limits and the seed token env name; fixed by a server-side merge onto the on-disk file rather than letting the browser echo unknown keys.

### 4.4 Design decisions worth carrying forward

- **Three evidence channels rendered differently:** substrate-observed and harness-observed at full weight; agent-reported as a muted claim; configuration echoed as if observed is also a claim; derived views name their source.
- **The NOW panel: exactly one of Refused, Waiting on you, Running, Ready, Idle** (later Loading and Unknown; never Ready when the substrate is unreadable), by a fixed human-urgency-first priority, with one primary button labeled by the engine's own next reason and a shared disabled-with-reason precedence so two screens cannot drift.
- **Name the unit of work from the engine's policy, not the UI's mental model.** "One click is one tick" had to be reworded when a tick chained plan then build.
- **Observe many, command one**; blast-radius confirms name the target and the consequences in the engine's terms; acting from the index declined so the index can never mutate.
- **Fixed registry, capability detection from the engine's own command list** (not a version guess), engine version pinned like a dependency floor. Weak spot: the contract is not mirrored locally, so shape drift is invisible to unit tests.
- **Audit every mutating attempt including refusals; 202 only on the child's spawn event; one in-flight per target; per-launch logs.**
- **Spec upload as content, never a path; basename only; size caps; atomic write; inert.**
- **Every net-new surface behind a default-off switch, flipped by a recorded operator decision.** Claim/reality tables in every intake. Human test scripts as release artifacts ("don't read the source; report what you see").

### 4.5 What did not work or is still awkward

- **Polling, not events.** Even after the cache, one repo costs about 1,080 GraphQL calls per hour. There is no event log, no heartbeat, and **no lock is reported on the GitHub substrate**, so a tick started by cron or the CLI is invisible and a second tick is invited. "Running" is shown only for ticks this console launched.
- **Transcript locality.** The operator cannot see what the agent is doing mid-tick; the 21-minute silence is mitigated by mtime liveness, not solved.
- **Dependence on GitHub-derived state**: work list empty when unreadable; circuit guessed; three fetches per refresh; auth failures look like rate limits; the worker and the console share one identity and one budget.
- **Local-state-in-cwd model**: fleet needs a hand-maintained clone per repo; policy writes land uncommitted in that clone; init leaves the chained-roles default at 6 so the README tells users to run a CLI command before pressing Start.
- **Test-honesty gaps**: DOM shims without CSS, fixtures shared between tests and view-models, no per-test timeout, a first screen hidden by a tidy fake.
- **Never verified end to end**: approve-to-merge on a real gate; the benchmark trigger. Nineteen open follow-up issues, none blocking.

### 4.6 Lessons specific to a UI-first harness

1. The UI must never own lifecycle truth, but it must own honest presentation of it. Every incident that mattered was a presentation lie about engine state.
2. A lifecycle stage shown in the UI must come from a durable, single-writer, timestamped record, not be re-derived from substrate reads. Give the engine an event log and a run-state heartbeat from day one; transitions are events the engine emits.
3. Design the "what is happening, what waits on me, what happens if I press this" panel first, with exactly one primary action.
4. Make liveness first-class: elapsed, last-activity age, a bounded output tail. Prefer a server event stream over polling an expensive substrate.
5. Budget the substrate: the UI must not share the worker's identity or starve it; show the remaining allowance.
6. Confirms name the target and the blast radius in the engine's terms.
7. Per-project settings need one allowlisted, per-key-validated engine verb with a confirm for anything that expands authority; never a UI editing YAML.
8. Hold no secrets in the UI process; record locations; redact at every exit with patterns for every provider.
9. Treat loopback as a network property: Host allowlist first, CSRF, strict CSP, body caps, security invariants written before the reviewer enforces them.
10. A fixed registry beats a generic run endpoint; adding capability means adding a validated row.
11. Autonomy needs a brake the UI is not required for, a per-project switch that defaults off, and a Stop whose leftovers are stated.
12. Spec-first project creation is an engine verb with a soundness gate; a starter policy should plan-then-stop so the operator reviews the plan before a build spends money.
13. Test against the real engine's outputs; capture real fixtures; run a dated real-instance canary before each release.
14. File cross-repo asks immediately; four engine asks sat unfiled for 37 days while a paid trap stayed live.

## 5. The adjacent systems

### 5.1 Switchboard: the origin project

Switchboard was a multi-service AI application (gateway, per-agent sub-agents behind a frozen contract, Postgres, workers, a help agent) built largely by AI agents with SDD from 2026-05-28, switched to Verity on 2026-07-01, and operated in production through at least 2026-07-09 (295 commits, 111 PRs, issues to #189, 69 stage files). Its role in this history is as the evidence base. Every place the build diverged from the standard single-agent flow was logged, D1 through D9, between 06-01 and 06-06, and a 1,052-line forensic interview of the repository, CI, and PRs was written the night before Verity's first commit. The divergences, in the order they were logged:

- **D1** the framework's state and specs were gitignored, so a second machine saw nothing; fixed by tracking the output directory.
- **D2–D3** issues became the defect channel and PR plus CI became the integration model once a second agent system joined.
- **D4** phantom progress: nine stages marked done before CI had ever run green.
- **D5–D6** an operator runbook and explicit blocked-on-human items were needed for environments that power down and prerequisites only a person can satisfy.
- **D7** STATUS.md as single-writer runtime truth, hand-edited 41 times.
- **D8** the independent testing machine was lost and the hotfix treadmill began.
- **D9** a cold handoff brief let a second agent system build a production feature with no shared session.

Two facts from Switchboard shaped everything after it. First, the plumbing (registry identity, digest pinning, paywalled branch protection, sleeping VMs, unrotated secrets) was the hard part; the agent collaboration over plain git was the easy part. Second, the single highest-leverage missing piece was a post-deploy behavioral check of the live interface, because every hotfix had passed CI and a health check. The July 2026 external product review (35 fixes, 19 enhancements, several real security defects) is the measure of what a fast SDD build left behind for the operate phase to absorb.

### 5.2 steer-it: a real project built with Verity (2026-07-31 → 08-11)

Steer-it (a git-backed AI architecture board with blinded judges and a human-only decision seat) was scaffolded by Verity on 2026-07-31 and reached a locally deployed v0.9.21 by 2026-08-05. By 08-11: 176 commits, 77 stage specs, 30 ADRs, 25 stage-merge commits, 12 `fix` commits, 3 reverts, 0 hotfix commits, tags v0.9.17–v0.9.21. Daily commit counts ran 27, 17, 6, 19, 33, 11, 12, 3, 12, 23, 13. Its README shows the Verity discipline transplanted intact: workspaces with "imports nothing from siblings" rules, an orchestrator that is the sole writer, ADR-numbered decisions, `STATUS.md` rendered from runtime truth with a rollback digest.

Observations for the new harness:
- Verity's stream loop can carry a non-trivial multi-package TypeScript system from zero to a deployed 0.9.x in about a week of calendar time with one operator. That throughput is real.
- The August 2026 external review of steer-it/verity/agent-keep found **no branch protection anywhere and a bot identity pushing directly to main** (34 of steer-it's 74 early commits were bot plan/changelog/release commits). "Evidence-gated delivery" was discipline, not mechanism, wherever the platform tier lacked protection. A new harness that owns its own merge path must make the gate a mechanism from day one.
- The same review found the classic drift pattern already present in a two-week-old project: contracts naming routes that did not exist, a version identity split (tag v0.6.0 while `package.json` said 0.0.0), and a deploy model that could ship undeployed code from a working checkout. Drift starts immediately; the countermeasure (revisit, pin tests) has to be built in, not added later.
- steer-it's own design choices are worth stealing for the new harness's decision layer: independent positions before rebuttal, blinded stateless judges emitting structured fields merged mechanically, no majority vote over the human, quarantine for invalid model output instead of "repair."

### 5.3 The three-pillar vision and Agent Keep (context for "live managed")

An August 2026 vision document positions three repos as one control architecture: **Steer-It decides, Verity delivers, Agent Keep operates.** Agent Keep is a per-agent runtime chassis (manifest-declared capabilities, "absence is a stronger control than policy," observed ingress/egress, token accounting) paired with a **mechanic** that operates the runtime from evidence. The maintainer interview (2026-08-04) narrowed the first real mechanic role to a **read-only helpdesk companion**: it may read production code, approved intent, logs and telemetry, and may open and comment on issues; it may not modify code, open remediation PRs, deploy, restart, change config, or touch application secrets. A watcher mirrors its issues into the private dev repo; Verity fixes there; a curated promotion returns the fix.

That is precisely the "live managed" state in the new rough spec, and the record already contains its design constraints and the reasons for them:
- Mechanic authority is **observe and report**, never actuate, in the first version. Actuation (restart, pause, throttle, rollback) was designed but deliberately not confirmed.
- The helpdesk needs a **sanitized product-intent contract** to distinguish intended behavior from defects without access to private dev records.
- **No cross-pillar packet contracts existed** (decision packet, deployment packet, evidence packet); both investigating agents flagged this as the top blocker and recommended proving one **manual golden loop** (prod issue → private fix → approved promotion → black-box verify → rollback drill) before automating any of it.
- Open questions recorded then and still open: who owns packet schemas; how issues are deduplicated and redacted; what telemetry access is the minimum portable contract; whether an audit-sink failure stops or degrades the helpdesk.

### 5.4 The dual-backend experiment (ai-sdlc, 2026-08-04)

The same brief, persona, and three repos were given to Claude Code and to Codex, each asked to act as a "software archaeologist" with an interview gate before writing. Both produced credible, citation-dense reports and both correctly discovered that the integrated three-pillar system did not exist yet. Their outputs were complementary rather than redundant:
- **Claude** produced ranked enhancement suggestions with effort/impact/risk, a "corrections: where I was wrong" section recording four interview corrections, a deviations list (schemas nobody validates against; "CI/CD-native" with no publish workflow; `--watch` documented but exit 30), and unverified-assumption hygiene.
- **Codex** produced a structural read: what it believed before inspection versus what the repos showed, confirmed blockers, intentionally rejected ideas, a prioritized ten-step plan (make buildability truthful, prove a manual loop, define minimal schemas, then automate), and a table of creator-planned enhancements.
- Both independently found the bot-direct-to-main gap and the docs-versus-code drift. Neither hallucinated the missing packets; both said "exists in no repo."

Takeaway for a dual-backend harness: the two runtimes are worth running on the same judgment tasks (review, audit, planning critique) as **independent seats**, not as interchangeable workers. This is the same conclusion steer-it reached (diversity from different model families, blinded evaluation) and the same one the benchmark grading reached (Codex's review caught what Claude's build missed, and vice versa).

**From steer-it's own session report (2026-08-06 → 08-11) and its 2026-09-24 revisit:**
- Sixteen releases in six days, "each through the two-agent build→review gate (fresh builder → fresh reviewer → merge on green CI)." The loop scales down to very small releases without ceremony.
- A family of parser bugs (a `## Decision` heading inside an argument body mistaken for structure) jammed 12 of 19 pipeline items; two independent readers had the same defect. Found by driving the real backlog, not by tests.
- The dashboard's item selection "worked" in tests (synthetic focus events) and did nothing on a real mouse click in Firefox/Safari. Tests had a blind spot the live app exposed.
- Review caught a first build that pulled the core package into the browser bundle, doubling it and breaking a stated boundary, and forced a rework to server-side structuring. Independent review earning its keep on architecture, not just correctness.
- A key-resolution bug (reading `apiKey` but not the per-provider `apiKeys` map) fail-closed with keys present; found only by the live dogfood with a real model call.
- Operational drag came from the platform, not the code: GitHub hosted runners intermittently "not acquired," and a version-stamp mismatch whenever the deploy ran from a `main` checkout one commit past the tag.
- The revisit six weeks later found prod running **from the dev checkout itself**, `deployed_at` stale, golive blocked on two missing documents, and **25 board items all JUDGED and none ratified: "the human decision step has never run at volume."** The automation outran the human's part of the loop. A new harness must make human steps cheap, batchable, and visible, or they become the step that never runs.

## 6. Cross-cutting lessons for the new harness

Each theme below states the rule, the evidence behind it across the three systems, and what it implies for a UI-first, local-first, dual-backend harness.

### 6.1 State and truth

**Rule.** Project state is derived from artifacts at read time. Each fact has exactly one authoritative source. Transitions are events the engine emits, with timestamps, into an append-only log.

**Evidence.** SDD's STATE.md rotted to "Design, 44%" while 18 releases shipped and was the only source of merge conflicts. Verity's one authored artifact, the committed usage ledger, lost 9 of 14 rows on branch switches and under-enforced budgets by the same amount (ADR-0036). Verity's release truth drifted the moment there were two homes (ADR-0034); its runtime-truth file sat stale across two promotions (stage 91). The console could show that a PR merged but never when, could not tell "no work" from "could not read," reported a 3-day-old run from another repo, and guessed the circuit state from a default.

**Implication.** The lifecycle states in the spec (idea through live managed) each need a named evidence artifact and a single-writer record. Give the engine an event log and a run-state heartbeat from day one; the UI shows the latest event per project and never computes a state the engine did not emit. Keep the substrate-agnostic derive layer (Verity's ledger and next modules cannot tell GitHub from local); that is what makes graduation possible later.

### 6.2 Gates, tests, and independence

**Rule.** Done is a machine-verified event on a clean, schema-from-zero environment, plus a behavioral check of the live application. The judge is never the author. Gates are judged by exit code only.

**Evidence.** Switchboard: nine stages "done" before CI ran; DB-mocked tests green while every real import would fail; a deploy verifier that grepped a substring; a UX session done as CSS arithmetic; every hotfix passed CI and health. Verity: the tail-swallowed lint failure twice; the test runner that never awaited; a skip counted as a pass; graded benchmark runs where the reviewer's verdict matched the code and Codex's review caught what its build missed. steer-it: dashboard tests passed on synthetic focus events while real clicks did nothing; review caught an architectural boundary violation the build missed.

**Implication.** Answer "agent-written tests pass trivially" with structure, not volume: tests and code authored by different roles or different backends; the verifier turns each live failure into a permanent scripted check; acceptance criteria exist before code via a spec-soundness gate; grade the artifact. Scale review depth by lifecycle state (ADR-0028's proportional gating, finished). Exit-code-only gates with inherited stdio are non-negotiable, and the committed gate definition must be the same thing local runs and CI execute.

### 6.3 The authority boundary

**Rule.** The model edits files and returns a structured result. The engine performs git, talks to the tracker, decides merges, creates work items, commits intent artifacts, and holds every credential. The model is invoked at exactly one choke point with a role prompt, a tool policy, a per-role model, a timeout, a ledger row, and a transcript.

**Evidence.** ADR-0012 (read-only sandbox broke branch and commit), ADR-0013 (denied network broke the reviewer's comment and the builder's state read), ADR-0026 (a contained planner could not create issues, so every Codex run stalled and the scoreboard showed a 5× win), ADR-0033 (git-write-false roles' artifacts never reached the repo for 42 days), the plan trigger that re-planned every tick until the loop rather than the prompt owned the decision, and the trust ladder that gave the reviewer's approve verdict to deterministic code. SDD's v2 rewrite reached for the same instinct (Codex as adversarial reviewer) through an API orchestrator and was abandoned in a day; Verity got there by keeping roles as harness-native prompts over a deterministic CLI.

**Implication.** Route the interactive screens (vision chat, spec change requests) through the same choke point so they are measured and policy-bound; today's interactive sessions are the unmeasured half. Keep executor lifetime at one unit of work and enforce delegation rules in the dispatcher (stage 92 preamble, stage 109 denylist).

### 6.4 Two back ends, two safety models

**Rule.** Trust is an explicit table, not an absence of a denylist entry. Each backend gets the containment its guarantees require, and the harness owns the guarantee.

**Evidence.** Claude Code enforces a per-role allowlist in its harness, but tools that never prompt must be denied explicitly (a headless build delegated to a sub-agent and exited, 465k tokens wasted). Codex's non-interactive mode ignores permission profiles, its file deny failed open for writes, its command filter never matched, and a broken config made commands silently not run; the child process once received every credential the caller held. Codex reports tokens but no dollars. The provider denylist of one put a proposed third runtime at maximum trust by omission (ADR-0031). The two backends produced complementary, not redundant, results on the same investigation brief and on graded benchmark runs.

**Implication.** See Section 3.7 for the backend catalog. Use the two backends as independent seats where judgment matters (one builds, the other reviews), not as interchangeable workers. Maintain real-binary test lanes for both. Pin minimum versions to verified features and re-verify on each runtime release.

### 6.5 Honesty on the unverifiable

**Rule.** When the harness cannot verify something it stops and names the reason. Unknown is a third state, never folded into green, red, zero, or empty. Every knob that relaxes a gate is an explicit opt-in that can never widen into a merge.

**Evidence.** No CI read as red (livelock); unreachable GitHub read as an empty project (a review told "no PR exists"); unknown cost summed as zero (a one-cent cap cleared); an untiered provider trusted; a ledger path that fell back to a stale file; the console rendering Ready while rate-limited and a fabricated circuit state on a no-repo start; loopback assumed to be an origin until DNS rebinding.

**Implication.** Write the honesty rules into the spec as first-class requirements with their own UI states (Unknown is a NOW-panel state). Design the failure classes (auth, network, rate limit, not-a-repo) so the UI can act on them, and show the substrate budget remaining.

### 6.6 Human gates and approvals

**Rule.** An approval consumes the exact parked result the human read, on the exact commit they read it against; a moved head invalidates it. The words on a gate must be true for the configuration. Human steps must be cheap, batchable, and visible.

**Evidence.** The unknown-cost gate that re-ran the role three times and flipped its verdict; the trust-0 approval that could never merge and re-bought a $1.47 review per click for 37 days; the A→B→A force-push hole; steer-it's 25 judged, zero ratified items; the console's first session abandoned after six blockers; the plan role never exercised in early canaries because a single-account rule silently dropped requests.

**Implication.** A UI approve button removes most of Verity's label-provenance machinery but must keep result pinning and head pinning, an audit line per attempt, and a consequence computed by the same function the engine uses. Make "waiting on you" a first-class queue with counts and a time-to-decision target.

### 6.7 Cost, limits, and measurement

**Rule.** One ledger row per role invocation, branch-independent, fail-closed lookup; verified spend separate from unknown; limits defined in terms the UI shows.

**Evidence.** The benchmark's counterintuitive result (cheaper planner, dearer run); planner thrash of 4M tokens; the per-run ceiling tripping on cache reads; transcripts colliding within a run; the console starving the worker's GitHub allowance from 5 s polling.

**Implication.** Decide what a token limit counts (billable versus total context) and show both. Give the UI its own bounded read budget. Record per-role provider and model on every row.

### 6.8 Local first, graduation later

**Rule.** The local substrate is the default; GitHub is a mirror reached by a curated promotion. Release truth derives from promotion records once two homes exist.

**Evidence.** Benchmark stages consumed by provisioning races and label-write lag; Actions cost on private repos; branch protection paywalled on Switchboard; the console's rate-limit exhaustion; Fresh step one shipped, graduation never built; the promotion pipeline shipping seven releases without a leak; the maintainer's own plan for a curated prod snapshot plus a watcher mirroring issues back.

**Implication.** Reuse the local substrate, gate runners, and promotion machinery; build graduation as promotion plus work-item replay; prove one manual golden loop before automating.

### 6.9 Secrets and identity

**Rule.** Locations, not values, everywhere the UI or the repo can see; per-role injection by capability; redaction at every exit; identity locked day one.

**Evidence.** Switchboard's token in a chat transcript and a published superadmin password, never rotated; a document with personal infra scrubbed from Verity's history on day three; the Codex child inheriting every credential; the registry-versus-git identity mismatch that needed a second token on every deploy; the console holding no secrets only because auth was the operator's own login.

### 6.10 The UI

**Rule.** The UI observes and commands; it never becomes the state machine, the merge path, or the model caller. One panel answers "what is happening, what waits on me, what happens if I press this," with one primary action named by the engine.

**Evidence.** Section 4 in full: the NOW panel, the evidence channels, the blast-radius confirms, the fixed registry, capability detection from the engine's command list, and the incidents that came from presentation lies.

### 6.11 Process

**Rule.** Run the real thing early and often. Write decisions down and the reasons for saying no. Re-audit decisions as claims on a schedule. File cross-repo asks the day they are found. Dogfood the harness on itself.

**Evidence.** Fifty-six of Verity's 115 stages came from two live-run bursts; SDD shipped with no CI and preached CI; the revisit role's "nothing moved" produced seventeen stages in a week; four console engine asks sat unfiled for 37 days; every declined idea (knowing, a third provider, Actions for Codex, acting from the index) has a written reason and, where relevant, a re-entry condition.

## 7. Implications for the new harness spec

The rough spec proposes: a product with its own UI and per-project settings; lifecycle states idea → spec → developing → alpha deployed → beta deployed → live → live managed; screens for vision, spec, architect, build, alpha/beta/live status, and managed; per-project settings for secrets, model-per-role, autonomy, deployment strategy, and token limits; local git and local testing first, graduating to GitHub at beta; Claude Code and Codex as back ends. What follows maps the record onto that proposal as requirements (R) and open decisions (D).

### 7.1 State model

- **R1. Lifecycle state must be derived from evidence, never set by hand.** Idea = a brief exists. Spec'd = a spec artifact exists and passed a soundness gate. Developing = stages exist and at least one is merged. Alpha = a deployment record plus a passing live check on the dev build. Beta = a curated promotion record plus a deployment record plus a passing live check on the promoted build. Live = a production deployment record plus live verification. Live managed = a mechanic instance is registered and reporting. Every transition has a named artifact; a UI shows the artifact, not a dropdown. (Verity's derived-state rule; Switchboard's phantom-progress failure; steer-it's stale `deployed_at`.)
- **R2. Two axes, not one.** Lifecycle state (where the product is) and attention state (refused / waiting on you / running / ready / idle, the console's NOW panel). Conflating them produced confusion in both Verity's role model and the first console.
- **R3. Fix the naming collision now.** The list says "staging deployed" and the definitions say "beta deployed." Pick one term and give each state a one-line evidence definition in the spec itself.
- **D1.** Is Live a deployment of the beta (public) repo or of the dev repo? The three-pillar record and ADR-0015 to 0023 assume production is a curated projection of dev and fixes always flow dev → promotion → prod. Confirm and write it down, because it determines where the mechanic files issues and where the builder works.
- **D2.** Add a terminal state (retired / archived) and an explicit "blocked / needs you" overlay so a stuck project is distinguishable from an idle one.

### 7.2 Testing and gates

- **R4. Keep independence, drop volume.** The property that made Verity trustworthy was not test count; it was that the judge did not write the code. Keep: an adversarial reviewer reading the diff against source; a verifier with no source access driving the running app; exit-code-judged gates that no pipe can mask; a test runner that fails vacuous passes and tallies skips. Drop or scale down: per-stage review depth in early states, mandatory smoke authoring for every feature in "developing."
- **R5. Proportional gating by lifecycle state** (ADR-0028's idea, finished): developing = builder tests + one review; alpha = plus verifier on the live dev build; beta = plus promotion privacy/completeness checks and human sign-off; live = plus golive checklist and rollback drill. Write the gate table into the spec.
- **R6. "Agent-written tests pass trivially" needs a specific countermeasure, not a slogan.** Candidates with evidence behind them: tests authored by a different role (or different backend) than the code; the verifier turning each live failure into a permanent scripted check; grading the artifact rather than the scoreboard; and a soundness gate on the spec so acceptance criteria exist before code (benchmark: plan quality depends on a decided architecture).
- **R7. Every gate is judged by exit code, with inherited stdio, never through a pipe.** Non-negotiable; it failed twice in Verity's own history and once more in a worktree with a different linter version.

### 7.3 Authority boundary

- **R8. The model never merges, never performs git, never writes to the tracker, never holds a deploy credential.** The engine does all of it from a structured result (ADR-0012, 0013, 0026, 0033). This held across both back ends and is the single most reused pattern in the record.
- **R9. Fresh context per unit of work, and delegation rules enforced by the dispatcher, not the prompt** (ADR-0004; stage 92; stage 109's explicit denylist).
- **R10. A single choke point for model invocation** with per-role model, tool policy, ledger row, transcript, and timeout. Route interactive chat screens (vision, spec change requests) through the same choke point so they are measured; today's interactive sessions are Verity's blind spot.
- **R11. Backend trust is an explicit table.** A runtime not in the table is refused for unattended work (ADR-0031). Codex requires containment (credential passlist, post-run invariants, disposable workspace); Claude Code can rely on harness-enforced allowlists plus an explicit denylist for tools that never prompt.

### 7.4 Human gates and approvals in a UI-first product

- **R12. The UI's approve button is the approval token.** This removes most of the machinery Verity needed to authenticate a GitHub label (park pointers, park.json, timeline provenance, A→B→A defense). Keep the two properties that mattered: an approval consumes the exact parked result the human read, on the exact commit they read it against; a moved head invalidates the approval and triggers a fresh review. Keep the audit log and CSRF discipline from the console.
- **R13. Make human steps cheap, batchable, and visible.** steer-it ended with 25 judged items and zero ratified; Verity's canaries never exercised the plan role because a single-account rule silently dropped requests; the first console session hit six blockers. The "waiting on you" queue is a first-class screen with counts, and the spec should state a target for time-to-decision per gate.
- **R14. Gate copy must be true for the configuration** (stage 111). If the button says "approve to merge," approval must merge; if it cannot, the button must say what it does. Compute the consequence from the same function the engine uses.

### 7.5 Settings and secrets

- **R15. Settings that already exist in the engine and should be surfaced rather than reinvented:** mode (manual / supervised / autonomous), trust rung, per-role provider and model (ADR-0024, resolved once per run), daily and per-run limits, unknown-cost behavior, deployment target catalog, gate runner, substrate.
- **R16. Secrets: references, not values, in the UI.** Store env var names, keychain entries, or an encrypted local file reference; the engine resolves at dispatch and injects per role by capability (the Codex passlist model generalized to every backend). Redact in every log and transcript. Never render a value back. The record has one purged history already.
- **R17. Token limits must not count prompt-cache reads as spend** without saying so; the per-run ceiling in Verity tripped on accounting artifacts. Decide what a "token limit" means (billable tokens, or total context) and show both.

### 7.6 Local first, graduate at beta

- **R18. Reuse the local substrate and gate runners as the default path**: committed work-item records, engine-performed merges, SHA-pinned gate-run records, a committed gate definition consumed identically by local runs and by CI, and direct / act-in-Docker / remote-over-SSH runners. Absent GitHub, the UI is the single driver, which also simplifies locking to one serialized queue.
- **R19. Build graduation, which was designed and never built.** Graduation = curated promotion (ADR-0016 allowlist projection, sanitized changelog, promotion record) plus replay of local work items into tracker issues. Prove it manually on one project before automating (the "manual golden loop" both August investigations recommended).
- **R20. Once two homes exist, release truth derives from promotion records** (ADR-0034), and the runtime-truth file is stamped at finalize (stage 91). Do not let the UI infer either.

### 7.7 The mechanic ("live managed")

- **R21. Observe and report only, in v1.** Read production code, approved intent, logs, telemetry, release metadata; open and comment on issues. No code changes, no PRs, no deploys, no restarts, no config changes, no secrets. Actuation is a separate, later, gated decision (Agent Keep ADR-0005 boundary; maintainer interview 2026-08-04).
- **R22. A triage gate between mechanic-filed issues and builder work.** This is the loop the no-self-feeding rule exists to prevent, and it is also a prompt-injection path (user text → issue → code). Require human triage or a soundness gate before a mechanic issue becomes a stage; deduplicate and redact before mirroring into the dev repo.
- **R23. A sanitized product-intent contract** so the mechanic can tell intended behavior from defects without access to private dev records.
- **D3.** What telemetry access is the minimum portable contract per deployment strategy (AWS, Azure, local, Tailscale test servers)? The record says no repo emitted metrics at all in August; this is a prerequisite work item, not a detail.
- **D4.** Does an audit-sink failure stop, degrade, or merely alert the mechanic? Decide explicitly; Agent Keep's egress path continued on audit failure and both investigations flagged it.

### 7.8 Roles, screens, and back ends

- **R24. Hide roles behind screens.** Sixteen roles were the most-cited confusion. The proposed screens (vision, spec, architect, build, alpha, beta, live, managed) are a sound consolidation; roles become internal workers named in logs.
- **R25. Spec screen is view-only with change requests, versioned append-only, and the spec pointer, never pasted text, is what work items reference** (operator-init contract).
- **R26. Use the two back ends as independent seats where judgment matters** (review, audit, plan critique), not as interchangeable workers. Evidence: benchmark grading (each caught what the other missed), the ai-sdlc experiment (complementary reports), steer-it's design (diversity from different model families). Where one backend builds, prefer the other to review.
- **R27. Real-binary test lanes for both back ends from day one** (Verity had one for Codex and none for Claude at v1.1.0). Stub-verified contracts are not evidence; pin backend minimum versions to verified features.
- **D5.** Is the new harness a single product that owns the engine, or a UI over a reusable engine with frozen contracts between them? The console's separate-repo decision bought supply-chain hygiene and independent release cadence at the cost of contract ceremony. Either answer is defensible; the derived-state and authority rules must hold in both.

### 7.9 Process meta-requirements

- **R28. Run the real thing early and often.** Every serious Verity bug surfaced on a live run, not in CI: canaries, benchmark fixtures, dogfood. Budget for a benchmark harness and throwaway projects from the first month.
- **R29. Build the revisit habit in**: periodic re-audit of decisions as claims, with pin tests that fail CI on contract drift.
- **R30. Record decisions and the reasons for saying no.** ADRs, frozen contracts with additive amendment, and a written re-entry condition for anything declined (knowing, third provider, Actions for Codex, acting from the index). A new chat, a fresh executor, and a second backend all read these instead of asking.

## 8. Reusable asset inventory, with keep / adapt / drop

Paths are relative to `/home/smahoney/projects/verity-framework` unless stated. Verdicts assume a local-first, UI-driven, dual-backend harness.

| Asset | Where | Verdict | Why |
|---|---|---|---|
| Provider-driver seam and coordinator | `verity/bin/lib/agent-exec.cjs`, `verity/bin/lib/agents/index.cjs`, `agents/result-contract.cjs`, `contracts/agent-result.md` | **Keep** | Runtime-neutral, reject-don't-ignore knobs, near-zero GitHub coupling; both back ends already behind it. |
| Claude driver | `agents/claude.cjs` | **Keep** | Verified argv, the explicit deny list, allowlist loader, cost normalization. |
| Codex driver and feature matrix | `agents/codex.cjs`, `agents/codex-features.cjs` | **Keep** | Every line traces to a real-binary finding; feature-derived version pin. |
| Credential passlist | `agents/codex.cjs` (`childEnv`) | **Keep, generalize to all back ends** | The only Codex restriction proven to bind; portable to any child process. |
| Post-run invariants and tier-2 workspace | `agents/invariants.cjs`, `agents/workspace.cjs` | **Keep; consider for Claude too** | Provider-neutral write-boundary teeth. |
| Capability policy vocabulary and enforceability gate | `agents/policy.cjs`, `contracts/role-capability-policy.md` | **Adapt** | Good vocabulary; make one file govern both back ends and add a tools-to-capabilities cross-check. |
| Per-role tool and permission files | `commands/verity/*.tools.json`, `*.permissions.json` | **Adapt** | Trim GitHub grants for local-first; fix the installer not copying permissions; reconcile mismatches. |
| Provider trust table | `agents/tiers.cjs` (ADR-0031) | **Keep** | Allowlist of trust, ADR-gated entries, refusal wording. |
| Git lifecycle | `agents/git-lifecycle.cjs` (ADR-0012) | **Keep; drop the PR-create half** | Explicit base resolution prevents stage stacking; pure git otherwise. |
| Intent-artifact commit and work-item reconcile | `agents/intent-artifacts.cjs`, `verity/bin/lib/work-items.cjs` (ADR-0033, 0026) | **Adapt** | Worker-owned side effects; retarget from issues to the record store. |
| Local substrate | `verity/bin/lib/substrate-local.cjs`, `contracts/local-work-item.md` | **Keep as the primary store** | Frozen, additive, git-committed records; honesty rule on gate-run freshness; machine-audited operator degradation. |
| Derive layer | `verity/bin/lib/ledger.cjs`, `next.cjs` | **Keep** | Pure functions over a snapshot; three-state CI and the verified stamp are the honesty core. |
| Label vocabulary | `verity/bin/lib/labels.cjs` | **Adapt** | Port the semantics; replace labels-on-issues with record fields plus an actor-and-time event log. |
| Direct gate runner, gate definition, scaffolded runner | `verity/bin/lib/gates.cjs`, `verity/templates/run-gates.cjs.tmpl`, `ci.yml.tmpl` | **Keep** | Exit-code only, SHA-pinned, single-sourced with CI, zero GitHub. |
| act and remote runners, catalog | `gates-act.cjs`, `gates-remote.cjs`, `gate-runners.cjs`, `~/.verity/gate-runners.md` | **Adapt** | Useful isolation; keep the catalog format; verify act's network needs. |
| GitHub Actions runner path | rollup reads in `ledger.cjs`, `trust.merge` with `--match-head-commit` | **Defer** | Only needed after graduation. |
| Human gate pure functions | `trust.approvalConsequence`, `trust.decideMerge`, `judgeApprovalEvent`, `pushesSince`, `parkRecordMismatch` in `trust.cjs` and `verity/worker/index.cjs` | **Keep the functions; rebuild the surface** | Comment pointers, timelines, and bot identity are GitHub-only; a UI needs a local approval record with approver, time, and head. |
| Lock protocol | `verity/bin/lib/locks.cjs` | **Drop, replace** | Comment-and-label leases; use a file or database lease under a single UI driver. |
| Trust ladder and diff classification | `trust.classify`, `localPrDiff` | **Keep** | Diff evidence is already sourced from git locally. |
| Register-trusted intake and spec-soundness gate | `verity/bin/lib/init.cjs`, `intake.cjs`, `contracts/operator-init.md` (ADR-0038) | **Adapt** | Sound trust model; inert on local until records carry an author. |
| Promotion projection | `verity/bin/lib/promotion.cjs`, `classification.cjs`, `promotion-config.cjs`, `.verity/production-content-classification.yml`, `.verity/promotions/PROM-*.yml` | **Keep** | Directly the "beta = scrubbed repo" step; about five GitHub call sites to retarget; tests already exercise a local bare prod. |
| Changelog sanitizer | `changelog-sanitize.cjs` (ADR-0022) | **Adapt** | Narrow autolink fix; generalize or drop. |
| Promotion verify | `promotion.cjs` verify step | **Adapt** | npm-specific; parameterize per stack. |
| Graduation | none | **Build** | ADR-0028 names the ingredients: promotion plus work-item replay plus repo creation. |
| Operator contracts | `contracts/operator-{snapshot,gate,run,inspect,act-v2,init}.md`, `verity/bin/lib/operator.cjs`, `operator-act.cjs` | **Adapt** | Local degradation is audited (121 resolved, 8 absent-with-reason, 1 GitHub-only); add refusal codes, a confirm layer, and a project lifecycle field, which does not exist today. |
| Contract-pin tests | `tests/contract-pins.test.cjs`, `tests/lib/contract-doc.cjs`, `tests/docs-literals.test.cjs` | **Keep** | Key sets derived from the contract text; mutation-proven; framework-agnostic. |
| Usage ledger | `verity/bin/lib/usage.cjs` (ADR-0036) | **Keep** | Branch-independent sidecar, UTC days, unknown is not zero, daily breaker. |
| Install render pipeline | `verity/bin/lib/install.cjs`, `verity/templates/preamble-*.tmpl` | **Keep** | One source, three hosts; headless prompt equals installed prompt. |
| Test runner and stub seams | `scripts/run-tests.cjs`, `tests/fixtures/agents/README.md`, `tests/real-codex.test.cjs` | **Keep** | Every honesty rule is paid for by an incident; forbid-rather-than-stub-green pattern. |
| Integration scripts | `scripts/integration-autonomy.cjs`, `integration-actions.cjs` | **Adapt** | Right shape, GitHub-bound and ungated; port to a local target and gate them. |
| Identity, scaffold, status, golive, smoke | `identity.cjs`, `scaffold.cjs`, `status.cjs`, `golive.cjs`, `smoke.cjs`, templates | **Adapt** | Small and mostly GitHub-free; drop the `gh repo view` availability probe. |
| Benchmark harness | `verity/bin/lib/benchmark.cjs`, `benchmark/` (fixtures A–D, runbook, findings) | **Adapt** | The tool that found what tests missed; retarget provisioning to local. |
| Role prompts and templates | `commands/verity/*.md`, `verity/templates/*.tmpl`, `verity/design-guides/` | **Adapt** | Consolidate behind lifecycle screens; keep the intake claim/reality step, stage template, ADR and contract templates, security invariants, recovery plan. |
| Console: registry, CSRF and Host allowlist, audit, exec, view-model | `/home/smahoney/projects/verity-console/lib/{registry,csrf,host,audit,exec}.cjs`, `public/view-model.js` | **Adapt** | Fixed-registry execution, loopback hardening, redaction, and the NOW-panel mappers are directly reusable patterns; the polling model is not. |
| Ollama and local-model path | `codex-ollama-local-findings.md` | **Defer** | Tool-loop and no-cache findings make unattended use questionable. |

Items still unverified in the record and worth a probe before the new spec relies on them: network denial under `codex exec`; the effect of `--ignore-rules`; whether act needs network for the checkout action; Codex F-A and F-D behavior on 0.146.0; any implemented work-item-to-issue replay; the approval-rank direction disagreement between two policy files; the Node 16.7 support claim, since CI runs Node 20 only.

## Appendix A. Numbers

| System | Span | Commits | Releases | Stages | ADRs | Tests | Code |
|---|---|---|---|---|---|---|---|
| VibrationPlan | 2025-11-22 → 2026-02-13 | prose only | none | none | none | none | role prompts |
| spec-driven-devops | 2026-03-02 → 2026-06-07 | 15 | 1.0.0 → 1.4.0 (+ 2.0.0-alpha.0–6, abandoned) | none of its own | none | ~120 asserts, 4 files | 19 command files (1,029 lines), installer 561 lines |
| Switchboard (built with SDD, then Verity) | 2026-05-28 → 2026-07-09+ | 295 | 34+ tags | 69 stage files | Verity-era ADRs | mixed | multi-service Python |
| verity-framework | 2026-06-07 → 2026-09-29 | 319 | 0.1.0 → 1.8.0 (16 versions; PROM-0001–0006 via promotion) | 115 | 38 | 1,614 passed / 8 skipped (2026-09-29) | ~29k lines, 59 files, zero deps |
| steer-it (built with Verity) | 2026-07-31 → 2026-08-11 | 176 | v0.9.6 → v0.9.21 | 77 | 30 | not counted | TypeScript workspaces |
| verity-console | 2026-08-05 → 2026-09-30 | 106 | v0.1.0, v0.1.1, v0.2.1 (v0.2.0 pulled) | 51 merged, 57 specs | 14 committed, 17 in tree | ~1,106 registrations, 70 files | ~19.3k lines, zero deps |

Benchmark record: fixture D on Claude Opus 861 s / 3.83M in / $4.97 (Aug) and $6.16 with per-role models (09-25, two stages auto-merged); plan=Sonnet +17% cost, +33% time; Codex on C about 1.8× faster and 3.7× fewer tokens, graded 15/20 vs 20/20; Codex on A about 5× fewer tokens and more stages built, graded 15/20 vs 19/20; fixture A 09-25: 10 stages planned, 6 merged, 16.42M in, $16.07. Early Codex N=3: void. Console: $10.49 first session, $1.47 wasted per bad approval; read budget 910 vs ~6,200 GitHub calls per hour.

## Appendix B. Source documents worth reading first

- Switchboard: `sdd-output/sdd-flow-divergences.md` (D1–D9); `vibration-plan-v2/flow-interview-questions.md` (the forensic interview); `product-review/switchboard-remediation-plan.md`.
- SDD: `sdd/workflows/run-role.md`, `sdd/bin/lib/state.cjs`, `spec-driven-devops-v2/spec-driven-devops-refactor.md`.
- Verity: `docs/framework-spec.md`, `docs/roles-spec.md`, `docs/autonomy.md`, `docs/adr/0004, 0008, 0011, 0012, 0013, 0014, 0026, 0028, 0029, 0030, 0031, 0033, 0036, 0037, 0038`, `CHANGELOG.md` 1.2.0 through 1.8.0, `benchmark/benchmark-findings.md`, `docs/revisit/2026-09-22-revisit.md`, `docs/dev/codex-enforcement-spike-0.146.0.md`, `codex-readiness-findings.md`.
- Console: `docs/architecture.md`, `docs/handoff/console-mission-control-redesign.md`, `docs/canary-v1-results-2026-09-28.md`, `docs/revisit/2026-09-24-revisit.md`, `docs/security-invariants.md`, `docs/engine-requests-autonomous-ui.md`, ADRs 0001–0017.
- Ecosystem: `ai-sdlc/cc/01-three-pillar-system-technical-audience.md`; `ai-sdlc/cc/output/findings-and-suggestions.md` and `ai-sdlc/cdx/repo-investigation-report/interview-findings-and-recommendations.md` (the dual-backend investigation); `steer-it/docs/session-report-2026-08-10.md` and `docs/revisit/2026-09-24-revisit.md`.

