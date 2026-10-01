# D1 Resolution Note: method change after the draft-3 review

**Date:** 2026-10-01. **Decision authority:** Sean. **Status:** replaces further prose drafts of D1.
**Inputs:** `sdlc-design-D1-engine-core.md` draft 3 (`35bc38b`), `sdlc-review-D1-draft3-Astra.md` (`4fc5f20`).

## 1. Why the method changes

Three review rounds: 16 blockers, then 12 open, then 12 open. Every draft-3 finding is accepted as correct. The findings have changed in kind: round one found missing mechanisms; round three found a SQL null-uniqueness hole, a git working-tree side effect, and a browser header interaction, each verified by running something. That class is found by execution, not by another prose pass, and each prose rewrite adds new surface. The architecture has been stable across all three rounds; no draft-3 finding challenges it.

Sean's decision: stop iterating D1 as prose. Split what remains by kind.

## 2. Design-level items, resolved here

These amend D1 draft 3. They are the only D1 changes made in prose.

| # | Finding | Resolution |
|---|---|---|
| R1 | B03 authorization cycle, supersession, sign-off hash | A `deployment_authorizations` row is created first with status `proposed`, binding candidate, environment, artifact and mapping, configuration, exact targets, policy, protected version, recovery plan, and a generation. The go-live decision binds that proposed row. A satisfied `*_authorize` evaluation moves it `proposed→issued`; the deploy operation consumes an issued authorization exactly once. Transitions: `proposed→issued`, `proposed→superseded`, `issued→consumed`, `issued→superseded`, `consumed→superseded`. Completion requires the operation's authorization to be the current non-superseded one for its scope. The review-content binding hashes reviewed source, approved baseline, protected definitions, and acceptance obligations, and excludes the gate-specific execution set, so completion-only checks do not change it. |
| R2 | B19 protected fingerprint cannot cover policy fields | Governed fields move out of `.surety/policy.json` into `.surety/checks/protected-policy.json`, inside the protected roots. The fingerprint stays sorted `(path, blob id)` with no field projection. `.surety/policy.json` holds only ungoverned settings and follows the ordinary policy path. A change to the protected file is a protected proposal. |
| R3 | B08 markers and process groups cannot prove absence of writers | Environment markers and process groups are diagnostic discovery aids only. D1 requires an engine-controlled execution boundary whose membership cannot be escaped by changing environment, session, group, or parent, and whose emptiness is observable after engine restart. D2 owns the mechanism (an engine-owned cgroup with `cgroup.kill` and the populated indicator is the leading candidate on this host) and its qualification. Until qualified, a backend and mode is refused for real runs. Domain termination is a reusable engine operation invoked before one-shot snapshot admission, before a session turn becomes idle, and by `endRun`. A quarantine ends only on observed termination, never on operator acknowledgement. |
| R4 | B18 missing decision kinds | Add `finding_applicability_exclusion` (subject and approval bind the exact assessment, finding, and successor candidate) and `check_correction_tightening` (human approval of a tightening correction) to the decision inventory. |
| R5 | B05 integration into a checked-out branch | **v1 rule: the integration branch is engine-owned and must not be checked out in any worktree the engine does not own.** The engine refuses integration, before moving the ref, if the branch is checked out elsewhere, with an instruction to switch branches or browse through a detached worktree or a second clone. A journaled checkout-updating protocol is deferred. (Sean's default; reversible.) |
| R6 | B14 token bootstrap cannot produce its own evidence | The UI requests bootstrap with a per-request same-origin referrer policy so the request carries a same-origin Referer while the page default stays no-referrer. Enumerated static shell and asset routes load without a token after Host and target checks; they carry no token, project data, or authority. Missing evidence fails closed with an actionable error. |
| R7 | B01 phase gate scope | A `phase` evaluation includes every requirement and integration obligation assigned to that phase regardless of delivery status and cannot be satisfied while an assigned obligation is incomplete. Deployment evaluations use delivered requirements plus release obligations. No implementing stage means not started. |

## 3. Contract-level items become acceptance tests

Everything else in the draft-3 review is contract precision: constraints, transition edges, recovery outcomes, manifests. These are not rewritten as prose. Each becomes an acceptance test, written before implementation by the Verifier and judged by exit status.

| Source | Becomes |
|---|---|
| B01 empty implementing set; zero-stage and partial-phase cases | scope tests |
| B05 own-workspace content vs metadata; five probe outcomes per journal kind; confirmed-before-finalizer; frozen finalizer inputs and receipt identity | git journal and recovery tests |
| B10 per-kind transition legality; Stop and Abandon from every owning state; blocked continuation | work-state tests generated from one transition table |
| B11 `UNIQUE(run) WHERE turn IS NULL`, `UNIQUE(turn) WHERE turn IS NOT NULL`; duplicate allocation after restart | store constraint tests |
| B12 per-kind dependency manifests; changed-but-still-eligible; self-consumption vs external change | decision and effect tests, per kind as each kind is enabled |
| B15 session edges, close-saves, restart at each boundary | session tests (M2, with sessions) |
| B17 table: recovery from created; quarantined→terminated; journal ambiguous exits; total attempt-to-operation derivation; check-result invalidation; typed evidence reuse; migration table; config additions; concurrency fixed at 1 through M3; chunk-receipt parent | schema and trace-matrix tests |
| N02, N06 | checker regression fixtures; Build fixture wording |

**Direction of authority reverses.** The schema, the transition tables, and the tests in the repository are the contract. Appendix A is generated from them. Hand-writing the appendix after the body is what produced B17.

## 4. How the first build runs

The manual first build the foundations already describe, started now on the M1 kernel:

- **Verifier (Astra):** writes the M1 acceptance tests first, from D1-01 to D1-38 as scoped to M1 plus the section 3 items, as a trace matrix of normal, refusal, cancellation, quarantine, and recovery paths. Independence rule, F §5.1.
- **Builder (Claude Code):** implements the store, transitions, git journal, scheduler, gate function for `stage` and `alpha_authorize`, decisions subset, API subset, ledger, records, and recovery, against a real SQLite and real git, on the scripted adapter. May not edit the acceptance tests; files objections.
- **Reviewer (Astra or a fresh Codex session):** reviews code against the tests and D1's architecture.
- **Engine and human owner (Sean):** performs git integration and approvals by hand until M3.
- **Out of M1:** sessions, deployment, publication, any real backend (waits for D2a isolation and boundary qualification).

## 5. Stopping rule

D1 is done when no open item is architecture-level and every contract-level item is a test the Verifier owns. New findings are classified the same way: a design decision goes to Sean; a contract defect becomes a failing test.
