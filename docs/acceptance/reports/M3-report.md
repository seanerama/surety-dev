# Surety M3 acceptance report

**Status:** skeleton. **M3 is not accepted.** This report records what has been run and decides nothing; whether M3 is accepted is Sean's decision. Every fact that a run not yet made must supply is a placeholder of the form `[[PENDING <label>: <what>; from <source>]]`, and row M240's test (`M240-the-m3-report.test.mjs`) fails while one remains. Nothing below is described as passing that was not run: where a row's file passed, the run, its revision and its source are named; the acceptance run itself (`npm test` on `main` after slice 22) has not been made.

**Written by:** the Verifier of M3 slice 22, 2026-10-08, on branch `verify/m3-s22` from `main` at `3c6e886`. **For:** Sean, the owner, before and after the acceptance run, the exhaustion-lane run, his real run (M239) and his hands-on run (M241); and Astra. **Form:** the M2 report's (`M2-report.md`), with BS3 §10's contents; what M3 does not claim follows `M1-not-claimed.md` and starts from D3 §6. It decides nothing.

The sources it cites: the **build specification** (`docs/spec/M3-build-spec.md`, cited BS3); the **acceptance plan** (`docs/acceptance/sdlc-M3-acceptance-plan.md`, rows M201 to M241); **D3** (`docs/design/sdlc-design-D3-checks.md`, draft 2); the **errata** (E-numbers, `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`); the **coverage record** (`packages/engine/test/acceptance/COVERAGE.md`); the **seam** (`packages/engine/test/acceptance/harness/SEAM.md`, cited "SEAM §n"). The real lane's records, once it has run, are copied to `docs/acceptance/reports/M3-real-lane/<date>/` (SEAM §§163, 237).

## 1. What M3 claims and does not claim

M3 is the direct workspace check runner of D3 draft 2 on this WSL2 host (BS3 §1). If accepted, it supports one claim: **on this host, with the recorded versions and limits, the engine executed a project's protected checks itself, in a `check` domain it qualified, against the protected version in force and never the candidate's copy, and judged each by the exit status of the check's own process as the engine observed it; it selected evidence by latest registration and never fell back to an older pass; it classified protected changes conservatively; it required the coverage, kinds and floors of D3 §4 before a gate could be satisfied; and it resolved a finding only through a required acceptance check covering the finding's criterion.** It does not support the claims that a check tests what it says (D3 §6 class C: the Verifier's construction and the Reviewer's assessment), that any other host, runner class or environment-bound check is qualified, or that Surety can deploy anything (BS3 §1).

BS3 §1's conditions, and where each stands at the time of writing:

| Condition | State |
|---|---|
| `npm test` exits zero on `main` for the kernel, sandbox and project lanes, every M3 row (M201 to M241) with executable tests and none skipped, the M1 and M2 rows passing | [[PENDING npm-test: the full run on `main` after slice 22 is merged, its revision, counts and exit; from the driver's run]] |
| The runner self-test passed at an engine start: `host_qualifications.check_runner` qualified, every mandatory case and control `passed`, recorded with its evidence | [[PENDING self-test-start: a start's `check_runner` row with its ten cases and controls; from the acceptance run or the real lane's journey home]] (section 5) |
| Row M205's exhaustion-lane file passed on the designated host (E92 item 2 (7)) | [[PENDING exhaust: `--lane exhaust` on `mini-hp01`, its revision and result; from the driver's or Sean's run (E69)]] |
| The real-lane row M239 passed under Sean's command, records retained (E92 item 3) | [[PENDING real-lane: M239's run, its date, outcome and run directory; from Sean's run (section 14)]] |
| The M3 acceptance report written | This report, a skeleton until the runs above are made. |

## 2. Revisions

| What | Revision |
|---|---|
| The tree this skeleton was written on | `main` at `3c6e886` (E101: slice 21 merged) |
| Slice 15, the walking check | merged; the driver's `--slice 15` on `385d459`, 1,092 of 1,092 (E93 item 4) |
| Slice 16, which result decides | merged; `--slice 16` on `1e37e0f`, 1,105 of 1,105 (E94 item 6) |
| Slice 17, the protected inputs | merged; `--slice 17` on `c0f513c`, 1,123 of 1,123 (E96 item 4) |
| Slice 18, what an execution establishes | merged; `--slice 18` on `1c7a00b`, 1,165 of 1,165 (E97 item 4) |
| Slice 19, the classifier | merged; `--slice 19` on `0780734`, 1,186 of 1,186 (E98 item 4) |
| Slice 20, validation scope | merged; `--slice 20` on `0f349ab`, 1,185 of 1,186, the one failure M71's held-project race, fixed in the test at `94a782a` (E99 items 5, 6) |
| Slice 21, repair and findings | merged at `6805dea`; `--slice 21` on `48841e1`, 1,242 of 1,243, the one failure M222 (Q2's reach), fixed in the test at `4a97d58` and passing alone (E101 item 5) |
| Slice 22, the end of M3 (these cases) | `verify/m3-s22` [[PENDING s22-merge: the merge of slice 22's cases and of its Builder's branch to `main`; from the driver's record]] |
| The revision the acceptance run ran | [[PENDING npm-test-rev: `main` at the full run; from the driver's run]] |
| The revision the real lane ran | [[PENDING real-lane-rev: the primary checkout's HEAD at Sean's run; from the reflog, as the M2 report did]] |
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
| At the acceptance run, as the active host qualification records them | [[PENDING host-at-run: the qualification row's host facts; from the acceptance run's home]] |

## 4. The backend (the real lane only)

M3's kernel, sandbox and project lanes run no backend (scripted roles). The real row M239 runs Claude Code on Sean's subscription token, as M2's lane did (E74, E88 item 3; a new token, E92 item 3).

| What | Value |
|---|---|
| The binary qualified: path, SHA-256, `--version` | [[PENDING m3-binary: the pinned copy in the real lane's home; from `observed/attempt.json` (the attempt's pinned binary) or the entry]] |
| The entry, its attempt, its activation | [[PENDING m3-entry: the trust entry, attempt and Sean's `trust_activation`; from `observed/activation.json`]] |
| Model | `claude-sonnet-5-5` (E59), as the harness asks; [[PENDING m3-model: the model every transcript shows; from the run's transcripts]] |
| Auth mode | `subscription_token` (E74 item 1) |

## 5. The host qualification and the runner self-test

The runner self-test (D3 §2.8; SEAM §208; R17) runs at an engine start in real `check` domains, every case beside its control; `direct` is qualified only when every mandatory case passes. Its ten cases, by the names SEAM §208 fixes:

| Case | What it shows (D3 §2.8) | Result and control at the acceptance start |
|---|---|---|
| `exit_zero` | exit 0 is passed | [[PENDING st-exit_zero: result and control; from check_runner.self_test]] |
| `exit_nonzero` | exit 1 is failed | [[PENDING st-exit_nonzero: result and control; from check_runner.self_test]] |
| `prints_passed_exits_nonzero` | "passed" printed with exit 1 is failed | [[PENDING st-prints_passed_exits_nonzero: result and control; from check_runner.self_test]] |
| `foreign_signal` | a signal the engine did not send is failed (sent by the engine itself to its own box's program after re-verification, otherwise `not_exercised`; E97 item 1) | [[PENDING st-foreign_signal: result and control; from check_runner.self_test]] |
| `deadline` | past the timeout, failed with `deadline_hit` | [[PENDING st-deadline: result and control; from check_runner.self_test]] |
| `term_handled_after_cancel` | TERM handled with exit 0 after an engine cancellation is not passed | [[PENDING st-term_handled_after_cancel: result and control; from check_runner.self_test]] |
| `missing_program` | a missing program is skipped | [[PENDING st-missing_program: result and control; from check_runner.self_test]] |
| `input_immutable` | a protected input refused at its pathname while a source write succeeds and does not persist; structural (E95 item 1: the box's mount table read host-side) | [[PENDING st-input_immutable: result and control; from check_runner.self_test]] |
| `orphan_stdout_closed` | an orphan with its standard output closed is failed | [[PENDING st-orphan_stdout_closed: result and control; from check_runner.self_test]] |
| `egress` | an undeclared egress refused while the declared one connects | [[PENDING st-egress: result and control; from check_runner.self_test]] |

| What | Value |
|---|---|
| The host qualification row, its status, its mechanism fingerprint | [[PENDING hq-row: the active row at the acceptance start; from its store]] |
| `check_runner.qualified`, `test_fixture` absent | [[PENDING runner-qualified: from the same row]] |
| H1 to H12 | [[PENDING hq-checks: each check's result and observed value; from the same row]] (D3 §2.2: no host requirement is added; H1 to H12 cover the `check` profile) |
| What the slices ran | M221 (a) and M201 (f) ran the self-test at a harness start behind its switch (`--harness-runner-self-test run`), every case passed, in the driver's `--slice 18` to `--slice 21` runs (E97 to E101); outside harness mode the self-test runs at every start (E97 item 1). Those runs' rows were not kept. |

## 6. The check profile's fingerprint

| What | Value |
|---|---|
| `check_runner.profile_fingerprint` at the acceptance start | [[PENDING profile-fingerprint: the check profile's fingerprint; from check_runner]] |
| The `runner_id` form | `direct@<host_id>/<fingerprint prefix>` (M201 (f), SEAM §208) |
| Its place in the mechanism fingerprint | D3 §2.2: the profile's fingerprint joins the mechanism fingerprint of the host qualification (D2 §7.1) |

## 7. The classifier

| What | Value |
|---|---|
| `classifier_version` | `1`: `CLASSIFIER_VERSION` in `src/checks/classify.ts` (E98 item 1), reported by `GET /v1/engine` (SEAM §217) |
| `classifier_authority` | default `{"mode": "recommend"}`: a Reviewer's approval of a tightening is a recommendation on the human's decision and applies nothing (D3 §3.3, Q5; SEAM §§217, 218). Sean may set it `authoritative` naming version 1 once the classifier rows pass on it (BS3 §3); M3 does not require it. In force at the acceptance run: [[PENDING classifier-authority: `GET /v1/engine`'s `config.classifier_authority` at the acceptance run; from the run]] |
| What qualifies version 1 | the kernel-lane classifier rows of Appendix C passing on it, B02's and T03's included (D3 §3.3): M224 to M228, and the project-lane root-hiding case M238 (c) (section 8) |

## 8. Every Appendix C statement, its row and its result

The 67 statements of D3 Appendix C, by the row that pins each (plan §4.1). "Last recorded" is the latest run that included the row's files, with its source; the acceptance column is the full `npm test` on `main` after slice 22, not yet made.

| Statements | Row | Lane | Last recorded | Acceptance run |
|---|---|---|---|---|
| D3-P01, D3-P05 | M202 | kernel | passed, `--slice 21` on `48841e1` (E101 item 5) | [[PENDING acc-M202: result; from npm test]] |
| D3-P02, D3-P03 | M203 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M203: result; from npm test]] |
| D3-P04, D3-R13 | M204 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M204: result; from npm test]] |
| D3-R05, D3-R06 | M205 | sandbox; (g) exhaust | passed in the sandbox lane, `--slice 21` on `48841e1`; (g) the exhaustion file not run on `mini-hp01` in any record E93 to E101 | [[PENDING acc-M205: result, and (g) on mini-hp01; from npm test and --lane exhaust]] |
| D3-R11, D3-R22, D3-R23 | M206 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M206: result; from npm test]] |
| D3-S06, D3-R27 | M207 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M207: result; from npm test]] |
| D3-R12 | M208 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M208: result; from npm test]] |
| D3-X01 | M209 | kernel, real git | passed, `--slice 21` on `48841e1` | [[PENDING acc-M209: result; from npm test]] |
| D3-P10 | M210 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M210: result; from npm test]] |
| D3-P06 | M211 | sandbox | passed, `--slice 21` on `48841e1` | [[PENDING acc-M211: result; from npm test]] |
| D3-P07 | M212 | sandbox | passed, `--slice 21` on `48841e1`; verified structurally (E95 item 1), Astra's T02 attempt cases not written | [[PENDING acc-M212: result; from npm test]] |
| D3-P08 | M213 | sandbox | passed, `--slice 21` on `48841e1` | [[PENDING acc-M213: result; from npm test]] |
| D3-R01, D3-R25 | M214 | sandbox | passed, `--slice 21` on `48841e1` | [[PENDING acc-M214: result; from npm test]] |
| D3-R02, D3-R03, D3-R04 | M215 | sandbox | passed, `--slice 21` on `48841e1` | [[PENDING acc-M215: result; from npm test]] |
| D3-R07, D3-R16, D3-R24 | M216 | sandbox + kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M216: result; from npm test]] |
| D3-R08, D3-R09 | M217 | sandbox | passed, `--slice 21` on `48841e1` | [[PENDING acc-M217: result; from npm test]] |
| D3-R10 | M218 | sandbox + kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M218: result; from npm test]] |
| D3-R15 | M219 | sandbox | passed, `--slice 21` on `48841e1` | [[PENDING acc-M219: result; from npm test]] |
| D3-R14 | M220 | sandbox | passed, `--slice 21` on `48841e1` | [[PENDING acc-M220: result; from npm test]] |
| D3-R17, D3-R26 | M221 | sandbox + kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M221: result; from npm test]] |
| D3-R18, D3-R19, D3-X03 | M222 | sandbox (E97 item 2) | **failed** in `--slice 21` on `48841e1` (Q2's reach); the test fixed at `4a97d58` and passing alone (E101 item 5) | [[PENDING acc-M222: result; from npm test]] |
| D3-J01, D3-J03, D3-J04 | M223 | project | passed, `--slice 21` on `48841e1`; its wrapper hardened in slice 22 (section 9); M223 passed alone with it on `verify/m3-s22` | [[PENDING acc-M223: result; from npm test]] |
| D3-C01 to D3-C04, D3-C11 | M224 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M224: result; from npm test]] |
| D3-C05, D3-C06 | M225 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M225: result; from npm test]] |
| D3-P09 | M226 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M226: result; from npm test]] |
| D3-C07, D3-C08 | M227 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M227: result; from npm test]] |
| D3-C09, D3-C10 | M228 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M228: result; from npm test]] |
| D3-S01, D3-S02, D3-S09 | M229 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M229: result; from npm test]] |
| D3-S07 | M230 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M230: result; from npm test]] |
| D3-S03, D3-S04, D3-S08 | M231 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M231: result; from npm test]] |
| D3-S10 | M232 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M232: result; from npm test]] |
| D3-S05 | M233 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M233: result; from npm test]] |
| D3-R20, D3-R21 | M234 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M234: result; from npm test]] |
| D3-F01 | M235 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M235: result; from npm test]] |
| D3-X02 | M236 | kernel | passed, `--slice 21` on `48841e1` | [[PENDING acc-M236: result; from npm test]] |
| D3-J02, D3-J05 | M238 | project | 11 of 11, run alone by the Verifier on `verify/m3-s22` (`main`'s engine at `3c6e886`), 2026-10-08 (section 9) | [[PENDING acc-M238: result; from npm test]] |

Rows beyond Appendix C, and the second files of rows above:

| Row and file | Lane | Last recorded | Acceptance run |
|---|---|---|---|
| M201, `M201-check-journey-path-one` and its three further files | sandbox | passed, `--slice 21` on `48841e1` | [[PENDING acc-M201: each file's result; from npm test]] |
| M237, `M237-check-journey-path-two` | sandbox | passed, `--slice 21` on `48841e1` | [[PENDING acc-M237: result; from npm test]] |
| M239, `M239-the-verifiers-check-writing-package` | sandbox | 0 of 1 alone on `verify/m3-s22` (the package; the Builder's work) | [[PENDING acc-M239-sandbox: result; from npm test]] |
| M239, `M239-the-real-check-journey` | real | not run (section 14) | not in `npm test` (manifest `real`) |
| M240, `M240-the-m3-report` | report | (a) passed, (b) failed by design, alone on `verify/m3-s22` | [[PENDING acc-M240: result, (b) passing only once this report is final; from npm test]] |
| M241, `M241-hands-on-script` | hands-on | 5 of 5 alone on `verify/m3-s22`; amended by the review (section 20) | [[PENDING acc-M241: result; from npm test]] | Astra's T01 to T20, L1 to L8, B01 to B04, Q1 to Q11 and N01 to N04 are traced to rows in the plan's §4.2.

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
| D3 A.7's engine keys (`check_timeout_max`, `check_output_max_bytes`, `checktree_max_bytes`, `checktree_max_entries`, `checktrees_max_bytes`, `check_infra_retries_max`) and the project key `max_concurrent_checks` | defaults as `contract/config.json` holds them (SEAM §186); at the acceptance run: [[PENDING config-in-force: `GET /v1/engine`'s `config` at the acceptance start; from the run]] |
| `classifier_authority` | section 7 |

## 11. The kernel, sandbox and project lanes on this host

| Run | Revision | Result | Source |
|---|---|---|---|
| The driver's `--slice 15` to `--slice 21` | section 2 | section 2 | E93 to E101 |
| M238 alone | `verify/m3-s22` on `3c6e886` | 11 of 11 | this report, the Verifier's run |
| M239's sandbox file alone (`M239-the-verifiers-check-writing-package`) | `verify/m3-s22` on `3c6e886` | 0 of 1: the `check_correction` Verifier's package holds no guidance for writing checks (COVERAGE.md, "M3 slice 22") | the Verifier's run |
| M240 alone | `verify/m3-s22` | (a) passes, (b) fails by design while this report is a skeleton | the Verifier's run |
| M241 alone | `verify/m3-s22` | 5 of 5 (the script's form and guards) | the Verifier's run |
| `M3-hands-on.sh` run once without pauses | `verify/m3-s22` on `3c6e886` | exit 0, each of the five checks shown (COVERAGE.md, "M3 slice 22"); not Sean's run; made before the review's S2 fix (section 18), and without a terminal, which the script now refuses | the Verifier's run |
| M223 alone, with the hardened wrapper | `verify/m3-s22` on `3c6e886` | 1 of 1 | the Verifier's run |
| The full `npm test` | [[PENDING npm-test-rev2: `main` after slice 22; from the driver's run]] | [[PENDING npm-test-result: counts and exit; from the driver's run]] | |

## 12. The exhaustion lane

Row M205 (g), an OOM kill in a check domain (E69; SEAM §212): `M205-an-oom-kill-on-the-exhaustion-host.test.mjs`, manifest `exhaust`, run only on `mini-hp01` with `SURETY_EXHAUSTION_HOST` set. [[PENDING exhaust-run: its revision, result and the domain's `oom_kill` count; from the run on mini-hp01]]

## 13. Egress for checks

A check has no egress unless its definition names hosts within `runner_config.direct.egress_allow`, through D2's proxy (D3 §2.2; M215). The real journey's governed file allows none. [[PENDING real-egress: the real lane's role runs' egress records, accepted contacts and any unexpected contact; from its run directory]]

## 14. The real lane's run (M239)

Only by Sean's command, on his subscription token, under his approvals (E92 item 3; `docs/acceptance/reports/M3-real-lane/README.md`). Expected cost: under 1 USD in Claude Code's estimates (plan question 5), plus a possible new qualification attempt (about 0.05 USD).

| File | Rows | Spends | Date | Outcome |
|---|---|---|---|---|
| `M239-the-real-check-journey` | M239 (a) to (d) | [[PENDING m239-spend: runs and estimated cost; from the ledger]] | [[PENDING m239-date: the run's date; from its records]] | [[PENDING m239-outcome: each case's outcome; from the runner's report]] |

The dress rehearsal (SEAM §171, with the fake `claude`; never evidence) passed 4 of 4 in its fourth run directory, after three that found defects in the lane's own code (COVERAGE.md, "M3 slice 22").

## 15. The real check journey

| What | Value |
|---|---|
| (a) The checks a real Verifier wrote: its run, the proposal, its class, Sean's answer, the version and its checks | [[PENDING m239-a: from `observed/M239.json`, `path_one`]] |
| (b) The stage built by a real Builder: the candidate, every execution with its domain and qualification, both gates | [[PENDING m239-b: from `observed/M239.json`, `path_one`]] |
| (c) Path two: the seeded defect, the finding (criterion and check), the disposition, the fix's candidate, the resolving execution, the gates | [[PENDING m239-c: from `observed/M239.json`, `path_two`]] |
| (d) No result from a fixture; the token's absence | [[PENDING m239-d: from `observed/M239.json`, `key_search`]] |

The checks' toolchain in the real journey: a copy of the engine's node binary in the run directory, its SHA-256 pinned in `check_commands`, its directory the checks' only read path, their `PATH` `/usr/bin:/bin` (the slice-22 review, minor 3; SEAM §237). What stays a fixture in the real journey, labelled (SEAM §237): the approved plan with its texts and index (spec approval is not built), the trigger of the first `check_correction` work and of path two's review, and the Alpha test target. No check result.

## 16. Cases reported `not_exercised`

Each passes by asserting the host fact and its reason, and is **never counted as passed**:

- **M205 (g)**, the OOM kill, off the designated host (plan §2.5; E69): its file runs only on `mini-hp01`.
- **The self-test's `foreign_signal`** reports `not_exercised` when the engine cannot re-verify its own box's program immediately before the kill (E97 item 1); a `not_exercised` mandatory case leaves `direct` unqualified (D3 §2.8).
- Carried from M2: the observer cases M112 (g), M116 (d), M124 (e), M128 (g), M135 (j) (H13 not exercised); M115 (f) and M115 (h); P20 on this workstation (exercised on `mini-hp01`).
**Not run, and so not counted:** M239, the real row, until Sean runs it (section 14; plan §2.5). It asserts no host fact and is no `not_exercised` case: its file is never run outside Sean's command.

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

## 19. Open decisions and provisional readings (E93 to E101)

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
| Slice 22 | Section 21's questions | open |

## 20. Hands-on run

Sean runs `docs/acceptance/reports/M3-hands-on.sh` (row M241; E92 item 2 (6)): scripted roles only, no model, no token, nothing paid. It shows him a check's processes in its domain's `cgroup.procs`, its tree with no `.git`, an input write refused while a source write is discarded, the gate read with the deciding execution and its history, and a root addition classified `unclassifiable`, each as `CHECK (n)` with a command he can run himself. [[PENDING hands-on: the date, the home kept and what Sean wrote down; from his run]]

## 21. Questions for Sean

Each is a decision, with the reading the Verifier pinned and its options.

1. **How M239 is run.** `run-tests.mjs --lane real` runs every file under the manifest's `real`, so it would run M2's real lane again (M136 to M140: an attempt and a journey, paid) beside M239. *Pinned:* M239 is run alone with `node --test` after `npm run build`, as the rehearsal runs (`M3-real-lane/README.md`); its own preflight holds every guard. Options: (a) as pinned; (b) an owner's change to `run-tests.mjs` letting `--lane real` take one file; (c) move M2's real files out of `real` (they would then fail the manifest check: not chosen).
2. **The reference project's wrapper** (section 9). Hardened as a test fixture; whether D3 §6 class B should name the empty test file in its text is yours.
3. **M238's mutants by target** (SEAM §236): the vacuous-run mutants against the retained check that runs the Builder's tests, the child failure and `process.exit(0)` against the acceptance check that runs the candidate as a child. A check that imports candidate code in its own process cannot be protected against `process.exit(0)` (D3 §6 class C); the mutant is not asserted against `srctests`.
4. **M239 path two with `repair_attempts_max` 0** (objection 030's precedent): so that a real check catching the seeded defect parks the stage rather than sending it back to the Builder, and the real Verifier's finding is the path.
5. **M240 fails until final**, as M141 did (the driver's ruling then, E88): `npm test` is not green until the real run and the exhaustion run are recorded and this report is final.
6. **The Reviewer's first diff holds the engine's own setup commits** (Sean's third real try; SEAM §242). A Reviewer is shown `candidate.diff` from a base the store names: the previous candidate's revision, or, for a project's first candidate, the parent of the project's first recorded revision (`src/store/reads.ts`). The first recorded revision is the engine's bootstrap commit, so a first candidate's diff always holds the bootstrap's `.surety/project.json` and every policy revision committed before the stage (`.surety/policy.json`, the owner's settings through the policy route), beside the Builder's work. The Reviewer's context says only "the candidate's changes, from <base> (first recorded parent) to <revision>": nothing tells it which commits in that range are the engine's or the owner's rather than a role's, though the commits' trailers say so (`Surety-Project` with no `Surety-Run`). In the third try a real Reviewer raised an open medium finding on exactly those two files ("neither relates to R2 or R3"), which blocked both gates; in the first try another let the same policy change pass. Options: (a) leave it: a Reviewer may question an owner's policy change, and the human dispositions such a finding; (b) the engine's diff base for a first candidate becomes the last engine setup commit before the first role's work (the project's own configuration is not the candidate's change); (c) the context names the engine's and the owner's commits in the range and says they are not the Builder's work to review. A design decision, not built here; the harness cannot avoid these commits without working around the engine (a policy revision is the only way to set the roles' backends, and the bootstrap always records first).

## 22. How to read the suite

As the M2 report's section 22, with the lanes of the M3 plan §2.1: `node scripts/run-tests.mjs acceptance --slice 22` runs every kernel-, sandbox- and project-lane file of slices 1 to 22; `--lane exhaust` runs the exhaustion files on a host named by `SURETY_EXHAUSTION_HOST`; the real row runs by Sean's command only. The coverage record lists every named case, its file and its lane; the seam (§§177 to 239) is the contract.
