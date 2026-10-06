# Surety M2 acceptance report

**Status:** skeleton. **M2 is not accepted.** Sean's fourth attempt (the hands-on run, `M2-hands-on.sh`, 2026-10-06 01:45 to 01:49 UTC, home `~/surety-hands-on-20261006T014511Z`) qualified Claude Code against a model: its attempt succeeded, its entry was activated, and path one of the journey ran. The facts that run recorded are filled below from its records (the engine's store and `records/`, read on a copy; nothing in the home was changed). The real-lane test files (`--lane real`) have **not** run, so what only they produce stays pending: the invalid-token attempt (M139), path two (M140 (b)), their run directory's records, and a Stop of a live real process (the hands-on run did not show it, section 15). Every fact still to be supplied is marked `[[PENDING …]]`. Nothing below is described as passing that was not run.

**Written by:** the Verifier of M2 slice 14, 2026-10-04, on branch `verify/m2-s14` from `main` at `872afe9`. **For:** Sean, the owner, before and after his real run and his hands-on run; and Astra. **Form:** the M1 report's (`M1-report.md`); what M2 does not claim follows `M1-not-claimed.md` and the running list `M2-not-claimed.md`. It decides nothing.

The sources it cites: the **build specification** (`docs/spec/M2-build-spec.md`, cited BS); the **acceptance plan** (`docs/acceptance/sdlc-M2-acceptance-plan.md`, rows M101 to M142); **D2** (`docs/design/sdlc-design-D2-backends-and-isolation.md`); the **errata** (E-numbers, `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`); the **coverage record** (`packages/engine/test/acceptance/COVERAGE.md`); the **seam** (`packages/engine/test/acceptance/harness/SEAM.md`, cited "SEAM §n"). The real lane's records, once it has run, are copied to `docs/acceptance/reports/M2-real-lane/<date>/` (SEAM §163).

## 1. What M2 claims and does not claim

M2 is the engine running Claude Code in one-shot headless mode as a real backend on this WSL2 host, under D2's sandbox, cgroup boundary, trust table and egress proxy (BS §1). If accepted, it supports one claim: **on this host, with the recorded versions and limits, the engine ran one real backend through the complete journey (plan, build, verification, review, the stage gate and an issued Alpha authorization) with the engine making every commit, the backend unable to reach the control plane, every process it started observed gone, and its usage recorded as the provider reported it.** It does not support the claims that any other host, backend, version or mode is qualified, that sessions work, or that Surety can deploy anything (BS §1).

**Authentication (E74 item 1, Sean's decision).** M2's real lane runs on Sean's Claude subscription, through a long-lived token he makes himself with `claude setup-token`, held by the engine as a secret file. The engine also supports the `api_key` mode (a dedicated API key, D2 Q1), kept for later; **M2 claims only the subscription mode.** In that mode the dollar figures are Claude Code's own estimates (`total_cost_usd`, recorded `estimated`), and the hard limit is the subscription's usage limits, which Sean's own Claude use shares; there is no dollar cap on the token.

BS §1's conditions, and where each stands at the time of writing:

| Condition | State |
|---|---|
| `npm test` exits zero on `main` for the kernel and sandbox lanes, every M2 row with executable tests and none skipped | **Not established.** Every row has a file. At the closing pass of slice 14 (`1c3267f`) the unit suite and `--slice 13` passed whole and every slice-14 no-cost file passed except M141 (b), which fails by design until this report is final; so `npm test` cannot exit zero before the real lane (section 13). |
| The real lane's rows (the three canaries and the journey) passed under a qualification attempt Sean approved, records retained | **The real-lane test files: not run.** [[PENDING real lane: the `--lane real` run's date, revision and per-file result; from the runner's report and `state.json`]] The hands-on run's attempt `qa_01M47E6BB5VX6C6218EEQBAKAR`, approved by Sean (decision answered 2026-10-06 01:45:42 UTC), succeeded with all three canaries; its records are in `~/surety-hands-on-20261006T014511Z/home` (sections 7, 15, 20). |
| The host qualification and the trust entry for Claude Code `active` with their evidence | **Host:** active at every start of the hands-on run (section 5). **Entry:** `trust_01M47E8ED7P7HP7V450507H4M6`, `active`, `activated_by` `dec_01M47E8ED9EFATNWQR1GQTXWK2` (Sean's `trust_activation`, answered 2026-10-06 01:46:51 UTC), its evidence the attempt's three canary records (section 6). |
| The M2 acceptance report written | This skeleton, with the hands-on run's facts filled. |

## 2. Revisions

| What | Revision |
|---|---|
| Engine and tests at the closing pass of slice 14 | `main` at `1c3267f` (2026-10-05): slices 10 to 14 merged without the real lane (E77) |
| Slices 10 to 13 closed | `main` at `872afe9` (2026-10-04), with the M133 (g) fix (E73) |
| The slice-14 cases | merged at `165344d`; amended at `8a9c105` (M141), `3af2a16` (objection 015), `890c875` (E74, the review's S1 to S3), `72e9654` (objection 016, option B), `97195aa` (objection 017), `26d6880` (objection 018), `a980d16` (`egress_connect_hang`) |
| The engine side of slice 14 | merged at `c3a2651` (E77 item 2); the hang fault at `1c3267f` (E77 item 3) |
| The revision the hands-on run ran | **Not recorded by the run** (the engine records no revision; it reports version `0.0.0`). `main` was at `02558a1` ("ready for Sean's fourth attempt") when it ran. [[PENDING hands-on: the revision Sean's checkout held; from Sean]] |
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
| At the hands-on run (2026-10-06), as the active host qualification `hq_01M47E8V1TQ3PCZHSHB51M5FA2` recorded them | `host_id` `1a2241c9653441439658410880ea14af`; kernel `6.6.87.2-microsoft-standard-WSL2`; `unshare`, `setpriv`, `mount` util-linux 2.39.3; `ip` iproute2-6.1.0, libbpf 1.3.0; systemd 255.4-1ubuntu8.17; node v22.22.0. The distribution, git and SQLite versions are not recorded by the run. |

## 4. The backend

| What | Value |
|---|---|
| Installed on this host, 2026-10-04 (not qualified) | `~/.local/bin/claude` links to `~/.local/share/claude/versions/2.1.289` (`2.1.289 (Claude Code)`, SHA-256 `a186b99e4a9c88366cd49df2f7dad56c61fc306ef0140b19ee64b7c42a8d1348`); 2.1.286, 2.1.287 and 2.1.288 are also present (2.1.288: SHA-256 `0298068b686e7fdbaf9402a7a587bb7f49c0b0e084de09f69145a0719207640c`). The binary updated itself from 2.1.288 to 2.1.289 on 2026-10-03 at 18:24 local time. D2 was written against 2.1.288. |
| The binary qualified: path, SHA-256, `--version` | `~/surety-hands-on-20261006T014511Z/home/backends/claude-2.1.289-a186b99e4a9c8836` (the engine's pinned copy), SHA-256 `a186b99e4a9c88366cd49df2f7dad56c61fc306ef0140b19ee64b7c42a8d1348`, `2.1.289 (Claude Code)` (the entry and the attempt) |
| Help hash | `a58ca2282c01312250fc8d861088dae6e46340ad55346557fcdbc0053f415367` |
| Model | `claude-sonnet-5-5` for every canary and every role (E59), as the entry records it; every transcript of the run shows only that model and no model fallback |
| Template | `claude -p --safe-mode --setting-sources user --strict-mcp-config --output-format stream-json --verbose --model <m> --tools <role tools> --disallowed-tools Agent Task ScheduleWakeup Workflow --permission-mode bypassPermissions --no-session-persistence --session-id <uuid> <prompt>`, the credential in `CLAUDE_CODE_OAUTH_TOKEN`; template version `claude-subscription-1` |
| Auth mode | `subscription_token`, as the entry records it |
| The binary's pin | The engine's copy above, in its own home, of the same SHA-256 as the installed 2.1.289 (section 4's first row); the operator's install was not touched |

## 5. The host qualification

The checks and probes below were **observed by the Verifier on 2026-10-04 at 08:22:58 UTC**, with a sandbox-lane engine (the test mode with `--harness-host-checks run`) on `main` at `872afe9`, started only to read them: row `hq_01M4304NNF317883GPK4K4JW4F`, `active`, eligible, no failed check; mechanism fingerprint `6355857210f11c9255570fa41244ba0641ec2fa68eb50b309298e003cc59e150`; the role profile's fingerprint `c1f0ad687d34c6466dac2e3acfd46b14be8f9f20ce318cde1159ffaaae641c8f`; `bootstrap_exception` false. The hands-on run's production starts recorded their own rows; the one in force at the end, `hq_01M47E8V1TQ3PCZHSHB51M5FA2` (qualified 2026-10-06 01:46:53 UTC, `bootstrap_exception` false), records the same results as below: H1 to H12 passed, H13 not exercised, P1 to P19 passed each with its target seeded and its control, P20 not exercised (excused); H12 then read 12.1 GiB available and 539.3 GiB free. The entry was written under the row in force at the attempt, `hq_01M47E68WA25EPWTQ329HK903W` (lapsed at the next start, `engine_restart`, as every row before the last).

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

`trust_01M47E8ED7P7HP7V450507H4M6`, written 2026-10-06 01:46:40 UTC by the hands-on run's attempt, from its store:

| Field | Value |
|---|---|
| backend, version, mode | `claude`, `2.1.289 (Claude Code)`, `one_shot_headless` |
| binary, help | section 4 |
| template, version, model, auth mode | section 4 |
| capabilities | tools `Bash, Edit, Glob, Grep, Read, Write`; denied `Agent, ScheduleWakeup, Task, Workflow`; features disabled `Agent, CronCreate, Monitor, RemoteTrigger, ScheduleWakeup, SendMessage, Task, Workflow`; `delegation_verified` true |
| host id, host qualification | `1a2241c9653441439658410880ea14af`, `hq_01M47E68WA25EPWTQ329HK903W` |
| isolation, boundary | `linux-namespaces-1`, `cgroup2-delegated-scope-1` |
| profile fingerprint | `3eae8def1fb0ad5dc68542b1a86973bd7f7b29d6f06b8b16deb11003f8628ac2` |
| egress hosts | `api.anthropic.com` |
| usage granularity, semantics, cost reporting | `model_call`, `delta`, `reported` (the stream carries `total_cost_usd`; in this mode each ledger row records it `estimated`, section 8) |
| enforceable boundaries | `invocation` by `dispatch_check`, overshoot `deadline`, evidence `rec_01M47E71PKY7K2CHTT94D20MRR` |
| result channel, session_qualified | `file`, 0 |
| provider files | locations `/surety/home/.claude`, `/surety/home/.claude.json`, `/surety/out/result.json`, `/tmp/cc-socks`, `/tmp/claude-1000`; persistence flags `--no-session-persistence`; excluded `/surety/home/.claude` |
| term_to_exit_ms | 12 |
| qualification attempt | `qa_01M47E6BB5VX6C6218EEQBAKAR` |
| evidence records | `rec_01M47E71PKY7K2CHTT94D20MRR` (positive), `rec_01M47E78BZ8PZ928V6WKH9GWM4` (cancellation), `rec_01M47E8ECRFXYXXZCNF43TSQ9M` (containment); fingerprint `ab35d6b624df614d1a80446c52462c46f6367b4fa5816133f13dcf8225d92298` |
| status, activated_by | `active`, `dec_01M47E8ED9EFATNWQR1GQTXWK2` (Sean, 2026-10-06 01:46:51 UTC) |

## 7. What the canaries established

D2 §4.5 lists what only the canaries establish for Claude Code. Each is class B until the attempt succeeds (D2 §8).

| What | Established |
|---|---|
| The subscription token's delivery (the path Claude Code documents, established, not assumed) | Established: `CLAUDE_CODE_OAUTH_TOKEN`, by elimination (the stream's `apiKeySource` `"none"`, the only credential the engine gave the backend, no credential file written by the engine) (`rec_01M47E71PKY7K2CHTT94D20MRR`) |
| What loads without `--bare` (hooks, plugins, CLAUDE.md discovery, from an empty volatile home) | The positive canary's stream: `system/ui_invalidate`, `system/init` (no MCP servers), `assistant` ×9, `rate_limit_event`, `user` ×6, `system/thinking_tokens` ×3, `result/success`; no hook or plugin event. Its provider files: section 6. What else loads is not recorded |
| Usage events and their granularity | `model_call`, `delta` (the entry); the positive canary's stream carried usage at 4 steps and one terminal result |
| Terminal events (success, failure) | Success: `result/success`, `is_error` false, `terminal_reason` `completed`, `total_cost_usd` 0.0317044, usage present, one model. A failure terminal event was not observed in this run |
| The tool surface; delegation verified absent | The stream's inventory `Bash, Edit, Glob, Grep, Read, Write`, within the template's `--tools`; `delegation_verified` true by inventory; at most one backend process per sample (217 samples of the containment canary's domain) |
| What it writes despite `--no-session-persistence` | Section 6's provider files |
| Exit statuses | positive `clean` (status 0); cancellation `engine_signaled` (status 143, signal 15 sent by the engine); containment `clean` (status 0) |
| TERM to exit | 12 ms; the backend exited on the engine's SIGTERM (status 143), the barrier `/surety/out/canary-barrier` witnessed by the init at 01:46:01.010 UTC |
| Whether it accepts the engine's derived session id (SEAM §146) | Accepted (`session_id_accepted` true; the stream's session id `3d969a7c-5a35-4556-9420-3f61834e8d5f`) |
| An unauthenticated backend | [[PENDING real lane: the failure class and the kept provider error; from M139 (a)]] (the hands-on run makes no invalid-token attempt) |
| Containment, by witnessed executions | Under E86: the probe run by the domain init (`run_by` `domain_init`) beside the live backend (seen at 01:46:02.420 UTC, a member at both host reads, `running_throughout` true); each action witnessed, hardened, its expected outcome, and corroborated host-side where the engine checks: `token_read` denied (ENOENT; the token file's bytes unchanged), `git_config` denied (EACCES, the write refused; the fixture repository's configuration unchanged), `engine_port` denied (ECONNREFUSED; not corroborated host-side, as designed), `unlisted_connect` denied (403; the proxy's log shows it refused `not_listed`), `workspace_write` allowed (the control). Controls: the workspace write ran; the provider tunnel ran (`api.anthropic.com:443` accepted, 1981 bytes up, 5247 down) (`rec_01M47E8ECRFXYXXZCNF43TSQ9M`) |

## 8. The attempt's spend, and TERM to exit

| What | Value |
|---|---|
| The bounds Sean set (E59, E74) | 300 000 billable tokens a run; 25 USD a day on Claude Code's own estimates, split across the qualification fixture project (10), path one's project (6) and path two's (9) (SEAM §161); the hard limit is the subscription's usage limits, shared with Sean's own Claude use (E74 item 1). No dollar cap exists on the token; the 50 USD provider-side cap applies only to the `api_key` mode, not used in M2 |
| The most the canaries' billable tokens can use | 3 × 300 000 × 10 USD per million = 9.00 USD at list rates (an estimate in this mode), plus cache reads and any overshoot until a canary's deadline |
| The spend as estimated before approval | 9 USD, labelled `estimate`, overshoot `deadline`, no cap; basis: three canaries at the fixture project's `budget_run_billable_tokens`, at the model's output rate; price version `anthropic-list-2026-09-25-unconfirmed+cache-write-1.25x-input-derived` |
| The spend as charged | The qualification fixture project: the positive canary 0.0317044 USD and the containment canary 0.0210254 USD (`estimated`, usage complete), the cancellation canary `unknown` (usage incomplete, stopped by the engine; 297 361 tokens of unknown allowance charged); 0.0527298 USD estimated in all. The hands-on project (the journey): Builder 0.0333388, Verifier 0.0415928, Reviewer 0.0489608, the stopped Builder 0.0298692 (`estimated`; its usage marked incomplete and 295 480 tokens of unknown allowance charged, section 21 question 13); 0.1537616 USD estimated in all. The run's total: 0.2064914 USD in Claude Code's own estimates |
| The invalid-token attempt (M139) | [[PENDING real lane: its ledger row (cost unknown, not zero); from `observed/M139.json`]] (not part of the hands-on run) |
| `term_to_exit_ms` | 12 |

## 9. The configuration in force

D2 A.7's engine keys at their defaults (`contract/config.json`), the qualified configuration: `ui_bootstrap` false; `max_concurrent_domains` 2; `host_reserve_memory` 2 GiB; `host_reserve_disk` 5 GiB; `domain_memory_max` 8 GiB; `domain_tasks_max` 1024; `domain_writable_bytes` 4 GiB; `domain_writable_inodes` 200 000; `result_max_bytes` 1 MiB; `provider_files_max_bytes` 64 MiB; `collect_entries_max` 10 000; `collect_deadline` 60 s; `stream_line_max_bytes` 1 MiB; `stream_queue_max_bytes` 8 MiB; `egress_resolve_timeout` 5 s; `egress_connect_timeout` 10 s; `egress_tunnel_max_seconds` 1800 s; `egress_tunnels_max` 16; `egress_buffer_max_bytes` 1 MiB; `egress_log_max_bytes` 4 MiB; `pause_challenge_timeout` 5 s; `isolation_probe_exhaustion` false on this host (E69). Project keys at their defaults except the lane's (SEAM §161): `budget_run_boundary` `invocation`; `budget_hard_maximum` false; `egress_allow_extra` and `sandbox_read_paths` empty.

In force during the hands-on run: the engine home's `config.json` as kept, `{"api_port": 7302, "tick_interval": 600}` (written by the journey engine's start; the script writes `tick_interval` 30 for the production starts), so every A.7 key above at its default; the policy revisions recorded: the qualification fixture project `budget_run_billable_tokens` 300 000, `budget_day_verified_usd` 10, `budget_day_unknown_tokens` 900 000; the hands-on project the same with `budget_day_verified_usd` 6, every role `claude`, deadlines 900 / 600 / 600 s; the no-entry project `backend_builder` `claude`, `preflight_refusals_max` 1.

## 10. Egress

The attempt proposes `api.anthropic.com` and nothing else. In the hands-on run every role run and every canary contacted `api.anthropic.com:443` only, each CONNECT accepted (three per run). The one refused destination was the engine's own containment check, `canary-unlisted.surety.invalid:443`, refused `not_listed`. The attempt's `unexpected_contacts` is empty.

## 11. The bootstrap route during qualification

`ui_bootstrap` is false by default (K3); the real lane's engines are started without it and M141 requires it false during qualification. In the hands-on run `ui_bootstrap` was not set (`config.json` above), and every host qualification row recorded `bootstrap_exception` false, the one in force at the attempt included.

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

Output kept: [[PENDING real lane: the runner's report under `test-results/` and the run directory's copy in `docs/acceptance/reports/M2-real-lane/`]]. None of these files has run: the fourth attempt was the hands-on run (section 20), whose records are in `~/surety-hands-on-20261006T014511Z` and are not copied into the repository (section 21, question 11).

## 15. The real-backend journey

| What | Value |
|---|---|
| Path one: commits, runs, gates, authorization | The hands-on run's path one (project `hands-on`, T2): Builder `run_01M47E8WKM0EGQ93DENA8BDR7G`, Verifier `run_01M47E9DYTH92716SXBGBCHQJ6`, Reviewer `run_01M47EA9V6GRZ0JHHKJSY6G21E`, each `completed`, exit class `clean`; the candidate's stage gate `not_satisfied` before the check's (fixture) execution and `satisfied` after it, the Reviewer's sign-off recorded, the Alpha authorization's gate `satisfied`; no finding |
| Path two: real or mixed; the finding, the fix, the gates | [[PENDING real lane: from `observed/M140.json` `path_two` or `path_two_mixed`]] (the hands-on run has no path two) |
| The engine's commits (R12.2) | In `~/surety-hands-on-20261006T014511Z/repo`, on `main` after the fixture's initial commit: `9c2aeeb` (bootstrap, `Surety-Project`), `8102a69` (policy revision 1, `Surety-Project`, `Surety-Policy-Revision`), and the journey's one commit `c41d5c4` (`Surety-Run` the Builder's run, `Surety-Role` builder, `Surety-Base`, `Surety-WorkItem`, `Surety-Kind` `stage_build`), each by `Surety Engine <engine@surety.invalid>`; none is the agent's |
| The ledger against the transcripts (R12.3) | For each run that ended with a terminal event (the three canaries' two clean ones and the journey's four), the ledger row's billable, cached and output tokens and its cost equal the terminal event's `modelUsage` sums and `total_cost_usd` exactly, recorded `estimated`; the cancellation canary, ended by the engine before any terminal event, is `unknown` with its allowance charged, not zero |
| The Stop (R12.4): `populated 0` read before the run read said ended | **Not shown by this run** (its CHECK (8) printed "not shown"). The Builder `run_01M47EB1MYFV3TT76JX60SW9Q2` finished its task on its own in 12 s (01:48:06 to 01:48:18 UTC, terminal event, exit status 0) and waited at the script's `boundary.before_terminated` barrier until Sean's Stop at 01:49:41; the engine then recorded `domain.terminated` (`populated 0`, `term_sent` false), exit class `clean`, and the run `stopped` / `human_stop`. No live process was stopped. The engine's live termination is shown by the cancellation canary (`engine_signaled`, `term_to_exit_ms` 12). [[PENDING real lane: a Stop of a live real process, `populated 0` read before the run read said ended; from `observed/M140.json` `stop_case`, or Sean's decision (section 21, question 12)]] |
| The subscription token's absence | The script's search (step 11) over the engine home and the repository, reading the token from its file, found it nowhere, as Sean reported from its output; the script kept `~/surety-hands-on-20261006T014511Z/token-grep.err`, which lists the 5 files it could not read, each the engine's execute-only copy of node. The search's result itself is not kept in a file |

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

**Class B as it stands after the hands-on run**: the hands-on run's canaries established, for Claude Code 2.1.289 on this host, section 7's items except one: the subscription token's delivery, the stream's usage and terminal-success events, the tool surface with delegation verified absent, what it writes despite `--no-session-persistence`, the exit statuses, TERM to exit, the derived session id, and containment by witnessed executions. Still class B: how an unauthenticated backend fails (M139, not run), a failure terminal event (not observed), and what loads without `--bare` beyond the stream's events. Before the hands-on run, all of D2 §4.5's "established by the canaries" items were class B; Codex (not in M2, E59 item 6); a second host for anything but the exhaustion lane; every `not_exercised` case of section 16.

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

Sean runs `docs/acceptance/reports/M2-hands-on.sh` (row M142): it begins with step 0, his own `claude setup-token` into a mode-600 file (never pasted into the script), explains that the runs use his subscription's allowance shared with his own Claude use and how to revoke the token after M2, refuses to start without the token's reference and his confirmation, asks before every paid step saying what it can cost at most, waits for his two approvals, and prints checks (1) to (9) each with the command he can run himself. **The fourth attempt, 2026-10-06 01:45 to 01:49 UTC** (home `~/surety-hands-on-20261006T014511Z`), ran every step: the host qualification (CHECK (1)); a dispatch with no entry refused `backend_refused`, no process (CHECK (2)); `surety qualify` with its preview (CHECK (3)); Sean's approval; the three canaries passing with a canary's domain shown (CHECK (4)); the containment evidence (CHECK (5)); his activation; path one of the journey with its commits and its ledger against the transcripts (CHECKs (6), (7)); a Stop, whose run had already ended its processes, so CHECK (8) is not shown (section 15); the token searched for and found nowhere (CHECK (9)). The earlier attempts (E82, E84, E86) and why each stopped are in the errata. [[PENDING hands-on: what Sean checked himself, and what surprised him; from Sean]]

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
11. **What counts as the real lane's records for M141.** M141 (b) is met only by a final report whose real-lane test files have run, with their run directory (`state.json` and the observations of M136 to M140) copied to `docs/acceptance/reports/M2-real-lane/`. The fourth attempt was the hands-on run, which produces none of those, does no invalid-token attempt (M139) and has no path two (M140 (b)). Options: (a) run the real-lane files (`--lane real`), which repeats the attempt and the journey and adds M139 and path two; (b) accept the hands-on run as the real lane's evidence for what it covered, keep its home's records as the report's source (copied into the repository or not), and decide M139 and path two separately. M141 is unchanged until you decide; it fails by design meanwhile.
12. **The Stop of a live real process (R12.4; CHECK (8)).** Not shown: the Builder of step 10 finished in 12 s, before the Stop. Options: (a) rerun step 10 alone with a task that keeps the backend busy for longer; (b) accept the cancellation canary's live termination (the engine's SIGTERM to a running real backend, exit within 12 ms, the domain read empty before the run ended) as R12.4's evidence. Recommendation: (a), since R12.4 is the human's Stop and the canary's is the engine's own.
13. **Finding: the Stop recorded over a clean exit.** The Stop's run had exited `clean` with a terminal event and a result 83 s before the Stop (it waited at the script's barrier); the engine recorded it `stopped` / `human_stop`, its result an `unaccepted_result` and its usage incomplete with 295 480 tokens of unknown allowance charged, although the terminal event reported every count and the cost. SEAM §143 and D2 §1.6 give a `clean` exit with an accepted result the outcome `completed`, unless the engine began cancellation before the exit (here `term_sent` false). The Verifier reads this as an engine defect, made reachable by the script's barrier holding the natural end; a sandbox-lane case can be written on your word.
14. **Finding: `runs.model_observed` is null on every run** of the hands-on run, while each ledger row records `model_observed` `claude-sonnet-5-5`. D1 A.3 lists the column as optional and no section pins when it is set. Whether the run should carry the observed model (as E86 item 3's fallback rule reads it) is yours; a case can follow.

## 22. How to read the suite

As the M1 report's section 10, with the lanes of the M2 plan §2.1: `node scripts/run-tests.mjs acceptance --slice 14` runs every kernel- and sandbox-lane file of slices 1 to 14; `--lane exhaust` runs the exhaustion files on a host named by `SURETY_EXHAUSTION_HOST`; `--lane real` runs the real lane, by Sean only. The coverage record lists every named case, its file and its lane; the seam (§§113 to 166) is the contract.
