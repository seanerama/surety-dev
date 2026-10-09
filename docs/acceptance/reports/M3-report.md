# Surety M3 acceptance report

**M3 accepted by Sean, 2026-10-09 (E109).**

**Status:** final. **M3 is accepted** (Sean, 2026-10-09, E109). Every condition of BS3 §1 is met as this report records it (section 1): the full `npm test` on `main` at `bb9dc7e` exited 0, the runner self-test passed at every start of the real lane's home, the exhaustion lane passed on `mini-hp01`, M239 passed under his command, and this report is written. Sean's hands-on run (M241) completed on its third attempt, 2026-10-09 (section 20), and he reported no surprise. Every fact below is taken from a record named beside it; a fact no record holds is said to be not run or unknown, never filled. The real lane's `state.json` and `observed/` are copied to `docs/acceptance/reports/M3-real-lane/2026-10-09/`, searched for the subscription token first, by its file, the value never shown: no hit; the final runs' two logs were searched the same way (no hit) and stay in the driver's scratchpad, not in the repository, whose `.gitignore` keeps `*.log` out (section 11).

**Written by:** the Verifier of M3 slice 22, 2026-10-08, on branch `verify/m3-s22` from `main` at `3c6e886`; **completed** by the Verifier on 2026-10-09, on `verify/m3-report` from `main` at `19a3724` (E107), from the run directory `~/surety-m3-real-20261009` (read only; its store read without the engine running), the driver's test logs, the primary checkout's reflog and the errata E102 to E107; **brought up to date** on 2026-10-09, on `verify/m3-report-final` from `main` at `bb9dc7e`, with the driver's two final runs (the full `npm test` and the exhaustion lane), from their logs and the driver's account. **For:** Sean, the owner, before and after the acceptance run, the exhaustion-lane run, his real run (M239) and his hands-on run (M241); and Astra. **Form:** the M2 report's (`M2-report.md`), with BS3 §10's contents; what M3 does not claim follows `M1-not-claimed.md` and starts from D3 §6. It decides nothing.

The sources it cites: the **build specification** (`docs/spec/M3-build-spec.md`, cited BS3); the **acceptance plan** (`docs/acceptance/sdlc-M3-acceptance-plan.md`, rows M201 to M241); **D3** (`docs/design/sdlc-design-D3-checks.md`, draft 2); the **errata** (E-numbers, `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`); the **coverage record** (`packages/engine/test/acceptance/COVERAGE.md`); the **seam** (`packages/engine/test/acceptance/harness/SEAM.md`, cited "SEAM §n"). The real lane's records, once it has run, are copied to `docs/acceptance/reports/M3-real-lane/<date>/` (SEAM §§163, 237).

## 1. What M3 claims and does not claim

M3 is the direct workspace check runner of D3 draft 2 on this WSL2 host (BS3 §1). If accepted, it supports one claim: **on this host, with the recorded versions and limits, the engine executed a project's protected checks itself, in a `check` domain it qualified, against the protected version in force and never the candidate's copy, and judged each by the exit status of the check's own process as the engine observed it; it selected evidence by latest registration and never fell back to an older pass; it classified protected changes conservatively; it required the coverage, kinds and floors of D3 §4 before a gate could be satisfied; and it resolved a finding only through a required acceptance check covering the finding's criterion.** It does not support the claims that a check tests what it says (D3 §6 class C: the Verifier's construction and the Reviewer's assessment), that any other host, runner class or environment-bound check is qualified, or that Surety can deploy anything (BS3 §1).

BS3 §1's conditions, and where each stands at the time of writing:

| Condition | State |
|---|---|
| `npm test` exits zero on `main` for the kernel, sandbox and project lanes, every M3 row (M201 to M241) with executable tests and none skipped, the M1 and M2 rows passing | **Met:** the driver's full `npm test` on `main` at `bb9dc7e` (2026-10-09, about 83 minutes, in the scratch worktree `run-s19` detached at `bb9dc7e`; log `/tmp/claude-1000/-home-smahoney-projects-sdlc-x/fa384943-ed62-4381-ae56-c1ae7b3402e5/scratchpad/final-npmtest.log`, the driver's scratchpad, not in the repository): unit 486 of 486 in 60 files; acceptance 1,265 of 1,265 in 218 files (327 suites), none failed, cancelled, skipped or todo; the runner's own report that 6 real-lane and 3 exhaustion-lane files were not run (only their lanes run them); exit 0. Earlier: `--slice 22` on `03dd88f`, 1,263 of 1,264, the one failure M240 (b) by design while this report was a skeleton. |
| The runner self-test passed at an engine start: `host_qualifications.check_runner` qualified, every mandatory case and control `passed`, recorded with its evidence | **Met at every start of the real lane's home:** seven host qualification rows, 2026-10-08 21:11 UTC to 2026-10-09 11:54 UTC, each with `check_runner.qualified` true, no fixture label, and every one of the ten mandatory cases and its control passed (section 5) |
| Row M205's exhaustion-lane file passed on the designated host (E92 item 2 (7)) | **Met:** the driver's `--lane exhaust` on `mini-hp01` at `bb9dc7e` (2026-10-09, `SURETY_EXHAUSTION_HOST` set to its own hostname; log copied from `mini-hp01` to `/tmp/claude-1000/-home-smahoney-projects-sdlc-x/fa384943-ed62-4381-ae56-c1ae7b3402e5/scratchpad/m3-exhaust-mini-hp01.log`, not in the repository): 12 of 12 in 3 files (M133, M130 (f) and (g), M205 (g)), exit 0. By the driver's account, the kernel log afterwards showed every OOM kill as `CONSTRAINT_MEMCG` inside the engine's `dom_` or `probe_` scopes only, and the host's available memory was 11,685 MiB against 11,942 MiB before, its staging containers still up (section 12). |
| The real-lane row M239 passed under Sean's command, records retained (E92 item 3) | **Passed, 4 of 4**, on the fourth try, 2026-10-09 (path two 11:54 to 11:56 UTC), `main` at `3fb093d`, in `~/surety-m3-real-20261009` (E107); the directory ends with nothing halted; records copied to `docs/acceptance/reports/M3-real-lane/2026-10-09/` (sections 14, 15). Four tries in all (E103 to E107; section 14). |
| The M3 acceptance report written | This report, final: no pending fact; what was not run is said so. |

## 2. Revisions

| What | Revision |
|---|---|
| The tree the skeleton was written on | `main` at `3c6e886` (E101: slice 21 merged) |
| The tree this report was completed on | `main` at `19a3724` (E107) |
| Slice 15, the walking check | merged; the driver's `--slice 15` on `385d459`, 1,092 of 1,092 (E93 item 4) |
| Slice 16, which result decides | merged; `--slice 16` on `1e37e0f`, 1,105 of 1,105 (E94 item 6) |
| Slice 17, the protected inputs | merged; `--slice 17` on `c0f513c`, 1,123 of 1,123 (E96 item 4) |
| Slice 18, what an execution establishes | merged; `--slice 18` on `1c7a00b`, 1,165 of 1,165 (E97 item 4) |
| Slice 19, the classifier | merged; `--slice 19` on `0780734`, 1,186 of 1,186 (E98 item 4) |
| Slice 20, validation scope | merged; `--slice 20` on `0f349ab`, 1,185 of 1,186, the one failure M71's held-project race, fixed in the test at `94a782a` (E99 items 5, 6) |
| Slice 21, repair and findings | merged at `6805dea`; `--slice 21` on `48841e1`, 1,242 of 1,243, the one failure M222 (Q2's reach), fixed in the test at `4a97d58` and passing alone (E101 item 5) |
| Slice 22, the end of M3 (these cases) | `verify/m3-s22` merged: the cases at `a9ddd51`, the review's fixes at `e508794` (`verify/m3-s22-r`), the Builder's branch at `8c63220`; E102 at `22e9c53` (the primary checkout's reflog). After it: the scope rule of the check-writing package (`4d3d3bf`, `e398062`; E103), E104 (`45f9b89`, `5511bd2`), path two's own project (`8270579`, `03dd88f`), E106 (`a0ae0eb`, `d92c0c4`, `3fb093d`) |
| The revision the acceptance run ran | `bb9dc7e`: the full `npm test` (section 1); the exhaustion lane on `mini-hp01` at the same revision. Before them, `--slice 22` on `03dd88f` |
| The revision the real lane ran | By the primary checkout's HEAD reflog (the runner's report records no revision; whether the working tree held uncommitted changes, or was built at that revision, is not recorded): the first try (2026-10-08, from 21:11 UTC) `22e9c53` (HEAD 21:00 to 21:23 UTC); the second (path one 22:30 to 23:34 UTC, path two to 23:36 UTC) `0018a0d` (HEAD 21:27 UTC to 00:44 UTC); the third (2026-10-09, 01:08 to 01:10 UTC) `8270579` (E105); the fourth (11:54 to 11:56 UTC) `3fb093d` (E107) |
| The contract files | `packages/engine/test/acceptance/contract/` at the same revision as the tests |

## 3. The host

Observed by the Verifier on 2026-10-08 (the tools' own output; not a qualification):

| What | Value |
|---|---|
| `host_id` (`/etc/machine-id`) | `1a2241c9653441439658410880ea14af` |
| Kernel | `6.6.87.2-microsoft-standard-WSL2` |
| WSL2 | yes |
| Distribution | Ubuntu 24.04.3 LTS |
| util-linux | 2.39.3 |
| `ip` | iproute2-6.1.0, libbpf 1.3.0 |
| systemd | 255 (255.4-1ubuntu8.17) |
| Node | v22.22.0 (the engine's and, named in `read_paths`, the reference project's toolchain) |
| git | 2.43.0 |
| SQLite (through `better-sqlite3` 13.0.3) | 3.53.4 |
| CPUs, memory | 20, 15.6 GiB |
| At the acceptance run, as the active host qualification records them | The real lane's active host qualification `hq_01M4G87G5ETZ7K2M2EZXK0M6NN` (2026-10-09 11:54 UTC): H1 to H12 passed, H13 not exercised (section 5); kernel `6.6.87.2-microsoft-standard-WSL2`; util-linux 2.39.3; node v22.22.0. The attempt's observation (`observed/attempt.json`, `host`) records the same `host_id`, Ubuntu 24.04.3 LTS, WSL2, git 2.43.0, systemd 255 (255.4-1ubuntu8.17), iproute2-6.1.0. SQLite's version is not recorded by the run. |

## 4. The backend (the real lane only)

M3's kernel, sandbox and project lanes run no backend (scripted roles). The real row M239 runs Claude Code on Sean's subscription token, as M2's lane did (E74, E88 item 3; a new token, E92 item 3).

| What | Value |
|---|---|
| The binary qualified: path, SHA-256, `--version` | `~/surety-m3-real-20261009/home/backends/claude-2.1.294-27122ca7b624f537` (the engine's pinned copy), SHA-256 `27122ca7b624f537546fbef35b80c66370d974ff258f3d9b10ac50bb8771f262`, `2.1.294 (Claude Code)`, copied from `~/.local/share/claude/versions/2.1.294` at 2026-10-08 21:11:56 UTC (`observed/attempt.json`, `source_binary`) |
| The entry, its attempt, its activation | `trust_01M4ENTSFDFD28PVACWPPTXZJM`, `active`; attempt `qa_01M4ENQKH7DS814GJ727Y6784F`, `succeeded` (Sean's `qualification_approval`; three canaries); activated by `dec_01M4ENVHH2MYXCM7EP1PH12P3P`, Sean's second `trust_activation` (the first was invalidated before it was answered: the engine restarted between steps and qualified the host again, E103 item 1); host qualification `hq_01M4ENQH8TGGJWQHHFXYHRDBCV`; egress hosts `api.anthropic.com`; `term_to_exit_ms` 13; the role profile's fingerprint `6ffd27144bf2e664e6e0287e8262b94db52c3cd585a081bdb00c895fe2f1bf01` (`observed/activation.json`) |
| Model | `claude-sonnet-5-5` (E59), as the harness asks; every one of the run directory's 20 ledger rows records `model_observed` `claude-sonnet-5-5`; the transcripts themselves were not read for this report |
| Auth mode | `subscription_token` (E74 item 1) |

## 5. The host qualification and the runner self-test

The runner self-test (D3 §2.8; SEAM §208; R17) runs at an engine start in real `check` domains, every case beside its control; `direct` is qualified only when every mandatory case passes. Its ten cases, by the names SEAM §208 fixes:

| Case | What it shows (D3 §2.8) | Result and control at the acceptance start |
|---|---|---|
| `exit_zero` | exit 0 is passed | passed; control "exit 1 in the same profile: failed" (`hq_01M4G87G5ETZ7K2M2EZXK0M6NN`; the same at each of the seven starts) |
| `exit_nonzero` | exit 1 is failed | passed; control "exit 0 in the same profile: passed" (`hq_01M4G87G5ETZ7K2M2EZXK0M6NN`; the same at each of the seven starts) |
| `prints_passed_exits_nonzero` | "passed" printed with exit 1 is failed | passed; control "output \"passed\" with exit 0: passed" (`hq_01M4G87G5ETZ7K2M2EZXK0M6NN`; the same at each of the seven starts) |
| `foreign_signal` | a signal the engine did not send is failed (sent by the engine itself to its own box's program after re-verification, otherwise `not_exercised`; E97 item 1) | passed; control "the same program not signalled, exiting 0 by itself: passed" (`hq_01M4G87G5ETZ7K2M2EZXK0M6NN`; the same at each of the seven starts) |
| `deadline` | past the timeout, failed with `deadline_hit` | passed; control "the same program ending within its timeout: passed" (`hq_01M4G87G5ETZ7K2M2EZXK0M6NN`; the same at each of the seven starts) |
| `term_handled_after_cancel` | TERM handled with exit 0 after an engine cancellation is not passed | passed; control "the same program exiting 0 by itself before its timeout: passed" (`hq_01M4G87G5ETZ7K2M2EZXK0M6NN`; the same at each of the seven starts) |
| `missing_program` | a missing program is skipped | passed; control "a program that exists, exit 0: passed" (`hq_01M4G87G5ETZ7K2M2EZXK0M6NN`; the same at each of the seven starts) |
| `input_immutable` | a protected input refused at its pathname while a source write succeeds and does not persist; structural (E95 item 1: the box's mount table read host-side) | passed; control "an ordinary source write in the same domain: succeeds and does not persist" (`hq_01M4G87G5ETZ7K2M2EZXK0M6NN`; the same at each of the seven starts) |
| `orphan_stdout_closed` | an orphan with its standard output closed is failed | passed; control "exit 0 with no descendant: passed, no orphans" (`hq_01M4G87G5ETZ7K2M2EZXK0M6NN`; the same at each of the seven starts) |
| `egress` | an undeclared egress refused while the declared one connects | passed; control "the declared host, through the same proxy: connects" (`hq_01M4G87G5ETZ7K2M2EZXK0M6NN`; the same at each of the seven starts) |

| What | Value |
|---|---|
| The host qualification row, its status, its mechanism fingerprint | `hq_01M4G87G5ETZ7K2M2EZXK0M6NN`, `active` (2026-10-09 11:54 UTC, the fourth try's journey start); mechanism fingerprint `69e3495b84aa567cf99850f7c99041436f30ed280b4d153f5c3aa64b6c34893c`, the same at all seven starts of the home; `bootstrap_exception` 0 at each |
| `check_runner.qualified`, `test_fixture` absent | `true` at all seven starts, none with a fixture label (the journey's engines ran with `--harness-runner-self-test run`; the production engines outside harness mode) |
| H1 to H12 | each `passed` at `hq_01M4G87G5ETZ7K2M2EZXK0M6NN`: H1 `cgroup.kill` present in the incarnation scope; H2 cgroup2, `nsdelegate`; H3 the scope with `Delegate=yes`, owned by uid 1000; H4 memory and pids delegated, `memory.swap.max` 0 in a probe; H5 the seven namespaces without privilege; H6 util-linux 2.39.3 and the tools resolved; H7 node v22.22.0 from a read-only bind; H8 the home on ext4 outside every mount plan; H9 P1 to P19 passed, P20 not exercised (excused here, E69 item 3); H10 P11 and P12; H11 the 1 MiB, 64-inode volatile bound; H12 12.2 GiB available (10.0 needed), 516.5 GiB free (9.0 needed); H13 not exercised (no observer loader) (D3 §2.2: no host requirement is added; H1 to H12 cover the `check` profile) |
| What the slices ran | M221 (a) and M201 (f) ran the self-test at a harness start behind its switch (`--harness-runner-self-test run`), every case passed, in the driver's `--slice 18` to `--slice 21` runs (E97 to E101); outside harness mode the self-test runs at every start (E97 item 1). Those runs' rows were not kept. |

## 6. The check profile's fingerprint

| What | Value |
|---|---|
| `check_runner.profile_fingerprint` at the acceptance start | `55d491c783c01e839cd1fea992500ca16abfa45086446475fbf99a7c24c81a9d`, the same at all seven starts of the real lane's home |
| The `runner_id` form | `direct@<host_id>/<fingerprint prefix>` (M201 (f), SEAM §208) |
| Its place in the mechanism fingerprint | D3 §2.2: the profile's fingerprint joins the mechanism fingerprint of the host qualification (D2 §7.1) |

## 7. The classifier

| What | Value |
|---|---|
| `classifier_version` | `1`: `CLASSIFIER_VERSION` in `src/checks/classify.ts` (E98 item 1), reported by `GET /v1/engine` (SEAM §217) |
| `classifier_authority` | default `{"mode": "recommend"}`: a Reviewer's approval of a tightening is a recommendation on the human's decision and applies nothing (D3 §3.3, Q5; SEAM §§217, 218). Sean may set it `authoritative` naming version 1 once the classifier rows pass on it (BS3 §3); M3 does not require it. In force at the acceptance run: the real lane's home sets no `classifier_authority` (its `config.json` holds `api_port` and `tick_interval` only), so the default `recommend` was in force; the path-one tightening was applied by Sean's answer to `check_correction_tightening` (`dec_01M4ET985X6J0SRTB1QA4JF2JS`), not by a Reviewer |
| What qualifies version 1 | the kernel-lane classifier rows of Appendix C passing on it, B02's and T03's included (D3 §3.3): M224 to M228, and the project-lane root-hiding case M238 (c) (section 8) |

## 8. Every Appendix C statement, its row and its result

The 67 statements of D3 Appendix C, by the row that pins each (plan §4.1). "Last recorded" is the latest full run that included the row's files: the driver's `--slice 22` on `03dd88f`, in which every file passed except M240 (b) (section 1); the acceptance column is the full `npm test` on `main` at `bb9dc7e`, in which every file passed (section 1), with the exhaustion lane on `mini-hp01` at the same revision for M205 (g).

| Statements | Row | Lane | Last recorded | Acceptance run |
|---|---|---|---|---|
| D3-P01, D3-P05 | M202 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-P02, D3-P03 | M203 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-P04, D3-R13 | M204 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-R05, D3-R06 | M205 | sandbox; (g) exhaust | passed in the sandbox lane (both files), `--slice 22` on `03dd88f`; (g) not run before the final runs | passed, `npm test` on `bb9dc7e` (sandbox lane); (g) passed on `mini-hp01` at `bb9dc7e` |
| D3-R11, D3-R22, D3-R23 | M206 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-S06, D3-R27 | M207 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-R12 | M208 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-X01 | M209 | kernel, real git | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-P10 | M210 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-P06 | M211 | sandbox | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-P07 | M212 | sandbox | passed, `--slice 22` on `03dd88f`; verified structurally (E95 item 1), Astra's T02 attempt cases not written | passed, `npm test` on `bb9dc7e` |
| D3-P08 | M213 | sandbox | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-R01, D3-R25 | M214 | sandbox | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-R02, D3-R03, D3-R04 | M215 | sandbox | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-R07, D3-R16, D3-R24 | M216 | sandbox + kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-R08, D3-R09 | M217 | sandbox | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-R10 | M218 | sandbox + kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-R15 | M219 | sandbox | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-R14 | M220 | sandbox | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-R17, D3-R26 | M221 | sandbox + kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-R18, D3-R19, D3-X03 | M222 | sandbox (E97 item 2) | passed, `--slice 22` on `03dd88f` (it failed `--slice 21` on `48841e1`, Q2's reach; the test fixed at `4a97d58`) | passed, `npm test` on `bb9dc7e` |
| D3-J01, D3-J03, D3-J04 | M223 | project | passed, `--slice 22` on `03dd88f`, with the hardened wrapper (section 9) | passed, `npm test` on `bb9dc7e` |
| D3-C01 to D3-C04, D3-C11 | M224 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-C05, D3-C06 | M225 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-P09 | M226 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-C07, D3-C08 | M227 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-C09, D3-C10 | M228 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-S01, D3-S02, D3-S09 | M229 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-S07 | M230 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-S03, D3-S04, D3-S08 | M231 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-S10 | M232 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-S05 | M233 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-R20, D3-R21 | M234 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-F01 | M235 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-X02 | M236 | kernel | passed, `--slice 22` on `03dd88f` (section 1) | passed, `npm test` on `bb9dc7e` |
| D3-J02, D3-J05 | M238 | project | passed, `--slice 22` on `03dd88f`; 11 of 11 alone on 2026-10-08 (section 9) | passed, `npm test` on `bb9dc7e` |

Rows beyond Appendix C, and the second files of rows above:

| Row and file | Lane | Last recorded | Acceptance run |
|---|---|---|---|
| M201, `M201-check-journey-path-one` and its three further files | sandbox | passed, `--slice 21` on `48841e1` | M201's four files passed, `npm test` on `bb9dc7e` |
| M237, `M237-check-journey-path-two` | sandbox | passed, `--slice 21` on `48841e1` | passed, `npm test` on `bb9dc7e` |
| M239, `M239-the-verifiers-check-writing-package` | sandbox | 0 of 1 alone on `verify/m3-s22` before the Builder's package; 2 of 2 in `--slice 22` on `03dd88f` | passed, `npm test` on `bb9dc7e` (2 of 2) |
| M239, `M239-the-real-check-journey` | real | 4 of 4 on the fourth try, 2026-10-09, `main` at `3fb093d` (section 14) | not in `npm test` (manifest `real`) |
| M125 (i), E106's case in `M125-handover` | sandbox | 0 of 1 alone on `main` at `c899b68` before E106 (COVERAGE.md, "E106") | passed, `npm test` on `bb9dc7e` |
| M240, `M240-the-m3-report` | report | (a) passed, (b) failed by design, alone on `verify/m3-s22` | 2 of 2, `npm test` on `bb9dc7e` (this report final) |
| M241, `M241-hands-on-script` | hands-on | 5 of 5 alone on `verify/m3-s22`; amended by the review (section 20) | passed, `npm test` on `bb9dc7e`; the row itself, Sean's run of the script, **passed** on its third attempt, 2026-10-09 (section 20) |

Astra's T01 to T20, L1 to L8, B01 to B04, Q1 to Q11 and N01 to N04 are traced to rows in the plan's §4.2.

## 9. The reference project and the protective wrapper (project lane)

The reference project (`harness/project/reference.mjs`; SEAM §§213, 236) runs Node's own test runner from the engine's Node installation through a protective wrapper. M238's run on 2026-10-08 (Verifier, alone, `verify/m3-s22`), 11 of 11:

| Case | Check | Observed |
|---|---|---|
| the control: the correct project | `guarded`, `srctests`, `bare` | each passed, exit 0; the stage gate satisfied |
| (a) a skipped test | `srctests` (wrapped) | failed, exit 3; the runner counted `# skipped 1` |
| (a) an empty run, no test file | `srctests` | failed, exit 3; `# tests 0` |
| (a) an empty run, a test file that runs no test | `srctests` | failed, exit 3; the runner reported the file itself as one passing test |
| (a) a premature success summary | `srctests` | failed, exit 3; the forged `# pass 1` came first in the runner's report, its own summary last |
| (a) a swallowed child failure | `guarded` | failed, exit 1; the candidate's child printed the right answer and exited 1 |
| (a) candidate `process.exit(0)` | `guarded` | failed, exit 1; the protected test runs the candidate as a child |
| (b) bare `node --test` on the skipped run, the empty run and the empty file | `bare` | **passed, exit 0: a LIMITATION (D3 §6 class B), never evidence of guarded execution**; the gate not satisfied beside it |
| (c) a failing test under `src/` | `srctests` | failed, exit 1, the runner's own status |
| (c) a proposal adding `src/` as a root | the classifier | `unclassifiable`, `root_layout_changed`, awaiting the human; a Reviewer's approval applied nothing |

**What slice 22 found in the wrapper, and changed.** Run first with the wrapper as slice 18 wrote it, the premature-summary mutant (then a test file that printed a summary and ran no test) **passed `srctests` with exit 0**: Node 22 reports a test file that exits 0 having run no test as one passing test (`ok 1 - src/sum.test.mjs`, `# tests 1`, `# pass 1`), and the wrapper read the first summary in the output. The wrapper (a test fixture, the Verifier's) now reads the runner's last summary and fails a top-level entry named for a test file (SEAM §236). That a bare definition, and a wrapper that only counts the summary, pass such a file is added to class B (section 18). M223, which uses the same wrapper, passed 1 of 1 run alone with it (section 11); its acceptance result is section 8's.

## 10. The configuration in force

| What | Value |
|---|---|
| D3 A.7's engine keys (`check_timeout_max`, `check_output_max_bytes`, `checktree_max_bytes`, `checktree_max_entries`, `checktrees_max_bytes`, `check_infra_retries_max`) and the project key `max_concurrent_checks` | defaults as `contract/config.json` holds them (SEAM §186); at the acceptance run: the real lane's home's `config.json` sets only `api_port` and `tick_interval`, so every other engine key, these included, was at its default at each start of that home |
| `classifier_authority` | section 7 |

## 11. The kernel, sandbox and project lanes on this host

| Run | Revision | Result | Source |
|---|---|---|---|
| The driver's `--slice 15` to `--slice 21` | section 2 | section 2 | E93 to E101 |
| M238 alone | `verify/m3-s22` on `3c6e886` | 11 of 11 | this report, the Verifier's run |
| M239's sandbox file alone (`M239-the-verifiers-check-writing-package`) | `verify/m3-s22` on `3c6e886` | 0 of 1: the `check_correction` Verifier's package holds no guidance for writing checks (COVERAGE.md, "M3 slice 22") | the Verifier's run |
| M240 alone | `verify/m3-s22`; then `verify/m3-report` on `19a3724` | (a) passed, (b) failed by design while the report was a skeleton; with the report final, see the row below | the Verifier's runs |
| M240 alone, this report final | `verify/m3-report` on `19a3724` | 2 of 2: (a) and (b) pass, 2026-10-09 | the Verifier's run |
| M241 alone | `verify/m3-s22` | 5 of 5 (the script's form and guards) | the Verifier's run |
| `M3-hands-on.sh` run once without pauses | `verify/m3-s22` on `3c6e886` | exit 0, each of the five checks shown (COVERAGE.md, "M3 slice 22"); not Sean's run; made before the review's S2 fix (section 18), and without a terminal, which the script now refuses | the Verifier's run |
| M223 alone, with the hardened wrapper | `verify/m3-s22` on `3c6e886` | 1 of 1 | the Verifier's run |
| The full `npm test` | `bb9dc7e` | unit 486 of 486 (60 files); acceptance 1,265 of 1,265 in 218 files, 0 failed, 0 skipped; exit 0 | the driver's run; `final-npmtest.log` in the driver's scratchpad |
| The exhaustion lane, `mini-hp01` | `bb9dc7e` | 12 of 12 in 3 files; exit 0 | the driver's run; `m3-exhaust-mini-hp01.log` in the driver's scratchpad |
| `--slice 22`, before the final runs | `03dd88f` | 1,263 of 1,264, the one failure M240 (b) by design; unit 481 of 481; after E106, unit 486 of 486 on `3fb093d` | the driver's run |

## 12. The exhaustion lane

Row M205 (g), an OOM kill in a check domain (E69; SEAM §212): `M205-an-oom-kill-on-the-exhaustion-host.test.mjs`, manifest `exhaust`, run only on `mini-hp01` with `SURETY_EXHAUSTION_HOST` set. **Passed:** the driver's `--lane exhaust` on `mini-hp01` at `bb9dc7e` (2026-10-09, `SURETY_EXHAUSTION_HOST` set to its own hostname; log copied from `mini-hp01` to `/tmp/claude-1000/-home-smahoney-projects-sdlc-x/fa384943-ed62-4381-ae56-c1ae7b3402e5/scratchpad/m3-exhaust-mini-hp01.log`, not in the repository). The lane's three files, 12 of 12: M133 (a) to (h) and P20 at start (on a host designated for it: passed, its target seeded, its negative recorded, its control run); M130 (f) and (g); M205 (g), "a check allocating past memory.max 64 MiB is OOM-killed: signaled, exit_status null, failed, the OOM kill recorded". **By the driver's account, not in the log:** afterwards the kernel log showed every OOM kill as `CONSTRAINT_MEMCG` inside the engine's `surety-…/dom_` or `probe_` scopes only; `mini-hp01`'s staging containers were still up, and its available memory was 11,685 MiB against 11,942 MiB before. The log names neither the host nor the revision; both are the driver's record.

## 13. Egress for checks

A check has no egress unless its definition names hosts within `runner_config.direct.egress_allow`, through D2's proxy (D3 §2.2; M215). The real journey's governed file allows none. The real lane's role and canary runs left 20 `egress_log` records in its home: 60 connections to `api.anthropic.com:443`, each accepted, and one refused, `canary-unlisted.surety.invalid:443` (`not_listed`), the engine's own containment check during the attempt; no other destination was contacted. Every check of the journey ran with no egress (the governed file allows no host). Read from the records; nothing here is the attempt's `unexpected_contacts` read anew.

## 14. The real lane's run (M239)

By Sean's command, on his subscription token, under his approvals (E92 item 3; `docs/acceptance/reports/M3-real-lane/README.md`): the first and second tries Sean's own, with his `qualification_approval`, his second `trust_activation` and his answer to the check-correction decision; the third and fourth run by the driver on his instruction, with no approval asked (E105, E107). One run directory throughout, `~/surety-m3-real-20261009`; each try after the first a rerun of the step that had not been established (`state.json`, `reruns_applied`: `m3_path_one`, then `m3_path_two`, then `m3_path_two,judge:M239 (c)`). Expected cost was under 1 USD in Claude Code's estimates (plan question 5); the four tries together came to 0.9494 USD estimated with one row unknown (below).

| File | Rows | Spends | Date | Outcome |
|---|---|---|---|---|
| `M239-the-real-check-journey` | M239 (a) to (d) | 20 role and canary runs in the home, each with one original ledger row: 0.9494 USD in Claude Code's estimates (`cost_status` `estimated`, on Sean's subscription), one row unknown (the cancellation canary, stopped by the engine, `usage_complete` 0). By try: the attempt's canaries 0.0594 plus the unknown; the first try 0.1712 (3 runs); the second 0.3275 (path one 0.1541, 2 runs; path two 0.1734, 4 runs); the third 0.1938 (4 runs); the fourth 0.1975 (4 runs) | 2026-10-08 to 2026-10-09; the passing run 2026-10-09 11:54 to 11:56 UTC | (a), (b), (c), (d) passed, 4 of 4, on the fourth try (`runner.log`, its fourth report). The tries: first 0 of 4 (path one not established: the real Verifier's `smoke` imported a source file no first stage writes; E103); second 3 of 4 (path one passed; path two's fix was not nominated at T1; E104); third 3 of 4 ((c): a real Reviewer's finding on the engine's setup files in the stage's diff; E105, E106); fourth 4 of 4 (E107) |

The dress rehearsal (SEAM §171, with the fake `claude`; never evidence) passed 4 of 4 in its fourth run directory, after three that found defects in the lane's own code (COVERAGE.md, "M3 slice 22").

## 15. The real check journey

| What | Value |
|---|---|
| (a) The checks a real Verifier wrote: its run, the proposal, its class, Sean's answer, the version and its checks | The real Verifier's `check_correction` run `run_01M4ET7YCW4TWVETDFR1515SCX` (second try; path one's project `proj_01M4ET7XGKAATZCQBZQ5C4WYD1`, begun with no check) wrote four checks: `r1-1`, `r2-1`, `r3-1` (acceptance, covering R1.1, R2.1, R3.1) and `smoke`; the proposal `prop_01M4ET96895S1MCMYNP1MT30CC`, classified `tightening`, no discovery error; Sean answered `check_correction_tightening` `dec_01M4ET985X6J0SRTB1QA4JF2JS` `approve`; applied as version `pv_01M4EXWFXEYNWAJZQEKV4VQ25C`, effective, no discovery error |
| (b) The stage built by a real Builder: the candidate, every execution with its domain and qualification, both gates | The real Builder built stage 1 in one round: candidate `cand_01M4EXWYX4GB7Q63VNHT62HRE5`; its checks `r1-1` and `smoke` exit 0, each an engine execution in a `check` domain of its own, bound to that start's self-tested qualification `hq_01M4ET756HHQWGV4XFN8DN22FV`; the stage gate and the Alpha gate satisfied on them; authorization `dauth_01M4EXXAA8YR08YDT2Q6HEC5PC` |
| (c) Path two: the seeded defect, the finding (criterion and check), the disposition, the fix's candidate, the resolving execution, the gates | Path two on a project of its own, `proj_01M4G884GMRSHE31XBC0E2E0B4` (fourth try), its initial version path one's checks as Sean approved them (`pv_01M4EXWFXEYNWAJZQEKV4VQ25C` at `ab5969e2`); on the stage's candidate `r2-1` exit 1 (the seeded defect), `r3-1` and `smoke` exit 0; the real Verifier's finding `fnd_01M4G89DG733E7VGDVM7XTG3N1` named `R2.1` and `r2-1` ("the window is 1,800,000,000 ms ... rather than 1,800,000 ms"); the real Reviewer dispositioned it `fix` and raised no other open finding (its context named the bootstrap and the policy revision as the engine's and the owner's, E106); the engine nominated the fix's integration (E104); on that candidate `r2-1` passed, execution `cx_01M4G8AVV1N22ZBWT4SEJ9114J`, trigger `nomination`, sequence 4 above the disposition's 3, in a `check` domain, result `cr_01M4G8B18STY2NV9ZV7B3CD7Y7`; `resolution_verification` names that result and evaluation `gate_01M4G8B4ESPGE93V4P7XCHK2J9`; both gates satisfied. The Reviewer's range held the engine's bootstrap (`.surety/project.json`), its policy revision (`.surety/policy.json`) and the Builder's `src/logout.mjs` only |
| (d) No result from a fixture; the token's absence | 22 check results in the journey's projects, every one naming an engine execution, none with the fixture's runner; the key search (`observed/M239.json`, `key_search`) over the run directory and the three repositories found no hit; and before the copy, a search of `state.json`, `observed/` and `runner.log` with the token's file as the pattern found none |

The checks' toolchain in the real journey: a copy of the engine's node binary in the run directory, its SHA-256 pinned in `check_commands`, its directory the checks' only read path, their `PATH` `/usr/bin:/bin` (the slice-22 review, minor 3; SEAM §237). What stays a fixture in the real journey, labelled (SEAM §237): the approved plan with its texts and index (spec approval is not built), the trigger of the first `check_correction` work and of path two's review, and the Alpha test target. No check result.

## 16. Cases reported `not_exercised`

Each passes by asserting the host fact and its reason, and is **never counted as passed**:

- **M205 (g)**, the OOM kill, is `not_exercised` off the designated host (plan §2.5; E69): its file runs only on `mini-hp01`, where it passed at `bb9dc7e` (section 12).
- **The self-test's `foreign_signal`** reports `not_exercised` when the engine cannot re-verify its own box's program immediately before the kill (E97 item 1); a `not_exercised` mandatory case leaves `direct` unqualified (D3 §2.8).
- Carried from M2: the observer cases M112 (g), M116 (d), M124 (e), M128 (g), M135 (j) (H13 not exercised); M115 (f) and M115 (h); P20 on this workstation (exercised on `mini-hp01`).
Sean's hands-on run completed on its third attempt (section 20). M239, the real row, ran and passed (section 14); it was never a `not_exercised` case.

- **Not written, and so not claimed:** Astra's T02 attempt cases and M212 (b) to (d) (E95 item 1: B01 verified structurally); M221 (b)'s "an optional observer never substitutes" (no optional observer of the self-test exists).

## 17. What M3 does not claim

In the form of `M1-not-claimed.md`, from D3 §6.

**D3 §6, class A** (outside the threat model): as D2 §8 class A; a check the Verifier wrote to pass whatever the source does.

**Class B** (real behaviour no test has yet established): the runner on any host before its self-test has passed there; `container` and `remote`; the environment-bound check; the phase gate; spec approval's registration of the index (the fixture stands in). That a project's toolchain fails on every condition its checks care about: the definition must make it so (E8). Node 22's `node --test` exits 0 when every test is skipped and when none exists, so a definition that runs it bare is a vacuous check; the reference project's demonstration of this is a limitation, never evidence of guarded execution. **Added by slice 22 (M238):** Node 22 also reports a test file that exits 0 having run no test as one passing test, so a bare definition, or a wrapper that only counts the summary, passes a test file that a candidate empties or ends early; the reference project's wrapper fails it, which protects that project only.

**Class C, verbatim from D3 §6:** The verdict is the exit status of the check's own process: a check that runs candidate code in its own process can be made to exit 0 by that code (`process.exit(0)` in an imported module), and no runner can tell; a check should run candidate code as a child and judge what it observably does, which is the Verifier's construction and the Reviewer's assessment, not the classifier's. A protected command can itself hide a child's nonzero status; exit-only judgment cannot prove a wrapper honest. The runner self-test qualifies the runner, never a project's checks. The classifier judges structure, so a vacuous new check covering a criterion classifies as a tightening (§3.2); a root addition is never agent-approved (§3.1). The latest registration decides, so an operator's repeated re-runs of a flaky check can turn a failure into a pass; a pending rerun blocks (§2.5), and every execution is kept and shown beside the deciding one (§2.6). A finding resolves only through a required acceptance check covering its criterion, but whether that check tests the defect is the Reviewer's judgment (§2.11). A check sees no git history and no live repository metadata (it reads `SURETY_SOURCE_REVISION` instead); submodules, LFS and filters are unsupported. Toolchain drift between executions is recorded (each records the program's resolved path and hash) but prevented only where `check_commands` pins a hash, and a pinned program hash alone does not pin its libraries, packages or mutable toolchain directories: optional pinning is not an immutable toolchain, and the stronger reproducibility claim is the deployment design's (Q6). Output is kept head and tail within its bound. A check's writes are discarded, and a check produces no artifact in D3. The engine creates no evidence-reuse entry. A candidate's checks run one at a time by default.

**Not in M3, refused where the engine can refuse** (BS3 §3): deployment and the environment-bound check (`environment_unbound`, M222 (c)); `container` and `remote` (`runner_unqualified`, M222 (a)); the phase gate (`unsupported`); spec approval; evidence-reuse creation and reuse across versions (Q1); an `authoritative` classifier as a condition; sessions, a second backend, the API-key mode for the real lane, the UI, dogfooding; submodules, LFS, filters and live repository metadata in a check tree.

**Accepted as not built in slices 15 to 21, each commented at its site** (E93 to E101): eviction under `checktrees_max_bytes` (admission refuses instead; E96 item 3); a top-level component name holding an input with `,`, `:`, `\` or whitespace is refused `mount_plan_refused` (E96 item 3); an open proposal is not reclassified on a version or classifier change before approval (revalidation catches it; E98 item 1); `area_unknown` checked against the closed list (E98 item 1); the phase scope; registration when a scope grows on a spec or module change; module presence for superseded candidates; the fixture's criterion-kind rule; architecture approval (E99 item 1); an X2 route from executing or integrating; any process for `spec_change` work; objections from other roles; re-arming a `change_spec` hold (E101 item 1); `superseded_by` not backfilled for stores made before slice 16 (E94 item 4).

**Bucket C of the triage:** M43 and M11 leave it (M229 to M231; M228, M236). The rest stays as `M2-not-claimed.md` lists it (M20, M27, M31, M58, M70, M72).

**The M1 and M2 reports' instrument limits stand:** storage that honours a sync is assumed, not established (E32 item 1); a clock that steps (E38); in the kernel lane host eligibility is the harness's say-so (E61 item 3).

## 18. Limits of the instruments

- The sandbox and project lanes prove the mechanisms on this host and kernel (WSL2 6.6.87.2), not another (BS3 §8).
- The runner self-test qualifies the runner, never a project's checks (BS3 §8; D3 §6 class C).
- The classifier's rows prove structure, not test semantics (BS3 §8).
- B01 is verified structurally: the domain's mount table read host-side, not by attempts from inside (E95 item 1; the slice-17 review ran the attempts in a scratch namespace reproducing the plan).
- The reference project protects only itself: its wrapper and child-run tests are a construction a Verifier can copy, not a property the engine enforces (D3 §6 class C).
- The real journey's engine runs in the test mode for the real lane (`--harness-real-lane`), because the plan and its index, the first `check_correction`'s trigger, path two's review trigger and the Alpha target are fixtures; its check results are the engine's own (SEAM §237).
- A destructive check instrument is released only after the host has read it contained (E64; BS3 §4). In the hands-on script as first merged (`a9ddd51`), the second operator re-run of step 6 was released without a read of its own: the release file was made before that execution was registered, so it acted at once. The review of slice 22 found it (S2); every release now follows its own read of that execution (`read_containment`: the program among its domain's `cgroup.procs`, by its own `/proc/<pid>/cgroup` too, the domain under the engine's scope), and the release file is removed once the execution has its result (SEAM §239; M241 (e)). The one released execution without its own read wrote only to its discarded overlay and its refused input.

## 19. Open decisions and provisional readings (E93 to E107)

Each stands as the driver ruled it until Sean answers.

| Erratum | Open or provisional | State |
|---|---|---|
| E93 | Objections 022 and 023 upheld; M205 (d), (g), (i) deferred to slice 18 (done there, E97) | provisional, the driver's record |
| E94 item 2 | A candidate superseded at its successor's nomination; `CANDIDATE_SUPERSEDED` and `REF_UNREAD` join D1 A.4; a scripted result's `runner_id` `test_fixture`; a result recorded after supersession never counts through reuse; `REF_UNREAD` resolves no finding and completes no work; a ref `absent` only when verified | provisional |
| E94 item 4 | Residual O2 (a gate's fingerprint from an earlier generation, failing closed); `superseded_by` not backfilled | recorded |
| E94 item 5 | **Open for Sean:** (a) whether an evaluation carrying `OUT_OF_BAND_CHANGE` should still resolve findings and complete fix work; (b) whether adopting an out-of-band commit should cancel or neutralize the latest candidate's queued and running executions | open |
| E95 | B01 verified structurally (decided); D4's questions (decided) | decided |
| E96 items 1, 3 | The manifest fingerprint's migration never guessing; the component-name limitation; eviction left for later | provisional |
| E97 item 2 | The self-test off by default in harness mode; M222 in the sandbox lane; "cancel" in M216 (b) the deadline; output after a crash between the exit report and collection not pinned; `definition_invalid` through a `cwd` that is not a directory; `ignore-term` writes one line; `alloc`'s bound; interleaving at the program's write granularity | provisional |
| E98 item 2 | A fixture-classified proposal keeps its class; elements compared exactly for strict and loosening, at least for unclassifiable; a narrowed root may also give `root_removed`, a `gate_kinds` change `applicability_changed`; the human's question re-raised after a Reviewer withdrawal | provisional |
| E98 item 3 | S1 (P0's own discovery errors) and S2 (a Reviewer applying a `required_checks` change without the validation-scope approval) fixed, each reachable only under `authoritative` | recorded |
| E99 items 1, 3 | A fix whose presence read fails nominates by engine cadence when a module could raise the tier; the Verifier's eight readings (uncovered criterion named by its key; `covers_not_allowed`; the waiver at T2; one content hash per candidate; presence by redefining `paths`; sign-offs by module name; fixture checks of criterion-bearing kinds may cover none; M204 (f) a second file) | provisional |
| E100 | S1 (the stage's own Builder repairs a later candidate's stage check) and S2 (the candidate's full scope resolves a finding) | decided by Sean |
| E100 item 3 | A T2 review is not queued for a candidate whose stage work Q2 parked; queued when the work resumes | provisional, not brought to Sean |
| E101 item 2 | The Verifier's six readings (repair context fields; `missing_verifications` with no new code; the routed `check_correction` by `trigger_id`; the X2 blocker no later than the repair it replaces; objections as findings, severity unpinned; `correct_check` and `change_spec` registering work triggered by the finding); a project-scoped finding keeps the version's required mark; a re-raised X2 blocker is a fresh decision | provisional |
| E101 item 3 | Q2's reach over accepted rows (objection 030: `repair_attempts_max: 0` before the build where a case is not about repair) | provisional |
| E102 | Slice 22 merged; the review's two serious findings in the Verifier's deliverables (S1, a rerun dispatching earlier paid work; S2, a release without its containment read) fixed with cases | provisional, the driver's record |
| E103 | The first real try: path one not established; the check-writing package's scope rule (a check covering no criterion is required at every stage gate) stated, case M239 (b) | provisional |
| E104 | A fix that names a finding is nominated at every tier, T1 included (M235 (f); M231 (c)'s straddle) | decided by Sean |
| E105 | The third real try: the fix resolved its finding; a Reviewer's finding on the engine's setup commits blocked the gates | provisional |
| E106 | The Reviewer's context names the engine's and the owner's commits of its range (M125 (i)) | decided by Sean |
| E106 item 3 | **Noted for Sean, not decided:** when the owner adopts an out-of-band change the engine records only its tip, so commits beneath it would be named unknown, not the owner's | open |
| E107 | The fourth real try: M239 4 of 4; spend 0.198 USD for its four runs | provisional |
| Slice 22 | Section 21's questions | open |

## 20. Hands-on run

Sean runs `docs/acceptance/reports/M3-hands-on.sh` (row M241; E92 item 2 (6)): scripted roles only, no model, no token, nothing paid. It shows him a check's processes in its domain's `cgroup.procs`, its tree with no `.git`, an input write refused while a source write is discarded, the gate read with the deciding execution and its history, and a root addition classified `unclassifiable`, each as `CHECK (n)` with a command he can run himself. **Passed: Sean's third attempt completed** (2026-10-09, about 14:02 UTC, `main` at `0c44c76`, directory `~/surety-m3-hands-on-20261009T140150Z`; read by the Verifier from its store, records and repository, read only, and from the coordinator's account of what Sean saw). Sean reported no surprise.

| Check | What he saw | The record |
|---|---|---|
| The engine's start | the runner self-test qualified `direct`, 10 of 10 cases passed, no fixture label | host qualification `hq_01M4GFGTD3VETCC7FF7GWBB8CX`, `active`; `check_runner.profile_fingerprint` `55d491c783c01e839cd1fea992500ca16abfa45086446475fbf99a7c24c81a9d` |
| CHECK (1) | the check program a member of its domain's `cgroup.procs`, read from the host | `contained`'s nomination execution `cx_01M4GFHJWHJFCT1WTF8P8SETV7` (sequence 2) in its own domain `dom_01M4GFHVFQ037YYN4TAGB3QYRA`; the host-side read is the script's output, by the coordinator's account |
| CHECK (2) | no `.git` anywhere under `checktrees/` | read again afterwards: no entry named `.git` under the home's `checktrees/` |
| CHECK (3) | the write to the protected input refused, `EROFS`; the write to `src/app.js` `ok`; nothing persisted | the execution's output record: `SURETY-CHECK-WRITE` with `.surety/checks/expect/app.js` `EROFS` and `src/app.js` `ok`; afterwards no file under `checktrees/` holds the written line, and the project's repository has no change |
| CHECK (4) | the stage gate satisfied; `contained` decided by its latest registration, with its history | evaluation `gate_01M4GFVA4P6GZ0Y6GCM1P43WPD`, `satisfied`; `contained` decided by `cx_01M4GFTXXXBW1SQJAKRW3R7CQS` (sequence 4, an operator's request, exit 0); its history counts 2: `cx_01M4GFHJWHJFCT1WTF8P8SETV7` (sequence 2, `passed`, the nomination) and `cx_01M4GFR30ZMEVNKR6KSW1W7PEY` (sequence 3, `failed`, an operator's request held to its deadline: `deadline_hit` 1, `signaled` 1) |
| CHECK (5) | the proposal adding `src/` as a root classified `unclassifiable` | proposal `prop_01M4GGKW8N5PE6CF23MPDX4MPQ`, `awaiting_human`, elements `root_layout_changed` (`src/`), `unhandled_change` (`src/app.js`), `no_strict_change`; the open decision `dec_01M4GGKXHNRN13ZGEDHRS9N8Z1`, `check_correction_unclassifiable` |

The two attempts before it stopped fail-closed at step 4, with nothing released or written: Sean's first attempt (2026-10-09, directory `~/surety-m3-hands-on-20261009T132420Z`, by the coordinator's account) stopped fail-closed at step 4: he spent longer than 90 s at step 3's two pauses while the check `contained` (`cx_01M4GDCXD0CFHG0WV5CGEYSN3R`) was held, the engine ended it at its `timeout_s` (`deadline_hit` 1, `signaled` 1; 13:25:01 to 13:26:23 UTC), and the script's containment read then found no program and stopped with "nothing is released": the guard behaving as designed, nothing written. The script never told him a clock was running. His second attempt (`~/surety-m3-hands-on-20261009T133616Z`) stopped the same way with the time shown (the check started 13:37:00, its deadline 13:38:22, step 4 began about 13:41): a warning was not enough. Fixed on `verify/m3-hands-on-deadline`: step 3 shows the time left before the check's deadline (from the execution's recorded start), and its two pauses while the check is held wait at most that time less 25 s, going on by themselves, and not at all when the time left is unknown or under 25 s; step 4 stops with the explanation when the check has already ended; the timeout (90 s) and the containment read are unchanged. The third ran on that fix.

One line of the script was corrected afterwards (`verify/m3-accepted`; not run): step 6 printed `"trigger": null` for each operator request, because the request's answer holds each execution's `id`, `check` and `key` only; it now prints `{id, key}`.

## 21. Questions for Sean

Each is a decision, with the reading the Verifier pinned and its options.

1. **How M239 is run.** `run-tests.mjs --lane real` runs every file under the manifest's `real`, so it would run M2's real lane again (M136 to M140: an attempt and a journey, paid) beside M239. *Pinned:* M239 is run alone with `node --test` after `npm run build`, as the rehearsal runs (`M3-real-lane/README.md`); its own preflight holds every guard. Options: (a) as pinned; (b) an owner's change to `run-tests.mjs` letting `--lane real` take one file; (c) move M2's real files out of `real` (they would then fail the manifest check: not chosen).
2. **The reference project's wrapper** (section 9). Hardened as a test fixture; whether D3 §6 class B should name the empty test file in its text is yours.
3. **M238's mutants by target** (SEAM §236): the vacuous-run mutants against the retained check that runs the Builder's tests, the child failure and `process.exit(0)` against the acceptance check that runs the candidate as a child. A check that imports candidate code in its own process cannot be protected against `process.exit(0)` (D3 §6 class C); the mutant is not asserted against `srctests`.
4. **M239 path two with `repair_attempts_max` 0** (objection 030's precedent): so that a real check catching the seeded defect parks the stage rather than sending it back to the Builder, and the real Verifier's finding is the path.
5. **M240 fails until final**, as M141 did (the driver's ruling then, E88). *Now:* this report is final with every fact from a record or said to be not run, and M240 passed 2 of 2 in the full `npm test` on `bb9dc7e`. The exhaustion lane has since run on `mini-hp01` (section 12); whether M240 should also require that run is yours; the Verifier has not made it a condition of the test.
6. **Decided as E106 (Sean, 2026-10-09: option (c)).** **The Reviewer's first diff holds the engine's own setup commits** (Sean's third real try; SEAM §242). A Reviewer is shown `candidate.diff` from a base the store names: the previous candidate's revision, or, for a project's first candidate, the parent of the project's first recorded revision (`src/store/reads.ts`). The first recorded revision is the engine's bootstrap commit, so a first candidate's diff always holds the bootstrap's `.surety/project.json` and every policy revision committed before the stage (`.surety/policy.json`, the owner's settings through the policy route), beside the Builder's work. The Reviewer's context says only "the candidate's changes, from <base> (first recorded parent) to <revision>": nothing tells it which commits in that range are the engine's or the owner's rather than a role's, though the commits' trailers say so (`Surety-Project` with no `Surety-Run`). In the third try a real Reviewer raised an open medium finding on exactly those two files ("neither relates to R2 or R3"), which blocked both gates; in the first try another let the same policy change pass. Options: (a) leave it: a Reviewer may question an owner's policy change, and the human dispositions such a finding; (b) the engine's diff base for a first candidate becomes the last engine setup commit before the first role's work (the project's own configuration is not the candidate's change); (c) the context names the engine's and the owner's commits in the range and says they are not the Builder's work to review. A design decision, not built here; the harness cannot avoid these commits without working around the engine (a policy revision is the only way to set the roles' backends, and the bootstrap always records first). **The decision:** the Reviewer's context names each commit of its diff's range that the engine made on no role run's behalf as the engine's or the owner's, not the Builder's work to review, from the engine's records and never from trailers alone; the diff is unchanged; what cannot be established is said as unknown. Its case is M125 (i) (SEAM §243).

## 22. How to read the suite

As the M2 report's section 22, with the lanes of the M3 plan §2.1: `node scripts/run-tests.mjs acceptance --slice 22` runs every kernel-, sandbox- and project-lane file of slices 1 to 22; `--lane exhaust` runs the exhaustion files on a host named by `SURETY_EXHAUSTION_HOST`; the real row runs by Sean's command only. The coverage record lists every named case, its file and its lane; the seam (§§177 to 239) is the contract.
