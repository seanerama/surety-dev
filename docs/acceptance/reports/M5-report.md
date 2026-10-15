# Surety M5 acceptance report

**Status:** skeleton (2026-10-14, by the Verifier of slice 38, on `verify/m5-s38`). Written in full only after the kernel, sandbox and project lanes pass on `main`, the exhaustion lane passes on `mini-hp01` and the two real runs are made (M5 plan §3.8 M445; BS5 §13). Until then every fact a run must supply is a `[[PENDING …]]` placeholder, and **M5 is not accepted**: nothing here describes as passing what has not been run.

**Readers:** Sean, the driver. **Form:** the M4 report's (`M4-report.md`), with `M5-not-claimed.md` beside it in `M4-not-claimed.md`'s form.

## 1. What M5 claims and does not claim

BS5 §1's claim, verbatim, and the conditions of acceptance as they stood at the end. [[PENDING acceptance: not yet run; from the final npm test on main, the exhaust lane, M443, M444]]

## 2. Revisions

[[PENDING revisions: not yet run; from the test, contract and engine revisions of the final runs (main, the real runs, the exhaustion lane)]]

## 3. The host

[[PENDING host: not yet run; from the host, kernel, systemd, Node, git and Claude Code versions, on the workstation and on mini-hp01]]

## 4. The backend and the two trust entries (the real lane only)

[[PENDING entries: not yet run; from m5_attempt_opus, m5_attempt_sonnet, m5_activation: the entries, their models, modes and profiles; the continuation canary's record (D6-S09; M420 (d), M443 (a))]]

## 5. The host qualification and the runner self-test

[[PENDING host qualification: not yet run; from the active host qualification of each run]]

## 6. D6 draft 3's approval and Astra's review

D6 draft 3 approved to build in E142; Astra's cross-review (`docs/reviews/D6/sdlc-review-D6-Astra.md`) applied as B01 to B14 and N01 to N04 (E141 item 1; `docs/design/sdlc-design-D6-astra-dispositions.md`). [[PENDING approval record: not yet run; from E142 as it stands at acceptance]]

## 7. The configuration in force, E140's numerics and the twelve readings

BS5 §11.1's table as it stood, E140 N1 to N4, the readings of D6 §12.2 as draft 3 states them (reading 10 reversed). [[PENDING configuration: not yet run; from contract/config.json at the final revision]]

## 8. Every Appendix C statement, its row and its result

Every one of D6 Appendix C's 67 statements, its principal row (plan §4.1) and its result on the final runs.

| Statement | Row | Result |
|---|---|---|
| D6-S01 session-is-a-run | M415 | [[PENDING D6-S01: not yet run; from M415 on main]] |
| D6-S02 turn-is-an-invocation | M415 | [[PENDING D6-S02: not yet run; from M415 on main]] |
| D6-S03 transcript-durable | M416 | [[PENDING D6-S03: not yet run; from M416 on main]] |
| D6-S04 save-validates | M417 | [[PENDING D6-S04: not yet run; from M417 on main]] |
| D6-S05 close-raises | M403 | [[PENDING D6-S05: not yet run; from M403 on main]] |
| D6-S06 idle-timeout | M418 | [[PENDING D6-S06: not yet run; from M418 on main]] |
| D6-S07 resume-from-records | M418 | [[PENDING D6-S07: not yet run; from M418 on main]] |
| D6-S08 session-exclusive | M419 | [[PENDING D6-S08: not yet run; from M419 on main]] |
| D6-S09 continuation-canary | M420 | [[PENDING D6-S09: not yet run; from M420 on main]] |
| D6-S10 turn-settlement | M447 | [[PENDING D6-S10: not yet run; from M447 on main]] |
| D6-V01 idea-record | M402 | [[PENDING D6-V01: not yet run; from M402 on main]] |
| D6-W01 spec-parse-at-save | M421 | [[PENDING D6-W01: not yet run; from M421 on main]] |
| D6-W02 spec-approval-floor | M422 | [[PENDING D6-W02: not yet run; from M422 on main]] |
| D6-W03 spec-writer-prohibitions | M423 | [[PENDING D6-W03: not yet run; from M423 on main]] |
| D6-A01 architect-products | M404 | [[PENDING D6-A01: not yet run; from M404 on main]] |
| D6-A02 approval-batched | M403 | [[PENDING D6-A02: not yet run; from M403 on main]] |
| D6-A03 architect-prohibitions | M423 | [[PENDING D6-A03: not yet run; from M423 on main]] |
| D6-A04 replan-one-shot | M424 | [[PENDING D6-A04: not yet run; from M424 on main]] |
| D6-A05 replan-refused-repairs | M424 | [[PENDING D6-A05: not yet run; from M424 on main]] |
| D6-A06 prospective-bundle | M448 | [[PENDING D6-A06: not yet run; from M448 on main]] |
| D6-P01 plan-references | M425 | [[PENDING D6-P01: not yet run; from M425 on main]] |
| D6-P02 plan-approvals | M425 | [[PENDING D6-P02: not yet run; from M425 on main]] |
| D6-P03 plan-dependencies | M426 | [[PENDING D6-P03: not yet run; from M426 on main]] |
| D6-P04 plan-validation | M426 | [[PENDING D6-P04: not yet run; from M426 on main]] |
| D6-P05 plan-routing | M427 | [[PENDING D6-P05: not yet run; from M427 on main]] |
| D6-P06 plan-registered-atomically | M405 | [[PENDING D6-P06: not yet run; from M405 on main]] |
| D6-P07 plan-open-question | M449 | [[PENDING D6-P07: not yet run; from M449 on main]] |
| D6-C01 change-request-work | M431 | [[PENDING D6-C01: not yet run; from M431 on main]] |
| D6-C02 proposed-diff-side-ref | M431 | [[PENDING D6-C02: not yet run; from M431 on main]] |
| D6-C03 impact-exact | M432 | [[PENDING D6-C03: not yet run; from M432 on main]] |
| D6-C04 change-approval | M433 | [[PENDING D6-C04: not yet run; from M433 on main]] |
| D6-C05 change-invalidates | M433 | [[PENDING D6-C05: not yet run; from M433 on main]] |
| D6-C06 unassigned-requirement | M434 | [[PENDING D6-C06: not yet run; from M434 on main]] |
| D6-W04 check-authoring | M435 | [[PENDING D6-W04: not yet run; from M435 on main]] |
| D6-W05 spec-semantic-representation | M449 | [[PENDING D6-W05: not yet run; from M449 on main]] |
| D6-W06 deferred-authoring-and-exception | M450 | [[PENDING D6-W06: not yet run; from M450 on main]] |
| D6-X01 autonomy-step | M436 | [[PENDING D6-X01: not yet run; from M436 on main]] |
| D6-X02 autonomy-stage | M436 | [[PENDING D6-X02: not yet run; from M436 on main]] |
| D6-X03 autonomy-phase | M436 | [[PENDING D6-X03: not yet run; from M436 on main]] |
| D6-X04 stage-order | M437 | [[PENDING D6-X04: not yet run; from M437 on main]] |
| D6-X05 pipelining | M437 | [[PENDING D6-X05: not yet run; from M437 on main]] |
| D6-X06 concurrency-envelope | M438 | [[PENDING D6-X06: not yet run; from M438 on main]] |
| D6-X07 event-driven-tick | M440 | [[PENDING D6-X07: not yet run; from M440 on main]] |
| D6-X08 memory-peak-recorded | M439 | [[PENDING D6-X08: not yet run; from M439 on main]] |
| D6-X09 profile-qualification-identity | M451 | [[PENDING D6-X09: not yet run; from M451 on main]] |
| D6-F01 phase-gate | M428 | [[PENDING D6-F01: not yet run; from M428 on main]] |
| D6-F02 phase-verification-work | M429 | [[PENDING D6-F02: not yet run; from M429 on main]] |
| D6-F03 phase-complete-effects | M406 | [[PENDING D6-F03: not yet run; from M406 on main]] |
| D6-F04 early-replan | M430 | [[PENDING D6-F04: not yet run; from M430 on main]] |
| D6-D01 alpha-policy | M407 | [[PENDING D6-D01: not yet run; from M407 on main]] |
| D6-D02 alpha-whole-set | M407 | [[PENDING D6-D02: not yet run; from M407 on main]] |
| D6-M01 pace-read | M441 | [[PENDING D6-M01: not yet run; from M441 on main]] |
| D6-M02 pace-human-wait | M441 | [[PENDING D6-M02: not yet run; from M441 on main]] |
| D6-R01 adopt-records | M409 | [[PENDING D6-R01: not yet run; from M409 on main]] |
| D6-R02 index-origin | M410 | [[PENDING D6-R02: not yet run; from M410 on main]] |
| D6-R03 requirement-confirm | M411 | [[PENDING D6-R03: not yet run; from M411 on main]] |
| D6-R04 retrofit-session-paths | M412 | [[PENDING D6-R04: not yet run; from M412 on main]] |
| D6-R05 conformance-stage | M413 | [[PENDING D6-R05: not yet run; from M413 on main]] |
| D6-R06 conformance-fix-blocks | M413 | [[PENDING D6-R06: not yet run; from M413 on main]] |
| D6-R07 existing-tests-not-evidence | M414 | [[PENDING D6-R07: not yet run; from M414 on main]] |
| D6-R08 scoped-descriptive | M414 | [[PENDING D6-R08: not yet run; from M414 on main]] |
| D6-R09 retrofit-mode-rules | M452 | [[PENDING D6-R09: not yet run; from M452 on main]] |
| D6-R10 conformance-alpha-barrier | M453 | [[PENDING D6-R10: not yet run; from M453 on main]] |
| D6-J01 journey | M401 | [[PENDING D6-J01: not yet run; from M401 on main]] |
| D6-J02 journey-real | M443 | [[PENDING D6-J02: not yet run; from M443 on main]] |
| D6-J03 retrofit-journey | M408 | [[PENDING D6-J03: not yet run; from M408 on main]] |
| D6-J04 retrofit-journey-real | M444 | [[PENDING D6-J04: not yet run; from M444 on main]] |

## 9. The C.2 migrations

[[PENDING C.2: not yet run; from COVERAGE, slices 31 to 37: each accepted row changed by K1 to K11, recorded as its correction's change]]

## 10. The kernel, sandbox and project lanes

[[PENDING lanes: not yet run; from the final npm test on main: unit and acceptance counts, units and homes left]]

## 11. The project-lane journeys and their pace reads

[[PENDING project pace: not yet run; from M401 (project lane) and M436's project-lane journey: their pace reads]]

## 12. The exhaustion lane

[[PENDING exhaust: not yet run; from M438 (h) on mini-hp01 with E69's caps, and M2's to M4's exhaust files]]

## 13. The rehearsals

[[PENDING rehearsals: not yet run; from M443's and M444's dress rehearsals (SURETY_REAL_REHEARSAL=1) on the revision of each paid run; never evidence]]

## 14. The real journey from an idea to Alpha (M443)

[[PENDING M443: not yet run; from state.json, observed/ and pace-M443.json under docs/acceptance/reports/M5-real-lane/<date>/; each case (a) to (g)]]

## 15. The real retrofit journey (M444)

[[PENDING M444: not yet run; from state.json, observed/ and pace-M444.json; each case (a) to (h); the claims table and the confirmations as Sean made them; the run's scale stated as small]]

## 16. The human acts as they were made, and the token

[[PENDING human acts: not yet run; from each act of BS5 §12 with its actor; any act the driver made on Sean's instruction, with his words (acted_by: driver, on_instruction); the token's search, counts only]]

## 17. The pace reads of the real runs

[[PENDING real pace: not yet run; from pace-M443.json, pace-M444.json: model times, tokens, cost and its status, memory.peak per domain, unknown where a figure has no row; never a throughput claim (N01)]] [[PENDING unknown usage: not yet run; from the ledger rows of each session turn: any turn whose usage Claude Code did not report, which reserves the run's whole allowance and closes the session (D1 §13.3, kept by Sean's decision of 2026-10-14), stated plainly; the caps in force, Sean's choice of 2026-10-14 (2 000 000 billable tokens per run; 30 and 20 USD a day)]]

## 18. The memory.peak figures

[[PENDING peaks: not yet run; from memory.peak per domain as recorded (M439), against role_memory_max and check_memory_max (E140 N1), for revisiting the defaults on measurements]]

## 19. Cases reported `not_exercised`

[[PENDING not_exercised: not yet run; from by name: only M438's exhaust file off mini-hp01 and the real rows if not run (plan §2.5)]]

## 20. The packages and the rehearsal (M442)

[[PENDING M442: not yet run; from M442 (a) to (c) on main; the packages' elements (SEAM §454) and the package gaps the rehearsal found]]

## 21. What M5 does not claim

See `M5-not-claimed.md` (D6 §11 class B and C, and M4's list, carried). [[PENDING not claimed: not yet run; from written with the report]]

## 22. Limits of the instruments

BS5 §8's limits: the scripted backend's products are the test's, so a pass on the kernel, sandbox and project lanes proves the engine's handling of a product, never that a model produces one; a scripted session proves the mechanism, not a conversation; the pace read on scripted roles measures the engine; one real run per journey is not a claim about a real agent's behaviour. [[PENDING limits: not yet run; from anything the runs add]]

## 23. Open decisions and provisional readings

[[PENDING open: not yet run; from E142 to the last M5 entry: what stays provisional]]

## 24. Hands-on run (M446)

[[PENDING hands-on: not yet run; from Sean's run of M5-hands-on.sh, if he chooses it, and what surprised him]]

## 25. Questions for Sean

[[PENDING questions: not yet run; from what the runs leave for his decision]]
