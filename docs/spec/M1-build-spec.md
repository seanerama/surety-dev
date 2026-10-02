# Surety M1 build specification

**Status:** in force from 2026-10-01. **Owner:** Sean. **Changes:** by the owner only.
**Readers:** the Claude Code sessions that verify, build and review M1, and Sean.

Surety is an evidence-gated delivery engine for AI coding agents. It drives headless coding agents through a governed lifecycle and lets nothing advance on an agent's say-so: only evidence the engine observed itself can satisfy a gate. This document tells you how to build its first milestone, M1. It does not restate the design. It tells you which documents hold the design, which parts of them have been corrected, who may write what, the order of work, and what "done" means.

Read sections 1 to 5 before doing anything. Sections 6 to 10 are reference for the slice you are working on.

---

## 1. What M1 is

M1 is the engine's core loop running against a **scripted adapter**: a stand-in for a coding agent that produces deterministic output and makes no model call. M1 has no real backend, no deployment, no publication, no sessions and no user interface.

M1 is accepted when two things are true: `npm test` exits zero on `main`, which requires every acceptance row M01 to M74 to have executable tests and none to be skipped; and the acceptance report in section 10 is written. Nothing less is acceptance.

Accepting M1 supports one claim: the kernel behaves as the acceptance plan requires on a scripted adapter, at the load limits the tests record. It does not support the claims that Surety can run a real agent, deploy anything, or has completed its first phase. Those wait for later milestones (section 10).

## 2. Sources and which one wins

All paths are from the repository root. The short names are used throughout this document.

| Short name | Document | What it is |
|---|---|---|
| **F** | `docs/foundations/sdlc-framework-foundations-v1.0.md` | The agreed principles, roles, state model and testing rules. |
| **E** | `docs/foundations/sdlc-foundations-v1.1-errata-draft.md` | Sean's decisions E1 to E40 that amend F. The merged v1.1 text has not been produced; read F with E. |
| **RN** | `docs/design/sdlc-design-D1-resolution-note.md` | Seven design corrections to D1 (R1 to R7) and the rule that ended prose review. |
| **Plan** | `docs/acceptance/sdlc-M1-acceptance-plan-Astra.md` | The M1 acceptance matrix: 74 rows, each a scenario with a required observable result. Written by Astra, the second architect. |
| **D1** | `docs/design/sdlc-design-D1-engine-core.md` | The engine architecture, draft 3: entities, store, git, scheduler, gate function, decisions, API, recovery. |
| **Review** | `docs/reviews/D1/sdlc-review-D1-draft3-Astra.md` | The last review of D1. Its findings B01 to B19 were accepted as correct; they are the reasons behind many Plan rows. |

When two sources disagree, the higher one in this list wins:

1. **F with E.** Sean's decisions.
2. **RN section 2.** It amends D1 wherever they differ.
3. **The Plan, and the executable acceptance tests once Sean has merged them.** A merged test is the contract for the behavior it pins.
4. **The Review's replacement text**, only where RN section 2 is silent. RN decided three points differently from the Review and wins on each: the protected fingerprint has no field projection; there is no checkout-updating protocol; a quarantine ends only on observed termination.
5. **D1 sections 1 to 19.** The architecture. Follow it wherever items 1 to 4 are silent.
6. **D1 Appendix A.** A starting point for names and schema only. D1's own header says Appendix A governs the body; RN section 3 reversed that. The appendix is known to be wrong in the places section 6 lists. Do not correct it by hand; it will be generated from the engine's schema and transition tables (Plan row M73).

This specification decides only what those sources leave open: who does what, in what order, the repository conventions and the test seam. Where it restates a source and gets it wrong, the source wins and the error is reported to Sean.

**Do not write a new draft of D1.** Three rounds of prose review did not converge, and Sean stopped that method (E20). A new finding is classified, not written into a design document: a design decision goes to Sean; a contract defect becomes a failing acceptance test.

## 3. Scope

**Built in M1** (D1 §19.3, RN §4, Plan §1):

- Runtime store: schema, migrations, transition functions, append-only history, identity.
- Engine startup, single-incarnation lock, restricted and full modes, closed configuration.
- Work items, triggers, the scheduler tick, leases and fencing, one run per project.
- The model-invocation choke point with the scripted adapter only; execution domains; the run-end protocol; Stop, Abandon, Resume; deadlines; quarantine.
- Git performed by the engine: workspaces, snapshots, diff validation, commits, integration, the ref registry, repository integrity, nomination, the journal and its recovery.
- Protected path: proposal capture and application, protected versions.
- The gate function for two gate kinds: `stage` and `alpha_authorize`.
- Findings, sign-offs, applicability assessments.
- The attention queue for the eleven decision kinds listed below.
- Ledger, usage observations, budgets; records, redaction, retention; backup and restore.
- The local HTTP API and event stream for all of the above; crash recovery.

**Work kinds that can be dispatched:** `stage_build`, `fix`, `verification`, `review`, `check_correction`, `replan`, `assessment`.

**Decision kinds that have effect:** `blocker`, `out_of_band_change`, `stop_confirm`, `abandon_confirm`, `policy_widening`, `finding_disposition`, `severity_lower`, `finding_applicability_exclusion`, `check_correction_tightening`, `check_correction_loosening`, `check_correction_unclassifiable`. D1 §19.3 lists eight; the Plan's eleven govern.

**Present only as a refusal** (Plan row M08). Each of these must fail before any launch or effect, with a declared error: opening or using a session; evaluating any gate kind other than `stage` and `alpha_authorize`; deploy, publish or export; management activation; any real backend, version or mode. An `alpha_authorize` evaluation may issue an authorization record for a configured test target. It never deploys and never reports a candidate as Alpha Deployed.

**Not built at all:** the UI package, environments' observation jobs and observation history, the Mechanic, adoption analysis, real notification transports. Tables D1 reserves for later designs are not created; a reserved name confers no authority.

Baseline inputs (an approved spec, architecture, plan) enter M1 as clearly labeled test fixtures. There is no public route that grants an approval silently.

## 4. Roles and how work moves

The foundations' first principle is that the Builder cannot determine acceptance alone. M1 is built by Claude sessions in three roles that never share a session. Using the same model in each role is permitted; separate sessions, separate write permissions and an exit-status judgment are what make the roles independent (F §5.5).

| Role | Who | May write | Never |
|---|---|---|---|
| **Verifier** | A Claude Code session, new for each slice | `packages/engine/test/acceptance/`; `docs/acceptance/objections/`; `docs/acceptance/reports/` | Weakens a row to make it passable. Derives an expected result from the engine's output. |
| **Builder** | A different Claude Code session | `packages/engine/src/`; `packages/engine/migrations/`; `packages/engine/api/`; `packages/engine/test/unit/`; `docs/acceptance/objections/` | Edits, skips or disables an acceptance test, its fixtures, the manifest or the runner. Approves its own work. |
| **Reviewer** | A third session, new for each review | Nothing. It reports findings to Sean. | Modifies anything it reviews. |
| **Owner** | Sean | Everything else: decisions, `docs/foundations`, `docs/design`, `docs/spec`, `docs/reviews`, the Plan, `CLAUDE.md`, `scripts/`, every `package.json`, `tsconfig.json`, the lockfile, and every merge to `main`. | — |

Each role's list is complete. A change to any path not on a role's list is a boundary violation, and `scripts/check-role-boundary.mjs` enforces exactly these lists. A session that needs an owner-only file changed (a new dependency, a compiler option, a row added to the Plan) asks Sean.

Astra wrote the Plan and does not take part in the build (E21). The Plan remains the inventory of what must be tested. Her budget is limited, so Sean asks her for a cross-review at milestones only; slice reviews are done by a Claude Reviewer session.

**One slice, start to finish:**

1. **Verify first.** A Verifier session on branch `verify/slice-N` writes the slice's acceptance tests from the Plan rows, lists their files in the manifest under that slice, and commits.
2. **Sean merges** after `node scripts/check-role-boundary.mjs verifier main verify/slice-N` exits zero.
3. **Build.** A Builder session on branch `build/slice-N`, cut from the updated `main`, implements and commits until `node scripts/run-tests.mjs acceptance --slice N` exits zero. That command runs the files listed for slices 1 to N, so an earlier slice cannot regress unnoticed.
4. **Review.** A Reviewer session reads the Builder's diff against the tests and D1 and reports findings, each classified as a design decision (for Sean) or a contract defect (a new failing test for the Verifier).
5. **Sean merges** after `node scripts/check-role-boundary.mjs builder main build/slice-N` exits zero and the slice command passes. A session may run git commands for Sean on his instruction; the decision to merge is his.

**From slice 4 the procedure is lighter (E31, Sean's decision).** One review per slice: a finding confirmed as serious becomes a failing test and gets one fix, judged by the tests; everything else is recorded for the next slice's Verifier. Verifiers write the fewest cases that pin each row's required result, and no stand-in engine or self-check. The next slice's Verifier works in a separate working copy while the current slice's Builder builds, so steps 1 and 3 of consecutive slices overlap.

The boundary check sees commits only and refuses to run on a working tree with uncommitted changes. It compares the branch with the point where it left `main`, so later commits on `main` are not counted against the branch.

**Who decides what the sources leave open.** The sources do not fix every name: an error code for an excluded capability, the exit status of a locked engine, a configuration key and its range. The Verifier decides these by writing them into a test and recording them in `harness/SEAM.md`. That is what tests-first means here. Use D1 Appendix A's names for tables, columns, enumeration values, events and error codes wherever section 6 does not correct them, and choose the plainest option where Appendix A has none. The Builder implements the names the tests fix and may object.

**Expected results come from the sources, not from the engine.** The Verifier keeps its own expected transition tables under `packages/engine/test/acceptance/contract/`, derived from D1 A.5 with the section 6 corrections, and generates transition cases from those. A test never reads the engine's own table to learn what is legal (Plan §2).

**Objections.** A Builder who believes a test is wrong does not work around it.

1. The Builder commits `docs/acceptance/objections/NNN-<row>-<slug>.md` on its build branch, stating the row, the test, what it believes is wrong and the source text that supports the claim. It tells Sean and continues with other work.
2. Sean starts a Verifier session on a branch `verify/slice-N-objection-NNN` cut from `main`. It reads the objection with `git show build/slice-N:<path>` and commits its answer as `NNN-<row>-<slug>.answer.md`, citing sources. If it upholds the objection it changes the test in the same branch.
3. Sean merges that branch. The Builder merges `main` into its build branch and continues.
4. If the two still disagree, Sean decides.

An open objection does not make a failing test pass.

**Commits.** Small, each with a message that says what changed and why. End every commit message with a `Surety-Role:` trailer naming the role (`verifier`, `builder`, `reviewer` or `owner`) after the co-author line. The trailer is a record, not the control; the boundary script is the control.

## 5. Fixed technical constraints

These are decided (E17, E18, D1 §6.1). Changing one is a decision for Sean.

- **Runtime:** Node 22 or later, on Linux. ES modules.
- **Language:** TypeScript compiled by `tsc` and nothing else. No bundler, no other transpiler, no copy step.
- **Assets that are not TypeScript** live beside `src/`, not in it, and are loaded at run time relative to the package root: migrations in `packages/engine/migrations/` as numbered `.sql` files, and the API contract at `packages/engine/api/schema.json`.
- **Dependencies:** `better-sqlite3`, pinned to an exact version, is the engine's only runtime dependency. Development dependencies are pinned to exact versions. Adding any dependency needs Sean's approval. One addition is expected: a browser driver for row M68.
- **Tests:** `node:test` and `node:assert`. No test framework.
- **Store:** SQLite in WAL mode, `synchronous=FULL`, foreign keys on. The connection lives in a worker thread behind one store interface. No transaction is held across a git call, an adapter call or a stream write.
- **Schema growth:** each slice adds the tables its rows touch. Until M1 is accepted no store exists outside a test, so a migration file may be rewritten. From acceptance on, an applied migration is immutable.
- **Git:** every command is spawned with an argument array, a constructed environment, explicit `--git-dir` and `--work-tree`, bounded output and a deadline. Never a shell string.
- **Engine home:** all runtime state lives under `$SURETY_HOME`. None of it is ever written into a tracked tree.
- **Engine settings:** read once at startup from `$SURETY_HOME/config.json`; changing one means a restart (E22).
- **API:** HTTP/1.1 on `127.0.0.1`, default port 7227, server-sent events for streams.

## 6. Design in force: D1 with its corrections

Read D1 for the architecture, then apply this table. Every entry is already decided. "Pinned by" names the Plan rows whose tests will hold the corrected behavior; where part of a correction is not tested until a later milestone, the entry says so. The Review section named under "Source" gives the full reasoning.

| # | D1 says | In force | Source | Pinned by |
|---|---|---|---|---|
| 1 | §2.7, §4.5 step 2, §16.1: live processes of a domain are found by process group and environment marker, and that establishes termination. | Markers and process groups are diagnostic aids only. Termination is established by an execution-boundary service whose membership cannot be escaped and whose emptiness is observable after restart. In M1 the scripted adapter plays that service and reports running, terminated or unknown. Unknown means quarantine. Terminating a domain is a reusable operation, invoked before a snapshot is admitted and by the run-end protocol. | RN R3; Review B08 | M13, M16–M18, M21 |
| 2 | §4.1: a quarantined run ends when termination is established "or the operator resolves the quarantine". | A quarantine ends only on observed termination. An operator's acknowledgement establishes nothing. | RN R3 | M16, M17 |
| 3 | §5.2, A.9: governed policy fields live in `.surety/policy.json` and the fingerprint covers them. | Governed fields live in `.surety/checks/protected-policy.json`, inside the protected roots. The fingerprint is SHA-256 over the sorted (path, blob id) list of the protected roots, with no field projection. `.surety/policy.json` holds only ungoverned settings. | RN R2; Review B19 | M35, M49 |
| 4 | §3.4, §9.6, A.2, A.5: a satisfied `*_authorize` evaluation creates the authorization as `issued`. | The authorization row is created first with status `proposed`, binding candidate, environment, artifact and mapping, configuration, exact targets, policy, protected version, recovery plan and a generation. A satisfied evaluation moves it to `issued`. The full transition set is proposed→issued, proposed→superseded, issued→consumed, issued→superseded, consumed→superseded. | RN R1; Review B03 | M44 pins proposal, single issuance, and that a changed scope cannot reuse an authorization. Consumption, supersession after consumption and the stability of the review-content binding are deferred trace F03; M1 builds no consumer. |
| 5 | A.2, A.8: 25 decision kinds. | Two more: `finding_applicability_exclusion` and `check_correction_tightening`. | RN R4; Review B18 | M52, M53 |
| 6 | §7.2, §7.6: the developer's checkout of the integration branch is a managed checkout that integration may leave behind. | The integration branch is engine-owned. If it is checked out in any worktree the engine does not own, integration is refused before the ref moves, with an instruction to switch branch or detach. No checkout-updating protocol exists. Managed checkouts and checkout-subject integrity observations remain part of the design. | RN R5; Review B05 | M22 pins the refusal. M25 and M46 pin checkout-subject integrity on a managed-checkout fixture. |
| 7 | §11.1: token bootstrap requires an `Origin` or `Referer` while the page policy is `no-referrer`. | The UI requests bootstrap with a per-request same-origin referrer policy. Enumerated static shell routes load without a token after Host and target checks and carry no token, project data or authority. Missing evidence fails closed. | RN R6; Review B14 | M68 |
| 8 | §9.1: a requirement is delivered if and only if every stage listing it in `implements` is integrated at an ancestor revision. | That predicate is true when no stage lists the requirement. A requirement with no implementing stage is not started. Deployment evaluations use delivered requirements plus release obligations. | RN R7, RN §3 B01; Review B01 | M38 |
| 9 | §9.1: one scope rule for all gate kinds. | A `phase` gate includes every obligation assigned to the phase regardless of delivery. | RN R7 | M08 pins that a phase gate is refused in M1. The rule itself is deferred trace F01. |
| 10 | §6.2: receipts are unique on `(run, turn)`. | SQLite allows duplicate rows when `turn` is null. Use `UNIQUE(run) WHERE turn IS NULL` and `UNIQUE(turn) WHERE turn IS NOT NULL`. That a turn belongs to its run, and that run kind agrees with nullability, is enforced in the database, because the tests attempt these writes directly. | Review B11 | M02, M03 |
| 11 | A.5: common work-item transitions apply to every kind; Abandon restores to eligible. | Common transitions are templates limited to states that kind can reach and to their named cause. Returning from `awaiting_decision` restores a stored, permitted continuation. Stop→held and Abandon→recorded prior state exist from every state that owns a run, including `integrated` and `awaiting_decision`. The legal transitions are one table, held as data. | Review B10 | M09, M13, M14 |
| 12 | A.5 Run: no created→finalizing; §16.1: recovery sets outcome `recovered`. | Recovery can end a run from `created`. It preserves an outcome already recorded and records the recovery separately. | Review B17 | M18 |
| 13 | A.5 Domain: `quarantined` has no exit. | quarantined→terminated on observed termination. | Review B17 | M17 |
| 14 | §7.10, A.5 Journal: recovery skips `confirmed` entries; `ambiguous` has no exit; each kind's probe is named but its outcomes are not. | Recovery visits every operation not `finalized`, including confirmed ones, which run only their finalizer. Each of the four journal kinds has a probe that classifies the effect as absent, applied, partial, conflicting or unknown, whether or not a receipt survived. Unknown and conflicting block. A retry needs positively reconciled absence or an explicitly bounded remaining effect. Finalizer inputs are frozen before the effect, and repeating a finalizer returns the same receipts. | Review B05, B17 | M26, M29–M33 |
| 15 | §7.3 step 4: any managed checkout the role altered is rejected. | For the run's own workspace, file content is judged by the captured diff. Its HEAD, index, git metadata and identity file stay invariant. A permitted edit is never a ref violation. | Review B05 | M19 |
| 16 | A.5 Attempt: no rule admits the first attempt; some states derive no operation status. | Every attempt state derives an operation status. The first attempt is admitted once. A failed attempt is never treated as proven absence. | Review B17 | M34 |
| 17 | §7.6, §7.9, §9.2: results are "invalidated" with no stored representation. | Check-result invalidation is durable and separate from evaluation staleness. Selection rejects an invalidated result, including after restart. | Review B17 | M40 |
| 18 | §3.4, A.3: an evidence-reuse entry points at a generic record. | Reuse needs a typed, assessed reuse entry that preserves every binding. If the reuse contract is incomplete, reuse is refused and the check stays unsatisfied. | Review B17 | M41 |
| 19 | §6.4: the applied-migration list "is a table" that A does not declare. | A migration history table holds identity, order and checksum. A changed checksum on an applied migration prevents full mode. | Review B17 | M05 |
| 20 | A.9: project `max_concurrent_runs` ranges 1 to 8; port, git limits, snapshot caps and decision targets are absent. | Project concurrency is exactly 1 through M3. The closed configuration declares the API authority and port, git deadline and output limits, snapshot caps, and decision-target overrides, each with a range. | Review B17; E18 | M07 |
| 21 | §14.1: chunk receipts reference a record that does not exist until the stream is published. | A stream has a durable pre-publication identity that its chunk receipts reference. A pre-publication stream is never gate evidence. | Review B17 | M63 |
| 22 | A.8: one dependency manifest per group of decision kinds. | Each enabled kind binds its complete consequence. A change that leaves the action eligible but alters the consequence still stales the preview. An effect's own expected consumption does not invalidate it; an unrelated change does. | Review B12 | M45–M57 |

Three D1 defaults deserve a reminder because code tends to drift from them:

- **Unknown is a value.** Unknown usage is null, not zero. An unreadable repository is refused, not clean. Unconfirmed termination is quarantine, not success. A missing record is `EVIDENCE_MISSING`, not an empty record.
- **Nothing writes `passed`.** A check's state is derived at evaluation from a recorded execution (D1 §9.2). No role, approval, budget or setting converts another state to passed.
- **A confirmed probe is not completion.** Completion is the finalizer (D1 §7.10).

## 7. Repository layout

```
package.json  package-lock.json   workspaces and pinned versions      OWNER
CLAUDE.md                         standing instructions for sessions  OWNER
scripts/                                                              OWNER
  run-tests.mjs                   the test runner
  check-role-boundary.mjs         the role-boundary check
  d1-consistency.mjs              lexical check of D1 (historical; not a gate)
packages/engine/
  package.json  tsconfig.json     bin `surety`; better-sqlite3 pinned OWNER
  src/                                                                BUILDER
    store/                        worker, transitions/
    git/                          context, registry, snapshot, validation, journal, integration, integrity
    scheduler/                    tick, leases, triggers
    gate/                         scope, evaluate, reasons, effect plans
    decisions/
    invoke/                       the choke point
    records/  ledger/  recovery/
    api/                          server, routes, cli
    testing/                      the engine side of the test seam (section 8), including the scripted adapter (E23)
  migrations/                     numbered .sql files                 BUILDER
  api/schema.json                 the API contract                    BUILDER
  test/unit/                      developer tests                     BUILDER
  test/acceptance/                                                    VERIFIER
    manifest.json                 each slice's test files
    COVERAGE.md                   every Plan case: its file, slice and status
    contract/                     the Verifier's expected transition tables
    harness/                      the test side of the seam, and SEAM.md
    M<nn>-<slug>.test.mjs         one or more files per Plan row
packages/ui/                      not part of M1
docs/                             see docs/README.md
```

Today only the scaffold exists: an engine package that builds, reports its version and refuses every command, with one developer test of the toolchain. The Builder adds each directory when its slice needs it.

**Acceptance test files.** ES modules named `M<nn>-<slug>.test.mjs`, where the slug is lower-case letters, digits and hyphens. A row may have several files when its cases belong to different slices. Each named case in a Plan row is a separately reported subtest with its own fixture. The manifest lists files by base name under the slice where they must first pass.

**What the runner enforces** (`scripts/run-tests.mjs`). It builds first, then runs one test file at a time, each test under a ten-minute limit that `SURETY_TEST_TIMEOUT_MS` overrides. It exits non-zero if a test fails; a test is skipped or marked todo; a file that ran has no passing test; a file is misnamed; a file is not listed under any slice; a listed file is missing; or, on a full run, a row has no file. The row inventory M01 to M74 is fixed in the runner, so a row cannot be dropped by editing the manifest.

**`COVERAGE.md`** is how one Verifier session hands over to the next. It lists every named case of every Plan row with the file that holds it, the slice it is listed under, and whether it is written. A case deferred to a later slice is recorded there when it is deferred.

## 8. The test seam

The Verifier writes tests before the engine exists, so both sides need an agreed boundary. This section fixes its shape. The Verifier fixes its exact names and formats in `packages/engine/test/acceptance/harness/SEAM.md` when writing slice 1, and extends that file in later slices. The Builder implements the engine side under `src/testing/`.

**Tests observe the engine from outside.** In order of preference:

1. **The process.** Start the built `surety` binary with a fresh `$SURETY_HOME` in a temporary directory and a port the test chooses, never the default. Kill it with real signals.
2. **The API.** Real HTTP and server-sent events on loopback, through a harness client that always sends the correct Host header and token. Slice 1 builds the Host check, the token and the audit event for the routes it has, so that early tests stay valid when slice 6 completes the boundary.
3. **The store file.** Open `store.db` directly with the pinned driver to read durable rows, and to attempt forbidden writes in constraint tests (rows M03, M04). This needs no engine endpoint, and no engine endpoint may offer arbitrary state writes.
4. **Git.** Real git commands against real repositories and worktrees in temporary directories.

**The engine provides, only in harness mode:**

| Capability | Purpose | First needed by |
|---|---|---|
| Fixture installer | Installs a registered project, an approved baseline, a plan with stages and work, and protected checks, each labeled as test setup. | M07 (a project), M09 (a plan and work) |
| Scripted adapter, backend id `scripted` | Deterministic role output: files written in the workspace, the structured result, usage observations, delays, exit, callbacks arriving late. | M02, M09 |
| Scripted execution boundary | Reports a domain as running, terminated or unknown, on the test's instruction. | M13, M16 |
| Barriers | Named points at which the engine pauses until released, or kills itself: at least intent commit, effect application, receipt commit, probe confirmation, finalizer commit, mid-migration, and the launch boundaries of row M18. | M05, M18, M33 |
| Controlled clock | Deadlines, aging and expiry without real waiting. | M15, M58 |
| Fault injection | A named failure in a store transaction, an audit write or a migration. | M04, M05, M61, M69 |
| Scripted notification sink | A local sink that can succeed, fail or leave delivery unknown. | M58 |

**Rules for the seam:**

- Harness mode is entered only by an explicit startup flag, never through the API, and `GET /v1/engine` reports it.
- Outside harness mode the `scripted` backend is refused like any unqualified backend, and every seam call is a no-op.
- Production code reaches the seam through one module. Nothing else in `src/` branches on being under test.
- The scripted adapter and boundary prove the engine's reactions. They do not qualify any real containment, runner or classifier, and no test may claim they do (Plan §2).
- Two lanes need real resources the seam cannot fake: a real browser for row M68, and a durability fault harness that can discard unsynced writes for row M67. Killing a process is not a power-loss test.

**A limit the Verifier should plan for.** Until a slice is built, every one of its tests fails at its first step, so running a test cannot show that the test itself is right. Keep harness helpers small, exercise the ones with real logic against a scratch SQLite database or git repository, and expect some test defects to surface during the build. They are fixed through the objection procedure, not by the Builder.

## 9. Slices

The order is the Plan's (§5). The kernel's parts depend on each other, so many rows have at least one case that cannot pass until a later slice. The Verifier resolves this case by case: the row's cases are split across files, each file is listed in the manifest under the slice where it must first pass, and `COVERAGE.md` records the split. **A row closes when its last file passes. A slice's exit is its manifest list, not a row range.**

The API and the decision queue grow with every slice. Each slice adds the routes and decision kinds its rows need; slice 5 completes the decision manifests and slice 6 completes the API boundary.

| Slice | Capability delivered | Rows introduced | D1 sections |
|---|---|---|---|
| **1. Store and startup** | Migrations with history; the transition framework; identity and sequence numbers; the tables rows M03 and M04 name, with their constraints and append-only triggers; engine lock and incarnation; startup sequence and restricted mode; closed configuration; health and engine routes with the Host check, token and audit event; refusal of excluded capabilities at the API; a fixture-installed project. | M03–M07; the store cases of M02; the API cases of M08; the Host, token and audit cases of M69 (E22) | §§1, 2, 6; A.1–A.3, A.9 |
| **2. Work, runs and interruption** | Work items and their transition table; triggers; the tick; leases and fencing; receipts, status and usage observations, and the original ledger row, because the run-end protocol writes them; domains and process ownership; the invocation choke point with the scripted adapter and boundary; the run-end protocol; Stop, Abandon, Resume; deadlines; quarantine and its clearance; run recovery. Workspaces are created through the journal's ordinary path. A minimal `blocker`, `stop_confirm` and `abandon_confirm`. | M09–M18; the rest of M02; the scheduler cases of M08 | §§3.2, 4, 8, 13.1, 15, 16 |
| **3. Git and the journal** | Execution context and ref registry; project bootstrap through the API; snapshot admission and validation; commits; checkpoints; integration by compare-and-swap; repository integrity; nomination; plan and stage finalizers; the full probe and recovery matrix for all four journal kinds; operation attempt semantics. | M19–M34 | §§3.1, 3.3, 3.5, 7 |
| **4. Ledger, records and backup** | Ledger corrections and normalization; budgets and fail-closed reads; the durable record path, chunk receipts, redaction and rescan; retention; backup and restore; power-loss durability. | M59–M67 | §§6.5, 6.6, 13, 14 |
| **5. Protected path, gates and decisions** | Governed policy file; proposal capture and application; acceptance scope; check states; evidence invalidation and reuse; findings, severity, sign-offs; `stage` and `alpha_authorize` evaluation; the proposed authorization; every enabled decision kind with its manifest; dedupe, batching, consumption, pre-effect revalidation; aging and escalation. | M35–M58 | §§5, 7.9, 9, 10 |
| **6. API, load and contract** | Browser bootstrap; the HTTP boundary matrix and audit; scoped reads and the NOW projection; latency under declared load; bounded event streams; the generated appendix and contract checks; fixture semantics and the invocation-boundary lint. | M68–M74 | §§11, 12, 17 |
| **7. Journey** | Nothing new. The end-to-end run observed through the public reads of slice 6. The journey itself (`M01-kernel-journey`) is the first target of slice 5 (E40). | M01 | — |

**Cases known to belong to a later slice than their row.** This list is a starting point for the Verifier, not a complete analysis.

| Row | Case | Waits for |
|---|---|---|
| M08 | Refusal of a gate kind, which needs a candidate and a gate route | Slice 5 |
| M09 | Legal paths that integrate (`stage_build`, `fix`, `replan`, `assessment`); `check_correction`, which needs a protected proposal | Slices 3 and 5 |
| M11 | Progress key over a snapshot tree; findings; a repair that completes | Slices 3 and 5 |
| M12 | The over-budget case | Slice 4 |
| M13, M14 | Stop and Abandon from integrating, integrated and verifying; an in-flight journal operation | Slice 3 |
| M15 | Writes that become ambiguous; integrity as a prerequisite step | Slice 3 |
| M24 | "Block affected gates" | Slice 5 |
| M61, M62 | Faults in gate and decision transactions; out-of-band changes blocking gates | Slice 5 |
| M64, M65 | A Critical finding that quarantines evidence; retention held by a decision, finding or gate | Slice 5 |

**Entry to a slice:** its acceptance files are merged and listed in the manifest. **Exit:** `node scripts/run-tests.mjs acceptance --slice N` and `npm run test:unit` exit zero on `main`, both boundary checks passed, and every review finding is either fixed, converted to a test, or decided by Sean.

**Stopping rule inside a slice.** The Builder builds what a row or a source requires and stops. No table, route, option or abstraction is added because a later slice or milestone might want it. Testing stops when the required rows pass (F §5.8). Adding a row to the Plan needs a concrete new finding and Sean's decision.

## 10. Done, and what comes after

**M1 is accepted when** `npm test` exits zero on `main` and the Verifier has written the acceptance report at `docs/acceptance/reports/M1-report.md`. The report records the test and engine revisions; operating system, Node, SQLite, git and browser versions; the load limits that were qualified; and the process-kill and power-loss results separately (Plan §5).

**Still closed after M1,** each needing its own design before work starts:

- Any real backend. It waits for the adapter contract and the qualification of control-plane isolation and the execution boundary (D2). Until then the engine refuses every real backend.
- The real check runner and diff classifier (D3).
- Sessions, a second backend and real-binary test lanes (M2).
- A real deployment target and Alpha completion (M3), which is what closes Surety's own first phase.
- The Plan's deferred traces F01 to F08.

## 11. Known open items

None of these blocks slice 1.

| Item | Why it matters | When it bites |
|---|---|---|
| Power-loss harness for row M67 | It must distinguish synced from unsynced state on real SQLite and real git. That may need a privileged device or filesystem setup on this WSL2 host, which is Sean's call. Without it M67 stays unpassed and M1 is not accepted. | Slice 4 |
| Browser driver for row M68 | **Decided (E36 item 1):** Playwright, one development dependency pinned exactly, driving Chromium and Firefox; both versions are recorded in the report. | Slice 6 |
| Numeric load limits for row M71 | **Decided (E36 item 2):** 5 projects, 20 connected clients, a 1 GB database, at the default 250 ms latency bound. Nothing larger is qualified. | Slice 6 |
| Foundations v1.1 text | E1 to E40 are not yet merged into one document. | Whenever convenient |
| Package name | "surety" has not been checked on npm. Both packages are private until it is. | Before any publication |
| `.surety/project.json` for this repository | Not created. The engine's own bootstrap or adoption transition is its only writer (E2), and Surety adopts itself only after M3. | After M3 |

## 12. Starting a session

Each prompt is complete as written. Replace `N` with the slice number.

**Verifier:**

> You are the Verifier for slice N of Surety M1. Read `CLAUDE.md`, then `docs/spec/M1-build-spec.md` sections 1 to 9, then `packages/engine/test/acceptance/COVERAGE.md` and `harness/SEAM.md` if they exist, then the rows for slice N in `docs/acceptance/sdlc-M1-acceptance-plan-Astra.md` and the sources each row cites. Create branch `verify/slice-N` from `main`. Write the executable acceptance tests for those rows, and for any earlier row's cases that `COVERAGE.md` defers to this slice, under `packages/engine/test/acceptance/`. List each file in `manifest.json` under the slice where it must first pass. Where a case cannot pass until a later slice, do not write it now: record it in `COVERAGE.md` with the slice it waits for. Define or extend `harness/SEAM.md` with exactly what the engine must provide, including every name you fixed that the sources left open. The engine is not built, so these tests cannot pass yet and running them will not validate them; check your harness helpers directly where they have logic. Write only the paths the spec's role table allows you. Commit your work, run `node scripts/check-role-boundary.mjs verifier main verify/slice-N`, and report: the files written, the cases per row, the cases deferred and to which slice, anything in the Plan you could not turn into a test and why, and any question that is Sean's to decide.

**Builder:**

> You are the Builder for slice N of Surety M1. Read `CLAUDE.md`, then `docs/spec/M1-build-spec.md` in full, then `packages/engine/test/acceptance/harness/SEAM.md` and the test files `manifest.json` lists for slice N. Create branch `build/slice-N` from `main`. Implement the engine until `node scripts/run-tests.mjs acceptance --slice N` and `npm run test:unit` both exit zero. Write only the paths the spec's role table allows you; in particular, change nothing under `packages/engine/test/acceptance/`. If you believe a test is wrong, file an objection as spec section 4 describes and keep going on the rest. If you need an owner-only file changed, stop and say so. Build only what the rows and sources require. Commit your work, run `node scripts/check-role-boundary.mjs builder main build/slice-N`, and report: what passes, with the command output; what does not and why; every objection filed; and anything you built that no row required.

**Reviewer:**

> You are the Reviewer for slice N of Surety M1. Read `CLAUDE.md` and `docs/spec/M1-build-spec.md`. Review the changes on `build/slice-N` since it left `main` (`git diff main...build/slice-N`) against the slice's acceptance tests, section 6 of the spec, and the D1 sections the slice covers. Change nothing. Report findings most serious first, each with file and line, a concrete failure scenario, and a classification: a design decision for Sean, or a contract defect that needs a new failing test. Say plainly if you found nothing. Look in particular for behavior the tests do not pin: a store write outside a transition function, a transaction held across an external call, an effect without a committed intent, an unknown treated as a success, and anything built that no row requires.
