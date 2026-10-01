# Acceptance coverage

How one Verifier session hands over to the next (build spec §7). Every Plan row appears here. For each row a slice has worked on, every named case is listed with its file, the slice whose manifest lists that file, and whether it is written. A case deferred to a later slice is recorded when it is deferred, with the reason. Rows no slice has worked on yet are listed at row level with the slice that introduces them (build spec §9); that slice's Verifier splits them into cases.

**Status values:** `written` (a test exists and is listed in the manifest); `deferred → N` (not written; waits for slice N); `not started` (row not yet split).

Last updated: slice 2, 2026-10-01. Slice 2 wrote rows M09 to M18 as far as slice 2 can pass them, the cases of M02, M05, M06, M07 and M08 that slice 1 deferred to it, and the cases the slice-1 reviews carried over (E23 items 8, 11 and 12), marked "(carried)" below. A file is listed under one slice only, so every slice-2 case of a slice-1 row is in a new file. The paragraph that follows is the slice-1 Verifier's.

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
| The git journal state projection changes only with a new journal event | — | 3 | deferred → 3: needs the journal transitions |

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
| Startup `integrity` shown to do real work | — | 3 | deferred → 3: see the obligations table |

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
| A valid project policy change takes effect and is inspectable | — | 3 | deferred → 3: commits `.surety/policy.json` through the journaled git path |
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
| Legal paths that integrate: `stage_build`, `fix` (to verifying and complete), `replan`, `assessment` | — | 3 | deferred → 3: needs snapshot, commit and integration |
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
| Unchanged findings with new ids and timestamps: the no-progress count over the progress key | — | 3, 5 | deferred → 3 and 5: the key is taken over a snapshot tree (3) and findings (5) |
| A small successful repair of work that integrates | — | 3 | deferred → 3 |
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
| A project at `max_chained_roles`: chaining stops at the declared human boundary | — | 3 | deferred → 3: in slice 2 no run's outcome creates further work, so there is no chain to stop (`harness/SEAM.md` §12). What a chain is needs the owner's answer first; see the slice-2 report |

### M13. Stop from every owning state

| Case | File | Slice | Status |
|---|---|---|---|
| Stop from `executing`, for each dispatched kind: the role is fenced, usage is kept, a late success changes nothing, the run ends stopped, the work is held, Resume starts a new linked run (6 cases) | `M13-stop.test.mjs` | 2 | written |
| Stop from `claimed`, for each dispatched kind: a run stopped before its role was spawned leaves no role running and holds the work (6 cases) | same | 2 | written |
| While the boundary still reports the domain running, the stopped run is not ended and the work is not held (the delayed acknowledgement) | same | 2 | written |
| Stop needs its confirmation, a stale confirmation does nothing, and a run is stopped only through its own project | same | 2 | written |
| Stop from `integrating`, `integrated`, `verifying`; with a journal operation in flight | — | 3 | deferred → 3 |
| Stop from `awaiting_decision` while a run still owns the work | — | 5 | deferred → 5: no engine path into it before slice 5; the edge is pinned at the table (M09) |

### M14. Abandon and durable dispatch hold

| Case | File | Slice | Status |
|---|---|---|---|
| Abandon from `executing`, for each dispatched kind: termination confirmed, workspace discarded, work back at its prior status under a dispatch hold, no repurchase until Resume (6 cases) | `M14-abandon.test.mjs` | 2 | written |
| Abandon from `claimed`, for each dispatched kind (6 cases) | same | 2 | written |
| While the boundary reports the domain running nothing is discarded, and no new trigger generation is dispatched onto the project; when termination is observed the abandon completes and the new generation runs | same | 2 | written |
| Abandon from `integrating`, `integrated`, `verifying`; with a journal operation in flight | — | 3 | deferred → 3 |
| Abandon from `awaiting_decision` while a run still owns the work | — | 5 | deferred → 5 |

### M15. Deadlines and stale generations

| Case | File | Slice | Status |
|---|---|---|---|
| A run past its deadline is cancelled, a late success changes nothing, dependent work stays undispatched, other work and control requests are not disturbed; then the work continues | `M15-deadlines.test.mjs` | 2 | written |
| A deadline is not observed termination: with the boundary reporting the domain running, the run is quarantined | same | 2 | written |
| A prerequisite step that overruns its budget suppresses that project for the tick, late completion included | same | 2 | written |
| A tick that has used up its budget dispatches nothing more | same | 2 | written |
| A git call past its deadline; possible writes become ambiguous | — | 3 | deferred → 3 |
| Repository integrity as the overrunning prerequisite step | — | 3 | deferred → 3 |

### M16. Unknown termination is never success

| Case | File | Slice | Status |
|---|---|---|---|
| The role process exited, but the boundary still reports the domain running (parent exited, child live); survives a restart; an acknowledgement establishes nothing | `M16-quarantine.test.mjs` | 2 | written |
| The boundary cannot read membership; survives a restart | same | 2 | written |
| Cancellation fails after Stop; survives a restart; an acknowledgement establishes nothing | same | 2 | written |
| No discard while quarantined | `M14-abandon.test.mjs` (the quarantine case) | 2 | written |
| No snapshot while quarantined | — | 3 | deferred → 3: snapshots are slice 3 (row M21 pins "no live snapshot") |

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
| After a normal result: the snapshot and its receipts are recovered | — | 3 | deferred → 3: slice 2 asserts the workspace retained with the role's files |

## Obligations recorded after the slice-1 review

The owner's decisions on the slice-1 review (E23). Each is work for the Verifier of the slice named; none is written yet.

| Slice | Row (suggested home) | Obligation | Why it is recorded |
|---|---|---|---|
| 2 | M06 (with M18) | Startup `recovery` must be shown to do real work: a restart test with real state to recover (a run that has not ended, a domain that has not terminated), asserting that the recovery happened before full mode, not only that the step name is listed. **Done in slice 2:** `M06-restart-recovery.test.mjs`; row M18 covers every crash boundary. | Slice 1 has nothing to recover, so its `recovery` step completes without doing anything and the slice-1 test can only check the step order. |
| 3 | M24 or M25 (with M06) | Startup `integrity` must be shown to do real work: a restart test in which a registered project's repository has an integrity violation, asserting it is detected before any dispatch. | Slice 1 builds no repository integrity; its `integrity` step establishes nothing about any repository. |
| 3 | M07 | The effective policy of a project is the policy revision the engine has recorded; with none recorded it is the schema defaults, with `revision: null`. A `.surety/policy.json` committed in the repository but never recorded by the engine is not effective. Pin what project bootstrap does with a policy file that already exists, and that an unrecorded one is not reported as effective. | Slice 1 pins only the defaults and the refusals; where the effective policy comes from is decided by the git slice. |
| 4 | M67 (open item, no row covers it) | D1 §6.1 requires the engine to refuse to start on a filesystem that does not honour fsync. This is not built and no Plan row covers it. Decide, together with row M67's power-loss harness, whether a startup check is feasible. Until then it is an open item, not a passed requirement, and the M1 report must say so. | A requirement with no test and no build must not be read as met. |
| later | — | A lint for store writes outside `src/store/transitions/` must allow exactly `src/store/migrate.ts` (`harness/SEAM.md` §5). | Recorded so the exception is not rediscovered as a defect, or widened. |
| 6 | M69 | `100 Continue` must not be sent before the declared-length body-cap check. A request with no Host header should get the engine's refusal body, not the HTTP library's bare 400. Both are listed as cases in the M69 table above. | Found by the second slice-1 review; recorded when slice 2 was verified, without tests, because the body caps and parser-level refusals are slice 6's. |

## Rows not yet split into cases

| Row | Introduced in slice | Known straddles (build spec §9 and slice-1 deferrals) |
|---|---|---|
| M01 | 7 | — |
| M19–M23 | 3 | — |
| M24 | 3 | "Block affected gates" → 5 |
| M25–M34 | 3 | — |
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

- **Slice 3:** M04 (journal state projection); M07 (a valid project policy change; the effective-policy obligation); M06 (startup `integrity` doing real work); M09 (the integrating part of `stage_build`, `fix`, `replan`, `assessment`); M11 (no-progress over a snapshot tree; a repair that completes work which integrates); M12 (the chaining boundary); M13 and M14 (Stop and Abandon from `integrating`, `integrated`, `verifying`; a journal operation in flight); M15 (a git call past its deadline, ambiguous writes, integrity as the prerequisite step); M18 (recovery of the snapshot after a normal result).
- **Slice 4:** M02 (record identities); M04 (chunk receipts); M12 (the over-budget project); the fsync open item.
- **Slice 5:** M08 (gate kinds, reserved decision kinds); M09 (a dispatched `check_correction`; an engine-raised `awaiting_decision` answered through the queue); M11 (findings in the progress key; a typed conflict); M13 and M14 (Stop and Abandon from `awaiting_decision` while a run owns the work); the decision manifests of `blocker`, `stop_confirm` and `abandon_confirm` (rows M45, M47, M48).
- **Slice 6:** M69 (the rest of the boundary matrix, with the two cases the second slice-1 review found); M74 (fixture semantics and the invocation boundary).
