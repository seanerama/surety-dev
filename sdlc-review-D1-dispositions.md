# D1 Cross-Review Dispositions (Draft 1 → Draft 2)

**Review:** `sdlc-review-D1-Astra.md` (2026-09-30). Verdict: reject, 16 blocking, 5 non-blocking.
**Dispositions by:** Claude, applied in D1 draft 2; product decisions by Sean recorded where marked.
**Legend:** Accepted = applied as proposed. Accepted, variant = applied with a stated difference. Scoped = the requirement is stated in D1 and the mechanism is assigned to D2 or D3.

## Blocking objections

| # | Disposition | Applied in draft 2 | Notes |
|---|---|---|---|
| B01 Gate scope | Accepted | §2.4, §3.4 AcceptanceScope, §9.1–9.3, A.4, D1-09 | Empty required set never satisfies; effective protected version; result selection by full binding; deadline precedes exit status; T3 inherits T2 sign-off. Materialization of source plus protected assets assigned to D3. |
| B02 Findings | Accepted | §3.4 Finding, §9.3(5), §9.4, D1-24 | Scopes project, lineage, candidate; inheritance across candidates; fix unsatisfied until verified; defer authority and re-evaluation per gate; Alpha exception evidence; severity transitions enforce F §6.3. |
| B03 Deployment | Accepted | §3.5 DeploymentVerification, §9.6, GateKind split, D1-25 | `*_authorize` and `*_complete` per environment; verification bound to one Operation, target set, artifact, mapping, config identity, protected version. |
| B04 Protected proposals | Accepted | §3.3 ProtectedProposal, §4.1 `proposal_captured`, §5.2, §7.3, §7.9, D1-21, D1-22 | Snapshot after quiescence; proposal is a terminal state with no commit; `applyProtectedProposal` is the only writer; policy-root loophole closed. |
| B05 Git integrity | Accepted | §3.5 GitJournal and RefRegistry, §7.2, §7.5, §7.6, §7.10, D1-11, D1-19 | Registry of engine-owned refs; CAS integration; journal reconciliation before integrity; developer branches excluded. |
| B06 Durability | Accepted | §6.1 FULL, §6.5 closure, §14.1, D1-23 | Power-loss test separate from kill test. |
| B07 Retry identity | Accepted | §2.5, §3.5 Operation and OperationAttempt, §4.4, §10.4, D1-14 | Logical operation plus attempts; notifications as journaled outbox intents. |
| B08 Leases and Stop | Accepted | §1.2 claim narrowed, §3.2 ProcessOwnership, §4.5, §8.3, §16.1, D1-08 | Exact generation equality; confirmed termination or quarantine; second-worker correctness explicitly not claimed. |
| B09 Event loop | Accepted, variant | §1.4, §6.1, §8.1 safety prerequisites, §8.5, §11.3, D1-20, §20 Q1 | Store worker is the default placement; the D1-20 latency test is the requirement. Draft 2 asks whether a main-thread placement that passes D1-20 may stay. |
| B10 Triggers and work state | Accepted | §3.2 trigger identity, §4.2, §8.2, A.5, D1-05, D1-31 | Unique trigger constraint; stopped state held until explicit resume; integrated versus complete; preflight refusal path; progress key and no-progress limit; typed conflict routing. |
| B11 Accounting | Accepted | §3.6 InvocationReceipt and UsageObservation, §13, D1-26 | Nullable unknowns; boundary disclosure per adapter; corrections append-only. |
| B12 Decisions | Accepted | §3.4 Decision identity, §9.7 effect plans, §10.1–10.5, §11.4, D1-15, D1-27 | Identity tuple unique across open and consumed; dry-run previews; fresh-read comparison; intents in transaction, effects after; inventory completed. |
| B13 Observation | Accepted | §3.5 ObservationJob, §8.1 step 5, §11.3 served_at vs observed_at, §12.3, D1-28 | Freshness bound; Unknown on expiry; reads never refresh timestamps. |
| B14 Browser boundary | Accepted; isolation scoped to D2 | §7.1 option terminators, §11.1, §17 items 1–5, 12–14, D1-29 | Control-plane isolation requirement stated in §17(12); D2 qualifies the mechanism; autonomy above supervised refused without it. |
| B15 Sessions and resume | Accepted | §3.2 Run state and session_state, §4.1, §15.2, §15.3, D1-30 | Exact provider session id; resume is a new Run. |
| B16 M1 labeling | Accepted | §19.3 | M1 is the preliminary loop; skeleton closes at M3; M1 entity list completed. |

## Non-blocking suggestions

| # | Disposition | Applied in draft 2 |
|---|---|---|
| N01 D1-02 strength | Accepted | §18 D1-02 rewritten per the proposed scenario |
| N02 Schema consistency | Accepted | Appendix A with a parsing consistency test; missing prefixes, event types, error codes added; workspace exception to the engine-home rule stated in §1.6; lineage succession in §3.3 |
| N03 UI contract and mockup fixtures | Accepted | §11.2 joint behavioral suite; §11.3 added routes; §12.3 local panel rule; three mockup fixture corrections applied in `mockup/` (Main NOW for relationship-crm and verity-console, Build NOW band, Gate pv-18 labels) |
| N04 Port provenance | Accepted | §13.2, §19.2 |
| N05 Retention and chunk redaction | Accepted | §14.2, §14.3, §5.5 resolver wording |

## Open questions from draft 1 (§20)

| Q | Decided by | Decision |
|---|---|---|
| 1 Store scope | Claude, per Astra | One store per engine home; export closure in §6.5 |
| 2 Nomination tags | **Sean** | Keep, as immutable registered refs audited by integrity |
| 3 Adoption baseline | **Sean** | Exact current commit, unpushed included; later unrecorded changes are out-of-band |
| 4 Concurrency | **Sean** | One active run per project through M3 |
| 5 Consequences | Claude, per Astra | Effect plans from owning transitions in dry-run; adapters describe only |
| 6 Sessions | Claude, per Astra | Feasible on both backends (`codex exec resume <id>`, `claude --resume <id>` observed); unqualified until D2; no silent fallback |
| 7 Event retention | Claude, per Astra | Append-only; paginated replay; size telemetry |
| 8 Repository | **Sean** | This directory becomes Surety's development repository (O11) |

## Verification notes carried into D2 and D3

- O10 port paths all exist at the resolved `verity/bin/lib/...` locations. `trust.classify` and `substrate-local.localPrDiff` perform git and GitHub acquisition and are not pure; extract rules only. Claude `normalizeUsage` folds cache reads into input; Codex `normalizeUsage` emits zeros for missing usage; neither is ported verbatim (§13.2).
- Codex 0.154.0 exposes `codex exec resume [SESSION_ID]`; Claude 2.1.286 (installed; 2.1.281 not retained) advertises `--resume`, `--session-id`, `--input-format stream-json`. Both are mechanisms, not qualifications. D2 must qualify the resume subcommand's containment and configuration separately from initial exec, and must handle provider session files under E16c.
- The 21 console security invariants are mapped in Astra's §8.4; items 2–8, 10, 11, 13–18, 20, 21 produced the §11.1 and §17 additions. Item 20's persistent operator token is a deliberate change under O8 and depends on D2 isolation.
