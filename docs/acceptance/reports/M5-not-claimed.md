# What M5 does not claim

**Written by:** the Verifier of M5's report, 2026-10-16, on branch `verify/m5-report` from `main` at `a92ceb6`, rebased onto `main` at `93cdfb3`, after the two real runs (M443 7 of 7, M444 8 of 8, at `5bf01a4`), the gate at `a92ceb6` (393 files, 2,113 passed, 5 failed; section 10 of the report) and the exhaustion lane at `a92ceb6` (15 of 15). The final confirming gate, on the final `main` after M66's fixture fix and the report, is erratum E154's. **Status:** the list behind the M5 report's section 22 (row M445; BS5 §13: "what M5 does not claim (`M5-not-claimed.md`, in `M4-not-claimed.md`'s form, starting from D6 §11)"); it decides nothing. An entry whose standing depends on a run names the run and its record; nothing here says a run passed that the M5 report does not record.

The classes are D6 §11's: **class A**, outside the threat model; **class B**, real behaviour no test has yet established, or that M5 does not build; **class C**, a limitation accepted by design. Each entry names its row where one bears on it, and the record that put it here.

## 1. What the real runs do not show

| Entry | Row(s) | Record |
|---|---|---|
| **That Sean made the real runs' human acts.** BS5 §12 names Sean's acts (the approvals, the sessions, the confirmations, the commands). In the acceptance runs of 2026-10-16 every one was made by the driver under Sean's standing instruction ("answer all the questions and approve gates"; "go ahead and start M444"), each logged with those words in `observed/driver-acts.jsonl` (M444's `surety deploy` by a line marked `"reconstructed"` from the store's request row, its original line lost); the store records each answer's actor as `human`, the route, not who. The owner's turns of every session were the driver's words. That a human owner would have answered alike, or that the runs meet "under Sean's command", is not claimed; it is Sean's to say. | M443, M444 | the M5 report, section 17; BS5 §12; E144 item 2 |
| **E153 on a real run.** The real runs ran at `5bf01a4`; the final engine `a92ceb6` adds E153 (a specification change after the final phase schedules a replan). Its code is exercised by M433's new file only. | M433, M443, M444 | the M5 report, section 2 |
| **That M444 ended with nothing open.** The test passed 8 of 8 with the third replan of phase 2 parked (`PLAN_DEPENDENCY_INCOMPLETE` on dependency results still `unknown`) and its blocker open in the store; the driver's two `retry` answers reached no engine. The replan was redundant (its plan already published as generation 2). The gap (M444F-1) is not fixed. | M444 (g) | the M5 report, sections 15, 16 |
| **A clean run at the acceptance revision.** Sean's bar (two consecutive runs with no engine fix, no restart and no driver workaround, E152 item 1) was met by loops 7 and 8 (`295e6a7`), the visual brief's vis1 (`295e6a7`) and a different app's ink2 (`339e116`); not by a run at `5bf01a4` beyond the acceptance lane's one run per journey. | M443, M444 | the M5 report, section 16 |
| **One run per journey is not a claim about a real agent's behaviour.** Real Spec Writers, Architects, Verifiers and Builders followed the packages in these runs after the engine and package fixes of the M5 report's section 16; that a real agent always will is not claimed, and four of the six real Architect replans of M444 were refused. | M442, M443, M444 | SEAM §§455, 456; BS5 §8 |
| **The dress rehearsal** is never evidence: it cannot show the subscription mode, what a real model does with its package, or how long anything takes. | M442 (c) | SEAM §171 |
| **The model observed per run in the pace read.** The ledger records the observed model of every invocation; `runs.model_observed` is never set, and the pace read reports it `unknown`. A known defect carried to M6 (section 6 below). | M441 | the M5 report, sections 18, 24 |
| **Service domains' memory.** The Alpha units' and the adapter qualifications' service domains have no recorded `memory.peak` or admitted maximum on their rows. | M439 | the M5 report, section 19 |
| **The project-lane journeys' pace figures.** The files passed; the reads' figures were not retained. | M401, M436, M441 | the M5 report, section 11 |
| **The token's absence from any conversation.** The runs searched the run directory, the repositories, the units' properties and journals (0 hits), and the report's search of the copied records found none; a conversation through which the value may have passed is outside every searched source. Sean revokes the token. | M443 (g), M444 (h) | the M5 report, section 17 |
| **The hands-on run.** No record of Sean's run of `M5-hands-on.sh`; its form and guards are M446's. | M446 | the M5 report, section 25 |

## 2. D6 §11, class A

| Entry | Record |
|---|---|
| As D2 §8 class A, a compromised operator account included. | D6 §11 |
| An owner who approves a specification he did not read, or an architecture he did not understand: the floor is his approval; the engine shows the parsed index and the check's record, not a judgement of their sense. | D6 §11 |
| A Spec Writer or Architect that writes what the owner asks for when the owner asks for something unwise. | D6 §11 |

## 3. D6 §11, class B: not built in M5

| Entry | Record |
|---|---|
| **Several machines** (E139 item 4): one engine, one host. A second host would need a remote runner contract placing a domain with D2's launcher, init, mount plan and launch authorization reproduced there over an authenticated channel (the launch socket is local today); the objects and context package present at the run's base and the results collected back through the secret screen; per-host envelopes and host qualifications; D4's identity reads on the service's host; secrets delivered to a remote init without a record; the single-writer store on one host, every remote fact a read the engine records with its source. Each a design of its own. | D6 §11; BS5 §13 |
| **Adoption of an already-public repository**, the Mechanic's view of an adopted production, dogfooding Surety on itself. | D6 §8.4, §11 |
| **A repair-before-conformance route** for an adopted project whose unchanged code fails its confirmed baseline (B12; would amend E6). Not taken. | E142 item 3; D6 §12.3 |
| **Independent rebinding of several pending spec-change proposals**: one proposal pending at a time instead. | D6 §4.2 |
| **A general semantic dependency analyzer for adopted tests** (B13): the import boundary is checked, meaning is not. | D6 §8.3 |
| **Sessions on Codex, or on Claude Code by API key**: the real lane is the subscription template. | D6 §11; BS5 §13 |
| **Provider-native session continuation** (Q1 (b)). | D6 §2 |
| **The automated architecture approval** of F §9.2. | D6 §12.2 reading 7 |
| **Evidence reuse across a spec change** beyond the Verifier's recorded applicability assessment: D6 re-runs instead. | D6 §4 |
| **More than one open session per project.** | D6-S08; M419 |
| **Parallel role runs at the engine's 8 GiB default on this workstation**: the per-profile maxima (4 GiB, 2 GiB) are what make more than one possible. | D6 §6.4; E140 N1 |
| **A UI** for sessions and the queue (E14). **Beta, Live, rollback, reattachment, the build execution, remote targets** (D5). | D6 §11; BS5 §13 |
| **The benchmark** (fixtures C and D against Verity's records, after M5; E130 item 9). No cache saving and no throughput figure is claimed (N01). | BS5 §10 |
| **An owner attestation route for human tests**: a human-test requirement is shown `owed`, never verified (the real M443's R6 and R7). | D6 §11 class C; findings #5, #12 |

## 4. D6 §11, class B: not yet established

Each is a measurement §7.6 makes and the benchmark reports, not a property a test can pin (N01). The real runs give one figure each, on one small project per journey (the M5 report, sections 18, 19); none is a claim.

| Entry | What the runs recorded | Record |
|---|---|---|
| That a Spec Writer session ends in a specification an owner approves | two sessions, each approved after 2 turns, the owner's answers the driver's | sections 14, 15, 17 |
| That a retrofit-mode session describes a repository truthfully | 27 claims rows, 11 requirements; two the owner (the driver) called defects | section 15 |
| That an Architect's plan passes the mechanical check first time | both sessions' plans passed at first close; four of six M444 replans were refused | sections 14, 15 |
| That a real stage takes the times §7.2 extrapolates | stages verified 119 s to 281 s after eligible, on one-module stages | section 18 |
| That the provider's cache absorbs any of a re-sent transcript | cached input tokens recorded (3.68 M and 3.66 M); no saving computed | section 18 |
| That a role runs within `role_memory_max` | highest role peak 230.7 MiB of 4 GiB | section 19 |
| That two useful real workloads fit this host at the trial maxima | peak 3 domains at once recorded | section 18 |
| That pipelining shortens a phase | not measured | |

The 4 GiB, 2 GiB and four-domain defaults are trial values (E140), not a capacity measurement.

## 5. D6 §11, class C

| Entry | Record |
|---|---|
| **Judgement:** the plan check proves references, approvals, dependencies and coverage, never that the plan is sensible, the ADRs sound or the stages well cut; a planned criterion with a vacuous check passes D3's classifier. | D6 §11; D3 §6 |
| **The specification's prose:** the engine reads TPL §5's index and the headers; prose it does not read can contradict the index. A `human-test` requirement has no check and is never `verified` by a gate. The Spec Writer did not ask for experience or design criteria in the first real run (findings #17); nothing in the engine requires them. | D6 §11 |
| **Sessions:** the transcript is re-sent each turn; the cache's effect is the provider's; the redactor catches registered forms only, so a secret typed in an unregistered form reaches the provider and the transcript record; an idle timeout saves and closes. | D6 §11 |
| **Pace:** §7.2's figures are from one-file stages; the model's time is the model's. | D6 §11 |
| **Autonomy:** `phase` lets a project spend up to its day budget with no human; the budgets and deadlines are the stop. | D6 §11; D1 §13.3 |
| **Impact analysis** is textual over ADRs and structural over modules; exact over requirement and criterion text, checks, stages and evidence; conservative and shown as uncertain where independence is not established. | D6 §11; B05 |
| **Ordering:** the plan's `depends_on` is the Architect's word; an undeclared dependency shows as a failed check, not a refusal. | D6 §11 |
| **Concurrency:** the envelope counts a domain at its maximum; the per-profile maxima are the owner's trade. | D6 §11 |
| **Retrofit:** an observed requirement the owner confirms is intended because he said so; a `defect` confirmed as intended becomes a requirement a check will pass against a bug; an adopted test is as vacuous as it was written; the adoption signals read names and conventions, not behaviour. | D6 §11; E6 |

## 6. Carried to the report by the runs (not fixed at `a92ceb6`)

**Known defects carried to M6, not fixed in M5** (the driver, 2026-10-17):

| Entry | Record |
|---|---|
| `runs.model_observed` is never set, so the pace read reports `unknown` although the ledger records the model. | the M5 report, section 18 |
| The plan check counts a dependency check result that has not yet run as incomplete and spends a replan's repairs on it (M444F-1). | the M5 report, sections 15, 16 |
| The parked third replan's blocker in M444's store was left open because the runner had already ended. | the M5 report, section 15 |
| The shared seed's engine switch should wait for live runs (the mechanism behind M401 (h)'s failure at `5bf01a4`, fixed test-side at `93cdfb3`, SEAM §472). | the M5 report, section 10 |
| The store's `engine_version` reads `0.0.0`: a run's revision comes from the runner's header, not the store. | the M5 report, section 2 |

**Other gaps the findings file records:**

| Entry | Record |
|---|---|
| Check authoring for criteria a requested specification change names does not wait for that change (#18). | findings file |
| Authoring and correction of one check can run concurrently, paid twice (#19; L1-2's root, its classification fixed at `dc899f3`). | findings file |
| Replans of one phase are not coalesced when a later one already planned against the newer specification (#20). | findings file |
| A defect whose verifying check comes in a later phase is offered only `accept` (L1-3). | findings file |
| A missing kind with nothing pending, and Alpha waiting on a lapsed adapter qualification, wait without a notice (#6, #15). | findings file |
| A superseded phase verification is not retired (INK-2); a redundant disposition question after the owner's accept (INK2-2). | findings file |
| The Spec Writer reads `phase_size` as a cap on requirements per phase (V2 note). | findings file |
| **The host's clock steps** after `wsl --shutdown`; wall-clock timestamps are no more exact than it; durations are monotonic. | BS5 §4.1 rule 17; M4's entry |
| **The workstation's systemd changes under unattended upgrades** (255.4-1ubuntu8.17 to 8.18 on 2026-10-16); a changed host mechanism makes trust entries stale (fixed to hold and ask, `f7a3e5c`); the claim is for the versions the report records. | the M5 report, sections 3, 16 |

## 7. Carried from earlier milestones, not re-planned

`M4-not-claimed.md` stands, unchanged by M5, except where M5 builds what it listed as not built: sessions and the interactive roles (E119) and automatic deployment (Q3, now `alpha_deploy: on_phase_complete` at D4's request layer, K9) are built and claimed as the M5 report's section 1 states. M4's open items stay carried (BS5 §14): E134 item 6 (the 56-byte home; the acceptance home was 28 bytes), E132 item 10 and E133 item 5, E125 to E134's readings, E94 item 5, E106, E50, E51, E53 to E55. The M1 to M4 instrument limits stand. **Open, intermittent:** at `5bf01a4` the split gate failed `M15-run-end-fault-matrix` (one case), `M440-a-storm-of-completions` (e1), (e5) and `M401-the-journey-from-phase-two-to-alpha` (h), none rerun alone there; M401 (h) was a test's timing assumption, fixed at `93cdfb3`; M15 and M440 did not fail at `a92ceb6`. At `a92ceb6` the split gate failed M29, M430 S2 and M450, each passing alone three times. **`M66-backup-and-restore`** fails one case at its fixture step on `mini-hp01` (git 2.55.0), at `5bf01a4` and `a92ceb6` alike, and passes on the workstation (git 2.43.0): a fixture problem specific to that host's git, fix in progress (`verify/m66-prune-fixture`); nothing is claimed of M66 on `mini-hp01` until it passes there (the M5 report, section 10).
