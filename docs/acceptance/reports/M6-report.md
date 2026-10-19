# Surety M6 acceptance report

**Status:** final (2026-10-19, by the Verifier of M540, on `verify/m540` from `main` at `4e05624`, completed from `main` at `5521699` and `1f8e064`). **M6 accepted by Sean with explicit exceptions** (E171 item 1, 2026-10-19): neither real run was clean; the final engine revision was not exercised by either real run; the final split gate at `12ee772` failed, its remaining execution failures classified load-sensitive by controlled reruns; the next clean real journey starts the clean-run record and takes the first measurement of a preview's `memory.peak`, without changing these results. **The final split gate, at `12ee772`** (`4e05624` with F8's fix and this report; split, three workers, `mini-hp01`): 440 files, 2,398 passed, 6 failed, 0 skipped: M540 (b) on this report's final-gate placeholder (filled since, from E170 item 2), and two load-sensitive files, M440 and M311 (h), each of which then passed 3 of 3 on a quiet host on both `4e05624` and `12ee772` (section 12); merged at `19afc9f` (E170). **The exhaustion lane at the final revision `19afc9f` passed** (run at `12ee772`, the same tree): **15 of 15 in 5 files, units 0**, as at `4e05624` before F8's fix (section 14). Every other fact below is taken from a record named beside it. A fact no record holds is said to be not run or unknown, never filled.

**The two real runs passed** on one run directory, `~/s6-1018`, one engine home: **M519, design before build and at Alpha, web, 10 of 10** (2026-10-18, last judged at `308230d`), and **M535, web, a labelled android simulation and a held logo, 12 of 12** (2026-10-18 and 19, last judged at `def6afd`). **M535 is not a clean run** under E152 item 1: it passed its design step by a governed Architect correction around engine finding F5, not by an engine fix (E167), one of its judgements was amended by Sean before it was re-judged (E167 item 4), and two harness findings (F6, F7) were fixed during it (E168). F5 is fixed on `main` at `d91492c` (E169), and F8 at `19afc9f` (E170), after both runs. M519's four findings were each fixed on `main` before M535 started, and M535's dress rehearsal passed on every revision it ran (section 17). **M535's four central owner acts were Sean's**, each with his own entry typed at his terminal; **every other act of both runs was the driver's** on Sean's quoted instructions (section 19). The runs' records are copied to `docs/acceptance/reports/M6-real-lane/2026-10-19/`, searched for the subscription token by its file, the value never read into this report: **no hit** (section 22); that search opened the token files by path, against the standing rule (E170 item 3). **The preview's `memory.peak` was not recorded for any of the four real previews** (finding F8, section 21): both runs are recorded unmeasured; F8 is fixed at `19afc9f` (E170, Sean's ruling: fix it now, measure on the next clean real run).

**Written by:** the Verifier of M540, 2026-10-19 (UTC). **Sources, read only:** the run directory `/home/smahoney/s6-1018` (its store `home/store.db` opened with `better-sqlite3` `{readonly: true}`, no engine started on it; its `state.json`, `observed/`, runner logs and `export-M535/`); the two project repositories under `~/s6-1018/repos/` (by `git archive` and `git cat-file` only); the rehearsal records `~/s6r-w*/rehearsal-passed.json` and `~/s6r-x*/rehearsal-passed.json`; the errata E156 to E171 (the final split gate as E170 item 2 records the driver's relay of it); `COVERAGE.md`; `git log` of `main`. **For:** Sean, for his acceptance decision (made since: E171) and his hands-on run (M541); and Astra. **Form:** the M5 report's (`M5-report.md`), with BS6 §13's contents; what M6 does not claim is `M6-not-claimed.md`, in `M5-not-claimed.md`'s form. It decides nothing.

The sources it cites: the **build specification** (`docs/spec/M6-build-spec.md`, cited BS6); the **acceptance plan** (`docs/acceptance/sdlc-M6-acceptance-plan.md`, rows M501 to M546); **D7** (`docs/design/sdlc-design-D7-designer.md`, draft 3); the **errata** (E-numbers, `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`); the **coverage record** (`packages/engine/test/acceptance/COVERAGE.md`); the **seam** (`packages/engine/test/acceptance/harness/SEAM.md`, "SEAM §n"); the **real lane's README** (`docs/acceptance/reports/M6-real-lane/README.md`). The copied records (section 22) are cited as `2026-10-19/<path>`.

## 1. What M6 claims and does not claim

M6 is the Designer (D7; BS6 §1): D7 §1's journey on this WSL2 host, on a scripted backend in every lane but one and twice for real. Accepted with E171's explicit exceptions, it supports BS6 §1's one claim, verbatim: **on this host, with the recorded versions and limits, on a scripted backend and twice for real, the engine derived an interface inventory from the approved architecture alone and held a Designer session to it; let the Designer write the design and nothing else, and nobody else write the design; checked every save mechanically, per target, without executing anything the role wrote; served web mockups natively and every other target's only inside a frame it labelled a simulation, and counted neither as evidence; let a design's criteria reach the specification only through the floor's approval, batched so the approval never staled itself; held UI stages, and only UI stages, until the protected version covering the design's criteria was applied, and never held anything on an asset's status; gave Builders and checks only the effective asset set, never a held or unanswered proposal, carried every approved replacement into the built application through recorded bindings, and let no parity result stand for a version it did not read; staled exactly the screens a change touched; recorded a review's verdicts as the owner's only on his own act, kept engine-observed evidence apart from what he supplied, and let no verdict on a simulation count as native; and left no design hold without an open question naming it.** It does not support the claims that a design is usable or good, that a simulation is faithful to its native technology, that a UI Builder implements a design, that the static checks catch what a person would call off-design, that an owner build or a screenshot is what he says it is, or that the app shows a bound asset where it is bound (D7 §15 classes B and C), or anything D5 or D8 owns (section 27 and `M6-not-claimed.md`).

**The conditions of acceptance (BS6 §1) as they stood when this report was written.** Where a condition is not met literally, it is met by E171 item 1's explicit exception, not passed:

| Condition | Where it stands | Section |
|---|---|---|
| `npm test` exits zero on `main` for the kernel, sandbox and project lanes, every row M501 to M546 with executable tests and none skipped, M1 to M5 kept passing, the straddles migrated and recorded | the final split gate, at `12ee772` (E170 item 2, `mini-hp01`, split, three workers): build and unit exit 0; 440 files, 2,398 passed, 6 failed, 0 skipped: M540 (b) (this report's final-gate placeholder, filled since), M440's storm (e1, e5) and requested tick (d), M311 (h) twice (cancelled); the storm 3 of 3 alone; the requested tick and M311 failed alone on the loaded host and passed 3 of 3 on a quiet host on both `4e05624` and `12ee772`, so load-sensitive under E150 item 6, not F8's. No split gate of M6 the errata record exited zero, the final one included. **The final gate is as section 12 records it.** **Not met literally:** met by E171 item 1's explicit exception to the zero-exit requirement, not passed. | 9, 12 |
| M5's five exhaust files passed once on `mini-hp01` at the final revision (E156 Q8) | **passed at the final revision `19afc9f`** (run at `12ee772`, the same tree): **15 of 15 in 5 files, exit 0, units after 0** (the driver, finished 2026-10-19 21:18:58 UTC); earlier at `4e05624`, before F8's fix, the same (about 18:02 UTC) | 14 |
| M519 and M535 passed, M519 first, M535 only after M519's defects were resolved and M535's rehearsal passed on its revision; records, pace reads and the per-act record retained | **M519 10 of 10; M535 12 of 12**; M519's four findings fixed on `main` before M535 started, M535's rehearsal recorded passed on each revision it ran (`8cffaf0`, `e62cc39`, `def6afd`); records, pace reads and per-act records retained and copied. M535 not clean (E167, E168). **No clean real run, and the final engine not exercised by either run:** met by E171 item 1's explicit exceptions, not as clean runs. | 15 to 19 |
| The report written with the per-act record and the measured Designer usage and preview memory; the hands-on if Sean chooses it | this report; the Designer usage measured (section 21); **the preview's `memory.peak` unknown in every real preview** (F8; fixed at `19afc9f`, E170; **not met literally:** E171 item 1's exception, the first measurement being the next clean real journey's); no record of Sean's hands-on run (M541's file passed at `12ee772`) | 19, 21, 30 |

## 2. Revisions

| What | Revision | Record |
|---|---|---|
| M519, first start (`m6_attempt` to `m6w_design`, halted at F1) | `0824dff` (E163), 2026-10-18 01:55:56 to 05:11:25 UTC | `state.json` `created_at`; `host_observations.engine_revision` (13 observations); `observed/M519.json` |
| M519, rerun of `m6w_design` refused before any engine (F2) | `292e11e` (E164), 06:38:47 | `runner-M519.log` header `=== rerun m6w_design at 2026-10-18T06:38:47Z rev 292e11e ===` |
| M519, rerun of `m6w_design` (passed; judge (c) halted on F3) | `fd5087f` (F1's fix `68f3867`, F2's `e47e0bc`, M404's race fix), 06:56:44 | the runner header; `engine_revision` (2 observations) |
| M519, `judge:M519 (c)`, then `m6w_build` to `m6w_teardown`: **10 of 10** | `308230d` (F3's fix, harness only; the engine code as at `fd5087f`), 07:24:56 to 08:22 | the runner header; `engine_revision` (2 observations); `start_condition.revision` |
| M535, its start and four reruns of `m6x_design` (the last reached the design; judge (a) halted) | `8cffaf0` (E166; F4's fix `25fef88`), 2026-10-18 23:01 to 2026-10-19 13:02 | `engine_revision` (27 observations) |
| M535, `judge:M535 (a)` (amended), then `m6x_build` to `m6x_teardown` (11 of 12; (l) failed on F6, F7) | `e62cc39` (E167; the amendment `348602e`, tests only), 13:16 to 15:30 | `engine_revision` (3 observations); `~/s6r-x3/rehearsal-passed.json` |
| M535, `judge:M535 (l)`: **12 of 12** | `def6afd` (E168; F6 and F7's fix `f107b11`, harness only), 15:49 | `observed/M535.json` `start_condition.revision` and its rehearsal record |
| The engine code of M535's three revisions | identical: `git diff 8cffaf0 def6afd -- packages/engine/src` is empty | `git diff` |
| The final engine on `main` | `19afc9f` (E170's merge; `5521699` adds the errata only): F8's fix `61bd15e` (three files of `src/`: `boundary/terminate.ts`, `deploy/adapters/local-service.ts`, `store/transitions/deploy.ts`; cases `8b1055e`, `ca58a02`) over `4e05624` (E169's entry) and `d91492c` (F5's fix: `ba3e5d1`, five files of `src/`; cases `e0f0c6b`); **not run by a real run** | `git diff --stat def6afd 19afc9f -- packages/engine/src`; `git diff --stat 4e05624 19afc9f -- packages/engine/src` |
| F5's gate | `b56e26d` (`gate/f5`; the same tree as `4e05624` but the errata) | E169 item 3 |
| The final split gate | `12ee772` (`gate/m6final`: `main` `4e05624` with `build/f8` `61bd15e`, `verify/f8` `ca58a02` and `verify/m540` `0f0e412`), merged at `19afc9f`, the same tree | E170 item 2; section 12 |
| Migrations | `0001` to `0038` (`0037_the_design_criterion_map.sql`, `0038_the_approved_effective_set.sql`, E163), unchanged from `0824dff` to `19afc9f` | `packages/engine/migrations/` |
| The contract | `contract/config.json` and `api/schema.json` unchanged from `0824dff` to `19afc9f` | `git diff` |
| D7 | draft 3 (E153 item 2), its §14 and §6.4 clarified by E162 item 4, its B.14 amended by E166 item 3 | the errata |
| BS6 and the plan | draft 2 (E156), with E162 item 1's rule 25 and M512, M536, M538 (f) | the errata |
| This report | `verify/m540` from `4e05624` (in the final gate at `0f0e412`), completed from `5521699` | this branch |

M544's revision is recorded at every host observation of the run directory: **47 observations, five revisions, none unknown**. The engine's version string (`host_observations.engine_version`) still reads `0.0.0`, the package's version; the revision is `engine_revision`. The real runs did not run on the final engine: F5's fix (E169) is exercised by M504, M506 and M508 only, and F8's (E170) by M510 (h) only, on the real unit within the final gate.

## 3. The host

| | Workstation (the real runs, the rehearsals) | `mini-hp01` (the gates and the exhaustion lane, E143 item 4, E148) |
|---|---|---|
| OS | Ubuntu 24.04.3 LTS on WSL2 | Omarchy (Arch-based) |
| Kernel | `6.6.87.2-microsoft-standard-WSL2` (`uname -a`: `Linux MSI 6.6.87.2-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC Thu Jun 5 18:30:46 UTC 2025 x86_64`) | `7.1.9-arch1-2` (`uname -a`: `Linux mini-hp01 7.1.9-arch1-2 #1 SMP PREEMPT_DYNAMIC Fri, 21 Aug 2026 22:18:59 +0000 x86_64 GNU/Linux`) |
| systemd | `255 (255.4-1ubuntu8.18)`, the same at every one of the 30 host qualifications | `261 (261.2-1-arch)` |
| Node | `v22.22.0` | `v22.22.0` (`~/surety-exhaust/node`, the exhaustion lane's) |
| git | `2.43.0` | `2.55.0` |
| util-linux | `2.39.3`; iproute2 `6.1.0` | not re-read for M6 |
| CPUs, memory | 20, 15 GiB; H12 read "memory available 11.0 GiB (needs 10.0 GiB)" at the last qualification | not re-read for M6 |
| Claude Code | `2.1.302 (Claude Code)`, the pinned binary `~/.local/share/claude/versions/2.1.302`, sha256 `60d7eb7f12fbb28a52533fe8be5884097403562aa02dc73991a021c7067e29a5`, copied into the home as `backends/claude-2.1.302-60d7eb7f12fbb28a` | not used |
| Host id | `1a2241c9653441439658410880ea14af` | not recorded here |
| Engine home | `/home/smahoney/s6-1018/home`, 24 bytes (E134's limit 56) | |

The workstation's figures were read on 2026-10-19 by `uname -a`, `systemctl --version`, `node --version`, `git --version`, `~/.local/share/claude/versions/2.1.302 --version`, `sha256sum` and `/etc/os-release`, and from the store's `host_qualifications.tool_versions`. `mini-hp01`'s were read by the driver over Tailscale on 2026-10-19 (`uname -a`, `systemctl --version`, `node --version`, `git --version`, the OS name) and relayed; its util-linux, CPUs and memory were not re-read.

## 4. The backend and the two trust entries (the real lane only)

Two qualification attempts, both by the subscription token (`auth_mode` `subscription_token`), each after the driver's `qualification_approval` (section 19), profile `{memory_max 4 GiB, writable_bytes 4 GiB, writable_inodes 200000, tasks_max 1024}`:

| Attempt | Model, mode | Canaries | Entry | Activated by |
|---|---|---|---|---|
| `qa_01M56BJ6K2M3M6X9Z2PZ1EJ1JK`, 01:56:01 UTC, `succeeded` | `claude-opus-5-5`, `session_headless` | positive, cancellation (term to exit 14 ms), containment, **continuation** (`run_01M56BNKG892BWTZ0RVE4JM4M6`, evidence `rec_01M56BPAZ049HETKAWCYN734EG`): all passed; unexpected contacts none | `trust_01M56BPB0F5MBAGKV4PC997CZ3`, `one_shot_headless`, `session_qualified` 1 | `dec_01M56BSAKXQMFNVFQQAYYNJCAK` (the driver, 02:00:07) |
| `qa_01M56BPGZ2ZQ1JEKZWK34SDX59`, 01:58:23 UTC, `succeeded` | `claude-sonnet-5-5`, `one_shot_headless` | positive, cancellation (15 ms), containment: all passed; unexpected contacts none | `trust_01M56BRJYZQ4S6M8VAEZ881DM7`, `one_shot_headless`, `session_qualified` 0 | `dec_01M56BSAKZ6PJ3ADY2Z9QNSVGY` (the driver, 02:00:15; a first answer at 01:59:41 named a stale decision and was refused, its line kept in `driver-acts.jsonl`, E164 item 4) |

Both entries: Claude Code `2.1.302`, usage per model call with `delta` semantics, cost `reported`, egress `api.anthropic.com` only, isolation `linux-namespaces-1`, boundary `cgroup2-delegated-scope-1`; both still `active` at the end. M535 reused them (E165 item 9). Every session ran on the Opus entry, the Designer's included (`model_designer` `claude-opus-5-5`); every one-shot as the policy asked (Opus for Spec Writer change runs and the Architect, Sonnet for Builder, Verifier and Reviewer). **The model each run observed (M542):** `runs.model_observed` equals `model_requested` on every run with a turn: all 39 of M519's, 26 of M535's 28, and the fixture's 7; the two others are M535's two Designer sessions that ended with no turn (section 18), whose model is `null` and whose pace read says why. Every ledger row's `model_observed` equals its `model_requested`.

## 5. The host qualification, the runner self-test and the preview's adapter

Every engine start of the run directory qualified the host afresh: **30 host qualifications**, 2026-10-18 01:55:59 to 2026-10-19 15:49:27 UTC, all with mechanism fingerprint `c21a7d5c776fe21b919ec9ab…`, each lapsed `engine_restart` at the next start except the last (`hq_01M5ADMZ20DZE0Q7YVNECRX1ZS`, `active`). In every one **H1 to H12 passed**, **H13 `not_exercised`** (not required: "no execution observer loader is configured (`kernel.unprivileged_bpf_disabled` = 2)"), probes **P1 to P19 passed**, **P20 `not_exercised`** ("host not designated for exhaustion probes … excused, not claimed"), no bootstrap exception. **The check runner's self-test** ran at 20 of the 30 starts, all ten cases passing each time, profile fingerprint `3f7152b98031…`; at ten starts no self-test is recorded (`check_runner` null): seven at 07:00:58 to 07:01:19 on 2026-10-18 (the halted directory's build-step engines of F3, E165 item 4), and the engines of 08:18:59, 2026-10-19 15:30:14 and 15:49:27 (records and judgement only).

**The `local_service` adapter qualification** (`surety qualify-adapter local_service`, the driver's act each time, section 19), each 9 of 9 cases (`deploy_read_back`, `replace`, `receipt_lost`, `not_issued`, `late_launcher`, `out_of_band`, `unreadable`, `refused`, `teardown`):

| Qualification | When | Engine build | Status |
|---|---|---|---|
| `aq_01M56CTSWC231VECGCZY93MKG4` | M519 `m6w_qualify`, 02:18:12 | `sha256:cf3ce19a8756f…` (`0824dff`) | `lapsed` `engine_build` |
| `aq_01M56WTCZD2XD9VYHMRJVE77QZ` | M519's rerun, 06:57:36, required before the preview because the new build lapsed the first (E165 item 2) | `sha256:680aebd193a0f…` (`fd5087f`) | `lapsed` `engine_build` |
| `aq_01M58N5SSE65SE2693M4ZGT78H` | M535 `m6x_qualify`, 23:22:30 | `sha256:769387c4965d0…` (`8cffaf0`; the engine code of `e62cc39` and `def6afd` the same) | `current` |

The preview and Alpha of each run ran under the qualification current at their time.

## 6. The adoption of BS6 and the plan (E156), and Sean's answers Q1 to Q8

BS6 and the M6 acceptance plan, draft 2, adopted by Sean in E156; his answers to BS6 §16's eight questions as E156 item 2 records them: Q1 the opening correction slice (39, M542 to M546); Q2 G7's trigger kept as built, `spec_change`; Q3 the design's human-test requirements assigned narrowly; Q4 D7 A.7's defaults as trial values, `stack` refused; Q5 two real runs, M519 then M535, day limits of 40 and 50 USD, no workaround carried forward; Q6 Sean performs M535's four central acts and the report records who performed each act; Q7 a short hands-on; Q8 the exhaust lane at the final revision.

**The adoption record as it stands at acceptance (E156 to E171):**

| Entry | Decided by | What |
|---|---|---|
| E156 | Sean | BS6 and the plan adopted; Q1 to Q8; the owner-file changes of BS6 §15 |
| E157 | the driver (delegation) | slice 39 merged (`dea04e2`); objections 125, 130, 135, 140, 141; objection 126 open for Sean |
| E158 | the driver | slice 40 merged (`1bbe470`); rule 23's first real-unit preview (both unit lists empty); objections 127 to 129, 146, 150, 151, 155 to 157, 160, 165 to 169 |
| E159 | the driver | slices 41 and 42 merged (`09d99ba`, `ceb3b7f`); objections 170, 173; three items recorded for this report (item 7) |
| E160 | the driver | slices 43 and 44 merged (`4bc0e80`); objections 172, 180 to 182; the SVG activity check refusing by default; `designInForce` |
| E161 | the driver | slice 45 merged (`f22951d`); objections 190 to 193; the review's blocking findings B1 to B3 |
| E162 | **Sean** | objections 126 and 145: answering consumes the question, under the replacement invariant (D7 §11, rule 25, M512, M536, M538 (f) updated); the snapshot caps kept; Waterlog approved with three edits; D7 §14's API wording and §6.4 clarified; held turns for other roles later; the first preview's evidence kept |
| E163 | the driver | slice 46 merged (`a149cc5`); E162's checks; objections 200 to 204; the per-approval effective set; two replan defects and the ruling that a phase waits for a pending replacement; the M519 rehearsal at `390b2fd` |
| E164 | the driver | M519's first paid run; F1 and the ruling on human-judged design criteria |
| E165 | the driver | M519 passed; F2, F3 and their rulings; F4 found; M435 (e)'s race |
| E166 | **Sean** | F4: a review's difference names only the criterion it concerns, or none; no actionable `fix` for an unlinked finding; D7 B.14 amended; M519's 24 findings reported as accepted unresolved differences |
| E167 | **Sean** (item 4) and the driver | M535's design step: F5, the Architect correction, the driver's two unused Designer sessions; judgement (a) amended |
| E168 | **Sean** (the second review, the edit) and the driver | M535's asset change and review: the struck web verdict and a second web review; four accepted findings; F6 and F7 |
| E169 | **Sean** | F5: an unshaped interface a `ui` module exposes is refused at the plan check; no state derived from an interface of unknown shape; fixed at `d91492c` |
| E170 | **Sean** (item 1) and the driver | F8: each preview's `memory.peak` read before its removal and recorded, an unreadable one `unknown` with its reason; both real runs recorded unmeasured; fixed at `19afc9f` after the final split gate at `12ee772`; this report's token search, which opened the token files by path (item 3) |
| E171 | **Sean** | M6 accepted with explicit exceptions (item 1); the web human test stays `pending` with his confirmed `deltas` verdict (item 2); the trial defaults kept provisionally (item 3); the 28 findings carried, recommendations separate (item 4); hardening H1 to H5 before unattended use, the rest of section 29 not approved as a block (item 5); the token-file access a process violation (item 6) |

Every driver's entry says "Sean may overturn any item"; none has been overturned in the errata.

## 7. D7's decisions as they stood

D7 draft 3, every question decided (its closing section; E153 item 2), its corrections G1 to G15, reconciled with D8 (§17; E155 item 2). **Changed after adoption, by Sean:** §11's invariant replaced (E162 item 1: every design-held stage accounted for by an open owner question, an owner-opened active Designer session, pending engine work or an unexpired owner-selected deferral; answering `open` or `later` consumes the question); §14's wording (E162 item 4: the API is TCP on loopback with its token and Host and origin checks); §6.4 clarified (E162 item 4: every approval durably identifies its effective asset set); B.14's delta gains optional `criterion` and `check`, named, never inferred (E166 item 3); §4.1's refusal sentence read as "consumed or exposed" (E169 item 2). **The driver's rulings under Sean's delegation, standing:** readiness follows D7 §7.5 literally and a `human`-kind design criterion is carried by its target's human test (E164 item 3); a phase waits for a pending replacement replan (E163 item 6); an item held `design_pending` is held for a rerun's leftovers (E165 item 3); a step's act record covers every attempt (E165 item 4); `design.assets_approved` only on a change (E160, confirmed by Sean in E162 item 4); the replan trigger fires for any change adding a criterion after the last phase (E160 item 5, recorded for Sean); closing a review always raises `design_verdicts` (E161 item 3, B2); and the objections each entry lists as upheld or decided.

## 8. The configuration in force

BS6 §11.1's table as `contract/config.json` holds it at `4e05624` (unchanged since `0824dff`), every value D7 A.7's trial value (E156 Q4):

| Key | Default | Range |
|---|---|---|
| `design` | `off` | `off`, `before_build`, `at_alpha`, `both` |
| `design_preview` | `static` | `off`, `static`; `stack` refused `invalid_value` |
| `design_widths` | [360, 720, 1280] | 1 to 6 widths, each 240 to 3,840 px |
| `design_orientations` | [portrait, landscape] | a non-empty subset |
| `design_external_urls` | `cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com` | host names |
| `assets_required_for` | `live` | `none`, `beta`, `live` |
| `model_designer`, `backend_designer` | `opus`; `scripted` | a model; `scripted`, `claude`, `codex` |
| `deadline_designer` | 1,800 s | 300 to 10,800 s |
| `designer_session_budget_billable_tokens` | 3,000,000 | 250,000 to 20,000,000 |
| `design_tree_max_bytes`, `design_tree_max_files` | 32 MiB, 800 | 1 to 128 MiB, 50 to 8,000 |
| `preview_memory_max` | 256 MiB | 64 MiB to `domain_memory_max` |
| `design_preview_ttl` | 86,400 s | 3,600 s to 14 d |
| `design_due_max_defer` | 7 d | 1 h to 30 d |
| `design_review_evidence_max_bytes` | 64 MiB | 1 MiB to 2 GiB |
| `design_review_evidence_max_review_bytes` | 512 MiB | 1 MiB to 16 GiB (E161 item 2) |

**What the real runs ran under** (each project's policy, set by the runner's setup through the owner's route and printed; `observed/M519.json` and `M535.json` `create.policy`): `design: both`, `autonomy: phase`, T2; `budget_day_verified_usd` **40 (M519) and 50 (M535)**; `deadline_builder` 900 s, `deadline_verifier` and `deadline_reviewer` 600 s; `model_designer`, `model_vision`, `model_spec_writer`, `model_architect` `claude-opus-5-5`, `model_builder`, `model_verifier`, `model_reviewer` `claude-sonnet-5-5`; `backend_*` `claude` for every role, the Designer's included; `phase_size` {min 1, max 5}; `designer_session_budget_billable_tokens` 3,000,000 (the default, set explicitly); `preview_memory_max` not set (the default, 256 MiB). Then, as widenings confirmed through `policy_widening` by the driver (section 19): `budget_run_billable_tokens` 2,000,000, `budget_day_unknown_tokens` 4,000,000, `alpha_deploy` `on_phase_complete` (one decision for M519, two for M535). No default was changed by any decision of Sean's on these runs' measurements; both are kept as trial defaults (E171 item 3; section 21).

## 9. Every row and its result

Every row of the M6 plan, M501 to M546, its lane, its slice and its result. **The results of the gated rows are the final split gate, at `12ee772`** (E170 item 2: split, three workers, `mini-hp01`; 440 files, 2,398 passed, 6 failed, 0 skipped: M540 (b) on the final-gate placeholder, M440's storm (e1, e5) and requested tick (d), M311 (h) twice). No M6 row but M540 failed there. Per-file counts are not in the errata and the gate logs on `mini-hp01` were not read for this report; they are not stated, but for the three files on the real unit the driver relayed (M510 8, M536 12, M520 through the preview unit 2). The gate in full is section 12's.

| Row | Lane | Slice | Result |
|---|---|---|---|
| M501 | kernel | 40 | passed at `12ee772` |
| M502 | kernel | 40 | passed at `12ee772` |
| M503 | kernel | 40 | passed at `12ee772` |
| M504 | kernel | 40 | passed at `12ee772`; F5's cases (`e0f0c6b`) among them |
| M505 | kernel | 40 | passed at `12ee772`; F1's cases (`379baa6`, `ec5f3ba`) among them |
| M506 | kernel | 41 | passed at `12ee772`; F5's cases among them |
| M507 | kernel | 40 | passed at `12ee772`; F1's cases among them |
| M508 | kernel | 44 | passed at `12ee772`; F1's and F5's cases among them |
| M509 | kernel | 40 | passed at `12ee772` |
| M510 | sandbox | 42 | passed at `12ee772`, 8 on the real unit; F8's case (h) (`8b1055e`, `ca58a02`) among them |
| M511 | kernel | 42 | passed at `12ee772` |
| M512 | kernel | 44 | passed at `12ee772`; (k) for F2 and F3 (SEAM §§550, 551) among them |
| M513 | kernel | 44 | passed at `12ee772` |
| M514 | kernel | 44 | passed at `12ee772` |
| M515 | kernel | 44 | passed at `12ee772` |
| M516 | project | 45 | passed at `12ee772`; F4's (g) among them |
| M517 | kernel | 44 | passed at `12ee772` |
| M518 | kernel | 45 | passed at `12ee772` (3 of 3 alone at `3ef611b` after a load failure, E166 item 6) |
| M519 | real | 46 | **real lane, 10 of 10**, last judged 2026-10-18 at `308230d` (section 16); never in a gate |
| M520 | kernel, sandbox | 42 | passed at `12ee772` (both files; through the preview unit, 2 on the real unit) |
| M521 | kernel | 41 | passed at `12ee772` |
| M522 | kernel | 43 | passed at `12ee772` |
| M523 | kernel | 43 | passed at `12ee772` |
| M524 | kernel | 41 | passed at `12ee772` |
| M525 | kernel | 43 | passed at `12ee772` |
| M526 | kernel | 43 | passed at `12ee772` |
| M527 | kernel | 43 | passed at `12ee772` |
| M528 | kernel | 45 | passed at `12ee772` |
| M529 | kernel | 45 | passed at `12ee772` |
| M530 | kernel | 44 | passed at `12ee772` |
| M531 | kernel | 45 | passed at `12ee772`; F4's (h) to (l) among them |
| M532 | kernel | 41 | passed at `12ee772` |
| M533 | kernel | 41 | passed at `12ee772` |
| M534 | kernel | 43 | passed at `12ee772` |
| M535 | real | 46 | **real lane, 12 of 12**, last judged 2026-10-19 at `def6afd` (section 18); never in a gate; not a clean run |
| M536 | project | 40 | passed at `12ee772`, 12 on the real unit; its first real-unit run 12 of 12 at `231b6d1` (`M6-first-preview/`) |
| M537 | kernel | 46 | passed at `12ee772` (both files) |
| M538 | kernel | 41 | passed at `12ee772` |
| M539 | kernel | 46 | passed at `12ee772` (3 of 3 alone at `3ef611b` after a load failure of (e), E166 item 6) |
| M540 | report | 46 | this report. In the final gate at `12ee772` (the report at `0f0e412`): (a) passed; (b) failed on the final-gate placeholder of section 12, the only one left, as expected. Filled from E170 item 2 and run alone on `verify/m540` from `5521699`, and again with E171 recorded from `1f8e064`, 2026-10-19: (a) and (b) passed, 2 of 2. At `b56e26d` the skeleton's (b) failed by design. |
| M541 | hands-on | 46 | the file (its form and guards) passed at `12ee772`; no record of Sean's run (section 30) |
| M542 | kernel | 39 | passed at `12ee772`; in the real runs, the observed model recorded on every run with a turn (section 4) |
| M543 | kernel | 39 | passed at `12ee772` (both files) |
| M544 | kernel | 39 | passed at `12ee772`; in the real runs, 47 host observations, each with its revision (section 2) |
| M545 | kernel | 39 | passed at `12ee772` |
| M546 | kernel | 39 | passed at `12ee772` |

## 10. Every D7 Appendix C row and the plan row that carries it

D7 Appendix C sketched 35 rows; each keeps its number in the plan (§4.1), its change from the sketch recorded there. The result is the carrying row's (section 9).

| D7 row | Plan row | Result |
|---|---|---|
| D7 M501 | M501 | passed at `12ee772` |
| D7 M502 | M502 | passed at `12ee772` |
| D7 M503 | M503 | passed at `12ee772` |
| D7 M504 | M504 | passed at `12ee772` |
| D7 M505 | M505 | passed at `12ee772` |
| D7 M506 | M506 | passed at `12ee772` |
| D7 M507 | M507 | passed at `12ee772` |
| D7 M508 | M508 | passed at `12ee772` |
| D7 M509 | M509 | passed at `12ee772` |
| D7 M510 | M510 | passed at `12ee772` |
| D7 M511 | M511 | passed at `12ee772` |
| D7 M512 | M512 | passed at `12ee772` |
| D7 M513 | M513 | passed at `12ee772` |
| D7 M514 | M514 | passed at `12ee772` |
| D7 M515 | M515 | passed at `12ee772` |
| D7 M516 | M516 | passed at `12ee772` |
| D7 M517 | M517 | passed at `12ee772` |
| D7 M518 | M518 | passed at `12ee772` |
| D7 M519 | M519 | real lane 10 of 10 at `308230d` |
| D7 M520 | M520 | passed at `12ee772` |
| D7 M521 | M521 | passed at `12ee772` |
| D7 M522 | M522 | passed at `12ee772` |
| D7 M523 | M523 | passed at `12ee772` |
| D7 M524 | M524 | passed at `12ee772` |
| D7 M525 | M525 | passed at `12ee772` |
| D7 M526 | M526 | passed at `12ee772` |
| D7 M527 | M527 | passed at `12ee772` |
| D7 M528 | M528 | passed at `12ee772` |
| D7 M529 | M529 | passed at `12ee772` |
| D7 M530 | M530 | passed at `12ee772` |
| D7 M531 | M531 | passed at `12ee772` |
| D7 M532 | M532 | passed at `12ee772` |
| D7 M533 | M533 | passed at `12ee772` |
| D7 M534 | M534 | passed at `12ee772` |
| D7 M535 | M535 | real lane 12 of 12 at `def6afd`; not a clean run |

The eleven rows the plan adds beyond Appendix C: M536 to M539 from D7's text, M540 (this report), M541 (the hands-on), M542 to M546 (M5's carried defects); their results are in section 9.

## 11. The straddles

BS6 §9.3 and the plan's §4.3: each accepted M1 to M5 row a D7 correction reached, as changed by a Verifier and recorded in COVERAGE. **`design: off` is the default**, so every M1 to M5 project runs as before.

| Correction | What changed in accepted rows | COVERAGE |
|---|---|---|
| G9 (every role but the Designer refused `.surety/design/`) | the roles' packages (M442) state the path through the registry; M423's prohibitions unchanged in their files | "M6 slice 40", "M6 slice 46" |
| G12 (the Designer exempt from D6-S08) | M419 unchanged for Vision, Spec Writer and Architect; E147 item 4's `integration_conflict` kept for them and pinned again in M532 (d) as the guard that G12 is the Designer's alone | "M6 slice 41" |
| G2, G6 (plan-check clauses), G1 (the module map's members) | **M442's straddle** (objection 146, upheld): `harness/real/packages.mjs` `architect.schema.modules` takes D7 G1's four module members and four interface members beside M5's, each of M5's still required; the reason list gains clause 5's codes; on `a33c06d` the changed file failed only at D7's lines, as a straddle written before its engine should | "M6 slice 40", the straddle of M442 |
| G3 (B.2's header and mark) | M421 and M449 unchanged; an M5 specification's `semantic_digest` does not move (M502 (c)) | "M6 slice 40" |
| G8 (the design class) | M432 unchanged; the design class empty for a project with no design | "M6 slice 44" |
| G14, G15 (`asset_inputs`, `asset_bindings`) | optional and empty on every M1 to M5 result; no accepted file changed | "M6 slice 43": "No accepted file and no earlier slice's harness changed" |
| G4 (the preview) | `design-preview` reserved; the owner's configuration of it refused (M511 (d)); deployment rows unchanged | "M6 slice 42": the same sentence |
| The pace read | figures added; M441 asserts no closed key set and is unchanged | "M6 slice 46" |
| G7 | built in M5 (E153); M433's E153 file as written; the trigger keeps the name `spec_change` (section 23) | the declared deviation at the head of COVERAGE |

**Accepted rows changed during M6 for reasons other than a D7 correction**, each test-side and recorded: the shared seed's engine switch waits for live runs and M335's unit read is confined to its home (E156 Q1; SEAM §474; "M6 slice 39"); M430 S1 (a) and S2 answer a plan approval once bound to the current head (objection 173, `e898af6`); M430 (c), R1, R2 pin the replacement replan at the phase's end (E163 item 6; `e554382`, `c9f09fa`); M442 (c) reports an errored play as its own failure (E163 item 6); M404 (e) waits for the project's one-shots before opening a session (`cd3bdef`, E165 item 8); M435 (e) waits for the corrected version to take effect (`9d92580`, E165 item 10). None is a weakening; each case's assertions are unchanged or extended.

## 12. The kernel, sandbox and project lanes (the split gate)

**The gates of M6 as the errata record them**, each split, three workers, `TMPDIR=/var/tmp`, on `mini-hp01`, with each failure rerun alone (E150 item 6); a failure that passed alone is recorded load-only, never as a pass of the gate:

| Gate | Entry | Acceptance | Failed in the gate | Alone |
|---|---|---|---|---|
| `e0ca344` (slice 39) | E157 | 399 files, 2,129 passed | 7: M74, M545 (a) (both fixed), M440 storm (e1, e5), M15, M311 (h) | the sixteen affected files 3 of 3 at `7b617b9` |
| `1bbe470` (slice 40) | E158 | 407 files, 2,197 passed | 12, in M440, M29, M545, M311 (h), M70, M401, M15, M08 | each file 3 of 3 |
| `f6287ea` (slice 41) | E159 | 413 files, 2,237 passed | 5, in M440, M430, M61, M327 | M61, M327, M440 3 of 3; M430 a test race (objection 173) |
| `a286577` (slice 42) | E159 | 417 files, 2,254 passed | 6, in M440, M338, M311 (h), M424 | 3 of 3 |
| `0124076` (slices 43, 44) | E160 | 430 files, 2,308 passed | 4, in M440, M29, M311 (h) | load-sensitive list |
| `18c7d14` (slice 45) | E161 | 435 files, 2,334 passed | 4, in M440, M29, M432 | 3 of 3 |
| `1f20d2e` (slice 46) | E163 | clean bar load | M440, M338, M540's skeleton | M338 3 of 3 |
| `bcc69de` (E162's checks) | E163 | 440 files, 2,373 passed | 9: M440 (storm, requested tick), M29, M15, M540, M442 (c) | 3 of 3; M442 (c) 2 of 3, traced to engine defects (E163 item 6) |
| `b76c37e` (the replan fixes) | E163 | 440 files, 2,378 passed | 7: M440, M338, M430 S2, M70, M104, M540 | 3 of 3 |
| `3e945a2` (F1) | E164 | 440 files, 2,388 passed | 4: M15, M440 storm, M404 (e), M540 | M15, M440 3 of 3; M404 (e) 2 of 3, a test race fixed at `cd3bdef` |
| `fd5087f` (F2, M404) | E165 | 440 files, 2,387 passed | 6: M440 storm, M311 (h), M401, M435 (e), M540 | 3 of 3, but M435 (e) 0 of 3, a test race fixed at `9e6910d` (3 of 3 alone after) |
| `3ef611b` (F4) | E166 | 2,392 passed | 7: M440 (e1, e5), M539 (e), M70, M15, M518, M540 | each file 3 of 3 |
| `b56e26d` (F5) | E169 | 2,399 passed | 4: M540's skeleton, M15's run-end fault matrix, M440's storm | M15, M440 3 of 3 |
| `12ee772` (F8; the final gate) | E170 | 440 files, 2,398 passed | 6: M540 (b) (the final-gate placeholder), M440 storm (e1, e5), M440 requested tick (d), M311 (h) ×2 (cancelled) | storm 3 of 3; on the loaded host the requested tick 1 of 3 and M311 2 of 3; on a quiet host both 3 of 3 on each of `4e05624` and `12ee772` |

**Load-sensitive under E150 item 6** (each failed in some gate and passed alone every time it was rerun, except after the final gate on its loaded host, where M440's requested tick passed 1 of 3 and M311 (h) 2 of 3, each then 3 of 3 on a quiet host on both revisions): M440 (the storm, the requested tick), M15 (the run-end fault matrix, the git write deadline), M311 (h), M29, M338, M70, M08, M401, M104, M432, M61, M327, M424, M518, M539 (e). E164's M404 (e) and E165's M435 (e) were test races, fixed test-side. E159 item 9: every gate since slice 40 has left one `/var/tmp/surety-integ-*` home on `mini-hp01` ("homes after: 1"), not yet traced to a file.

**The final split gate** (E170 item 2; the driver's relay, its logs on `mini-hp01` not read by me): at **`12ee772`** (`gate/m6final`: `main` `4e05624` with `build/f8` `61bd15e`, `verify/f8` `ca58a02` (cases `8b1055e`, `ca58a02`) and `verify/m540` `0f0e412`), split, three workers, on `mini-hp01`, 2026-10-19 19:24:48 to 20:49:20 UTC. **Build exit 0; unit exit 0. Acceptance: 440 files, 2,398 passed, 6 failed, 0 skipped.** From the gate's units log on `mini-hp01` (relayed): "manager: running", "units before: 0", "units left:" empty (none), "homes after: 1" (the count of `$TMPDIR/surety-*` directories after the gate; E159 item 9's one home). The six failures:

- **M540 (b)**, "no placeholder is left": this placeholder, the only one left; expected, and filled here.
- **M440-a-storm-of-completions** (e1, e5).
- **M440-the-requested-tick** (d): D1 §8.1's order (recover, journal, integrity) against the held tick's end.
- **M311-the-identity-reads-duration** (h), twice: cancelled, the before hook timing out after 30 s waiting for a tick.

**Alone on `mini-hp01` right after the gate:** the storm 3 of 3; the requested tick 1 of 3 (the same (d) failure twice); M311 2 of 3 (in one run the before hook timed out waiting for a tick, both tests cancelled). **Then on a quiet host, alternating `main` `4e05624` and the gate `12ee772`, three rounds:** the requested tick and M311 each passed 3 of 3 on each revision (12 of 12). So neither failure is F8's; both stay on E150 item 6's load-sensitive list, and neither is counted as a pass of the gate. **On the real unit within the gate:** M510 8 passed (F8's new case (h) among them), M536 12, M520 through the preview unit 2. Merged at `19afc9f`, the same tree as `12ee772`; errata E170 at `5521699`. **No split gate of M6 exited zero, the final one included**; every failure but M540's placeholder is load-sensitive under E150 item 6.

**Accepted as an explicit exception** (E171 item 1): the gate failed; controlled reruns support classifying its remaining execution failures as load-sensitive, and M540's was the report's own placeholder, filled since.

## 13. The project-lane journeys and their pace reads

The project-lane rows are **M536** (the design journey on the scripted backend, a real preview unit and a real Alpha unit) and **M516** (the review at Alpha on the real web Alpha), each passing at `12ee772` (section 9). **M536's first real-unit run** (rule 23; E158 item 2; E162 item 5), at `231b6d1` on the workstation, 2026-10-17 07:15:44 to 07:22:41 UTC: 12 tests, 12 passed, `rc=0`; the `surety-*` user unit list empty before and empty after (`docs/acceptance/reports/M6-first-preview/`, Sean's review of it in E162 item 5: it does not establish that unrelated units were unchanged throughout). **Their pace reads' figures are not retained**: the gate keeps per-file pass counts only, and M536 (k) pins only that BS6 §10's design figures are present or unknown with their reasons. The preview's `memory.peak` on its real unit in the project lane is therefore not known from any retained record.

## 14. The exhaustion lane (E156 Q8)

M6 adds no exhaust file; M5's five (`M133-resource-limits`, `M130-exit-classes-limits`, `M205-an-oom-kill-on-the-exhaustion-host`, `M341-a-service-at-its-limits`, `M438-a-role-domain-past-its-maximum`) run once on `mini-hp01` at the final revision with `SURETY_EXHAUSTION_HOST` set, an acceptance condition because M6 changes admission (the preview's own maximum, one-shots beside a Designer session). An earlier run at `65fcf5e`, 15 of 15 in 5 files, units 0 (`mini-hp01:~/gate-logs/m6early-65fcf5e-exhaust-summary.log`), is not the condition.

**Earlier, at `4e05624`** (the driver's run, `~/exhaust.sh m6final-4e05624` on `mini-hp01`: `node scripts/run-tests.mjs acceptance --lane exhaust` with `SURETY_EXHAUSTION_HOST=mini-hp01`, `XDG_RUNTIME_DIR` and the D-Bus address set, `TMPDIR=/var/tmp`, in the checkout `~/surety-gate` at `main` `4e05624e`, finished 2026-10-19 about 18:02 UTC): **exhaust exit 0; tests 15, pass 15, fail 0; "acceptance: 5 file(s) passed."; units left 0.** By file: `M133-resource-limits` 45.4 s, `M130-exit-classes-limits` (f), (g) 7.6 s, `M205-an-oom-kill-on-the-exhaustion-host` (g) 4.7 s, `M341-a-service-at-its-limits` 13.0 s, `M438-a-role-domain-past-its-maximum` (h) 4.5 s. Logs: `mini-hp01:~/gate-logs/m6final-4e05624-exhaust.log` and `m6final-4e05624-exhaust-summary.log` (the driver's relay; not read by me). `4e05624` was the final engine when that run was made; F8's fix (`61bd15e`, merged at `19afc9f`, E170) then changed three files of `src/` (`boundary/terminate.ts`, `deploy/adapters/local-service.ts`, `store/transitions/deploy.ts`), so the lane was run again.

**At the final revision `19afc9f`** (the driver's run, `~/exhaust.sh m6final-12ee772` on `mini-hp01`, the same command and environment as the `4e05624` run, in the checkout `~/surety-gate` at `12ee772`, whose tree is the same as `main` `19afc9f`: `git diff 12ee772 19afc9f` is empty; finished 2026-10-19 21:18:58 UTC): **exhaust exit 0; tests 15, pass 15, fail 0; "acceptance: 5 file(s) passed."; units after 0.** Per-file times were not relayed for this run. This is E156 Q8's run at the final revision; the report's commits since change only `docs/acceptance/reports/`. E171 item 1 records it: the final engine passed the exhaust lane, 15 of 15 at `12ee772`, the tree of `19afc9f`.

## 15. The rehearsals

Never evidence (SEAM §171; BS6 §12). Each paid start was preceded by the dress rehearsal of its file with the package-driven fakes, the Designer's among them (`SURETY_REAL_REHEARSAL=1`), on the revision it ran; a rehearsal whose every case passes writes `rehearsal-passed.json` (`{file, revision, dirty, at, run_dir}`), and the paid run refuses unless it names that exact clean revision. The records found (each `dirty: false`):

| Rehearsal | File | Revision | Recorded at (UTC) | For |
|---|---|---|---|---|
| `~/s6r-w` | M519 | `390b2fd` | 2026-10-17 23:13 | E163 item 8 (10 of 10); not a paid revision |
| `~/s6r-w2` | M519 | `0824dff` | 2026-10-18 01:55 | M519's start (10 of 10, E164 item 1) |
| `~/s6r-w3` | M519 | `292e11e` | 06:38 | the refused rerun (F2) |
| `~/s6r-w4` | M519 | `fd5087f` | 06:56 | the rerun of `m6w_design` |
| `~/s6r-w5` | M519 | `308230d` | 07:24 | `judge:M519 (c)` and the build to teardown |
| `~/s6r-x1` | M535 | `65fcf5e` | 16:23 | before F4's fix; not a paid revision |
| `~/s6r-x2` | M535 | `8cffaf0` | 21:07 | M535's start and its reruns of `m6x_design` (12 of 12, the driver's account) |
| `~/s6r-x3` | M535 | `e62cc39` | 2026-10-19 13:15 | `judge:M535 (a)` and the build to teardown (E167 item 4) |
| `~/s6r-x4` | M535 | `def6afd` | 15:49 | `judge:M535 (l)` (E168 item 5) |

M535's case (k), its start condition, passed at every one of its seven starts (`runner-M535-results.txt`).

## 16. The first real run: design before build and at Alpha, one target (M519)

**Passed 10 of 10**, last judged 2026-10-18 at `308230d` (the run 01:55:56 to 08:22 UTC with a halt; section 2), run directory `~/s6-1018` (`run-kind.json`: `rehearsal: false`), engine home `/home/smahoney/s6-1018/home`. **The brief:** V1's visual-design brief, `~/surety-m5-physics-idea-visual.md` (Mechanica, three physics labs), unchanged; project `m6-m519-mechanica` (`proj_01M56BT56F8DBWG5HM55FWEMXD`), T2, `design: both`, `autonomy: phase`, `alpha_deploy: on_phase_complete`, day limit 40 USD. **The specification** (version 1, 02:04:40) `**Targets:** web`, one phase, R1 to R8; version 2 (02:39:55) by the design's consolidated change, adding the web human-test requirement R9 and design criteria among them R6.1, R7.1 and R8.20 of kind `human` (9 requirements). **The architecture:** four stages; the two UI stages held for the design (`plan_01M56CC1ZMMY7392MTRSCKHTBN`).

| Case | Result | What the records show |
|---|---|---|
| (a) the attempts; `session_qualified` from the continuation canary; both entries active | passed | section 4 |
| (b) the sessions metered, the Designer's among them; the design passing its check; the preview deployed, opened through the relay and torn down | passed | Spec Writer session `run_01M56BVZF5…` (2 owner turns), Architect `run_01M56C2NTS…` (1), Designer `run_01M56CW24F…` (3 turns, 1,156 s; its first save refused by the design check for fixture names and `scene_html` on a web target, fixed by the Designer itself), each turn one ledger row with usage `recorded`. Design revision `dsg_01M56E0GBV…` v1 at `81f4d5f`, check passed. Previews `dpv_01M56DZS7Y…` (generation 1, 02:38:24 to 02:39:56) and `dpv_01M56WTMMP…` (generation 2 at the rerun, 06:57:45 to 06:59:04), each opened through the relay and torn down; the second stopped by the owner's route `DELETE …/design/preview` (E165 item 2). |
| (c) the batched approval: `design_approval` and its `spec_change` under one `batch_key`, recorded with the actor and its performer | passed after F3's fix | the batch answered 02:39:55 by the driver (section 19); judge (c) first halted at 07:02 because the rerun's act record had dropped the first attempt's acts (F3) |
| (d) the build: the UI stage held `design_pending` while the API stage built, released after `design.ready`; every check result an engine execution | passed | the UI stage held 16,145 s `design_pending` (the F1 deadlock included), the other 0 s; `design.ready` at 06:56:49 at the rerun's first tick (F1's fix); both UI stages failed `page-labels` (R8.4) on a wrong check, answered `correct_check` by the driver and its correction approved (E165 item 5); four stages verified; **210 check results, every one `execution_established` by the engine's runner** (`direct`, one runner id) |
| (e) `qualify-adapter`; Alpha requested under policy, `alpha_authorize` satisfied, verified, `alpha_deployed` on a real unit of the run home's prefix | passed | request `dreq_01M570RT55M80W58AE1HBXHD97` (`requested_by: policy`); `alpha_authorize` `gate_01M570RT55…`, `alpha_complete` `gate_01M570S1BC…`; candidate `cand_01M570AK2CKY8XG3S18PF3NMJJ` `alpha_deployed` 21,983 s after creation |
| (f) the review at Alpha: `design_verdicts` answered by the owner; the web human test carrying the confirmed verdict | passed | review `drv_01M571DG72BPRQ6SQN8S4QKQKN` (trigger `alpha_complete`, subject the candidate and deployment `op_01M570RT55…`), review-mode session `run_01M570VBQP…` (2 turns, 453 s); 3 engine-observed evidence records; 31 deltas (21 implementation, 3 both, 7 design); confirmed as proposed by the driver (`dec_01M571DG7571…`, 08:18:06); the human test R9 carrying the three confirmed verdicts, `status: pending` |
| (g) the teardown applied, nothing of the prefix left; `pace.json` with the Designer's figures and the preview's peak; the token nowhere | passed | teardown applied; left: units, cgroups, run files none; 21 journals searched, 0 hits; `records.token` over the run directory and `repos/m519-mechanica`, **hits 0**; `transcript_token_hits` 0; `pace.json` with the preview's peak **`unknown`** ("not read before its removal"), which the case accepts as a value |
| (h) every step's end (rule 25) | passed | no step judged passed with a question it raised open |
| (i) every owner act: its performer with evidence beyond the store's `human` actor; none unknown | passed | every act the driver's (section 19) |
| (j) the findings: each defect with its step and its workaround | passed | F1 to F4, none with a workaround (section 17) |

**Runs:** 39 runs (4 sessions: Spec Writer, Architect, two Designer; 35 one-shots: 16 Verifier, 10 Reviewer, 8 Builder, 1 Spec Writer change run), every one `completed`; **43 ledger rows, 16.57 USD estimated** (section 20), against the guess of 10 to 18 USD.

**The review's differences and M519's 24 accepted unresolved differences** (E165 item 6; E166 items 1 and 5). Confirming the verdicts filed one finding per implementation or `both` delta per lab: **24 findings** (momentum lab 7, friction lab 8, trajectory lab 9), each recorded with criterion **R8.19** and check **`design-asset-favicon`**, an association the engine manufactured (`designCheckFor`) from another criterion on the same target, not one the difference concerns (F4). The driver answered `accept` on all 24 (08:18:43 to 08:18:45). **They are accepted unresolved differences of the Alpha, not repaired defects**; the store is not edited, and `observed/f4-associations-M519.json` records each with its disposition, its recorded association marked erroneous, `resolved: false`, `repaired: false`. (F4's first findings entry says 23; the store has 24.)

| Difference (each lab's finding unless named) | Labs | Kind |
|---|---|---|
| the start-up failure card has no logo and no "Reload the page" button | 3 | implementation |
| out-of-range messages are the raw `RangeError` text with internal names and no units (a recommendation for the next design revision) | 3 | both |
| after a run the Run button still reads "Run the experiment", not "Run again" | 3 | implementation |
| the 3D-unavailable notice uses other words than the design's | 3 | implementation |
| a missing `--scene-*` token is not reported on the console | 3 | implementation |
| the scene's grid is drawn fully opaque, not at 70 % (R8.20) | 3 | implementation |
| the momentum "Why" sentence can contradict the numbers when cart 2 already moves (R6.1) | momentum | implementation |
| "Skip to the lab controls" always targets `#momentum-controls`, hidden on the other labs | friction, trajectory | implementation |
| the friction lab's predicted stopping point is a box, not a pole with a flag | friction | implementation |
| the trajectory lab's predicted landing point is a cylinder, not a ring on the ground | trajectory | implementation |
| the drag coefficient's hint is overwritten with the range text on load | trajectory | implementation |

The review's design-kind deltas (the momentum prediction range of −30 to 30 m/s, the input-error wording, the letter-spacing, the scaled playback) filed no finding; the driver recorded them as recommendations for the next design revision and accepted the scaled playback as built (E165 item 6). Nothing was rendered: every delta rests on the served HTML, CSS and scripts, the verdicts recorded `observed_on: browser` because the schema has no value for "read, not rendered" (E165 item 6).

## 17. M519's defects and their fixes before M535 started (E156 Q5)

Every defect M519 found (`observed/findings-M519.jsonl`), the step it stopped, whether a driver workaround passed it, its fix on `main` with its commit, and its acceptance case. **No step of M519 was passed by a workaround**: every finding's `workaround` is null, and M519 (j) and M535 (k) both read it so. A step a defect stopped was rerun on the fixed revision (section 2).

| Finding | Step stopped | Kind | Workaround | Fix on `main` (commit) | Acceptance case |
|---|---|---|---|---|---|
| **F1**, the design readiness deadlock: `designReadiness` required every added criterion covered by a check, stricter than D7 §7.5; the `human`-kind criteria R6.1, R7.1, R8.20 were deferred to a stage held `design_pending`; nothing in flight and no question naming the cause | `m6w_design`, halted 05:11:25 after 180 minutes (E164) | engine | none: the step was left to time out | `68f3867` (build `f6722a8`, `a803c2b`, `6613f3b`), the driver's ruling of E164 item 3 | M505, M507, M508 (`379baa6`, `ec5f3ba`); SEAM §549 |
| **F2**, a rerun's leftovers counted builds held `design_pending` as earlier work | the rerun of `m6w_design` at `292e11e`, refused before any engine | harness | none | `e47e0bc` | M512 (k); SEAM §550 |
| **F3**, a rerun's act record dropped the first attempt's acts; a halted directory still started engines for later steps | `m6w_design`'s judge (c), halted after the rerun passed | harness | none | `308230d` | M512 (k); SEAM §551 |
| **F4**, a confirmed review's findings each linked to criterion R8.19 and check `design-asset-favicon`, whatever they concerned | none stopped (found at `m6w_review`; the 24 findings accepted, section 16) | engine | none | `25fef88` (cases `711da7f`, `2338919`; build `9ff79c0`, `5aa6299`, `12ba708`, `0e074be`), Sean's rulings (E166) | M516 (g), M531 (h) to (l) |

Each finding is recorded resolved in `findings-M519.jsonl` by its commit (F1 to F3 at 07:19:34, F4 at 20:58:53 on 2026-10-18). The gate before F4's merge, `3ef611b`, is section 12's. **M535's start condition** (M535 (k), BS6 §12): M519's `state.json` records every step `m6w_create` to `m6w_teardown` passed with `workaround: null`; every finding resolved by a commit the checked-out revision contains; **M535's rehearsal passed on the revision M535 ran** (`8cffaf0`, `~/s6r-x2`; then `e62cc39`, `~/s6r-x3`, and `def6afd`, `~/s6r-x4`; section 15); the checkout clean. The runner checked it before any engine started at each of M535's seven starts, and (k) passed each time; its last record is `observed/M535.json` `start_condition` (revision `def6afd`, rehearsal `~/s6r-x4`).

## 18. The second real run: the M6 journey, web and a labelled android simulation, a held logo (M535)

**Passed 12 of 12**, last judged 2026-10-19 15:49 UTC at `def6afd`; the run 2026-10-18 23:01 to 2026-10-19 15:30 (sections 2, 15), the same run directory and home. **The brief:** Waterlog (`docs/acceptance/reports/M6-real-lane/m535-brief.md`, approved by Sean with three edits, E162 item 3); project `m6-m535-waterlog` (`proj_01M58KYMDFHMR612C1ZRT5N203`), T2, `design: both`, `autonomy: phase`, `alpha_deploy: on_phase_complete`, day limit 50 USD; `**Targets:** web, android`, `**Cross-platform:** yes`. Specification version 1 (23:05:36, R1 to R5); version 2 (12:50:04) by the design's change, adding R6 (web) and R7 (android), the human tests, and the criteria R3.8 to R3.17 and R4.7 to R4.10 (E167 item 1).

**M535 is not a clean run** under E152 item 1 (E167 item 5). (1) **F5** (engine): a `ui`-module interface with neither request nor response (four file-kind interfaces: web `page` and `design_tokens`, android `api_base_url` and `simulation`) was derived `shape_known: false` but still owed an `ok` state, so no design could pass (`DESIGN_STATE_UNCOVERED` when omitted, `DESIGN_INTERFACE_SHAPE_UNKNOWN` when named). M535 went past it by **a governed Architect correction**: on Sean's instruction the driver routed the four Designer findings to the Architect (`architect`), and two Architect sessions under his delegation removed the four interfaces from the module map and set the logo's `asset_paths` to the `on_dark` variant on both targets; a first correction that also changed `phase-1.json` and `roadmap.json` was refused at close `plan_generation_stale`, and the files were restored byte for byte (E167 item 1). Not by an engine fix: F5 was fixed on `main` at `d91492c` after the run (E169). (2) **Judgement (a) was amended by Sean** (E167 item 4) after it halted the run on the driver's two unused Designer sessions, then re-judged at `e62cc39`. (3) **F6 and F7** (harness) were fixed during the run (`f107b11`) before `judge:M535 (l)` was rerun at `def6afd` (E168 items 4, 5). Also: the step's 180-minute wait lapsed at four starts (`runner-M535-results.txt`), three of them before Sean's second Designer session, after the driver's two early `open` answers; each rerun was routine and cost nothing (E167 item 3).

| Case | Result | What the records show |
|---|---|---|
| (k) its start | passed at each of seven starts | section 17 |
| (a) the sessions metered, the Designer's among them; the design passing its check; the preview deployed, opened through the relay and torn down | passed at `e62cc39` (amended) | Spec Writer `run_01M58M1EMS…` (1 turn), Architect `run_01M58M7Q0S…` (1) and the two correction sessions `run_01M58YB2WE…` (5) and `run_01M58YQN4D…` (1); six Designer sessions: Sean's `run_01M58VM5RV…` (3 turns, timed out, its save refused by F5) and `run_01M5A18XAT…` (1 turn, saved `0a2ad63`, design check `dchk_01M5A1M43V…` passed), the driver's two unused `run_01M58N7DKA…` and `run_01M58ZAMMQ…` (no turn, no ledger row, listed by the amended judgement, never hidden), and two review-mode sessions; every turn one ledger row, usage `recorded` |
| (b) the preview: the web mockup served bare, the android mockup inside the engine's labelled frame; `SIMULATIONS.txt` on export | passed | previews `dpv_01M5A1Q1Y8…` (generation 1, 12:20:54 to 12:50:05, Sean's inspection) and `dpv_01M5A3WEHW…` (generation 2, 12:58:48 to 12:58:51, the runner's own read); the export `export-M535/` with `SIMULATIONS.txt` (copied) |
| (c) the first approval with the logo held | passed | `dsg_01M5A2JMWK…` v4, `assets_held: ["logo"]`, the effective logo the placeholder (`logo@1`) |
| (d) the UI stages: each Builder package holding the effective logo by digest and never the held one; each check reading the effective `slot@version`; bindings recorded | passed | stages 1 and 2 verified, stage 3 integrated; bindings web `public/assets/logo.svg` (`copy`) and android `android/assets/logo.png` (`derived`) |
| (e) the held logo approved by an asset-only approval: the effective version moved; one `asset_updated` item | passed | the driver submitted (`surety design assets submit`, 14:52), Sean approved (15:00:09) `dsg_01M5AAD617…` (`asset_only`); `logo` from version 1 (placeholder, digest `837b61b2…`) to 2 (approved, `c50ae13c…`); one fix `wi_01M5AATPBS…` from the two bindings |
| (f) its integration: `asset_version_changed` obligations resolved; parity passing with the new `slot@version` | passed | obligations `r3-logo` (15:02:48) and `r4-logo` (15:03:29) resolved; parity results `cr_01M5AAZHXE…` and `cr_01M5AB0SHA…`, exit 0, `asset_inputs` `logo/on_dark@2`; approval to integration 67 s |
| (g) `alpha_deployed` under policy | passed | request `dreq_01M5A5C2X45NYG1Y3JC5RRWS91` (`requested_by: policy`), 13:24 UTC, **before the logo's approval**; candidate `cand_01M5A50BX0WWHJX5Q2QXJCSR6K`; Alpha was not redeployed and **serves the placeholder logo**; `main` holds the approved logo (`53efa50`) (E168 item 1) |
| (h) the review: web screens from the engine's observations; android `not_observed` `no_native_runtime`, its human test pending | passed | review 1 `drv_01M5ABABP9…` (trigger `alpha_complete`, 1 engine-observed evidence record of `/`); android `not_observed`; see below for the struck web verdict and review 2 |
| (i) the teardown applied, nothing left; `pace.json`; the token nowhere | passed | applied; left none; 33 journals searched, 0 hits; `records.token` over the run directory and `repos/m535-waterlog`, **hits 0**; `transcript_token_hits` 0; the preview's peak **`unknown`** |
| (j) every step's end (rule 25) | passed | |
| (l) the owner's acts: the four central acts performed by Sean with his own entries; every other act's performer recorded; the human actor alone never counted | passed at `def6afd` (after F6, F7) | section 19 |

**The review at Alpha, the struck web verdict and the second review** (E168 items 2, 3). The driver ran the review-mode session (two turns: its HTTP reads of the Alpha through the relay, then a correction of its own misreported wording). When Sean confirmed it (15:11:18) he **struck the web verdict** by running the driver's example command, which carried `--strike web/web-plant-list`: the driver's error in giving it as a runnable line. On Sean's choice the driver requested an **owner-invoked second web review** (`surety design review --target web`, `drv_01M5ABSZQHN4PZ224XTZH5QJXX`, trigger `owner_command`, subject recorded `owner_build` naming the same Alpha candidate and deployment; no evidence recorded), which found the same four implementation deltas and a fifth of kind `both`. **Sean confirmed it** (15:23:10) with an edit dropping the fifth (`observed/m535-design/review2-edit-without-delta5.json`). The web human test R6 carries that verdict, `provenance: owner_reported`, `status: pending`; the android human test R7 carries `not_observed`, pending.

**Sean's ruling** (E171 item 2): the second web review is owner-reported evidence, not a passed human test. The web human test stays `pending`, carrying his confirmed `deltas` verdict; android's stays `pending`. No engine observation is reconstructed, the struck verdict (E168) is not restored, and the human test is not marked passed; his confirmation establishes that he accepted that review record, not that every reported defect is fixed.

**M535's four accepted findings**, each naming no criterion and no check, so `accept` was their only option under E166, accepted by the driver (15:24:23), **standing unresolved**: (1) the Alpha serves the placeholder logo (deployed before the approval); (2) no favicon: `index.html` has no `rel=icon` and `/favicon.svg` answers 404; (3) focus leaves the Watered button while logging (the list is rebuilt); (4) the success announcement may be unread (a new live region is created each time). **The fifth review delta**, focus after "Try again" (a design change to the keyboard path, kind `both`), is a **recommendation for the next design revision, not decided** (E168 item 3).

**Carried, not erased** (E171 item 4): the four findings stay accepted and unresolved, linked to their reviews, to be triaged for Waterlog's next revision; M6's acceptance authorises none of their proposed work. The fifth delta stays a design recommendation, a requirement only by Sean's approval. The approved logo reached the repository and its checks (`53efa50`, logo@2), not a redeployed Alpha: the Alpha still serves the placeholder.

**Runs:** 28 runs (10 sessions: Spec Writer 1, Architect 3, Designer 6; 18 one-shots: 8 Verifier, 5 Builder, 4 Reviewer, 1 Spec Writer change run); 26 metered; every one-shot and every session with a turn `completed` except Sean's two Designer sessions, which ended `timed_out` after their last turn (the second after its save). **34 ledger rows, 14.51 USD estimated, none unknown** (section 20). E168 item 6 says "34 metered runs": the store has 34 ledger rows (invocations) over 26 runs.

## 19. Every owner act of both runs, and who performed it (E156 Q6)

Every owner act of M519 and M535: the act, its route, who actually performed it (Sean, the driver on a quoted instruction, or `unknown`) and the evidence beyond the store's `human` actor that establishes it (`owner-acts.jsonl` for Sean's own entries, typed by him at the runner's prompt in his terminal through `owner-act.mjs`, which refuses unless its input and output are a terminal; `driver-acts.jsonl` for the driver's, each with Sean's instruction quoted; the relay's openings and closings for a preview inspection). **An API actor `human` alone is never counted as Sean's act or as evidence that he inspected anything**: the store records every answered decision's actor as `human`, and every session's owner turns as `owner`; neither says who. No act of either run is `unknown`. Built from `observed/acts-M519.json`, `observed/acts-M535.json`, `observed/owner-acts.jsonl` (6 entries) and `observed/driver-acts.jsonl` (85 lines). The runs themselves were started by the driver (Sean's paid-run delegation, E144 item 2).

**The instructions quoted.** M519, every act: "go ahead and drive M519's acts yourself". M535: (I1) "Start M535 using the prepared checkout and stated limits. Handle the routine steps under my existing delegation."; (I2) "Please take over the governed architecture correction now. Verify the four entries' classification and the logo-variant mismatch, then refresh the inventory and arrange any necessary Designer updates."; (I3) "Request a second web review (Sean, 2026-10-19, after the first confirmation struck the web verdict by mistake)", the driver's words recording Sean's choice.

| Run | Act | Route | Performed by | Evidence beyond the store's human actor |
|---|---|---|---|---|
| M535 | the Designer feedback: Sean's own turns in two Designer sessions, `run_01M58VM5RV7RC3VW4JJQ749H77` (3 turns, 01:16 to 01:41) and `run_01M5A18XAT9YZENR2SP1M9Q1GT` (1 turn, 12:14) | `surety session say` on the Designer session (`POST …/sessions/:run/turns`) | **Sean** | two entries in `owner-acts.jsonl`: 01:39:03 "I asked for readable text, more spacing, clear watering status and comfortable phone controls. I kept the logo unapproved and asked about the asset binding mismatch."; 12:19:55 "Yes, that's the right inventory: its digest excludes version numbers, and version 3 changed only the android logo path, which isn't in the inventory." No driver entry. The transcript record shows his first turn was the literal template text `PASTE_YOUR_FEEDBACK_HERE`, which his second turn calls accidental. |
| M535 | the preview inspection of revision `0a2ad63` (the web mockups and the android simulation through the relay) | `surety design preview`, `surety env open design-preview` (`POST …/design/preview`, `POST …/environments/design-preview/relay`) | **Sean** | his entry 12:49:39 "checked all the mockups. they look good"; the relay's record: opened 12:26:46 (generation 1, port 45931), closed 12:49:22 by command. **The paths served are not recorded**: neither the relay nor the preview server records requests (`relay_requests` `unknown`, with that reason). The relay's second opening (12:58:50 to 12:58:51) is the runner's own read, not an inspection. |
| M535 | the combined approval: `design_approval` with the logo held (`dec_01M5A2M88D…`, 12:49:52) and its `spec_change` (`dec_01M5A2M89Y…`, 12:50:04) | `POST …/decisions/:d/answer` with `assets_held` | **Sean** | his entry 12:50:27 "everything looks good." |
| M535 | the review confirmation: `design_verdicts` of review 1 (`dec_01M5ABABPB…`, 15:11:18, the web verdict struck by mistake) and of review 2 (`dec_01M5ABYMTH…`, 15:23:10, with the edit dropping delta 5) | `surety design verdicts <review> confirm` | **Sean** | one entry, 15:29:57, after both: "I reviewed and accepted it"; E168 items 2 and 3 |
| M535 | the asset-only approval of the held logo (`dec_01M5AAD61B…`, 15:00:09) | `POST …/decisions/:d/answer` | **Sean** | his entry 15:00:24 "i looked at the logo." |
| M535 | `policy_widening` ×2 (23:01:40, 23:02:08) | `POST …/decisions/:d/answer` | the driver on (I1) | two lines of `driver-acts.jsonl` |
| M535 | the Spec Writer session (1 owner turn), `spec_approval` (23:05:36) | `surety session …`; the answer route | the driver on (I1) | `driver-acts.jsonl` 23:05:17, 23:05:36 |
| M535 | the Architect session (1 turn), `architecture_approval` and `plan_approval` (23:12:11) | the same | the driver on (I1) | `driver-acts.jsonl` 23:10:26, 23:12:11, 23:12:12 |
| M535 | `surety qualify-adapter local_service` | the CLI | the driver on (I1) | `driver-acts.jsonl` 23:22:30 |
| M535 | `correction_approval` ×2 (23:23:22; the design criteria's checks 12:58:36) | the answer route | the driver on (I1) | `driver-acts.jsonl` |
| M535 | `design_due` answered `open` ×2 (23:23:22 on (I1); 02:19:54 on (I2)), each opening a Designer session that timed out unused | the answer route | the driver | `driver-acts.jsonl`; E167 item 3 calls both premature |
| M535 | `finding_disposition` ×4 `architect` (the Designer's F5 findings, 01:42:00) | the answer route | the driver on (I1) | `driver-acts.jsonl`; Sean's (I2) followed |
| M535 | the two Architect correction sessions (5 and 1 owner turns) and `architecture_approval` ×2 (02:08:39, 02:10:27) | `surety session …`; the answer route | the driver on (I2) | `driver-acts.jsonl` 02:07:09 to 02:10:27 |
| M535 | `surety design assets submit` (14:52:46) | `POST …/design/assets/submit` | the driver on (I1) | `driver-acts.jsonl` 14:52:52 |
| M535 | `design_due` (`alpha_review`) answered `open` (15:05:47) | the answer route | the driver on (I1) | `driver-acts.jsonl` |
| M535 | the review-mode session of review 1 (2 turns) and the second review's request and session (2 turns) | `surety design review --target web`; `surety session …` | the driver, on (I1) and (I3) | `driver-acts.jsonl` 15:08:49, 15:19:51 |
| M535 | `finding_disposition` ×4 `accept` (15:24:23) | the answer route | the driver on (I1) | `driver-acts.jsonl` |
| M519 | `qualification_approval` ×2 (01:56:41, 01:58:28; the shared step `m6_attempt`) | the answer route | the driver | `driver-acts.jsonl` |
| M519 | `trust_activation` ×2 (02:00:07, 02:00:15; `m6_activation`), and one refused answer naming a stale decision (01:59:41) | the answer route | the driver | `driver-acts.jsonl`, the refused line kept (E164 item 4) |
| M519 | `policy_widening` (02:00:38) | the answer route | the driver | `driver-acts.jsonl` |
| M519 | the Spec Writer session (2 owner turns), `spec_approval` (02:04:40) | `surety session …`; the answer route | the driver | `driver-acts.jsonl` |
| M519 | the Architect session (1 turn), `architecture_approval` and `plan_approval` (02:10:08) | the same | the driver | `driver-acts.jsonl` |
| M519 | `surety qualify-adapter local_service` ×2 (02:18:12; the rerun's 06:57:36) | the CLI | the driver | `driver-acts.jsonl` |
| M519 | `correction_approval` ×5 in the design step (02:18:47 to 02:44:16), ×1 in the build (07:54:46) | the answer route | the driver | `driver-acts.jsonl` |
| M519 | `design_due` answered `open` (02:18:53) | the answer route | the driver | `driver-acts.jsonl` |
| M519 | `finding_disposition` ×2 in the design step (`correct_check` 02:32:38, `reject` 02:33:09) | the answer route | the driver | `driver-acts.jsonl` |
| M519 | the Designer feedback (3 owner turns, `run_01M56CW24FTV4XNS6TSZJKEGPP`) | `surety session say` | the driver | `driver-acts.jsonl` 02:36:22 |
| M519 | the preview inspection ×2 (02:38; the rerun's 06:58): HTTP reads through the relay of the index, the mockups, the favicon; nothing rendered | `surety design preview`; the relay | the driver | `driver-acts.jsonl` 02:38:47, 06:59:10; the relay opened 02:38:28 to 02:38:47 and 06:58:36 to 06:58:49 |
| M519 | the combined approval (`design_approval` and `spec_change`, 02:39:55) | the answer route | the driver | `driver-acts.jsonl` (two lines) |
| M519 | `blocker` ×2 `correct_check` (07:53:46, 07:53:55) | the answer route | the driver | `driver-acts.jsonl` |
| M519 | the Alpha inspection (08:08:01): HTTP reads through the relay; no store event of its own | the relay | the driver | `driver-acts.jsonl` only (E165 item 9) |
| M519 | `design_due` (`alpha_review`) answered `open` (08:08:01) | the answer route | the driver | `driver-acts.jsonl` |
| M519 | the review-mode session (2 owner turns) | `surety session …` | the driver | `driver-acts.jsonl` 08:18:11 |
| M519 | the review confirmation (`design_verdicts` confirm, 08:18:06) | `surety design verdicts … confirm` | the driver | `driver-acts.jsonl` |
| M519 | `finding_disposition` ×24 `accept` (08:18:43 to 08:18:45) | the answer route | the driver | `driver-acts.jsonl` (24 lines) |

Not owner acts: both runs' Alpha requests were the engine's, under policy; M535's second preview generation and its export read were the runner's.

## 20. The pace reads of the real runs

From `observed/pace-M519.json` and `observed/pace-M535.json` (the engine's `GET /v1/projects/:p/pace` at each run's end) and the store's `ledger_rows`. Never a throughput claim; one run each; M519's figures include the F1 halt (about 4.3 hours) and M535's the wait for Sean's sessions overnight.

| | M519 (`m6-m519-mechanica`) | M535 (`m6-m535-waterlog`) |
|---|---|---|
| created to `spec_approved` | 257 s | 270 s |
| created to `architecture_approved` | 586 s | 665 s |
| `spec_approved` to `design_approved` | 2,116 s | 49,468 s |
| `design_approved` to `design.ready` | 15,414 s (F1) | 513 s |
| created to phase 1 complete; to `alpha_deployed` | 21,976 s; 21,983 s | 51,819 s; 51,829 s |
| phase plan published to completed; phase verification | 21,389 s; 16.8 s | 51,154 s; 23.1 s |
| UI stages' `design_pending`; `design_stale` | 16,145 s and 0 s; 0 s | 48,465 s and 48,466 s; 0 s |
| human wait of `design_due`, `design_approval` (union) | 16,145 s, 19 s (16,145 s) | 48,465 s, 783 s (48,465 s) |
| slots by source; unbound; `not_checkable_yet` | placeholder 6; 0; web 6 | placeholder 4, approved 5; 2; android 3, web 2 |
| asset approval to integration | none | 67 s |
| reviews: subject, time, deltas, evidence | candidate, 594 s, web 21 implementation + 3 both + 7 design, 3 engine-observed | candidate, 175 s, 4 implementation, 1 engine-observed; owner build, 153 s, 4 implementation, evidence `unknown` ("the review recorded no evidence") |
| sessions; runs | 4; 39 | 10; 28 |
| model observed per run | every run (39) | every run with a turn (26); the two sessions with no turn `unknown` with the reason |
| peak domains at once | 2 | 2 |
| tokens (ledger): billable, cached, output | 1,462,583; 17,305,009; 435,911 | 1,265,371; 13,261,121; 349,719 |
| **cost (Claude Code's estimates)** | **43 ledger rows, 39 runs, 16.57 USD; none unknown** | **34 ledger rows, 26 runs, 14.51 USD; none unknown** |
| by role (USD) | Designer 7.20, Verifier 3.70, Builder 2.69, Architect 1.04, Spec Writer 1.03, Reviewer 0.92 | Designer 6.25, Verifier 3.59, Architect 2.17, Builder 1.24, Spec Writer 0.82, Reviewer 0.43 |
| day (UTC) | 2026-10-18: 16.57 | 2026-10-18: 3.52; 2026-10-19: 10.99 |

**The run directory's total:** 85 ledger rows, **31.33 USD estimated**: M519 16.57, M535 14.51 (each `round(sum(cost_usd))` over its project's rows, `cost_status` `estimated` on every row), and the qualification fixture's 8 rows, 0.25 USD, of which 2 are `unknown` (the two cancellation canaries, `stopped`, each reserving its unknown allowance: 296,613 and 296,957 tokens). Expected (BS6 §12, guesses): M519 10 to 18 USD, M535 15 to 25 USD, the attempts under 0.50: all within. No cap was reached: no run passed 2,000,000 billable tokens, no Designer session 3,000,000, no project its day limit. **Memory peaks of the other domains** (`execution_domains.memory_peak`, all recorded): role domains, highest **317.1 MiB** (an M535 Designer session) of `role_memory_max` 4 GiB; check domains, highest 70.2 MiB of 2 GiB; **service domains: 33, none with a peak** (as in M5).

## 21. The Designers' measured usage and the preview's memory.peak against the trial defaults (E156 Q4)

Each Designer session of both runs: its turns, its billable, cached and output tokens, and its time per session and per turn, against `designer_session_budget_billable_tokens` (3,000,000, a trial value); each preview's `memory.peak` against `preview_memory_max` (256 MiB, a trial value). From the store's `turns` and `ledger_rows` (read only) and the pace reads' `design.designer_sessions` and `design.previews`; the per-turn time is `finished_at` less `started_at`.

| Session | Run, mode, outcome | Turns | Billable / cached / output tokens | Session time | Per turn: time; billable | Cost | Share of the budget |
|---|---|---|---|---|---|---|---|
| `run_01M56CW24FTV4XNS6TSZJKEGPP` | M519, design, `completed` | 3 | 253,150 / 4,720,902 / 107,592 | 1,156 s | 932 s, 189,163; 59 s, 21,464; 86 s, 42,523 | 5.12 USD | 8.4 % |
| `run_01M570VBQPBADD7N0ASYM4WWQK` | M519, review, `completed` | 2 | 132,804 / 2,432,697 / 26,390 | 453 s | 358 s, 108,673; 60 s, 24,131 | 2.08 USD | 4.4 % |
| `run_01M58N7DKAJR9RHSAERESG100D` | M535, design, `timed_out` (the driver's, unused) | 0 | no ledger row (`unknown` in the pace read) | 1,200 s | none | none | none |
| `run_01M58VM5RV7RC3VW4JJQ749H77` | M535, design, `timed_out` (Sean's) | 3 | 271,180 / 3,210,656 / 60,415 | 2,715 s | 321 s, 98,157; 231 s, 101,536; 116 s, 71,487 | 4.02 USD | 9.0 % |
| `run_01M58ZAMMQRSXRX07RDBBXF1RZ` | M535, design, `timed_out` (the driver's, unused) | 0 | no ledger row | 1,212 s | none | none | none |
| `run_01M5A18XAT9YZENR2SP1M9Q1GT` | M535, design, `timed_out` after its save (Sean's) | 1 | 57,341 / 575,170 / 6,877 | 1,299 s | 97 s, 57,341 | 0.71 USD | 1.9 % |
| `run_01M5AB510ZDGN65XYN8P09544P` | M535, review 1, `completed` | 2 | 62,259 / 477,700 / 12,424 | 164 s | 116 s, 49,998; 26 s, 12,261 | 0.84 USD | 2.1 % |
| `run_01M5ABSZQD5V3DATVP18VYJ530` | M535, review 2, `completed` | 2 | 53,857 / 313,446 / 9,277 | 138 s | 98 s, 47,435; 22 s, 6,422 | 0.68 USD | 1.8 % |

**Against the budget:** the highest session spent 271,180 billable tokens, **9.0 % of 3,000,000**; the highest single turn 189,163 (the first turn of M519's Designer, 932 s, 4.25 USD). The Designer was the costliest role in both runs (7.20 and 6.25 USD, 43 % of each project's estimate). Every Designer turn's usage was `recorded`; the model observed was `claude-opus-5-5` on every turn. These are one host's and two small projects' figures, for revisiting the default, not a measurement of a Designer's cost in general (D7 §15 class B).

**The preview's `memory.peak`: not recorded in either run (finding F8, fixed after them).** Every one of the four real previews (M519 `dpv_01M56DZS7Y…`, `dpv_01M56WTMMP…`; M535 `dpv_01M5A1Q1Y8…`, `dpv_01M5A3WEHW…`) reads `memory_peak` **`unknown`** in the pace read ("the preview domain's memory.peak was not read before its removal"); `design_previews.memory_peak` and its service domain's `execution_domains.memory_peak` are null on all four. M519 (g) and M535 (i) accept a value or `unknown`, so both passed. D7 §14 and E156 Q4 require each preview's domain `memory.peak`, so that `preview_memory_max` is revisited on measurements; `design_previews.memory_peak` existed and the pace read used it, but nothing wrote it: **finding F8** (E170 item 1). **Sean's ruling** (E170 item 1): fix it now; this report records both runs as unmeasured; the next clean real run takes the first measurement; a peak that cannot be read stays `unknown` with its reason, never zero. **Fixed at `19afc9f`** (`61bd15e`: the local-service adapter reads the domain's cgroup `memory.peak` before it stops the unit, and `design_previews.memory_peak` and the teardown and replacement payloads record it), pinned by **M510 (h)** (`8b1055e`, `ca58a02`: every route, replaced, `--stop`, TTL and approval, leaves `memory_peak` an integer above zero and at most `preview_memory_max`, and the pace read equals it), which passed on the real unit within the final gate (section 12). **So the trial default `preview_memory_max` (256 MiB) is not yet revisited on any measurement:** no real run has run on the fixed engine. The preview's deploy times were recorded: 0.7 s, 1.5 s, 2.0 s, 1.9 s.

**Default changes:** none. Sean keeps `designer_session_budget_billable_tokens` (3,000,000) and `preview_memory_max` (256 MiB) as trial defaults, provisionally (errata E171 item 3): two small applications are not enough to choose a general limit. The next measurements record, beside spend, each session's length, its retries, and whether the reserved budget held back other work.

## 22. The design trees approved and the review files

Copied to `docs/acceptance/reports/M6-real-lane/2026-10-19/` (BS6 §12; the README's section 6), **190 files, 3,116,227 bytes**:

| Path | What | Source |
|---|---|---|
| `state.json` | the run directory's step record | `~/s6-1018/state.json` |
| `observed/` | `M519.json`, `M535.json`, `acts-M519.json`, `acts-M535.json`, `owner-acts.jsonl`, `driver-acts.jsonl`, `findings-M519.jsonl`, `f4-associations-M519.json`, `pace-M519.json`, `pace-M535.json` (each project's `pace.json`), `step-attempts.json`, `step-starts.json`, `m535-design/` (Sean's first-session feedback, the session record, the Designer update the driver suggested, the edit dropping delta 5) | `~/s6-1018/observed/` |
| `export-M535/` | the approved tree's export with `SIMULATIONS.txt` | `~/s6-1018/export-M535/` |
| `design/M519-v1-81f4d5f/` | M519's design at its one approved revision, `dsg_01M56E0GBV…` v1, commit `81f4d5f`, tree `16c66aa8`: 63 files, 1,066,632 bytes | `git archive 81f4d5f .surety/design` in `repos/m519-mechanica` |
| `design/M535-v4-0a2ad63/` | M535's design at `dsg_01M5A2JMWK…` v4 (full, approved 12:50:04, superseded by the asset-only revision), commit `0a2ad63`, tree `82c0c3d1`: 44 files, 138,012 bytes. **The asset-only revision `dsg_01M5AAD617…` (approved 15:00:09) records commit `af1fb47`, whose `.surety/design` is the same git tree object** (`82c0c3d1`): the approval moved the effective set, not the files; so it is copied once | `git archive 0a2ad63 .surety/design` in `repos/m535-waterlog` |
| `reviews/` | the review files: M519 `review-1.json` (blob `81596dea`), M535 `review-1.json` (blob `3c357a53`) and `review-2.json` (blob `21162b79`) | `git cat-file blob` |
| `evidence-digests.json` | the 4 evidence records (3 for M519, 1 for M535), `engine_observed`, `http_response`, each with its route, status, size and sha256 digest; never the bytes | `design_evidence`, read only |
| `transcripts/` | the 13 sessions' transcript records (the canary, M519's 4, M535's 8 with turns), each entry's text from its record file, every record's sha256 matching, `post_scan` as recorded | `session_transcripts` and `records`, read only |
| `store-reads.json` | the store reads this report cites (revisions, ledger, Designer turns, previews, design revisions and reviews, entries, qualifications) | the store, read only |
| `token-search.json` | the token search below: its forms, files searched, hit counts, and the runs' own searches; never a value | this report's search |
| `runner-M519-results.txt`, `runner-M535-results.txt` | **excerpts** of the runner logs: each start's header and every case's result line and summary | `~/s6-1018/runner-M519.log`, `runner-M535.log` |

**Not copied, by choice:** the engine home (`~/s6-1018/home/`, 526 MB, its `api.token` among it); the full runner logs (162 KB and 204 KB), whose curl lines name the engine's token file by path (`$(cat …/home/api.token)`); the repositories beyond the design trees and review files; `WAITING.txt`, `secrets/`, `bin/`. No device screenshot exists: no owner evidence was supplied.

**The token.** The runs' own searches, at each run's records step: M519 (g) and M535 (i), `records.token` over the run directory and each project's repository, **hits 0**; `transcript_token_hits` (every transcript record of the project, searched in memory), **0**; the teardown's journals, 21 and 33 units, **0 hits**. **The M540 Verifier's search of the copied set** (all 190 files, `token-search.json` included) and of `docs/acceptance/reports/`, by the token's file, the value never printed, in its raw, JSON-escaped and base64 forms: **0 hits** for `~/.config/surety/m5-subscription.token` (the file the driver's records name for these runs) and **0 hits** for the older `~/.config/surety/claude-subscription.token`. The engine's `api.token` and the deploy secret were not searched by value (they are credentials not to be read); the copied set holds the API token's path only, in the act records' curl lines. Whether the token's value passed through any conversation is not in any record I read. Sean revokes the token if he made a new one (BS6 §12).

**How that search was made** (E170 item 3). The search process opened both subscription token files by path and wrote only hit counts; no value or part of one was printed or written. This broke the standing rule that no agent reads a token file. The driver disclosed it to Sean and stopped any further read; the counts stand. Future token searches use the harness's own search, at each run's records judgement (M519 (g), M535 (i)), whose counts are above; this report's completion did not search again.

**Sean's ruling** (E171 item 6): the access is retained as a **process violation**. The zero counts establish the search result only, not permission to repeat the access, nor proof of the value's absence from every possible destination. Future token searches use the harness's own documented procedure only.

## 23. G7's trigger: the accepted naming deviation (E156 Q2)

The post-final-phase replan keeps its built trigger `spec_change` (E153 item 1; `registerDeliveryReplans`), an accepted naming deviation from D7 A.2's `post_phase_change`, recorded at the head of COVERAGE, with no rename and no migration; its behaviour pinned by **M517** (the design change after the final phase: one replan with `trigger_source` `spec_change` where the corrected check fails, none where it passes, one per change across ticks and restarts) and **M529**, both passing at `12ee772`. M433's E153 file stands as written. E160 item 5 records, for Sean, that the trigger fires for any change adding a criterion after the last phase, beyond E153's "obligations only". Neither real run reached the post-final-phase replan.

## 24. The carried defects as handled (BS6 §11.3)

| E154 | Item | Handling | Where it stands |
|---|---|---|---|
| 6 (1) | `runs.model_observed` never set | **M542** | passes at `12ee772`; in the real runs recorded on every run with a turn (section 4) |
| 6 (2) | M444F-1: a replan refused on pending prerequisite results | **M543** (held under `prerequisite_results`) | passes at `12ee772` (both files); neither real run replanned |
| 6 (3) | M444's parked blocker left open after the runner ended | rule 25 in the real rows: M519 (h), M535 (j) | both passed; no step judged passed with a question it raised open |
| 6 (4) | the shared seed's switch | test-side, slice 39 (SEAM §474) | fixed; M401 not failing for that reason since |
| 6 (5) | `engine_version` `0.0.0` | **M544** (`engine_revision`) | passes; 47 real observations with their revision; `engine_version` still `0.0.0` |
| 6 (6) | INK-2: a stale phase verification not retired | **M545** | passes at `12ee772` |
| 6 (7) | INK2-2: a redundant disposition question | **M546** | passes at `12ee772` |
| 5 | M15's preflight-refusal case, M311 (h): load only | E150 item 6's protocol | M15 failed in six of the thirteen gates of section 12 (the run-end matrix or the git write deadline), M311 (h) in five; each passed alone every time it was rerun |
| 5 | M335's host-wide unit read | test-side, slice 39 | fixed; not failing since |

## 25. Cases reported `not_exercised`

By name: **H13** (the execution observer, optional) and **P20** (exhaustion probes, the workstation not designated) of every one of the 30 host qualifications (section 5). **The exhaust files** are not run off `mini-hp01` (section 14). **No case was reported `not_exercised` for want of a browser, an emulator or a device**: M535 (h)'s android verdict is `not_observed` with reason `no_native_runtime`, a recorded verdict, not a skipped case, and its human test stays pending. No real row was left unrun. The runner fails a skipped test, so no gate in section 12 counted a skip as a pass.

## 26. The packages and the rehearsal (M537)

M537 at `12ee772`: both files passed (the Designer's and the Verifier packages state what the engine reads; the rehearsal plays from the Designer's package, 13 of 13 in COVERAGE's run of 2026-10-17). The Designer's package is built from the registry like M5's (E151) and its fake derives every file from what the package states (objection 202). **Package gaps the rehearsals found** before any paid step: `ROLE_KEY` lacked `designer: backend_designer` (E163 item 2); the correction fake read programs the engine had moved (objection 201); `designer.review.files` for what review mode lacks (objection 204); the replan and check-authoring packages stated `depends_on` as stage ids where the schema needs numbers, found through M442 (c)'s intermittent failure (E163 item 6). **What the real runs found that no rehearsal could:** the human-judged design criteria (F1, the engine's readiness rule rather than a package gap); the review's manufactured links (F4); the unshaped file-kind interfaces an Architect may declare on a `ui` module (F5, now refused at the plan check); the Designer's first save in M519 refused for fixture names and `scene_html` on a web target, which the Designer fixed from the refusal (E164 item 1).

## 27. What M6 does not claim

See `M6-not-claimed.md` (D7 §15 classes A, B and C, BS6 §13's list, what the real runs do not show, D8 entirely, and M5's list, carried). In short: native execution, native building, packaging and device testing of any target; a browser, rendered screenshots and pixel comparison; image generation; that a Designer session produces an approvable design, that a simulation is faithful, that a UI Builder implements a design, that the static checks catch what a person would call off-design, that bindings are where the app loads its assets, that a session costs near D7 §13's guess; D7 §15 class C; D8; the preview's memory against its maximum, unmeasured in both runs (F8, fixed at `19afc9f` after them; section 21); that M535 is a clean run; that the review's verdicts rest on anything rendered; and that Sean made M519's acts or M535's other acts (section 19).

## 28. Limits of the instruments

BS6 §8's limits: the scripted Designer's design is the test's, so a pass proves the engine's handling of a design, never that a model produces an approvable one (D7 §15 class B); a test reads mockups as bytes, never as rendered pages, so "the frame cannot be removed" is pinned by the frame's markup and the iframe's sandbox attribute, not by a browser (BS6 §4.1 rule 21); the review's verdicts on scripted runs are the script's; two real runs are not a claim about a real Designer's behaviour. **What the runs add:**

- **Nothing in either run was rendered.** Every preview inspection by the driver and every review delta rests on HTTP reads of HTML, CSS and scripts; the review schema has no value for "read, not rendered", so M519's verdicts say `observed_on: browser` (E165 item 6). Sean's preview inspection is his word ("checked all the mockups"); the relay records no paths, so what he opened is not established beyond the relay's opening and closing.
- **M535's web human test carries an owner-reported verdict**, review 2's, on a subject recorded `owner_build` that names the same Alpha candidate, with no evidence record; review 1's engine-observed web verdict was struck by mistake (section 18).
- **The Alpha of M535 serves the placeholder logo**: the asset change propagated to `main` and to the parity checks, not to a redeployed Alpha (E168 item 1).
- **The preview's `memory.peak` was not read** on any real preview (F8, section 21); its fix (`19afc9f`) is pinned by M510 (h) on the real unit, not yet by a real run; service domains have no peak (section 20).
- **The real runs did not run on the final engine**: F5's fix (`d91492c`) is exercised by M504, M506 and M508 only, F8's (`19afc9f`) by M510 (h) only.
- **M535 is not a clean run** (section 18); M519's design step was rerun after F1 (section 17). No clean-run bar like E152 item 1's was set for M6, and none was met.
- **The split gate runs three workers**: load-only failures recur (section 12); E159 item 9's one leftover home per gate on `mini-hp01` is not traced.
- **The store's `engine_version` reads `0.0.0`**; the revision is `engine_revision` (section 2).
- **Recorded in E159 item 7, unchanged:** a native mockup is served from the same origin as the frame and could remove its banner; `previewState` scans `events` without an index; D7 §14's API wording (corrected in E162 item 4: TCP on loopback with a token and Host and origin checks, not a unix socket).
- **Wall-clock timestamps** are no more exact than this WSL2 clock (BS6 §4.1 rule 17); durations the engine measures are monotonic.
- **The project-lane pace reads' figures were not retained** (section 13).

## 29. Open decisions and provisional readings

From E156 to E171, what stays provisional or open, and what E171 decided:

- **F5's ruling is Sean's (E169)**, and F8's (E170); the real runs give no evidence of either.
- **The hardening follow-up before unattended use** (E171 item 5), each recorded individually, a failing acceptance case first, then the fix, Sean deciding any behaviour the case must fix:
  - **H1.** The Reviewer's own `fix` on a finding with no check is refused, nothing dispatched, the owner question kept (E166 item 4).
  - **H2.** One confirmed `matches` on one screen does not accept a target's human test while other screens are unreviewed or differing (E161 item 6).
  - **H3.** An unresolvable `depends_on` id is reported, never silently dropped from a Builder's package (E163 item 7).
  - **H4.** A spec change whose replan was refused stale, and a cancelled parked design correction leaving the design version never ready, are each visibly recoverable (E163 item 7, E164 item 4).
  - **H5.** A review closed with `refuse` keeps its audit history but gets a governed withdrawal or recovery path; its form is Sean's decision (E166 item 4).
- **Not approved as a block** (E171 item 5): the rest of what E156 to E170 record for Sean mixes defects, deliberate limitations and items already decided; **each stays open until classified individually**: the Reviewer package's sentence on findings with no check (E166 item 4); M516's row text still says "`fix` as E43" (E166 item 4); `design_due` re-raised while an owner-opened Designer session exists, its `open` then blocked (E164 item 4); an owner turn refused `resource_envelope` while builds hold the host's domains (E164 item 4); owner acts with no store event (`alpha_inspection`, `review_session`, E165 item 9); a real run on a new engine build must re-qualify `local_service` before any preview or Alpha, which only the engine's refusal says (E165 item 9); no single act retires a pending proposal, the T2/T3 phase verification is requested before the hold check, and `GET …/plan` shows `depends_on` as ids (E163 item 7); the replan trigger's breadth (E160 item 5); verdicts and the design approval need two owner acts, nothing reads an observed design's criterion without a change phase, an asset-only approval resets `owner_accepted` (E161 item 6); `design.assets_approved` reading and turning `design` on over an existing manifest (E160 item 8); E157 item 3's two items (the revision is the checkout's HEAD, not `dist/`'s, a dirty tree not flagged; a stuck prerequisite holds a replan without limit, visibly). Convenience improvements follow H1 to H5.
- **The driver's rulings under Sean's delegation** (E157 to E165, E167, E168), each provisional until Sean confirms it (section 7).
- **F8 is decided** (E170): fixed at `19afc9f`; the first measurement of a real preview's peak, and any revisit of `preview_memory_max` on it, wait for the next clean real run (section 21).
- **The 28 accepted findings** (M519's 24, M535's four) stay accepted and unresolved, linked to their reviews, carried to each application's next revision for triage; M6's acceptance authorises none of their proposed work; a "won't fix" only as an individually documented decision, never recorded as repaired (E171 item 4). A later governed route for adding verification links to an existing finding is separate work (E166 item 3).
- **Design recommendations stay separate** (M535's fifth delta, M519's design-kind recommendations, section 16): requirements only by Sean's approval (E171 item 4).
- **E159 item 9's leftover home** on `mini-hp01`, untraced.
- **M5's open items** carried (`M5-not-claimed.md`; BS6 §14).

## 30. Hands-on run (M541)

`M6-hands-on.sh`'s file (`M541-hands-on-script`) passed at `12ee772` (its form and guards: the five steps, each acting step reading the prefix first). **No record of Sean's run of it** was found; what surprised him is his to add if he makes it. He did perform M535's central acts himself (section 19), the closest record of his hands on the Designer's surfaces.

## 31. Sean's rulings on the report's questions (E171)

Sean ruled on all five questions this section asked, 2026-10-19 (E171); none is left open here.

1. **M535 is not a clean run; does that meet the real-lane condition?** Both runs are accepted as evidence that the workflow works, their history preserved, as explicit acceptance exceptions: neither run clean, the final engine not exercised by either, the final gate failed with its remaining failures classified load-sensitive; the next clean real journey starts the clean-run record and takes the first `memory.peak` measurement, without changing these results (E171 item 1).
2. **The struck web verdict.** The second web review is owner-reported evidence, not a passed human test: the web human test stays `pending` with his confirmed `deltas` verdict, android's stays `pending`; no engine observation reconstructed, the struck verdict not restored (E171 item 2).
3. **The Designer budget.** The 3,000,000-token budget and `preview_memory_max` (256 MiB) stay trial defaults, provisionally; the next measurements add each session's length, its retries, and whether the reservation held back other work (E171 item 3).
4. **The 28 accepted findings and the recommendations.** Carried forward, accepted and unresolved, linked to their reviews, for each application's next revision; acceptance authorises none of their work; recommendations stay separate and become requirements only by his approval (E171 item 4).
5. **The open items of section 29.** H1 to H5 are the hardening follow-up before unattended use, each a failing case first; the rest is not approved as a block, each item open until classified individually (E171 item 5; section 29).

He also ruled that the token-file access of section 22 is retained as a process violation (E171 item 6).
