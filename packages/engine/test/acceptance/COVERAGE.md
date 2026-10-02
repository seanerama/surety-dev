# Acceptance coverage

How one Verifier session hands over to the next (build spec §7). Every Plan row appears here. For each row a slice has worked on, every named case is listed with its file, the slice whose manifest lists that file, and whether it is written. A case deferred to a later slice is recorded when it is deferred, with the reason. Rows no slice has worked on yet are listed at row level with the slice that introduces them (build spec §9); that slice's Verifier splits them into cases.

**Status values:** `written` (a test exists and is listed in the manifest); `deferred → N` (not written; waits for slice N); `not written (slice N)` (the slice it waited for has been verified and the case was left out, with the reason; nobody is going to write it unless the owner asks); `not started` (row not yet split).

Last updated: slice 7, 2026-10-02. This session wrote row M01, the journey: seven cases in one file, listed under slice 7 (the section "Slice-7 row" below), by E31's procedure. It was not run: it needs slice 5, and the engine is not built that far. It adds nothing to the seam (`harness/SEAM.md` §86) and changes no helper and no other test. What the row names and the seam does not reach is recorded with the row. Slice 6 has not been verified when this is written; its rows are still under "Rows not yet split into cases". The paragraph that follows is the previous session's.

Slice 5, 2026-10-02. This session wrote rows M35 to M58: 97 cases in 24 files, all listed under slice 5 (the section "Slice-5 rows" below), by E31's procedure: one file per row, the fewest cases that pin each row's required result, a separately reported case only where the Plan names a finite case set, no stand-in engine and no self-check. None of them was run: each fails at its first slice-5 step. Of the cases earlier slices left for slice 5, those that were cheap and belonged to one of these rows were folded into that row's file; the rest are marked `not written (slice 5)` in their own row's table, each with its reason, and listed again under "Obligations recorded by the slice-5 session". That section also lists the existing tests whose assertions slice 5's rules make wrong; this session did not change them. One file was added for the slice-3 review and listed under slice 4 (`M23-filter-driver-however-spelled.test.mjs`, four cases). `harness/SEAM.md` §§65 to 85 state the contract and list every name this session fixed. The paragraph that follows is the previous session's.

Slice 4, 2026-10-02. This session wrote rows M59 to M67 and the cases of rows M02, M04, M12 and M61 that earlier slices left for slice 4: 39 cases in 13 files, all listed under slice 4 (the section "Slice-4 rows" below). The procedure changed with this slice (E31): the fewest cases that pin each row's required result, no generated matrix, no stand-in engine and no self-check. Only the five shim cases of row M67 were run; they need no engine and pass. Everything else fails until slice 4 is built, and a defect in a test surfaces then, through the objection procedure. Cases that wait for slice 5 or 6 were not written; each is in its row's table and under "Obligations recorded by the slice-4 session". `harness/SEAM.md` §§52 to 64 state the contract and list every name this session fixed. The paragraph that follows is the previous session's.

Slice 3, second Verifier session, 2026-10-02. This session wrote rows M26 to M34 and every case the first session left for it: 204 cases in 19 files, all listed under slice 3 (the section "Slice-3 rows, second session" below). The probe cases (M29 to M32), the crash cases (M33) and the fault-matrix cells through integration (M15) are generated from `contract/journal.json` and `contract/run-end-faults.json`, one separately reported case per cell. Cases that cannot pass before slice 4 or 5 were not written; each is recorded under "Obligations recorded by the second slice-3 session" with the slice it waits for. `harness/SEAM.md` §§39 to 51 state the contract and list every name this session fixed. The paragraph that follows is the first session's.

Slice 3, first Verifier session, 2026-10-02. Slice 3 is written by two Verifier sessions in sequence. This one wrote, first, what the final slice-2 review carried forward (E28): the run-end fault matrix and five single cases, marked "(final review)" below, listed under slice 3 because they must first pass when slice 3 is built; and the audit of the existing tests for timing sensitivity (E29 item 2; `harness/SEAM.md` §24). Then rows M19 to M25 and the slice-3 cases of earlier rows that concern snapshots, validation, commits and integrity. Rows M26 to M34 and the cases listed under "Left for the second slice-3 session" are that session's. The paragraph that follows is the previous one.

Slice 2, 2026-10-02, after the second slice-2 review. A second Reviewer probed the slice-2 engine after its first fix round and confirmed four more defects; the owner decided the questions that came with them (E27). The defects and the decisions that needed a test became eight new cases, marked "(review 2)" below: three in the lease file of row M15, four in M16, one in M23. Three existing M15 cases changed with E27 item 3 (what a lease expiry leaves), and one was made independent of a host clock that steps back. What that review found and no test pins yet is under "Obligations recorded after the second slice-2 review". `harness/SEAM.md` §23 lists what changed in the contract. The paragraph that follows is the first review's.

Slice 2, 2026-10-01, after the slice-2 review. A Reviewer probed the slice-2 engine and confirmed defects that the slice-2 tests did not catch; the owner decided the questions it raised (E25). The defects and the decisions that needed a test became eleven cases, marked "(review)" below: five in a new file for row M15, two in M16, one in M14, and three in two files for rows M23 and M31, which slice 3 introduces and whose cases slice 2's engine already reaches. What that review found and no test pins yet is under "Obligations recorded after the slice-2 review". `harness/SEAM.md` §22 lists what changed in the contract. The paragraph that follows is the slice-2 Verifier's.

Slice 2, 2026-10-01. Slice 2 wrote rows M09 to M18 as far as slice 2 can pass them, the cases of M02, M05, M06, M07 and M08 that slice 1 deferred to it, and the cases the slice-1 reviews carried over (E23 items 8, 11 and 12), marked "(carried)" below. A file is listed under one slice only, so every slice-2 case of a slice-1 row is in a new file. The paragraph that follows is the slice-1 Verifier's.

Slice 1, 2026-10-01, after the slice-1 review. The review's four contract defects became five cases, marked "(review)" below: two in row M69 for the Host check, one in M69 and one in M06 for the token file, one in M07. The owner's decisions on the review's other findings (E23) added the seam-confinement cases of row M74 and the obligations listed under "Obligations recorded after the slice-1 review".

## Slice-1 rows

### M02. Distinct work versus duplicate allocation

| Case | File | Slice | Status |
|---|---|---|---|
| Two one-shot runs of the same role each hold their own receipt | `M02-receipt-store-constraints.test.mjs` | 1 | written |
| A second null-turn receipt for one run is rejected by the store | same | 1 | written |
| The rejection holds after the store is closed and reopened | same | 1 | written |
| The rejection holds after the engine restarts on the same store | same | 1 | written |
| Concurrent allocations from separate processes store exactly one receipt | same | 1 | written |
| A second original ledger row for one invocation is rejected; a correction is not | same | 1 | written |
| Two dispatched runs of one role have identities of their own: run, invocation, domain, ownership, workspace, grant, lease, ledger row, process | `M02-dispatch-identity.test.mjs` | 2 | written |
| Allocating the receipt of one run again, repeatedly and concurrently, returns that receipt and launches nothing | same | 2 | written |
| After a restart the allocation still returns the same receipt, with no second receipt and no launch | same | 2 | written |
| A result sent twice is one completion and one charge | same | 2 | written |
| Finalization repeated by recovery, and repeated again, charges once | same | 2 | written |
| Two dispatched runs of one role each have their own transcript and result records, published, each in its own file | `M02-record-identities.test.mjs` | 4 | written |

Row closes in slice 4.

### M03. Session-turn constraint at the store boundary

| Case | File | Slice | Status |
|---|---|---|---|
| A second receipt for one turn is rejected | `M03-turn-receipt-constraints.test.mjs` | 1 | written |
| A receipt whose turn belongs to another run is rejected with its whole write set | same | 1 | written |
| A null-turn receipt for a session run is rejected | same | 1 | written |
| A turn-bearing receipt for a one-shot run is rejected with its whole write set | same | 1 | written |
| A transaction containing a rejected receipt leaves none of its other rows | same | 1 | written |

Row closes in slice 1.

### M04. Atomic transition and append-only history

| Case | File | Slice | Status |
|---|---|---|---|
| Receipts cannot be updated or deleted | `M04-append-only-history.test.mjs` | 1 | written |
| Status observations cannot be updated or deleted | same | 1 | written |
| Usage observations cannot be updated or deleted | same | 1 | written |
| Ledger rows cannot be updated or deleted | same | 1 | written |
| Journal events cannot be updated or deleted | same | 1 | written |
| Events cannot be updated or deleted | same | 1 | written |
| Observation history "if present": not built in M1, asserted absent | same | 1 | written |
| A failure between the domain write and the event write leaves nothing behind | `M04-atomic-transition.test.mjs` | 1 | written |
| A committed transition changes the projection only with its new event (project pause/resume) | same | 1 | written |
| A chunk receipt of an unpublished stream cannot be updated or deleted | `M04-chunk-receipts-append-only.test.mjs` | 4 | written |
| The git journal state projection changes only with a new journal event: after operations of every journal kind, ended well and ended failed, each operation has one projection row at its last journal event (bootstrap, policy change, an integrated run, a checkpoint, an abandon, a refused integration) | `M04-journal-state-projection.test.mjs` | 3 | written |
| The transaction that appends `applied`, `confirmed` or `finalized` fails once: neither a second event nor a projection that ran ahead is left, and the journal goes on from where it was (3 cases) | same | 3 | written |

### M05. Migrations and restricted startup

| Case | File | Slice | Status |
|---|---|---|---|
| A fresh store records each migration once with its identity, order and checksum | `M05-migrations.test.mjs` | 1 | written |
| An upgrade applies only the pending migration, once, after those already applied | same | 1 | written |
| A kill during migration exposes no partial upgrade, and a restart applies it once | same | 1 | written |
| A failing migration leaves the engine restricted, diagnosable and without partial state | same | 1 | written |
| A changed checksum on an applied migration prevents full mode | same | 1 | written |
| While a migration is in progress, health answers in restricted mode and mutations are refused | same | 1 | written |
| A failing migration prevents dispatch of eligible work, and a correct restart dispatches it | `M05-failed-startup-no-dispatch.test.mjs` | 2 | written |
| A changed checksum on an applied migration prevents dispatch of eligible work | same | 2 | written |

Row closes in slice 2.

### M06. One engine incarnation

| Case | File | Slice | Status |
|---|---|---|---|
| A second engine on a live home is refused with `engine_locked` and changes nothing | `M06-engine-lock.test.mjs` | 1 | written |
| Simultaneous starts on one home produce exactly one owner | same | 1 | written |
| After the owner is killed, a restart takes over with a new incarnation and recovers before full mode | same | 1 | written |
| A lock naming a live process with a different start time (reused pid) is stale, and that process is not signalled | same | 1 | written |
| A lock naming a live process identity is honoured | same | 1 | written |
| A lock written under a previous boot is stale | same | 1 | written |
| A start refused for its token file takes no lock and does not block the next start (review) | same | 1 | written |
| Restart recovers owned runs and domains before any dispatch: the `recovery` step ends a run that was executing and terminates its domain before full mode (also the E23 item 1 obligation) | `M06-restart-recovery.test.mjs` | 2 | written |
| A directory where `api.token.tmp` should be: one refusal line, status 6, no stack trace, no lock left, next start succeeds (carried) | `M06-startup-failure.test.mjs` | 2 | written |
| A directory where `engine.lock.guard` should be: the same (carried) | same | 2 | written |
| An engine home that is not writable: the same (carried) | same | 2 | written |
| An API port that is already bound: status 6 `listen_failed` (carried) | same | 2 | written |
| A directory where `store.db` should be leaves the engine restricted with the failure readable (carried; passes on the slice-1 engine) | same | 2 | written |
| Startup `integrity` shown to do real work: a branch moved while the engine was down is found by the integrity step, before full mode and before any dispatch, while the other project runs | `M06-startup-integrity.test.mjs` | 3 | written |

### M07. Closed configuration and fixed M1 concurrency

| Case | File | Slice | Status |
|---|---|---|---|
| Engine defaults are inspectable, finite and attributed to their source | `M07-closed-configuration.test.mjs` | 1 | written |
| An unknown engine key is refused before the engine takes any state | same | 1 | written |
| A refused configuration leaves an existing home and store unchanged | same | 1 | written |
| Invalid API port values are refused | same | 1 | written |
| Invalid API authority values are refused | same | 1 | written |
| Out-of-range and malformed time limits are refused | same | 1 | written |
| The body caps are fixed | same | 1 | written |
| Out-of-range git deadlines and output limits are refused | same | 1 | written |
| Invalid decision-target overrides are refused | same | 1 | written |
| An empty decision-target map is valid and is reported as the default (review) | same | 1 | written |
| Engine-wide run concurrency is bounded | same | 1 | written |
| `null` never stands for a default or for unlimited | same | 1 | written |
| Valid alternatives take effect, are reported as configured and are used (authority used by the Host check; engine concurrency 3 leaves the project at 1) | same | 1 | written |
| Project defaults are inspectable, with concurrency fixed at 1 | same | 1 | written |
| Project concurrency other than 1 is refused with no effect | same | 1 | written |
| Unknown project keys are refused | same | 1 | written |
| Out-of-range project values (including snapshot caps) are refused, and a mixed submission changes nothing | same | 1 | written |
| A project is created through the API by a journaled bootstrap commit of `.surety/project.json`; the branch is registered; work is dispatched for it | `M07-project-bootstrap-and-policy.test.mjs` | 3 | written |
| A request the schema refuses, a path that is no repository and a branch that does not exist create nothing | same | 3 | written |
| A policy file that was in the repository before the project existed is not effective, is left as it is, and never becomes effective through a later change (E23 item 3) | same | 3 | written |
| A valid project policy change is committed through the journal, recorded as a revision and reported as effective; a second change is the next revision | same | 3 | written |
| A valid change takes effect: the repair limit, a role deadline and a snapshot cap are the changed ones | same | 3 | written |
| A change that widens authority raises `policy_widening` | `M49-policy-widening-manifest.test.mjs` | 5 | written |
| By default the engine runs two projects at once and no more | `M07-settings-used-by-scheduler.test.mjs` | 2 | written |
| A configured engine limit of three runs three projects at once, and still one run per project | same | 2 | written |
| Role deadlines are the configured settings | `M09-work-paths.test.mjs` (the dispatch assertions) | 2 | written |
| Tick step and tick budgets are used | `M15-deadlines.test.mjs` | 2 | written |

### M08. M1 capability boundary

| Case | File | Slice | Status |
|---|---|---|---|
| Session open, turn, save and close are refused before any effect | `M08-api-capability-refusals.test.mjs` | 1 | written |
| Management and release surfaces are refused | same | 1 | written |
| Deploy, publish and export requests are refused before any effect | same | 1 | written |
| Tables reserved for later designs, and environment observation tables, do not exist | same | 1 | written |
| A fixture-installed project is labelled as test setup | same | 1 | written |
| The test seam is unreachable outside harness mode | same | 1 | written |
| A trigger for a work kind outside M1 is refused and creates nothing | `M08-scheduler-capability-refusals.test.mjs` | 2 | written |
| A work item of an excluded kind that is in the store anyway is never launched, while permitted work is | same | 2 | written |
| Without the harness, a dispatch is refused before launch with `backend_refused` | same | 2 | written |
| In harness mode without a scripted directory, a dispatch is refused before launch with `backend_refused` | same | 2 | written |
| A scheduler intent for a session | — | — | not a separate case: M1 has no path that creates a session run; the API refusals are written (slice 1), and row M03 covers the store |
| Phase and completion gate evaluation is refused | `M44-stage-gate-versus-alpha-authorization.test.mjs` (last case) | 5 | written |
| Reserved decision kinds have no effect | — | 5 | not written (slice 5): no route and no fixture raises a decision of a kind M1 does not enable, so there is nothing to answer; a row inserted directly would test the test |

### M69. HTTP boundary and audit (core cases moved forward to slice 1)

Build spec §8 has slice 1 build the Host check, the token and the audit event, so their core cases are written now; the row is introduced in slice 6. The slice-1 review brought one more case forward from slice 6: `100 Continue` against the Host check, because slice 1 built the code that decides it. `100 Continue` against the refusals slice 6 builds stays there.

| Case | File | Slice | Status |
|---|---|---|---|
| A foreign Host is refused before routing, on reads and on mutations | `M69-boundary-core.test.mjs` | 1 | written |
| An absolute-form request target with a foreign authority is refused | same | 1 | written |
| A request with more than one Host header is refused, whatever the copies say (review; the Plan's "malformed Host") | same | 1 | written |
| `100 Continue` is not sent to a request the Host check refuses; a request that passes the checks is told to continue (review; moved forward from slice 6) | same | 1 | written |
| Requests without a valid token are refused | same | 1 | written |
| The token file is private, long and stable across restart | same | 1 | written |
| A token file open to group or others refuses the start and is left as it was (review) | same | 1 | written |
| Refused mutations are audited, and no token value is recorded | same | 1 | written |
| A successful mutation is audited and attributable to its request | same | 1 | written |
| A failed audit write refuses the mutation | same | 1 | written |
| A named pipe at `api.token` refuses the start promptly, whatever its mode, and nothing is written (carried) | `M69-token-file-and-expect.test.mjs` | 2 | written |
| A malformed token file refuses the start and is never replaced: empty, whitespace only, too short, leading whitespace, a line break or control character inside, non-ASCII (carried) | same | 2 | written |
| A well-formed token an operator wrote is used as it is (carried; passes on the slice-1 engine) | same | 2 | written |
| An `Expect` other than `100-continue` is answered by the engine: Host first, then its own audited refusal (carried) | same | 2 | written |
| A token file whose token has a space or a tab inside it refuses the start and is never replaced (3 cases; E24 item 8; passes on the slice-2 engine) | `M69-token-interior-whitespace.test.mjs` | 3 | written |
| Origin, Referer and fetch-metadata matrix; no CORS | — | 6 | deferred → 6 |
| Declared and streamed body caps; `100 Continue` against the Origin, Referer, fetch-metadata and body-cap refusals (the Host case is written, above). In particular `100 Continue` must not be sent before the declared-length body-cap check: the slice-1 engine tells a request whose `Content-Length` exceeds the cap to continue and refuses it afterwards (second slice-1 review) | — | 6 | deferred → 6 |
| Other malformed Host forms: a request with no Host header gets a bare 400 from the HTTP library, before the engine's handler. It should get the engine's refusal body (`host_refused`); the status is already right (E23 item 10) | — | 6 | deferred → 6: decided together with parser-level refusals ("error callbacks") |
| Defensive headers on every response, errors included | — | 6 | deferred → 6 |
| Error callbacks and stream callback failure do not crash the engine | — | 6 | deferred → 6 |

### M74. Accepted fixture semantics and invocation boundary (seam-confinement cases moved forward to slice 1)

The row is introduced in slice 6. The owner's decision after the slice-1 review (E23) tightened build spec §8's rule that test-mode code is confined to the seam module, and put its source inspection here, beside the row's other inspection of the build (a backend spawn outside the choke point). `harness/SEAM.md` §7 "Confinement" states the rule, what the inspection proves and what it does not.

| Case | File | Slice | Status |
|---|---|---|---|
| Production source reaches the seam folder only by importing the seam module | `M74-seam-confinement.test.mjs` | 1 | written |
| A value imported from the seam module is only ever called | same | 1 | written |
| Nothing outside the seam folder names the harness or the fixture label | same | 1 | written |
| Fixture and capability output; displayed states producible by the kernel's API; no-dispatch differs from measured zero | — | 6 | deferred → 6 (not yet split into cases) |
| UI or client cannot invoke models or mutate engine state outside the API; a backend spawn outside the choke point fails the boundary test | — | 6 | deferred → 6 (not yet split into cases) |

## Slice-2 rows

Kinds: "each dispatched kind" is `stage_build`, `fix`, `verification`, `review`, `replan`, `assessment`. `check_correction` is in the transition table and is not dispatched before slice 5. Slice 2 can reach two run-owning statuses with a real run, `claimed` and `executing`; the others need integration (slice 3) or an engine-raised decision on running work (slice 5).

### M09. Per-kind work transitions and blocked continuation

| Case | File | Slice | Status |
|---|---|---|---|
| For each of the seven M1 kinds: every edge outside the table, from every status the kind can reach, is an atomic refusal (generated; includes review → integration, and leaving `awaiting_decision` for a status the kind lacks or for a continuation it did not store) | `M09-work-transitions.test.mjs` (7 cases) | 2 | written |
| For each of the seven M1 kinds: every edge in the table is accepted (its path, the common templates it reaches, Stop and Abandon from every owning status, `integrated` and `awaiting_decision` included) | same (7 cases) | 2 | written |
| A verification item runs eligible → claimed → executing → complete with no integration step | `M09-work-paths.test.mjs` | 2 | written |
| A review item runs the same path | same | 2 | written |
| `stage_build`, `fix`, `replan`, `assessment`: dispatched, reach executing (4 cases; the plan fixture is checked in the `stage_build` case) | same | 2 | written |
| Retry on a parked item's blocker returns it to eligible, and only the next tick launches it; a stale preview and a second answer are refused; nothing unrelated is launched | `M09-blocked-continuation.test.mjs` | 2 | written |
| Cancel on a parked item's blocker cancels it without another launch | same | 2 | written |
| Legal paths that integrate, as far as `integrated`: a valid result of a `stage_build`, `fix` (Builder), `replan` or `assessment` (Architect) run is snapshotted, validated, committed with its role's revision kind and integrated (4 cases, generated from `contract/snapshot-validation.json`) | `M09-integrating-paths.test.mjs` | 3 | written |
| What follows `integrated`: a `replan` and an `assessment` item run their whole path to `complete` (2 cases) | `M09-after-integrated.test.mjs` | 3 | written |
| A `stage_build` item runs its whole path: `verifying` at the nomination that holds it, `complete` when that candidate's verification completes | same | 3 | written |
| A verification that fails completes nothing: the Builder's work is still `verifying` when the failed run is over and its repair has begun | same | 3 | written |
| A `fix` item stays `integrated` until a candidate that holds it is nominated, and is verified with that candidate | same | 3 | written |
| Work integrated after a nomination is not held by that candidate: it stays `integrated` when the candidate is verified | same | 3 | written |
| A stage's work is `complete` only when its `stage` gate is satisfied | `M44-stage-gate-versus-alpha-authorization.test.mjs` (first case) | 5 | written. The four Builder cases above were not changed and still assert the interim rule: see "Obligations recorded by the slice-5 session" |
| `check_correction` dispatched and completed | `M36-capture-protected-only-proposal.test.mjs` (first two cases) | 5 | written: it completes through proposal capture, and a rejected diff does not complete it |
| An engine-raised `awaiting_decision` answered through the queue restores its stored continuation | — | 5 | not written (slice 5): M1 still has no engine path into `awaiting_decision`; the typed conflict that would be the first (row M11) is not written either |

### M10. Trigger identity through all outcomes

| Case | File | Slice | Status |
|---|---|---|---|
| A trigger observed again before completion (waiting and running), after a refused run, after restarts and after success creates nothing and raises no error; a new generation is a distinct item and runs | `M10-trigger-identity.test.mjs` | 2 | written |
| A new generation stays subject to the project pause and to the one run a project may have | same | 2 | written |
| A new generation is not dispatched onto a project whose old run is quarantined | `M14-abandon.test.mjs` (the quarantine case) | 2 | written |

Row closes in slice 2.

### M11. Repair and conflict stopping

| Case | File | Slice | Status |
|---|---|---|---|
| Work whose every run fails is launched once plus the permitted repairs, each counted once, then parks with its cause | `M11-repair-limits.test.mjs` | 2 | written |
| A result that is not valid is a failed run, counted once however often it is sent; a repair that succeeds completes (kind `verification`) | same | 2 | written |
| Runs refused before launch are counted on their own and park the work at their limit | same | 2 | written |
| Work whose every attempt leaves the same rejected tree is launched once plus `no_progress_max` times, then parks for no progress: the progress key is taken over the snapshot tree | `M11-no-progress-over-snapshot-tree.test.mjs` | 3 | written |
| Work whose every attempt leaves a different rejected tree counts no lack of progress, and parks at the repair limit | same | 3 | written |
| A small repair that succeeds completes work that integrates | same | 3 | written |
| Unchanged findings with new ids and timestamps: the findings part of the progress key | — | 5 | not written (slice 5): in M1 findings are reported by Verifier and Reviewer runs, which are not repaired on what they find; no failed run carries findings into a progress key |
| A requirement or contract conflict routes to a decision without another repair | — | 5 | not written (slice 5): D1 §4.3 gives it one clause ("routes to objection or baseline review") and M1 builds neither route; it needs the owner to say what the route is in M1 |

### M12. Scheduling boundaries

| Case | File | Slice | Status |
|---|---|---|---|
| A paused project dispatches nothing while the other progresses | `M12-scheduling-boundaries.test.mjs` | 2 | written |
| Pausing lets the run under way finish and holds back what would follow it | same | 2 | written |
| A held item is never launched while the other project progresses | same | 2 | written |
| An item on dispatch hold is never launched while the other project progresses | same | 2 | written |
| An item is not launched before the work it depends on is complete (the "blocked" case) | same | 2 | written |
| A project has one run at a time | same | 2 | written |
| Concurrency across projects is bounded by the engine setting | same | 2 | written |
| Simultaneous tick requests run one scheduler and dispatch each item once | same | 2 | written |
| A project that is over its day budget dispatches nothing while the other project progresses | `M12-over-budget-project.test.mjs` | 4 | written |
| Work that a run's outcome created (a candidate's verification) is not launched without a human step: one decision, asked once, also across a restart, while another project's work progresses; after `continue` it is launched once | `M12-chain-of-roles.test.mjs` | 3 | written |
| `cancel` at the boundary cancels the work without a launch | same | 3 | written |
| The work a committed plan registers is chained too: its stages are not built without a human step | same | 3 | written |
| What is not a chain: work a fixture created, the repair of a failed run and a Resume are dispatched without a human step, also while chained work waits | same | 3 | written |
| A limit above 1: a chain of two or more roles runs unasked up to the limit and stops there | `M49-policy-widening-manifest.test.mjs` (first case) | 5 | written |

### M13. Stop from every owning state

| Case | File | Slice | Status |
|---|---|---|---|
| Stop from `executing`, for each dispatched kind: the role is fenced, usage is kept, a late success changes nothing, the run ends stopped, the work is held, Resume starts a new linked run (6 cases) | `M13-stop.test.mjs` | 2 | written |
| Stop from `claimed`, for each dispatched kind: a run stopped before its role was spawned leaves no role running and holds the work (6 cases) | same | 2 | written |
| While the boundary still reports the domain running, the stopped run is not ended and the work is not held (the delayed acknowledgement) | same | 2 | written |
| Stop needs its confirmation, a stale confirmation does nothing, and a run is stopped only through its own project | same | 2 | written |
| Stop while the work is `integrating`, before the swap: the integration is not made, its operation is failed, the work is held, Resume integrates a new run | `M13-stop-during-integration.test.mjs` | 3 | written |
| Stop while the work is `integrating`, with the swap made and not yet recorded: the operation in flight is reconciled and finalized, the work is integrated and then held, nothing is undone | same | 3 | written |
| Stop while the work is `integrated` and its run has not ended: the run ends stopped, the work is held, the integration stands | same | 3 | written |
| Work that is `verifying` is owned by no run of its own: stopping the candidate's verification run holds the verification work and leaves the Builder's work `verifying`; the Builder's ended run cannot be stopped | same | 3 | written |
| Stop from `awaiting_decision` while a run still owns the work | — | 5 | not written (slice 5): no engine path into `awaiting_decision` (row M09, above); the edge stays pinned at the table |

### M14. Abandon and durable dispatch hold

| Case | File | Slice | Status |
|---|---|---|---|
| Abandon from `executing`, for each dispatched kind: termination confirmed, workspace discarded, work back at its prior status under a dispatch hold, no repurchase until Resume (6 cases) | `M14-abandon.test.mjs` | 2 | written |
| Abandon from `claimed`, for each dispatched kind (6 cases) | same | 2 | written |
| While the boundary reports the domain running nothing is discarded, and no new trigger generation is dispatched onto the project; when termination is observed the abandon completes and the new generation runs | same | 2 | written |
| Resume of an eligible item on dispatch hold writes exactly one `work.resumed` event, in the transaction that clears the hold: with the event's write failing, the hold stays (review) | same | 2 | written |
| Abandon while the work is `integrating`, before the swap: the integration is not made, its operation is failed, the workspace is discarded, the work returns to `eligible` under a dispatch hold | `M14-abandon-during-integration.test.mjs` | 3 | written |
| Abandon while the work is `integrating`, with the swap made and not yet recorded: the operation in flight is reconciled and finalized before anything is discarded | same | 3 | written |
| Abandon while the work is `integrated` and its run has not ended: the workspace is discarded, the integration stands | same | 3 | written |
| Abandon from `verifying` | — | — | not a case: no run owns work that is being verified (`harness/SEAM.md` §47); the M13 case above pins that for Stop, and an ended run refuses Abandon as it refuses Stop (slice 2) |
| Abandon from `awaiting_decision` while a run still owns the work | — | 5 | not written (slice 5): as for Stop |

### M15. Deadlines and stale generations

| Case | File | Slice | Status |
|---|---|---|---|
| A run past its deadline is cancelled, a late success changes nothing, dependent work stays undispatched, other work and control requests are not disturbed; then the work continues | `M15-deadlines.test.mjs` | 2 | written |
| A deadline is not observed termination: with the boundary reporting the domain running, the run is quarantined | same | 2 | written |
| A prerequisite step that overruns its budget suppresses that project for the tick, late completion included | same | 2 | written |
| A tick that has used up its budget dispatches nothing more | same | 2 | written |
| The transaction that enters `finalizing` fails once: the run still ends within a bounded number of ticks, with the outcome decided before its lease expired (`completed`: the role's result had been accepted and the role had exited 0), and the project dispatches its next item (review; outcome pinned after review 2, E27 item 3) | `M15-lease-supervision.test.mjs` | 2 | written |
| The transaction that ends the run fails once: the run still ends with the outcome it had recorded, the work is not bought again, and the project dispatches its next item (review) | same | 2 | written |
| A role that sends no heartbeat for longer than `lease_ttl` keeps its lease, because the engine renews it at least every `lease_ttl`/3, and has its result accepted (review; E25 item 1). After review 2 the comparison with the clock allows two seconds for a host clock that steps back (`harness/SEAM.md` §23) | same | 2 | written |
| A lease nobody renews expires, and the next tick puts its run through the run-end protocol although the engine that owns it is alive: a launch stalled before the spawn finds its run ending or over when it comes back, and spawns nothing (review; E25 item 1). The run is treated as recovered: `recovered` / `recovered`, its work `held` and not dispatched again by itself, `repair_attempts` unchanged, no blocker, while the project's next item runs (review 2; E27 item 3) | same | 2 | written |
| A lease past its expiry is not renewed by a heartbeat or by the engine, the result presented on it is refused, the role is not left running, and the project goes on (review; E25 item 1). The run is treated as recovered, as above, although its role exited afterwards; the held work gets a new run, linked to the first, only after an explicit Resume (review 2; E27 item 3) | same | 2 | written |
| The engine renews the lease of a run it is preparing: with the launch held before the spawn and the clock moved in steps shorter than `lease_ttl`/3 for more than twice `lease_ttl`, the lease is renewed at least every `lease_ttl`/3 and never expires; when the launch is let go the role is spawned once and the run completes (review 2; E27 item 2) | same | 2 | written |
| After the engine has decided to end a run (past its deadline, the `run.finalizing` transaction failed once), a heartbeat of its role does not move the lease (review 2; E27 item 5) | same | 2 | written |
| A run past its deadline whose `run.finalizing` transaction fails once, with a role that keeps sending heartbeats and never exits by itself, still ends `timed_out` within a bounded number of ticks while the clock moves only in steps shorter than `lease_ttl`; the role is terminated; the work is parked with cause `deadline`; the project dispatches its next item (review 2) | same | 2 | written |
| The run-end fault matrix: for each of ten ways a run can end in slice 2, one reference case and one case per store transaction on its path (77 cells, generated from `contract/run-end-faults.json`). With a one-shot fault armed on the transaction, the project reaches the same final durable facts as with none, without a restart (final review; E28 item 1) | `M15-run-end-fault-matrix.test.mjs` (87 cases) | 3 | written |
| A Stop confirmed while a deadline end is being retried is refused with `illegal_transition`; the run ends `timed_out` and its work is parked behind the deadline blocker (final review) | `M15-decided-outcome-stands.test.mjs` | 3 | written |
| A Stop confirmed after the lease has expired and before a tick has acted on it is recorded as given: `stopped`, work `held` (final review; E28 item 2; passes on the slice-2 engine) | same | 3 | written |
| An Abandon confirmed in the same position is recorded as given: `abandoned`, workspace discarded, work on dispatch hold (final review; E28 item 2; passes on the slice-2 engine) | same | 3 | written |
| A role that exited 0 after its result was accepted ends `completed` although the clock jumps past `lease_ttl` before the engine has acted on the exit (final review) | same | 3 | written |
| A `worktree add` held open is killed at `git_deadline`, its operation is marked ambiguous, no role is launched on it, and another project and the API go on | `M15-git-deadline-and-integrity-step.test.mjs` | 3 | written |
| An integrity step that overruns its budget suppresses that project for the tick, late completion included, while the other project is dispatched | same | 3 | written |
| An operation that a git deadline left ambiguous stays ambiguous and blocks its project while the repository does not answer; once it does, the next tick reconciles it absent and withdraws it; its run had ended `failed` / `infra_error`, never launched, and the work is repaired by a new run in a workspace of its own | `M15-ambiguous-git-call-reconciled.test.mjs` | 3 | written |
| A late completion launches nothing: a worktree that turns out complete is adopted as the ended run's retained workspace, and the work is still repaired by a new run | same | 3 | written |
| The run-end fault matrix for the five endings that pass through a commit or an integration (a role completes and its work integrates; an integration refused; Stop and Abandon from `integrating`; a checkpoint): one reference case per ending and one case per store transaction on its path (61 cells, generated from `contract/run-end-faults.json`); the compared facts include the repository and the journal (E28 item 1) | `M15-run-end-fault-matrix-integration.test.mjs` (66 cases) | 3 | written |
| A commit or a ref update left ambiguous by a deadline in a running engine | — | — | not written: see "What the second session could not turn into a test" |

### M16. Unknown termination is never success

| Case | File | Slice | Status |
|---|---|---|---|
| The role process exited, but the boundary still reports the domain running (parent exited, child live); survives a restart; an acknowledgement establishes nothing | `M16-quarantine.test.mjs` | 2 | written |
| The boundary cannot read membership; survives a restart | same | 2 | written |
| Cancellation fails after Stop; survives a restart; an acknowledgement establishes nothing | same | 2 | written |
| No discard while quarantined | `M14-abandon.test.mjs` (the quarantine case) | 2 | written |
| A role that completes and exits, leaving a real descendant that holds its stdout open: the run-end protocol begins at the exit, the descendant is terminated as a member of the domain, the run ends `completed` (review) | `M16-quarantine.test.mjs` | 2 | written |
| With the boundary reporting `unknown`, a stopped run is quarantined at that report, not after `terminate_grace` and `kill_grace` (review) | same | 2 | written |
| With the boundary reporting `unknown`, a stopped role that ignores SIGTERM is quarantined at the report, is still running then, and is sent SIGKILL once `terminate_grace` has passed, without a tick; the quarantine holds while the boundary cannot be read, and clears, the run ending `stopped` and the work `held`, once the boundary reads again (review 2) | same | 2 | written |
| A role that sends a valid result, closes its stdout and exits 0 later is not signalled and has no outcome while it lives; when it exits the run ends `completed` (review 2) | same | 2 | written |
| A valid result with no line ending, from a role that exits 0, ends `completed` (review 2; E27 item 1; a guard: the slice-2 engine already passes it) | same | 2 | written |
| The same with a descendant of the role holding its stdout open: `completed`, and the descendant terminated (review 2; E27 item 1) | same | 2 | written |
| A role that writes one line of 64 MiB and then its usage and a valid result ends `completed` within eight seconds, with the usage recorded: reading a role's output is linear in the length of a line and loses nothing after a long line (final review) | `M16-role-output-long-line.test.mjs` | 3 | written |
| No snapshot while quarantined: a Builder whose domain cannot be read after its valid result is quarantined as `failed` / `infra_error`, is never snapshotted (not when the quarantine clears either), and its work is repaired by a new run | `M16-no-snapshot-while-quarantined.test.mjs` | 3 | written |

### M17. Observed quarantine clearance

| Case | File | Slice | Status |
|---|---|---|---|
| From M16's durable state: the boundary reports the domain empty, the run ends with its recorded outcome, one ledger row, one disposition, the reservation released once, no capability revived; repeating the observation and restarting change nothing; the work continues | `M17-quarantine-clearance.test.mjs` | 2 | written |
| A run quarantined after its role finished keeps the outcome it recorded when the quarantine is cleared | same | 2 | written |

Row closes in slice 2.

### M18. Allocation, launch and end crash boundaries

| Case | File | Slice | Status |
|---|---|---|---|
| Killed at run created | `M18-crash-boundaries.test.mjs` | 2 | written |
| Killed at domain allocated | same | 2 | written |
| Killed at receipt committed | same | 2 | written |
| Killed just before the spawn | same | 2 | written |
| Killed after the role was spawned and before its ownership was completed (the role outlives the engine and is found by its marker) | same | 2 | written |
| Killed after a normal result and before the engine acted on it | same | 2 | written |
| Killed while finalizing, before ended: the recorded outcome is kept and finalized once | same | 2 | written |
| A recorded pid that now belongs to an unrelated process is not signalled | same | 2 | written |
| A boundary whose emptiness is unknown after the restart leaves the run quarantined until termination is observed | same | 2 | written |
| After a normal result: recovery ends the run as recovered, records the snapshot tree of what the role left, and accepts nothing | `M18-snapshot-recovery.test.mjs` | 3 | written |

## Rows of slice 3 with a case moved forward to slice 2

The slice-2 review found two defects in the one git effect slice 2 makes, the run workspace. Their rows are introduced in slice 3; the cases are written now and their files are listed under slice 2, because the slice-2 engine already makes the call they pin. Slice 3's Verifier splits the rest of each row.

### M23. Two repositories and hostile ambient overrides (engine git runs no repository code, moved forward)

| Case | File | Slice | Status |
|---|---|---|---|
| A `post-checkout` hook (and a `reference-transaction` hook) in the repository's hooks directory is not run when the engine creates a workspace (review; E25 item 3) | `M23-engine-git-runs-no-repository-code.test.mjs` | 2 | written |
| The same hooks in a directory the repository's configuration names as `core.hooksPath` are not run either (review; E25 item 3) | same | 2 | written |
| A program the repository's configuration names as `core.fsmonitor` is not run when the engine creates a workspace; the fixture first shows that git runs it on an ordinary `worktree add`, also with hooks switched off (review 2; E27 item 4) | same | 2 | written |
| None of git's hooks in the repository's hooks directory is run on workspace creation, snapshot, commit, ref update or integrity reads | `M23-no-repository-code-snapshot-commit.test.mjs` | 3 | written |
| No hook in a directory the repository's configuration names as `core.hooksPath` is run | same | 3 | written |
| The program named as `core.fsmonitor` is not run | same | 3 | written |
| A filter driver named in the repository's configuration is not run, and its files are committed unfiltered (2 cases: clean and smudge programs; a long-running process filter). E29 item 1: a repository that needs one is not supported in M1 | same | 3 | written |
| An external diff program, a textconv program, a signing program, an editor and a pager named in the repository's configuration are not run | same | 3 | written |
| A filter driver is not run however the repository's configuration spells it (the slice-3 review; 4 cases: an old-style dotted section whose name is not all lower case, `[filter.EVIL]`; a second section header on one line, `[core] [filter "evil"]`; an include written on one line with the driver defined only in the included file; an included file reached through a symbolic link). Each case first shows that ordinary git runs the program on that fixture | `M23-filter-driver-however-spelled.test.mjs` | 4 | written (by the slice-5 session; listed under slice 4, whose Builder fixes it; not run: this working copy has no slice-3 engine) |
| `core.sshCommand`, credential helpers, `core.askPass` | — | — | not a case: no git call M1 makes reaches them (no remote operation). A merge driver is reached by the rebase and is pinned in `M28-integration-race-and-compare-and-swap.test.mjs` |
| Two repositories with identifiable content, hostile `GIT_*`, `GH_*`, editor and pager variables, hostile global and counted configuration, and the engine started inside a third repository: each project is committed and integrated in its own repository, nothing reaches the other or the third, no ambient program runs, no commit carries an ambient identity | `M23-two-repositories-hostile-environment.test.mjs` | 3 | written |

### M31. Worktree-add probe (the engine home behind a symbolic link, moved forward)

| Case | File | Slice | Status |
|---|---|---|---|
| With `$SURETY_HOME` a symbolic link, a dispatch launches, its `worktree_add` operation is recorded `succeeded`, the role runs in the workspace, and no worktree is registered in the repository that no `workspaces` row names, also after a second dispatch (review) | `M31-worktree-add-symlinked-home.test.mjs` | 2 | written |
| A symbolic link at a new run's workspace path, pointing at another run's retained worktree, is refused: the worktree add does not succeed, no role runs there, and the other worktree is untouched (second slice-2 review; E27) | `M31-workspace-path-symlink.test.mjs` | 3 | written |
| The five probe outcomes at recovery, from each of three durable journal states (15 cases, generated) | `M31-worktree-add-probe.test.mjs` | 3 | written (below, "M29 to M32") |
| An engine killed during `git worktree add` leaves the git child alive: recovery does not act on a probe while that child lives, and no worktree appears afterwards that no row names (slice-2 review) | `M31-git-child-outlives-engine.test.mjs` | 3 | written |

## Slice-3 rows, first session (M19 to M25)

Generated cases are generated from `contract/snapshot-validation.json`. "Builder" cases use the kind `fix`; the role rules are the same for `stage_build`. Every rejected-result case first shows that the role did what the case is about, and then that nothing of the run was accepted: no commit, no revision, no ref created or moved by the engine, the registry unchanged, the workspace retained.

### M19. Own content versus metadata

| Case | File | Slice | Status |
|---|---|---|---|
| A Builder that adds, changes, deletes and renames files and links one to another has exactly that committed, and is never out of band while it works (ticks run their integrity step while the role holds with its edits on disk) | `M19-own-content-versus-metadata.test.mjs` | 3 | written |
| An Architect that writes its own artifacts has them committed as an `intent` revision | same | 3 | written |
| A Builder that makes a permitted edit and alters something outside the diff has the whole result rejected as a ref violation (9 cases: commits in its workspace; checks out a branch there; stages a file in the real index; changes the repository's configuration; plants a hook; rewrites its workspace's `.git` file; moves the integration branch; deletes it; edits a tracked file in another run's retained workspace). For the two ref cases the altered ref is also observed out of band and not absorbed | same | 3 | written |
| A Builder that changes the identity file of a project created through the API, or creates it in a project that has none, has the whole result rejected (2 cases) | same | 3 | written |

Row closes in slice 3.

### M20. Unsafe diff and literal prompt

| Case | File | Slice | Status |
|---|---|---|---|
| Builder and Architect: every path the role may change is committed (2 cases) | `M20-unsafe-diff-and-literal-data.test.mjs` | 3 | written |
| Builder: a change to a path under `.surety/`, with a permitted change beside it, rejects the whole result (7 cases, among them the protected root, the policy file and the identity file). Architect: a change outside its four directories does (6 cases) | same | 3 | written |
| A snapshot that holds a link leading outside the workspace (4 cases: absolute; relative with `..`; through another link; replacing a tracked file), a repository of its own (a gitlink), a protected change beside a source change, or more than a cap allows (3 cases: one file over `snapshot_max_file_bytes`; more files than `snapshot_max_files`; more bytes than `snapshot_max_bytes`) is rejected whole | same | 3 | written |
| Files named like options or holding shell syntax are committed under exactly those names, and nothing is run | same | 3 | written |
| A stage goal and a role summary full of shell syntax, options and forged trailers change nothing but the text they are: each commit trailer exists once, with the engine's value | same | 3 | written |
| An integration branch whose name holds shell syntax is a branch like any other | same | 3 | written |
| What a role wrote outside its workspace is in no commit (M1 does not keep a role inside its workspace, E25 item 2; this pins only that nothing of it is accepted) | same | 3 | written |
| A Verifier's protected-only diff, its protected-and-source mixture, and another role's protected diff as a *proposal* question | `M36-capture-protected-only-proposal.test.mjs` | 5 | written, with the Verifier's and the Reviewer's role prohibitions |
| The cap on a git command's output (`git_output_cap`) | — | — | not written: see "What this session could not turn into a test" |

### M21. Quiescent snapshot and checkpoint

| Case | File | Slice | Status |
|---|---|---|---|
| While the boundary reports the domain running nothing is captured; once it reports terminated the checkpoint is taken, the validated, recorded, journaled and committed trees are one tree, the integration branch does not move, nothing is nominated, the workspace's current base advances, the run's original base is kept, and the work is to be continued | `M21-quiescent-snapshot-and-checkpoint.test.mjs` | 3 | written |
| The next run starts from the checkpoint commit in a workspace of its own, linked to the run that checkpointed, with no repair charged; its commit, made on the checkpoint, is the one integrated | same | 3 | written |
| A continuation "does not imply gate success" | — | 5 | not written (slice 5): a checkpoint nominates nothing (asserted in slice 3) and a gate is evaluated for a candidate, so there is no gate a continuation could have satisfied |

### M22. Integration branch checked out elsewhere

| Case | File | Slice | Status |
|---|---|---|---|
| Checked out in the repository's own work tree: the ref does not move, the checkout is left exactly as it was, the run fails with `integration_conflict`, the work is parked with a blocker that names the worktree and says how to free the branch; once it is freed a retry integrates | `M22-integration-branch-checked-out-elsewhere.test.mjs` | 3 | written |
| Checked out in a linked worktree with uncommitted edits: refused the same way, and every edit, staged or not, and every untracked file is still there | same | 3 | written |
| Checked out between the commit and the compare-and-swap (barrier `journal.ref_update.intent_committed`, armed while the engine runs): the second check refuses it, and the journaled ref update is recorded as failed | same | 3 | written |
| A project is not created through the API on a repository whose integration branch is checked out; once it is freed, it is | same | 3 | written |
| The supported topology: the developer's work tree on another branch, one linked worktree detached and one on a feature branch; the integration goes through, no checkout is touched, nothing is reported out of band | same | 3 | written |

Row closes in slice 3.

### M23. Two repositories and hostile ambient overrides

Its cases are in the table "Rows of slice 3 with a case moved forward to slice 2", above: two files in slice 2 and slice 3 for the rule that engine git runs no repository code, one for the two repositories under a hostile environment. Row closes in slice 3.

### M24. Tracked refs versus developer refs

| Case | File | Slice | Status |
|---|---|---|---|
| A branch and a tag the engine does not track are created, moved and deleted: no observation, no decision, and the project goes on | `M24-tracked-refs-versus-developer-refs.test.mjs` | 3 | written |
| The integration branch moved by someone else: observed once, not absorbed, the project blocked (nothing dispatched; a policy change refused with `out_of_band_change`), also across ticks and a restart | same | 3 | written |
| `discard` puts the branch back through the journal, keeps the stray commit under a registered `refs/surety/oob/` ref, and the project goes on from the expected commit; the engine's own reset, oob ref and integration are not observed in turn | same | 3 | written |
| `adopt` makes the commit found the expected one, records it as an `out_of_band` revision, and the project goes on from it | same | 3 | written |
| The integration branch deleted: observed with nothing found, the project blocked, and `discard` restores it | same | 3 | written |
| A ref the engine created for a checkpoint, moved and then deleted by someone else, is observed each time and never absorbed | same | 3 | written |
| After a bootstrap, a policy change, a checkpoint and an integration, through ticks and a restart, nothing is out of band and every registered ref is where the registry expects it | same | 3 | written |
| An immutable nomination ref moved: observed once, not absorbed, also across a restart; `discard` is the only answer offered; it puts the ref back through the journal and keeps the stray commit; the candidate is untouched | `M24-nomination-ref-moved-or-deleted.test.mjs` | 3 | written |
| An immutable nomination ref deleted: observed with nothing found; `discard` restores it | same | 3 | written |
| "Block affected gates" | `M40-durable-evidence-invalidation.test.mjs` (first case) | 5 | written for an observation of the integration branch. For an observation of a nomination ref: not written (the rule the tests fix is per project, `harness/SEAM.md` §72) |

### M25. Checkout edits and unreadable repository

| Case | File | Slice | Status |
|---|---|---|---|
| An unstaged edit in the developer's checkout of the integration branch, with HEAD and index where they were, is observed as a checkout change, preserved, and offered `stash` or `adopt`; one observation across ticks and a restart; the baseline is not replaced | `M25-checkout-edits-and-unreadable-repository.test.mjs` | 3 | written |
| A staged edit is observed the same way: the index differs from the baseline, the HEAD does not | same | 3 | written |
| An unreadable repository is reported as unreadable, not as clean; nothing is dispatched, a command that needs it is refused with `repo_unreadable`, and no option is offered; once readable and unchanged, the observation closes and the project goes on | same | 3 | written |
| A ref that was moved while the repository could not be read is found when it can be read again, before anything is dispatched | same | 3 | written |
| The answers to a checkout observation (`stash`, `adopt`), and what the decision binds | `M46-out-of-band-change-manifest.test.mjs` | 5 | written for `stash` and for what the decision binds. `adopt` of a checkout: not written (row M46's required result does not name it) |

## Slice-3 rows, second session (M26 to M34, and the cases that pass through an integration)

The probe cases, the crash cases and the fault-matrix cells are generated from `contract/journal.json` and `contract/run-end-faults.json`; each cell is its own reported case. Every case that brings an operation to an end checks it, and usually every operation of its project, with `assertOperation` (`harness/journal.mjs`): a legal journal, the state projection at its last event, attempts numbered and admitted by the rule, the status the table derives, one `git.journal_*` event per journal event. The cases of rows M04, M09, M12, M13, M14, M15, M24 and M31 that this session wrote are listed in the tables of those rows above.

### M26. Stage and intent finalizers

| Case | File | Slice | Status |
|---|---|---|---|
| The integration of a commit that holds a phase plan registers the plan, one stage row per stage and one `stage_build` item per stage, and the `replan` work is complete; ticks and a restart register nothing again | `M26-plan-and-stage-finalizers.test.mjs` | 3 | written |
| The finalizer is delayed while a newer plan is introduced: it registers the committed plan, exactly, and nothing of the newer one | same | 3 | written |
| Killed after the integration of a plan was confirmed and before its finalizer, with the plan file in the workspace rewritten meanwhile: the restart registers the plan once, from the commit; the `replan` work is complete (no ownerless plan); a second restart writes nothing again | same | 3 | written |
| A plan file that is not JSON, or has a stage with no goal, rejects the whole result: nothing is committed that could not be registered (2 cases) | same | 3 | written |
| The integration of a stage's work marks that stage integrated at the run's commit | same | 3 | written |
| The finalizer is delayed while a newer plan with a stage of the same number is introduced: the stage the run built is the one finalized, the newer stage and its work are untouched | same | 3 | written |

### M27. Nomination identity and cadence

| Case | File | Slice | Status |
|---|---|---|---|
| T2: the completion of a stage nominates the integrated revision; candidate, immutable ref, registry and lineage succession agree; one verification item; the stage's work is `verifying`; ticks and a restart nominate nothing again and observe nothing out of band | `M27-nomination-identity-and-cadence.test.mjs` | 3 | written |
| T1: the completion of a stage nominates nothing; the work stays `integrated` | same | 3 | written |
| T1: a Builder's `nominate: true` is performed by the engine, `nominated_by` `builder_request` | same | 3 | written |
| T2: a Builder's request before the cadence point is not a nomination: no candidate, ref or journaled nomination | same | 3 | written |
| T1: a checkpoint is never a candidate, although the Builder asked for a nomination with it | same | 3 | written |
| A `nominate` that is not a boolean makes the result invalid | same | 3 | written |
| A second stage integrated after a nomination is recorded on the successor lineage and nominated as the next candidate; the first candidate, its ref and its lineage are as they were | same | 3 | written |
| Killed after the nomination ref was written and confirmed, before the finalizer: the restart's recovery step writes the candidate, registers the ref and succeeds the lineage before full mode; a second restart writes nothing again (D1-18) | same | 3 | written |
| Killed after a T2 stage was integrated and before it was nominated: the stage is still nominated after the restart, once | same | 3 | written |
| T1's nomination at phase completion | — | — | not a case in M1: phase verification is not in M1 (build spec §3) |
| The evidence of an earlier candidate is retained when the source changes after its nomination | — | 4 | deferred → 4: no evidence record exists before the records slice; slice 3 pins that the candidate, its ref and its lineage are retained |

### M28. Integration race and compare-and-swap

| Case | File | Slice | Status |
|---|---|---|---|
| The branch moved by the engine's own commit while the run was under way: the result is rebased onto the head, the rebased tree is the head's tree plus the run's changes, it is committed on the head through the journal, and the swap is made from the head | `M28-integration-race-and-compare-and-swap.test.mjs` | 3 | written |
| The branch moved to an adopted commit that changes the same file another way: the rebase conflicts, nothing is integrated, the work parks, no role is launched and no work created to resolve it; after `retry` the work runs again from the new head | same | 3 | written |
| The branch moved between the journaled intent and the swap: the compare-and-swap fails, the unexpected head is not overwritten, the operation is failed, the registry is not told, the move is observed out of band; after adopt and `retry` the work is integrated on top | same | 3 | written |
| A merge driver the repository's configuration names is not run by the rebase | same | 3 | written |
| A rebased tree that fails validation where the run's own snapshot passed (the protected set) | — | 5 | not written (slice 5): it needs a protected application to land between a Builder's base and its integration, which one run per project and the integration lease leave no cheap way to arrange |

### M29 to M32. The four probes, five outcomes each

One case per journal kind, durable journal state (`intended`, `applied`, `ambiguous`) and probe outcome: 4 × 3 × 5 = 60 cases, and three more for the second form of a partial worktree add. Each builds the outcome in real git by hand, starts the engine, and compares what recovery made of the operation with `contract/journal.json`. A case whose outcome blocks then removes what blocked it and shows the operation going through; every case ends with the project going on through the public API.

| Kind (file, 15 cases each) | `absent` | `applied` | `partial` | `conflicting` | `unknown` |
|---|---|---|---|---|---|
| `ref_update`: the integration of a Builder's run (`M29-ref-update-probe.test.mjs`) | ref at the old commit: retried once | ref at the new commit: finalized, the swap not repeated | claimed, no remainder declared: blocks | ref at a third commit: blocks, not overwritten | repository unreadable: blocks |
| `commit_tree`: the commit of a Builder's run (`M30-commit-tree-probe.test.mjs`) | object and keep ref removed: retried, the same commit id | as the effect left it: finalized | keep ref removed: completed by publishing | keep ref at another commit: blocks | object store unreadable: blocks |
| `worktree_add`: the workspace of a dispatch (`M31-worktree-add-probe.test.mjs`, 18 cases) | no artifacts: withdrawn | complete worktree: adopted once | metadata without directory: residue removed, withdrawn; and, as three further cases, metadata and directory with the checkout not finished (what a `worktree add` cut short leaves): not adopted, residue removed, withdrawn | unrelated directory at the path: blocks, content untouched | worktree metadata unreadable: blocks |
| `worktree_remove`: an abandoned run's workspace (`M32-worktree-remove-probe.test.mjs`) | worktree still there: retried | nothing left: finalized | metadata without directory: completed | unrelated directory at the path: blocks | worktree metadata unreadable: blocks |

All 63 are written, slice 3. Not written: a third form of `partial` for the two worktree kinds, a directory that still has its link and no metadata in the repository (see "What the second session could not turn into a test").

| Case | File | Slice | Status |
|---|---|---|---|
| A workspace removal that a git deadline left ambiguous, followed by a crash before the run had ended: recovery completes, the engine reaches full mode, the same operation is retried and the workspace discarded once, the run ends abandoned (slice-2 review) | `M32-ambiguous-removal-then-crash.test.mjs` | 3 | written |
| The same with the engine still running: while the repository does not answer the removal stays blocked and the run is not ended; once it answers the next tick retries the same operation | same | 3 | written |

### M33. Crash across journal and finalizer boundaries

| Case | File | Slice | Status |
|---|---|---|---|
| For each of the four journal kinds, the engine killed at each of the five boundaries (20 cases, generated). Each reads what is durable (journal, projection, attempts, the effect in git, the finalizer's receipts), restarts, requires the way on the table gives, restarts a second time and requires every receipt to have the identity and content it had, and lets the project go on | `M33-crash-across-journal-and-finalizer-boundaries.test.mjs` | 3 | written |

### M34. Operation attempt semantics

| Case | File | Slice | Status |
|---|---|---|---|
| An operation is committed before its first attempt is issued; the attempt is number 1, admitted once, and succeeds when the probe confirms its effect | `M34-operation-attempt-semantics.test.mjs` | 3 | written |
| The store refuses a second attempt with a number already used, and a second journal event with a sequence number already used | same | 3 | written |
| A failure before any effect leaves the attempt and the operation failed; no tick and no restart retries it; a new operation that does its work names it as its prior and supersedes it | same | 3 | written |
| An attempt whose command was killed at its deadline is ambiguous, and so is its operation: not retried before a probe has reconciled it, and it completes nothing | same | 3 | written |
| Reconciled succeeded: an attempt whose effect was applied and never recorded is reconciled, not repeated | same | 3 | written |
| Reconciled absent: between the reconciliation and the retry the operation is `intended` again; the retry is attempt 2 of the same operation | same | 3 | written |
| Reconciled partial: with the remainder declared the operation is `partial`, and completes nothing, until a new attempt has completed it | same | 3 | written |
| The derivation gives a status for every combination of latest attempt, journal state and successor | `harness/selfcheck/slice3b.mjs` (not an acceptance case) | — | checked on the contract table: no engine is involved in it |

## Slice-4 rows (M59 to M67, and the cases earlier rows left for slice 4)

Written by one Verifier session under E31. Each row has the fewest cases that pin its required result; a separately reported case exists only where the Plan names a finite set. The contract is `harness/SEAM.md` §§52 to 64. The cases of M02, M04 and M12 are in those rows' tables above.

### M59. Metering identity and normalization

| Case | File | Slice | Status |
|---|---|---|---|
| Four invocations with a reported, an estimated, an unknown and a measured-zero cost: one original row each, raw usage kept, cache reads apart from billable input, and the API's totals equal to the numbers stated in the fixture | `M59-metering-identity-and-normalization.test.mjs` | 4 | written |
| A dispatch refused before launch has no ledger row, and a project that launched nothing reports no dispatch, not zero | same | 4 | written |

Row closes in slice 4.

### M60. Partial usage and idempotent delta corrections

| Case | File | Slice | Status |
|---|---|---|---|
| Cumulative and delta observations of the same usage fold to the same original row | `M60-partial-usage-and-corrections.test.mjs` | 4 | written |
| Usage observed before the engine was killed survives with the rest marked unknown; a second recovery and a tick add nothing | same | 4 | written |
| A later correction is a delta row linked to the original, applied once however often it is sent, also after a restart; the fold gives the totals and settles what was uncertain | same | 4 | written |

Row closes in slice 4.

### M61. Budget boundaries and failed reads

| Case | File | Slice | Status |
|---|---|---|---|
| A run that passes its token limit is stopped at a usage observation, through cleanup, with what it observed kept; `retry` runs that work again and nothing that had completed | `M61-budget-boundaries-and-failed-reads.test.mjs` | 4 | written |
| Unknown cost is bounded by tokens: the run is stopped at the day limit and its cost stays unknown, not zero | same | 4 | written |
| The time limit and the repair limit | `M15-deadlines.test.mjs`, `M11-repair-limits.test.mjs` | 2 | written (in slice 2, where they were built; not repeated) |
| Store error in a budget read: nothing is dispatched, although an earlier check had succeeded | `M61-budget-boundaries-and-failed-reads.test.mjs` | 4 | written |
| Store error in the lease read before a spawn: no role is launched; the work is repaired afterwards | same | 4 | written |
| Store error writing a journal intent: no git effect and no launch | same | 4 | written |
| Store error in a gate transaction | `M44-stage-gate-versus-alpha-authorization.test.mjs` (second case) | 5 | written |
| Store error in a decision transaction | `M56-dedupe-consumption-and-combined-plans.test.mjs` (third case) | 5 | written |
| Resolving a budget refusal does not make a check pass | — | 5 | not written (slice 5): answering a budget blocker runs the work again and has no path to a check state except through what a role then says, which row M39 pins converts nothing |
| A role's result whose recording keeps failing: the run ends failed with the cause stated, the result is still in the transcript, the work is repaired (the second slice-2 review's obligation; E27, E30 item 9) | `M61-budget-boundaries-and-failed-reads.test.mjs` | 4 | written |

### M62. Accounting survives source-history changes

| Case | File | Slice | Status |
|---|---|---|---|
| Ledger rows, totals, records and the budget refusal are the same after developer branch switches, a rebase, a squash, a linked worktree, a restart, and a moved and rebound repository; a correction sent again is not applied again; no runtime ledger in a tracked tree | `M62-accounting-survives-source-history-changes.test.mjs` | 4 | written |
| Out-of-band changes block gates without hiding accounting | `M40-durable-evidence-invalidation.test.mjs` (first case) | 5 | written |

### M63. Durable record and chunk publication

| Case | File | Slice | Status |
|---|---|---|---|
| Long output is retained chunk by chunk and published whole when the role has ended | `M63-durable-record-and-chunk-publication.test.mjs` | 4 | written |
| The engine is killed before the stream is registered | same | 4 | written |
| ... after a durable chunk | same | 4 | written |
| ... before the final rename | same | 4 | written |
| ... after publication, before anything refers to the record | same | 4 | written |
| Output beyond the cap is not retained, and the incomplete transcript is not published (the slice-2 review's obligation, E25) | same | 4 | written |
| A pre-publication stream is never gate evidence | — | 5 | not written (slice 5): no route can make a check result name an unpublished stream (the check-result fixture publishes its output whole); only a directly inserted row could, and that would test the test. Slice 4 pins that no run names an unpublished stream and that the API does not serve one. |

### M64. Streaming redaction and a later detector

| Case | File | Slice | Status |
|---|---|---|---|
| A secret split between two writes of the role, and across the boundary of a stored chunk, is in no file under the engine home and in nothing the API returns | `M64-streaming-redaction-and-later-detector.test.mjs` | 4 | written |
| A secret with multibyte characters, the role's write ending inside one of them | same | 4 | written |
| A detector registered later marks the stored record it matches as a hit, which is then no longer served; other records are untouched | same | 4 | written |
| The later hit creates a Critical project finding and quarantines dependent evidence; a gate that was satisfied cannot go on using it | `M40-durable-evidence-invalidation.test.mjs` (second case) | 5 | written |
| Known secrets do not reach the event stream or the output tail | — | 6 | deferred → 6: neither stream is built before slice 6. The store, which those streams read from, is covered now. |

### M65. Retention and corrupt evidence

| Case | File | Slice | Status |
|---|---|---|---|
| A record nothing refers to expires and keeps its row without its content; a record of live work (a held item's run) is retained | `M65-retention-and-corrupt-evidence.test.mjs` | 4 | written |
| Referenced bytes removed while the engine was down are found by the recovery step, and the record is refused, not served empty | same | 4 | written |
| ... corrupted | same | 4 | written |
| Retention held by an open decision, a finding, a gate evaluation, a pending effect intent, a pending journal entry | `M40-durable-evidence-invalidation.test.mjs` (third case) | 5 | written for the evidence of a gate evaluation. For a finding, an open decision, a pending intent and a journal entry: not written (no M1 path gives one of them a record of its own to hold) |
| Missing, corrupt or quarantined evidence blocks the gates and effects that depend on it (`EVIDENCE_MISSING`) | `M40-durable-evidence-invalidation.test.mjs` (second and fourth cases) | 5 | written for quarantined and for missing evidence at a gate; corrupt bytes are the same read as missing ones (slice 4) |

### M66. Complete backup and restore

| Case | File | Slice | Status |
|---|---|---|---|
| A complete backup, restored into a fresh home with the repository bound, after a garbage collection: accounting, records and commits are back and the engine reaches full mode | `M66-backup-and-restore.test.mjs` | 4 | written |
| A backup with a member omitted is refused | same | 4 | written |
| A backup with a member altered is refused | same | 4 | written |
| A database-only copy is labeled insufficient for recovery and refused as one | same | 4 | written |

Row closes in slice 4.

### M67. Power-loss durability, separate from SIGKILL

The V resource is an unprivileged shim (E31 item 5; `harness/SEAM.md` §60 says what it models and what it does not).

| Case | File | Slice | Status |
|---|---|---|---|
| The shim: a SQLite transaction committed under `synchronous=FULL` survives a cut | `M67-power-loss-shim-is-faithful.test.mjs` | 4 | written; passes today |
| The shim: a transaction committed without a sync does not, and the synced one before it does | same | 4 | written; passes today |
| The shim: a commit and a branch git wrote with `core.fsync=all` survive | same | 4 | written; passes today |
| The shim: a commit and a branch git wrote with `core.fsync=none` do not | same | 4 | written; passes today |
| The shim: git started with a constructed environment by a process under the shim is under the shim | same | 4 | written; passes today |
| Power cut after an intent commit: the intent is there on restart, its effect is not, and the work goes on | `M67-power-loss-durability.test.mjs` | 4 | written |
| Power cut after a record publication: the published record is whole and is served | same | 4 | written |
| Power cut after an effect was applied and before its receipt: recovery finds what git holds and the integration is made exactly once | same | 4 | written |

Row closes in slice 4. The process-kill results it is reported apart from are rows M18 and M33.

## Slice-5 rows (M35 to M58, and the cases earlier rows left for slice 5)

One file per row. A row's cases are the Plan's own: its named case set where it names one, and for the decision rows M45 to M55 the set the paragraph that opens Plan §3.5 gives (a positive answer; a changed dependency under which the action remains eligible; for an effect-producing option, a change after the answer and before the effect). The cases of M38, M39 and M41 are separately reported readings of one fixture each. Every file is listed under slice 5 and none has been run.

### M35. The separate governed policy file

| Case | File | Slice | Status |
|---|---|---|---|
| An ordinary budget setting is committed to `.surety/policy.json` and leaves the protected fingerprint and the effective version as they were; the fingerprint is the test's own computation over the protected roots | `M35-separate-governed-policy-file.test.mjs` | 5 | written |
| A human edit of a governed field becomes a protected proposal and is not applied (2 cases: `check_commands`, `required_checks`) | same | 5 | written |
| A roots change that would take the governed file out of protection is itself a protected change, judged by the authorized roots; while it is unapproved the authorized roots stay in force | same | 5 | written |
| A protected set that no authorized version covers blocks the gates of a candidate that holds it (an adopted out-of-band commit) | same | 5 | written |

### M36. Capturing a protected-only proposal

| Case | File | Slice | Status |
|---|---|---|---|
| A Verifier's protected-only diff: a proposal is captured, no commit follows, the run ends completed (also the first dispatched `check_correction`, row M09) | `M36-capture-protected-only-proposal.test.mjs` | 5 | written |
| A Verifier's protected-and-source diff: rejected whole | same | 5 | written |
| Another role's protected diff (a Reviewer's): rejected whole | same | 5 | written |
| A Verifier that changes only source, and a Reviewer that writes a file of its own, are rejected whole (the role prohibitions slice 3 left for this slice; rows M20, M36) | same | 5 | written |

### M37. Applying an approved protected proposal

| Case | File | Slice | Status |
|---|---|---|---|
| Authorized by a Reviewer: one protected commit, one new effective version, the old evidence invalidated and stale under the new version, the old candidate unchanged, the next nomination under the new version; an unapproved proposal is not applied; the classification is labelled a fixture | `M37-apply-approved-protected-proposal.test.mjs` | 5 | written |
| Killed before the application: the intended version is recorded, unauthorized, with no git effect; recovery applies once | same | 5 | written |
| Git has applied and the finalizer has not run: gates are blocked (`GIT_JOURNAL_PENDING`); killed there, recovery finalizes once and invalidates the old evidence | same | 5 | written |
| The human-approved tightening, loosening and unclassifiable paths through a normal application | `M53-…`, `M54-…`, `M55-…` (their positive cases) | 5 | written there, with the same judgement (`assertApplied`); not repeated here |

### M38. Delivery and stage scope

| Case | File | Slice | Status |
|---|---|---|---|
| Zero implementing stages: not started, also when every stage is integrated | `M38-delivery-and-stage-scope.test.mjs` | 5 | written |
| None integrated: not started | same | 5 | written |
| Some integrated: partial, not delivered | same | 5 | written |
| All integrated at an ancestor: delivered | same | 5 | written |
| A stage integrated at a revision that is not an ancestor of the candidate delivers nothing to it | same | 5 | written |
| An empty required set, and a delivered requirement with no required check, leave the scope incomplete | same | 5 | written |
| A stage's scope binds that stage's obligations and not another stage's | same | 5 | written |
| The Alpha scope is the delivered requirements plus the release floor; nothing unfinished is in it | same | 5 | written |
| "Uncertain" coverage | — | — | not written (slice 5): the sources name no condition that makes coverage uncertain rather than missing or empty |

### M39. The five check states and precedence

| Case | File | Slice | Status |
|---|---|---|---|
| Missing: no execution recorded | `M39-five-check-states-and-precedence.test.mjs` | 5 | written |
| Stale: only executions bound to another source revision, runner class, environment or artifact | same | 5 | written |
| Stale: only executions bound to another protected version | `M37-apply-approved-protected-proposal.test.mjs` (first case) | 5 | written there: it needs a second version |
| Skipped: not executed, whatever exit status came with it | `M39-…` | 5 | written |
| Failed: a signal, a deadline, a null exit status, a nonzero one | same | 5 | written |
| Passed: established, zero exit, no signal or deadline, bound as the scope is | same | 5 | written |
| An earlier pass followed by a later matching failure is failed, though the pass has the later timestamp | same | 5 | written |
| A role's claim converts nothing; only passed satisfies the gate | same | 5 | written |
| An approval or a budget converts nothing | — | — | not written (slice 5): no approval in M1 has a path to a check state (row M51 asserts that a severity approval changes none); the budget half is row M61's, above |

### M40. Durable evidence invalidation

| Case | File | Slice | Status |
|---|---|---|---|
| A pass invalidated by an adopted out-of-band change, its bindings unchanged, is not selected again before or after a restart; evaluation staleness is a separate durable fact; a new execution satisfies the gate. While the observation is unreconciled the gate is blocked and the ledger is read as before (rows M24, M62) | `M40-durable-evidence-invalidation.test.mjs` | 5 | written |
| Invalidation by a protected change | `M37-apply-approved-protected-proposal.test.mjs` | 5 | written there |
| A secret found later in an evidence record raises a Critical project finding and takes the evidence from a gate that was satisfied (row M64) | `M40-…` | 5 | written |
| Evidence a gate evaluation refers to is retained past the retention period; an unreferenced record expires (row M65) | same | 5 | written |
| Evidence whose bytes are gone is reported missing by the gate, not read as empty (row M65) | same | 5 | written |

### M41. Typed evidence reuse

| Case | File | Slice | Status |
|---|---|---|---|
| Without a reuse entry an earlier candidate's result is not the later candidate's; the earlier candidate keeps its evidence as it was (the evidence half of row M27) | `M41-typed-evidence-reuse.test.mjs` | 5 | written |
| An assessed entry that names the result lets it count, and removes nothing from the required set | same | 5 | written |
| A reused result bound to another runner class or another environment does not pass | same | 5 | written |
| An entry that is not assessed, one that offers a generic record, one that offers no result (a waiver) leave the check unsatisfied | same | 5 | written |
| A reused result bound to another protected version | — | — | not written (slice 5): it needs a protected application between the two candidates, and the binding is the one row M37 already shows to be `stale` |

### M42. Findings, dispositions and inherited applicability

| Case | File | Slice | Status |
|---|---|---|---|
| An unresolved finding stays in the query through a planned fix and across two successor lineages; a fix that is only planned resolves nothing | `M42-findings-dispositions-and-inherited-applicability.test.mjs` | 5 | written |
| A deferral holds while its authority matches the current severity and its target has not passed; each evaluation re-evaluates it; raised severity makes it unauthorized; a passed target makes it expired | same | 5 | written |
| The human owner's accept of a Medium finding satisfies the gate | same | 5 | written |
| A fix is resolved by a verification on the candidate that holds it; a resolution whose verification is invalidated reopens the finding | same | 5 | written |
| An exclusion that is proposed, and then assessed, excludes nothing before its required approval | same | 5 | written |

### M43. Severity, tier and independence floors

| Case | File | Slice | Status |
|---|---|---|---|
| T1, T2, T3 (3 cases): the required set is cumulative, and every sign-off the tier names is needed, bound to the revision and the content reviewed (T2 the Reviewer's at candidate scope; T3 also per module and the security review) | `M43-severity-tier-and-independence-floors.test.mjs` | 5 | written |
| At Alpha: Critical blocks; High blocks without its exception and in a sensitive area with it; the exception waives no check; a role's verdict decides nothing | same | 5 | written |
| Who may lower a severity | `M51-severity-lower-manifest.test.mjs` | 5 | written there |
| A module's tier override; the sensitivity floor's own checks | — | — | not written (slice 5): the row's required result does not name them, and what a sensitive area requires is D3's |

### M44. Stage gate versus Alpha authorization

| Case | File | Slice | Status |
|---|---|---|---|
| A stage's work is complete only when its stage gate is satisfied, not when its candidate's verification completes; the engine evaluates the gate itself; a satisfied stage gate issues no authority (E30 item 16 ends; row M09) | `M44-stage-gate-versus-alpha-authorization.test.mjs` | 5 | written |
| A satisfied Alpha evaluation issues the one proposed authorization it was made for; repeating it issues nothing more; a failed evaluation transaction issues nothing (row M61); nothing is deployed | same | 5 | written |
| A restart between proposal and issuance | same | 5 | written |
| Another target set is another proposal, whose issuance supersedes the first; a successor candidate has neither the authorization nor the sign-off | same | 5 | written |
| Every other gate kind is refused before any effect (row M08) | same | 5 | written |

### M45 to M55. One manifest per enabled decision kind

| Row, kind | Positive answer | Changed dependency, action still eligible | Change after the answer, before the effect | File |
|---|---|---|---|---|
| M45 `blocker` | `retry` resumes the bound continuation only | the cause changes while the work stays parked | not an effect-producing option | `M45-blocker-manifest.test.mjs` (3 cases; the third: a quarantine that clears by observation) |
| M46 `out_of_band_change` | `stash` of a checkout, through the journal | the file is edited again (checkout); the branch is moved again (ref) | the file is edited again | `M46-out-of-band-change-manifest.test.mjs` (4 cases) |
| M47 `stop_confirm` | a preview taken while `claimed` confirms the `executing` run (E25 item 4) | the run's work is integrated between preview and confirmation | Stop records no effect intent | `M47-stop-confirm-manifest.test.mjs` (3 cases; the third: Stop and Abandon of a quarantined run are `quarantined`) |
| M48 `abandon_confirm` | nothing is discarded before termination is observed; the work's fate is the previewed one | the run's commit is integrated between preview and confirmation | Abandon records no effect intent; its removal's own probe is row M32 | `M48-abandon-confirm-manifest.test.mjs` (2 cases) |
| M49 `policy_widening` | raising the chain limit; with a limit of two the second role runs unasked and the third waits (row M12) | the base changes, the proposed change stays the same | the base changes | `M49-policy-widening-manifest.test.mjs` (4 cases; the fourth: a widening cannot carry a governed edit) |
| M50 `finding_disposition` | the human approves a Medium finding's deferral | the deferral is proposed again with another target | not an effect-producing option | `M50-finding-disposition-manifest.test.mjs` (3 cases; the third: an expired deferral cannot be approved) |
| M51 `severity_lower` | High to Medium on the human's approval; no check state changes | the finding's sensitivity changes | not an effect-producing option | `M51-severity-lower-manifest.test.mjs` (3 cases; the first: a Reviewer lowers Medium to Low alone) |
| M52 `finding_applicability_exclusion` | the human's approval excludes the finding for the assessed candidate and no other | the finding is raised to Critical | not an effect-producing option | `M52-finding-applicability-exclusion-manifest.test.mjs` (2 cases) |
| M53 `check_correction_tightening` | the human approves; separately, a Reviewer approves | the integration branch moves | the policy changes | `M53-check-correction-tightening-manifest.test.mjs` (5 cases; the fifth: a Verifier approves nothing, and an unclassifiable correction cannot take this path) |
| M54 `check_correction_loosening` | only the human approves | the source moves | the integration branch is moved by hand | `M54-check-correction-loosening-manifest.test.mjs` (4 cases; the fourth: a required-set change also needs the scope authority) |
| M55 `check_correction_unclassifiable` | routed to the human; the approval waives no check and applies no later diff | the classification is replaced | the evidence is replaced | `M55-check-correction-unclassifiable-manifest.test.mjs` (3 cases) |

All written, slice 5. Not written for these rows, each because the Plan's case set for a kind is one changed dependency and not every one the row lists: the other dependencies each row names (a blocker's evidence and continuation; a finding's status, evidence and scope; a proposal's tree and approved spec; ancestry for an exclusion). `adopt` of a checkout observation, and every `reject` answer, are not exercised.

### M56. Dedupe, consumption and combined plans

| Case | File | Slice | Status |
|---|---|---|---|
| The same question with its content in another order is the same decision with the same preview, before and after a restart | `M56-dedupe-consumption-and-combined-plans.test.mjs` | 5 | written |
| Questions about different subjects are different decisions | same | 5 | written |
| A failed consuming transaction consumes nothing (row M61); the answer consumes once, with one approval, one effect and no role launched; the same answer again is `decision_consumed` | same | 5 | written |
| Killed after the consumption and before the effect (a lost response): consumed durably, the effect made once after the restart | same | 5 | written |
| A batch of compatible answers is consumed together | same | 5 | written |
| A batch of conflicting answers consumes none; consumed and invalidated are refused with different codes | same | 5 | written |
| The same question raised again after consumption with no material change returns the consumed row | — | — | not written (slice 5): every M1 route that raises on request (Stop, Abandon, a widening) changes its subject when it is consumed, so the question cannot be put again unchanged |

### M57. Own consumption versus external preconditions

| Case | File | Slice | Status |
|---|---|---|---|
| The consumption changes a status the decision was bound to and the effect still runs; the intent binds the state after its own consumption; what is performed is what the plan said, actor and resources included | `M57-own-consumption-versus-external-preconditions.test.mjs` | 5 | written |
| An unrelated policy change between consumption and dispatch invalidates the effect; nothing is applied and the approval is not transferred | same | 5 | written |
| A separate ref change and a separate authorization change before dispatch | `M54-…` (third case) for a ref | 5 | the ref change is written there; an authorization change is not written (slice 5): no M1 effect consumes an authorization |

### M58. Aging and notification ambiguity

| Case | File | Slice | Status |
|---|---|---|---|
| Past its target the decision is escalated once and its notification delivered once, however much more time passes | `M58-aging-and-notification-ambiguity.test.mjs` | 5 | written |
| Killed before the delivery: after the restart the engine asks the sink, finds nothing, and delivers once | same | 5 | written |
| Killed after the delivery and before its receipt: it asks the sink, finds the delivery, and does not send again | same | 5 | written |
| The sink cannot confirm and cannot be asked: the intent is `unknown` and is not sent again | same | 5 | written |
| A delivery the sink refuses (`failed`) | — | — | not written (slice 5): the row's required result is about ambiguity; what follows a plain failure (a retry, a limit) is not in the sources |

## Slice-7 row (M01)

One file and one journey, at tier T2. The journey is made once, in a `before` hook, and each case reads one clause of the row's required result from it, as the cases of rows M38, M39 and M41 read one fixture; if the journey cannot be made, every case fails. Every step is one an earlier row pins by itself. Fixtures are used for what the Plan says enters as a fixture (the approved baseline and plan, the declared check, its execution, the Alpha test target) and for one thing more, the review's work item (below). The project is created through `POST /v1/projects`; the gates and the authorization go through their public routes. The file is listed under slice 7 and has not been run.

### M01. Bootstrap and the minimum successful kernel journey

| Case | File | Slice | Status |
|---|---|---|---|
| Runtime data stays outside tracked source: all the journey added to the integration branch is the project's identity file and the Builder's edit, and the developer's checkout holds exactly what it held before the project existed | `M01-kernel-journey.test.mjs` | 7 | written |
| The engine commits the permitted output of the Builder: one commit, the tree of what the role left, on the base it ran on, and the integration branch is still at it when the journey ends | same | 7 | written |
| The engine registers the work that follows the build and nominates once: one candidate and one nomination ref at the Builder's commit, and the candidate's verification work, registered by the nomination and not labelled a fixture | same | 7 | written |
| The stage gate is satisfied by the observed execution of its check, and not before it: built, verified and signed off, it is unsatisfied for the missing execution alone; with the execution recorded it is satisfied and the stage's work is complete; the sign-off is the Reviewer's, from a run of its own | same | 7 | written |
| The Alpha-authorization gate is satisfied from the same evidence and issues the one authorization that was proposed for the test target | same | 7 | written |
| The candidate remains Developing, and no deployment or publication is attempted: no candidate advanced, no deploy, publish, rollback or teardown operation, and the three roles are the only processes launched | same | 7 | written |
| The API and the event history agree with the durable rows: the run read and the gate commands' answers are the rows; each run's and each work item's events end where its row is; every journal event of every git operation is in the log; one project created and registered, one authorization issued | same | 7 | written |
| The event history read over HTTP (`GET /v1/events`), and a read of the candidate, its gates or the project's work (D1 §11.3) | — | — | not written (slice 7): `harness/SEAM.md` has none of these routes. They belong to slice 6 (rows M70 and M72), which was not verified when the journey was written |

Row closes in slice 7.

**How the row's words were read.**

- *"Registers work."* The plan is a fixture, as the row's setup says, so the work the engine itself registers in this journey is the candidate's verification, at the nomination (D1 §7.7). A committed plan that registers its stages (D1 §7.8) is row M26 and is not repeated here: it would need an Architect's run, which the row does not have.
- *"Independent verification/review as required by the tier."* T2 requires the Reviewer's sign-off at candidate scope (`harness/SEAM.md` §70). The Verifier and the Reviewer each run once, as runs of their own. The Verifier's run changes nothing and reports nothing: no gate input comes from it in M1. Its completion is what makes the engine evaluate the stage gate by itself, which the journey does not rely on.
- *"From observed fixture evidence."* The stage gate is evaluated twice: with everything in place but the check's execution, and again with it. Only the second is satisfied.
- *"API and event history agree with durable rows."* The event history is the store's `events` table; the API is the run read and the answers of the gate and authorization commands. See the last line of the table.

**What the journey needed and the seam lacks.** Nothing was added to the seam. Two things are recorded for the owner:

| What | Why it matters |
|---|---|
| Nothing in M1 creates `review` work. The Reviewer's run that T2 requires is made with the trigger fixture, as in rows M43 and M44. | The row lists what enters as a fixture, and review work is not on the list. In the journey a tier's required review happens only because the test schedules it. Who schedules it outside a test is not in the sources: a design decision. |
| No public read of the event history, of a candidate or of a gate evaluation is in the seam. | The row's last clause is pinned against the store and three routes. Once slice 6 fixes the event stream and the scoped reads, one read of each can be added to the journey's last case. That is a Verifier's change to this file, after slice 6 is verified. |

**Not run.** `node --check` and a resolution of every imported name against the harness are all that stand behind the file. Three orderings in it have no earlier test (`harness/SEAM.md` §86): fixtures applied to a project created through the API, checks declared before a candidate exists, and a sign-off recorded before the check's execution. A defect in the test will show when slice 5 is built and goes through the objection procedure.

## Obligations recorded by the slice-5 session

**Existing tests whose assertions slice 5 makes wrong.** This session changed none of them. Each must be changed by a Verifier before `node scripts/run-tests.mjs acceptance --slice 5` can pass, and none of the changes can be made before slice 5 is built, because the current assertions are right for the engine as slices 3 and 4 build it.

| File, case | What it asserts now | What slice 5 makes true | The change |
|---|---|---|---|
| `M09-after-integrated.test.mjs`: "a stage_build item runs its whole path"; "a verification that fails completes nothing"; "a fix item runs its whole path" (its last assertion, about the stage); "work integrated after a nomination is not held by that candidate" (its assertion that the stage's work is complete) | The Builder's stage work is `complete` when its candidate's `verification` item completes (E30 item 16) | It stays `verifying` until its `stage` gate is satisfied (`harness/SEAM.md` §70). These fixtures declare no check, so their gates are never satisfied | Assert `verifying` where `complete` is asserted for a `stage_build` item, and leave completion to `M44-…`'s first case; or give each fixture a required check, a passing execution and, at T2, a Reviewer's sign-off. The `fix` item's completion is unchanged |
| `M12-chain-of-roles.test.mjs`: first case, `workItem(built).status === 'complete'` after the verification completes | the same | the same | the same |
| `M13-stop-during-integration.test.mjs`: last case, the two final assertions | the same | the same | the same |
| `M16-quarantine.test.mjs`: "a role that completes and exits, leaving a descendant with its output open …" and "a role that sends a valid result, closes its stdout and exits 0 later …" | A `verification` run that wrote `report.txt` ends `completed` | A Verifier may change only the protected set: the run is rejected, `failed` / `diff_violation` (§68) | Drop the `step.write('report.txt', …)` step and the two assertions that the file exists. The first case of the file writes the same file in a run that is quarantined and never snapshotted; it is unaffected, and may drop the write too |
| `M31-worktree-add-symlinked-home.test.mjs` | The default script writes `report.txt` in a `verification` run and in a `review` run, and both complete | Both are rejected | Drop the write and the assertion that the file exists |
| `M31-workspace-path-symlink.test.mjs` | The repaired run of a `verification` item writes `written-by-the-second-run.txt` and completes | That run is rejected and repaired once more | Make the item a `fix` (its work then ends `integrated`, not `complete`), or drop the write |

**Cases not written, by decision of this session** (each is also in its row's table):

| Row | Case | Why |
|---|---|---|
| M08 | Reserved decision kinds have no effect | Nothing can raise one. |
| M09, M13, M14 | An engine-raised `awaiting_decision`; Stop and Abandon from it | M1 has no engine path into `awaiting_decision`. |
| M11 | Findings in the progress key; a typed conflict routed to a decision | Findings come from Verifier and Reviewer runs, which are not repaired on what they find; the conflict route is not built and not specified for M1. |
| M21 | A continuation implies no gate success | A gate is evaluated for a candidate; a checkpoint has none. |
| M24 | A nomination ref's observation blocks its candidate's gates | The rule the tests fix is per project and is pinned for the integration branch. |
| M25, M46 | `adopt` of a checkout observation | The row's required result does not name it. |
| M27, slice-3 review | The nomination finalizer takes the set of work it moves to `verifying` from inputs frozen with its intent (build spec §6 correction 14; the owner's provisional decision after the slice-3 review) | It is not one short case: it needs the integration held at one journal barrier and the nomination at another of the same kind, and a second item forced to `integrated` in between. Recorded for the Verifier of the slice that next touches nomination. |
| M28 | A rebased tree that fails validation against a protected set that moved | No cheap way to land a protected application between a run's base and its integration. |
| M41 | A reused result bound to another protected version | Needs a second version; M37 shows the binding stale. |
| M56 | A question raised again unchanged after consumption | No M1 route can put it. |
| M61 | Resolving a budget refusal makes no check pass | No path from a blocker's answer to a check state. |
| M63 | A pre-publication stream is never gate evidence | No route can reference one. |
| M65 | Retention held by a finding, an open decision, a pending intent or a journal entry | None of them holds a record of its own in M1's paths. |

**For the owner** (questions in the Verifier's report; each is a name or rule this session fixed where the sources were silent, `harness/SEAM.md` §84):

| Topic | What the tests fix | What is not pinned |
|---|---|---|
| The protected roots | A roots change is judged by the authorized roots | The protected set after an authorized roots change that leaves the governed file outside the roots. Recommended: the governed file is always protected. |
| What completes a `fix` | Unchanged: its candidate's verification | A `fix` has no stage and so no stage gate; it can complete with no evidence at all. |
| The stage gate's trigger | The engine evaluates it when the candidate's verification completes, and at ticks | — |
| High findings at a stage gate | — | Only the Alpha ladder of F §6.1 is tested. |
| The security review at T3 | A sign-off of scope `security` | D1 A.2's `SignOffScope` has no such value. |
| Who records the Alpha exception | A fixture | F §6.1 does not say who may. |
| What an adoption invalidates | At least the results of the candidate the open lineage started from | Other candidates' results. |
| How a fix is resolved | By an evaluation in which the check the finding names passes | A finding that names no check can only be deferred, accepted or excluded. |
| How a disposition, a lowering and an exclusion reach the human | A role proposes; the engine asks | A human who wants to accept or defer with no Reviewer proposal has no route. |
| An approval whose effect was invalidated | The proposal returns to awaiting approval | D1 A.5 has no such edge for a proposal. |
| What Stop and Abandon bind | The run, its workspace and what it holds, the fates | — |
| New public surface | `POST …/candidates/:c/gates/:kind`, `POST …/candidates/:c/authorizations`, 202 from the policy route for a governed edit | — |

## What the slice-5 session could not turn into a test

- **Anything, by running it.** No test of this slice was run. Three rows read one fixture each from a `before` hook; a defect in such a fixture fails every case of its row at once.
- **"Classification fixtures do not qualify D3"** (row M37) is a statement about what may be claimed, not a behaviour. The tests assert that the fixture's event is labelled `test_fixture`, and the files say what they do not qualify.
- **"Uncertain" coverage** (row M38) and a classifier's "replace evidence" beyond a quarantined rationale (row M55): the sources give no other condition to construct.
- **The Plan's "compares the complete consequence/plan binding"** is tested as: the manifest holds every key the contract names, the values the case is about are the rows' values, and the next generation's manifest differs in the dependency that changed. The tests do not recompute a preview hash: its encoding is the engine's.
- **That a consumed effect is made exactly once across every crash point.** One kill between consumption and effect is tested (row M56) and two inside a protected application (row M37); the journal's own crash matrix is slice 3's.
- **The notification intent's `notify` operation and its attempts** (D1 §2.5): the tests read the intent's status and the sink's own log, not the operation rows.

## Obligations recorded by the slice-4 session

| Slice | Row (suggested home) | Obligation | Why it is recorded |
|---|---|---|---|
| 5 | M61 | **Done in slice 5, except the budget half** (`M44-…` second case, `M56-…` third case; the budget half is not written, see the slice-5 obligations). Store errors in gate and decision transactions; resolving a budget refusal makes no check pass. | No gate, no check state and no decision manifest before slice 5. |
| 5 | M62 | **Done in slice 5** (`M40-…`, first case). An out-of-band change blocks gates and does not hide the ledger. | No gate before slice 5. |
| 5 | M63, M64, M65 | **Done in slice 5 in part** (`M40-…`: the Critical finding and quarantined evidence, retention held by a gate's evidence, missing evidence; the rest is not written, see the slice-5 obligations). A pre-publication stream is never gate evidence; a later detector hit raises a Critical project finding and quarantines dependent evidence and gates; retention held by a decision, finding, gate, effect intent or journal entry; `EVIDENCE_MISSING` on dependent gates. | Findings, gates and decisions with evidence arrive in slice 5. Slice 4 pins the record's own state in each case (`published`, `post_scan`, `path`, the read's refusal). |
| 5 | M27 | **Done in slice 5** (`M41-…`, first case). "Source changes after nomination retain the old candidate/evidence": the evidence half. Recorded for slice 4 by the second slice-3 session; still nothing binds a record to a candidate before check results exist. | So that it is not looked for here. |
| 6 | M64, M72 | Known secrets do not reach the event stream or a run's output tail. | Neither stream exists before slice 6. |
| 6 | M71 | The memory an engine uses for a role's output is not measured. Slice 4 pins what is retained (at most 8 MiB, and then no published transcript), not what is buffered. | A resident-memory bound needs the load row's fixtures and a threshold measured on a built engine. |
| owner | M67 (open item, no row) | D1 §6.1: the engine refuses to start on storage that does not honour sync. Not built, not tested. The Verifier's recommendation is in the slice-4 report: that a device honours a sync cannot be observed from a process without cutting power, so a startup check can only be a check of the filesystem's type. Until the owner decides, it is an open item, and the M1 report must say that M67 passing says nothing about the host's storage. | E23 item 6 deferred it to this slice. |
| owner | M67 | The power-loss model: names durable at once, unsynced data lost whole. A stricter model (a rename lost unless its directory was synced) would make every git write non-durable, since git syncs no directory. | The model decides what M67 can catch; `harness/SEAM.md` §60 lists what it cannot. |
| owner | M61, M12 | Budget semantics the tests fix: a budget stop parks the work behind a blocker with `retry` and `cancel`; an over-budget project's eligible work is left eligible; whether an estimate counts as verified cost is left unpinned. | Provisional choices, on the same footing as E24 to E30. |
| owner | M63 | A stream cut by a crash, or over the output cap, is never published, so such a run has no transcript the API serves; its retained chunks stay on disk. Serving partial output with a mark would need a column D1 A.3 does not have. | A consequence the owner should see before a real backend's transcripts matter. |
| owner | M62, M66 | `POST /v1/projects/:p/rebind`, the `surety store` commands' flags, exit status 7 and the manifest are names D1 does not have. | New public surface. |
| report | M66 | What a restored engine does about workspaces is not pinned: they are not part of a backup. The test leaves the old home in place, so the workspaces its rows name still exist. | So that a pass is not read as "workspaces are restored". |
| report | M62 | After a repository is moved and rebound, the test asserts accounting, records and the budget refusal. It does not assert that the engine's retained workspaces, which are linked worktrees of the moved repository, are usable again. | The row is about accounting. |

## What the slice-4 session could not turn into a test

- **That a filesystem honours sync.** Row M67's shim models what a sync promises; it cannot show that the host keeps the promise.
- **Loss of names.** The shim keeps every rename, creation and removal. D1 §14.1's directory sync after a record's rename is therefore not pinned.
- **The engine-under-shim cases, the crash cases and everything else that needs slice 4** could not be run. They were read, their imports and names were resolved, and they will be judged by the build.
- **`raw_usage` for an invocation with several observations**, and what the ledger read answers at exactly a budget's limit: left unpinned rather than guessed.
- **The scheduler's daily backup, `backup_keep`, `surety store export` and `import`**: D1 §6.5 has them, no Plan row asks for them.

## Left for the second slice-3 session

Nothing: the second session wrote every case listed here by the first (the section above, and the rows of M04, M09, M12, M13, M14, M15, M24 and M31).

## Obligations recorded by the second slice-3 session

Cases this session did not write because they cannot pass before a later slice, and questions the tests answer one way for now.

| Slice | Row (suggested home) | Obligation | Why it is recorded |
|---|---|---|---|
| 5 | M09, with M38 and M44 | **Done in slice 5** (`M44-…`, first case). The slice-3 assertions named here were not changed and are listed, with the change each needs, under the slice-5 obligations. A stage's work is `complete` only when its `stage` gate is satisfied. Slice 3 completes the Builder's work when its candidate's `verification` item completes (`M09-after-integrated.test.mjs`, four cases; `M12-chain-of-roles.test.mjs`; `M13-stop-during-integration.test.mjs`, last case). Those assertions change when the gate exists. | Nothing computes a gate before slice 5, and the path of D1 A.5 has to end somewhere until then. |
| 5 | M12, with M49 | **Done in slice 5** (`M49-…`, first case). A limit above 1: with `max_chained_roles` raised, a chain runs unasked up to the limit and stops there. Raising it is a widening and takes the `policy_widening` route. | Slice 3 can only run the default; `PUT` of a higher value is not a valid plain change. |
| 5 | M24, M40, M44 | **Done in slice 5 for a pending operation and for an observation of the integration branch** (`M37-…` third case, `M40-…` first case); a nomination ref's observation is not written. A candidate whose lineage has a journal operation that is not finalized, or an unreconciled observation of its nomination ref, has its gates blocked (`GIT_JOURNAL_PENDING`, `OUT_OF_BAND_CHANGE`; D1 §9.3). | No gates before slice 5. Slice 3 pins the journal and the observation themselves. |
| 5 | M28, with M35 to M37 | **Not written in slice 5** (see the slice-5 obligations). A rebase whose result must be validated again and fails: the rebased tree touches a path the run may not change once the protected set at the head differs from the one at the run's base. | Slice 3 has no protected set that can move between base and head. |
| 5 (was 4) | M27, with M64 and M65 | **Done in slice 5** (`M41-…`, first case). "Source changes after nomination retain the old candidate/evidence": the evidence half. **Moved to slice 5 by the slice-4 session:** nothing binds a record to a candidate before check results exist. | No evidence record before slice 4. |
| 4 | M12 | **Done in slice 4** (`M12-over-budget-project.test.mjs`). Budgets: the over-budget project at the scheduling boundary. Unchanged from slice 2's deferral; nothing of it was reachable here. | Listed so that the slice-4 Verifier does not look for it in slice 3. |
| before M2 (owner) | M31, M15 | A `worktree_add` that recovery finds absent or half made is withdrawn, not retried, because its run is over. If held work were ever to resume in the run that was interrupted, this would change. | The same kind of question as E24 item 3 and E27's last question: how much a crash costs. |
| before M2 (owner) | M33, M29 | A run whose integration was completed by recovery ends `recovered` with its work `integrated`, not `held`. E24 item 3 reads "work whose run was recovered after a crash is held"; this is the one exception, taken because integrated work has nothing left to resume. | A departure from the letter of E24 item 3 that the owner should see. |
| report | M31 | What the engine does to find a dead incarnation's git children is not pinned; only that by full mode none is alive or the operation is blocked. The case covers `git worktree add`, the one git call that can be held before it writes; a surviving `update-ref` or `commit-tree` is not constructed. | A limit of the fixture, recorded so that it is not read as coverage of all four kinds. |

## What the second session could not turn into a test

- **A commit or a ref update left ambiguous by a deadline while the engine runs.** `holdGit` holds every git call on a repository, and an acceptance makes reads before it makes its commit and its swap; the first held call is then a read, which fails, and the write is never reached. The `ambiguous` journal state of those two kinds is reached the other way, by a restart whose probe can only find `unknown` (15 cases each). A deadline on a write is pinned for the two worktree kinds, which are the first git call of their step.
- **A third form of a partial worktree**: the directory with its link, and no metadata for it in the repository (`removeWorktreeMetadata` in `harness/repos.mjs` builds it, and the self-check runs it against real git). The contract table's `partial` covers it. The generated cases use the two forms the git commands themselves leave when they are cut short: `worktree add` writes the metadata and the link before the checkout (metadata and directory, nothing checked out), and `worktree remove` deletes the directory before the metadata (metadata without its directory). The third form needs someone to have pruned the metadata by hand; no case builds it.
- **Stop or Abandon of work that is `verifying`.** No run owns such work, so no command can reach those edges of the transition table; the last M13 case pins that. The edges stay in `contract/work-items.json` as the table's, exercised only by the slice-2 transition cases that force edges through the harness.
- **That the rebased tree is validated again** (row M28) is pinned by its result only: the rebased commit holds what it should and nothing else. No case makes a rebased tree fail (above, deferred to slice 5).
- **The cap on a git command's output** (`git_output_cap`), which the first session left for "a rebase's conflict listing in M28". The conflict case does not reach it: what the engine prints or reads while rebasing is its own choice, and a test cannot make an unknown command print 64 KiB. Still not written; the first git call with unbounded output that a test can aim at is a diff in slice 5.
- **Whether an observation of a moved nomination ref blocks dispatch of its project.** The first session pinned that for the integration branch and the repository; for a nomination ref the sources say only that it blocks the affected gates (slice 5). The M24 cases assert the observation and its one answer, not what is dispatched meanwhile.
- **How long a blocked operation may stay unexamined.** The cases require that the next tick's journal step probes it again. Nothing pins a bound on that step's own duration beyond `tick_step_budget`.

## Obligations recorded by the first slice-3 session

| Slice | Row (suggested home) | Obligation | Why it is recorded |
|---|---|---|---|
| 5 | M36 (with M20) | **Done in slice 5** (`M36-…`). The scripts named here were not changed; the slice-5 obligations list them, and one more (`M31-workspace-path-symlink.test.mjs`). Role prohibitions for the Verifier and the Reviewer. By F §4.1 a Verifier may not modify application source and a Reviewer may modify nothing; by D1 §7.3 a Verifier's protected-only diff becomes a proposal. Slice 3 pins validation for the Builder's and the Architect's kinds only, because four slice-2 cases have a verification role write `report.txt` and complete (`M16-quarantine.test.mjs`, three cases; `M31-worktree-add-symlinked-home.test.mjs`). When slice 5 pins the rule, those four scripts change with it (the role writes nothing, or writes under the protected root and the case moves to proposal capture). | A rule the sources state and no test pins yet, and four cases that would contradict it. The owner may prefer to pin the refusal in slice 3 and change the four cases now; see the Verifier's report. |
| 5 | M46 | **Done in slice 5** (`M46-…`), except `adopt` of a checkout. The answers to a checkout observation (`stash`, `adopt`), the dependency manifest of `out_of_band_change`, and the fresh comparison before the effect. Slice 3 pins the two answers for a ref without a manifest. | D1-11 needs `discard` and `adopt` for a ref to make row M24 meaningful; the rest is the decision slice's. |
| 5 | M24, M40 | **Done in slice 5** (`M40-…`, first case). That an out-of-band observation blocks the gates it affects, and that `adopt` invalidates the evaluations and results of the lineage. | No gates before slice 5. |
| 5 | M49 | **Done in slice 5** (`M49-…`): raising the chain limit or a budget. Whether raising another key widens is not pinned. Which policy changes widen authority. Slice 3's cases only lower limits; raising one must take the `policy_widening` route. | So that the slice-5 Verifier does not take "a valid change is answered 200" for the whole rule. |
| 3, second session | M26, M27 | **Done in slice 3, second session** (`harness/SEAM.md` §§41, 42). What `revisions.lineage` holds, the stage's status and `integrated_revision`, and what a committed phase plan under `.surety/phases/` must contain. The first session's cases write no plan and read no lineage. | Left open on purpose, so the finalizer rows fix them. |
| before M2 (owner) | M18 | Recovery records the snapshot tree of what a role left (D1-32). What a Resume does with it is not pinned: the new run starts from the branch, in a workspace of its own, as in slice 2. | A snapshot nobody uses yet; whether resumed work continues from it is a design question. |
| before M2 (owner) | M16, M21 | A run whose domain cannot be shown empty before its snapshot fails (`failed` / `infra_error`) and its work is repaired from the start. The alternative, snapshotting when the quarantine clears, would save the role's work and needs a run that leaves `finalizing`, which D1 A.5 does not have. | The strict reading costs paid work on a real backend, like the lease question of E27. |
| report | — | M1 does not keep a role inside its workspace and does not see what it writes outside the repository and the managed checkouts (E25 item 2). `M20`, "what a role wrote outside its workspace is in no commit", pins only that none of it is accepted. | A limit, recorded so it is not read as containment. |

## What this session could not turn into a test

- **The cap on a git command's output** (`git_output_cap`; row M20, "output/file limits are enforced"). No git call M1 makes can be made to print more than the smallest cap (64 KiB) by anything a test can arrange without also failing for another reason first: the engine's reads are of refs, worktree lists and trees it bounds itself. The file-side limits (the three snapshot caps) are written. Left for the row that first has a git call with unbounded output (a rebase's conflict listing in M28, or a diff in slice 5).
- **"Run integrity both during execution and at snapshot validation"** (row M19) is written for a permitted edit (ticks during the run observe nothing) and for every alteration at validation. That a tick *during* a run observes a registered ref the role moved is not asserted separately: the same run then ends with a ref violation and the observation is asserted after it.
- **E28's last minor defect**: "when the clock steps back between reading an expired lease and acting on it, a live run is wrongly marked as ending". The controlled clock only moves forward (`harness/SEAM.md` §18), and the host's own step back cannot be produced on demand, so no test can put a step between the engine's read and its action. The run-end fault matrix and `M15-decided-outcome-stands.test.mjs` pin what a run ends as once it is ending; they do not pin that this read is taken consistently. It belongs with the monotonic-clock question E27 item 8 puts in slice 6.
- **A hostile ambient variable the engine must honour.** None is: the hostile-environment case asserts effects (where commits, refs and worktrees went, which programs ran, which identities commits carry), not the content of each git child's environment, which only the engine can see.

## Obligations recorded after the second slice-2 review

What the second slice-2 review found, or the owner decided (E27), that no test pins yet. Each is work for the Verifier of the slice named. Except for the last row, the findings are recorded as the Reviewer reported them; this Verifier session did not run them again.

| Slice | Row (suggested home) | Obligation | Why it is recorded |
|---|---|---|---|
| 3 | M31 (worktree-add probe), with M14 | **Done in slice 3, first session** (`M31-workspace-path-symlink.test.mjs`; the consequence for an Abandon is no longer reachable, since no role is launched there). A workspace path that is itself a symbolic link should be refused. The Reviewer confirmed on the slice-2 engine that, with paths compared after their links are resolved (the fix for the symlinked engine home), a symbolic link planted at a new run's workspace path and pointing at another run's retained worktree makes a failed `worktree add` probe as present, and a later Abandon would remove the other run's worktree. It needs a process of the engine's user that knows the run id. To pin: a workspace path that is a symbolic link is refused. A case in which an Abandon must not remove a worktree that another `workspaces` row names would pin the consequence as well. | E27 carries it to slice 3: the probe's outcomes ("foreign or conflicting occupancy") are row M31's and are not yet split into cases. |
| 4 | M61 (store faults), with M63 | **Done in slice 4** (`M61-budget-boundaries-and-failed-reads.test.mjs`, last case; `harness/SEAM.md` §61; one failure is retried since E30 item 9). A transient store failure while recording a role's `result` drops the result with no retry: the run then ends as if no result had been sent. The store command queue's limit of 256 entries is one way to such a failure. What the engine must do instead (retry, or end the run with the failure visible) is for the slice-4 Verifier to settle with the owner; it must not be a silently missing result. | Reviewer's finding; E27 carries it. Faults in store transactions are slice 4's (row M61). |
| report; D2 | — (no M1 test) | A descendant's output inside the engine's short read window after the role exits is treated as the role's: a `result`, a `usage` line or a `heartbeat` that a descendant writes to the inherited stdout in that window is taken as sent by the role. This is a known limit of M1's scripted runs. The scripted protocol has no way to tell writers of one pipe apart, and M1 claims no isolation of a role from what it starts (E25 item 2). Real containment, and an output channel a descendant cannot write to, are D2's. The M1 acceptance report must say so. | A limit recorded so it is not mistaken for a guarantee: the unterminated-line and descendant cases show that the role's own last output is kept, not that nothing else can be injected. |
| before M2 (owner) | M15, M06, M18 | E27 ends with a question for the owner that these tests answer the strict way for now. (a) Should a run the engine is still supervising, with a live process, survive the expiry of its lease, the engine re-granting the lease after checking the process is alive? Today: expiry is final (`M15-lease-supervision.test.mjs`, "a lease past its expiry is not renewed …"), and a run ended for it is `recovered` with its work `held`. (b) Should held work resume by itself after a pause, or after a crash, instead of waiting for an explicit Resume (E24 item 3)? Today: `held` until Resume, after a startup recovery (M06, M18) and after a lease expiry (M15). The Reviewer measured the cost of the strict rule: an engine paused for 34 s against a 30 s lease ended all three runs in flight on resume, one of which had a valid result. If the owner changes either answer, the M15 lease cases and `contract/run-lifecycle.json` (`lease_expiry`, `work_after_run.recovered`) change with it. | So the next Verifier knows these rules are provisional and may change before M2, and does not build further cases on them without asking. |
| any (host) | every file that uses the controlled clock | The wall clock of the host these tests were written on steps back about 0.75 s every half minute. The engine's clock is the wall clock plus an offset, so a timestamp taken just after a clock advance can be earlier than the advance's `now`. A test that compares the two exactly fails now and then for no fault of the engine; allow two seconds, as the M15 lease cases do (`harness/SEAM.md` §23, "The host's clock"). Whether the engine should measure durations (grace periods, budgets, lease ages) on a monotonic clock is a question for the load and durability slices. | Found while verifying this pass: an existing case failed on the unchanged slice-2 engine in about one run in ten. |

## Obligations recorded after the slice-2 review

What the slice-2 review found, or the owner decided (E25), that no test pins yet. Each is work for the Verifier of the slice named. Except for the last row, the findings are recorded as the Reviewer reported them; this Verifier session did not run them again.

| Slice | Row (suggested home) | Obligation | Why it is recorded |
|---|---|---|---|
| 3, second session | M32, M33 (journal matrix, M29–M33) | **Done in slice 3, second session** (`M32-ambiguous-removal-then-crash.test.mjs`, two cases: with a crash, and with the engine still running). After a `worktree_remove` settles `ambiguous` and the engine crashes before the run finishes, recovery must complete and the engine must reach full mode. In the slice-2 engine a second removal intent for the same run collides on the operation's idempotency key, so recovery fails on every restart. | Confirmed by the Reviewer. The journal's probe and retry rules are slice 3's (build spec §6 correction 14); a slice-2 test would pin a retry rule before its row is written. |
| 3, second session | M31, M33 | **Done in slice 3, second session** (`M31-git-child-outlives-engine.test.mjs`). An engine killed during `git worktree add` leaves the git child running. Recovery can then probe `absent` while the child is still writing, and the worktree appears afterwards as one no row names. Recovery must account for a git child that outlived its engine before it trusts a probe. | Same review. Needs a barrier inside a git call, which slice 3's harness adds. |
| 3 | M23 | **Done in slice 3, first session** (`M23-no-repository-code-snapshot-commit.test.mjs`; the owner decided the filter question, E29 item 1). Extend `M23-engine-git-runs-no-repository-code.test.mjs` to commits, ref updates and snapshots, and decide with the owner how far "other repository-configured execution" reaches: filter drivers (`filter.*.clean`, `smudge`, `process`) run on checkout and on `git add`, so they are reachable from slice 3's snapshot; disabling them also disables Git LFS in a governed repository. | E25 item 3 states the rule generally and pins it now for the worktree calls only. |
| 5 | M47, M48 | **Done in slice 5** (`M47-…`, `M48-…`; `harness/SEAM.md` §80). What a Stop or Abandon confirmation binds: the run's identity, whether it can still be stopped, and the workspace's fate, not the difference between `claimed` and `executing` (E25 item 4). Until then the slice-2 behaviour stands: a confirmation raised while the run was `claimed` may be refused as stale once it is `executing`. | The owner settled the rule and put the test in slice 5, with the decision manifests. |
| 5 | M09 (`check_correction`), M35–M37 | **Done in slice 5** (`M36-…`, first two cases). `check_correction` is in the transition table and the slice-2 engine will dispatch one and complete it with no proposal captured. Only a fixture can create one today (`harness/SEAM.md` §12 says the slice-2 tests never dispatch it). The first slice-5 case for this kind must show that a `check_correction` run completes only through proposal capture. | A kind that completes without doing what it exists for must not be read as built. |
| 4, 6 | M63 (streamed output), M71 (load) | **The slice-4 part is done** (`M63-durable-record-and-chunk-publication.test.mjs`, last case: what is retained is capped; what is buffered is not measured, and stays with M71). The engine buffers a role's output without a cap. The scripted boundary scans every process on each observation, at least once a second while a run is ending, which costs time under load. | Reviewer's findings; E25 carries them to the records slice and the load row. |
| 5 (or the row that owns it) | M47, with M16 | **Done in slice 5** (`M47-…`, third case: `quarantined`, for Stop and for Abandon). A quarantined run answers Stop with `illegal_transition`. D1 A.7 has a public code `quarantined`, which no test uses yet. Decide which code a Stop or Abandon of a quarantined run answers with, and pin it where the Stop manifest is written. | The slice-2 tests pin `illegal_transition` only for a run that has ended. |
| report | — | E25 item 2: M1 roles run without control-plane isolation. A scripted role runs as the engine's user, under the engine home, and can read the token file. Nothing in M1 is evidence for D1 §17 item 12. The M1 acceptance report must say so. | An accepted limit must not be read as a passed requirement. |
| D2 (no M1 test) | — | The scripted `auto` boundary does not count a process whose `/proc/<pid>/environ` it cannot read, so it can report `terminated` while a marked process that made itself unreadable is alive. The Reviewer asked whether to pin `unknown` for that. The case was written and tried, and then withdrawn. It reproduces: a role that leaves a copy of `sleep` which may be executed and not read (the kernel marks such a process not dumpable) exits, and the slice-2 engine ends the run `completed` while that process lives. It is not pinned for four reasons. (1) "Unreadable means `unknown`" cannot be the rule: every exiting process and every zombie is unreadable for a moment (measured on this host: more than 750 failed reads while some 650 short-lived children came and went), the role itself at each run end, and two lasting processes of the same user are unreadable all the time (`systemd --user`, `(sd-pam)`). The first form of the rule made the stand-in engine quarantine at random in three files that had passed. (2) A rule that works has to tell a hiding process from a dying one by whether `/proc/<pid>/stat` still shows an address space, and has to bound membership by the recorded process group; it then still misses a descendant that leaves the group, and a domain whose ownership row was never completed. (3) The premise cannot be made as root, where every environment is readable, and the runner does not allow a skip. (4) `auto` is the Verifier's stand-in for the execution boundary. It qualifies no containment (Plan §2), and M1 claims no isolation of a role from the engine (E25 item 2). `harness/SEAM.md` §14 now says what `auto` does and states the limit. | A limit of a stand-in, recorded so it is not mistaken for containment, and so the next Verifier does not rediscover the trap. Membership that cannot be escaped is D2's to qualify (build spec §6 correction 1). |

## Obligations recorded after the slice-1 review

The owner's decisions on the slice-1 review (E23). Each is work for the Verifier of the slice named; none is written yet.

| Slice | Row (suggested home) | Obligation | Why it is recorded |
|---|---|---|---|
| 2 | M06 (with M18) | Startup `recovery` must be shown to do real work: a restart test with real state to recover (a run that has not ended, a domain that has not terminated), asserting that the recovery happened before full mode, not only that the step name is listed. **Done in slice 2:** `M06-restart-recovery.test.mjs`; row M18 covers every crash boundary. | Slice 1 has nothing to recover, so its `recovery` step completes without doing anything and the slice-1 test can only check the step order. |
| 3 | M24 or M25 (with M06) | **Done in slice 3, first session** (`M06-startup-integrity.test.mjs`). Startup `integrity` must be shown to do real work: a restart test in which a registered project's repository has an integrity violation, asserting it is detected before any dispatch. | Slice 1 builds no repository integrity; its `integrity` step establishes nothing about any repository. |
| 3 | M07 | **Done in slice 3, first session** (`M07-project-bootstrap-and-policy.test.mjs`). The effective policy of a project is the policy revision the engine has recorded; with none recorded it is the schema defaults, with `revision: null`. A `.surety/policy.json` committed in the repository but never recorded by the engine is not effective. Pin what project bootstrap does with a policy file that already exists, and that an unrecorded one is not reported as effective. | Slice 1 pins only the defaults and the refusals; where the effective policy comes from is decided by the git slice. |
| 4 | M67 (open item, no row covers it) | **Still open after slice 4; the Verifier's recommendation is in its report and under "Obligations recorded by the slice-4 session".** D1 §6.1 requires the engine to refuse to start on a filesystem that does not honour fsync. This is not built and no Plan row covers it. Decide, together with row M67's power-loss harness, whether a startup check is feasible. Until then it is an open item, not a passed requirement, and the M1 report must say so. | A requirement with no test and no build must not be read as met. |
| later | — | A lint for store writes outside `src/store/transitions/` must allow exactly `src/store/migrate.ts` (`harness/SEAM.md` §5). | Recorded so the exception is not rediscovered as a defect, or widened. |
| 6 | M69 | `100 Continue` must not be sent before the declared-length body-cap check. A request with no Host header should get the engine's refusal body, not the HTTP library's bare 400. Both are listed as cases in the M69 table above. | Found by the second slice-1 review; recorded when slice 2 was verified, without tests, because the body caps and parser-level refusals are slice 6's. |

## Rows not yet split into cases

| Row | Introduced in slice | Known straddles (build spec §9 and slice-1 deferrals) |
|---|---|---|
| M68 | 6 | Needs the browser driver (build spec §11) |
| M70–M73 | 6 | M71 needs numeric load limits (build spec §11) |
| M74 | 6 | Seam-confinement cases written in slice 1 (above); the rest → 6 |

Deferred cases that later slices must pick up, by slice:

- **Slice 3, second session:** written; nothing is left for slice 3.
- **Slice 4:** written, except M27's evidence half (moved to slice 5) and the fsync open item (the owner's; see "Obligations recorded by the slice-4 session").
- **Slice 5:** written (rows M35 to M58). Every case an earlier slice left for slice 5 is either written, in the row's file named in its table, or marked `not written (slice 5)` with its reason; "Obligations recorded by the slice-5 session" lists both, and the existing tests that must change when slice 5 is built.
- **Slice 6:** M64 (secrets in the event stream and the output tail); M71 (the memory used for a role's output); M69 (the rest of the boundary matrix, with the two cases the second slice-1 review found); M74 (fixture semantics and the invocation boundary); M71 (the cost of the boundary's process scan under load).
- **Slice 7:** written (row M01, above, under "Slice-7 row"). When slice 6 has fixed the event stream and the scoped reads, the journey's last case can read them.
