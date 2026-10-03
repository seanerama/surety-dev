# D3 brief: the protected acceptance path, the check runner and the diff classifier

**Status:** owner's brief, 2026-10-03, drafted by the driver under Sean's decision that D3 follows once D2's execution boundary is fixed (E48 item 2; D2 approved to build, E58). This document says what the D3 design must answer, what it inherits, what it may not reopen, and how it is produced and judged. It is not the design. The design is `docs/design/sdlc-design-D3-checks.md`, drafted from this brief, cross-reviewed once by Astra, closed by the stopping rule of E20.

## 1. Why now

Every gate in M1 and M2 is satisfied only by a `passed` check state, which D1 §9.2 derives from a `check_results` row with `execution_established = true` and exit status zero (D1 §17 item 8). In M1 and the two M2 slices those rows come from the scripted adapter: the engine's reactions to check results are proven, but no engine component has ever run a check. D1 declared out of scope, for D3, "the protected acceptance path, check runner, source-and-protected-assets materialization, diff classifier" (D1 preamble). Astra's second priority for the next milestone is trustworthy real check execution (E46). D2 leaves D3 a boundary to run checks inside: the `check` profile of the sandbox and the domain (D2 §3.8), so that a check execution's termination and resources are established the same way as a role's. Two bucket-C entries of the triage wait on D3 (M43: a module's tier override and a sensitive area's own required checks; M11: a requirement-versus-contract contradiction), and one E37 question does too (whether the engine sends a fix back to its Builder when the named check fails). M3's real deployment needs a `post_deploy_behavior` check run through the protected path (D1 §19.3), so D3 precedes M3.

## 2. What D3 covers

Four things, each with its own section in the design and its own evidence:

1. **The protected acceptance path** (F §5.2, §5.3; D1 §5.2, §7.9). What the governed set is at runtime: the files under the protected roots and the governed policy fields (`check_commands`, `check_discovery`, `runner_config`, `result_collection`, `required_checks`); how the engine materializes the protected set for a check run (the authorized tree at the effective protected version, never the candidate's working copy of it); how a check's discovery, command, configuration and result collection are fixed by that version and nothing a Builder can touch.
2. **The check runner.** The engine component that executes a required check against a candidate inside a `check`-profile domain (D2 §3.8): what it materializes (the candidate's source at `source_revision`, the protected assets at the effective version, the environment and artifact where the check kind needs them), how it launches, bounds and terminates the execution (D2 §3), how it establishes `execution_established`, `signaled`, `deadline_hit`, `exit_status` and the `output` record, how it assigns `execution_seq` and binds the result (D1 §3.4 `check_results`, §9.2), and how a result reaches the gate without any role's word. Runner classes `direct`, `container`, `remote` (D1 `RunnerClass`): which D3 qualifies first and what the others wait for.
3. **The diff classifier.** The engine function that classifies a protected proposal (D1 §7.9) into `tightening`, `loosening` or `unclassifiable` against the approved spec and the governed set, with a conservative fallback (E13 consequence: "the diff classifier is a detailed-design item; its conservative fallback is part of the contract"); what makes a change a tightening (a stricter or added check that covers the same or more requirements) and what it can never call one; how classification is re-run at application as an effect precondition (K8, D2 §5 C2) and how the Reviewer's approval of a tightening becomes effective only once the classifier is qualified.
4. **Validation scope at run time** (F §5.6, §5.7). How the required set for a candidate is computed from the tier, the sensitive areas each requirement and module touches (the sensitivity floor), a module's tier override (M43), and the phase's validation obligations; how `evidence_reuse` is bounded by the classifier's judgement of what an earlier result still establishes.

## 3. What D3 must answer

Each question is one the design states an answer to in prose, with the tests that will pin the contract named beside it. A question the design cannot answer is listed in its open questions with the decision Sean must take; never answered by silence or an unstated default.

**The protected path**
- P1. The exact runtime shape of the governed set: the protected roots, the layout under `.surety/checks/` (check definitions, expectations, fixtures, runner configuration, discovery rules), and the governed policy fields; what a check definition contains (id, command as an argument array, working directory, timeout, environment keys it may read, the requirement keys and acceptance criteria it covers per `.surety/spec/spec.md`, the runner class, what it produces).
- P2. How the protected set is materialized for execution: read-only, at the effective version, from the authorized tree (D1 §7.9), never from the candidate's checkout; what happens when the candidate's revision and the effective version disagree on the protected files (the candidate's copy is ignored or the gate blocks; say which and why).
- P3. How `check_discovery` works without running repository code: discovery is a function of the materialized tree, never a program the repository names (E25 item 3, E29 item 1, E37 item 1 apply to the runner as they do to engine git).
- P4. How the Verifier's protected changes in a workspace become a proposal (D1 §7.3 step 2) and how the proposal's `affected_checks` are computed.

**The check runner**
- R1. What a check execution materializes and where: the candidate's source at `source_revision` (the engine's own checkout or a fresh worktree, read-only to the check except the locations the check kind declares writable), the protected assets, the toolchain paths a policy names (`sandbox_read_paths`, D2 §2.3), the environment constructed from the check definition and the grant (D1 §17 item 4), the artifact for kinds that need one.
- R2. How the runner launches a check inside a `check`-profile domain: which of D2's launcher, domain init and volatile filesystem it reuses, what differs from a role (no provider egress unless the check kind declares a destination; no provider key; a different result channel), and how a check's output becomes the `output` record (redacted, bounded, D1 §14).
- R3. What establishes `execution_established`: the runner's own observation that the process was placed in the domain, authorized (D2 §3.2) and started, never the check's output; what sets `signaled`, `deadline_hit` and `exit_status`; how termination with closure (D2 §3.2) precedes the result's recording; what a `unknown` domain observation does to the result (no row, or a row with `execution_established = false`; say which).
- R4. How `execution_seq` is assigned (D1: "by the runner registration transaction", monotonic per project) and how a result is bound to candidate, `source_revision`, protected version, runner class, environment and artifact digest so that §9.2's selection and staleness rules work unchanged.
- R5. What triggers a check execution: a nomination (verification work), a request by route, a protected application that invalidated results (D1 §7.9), a fix's integration (E43); how executions are scheduled against the resource envelope (D2 §3.7) and leased; what one run per project (D1 §8) means for checks; whether checks of one candidate run in parallel.
- R6. What happens when a check cannot be run (missing toolchain, a definition that does not parse, a materialization failure): the state is `missing` or `skipped` by §9.2, the gate not satisfied (E41 item 2), and a person sees why (the status line, the gate read of E47).
- R7. Which runner class M3 qualifies (`direct` inside the `check` profile on this host is the expected answer) and what `container` and `remote` require before they are qualified; how a check result records its runner's identity and qualification (as D2's trust entry does for a backend).
- R8. Developer tests (F §5.4): how a Builder-owned test's result may contribute evidence without entering the protected path, and what distinguishes its row from a required check's.
- R9. The E37 question: whether the engine sends a fix back to its Builder when the check its finding names fails again, or parks it; and what a repeated failure of the same check counts as for repair limits (D1 §4.3, M11).

**The diff classifier**
- C1. The definition of each `ChangeKind` in terms a test can pin: `initial` (no prior version), `tightening` (every check of the prior version is retained or strictly strengthened, and the requirements covered are a superset), `loosening` (a check removed, weakened, or its coverage reduced), `unclassifiable` (anything the rules cannot place, including a change to runner configuration or discovery that could alter what runs).
- C2. The conservative fallback: when in doubt, `unclassifiable`, which needs the human (D1 §7.9); the rule that no change to `required_checks`, `check_commands`, `check_discovery`, `runner_config` or `result_collection` is a tightening by itself (D1 §5.2: generic policy confirmation never substitutes).
- C3. How a proposal's classification is bound to its base and the effective version and re-run at application (K8); what the Reviewer's approval of a tightening means before the classifier is qualified (a recommendation) and after (authority, per F §4.1 "approve tightening check corrections against the spec").
- C4. How the classifier reads the approved spec (`.surety/spec/spec.md` R-keys and criteria; the requirement index the engine registers) to judge coverage, and what it does when a check names a criterion the spec does not have (M11's contradiction route: a blocker for a person, not a repair).
- C5. What invalidation an applied change causes (D1 §7.9: dependent evaluations and results) and what `evidence_reuse` the classifier permits: a result under the prior version may be reused for a later candidate only when the classifier shows the check unchanged for that candidate's scope; otherwise stale (M41, slice 1 A5).

**Validation scope**
- S1. The required set for a candidate: from the tier (F §5.7), the sensitivity floor for each sensitive area the delivered requirements and the touched modules name (F §5.6, O1), a module's tier override (M43), the phase's validation obligations (F §3.10); how `required_check_ids`, `runner_classes` and `sensitivity_categories` on the acceptance scope (D1 §3.4) are computed and when the scope is `validated`.
- S2. What a sensitive area requires: the fixed list of F O1 and, per area, the checks that must exist and pass; whether D3 ships those checks or only their requirement (the spec template's "sensitive areas raise the checks required whatever the tier").
- S3. How a check names what it covers (R-keys, criteria) so that delivery (D1 §9.1) and coverage (M38's "uncertain", today unreachable) are computed from the protected set.

**Carried in**
- X1. The gate evaluation's own reads (E51 question 1): whether `alpha_authorize`, the gate that issues something, reads the candidate's registered refs and records an observation before evaluating, as D1 §7.2 asks of every engine git call; the Reviewer recommended it, the driver deferred it to D3.
- X2. The two bucket-C entries M43 and M11, settled here.
- X3. M3's `post_deploy_behavior` check (D1 §19.3): what D3 must leave for the deployment design so that a check can run against an environment rather than a workspace (environment and artifact bindings of `check_results`).

## 4. What D3 inherits and may not reopen

- D1 draft 3 as corrected by the M1 build spec section 6, the resolution note, D2's K1 to K10, and the errata E1 to E58. D3 extends D1 and D2; it does not redraft either. A rule D3 needs changed is a numbered proposed correction with the test that would pin it, and Sean decides.
- D1 §9.2's check state assignment and §17 item 8: nothing writes `passed`; only a runner-established execution with exit status zero satisfies a gate. D3 is what makes "runner-established" real; it changes neither rule.
- D2's sandbox, boundary and resource envelope, reused for the `check` profile (D2 §3.8); the `check` profile's mount plan is D3's to define within D2 §2.3's forbidden set.
- F §5.2 to §5.4 and §5.6 to §5.7, as amended by the errata (E9, E13, E19).
- The dependency rule: `better-sqlite3` only; a toolchain a check needs is the project's, mounted by policy, never the engine's dependency.
- The role separation and the lean procedure (E31, E40); the three lanes of the M2 build spec section 4 (a check runner's tests belong to the sandbox lane; a check against a real project's toolchain to a new `project` lane D3 defines, or to `real` if it needs a model, which it should not).
- Scope: the four things of section 2 and the carried items of section 3. Deployment adapters, the environment observation job, export, the Mechanic and the UI stay out (D1 preamble).

## 5. What D3 produces

- `docs/design/sdlc-design-D3-checks.md`: prose for the architecture, in D1's and D2's register and section discipline (numbered sections; an appendix of closed enumerations for every new state, field, reason, error and configuration key; an open-questions section for Sean). Shorter than D2 (441 lines) if possible.
- A table at its end, "contract precision pinned by tests", every statement a test must pin with a proposed name and lane; design review stops where that table starts (E20).
- The `check` profile's definition for D2's sandbox and the host requirements it adds, if any.
- A list of what D3 does not claim, in the form of `M1-not-claimed.md`.
- The runtime shape of `.surety/checks/` as a short reference the spec template (`docs/spec/templates/project-spec-template.md`) can point to, so a project's Verifier knows what to write.

## 6. How D3 is produced and judged

1. **Draft 1** by an assistant session acting as architect under this brief, in a worktree, as an owner document. It reads the sources of section 4 first, the predecessor incident record (`docs/reviews/predecessors/`, especially the checker-exit, CI-skew and vacuous-test incidents CH 1, 8, 12, 17), the M1 kernel's gate and protected code as built (`packages/engine/src/gates/`, `src/protected/`, `src/store/transitions/{gates,protected,findings}.ts`) and the seam's sections on gates, protected proposals and check results, so that D3 names what exists.
2. **The driver's check** of draft 1 against this brief: every question of section 3 answered or listed as open; nothing of section 4 reopened; the test table present.
3. **Astra's cross-review**, once, with a brief in the form of `docs/reviews/D2/sdlc-design-D2-review-brief-astra.md`; dispositions recorded as for D2; Sean decides each.
4. **Draft 2** applies the dispositions. **No draft 3** unless Sean asks.
5. Sean approves D3 to build. Its rows join the M2 plan or open M3's, as Sean decides then.

## 7. What D3 is not

Not a test framework: a check is a command the project's own tooling runs; D3 runs it, bounds it, and records what happened. Not a policy on which tests a project should have: the spec and the tier decide that; D3 computes the required set from them. Not a code reviewer: the classifier judges a diff to the protected set against the spec's keys, not the quality of the checks. Not the deployment design, though it must leave the environment-bound check a place to stand.
