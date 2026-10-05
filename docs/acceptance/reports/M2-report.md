# Surety M2 acceptance report

**Status:** skeleton. **M2 is not accepted.** The real lane has not run: no real backend has been run against a model, no qualification attempt has been approved, and no trust entry exists. Every fact the real lane is to supply is marked `[[PENDING real lane: <what>; from <source>]]` and is to be filled from the run's records after Sean runs it. Nothing below is described as passing that was not run.

**Written by:** the Verifier of M2 slice 14, 2026-10-04, on branch `verify/m2-s14` from `main` at `872afe9`. **For:** Sean, the owner, before and after his real run and his hands-on run; and Astra. **Form:** the M1 report's (`M1-report.md`); what M2 does not claim follows `M1-not-claimed.md` and the running list `M2-not-claimed.md`. It decides nothing.

The sources it cites: the **build specification** (`docs/spec/M2-build-spec.md`, cited BS); the **acceptance plan** (`docs/acceptance/sdlc-M2-acceptance-plan.md`, rows M101 to M142); **D2** (`docs/design/sdlc-design-D2-backends-and-isolation.md`); the **errata** (E-numbers, `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`); the **coverage record** (`packages/engine/test/acceptance/COVERAGE.md`); the **seam** (`packages/engine/test/acceptance/harness/SEAM.md`, cited "SEAM §n"). The real lane's records, once it has run, are copied to `docs/acceptance/reports/M2-real-lane/<date>/` (SEAM §163).

## 1. What M2 claims and does not claim

M2 is the engine running Claude Code in one-shot headless mode as a real backend on this WSL2 host, under D2's sandbox, cgroup boundary, trust table and egress proxy (BS §1). If accepted, it supports one claim: **on this host, with the recorded versions and limits, the engine ran one real backend through the complete journey (plan, build, verification, review, the stage gate and an issued Alpha authorization) with the engine making every commit, the backend unable to reach the control plane, every process it started observed gone, and its usage recorded as the provider reported it.** It does not support the claims that any other host, backend, version or mode is qualified, that sessions work, or that Surety can deploy anything (BS §1).

**Authentication (E74 item 1, Sean's decision).** M2's real lane runs on Sean's Claude subscription, through a long-lived token he makes himself with `claude setup-token`, held by the engine as a secret file. The engine also supports the `api_key` mode (a dedicated API key, D2 Q1), kept for later; **M2 claims only the subscription mode.** In that mode the dollar figures are Claude Code's own estimates (`total_cost_usd`, recorded `estimated`), and the hard limit is the subscription's usage limits, which Sean's own Claude use shares; there is no dollar cap on the token.

BS §1's conditions, and where each stands at the time of writing:

| Condition | State |
|---|---|
| `npm test` exits zero on `main` for the kernel and sandbox lanes, every M2 row with executable tests and none skipped | **Not established.** Every row has a file. At the closing pass of slice 14 (`1c3267f`) the unit suite and `--slice 13` passed whole and every slice-14 no-cost file passed except M141 (b), which fails by design until this report is final; so `npm test` cannot exit zero before the real lane (section 13). |
| The real lane's rows (the three canaries and the journey) passed under a qualification attempt Sean approved, records retained | **Not run.** [[PENDING real lane: the `--lane real` run's date, revision and per-file result; from the runner's report and `state.json`]] |
| The host qualification and the trust entry for Claude Code `active` with their evidence | **Host: active at every sandbox-lane start since slice 12** (section 5). **Entry: none.** [[PENDING real lane: the entry's id and `activated_by`; from `observed/activation.json`]] |
| The M2 acceptance report written | This skeleton. |

## 2. Revisions

| What | Revision |
|---|---|
| Engine and tests at the closing pass of slice 14 | `main` at `1c3267f` (2026-10-05): slices 10 to 14 merged without the real lane (E77) |
| Slices 10 to 13 closed | `main` at `872afe9` (2026-10-04), with the M133 (g) fix (E73) |
| The slice-14 cases | merged at `165344d`; amended at `8a9c105` (M141), `3af2a16` (objection 015), `890c875` (E74, the review's S1 to S3), `72e9654` (objection 016, option B), `97195aa` (objection 017), `26d6880` (objection 018), `a980d16` (`egress_connect_hang`) |
| The engine side of slice 14 | merged at `c3a2651` (E77 item 2); the hang fault at `1c3267f` (E77 item 3) |
| The revision the real lane ran | [[PENDING real lane: the revision; from the runner's report header and `git rev-parse HEAD` at the run]] |
| The contract files | `packages/engine/test/acceptance/contract/` at the same revision as the tests |

## 3. The host

Observed by the Verifier on 2026-10-04 (the tools' own output; not a qualification):

| What | Value |
|---|---|
| `host_id` (`/etc/machine-id`, SEAM §116) | `1a2241c9653441439658410880ea14af` |
| Kernel | `6.6.87.2-microsoft-standard-WSL2` |
| WSL2 | yes |
| Distribution | Ubuntu 24.04.3 LTS |
| util-linux (`unshare`, `setpriv`, `mount`) | 2.39.3 |
| `ip` | iproute2-6.1.0, libbpf 1.3.0 (`/usr/sbin/ip`) |
| systemd | 255 (255.4-1ubuntu8.17); the user manager delegates `cpu memory pids` (E64 item 6) |
| Node | v22.22.0 |
| git | 2.43.0 |
| SQLite (through `better-sqlite3`) | 3.53.4 |
| At the real run | [[PENDING real lane: the same facts as recorded at the run; from `observed/attempt.json` `host`]] |

## 4. The backend

| What | Value |
|---|---|
| Installed on this host, 2026-10-04 (not qualified) | `~/.local/bin/claude` links to `~/.local/share/claude/versions/2.1.289` (`2.1.289 (Claude Code)`, SHA-256 `a186b99e4a9c88366cd49df2f7dad56c61fc306ef0140b19ee64b7c42a8d1348`); 2.1.286, 2.1.287 and 2.1.288 are also present (2.1.288: SHA-256 `0298068b686e7fdbaf9402a7a587bb7f49c0b0e084de09f69145a0719207640c`). The binary updated itself from 2.1.288 to 2.1.289 on 2026-10-03 at 18:24 local time. D2 was written against 2.1.288. |
| The binary qualified: path, SHA-256, `--version` | [[PENDING real lane: `binary_path`, `binary_sha256`, `version`; from the entry in `observed/attempt.json`]] |
| Help hash | [[PENDING real lane: `help_sha256`; from the entry]] |
| Model | `claude-sonnet-5-5` for every canary and every role (E59). [[PENDING real lane: the model the entry records; from the entry]] |
| Template | The subscription mode's template, D2 §4.5's text without `--bare` (E74 item 1), a template version of its own. [[PENDING real lane: the template and version the entry records]] |
| Auth mode | `subscription_token` (E74 item 1). [[PENDING real lane: `auth_mode` as the entry records it]] |
| The binary's pin | The engine copies the qualified binary into its own home and pins the copy (E74 item 3, the driver's default), so neither Claude Code's updater nor its installer's pruning can change or remove it. [[PENDING real lane: the copy's path and SHA-256; from the entry]] |

## 5. The host qualification

The checks and probes below were **observed by the Verifier on 2026-10-04 at 08:22:58 UTC**, with a sandbox-lane engine (the test mode with `--harness-host-checks run`) on `main` at `872afe9`, started only to read them: row `hq_01M4304NNF317883GPK4K4JW4F`, `active`, eligible, no failed check; mechanism fingerprint `6355857210f11c9255570fa41244ba0641ec2fa68eb50b309298e003cc59e150`; the role profile's fingerprint `c1f0ad687d34c6466dac2e3acfd46b14be8f9f20ce318cde1159ffaaae641c8f`; `bootstrap_exception` false. The real lane's production start records its own row, which replaces this one for the report: [[PENDING real lane: the host qualification row in force during the attempt, its checks and probes; from `observed/attempt.json` `host.host_qualification_row`]].

| Check | Result | Observed |
|---|---|---|
| H1 | passed | kernel 6.6.87.2-microsoft-standard-WSL2; `cgroup.kill` present in the engine's scope |
| H2 | passed | cgroup2 at `/sys/fs/cgroup`, `nsdelegate` |
| H3 | passed | the incarnation scope with `Delegate=yes`, owned by uid 1000; the engine in its `supervisor` leaf |
| H4 | passed | `memory` and `pids` delegated; `cgroup.kill` present; `memory.swap.max` set to 0 in a probe cgroup |
| H5 | passed | user, mount, pid, network, ipc, uts and cgroup namespaces created without privilege |
| H6 | passed | `unshare`, `setpriv`, `mount`, `umount`, `pivot_root` (util-linux 2.39.3), `ip` (iproute2-6.1.0), `mknod` (coreutils 9.4), each resolved with its version |
| H7 | passed | node v22.22.0 ran from a read-only bind inside the sandbox |
| H8 | passed | the engine home on ext4, outside every mount plan |
| H9 | passed | P1 to P19 passed; P20 not exercised, excused (`not_designated`: `isolation_probe_exhaustion` false, E69 item 3) |
| H10 | passed | P11: `/mnt/c/Windows/System32/cmd.exe` (SHA-256 `97ac98b1…c7dabb`) ran in the host control and not inside; P12: the role's mount table against the validated plan (115 mounts) |
| H11 | passed | a 1 MiB, 64-inode volatile tmpfs stopped a 2 MiB write at 1 048 576 bytes and creation at 46 files; the overlay's lower layer unchanged |
| H12 | passed | 12.8 GiB available (10.0 GiB needed); 562.5 GiB free on the home's filesystem (9.0 GiB needed) |
| H13 | not exercised | no observer loader configured (`kernel.unprivileged_bpf_disabled = 2`); optional, never required |

| Probe | Result | Target seeded | Control |
|---|---|---|---|
| P1 to P19 | each passed | each true | each true |
| P20 | not exercised (excused on this host, E69 item 3; passed on `mini-hp01`, section 13) | false | — |

## 6. The trust entry for Claude Code

None exists. [[PENDING real lane: every field of the entry (backend, version, binary path and SHA-256, help SHA-256, mode, template and version, model, auth mode, capabilities, host id, host qualification, isolation, boundary, profile fingerprint, egress hosts, usage granularity and semantics, cost reporting, enforceable boundaries, result channel, session_qualified, provider files, term_to_exit_ms, qualification attempt, evidence records, evidence fingerprint, status, activated_by), each with its evidence record; from `observed/attempt.json` `attempt.entry`, `entry_evidence` and `observed/activation.json`]]

## 7. What the canaries established

D2 §4.5 lists what only the canaries establish for Claude Code. Each is class B until the attempt succeeds (D2 §8).

| What | Established |
|---|---|
| The subscription token's delivery (the path Claude Code documents, established, not assumed) | [[PENDING real lane: `credential_delivery`; from the positive canary's evidence, M136 (b)]] |
| What loads without `--bare` (hooks, plugins, CLAUDE.md discovery, from an empty volatile home) | [[PENDING real lane: from the canaries' streams and provider files]] |
| Usage events and their granularity | [[PENDING real lane: `usage_granularity`, `usage_semantics`, the events carrying usage; from the entry and the positive canary's stream, M136 (b), (d)]] |
| Terminal events (success, failure) | [[PENDING real lane: the terminal event's fields; from `observed/M136.json` `terminal_event`]] |
| The tool surface; delegation verified absent | [[PENDING real lane: `capabilities`, the stream's inventory if any, the most backend processes per sample; from M136 (c)]] |
| What it writes despite `--no-session-persistence` | [[PENDING real lane: `provider_files`; from M136 (b)]] |
| Exit statuses | [[PENDING real lane: the canaries' `exit_evidence`; from `observed/attempt.json`]] |
| TERM to exit | [[PENDING real lane: `term_to_exit_ms` and the signal that ended it; from M137 (a)]] |
| Whether it accepts the engine's derived session id (SEAM §146) | [[PENDING real lane: from `observed/M136.json` `session_id`]] |
| An unauthenticated backend | [[PENDING real lane: the failure class and the kept provider error; from M139 (a)]] |
| Containment, by witnessed executions | [[PENDING real lane: each action's witness, outcome and host corroboration, and the controls; from M138]] |

## 8. The attempt's spend, and TERM to exit

| What | Value |
|---|---|
| The bounds Sean set (E59, E74) | 300 000 billable tokens a run; 25 USD a day on Claude Code's own estimates, split across the qualification fixture project (10), path one's project (6) and path two's (9) (SEAM §161); the hard limit is the subscription's usage limits, shared with Sean's own Claude use (E74 item 1). No dollar cap exists on the token; the 50 USD provider-side cap applies only to the `api_key` mode, not used in M2 |
| The most the canaries' billable tokens can use | 3 × 300 000 × 10 USD per million = 9.00 USD at list rates (an estimate in this mode), plus cache reads and any overshoot until a canary's deadline |
| The spend as estimated before approval | [[PENDING real lane: the attempt's `spend`; from `observed/attempt.json` `proposed`]] |
| The spend as charged | [[PENDING real lane: each canary's ledger row and the day's totals; from `observed/attempt.json`]] |
| The invalid-token attempt (M139) | [[PENDING real lane: its ledger row (cost unknown, not zero); from `observed/M139.json`]] |
| `term_to_exit_ms` | [[PENDING real lane: from the cancellation canary]] |

## 9. The configuration in force

D2 A.7's engine keys at their defaults (`contract/config.json`), the qualified configuration: `ui_bootstrap` false; `max_concurrent_domains` 2; `host_reserve_memory` 2 GiB; `host_reserve_disk` 5 GiB; `domain_memory_max` 8 GiB; `domain_tasks_max` 1024; `domain_writable_bytes` 4 GiB; `domain_writable_inodes` 200 000; `result_max_bytes` 1 MiB; `provider_files_max_bytes` 64 MiB; `collect_entries_max` 10 000; `collect_deadline` 60 s; `stream_line_max_bytes` 1 MiB; `stream_queue_max_bytes` 8 MiB; `egress_resolve_timeout` 5 s; `egress_connect_timeout` 10 s; `egress_tunnel_max_seconds` 1800 s; `egress_tunnels_max` 16; `egress_buffer_max_bytes` 1 MiB; `egress_log_max_bytes` 4 MiB; `pause_challenge_timeout` 5 s; `isolation_probe_exhaustion` false on this host (E69). Project keys at their defaults except the lane's (SEAM §161): `budget_run_boundary` `invocation`; `budget_hard_maximum` false; `egress_allow_extra` and `sandbox_read_paths` empty.

In force during the real run: [[PENDING real lane: the engine's `config.json` and each project's policy revision; from the engine home and `GET /v1/projects/:p/policy` as recorded]].

## 10. Egress

The attempt proposes `api.anthropic.com` and nothing else. [[PENDING real lane: the hosts the canaries contacted, every refused destination and the attempt's `unexpected_contacts`; from `observed/M136.json` `egress`]]

## 11. The bootstrap route during qualification

`ui_bootstrap` is false by default (K3); the real lane's engines are started without it and M141 requires it false during qualification. [[PENDING real lane: `bootstrap_exception` as `GET /v1/engine` showed it at the attempt; from `observed/attempt.json` `host.engine_read`]]

## 12. The execution observer

Not available. H13 is `not_exercised` on this host (`kernel.unprivileged_bpf_disabled = 2`); Sean's feasibility run (E57) has not been made. The five optional cases (M112 (g), M116 (d), M124 (e), M128 (g), M135 (j)) report `not_exercised` and are never counted as passed. Nothing is claimed by the observer's absence.

## 13. The kernel and sandbox lanes on this host, and the exhaustion lane

Each run below was made and its output kept by the session named; this report repeats their figures and runs nothing of its own except where it says so.

| Run | Revision | Result | Source |
|---|---|---|---|
| `--slice 13`, the closing run of slice 13 | `main` at `36f1539` | 1 018 of 1 018 cases in 162 files, none skipped; unit 172 tests in 35 files | COVERAGE.md, "M2 slice 13", "The closing run" |
| `--slice 13`, the driver's rerun before the merge | `9ca622e` | 1 018 of 1 018 in 162 files; unit 172 in 35 | E72 |
| `--slice 13`, the driver's regression after the M133 (g) fix | `5cc1e62` | 1 018 of 1 018; unit 173 | E73 item 3 |
| `--slice 13`, the slice-14 Verifier's run after the manifest change | `verify/m2-s14` at `f3deecb` | 1 018 of 1 018 in 162 files, none skipped (unit suite not run) | COVERAGE.md, "M2 slice 14", "Checks" |
| M137 (b), the cancellation canary's negatives (sandbox lane, new in slice 14) | `main` at `872afe9` | 2 of 2 | COVERAGE.md, "M2 slice 14" |
| The exhaustion lane on `mini-hp01` (bare metal, Arch-based, kernel 7.1.9, Node 22.22.0) | `main` at `36f1539`, then the fix | `M110-host-checks-and-scope` 4 of 4, `M112` 6 of 6, `M116` 4 of 4; `M130-exit-classes-limits` 2 of 2; `M133-resource-limits` 8 of 9, then 9 of 9 against the fix, P20 passed with `isolation_probe_exhaustion` true; every OOM kill confined to a test domain's or a P20 box's memory cgroup; the staging containers up throughout | E73 |
| The closing pass of slice 14: `npm run test:unit`, then `--slice 13` | `main` at `1c3267f` (slice 14's engine side and the hang fault merged) | unit 214 of 214 in 41 files; `--slice 13` 1 018 of 1 018 in 162 files, none skipped | COVERAGE.md, "M2 slice 14 (engine side, closing run)" |
| The slice-14 no-cost files, each alone, same revision | `main` at `1c3267f` | M125 3/3, M133 option B 1/1, M136 with a fake backend 4/4, M137 (b) 2/2, M140 credential never echoed 1/1, M142 5/5; M141 1/2, its (b) failing by design (the report is a skeleton) | same |
| The full `npm test` | — | **not run on any revision**; it fails at M141 (b) by design until this report is final | — |

## 14. The real lane's runs

The real lane runs only by Sean's command (`node scripts/run-tests.mjs acceptance --lane real`), with his subscription token's reference, his confirmation and his answers (SEAM §159). The files run in this order; each records what it saw in the run directory (SEAM §163).

| File | Rows | Spends | Date | Outcome |
|---|---|---|---|---|
| `M139-unauthenticated-canary` | M139 (a), (b) | no tokens (an invalid subscription token) | [[PENDING real lane: date]] | [[PENDING real lane: per case]] |
| `M136-positive-canary` | M136 (a) to (d) | the attempt: 3 canaries | [[PENDING real lane: date]] | [[PENDING real lane: per case]] |
| `M137-cancellation-canary` | M137 (a), (c) | none beyond the attempt | [[PENDING real lane: date]] | [[PENDING real lane: per case]] |
| `M138-containment-canary` | M138 (a) to (c) | none beyond the attempt | [[PENDING real lane: date]] | [[PENDING real lane: per case]] |
| `M140-real-backend-journey` | M140 (a) to (e) | path one 3 runs, the Stop 1, path two 6 | [[PENDING real lane: date]] | [[PENDING real lane: per case; path two real or mixed]] |

Output kept: [[PENDING real lane: the runner's report under `test-results/` and the run directory's copy in `docs/acceptance/reports/M2-real-lane/`]].

## 15. The real-backend journey

| What | Value |
|---|---|
| Path one: commits, runs, gates, authorization | [[PENDING real lane: from `observed/M140.json` `path_one`, `commits`]] |
| Path two: real or mixed; the finding, the fix, the gates | [[PENDING real lane: from `observed/M140.json` `path_two` or `path_two_mixed`]] |
| The engine's commits (R12.2) | [[PENDING real lane: each commit with its trailers and identity; from `observed/M140.json` `commits`]] |
| The ledger against the transcripts (R12.3) | [[PENDING real lane: from `observed/M140.json` `ledger_against_transcripts`]] |
| The Stop (R12.4): `populated 0` read before the run read said ended | [[PENDING real lane: from `observed/M140.json` `stop_case`]] |
| The subscription token's absence | [[PENDING real lane: the search's roots and repositories and its result; from `observed/M140.json` `key_search`]] |

What stays a fixture in the journey, labelled: the approved plan and its texts, the protected check's declaration and **its execution** (D3's runner is not built: the check is recorded passed by the test, as row M01 records it, and is evidence of nothing about the code), and the Alpha test target.

## 16. Cases reported `not_exercised`

Each passes by asserting the host fact and its reason, and is **never counted as passed** (M2 plan §2.5):

- the observer cases M112 (g), M116 (d), M124 (e), M128 (g), M135 (j): H13 not exercised;
- M115 (f), a member the kill cannot end (no unprivileged way to make one);
- M115 (h), a real stop of the user manager (a `daemon-reexec` and the `manager_unreachable` fault stand in; E59 item 5);
- P20 in this host's start-up suite (excused, E69 item 3; exercised on `mini-hp01`);
- the Docker path of P10 and P11 are exercised here (Docker present, WSL2); M119 (d)'s host submount and M122 (d) ran in full on this host.

## 17. What M2 does not claim

**D2 §8, class A** (outside the threat model): protection against root, a kernel exploit, the user's systemd manager, a compromised operator account, or Windows-side software on a WSL2 host; what the provider retains of what it is sent.

**Class B as it stands after the real lane**: [[PENDING real lane: D2 §8 class B less what the canaries established; from section 7]]. Before the real lane, all of D2 §4.5's "established by the canaries" items are class B; Codex (not in M2, E59 item 6); a second host for anything but the exhaustion lane; every `not_exercised` case of section 16.

**Class C, verbatim from D2 §8** (under E74, "the role holds its provider key" reads "the role holds its subscription token": a leaked token reaches the subscription account, which Sean revokes; the egress proxy allows only the provider): Q2's limitation, as Sean decided it: the role holds its provider key, so the backend's reported usage is attributed evidence, not an independent meter of all the key could spend; a role can make extra provider calls through the allowed destination, and a hard maximum belongs to a provider-side limit on the key, not to the engine. The role can read that key, and can copy or encode it into its workspace or send it to an allowed host; the secret screen (§2.5) detects registered raw and escaped forms only, never an arbitrary encoding. The proxy restricts destinations, not content. At the `invocation` boundary, overshoot within one invocation is bounded only by the deadline (§4.2). A crash loses the volatile filesystem: the role's unsnapshotted workspace changes, its provider files and its unvalidated result are recorded missing and are not recovered, so a Resume starts from the last snapshot (E30 item 10 does not apply to real backends). The mount plan is validated before each launch; a socket or credential an operator's own software creates in an approved `sandbox_read_paths` directory after that validation is not caught. The role reads all of the repository's objects and refs (F §3.10.8). A same-uid process outside every domain can read the token file and replace a backend binary between the hash check and the exec. With `ui_bootstrap` on, any local uid can obtain the token (§2.6). Sessions, filter drivers, Git LFS, partial clones, repositories with alternates, and any host other than Linux are not supported. The optional execution observer (§3.9) is a qualification aid only: production monitoring and BPF-based enforcement are out of D2's scope, and no claim rests on an event the observer did not record.

**Bucket C of the triage** (`M1-not-claimed.md` class B, unchanged by M2; M2 plan §4.3): M11 (a requirement-versus-contract contradiction goes to a person), M20 (git output over the cap), M27 (the verified set frozen at nomination), M31 with M32 (a workspace whose repository entry was pruned by hand), M43 (a module's tier override and a sensitive area's required checks), M58 (a notification plainly refused by its channel), M70 (a record file replaced by a real device file), M72 (the event stream filtered to one project).

**Everything listed in `M2-not-claimed.md`**, slice by slice (slices 10 to 13, with the review residuals; the "After slice 14" entries for the real lane), carried here by reference and brought to the state after the real lane when this report is final.

**The M1 report's instrument limits stand:** storage that honours a sync is assumed, not established (E32 item 1); a clock that steps (E38).

## 18. Limits of the instruments

- The sandbox lane proves the mechanisms on this host and kernel (WSL2 6.6.87.2), not on another (BS §8).
- The exhaustion proof is `mini-hp01`'s (kernel 7.1.9, bare metal), at the test caps (`pids.max` 64, `memory.max` 64 MiB, 1 MiB and 64 inodes), not at the engine's defaults (E69, E73).
- In the kernel lane, host eligibility is the harness's say-so (E61 item 3).
- The real lane's evidence is the attempt's records at the recorded versions (BS §8); a binary that updates itself is a different binary (section 21, question 1).
- The real journey's engine ran in the engine's test mode for the real lane (`--harness-real-lane`), because the plan, the check's declaration and execution, and the Alpha target are fixtures in M2; the entry it dispatched to was written and activated by a production engine (SEAM §164).
- A check's execution is a fixture throughout M2; no check runner exists (D3).
- The observer, absent, adds nothing and nothing is claimed by its absence.
- A destructive role action is released only after the host has read the role contained; this guard exists because a test once ended every process of the user on this machine (E64 item 1).

## 19. What the build learned

[[PENDING report: written when the report is final, from E59 to the real lane's record: the session-ending test and the fail-closed instruments (E64), the kill-path audit (E65), the forgeable containment witness and its redesign (E71, E72), the descriptors inherited from a Tailscale session found on `mini-hp01` (E71 item 1), the over-bound stream line kept in the transcript (E73), and whatever the real lane shows]]

## 20. Hands-on run

Sean runs `docs/acceptance/reports/M2-hands-on.sh` (row M142): it begins with step 0, his own `claude setup-token` into a mode-600 file (never pasted into the script), explains that the runs use his subscription's allowance shared with his own Claude use and how to revoke the token after M2, refuses to start without the token's reference and his confirmation, asks before every paid step saying what it can cost at most, waits for his two approvals, and prints checks (1) to (9) each with the command he can run himself. [[PENDING hands-on: the date, what he checked, and what surprised him; from Sean]]

## 21. Questions for Sean

These are open at the time of writing; each is a decision, with options and the Verifier's recommendation.

1. **Pinning Claude Code against its self-updater.** The binary updated itself from 2.1.288 to 2.1.289 overnight (2026-10-03 18:24), and an entry bound to a file that changes or goes is revoked by design (D2 §7.3). *The driver's default (E74 item 3):* the engine copies the qualified binary into its own home and pins the copy, and sets `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` in the backend's environment; your own install and settings are never touched. (The Verifier checked that a copy of 2.1.289 answers `--version` from another path with an empty `HOME` and writes nothing.) Sean confirms.
2. **The chain boundary in the real lane** (SEAM §162). *The driver's default: (a).* The journey's test answers `continue` at the chain boundary as row M01 does; each answer starts a paid run within the project's limits. Options: (a) as written; (b) the test waits for Sean's answer at each boundary as it does for the two money decisions. Recommendation: (a) for the test, since his activation already authorizes the journey and the limits bound it; the hands-on script asks him before each run either way.
3. **M141 and `npm test`.** *Decided by the driver, provisionally (2026-10-04):* M141's file fails while this report holds any pending fact, with "the real lane has not run: the M2 report is a skeleton (N pending facts)", so `--slice 14` and `npm test` fail until the real lane has run and the report is final (SEAM §163). Sean confirms or overturns.
4. *The driver's default: keep the flags.* **The engine's credential flags** (`--secret-file`, `--provider-cap-usd`, SEAM §160) rather than a configuration key. Recommendation: keep the flags for M2; a configuration key belongs with the UI's settings later.
5. *The driver's default: as written.* **The day's 25 USD split across projects** (10 / 6 / 9, SEAM §161). Recommendation: as written; raise a project's limit only by policy, which is a widening and asks you.
6. **The price of `claude-sonnet-5-5`** in the engine's table (2 / 10 / 0.20 USD per million, as cached on 2026-09-25), used for the attempt's estimate; in the subscription mode the ledger's figures are Claude Code's own `total_cost_usd`. Confirm the list rates.
7. **Whether automated use fits your subscription's terms** is yours to check (E74 item 1).
8. **`DISABLE_UPDATES`'s value** (objection 016). The documentation read names the variable without a value; M125 (b) pins `1` by its sibling's convention (the driver's default, E76 item 1).
9. **The `<version>` in the pinned copy's name** (objection 016). The tests take the first word of the binary's own `--version` (the driver's default, E76 item 1).
10. **The engine requesting a tick when a quarantined domain's launcher exits** (E77 item 1). It is recorded as a later improvement and not built; recovery waits for the next scheduled tick.

## 22. How to read the suite

As the M1 report's section 10, with the lanes of the M2 plan §2.1: `node scripts/run-tests.mjs acceptance --slice 14` runs every kernel- and sandbox-lane file of slices 1 to 14; `--lane exhaust` runs the exhaustion files on a host named by `SURETY_EXHAUSTION_HOST`; `--lane real` runs the real lane, by Sean only. The coverage record lists every named case, its file and its lane; the seam (§§113 to 166) is the contract.
