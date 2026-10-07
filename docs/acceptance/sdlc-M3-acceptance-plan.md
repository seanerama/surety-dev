# Surety M3 acceptance plan — draft

**Status:** draft row inventory for M3, written by the architect on 2026-10-06 for Sean's approval (E91 item 3), in the form of the M2 plan (`docs/acceptance/sdlc-M2-acceptance-plan.md`), with the M3 build spec (`docs/spec/M3-build-spec.md`, BS3). It is the inventory the M3 build's tests will be written from: each slice's Verifier splits its rows into named cases and fixes the details of section 2.6 in the seam. No test is written by this pass and no engine code is touched. This file does not claim that any row has a test or has passed.

**Basis:** D3 draft 2 (`docs/design/sdlc-design-D3-checks.md`, approved to build, E90 and E91), its Appendix C of 67 statements, Astra's T01 to T20 among them; Astra's review (`docs/reviews/D3/sdlc-review-D3-Astra.md`, cited AD); the errata E89 to E91; the accepted engine's seam (`packages/engine/test/acceptance/harness/SEAM.md`); `docs/acceptance/reports/M2-not-claimed.md` as it stands; the M2 report's question 15 (F2), decided as D3 §2.11.

**Rows:** `M201` to `M241`, so no row collides with M1's `M01` to `M74` or M2's `M101` to `M142`. Forty-one rows: twenty-two kernel, fourteen sandbox, two project, one real, one report and one hands-on. Every Appendix C statement is a row or a named case of one (section 4.1). The M1 and M2 rows are accepted and are not re-planned; where an M3 correction changes what one of their fixtures must supply, section 4.3 says which.

## 1. Sources, authority and scope

References throughout this plan:

- **D3:** draft 2. `§n` is its section; `L1` to `L8` its §7.1 corrections; `Q1` to `Q11` its decided questions (§7.2, §7.4); `D3-Xnn` a statement of its Appendix C; `B01` to `B04`, `N01` to `N04` and `T01` to `T20` Astra's amendments, suggestions and test cases as draft 2 applied them.
- **D1, D2, BS, RN:** as the M2 plan; D2's `K1` to `K10` stand.
- **E:** `sdlc-foundations-v1.1-errata-draft.md`, E1 to E91. **SEAM:** the accepted seam, §n. **NC:** `M2-not-claimed.md`.

D3 extends D1 and D2 and changes them only by L1 to L8. Where D3 leaves a detail to the tests, the Verifier fixes it in the seam (section 2.6). The tests are the contract; a Builder never edits an acceptance test to obtain a pass and files an objection instead; Sean keeps integration and approval authority. Design review of D3 stopped at E91: a finding after this plan is a decision for Sean or a failing acceptance test (E20).

**What M3 adds, and what these rows cover.** D3 §§1 to 5 as BS3 §3 lists them: the governed set and discovery, the input manifest, the check runner of class `direct` and its self-test, selection by registration, the classifier, validation scope, the repair loop, finding resolution, the gate's ref reads, the objection route; and two journeys, one per path, through a real `check` domain.

**What M3 does not cover.** BS3 §3's "Not in M3": deployment and the environment-bound check, `container` and `remote`, the phase gate, spec approval, reuse creation and cross-version reuse, sessions, a second backend, the UI. Their refusals are rows where the engine can refuse (M222).

## 2. Test method and fixtures

### 2.1 The lanes

| Lane | What runs | Cost | When it runs |
|---|---|---|---|
| **kernel** | As M1: the scripted adapter, real SQLite and git, loopback HTTP, and the **scripted check boundary**, which reports each execution's placement, `started`, exit, `orphans` and termination as the test scripts them. | nothing | with `npm test`, on any Linux host |
| **sandbox** | Test-owned check programs in the real `check` profile and boundary on this host: unprivileged namespaces, the delegated cgroup subtree, the check tree, the volatile overlay, D2's proxy with no destination but the engine's echo endpoint. No model, no token. | nothing paid; needs the host | with `npm test`, on a host where M2's sandbox lane runs; otherwise each sandbox row fails, never skips |
| **project** | The reference project's own toolchain (Node's built-in test runner from the engine's own Node installation, named in `read_paths`) behind its protective wrapper, in the real sandbox. No model. | nothing paid; needs the host | with `npm test`, as the sandbox lane (question 1) |
| **exhaust** | M2's lane (E69): only row M205's OOM case. | nothing paid; the designated host | `--lane exhaust` on `mini-hp01` only |
| **real** | A real Verifier and Builder (Claude Code on Sean's subscription token, E74) on a temporary project; the engine runs the checks. | Claude Code's estimates; Sean's subscription limits | only by Sean's command (question 5) |

The project lane fits the sandbox lane: it needs nothing the sandbox lane does not, spends nothing and destroys nothing, so it runs with `npm test` and needs no runner lane of its own; its files are marked in the manifest for the report (question 1). Resources, as the M2 plan's marks: kernel rows use S, G, A, H and the scripted check boundary; sandbox rows add P and X; project rows add the Node toolchain; the real row adds M.

### 2.2 Containment of destructive instruments

Every sandbox and project row whose check program signals, renames, exchanges, links, detaches, ignores TERM, floods output or fills storage follows BS3 §4's safety rules 1 to 4 (E64): the program refuses outside a check domain, the test reads containment host-side before releasing it, the destructive file runs last in its slice, and storage bounds are set low through harness overrides. Rows M205, M212, M214, M216, M217 and M220 carry such instruments; the slice's Builder lists the engine's new kill paths and the Reviewer checks them.

### 2.3 Harness additions this plan assumes

These reach production code as ordinary parameters or seam hooks under SEAM §7's confinement rule; none is selectable outside harness mode. The Verifier names them exactly in the seam; the Builder may object.

- **The scripted check boundary** (kernel lane) and **the runner switch** for kernel-lane engines (BS3 §8): registrations are recorded; executions are admitted only when a test enables the scripted boundary, so the accepted rows' fixture results keep deciding (they take the shared sequence, L7).
- **The runner qualification fixture** for slices 15 to 17 (question 2), labelled `test_fixture`.
- **Test-owned check programs:** exit n; kill itself with a foreign signal; sleep past `timeout_s`; ignore TERM and exit 0 on it; detach a descendant with standard output closed; print "passed" and exit 1; attack each input and its ancestors (write, rename, removal, exchange, replacement, symlink redirection, hard link); write to the control descriptors; flood output; print a held secret; read its environment and mount table into its output.
- **Fixtures:** the plan fixture extended with requirements' criteria and areas, modules with tiers and areas (D3 §4.5's fields); a protected version declared from a tree (the existing fixture, harness only); a seeded assessed reuse entry; a trigger fixture for `check_correction` work; a governed edit through the policy route (SEAM §66).
- **Barriers:** `checks.registered`, `checks.before_materialize`, `checks.materialized`, D2's launcher barriers for a check execution, `init.check_exited` (after the check's own exit, before the orphan observation), `collect.before_read`, and points before, inside and after the nomination and application finalizers.
- **Faults:** `init_report_lost`, a stalled engine git, a failed materialization, an unreadable registered ref, a scheme-mismatched recorded fingerprint, a usage of `classifier_version` other than the running one.
- **The reference project** (`harness/project/`): a Node project with two requirements and their criteria, a protective wrapper program that runs Node's test runner as a child and fails on an empty, all-skipped or early-exiting run, acceptance and smoke checks, and the mutants of M238.

### 2.4 How results are observed

From outside the engine, as in M2: the API (the candidate's check executions route, the gate read with its deciding executions and history, decisions, events), the store (D3 A.3's tables and columns), git, the filesystem (the check tree, its absence of `.git`, the engine home), the process table and the domain's cgroup files read host-side. A check program's report of what it saw (its environment, mount table, the bytes of an input) is test instrumentation published in its output record; whatever the claim is about is corroborated host-side. Deterministic barriers, the controlled clock and crash-and-reopen as M1 and M2.

### 2.5 Honest `not_exercised`

Only M205's OOM case, off the designated host, and the real row if Sean does not run it. Nothing else in M3 depends on host features M2 did not already require.

### 2.6 Details D3 leaves to the tests, which the Verifier fixes in the seam

The shape of `checks_due` and the gate read's naming of a pending, quarantined, interrupted or due execution; the gate read's history entry (N03); the reason code an evaluation refused on an unread ref carries (N02) and the bounded reread's interval; how trigger generations number recovery registrations (T05); the form of `runner_id` and how a test reads an execution's domain; the self-test case names; the test values of the check-tree bounds and of `checktree_max_entries`; how the gate read names the missing verification of D3 §2.11; the role packages' wording for criteria and Appendix B; how a test drives an engine start with a fingerprint recorded under the old scheme.

## 3. M3 trace matrix

Columns: the row, its scenario and named cases, the result it must observe, its sources, its lane and its slice. Cases are lettered; the slice's Verifier may split or merge cases but not drop an observation.

### 3.1 Slice 15: the walking check

| ID | Scenario and named cases | Required observable result | Pins | Lane | Slice |
|---|---|---|---|---|---|
| M201 | **The check journey, path one.** A temporary project as M01's, T1, one stage, one requirement with two criteria; a governed file naming a test-owned check program; an acceptance check covering both criteria and a smoke check, inputs declared; scripted roles. (a) the stage integrates and the candidate is nominated; (b) its checks run; (c) the gates; (d) a candidate whose source makes the acceptance check exit 1; (e) the whole journey's provenance; (f) from slice 18, the same journey with no runner qualification fixture. | (a) each required check registered once (`check.registered`), with the nomination trigger. (b) each execution's check tree has the candidate's files and the effective protected inputs and no `.git`; the check program's pid is in the execution's domain (`cgroup.procs`, host-read); one `check_results` row each with its `execution`, `runner_id`, `execution_established` true, exit 0 and an output record. (c) the `stage` gate and `alpha_authorize` satisfied with every check `passed`, their deciding results those executions, named on the gate read. (d) `failed`, `CHECK_NOT_PASSED`, its output record present, no authorization issued. (e) no `check_results` row came from the fixture route or a role. (f) as (a) to (e), `check_runner` qualified by the self-test. | D3 §§1.3, 1.4, 2.1 to 2.6, 4.2, 4.3; L1, L2; E40 | sandbox | 15 |
| M202 | **The governed schemas, their defaults, the required set** (D3-P01, D3-P05; T01). (a) each governed field omitted, and each member of `runner_config.direct` omitted; (b) an unknown key, an invalid value, a value over `check_timeout_max` or `check_output_max_bytes`, a `container` or `remote` key; (c) discovery under a changed host environment; (d) an effective version with errors; a proposal with errors; (e) `required_checks` absent, a list, a listed key with no definition. | (a) the A.4 default and unit on the version read. (b) each a discovery error with its path and `DiscoveryError` code, never clamped. (c) identical discovery. (d) every gate `ACCEPTANCE_SCOPE_INCOMPLETE` naming the path; the proposal cannot apply. (e) every check required; exactly the listed keys; `required_key_without_definition`. | D3 §1.1, A.4; N04 | kernel | 15 |
| M203 | **Definitions, and discovery runs nothing** (D3-P02, D3-P03; T01). (a) each field of §1.3 invalid in turn: key not the stem, a repeated JSON member, criterion, input or required key, a program not in `check_commands`, an input outside the roots, naming the governed file or not a regular file, `covers` on a developer check or on the wrong kind, an engine variable in `env`; (b) a hostile tree: a symlink, a submodule and an executable in the definitions directory, a definition over 64 KiB, 513 definitions, hooks, a filter driver and an fsmonitor planted. | (a) each its discovery error, never a dropped definition. (b) the errors and caps recorded; every seeded sentinel untouched; no remote contacted; no entry, required or not, omitted silently. | D3 §§1.3, 1.4 | kernel | 15 |
| M204 | **Triggers, registration and the frozen discovery** (D3-R13, D3-P04; L2; T05). (a) nomination; (b) a protected application; (c) the operator route: two requests, then one replayed; a key not required; (d) a role's result carrying a registration or result field; (e) a kill before, inside and after the nomination and application finalizers, then a restart; (f) a nomination whose required set needs the candidate's module facts, evaluated before registration. | (a) each check of the union of the stage and Alpha required sets registered once. (b) the new version's checks registered for every unsuperseded candidate in the finalizer that invalidates the old results. (c) both requests register; the replay registers nothing; `400 invalid_value`. (d) the result invalid and nothing registered or recorded. (e) the `checks` rows equal the frozen discovery; exactly one registration per trigger generation and key; nothing twice. (f) every affected check `missing`, naming `checks_due`; the gate unsatisfied. | D3 §2.5, §1.4; L2; SEAM §§67, 68 | kernel | 15 |
| M205 | **What establishes a result; the exit mapping** (D3-R05, D3-R06; T07). (a) exit 0; (b) exit 3; (c) prints "passed" and exits 1; (d) a foreign signal; (e) a failed exec; (f) `init_report_lost` with closure observed; (g) an OOM kill (exhaust lane); (h) the engine cancels and the program handles TERM with exit 0; (i) the program writes to its output and to the control descriptors a forged `started` and exit. | (a) `passed`. (b), (c) `failed`, `exit_status` as reported. (d) `signaled`, `exit_status` null, `failed`. (e) `execution_established` false, `exec_failed`, `skipped`. (f) established, `exit_status` null, `failed`. (g) `signaled`, `failed`; `not_exercised` off the designated host. (h) never `passed`; `exit_status` null. (i) no field set by it. Every case: `execution_established` only with the engine's authorized launch, `started` and closure. | D3 §2.6; D1 §9.2; E69 | sandbox; (g) exhaust | 15 |

### 3.2 Slice 16: which result decides

| ID | Scenario and named cases | Required observable result | Pins | Lane | Slice |
|---|---|---|---|---|---|
| M206 | **Registration decides; one sequence** (D3-R11, D3-R22, D3-R23; L7, B03; T04, T06). (a) two executions of the same bindings, the later finishing first, then the earlier; (b) an old matching pass and an assessed reuse pass seeded, then a newer registration evaluated while queued, materializing, running, quarantined, interrupted and cancelled without a result; (c) a satisfied evaluation, then a registration; (d) fixture results and runner registrations interleaved; (e) sequence 9 registered and unfinished, the highest result 5, a disposition, then 9 completes. | (a) the later-registered decides throughout; timestamps change nothing. (b) each time `missing`, the gate read naming the execution and its condition; never an earlier pass. (c) the evaluation `stale` in the registration's transition. (d) one sequence, no collision. (e) 9 does not count as after the disposition. No synthetic result is ever inserted. | D3 §2.5, §7.1 L7 | kernel | 16 |
| M207 | **Reuse bounded; history beside the deciding result** (D3-S06, D3-R27; Q1, N03). (a) a reuse entry with the same check fingerprint and effective version; a changed fingerprint; a changed version; (b) a protected application; (c) two failures then a pass at the same bindings; an operator request and an infrastructure retry. | (a) counts; `stale`; `stale`. (b) every result of the superseded version invalidated; nothing crosses versions; the engine creates no reuse entry. (c) the gate read shows the count and identities of the earlier failures and a link to their ordered history; the pass relabels nothing; the two triggers are distinguishable. | D3 §3.5, §2.6 | kernel | 16 |
| M208 | **Frozen bindings and supersession** (D3-R12; T15; Q9). (a) a recorded row's bindings; (b) the version, then separately the candidate, superseded before launch; (c) each superseded while running; (d) only the candidate superseded, with an assessed reuse and old-source bindings; evaluate the old candidate. | (a) candidate, revision, version materialized, class, runner id and qualification. (b) cancelled, no row (`check.cancelled`). (c) recorded and `stale`. (d) the evaluation refused: not satisfied, naming its successor, issuing and completing nothing; its results trigger no repair and resolve no finding. | D3 §2.5; E91 item 2 | kernel | 16 |
| M209 | **The gate's own ref reads** (D3-X01; Q4, N02; T16). (a) each registered ref moved, then deleted, and evaluated at once at each supported gate kind; (b) a transient git failure, then the read recovered; (c) an engine-owned journal finalizer racing the fact preparation. | (a) observed before the evaluation, with no tick: the integrity observation, `OUT_OF_BAND_CHANGE`, nothing issued. (b) the evaluation refused naming the unread fact; no changed-ref value, no out-of-band row, no adopt or discard decision; the recovered read finds none. (c) reconciled against the registry's generation, never reported as out of band. | D3 §5 X1; D1 §7.2, §7.6; SEAM §99 | kernel, real git | 16 |

### 3.3 Slice 17: the protected inputs

| ID | Scenario and named cases | Required observable result | Pins | Lane | Slice |
|---|---|---|---|---|---|
| M210 | **Input identity and the fingerprint migration** (D3-P10; L6, B01; Q11). (a) a regular input replaced by a symlink with the same blob id; an executable bit changed; (b) a symlink among a check's inputs; (c) an engine start over a store whose protected versions hold mode-free fingerprints, one of them with an unreadable tree. | (a) the protected fingerprint and the check fingerprint change; `input_changed`. (b) `input_not_regular`. (c) each readable version recomputed from its authorized tree; the unreadable one's fingerprint unreadable and its gates `PROTECTED_PATH_UNAUTHORIZED`; no comparison across schemes reads as equal. | D3 §1.3, §7.1 L6, §7.4 Q11 | kernel | 17 |
| M211 | **The candidate's copy is ignored** (D3-P06). A candidate whose protected files differ from the effective version's, a sentinel in each. | The check reads the effective sentinel; the candidate's fingerprint recorded on the execution; the result binds the effective version. | D3 §1.5 | sandbox | 17 |
| M212 | **Inputs are immutable at their pathnames** (D3-P07; B01; T02). From inside the domain, against each input and each ancestor, an ancestor existing only in the overlay's upper layer included: (a) write, truncate; (b) rename, removal, exchange, replacement; (c) symlink redirection; (d) a hard link; (e) the control: a source write. | (a) to (d) after every attempt the input's pathname reads the protected bytes (the program's report, corroborated by the expected digest). (e) succeeds in the domain and does not persist: the candidate's tree and checkout unchanged afterwards (E89 item 2). | D3 §2.2; AD §9 | sandbox | 17 |
| M213 | **The manifest is projected exactly** (D3-P08; B01; T01, T02). (a) declared inputs; (b) overlapping directory inputs; (c) a directory input containing the governed file; (d) default inputs (Q3); (e) roots configured so the governed file lies outside them; (f) a candidate whose root layout differs; (g) a symlinked mount-target ancestor in the candidate's source. | (a) those paths and no other protected path visible. (b) each member once. (c), (e) the governed file visible nowhere, the source projection included. (d) every file under the roots but the governed file. (f) as (a). (g) `mount_plan_refused`, no launch. | D3 §§1.3, 1.5, 2.2 | sandbox | 17 |
| M214 | **The check tree and bounded preparation** (D3-R01, D3-R25; T17). (a) a tree: tracked files, no `.git`, no roots, no governed file, the version's protected files; hooks, a filter and a remote planted; (b) two executions of one triple; the last reference gone; (c) each bound low: entries, bytes per tree, bytes for all trees, a stalled git; (d) many zero-byte entries; a large definition traversal; (e) two projects with the same relative paths; (f) during (c) and (d), the API and a cancellation. | (a) as stated; nothing ran. (b) one tree, reused read-only; removed. (c) `materialization_failed`; no partial tree visible or left. (d) bounded, as (c). (e) neither reads the other's. (f) both answered within D2 §3.7's bounds. | D3 §2.4 | sandbox; kernel for faults | 17 |
| M215 | **Environment, egress, direct exec** (D3-R02, D3-R03, D3-R04; Q6). (a) the environment; (b) no `egress`; a declared host; an undeclared one; (c) shell metacharacters in an argument; (d) a pinned hash that differs; an unpinned program. | (a) exactly §2.3's variables; parent-only sentinels and every held secret absent. (b) nothing leaves loopback; the declared host connects through the proxy and is logged; the undeclared refused. (c) passed literally; no shell in the process tree. (d) `toolchain_missing`; every execution records the resolved path and hash, pinned or not. | D3 §§2.3, 2.6, 1.1 | sandbox | 17 |

### 3.4 Slice 18: what an execution establishes

| ID | Scenario and named cases | Required observable result | Pins | Lane | Slice |
|---|---|---|---|---|---|
| M216 | **Unknown, interrupted, and every point of a start** (D3-R07, D3-R16, D3-R24; L1; T05, T07). (a) the domain's termination unknown, from `materializing` and from `running`; then observed; (b) cancel, and separately crash, after allocation, placement, authorization, a successful exec, the durable `started`, the exit report, collection; (c) a recovery's retries; a restart between them; (d) a pause past `lease_ttl`. | (a) `quarantined`, no row, nothing collected, the check `missing` and named on the gate read; after observation exactly one row. (b) closure first; before `running` the execution and domain stay nonterminal while closure is unknown; an execution whose exit report was recorded is recorded; any other ends `interrupted` with no row and is never recorded as not started; the domain's binding names the check execution on every path. (c) one registration per attempt within `check_infra_retries_max`; the original trigger's budget survives the restart; retries wait for closure. (d) re-granted only by D2 §3.5's challenge; `timeout_s` unchanged. | D3 §2.6, §2.7, §7.1 L1 | sandbox + kernel | 18 |
| M217 | **Orphans and deadlines** (D3-R08, D3-R09; L4; T08). (a) the program exits 0 leaving a detached descendant with standard output closed; (b) the descendant ends during cleanup; (c) the control: no descendant; (d) past `timeout_s`, a program that ignores TERM. | (a) `orphans`, `failed`, observed at the program's exit; the descendant gone afterwards. (b) still `orphans`. (c) `passed`. (d) TERM then kill, `deadline_hit` and `signaled`; no later report changes the row. | D3 §2.6, §7.1 L4 | sandbox | 18 |
| M218 | **Output and evidence presence** (D3-R10; T09). (a) a flood past `output_max_bytes`; (b) interleaved standard output and error; (c) no output; (d) a held secret printed; (e) a record refused, and separately removed after recording; (f) the engine and the program's own exit during a flood. | (a) head and tail kept, the drop counted. (b) interleaved. (c) an empty record. (d) refused, the critical finding raised, no raw secret published. (e) `EVIDENCE_MISSING` on every evaluation selecting it, asserted apart from the finding. (f) neither stalls. No output changes a result field. | D3 §2.6; D1 §9.3 input 8, §14.2 | sandbox + kernel | 18 |
| M219 | **What cannot run** (D3-R15). Each `NotRunReason`: an invalid definition, a missing program, a failed materialization, a refused mount plan, no host qualification, an unqualified runner, an environment-requiring check from nomination, a failed exec; a registered execution never attempted. | A row each, `execution_established` false, `skipped`, the reason on the gate read; the host-level reasons make NOW `refused` / `check_unrunnable`; `materialization_failed` registered again as `recovery`; the never-attempted execution leaves `missing`. | D3 §2.7 | sandbox | 18 |
| M220 | **Scheduling** (D3-R14). (a) `max_concurrent_domains`, the host reserves, `max_concurrent_checks`; (b) a role's run holding the project; (c) one candidate's checks. | (a) respected, the hold shown as `resource_envelope`. (b) a check runs meanwhile. (c) serially by default. | D3 §2.5; D2 §3.7; L2 | sandbox | 18 |
| M221 | **The runner self-test and the runner binding** (D3-R17, D3-R26; B01; T18, T19). (a) an engine start: every case and control of D3 §2.8, the pathname cases included; (b) one mandatory case forced `failed`, then one `not_exercised`; (c) the profile changed, and separately a restart, between registration and launch; (d) a historical result after requalification; (e) outside harness mode, the runner qualification fixture's route. | (a) `check_runner` qualified, each case and control `passed`, recorded. (b) `direct` unqualified; executions `runner_unqualified`. (c) dispatch uses the qualification current at launch or records `runner_unqualified`; the execution persists the runner identity, qualification and program hash it used. (d) not relabelled. (e) absent. | D3 §2.8, §2.5 | sandbox + kernel | 18 |
| M222 | **Runner classes, developer checks, the reserved environment** (D3-R18, D3-R19, D3-X03; E89 item 2). (a) `container` and `remote` definitions; (b) a required developer check; its test files changed by a Builder; (c) an environment-requiring check from every non-environment trigger. | (a) discovered; executions `runner_unqualified`; a `direct` result never matches them. (b) blocks until it passes; covers no criterion and counts toward no kind; its files change with no proposal. (c) `environment_unbound`; no workspace check holds a secret. | D3 §§2.8, 2.9, 5 X3 | kernel | 18 |
| M223 | **A real project's toolchain** (D3-J01, D3-J03, D3-J04). The reference project. (a) correct source; a broken one; (b) the toolchain path removed from the host; the pinned hash changed; (c) a test that hangs. | (a) `passed`; `failed`, with the real runner's exit statuses. (b) `toolchain_missing`, NOW `check_unrunnable`. (c) the timeout reached; every process it started gone. | D3 §2.8, Appendix B | project | 18 |

### 3.5 Slice 19: the classifier

| ID | Scenario and named cases | Required observable result | Pins | Lane | Slice |
|---|---|---|---|---|---|
| M224 | **Every element, and nothing hidden** (D3-C01 to D3-C04, D3-C11; B02; T03). (a) project creation; (b) each strict element alone; (c) each loosening element alone and beside strict ones; (d) each unclassifiable element alone, beside strict, beside loosening; neutral changes only; (e) each schema field's isolated delta, then each delta without an explicit rule beside a new strict check: a `phase` change, an added sensitive area, a symlink for a regular file, an executable-mode change. | (a) `initial`, and nothing else is. (b) `tightening` with its reason; a root addition is not among them. (c) `loosening`, a root removal included. (d) `unclassifiable`, `root_layout_changed` and `unhandled_change` included. (e) every delta classified; none vanishes; each combination `unclassifiable`. Each classification records `classifier_version`. | D3 §3.1, §3.2 | kernel | 19 |
| M225 | **Declared inputs, root changes, the policy route** (D3-C05, D3-C06; B02; Q3). (a) a new check outside every existing check's inputs, the root layout unchanged, with declared inputs and under default inputs; (b) a governed edit adding a root, with declared and with default inputs, where a retained check would pass once its source is hidden; (c) a root removed; (d) a program change. | (a) `tightening`; `unclassifiable`. (b) `unclassifiable` both times. (c) `loosening`. (d) `unclassifiable`. The policy route uses the same function. | D3 §3.1; SEAM §66 | kernel | 19 |
| M226 | **Affected checks** (D3-P09; N01). (a) checks added, removed, definition-, input-, required- and applicability-changed; (b) an existing required key removed with no definition change; (c) any protected file changed under default inputs. | (a) each listed with its reasons. (b) listed, reason `required_changed`. (c) every check listed. | D3 §1.6 | kernel | 19 |
| M227 | **Revalidation and authority** (D3-C07, D3-C08; T10; Q5). (a) between preview and effect, each of: the effective version, the spec's criteria or areas, the scope approval, the discovery, the classifier version, `classifier_authority`, with the class unchanged; (b) a replay after a restart; (c) `recommend`; `authoritative` for the running version; for another version; (d) the setting changed while a Reviewer's application is pending. | (a) the intent invalidated `EFFECT_PRECONDITION_CHANGED`, the approval withdrawn, nothing applied, the next generation raised; a Reviewer's approval withdrawn the same way. (b) refused. (c) a recommendation on the human decision, nothing applied; applied after revalidation; read as `recommend`. (d) stopped; the proposal goes to the human. | D3 §3.3; K8 | kernel | 19 |
| M228 | **Invalid definitions and spec changes** (D3-C09, D3-C10; L5). (a) a proposal with a discovery error, `criterion_unknown` included; (b) a spec revision removing a criterion a definition names. | (a) `unclassifiable`; `approve` carries `CHECK_DEFINITION_INVALID`; `reject` works. (b) the effective version gains `criterion_unknown`; every gate `ACCEPTANCE_SCOPE_INCOMPLETE` until a correction applies. | D3 §3.4, §7.1 L5 | kernel | 19 |

### 3.6 Slice 20: validation scope

| ID | Scenario and named cases | Required observable result | Pins | Lane | Slice |
|---|---|---|---|---|---|
| M229 | **Criterion coverage and the sensitivity floor** (D3-S01, D3-S02, D3-S09; L3, B04; T11). (a) a criterion with no required acceptance-origin check; a requirement with no criterion; a developer check naming a criterion; (b) an area from a requirement, then from a scope module, with no floor check listing the gate kind; the floor at each tier; (c) a sensitive requirement spanning two stages, no module declaring the area, at the first stage's gate. | (a) `ACCEPTANCE_SCOPE_INCOMPLETE` naming the criterion; the requirement uncertain; the developer check refused at discovery and covering nothing. (b) incomplete, `area:<name>`; the floor applies at T1 to T3. (c) the floor check is in the first stage's scope. | D3 §§4.2 to 4.4; §7.1 L3 | kernel | 20 |
| M230 | **The kind inventory** (D3-S07; B04; T11). A T3 scope with complete criteria and sign-offs: (a) missing each required kind in turn; (b) `required_checks`, `gate_kinds` or `tier_floor` used to omit one; (c) a developer check of the missing kind. | (a) incomplete, `kind:<kind>`. (b) still incomplete. (c) still incomplete. | D3 §4.3 | kernel | 20 |
| M231 | **Scope modules, tier and cadence** (D3-S03, D3-S04, D3-S08; Q7, Q10). (a) a module's override raises the scope's tier for checks, kinds and sign-offs; an override below the project's tier; (b) a stage scope; a deployment scope, with a module deleted at the revision; an unreadable presence fact; (c) a T1 project integrating a stage whose module is T2; a `fix` whose revision holds a T2 module. | (a) raised; never lowered. (b) the stage's modules; every module present; the deleted one absent; incomplete. (c) nominated by engine cadence with no Builder request, both times. | D3 §4.1; E91 item 2 | kernel | 20 |
| M232 | **One scope rule** (D3-S10; T12). Change only a requirement's sensitivity, only its criteria, only a module's tier, only a module's presence. | Check registration, the gate's scope, the required sign-offs, the acceptance content hash and the preview's staleness all change together; an earlier sign-off cannot authorize the changed content; a nonsensitive case with the same required set keeps its hash. | D3 §4.2; AD §8.3 | kernel | 20 |
| M233 | **The requirement index** (D3-S05; question 4). Index rows registered: well-formed; a row that does not parse; an unknown area; a criterion not of its requirement; a repeated criterion. | Exactly the criteria and areas registered; each malformed case refused with its row named. | D3 §4.5 | kernel | 20 |

### 3.7 Slice 21: repair and findings

| ID | Scenario and named cases | Required observable result | Pins | Lane | Slice |
|---|---|---|---|---|---|
| M234 | **The repair loop** (D3-R20, D3-R21; Q2; T13). A `fix` with its named check, and a `stage_build` with its stage scope's checks: (a) a failure on the current candidate; (b) a failure recorded before the item reached `verifying`; (c) an earlier failure finishing after a newer pass; (d) several checks of one build failing; (e) restarts and repeated ticks; (f) `skipped`, `missing`, `stale`, a superseded candidate's result; (g) the same failure on an unchanged tree; (h) a conflict finding in the Builder's run. | (a), (b) sent back once, `repair_attempts` +1, the failed outputs in the next context. (c) nothing. (d) one repair. (e) no second repair. (f) none. (g) counts toward `no_progress_max`; either limit parks with a blocker naming the checks. (h) the conflict route wins. | D3 §2.10 | kernel | 21 |
| M235 | **Finding resolution** (D3-F01; L8, F2 (c); T20; Q8). A finding naming criterion R1.1 and check `login`, dispositioned `fix`: (a) `login` required, acceptance-origin, covering R1.1, passing after the disposition, evidence intact; (b) instead an unrelated passing check, a developer check, a check outside the required set, a check not covering R1.1, a pass registered before the disposition, a pass with its output record missing; (c) a finding with no criterion; a criterion no required acceptance check covers; (d) the resolving execution invalidated; (e) a criterion not in the index. | (a) resolved, `resolution_verification` naming the evaluation and the execution; the fix completes. (b) unresolved each time. (c) unresolved; the gate read names the missing verification; one `check_correction` work item for the Verifier, triggered by the finding, chained (waits at the chain boundary). (d) reopened. (e) an invalid result, nothing stored. | D3 §2.11; E91 item 2; SEAM §74 | kernel | 21 |
| M236 | **The conflict route and objections** (D3-X02; T14; E89 item 2). (a) a conflict finding from a Builder and from a Verifier run; each option of the blocker; (b) an objection naming an unknown, a foreign-project or an unrelated check or criterion; (c) a replayed objection. | (a) repair stops; the blocker of §5 X2 raised; `correct_check`, `change_spec`, `retry`, `cancel` each do what they say; no answer changes a check state; the objected check stays in force; no Builder field edits the spec. (b) the entry invalid, no blocker, no spec change. (c) deduplicated. | D3 §5 X2 | kernel | 21 |
| M237 | **The check journey, path two.** M201's project. (a) a Builder's candidate fails the acceptance check; (b) the repaired candidate; (c) a Verifier's Critical finding naming R1.2 and the acceptance check; the Reviewer's `fix`; the fix's candidate. | (a) the `stage_build` sent back once with the output in its context. (b) its checks run and pass in their domains. (c) the check passes on the fix's candidate by an execution registered after the disposition; the finding resolved; both gates satisfied on engine-observed results only. | D3 §§2.10, 2.11; E40 | sandbox | 21 |

### 3.8 Slice 22: the end of M3

| ID | Scenario and named cases | Required observable result | Pins | Lane | Slice |
|---|---|---|---|---|---|
| M238 | **The protective wrapper and the root-hiding case** (D3-J02, D3-J05; T18, T03, B02). The reference project. (a) a skipped test; an empty run; a swallowed child failure; a premature success summary; candidate code calling `process.exit(0)`; (b) a bare `node --test` definition; (c) a retained check discovering tests under `src/`, failing on a failing source test; a proposal adding `src/` as a root. | (a) each `failed`. (b) the vacuous pass shown and labelled a limitation, never evidence of guarded execution. (c) `failed`; the proposal `unclassifiable`, so no agent approval can apply it. | D3 §6, §3.1, Appendix B | project | 22 |
| M239 | **The real journey** (question 5). A temporary project; Claude Code on Sean's subscription token for the roles; the entry active. (a) a real Verifier writes the stage's checks (definitions and programs under `.surety/checks/`) through `check_correction` work; Sean answers the classification's decision; (b) a real Builder builds the stage; the engine runs the checks; (c) path two: a seeded defect; the real Verifier's finding names a criterion and a check; fix; resolution. | (a) a proposal, classified, applied by Sean's answer; the checks discovered with no error. (b) every check result an engine execution in a `check` domain; both gates satisfied on them. (c) the finding resolved only through the covering required check, as M235. No check result written by a fixture. | E89, E91; NC "a check's execution in the real journey is a fixture" | real | 22 |
| M240 | **The M3 acceptance report.** Written by the Verifier after the lanes pass on `main`. | BS3 §10's contents; every Appendix C statement's row named with its result; the runner self-test's cases; the profile fingerprint; the classifier version and authority; the `not_exercised` cases by name; what M3 does not claim, from D3 §6. Nothing described as passing that was not run. | BS3 §10; E40 | report | 22 |
| M241 | **Hands-on** (question 6). `M3-hands-on.sh`, in the M2 form. | Sean sees for himself: a check's processes in its domain's `cgroup.procs`; its tree with no `.git`; an input write refused while a source write is discarded; the gate read with the deciding execution and its history; a root addition classified `unclassifiable`. He writes down any surprise, each a decision or a failing test. | E45, E88 (the form) | hands-on | 22 |

## 4. Conversion and deferred traces

### 4.1 Every Appendix C statement

| Statements | Row |
|---|---|
| D3-P01, D3-P05 | M202 |
| D3-P02, D3-P03 | M203 |
| D3-P04, D3-R13 | M204 |
| D3-R05, D3-R06 | M205 |
| D3-R11, D3-R22, D3-R23 | M206 |
| D3-S06, D3-R27 | M207 |
| D3-R12 | M208 |
| D3-X01 | M209 |
| D3-P10 | M210 |
| D3-P06 | M211 |
| D3-P07 | M212 |
| D3-P08 | M213 |
| D3-R01, D3-R25 | M214 |
| D3-R02, D3-R03, D3-R04 | M215 |
| D3-R07, D3-R16, D3-R24 | M216 |
| D3-R08, D3-R09 | M217 |
| D3-R10 | M218 |
| D3-R15 | M219 |
| D3-R14 | M220 |
| D3-R17, D3-R26 | M221 |
| D3-R18, D3-R19, D3-X03 | M222 |
| D3-J01, D3-J03, D3-J04 | M223 |
| D3-C01 to D3-C04, D3-C11 | M224 |
| D3-C05, D3-C06 | M225 |
| D3-P09 | M226 |
| D3-C07, D3-C08 | M227 |
| D3-C09, D3-C10 | M228 |
| D3-S01, D3-S02, D3-S09 | M229 |
| D3-S07 | M230 |
| D3-S03, D3-S04, D3-S08 | M231 |
| D3-S10 | M232 |
| D3-S05 | M233 |
| D3-R20, D3-R21 | M234 |
| D3-F01 | M235 |
| D3-X02 | M236 |
| D3-J02, D3-J05 | M238 |

All 67 statements: P 10, R 27, C 11, S 10, F 1, X 3, J 5. Rows beyond Appendix C: M201 and M237 (the journeys, E40), M239 (the real journey), M240 (the report), M241 (the hands-on).

### 4.2 Astra's cases, the corrections and the decisions

| Item | Rows |
|---|---|
| T01 | M202, M203, M213 |
| T02 | M212, M213 |
| T03 | M224, M238 |
| T04 | M206 |
| T05 | M204, M216 |
| T06 | M206 |
| T07 | M205, M216 |
| T08 | M217 |
| T09 | M218 |
| T10 | M227 |
| T11 | M229, M230, M231 |
| T12 | M232 |
| T13 | M234 |
| T14 | M236 |
| T15 | M208 |
| T16 | M209 |
| T17 | M214 |
| T18 | M221, M238 |
| T19 | M221 |
| T20 (F2) | M235, M237 |
| L1 | M216, M201 |
| L2 | M204, M220 |
| L3 (with B04) | M229 to M232 |
| L4 | M217 |
| L5 | M228 |
| L6 (B01) | M210, M212, M213, M221 |
| L7 (B03) | M206 |
| L8 (F2) | M235 |
| B02 | M224, M225, M238 |
| Q1, Q2, Q3, Q4, Q5 | M207, M234, M213 and M225, M209, M227 |
| Q6, Q7, Q8, Q9, Q10, Q11 | M215, M231, M235, M208, M231, M210 |
| N01, N02, N03, N04 | M226, M209, M207, M202 |
| E89 item 2 (overlay, objection, `direct`) | M212 (e), M236, M222 |

### 4.3 What changes in accepted rows

The accepted M1 and M2 rows keep passing; the corrections below change what their shared fixtures must supply (question 3). Each change is the Verifier's, recorded in `COVERAGE.md` under its correction, with the former insufficient case pinned as now refused.

| Correction | Slice | Accepted rows affected |
|---|---|---|
| Q9, a superseded candidate's evaluation refused | 16 | rows that evaluate a candidate after its successor (M01's second path, the lineage rows) |
| L6, the fingerprint over the manifest | 17 | rows asserting fingerprint values (SEAM §66's) |
| L3 and B04: criteria, kinds, floors, cadence | 20 | every row whose fixture project satisfies a gate (the plan fixture gains criteria, an acceptance and a smoke check); M140's real-lane project (rewritten, not rerun until Sean chooses) |
| L8, a finding's criterion | 21 | M01's and M42's second paths; M140 (b) |

### 4.4 Deferred traces

Bucket C of the triage: M43 and M11 leave it (M229 to M231; M228, M236). The rest stays on the not-claimed list with what reopens it, unchanged from the M2 plan §4.3. D3 §6's classes carry into the report as M240 states. The open E50, E51, E53 to E55 decisions stay carried, not re-planned.

## 5. Execution order and acceptance boundary

The Verifier writes a slice's rows before the Builder implements it, under E31's pace: one review per slice, the fewest cases. Manifest slices continue from M2's (14).

| Slice | Rows | Rows by lane | What it establishes |
|---|---|---|---|
| 15, the walking check | M201 to M205 | kernel 3, sandbox 2 (one exhaust case) | a whole check path through a real `direct` execution to the gate |
| 16, which result decides | M206 to M209 | kernel 4 | selection by registration, history, supersession, the gate's ref reads |
| 17, the protected inputs | M210 to M215 | kernel 1, sandbox 5 | the manifest and its migration, immutable inputs, the check tree, environment and egress |
| 18, what an execution establishes | M216 to M223 | sandbox 6, kernel 1, project 1 | unknown and interrupted, orphans, evidence presence, not-run reasons, scheduling, the self-test, classes; a real toolchain |
| 19, the classifier | M224 to M228 | kernel 5 | every element, root changes, affected checks, revalidation and authority, invalid definitions |
| 20, validation scope | M229 to M233 | kernel 5 | coverage, kinds, floors, cadence, one scope rule, the index |
| 21, repair and findings | M234 to M237 | kernel 3, sandbox 1 | the repair loop, F2, objections, the journey's second path |
| 22, the end of M3 | M238 to M241 | project 1, real 1, report 1, hands-on 1 | the mutants and root hiding; the real run, the report, the hands-on |

**Acceptance** is BS3 §1: `npm test` on `main` runs the kernel, sandbox and project lanes with every row and named case passing on this host and no case skipped; the runner self-test qualified at an engine start; the exhaust and real rows as Sean chooses (questions 5 and 7); the report of M240. A sandbox or project row that fails for want of the host fails M3. The finite matrix is the stopping boundary (E20).

## Questions for Sean

Each is a decision D3 and the errata leave open, with options and the architect's recommendation.

1. **The project lane and the runner.** Options: (a) project-lane files run with `npm test` like sandbox-lane files, marked in the manifest for the report, with no new `--lane`; (b) a `--lane project` kept out of `npm test`. Recommendation: (a). The lane spends nothing and destroys nothing, and keeping it out of `npm test` would leave the full run unable to show the runner on a real toolchain. The owner's change is then only `ROWS` and the manifest (BS3 §12).
2. **A runner qualification fixture for the walking check.** D3 §2.8 qualifies `direct` only by the full self-test, B01's pathname cases included, which slice 18 builds; journey-first puts a real execution in slice 15. Options: (a) a harness-only fixture marks `check_runner` qualified, labelled `test_fixture`, for slices 15 to 17; M201 (f) reruns the journey without it in slice 18, and M221 (e) pins that the route exists only in harness mode, as M2 did with its fixture trust entry; (b) no fixture; the journey moves to slice 18. Recommendation: (a). It keeps the journey first without claiming qualification, and the fixture's last use is pinned.
3. **Accepted fixtures under L3, L6, Q9 and F2** (section 4.3). Options: (a) the Verifier updates the shared fixtures in the slice that brings each correction, records each change in `COVERAGE.md` under that correction, and pins the former insufficient case as refused (AD §8.3); M140's real-lane project is rewritten but not rerun until you choose; (b) a compatibility setting keeping the old rules for old fixtures. Recommendation: (a). Option (b) would leave a weaker path in production and is new design.
4. **The requirement index parser** (D3 §4.5, M233). Spec approval is not built; the plan fixture supplies the index's fields. Options: (a) build the §4.5 parser now, and have the plan fixture register the index through it, so M233 pins the real rule; (b) defer M233 with spec approval, the fixture supplying parsed fields. Recommendation: (a). The parser is small and fully specified, and (b) leaves an M3 row with nothing to test.
5. **The real lane at the end of M3** (M239). M2's not-claimed list says a check's execution in the real journey is a fixture; only a real run closes that. Options:
   - (a) One run: a real Verifier writes the stage's checks through `check_correction` work and the protected route, you answer the classification's decision, a real Builder builds, the engine runs the checks, and path two shows F2 with a real finding naming a criterion.
   - (b) No real run. M3's claim rests on the project lane (a real toolchain with scripted roles), and the not-claimed entry stays.
   - (c) Path one only.

   Cost: M2's whole real lane cost a few tenths of a USD in Claude Code's estimates (E87 items 1 and 9). M3's run adds one Verifier authoring run, and the check executions call no model, so it should stay under 1 USD in estimates. It draws on your subscription's usage limits, which your own sessions share. It needs a new `claude setup-token` (E88 item 3), and possibly one new qualification attempt (about 0.05 USD) if the entry no longer serves. It also needs the Verifier's package to describe definitions (BS3 §3). Recommendation: (a), at slice 22, by your command, rehearsed first against the fake backend.
6. **The hands-on run** (M241). Options: (a) a short script in M2's form, in the same sitting as the real run; (b) none, the report alone. Recommendation: (a). Five checks, about fifteen minutes.
7. **The OOM case of D3-R06** (M205 (g)). E69 keeps memory exhaustion off this workstation. Options: (a) one exhaust-lane file run on `mini-hp01` with E69's caps, with the M3 report citing it; (b) `not_exercised` and listed as not claimed. Recommendation: (a). It is one small file, run once by you or by the driver at your request.
