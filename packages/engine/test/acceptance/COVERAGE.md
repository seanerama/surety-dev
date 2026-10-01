# Acceptance coverage

How one Verifier session hands over to the next (build spec §7). Every Plan row appears here. For each row a slice has worked on, every named case is listed with its file, the slice whose manifest lists that file, and whether it is written. A case deferred to a later slice is recorded when it is deferred, with the reason. Rows no slice has worked on yet are listed at row level with the slice that introduces them (build spec §9); that slice's Verifier splits them into cases.

**Status values:** `written` (a test exists and is listed in the manifest); `deferred → N` (not written; waits for slice N); `not started` (row not yet split).

Last updated: slice 1, 2026-10-01, after the slice-1 review. The review's four contract defects became five cases, marked "(review)" below: two in row M69 for the Host check, one in M69 and one in M06 for the token file, one in M07. The owner's decisions on the review's other findings (E23) added the seam-confinement cases of row M74 and the obligations listed under "Obligations recorded after the slice-1 review".

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
| Two dispatched runs of one role have distinct invocation, domain, workspace and record identities | — | 2 | deferred → 2: needs the scheduler, choke point and scripted adapter |
| Engine-side duplicate allocation (repeated and concurrent, and after restart) returns the same receipt with no second launch | — | 2 | deferred → 2: needs the allocation path in the tick |
| No duplicate ledger charge across repeated finalization of one run | — | 2 | deferred → 2: needs the run-end protocol |

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
| Failure prevents dispatch of eligible work (not only of mutations) | — | 2 | deferred → 2: slice 1 has no dispatch; slice 1 pins that the scheduler never starts (`engine.started` absent) |

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
| Restart recovers owned runs and domains before any dispatch | — | 2 | deferred → 2: needs runs and domains to recover |

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
| Effective settings are used by the scheduler (engine and project concurrency, tick budgets) | — | 2 | deferred → 2: needs dispatch; row M12 also pins it |

### M08. M1 capability boundary

| Case | File | Slice | Status |
|---|---|---|---|
| Session open, turn, save and close are refused before any effect | `M08-api-capability-refusals.test.mjs` | 1 | written |
| Management and release surfaces are refused | same | 1 | written |
| Deploy, publish and export requests are refused before any effect | same | 1 | written |
| Tables reserved for later designs, and environment observation tables, do not exist | same | 1 | written |
| A fixture-installed project is labelled as test setup | same | 1 | written |
| The test seam is unreachable outside harness mode | same | 1 | written |
| Scheduler intents for excluded work kinds (`deploy`, `publish`, `export`, `rollback`, `conformance`, sessions) never launch | — | 2 | deferred → 2: needs the tick |
| A real backend, version or mode is refused (`backend_refused`) before launch | — | 2 | deferred → 2: needs the choke point |
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
| Origin, Referer and fetch-metadata matrix; no CORS | — | 6 | deferred → 6 |
| Declared and streamed body caps; `100 Continue` against the Origin, Referer, fetch-metadata and body-cap refusals (the Host case is written, above) | — | 6 | deferred → 6 |
| Other malformed Host forms: a request with no Host header gets its 400 from the HTTP parser, before the engine's handler; whether that answer must carry the refusal body is not pinned | — | 6 | deferred → 6: needs the owner's or the slice-6 Verifier's decision on parser-level refusals (the same question as "error callbacks") |
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

## Obligations recorded after the slice-1 review

The owner's decisions on the slice-1 review (E23). Each is work for the Verifier of the slice named; none is written yet.

| Slice | Row (suggested home) | Obligation | Why it is recorded |
|---|---|---|---|
| 2 | M06 (with M18) | Startup `recovery` must be shown to do real work: a restart test with real state to recover (a run that has not ended, a domain that has not terminated), asserting that the recovery happened before full mode, not only that the step name is listed. | Slice 1 has nothing to recover, so its `recovery` step completes without doing anything and the slice-1 test can only check the step order. |
| 3 | M24 or M25 (with M06) | Startup `integrity` must be shown to do real work: a restart test in which a registered project's repository has an integrity violation, asserting it is detected before any dispatch. | Slice 1 builds no repository integrity; its `integrity` step establishes nothing about any repository. |
| 3 | M07 | The effective policy of a project is the policy revision the engine has recorded; with none recorded it is the schema defaults, with `revision: null`. A `.surety/policy.json` committed in the repository but never recorded by the engine is not effective. Pin what project bootstrap does with a policy file that already exists, and that an unrecorded one is not reported as effective. | Slice 1 pins only the defaults and the refusals; where the effective policy comes from is decided by the git slice. |
| 4 | M67 (open item, no row covers it) | D1 §6.1 requires the engine to refuse to start on a filesystem that does not honour fsync. This is not built and no Plan row covers it. Decide, together with row M67's power-loss harness, whether a startup check is feasible. Until then it is an open item, not a passed requirement, and the M1 report must say so. | A requirement with no test and no build must not be read as met. |
| later | — | A lint for store writes outside `src/store/transitions/` must allow exactly `src/store/migrate.ts` (`harness/SEAM.md` §5). | Recorded so the exception is not rediscovered as a defect, or widened. |

## Rows not yet split into cases

| Row | Introduced in slice | Known straddles (build spec §9 and slice-1 deferrals) |
|---|---|---|
| M01 | 7 | — |
| M09 | 2 | Paths that integrate → 3; `check_correction` → 5 |
| M10 | 2 | — |
| M11 | 2 | Progress key over a snapshot tree, findings, completed repair → 3 and 5 |
| M12 | 2 | Over-budget case → 4 |
| M13 | 2 | Stop from integrating, integrated, verifying; in-flight journal operation → 3 |
| M14 | 2 | Same as M13 → 3 |
| M15 | 2 | Writes that become ambiguous; integrity as a prerequisite step → 3 |
| M16 | 2 | — |
| M17 | 2 | — |
| M18 | 2 | — |
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

Deferred slice-1 cases that later slices must pick up: M02 (three cases → 2), M04 (chunk receipts → 4; journal state projection → 3), M05 (dispatch prevention → 2), M06 (run/domain recovery before dispatch → 2), M07 (valid project policy change → 3; settings used by the scheduler → 2), M08 (scheduler intents and real backend → 2; gate kinds and reserved decision kinds → 5), M69 (the rest of the boundary matrix → 6), M74 (fixture semantics and the invocation boundary → 6). Later slices must also pick up the obligations recorded after the slice-1 review, above.
