# Acceptance coverage

How one Verifier session hands over to the next (build spec §7). Every Plan row appears here. For each row a slice has worked on, every named case is listed with its file, the slice whose manifest lists that file, and whether it is written. A case deferred to a later slice is recorded when it is deferred, with the reason. Rows no slice has worked on yet are listed at row level with the slice that introduces them (build spec §9); that slice's Verifier splits them into cases.

**Status values:** `written` (a test exists and is listed in the manifest); `deferred → N` (not written; waits for slice N); `not started` (row not yet split).

Last updated: slice 3, first Verifier session, 2026-10-02. Slice 3 is written by two Verifier sessions in sequence. This one wrote, first, what the final slice-2 review carried forward (E28): the run-end fault matrix and five single cases, marked "(final review)" below, listed under slice 3 because they must first pass when slice 3 is built; and the audit of the existing tests for timing sensitivity (E29 item 2; `harness/SEAM.md` §24). Then rows M19 to M25 and the slice-3 cases of earlier rows that concern snapshots, validation, commits and integrity. Rows M26 to M34 and the cases listed under "Left for the second slice-3 session" are that session's. The paragraph that follows is the previous one.

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
| Distinct record identities (transcript, result) for two dispatched runs | — | 4 | deferred → 4: records are written by the durable record path of slice 4 |

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
| Chunk receipts cannot be updated or deleted | — | 4 | deferred → 4: the parent is the pre-publication stream identity of build spec §6 correction 21 (row M63), not yet fixed |
| The git journal state projection changes only with a new journal event | — | 3 | deferred → 3, second session: needs the journal's transition table (`contract/journal.json` holds only the ordinary course so far) |

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
| A change that widens authority raises `policy_widening` | — | 5 | deferred → 5: row M49 says which changes widen; slice 3 only lowers limits |
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
| Phase and completion gate evaluation is refused | — | 5 | deferred → 5: needs a candidate and the gate function (build spec §9) |
| Reserved decision kinds have no effect | — | 5 | deferred → 5: needs the decision queue |

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
| What follows `integrated`: `verifying` and `complete` for `stage_build` and `fix`, `complete` for `replan` and `assessment` | — | 3 | deferred → 3, second session: `verifying` needs a chain of roles (E24 item 1), and the plan and stage finalizers are row M26 |
| `check_correction` dispatched and completed | — | 5 | deferred → 5: needs a protected proposal |
| An engine-raised `awaiting_decision` answered through the queue restores its stored continuation | — | 5 | deferred → 5: slice 2 has no engine path into `awaiting_decision` (the first is a typed conflict finding); the stored-continuation rule itself is pinned at the table, above |

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
| Unchanged findings with new ids and timestamps: the findings part of the progress key | — | 5 | deferred → 5: needs findings |
| A requirement or contract conflict routes to a decision without another repair | — | 5 | deferred → 5: needs findings |

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
| A project that is over budget | — | 4 | deferred → 4: budgets |
| A project at `max_chained_roles`: chaining stops at the declared human boundary | — | 3 | deferred → 3, second session: in slice 2 no run's outcome creates further work, so there is no chain to stop (`harness/SEAM.md` §12). What a chain is needs the owner's answer first; see the slice-2 report |

### M13. Stop from every owning state

| Case | File | Slice | Status |
|---|---|---|---|
| Stop from `executing`, for each dispatched kind: the role is fenced, usage is kept, a late success changes nothing, the run ends stopped, the work is held, Resume starts a new linked run (6 cases) | `M13-stop.test.mjs` | 2 | written |
| Stop from `claimed`, for each dispatched kind: a run stopped before its role was spawned leaves no role running and holds the work (6 cases) | same | 2 | written |
| While the boundary still reports the domain running, the stopped run is not ended and the work is not held (the delayed acknowledgement) | same | 2 | written |
| Stop needs its confirmation, a stale confirmation does nothing, and a run is stopped only through its own project | same | 2 | written |
| Stop from `integrating`, `integrated`, `verifying`; with a journal operation in flight | — | 3 | deferred → 3, second session |
| Stop from `awaiting_decision` while a run still owns the work | — | 5 | deferred → 5: no engine path into it before slice 5; the edge is pinned at the table (M09) |

### M14. Abandon and durable dispatch hold

| Case | File | Slice | Status |
|---|---|---|---|
| Abandon from `executing`, for each dispatched kind: termination confirmed, workspace discarded, work back at its prior status under a dispatch hold, no repurchase until Resume (6 cases) | `M14-abandon.test.mjs` | 2 | written |
| Abandon from `claimed`, for each dispatched kind (6 cases) | same | 2 | written |
| While the boundary reports the domain running nothing is discarded, and no new trigger generation is dispatched onto the project; when termination is observed the abandon completes and the new generation runs | same | 2 | written |
| Resume of an eligible item on dispatch hold writes exactly one `work.resumed` event, in the transaction that clears the hold: with the event's write failing, the hold stays (review) | same | 2 | written |
| Abandon from `integrating`, `integrated`, `verifying`; with a journal operation in flight | — | 3 | deferred → 3, second session |
| Abandon from `awaiting_decision` while a run still owns the work | — | 5 | deferred → 5 |

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
| How an operation made ambiguous by a deadline is reconciled, and what its run ends as | — | 3 | deferred → 3, second session: the probes and attempt statuses are rows M31 and M34 |

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
| `core.sshCommand`, credential helpers, `core.askPass`, merge drivers | — | — | not a case: no git call M1 makes reaches them (no remote operation, no merge); a rebase is row M28's, second session |
| Two repositories with identifiable content, hostile `GIT_*`, `GH_*`, editor and pager variables, hostile global and counted configuration, and the engine started inside a third repository: each project is committed and integrated in its own repository, nothing reaches the other or the third, no ambient program runs, no commit carries an ambient identity | `M23-two-repositories-hostile-environment.test.mjs` | 3 | written |

### M31. Worktree-add probe (the engine home behind a symbolic link, moved forward)

| Case | File | Slice | Status |
|---|---|---|---|
| With `$SURETY_HOME` a symbolic link, a dispatch launches, its `worktree_add` operation is recorded `succeeded`, the role runs in the workspace, and no worktree is registered in the repository that no `workspaces` row names, also after a second dispatch (review) | `M31-worktree-add-symlinked-home.test.mjs` | 2 | written |
| A symbolic link at a new run's workspace path, pointing at another run's retained worktree, is refused: the worktree add does not succeed, no role runs there, and the other worktree is untouched (second slice-2 review; E27) | `M31-workspace-path-symlink.test.mjs` | 3 | written |
| The five probe outcomes at recovery: no artifacts, complete valid worktree, partial directory or metadata, foreign or conflicting occupancy, unreadable metadata | — | 3 | deferred → 3, second session (not yet split into cases) |

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
| A Verifier's protected-only diff, its protected-and-source mixture, and another role's protected diff as a *proposal* question | — | 5 | deferred → 5: proposal capture is row M36. Role prohibitions for the Verifier and the Reviewer wait with it: see the obligations of this session, below |
| The cap on a git command's output (`git_output_cap`) | — | — | not written: see "What this session could not turn into a test" |

### M21. Quiescent snapshot and checkpoint

| Case | File | Slice | Status |
|---|---|---|---|
| While the boundary reports the domain running nothing is captured; once it reports terminated the checkpoint is taken, the validated, recorded, journaled and committed trees are one tree, the integration branch does not move, nothing is nominated, the workspace's current base advances, the run's original base is kept, and the work is to be continued | `M21-quiescent-snapshot-and-checkpoint.test.mjs` | 3 | written |
| The next run starts from the checkpoint commit in a workspace of its own, linked to the run that checkpointed, with no repair charged; its commit, made on the checkpoint, is the one integrated | same | 3 | written |
| A continuation "does not imply gate success" | — | 5 | deferred → 5: gates. That it implies no nomination is asserted in both cases above |

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
| An immutable nomination ref moved or deleted | — | 3 | deferred → 3, second session: nomination is row M27 |
| "Block affected gates" | — | 5 | deferred → 5 (build spec §9) |

### M25. Checkout edits and unreadable repository

| Case | File | Slice | Status |
|---|---|---|---|
| An unstaged edit in the developer's checkout of the integration branch, with HEAD and index where they were, is observed as a checkout change, preserved, and offered `stash` or `adopt`; one observation across ticks and a restart; the baseline is not replaced | `M25-checkout-edits-and-unreadable-repository.test.mjs` | 3 | written |
| A staged edit is observed the same way: the index differs from the baseline, the HEAD does not | same | 3 | written |
| An unreadable repository is reported as unreadable, not as clean; nothing is dispatched, a command that needs it is refused with `repo_unreadable`, and no option is offered; once readable and unchanged, the observation closes and the project goes on | same | 3 | written |
| A ref that was moved while the repository could not be read is found when it can be read again, before anything is dispatched | same | 3 | written |
| The answers to a checkout observation (`stash`, `adopt`), and what the decision binds | — | 5 | deferred → 5: row M46 |

## Left for the second slice-3 session

Rows M26 to M34, and these cases of earlier rows, none of which is written: what follows `integrated` on the integrating paths and the plan and stage finalizers (M09 with M26); the chain of roles and `max_chained_roles` (M12; E24 item 1); Stop and Abandon from `integrating`, `integrated` and `verifying`, and with a journal operation in flight (M13, M14); the reconciliation of an operation a git deadline made ambiguous (M15 with M31, M34); the journal state projection changing only with a journal event (M04); a nomination ref moved or deleted (M24 with M27); the five outcomes of the worktree-add probe beyond the symbolic link (M31); and the two recovery obligations of the slice-2 review (an ambiguous worktree removal followed by a crash; a git child that outlives a killed engine). `harness/SEAM.md` §37 says what this session fixed for that one to build on: the journal barrier names and their arming while the engine runs, `harness/journal.mjs`, `contract/journal.json`.

## Obligations recorded by the first slice-3 session

| Slice | Row (suggested home) | Obligation | Why it is recorded |
|---|---|---|---|
| 5 | M36 (with M20) | Role prohibitions for the Verifier and the Reviewer. By F §4.1 a Verifier may not modify application source and a Reviewer may modify nothing; by D1 §7.3 a Verifier's protected-only diff becomes a proposal. Slice 3 pins validation for the Builder's and the Architect's kinds only, because four slice-2 cases have a verification role write `report.txt` and complete (`M16-quarantine.test.mjs`, three cases; `M31-worktree-add-symlinked-home.test.mjs`). When slice 5 pins the rule, those four scripts change with it (the role writes nothing, or writes under the protected root and the case moves to proposal capture). | A rule the sources state and no test pins yet, and four cases that would contradict it. The owner may prefer to pin the refusal in slice 3 and change the four cases now; see the Verifier's report. |
| 5 | M46 | The answers to a checkout observation (`stash`, `adopt`), the dependency manifest of `out_of_band_change`, and the fresh comparison before the effect. Slice 3 pins the two answers for a ref without a manifest. | D1-11 needs `discard` and `adopt` for a ref to make row M24 meaningful; the rest is the decision slice's. |
| 5 | M24, M40 | That an out-of-band observation blocks the gates it affects, and that `adopt` invalidates the evaluations and results of the lineage. | No gates before slice 5. |
| 5 | M49 | Which policy changes widen authority. Slice 3's cases only lower limits; raising one must take the `policy_widening` route. | So that the slice-5 Verifier does not take "a valid change is answered 200" for the whole rule. |
| 3, second session | M26, M27 | What `revisions.lineage` holds, the stage's status and `integrated_revision`, and what a committed phase plan under `.surety/phases/` must contain. The first session's cases write no plan and read no lineage. | Left open on purpose, so the finalizer rows fix them. |
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
| 4 | M61 (store faults), with M63 | A transient store failure while recording a role's `result` drops the result with no retry: the run then ends as if no result had been sent. The store command queue's limit of 256 entries is one way to such a failure. What the engine must do instead (retry, or end the run with the failure visible) is for the slice-4 Verifier to settle with the owner; it must not be a silently missing result. | Reviewer's finding; E27 carries it. Faults in store transactions are slice 4's (row M61). |
| report; D2 | — (no M1 test) | A descendant's output inside the engine's short read window after the role exits is treated as the role's: a `result`, a `usage` line or a `heartbeat` that a descendant writes to the inherited stdout in that window is taken as sent by the role. This is a known limit of M1's scripted runs. The scripted protocol has no way to tell writers of one pipe apart, and M1 claims no isolation of a role from what it starts (E25 item 2). Real containment, and an output channel a descendant cannot write to, are D2's. The M1 acceptance report must say so. | A limit recorded so it is not mistaken for a guarantee: the unterminated-line and descendant cases show that the role's own last output is kept, not that nothing else can be injected. |
| before M2 (owner) | M15, M06, M18 | E27 ends with a question for the owner that these tests answer the strict way for now. (a) Should a run the engine is still supervising, with a live process, survive the expiry of its lease, the engine re-granting the lease after checking the process is alive? Today: expiry is final (`M15-lease-supervision.test.mjs`, "a lease past its expiry is not renewed …"), and a run ended for it is `recovered` with its work `held`. (b) Should held work resume by itself after a pause, or after a crash, instead of waiting for an explicit Resume (E24 item 3)? Today: `held` until Resume, after a startup recovery (M06, M18) and after a lease expiry (M15). The Reviewer measured the cost of the strict rule: an engine paused for 34 s against a 30 s lease ended all three runs in flight on resume, one of which had a valid result. If the owner changes either answer, the M15 lease cases and `contract/run-lifecycle.json` (`lease_expiry`, `work_after_run.recovered`) change with it. | So the next Verifier knows these rules are provisional and may change before M2, and does not build further cases on them without asking. |
| any (host) | every file that uses the controlled clock | The wall clock of the host these tests were written on steps back about 0.75 s every half minute. The engine's clock is the wall clock plus an offset, so a timestamp taken just after a clock advance can be earlier than the advance's `now`. A test that compares the two exactly fails now and then for no fault of the engine; allow two seconds, as the M15 lease cases do (`harness/SEAM.md` §23, "The host's clock"). Whether the engine should measure durations (grace periods, budgets, lease ages) on a monotonic clock is a question for the load and durability slices. | Found while verifying this pass: an existing case failed on the unchanged slice-2 engine in about one run in ten. |

## Obligations recorded after the slice-2 review

What the slice-2 review found, or the owner decided (E25), that no test pins yet. Each is work for the Verifier of the slice named. Except for the last row, the findings are recorded as the Reviewer reported them; this Verifier session did not run them again.

| Slice | Row (suggested home) | Obligation | Why it is recorded |
|---|---|---|---|
| 3, second session | M32, M33 (journal matrix, M29–M33) | After a `worktree_remove` settles `ambiguous` and the engine crashes before the run finishes, recovery must complete and the engine must reach full mode. In the slice-2 engine a second removal intent for the same run collides on the operation's idempotency key, so recovery fails on every restart. | Confirmed by the Reviewer. The journal's probe and retry rules are slice 3's (build spec §6 correction 14); a slice-2 test would pin a retry rule before its row is written. |
| 3, second session | M31, M33 | An engine killed during `git worktree add` leaves the git child running. Recovery can then probe `absent` while the child is still writing, and the worktree appears afterwards as one no row names. Recovery must account for a git child that outlived its engine before it trusts a probe. | Same review. Needs a barrier inside a git call, which slice 3's harness adds. |
| 3 | M23 | **Done in slice 3, first session** (`M23-no-repository-code-snapshot-commit.test.mjs`; the owner decided the filter question, E29 item 1). Extend `M23-engine-git-runs-no-repository-code.test.mjs` to commits, ref updates and snapshots, and decide with the owner how far "other repository-configured execution" reaches: filter drivers (`filter.*.clean`, `smudge`, `process`) run on checkout and on `git add`, so they are reachable from slice 3's snapshot; disabling them also disables Git LFS in a governed repository. | E25 item 3 states the rule generally and pins it now for the worktree calls only. |
| 5 | M47, M48 | What a Stop or Abandon confirmation binds: the run's identity, whether it can still be stopped, and the workspace's fate, not the difference between `claimed` and `executing` (E25 item 4). Until then the slice-2 behaviour stands: a confirmation raised while the run was `claimed` may be refused as stale once it is `executing`. | The owner settled the rule and put the test in slice 5, with the decision manifests. |
| 5 | M09 (`check_correction`), M35–M37 | `check_correction` is in the transition table and the slice-2 engine will dispatch one and complete it with no proposal captured. Only a fixture can create one today (`harness/SEAM.md` §12 says the slice-2 tests never dispatch it). The first slice-5 case for this kind must show that a `check_correction` run completes only through proposal capture. | A kind that completes without doing what it exists for must not be read as built. |
| 4, 6 | M63 (streamed output), M71 (load) | The engine buffers a role's output without a cap. The scripted boundary scans every process on each observation, at least once a second while a run is ending, which costs time under load. | Reviewer's findings; E25 carries them to the records slice and the load row. |
| 5 (or the row that owns it) | M47, with M16 | A quarantined run answers Stop with `illegal_transition`. D1 A.7 has a public code `quarantined`, which no test uses yet. Decide which code a Stop or Abandon of a quarantined run answers with, and pin it where the Stop manifest is written. | The slice-2 tests pin `illegal_transition` only for a run that has ended. |
| report | — | E25 item 2: M1 roles run without control-plane isolation. A scripted role runs as the engine's user, under the engine home, and can read the token file. Nothing in M1 is evidence for D1 §17 item 12. The M1 acceptance report must say so. | An accepted limit must not be read as a passed requirement. |
| D2 (no M1 test) | — | The scripted `auto` boundary does not count a process whose `/proc/<pid>/environ` it cannot read, so it can report `terminated` while a marked process that made itself unreadable is alive. The Reviewer asked whether to pin `unknown` for that. The case was written and tried, and then withdrawn. It reproduces: a role that leaves a copy of `sleep` which may be executed and not read (the kernel marks such a process not dumpable) exits, and the slice-2 engine ends the run `completed` while that process lives. It is not pinned for four reasons. (1) "Unreadable means `unknown`" cannot be the rule: every exiting process and every zombie is unreadable for a moment (measured on this host: more than 750 failed reads while some 650 short-lived children came and went), the role itself at each run end, and two lasting processes of the same user are unreadable all the time (`systemd --user`, `(sd-pam)`). The first form of the rule made the stand-in engine quarantine at random in three files that had passed. (2) A rule that works has to tell a hiding process from a dying one by whether `/proc/<pid>/stat` still shows an address space, and has to bound membership by the recorded process group; it then still misses a descendant that leaves the group, and a domain whose ownership row was never completed. (3) The premise cannot be made as root, where every environment is readable, and the runner does not allow a skip. (4) `auto` is the Verifier's stand-in for the execution boundary. It qualifies no containment (Plan §2), and M1 claims no isolation of a role from the engine (E25 item 2). `harness/SEAM.md` §14 now says what `auto` does and states the limit. | A limit of a stand-in, recorded so it is not mistaken for containment, and so the next Verifier does not rediscover the trap. Membership that cannot be escaped is D2's to qualify (build spec §6 correction 1). |

## Obligations recorded after the slice-1 review

The owner's decisions on the slice-1 review (E23). Each is work for the Verifier of the slice named; none is written yet.

| Slice | Row (suggested home) | Obligation | Why it is recorded |
|---|---|---|---|
| 2 | M06 (with M18) | Startup `recovery` must be shown to do real work: a restart test with real state to recover (a run that has not ended, a domain that has not terminated), asserting that the recovery happened before full mode, not only that the step name is listed. **Done in slice 2:** `M06-restart-recovery.test.mjs`; row M18 covers every crash boundary. | Slice 1 has nothing to recover, so its `recovery` step completes without doing anything and the slice-1 test can only check the step order. |
| 3 | M24 or M25 (with M06) | **Done in slice 3, first session** (`M06-startup-integrity.test.mjs`). Startup `integrity` must be shown to do real work: a restart test in which a registered project's repository has an integrity violation, asserting it is detected before any dispatch. | Slice 1 builds no repository integrity; its `integrity` step establishes nothing about any repository. |
| 3 | M07 | **Done in slice 3, first session** (`M07-project-bootstrap-and-policy.test.mjs`). The effective policy of a project is the policy revision the engine has recorded; with none recorded it is the schema defaults, with `revision: null`. A `.surety/policy.json` committed in the repository but never recorded by the engine is not effective. Pin what project bootstrap does with a policy file that already exists, and that an unrecorded one is not reported as effective. | Slice 1 pins only the defaults and the refusals; where the effective policy comes from is decided by the git slice. |
| 4 | M67 (open item, no row covers it) | D1 §6.1 requires the engine to refuse to start on a filesystem that does not honour fsync. This is not built and no Plan row covers it. Decide, together with row M67's power-loss harness, whether a startup check is feasible. Until then it is an open item, not a passed requirement, and the M1 report must say so. | A requirement with no test and no build must not be read as met. |
| later | — | A lint for store writes outside `src/store/transitions/` must allow exactly `src/store/migrate.ts` (`harness/SEAM.md` §5). | Recorded so the exception is not rediscovered as a defect, or widened. |
| 6 | M69 | `100 Continue` must not be sent before the declared-length body-cap check. A request with no Host header should get the engine's refusal body, not the HTTP library's bare 400. Both are listed as cases in the M69 table above. | Found by the second slice-1 review; recorded when slice 2 was verified, without tests, because the body caps and parser-level refusals are slice 6's. |

## Rows not yet split into cases

| Row | Introduced in slice | Known straddles (build spec §9 and slice-1 deferrals) |
|---|---|---|
| M01 | 7 | — |
| M26–M30 | 3, second session | — |
| M31 | 3, second session | The symlinked-home case is written in slice 2 and the symbolic-link path in slice 3 (above); the five probe outcomes → second session |
| M32–M34 | 3, second session | — |
| M35–M58 | 5 | — |
| M59, M60 | 4 | — |
| M61 | 4 | Faults in gate and decision transactions → 5 |
| M62 | 4 | Out-of-band changes blocking gates → 5 |
| M63 | 4 | — |
| M64, M65 | 4 | Critical finding quarantining evidence; retention held by a decision, finding or gate → 5 |
| M66 | 4 | — |
| M67 | 4 | Needs the power-loss harness (build spec §11) |
| M68 | 6 | Needs the browser driver (build spec §11) |
| M70–M73 | 6 | M71 needs numeric load limits (build spec §11) |
| M74 | 6 | Seam-confinement cases written in slice 1 (above); the rest → 6 |

Deferred cases that later slices must pick up, by slice:

- **Slice 3, second session** (the first session wrote the rest of what was listed here; see "Left for the second slice-3 session"): rows M26 to M34; M04 (journal state projection); M09 (what follows `integrated`); M12 (the chaining boundary); M13 and M14 (Stop and Abandon from `integrating`, `integrated`, `verifying`; a journal operation in flight); M15 (the reconciliation of an operation made ambiguous by a deadline); M24 (a nomination ref moved or deleted); M31 (the five probe outcomes); the two recovery obligations of the slice-2 review (an ambiguous worktree removal followed by a crash; a git child that outlives its engine).
- **Slice 4:** M02 (record identities); M04 (chunk receipts); M12 (the over-budget project); the fsync open item; a cap on buffered role output (slice-2 review); a transient store failure while recording a role's result must not drop the result (second slice-2 review).
- **Slice 5:** M20 and M36 (role prohibitions for the Verifier and the Reviewer, with the four slice-2 scripts that change then); M24 (gates blocked by an observation); M25 and M46 (the answers to a checkout observation, the manifest); M07 and M49 (policy widening); M11 (the findings part of the progress key); M21 (a continuation implies no gate success); M08 (gate kinds, reserved decision kinds); M09 (a dispatched `check_correction`; an engine-raised `awaiting_decision` answered through the queue); M11 (findings in the progress key; a typed conflict); M13 and M14 (Stop and Abandon from `awaiting_decision` while a run owns the work); the decision manifests of `blocker`, `stop_confirm` and `abandon_confirm` (rows M45, M47, M48), with what a Stop or Abandon confirmation binds (E25 item 4) and the code a quarantined run answers Stop with; a `check_correction` run that cannot complete without a captured proposal.
- **Slice 6:** M69 (the rest of the boundary matrix, with the two cases the second slice-1 review found); M74 (fixture semantics and the invocation boundary); M71 (the cost of the boundary's process scan under load).
