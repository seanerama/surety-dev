# Surety M3 build specification

**Status:** draft 1, written by the architect for Sean's approval (E91 item 3), 2026-10-06, with the M3 acceptance plan (`docs/acceptance/sdlc-M3-acceptance-plan.md`). Not in force until Sean adopts it. **Owner:** Sean. **Changes:** by the owner only.
**Readers:** the sessions that verify, build and review M3, and Sean.

M1 built the kernel on a scripted stand-in for a coding agent (`docs/spec/M1-build-spec.md`; accepted, E45). M2 made the engine run one real coding agent inside isolation the host qualifies and the engine observes (`docs/spec/M2-build-spec.md`; accepted, E88). In both, every check result a gate read was written by a test: no part of the engine has run a check (E89 item 1; `M2-not-claimed.md`, "a check's execution in the real journey is a fixture"). M3, this document, makes the engine **run a project's protected checks itself**, judge them, and compute what a gate requires, as D3 draft 2 designs. Everything the M1 and M2 specs fix about roles, constraints and procedure stays in force; this document says only what M3 adds or changes.

Read sections 1 to 5 before doing anything. Sections 6 to 12 are reference for the slice you are working on.

---

## 1. What M3 is

M3 is **the direct workspace check runner** of D3 draft 2 (E89, E90, E91), on this WSL2 host: the protected acceptance path at runtime (governed schemas, discovery that runs nothing, the input manifest), the check runner of class `direct` (registration, a check tree with no `.git`, a `check`-profile domain whose inputs are immutable at their pathnames, launch and observation through D2's boundary, the result and its output record, the runner self-test at host qualification), the diff classifier with its conservative fallback, validation scope at run time (criterion coverage, the kind inventory per tier, the sensitivity floor, module tiers and cadence), the repair loop on a failed check, finding resolution under F2 (c), the gate's own ref reads, and the Builder's objection route. M3 has no deployment, no environment-bound check, no `container` or `remote` runner, no phase gate, no sessions and no user interface.

M3 is accepted when:

- `npm test` exits zero on `main` for the kernel, sandbox and project lanes, which requires every M3 acceptance row (M201 to M241) to have executable tests and none skipped, and the M1 and M2 rows to keep passing;
- the runner self-test has passed on this host at an engine start, so `host_qualifications.check_runner` is `qualified` with every mandatory case and control `passed`, recorded with its evidence;
- the exhaustion-lane file of row M205 has passed on the designated host (E69), if Sean answers the plan's question 7 (a);
- the real-lane row M239 has passed under Sean's command, if Sean answers the plan's question 5 (a) or (c), with its records retained;
- the M3 acceptance report is written (section 10).

Nothing less is acceptance.

Accepting M3 supports one claim: on this host, with the recorded versions and limits, the engine executed a project's protected checks itself, in a `check` domain it qualified, against the protected version in force and never the candidate's copy, and judged each by the exit status of the check's own process as the engine observed it; it selected evidence by latest registration and never fell back to an older pass; it classified protected changes conservatively; it required the coverage, kinds and floors of D3 §4 before a gate could be satisfied; and it resolved a finding only through a required acceptance check covering the finding's criterion. It does not support the claims that a check tests what it says (that is the Verifier's construction and the Reviewer's assessment, D3 §6 class C), that any other host, runner class or environment-bound check is qualified, or that Surety can deploy anything.

## 2. Sources and which one wins

The M1 and M2 specs' tables stand, with these added. Where sources disagree, the later decision wins: the errata over D3, D3 over D2 and D1 where its numbered corrections (L1 to L8) say so, the adopted M3 acceptance plan over all of them for what a row requires, and the merged tests over the plan for contract detail (E20).

| Short name | Document | What it is |
|---|---|---|
| **D3** | `docs/design/sdlc-design-D3-checks.md` | Draft 2, approved to build (E90, E91): the protected path at runtime, the check runner, the diff classifier, validation scope; corrections L1 to L8 to D1 and D2; decided questions Q1 to Q11; Appendix C's 67 test statements in three lanes. |
| **D3 brief** | `docs/design/sdlc-design-D3-brief.md` | What D3 had to answer; the inheritance rules. |
| **Review** | `docs/reviews/D3/sdlc-review-D3-Astra.md` | Astra's cross-review (AD): amendments B01 to B04, suggestions N01 to N04, test cases T01 to T20, all applied in draft 2. |
| **Decisions** | `docs/design/sdlc-design-D3-decisions-prep.md` | The decision sheet E89 and E90 answered. |
| **M3 plan** | `docs/acceptance/sdlc-M3-acceptance-plan.md` | The M3 acceptance matrix: 41 rows M201 to M241, derived from D3 Appendix C; adopted with this spec. |
| **E** | the errata, E89 to E91 | M3's opening, D3's approval with Astra's amendments, the questions draft 2 raised. |
| **SEAM** | `packages/engine/test/acceptance/harness/SEAM.md` | The test contract as it stands; M3 extends it. |

## 3. Scope

**In M3:**

- The governed set at runtime (D3 §1): the closed schemas of the six governed fields with every default and unit (A.4), check definitions, discovery as a function of a tree with engine git, the input manifest of path, type, mode and object id (L6), the migration of recorded protected fingerprints to it (Q11).
- The check runner, class `direct` (D3 §2): `check_executions`, registration from the project's one sequence (L7) in the trigger's own transition or behind `checks_due` (L2), the check tree and its bounds, the `check` profile with its discarded writable overlay (E89 item 2) and its immutable input namespace (B01), the constructed environment, egress only through D2's proxy, launch through D2's launcher with the check execution in the invocation's place (L1), `orphans` at the check's own exit (L4), unknown and interrupted executions with no row, the output record and evidence presence, the not-run reasons, the Checks tick step, the runner self-test at host qualification and the binding of each execution to the qualification in force at launch.
- Selection by latest registration (L7, B03), reuse bounded as built with no cross-version reuse (Q1), execution history beside the deciding result (N03), supersession with the superseded candidate's evaluation refused (Q9).
- The diff classifier (D3 §3): every element, `root_layout_changed` and `unhandled_change` (B02), affected checks with reasons (N01), revalidation of the whole binding at application (T10), `classifier_authority` (Q5; it stays `recommend` unless Sean sets it).
- Validation scope at run time (D3 §4): criterion coverage, the kind inventory per scope tier, the sensitivity floor including partial delivery, module tiers and the verification cadence (L3, B04, Q7, Q10), one scope rule for every consumer.
- The repair loop for `fix` and `stage_build` (D3 §2.10, Q2), finding resolution under F2 (c) with the route for a missing verification (D3 §2.11, L8, Q8), the Builder's objection route (D3 §5 X2, E89 item 2), the gate's own ref reads (D3 §5 X1, Q4, N02).
- The role packages, following E87 item 10's principle that each role's package says what its gate reads: every role that reports findings is told to name the criterion a finding breaks (D3 §2.11); the Verifier's package names the requirement index's criteria and D3 Appendix B's definition reference.
- The reference project of the `project` lane: a small Node project whose protected checks run its own Node test runner through a protective wrapper.
- M43 and M11 leave bucket C of the triage: M43 through D3 §4.1 to §4.4, M11 through D3 §3.4 and §5 X2.
- The M3 acceptance report, and the real-lane run and hands-on run if Sean chooses them (plan questions 5 and 6).

**Not in M3** (each refused by the engine, with a test that it is, where the engine can refuse it):

- Deployment, the environment-bound check and its trigger (`environment_unbound`; D3 §5 X3), secrets for checks, the environment observation job.
- The `container` and `remote` runner classes (`runner_unqualified`; D3 §2.8).
- The phase gate (`unsupported`, as built) and phase verification.
- Spec approval and its registration of the requirement index; the plan fixture supplies the index (D3 §4.5; plan question 4 decides whether the index parser is built now).
- Creating evidence-reuse entries, and reuse across protected versions (Q1).
- An `authoritative` classifier as a condition of acceptance: Sean may set it after the classifier rows pass (Q5); M3 does not require it.
- Sessions, a second backend, the API-key mode for the real lane, the UI, dogfooding (E89 item 1).
- Submodules, Git LFS, filters and live repository metadata in a check tree (D3 §2.4, §6).
- The rest of bucket C of the triage (`docs/spec/M2-input-triage.md`), unchanged.

## 4. Roles, lanes and who runs what

The M1 spec's section 4 and the M2 spec's section 4 stand: the same three roles with the same paths (`CLAUDE.md`), Sean the owner, the lean procedure of E31 and E40, objections as before. M3 adds:

- **Four lanes** (D3 Appendix C; plan §2.1). `kernel`: as M1, with real git and SQLite and a **scripted check boundary** the test drives; `sandbox`: test-owned check programs inside the real `check` profile and boundary on this host, no model; `project`: the reference project's own toolchain inside the real sandbox, no model; `real`: the paid lane of M2, unchanged. The project lane needs no runner lane of its own: it costs nothing, destroys nothing and runs with `npm test` like the sandbox lane (plan question 1). One case of row M205 (an OOM kill) belongs to the exhaustion lane of E69.
- **Who may run what.** `npm test` and `--slice N`: every role and the driver, as before. `--lane exhaust`: only on the designated host (`mini-hp01`, `SURETY_EXHAUSTION_HOST`), never on this workstation, by Sean or by the driver at his request (E69). `--lane real`: only by Sean's command, under his approvals, on a subscription token he makes (E74, E88 item 3); a Verifier writes the real-lane cases and rehearses them against the fake backend (`SURETY_REAL_REHEARSAL`, E87 item 8); a Builder never runs a real backend.
- **The Reviewer's rule** (E31) stands: anything called serious is reproduced by running the engine; in the sandbox and project lanes that includes running checks in real `check` domains. Never a model.
- **Host steps are Sean's**, as in M2. M3 adds none (D3 §2.2: H1 to H12 cover the `check` profile); the reference project's Node is the engine's own installation, named in the project's `read_paths`.

**Safety rules carried from M2** (E64; SEAM §§127, 128):

1. **A destructive instrument fails closed, in two halves.** A test-owned check program that signals, renames or exchanges paths, detaches descendants, ignores TERM, floods output or fills storage refuses to act unless it establishes from inside that it is contained (its pid namespace is not the host's, pid 1 is the domain init, at most 16 processes visible; any failed read is a refusal), and the test releases it only after reading containment from the host side (the domain's `cgroup.procs`, the instrument's `/proc/<pid>/cgroup`). The test's own changes to the cgroup tree refuse any path outside a test engine's scope.
2. **The engine's kill paths are audited.** Each slice's Builder lists every `cgroup.kill` and `cgroup.procs` write, directory removal and signal that `src/checks/` adds, with what establishes the target is inside the engine's own scope; the slice's Reviewer checks the list by reading and by running.
3. **Order:** within a slice, a destructive file runs last, after containment is observed in a non-destructive one.
4. **No exhaustion here:** storage, memory and process exhaustion run only in the exhaustion lane on the designated host with E69's caps; every storage bound a sandbox row tests (M214) is set low through a harness override, in MiB, never by filling the disk.
5. **The real lane** runs only by Sean's command; no fixture approves spend; the token is never written to a file the repository or a record holds (E74, E87).
6. **Keep the machine quiet** during sandbox and project runs: H12 needs `MemAvailable` of `host_reserve_memory` plus `domain_memory_max` (E87 item 7).

## 5. Fixed technical constraints

The M1 and M2 specs' section 5 stand, with these added or sharpened:

- **Dependencies:** unchanged; `better-sqlite3` is the engine's only runtime dependency. A check's toolchain is the project's, named in governed `runner_config.direct.read_paths`, never the engine's dependency (D3 brief §4). The reference project uses Node's built-in test runner and nothing from npm.
- **Process starts:** `src/checks/` joins the places permitted to start a process (E39 item 7); the spawn lint (row M74's) lists it.
- **No shell:** a check's `command` is executed as an argument array; nothing in `src/checks/` interposes a shell.
- **Discovery and classification run nothing:** they read trees with engine git (`ls-tree`, `cat-file`) under E25 item 3, E29 item 1 and E37 item 1.
- **Check trees** live under `$SURETY_HOME/checktrees/`, engine-owned, keyed by project, never named by policy.
- **The fingerprint scheme changes once** (L6, Q11): a migration recomputes recorded protected fingerprints from their authorized trees; no comparison crosses schemes.

## 6. Design in force: D1, D2 and D3

D1 draft 3 with the M1 spec's section 6 corrections and D2's K1 to K10 stands. D3 draft 2 is in force as approved (E90, E91), and its §7.1 corrections L1 to L8 apply to D1 and D2. Its §7.2 and §7.4 decisions (Q1 to Q11) are part of the design. E89 item 2's three choices stand: the discarded writable overlay, the Builder's objection route, `direct` only.

No further prose draft of D3 (E20, brief §6 step 4): a finding during the build is a decision for Sean recorded in the errata, or a failing acceptance test.

## 7. Repository layout

Additions under `packages/engine/` (the names are the starting point; the Builder may arrange modules differently if the lint and the boundary script still hold):

```
src/checks/
  discovery.ts            the governed schemas, definitions, discovery errors, the input manifest
  register.ts             registration, triggers, checks_due, the Checks tick step's admission
  checktree.ts            materialization, bounds, staging, reference counting
  profile.ts              the check profile's mount plan, the immutable input namespace
  run.ts                  launch through the D2 launcher, observation, collection, the result row
  selftest.ts             the runner self-test and its controls
  classify.ts             the diff classifier
  scope.ts                the required set, coverage, kinds, floors, cadence: one function for every consumer
src/protected/            the manifest-based fingerprint (L6) and its migration
src/gates/                selection by registration (L7), the ref reads (X1), finding resolution (L8)
migrations/               check_executions and the added columns of D3 A.3; the fingerprint migration
test/acceptance/
  harness/checks/         the scripted check boundary, test-owned check programs, containment reads
  harness/project/        the reference project, its protective wrapper and its mutants
```

## 8. The test seam

The M1 and M2 seams stand. M3 adds, each confined to harness mode by SEAM §7's rule and never selectable in production:

- **The scripted check boundary** (kernel lane): the test scripts each execution's placement, `started`, exit report, `orphans` and termination, so the kernel's registration, selection, repair and resolution rules run without a sandbox.
- **A runner switch for kernel-lane engines:** registrations are recorded, and executions are admitted only when the test enables the scripted check boundary, so the accepted M1 and M2 rows that record fixture results keep their meaning: a fixture result takes the shared sequence (L7) and decides over a queued registration of the same bindings.
- **A runner qualification fixture** (plan question 2): a harness route that marks `check_runner` qualified, labelled `test_fixture`, for the sandbox lane before slice 18 builds the self-test; row M221 pins that no such route exists outside harness mode and that the journey passes without it.
- **Test-owned check programs** at a test path named in `check_commands` and `read_paths`, under the two-half rule of section 4.
- **The reference project** with Node's built-in runner, a protective wrapper and mutants; its Node is the engine's own installation.
- **Barriers and faults** at registration, materialization, launch (D2's), the init's report of the check's exit, collection, and the nomination and application finalizers; faults `init_report_lost`, a stalled git, a failed materialization, an unreadable ref.
- **Limits of the instruments** the M3 report must state: the sandbox and project lanes prove the mechanisms on this host and kernel; the runner self-test qualifies the runner, never a project's checks; the classifier's rows prove structure, not test semantics.

## 9. Slices

From the M3 acceptance plan, section 5. Manifest slices continue from M2's (14). Each slice follows the M1 and M2 procedure: Verifier on `verify/m3-s<N>`, Builder on `build/m3-s<N>` started at the same time and messaged when the cases reach `main`, one Reviewer pass, the driver's rerun of `--slice <N>` and the unit suite before each merge. **Journey first** (E40): slice 15 runs a whole check path end to end through a real `direct` execution before any component is hardened.

| Slice | Rows | Lanes | After it the engine |
|---|---|---|---|
| 15, the walking check | M201 to M205 | kernel 3, sandbox 2 | discovers a project's checks from its governed file, registers them at nomination, builds a check tree, runs each in a real `check` domain, records what it observed, and satisfies or refuses the stage and Alpha gates on those results alone (under the runner qualification fixture) |
| 16, which result decides | M206 to M209 | kernel 4 | selects by latest registration and never falls back; one sequence for registrations, fixtures and the watermark; shows execution history; refuses a superseded candidate's evaluation; rereads its refs at every gate and tells a failed read from a change |
| 17, the protected inputs | M210 to M215 | kernel 1, sandbox 5 | identifies inputs by path, type, mode and object id and migrates recorded fingerprints; presents exactly the manifest, immutable at its pathnames, ignoring the candidate's copy; builds bounded, staged check trees; constructs the environment and egress |
| 18, what an execution establishes | M216 to M223 | sandbox 6, kernel 1, project 1 | records no row for unknown or interrupted executions, fails orphans and deadlines, requires the output record, records the not-run reasons, schedules within the envelope, qualifies `direct` only by its full self-test, refuses other classes, and runs a real project's toolchain |
| 19, the classifier | M224 to M228 | kernel 5 | classifies every difference with the conservative fallback, never agent-approves a root change, lists affected checks with reasons, revalidates the whole binding at application, and blocks approval of invalid definitions |
| 20, validation scope | M229 to M233 | kernel 5 | requires criterion coverage, the kind inventory and the sensitivity floor per scope tier, raises cadence by module tier, and derives every consumer from one scope rule |
| 21, repair and findings | M234 to M237 | kernel 3, sandbox 1 | sends failed stage and fix work back once per candidate, resolves a finding only through a covering required acceptance check, routes a missing verification to the Verifier, and takes a Builder's objection to Sean; the journey's second path runs |
| 22, the end of M3 | M238 to M241 | project 1, real 1, report 1, hands-on 1 | fails the reference project's mutants, the root-hiding case included; the real run (if chosen), the report and the hands-on |

**What a Builder can build before any real backend is touched:** all of it. Nothing in slices 15 to 21 spends money or needs a token; slice 22's real row is the only paid step, and only if Sean chooses it.

**Known straddles** (plan question 3): L6 changes recorded fingerprint values (slice 17); Q9 changes the reason an evaluation of a superseded candidate gives (slice 16); L3 and B04 make scopes without criteria, without the kind inventory or without a floor incomplete (slice 20), which changes the shared fixtures of the M1 and M2 rows and the M2 real-lane project; F2 makes a finding's criterion necessary for resolution (slice 21), which changes M01's and M42's second paths. Each change is the Verifier's, recorded in `COVERAGE.md` under the correction that causes it, with the former insufficient case pinned as now refused (AD §8.3); none is a weakening.

## 10. Done, and what comes after

M3 is accepted when section 1's conditions hold. **The M3 acceptance report** (`docs/acceptance/reports/M3-report.md`, by the Verifier) records: the test, contract and engine revisions; the host and tool versions; the host qualification with the runner self-test's every case and control; the check profile's fingerprint; the classifier version and `classifier_authority` in force; the kernel, sandbox and project lane results; the exhaustion and real lanes' records if run; and what M3 does not claim, in the form of `M1-not-claimed.md`, starting from D3 §6. A hands-on walkthrough (`M3-hands-on.sh`), if Sean chooses it, shows him a check running in its domain, its tree with no `.git`, an input write refused, a gate read with the deciding execution and its history, and a protected change classified.

**Still closed after M3:** deployment and the environment-bound check (a later milestone, D3 §5 X3); `container` and `remote`; the phase gate; spec approval; sessions; a second backend and the API-key mode; the UI; dogfooding, which E89 deferred until checks are real and which M3 makes possible.

## 11. Known open items

| Item | Why it matters | When it bites |
|---|---|---|
| The plan's questions 1 to 7 | The runner's rows, the qualification fixture, the fixture straddles, the index parser, the real lane, the hands-on, the OOM case | Before slice 15 (1 to 4), before slice 22 (5 to 7) |
| A new subscription token (E88 item 3) | The real lane needs one, made with `claude setup-token`; whether Claude Code's trust entry still serves or a new qualification attempt is needed is established when the engine starts | Slice 22, if the real lane runs |
| Accepted fixtures under L3, L6, Q9 and F2 | Accepted tests change; recorded as corrections' changes, not weakenings | Slices 16, 17, 20, 21 |
| E64 item 5's sandbox-lane precheck | The runner could fail once with "no user manager reachable" instead of many failures; an owner's change of a few lines | Any time |
| Foundations v1.1 text | E1 to E125 still unmerged | Whenever convenient |

## 12. Owner-file changes this spec needs

Made by the driver, not by a role (CLAUDE.md):

- **`scripts/run-tests.mjs`:** `ROWS` gains `M201` to `M241` (41 rows), and its comment cites the M3 plan §3. No new lane if question 1 is answered (a): project-lane files run with `npm test` like sandbox-lane files. The exhaustion lane gains row M205's OOM file through the manifest, with no runner change.
- **`packages/engine/test/acceptance/manifest.json`:** slices `15` to `22`; the informational `sandbox` list gains the sandbox-lane and project-lane files; `exhaust` gains M205's OOM file; `real` gains M239's file if question 5 is answered (a) or (c). The full run then requires a file for every row of the three plans.
- **`CLAUDE.md`:** "Read `docs/spec/M1-build-spec.md` before changing anything" names the M3 build spec too; the Commands block's `--slice N` note ("9 = everything merged so far") is updated; "`npm test` fails until every row of both plans (M01 to M74, M101 to M142)" becomes the three plans with M201 to M241. The roles' paths are unchanged.
- **`docs/spec/templates/project-spec-template.md`:** its section 5 points to the requirement index's form (D3 §4.5) and D3 Appendix B, so a project's Verifier knows what to write.
