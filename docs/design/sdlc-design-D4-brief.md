# D4 brief: deployment to a real Alpha environment

**Status:** owner's brief, 2026-10-07, drafted by the driver for Sean, who takes it to a design team. This document says what the D4 design must answer, what it inherits, what it may not reopen, and how it is produced and judged. It is not the design. The design will be `docs/design/sdlc-design-D4-deployment.md`, drafted from this brief, cross-reviewed once, and closed by the stopping rule of E20.

**For a reader new to Surety.** Surety is an evidence-gated delivery engine for AI coding agents: agents plan, build, verify and review software under an engine that accepts no agent's word as evidence, records every decision, and lets work advance only through gates satisfied by evidence the engine observed itself. The framework is defined in `docs/foundations/sdlc-framework-foundations-v1.0.md` (cited **F**), as amended by the errata `docs/foundations/sdlc-foundations-v1.1-errata-draft.md` (cited **En**). Three designs are approved: **D1**, the engine core (`docs/design/sdlc-design-D1-engine-core.md`); **D2**, real agent backends and their isolation (`docs/design/sdlc-design-D2-backends-and-isolation.md`); **D3**, the check runner (`docs/design/sdlc-design-D3-checks.md`, draft 2). Milestones: **M1** (the engine kernel, accepted, E45) and **M2** (Claude Code as an isolated real backend, accepted, E88) are done; **M3** (D3's check runner, E92) is in build. Read `CLAUDE.md` and the M3 build spec `docs/spec/M3-build-spec.md` first for how the repository is built.

## 1. Why now

Surety can take a project from an approved spec to a candidate whose stage gate and Alpha authorization gate are satisfied on evidence the engine observed: M2 proved it with real agents, and M3 makes the checks themselves engine-run. It stops there. A satisfied `alpha_authorize` issues a `deployment_authorizations` row (D1 §9.6) and nothing consumes it: no engine component has ever deployed anything, the "Alpha environment" in every test is a fixture, and the candidate state **Alpha Deployed** (F §3.3) has never been reached. D1 §19.3 says Surety's walking skeleton stays open until the engine "exercises a real minimal deployment target through alpha authorization, a journaled deploy operation, identity read, and a required `post_deploy_behavior` check through the protected path". That milestone was named M3 in D1; E89 made M3 the check runner, so deployment is **M4** (the M2 and M3 build specs say so), and D4 is its design.

The engine already holds most of the bookkeeping: operations with durable identities and attempts, a journal, `deployment_authorizations`, `deployment_verifications`, `environments` with their three separate facts, observation jobs, `releases` (D1 §§3.4, 3.5, 9.6). D3 reserved the environment-bound check (D3 §5 X3). What is missing is the part that acts on the world and observes it: the **deployment adapter**, the **deploy operation** that drives it, the **verification** that establishes what is actually running, and the **Release Operator** that executes it under a scoped capability.

## 2. What D4 covers

1. **The deployment adapter contract** (F §10: deploy, status, logs, teardown, verify, reconcile). One interface every target implements; what each call promises, what it returns, how it fails, and what "reconcile whether an operation took effect" means for each.
2. **The deploy operation.** How an issued authorization becomes a journaled operation (D1 §2.5, §3.5, §7.10), its attempts, its `deployment_generation`, its exactly-once effect under crash and retry (F §3.7: "before any retry, the engine reconciles whether the operation already took effect"), and how it consumes the authorization.
3. **Artifact and configuration identity.** What `artifact_digest`, `config_identity`, `target_set` and the source-to-artifact mapping are for a real target; who builds the artifact, from what, inside which boundary; how the engine knows the bytes deployed are the bytes authorized.
4. **Deployment verification by observation** (F §3.3, §3.7; D1 §9.6). The identity reads that establish each target runs the mapped artifact, and the required `post_deploy_identity` and `post_deploy_behavior` checks, run through D3's runner against the environment (D3 §5 X3); how `alpha_complete` is satisfied, and how **Alpha Deployed** is recorded only then.
5. **Environment records and observation** (F §3.6; D1 §3.5, §8.1 step 5). Last verified, attempted, and observed condition kept separate, with `unknown` shown as unknown; the observation job, its cadence and freshness; what an environment read can and cannot claim.
6. **Secrets for deployment.** How credentials a target needs reach the adapter and the environment-bound checks without passing through any agent's context (F §10 "secrets storage and injection"; D2 §2.5 reserves the delivery form; D3 X3 reserves secret references on check executions).
7. **The Release Operator** (F §4.1). The role or engine component that executes authorized deploy operations through scoped capabilities: whether it is an agent at all, what it may and may not do, and how it is isolated (D2's sandbox, a new profile, or engine code).
8. **The first real target.** One concrete minimal target the walking skeleton deploys to, chosen and qualified, with the adapter for it.

## 3. What D4 must answer

Each question is answered in prose with the tests that will pin it named beside it. A question the design cannot answer goes to its open-questions section as a decision for Sean, with options and a recommendation; never answered by silence or an unstated default.

**The adapter contract**
- A1. The interface: each call (`deploy`, `status`, `logs`, `teardown`, `verify`, `reconcile`), its inputs (authorization, artifact, configuration identity, target set, operation and attempt identity), its outputs, its bounds (deadline, output size), and its failure classes. Which calls are effects and which are reads.
- A2. **Reconcile**: for each effect, how the adapter answers "did attempt N take effect, partly, or not at all" from the target's own state, without trusting the adapter's memory; what it returns when it cannot tell (`unknown`, never success); how an `ambiguous` operation (D1 A.5) is resolved before any retry.
- A3. How an adapter is qualified before the engine trusts it, by analogy with D2's trust entries and D3's runner self-test: what a qualification run proves (a deploy that is then read back, a teardown, a reconcile after a simulated crash, a refused unauthorized deploy), and what is recorded on each result.
- A4. Where adapter code runs and with what authority: engine process, a sandbox domain (D2), or a separate host agent; what it can reach on the network (D2 §2.4's egress proxy) and on the host.

**The deploy operation**
- O1. The transition from an issued `deployment_authorizations` row to a deploy operation and its journal entries; what freezes at intent (authorization, artifact, configuration, target set) and what is rechecked as an effect precondition immediately before the effect (D2 §5 C2, K8): the authorization still current, the candidate not superseded (D3 Q9), the environment not changed out of band.
- O2. Exactly-once under crash: kill the engine at each step (before intent, after intent, mid-deploy, after deploy before verification, during verification) and say what recovery does; no duplicate deployment, no lost attempt, no verification credited to the wrong attempt (`deployment_generation`).
- O3. A failed or partial deployment: what the environment record shows (attempted, not verified), what happens to the last verified deployment (unchanged, F §3.6), and what the operator can do next (retry after reconcile, roll back to the last verified, abandon).
- O4. Concurrency: two authorizations for the same environment; a deploy while an observation job runs; a new candidate authorized while an earlier one is deploying.

**Artifact and identity**
- I1. What the artifact is for the first target (an image, an archive, a directory tree) and who builds it: the engine from the candidate's revision inside a boundary, a check, or a role; how the build is reproducible enough that `artifact_digest` identifies it; what the source-to-artifact mapping records.
- I2. `config_identity`: what configuration is, where it lives (governed policy, the protected path, the environment), and how a configuration change alone produces a new identity.
- I3. Identity reads: how the engine reads, per target, what is actually running (a digest, a version endpoint, a file hash) through the adapter, and why that read cannot be satisfied by the artifact reporting on itself.

**Verification**
- V1. The environment-bound check (D3 §5 X3): definitions of kind `post_deploy_identity` and `post_deploy_behavior` with `requires: ["environment", "artifact_digest"]`; the trigger `deployment_verification` with environment, artifact digest, operation attempt and `deployment_generation` frozen at registration; the `check` profile's egress list taken from the environment's targets; a check tree holding only the protected inputs, with no candidate source.
- V2. What `alpha_complete` requires, mapped onto D1 §9.6's `deployment_verifications` row: every required target's identity read matches, at least one required `post_deploy_behavior` check passed, every required post-deploy check passed, all bound to the current attempt and generation; and that a later attempt or target change invalidates earlier verifications.
- V3. What "verified" can never mean: tests passing on the candidate alone (F §3.7), an adapter's success return, or the deployed application's own claim about itself.

**Environments and observation**
- N1. The environment record for the first target: its targets, its three facts, the observation job, cadence and freshness bounds (D1 §8.1 step 5), and how `unknown` and `expired` are shown and never read as healthy.
- N2. Out-of-band changes to an environment (someone redeploys by hand): how an observation detects them and what it does to the record and to pending operations, by analogy with D1 §7.6's integrity observations for git.

**Secrets**
- S1. Where deployment secrets are stored, who can read them, and how they are delivered to the adapter and to environment-bound checks, never to an agent's context and never into a record (D1 §14.2's secret screen applies).
- S2. What a leaked deployment secret reaches, stated as a class C limitation in D2 §8's form, and how it is revoked.

**The Release Operator**
- R1. Whether the Release Operator is an agent (a model) or engine code. F §4.1 gives it "export, release mapping, publication, deployment, recovery records" through "scoped capabilities" and forbids it to "waive checks; alter code; supply its own independent verdict"; nothing in Alpha deployment obviously needs a model. Recommend one, with reasons.
- R2. Its capabilities, how they are scoped to one authorization, and how an attempt outside them is refused and recorded.

**The first target**
- T1. Which target the walking skeleton uses, chosen for being real, minimal, reversible and safe: candidates include a process or container on the engine's own host, or a dedicated user or container on the second machine (`mini-hp01`, reachable over Tailscale). **Constraint:** existing workloads on either machine (Sean's staging containers on `mini-hp01`, his sessions on the workstation) must never be touched; the target is created for Surety and torn down by it.
- T2. What qualifying that target and its adapter costs and requires from Sean (approvals, host access, credentials), stated before the build starts.

**Scope**
- SC1. **A decision for Sean, with a recommendation:** whether D4 covers Alpha only, the walking skeleton D1 §19.3 names, or also Beta (export by allowlist, the delivery repository on GitHub, publication approval, staging; F §7) and Live (go-live approval, recovery plan, rollback; F §7.7, §9.1). The driver's recommendation: **D4 designs the adapter contract and the deploy, verify and observe path generally, and M4 builds Alpha only**; Beta's export and publication, and Live's go-live and recovery, follow as D5, since each adds a new external effect (publishing source, production traffic) with its own approval floor.

**Carried in**
- X1. D3 §5 X3 and its reserved fields (`check_executions.deployment`, secret references on executions, the `environment_unbound` not-run reason): D4 completes them without reopening D3.
- X2. D3 Q7's note: a module whose files disappear has not thereby lost its external effects (stored personal data, scheduled jobs); say what the deployment design records about that, or list it as not claimed.
- X3. The `releases` entity (D1 §3.5) and the candidate states: what M4 writes (Alpha Deployed only, if SC1 is Alpha) and what stays reserved.

## 4. What D4 inherits and may not reopen

- **D1 draft 3** as corrected by the M1 build spec section 6, the resolution note, D2's K1 to K10, D3's corrections L1 to L8, and the errata E1 to E93. D4 extends them; a rule it needs changed is a numbered proposed correction with the test that would pin it, and Sean decides.
- **The mandatory floor of F §9.1:** observed deployment verification for every deployment state; reconciliation of interrupted external operations before retry; no approval or budget outcome turns a failed or missing required check into a pass. Nothing in D4 relaxes it.
- **D2's isolation and resource envelope** (sandbox, boundary, egress proxy, termination with closure, quarantine on unknown) wherever D4 runs a process; **D3's runner** for every check, environment-bound ones included.
- **Unknown is a value** everywhere: an unreadable environment, an ambiguous operation, an identity read that fails are `unknown`, never healthy, succeeded or verified.
- **The dependency rule:** `better-sqlite3` is the engine's only runtime dependency. A target's tooling (a container runtime, a cloud CLI) is the target's, reached by the adapter, never the engine's dependency.
- **Roles and process:** the role separation of `CLAUDE.md`, the lean procedure (E31, E40: journey first, fewest cases, scope frozen), and the lanes: kernel and sandbox at no cost; the exhaustion lane only on `mini-hp01`; the real lane (anything that spends Sean's subscription) only on his command.
- **Safety (E64, absolute):** any destructive test instrument fails closed in two halves; tests touch only what they created; nothing of Sean's is touched. A deployment test deploys only to a target Surety created for the test and tears it down.

**Lessons from M2 and M3 the design should respect:**
- **Engine-run probes, not agent-run ones.** An agent asked to attempt something that looks like an attack is refused by the model's safeguards, inconsistently (E82, E86). Anything adversarial is run by the engine, not asked of an agent.
- **Model fallback.** A run whose provider switched models mid-session is not the qualified model's work (E86 item 3).
- **No host write before the boundary closes.** Setup that follows links outside a namespace can write on the host (E93 S1).
- **Byte-exact materialization.** Anything built from a revision is built from the object store, never through a work tree with attributes (E93 S2).
- **Registration decides** (D3 L7). A newer pending execution blocks an older pass.
- **Host conditions.** The host check needs about 10 GiB available at the defaults (E87 item 7), and WSL interop can flake (E86 item 8). A real-lane run needs a quiet machine.

## 5. What D4 produces

- `docs/design/sdlc-design-D4-deployment.md`: prose for the architecture in D1's, D2's and D3's register (numbered sections; an appendix of closed enumerations for every new state, field, reason, error, event and configuration key; an open-questions section for Sean). Aim for D3's length or shorter.
- A table at its end, **contract precision pinned by tests**: every statement a test must pin, with a proposed name and lane. Design review stops where that table starts (E20).
- The adapter interface as a short reference, and the first target's adapter described against it.
- The qualification of an adapter and a target: what runs, what is recorded, what it costs.
- A list of what D4 does not claim, in the form of `docs/acceptance/reports/M2-not-claimed.md`.

## 6. How D4 is produced and judged

1. **Draft 1** by the design team, acting as architect under this brief. Read first: `CLAUDE.md`; F §§3.3 to 3.7, 4.1, 7, 9.1 and 10; D1 §§2.5, 3.4, 3.5, 7.10, 8.1, 9.6 and 19.3; D2 §§2.3 to 2.5, 3 and 8; D3 §§2, 5 X3 and 6; the errata E45 to E93; the predecessor incident record (`docs/reviews/predecessors/`), especially the deployment, partial-failure and duplicate-operation incidents; and the engine as built for operations, the journal and authorizations (`packages/engine/src/store/transitions/`, `src/journal/`), so that D4 names what exists.
2. **The driver's check** of draft 1 against this brief: every question of section 3 answered or listed as open; nothing of section 4 reopened; the test table present.
3. **Astra's cross-review, once**, with a brief in the form of `docs/reviews/D3/sdlc-design-D3-review-brief-astra.md`; her findings dispositioned by Sean.
4. **Draft 2** applies the dispositions. No draft 3 unless Sean asks.
5. **Sean approves D4 to build**; the M4 build spec and acceptance plan follow, as M3's did (E92).

## 7. What D4 is not

Not a CI/CD system: Surety does not replace a project's build tooling; it decides when an exact candidate may be deployed, drives the deployment through an adapter, and records what it observed. Not a cloud abstraction: one adapter contract and one real target, others later through the same contract. Not monitoring: the observation job reads the environment's condition for the record; production telemetry and the Mechanic (F §8) are later. Not Beta or Live, unless Sean's answer to SC1 says so.
