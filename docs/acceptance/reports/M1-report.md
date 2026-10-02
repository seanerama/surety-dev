# Surety M1 acceptance report

**Written by:** the Verifier, 2026-10-02, on branch `verify/report`. **For:** Sean, the owner, before his hands-on run and his decision whether to accept M1; and Astra, the architect who wrote the acceptance plan. **Status:** a record of what was run and what was observed. It decides nothing.

Surety is an evidence-gated delivery engine for AI coding agents: a program (the **engine**) that drives coding agents through a governed lifecycle and lets nothing advance on an agent's say-so. M1 is its first milestone. This report is the last deliverable of M1 before the owner's hands-on run (build specification, section 10). It is written for two readers who were not in the build, so terms are explained where they first appear and nothing is taken from the build's chat. Everything below that is described as passing was run by the Verifier on 2026-10-02 and its output kept; nothing is described as passing that was not run.

The sources it cites: the **build specification** (`docs/spec/M1-build-spec.md`); the **acceptance plan** (`docs/acceptance/sdlc-M1-acceptance-plan-Astra.md`: Astra's 74 rows M01 to M74, each a scenario with a required observable result); the **errata** (`docs/foundations/sdlc-foundations-v1.1-errata-draft.md`, the owner's decisions E1 to E42, cited below as E-numbers); the **coverage record** (`packages/engine/test/acceptance/COVERAGE.md`, every row split into named test cases, with the reason for every case that was left out); the **seam** (`packages/engine/test/acceptance/harness/SEAM.md`, the prose contract between the tests and the engine, cited as "SEAM section N"); and the **not-claimed list** (`docs/acceptance/reports/M1-not-claimed.md`).

## 1. What M1 claims and does not claim

M1 is the engine's core loop running against a **scripted adapter**: a stand-in for a coding agent that does exactly what a test tells it to, makes no model call, and reports what it did (build specification, section 1). Accepting M1 supports one claim: **the kernel behaves as the acceptance plan requires, on a scripted adapter, at the load limits the tests record** (section 3 below). It does not support the claims that Surety can run a real agent, that it can deploy anything, or that it has completed its first phase; those wait for later milestones (build specification, section 10). The scripted adapter and the scripted execution boundary prove the engine's reactions; they qualify no real agent backend, no real process containment and no real check runner (acceptance plan, section 2). M1 has no real backend, no deployment, no publication, no sessions and no user interface, and the tests establish that each of those is refused rather than quietly absent (rows M08 and M74). An Alpha authorization in M1 is an issued record for a configured test target; nothing is deployed and no candidate is ever reported as deployed.

## 2. The run

**Revision.** `9c0dbf6a61eb6a7fb1c18e4bae312b74bdd767fb`, the head of `main` on 2026-10-02 ("Merge build/slice-6: the API boundary, reads, streams, load, the contract, and the three review fixes (E42)"). The acceptance tests and the engine live in the same repository, so the test revision and the engine revision are this one commit. The last commit that touched the acceptance tests before it is `273f401` (2026-10-02 16:06 -0500); the last that touched the engine's source, migrations or API files is `0a4da14` (2026-10-02 16:09 -0500); the runner, `scripts/run-tests.mjs`, was last changed at `8fd8047` (2026-10-01).

**Command.** `npm test`, run from a clean git worktree of that revision at 21:48:22 UTC on 2026-10-02 with dependencies installed, its output written to a file. `npm test` runs the unit suite and then the whole acceptance suite; each is run by `scripts/run-tests.mjs`, which builds the engine with `tsc` first, runs one test file at a time, and refuses to report success if any test was skipped, if a file had no passing test, if a file is misnamed or not listed in the manifest, or if any of the 74 rows has no test file. Nothing else used the machine during the run, with one exception that is recorded so it is known: while the suite was in its slice-3 files, the Verifier, probing how the test reporter counts cases, ran one acceptance file by itself (`M16-quarantine.test.mjs`, nine cases, about 25 seconds) in a second process with its own engine homes and ports. It passed, the suite showed no failure, and since E41 item 1 an engine does not touch another home's processes (section 8); it is nonetheless a second engine on the machine during part of the run.

**Closing lines, verbatim.** The unit suite:

```
ℹ tests 75
ℹ suites 0
ℹ pass 75
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11849.758111
unit: 16 file(s) passed.
```

The acceptance suite, followed by the shell's `time` of the whole `npm test` and the line the Verifier's wrapper wrote with the command's exit status:

```
ℹ tests 795
ℹ suites 207
ℹ pass 795
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1157812.317662
acceptance: 124 file(s) passed.

real	18m27.070s
user	8m56.981s
sys	3m33.408s
exit=0
```

`npm test` exited 0. No test failed, was cancelled, skipped or marked to-do. (The acceptance suite's own duration, 1,157.8 s measured on a clock that does not step, is longer than the shell's `real` 18 m 27 s for the whole command, which is measured on the host's wall clock; section 8 says why.) The runner kept the full reports under `test-results/` in that worktree, which git does not track: `test-results/unit-2026-10-02T21-48-22-678Z.log` and `test-results/acceptance-2026-10-02T21-48-35-013Z.log`.

**Files and cases per slice.** The build was made in seven slices (build specification, section 9); `packages/engine/test/acceptance/manifest.json` lists each test file under the slice where it must first pass. The case counts are the passing tests of this run, attributed to files by the order in which the runner ran them; their total is the reporter's 795.

| Slice | Capability | Files | Cases passed |
|---|---|---|---|
| 1 | Store and startup | 10 | 69 |
| 2 | Work, runs and interruption | 22 | 122 |
| 3 | Git and the journal | 39 | 384 |
| 4 | Ledger, records and backup | 15 | 47 |
| 5 | Protected path, gates and decisions (and the journey, row M01) | 25 | 110 |
| 6 | API, load and contract | 12 | 61 |
| 7 | The journey read through the API | 1 | 2 |
| **Total** | | **124** | **795** |

Every row M01 to M74 has at least one file, and the runner checked that before running anything.

**Versions.**

| What | Version |
|---|---|
| Operating system | `Linux MSI 6.6.87.2-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC Thu Jun 5 18:30:46 UTC 2025 x86_64 GNU/Linux`; `/etc/os-release`: Ubuntu 24.04.3 LTS (Noble Numbat). A Linux virtual machine under Windows (WSL2). |
| Node | v22.22.0 |
| SQLite | 3.53.4, as `sqlite_version()` reports it through the engine's one runtime dependency, `better-sqlite3` 13.0.3 |
| git | 2.43.0 |
| Browser driver | Playwright 1.58.2 (a development dependency used by row M68 only; E36 item 1) |
| Browsers, as the M68 test printed them in this run | `M68 browser lane: chromium 145.0.7632.6` and `M68 browser lane: firefox 146.0.1` |

## 3. Qualified load limits

Row M71 ("latency under the declared maximum load") qualifies the limits the owner decided (E36 item 2), recorded in `packages/engine/test/acceptance/contract/load-limits.json`: **5 projects, 20 connected clients, a store of 1,073,741,824 bytes (one gibibyte), and the engine's default API latency bound of 250 ms.** Nothing larger is qualified by this run, and the figures below are for this host only.

**What the two latency cases measured** (SEAM section 93). Each case first shows that its fixture is at the limits and then samples `GET /v1/health`, the engine's health route, and the admission of a Stop command (the answer to each of its two requests), about every hundred milliseconds. The first case does this while a startup migration scans the full store eight times, with the engine in restricted mode; the second in full mode, with everything the row names under way at once: twenty clients on the event stream (seventeen following it, two replaying the whole log in pages of a million events, one that asks for everything and reads nothing), a backup of the store taken by the running engine, one project's git held so that a git child of the engine is open on its repository, a role writing six mebibytes that the engine hashes into chunks, a stage gate recomputed, and three runs stopped. A third case checks that a role's output is not held in memory. What this run printed:

| Case | Measurement |
|---|---|
| Fixture | `5 projects, 20 clients, store 1025.5 MiB (limit 1024.0 MiB), api_latency_bound 250 ms`; the store was built from 16,256 filler events in one transaction in 1,800 ms |
| Startup migration over the full store, restricted mode | health: 145 valid samples of 145, median 2.1 ms, **worst 4.7 ms**; Stop (refused with `engine_starting`, as it must be in restricted mode): 5 valid of 5, median 1.6 ms, **worst 2.1 ms** |
| Full mode at the limits, a window of 37,181 ms | health: 467 valid samples of 467, median 3.5 ms, **worst 8 ms**; Stop admission: 6 valid of 6, median 18.3 ms, **worst 25 ms** |
| Termination latency, measured apart and not judged against the bound | from a Stop's admission to the run's end: 300 ms for a run that exits on SIGTERM; 2,346 ms for one that ignores it (it is killed after the configured grace of 2 s); 2,338 ms for the run that was writing output being hashed |
| The backup under way | ended 37,107 ms after its start with one project's git held, labelled `incomplete_for_recovery`, which is what E42 item 2 requires when git cannot confirm that project's commits in time |
| The load that was on the engine during the window | a backup of 1,025.6 MiB; 29,848.8 MiB replayed to the paging clients; 7 chunks hashed; 20 clients, all still connected at the end |
| A role's output is not held in memory | 512.0 MiB written by the role; the engine's peak resident memory 94.7 MiB before, 197.5 MiB after, a rise of 102.9 MiB against an allowed rise below 256.0 MiB |

**The rule the test judges by** (E39 item 5; SEAM section 93, "How a latency is judged on a host that may be busy"). Every sample of the engine is paired with a control: at the same instant, from the same event loop, a request to a trivial server inside the test process. A sample whose control took more than 50 ms is void, because the host or the test process was not responsive at that moment and the sample says nothing about the engine. Every valid sample must be within the 250 ms bound, with whatever the control cost included; the bound is never widened and nothing is subtracted. A judgement needs a stated number of valid samples (thirty of health and four of the six Stop requests in full mode; five of health and two of Stop during the migration); with fewer, the case fails as not judged, which is not a pass. In this run no sample was void.

Two things the row does not show, recorded in the coverage record: that the engine's event loop is never blocked for longer than the bound (the cases sample; a block that falls between two samples would not be seen), and the engine's own store queue depth and transaction durations (not observable from outside; the not-claimed list's class C).

## 4. Process-kill results and power-loss results

These are reported apart, as the acceptance plan requires (section 5): killing a process is not a power-loss test, because what a killed process had already written reaches the disk, while a power cut loses what was not synced.

### 4a. Process kill (SIGKILL) and crash

The rows below start a real engine process, kill it with SIGKILL at a chosen point, reopen its database and inspect its git repositories, restart it, and require the work to go on through the public API. All of their cases passed in this run.

| Row and file | Cases passed | What the cases show |
|---|---|---|
| M18, `M18-crash-boundaries.test.mjs` | 9 | The engine is killed at each of seven boundaries of allocating, launching and ending a run (`dispatch.run_created`, `dispatch.domain_allocated`, `dispatch.receipt_committed`, `launch.before_spawn`, `launch.before_ownership`, `run.result_received`, `run_end.before_ended`). After each restart the run is ended as `recovered` with its work held for an explicit Resume, except at the last boundary, where the result had already been accepted and the run ends `completed`; a role spawned before the kill is found and terminated and its workspace is retained with what it wrote; recovery launches nothing and the same receipts and domains are accounted for; the scheduler launches no replacement; Resume starts exactly one new run, linked to the recovered one, which completes the work; and where the outcome was recorded before the kill, a second restart changes nothing and the run is finalized once. Two further cases: a recorded process id that now belongs to an unrelated process is never signalled; a boundary whose emptiness is unknown after the restart leaves the run quarantined until termination is observed. |
| M18, `M18-snapshot-recovery.test.mjs` | 1 | Killed after a normal result and before the snapshot: recovery ends the run as `recovered`, records the tree of what the role left as evidence, and accepts nothing. |
| M33, `M33-crash-across-journal-and-finalizer-boundaries.test.mjs` | 20 | For each of the four kinds of git operation the engine journals (a ref update, a commit, a workspace creation, a workspace removal) and each of five boundaries (intent committed, effect applied, receipt committed, probe confirmed, finalizer committed), the engine is killed there. After the restart the operation is finalized with a legal journal; the effect is in git exactly once (an effect that is there is never made again; one that is positively absent is retried once as a new attempt); the finalizer's receipts are there; the engine's own effect is not reported as an out-of-band change; and the work goes on. |
| M31, `M31-git-child-outlives-engine.test.mjs` | 2 | An engine killed during `git worktree add` leaves the git child alive: recovery does not act on a probe while that child lives, and no workspace appears afterwards that no row names. And an engine never signals a process that another engine home started (the slice-5 review's finding, E41 item 1). |
| M32, `M32-ambiguous-removal-then-crash.test.mjs` | 2 | A workspace removal that a git deadline left ambiguous, followed by a crash before the run had ended: recovery completes, the engine reaches full mode, the same operation is retried and the workspace discarded once, and the run ends abandoned. |
| M06, `M06-restart-recovery.test.mjs` | 1 | A restart recovers owned runs and domains before any dispatch: the recovery step ends a run that was executing and terminates its domain before full mode. |
| M16, `M16-quarantine.test.mjs` and `M16-no-snapshot-while-quarantined.test.mjs` | 10 | Unknown termination is never success: a role whose process exited while the execution boundary still reports the domain running, a boundary that cannot read membership, a cancellation that fails, and a descendant that outlives the role all leave the run quarantined, never completed and never snapshotted, until termination is observed. |
| M17, `M17-quarantine-clearance.test.mjs` | 2 | A quarantine clears only when the boundary reports the domain terminated, and nothing else clears it. |
| M58, `M58-aging-and-notification-ambiguity.test.mjs` | 4 | The engine is killed before a notification's delivery and, separately, after the delivery and before its receipt: after each restart it asks the notification sink what happened and delivers exactly once; when the sink cannot say, the delivery is recorded as unknown and never blindly repeated. |

The journal's recovery probes (rows M29 to M32, the four probe files, 48 cases in this run) plant each durable journal state and require each of the five probe outcomes to lead where the contract table says; they are recovery cases rather than kills and passed too.

### 4b. Power loss

Row M67 cuts power with an unprivileged **shim** (E31 item 5; SEAM section 60): a small C library compiled at test time and loaded into the engine process with `LD_PRELOAD`, which the engine passes on to the git processes it starts. **What the shim models** (E32 item 1, in substance): a regular file's content is durable as of its last `fsync` or `fdatasync`; a file created during the session and never synced is empty after the cut; names are durable at once, so a creation, a rename or a removal is kept as the process left it. A cut kills every process under the shim with SIGKILL and then gives every file the content of its last synced copy. **What it does not model:** the loss of a rename or a directory entry that a real filesystem could lose because its directory was not synced (so a missing directory sync is not detected); torn or partial writes, or reordering (unsynced data is lost whole); data made durable by a way the shim does not see (`msync`, files opened `O_SYNC`, `sync_file_range`, io_uring, a statically linked program, a child started through `system` or `popen`), which it takes for unsynced; file metadata; and the medium itself.

**What passed in this run:**

- **The five shim-fidelity cases** (`M67-power-loss-shim-is-faithful.test.mjs`), which need no engine: a SQLite transaction committed through the pinned driver under `synchronous=FULL` survives a cut; one committed without a sync does not, while the synced one before it does; a commit and a branch git wrote with `core.fsync=all` survive; the same written with `core.fsync=none` do not; and a git started by a process under the shim, with an environment that process constructed, is under the shim too.
- **The three M67 durability cases** (`M67-power-loss-durability.test.mjs`): the engine, under the shim, is paused at a barrier and the power is cut. After an intent commit, the intent is in the store on restart, its effect is not, and the work goes on (a Resume completes it with one launch in all). After a record publication, the published record is whole and the restarted engine serves it. After an effect was applied and before its receipt, recovery finds what git holds, the integration is made exactly once, the branch is at the run's commit and the registry expects it there.
- **The three unsafe-filesystem cases** (`M67-unsafe-filesystem-refused.test.mjs`, E36 item 7): an engine home on a memory-backed filesystem (a real one, under `/dev/shm`) is refused before anything is written; ten named network and user-space filesystem kinds, a Windows drive seen from inside WSL among them, are refused the same way; any other kind starts normally.

**What this says and does not say.** A pass shows that the engine syncs what it must before it relies on it: the store commits are synced, a record's file is synced before it is published, every git write whose effect the store records is synced by git or by the engine, and the engine can start again from exactly the synced state. It says **nothing about whether this host's storage honours a sync** (E32 items 1 and 2; E36 item 7). The engine cannot check that, no process can without a real power cut, and the unsafe-filesystem refusal is a refusal by kind of filesystem, not a test of the medium.

## 5. What the one review per slice found and what was done

From slice 4 the build had one Reviewer pass per slice (E31). A finding the review confirmed as serious by running the engine became one failing acceptance case, written by the Verifier from the sources, and got one fix from the Builder before the slice was merged; the case stays in the suite. Slices 1 to 3 had more review rounds under the earlier procedure (E23 to E28, E33); their defects were likewise turned into cases and fixed, and are not listed here. Every row below passed in the run of section 2.

| Slice | Confirmed defect | What was done | Where |
|---|---|---|---|
| 4 | In a partial clone, engine git fetched a missing object from the remote on demand and ran the program named as the remote's upload-pack (E37 item 1) | Fixed before merge with a test: engine git never contacts a remote and never runs a program a remote's configuration names; a partial clone is not supported in M1 | `M23-partial-clone-no-remote.test.mjs` |
| 4 | A held secret containing a character JSON escapes reached the transcript and the API in its escaped form (E37 item 2) | Fixed before merge with a test: a transcript line that parses as JSON is redacted on its decoded values; neither the raw nor the escaped form is on disk or served | `M64-streaming-redaction-and-later-detector.test.mjs` |
| 4 | One failed store write dropped a usage observation; the ledger then claimed complete usage and the budget stop did not happen (E37 item 3) | Fixed before merge with a test: the write is retried for a bounded time, the observation is stored once, and the run that passes its token limit on it is stopped | `M61-budget-boundaries-and-failed-reads.test.mjs` |
| 4 | A backup taken after a listed commit had been pruned was labelled complete and could not be restored (E37 item 4) | Fixed before merge with a test: `surety store backup` is refused (exit status 7, `backup_incomplete`) and nothing it leaves says `complete` | `M66-backup-and-restore.test.mjs` |
| 4 | A filter driver can still run if the repository's configuration is rewritten while the engine is running git (E37 item 5) | **Deferred** to D2, the isolation design, with no case; section 7 | — |
| 5 | When reconciling a journal operation, an engine killed every git process on the machine that carried another engine's marker, whatever its home (E41 item 1) | Fixed before merge with a test: an engine may end only processes of its own home | `M31-git-child-outlives-engine.test.mjs` |
| 5 | With the repository's git not answering, the check for an unauthorized protected set was skipped and the stage gate was satisfied (E41 item 2) | Fixed before merge with a test: a gate input that could not be read makes the gate not satisfied | `M35-separate-governed-policy-file.test.mjs` |
| 5 | A quarantined Verifier's findings were lost and its verification still completed, so a Critical finding vanished (E41 item 3) | Fixed before merge with a test: a quarantined run's report is recorded like any other, and its work does not complete before that | `M42-findings-dispositions-and-inherited-applicability.test.mjs` |
| 5 | A Reviewer's sign-off was bound to the acceptance content in force when its report arrived, so a check added during the review was covered by a sign-off that never saw it (E41 item 4) | Fixed before merge with a test: a sign-off binds the content its run was started on | `M43-severity-tier-and-independence-floors.test.mjs` |
| 5 | A stage gate blocked by an outside change was never evaluated again when the block cleared, so the stage stayed in verification (E41 item 5) | Fixed before merge with a test: the gate is evaluated again when the block clears | `M44-stage-gate-versus-alpha-authorization.test.mjs` |
| 6 | After a detector marked a run's transcript as holding a secret, the run's output tail still returned every byte (E42 item 1) | Fixed before merge with a test: a quarantined record is served by no route, the tail included | `M64-secrets-in-streams.test.mjs` |
| 6 | The engine had its own reader of git's object files, which reported a corrupt commit as present, so a backup that could not be restored was labelled complete (E42 item 2) | Fixed before merge with a test: the reader is removed; the engine asks git, within the git deadline, and a commit git cannot confirm in time leaves the backup `incomplete_for_recovery`. The row M71 load case was changed to match | `M66-backup-in-a-running-engine.test.mjs` (first case); `M71-latency-under-declared-load.test.mjs` |
| 6 | A link in a repository's pack directory could exhaust the engine's memory or hang a backup for ever (E42 item 3) | Fixed before merge with two tests: a backup started in a running engine always ends within a bound, with the label git gives, with the engine's memory bounded and health answering | `M66-backup-in-a-running-engine.test.mjs` (last two cases) |

The reviews also recorded findings that were not serious, and design questions for the owner; those are in E37, E41 and E42 and, where they concern a user, in section 7.

## 6. What M1 does not claim beyond the suite

A passing suite supports no claim about behaviour that no test exercises. The not-claimed list (`docs/acceptance/reports/M1-not-claimed.md`) repeats every case of the acceptance plan that the coverage record marks as not written, 33 in all, each with the reason and in one of three classes:

| Class | Cases |
|---|---|
| A, unreachable in M1: no route, fixture or role output can produce the situation | 14 |
| B, real behaviour that no test establishes | 18 |
| C, cannot be observed from outside the engine | 1 |

The class-B cases the Verifier ranked most important for a hands-on run, most important first (the list's own ranking, with the plan row):

1. **The reads that are not built (M70).** A person at the API can see a project's status line, its runs under way, its open decisions and a candidate's latest gate outcomes. They cannot list work items, see why work is parked, see pending git operations, or see why a gate was not satisfied after the fact. A hands-on run will need the database open beside it (section 9 reads what it can from the event stream instead).
2. **The "reject" answers (M49 to M55).** No test exercises a "reject" answer for any of the seven kinds of decision that offer one.
3. **The status line's other causes of "refused" (M70).** For a repository that cannot be read or an unresolved out-of-band change, nothing establishes what the status line says; the slice-6 review saw "waiting on you" for an unreadable repository (E42, carried).
4. **"Adopt" for edits found in the developer's checkout (M25, M46).** Editing a file in the checkout during a run is easy to do by accident, and "adopt" is one of the two answers offered; only "set aside" is tested.
5. **An answer given on an outdated preview, for the facts that are not tested (M45 to M55).** One changed fact per decision kind is tested; the others each kind depends on are not.
6. **A git commit or branch update that hangs while the engine runs (M15), and git output over the cap (M20).** Both depend on the repository and the machine.

The list also names three kinds of thing that are not claimed and are recorded elsewhere: capabilities M1 excludes by design (sessions, deployment, publication, any real backend, the user interface); limits of the test instruments (sections 3, 4 and 8 of this report); and details the tests leave open inside behaviour they do establish, which the coverage record and the seam mark as "not pinned".

## 7. Deferred, by decision

Each of these is a known gap that the owner chose to carry rather than close in M1. What a user would notice is said in plain words.

- **The filter-driver race** (E37 item 5). Engine git disables the filter drivers it finds in a repository's configuration before it runs a command that applies filters, in two steps. A process that rewrites the configuration between those steps gets its driver run. Closing the window inside M1 would mean rewriting the git layer. In M1 the only such process is a role, which runs without isolation and can already do anything the user can; the race is carried to D2, the isolation design, as a named requirement. A user would notice nothing unless a role, or another program with write access to the repository's configuration, raced the engine on purpose.
- **Lease expiry after a pause** (E36 item 6). If the engine stops running for longer than a run's lease lasts (90 seconds by default), for example because the machine slept, every in-flight run is ended as `recovered` when the engine wakes and its work is held for an explicit Resume, even if the role's process was alive and well. The owner decided that a healthy supervised run will survive a pause, but that is built at the start of M2; M1 keeps the strict rule its tests pin. A user whose laptop sleeps during a run will find the run ended and its work held.
- **The Alpha exception for a High finding** (E36 item 5). Only the human owner may approve an exception that lets a High finding not block an Alpha authorization. In M1 the exception enters as test data through a fixture; the approval flow is built in M2. A user cannot grant one through the API in M1.
- **The bootstrap-token question** (E42, a design question not applied). The route that gives a browser page the API token trusts request headers a browser cannot forge but any other local program can. That defeats the token file's permissions for another user of the same machine, and for a role once roles are isolated. The build matches the design as written; it is to be settled with the isolation design, before the UI ships or a real backend runs. A user on a single-user machine would notice nothing; the gap matters once another person or an isolated role shares the machine.
- **Audit growth** (E42, a design question not applied). Every refused request is audited, and nothing limits that: a web page that sends unauthenticated requests makes the store grow by about 1.6 KB per request, at several hundred requests a second. Whether to rate-limit or coalesce the audit is open. A user would notice the store growing under such a page.
- **Git LFS, custom merge drivers and partial clones are unsupported** (E29 item 1, E30 item 3, E37 item 1). Engine git runs no program from a repository's configuration: no filter driver (which Git LFS needs), no merge driver when it rebases, and no fetch from a remote (which a partial clone needs for missing objects). A repository that depends on any of these is not supported in M1: an LFS-managed file would be checked out as its pointer, a custom merge would fall back to git's own, and a missing object would simply be missing.
- **Estimated cost against the budget** (E32 item 4). Whether an estimated cost, as opposed to a reported one, counts against the verified daily spending limit is left open until M2. A user with a budget set would see estimated spend reported beside reported spend without knowing which of the two the limit is judged by.

## 8. Host caveats

The run of section 2 and the whole build were made on one machine, a WSL2 virtual machine, and four things about it bear on how a failure should be read.

- **The wall clock steps.** This machine's wall clock steps back about 1.8 seconds every 30 seconds (a time-sync correction) and jumps forward, by about 15 minutes, when the virtual machine resumes after its host slept (E30, "Timekeeping"; E38). The engine measures every in-process duration on a monotonic clock since slice 3, and the harness's own waits do the same since the pass before the slice-5 build; stored timestamps and lease expiries stay on the wall clock by decision. The run in section 2 shows the step itself: the acceptance suite's own duration, 1,157.8 s on a clock that does not step, is 50 s longer than the shell's wall-clock `real` of 18 m 27 s for a command that also included the unit suite and two builds. Fixing the machine's time synchronisation is the owner's.
- **A host sleep during a run can fail cases legitimately** (E38). Leases and stored timestamps are on the wall clock, so a sleep that outlasts a lease ends in-flight runs (section 7), and a case that was waiting on one then fails for a real reason, not a test defect. Run the suite on a machine that stays awake.
- **Two engines on one machine disturbed each other until E41 item 1.** Through slice 5, an engine reconciling a journal operation killed every git process on the machine that carried another engine's marker, whatever its home. That made test files fail when several ran at once, and it is the likeliest cause of the unexplained one-off failures recorded in E29 item 2 and E36. It is fixed (section 5) and pinned by a case in `M31-git-child-outlives-engine.test.mjs`. The runner still runs files one at a time.
- **The one-off failure of E29 item 2 is unresolved.** After the slice-2 merge the suite failed once on `main`, 190 of 191, and then passed six times in a row; the failing run's output had not been kept. The timing audit of the slice-3 Verifier removed a plausible cause without proving it was the one, and the clock did not jump in that window (E38). Its likeliest cause is the cross-engine kill above (E41 item 1): at the time of that run, a test engine that was reconciling an operation could kill a git child of another test's engine, which would be reported as an unknown or a failed git call. None of those runs was kept, so this is a likelihood and not a finding. Since then the runner keeps every run's full report under `test-results/`, so a failure that does not repeat can still be named. The run of section 2 had no failure.

## 9. Hands-on run

This is the kernel journey of row M01, the same one `packages/engine/test/acceptance/harness/journey.mjs` makes for the two M01 test files, done by hand against a running engine with `curl`. Nothing in it is new: every step is one an earlier row pins by itself, and the fixtures used (the approved baseline and plan, the declared check, the check's execution, the Alpha test target) are the ones the plan says enter M1 as test setup. **The Verifier ran this walkthrough end to end, as the script below, four times on 2026-10-02 against the built engine of the revision in section 2, after the suite had finished; each run ended at the backup with the label `complete`, and the outputs quoted under "what you should see" are from those runs.** (A first attempt stopped at step 3 on a defect in the script's own wait, before the engine had done anything beyond creating the project; the wait was removed.)

The whole walkthrough is in `docs/acceptance/reports/M1-hands-on.sh`, which runs the steps below in order, prints each answer, and stops at the first answer that is not the expected one. The quickest way is to run it whole:

```
cd /home/smahoney/projects/sdlc-x        # a checkout of main at the revision in section 2
npm run build
bash docs/acceptance/reports/M1-hands-on.sh
```

It needs `node`, `git`, `curl` and `jq`, makes everything under one temporary directory (`/tmp/surety-hands-on-XXXXXX`, printed at its start), stops the engine it started, and removes the directory at the end unless `KEEP=1` is set in the environment, in which case the engine home, the repository and the engine's log stay for inspection. `PORT` chooses the API port (default 7301). The steps are repeated here, with what to expect, so they can also be pasted one at a time; paste the helper block first. The blocks are the script's own commands; only its bounded waits are written as plain `until` loops here, so a step that never reaches its expected state would wait rather than stop.

**0. Helpers.** Paste once. `S` is one request with the API token from the engine home (curl adds the `Host` header itself; a client with no `Origin` or `Sec-Fetch-Site` header is an origin-less client and goes on to the token check, SEAM section 89). `events` reads one replay page of the event stream and prints the JSON of every event, one per line. `tick` asks the scheduler to run once; with `tick_interval` at its maximum the engine ticks only when asked, except for the ticks it requests of its own after the commands a tick commits.

```bash
REPO=$PWD; CLI=$REPO/packages/engine/dist/cli.js
WORK=$(mktemp -d /tmp/surety-hands-on-XXXXXX); SURETY_HOME=$WORK/home; SCRIPTED=$WORK/scripted; PROJ_REPO=$WORK/repo
PORT=7301; API=http://127.0.0.1:$PORT
S() { curl -sS -H "X-Surety-Token: $(cat "$SURETY_HOME/api.token")" -H 'Content-Type: application/json' "$@"; }
events() { S "$API/v1/events?since=0&limit=100000" | sed -n 's/^data: //p'; }
tick() { S -X POST "$API/v1/projects/$P/tick" -d '{}'; echo; sleep 1; }
```

**1. A fresh engine home, a scripted-role directory and a disposable repository.** The configuration sets the port, the longest tick interval (so nothing happens that you did not ask for) and short grace periods for ending a role. The scripted role is the harness's own program, `child.mjs`; `scripts/default.json` is the script every launch follows unless the work item has one of its own, and it changes nothing and reports completion, which is what the Verifier does in the journey. The repository holds one commit with the two protected files the checks fixture expects, and its integration branch `main` is checked out nowhere (the developer's checkout is detached), which is the supported topology.

```bash
mkdir -p "$SURETY_HOME" "$SCRIPTED/scripts" "$SCRIPTED/release"
echo "{\"api_port\": $PORT, \"tick_interval\": 600, \"terminate_grace\": 2, \"kill_grace\": 1}" > "$SURETY_HOME/config.json"
cp "$REPO/packages/engine/test/acceptance/harness/scripted/child.mjs" "$SCRIPTED/"
echo '{"steps": [{"result": {"status": "completed", "summary": "scripted role finished"}}]}' > "$SCRIPTED/scripts/default.json"
export GIT_AUTHOR_NAME='Surety Fixture' GIT_AUTHOR_EMAIL='fixture@surety.invalid' GIT_COMMITTER_NAME='Surety Fixture' GIT_COMMITTER_EMAIL='fixture@surety.invalid'
git init -q -b main "$PROJ_REPO" && mkdir -p "$PROJ_REPO/.surety/checks"
printf '# hands-on\n' > "$PROJ_REPO/README.md"
printf '{"protected_paths": [".surety/checks/"], "required_checks": ["login"]}\n' > "$PROJ_REPO/.surety/checks/protected-policy.json"
printf '{"expect": 200}\n' > "$PROJ_REPO/.surety/checks/login.check.json"
git -C "$PROJ_REPO" add -A && git -C "$PROJ_REPO" commit -q -m 'fixture: initial commit' && git -C "$PROJ_REPO" checkout -q --detach
git -C "$PROJ_REPO" log --oneline main
```

You should see one commit, `fixture: initial commit`.

**2. Start the engine in harness mode with the scripted backend.** The engine runs with a constructed environment, as the tests run it (SEAM section 1): the working directory is the engine home and the environment holds only `SURETY_HOME`, `PATH`, `HOME`, `LANG` and `TZ`. `--harness` enters harness mode, which is the only way the scripted backend and the fixture routes exist; `--harness-scripted` names the scripted directory.

```bash
( cd "$SURETY_HOME" && exec env -i SURETY_HOME="$SURETY_HOME" PATH="$PATH" HOME="$SURETY_HOME" LANG=C.UTF-8 TZ=UTC \
    node "$CLI" serve --harness --harness-scripted "$SCRIPTED" > "$WORK/engine.log" 2>&1 ) &
ENGINE_PID=$!
until [ -f "$SURETY_HOME/api.token" ]; do sleep 0.2; done
S "$API/v1/health"; echo
S "$API/v1/engine" | jq '{version, mode, harness, backends, incarnation}'
```

You should see `{"mode":"full"}` (if it says `restricted`, wait a moment and ask again: the engine is still starting), and then `"mode": "full"`, `"harness": true`, `"backends": ["scripted"]` and an incarnation id. The token file `api.token` is readable by you alone.

**3. Create the project through the public route.** `POST /v1/projects` registers the project and commits its identity file, `.surety/project.json`, to the integration branch through the engine's journal.

```bash
CREATED=$(S -X POST "$API/v1/projects" -d "{\"name\": \"hands-on\", \"tier\": \"T2\", \"dev_repo_path\": \"$PROJ_REPO\", \"integration_branch\": \"main\"}")
echo "$CREATED" | jq .; P=$(echo "$CREATED" | jq -r '.project.id')
sleep 2; S "$API/v1/projects/$P" | jq '.project | {id, now, execution, open_decisions, spend_today: {invocations: .spend_today.invocations, no_dispatch: .spend_today.no_dispatch}}'
git -C "$PROJ_REPO" log --oneline main
```

You should see `201` with `"registration_state": "pending_bootstrap"` (or already `"registered"`); then the project read, which is the project's **NOW** state: `"state": "idle"` with the reason "Nothing is under way, nothing waits for you, and no work can be dispatched.", no run, no open decision, `"invocations": 0` and `"no_dispatch": true` (nothing has been launched today, and the engine says so rather than showing zero spend). `git log` shows a second commit, `surety: bootstrap project proj_…`, which adds `.surety/project.json` and nothing else. The event stream (`events | jq -c '{seq, type}'`) shows `project.created` and, after the two journaled git operations, `project.registered`.

**4. Fixtures: the approved baseline and plan, and the declared check.** Both are labelled test setup (every event they cause carries `test_fixture: true`). The plan has one requirement, `R1`, and one stage that implements it; the plan fixture creates the stage's `stage_build` work item. The checks fixture declares the check `login`, covering `R1`, for both gate kinds.

```bash
PLAN=$(S -X POST "$API/v1/harness/fixtures/plan" -d "{\"project\": \"$P\", \"requirements\": [{\"key\": \"R1\"}], \"stages\": [{\"number\": 1, \"goal\": \"the first stage\", \"implements\": [\"R1\"]}]}")
echo "$PLAN" | jq .; STAGE=$(echo "$PLAN" | jq -r '.stages[0].id'); BUILD=$(echo "$PLAN" | jq -r '.stages[0].work_item')
CHECKS=$(S -X POST "$API/v1/harness/fixtures/checks" -d "{\"project\": \"$P\", \"checks\": [{\"key\": \"login\", \"kind\": \"acceptance\", \"gate_kinds\": [\"stage\", \"alpha_authorize\"], \"requirements\": [\"R1\"]}]}")
echo "$CHECKS" | jq .; CHK=$(echo "$CHECKS" | jq -r '.checks[0].id')
S "$API/v1/projects/$P" | jq '.project.now'
```

You should see a plan id, one stage with its `work_item` (`wi_…`), one requirement; then the protected version (`pv_…`) and the check's id (`chk_…`); and NOW is now `"state": "ready"`, `"primary_action": "tick"`, "One work item is eligible and can be dispatched at the next tick."

**5. Script the Builder and ask for a tick.** The Builder's script for the stage's work item writes one file, `src/app.js`, and reports completion. The tick dispatches the work: the engine creates a workspace through the journal, launches the scripted role in it, reads its result, snapshots and validates what it left, commits it and integrates it into `main`. At tier T2 the engine then nominates the integrated commit as a candidate, at the next tick.

```bash
cat > "$SCRIPTED/scripts/$BUILD.json" <<'EOF'
[{"steps": [{"write": {"path": "src/app.js", "content": "export const answer = 42;\n"}},
            {"result": {"status": "completed", "summary": "scripted role finished"}}]}]
EOF
tick
S "$API/v1/projects/$P" | jq '.project | {now, execution}'
until S "$API/v1/projects/$P" | jq -e '.project.execution.runs == []' >/dev/null; do sleep 0.5; done
RUN=$(events | jq -r 'select(.type == "run.ended") | .subject.run' | head -1)
S "$API/v1/projects/$P/runs/$RUN" | jq '.run | {id, state, outcome, reason_class, code}'
git -C "$PROJ_REPO" log --oneline main
tick
until events | jq -e 'select(.type == "candidate.nominated")' >/dev/null 2>&1; do sleep 0.5; done
C=$(events | jq -r 'select(.type == "candidate.nominated") | .subject.candidate' | head -1); echo "candidate: $C"
git -C "$PROJ_REPO" for-each-ref
```

You should see `{"tick":"requested"}`; then either NOW `running` with the run listed under `execution.runs`, or, if the run has already ended (the scripted role is quick), `idle` with no run. The run read shows `"state": "ended"`, `"outcome": "completed"`, `"reason_class": "none"`. `git log` shows a third commit, `w-1 stage_build: the first stage`, on top of the bootstrap commit. After the second tick there is a candidate (`cand_…`), and `for-each-ref` shows `main` and the candidate's own ref, `refs/surety/cand/1`, at the Builder's commit, beside the `refs/surety/keep/…` refs the engine keeps so that a garbage collection cannot remove what the store refers to. The developer's checkout was not touched.

**6. The chain boundary: find the decision in the decisions read and answer it with its preview hash.** The nomination registered the candidate's verification work. At the default `max_chained_roles` of 1, work the engine created from the outcome of a run waits for a person: the engine raises one `blocker` decision offering `continue` and `cancel`. It is found in the decisions read, and answered with the `preview_hash` the read showed; an answer with any other hash is refused as stale.

```bash
until S "$API/v1/projects/$P/decisions" | jq -e '.decisions | length > 0' >/dev/null; do tick >/dev/null; done
S "$API/v1/projects/$P/decisions" | jq '.decisions[] | {id, kind, subject_type, subject_id, question, options: [.options[].key], preview_hash}'
S "$API/v1/projects/$P" | jq '.project.now'
D=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].id'); HASH=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].preview_hash'); VERIFICATION=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].subject_id')
S -X POST "$API/v1/projects/$P/decisions/$D/answer" -d "{\"option\": \"continue\", \"preview_hash\": \"$HASH\"}"; echo
S "$API/v1/projects/$P/decisions" | jq '.decisions'
tick
until events | jq -e "select(.type == \"work.complete\" and .subject.work_item == \"$VERIFICATION\")" >/dev/null 2>&1; do sleep 0.5; done
events | jq -c "select(.subject.work_item == \"$VERIFICATION\") | {seq, type, from: .payload.from, to: .payload.to}"
```

You should see one decision: `"kind": "blocker"`, `"subject_type": "work_item"`, a `subject_id` that is the verification work item, the question "Work item wi_… (verification) was created by the outcome of a run, and the project's max_chained_roles does not let it run without a person. Continue to let the scheduler dispatch it, or cancel it.", the options `continue` and `cancel`, and a 64-character `preview_hash`. NOW is `"state": "waiting_on_you"`, `"primary_action": "answer_decision"`. The answer is accepted: `{"decision":{"id":"dec_…","status":"consumed"}}`, and the decisions read is then `[]`. After the tick the Verifier runs (it follows `default.json`), and the event stream shows the verification work item's path: `work.created` to `eligible`, `work.claimed` to `claimed`, `work.advanced` to `executing`, `run.ended`, `work.complete` to `complete`.

**7. The stage gate before the check's execution is observed: not satisfied.** The gate is evaluated through its public route. An unsatisfied gate is an answer, not an error, so the status is 200 either way.

```bash
S -X POST "$API/v1/projects/$P/candidates/$C/gates/stage" -d "{\"stage\": \"$STAGE\"}" | jq '.evaluation | {outcome, reasons, check_states, stale}'
```

You should see `"outcome": "not_satisfied"` with two reasons, `CHECK_NOT_PASSED` naming the check and `SIGNOFF_MISSING` naming the candidate, and `check_states` showing the check as `missing`: the candidate is built and verified, but no execution of its required check has been observed, and no Reviewer has signed it off, because the engine queues the review only once the check has passed (E36 item 3).

**8. Record the check's execution; the engine queues the review; let it through; the Reviewer signs off.** The execution enters as a fixture (M1 has no check runner). Within the ticks that follow, the engine registers the candidate's `review` work by itself; it is chained work, so it waits at the chain boundary like the verification did. The Reviewer's script reports a sign-off at candidate scope, which is what tier T2 requires.

```bash
S -X POST "$API/v1/harness/fixtures/check-result" -d "{\"project\": \"$P\", \"check\": \"$CHK\", \"candidate\": \"$C\", \"exit_status\": 0}" | jq .
until S "$API/v1/projects/$P/decisions" | jq -e '.decisions | length > 0' >/dev/null; do tick >/dev/null; done
S "$API/v1/projects/$P/decisions" | jq '.decisions[] | {id, kind, subject_type, subject_id, preview_hash}'
REVIEW=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].subject_id')
events | jq -c "select(.type == \"work.created\" and .subject.work_item == \"$REVIEW\") | {seq, type, subject, payload}"
cat > "$SCRIPTED/scripts/$REVIEW.json" <<'EOF'
[{"steps": [{"result": {"status": "completed", "summary": "scripted role finished", "signoffs": [{"scope": "candidate"}]}}]}]
EOF
D=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].id'); HASH=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].preview_hash')
S -X POST "$API/v1/projects/$P/decisions/$D/answer" -d "{\"option\": \"continue\", \"preview_hash\": \"$HASH\"}"; echo
tick
until events | jq -e 'select(.type == "signoff.recorded")' >/dev/null 2>&1; do sleep 0.5; done
events | jq -c 'select(.type == "signoff.recorded") | {seq, type, subject, payload}'
```

You should see the check result (`cr_…`, `"execution_seq": 1`); a second `blocker` decision whose `subject_id` is a new work item; that item's `work.created` event with `"kind": "review"` and no `test_fixture` label, because the engine created it; the answer consumed; and, after the tick, a `signoff.recorded` event naming the candidate, the sign-off and the Reviewer's run, with `"scope": "candidate"`.

**9. The stage gate again: satisfied, and the stage's work completes.** A satisfied stage gate completes the stage's work item in the same transaction (SEAM section 70).

```bash
S -X POST "$API/v1/projects/$P/candidates/$C/gates/stage" -d "{\"stage\": \"$STAGE\"}" | jq '.evaluation | {outcome, reasons, check_states, stale}'
events | jq -c "select(.subject.work_item == \"$BUILD\") | {seq, type, from: .payload.from, to: .payload.to}"
```

You should see `"outcome": "satisfied"`, `"reasons": []`, the check `passed`, `"stale": false`; and the Builder's work item's whole path, ending in `work.complete` from `verifying` to `complete`. In the stream there are now several `gate.evaluated` events: the ones your requests made, and one the engine made itself when it recorded the check's execution and queued the review (that one carried `SIGNOFF_MISSING` alone).

**10. The Alpha authorization for a test target.** A configured test target enters as a fixture. An authorization is proposed for the candidate on it (candidate, environment, artifact digest, configuration identity, exact targets), and the `alpha_authorize` gate is evaluated for that proposal. A satisfied evaluation issues the authorization record. Nothing is deployed.

```bash
ENV=$(S -X POST "$API/v1/harness/fixtures/environment" -d "{\"project\": \"$P\", \"name\": \"alpha\", \"target_set\": [\"alpha-1\"]}" | jq -r '.environment.id')
AUTH=$(S -X POST "$API/v1/projects/$P/candidates/$C/authorizations" -d "{\"environment\": \"$ENV\", \"artifact_digest\": \"sha256:$(printf 'a%.0s' $(seq 1 64))\", \"config_identity\": \"config-1\", \"target_set\": [\"alpha-1\"]}")
echo "$AUTH" | jq .; DAUTH=$(echo "$AUTH" | jq -r '.authorization.id')
S -X POST "$API/v1/projects/$P/candidates/$C/gates/alpha_authorize" -d "{\"authorization\": \"$DAUTH\"}" | jq '.evaluation | {outcome, reasons, check_states, stale}'
events | jq -c 'select(.type == "authorization.issued") | {seq, type, subject, payload}'
```

You should see the proposal answered 201 with `"status": "proposed"`, `"generation": 1`; the evaluation `satisfied` with the check `passed`; and one `authorization.issued` event naming the candidate, the authorization, the evaluation and the environment.

**11. What the API shows at the end.**

```bash
S "$API/v1/projects/$P/candidates/$C" | jq '.candidate | {id, progress, protected_version, successor, gates: (.gates | map_values({outcome, stale}))}'
S "$API/v1/projects/$P" | jq '.project | {now, execution, open_decisions, spend_today: {invocations: .spend_today.invocations, no_dispatch: .spend_today.no_dispatch, usage_incomplete: .spend_today.usage_incomplete}}'
S "$API/v1/projects/$P/decisions" | jq '.decisions'
events | jq -c 'select(.type | test("^(project|run\\.(created|ended)|candidate|decision\\.(raised|consumed)|work\\.(created|complete)|gate\\.evaluated|signoff|authorization)")) | [.seq, .type, (.subject | to_entries | map(.value) | join(" "))]'
git -C "$PROJ_REPO" log --oneline main; git -C "$PROJ_REPO" status --short
```

You should see the candidate `"progress": "developing"` (nothing was deployed), its `protected_version` with `nominated` and `effective` the same version, `"successor": null`, and both gates `satisfied` and not stale. The project is `idle` with no run, no open decision, `"invocations": 3` (the Builder, the Verifier and the Reviewer), `"no_dispatch": false` and `"usage_incomplete": 3`, because the scripted roles reported no usage and the engine does not pretend otherwise. The decisions read is `[]`. The event listing tells the journey in order: `project.created`, `project.registered`, the Builder's `work.created`, `run.created` and `run.ended`, `candidate.nominated`, the verification's `work.created`, the two `decision.raised` and `decision.consumed` pairs, the three runs, `signoff.recorded`, the `work.complete` of all three items, the `gate.evaluated` events and `authorization.issued`; there is no `candidate.advanced`. `git log` shows the three commits and `git status` nothing: runtime data stayed outside tracked source.

**12. Stop the engine and take a backup of its home.** `surety store backup` runs against the engine home while no engine holds it. Its last line on standard output is the backup's directory and its label; the manifest lists the store snapshot, every published record, and per project the commits the snapshot refers to, which it confirmed with git.

```bash
kill -TERM "$ENGINE_PID"; wait "$ENGINE_PID"
( cd "$SURETY_HOME" && env -i SURETY_HOME="$SURETY_HOME" PATH="$PATH" HOME="$SURETY_HOME" LANG=C.UTF-8 TZ=UTC node "$CLI" store backup ) | tee "$WORK/backup.out"
jq '{label, store: .store | {file, bytes}, records: (.records | length), git}' "$(tail -1 "$WORK/backup.out" | jq -r '.backup')/manifest.json"
```

You should see `{"backup":"…/home/backups/<time>-bak_…","label":"complete"}` and a manifest with `"label": "complete"`, the store file and its size, the records (six in the Verifier's runs: a transcript and a result for each of the three roles), and the project's two commits, the bootstrap commit and the Builder's. Then `rm -rf "$WORK"` when you are done.

**What this walkthrough does not do,** so that it is not read as more than the journey: it raises no finding and runs no fix (the fix loop's engine-created work is the question E40 leaves for the owner); it answers no decision with `cancel` or any other negative option; it uses no out-of-band change, no Stop, no Abandon, no crash and no power cut; and it reads work items and gate reasons from the event stream and the gate's own answer, because the reads that would list them are not built (section 6, item 1).

## 10. How to read the suite

- **The runner.** `node scripts/run-tests.mjs acceptance` runs every acceptance file; `--slice N` runs exactly the files `manifest.json` lists for slices 1 to N. `npm run test:unit` runs the Builder's unit tests; `npm test` runs both. The runner builds first, runs one file at a time, and treats a skip, a file with no passing test, a misnamed or unlisted file, or a row with no file as a failure; the exit status is the judgement.
- **Where reports go.** Every run's full report is written under `test-results/` in the working copy (not tracked by git), named `acceptance-<time>.log`, `acceptance-sliceN-<time>.log` or `unit-<time>.log`; on a failure the runner also prints the failing tests' names and the report's path. Each test that measures something prints it as an `ℹ` line in the report (the M68 browser versions and the M71 figures of this report were taken from there).
- **The contract.** `harness/SEAM.md` says in prose what the tests rely on; `contract/*.json` holds the Verifier's expected tables (transitions, journal states, decision manifests, load limits, refused filesystems), derived from the sources and never from the engine. `COVERAGE.md` maps every row to its cases, its files and what was left out.
- **The role boundary.** Each role may write only its own paths: the Verifier `packages/engine/test/acceptance/`, `docs/acceptance/objections/` and `docs/acceptance/reports/`; the Builder `packages/engine/src/`, `migrations/`, `api/` and `test/unit/`, plus objections; the Reviewer nothing. `node scripts/check-role-boundary.mjs <builder|verifier> main <branch>` checks a branch's committed changes against those lists and sees commits only; a Builder never edits an acceptance test, and a disputed test goes through the objection procedure in `docs/acceptance/objections/`.
