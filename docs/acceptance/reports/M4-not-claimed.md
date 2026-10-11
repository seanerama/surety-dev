# What M4 does not claim

**Written by:** the Verifier of M4 slice 30, 2026-10-11, on branch `verify/m4-s30` from `main` at `f83c2b1`. **Status:** the list behind the M4 report's section 18 (row M343; BS4 §13: "what M4 does not claim, in the form of `M1-not-claimed.md`, starting from D4 §11"); it decides nothing. It is written before the acceptance run, the exhaustion lane, the real lane and the hands-on run: an entry whose standing depends on one of those runs says so, and nothing here says a run passed. It is a separate file because `M1-not-claimed.md`, `M2-not-claimed.md` and the M3 report's section 17 are the lists behind their milestones' accepted claims; this one is M4's.

The classes are D4 §11's: **class A**, outside the threat model; **class B**, real behaviour no test has yet established, or that M4 does not build; **class C**, a limitation accepted by design. Each entry names its row, where it is established or why it is not, and the record that put it here. The items the errata and the slice-29 review carried to M343 (E125 to E131, SEAM §§321 to 333) are marked **carried**.

## 1. Carried to M343 by the errata and the slice-29 review

| Entry | Row(s) | Class | Claimed where | Record |
|---|---|---|---|---|
| **A new attempt invalidating earlier verification rows `later_attempt`** (M315 (b)). No M4 path makes an attempt of an operation once one of its attempts is confirmed: a retry follows only `reconciled_absent` or `reconciled_partial`, and a round follows only a confirmed effect (D4 §4.2, §4.4). The rule is unreachable by the engine as designed, so no case can observe it. | M315 (b) (D4-V01) | A (unreachable by design) | nowhere; not written (slice 25) | E128 item 6; E129 item 9; E130 item 8; E131 item 8; COVERAGE "M4 slice 25" |
| **The condition "some running"** (D4 §6.2 rule 5) of M329 (b). With M4's one target (D4 §10 X2; M312's refusal of any other count) an environment cannot have some of its targets running, so the rule cannot be built. | M329 (b) (D4-N02, D4-N05) | A (unreachable with one target) | nowhere; not written (slice 27) | E130 items 4, 8; SEAM §298 reading (2) |
| **A same-uid ptracer.** `ptrace_scope` is recorded as a host fact and never refuses: a process of the operator's own uid outside every domain that may ptrace can read a service's or its init's memory, the secret values a launch reply delivered included, and alter them. | M332, M334; SEAM §312 | C (D2 §8 class C: the operator's own account) | nowhere | E131 items 2, 8 |
| **M341 off the designated host.** The service-limits row runs only on `mini-hp01` (E69); anywhere else its one case fails `not_exercised`, never a skip, and is never counted as passed. The workstation's own memory and task exhaustion of a service is not claimed. | M341 (D4-T05) | B | `--lane exhaust` on mini-hp01, by the driver at Sean's request: not yet run | E69; E121 item 4 (question 2); SEAM §326 |
| **Artifact eviction** (BS4 question 7, decided (a)). An artifact any authorization, operation, round or environment record names is never evicted (E117), so in M4 it is kept for ever; at `artifacts_max_bytes` (2 GiB) the engine refuses `retention_full` rather than evict. No retention rule is designed or built. | M309 | B (not built in M4) | nowhere | E117; E121 items 3, 4 |
| **The slice-29 review's details left unpinned:** whether a qualification case that completed before an orderly stop keeps its result (only that none is `failed` and every one not `passed` is `not_exercised`, SEAM §329); whether the qualification environment is an `environments` row (SEAM §322). | M338 | B | nowhere | SEAM §§322, 329 |

## 2. D4 §11, class A

| Entry | Record |
|---|---|
| As D2 §8 class A, a compromised operator account included. | D4 §11 |
| A post-deploy check the Verifier wrote to pass whatever the service does (D3 §6). | D4 §11 |
| A change to the service manager's state by the operator's own account while the engine is down, beyond what the next read shows. | D4 §11 |

## 3. D4 §11, class B: not yet established when D4 was written

Each names the case that establishes it; until the acceptance run, the last gate that ran it is the M4 report's section 10. None is claimed beyond what its case shows on this host.

| Entry | Established by | Record |
|---|---|---|
| D2's launcher, domain init and constructed root (`pivot_root`) in a service unit; launch authorization over the engine's socket; the init's launch-time report agreeing with the host read; the original application identity retained against pid reuse | `deploy_read_back`, D4-T01 (M310), D4-I05 (M311) | D4 §11 |
| The single-use launch under a manual or manager restart | `out_of_band`, D4-T06 (M322) | D4 §11 |
| A launcher creating child cgroups under `Delegate=yes`; the immutable pathname for the `service` profile; the isolation of the init's control channel | D4-T01 (M310), D4-V02 (M314) | D4 §11; E121 item 4 (question 1: the domain cgroup is the unit's own) |
| The unit surviving the death of an engine incarnation scope; recovery with a real service domain at a restart | D4-O03 (M321 sandbox), D4-T07 to D4-T09 (M324) | D4 §11 |
| The qualification's host time and the headroom of Q6's figures, which are starting caps, not measurements | the first qualification run (D4-A06, M338 (g)) and the sandbox lane | D4 §11; BS4 §11.3; the M4 report section 9 |
| **Behaviour across a restart of the user's service manager or of the host**: not attempted, and not claimed unless separately exercised, beyond that the units are gone and the next observation says `down` or `unknown` | nothing in M4 (BS4 §4.1 rule 2 forbids restarting the manager) | D4 §11, §9.6; BS4 §13 |

## 4. D4 §11, class B: not built in M4

| Entry | Record |
|---|---|
| **Reattachment after an engine restart:** a surviving service's supervision is `unknown` until it is redeployed or torn down; no authenticated recovery of its supervision, original identity or exit state is built. D5's, with Live. | E110; D4 §9.2 |
| **The recovery of a surviving service's old secret versions**, which would let a restarted engine screen that service's output: its output is withheld instead (`redaction_unavailable`). | E116; M334 |
| **The build execution** (Q4): a project that must be compiled or have dependencies installed is not supported; a configuration declaring a build step is refused (`config_invalid`, M312). | D4 §3.1; BS4 §3 |
| **Any adapter but `local_service`**, any remote or container target: network partitions, remote credentials, a target the engine reaches over a network. | D4 §9.1; BS4 §3 |
| **Beta and Live** (Q1): `publish`, `rollback` and export operations, `beta_*` and `live_*` gates (`unsupported`), `releases`. | D4 §10 X3; M336 |
| **Rollback** (Q8): teardown and a new authorized deployment are not a tested production recovery plan. | D4 §11 |
| **Enduring effects of deleted modules on a stateful target** (X2): persistent state, a non-empty egress list and a target count other than one are refused (M312). | D4 §10 X2 |
| Automatic deployment (Q3); a Release Operator agent (no run of role `release_operator`, M336); sessions and the interactive roles (E119); a second backend; the API-key mode of the real lane; the UI. | BS4 §3 |

## 5. D4 §11, class C, and the limitations the build added

| Entry | Row(s) | Record |
|---|---|---|
| **Re-execution:** an application that re-executes the same runtime with identical arguments is not distinguished by the identity read's fields. M311 (f) shows it read `match`, labelled not claimed. | M311 (f) | D4 §3.4, §11 |
| **Identity:** the read establishes what was mounted and started, not that the running code never loads code it wrote or fetched at run time; **the two bracketing reads of a round are not continuous attestation** of execution between them (J7). | M311, M316 | D4 §11 |
| **Check quality** (RV6): every mechanism establishes what ran and the verdict a check returned, never that a post-deploy check tests the right behaviour. A check that only probes health passes the Switchboard mutant: a LIMITATION, never evidence. | M340 (c) | D4 §5.4, §11; E120 item 2 |
| **Secrets:** the deployed service and any check given a secret hold it and can leak it by any channel open to them; the screen detects registered forms only; a same-uid process outside every domain can read the secret files and the HMAC key. After an engine restart a surviving service's output is withheld, not screened. | M332 to M334 | D4 §7.4, §11 |
| **A secret fragment shorter than 4 bytes at an output cut** is not masked: cut output masks the head's trailing and the tail's leading proper fragments of every held form from `CUT_FRAGMENT_MIN` (4 bytes); the cases pin no fragment of 8 bytes or more. | M332 | E131 item 6 (S1); SEAM §320 |
| **Artifacts:** the sealed copy in the engine home can be changed by a same-uid process; a rehash at every deploy detects it then, not before. | M309 | D4 §11 |
| **Availability:** one generation runs at a time, so each deploy has a gap; an engine crash during verification ends that round `unknown`, and the operator redeploys; the observation job samples, so the service can be down between observations without a record of it; `healthy` describes liveness and identity, never correct behaviour. | M321, M329 | D4 §11; E110 |
| **A running Alpha service takes memory, not a domain slot**: at the default limits no role run fits beside a running Alpha service on this workstation, and a teardown frees the room. | M319 | E126 |
| **Freshness:** an observation is a fact at `observed_at` and nothing after `expires_at`. | M328 | D4 §11 |
| **The service link** relays bytes and does not inspect them. **The operator relay**, while open, exposes the application to other local users and to browser-originated requests on the host; it exposes no engine token or control endpoint. | M314, M337 | D4 §5.2, §11 |
| **The environment** runs on the operator's own host: a service that exhausts its envelope takes its own reservation, not the host, but its reservation, one check's capacity included, reduces what role runs can be admitted while it runs. | M319, M341 | D4 §11 |
| **A stop the init cannot see** (its channel already lost, or the application gone before its handler runs) is classified only from what was read; a row's `found` states what was read, never who acted. | M331 | E130 item 3 |
| **A unit of unknown ownership is never cleaned automatically**: it blocks deployment to its environment (and admission where its reservation cannot be accounted) until the operator recovers exactly that resource by hand. | M306, M324 | E129 item 3 (Q5, item A); D4 §9.2 |

## 6. What the real journey and the hands-on run do not show

| Entry | Record |
|---|---|
| **The real journey's fixtures**, labelled: the approved plan with its texts and index (spec approval is not built) and the first `check_correction`'s trigger; its engine runs in the real lane's test mode for them (`--harness-real-lane`, with `--harness-deploy-adapter real`). No check result and no qualification is a fixture's. | SEAM §336 |
| **M140, M2's real journey, is rewritten by J3 and J4 and not rerun** (C.2): its new authorization prerequisites are not claimed as run. | BS4 §9.2; E118 item 1 |
| **The token's absence from unit properties and journals** is searched while the service runs (its properties, its transient unit file where it can be read) and after the teardown (the journals of the units the store's intents name); an unread source is recorded as unread, never as clean, and the report says which were read. | SEAM §336 |
| **A real agent's behaviour cannot be scripted**: a miss by the real Verifier or Builder ends a step "not established", never a verdict on the engine. | E59 item 3; SEAM §336 |
| **The dress rehearsal** (the fake `claude`) is never evidence: it cannot show the subscription mode, the real activation, what a real model does with its package, or how long anything takes. | SEAM §171 |
| **The hands-on run** is Sean's observation, not a test: the script's form and guards are M344's case; what he saw is the report's section 21. | E45; SEAM §337 |

## 7. Carried from earlier milestones, not re-planned

The M3 report's open items stay carried (plan §4.4): E94 item 5 (a) and (b), E106's note on adopted commits, E50, E51, E53 to E55. The M1 to M3 instrument limits stand: storage that honours a sync is assumed (E32 item 1); a clock that steps (E38; for M4's durations, objection 052 and SEAM §333); in the kernel lane host eligibility is the harness's say-so (E61 item 3). Class B of `M1-not-claimed.md` and the lists of `M2-not-claimed.md` and the M3 report's section 17 are unchanged by M4. **Open, intermittent:** M205 (an M3 sandbox file) failed in two of four full runs on slice-23 code and passed in the gate (E125 item 7); M125 (i) failed once under load in slice 26's gate, its E106 weakness fixed in slice 27 (E129 item 10, E130 item 1).
