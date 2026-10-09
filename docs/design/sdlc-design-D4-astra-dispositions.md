# D4: Astra's cross-review, the decisions for Sean

**Status:** prepared by the driver, 2026-10-09, after M3's acceptance (E109). **Not decided.** Source: `docs/reviews/D4/sdlc-review-D4-Astra.md` (her verdict: **approve with the amendments B01 to B08 applied**). Each item below is one decision, recommendation first, cost said plainly. Each answer becomes an errata entry marked decided by Sean; then one architect agent writes D4 draft 2 applying exactly these dispositions (E20: no draft 3), and D4's status becomes "decided".

**Already decided, not reopened:** Q1 to Q10 and approval of D4's recommendations (E95). Astra recommends (a) on every Q, as you chose, with three qualifiers that need no new decision: Q6's numbers are starting caps, not measured headroom; Q7's relay and Q10's paid run still need your command when they happen; Q4 means compiled or dependency-installing projects stay unsupported until a build step exists (goes on the not-claimed list).

**How to read the items.** Every amendment adds contract text to D4 and acceptance cases to M4; none adds a backend, remote host, cloud cost or dependency. The two with a real scope choice are B01 and B07, and they share one question: **what a restarted engine may do with an Alpha service that survived it.**

---

## B01. Supervising a service that outlives the engine

**The problem.** D4 lets the service keep running when the engine crashes (that is what makes the target real), but says only "a socket the engine reconnects to". It does not say how a new engine proves it is talking to the same sandbox and the same application, what happens when the application exits by itself or fails to start, or whether the service manager may restart it. The engine's sandbox init today serves one run and exits with it; a long-lived, reconnectable supervisor is new work.

**Astra's fix, in parts:**
1. A launch is single-use: automatic restart off, so nothing reruns the application under a spent grant. The init remembers the one original application and its exit; natural exit and failed start are legal endings; an uncertain ending stays quarantined.
2. A restarted engine reattaches through an authenticated control channel (fresh challenge, bound to the new incarnation) and recovers the original application's identity and exit state.
3. Before admitting new work, a restarted engine accounts for every surviving service's resource reservation; anything it cannot account for blocks deployment, never adopted or killed automatically.

**Options.**
- **(a) Parts 1 and 3 now; part 2 not in M4 (recommended).** After an engine restart a surviving service keeps running and is still read through the service manager and `/proc`, but its supervision is `unknown`: no verification can pass on it, and its logs and relay stay closed (B07), until you redeploy or tear it down. Astra's own text already allows exactly this outcome ("if these facts cannot be established, supervision is unknown and no verification may pass"); M4 simply never establishes it. Authenticated reattachment goes to D5 with Live, and "reattachment after an engine restart" goes on M4's not-claimed list.
- **(b) All three parts in M4**, as Astra wrote it.

**Recommendation: (a).** Alpha is disposable, and redeploying after a crash is one command. Reattachment is the largest single piece of new engine work in the review, and it matters for Live, not Alpha. **Cost of (a):** an engine crash during verification ends that round `unknown`, and you redeploy. **Cost of (b):** roughly one extra slice (a new control protocol, its stale-connection and restart tests), and B07's harder variant.

## B02. Reconciling the whole effect, with one answer per state

**The problem.** D4's reconcile table can give two answers for one state (an unexpected running generation plus an unchanged prior counts as both `absent` and `conflicting`), calls a teardown done when no unit exists even if sockets, cgroups or runtime directories remain, and reads only the names it expects, so it cannot see a unit it did not record. Closing a launch grant also does not settle a service-manager job still in flight.

**Astra's fix.** Reconcile first takes a complete, bounded inventory of everything under the environment's own name prefix (read-only; discovery grants no authority to stop anything); `unknown` and `conflicting` take precedence; `absent` requires nothing left that could still act later; teardown is done only when every resource it covers is gone; nothing new is started until the prior effect's host calls and manager jobs are quiescent.

**Recommendation: accept as written.** It is the same discipline the git journal already follows (`othersChildrenGone()` before probing). **Cost:** contract text and about six acceptance cases; no new mechanism.

## B03. A retry needs its own frozen intent

**The problem.** D4 freezes the unit names on the operation before its first attempt, but each attempt gets a new generation, and the names include it, so a permitted second attempt would use names the operation never froze; a partial first attempt may also leave a unit that needs cleanup. The frozen-inputs trigger rightly forbids rewriting the operation to fit.

**Astra's fix.** The operation freezes what was authorized (candidate, artifact, configuration, targets); each attempt freezes its own intent (its generation, its unit names, what it may replace or clean up) before its first host call. A partial retry's preview names the remaining effects and goes stale if they change. The finalizer creates one durable verification round, and replaying it creates no second one.

**Recommendation: accept as written.** **Cost:** one more table or column set; no change to the existing frozen-operation trigger.

## B04. Recheck the gate's eligibility just before acting

**The problem.** Between the authorization and the deploy, a protected tightening can invalidate results, a required rerun can become pending, or a new blocking finding can appear. D4's pre-effect check confirms only that the authorization is still this operation's; the engine as built does not withdraw a deployment authorization when a protected change lands.

**Astra's fix.** Immediately before each effect, re-evaluate the issuing gate's eligibility for the exact candidate and binding (protected version, policy, deciding results, sign-offs, findings, evidence); if anything changed, refuse with `EFFECT_PRECONDITION_CHANGED`, no adapter call.

**Recommendation: accept as written.** It is the same "gate rereads at the point of use" rule M3 built for checks (slice 16). **Cost:** small; five refusal cases plus a positive control.

## B05. Ordering verification rounds of the same attempt

**The problem.** Generations stop a newer deployment's result being overwritten by an older one, but not two verification rounds of the same attempt: an older round finishing late could overwrite a newer one, and an old `verified` row could still decide while a new round is being set up.

**Astra's fix.** Each verification request records a durable, ordered round before its first read; the newest registered round decides regardless of completion order; while it is pending, interrupted or quarantined, no earlier pass satisfies completion. A change to the required checks or the protected version supersedes the round.

**Recommendation: accept as written.** It is M3's rule for checks (a newer pending run blocks an older pass, row M206) applied to verification. **Cost:** contract text and about six cases.

## B06. Every wait has a deadline, and the lease always gets released

**The problem.** The environment lease is held through verification, but some paths never reach verification (refused before launch, superseded candidate, quarantined check), so the lease could be held forever. Separately, a running service could use up the resource envelope so that the check needed to verify it cannot be admitted: two correct rules producing a deadlock.

**Astra's fix.** Deployment orchestration gets a durable deadline that survives restarts and is not renewed by ticks; reaching it records verification `unknown` with what is missing, never a fake result. Each failure path says how the lease is released (only after effects are quiescent). Preempting teardown is allowed during verification too. Admitting a service reserves room for at least one post-deploy check, or refuses before stopping the previous service.

**Recommendation: accept as written.** **Cost:** one numeric default (the orchestration deadline), which is yours; I would propose it in the build spec (for example 15 minutes) for your approval with the other limits. The capacity reservation means one fewer role run fits beside a running Alpha service than E95's Q6 note said.

## B07. Old secrets after a rotation and a restart

**The problem.** After you rotate a deployment secret and the engine restarts, the engine holds only the new value, while the surviving service still holds the old one and can print it. The engine's redactor would no longer recognize the old value, so a log read or check output could store it in clear.

**Options** (they follow B01):
- **(a) With B01 (a), recommended:** a restarted engine never publishes a surviving service's output. Its logs, its relay and checks against it are refused with an explicit "redaction unavailable" condition until the service is replaced or torn down. Raw service output never goes to the service manager's journal or standard streams. The environment read shows "rotation pending replacement".
- **(b) With B01 (b):** the init keeps each live service's secret versions in protected memory and hands them back over the authenticated channel so the engine can screen old output; if that fails, (a)'s refusal applies.

**Recommendation: (a).** It is Astra's own fallback rule made the only rule in M4, and it holds the existing guarantee (no raw secret the engine delivered is ever stored) without new secret-recovery machinery. **Cost:** after an engine restart you redeploy before reading that service's logs.

## B08. The artifact's identity: file modes and size limits

**The problem.** The artifact's digest includes file modes, but files are made read-only after the digest is taken, so a 0644 file sealed as 0444 cannot be compared literally; dropping mode from the comparison would make the identity check pass falsely. The artifact also has no declared limits on file count, size or total retained disk.

**Astra's fix.** The digest uses a canonical mode class (100644 or 100755, as git does); sealing removes write permission but keeps the executable class; the target read rebuilds the same class. Declared limits on entries, bytes per artifact, total retained bytes and elapsed work; exceeding one refuses before deployment and cleans only unreferenced partial staging.

**Recommendation: accept as written.** **Cost:** four numeric defaults, yours, proposed in the build spec with the others (they work like M3's check-tree limits).

---

## The rest of the review (one decision, if you want it batched)

- **J1 to J9:** Astra accepts J5 as written and the other eight "with variant"; every variant is one of B01 to B08 above or a note on which accepted tests must change (M08's "deployment unsupported" boundary moves; M01, M44 and M140's fixtures need the new authorization prerequisites, done by a Verifier and recorded in COVERAGE). **Recommendation:** accept her variants, following your B01 and B07 choices.
- **N01 to N04** (non-blocking): explicit precedence for the observed condition and acknowledged drift; GET routes stay pure reads (no adapter call on a read); keep feasibility evidence, adapter qualification and milestone tests apart; align D4's schema appendix and not-claimed list with the body. **Recommendation:** accept all four into draft 2, editorially.

## After your answers

1. One errata entry per answer (or one for a batch you choose).
2. D4 draft 2 by one architect agent, applying exactly these dispositions; I check it against them. No draft 3.
3. D4's status marked decided; then the M4 build spec and acceptance plan (rows from M301, slices from 23), opening with D4 §9.6's probe confirmation, for your approval.
