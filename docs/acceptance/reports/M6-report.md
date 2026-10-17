# Surety M6 acceptance report

**Status:** skeleton (2026-10-17, by the Verifier of slice 46, on `verify/m6-s46`). Written in full only after the kernel, sandbox and project lanes pass on `main` (the split gate on `mini-hp01`), M5's five exhaust files pass once on `mini-hp01` at the final revision (E156 Q8), and the two real runs are made, M519 first and M535 only after M519's defects are resolved and M535's rehearsal has passed on its revision (M6 plan §3.8 M540; BS6 §§1, 12, 13). Until then every fact a run must supply is a `[[PENDING …]]` placeholder, and **M6 is not accepted**: nothing here describes as passing what has not been run.

**Readers:** Sean, the driver. **Form:** the M5 report's (`M5-report.md`), with `M6-not-claimed.md` beside it in `M5-not-claimed.md`'s form, written with the final report.

## 1. What M6 claims and does not claim

BS6 §1's claim, verbatim, and the conditions of acceptance as they stood at the end. [[PENDING acceptance: not yet run; from the final npm test on main, the exhaust lane at the final revision, M519, M535]]

## 2. Revisions

[[PENDING revisions: not yet run; from the test, contract and engine revisions of the final runs (main, each real run, the exhaustion lane), and M544's recorded engine revision of each real run]]

## 3. The host

[[PENDING host: not yet run; from the host, kernel, systemd, Node, git and Claude Code versions, on the workstation and on mini-hp01]]

## 4. The backend and the two trust entries (the real lane only)

[[PENDING entries: not yet run; from m6_attempt and m6_activation: the entries (Opus session_headless with the continuation canary, Sonnet one_shot_headless), their models, modes and profiles; the model each run observed (M542)]]

## 5. The host qualification, the runner self-test and the preview's adapter

[[PENDING host qualification: not yet run; from the active host qualification of each run and the local_service adapter qualification the preview and Alpha ran under]]

## 6. The adoption of BS6 and the plan (E156), and Sean's answers Q1 to Q8

BS6 and the M6 acceptance plan, draft 2, adopted by Sean in E156; his answers to BS6 §16's eight questions as E156 item 2 records them: Q1 the opening correction slice (39, M542 to M546); Q2 G7's trigger kept as built, `spec_change`; Q3 the design's human-test requirements assigned narrowly; Q4 D7 A.7's defaults as trial values, `stack` refused; Q5 two real runs, M519 then M535, day limits of 40 and 50 USD, no workaround carried forward; Q6 Sean performs M535's four central acts and the report records who performed each act; Q7 a short hands-on; Q8 the exhaust lane at the final revision. [[PENDING adoption record: not yet run; from E156 and every later errata entry of M6 as they stand at acceptance (E157 onwards)]]

## 7. D7's decisions as they stood

D7 draft 3, every question decided (its closing section; E153 item 2), its corrections G1 to G15, reconciled with D8 (§17; E155 item 2). [[PENDING D7 decisions: not yet run; from D7 at the final revision and the driver's rulings under Sean's delegation recorded in the errata (objections upheld or decided)]]

## 8. The configuration in force

BS6 §11.1's table (D7 A.7's keys, trial values by E156 Q4) as it stood at the final revision. [[PENDING configuration: not yet run; from contract/config.json at the final revision and each real run's project policy as its records show it, widenings included]]

## 9. Every row and its result

Every row of the M6 plan, M501 to M546, its lane, its slice and its result on the final runs.

| Row | Lane | Slice | Result |
|---|---|---|---|
| M501 | kernel | 40 | [[PENDING M501: not yet run; from M501's files on main, the final split gate]] |
| M502 | kernel | 40 | [[PENDING M502: not yet run; from M502's files on main, the final split gate]] |
| M503 | kernel | 40 | [[PENDING M503: not yet run; from M503's files on main, the final split gate]] |
| M504 | kernel | 40 | [[PENDING M504: not yet run; from M504's files on main, the final split gate]] |
| M505 | kernel | 40 | [[PENDING M505: not yet run; from M505's files on main, the final split gate]] |
| M506 | kernel | 41 | [[PENDING M506: not yet run; from M506's files on main, the final split gate]] |
| M507 | kernel | 40 | [[PENDING M507: not yet run; from M507's files on main, the final split gate]] |
| M508 | kernel | 44 | [[PENDING M508: not yet run; from M508's files on main, the final split gate]] |
| M509 | kernel | 40 | [[PENDING M509: not yet run; from M509's files on main, the final split gate]] |
| M510 | sandbox | 42 | [[PENDING M510: not yet run; from M510's files on main, the final split gate]] |
| M511 | kernel | 42 | [[PENDING M511: not yet run; from M511's files on main, the final split gate]] |
| M512 | kernel | 44 | [[PENDING M512: not yet run; from M512's files on main, the final split gate]] |
| M513 | kernel | 44 | [[PENDING M513: not yet run; from M513's files on main, the final split gate]] |
| M514 | kernel | 44 | [[PENDING M514: not yet run; from M514's files on main, the final split gate]] |
| M515 | kernel | 44 | [[PENDING M515: not yet run; from M515's files on main, the final split gate]] |
| M516 | project | 45 | [[PENDING M516: not yet run; from M516's files on main, the final split gate]] |
| M517 | kernel | 44 | [[PENDING M517: not yet run; from M517's files on main, the final split gate]] |
| M518 | kernel | 45 | [[PENDING M518: not yet run; from M518's files on main, the final split gate]] |
| M519 | real | 46 | [[PENDING M519: not yet run; from the real run's records under docs/acceptance/reports/M6-real-lane/<date>/]] |
| M520 | kernel, sandbox | 42 | [[PENDING M520: not yet run; from M520's files on main, the final split gate]] |
| M521 | kernel | 41 | [[PENDING M521: not yet run; from M521's files on main, the final split gate]] |
| M522 | kernel | 43 | [[PENDING M522: not yet run; from M522's files on main, the final split gate]] |
| M523 | kernel | 43 | [[PENDING M523: not yet run; from M523's files on main, the final split gate]] |
| M524 | kernel | 41 | [[PENDING M524: not yet run; from M524's files on main, the final split gate]] |
| M525 | kernel | 43 | [[PENDING M525: not yet run; from M525's files on main, the final split gate]] |
| M526 | kernel | 43 | [[PENDING M526: not yet run; from M526's files on main, the final split gate]] |
| M527 | kernel | 43 | [[PENDING M527: not yet run; from M527's files on main, the final split gate]] |
| M528 | kernel | 45 | [[PENDING M528: not yet run; from M528's files on main, the final split gate]] |
| M529 | kernel | 45 | [[PENDING M529: not yet run; from M529's files on main, the final split gate]] |
| M530 | kernel | 44 | [[PENDING M530: not yet run; from M530's files on main, the final split gate]] |
| M531 | kernel | 45 | [[PENDING M531: not yet run; from M531's files on main, the final split gate]] |
| M532 | kernel | 41 | [[PENDING M532: not yet run; from M532's files on main, the final split gate]] |
| M533 | kernel | 41 | [[PENDING M533: not yet run; from M533's files on main, the final split gate]] |
| M534 | kernel | 43 | [[PENDING M534: not yet run; from M534's files on main, the final split gate]] |
| M535 | real | 46 | [[PENDING M535: not yet run; from the real run's records under docs/acceptance/reports/M6-real-lane/<date>/]] |
| M536 | project | 40 | [[PENDING M536: not yet run; from M536's files on main, the final split gate]] |
| M537 | kernel | 46 | [[PENDING M537: not yet run; from M537's files on main, the final split gate]] |
| M538 | kernel | 41 | [[PENDING M538: not yet run; from M538's files on main, the final split gate]] |
| M539 | kernel | 46 | [[PENDING M539: not yet run; from M539's files on main, the final split gate]] |
| M540 | report | 46 | [[PENDING M540: not yet run; from this report, final]] |
| M541 | hands-on | 46 | [[PENDING M541: not yet run; from M541's file on main, and Sean's run if he makes it]] |
| M542 | kernel | 39 | [[PENDING M542: not yet run; from M542's files on main, the final split gate]] |
| M543 | kernel | 39 | [[PENDING M543: not yet run; from M543's files on main, the final split gate]] |
| M544 | kernel | 39 | [[PENDING M544: not yet run; from M544's files on main, the final split gate]] |
| M545 | kernel | 39 | [[PENDING M545: not yet run; from M545's files on main, the final split gate]] |
| M546 | kernel | 39 | [[PENDING M546: not yet run; from M546's files on main, the final split gate]] |

## 10. Every D7 Appendix C row and the plan row that carries it

D7 Appendix C sketched 35 rows; each keeps its number in the plan (§4.1), its change from the sketch recorded there.

| D7 row | Plan row | Result |
|---|---|---|
| D7 M501 | M501 | [[PENDING D7 M501: not yet run; from M501 on main]] |
| D7 M502 | M502 | [[PENDING D7 M502: not yet run; from M502 on main]] |
| D7 M503 | M503 | [[PENDING D7 M503: not yet run; from M503 on main]] |
| D7 M504 | M504 | [[PENDING D7 M504: not yet run; from M504 on main]] |
| D7 M505 | M505 | [[PENDING D7 M505: not yet run; from M505 on main]] |
| D7 M506 | M506 | [[PENDING D7 M506: not yet run; from M506 on main]] |
| D7 M507 | M507 | [[PENDING D7 M507: not yet run; from M507 on main]] |
| D7 M508 | M508 | [[PENDING D7 M508: not yet run; from M508 on main]] |
| D7 M509 | M509 | [[PENDING D7 M509: not yet run; from M509 on main]] |
| D7 M510 | M510 | [[PENDING D7 M510: not yet run; from M510 on main]] |
| D7 M511 | M511 | [[PENDING D7 M511: not yet run; from M511 on main]] |
| D7 M512 | M512 | [[PENDING D7 M512: not yet run; from M512 on main]] |
| D7 M513 | M513 | [[PENDING D7 M513: not yet run; from M513 on main]] |
| D7 M514 | M514 | [[PENDING D7 M514: not yet run; from M514 on main]] |
| D7 M515 | M515 | [[PENDING D7 M515: not yet run; from M515 on main]] |
| D7 M516 | M516 | [[PENDING D7 M516: not yet run; from M516 on main]] |
| D7 M517 | M517 | [[PENDING D7 M517: not yet run; from M517 on main]] |
| D7 M518 | M518 | [[PENDING D7 M518: not yet run; from M518 on main]] |
| D7 M519 | M519 | [[PENDING D7 M519: not yet run; from M519 on main]] |
| D7 M520 | M520 | [[PENDING D7 M520: not yet run; from M520 on main]] |
| D7 M521 | M521 | [[PENDING D7 M521: not yet run; from M521 on main]] |
| D7 M522 | M522 | [[PENDING D7 M522: not yet run; from M522 on main]] |
| D7 M523 | M523 | [[PENDING D7 M523: not yet run; from M523 on main]] |
| D7 M524 | M524 | [[PENDING D7 M524: not yet run; from M524 on main]] |
| D7 M525 | M525 | [[PENDING D7 M525: not yet run; from M525 on main]] |
| D7 M526 | M526 | [[PENDING D7 M526: not yet run; from M526 on main]] |
| D7 M527 | M527 | [[PENDING D7 M527: not yet run; from M527 on main]] |
| D7 M528 | M528 | [[PENDING D7 M528: not yet run; from M528 on main]] |
| D7 M529 | M529 | [[PENDING D7 M529: not yet run; from M529 on main]] |
| D7 M530 | M530 | [[PENDING D7 M530: not yet run; from M530 on main]] |
| D7 M531 | M531 | [[PENDING D7 M531: not yet run; from M531 on main]] |
| D7 M532 | M532 | [[PENDING D7 M532: not yet run; from M532 on main]] |
| D7 M533 | M533 | [[PENDING D7 M533: not yet run; from M533 on main]] |
| D7 M534 | M534 | [[PENDING D7 M534: not yet run; from M534 on main]] |
| D7 M535 | M535 | [[PENDING D7 M535: not yet run; from M535 on main]] |

## 11. The straddles

BS6 §9.3 and the plan's §4.3: each accepted M1 to M5 row a D7 correction reached (G9, G12, G2 and G6, G3, G8, G14 and G15, G4, the pace read, G7), as changed by a Verifier and recorded in COVERAGE. [[PENDING straddles: not yet run; from COVERAGE, M6 slices 39 to 46: each accepted row changed, its former case kept or pinned as now refused]]

## 12. The kernel, sandbox and project lanes (the split gate)

[[PENDING lanes: not yet run; from the final split gate on mini-hp01 (three workers, TMPDIR=/var/tmp): unit and acceptance counts, units and homes left; each failure named, rerun alone three times, and recorded load-only where it passed alone (E150 item 6), never as a pass of the gate]]

## 13. The project-lane journeys and their pace reads

[[PENDING project pace: not yet run; from M536 and M516 (project lane): their pace reads, the preview's memory.peak on its real unit, rule 23's before-and-after unit lists of the first real-unit preview (E158 item 2)]]

## 14. The exhaustion lane (E156 Q8)

[[PENDING exhaust: not yet run; from M5's five exhaust files once on mini-hp01 at the final revision with SURETY_EXHAUSTION_HOST set; M6 adds none]]

## 15. The rehearsals

[[PENDING rehearsals: not yet run; from M519's and M535's dress rehearsals (SURETY_REAL_REHEARSAL) with the package-driven fakes, the Designer's among them, each on the revision its paid run used; never evidence]]

## 16. The first real run: design before build and at Alpha, one target (M519)

[[PENDING M519: not yet run; from state.json, observed/ and pace.json under docs/acceptance/reports/M6-real-lane/<date>/; each case (a) to (j); the visual-design brief with Targets: web, design: both, the day limit of 40 USD]]

## 17. M519's defects and their fixes before M535 started (E156 Q5)

Every defect M519 found, the step it stopped, whether a driver workaround passed it (a step passed only by a workaround is recorded as not passed), its fix on `main` with its commit and its acceptance case where a row covers it, and M535's rehearsal passed on the revision M535 ran. [[PENDING M519 defects: not yet run; from M519's findings record, the fixing Builder branches merged by the driver, M535's start condition (k) as its runner recorded it]]

## 18. The second real run: the M6 journey, web and a labelled android simulation, a held logo (M535)

[[PENDING M535: not yet run; from state.json, observed/ and pace.json under docs/acceptance/reports/M6-real-lane/<date>/; each case (a) to (l); the purpose-written web-and-android brief, design: both, the day limit of 50 USD]]

## 19. Every owner act of both runs, and who performed it (E156 Q6)

Every owner act of M519 and M535: the act, its route, who actually performed it (Sean, the driver on a quoted instruction, or `unknown`) and the evidence beyond the store's `human` actor that establishes it (`owner-acts.jsonl` for Sean's own entries, `driver-acts.jsonl` for the driver's instruction words, the relay's record of the mockup paths served during a preview inspection where it records requests). **An API actor `human` alone is never counted as Sean's act or as evidence that he inspected anything**; an act with neither record is reported `unknown`. M535's four central acts are Sean's by E156 Q6.

| Run | Act | Route | Performed by | Evidence beyond the store's human actor |
|---|---|---|---|---|
| M535 | the Designer feedback (his own turns in the Designer session) | `surety session say` on the Designer session | [[PENDING M535 Designer feedback performer: not yet run; from owner-acts.jsonl]] | [[PENDING M535 Designer feedback evidence: not yet run; from owner-acts.jsonl and the session's transcript record]] |
| M535 | the preview inspection (the web mockup and the android simulation through the relay) | `surety design preview`, `surety env open design-preview` | [[PENDING M535 preview inspection performer: not yet run; from owner-acts.jsonl]] | [[PENDING M535 preview inspection evidence: not yet run; from owner-acts.jsonl and the relay's record of the mockup paths served, where it records requests]] |
| M535 | the combined approval (design_approval with the logo held, and its spec_change) | `POST …/decisions/:d/answer` with `assets_held` | [[PENDING M535 combined approval performer: not yet run; from owner-acts.jsonl]] | [[PENDING M535 combined approval evidence: not yet run; from owner-acts.jsonl]] |
| M535 | the review confirmation (design_verdicts) | `surety design verdicts <review> confirm` | [[PENDING M535 review confirmation performer: not yet run; from owner-acts.jsonl]] | [[PENDING M535 review confirmation evidence: not yet run; from owner-acts.jsonl]] |
| M519 | [[PENDING M519 acts: not yet run; from every owner act of M519's steps, one row each]] | | | |
| M535 | [[PENDING M535 other acts: not yet run; from every other owner act of M535's steps, one row each]] | | | |

## 20. The pace reads of the real runs

[[PENDING real pace: not yet run; from each run's pace.json: baseline.spec_approved to baseline.design_approved to design.ready, the hold intervals per UI stage, the human wait of design_due and design_approval, the review's subject, time, deltas and evidence by provenance, approval to integration per asset change, slots by source, unbound slots, not_checkable_yet by target; model times, tokens, cost and its status; unknown where a figure has no row; never a throughput claim, compared with V1's where the brief is V1's]]

## 21. The Designers' measured usage and the preview's memory.peak against the trial defaults (E156 Q4)

Each Designer session of both runs: its turns, its billable, cached and output tokens, and its time per session and per turn, against `designer_session_budget_billable_tokens` (3,000,000, a trial value); each preview's `memory.peak` against `preview_memory_max` (256 MiB, a trial value); and any change of a default Sean decided on these observations, recorded in the errata, never made silently. [[PENDING Designer usage and preview peak: not yet run; from the real runs' pace reads (per Designer session and per preview) and the errata entry of Sean's decision, if any]]

## 22. The design trees approved and the review files

[[PENDING design trees: not yet run; from the design trees at each approved revision and the review files copied under M6-real-lane/<date>/; the evidence records' digests (never the bytes of device screenshots unless Sean says so)]]

## 23. G7's trigger: the accepted naming deviation (E156 Q2)

The post-final-phase replan keeps its built trigger `spec_change` (E153 item 1; `registerDeliveryReplans`), an accepted naming deviation from D7 A.2's `post_phase_change`, recorded in COVERAGE, with no rename and no migration; its behaviour pinned by M517 and M529. [[PENDING G7: not yet run; from M517 and M529 on main]]

## 24. The carried defects as handled (BS6 §11.3)

E154 items 5 and 6 as decided by E156 Q1: M542 to M546 for the engine's; M519 (h) and M535 (j) for the real-lane runner's end condition; the shared seed's switch and M335's unit read fixed test-side (SEAM §474); M15 and M311 (h) under E150 item 6's protocol. [[PENDING carried defects: not yet run; from M542 to M546 on main, COVERAGE M6 slice 39, the gate records]]

## 25. Cases reported `not_exercised`

[[PENDING not_exercised: not yet run; from by name: only the real rows if not run (plan §2.5); no case for want of a browser, an emulator or a device]]

## 26. The packages and the rehearsal (M537)

[[PENDING M537: not yet run; from M537 on main; the Designer's and the Verifier packages' elements and the package gaps the rehearsals found]]

## 27. What M6 does not claim

See `M6-not-claimed.md` (D7 §15 classes B and C, D8 entirely, and M5's list, carried), written with the final report. [[PENDING not claimed: not yet run; from written with the report]]

## 28. Limits of the instruments

BS6 §8's limits: the scripted Designer's design is the test's, so a pass proves the engine's handling of a design, never that a model produces an approvable one (D7 §15 class B); a test reads mockups as bytes, never as rendered pages, so "the frame cannot be removed" is pinned by the frame's markup and the iframe's sandbox attribute, not by a browser (BS6 §4.1 rule 21); the review's verdicts on scripted runs are the script's; two real runs are not a claim about a real Designer's behaviour. [[PENDING limits: not yet run; from anything the runs add, and E159 item 7's recorded items (a native mockup served from the frame's origin; the API on TCP 127.0.0.1 with a token where D7 §14 says a unix socket)]]

## 29. Open decisions and provisional readings

[[PENDING open: not yet run; from E156 to the last M6 entry: the driver's rulings under Sean's delegation that stay provisional, and the questions left open for Sean (objections 126 and 145 among them)]]

## 30. Hands-on run (M541)

[[PENDING hands-on: not yet run; from Sean's run of M6-hands-on.sh, if he chooses it, and what surprised him]]

## 31. Questions for Sean

[[PENDING questions: not yet run; from what the runs leave for his decision]]
