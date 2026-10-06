# D3: the decisions waiting for Sean (prepared while Astra reviews)

**Status:** prepared by the driver, 2026-10-06, from D3 draft 1 (`sdlc-design-D3-checks.md`), its brief, and what M2 taught (E79 to E88). **Not decided.** Astra's review (`docs/reviews/D3/sdlc-design-D3-review-brief-astra.md`) may change any of these; each is revisited against her findings before it comes to Sean, one at a time, recommendation first. Each decision, once made, is recorded in the errata as decided.

**What D3 is, in one paragraph.** In M1 and M2 every gate passed on check results that a test wrote down as "passed": no part of the engine has ever run a check. D3 designs the part that does: the **check runner** executes a project's protected checks (the Verifier's tests, under `.surety/checks/`) against a candidate, in a sandbox domain like the agents', and records only what the engine itself observed: the check's own process started, and its exit status. Around it: how checks are declared and discovered, how a change to the checks is classified (tightening, loosening, or "a person decides"), and which checks a gate requires. Out of scope, unchanged: deployment, the UI, other runner kinds.

---

## Part 1. The seven open questions in D3 (§7.2)

| # | In plain terms | Options | Recommendation |
|---|---|---|---|
| Q1 | When the checks change, may an old result still count for a check that did not change? | (a) no: every result is invalidated and the checks run again; (b) yes, where the check's fingerprint is unchanged | **(a)**, as D3 recommends. Checks cost no model, so re-running is cheap; reuse can come with expensive environment checks later. |
| Q2 | When a required check fails on a stage's build, does the work go back to its Builder automatically, as a fix does? | (a) yes; (b) no, it waits | **(a)**. Under (b) a failed stage check has no way forward: a review is only queued once checks pass, so nobody could send it back. |
| Q3 | If a check does not say which protected files it reads, what is assumed? | (a) all of them (so any change to the checks' files goes to you); (b) a check must say | **(a)**. It fails toward you; a project that wants the engine to approve tightenings on its own declares its inputs. |
| Q4 | Before deciding a gate, should the engine re-read the branch and the candidate's ref from git, to catch an out-of-band change made since the last tick? | (a) every gate; (b) only the Alpha authorization; (c) none, accept the window | **(a)**. Two cheap reads per decision; a stage gate completes work just as an authorization issues one. |
| Q5 | How does the engine's change classifier become trusted to approve a tightening on its own (without you)? | (a) an engine setting naming the qualified classifier version, set by the operator after its tests pass; (b) a decision you answer, like the trust activation | **(a)**. The classifier is engine code you merge; a decision would add a step with no new evidence. Until it is set, every tightening still comes to you. |
| Q6 | Must each program a check runs be pinned by its hash? | (a) optional, the hash recorded on every run; (b) mandatory | **(a)**, with pinning recommended for checks that gate a deployment. M2's lesson (Claude Code updated itself overnight) argues for recording always; requiring it for every toolchain would make routine upgrades a protected change. |
| Q7 | At a deployment gate, which modules count when deciding which checks and floors apply? | (a) every module present; (b) only modules the candidate's change touched | **(a)**. Under (b) a sensitive module changed by an earlier candidate escapes the floor of a later one. |

## Part 2. The corrections D3 proposes to D1 and D2 (§7.1)

These change rules already built; each comes with its tests. **Recommendation: approve all five.**

- **L1.** A sandbox domain belongs either to an agent's invocation or to a check execution, never both; check executions get their own lease kind. (What lets checks reuse D2's sandbox.)
- **L2.** A new tick step, after the gates, schedules and supervises check executions. A check is not a run: it does not count against the one-run-per-project rule, and may run while an agent works (it reads a fixed revision and writes nothing).
- **L3.** A scope is complete only when every acceptance criterion of every requirement it delivers is covered by a required acceptance check, and every sensitive area has its floor check. Developer tests cover nothing. (Today only requirements are mapped, not their criteria.)
- **L4.** A check also fails if it left processes running when it ended (it did not finish its work).
- **L5.** You cannot approve a change to the checks while their definitions have errors; only "reject", and the Verifier corrects.

## Part 3. Choices D3 made that you should see (not in its question list)

- **A check's writes go to a scratch layer that is thrown away** (§2.2), instead of a read-only source with declared writable paths, as the brief asked. Toolchains write caches and reports in places nobody declares correctly; discarding gives the same protection: nothing a check writes reaches the candidate, the checkout or another check. The protected inputs stay strictly read-only. **Recommendation: accept.**
- **A Builder can object to a check** (X2): a finding that a check contradicts the requirement or the contract stops automatic repair and comes to you with four choices (have the Verifier correct the check, change the spec, retry, cancel); the check stays in force meanwhile. **Recommendation: accept**; the alternative (park the work at its next failure) is the harm M1 listed as not handled.
- **Only the `direct` runner** (a check in a sandbox on the engine's own host) is designed and qualified; `container` and `remote` stay refused. **Recommendation: accept** for M3.
- **What D3 does not claim** (§6), worth knowing: a check that runs candidate code in its own process can be made to exit 0 by that code; a vacuous new check counts as a tightening; repeated re-runs of a flaky check can turn a failure into a pass (every run is kept and listed). These are limits by design, controlled by the Verifier's construction and the Reviewer's assessment.

## Part 4. Carried from M2

- **F2, M2 report question 15:** a finding resolves when the check it names passes, whether or not that check covers the defect. With D3, checks declare which requirement criteria they cover, so this can be closed cheaply. **Recommendation:** in M3, a `fix` resolves only through a check that is a **required acceptance check of the candidate's scope** (never a developer check, never one outside the scope), and the Verifier's finding names the criterion it breaks; whether the check really tests that defect stays the Reviewer's judgment, as no engine can read a test's meaning. Options: (a) this; (b) leave it to the Reviewer entirely; (c) require the named check to cover the very criterion the finding names (stricter; a finding about a criterion with no check then cannot be resolved until one is added, which is arguably right).
- **M2 report questions 1 to 10:** the driver's defaults stand; none blocks D3.
- **Q14 (the run's observed model):** small; can ride in M3's first slice if you want it.

## Part 5. What M3 would then be (for orientation, not for decision yet)

M3 builds D3 as approved, in slices like M2's: the governed checks and their discovery; the runner on the `direct` class with its self-test at host qualification; the classifier; validation scope at run time; the fix loop on a failed check; F2 as decided. Almost all of it runs on the fake agent and scripted checks at no cost; the real lane returns once at the end, so that a real Verifier's checks are executed by the engine on a real Builder's code. The build spec and acceptance plan follow your decisions.

## After Astra's review

The driver checks each of her findings against this sheet, records which questions she changes, adds any new decision she raises, and brings them to Sean one at a time: the design's open questions first (they shape the build), then the corrections as one approval, then F2.
