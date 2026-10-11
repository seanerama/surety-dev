# Surety M4 acceptance report

**Status:** skeleton. **M4 is not accepted.** Nothing below that a run must supply has been run for this report: each such fact is a placeholder `[[PENDING <label>: not yet run; from <source>]]`, filled only from the record named, after the run; a fact no record holds is to be said not run or unknown, never filled. The acceptance run (`npm test` on `main`), the adapter's qualification by Sean's command, the exhaustion lane on `mini-hp01`, the real lane (M342) and the hands-on run (M344) have not been made.

**Written by:** the Verifier of M4 slice 30, 2026-10-11, on branch `verify/m4-s30` from `main` at `f83c2b1` (slice 29's cases merged; slice 29's Builder, `build/m4-s29` at `fdee5c9`, not yet merged; its gate running). **For:** Sean, the owner, before and after the acceptance run, the exhaustion-lane run, his real run (M342) and his hands-on run (M344); and Astra. **Form:** the M3 report's (`M3-report.md`), with BS4 §13's contents; what M4 does not claim follows `M1-not-claimed.md`, starts from D4 §11 and is kept in `M4-not-claimed.md`. It decides nothing.

The sources it cites: the **build specification** (`docs/spec/M4-build-spec.md`, cited BS4); the **acceptance plan** (`docs/acceptance/sdlc-M4-acceptance-plan.md`, rows M301 to M344); **D4** (`docs/design/sdlc-design-D4-deployment.md`, draft 2, approved E120); the **errata** (E-numbers, `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`); the **coverage record** (`packages/engine/test/acceptance/COVERAGE.md`); the **seam** (`packages/engine/test/acceptance/harness/SEAM.md`, cited "SEAM §n"). The real lane's records, once it has run, are copied to `docs/acceptance/reports/M4-real-lane/<date>/` (BS4 §12; SEAM §336).

## 1. What M4 claims and does not claim

M4 is Alpha deployment on one target, `local_service`, of D4 draft 2 on this WSL2 host (BS4 §1). If accepted, it supports one claim: **on this host, with the recorded versions and limits, the engine deployed a candidate it had sealed from the object store only under an authorization it derived itself and a gate that could be met; created, stopped and removed only units and resources it had positively recorded for the environment; treated every adapter receipt as a claim and decided every effect by a complete read of the target; identified the running application by its original instance and the tree it was started from, never by the application's account of itself; verified a deployment only by two bracketing identity reads and the passing of required post-deploy checks it ran itself, all bound to one round of the current generation; advanced the candidate to `alpha_deployed` only through a satisfied `alpha_complete`; and after a crash kept a surviving service running with its supervision `unknown`, verified nothing on it and published none of its output.** It does not support the claims that a post-deploy check tests the behaviour it covers (D4 §5.4, §11 class C), that the engine can reattach to a service after a restart, roll back, build or install dependencies, deploy anywhere but this host, or deploy to Beta or Live (BS4 §1; section 18).

BS4 §1's conditions, and where each stands at the time of writing:

| Condition | State |
|---|---|
| `npm test` exits zero on `main` for the kernel, sandbox and project lanes, every M4 row (M301 to M344) with executable tests and none skipped, the M1 to M3 rows passing, the C.2 migrations recorded | [[PENDING cond-npm-test: not yet run; from the driver's full `npm test` on main after slice 30]]. M343 (b), this report's own case, fails by design while this report is a skeleton (SEAM §338) |
| `surety qualify-adapter local_service` passed on this host by Sean's command: an `adapter_qualifications` row `current` with every case and its control `passed`, with its evidence (M338) | [[PENDING cond-qualify: not yet run; from Sean's `qualify-adapter` in the real run's home, `observed/M342.json` (`qualification`)]] |
| Row M341's exhaustion-lane file passed on the designated host (E69) | [[PENDING cond-exhaust: not yet run; from the driver's `--lane exhaust` on mini-hp01]] |
| The real-lane row M342 passed under Sean's command (E95 Q10), its records retained | [[PENDING cond-real: not yet run; from Sean's real run, `docs/acceptance/reports/M4-real-lane/<date>/`]] |
| The M4 acceptance report written (BS4 §13) | this report, a skeleton |
| Sean has run the hands-on script (M344), if he chooses it | [[PENDING cond-hands-on: not yet run; from Sean's run of `M4-hands-on.sh`]] |

## 2. Revisions

| What | Revision |
|---|---|
| The tree this skeleton was written on | `main` at `f83c2b1` (slice 29's cases and objection 052 merged) |
| Slice 23, the walking deployment | merged at `3450b4e`; the driver's `--slice 23` on `b2480c2`, 1,319 of 1,319 (E125 item 1) |
| Slice 24, deploy and identify | merged at `8406639`; `--slice 24` on `273fb9e`, 1,375 of 1,375 (E127 item 1) |
| Slice 25, verify behaviourally | merged at `ac583ab`; `--slice 25` on `38e41e5`, 1,419 of 1,419 (E128 item 1) |
| Slice 26, crash and recover | merged at `18dcf71`; `--slice 26` on `76f24f4`, 1,483 of 1,485, M74 fixed at `cc0cba0` and M125 (i) intermittent (E129 items 1, 10) |
| Slice 27, tear down and observe | merged at `12ca17a`; `--slice 27` on `eb970a3`, 1,529 of 1,529 (E130 item 1) |
| Slice 28, secrets and authority | merged at `a9da084`; `--slice 28` on `fe7c331`, 1,566 of 1,566 in 273 files (E131 item 1) |
| Slice 29, qualification and the reference project | the cases at `f83c2b1`; the Builder's `build/m4-s29` at `fdee5c9`; [[PENDING rev-s29: not yet run; from the driver's slice-29 gate and merge]] |
| Slice 30, the end of M4 | these cases on `verify/m4-s30`; [[PENDING rev-s30: not yet run; from the driver's slice-30 gate and merge]] |
| The revision the acceptance run ran (tests, contract and engine) | [[PENDING rev-acceptance: not yet run; from the driver's full `npm test`]] |
| The revision the real lane ran | [[PENDING rev-real: not yet run; from Sean's real run and the primary checkout's reflog]] |
| The contract files | `packages/engine/test/acceptance/contract/` at the same revision as the tests |

## 3. The host

As the driver read it on 2026-10-09 for the probe's confirmation (E122 item 1), and as the acceptance run's host qualification is to record it:

| What | Value |
|---|---|
| `host_id` (`/etc/machine-id`) | [[PENDING host-id: not yet run; from the real lane's `observed/attempt.json`, `host`]] |
| Kernel | `6.6.87.2-microsoft-standard-WSL2` (E122 item 1); at the acceptance run [[PENDING host-kernel: not yet run; from the active host qualification]] |
| WSL2 | yes |
| Distribution | [[PENDING host-distribution: not yet run; from `observed/attempt.json`, `host`]] |
| systemd | 255 (255.4-1ubuntu8.17) (E122 item 1); at the acceptance run [[PENDING host-systemd: not yet run; from the qualification's evidence, `tools`]] |
| `systemd-run` and `systemctl`: paths and versions | [[PENDING host-tools: not yet run; from the qualification's evidence, `tools` (SEAM §322)]] |
| Node (the engine's and the reference service's runtime, pinned by path and hash) | [[PENDING host-node: not yet run; from the active host qualification and the configuration's `runtime`]] |
| git | [[PENDING host-git: not yet run; from `observed/attempt.json`, `host`]] |
| SQLite (through `better-sqlite3`) | [[PENDING host-sqlite: not yet run; from the Verifier's reading at the acceptance run (the real run does not record it)]] |
| util-linux, `ip` | [[PENDING host-util-linux: not yet run; from the active host qualification]] |

## 4. The backend (the real lane only)

M4's kernel, sandbox and project lanes run no backend (scripted roles). The real row M342 runs Claude Code on Sean's subscription token (E74), a new token (BS4 §12, "Before it").

| What | Value |
|---|---|
| The binary qualified: path, SHA-256, `--version` | [[PENDING backend-binary: not yet run; from `observed/attempt.json`, `source_binary`]] |
| The entry, its attempt, its activation | [[PENDING backend-entry: not yet run; from `observed/activation.json`]] |
| Model | `claude-sonnet-5-5` (E59), as the harness asks; [[PENDING backend-model: not yet run; from the ledger's `model_observed`]] |
| Auth mode | `subscription_token` (E74 item 1) |

## 5. The host qualification and the runner self-test

M4 adds no host requirement: the user service manager is already H3's (D4 §9.4; BS4 §4). The runner self-test (D3 §2.8; SEAM §208) qualifies `direct` at every start of the real lane's home and of the project lane's engines.

| What | Value |
|---|---|
| The host qualification row at the acceptance start, its mechanism fingerprint | [[PENDING hq-row: not yet run; from the real lane's home]] |
| H1 to H12, H13 | [[PENDING hq-checks: not yet run; from the same row]] |
| `check_runner.qualified`, no fixture label, every case and control | [[PENDING hq-self-test: not yet run; from the same row]] |

## 6. The probe's confirmation

The feasibility probe of 2026-10-07 (`docs/reviews/D4/feasibility-probe-2026-10-07/`) ran with stand-ins, not D2's launcher, init or authorization (D4 preamble). **E122** (decided by Sean, 2026-10-09; BS4 §§9.1, 10; E95) records its confirmation: the host unchanged (kernel 6.6.87.2, systemd 255.4, the probe's versions; no new probe), nothing in the log contradicting D4 §9.2 or §3.4, every claim not established naming the M4 row that establishes it (D4 §11 class B), and the domain cgroup the unit's own (E121 item 4, question 1). The probe and the adapter qualification are kept apart (AR N03): the probe is feasibility only, never a qualification.

## 7. The adapter qualification

By `surety qualify-adapter local_service` (D4 §2.6, A.8; SEAM §§322, 323), in the real run's home, by Sean's command (question 6). Its nine cases, in D4 A.2's order, each beside its control:

| Case | What it shows (D4 §2.6) | Result and control |
|---|---|---|
| `deploy_read_back` | a fixture artifact deployed through the real launcher, init and launch authorization, read back from the target | [[PENDING aq-deploy_read_back: not yet run; from the row's `cases`]] |
| `replace` | a second generation replaces the first; one generation runs at a time | [[PENDING aq-replace: not yet run; from the row's `cases`]] |
| `receipt_lost` | a lost receipt, settled by reconcile from the target in one engine process | [[PENDING aq-receipt_lost: not yet run; from the row's `cases`]] |
| `not_issued` | an effect not issued, read absent | [[PENDING aq-not_issued: not yet run; from the row's `cases`]] |
| `late_launcher` | a launcher asking after its attempt's launch was closed runs nothing | [[PENDING aq-late_launcher: not yet run; from the row's `cases`]] |
| `out_of_band` | a manual restart: its launcher refused, the change recorded out of band | [[PENDING aq-out_of_band: not yet run; from the row's `cases`]] |
| `unreadable` | a missing bus address: every read `unknown`, nothing created | [[PENDING aq-unreadable: not yet run; from the row's `cases`]] |
| `refused` | each forged capability refused by `adapterCall`, naming its member | [[PENDING aq-refused: not yet run; from the row's `cases`]] |
| `teardown` | an exact teardown, applied; nothing of the qualification's prefix left | [[PENDING aq-teardown: not yet run; from the row's `cases`]] |

| What | Value |
|---|---|
| The row: id, `status` `current`, `label` null, `adapter_version`, `engine_build`, its host qualification | [[PENDING aq-row: not yet run; from `observed/M342.json`, `qualification.row`]] |
| The `service` profile's fingerprint (`profile_fingerprint`) | [[PENDING aq-profile: not yet run; from the same row]] |
| The evidence record (`qualification_evidence`): the host tools' paths and versions | [[PENDING aq-evidence: not yet run; from the evidence's `tools` (`systemd-run`, `systemctl`, each its path and version)]] |
| Still current at the deployment's start (E131 item 9: matched on the host qualification's content) | [[PENDING aq-current: not yet run; from `observed/M342.json`, `deploy.qualification_at_start`]] |
| What the slices ran | M338's sandbox files qualify the adapter in each test's own disposable home (slice 29); [[PENDING aq-slices: not yet run; from the driver's slice-29 gate]] |

## 8. The configuration in force, the numeric values and CD1 to CD4

As adopted with BS4 (**E121**, Sean, 2026-10-09):

| Key or decision | As approved | Pinned by |
|---|---|---|
| `deploy_orchestration_deadline` | 1,800 s (range 300 to 10,800) | M325 |
| `artifact_max_entries` | 20,000 | M309 (f), M311 (h) |
| `artifact_max_bytes` | 256 MiB | M309 (f), M311 (h) |
| `artifacts_max_bytes` | 2 GiB, never evicted (question 7) | M309 |
| `artifact_prepare_deadline` | 600 s | M309 (f) |
| `adapter_read_deadline` | 10 s, kept; measured (section 9) and returned to Sean if a read takes more than half of it | M311 (h), M338 (g) |
| CD1 | a re-verification after the orchestration deadline has its own durable deadline and retakes the environment lease | M325 (f) |
| CD2 | a service whose supervision is `unknown` never reads `healthy`: `degraded`, detail `supervision_unknown` | M329 (e) |
| CD3 | a kill between the launch grant and the init's `started` report stays `unknown`; the way out is preempting teardown and a new request | M321 (g) |
| CD4 | stable process title and arguments are a requirement of the service (the template and the Builder's package), no engine change | M311 (g) |

D4 A.7's other values stand as decided (Q6, Q9): `identity_observation_every` 10, `observation_cadence` 30 s, the `service_link_*` keys as D2's `egress_*`. The configuration in force at the real run (the environment `alpha`'s content, written by the runner through the owner's route): [[PENDING config-real: not yet run; from `observed/M342.json`, `deploy.config`]]. Every other engine key at its default unless the run's `config.json` sets it: [[PENDING config-keys: not yet run; from the real run's home]].

## 9. Identity-read durations and the qualification's host time

D4 §11 class B asks for both: Q6's figures are starting caps, not measurements.

| What | Value |
|---|---|
| The qualification's host time (`host_time_ms`, monotonic, SEAM §333) | [[PENDING dur-host-time: not yet run; from the qualification's evidence]] |
| Every identity read of the qualification (`identity_reads[].duration_ms`), the slowest against half of `adapter_read_deadline` (5,000 ms) | [[PENDING dur-reads: not yet run; from the qualification's evidence]] |
| M311 (h): the read at `artifact_max_entries` small files and at `artifact_max_bytes` bytes | slice 24's figures, by E127 item 8: about 270 ms at 20,000 entries and about 235 ms at 256 MiB, after `273fb9e`; at the acceptance run [[PENDING dur-m311h: not yet run; from the acceptance run's `# note:` lines]] |
| The real deployment's two identity reads | [[PENDING dur-real: not yet run; from `observed/M342.json`, `deploy.verification.identity_reads`]] |

## 10. Every Appendix C statement, its row and its result

The 63 statements of D4 Appendix C (A 9, I 8, O 14, V 9, N 6, S 5, R 2, T 10), each with the row that pins it (plan §4.1) and that row's lane (plan §3). "Last recorded" is the latest gate that ran the row's files: the driver's `--slice 28` on `fe7c331` (E131 item 1: 1,566 of 1,566 in 273 files, none failed, cancelled or skipped), which ran every file of slices 1 to 28; slice 29's files have not passed a gate yet. The acceptance column is the full `npm test` on `main`, with the exhaustion lane on `mini-hp01` for D4-T05 and Sean's real run for D4-T04.

| Statement | Row | Lane | Last recorded | Acceptance run |
|---|---|---|---|---|
| D4-A01 | M304 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-A01: not yet run; from the acceptance run on main]] |
| D4-A02 | M304 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-A02: not yet run; from the acceptance run on main]] |
| D4-A03 | M320 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-A03: not yet run; from the acceptance run on main]] |
| D4-A04 | M320 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-A04: not yet run; from the acceptance run on main]] |
| D4-A05 | M335 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-A05: not yet run; from the acceptance run on main]] |
| D4-A06 | M338 | sandbox, kernel | [[PENDING last-D4-A06: not yet run; from the driver's slice-29 gate]] | [[PENDING acc-D4-A06: not yet run; from the acceptance run on main]] |
| D4-A07 | M338 | sandbox, kernel | [[PENDING last-D4-A07: not yet run; from the driver's slice-29 gate]] | [[PENDING acc-D4-A07: not yet run; from the acceptance run on main]] |
| D4-A08 | M336 | kernel, sandbox | passed, `--slice 28` on `fe7c331` (E131), but (c) outside harness mode, a case of `M338-qualify-adapter-by-command` (slice 29): [[PENDING last-D4-A08: not yet run; from the driver's slice-29 gate]] | [[PENDING acc-D4-A08: not yet run; from the acceptance run on main]] |
| D4-A09 | M334 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-A09: not yet run; from the acceptance run on main]] |
| D4-I01 | M308 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-I01: not yet run; from the acceptance run on main]] |
| D4-I02 | M309 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-I02: not yet run; from the acceptance run on main]] |
| D4-I03 | M302 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-I03: not yet run; from the acceptance run on main]] |
| D4-I04 | M303 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-I04: not yet run; from the acceptance run on main]] |
| D4-I05 | M311 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-I05: not yet run; from the acceptance run on main]] |
| D4-I06 | M308 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-I06: not yet run; from the acceptance run on main]] |
| D4-I07 | M309 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-I07: not yet run; from the acceptance run on main]] |
| D4-I08 | M309 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-I08: not yet run; from the acceptance run on main]] |
| D4-O01 | M305 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O01: not yet run; from the acceptance run on main]] |
| D4-O02 | M306 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O02: not yet run; from the acceptance run on main]] |
| D4-O03 | M321 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O03: not yet run; from the acceptance run on main]] |
| D4-O04 | M322 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O04: not yet run; from the acceptance run on main]] |
| D4-O05 | M323 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O05: not yet run; from the acceptance run on main]] |
| D4-O06 | M323 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O06: not yet run; from the acceptance run on main]] |
| D4-O07 | M325 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O07: not yet run; from the acceptance run on main]] |
| D4-O08 | M318 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O08: not yet run; from the acceptance run on main]] |
| D4-O09 | M326 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O09: not yet run; from the acceptance run on main]] |
| D4-O10 | M327 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O10: not yet run; from the acceptance run on main]] |
| D4-O11 | M326 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O11: not yet run; from the acceptance run on main]] |
| D4-O12 | M325 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O12: not yet run; from the acceptance run on main]] |
| D4-O13 | M325 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O13: not yet run; from the acceptance run on main]] |
| D4-O14 | M319 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-O14: not yet run; from the acceptance run on main]] |
| D4-V01 | M315 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-V01: not yet run; from the acceptance run on main]] |
| D4-V02 | M314 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-V02: not yet run; from the acceptance run on main]] |
| D4-V03 | M316 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-V03: not yet run; from the acceptance run on main]] |
| D4-V04 | M317 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-V04: not yet run; from the acceptance run on main]] |
| D4-V05 | M317 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-V05: not yet run; from the acceptance run on main]] |
| D4-V06 | M305 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-V06: not yet run; from the acceptance run on main]] |
| D4-V07 | M303 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-V07: not yet run; from the acceptance run on main]] |
| D4-V08 | M318 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-V08: not yet run; from the acceptance run on main]] |
| D4-V09 | M315 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-V09: not yet run; from the acceptance run on main]] |
| D4-N01 | M328 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-N01: not yet run; from the acceptance run on main]] |
| D4-N02 | M329 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-N02: not yet run; from the acceptance run on main]] |
| D4-N03 | M331 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-N03: not yet run; from the acceptance run on main]] |
| D4-N04 | M331 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-N04: not yet run; from the acceptance run on main]] |
| D4-N05 | M329 | kernel, sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-N05: not yet run; from the acceptance run on main]] |
| D4-N06 | M328 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-N06: not yet run; from the acceptance run on main]] |
| D4-S01 | M332 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-S01: not yet run; from the acceptance run on main]] |
| D4-S02 | M332 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-S02: not yet run; from the acceptance run on main]] |
| D4-S03 | M333 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-S03: not yet run; from the acceptance run on main]] |
| D4-S04 | M333 | kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-S04: not yet run; from the acceptance run on main]] |
| D4-S05 | M334 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-S05: not yet run; from the acceptance run on main]] |
| D4-R01 | M336 | kernel, sandbox | passed, `--slice 28` on `fe7c331` (E131), but (c) outside harness mode, a case of `M338-qualify-adapter-by-command` (slice 29): [[PENDING last-D4-R01: not yet run; from the driver's slice-29 gate]] | [[PENDING acc-D4-R01: not yet run; from the acceptance run on main]] |
| D4-R02 | M336 | kernel, sandbox | passed, `--slice 28` on `fe7c331` (E131), but (c) outside harness mode, a case of `M338-qualify-adapter-by-command` (slice 29): [[PENDING last-D4-R02: not yet run; from the driver's slice-29 gate]] | [[PENDING acc-D4-R02: not yet run; from the acceptance run on main]] |
| D4-T01 | M310 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-T01: not yet run; from the acceptance run on main]] |
| D4-T02 | M313 | sandbox, project | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-T02: not yet run; from the acceptance run on main]] |
| D4-T03 | M339 | project | [[PENDING last-D4-T03: not yet run; from the driver's slice-29 gate]] | [[PENDING acc-D4-T03: not yet run; from the acceptance run on main]] |
| D4-T04 | M342 | real | [[PENDING last-D4-T04: not yet run; from Sean's real run]] | [[PENDING acc-D4-T04: not yet run; from Sean's real run of M342, on main]] |
| D4-T05 | M341 | exhaust | [[PENDING last-D4-T05: not yet run; from the driver's --lane exhaust on mini-hp01]] | [[PENDING acc-D4-T05: not yet run; from the driver's --lane exhaust on mini-hp01, on main]] |
| D4-T06 | M322 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-T06: not yet run; from the acceptance run on main]] |
| D4-T07 | M324 | sandbox, kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-T07: not yet run; from the acceptance run on main]] |
| D4-T08 | M324 | sandbox, kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-T08: not yet run; from the acceptance run on main]] |
| D4-T09 | M324 | sandbox, kernel | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-T09: not yet run; from the acceptance run on main]] |
| D4-T10 | M337 | sandbox | passed, the driver's `--slice 28` gate on `fe7c331` (E131) | [[PENDING acc-D4-T10: not yet run; from the acceptance run on main]] |
Rows beyond Appendix C: M301 and M307 (the journeys, E40), M312, M330 and M340 (E120 item 2), M343 (this report), M344 (the hands-on); their results are section 13's.

## 11. The C.2 migrations

D4 Appendix C.2's accepted rows, migrated by the Verifier of slice 23 and recorded in COVERAGE.md under the correction that causes each (E118 item 1), none a weakening, each former insufficient case pinned as refused:

| Row | Correction | Change |
|---|---|---|
| M08 | deployment enabled | its "deploy" refusal narrowed; the refusals of publish, export and the other excluded paths kept |
| M01, M44 | J3, J4 | their shared gate fixtures gain labelled qualification facts, an identity method and a required `post_deploy_behavior` check (`alphaTarget`, SEAM §§248, 254); M44's single issuance preserved |
| M140 | J3, J4 | M2's real-lane project gains the same if it reaches an Alpha authorization: rewritten, not rerun (BS4 §9.2), so not claimed as rerun |
| M112 to M118, M216 | J2 | none changed; mixed-owner recovery added as M324 (f) |

Their results at the acceptance run: [[PENDING c2: not yet run; from the full `npm test` on main]].

## 12. The reference project and the Switchboard mutant (project lane)

The reference project (`harness/project/service.mjs`; SEAM §325): a dependency-free Node HTTP service, its library tested by M3's wrapper, and a required `post_deploy_behavior` check of the user operation GET /sum?a=2&b=3. M339 runs it through D4 §1 on a real unit with no stand-in; M340 shows the Switchboard mutant (health and identity pass, the operation fails) refused completion, and a check that only probes health passing it, a LIMITATION (D4 §5.4, §11 class C).

| Case | Observed |
|---|---|
| M339, the journey | [[PENDING ref-m339: not yet run; from the driver's slice-29 gate and the acceptance run]] |
| M340 (a), (b), the mutant and its fix | [[PENDING ref-m340: not yet run; from the same]] |
| M340 (c), a health-only check: **a LIMITATION, never evidence** | [[PENDING ref-m340c: not yet run; from the same]] |

## 13. The kernel, sandbox and project lanes on this host

| Run | Revision | Result | Source |
|---|---|---|---|
| The driver's `--slice 23` to `--slice 28` | section 2 | section 2 | E125, E127 to E131 |
| The driver's `--slice 29` | `fdee5c9` | [[PENDING lanes-s29: not yet run; from the driver's gate]] | the driver's run |
| The driver's `--slice 30` (M342's free halves, M343, M344) | [[PENDING lanes-s30-rev: not yet run; from the driver's gate]] | [[PENDING lanes-s30: not yet run; from the driver's gate (M343 (b) fails by design while this report is a skeleton)]] | the driver's run |
| The full `npm test` | [[PENDING lanes-full-rev: not yet run; from the driver's run]] | [[PENDING lanes-full: not yet run; from the driver's run]] | the driver's run |
| The rule-7 check around each run (no `surety-*` unit left) | each run | [[PENDING lanes-rule7: not yet run; from the runner's own report]] | E121 item 5 |

## 14. The exhaustion lane

Row M341, a service at its memory and task limits (D4-T05; SEAM §326): `M341-a-service-at-its-limits.test.mjs`, manifest `exhaust`, run only on `mini-hp01` with `SURETY_EXHAUSTION_HOST` set; off that host its one case fails `not_exercised`, never a skip. [[PENDING exhaust-m341: not yet run; from the driver's `--lane exhaust` on mini-hp01]].

## 15. The real lane's run (M342)

By Sean's command, on his subscription token, under his approvals and his own two commands (BS4 §12; `docs/acceptance/reports/M4-real-lane/README.md`). Expected under 1 USD in Claude Code's estimates; an estimate, not a cap (D4 §9.4).

| File | Rows | Spends | Date | Outcome |
|---|---|---|---|---|
| `M342-the-real-deployment-journey` | M342 (a) to (d) | [[PENDING real-spend: not yet run; from the run directory's ledger]] | [[PENDING real-date: not yet run; from `state.json`]] | [[PENDING real-outcome: not yet run; from `runner.log` and `state.json`]] |

The dress rehearsal (SEAM §171, the fake `claude`; never evidence): [[PENDING real-rehearsal: not yet run; from the rehearsal's run directory]].

## 16. The real deployment journey

| What | Value |
|---|---|
| (a) The checks a real Verifier wrote: its run, the proposal, its class, Sean's answer, the version, its workspace checks and its `post_deploy_behavior` check | [[PENDING journey-a: not yet run; from `observed/M342.json`, `checks`]] |
| (b) The service a real Builder built: the candidate, every execution with its domain and qualification, the stage gate, the Alpha authorization gate | [[PENDING journey-b: not yet run; from `observed/M342.json`, `build` and `deploy.request`]] |
| (c) Sean's two commands; the unit read from the host; the round, both identity reads, the check through the link; `verified`; `alpha_deployed` | [[PENDING journey-c: not yet run; from `observed/M342.json`, `qualification` and `deploy`]] |
| (d) The teardown; what was left; no result from a fixture; the token's absence (files, git objects, unit properties, journal output) | [[PENDING journey-d: not yet run; from `observed/M342.json`, `teardown` and `key_search`]] |

What stays a fixture in the real journey, labelled (SEAM §336): the approved plan with its texts and index (spec approval is not built) and the first `check_correction`'s trigger. No check result and no qualification.

## 17. Cases reported `not_exercised`

Each passes by asserting the host fact and its reason, and is **never counted as passed** (plan §2.5):

- **M341**, a service at its limits, is `not_exercised` off the designated host (E69; SEAM §326): its file runs only on `mini-hp01` (section 14).
- **M342**, the real row, is `not_exercised` only if Sean does not run it (plan §2.5); [[PENDING notex-m342: not yet run; from Sean's real run]].
- Carried from M2 and M3: the observer cases M112 (g), M116 (d), M124 (e), M128 (g), M135 (j) (H13 not exercised); M115 (f) and M115 (h); P20 on this workstation (exercised on `mini-hp01`); the self-test's `foreign_signal` when the engine cannot re-verify its own program.
- **Not written, and so not claimed** (`M4-not-claimed.md`): M315 (b) `later_attempt` (unreachable as designed; E128 item 6); M329 (b)'s "some running" (one target, X2; E130 item 4).

## 18. What M4 does not claim

In the form of `M1-not-claimed.md`, from D4 §11; every entry is listed with its row and erratum in `docs/acceptance/reports/M4-not-claimed.md`.

**D4 §11, class A** (outside the threat model): as D2 §8 class A, a compromised operator account included; a post-deploy check the Verifier wrote to pass whatever the service does (D3 §6); a change to the service manager's state by the operator's own account while the engine is down, beyond what the next read shows.

**Class B, not yet established**, each with the case that establishes it: D2's launcher, init and constructed root in a service unit, launch authorization, the init's report against the host read, the original identity against pid reuse (`deploy_read_back`, D4-T01, D4-I05); the single-use launch under a restart (`out_of_band`, D4-T06); child cgroups under `Delegate=yes`, the immutable pathname, the control channel's isolation (D4-T01, D4-V02); the unit surviving an engine incarnation scope's death and recovery with a real service domain (D4-O03 sandbox, D4-T07 to D4-T09); the qualification's host time and Q6's headroom (section 9); **behaviour across a restart of the user's service manager or of the host**: not attempted and not claimed unless separately exercised. Their acceptance results are section 10's.

**Class B, not built in M4:** **reattachment after an engine restart** and with it the recovery of a surviving service's old secret versions (E110, E116; D5 with Live); **the build execution**: a compiled or dependency-installing project is not supported (Q4); any adapter but `local_service` and any remote or container target; **Beta and Live** (Q1); **rollback** (Q8): teardown and a new authorized deployment are not a tested recovery plan; **enduring effects** of deleted modules **on a stateful target** (X2).

**Class C, verbatim from D4 §11:** **Re-execution:** an application that re-executes the same runtime with identical arguments is not distinguished by the identity read's fields (§3.4). **Identity:** the read establishes what was mounted and started, not that the running code never loads code it wrote or fetched at run time (§3.4); the two bracketing reads of a round are not continuous attestation of execution between them (J7). **Check quality** (RV6): every mechanism here establishes what ran and the verdict a check returned, never that a post-deploy check tests the right behaviour (D3 §6 class C). **Secrets:** the deployed service and any check given a secret hold it and can leak it by any channel open to them; the screen detects registered forms only (§7.4); a same-uid process outside every domain can read the secret files and the HMAC key. After an engine restart a surviving service's output is withheld, not screened (§7.3). **Artifacts:** the sealed copy in the engine home can be changed by a same-uid process; a rehash at every deploy detects it then, not before. **Availability:** one generation runs at a time, so each deploy has a gap; an engine crash during verification ends that round `unknown`, and the operator redeploys (E110); the observation job samples, so the service can be down between observations without a record of it; `healthy` describes liveness and identity, never correct behaviour. **Freshness:** an observation is a fact at `observed_at` and nothing after `expires_at`. **The service link** relays bytes and does not inspect them. **The operator relay**, while open, exposes the application to other local users and to browser-originated requests on the host; it exposes no engine token or control endpoint (§5.2). **The environment** runs on the operator's own host: a service that exhausts its envelope takes its own reservation, not the host, but its reservation, one check's capacity included, reduces what role runs can be admitted while it runs.

**Also not claimed (BS4 §13):** whether a post-deploy check tests the right behaviour (RV6; the Switchboard mutant's health-only check, section 12); a same-runtime, same-argument re-exec (§3.4; M311 (f) labelled); continuous attestation between a round's two reads (J7); **artifact eviction** (question 7, decided (a)): referenced artifacts are never evicted, so `retention_full` is reachable at `artifacts_max_bytes`; the secret, artifact, availability, freshness, link and relay limits of class C above.

**Carried to this report by the errata and the slice-29 review** (each in `M4-not-claimed.md`): M315 (b) `later_attempt` (E128 item 6, E129 item 9, E130 item 8, E131 item 8); M329 (b)'s "some running" (E130 items 4, 8); a same-uid ptracer of a service or its init (`ptrace_scope` recorded as a host fact, never a refusal; D2 §8 class C; E131 items 2, 8); M341 off the designated host (E69; SEAM §326); the provisional readings of E125 to E131 and the slice-29 review's rulings (section 20).

**The M1 to M3 reports' instrument limits and open items stand:** storage that honours a sync is assumed (E32 item 1); a clock that steps (E38; objection 052 and SEAM §333 for M4's durations); in the kernel lane host eligibility is the harness's say-so (E61 item 3); E94 item 5 (a) and (b), E106's note on adopted commits, E50, E51, E53 to E55 (plan §4.4).

## 19. Limits of the instruments

- The sandbox and project lanes prove the mechanisms on this host, kernel (WSL2 6.6.87.2) and systemd (255.4), not another (BS4 §8).
- The adapter qualification qualifies the adapter, never a project's service or checks; the probe and the qualification are kept apart (AR N03; BS4 §8).
- A project-lane check proves the reference project's construction only (BS4 §8); a health-only check passes the Switchboard mutant (M340 (c)).
- The real journey's engine runs in the test mode for the real lane (`--harness-real-lane`), because the plan and its index and the first `check_correction`'s trigger are fixtures, with the real adapter (`--harness-deploy-adapter real`); its check results and its qualification are the engine's own (SEAM §336).
- The token's absence from unit properties is read while the service ran (`systemctl --user show` of its exact name, and its transient unit file where it could be read); from journal output, of every unit the store's intents name, after the teardown. An unread source is recorded as unread, never as clean: [[PENDING limits-reads: not yet run; from `observed/M342.json`, `deploy.host` and `teardown.journal_search`]].
- Every destructive instrument of the sandbox, project and exhaust lanes is released only after the host has read it contained (E64; BS4 §4.1 rule 8); the hands-on script acts on no unit itself and prints Sean's restart (SEAM §337).

## 20. Open decisions and provisional readings (E122 to E131)

Each stands as the driver ruled it until Sean answers.

| Erratum | Open or provisional | State |
|---|---|---|
| E122 | The probe's confirmation; the domain cgroup the unit's own | decided by Sean |
| E123 | One full run per slice, overlapped | decided by Sean |
| E124 | The first real unit: go-ahead given | decided by Sean |
| E125 | Slice 23: the driver's design answers (a minimal artifact sealed in slice 23; `PUT …/config` creating the environment by name; coalescing; `deploy/<name>` references; the prefix fixed at creation; sibling journal tables) | provisional, the driver's record |
| E126 | A running Alpha service counts by memory, not by a domain slot | decided by Sean |
| E127 | Slice 24: the service init asks for the launch grant | provisional, to be confirmed when D4 is next revised |
| E128 | Slice 25: a result finished after `supervision_lost_at` is missing, not failed; another active unit under the prefix is `differs`; `missing` kind `binding` | provisional |
| E129 | Slice 26: an unreadable inventory before an attempt fails the operation; ownership by name and cgroup; closure needs the recorded cgroup absent and the unit not found; no automatic destructive cleanup | provisional |
| E130 | Slice 27: out-of-band detection by any adapter read; a stop the init cannot see classified from what was read; a deploy preempted before any attempt `failed` on `environment_lease`; M329 (b) for the not-claimed list | provisional |
| E131 | Slice 28: the comm challenge; `SURETY_SECRET_<NAME>`; D4-A08's reading of M2's spawn sites; `CAPABILITY_REFUSED`; item 9, the adapter's qualification keyed on the host qualification's content (decided by Sean) | provisional, but item 9 decided |
| Slice 29 | The review's S1 to S3 (an unread host fact equals nothing; a stopped run `interrupted`; a killed run's leftovers refused by exact name) and Sean's D4-A06 decision (a later run that does not qualify lapses the current row) (SEAM §§328 to 332) | [[PENDING open-s29: not yet run; from the slice-29 erratum]] |
| Slice 30 | Section 22's questions | open |

## 21. Hands-on run

Sean runs `docs/acceptance/reports/M4-hands-on.sh` (row M344; question 9): scripted roles only, no model, no token, nothing paid. It shows him the unit and its cgroup by exact name; the original application instance and the identity read's tree hash beside the sealed digest; the verification row with both reads and the check's result; his own restart of his hands-on unit, its launcher refused and the out-of-band decision it raises; the environment read's three facts; and a teardown leaving nothing of the prefix, each as `CHECK (n)` with a command he can run himself. [[PENDING hands-on: not yet run; from Sean's run and its records]].

## 22. Questions for Sean

1. **`surety deploy`** (D4 §1 item 4, A.8; E121 item 4). The real row has Sean type it; as built (`build/m4-s29`) the CLI has `qualify-adapter` and `env`, not `deploy`. *Pinned* (SEAM §335, †): `surety deploy <candidate> --env <environment> --project <project>`, the client of `POST …/deployments` in §313's convention (exit 0 with the answer's JSON; a refusal's status and body on standard error, exit 1; a usage error exit 2). `M342-the-deploy-command` holds it in the kernel lane; the Builder builds it in slice 30.
2. **The Verifier's package for environment-bound checks** (BS4 §3, "the role packages"). As built it names the workspace kinds and the gate kinds `stage` and `alpha_authorize` only, so a real Verifier would not know to write a `post_deploy_behavior` check. *Pinned*: `M342-the-verifiers-deployment-check-package`, by meaning (the kinds, `alpha_complete`, `requires`, `secrets`, `SURETY_TARGET_<NAME>`, and that `alpha_complete` needs a required `post_deploy_behavior` check).
3. **M343 fails until final**, as M141 and M240 did (E88): this report's own case fails `npm test` while it is a skeleton, which is the honest state.

## 23. How to read the suite

As the M3 report's section 22, with the lanes of the M4 plan §2.1: `node scripts/run-tests.mjs acceptance --slice 30` runs every kernel-, sandbox- and project-lane file of slices 1 to 30; `--lane exhaust` runs the exhaustion files on a host named by `SURETY_EXHAUSTION_HOST`; the real row runs by Sean's command only, alone with `node --test` (question 5). The coverage record lists every named case, its file and its lane; the seam (§§244 to 338) is the contract.
