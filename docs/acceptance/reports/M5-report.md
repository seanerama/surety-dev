# Surety M5 acceptance report

**Status:** final, with one fact still running when it was written and left as the only placeholder: the fix of `M66-backup-and-restore`'s fixture on `mini-hp01`'s git (section 10). **M5 is not yet accepted:** acceptance is Sean's decision (BS5 §1). The gate at the final engine `a92ceb6` on `mini-hp01`: 393 files, 2,113 passed, 5 failed; M445 (b) by design, three passing alone three times each, and M66 failing at a fixture step on `mini-hp01`'s git 2.55.0 (section 10). The exhaustion lane at `a92ceb6`: 15 of 15 (section 12). **The final confirming gate**, at the final `main` after M66's fix and this report, is recorded in erratum E154, not here: this report cannot record a gate that runs on it. Every other fact below is taken from a record named beside it. A fact no record holds is said to be not run or unknown, never filled. The two real runs passed on one run directory at engine `5bf01a4`, 2026-10-16: **M443, idea to Alpha, 7 of 7; M444, the retrofit, 8 of 8** (sections 14, 15). Their records are copied to `docs/acceptance/reports/M5-real-lane/2026-10-16/`, searched first for the subscription token by its file, the value never read into this report or shown: no hit (section 17). **Every human act of both runs was made by the driver, not by Sean**, under Sean's standing instruction ("answer all the questions and approve gates"), each recorded with those words in `observed/driver-acts.jsonl` (section 17). **Written by:** the Verifier of M5's report, 2026-10-16 and 17 (UTC), on branch `verify/m5-report` from `main` at `a92ceb6`, rebased onto `main` at `93cdfb3` (the skeleton of slice 38 had 89 placeholders); the gate's and exhaustion lane's results at `a92ceb6`, the reruns alone and the corrected act log are the driver's, relayed on 2026-10-17 and checked against the logs on `mini-hp01` where a log holds them. **Sources, read only:** the run directory `/home/smahoney/s5-final` (its store read with `better-sqlite3` `{readonly: true}`, no engine started on it); the earlier run directories `~/surety-m5-real-20261015`, `~/surety-m5-real-20261015b`, `~/s5-loop1` to `~/s5-loop8`, `~/s5-vis1`, `~/s5-vis2`, `~/s5-ink1`, `~/s5-ink2` (their stores, the same way); the driver's findings file (`driver-scratch/m443-real-findings.md`, outside the repository); the gate logs on `mini-hp01` (`~/gate-logs/m5final-5bf01a4-*`, over SSH); the errata E136 to E153; `COVERAGE.md`; `git log` of `main`. **For:** Sean, before his acceptance decision, his hands-on run (M446) and his revocation of the token; and Astra. **Form:** the M4 report's (`M4-report.md`), with BS5 §13's contents; what M5 does not claim is `M5-not-claimed.md`, in `M4-not-claimed.md`'s form. It decides nothing.

The sources it cites: the **build specification** (`docs/spec/M5-build-spec.md`, cited BS5); the **acceptance plan** (`docs/acceptance/sdlc-M5-acceptance-plan.md`, rows M401 to M453); **D6** (`docs/design/sdlc-design-D6-idea-to-alpha.md`, draft 3); the **errata** (E-numbers, `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`); the **coverage record** (`packages/engine/test/acceptance/COVERAGE.md`); the **seam** (`packages/engine/test/acceptance/harness/SEAM.md`, "SEAM §n"); the **objections** 057 to 120 (`docs/acceptance/objections/`). The real lane's records are at `docs/acceptance/reports/M5-real-lane/2026-10-16/` (BS5 §12): `state.json`, `observed/` (each journey's record, each project's pace read and the driver's act log), the two runner logs (added with `git add -f`, since `.gitignore` keeps `*.log` out) and the five sessions' transcript records under `transcripts/`.

## 1. What M5 claims and does not claim

M5 is idea to Alpha (E136): D6 §1's and §8's two journeys on this WSL2 host, on a scripted backend in every lane but one and once for real on each journey (BS5 §1). If accepted, it supports BS5 §1's one claim, verbatim: **on this host, with the recorded versions and limits, on a scripted backend and once for real on each journey, the engine took a project from an idea the owner typed, and another from a repository the owner adopted, to `alpha_deployed`: it metered every conversational turn as a run of its own, settled before the next, and carried the conversation only in records it held; parsed every product with a closed schema and let no role approve its own; checked each phase plan mechanically against its approved bundle, routed it by the artifacts' diff and never by a role's declaration, published it only by the authorized finalizer after approval, and registered no stage work any other way; authored the phase's checks before any stage built and released no Builder before the protected version was applied; dispatched as many runs at once as the plan's dependencies allowed and the host's envelope admitted by the rule as built, each domain counted at the maximum it was admitted with, and never more; ran a phase unattended within F §9.1's floor and stopped exactly where the foundations route a decision; computed a specification change's impact exactly from records, invalidated what it named and let no old-generation check clear it; evaluated the `phase` gate over the phase's whole requirement set with its checks executed on the candidate and replanned from durable records, never from a session's transcript; requested Alpha under policy only through D4's request path and gate; recorded the pace of all of it from the observations it recorded when they happened, with `unknown` where one was missing; and made nothing of an adopted repository acceptance evidence except through the Verifier's protected proposal with its dependency boundary and the owner's or Reviewer's approval, and let no failed conformance check be moved out of the way.** It does not support the claims that a specification is truthful or a plan sensible (D6 §11 class C), that a real-size stage takes any particular time or any number of tokens, that the provider's cache saves anything, that a role runs within `role_memory_max`, that several machines can run one project, or anything D5 owns (BS5 §1; section 22 and `M5-not-claimed.md`).

**The conditions of acceptance (BS5 §1) as they stood when this report was written:**

| Condition | Where it stands | Section |
|---|---|---|
| `npm test` exits zero on `main` for the kernel, sandbox and project lanes, every row M401 to M453 with executable tests and none skipped, M1 to M4 kept passing, C.2 migrated | **not yet established.** The gate at the final engine `a92ceb6` on `mini-hp01` (split, three workers): unit 802 of 802 in 107 files; acceptance 393 files, 2,113 passed, **5 failed**, none skipped: M445 (b) by design; M29, M430, M450 each passing alone three times; **M66 failing at its fixture step on `mini-hp01`'s git**, its fix in progress. The final confirming gate is E154's. | 10 |
| The exhaustion-lane file of M438 passed on `mini-hp01` | **passed at `a92ceb6`: 15 of 15 in 5 files**, units 0 | 12 |
| M443 and M444 passed under Sean's command, each after its rehearsal, records and pace reads retained | **M443 7 of 7, M444 8 of 8**, at `5bf01a4`, after rehearsal 29 on the same revision (M443 7 of 7, M444 8 of 8, the driver's account). "Under Sean's command": the runs were started and every human act made by the driver under Sean's standing instruction (section 17); whether that meets the condition is Sean's to say. Records and pace reads retained. | 13 to 17 |
| The report written; the hands-on run if Sean chooses it | this report; no record of Sean's hands-on run (M446's file passed at `5bf01a4`, 7 of 7) | 25 |

## 2. Revisions

| What | Revision | Record |
|---|---|---|
| The engine and tests of both real runs | `5bf01a4` (`main`, the merge of `fix/m5-alpha-rerequest-wait` at `b8d270a`), built in the driver's scratch checkout (`…/scratchpad/run-m4`, the path printed in every runner command) | each runner log's first line: `=== M443 start 2026-10-16T22:05:40Z at 5bf01a4 ===`, `=== M444 start 2026-10-16T22:55:23Z at 5bf01a4 ===` |
| The rehearsal before them (rehearsal 29) | `5bf01a4` | the driver's account; its logs are in the driver's scratchpad, not retained here |
| The last complete gate | `5bf01a4` | `mini-hp01:~/gate-logs/m5final-5bf01a4-*` (start 21:52:27 UTC, unit done 21:56:10, acceptance done 22:56:21) |
| The final engine on `main` | `a92ceb6` (E153: a specification change after the final phase schedules one replan; `src/spec/change.ts`, `src/plan/bundle.ts`, `src/scheduler/tick.ts`, `src/store/worker.ts`; acceptance file `M433-a-change-after-the-final-phase-schedules-a-replan`, unit file `e153-delivery-replan`; no migration, no contract change) | `git diff --stat 5bf01a4 a92ceb6` |
| The gate and exhaustion lane at the final engine | `a92ceb6` (gate start 23:27:50 UTC, unit done 23:31:40, acceptance done 2026-10-17 00:32:47) | `mini-hp01:~/gate-logs/m5final-a92ceb6-*`; sections 10, 12 |
| M401 (h)'s test fix | `93cdfb3` (`verify/m5-m401h-flake` at `a4a0d56`: a third ordering the engine legitimately produces; (k) the clock-step ruling; SEAM §472, 10 of 10 alone, 6 of 6 under load); tests only, no engine change | `git log` |
| The final confirming gate | the final `main`, after M66's fixture fix and this report | erratum E154, not this report |
| Migrations | `0001` to `0030` (`0030_classified_tree.sql`, E152 item 2), the same at both revisions | `packages/engine/migrations/` |
| The contract | `packages/engine/test/acceptance/contract/config.json` and `api/schema.json` as at `a92ceb6`, unchanged since `5bf01a4` | `git diff` |
| D6 | draft 3, `1e7267b` | E142 item 1 |
| This report | `verify/m5-report` from `a92ceb6`, rebased onto `93cdfb3` | this branch |

The engine's own version string, as `host_observations.engine_version` records it, is `0.0.0` (the package's version), not a revision: the revision of a run is the runner's header, not the store. The real runs did not run on `a92ceb6`; nothing of E153 is claimed from them.

## 3. The host

| | Workstation (the real runs, the sandbox lanes' development) | `mini-hp01` (the gates and the exhaustion lane, E143 item 4, E148) |
|---|---|---|
| OS | Ubuntu 24.04.3 LTS on WSL2 | Omarchy (Arch) |
| Kernel | `6.6.87.2-microsoft-standard-WSL2` | `7.1.9-arch1-2` |
| systemd | `255.4-1ubuntu8.18` (unattended upgrade from `8.17` at 2026-10-16 11:08 UTC, during loop 4, section 16) | `261.2-1-arch` |
| Node | `v22.22.0` | `v26.7.0` (mise) |
| git | `2.43.0` | `2.55.0` |
| util-linux | `2.39.3` | `2.42.2` (fd-based mount; E134's legacy-mount fix applies) |
| CPUs, memory | 20, 15 GiB; `MemAvailable` 13.25 to 13.86 GB at the runs' 41 host observations | 12, 15 GiB |
| Claude Code | `2.1.300`, the pinned binary `~/.local/share/claude/versions/2.1.300`, copied into the home as `backends/claude-2.1.300-674deba0bba9aee4`, sha256 `674deba0bba9aee479f4503c438b49303b6fdd304b9a471b14977aaec5215453` | not used |
| Host id | `1a2241c9653441439658410880ea14af` | not recorded here |

Read on 2026-10-16 by `uname`, `systemctl --version`, `node --version`, `git --version`, `/etc/os-release` on each host, and from the store's `host_qualifications.tool_versions` for the run.

## 4. The backend and the two trust entries (the real lane only)

Two qualification attempts, both by the subscription token (`auth_mode` `subscription_token`), on host qualification `hq_01M53BZS…`/`hq_01M53C4H…`, profile `{memory_max 4 GiB, writable_bytes 4 GiB, writable_inodes 200000, tasks_max 1024}`:

| Attempt | Model, mode | Canaries | Entry | Activated by |
|---|---|---|---|---|
| `qa_01M53BZVZ0FTZ8AW7CXEYS5YBC`, 22:05:46 UTC, `succeeded` | `claude-opus-5-5`, `session_headless` | positive, cancellation (term to exit 13 ms), containment, **continuation**: all passed; unexpected contacts none | `trust_01M53C4F0A46S09TVPV2VAC2SG`, `one_shot_headless`, `session_qualified` 1 | `dec_01M53C4J2D2CT33Z6RJNZ3ZAGK` (the driver, 22:08:44) |
| `qa_01M53C4KR7BNP37XDVV8YXQG7X`, 22:08:21 UTC, `succeeded` | `claude-sonnet-5-5`, `one_shot_headless` | positive, cancellation (12 ms), containment: all passed; unexpected contacts none | `trust_01M53C7AMQS9TK2ZGQWBSGDDD6`, `one_shot_headless`, `session_qualified` 0 | `dec_01M53C835MRJVF7PH6976K2AA9` (the driver, 22:10:50; the first activation question, `dec_01M53C7AMR…`, answered at 22:10:10, was refused 409: it had been re-raised at the engine's start, the harness defect the findings file records from 10-15) |

Both entries: Claude Code `2.1.300`, usage per model call with `delta` semantics, cost `reported`, egress `api.anthropic.com` only, isolation `linux-namespaces-1`, boundary `cgroup2-delegated-scope-1`. Every session ran on the Opus entry; every one-shot as the policy's model asked (Opus for the Spec Writer and Architect, Sonnet for the rest, BS5 §11.1).

**The continuation canary's record** (D6-S09; M420 (d); M443 (a)), `rec_01M53C4EZ068DPXYMH8BYJJXKC` (`qualification_evidence`, post-scan clean): run `run_01M53C38X61KRAY9637NQM8GAH` of kind `session`, two turns, each `replied` with usage `recorded`; turn 1 told to write the engine's token into the artifact, turn 2 to answer every match of the token's pattern in its package; `token_in_reply` true; quiescence held (turn 1's domain `terminated` at 22:07:53.483, turn 2 launched at 22:07:54.205); provider files **not carried** (each turn's volatile home placed empty in a domain of its own; both inventories recorded and complete; nothing the same in both). The engine's token here is the canary's own marker, not a secret.

## 5. The host qualification and the runner self-test

Every engine start of the run directory qualified the host afresh: **20 host qualifications**, 22:05:43 to 23:51:38 UTC, all with mechanism fingerprint `2e4abc150d987a90f3ee1409…`, each lapsed `engine_restart` at the next start except the last (`hq_01M53J1Q3BFC6DMNKSK2YRBS01`, 23:51:38, recorded `active`: the engine of the runner's last step). In every one, checks **H1 to H12 passed**, **H13 `not_exercised`** (not required: "no execution observer loader is configured (`kernel.unprivileged_bpf_disabled` = 2); the observer is optional"), probes P1 to P6 passed, no bootstrap exception. H12 read, for example, "memory available 12.9 GiB (needs 10.0 GiB); disk free 525.7 GiB (needs 9.0 GiB)". **The check runner's self-test** ran at 18 of the 20 starts, all ten cases passing each time (exit zero, exit non-zero, prints passed and exits non-zero, foreign signal, deadline, term handled after cancel, missing program, input immutable, orphan stdout closed, egress), profile fingerprint `3f7152b9…`; at two starts (`hq_01M53ETPEJ2T…`, the teardown's own engine at 22:55:22, and the last) no self-test is recorded (`check_runner` null). **The adapter qualification** (`surety qualify-adapter local_service`, run by the driver, section 17): `aq_01M53EMTZH1R9P2PT4AGE949JW` (M443, 22:52:10, 9 of 9 cases with their controls: `deploy_read_back`, `replace`, `receipt_lost`, `not_issued`, `late_launcher`, `out_of_band`, `unreadable`, `refused`, `teardown`; later `lapsed`) and `aq_01M53GGB1GSW2XH9JFHRP6EST1` (M444, 23:24:40, 9 of 9, `current`).

## 6. D6 draft 3's approval and Astra's review

D6 draft 3 approved to build in E142 (`1e7267b`: Astra's B01 to B14 and N01 to N04 applied, all accepted as written); her cross-review (`docs/reviews/D6/sdlc-review-D6-Astra.md`: approve with section 2's amendments applied) applied as B01 to B14 and N01 to N04 (E141 item 1; `docs/design/sdlc-design-D6-astra-dispositions.md`). **The approval record as it stands at acceptance:** E142 items 1 to 5, unchanged; BS5 and the plan adopted, draft 2 (53 rows, 67 statements); Astra's question 1 (a repair-before-conformance route) decided as recommended, not built in M5 (E142 item 3). D6 was amended after its approval by Sean's decisions of E152 item 3 (D3 §2.11: a criterion-less finding resolved by its named check passing after `fix`; `correct_check` on the owner's own question), E152 item 4 (D1 §7.5 and D1-19: a rebase conflict sends the Builder back once) and E153 item 1 (a specification change after the final phase schedules a replan; D6 §4.5), each from the real runs (section 16).

## 7. The configuration in force, E140's numerics and the twelve readings

**BS5 §11.1's table as the contract held it** at `5bf01a4` and `a92ceb6` (`contract/config.json`), each as BS5 states it:

| Key | Default, range |
|---|---|
| `role_memory_max` | 4 GiB, 512 MiB to `domain_memory_max` (E140 N1) |
| `check_memory_max` | 2 GiB, 512 MiB to `domain_memory_max` (E140 N1) |
| `domain_memory_max` | 8 GiB, 512 MiB to 64 GiB (E140 N1) |
| `max_concurrent_domains` | 4, 1 to 8 (E140 N2) |
| `adoption_full_max_files` | 2,000, 100 to 100,000 (E140 N4) |
| `autonomy` | `phase` of `step`, `stage`, `phase` |
| `max_chained_roles` | 24, 1 to 64 |
| `max_concurrent_runs` | absent at both scopes, refused as a setting (K2) |
| `alpha_deploy` | `manual` of `manual`, `on_phase_complete` |
| `phase_size` | {min 3, max 5}, each 1 to 12 |
| `session_idle_timeout` | 1,200 s, 60 to 7,200 s |
| `turn_max_bytes`, `transcript_max_bytes` | 64 KiB (4 KiB to 1 MiB); 8 MiB (1 to 64 MiB) |
| `deadline_vision`, `deadline_spec_writer`, `deadline_architect` | 1,800 s each, 300 to 10,800 s |
| `model_*` | `opus` for Vision, Spec Writer, Architect; `sonnet` for Builder, Verifier, Reviewer |
| `tick_interval`, `tick_budget` | 30 s (5 to 600), 20 s (5 to 300) |

**E140's numerics** (N1 the 4 GiB and 2 GiB maxima, N2 four domains, N3 the retrofit's cost estimate, N4 2,000 files) stand as decided; none is a measurement (section 19 has the peaks).

**What the real runs ran under** (each project's policy, set by the runner's setup through the owner's route and printed): M443 `budget_day_verified_usd` 30, M444 20; `deadline_builder` 900 s, `deadline_verifier` and `deadline_reviewer` 600 s; models `claude-opus-5-5` for Vision, Spec Writer and Architect, `claude-sonnet-5-5` for Builder, Verifier and Reviewer; backend `claude` for every role; `phase_size` {min 1, max 5}; then, as a widening confirmed through `policy_widening` (E143 item 1), `budget_run_billable_tokens` 2,000,000 and `budget_day_unknown_tokens` 4,000,000 on both, and `alpha_deploy` `on_phase_complete` on M443 (E151 item 3). Every host observation recorded `autonomy` `phase`, `tick_interval` 30, `domain_memory_max` 8 GiB, `role_memory_max` 4 GiB, `check_memory_max` 2 GiB, `max_concurrent_domains` 4.

**The twelve readings of D6 §12.2** stand as draft 3 states them, **reading 10 reversed** (a conformance `fix` records and blocks; a roadmap move resolves nothing; B12), each pinned by the rows BS5 §11.2 names; none was overruled. E152 items 3 and 4 and E153 item 1 amend D3, D1 and D6 §4.5 (section 6); they do not overrule a reading.

## 8. Every Appendix C statement, its row and its result

Every one of D6 Appendix C's 67 statements, its principal row (plan §4.1) and its result. **The results are the gate's at the final engine `a92ceb6`** on `mini-hp01` (`m5final-a92ceb6-acc.log`, per file `pass=` and the `FAILED` list), with the reruns alone the driver made there, and the real lane's for M443 and M444; where the gate at `5bf01a4` differed, its result follows. A row's result is the sum over its files. No statement's row failed at `a92ceb6` except in the split gate, and each such case passed alone three times; M66, the one failure not passing alone, is an M1 row and maps no D6 statement.

| Statement | Row | Result |
|---|---|---|
| D6-S01 session-is-a-run | M415 | passed at `a92ceb6`: 1 file, 4 tests |
| D6-S02 turn-is-an-invocation | M415 | passed at `a92ceb6`: 1 file, 4 tests |
| D6-S03 transcript-durable | M416 | passed at `a92ceb6`: 2 files, 7 tests |
| D6-S04 save-validates | M417 | passed at `a92ceb6`: 1 file, 5 tests |
| D6-S05 close-raises | M403 | passed at `a92ceb6`: 5 files, 16 tests |
| D6-S06 idle-timeout | M418 | passed at `a92ceb6`: 1 file, 11 tests |
| D6-S07 resume-from-records | M418 | passed at `a92ceb6`: 1 file, 11 tests |
| D6-S08 session-exclusive | M419 | passed at `a92ceb6`: 1 file, 5 tests |
| D6-S09 continuation-canary | M420 | passed at `a92ceb6`: 2 files, 12 tests; its real part, the continuation canary on Claude Code 2.1.300, passed in M443 (a) (§4) |
| D6-S10 turn-settlement | M447 | passed at `a92ceb6`: 2 files, 10 tests |
| D6-V01 idea-record | M402 | passed at `a92ceb6`: 1 file, 9 tests |
| D6-W01 spec-parse-at-save | M421 | passed at `a92ceb6`: 1 file, 17 tests |
| D6-W02 spec-approval-floor | M422 | passed at `a92ceb6`: 2 files, 16 tests |
| D6-W03 spec-writer-prohibitions | M423 | passed at `a92ceb6`: 1 file, 12 tests |
| D6-A01 architect-products | M404 | passed at `a92ceb6`: 1 file, 9 tests |
| D6-A02 approval-batched | M403 | passed at `a92ceb6`: 5 files, 16 tests |
| D6-A03 architect-prohibitions | M423 | passed at `a92ceb6`: 1 file, 12 tests |
| D6-A04 replan-one-shot | M424 | passed at `a92ceb6`: 3 files, 8 tests |
| D6-A05 replan-refused-repairs | M424 | passed at `a92ceb6`: 3 files, 8 tests |
| D6-A06 prospective-bundle | M448 | passed at `a92ceb6`: 1 file, 8 tests |
| D6-P01 plan-references | M425 | passed at `a92ceb6`: 1 file, 4 tests |
| D6-P02 plan-approvals | M425 | passed at `a92ceb6`: 1 file, 4 tests |
| D6-P03 plan-dependencies | M426 | passed at `a92ceb6`: 2 files, 9 tests |
| D6-P04 plan-validation | M426 | passed at `a92ceb6`: 2 files, 9 tests |
| D6-P05 plan-routing | M427 | passed at `a92ceb6`: 2 files, 3 tests |
| D6-P06 plan-registered-atomically | M405 | passed at `a92ceb6`: 1 file, 6 tests |
| D6-P07 plan-open-question | M449 | passed at `a92ceb6`: 1 file, 5 tests |
| D6-C01 change-request-work | M431 | passed at `a92ceb6`: 2 files, 7 tests |
| D6-C02 proposed-diff-side-ref | M431 | passed at `a92ceb6`: 2 files, 7 tests |
| D6-C03 impact-exact | M432 | passed at `a92ceb6`: 3 files, 9 tests |
| D6-C04 change-approval | M433 | passed at `a92ceb6`: 4 files, 17 tests, E153's `M433-a-change-after-the-final-phase-schedules-a-replan` (8 of 8) among them |
| D6-C05 change-invalidates | M433 | passed at `a92ceb6`: 4 files, 17 tests, E153's `M433-a-change-after-the-final-phase-schedules-a-replan` (8 of 8) among them |
| D6-C06 unassigned-requirement | M434 | passed at `a92ceb6`: 1 file, 1 tests |
| D6-W04 check-authoring | M435 | passed at `a92ceb6`: 2 files, 8 tests |
| D6-W05 spec-semantic-representation | M449 | passed at `a92ceb6`: 1 file, 5 tests |
| D6-W06 deferred-authoring-and-exception | M450 | at `a92ceb6`: 1 file, 2 passed: `M450-deferred-authoring-and-the-exception` (a) failed in the split gate; rerun alone on `mini-hp01` at `a92ceb6` three times, 3 of 3 each (the driver) |
| D6-X01 autonomy-step | M436 | passed at `a92ceb6`: 3 files, 14 tests |
| D6-X02 autonomy-stage | M436 | passed at `a92ceb6`: 3 files, 14 tests |
| D6-X03 autonomy-phase | M436 | passed at `a92ceb6`: 3 files, 14 tests |
| D6-X04 stage-order | M437 | passed at `a92ceb6`: 3 files, 10 tests |
| D6-X05 pipelining | M437 | passed at `a92ceb6`: 3 files, 10 tests |
| D6-X06 concurrency-envelope | M438 | passed at `a92ceb6`: 2 files, 8 tests; its exhaust file (M438 (h)) passed at `a92ceb6` (§12) |
| D6-X07 event-driven-tick | M440 | passed at `a92ceb6`: 2 files, 16 tests; at `5bf01a4`: 14 passed, 2 failed (§10) |
| D6-X08 memory-peak-recorded | M439 | passed at `a92ceb6`: 1 file, 3 tests |
| D6-X09 profile-qualification-identity | M451 | passed at `a92ceb6`: 2 files, 5 tests |
| D6-F01 phase-gate | M428 | passed at `a92ceb6`: 1 file, 5 tests |
| D6-F02 phase-verification-work | M429 | passed at `a92ceb6`: 3 files, 6 tests |
| D6-F03 phase-complete-effects | M406 | passed at `a92ceb6`: 2 files, 7 tests |
| D6-F04 early-replan | M430 | at `a92ceb6`: 4 files, 12 passed: `M430-replacements-pending-while-stages-move` S2 failed in the split gate; rerun alone on `mini-hp01` at `a92ceb6` three times, 4 of 4 each (the driver) |
| D6-D01 alpha-policy | M407 | passed at `a92ceb6`: 4 files, 11 tests |
| D6-D02 alpha-whole-set | M407 | passed at `a92ceb6`: 4 files, 11 tests |
| D6-M01 pace-read | M441 | passed at `a92ceb6`: 3 files, 18 tests |
| D6-M02 pace-human-wait | M441 | passed at `a92ceb6`: 3 files, 18 tests |
| D6-R01 adopt-records | M409 | passed at `a92ceb6`: 2 files, 9 tests |
| D6-R02 index-origin | M410 | passed at `a92ceb6`: 1 file, 4 tests |
| D6-R03 requirement-confirm | M411 | passed at `a92ceb6`: 2 files, 6 tests |
| D6-R04 retrofit-session-paths | M412 | passed at `a92ceb6`: 1 file, 3 tests |
| D6-R05 conformance-stage | M413 | passed at `a92ceb6`: 3 files, 12 tests |
| D6-R06 conformance-fix-blocks | M413 | passed at `a92ceb6`: 3 files, 12 tests |
| D6-R07 existing-tests-not-evidence | M414 | passed at `a92ceb6`: 2 files, 7 tests |
| D6-R08 scoped-descriptive | M414 | passed at `a92ceb6`: 2 files, 7 tests |
| D6-R09 retrofit-mode-rules | M452 | passed at `a92ceb6`: 1 file, 4 tests |
| D6-R10 conformance-alpha-barrier | M453 | passed at `a92ceb6`: 1 file, 5 tests |
| D6-J01 journey | M401 | passed at `a92ceb6`: 9 files, 22 tests; at `5bf01a4`: 21 passed, 1 failed (§10); its T1 variant (case (m)) is `M401-the-t1-variant-on-the-scripted-backend` |
| D6-J02 journey-real | M443 | real lane at `5bf01a4`, 2026-10-16: **7 of 7 passed** (§14); a real-lane file, never in a gate |
| D6-J03 retrofit-journey | M408 | passed at `a92ceb6`: 2 files, 9 tests |
| D6-J04 retrofit-journey-real | M444 | real lane at `5bf01a4`, 2026-10-16: **8 of 8 passed** (§15); a real-lane file, never in a gate |

Rows beyond Appendix C at `a92ceb6`: M442 (the packages and the rehearsal) 3 files, 55 passed; M445 (this report) 1 passed, (b) failed by design while the report was a skeleton; M446 (the hands-on script) 1 file, 7 passed.

## 9. The C.2 migrations

Each accepted row that a correction K1 to K11 changed, as plan §4.3 lists them, is recorded in `COVERAGE.md` under the slice whose correction caused it, with the former insufficient case pinned as now refused; none is recorded as a weakening, and production gained no compatibility escape. Where each is:

| Correction | Slice | What changed in accepted rows | COVERAGE |
|---|---|---|---|
| K3, N02 (`autonomy`; `max_chained_roles` 24 as a depth cap) | 31 | `autonomy: step` pinned before the plan exists in the shared fixtures (`deployable`, `hostDeployable`, `referenceDeployable`, `classifierProject`, `nominated`, `pinStep`) and in M01, M09, M12, M13, M27, M37 to M43, M50 to M52, M55, M69, M70, M71, M101 (d), M105, M106, M125, M201, M204 to M209, M212 to M214, M219, M220, M222, M223, M229, M230, M234, M318, M325; M49's widenings above the new default | "M5 slice 31a", the C.2 straddle first and second passes; SEAM §§348, 363, 366 |
| K4, B02 to B04, B08 (`registerPlan`; the publishing finalizer; the labelled fixture) | 31 | `installFixturePlan` a labelled caller of the production path, K4's fields with defaults; M74 case 4 (no default takes the fixture's path) | "M5 slice 31a"; objections 060, 061 |
| K6, B01 (session routes; settlement) | 31, 33 | M08's and M03's `unsupported` refusals of session open, turn, save, close narrowed (31), replaced by M415 to M419 and M447 (33); their other refusals kept | "M5 slice 31a", "M5 slice 33" |
| K10, B10 (six-column index; provenance) | 32 | M233's five-column cases kept, the six-column form added | "M5 slice 32" |
| K11, B11, B12 (conformance; the `fix` rule) | 32 | M234 and M235 not weakened: a conformance `fix` resolves nothing; M235 (g) for E152 item 3 | "M5 slice 32"; E152 |
| K5, B06 (the `phase` gate) | 35 | M3's `unsupported` case for `phase` replaced by M428; `SCOPE_KINDS` gains `phase` in M229 to M232; `phase_size` in the contract and journeys' policies; `replan` on X2's blocker; M44's `phase` route | "M5 slice 35", its straddles |
| K8, B04, B05 (semantic representation; spec-evidence generation) | 34, 36 | ruling 2's effect intent `spec_approval_application` (M403 (g)); ruling M4's `M401-a-replan-that-edits-an-adr-routes-to-the-owner` prepared against architecture 2, the former form now refused (`PLAN_STALE_BASELINE`) | "M5 slice 34"; SEAM §§399, 405 |
| K7, B05, B07 (`check_authoring`; readiness) | 37 | per-kind tables and repeated triggers with `check_authoring` | "M5 slice 37" |
| K2, B09 (no run count; per-profile maxima) | 37 | `contract/config.json` (`max_concurrent_runs` removed at both scopes, `max_concurrent_domains` 4, `role_memory_max`, `check_memory_max`); M07 rewritten (several projects and items at once, the key refused at start and as a setting); M12, M15, M70, M71, M419, M133, M220, M310, M408 narrowed; M239 and M342 (sandbox) given a default script that exits | "M5 slice 37"; SEAM §437; COVERAGE line on the slice-38 Builder's two straddles |
| K1, N02 (the requested tick) | 37 | M12, M15, M18, M71 scheduling; objections 090 to 096, 100 to 115 (cases written for one run per project and no requested tick) | "M5 slice 37"; E150 item 4 |
| K9, B14 (`alpha_deploy`) | 31 | M303, M305, M306, M336 reached by the policy's request | "M5 slice 31b" |

Later corrections from Sean's decisions, recorded the same way: E152 item 4 changes M28 (one Builder repair on the moved head, `e1c0f69`); E153 adds M433's new file (`8ee2776`).

## 10. The kernel, sandbox and project lanes

**The last complete gate, at `5bf01a4`**, on `mini-hp01`, split, three workers (E149 item 6, E150 item 6), 2026-10-16 21:52 to 22:56 UTC: user manager running; **units before 0**; build exit 0; **unit 798 of 798 in 106 files**, exit 0; **acceptance: 392 files, 2,105 tests passed, 5 failed, 0 skipped, 0 todo, 0 empty files**, exit 1; **units left none; homes after 0**. By plan: M1 rows 128 files, 849 passed, 1 failed; M2 41 files, 222 passed; M3 50 files, 208 passed; M4 70 files, 356 passed; M5 103 files in 51 rows, 470 passed, 4 failed. The five failed tests:

1. `M15-run-end-fault-matrix`: "a preflight refusal after a lease was issued; the transaction that records the refusal (invocation.status) fails once": the final durable facts differ from those of the same ending with no fault.
2. `M440-a-storm-of-completions` (e1): under the storm 26 of 48 items completed by requested ticks alone.
3. `M440-a-storm-of-completions` (e5): a run of the storm left unended.
4. `M401-the-journey-from-phase-two-to-alpha` (h): phase 2's authoring applied after CR-1's approval; its question was invalidated where the case expects it standing.
5. `M445-the-m5-report` (b): the report was a skeleton (by design).

**None of 1 to 4 was rerun alone at `5bf01a4`** (the driver). M401 (h) was then found to be a test's timing assumption and fixed test-side at `93cdfb3` (`verify/m5-m401h-flake`, SEAM §472: 10 of 10 alone, 6 of 6 under load). M15 run-end and M440 (e1), (e5) did not fail in the gate at `a92ceb6`. Nothing more is claimed of them at `5bf01a4`.

**The gate at the final engine `a92ceb6`**, on `mini-hp01`, split, three workers, 2026-10-16 23:27:50 to 2026-10-17 00:32:47 UTC: user manager running; **units before 0**; build exit 0; **unit 802 of 802 in 107 files** (E153's unit file added), exit 0; **acceptance: 393 files, 2,113 tests passed, 5 failed, 0 skipped, 0 todo, 0 empty files**, exit 1; **units left none; homes after 0**. By plan: M1 rows 128 files, 848 passed, 2 failed; M2 41 files, 222 passed; M3 50 files, 208 passed; M4 70 files, 356 passed; M5 104 files in 51 rows, 479 passed, 3 failed. The five failed tests, and each rerun alone on `mini-hp01` at `a92ceb6`, three times (the driver's reruns):

| Failed in the split gate | Alone, three runs |
|---|---|
| `M29-ref-update-probe`: "ref_update, journal applied, effect found conflicting (the ref put at a third commit) … once what blocked it is gone, the next tick takes the operation on" | 15 of 15 each run |
| `M430-replacements-pending-while-stages-move` S2: "stage 1 integrated and verifying, kept by the replacement; its check fails after the swap" | 4 of 4 each run |
| `M450-deferred-authoring-and-the-exception` (a) to (c) | 3 of 3 each run |
| `M66-backup-and-restore`: "a backup taken after a commit its manifest would list has left the repository is refused, and nothing it leaves is labeled complete" :: "the fixture: the commit is gone from the repository" | **4 of 5 every run**: the same case fails at the same fixture step |
| `M445-the-m5-report` (b): the report was not yet final | by design |

**M66: the fixture fails on `mini-hp01`'s git; fix in progress.** M66 passes 5 of 5 on the workstation at `93cdfb3` (git 2.43.0) and fails the same way on `mini-hp01` at `5bf01a4` as at `a92ceb6` (git 2.55.0, installed there 2026-09-04): the failure is the case's own setup on that host's git, before any engine assertion, not an engine change between the revisions. A Verifier is fixing the fixture (`verify/m66-prune-fixture`). Its result: [[PENDING M66 fixture fix on mini-hp01]]

**The final confirming gate**, on the final `main` after M66's fix and this report, is recorded in erratum E154, not in this report, which cannot record a gate that runs on itself.

## 11. The project-lane journeys and their pace reads

The files carrying the project-lane journeys at `a92ceb6`: M401's nine files, 22 tests, all passed (at `5bf01a4` the journey from phase two to Alpha failed (h), section 10), M408's two (the retrofit journey 8 of 8; a confirmed requirement that fails blocks conformance, 1 of 1), M436's three (14 passed) and M441's three (`the-pace-read-after-the-journey`, `the-pace-read-from-recorded-observations`, `the-peak-across-a-restart-on-the-real-boundary`; 18 passed). **Their pace reads' figures are not retained**: the gate keeps per-file pass counts only, and the files do not write their reads anywhere a later reader finds them. What M441 pins (that the read exists, derives every figure from a recorded observation and says `unknown` where one is missing, D6-M01 and D6-M02) passed; what the scripted journeys' reads said is unknown.

## 12. The exhaustion lane

Earlier result: at `2fe51ee` (slice 37's build), `--lane exhaust` on `mini-hp01` with `SURETY_EXHAUSTION_HOST` set, **15 of 15 in 5 files** (`M133-resource-limits`, `M130-exit-classes-limits`, `M205-an-oom-kill-on-the-exhaustion-host`, `M341-a-service-at-its-limits`, `M438-a-role-domain-past-its-maximum`), 0 units left (E150 item 5). Not rerun at `5bf01a4` in any record I found.

**At the final engine `a92ceb6`**, `--lane exhaust` on `mini-hp01` with `SURETY_EXHAUSTION_HOST` set (`m5final-a92ceb6-exhaust-summary.log`): **exhaust exit 0; tests 15, pass 15, fail 0; acceptance: 5 file(s) passed; units 0**. M438 (h), the role domain past its maximum, is among the five.

## 13. The rehearsals

Never evidence (SEAM §171; BS5 §12). **Rehearsal 29**, on `5bf01a4`, the revision of both paid runs, with the package-driven fakes (`SURETY_REAL_REHEARSAL=1`): **M443 7 of 7, M444 8 of 8** (the driver's account; logs in its scratchpad, not retained). Earlier: the dress rehearsal on `main` at `ee3aa37`, M443 7 of 7, M444 8 of 8, no unit left; rehearsals 1 to 8 found harness defects only, each fixed (E151 item 6); slice 38's package-driven rehearsal found six package gaps a fake had hidden before any paid step (E151 item 2). Rehearsals between the real runs of section 16 (18, 25 and others) were run by the driver before each resumed or fresh run; their count and outcomes beyond those named in the findings file are not recorded here.

## 14. The real journey from an idea to Alpha (M443)

**Passed 7 of 7**, 2026-10-16 22:05:40 to 22:55:23 UTC (2,991 s), at `5bf01a4`, run directory `~/s5-final` (`run-kind.json`: `rehearsal: false`), engine home `/home/smahoney/s5-final/home` (28 bytes, under E134's 56). The idea: Sean's brief `~/surety-m5-physics-idea.md` (Mechanica, a physics lab), so the project is `m5-real-mechanica` (`proj_01M53C9CP71558J8MFCQ1NAFER`), T2, `autonomy: phase`, `alpha_deploy: on_phase_complete`; Vision skipped and recorded (`SURETY_REAL_VISION=skip`, D6 §1 step 2: the project was created with the brief).

| Case | Result | What the records show |
|---|---|---|
| (a) the attempts; `session_qualified` from the continuation canary; both entries active | passed (314 s) | section 4 |
| (b) the sessions; each turn metered with its ledger row; each product parsed and approved | passed (1,565 s) | Spec Writer session `run_01M53D1HH4…` (2 turns, 261 s, completed), spec v1 `spec_01M53D9J0P…` (11 requirements, R6 and R7 human tests); Architect session `run_01M53D9VZ9…` (1 turn, 195 s), architecture, roadmap and phase-1 plan `plan_01M53DFVF6…` (routing `human`, 2 stages, published 22:31:58), approved as one bundle; each turn one ledger row, usage recorded |
| (c) phase 1 by real roles: authoring approved, every result an engine execution, both stages verified, phase complete, replan registered | passed (605 s) | check authoring 299 s (proposal `unclassifiable`, 11 checks); stage 1 verified 256 s after eligible, stage 2 193 s; one `blocker` on stage 1 (the Builder's objection that a smoke check imported a stage-2 module), answered `correct_check` and corrected; phase 1 complete 2,001 s after the project's creation; the replan one-shot (59 s) registered phase 2's plan `plan_01M53E88VB…` |
| (d) the change: impact shown, approved, invalidation and correction done | passed (279 s) | `surety spec change-request` with `change-request.md` (R11.5: numeric strings refused), `scr_01M53EC8CP…` approved; spec v2 `spec_01M53EDNDX…`; `spec_evidence_generation` 2; the correction (`r11-service` adds numeric-string cases) approved; the first `spec_change` question invalidated and asked again (`dec_01M53ED8AZ…` then `dec_01M53EDD4P…`) |
| (e) phase 2 by real roles, every check an engine execution | passed (223 s) | phase 2's authoring 96 s (`tightening`), stages verified 281 s and 204 s; phase 2 complete 2,641 s after creation |
| (f) `qualify-adapter`; the request under policy; `alpha_authorize` satisfied; verified; `alpha_deployed` on a real unit | passed (0.25 s, judged from records) | two policy requests `dreq_01M53EMVHD…` and `dreq_01M53ESZSP…` (`requested_by: policy`); `alpha_authorize` `gate_01M53ESZSN…` satisfied; `alpha_complete` `gate_01M53ET8S6…` satisfied on `post-deploy-alpha`; candidate `cand_01M53EFJAJ…` `alpha_deployed` 2,650 s after creation, on unit `surety-20541a92d32d-env_01M53D9J0R83BD7WWG9ZED09KK-g1.service` (`token_hits` 0) |
| (g) teardown applied, nothing left; `pace.json`; no result by a fixture; the token in no file, git object or journal output | passed (3.8 s) | teardown `att_01M53ETDSZ…` applied; left: units, cgroups, run files none; 10 journals searched, 0 hits; `observed/M443.json` `records.token`: roots `~/s5-final`, repo `repos/mechanica`, **hits 0**; all 153 check results of the run directory by the engine's runner (`direct@1a2241c9…/3f7152b98031`) |

**Runs:** 2 sessions (3 turns) and 19 one-shots: 4 Builders, 10 Verifier runs (2 check authorings, 4 verifications, 2 corrections, 2 phase verifications), 3 Reviewers, 1 Architect replan, 1 Spec Writer change run; every run `completed`, no repair. **22 invocations, 5.51 USD estimated** (section 18). The requirements: R1 to R11 recorded `approved`; R6 and R7 human tests, shown `owed` by the pace read (never verified, D6 §11 class C).

## 15. The real retrofit journey (M444)

**Passed 8 of 8**, 2026-10-16 22:55:23 to about 23:52:44 UTC (3,441 s), same directory and home, at `5bf01a4`. **The run's scale is small**: the adopted repository has 3 tracked files, 1,251 bytes and 6 commits.

**The repository** (D6-J04; E141 item 3): the M4 real run's Builder repository copied from `~/surety-m4-real-20261012/repos/real-deployment-journey-3`, its recorded head `5fcd423b0bd333273344c23725b23b8e836d3255` checked, the Surety records removed by one recorded commit (prepared head `f427c7fc…`), adopted as `m5-real-sums` (`proj_01M53EWEQ1XRM3T8K6DD6ESXS7`), T1, `alpha_deploy: manual`, source revision A `f427c7fc19d2056dcfcc02d22bc934909182189a` pinned at adoption (22:56:20), signals 3 files, 2 languages, no test, CI or deploy files; recommended mode `full` (threshold 2,000); mode answered `full`.

| Case | Result | What the records show |
|---|---|---|
| (a) adoption: A pinned before the bootstrap, the signals, the mode | passed (134 s) | above |
| (b) the retrofit Spec Writer's claims; each produced requirement answered | passed (1,025 s) | session `run_01M53FNDJY…` (2 turns, 237 s); spec v1 `spec_01M53FXERG…`, 11 requirements, all `reverse_engineered`; 27 `spec_claims` rows (for example: README.md:1, "the repository is a fixture … makes no behavioural claim"; server.mjs:33, "a and b must be numbers": "mostly matches … `Infinity` and `NaN` are rejected, while hex, octal, binary and exponent forms are …"); `spec_approval` blocked on `REQUIREMENT_UNANSWERED` for each of R1 to R11 until answered, then approved (`dec_01M53FX44V…`) |
| (c) one conformance stage for the approved set | passed (229 s) | Architect session `run_01M53FXRP3…` (1 turn, 85 s); plan `plan_01M53G0CSF…`; stage `stage_01M53G0CSG…`, `conformance_state` `source_bound` to A, implementing 9 requirements (R8 and R9 excluded as defects) |
| (d) the real Verifier's authoring; adopted tests with their boundary where any; the toolchain approved | passed (361 s) | authoring 151 s, 12 checks added ("floor checks"), proposal `prop_01M53G47HH…` applied, `unclassifiable`, approved; the repository had no tests, so no test was adopted (the case holds "where any were adopted") |
| (e) conformance: no `stage_build`; c-1's source A; its checks engine-run; the gate as the checks decide | passed (0.4 s) | `builds` 0; candidate `cand_01M53G58KF…` (seq 1); stage `verified`, `conformed`, source A; 61 checks executed on it |
| (f) the deploy of c-1; `alpha_deployed`; pending requirements shown; the replan only after `alpha_complete` | passed (1,188 s) | the deploy request `dreq_01M53H6VVA…` (`requested_by: human`, 23:36:58) found the Alpha scope missing a post-deploy kind; the engine registered authoring for the gap (`authoring_gap`, `post-deploy-user-operation`, approved); `alpha_complete` `gate_01M53HCC0A…` satisfied 23:39:58; `replans_before_complete` empty; the replan `wi_01M53HCRM6…` created 23:40:11, after it |
| (g) one phase-2 stage built by a real Builder and verified | passed (499 s) | see below; Builder `run_01M53HXD5P…` (16 s) |
| (h) teardown applied, nothing left; claims and confirmations kept; token absent; scale stated small | passed (4.0 s) | teardown `att_01M53HCRP7…` applied at 23:40:16 (in `m5r_deploy`'s `finally`); left none; 20 journals searched, 0 hits; `observed/M444.json` `records.token`: **hits 0** |

**The confirmations, as made** (by the driver, section 17): R1 to R7, R10 and R11 `confirm` (each `origin: observed`); **R8 and R9 `defect`** (R8, an overflowing sum; R9, a request target `new URL` cannot parse crashes the process), each scheduled to phase 2 and excluded from the conformance set (B11, B12).

**After Alpha** (the change phase, the part of the journey M444 (f) and (g) read): the first replan run refused its own result (`requirement_conflict`: the Architect could not plan R8.1 and R9.4 as written, "the owner's to route to a specification change"; repaired, `completed`), and the Verifier's findings raised two `finding_disposition` questions, answered `change_spec`; two Spec Writer change runs produced spec v2 (R8 restated: an overflowing sum answers 400 and the server stays up) and v3 (R9 restated: an unparseable target answers 400 and the process stays up); their corrections approved; `spec_evidence_generation` 3. Each change queued its own replan (one per change request, E150 item 3): the first published phase 2 generation 1, then generation 2 (`plan_01M53HXCM5…`, its stage cancelled for the newer one); the Builder built R8 and R9 and the stage was verified (14 checks). **The third replan item `wi_01M53HQ8FM536YRSHC5HQ4ASFP` parked** after both its runs were refused `PLAN_DEPENDENCY_INCOMPLETE` (phase 1's checks read `unknown` on a candidate created when the corrections applied, before they had run); its `blocker` `dec_01M53J0X8P42FV5V1B99CHSEDX` (retry, cancel) was raised at 23:51:11 and **is still open in the store**: the test ended at 23:51:35 and the driver's two `retry` answers (23:51:52, 23:52:09) got no response (the act log: `"http":"000 (engine stopped: the runner had ended)"`). The replan was redundant (its plan already published as generation 2); the gap is recorded as M444F-1 (section 16), and both it and the open blocker are known defects carried to M6 (section 24). 17 one-shots: 6 Architect replans (4 `failed` `invalid_result`, 2 `completed`), 2 Spec Writer change runs, 8 Verifier runs, 1 Builder; **20 invocations, 6.51 USD estimated**, against an expectation of about 3 USD (E140 N3): the difference is the four refused replans (1.81 USD) and the two change runs with their corrections, none expected by BS5 §12's estimate.

## 16. The engine's real-run hardening

The acceptance real lane of sections 14 and 15 is the last of 15 real run directories on 2026-10-15 and 16. The earlier ones are history, not the acceptance record: each found engine gaps (E135's class: a gap the scripted roles hid), each gap was fixed on `main` by a Builder branch merged by the driver, and the next run started on the fixed engine. Figures from each directory's store (`ledger_rows`, read only); the run outcomes and gaps from the driver's findings file and E152.

| Run directory | Engine | What | Invocations, USD est. | Clean? |
|---|---|---|---|---|
| `surety-m5-real-20261015` | before `7c51d5e` | M443 on the reference brief (Tally); abandoned at the spec when Sean chose his own idea | 10, 0.71 | no |
| `surety-m5-real-20261015b` | `7c51d5e`, then each fix from `e9509db` to `6426618` mid-run | the first M443 (Mechanica): **Alpha deployed 2026-10-15 23:27:25 UTC**, 7 of 7; then M444 (sums) 8 of 8 about 03:00 UTC on 10-16 | Mechanica 60, 13.59; sums 18, 5.50; total 86, 19.33 | no: 9 fix cycles with restarts (E152 item 1) |
| `s5-loop1` | `6426618` | fresh M443 | 36, 7.11 | no (retired) |
| `s5-loop2` | `4c0f067` | stopped at qualification | 3, 0.10 | no |
| `s5-loop3` | `f0bf986` | reached phase 2 verification | 47, 7.56 | no (retired) |
| `s5-loop4` | `b39e108` | clean through phase 1, then the host's systemd upgrade | 28, 5.54 | no |
| `s5-loop5` | `e1c0f69` | Alpha 14:46:40 UTC | 57, 9.05 | no |
| `s5-loop6` | after `7502dec` (the findings file) | Alpha by policy | 44, 7.16 | no |
| `s5-loop7` | `295e6a7` | Alpha by policy, 16:13 to 17:10 UTC | 39, 7.59 | **yes, the first** |
| `s5-loop8` | `295e6a7` | Alpha by policy, 17:10 to 18:12 UTC | 41, 7.20 | **yes** |
| `s5-vis1` | `295e6a7` | a visual-design brief; Alpha by policy | 43, 8.61 | **yes** |
| `s5-vis2` | `295e6a7`, then `aa06dcf` mid-run | the visual brief again; Alpha 20:48:37 | 52, 11.19 | no |
| `s5-ink1` | then `339e116` mid-run (its start revision not recorded here) | a different app (Inkwell); Alpha by policy | 42, 6.54 | no |
| `s5-ink2` | `339e116` | Inkwell; Alpha by policy, 20:49 to 21:45 UTC | 42, 6.19 | **yes** |
| `s5-final` | `5bf01a4` | **the acceptance lane**, M443 and M444 | 50, 12.26 | M443 ordinary acts only; M444 ended with M444F-1's blocker open |

"Clean" is Sean's bar (E152 item 1): `alpha_deployed` with no engine fix, no restart and no driver workaround, ordinary decision answers allowed. Two consecutive clean runs of the physics brief (loops 7 and 8), one of the visual brief (vis1) and one of a different app (ink2) met it, all at `295e6a7` or `339e116`.

**Each gap and its fix** (the commit on `main`; "E152" where the errata record it):

| Found in | Gap | Fix |
|---|---|---|
| first M443, #1 | the Verifier's package did not state that an acceptance-origin check of a criteria kind covers at least one criterion (`CHECK_DEFINITION_INVALID` twice) | `e9509db` |
| first M443, #2 | `dir/**` module paths read as unread globs; module presence never recorded; a silent stall | `f40f075` |
| first M443, #3, #4 | a Reviewer's finding with no disposition: no fix, no question; a silent stall | `a7c1470` (`fab473d`) |
| first M443, #7, #8 | the replan's kept-stage rule unstated; a kept stage neither listable nor changeable | `e56385e`, `09edb7b` |
| first M443, #9 | a missing check kind with no authoring registered by a replacement; a silent stall | `7eb8f79` |
| first M443, #5, #12 | a stage implementing only human tests could never pass its gate | `397115a` (E152 item 2) |
| first M443, #14 | an unsatisfied gate evaluation never recomputed after a restart | `1cac7e9` (E152) |
| first M444, #21, #22 | an undispositioned finding no review would reach; `accept` that did not release a blocking finding | `756a14a`, `6426618` (E152) |
| loop 1, L1-1, L1-2, L1-4 | the per-stage validation rule stated wrongly to the Architect; a stale-base proposal classified as deleting concurrent additions; a finding naming a check its own proposal adds | `dc899f3`, migration 0030 (E152) |
| loop 1, L1-5 | a phase deferring criteria it did not owe | `4c0f067` (E152) |
| — | objections 118 to 120 (M207, M433, M424 (c)), test-side | `a44a9c3` |
| loop 2, L2-1 | Claude Code's embedded ripgrep counted as a second backend; the containment canary failed | `f0bf986` (E152) |
| loop 3, L3-obs1 | finding categories undescribed | `0863c17` (E152) |
| loop 3, L3-1 | a conflict finding's disposition did not settle its blocker; duplicate Builders | `bb493ab` (`a942dc8`) (E152) |
| loop 3, L3-2, L3-3 | a rebase conflict parked; a finding on a criterion-less check could never be resolved | Sean's decisions E152 items 3 and 4; built `c06c116`, tests `e1c0f69` |
| loop 4, L4-1 | after the host's systemd upgrade the trust entries were stale but `active`; dispatch refused with an uninformative question | `f7a3e5c` (`b7b374f`) |
| loop 5, L5-obs1 | the Verifier declared directory inputs, so every addition was unclassifiable | `4ccbb9b` |
| loop 5, L5-2 | `alpha_authorize` refused on a missing review sign-off; no review queued; a silent stall | `7502dec` (`636d341`) |
| loop 6, L6-1 | a `fix` finding never resolved at gates outside its first scope | `295e6a7` |
| vis2, V2-1 | the Alpha gate's missing post-deploy kind never authored; a silent stall | `aa06dcf` (`fc81438`) |
| ink1, INK-1 | a fix Builder editing `.surety/` ADRs on every attempt (`diff_violation` ×4) | `339e116` (`180dbe9`) |
| vis2, V2-2 | the policy's re-request made before the gap's checks ran | `5bf01a4` (`b8d270a`) |
| first M443 and E153 | a specification change after the final phase scheduled no replan | Sean's decision E153 item 1; `a92ceb6` (`cc7282b`), after the acceptance runs |

**Open after the acceptance lane** (the findings file; none fixed on `main` at `a92ceb6`): M444F-1 (the plan check refuses a replan on dependency results still `unknown` and spends its repairs in seconds; section 15); #18 (check authoring for criteria a requested change names should wait for that change); #19 and L1-2's root (authoring and correction of one check running concurrently, paid twice); #20 (replans of one phase not coalesced); L1-3 (a defect whose check comes later is offered only `accept`); #6 and #15 (a kind missing with nothing pending, and Alpha waiting on a lapsed adapter qualification, wait silently); INK-2 (a superseded phase verification not retired); INK2-2 (a redundant disposition question); the design questions of sections 24 and 26.

## 17. The human acts as they were made, and the token

**Who acted.** Every act BS5 §12 names Sean's was made by **the driver**, under Sean's standing instruction, recorded line by line in `observed/driver-acts.jsonl` (64 lines, all JSON), each with `acted_by: driver` and `on_instruction`: **"answer all the questions and approve gates"** (41 lines) or **"answer all the questions and approve gates; go ahead and start M444"** (23 lines, the commands and session turns). The driver corrected the file at its source on 2026-10-17 and the copy here is the corrected one: the two `retry` lines that read `"http":000` (not JSON) now read `"http":"000 (engine stopped: the runner had ended)"`, and one line was appended for M444's `surety deploy`, marked `"reconstructed"` (below). The store records every answered decision's actor as `human` (38 answers, all `human`): the route, not who. `state.json` labels the two `qualify-adapter` steps `by: "Sean's command"`, the runner's fixed text; the act log shows the driver typed both. BS5 §12 asks that such acts be recorded in `state.json` (`acted_by: driver, on_instruction`); they were recorded in `observed/driver-acts.jsonl` instead, which is copied with it. **The runs were also started by the driver** (Sean delegated paid runs, E144 item 2; the memory file "paid runs delegated").

**The sessions' content was the driver's.** The driver wrote every owner turn: M443's Spec Writer turn 1 ("Please write the specification from the accepted idea (Mechanica). Keep every requirement, range and tolerance the idea states, R6 and R7 as human tests …") and turn 2 (answers to the Spec Writer's questions, physics included); the Architect's one turn; M444's two Spec Writer turns (turn 2 answered its questions, among them the tier: "T1, as the project was adopted"); the Architect's one turn. The transcripts are in `transcripts/`.

**The acts, M443:** `qualification_approval` ×2 (22:06:04, 22:08:45); `trust_activation` ×2 (22:08:44; 22:10:10 refused 409 on a re-raised question, then 22:10:50); `policy_widening` (22:11:30); the Spec Writer session (open 22:24:09, two turns, save, close 22:28:31) and `spec_approval` (22:28:32, "standard owner answers"); the Architect session (22:28:42 to 22:31:58) and `architecture_approval` with `plan_approval` (22:31:58); phase 1's checks approved (22:37:15, "11 added incl. post-deploy-alpha"); the stage-1 `blocker` answered `correct_check` (22:40:07, "the Builder is right: smoke-physics at stage 1 imports validate.js, which the plan assigns" to stage 2) and its correction approved (22:40:57); phase 2's checks approved (22:47:16, tightening); `surety spec change-request` (22:47:29, R11.5 numeric strings refused); `spec_change` approved (22:48:15); its correction approved (22:49:05); `surety qualify-adapter local_service` (22:52:10). **The Alpha request was the engine's**, under policy.

**The acts, M444:** `surety project adopt` (22:56:20); `adoption_mode` `full` (22:56:56); `policy_widening` (22:57:33); the Spec Writer session (23:09:58 to 23:13:56); eleven `requirement_confirm` (23:14:09 to 23:14:10: nine `confirm`, R8 and R9 `defect`); `spec_approval` (23:14:21); the Architect session (23:14:31 to 23:15:57); `architecture_approval` and `plan_approval` (23:15:57); the conformance checks approved (23:18:36, "12 added incl. floor checks"); `surety qualify-adapter local_service` (23:24:40); **`surety deploy` of c-1, by the driver** (23:36:58): its line was lost when the driver piped its act script into `head`, which ended it before it wrote; the line now in the log is marked `"reconstructed"`, built after the fact from the store's row `dreq_01M53H6VVAQBQTMMAK685KDBTK` (`requested_by: human`, `deployed`, 23:36:58Z); the driver also made the request again several times while the gap's check was authored, all under the one request key; the alpha gap's check approved (23:37:50); two `finding_disposition` answered `change_spec` (23:41:53: R8, R9 "to be restated as intended"); `spec_change` v2 approved (23:43:48); its correction approved (23:44:54); `spec_change` v3 approved (23:45:55); its correction approved (23:46:45); the parked replan's `blocker` answered `retry` twice (23:51:52, 23:52:09), **neither reached the engine** (section 15).

**The token.** The token was in `~/.config/surety/m5-subscription.token` (0600, 109 bytes), outside the repository, `~/.claude` and the run directory. The runs' own searches: M443 (g) and M444 (h), "the token in no file, git object or journal output": `records.token` hits **0** over the root `~/s5-final` and each repository; the units' journals 10 (M443) and 20 (M444) searched, **0 hits**; the units' properties while running `token_hits` 0. **My search of the copied records** (`docs/acceptance/reports/M5-real-lane/2026-10-16/`, 13 files: `state.json`, the five files of `observed/`, the two runner logs, the five transcripts), by the token file's bytes and their base64 form, the value never printed: **0 hits**; the same for the disposable deploy secret (`~/s5-final/secrets/ref_secret`): **0 hits**. Whether the token's value passed through any conversation is not in the records I read. Sean revokes the token (BS5 §12).

## 18. The pace reads of the real runs

From `observed/pace-M443.json` and `observed/pace-M444.json` (the engine's `GET /v1/projects/:p/pace` at the end of each run) and the store's `ledger_rows`. Never a throughput claim (N01); one run per journey.

| | M443 (`m5-real-mechanica`) | M444 (`m5-real-sums`) |
|---|---|---|
| created to `spec_approved` | 1,054 s | 1,081 s |
| created to `architecture_approved` | 1,260 s | 1,178 s |
| created to phase complete | phase 1 2,001 s; phase 2 2,641 s | phase 1 1,655 s; phase 2 3,313 s |
| created to `alpha_deployed` | 2,650 s | 2,619 s |
| sessions | 2, 3 turns, 456 s, unmeasured 0 s; tokens billable 89,176, cached 537,113, output 45,771 | 2, 3 turns, 322 s, unmeasured 0 s; 77,580, 369,817, 30,514 |
| runs | 21 (2 sessions, 19 one-shots) | 19 (2 sessions, 17 one-shots) |
| invocation elapsed time, summed | 1,250 s (Verifier check authoring 394 s, Builders 247 s, Architect session 191 s, Spec Writer session 108 s) | 1,141 s (Architect replans 396 s, Verifier authoring 223 s, Spec Writer session 157 s, change runs 153 s) |
| wait, end protocol (summed) | 17 s, 157 s | 15 s, 83 s |
| phase plan published to completed | phase 1 741 s, phase 2 580 s | phase 1 477 s; phase 2 gen 1 `unknown` ("the phase completed was not recorded"), gen 2 136 s |
| authoring | phase 1 299 s `unclassifiable`, phase 2 96 s `tightening` | phase 1 151 s `unclassifiable`; phase 2 75 s, class `unknown` ("no classified authoring proposal for the plan") |
| phase verification | 12.8 s, 14.3 s | `unknown` ("no phase verification ran for the plan": T1) |
| replan | after phase 1: 59 s, `registered` | after phase 1: 127 s, `registered` |
| stages | 4 verified; checks 40, 34, 38, 29 (28 s, 24 s, 33 s, 26 s); human wait 49 s (stage 1, the `blocker`), else 0 | conformance stage verified, 61 checks (38 s), its integration `unknown` ("its integration was not recorded": no Builder); phase 2 stage verified 119 s after eligible, 14 checks; one stage `cancelled` |
| idle by reason | `resource_envelope` 5.2 s, `depends_on` 113.9 s, `authoring_readiness` 93.8 s; `chain_boundary`, `open_decision`, `session_busy`: `unknown` ("no closed … hold interval was recorded") | `depends_on` 655.9 s, `authoring_readiness` 352.4 s; the other four `unknown` |
| decisions open (each) | 10 decisions, 0.2 s to 49 s | 24 decisions, 0.2 s to 36 s |
| model observed per run | `unknown` for every run ("no model was observed for the run"); see below | the same |
| peak domains at once | 3 (of 4) | 3 |
| tokens (ledger) | billable 566,239; cached 3,679,460; output 165,695 | 629,149; 3,659,029; 116,568 |
| **cost (estimated, Claude Code's estimates)** | **22 invocations, 5.51 USD** | **20 invocations, 6.51 USD** |

**The run's total:** 50 invocations, **12.26 USD estimated**: the two projects above and the qualification fixture's 8 (0.24 USD, of which 2 rows `unknown`, below); billable 1,223,253, cached 7,545,410, output 286,470 tokens. Every row is dated 2026-10-16 UTC. Expected: M443 about 5 USD, M444 about 3, the attempts under 0.50 (BS5 §12): M443 and the attempts within, M444 at about twice (section 15).

**The model observed.** Every one of the 50 ledger rows records `model_observed` equal to `model_requested`; the `runs` table's `model_observed` is null for all 47 runs, and the pace read, which reads the run's, says `unknown` for every run. **A known defect, carried to M6, not fixed in M5** (the driver): `runs.model_observed` is never set, so the pace read reports `unknown` although the ledger records the model (section 24; `M5-not-claimed.md`).

**Unknown usage.** No session turn's usage was unknown: all 8 turns of the run directory settled with usage `recorded` (the continuation canary's 2, M443's 3, M444's 3). Two ledger rows have `cost_status` `unknown` and `usage_complete` 0: the two cancellation canaries (`run_01M53C1JDW…`, `run_01M53C5QFY…`, both `stopped` `human_stop`), on the qualification fixture project, each reserving its unknown allowance (296,599 and 296,927 tokens). No real project's run reserved its allowance. The caps in force (Sean's choice of 2026-10-14, E151 item 3): 2,000,000 billable tokens a run; 30 USD a day for M443, 20 for M444; 4,000,000 unknown tokens a day. No cap was reached.

## 19. The memory.peak figures

`execution_domains.memory_peak`, read before removal (M439), in MiB, against the maximum each domain was admitted with:

| Project | Profile, role, kind | Domains | Peak recorded | Highest peak | Median | Admitted maximum |
|---|---|---|---|---|---|---|
| fixture | role, Verifier one-shot (canaries) | 6 | 6 | 146.5 | 138.8 | 4,096 |
| fixture | role, Vision session (the continuation canary) | 2 | 2 | 143.6 | 143.6 | 4,096 |
| M443 | role, Spec Writer session | 2 | 2 | 190.8 | 190.8 | 4,096 |
| M443 | role, Architect session | 1 | 1 | 149.8 | | 4,096 |
| M443 | role, Verifier one-shot | 10 | 10 | 226.1 | 146.0 | 4,096 |
| M443 | role, Builder one-shot | 4 | 4 | **230.7** | 155.1 | 4,096 |
| M443 | role, Reviewer one-shot | 3 | 3 | 142.2 | 140.7 | 4,096 |
| M443 | role, Architect and Spec Writer one-shots | 2 | 2 | 150.1 | | 4,096 |
| M443 | check | 78 | 78 | 104.8 | 52.2 | 2,048 |
| M444 | role, Spec Writer session | 2 | 2 | 161.7 | | 4,096 |
| M444 | role, Architect session | 1 | 1 | 155.0 | | 4,096 |
| M444 | role, Verifier one-shot | 8 | 8 | 188.5 | 159.0 | 4,096 |
| M444 | role, Architect one-shot (replans) | 6 | 6 | 148.0 | 145.4 | 4,096 |
| M444 | role, Spec Writer one-shot, Builder | 3 | 3 | 145.8 | | 4,096 |
| M444 | check | 75 | 75 | 55.9 | 40.9 | 2,048 |
| all | service (the two Alpha units; 18 of the adapter qualifications) | 20 | **0** | `unknown` | | `unknown` (not recorded) |

**203 of 223 domains** have a peak; every role and check domain does; no service domain has a peak or an admitted maximum on its row. Against E140 N1: the highest role peak, 230.7 MiB, is 5.6 % of `role_memory_max` (4 GiB); the highest check peak, 104.8 MiB, 5.1 % of `check_memory_max` (2 GiB). These are one small project's figures on one host, for revisiting the defaults (BS5 §10), not a capacity measurement or a claim that a role runs within its maximum (D6-X08 measures; `M5-not-claimed.md`).

## 20. Cases reported `not_exercised`

By name: **M438's exhaust file** (`M438-a-role-domain-past-its-maximum`) off `mini-hp01` (plan §2.5), run only by `--lane exhaust` there (section 12); **H13** of every host qualification (the execution observer, optional, section 5). No real row was left unrun. No case of the gates at `5bf01a4` or `a92ceb6` reported `not_exercised` as a pass (each summary: 0 skipped, 0 todo, 0 empty files).

## 21. The packages and the rehearsal (M442)

M442 at `a92ceb6` (as at `5bf01a4`): 3 files, **55 tests passed** ((a) each role's package states what the engine reads; (b) the rehearsal's fakes under a package with one stated element removed fail; (c) the rehearsal plays from the package). The packages' elements are SEAM §454's registry, each rendered in its role's `prompt.md` as a `surety-reads` block (E151 item 1). **The package gaps the rehearsal found** before any paid step (E151 item 2): the authoring package forbade the toolchain it had to name; the phase Verifier's schema had no `signoffs`; the spec change's one-shot had no `changes`; the Builder's dependency interfaces were empty; the post-deploy target's value form was lost; the Architect was not told what `prepared_against` holds. **The package gaps the real runs found** that no rehearsal could (section 16): the covers rule (`e9509db`), the module path form (`f40f075`), the kept-stage rule (`e56385e`), the per-stage validation rule (`dc899f3`), the finding categories (`0863c17`), file-level inputs (`4ccbb9b`), nothing under `.surety/` a Builder's (`339e116`); still open, the Spec Writer reading `phase_size` as a cap on requirements per phase (V2 note) and not asking for experience or design criteria (#17).

## 22. What M5 does not claim

See `M5-not-claimed.md` (D6 §11 classes A, B and C; BS5 §13's list; what the real runs do not show; M4's list carried). In short: several machines (with D6 §11's list of what they would need); adoption of a public repository; Codex and API-key sessions; provider-native continuation; the automated architecture approval; evidence reuse across a spec change; more than one open session per project; parallel role runs at the 8 GiB default on this workstation; that a specification or a retrofit description is truthful, that a plan passes first time, that a real stage takes §7.2's times, that a role runs within `role_memory_max`, or that pipelining shortens a phase; D6 §11 class C; the benchmark; Beta, Live, rollback, reattachment; and **that Sean made the real runs' human acts** (section 17).

## 23. Limits of the instruments

BS5 §8's limits: the scripted backend's products are the test's, so a pass on the kernel, sandbox and project lanes proves the engine's handling of a product, never that a model produces one; a scripted session proves the mechanism, not a conversation; the pace read on scripted roles measures the engine; one real run per journey is not a claim about a real agent's behaviour. **What the runs add:**

- **The real runs' owner was the driver**, an agent acting under Sean's standing instruction, not Sean; what the sessions produced depended on its answers (section 17). That a human owner would have answered alike is not claimed.
- **The real lane ran at `5bf01a4`, the final engine is `a92ceb6`**: E153's code was not exercised by a real run.
- **The acceptance lane is one run per journey**; the clean-run bar of section 16 was met on four runs at `295e6a7` and `339e116`, not at `5bf01a4`. M444 itself ended with a parked replan's question open (M444F-1).
- **The split gate runs three workers**: four of the five failures at `5bf01a4` were not rerun alone there; at `a92ceb6` three of the four non-report failures passed alone three times each (E150 item 6's protocol), and M66 fails on `mini-hp01`'s git at a fixture step (section 10).
- **The pace read reports the run's model `unknown`** though the ledger observed it (section 18; a known defect carried to M6, section 24).
- **The store's `engine_version` reads `0.0.0`** (the package version): a run's revision comes from the runner's header, not the store (section 2).
- **Service domains have no recorded peak or maximum** (section 19).
- **Wall-clock timestamps** are no more exact than this WSL2 clock, which was stepping after `wsl --shutdown` (findings file, 10-15; BS5 §4.1 rule 17); durations the engine measures are monotonic.
- **The project-lane pace reads' figures were not retained** (section 11).

## 24. Open decisions and provisional readings

From E142 to E153, what stays provisional or open:

- **Astra's question 1** (a repair-before-conformance route): decided not in M5 (E142 item 3); M444's adopted repository failed no confirmed requirement, so the real run gave no evidence for or against it. The defects found (R8, R9) left by `defect` at confirmation and came back by `change_spec` after Alpha.
- **E140's numerics** are trial values; section 19's peaks are the first real measurements.
- **The driver's rulings** under Sean's delegation (E143 to E153, each "the rest the driver's"), among them the qualification step's place before phase 2 and the teardown in its deployment's `finally` (E151 item 4), the runner's drain-before-stop, the human-test scope rule (#12), the restart staleness rule (#14), the owed-finding rules (#21, #22), the embedded-ripgrep rule (L2-1): each provisional until Sean confirms it.
- **The design questions the loops raised for Sean** (findings file), not decided: whether work held after a run ends `recovered` at restart should raise an owner question (objection 120's note); whether the engine may propose a requalification attempt itself (L4); the Alpha sign-off's fix path when the Reviewer asks for fixes (L5-2's note); an owner attestation route for human tests (#5, after M5).
- **Known defects carried to M6, not fixed in M5** (the driver, 2026-10-17): (1) `runs.model_observed` is never set, so the pace read reports `unknown` although the ledger records the model (section 18); (2) the plan check counts a dependency check result that has not yet run as incomplete and spends a replan's repairs on it (M444F-1, section 15); (3) the parked third replan's blocker in M444's store was left open because the runner had already ended (section 15); (4) the shared seed's engine switch should wait for live runs (the mechanism behind M401 (h)'s failure at `5bf01a4`, fixed test-side at `93cdfb3`, section 10).
- **M66's fixture on `mini-hp01`'s git 2.55.0**: fix in progress (`verify/m66-prune-fixture`, section 10).
- **M4's open items** carried (BS5 §14): E134 item 6, E132 item 10, E133 item 5, E125 to E134's readings, E94 item 5, E106, E50, E51, E53 to E55.

## 25. Hands-on run (M446)

`M5-hands-on.sh`'s file (`M446`) passed at `a92ceb6`, 7 of 7 (its form and guards). **No record of Sean's run of it** was found; what surprised him is his to add if he makes it. Sean did try the earlier real runs' Mechanica apps (findings file #17, 10-15: "it met the requirements but the design is so basic i am surprised it took so long and so many stages to build").

## 26. Questions for Sean

1. **"Under Sean's command."** Every human act of the acceptance runs was the driver's under your standing instruction (section 17), as in M4 (`M4-not-claimed.md` section 6). Does that meet BS5 §1's condition?
2. **The four known defects carried to M6** (section 24), the driver's call: do you confirm they are not M5's?
3. **M444's cost** (6.51 USD against about 3): four refused Architect replans and two change runs. A figure for the benchmark's planning, or a cap to revisit?
4. **The open gaps of section 16** (#18, #19, #20, L1-3, #6, #15, INK-2, INK2-2) and the design questions of section 24: which are M5's and which after it.
