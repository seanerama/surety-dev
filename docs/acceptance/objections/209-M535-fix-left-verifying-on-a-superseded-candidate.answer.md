# 209, answered: why the superseded fix stays `verifying`, why the harness counted it runnable, and the correction

Answer to `209-M535-fix-left-verifying-on-a-superseded-candidate.md`, by the Verifier on `verify/f33-fix-verifying` (cut from `main` at `3b643c87`), 2026-10-23, under Sean's authorization of the same day (errata E179 item 8).

Nothing here changes `packages/engine/src/`, the run store, any acceptance row or any rule. The engine corrections are for the Builder once Sean has decided the questions marked **Design decision for Sean**. The harness correction (question 3) is the Verifier's and is made on this branch, after its failing case.

**Decided.** Sean decided D-1 to D-5 on 2026-10-23 (errata E180, on `main` at `bf1ca304`). His rulings are quoted in section 8 and govern wherever sections 1 to 7 recommend otherwise. The cases narrowed and added under them are in section 9, and the Builder's brief is section 10.

## 0. What the store shows

Read from a copy of `/tmp/f33-evidence/store-s7-1020.db`. The sha256 `5a727329…6507` was the same before and after every read here.

- **The finding** `fnd_01M5G804A7604DTRPZF3S16YG9` has `scope` `candidate`, `candidate` null and `subject_id` the project. Its `source_run` is `run_01M5G7WB4WGMK8D42JS3YJR2V3`, a Verifier run on `wi_01M5G7WABASY9EVX48M5ZPKPGC`, kind `check_correction`, subject `{"request": "scr_…"}`, trigger `spec_obligation`. The finding names check `design-tokens-parity` and criterion R13.3. It was dispositioned `fix` by the human at `disposition_seq` 204, and its `reevaluations` are `[]`.
- **The owner's question** `dec_01M5G804KZSHP9W41E7P4F1TSA` (`finding_disposition`, scope `disposition_owed`) told him under `fix`: "It holds the gates until its check design-tokens-parity passes after the fix, which resolves it." Neither half came true.
- **Every evaluation, and none read it.** The store holds 197 gate evaluations for the project. 154 came after the disposition, and 14 of those were satisfied: 5 stage, 1 phase, 4 `alpha_authorize` and 4 `alpha_complete`. No evaluation lists the finding in `inputs_snapshot.findings`.
- **The check passed after the disposition.** `design-tokens-parity` passed on `cand_01M5GPNABB8YX6DVFCS55EKCKC` at execution seqs 292 and 319, and on `cand_01M5HS2MW5VA1JJ0367JDG5TRQ` at 347. All three are above the watermark of 204.
- **The fix was carried, by ancestry.** `cand_01M5GAK819E9DM8JBTNKWDEEJW` (seq 8) holds the fix. Its successor's lineage `lin_01M5GAK819E9DM8JBTNKWDEEJX` has `started_from_candidate` = seq 8. So every later candidate, seq 9 to 13, holds the fix by ancestry: `heldByAncestry` (E43).
  - The objection's observation 4 says the fix was "neither carried to the new candidate…". That is true only of the successor's own `held_work`. It is not true of the engine's holding, which is by ancestry.
- **Why no gate was due on the fix's own candidate.** When seq 8 was nominated, the stage item `wi_01M5DZNBPHZM6NKYW5HVWKTPKT` was `parked` (`repair_attempts_max`). It was resumed at 2026-10-22T01:09:59Z, and its later candidates' stage gates were due and evaluated. The last satisfied one was seq 12's, at 02:33:01Z.
- **Nothing pending at the review.** There is no run of the fix, no pending execution, no open verification, review or phase verification, and the phase plan is `completed`.
- **The runner's failure did not name the fix.** The review step failed with "not reached within 60 minutes (open decisions: [the two E179 questions])" (`/tmp/f33-evidence/runner-M535.log`, line 1602 ff.).
- **Four findings have the same unbindable shape.** The store holds four findings with `scope` `candidate` and `candidate` null: this one, two Verifier findings the owner accepted, and one open Builder objection (`fnd_01M5G55DQK67…`). The objection is outside this answer; objections take D3 §5 X2's route.

## 1. Whose rule is broken?

**The engine's.**

`recordReport` (`store/transitions/findings.ts`) records a role's finding with the scope it reports, `candidate` by default. It takes the candidate from the run's work subject, which for a `check_correction` run (and for any run whose work names no candidate) is null. `findingApplies` (`store/transitions/gates.ts`) then returns false for every candidate, because the finding is not `project` and has no candidate. So:

- **No evaluation ever reads it.** It is never a subject of `FINDING_UNSATISFIED`. A Medium defect the owner chose to fix held none of the 14 gates that passed after his disposition.
- **It can never be resolved.** D3 §2.11 resolves a `fix` "by an evaluation of a candidate it applies to".
- **The fix can never complete.** E34 item 7, E36 item 4 and E38 item 6 complete a fix only in the evaluation that resolves its finding.

**What decides it.** D1 §9.3 input (5), and SEAM §74 "Which findings a gate asks about", define applicability:

> `project` scope → always; `lineage` or `candidate` scope → the originating candidate and every successor reached through `started_from_candidate`

A `candidate`-scoped finding with no originating candidate is outside that definition. D1 §3.4 and the table schema allow `candidate` null for `project` findings and engine-origin findings (D1 §14.2's `security` finding is "scoped to the project"). No source provides for a role's `candidate` finding without a candidate. The engine wrote a row the design's applicability rule cannot place. This is reproduced through the API in M235 "(a) F26" below.

**The citation.** The text the objection quotes as "E36 item 6" ("a fix that names no finding, or whose finding names no check, can never complete") is **E38 item 6**. That rule concerns a fix whose finding names no check. This finding names both a check and a criterion, and the check is a required acceptance check covering the criterion: D3 §2.11 conditions 1 and 2 hold, and condition 3 held at seqs 292, 319 and 347. It cannot complete only because the engine recorded it outside applicability.

So this is a defect of the engine, not a gap in E38 item 6 or in D3 §2.11. There is a narrower gap in the rules: no source says what a `fix` disposition does on a finding that no evaluation can read. D3 §2.11 routes a missing check, not missing applicability. That gap closes once every finding applies to some candidate.

**What should read it: Design decision for Sean (D-1).** No source says what a finding raised by a run whose work names no candidate applies to. The options are:

- **(A) Record it at `project` scope.** It then applies to every candidate (D1 §9.3 (5)). The first evaluation of any candidate in which its named check is required (E100 S2: in one of the candidate's scopes), passing after the disposition, resolves it and completes the fix (gates.ts as built). Until then it is `FINDING_UNSATISFIED` at every gate, which is what the owner was told.
- **(B) Bind it at raise time to the project's latest unsuperseded candidate.** It then applies to that candidate and its successors. In practice this behaves like (A), because earlier candidates are superseded and refused (Q9), but it needs a choice of candidate that no source makes.
- **(C) Refuse `fix` on it** (H1's form, E171 item 5 as ruled in E172 item 1; SEAM §552) and keep the owed question. Alone, (C) is not enough: the finding would still be read by no gate, a Medium defect that holds nothing, which is the finding itself dropped.

**Recommendation: (A).** It needs no new rule, only D1 §9.3 (5)'s existing `project` case. It makes the owner's question true as it stands, and it removes the shape the store shows four times. Under (A) the observed run would have resolved the finding at seq 12's satisfied stage gate (02:33:01Z): seq 12 descends from seq 8 and passed `design-tokens-parity` at seq 292 > 204. The fix would have completed then.

## 2. What happens to a plain `fix` held by a superseded candidate?

**What the design requires: carried to the successor by ancestry and judged there.**

- E43: work is held by ancestry. A successor's stage gate completes work its predecessors hold.
- D1 §9.3 (5): a finding applies to "every successor reached through `started_from_candidate`".
- D3 §2.11: it is resolved "by an evaluation of a candidate it applies to", not necessarily the fix's own.
- D3 Q9 (E91 item 2): the superseded candidate itself is never evaluated, and its results resolve nothing and trigger no repair.

The engine already does the carrying (`heldByAncestry`), and the resolution rule completes a verifying fix in any evaluation that resolves its finding. **This was observed, not assumed.** With the stage still `verifying`, two plain fixes, and fix 1's candidate superseded by fix 2's, the stage gate the engine evaluated by itself on the successor read both findings and resolved both, and both fixes completed. That is the control run of the exploration for case (b). Supersession by itself loses nothing.

**What the design rules out:**

- **Returning the fix to `eligible`.** D3 §2.10 sends a fix back only when its named check failed at its current candidate. Nothing failed here, and sending it back dispatches a paid Builder run with nothing to fix.
- **Completing it as superseded.** E36 item 4 and E38 item 6 complete a fix only with its finding's resolution. The superseded completion in `finalize.ts` is D6 §5.7's, for a stage's late integration under an early replacement (`plan/replace.ts` `supersededWhileRunning`), not a candidate's supersession. A fix completed with its finding unresolved and nothing asked is exactly what Sean called dropping work.

**What fails, and is not decided.** No gate is ever due to judge a plain fix unless a `stage_build` it rides with is still `verifying`. `dueStageGates` (gates.ts) makes a gate due only for a verifying `stage_build` held by a candidate, or for an `asset_updated` fix (D7 §6.5). A plain fix whose stage was verified before the finding (or parked, as stage 3 was when seq 8 was nominated) gets no evaluation on its own candidate or on any successor, and stays `verifying`. Nothing runs, nothing is asked. This is reproduced in M235 "(a) F33".

- E43 presumes the stage is still verifying ("after a fix it is that candidate's evaluation that completes the stage").
- SEAM §74 leaves the other case open ("which candidate completes a stage whose first candidate's gate was satisfied before a later fix is not pinned").
- D7 §6.5 decided it for `asset_updated` fixes only.

**Design decision for Sean (D-2): which evaluation the engine makes for a plain verifying fix.**

Recommendation: D7 §6.5's form, extended. For a verifying `fix` held by an unsuperseded candidate (itself or by ancestry) whose verification is complete, the engine makes due the `stage` gates, on that candidate, of each stage it holds whose required set includes the finding's named check. It does so when there is no evaluation of that candidate and stage yet, or the latest is stale. That evaluation reads the finding, and the existing resolution rule resolves it and completes the fix. A stage's work already `complete` is unaffected: `completeStageWork` acts on verifying `stage_build` items only.

**Design decision for Sean (D-3): what happens when nothing can judge it.** This covers two cases: no stage scope of any unsuperseded candidate holding the fix requires its named check (a phase-only check, or a check the version removed), or no unsuperseded candidate holds it at all.

Recommendation: rule 25's form at the engine, as D3 §2.10's park does. Raise one `blocker` decision on the fix. Its subject is the work item, and it names the fix, its finding, the named check and the candidates. The options are:

- `retry`: judge again on the current candidate.
- `cancel`: cancel the fix. The finding returns to its owed `finding_disposition` question, never resolved.

Suggested question text:

> Fix `<wi>` for finding `<fnd>` (check `<key>`, criterion `<c>`) is verifying, and no gate the engine evaluates on `<candidates>` requires its check, so nothing can resolve it. Retry to judge it again on the current candidate, or cancel it and decide the finding again.

The `blocker` kind exists (D1). Its reason value (`fix_unjudged`, say) and its options are new and are Sean's.

**Design decision for Sean (D-4): the fix's repair after supersession.** E100 item 1 decided that "a `fix` keeps E43's fix candidate" as its current candidate (D3 §2.10), and `repair.ts` `currentCandidate` does so. Once that candidate is superseded, D3 §2.10's loop is dead for the fix ("a result of a superseded candidate triggers nothing"). If the named check fails on the successor, the fix is never sent back. The stage's own Builder is sent back instead, if the check is in a verifying stage's scope; if not, nothing happens.

Recommendation: S1's rule for fixes too. The current candidate becomes the latest unsuperseded candidate holding the fix by ancestry. This reverses part of Sean's own ruling, so it is his, and no case here asserts it.

## 3. Should the harness count such a `verifying` item as runnable?

**No: neither runnable nor in flight.** A project where that is all that is left is a silent stall, and the harness must fail it at once, naming the item.

- **BS6 §4.1 rule 25** decides it: "with no runnable work, no work in flight and no open owner question, short of its expected end, fails at once naming that state, never waiting out its timeout".
- **E162 item 1** (D7 §11): what accounts for a hold is an open question, an owner-opened session, "pending engine work" or a deferral. A fix with no run, no pending execution, no pending verification or review, no due gate and no repair due on any unsuperseded candidate holding it has none.
- Counting it as runnable made the harness wait for work the engine will never do. That is F19's "stall masked as work" and F33's deadline failure.

**The correction**, made on this branch in `harness/real/m6-lane.mjs` (SEAM.md §561):

- **`activity()`** judges each `verifying` fix with the engine's own predicates, as §558 (E178) asks the engine's `milestoneUnmet`: `dueStageGates` and `heldByAncestry` of the compiled `store/transitions/gates.js`, and `checkOutputsFor` and `currentCandidate` of `store/transitions/repair.js`. A fix the engine can move stays in `runnable`. One it cannot is listed in a new `stuck` field `{id, kind, status, finding, held_by, own_candidates, why}`, never in `runnable`.
- **Unknown is never stuck.** Predicates that cannot be loaded or throw leave the fix in `runnable`, marked `judged: "unknown"`.
- **Only `fix` items are judged this way.** A verifying `stage_build` can also be completed by its phase's completion (`plan/phase.ts`), which no pure predicate answers, so it is counted as before.
- **The stall check** (`driveM6`) names stuck fixes when it fails as a silent stall.
- **The review's end condition** is now the exported `reviewEndJudge`. A stuck fix with nothing else running, queued or asked (E179-acknowledged questions excepted) fails the step as a silent stall at the third such poll, naming it. It is never judged ended.

**On the run's store** (the copy, read only): the corrected `activity()` gives `runnable` `[]` and `stuck` `[wi_01M5GAJNFAZ2V0WZ1J6P8AVZC6]` (finding `fnd_01M5G804…`, `held_by` `cand_01M5HS2MW5VA1JJ0367JDG5TRQ`, its own candidate `cand_01M5GAK819…` superseded by `cand_01M5GJHT1E8X9RRHC3HBTJG49M`), with `asked` holding only the two E179 questions. `reviewEndJudge` with the review confirmed and those two excepted returns false, false, then throws:

> m6x_review: a silent stall (BS6 §4.1 rule 25): nothing runnable, nothing in flight, nothing asked, and work the engine can no longer move: fix wi_01M5GAJNFAZ2V0WZ1J6P8AVZC6 verifying (finding fnd_01M5G804A7604DTRPZF3S16YG9), held by cand_01M5HS2MW5VA1JJ0367JDG5TRQ, its candidate cand_01M5GAK819E9DM8JBTNKWDEEJW superseded by cand_01M5GJHT1E8X9RRHC3HBTJG49M: …

At the real lane's 15-second rounds that is about 45 seconds instead of the 60-minute deadline, and it names the fix instead of only the two acknowledged questions. It is a failure, never a pass.

**It cannot make M535 pass.**

- With the fix stuck, the step fails as a stall.
- With the fix settled (after the Builder's correction), the review ends as before, and its judgements after the end are unchanged code. `ruleTwentyFive` and `recordActs` are not touched. M535 (l) still fails on `review_confirmation` performed by the driver.

**Left for Sean (D-5, optional).** `ruleTwentyFive`, the judgement at each step's end, does not read `stuck`. Rule 25's stall is "short of its expected end", so a step that reaches its end with stuck work (the Alpha step at 02:36Z on 2026-10-22, with this fix already stuck) is not failed by the rule's letter. Recommendation: record stuck work in every step's `rule_25` value. Failing the step for it is Sean's to decide. Not done here.

## 4. Failing cases first

Every case is built through the engine's API in the kernel lane. No browser, no real model, never `--lane real` or `--lane exhaust`. The shared fixtures are in `packages/engine/test/acceptance/harness/checks/stuck-fix.mjs` (new). Each file was run whole with `node --test --test-reporter=spec <file>` after `npm run build`, `TMPDIR=/tmp/vrf-f33`.

| Case | File (row) | What it asserts | Against `main` `3b643c87` |
|---|---|---|---|
| (a) | `M235-finding-resolution.test.mjs`, "(a) F26 (objection 209): a finding a Verifier's check_correction run raises …" (row M235, (a)'s required result: "resolved …; the fix completes") | After the owner's `fix`, the fix built, its candidate verified with `login` passing after the disposition, and the engine's own stage gate satisfied: the finding is resolved and the fix complete, or an open owner question names them. A fix complete with its finding unresolved fails as a drop. | **Fails**: "F26: the fix wi_… is left verifying and its finding fnd_… dispositioned with nothing asked about either, although login passed on the fix's candidate … after the disposition and the engine's own stage gate there was satisfied: the finding is recorded scope candidate with candidate null, so it applies to no candidate (D1 §9.3 (5); gates.ts findingApplies) and no evaluation read it (read by [] of [[cand_…,"stage","satisfied"]]); … the owner was told "… It holds the gates until its check login passes after the fix, which resolves it."" |
| (b) | `M235-finding-resolution.test.mjs`, "(a) F33 (objection 209): a plain fix whose candidate a later fix's candidate supersedes …" (row M235, (a)'s required result) | The stage verified first; two owner `fix`es; fix 1's candidate verified, then superseded by fix 2's (holding it by ancestry), which is verified with `login` passing after both dispositions; the engine ticked. Fix 1 judged or asked, as in (a). | **Fails**: "F33: the fix wi_… is left verifying, held by its own candidate cand_… (superseded by cand_…) and by cand_… by ancestry, and its finding fnd_… dispositioned, with nothing asked about either, although login passed on both candidates after the disposition: no evaluation read it (evaluations: [[cand_…,"stage","satisfied"]]), because the engine's due gates (gates.ts dueStageGates) are only those of a verifying stage_build or an asset_updated fix …; … so nothing will ever judge it (fix 2: verifying, its finding dispositioned)" |
| (c) | `M512-design-due-and-no-silent-stalls.test.mjs`, "(k) F33 (objection 209), a fix the engine can no longer move …" (row M512 (k), the harness's rule-25 judgements; SEAM §561) | On (b)'s state, with nothing running, queued or asked:<br>• `activity()` lists neither fix runnable and names both `stuck` (fix 1 `held_by` candidate 3, its own candidate 2 superseded by 3).<br>• `quietState` is `silent`.<br>• `driveM6` with the stall check fails within three ticks as a silent stall naming both, never "not reached".<br>• `reviewEndJudge` fails at the third poll naming both, alone and beside an E179-acknowledged question; with nothing stuck and the review confirmed it ends; unconfirmed it does not; beside an open question it never stalls.<br>• Still counted: an operator check request on candidate 3 (both fixes in flight, `busy`, stuck again once recorded); an eligible item on the paused project (runnable, `busy`); on a store backup whose candidate-3 `held_work` cannot be read, both fixes counted, marked `unknown`. | **Fails** at its first assertion: "F33: activity() counts the verifying fixes wi_…, wi_… as runnable although the engine can do nothing for them: no run, no pending check execution, no pending verification, no due gate and no repair due on any unsuperseded candidate holding them (the engine dispatches nothing for them at any tick), so the runner's stall judgement never fires and the review's end never comes: a stall masked as work (F19)" |

Case (b)'s name carries "(a)" because it is M235 (a)'s required result under supersession. Both M235 cases assert the minimum that every option of D-1 to D-3 satisfies: judged, or asked. Once Sean decides, the Verifier narrows them (a changed test).

**Results at `252bdede`** (cases only; engine and harness as on `main`):

- `M235-finding-resolution.test.mjs`: **11 tests, 9 passed, 2 failed** (the two new cases above), 0 skipped, 0 cancelled.
- `M512-design-due-and-no-silent-stalls.test.mjs`: **18 tests, 17 passed, 1 failed** (the new case above), 0 skipped, 0 cancelled.

**Results after the harness correction** (this branch's second commit): section 6.

## 5. The proposed correction

### 5.1 Harness (the Verifier's, done)

This is section 3's correction: `harness/real/m6-lane.mjs` and SEAM.md §561. Results are in section 6.

### 5.2 Engine (the Builder's, after Sean's decisions; `packages/engine/src/` untouched here)

1. **Under D-1 (A): a role's finding from a run whose work names no candidate is a `project` finding.**
   - In `store/transitions/findings.ts` `recordReport`, when the run's work subject names no candidate, record each reported finding (other than a Builder's objection, which takes X2's route) with `scope` `project` and `subject_id` the project. Do this whatever scope the role reported.
   - `finding.raised` keeps its type. Its payload gains `reported_scope` and `cause: "no_candidate"`, so the change of scope is visible.
   - For rows already written with a non-`project` scope and a null candidate, `gates.ts` `findingApplies` treats them as `project`. This is the one place applicability is decided; no migration is needed, and the closed run's store is not touched.
   - With this, the owed question's `fix` text is true as written, and gates.ts's existing resolution rule ("A fix's work completes with its finding's resolution (E36 item 4)") resolves the finding and completes the fix in the first evaluation where its named check passes after the disposition.
2. **Under D-2: the due gates read a plain fix.**
   - In `gates.ts` `dueStageGates`, beside the `asset_updated` loop: for each verifying `fix` (subject naming a finding, not `asset_updated`) held by ancestry by an unsuperseded candidate whose verification is complete, and whose finding is `open` or `dispositioned` `fix` and applies to the candidate, make due the `stage` gate of each stage the candidate holds by ancestry whose required set on that candidate includes the finding's named check. Do this when there is no evaluation of that candidate and stage, or the latest is stale.
   - Nothing new completes or resolves anything: the existing resolution rule does.
   - Q9's skip of superseded candidates stays.
3. **Under D-3: a question when nothing can judge it.** At the tick's Gates step, a verifying `fix` that (2) cannot make due on any unsuperseded candidate holding it, or that no unsuperseded candidate holds, gets one `blocker` decision on the fix. It is raised once per fix and generation, with the reason and question text of section 2 and the options `retry` and `cancel`. On `cancel` the fix is cancelled and the finding's owed question is raised again; the finding is never resolved by it.
4. **Under D-4 (if Sean so decides): the fix's current candidate.** In `repair.ts` `currentCandidate` for `fix`, use the latest unsuperseded candidate holding it by ancestry, as for `stage_build`.

Each change comes with the M235 cases above, narrowed by the Verifier to the option Sean picks.

### 5.3 What the correction must NOT do

- **Never complete a fix whose finding is unresolved.** This rules out completing it at its candidate's supersession, at its candidate's verification, or at the phase's completion. `plan/phase.ts` completes only stage work, and must not be widened to fixes. Doing any of these drops the finding silently (E36 item 4).
- **Never resolve the finding without an evaluation that read it,** including by a result of the superseded candidate (Q9).
- **Never cancel the fix or the finding,** or change either's status, without an owner's answer.
- **Never send the fix back to `eligible` when nothing failed.**
- **Never edit the run store.**
- **Never make M535's review step pass.**
  - With the engine corrected, the review in the observed state would end, and M535 (l) would still fail on the driver-performed `review_confirmation`, as it must.
  - Neither M535 (j), (l), M519 (h), rule 25, `ruleTwentyFive`, `recordActs` nor E179's exception is changed by anything here.
  - No real-lane step is rerun; Sean authorized none.

## 6. Results after the harness correction

Harness correction: commit `822ee4a0`. Each file below was run whole after `npm run build`, with `TMPDIR=/tmp/vrf-f33`, 0 skipped and 0 cancelled in every file. No `real` or `exhaust` file was run.

| File | Tests | Passed | Failed | Note |
|---|---|---|---|---|
| `M512-design-due-and-no-silent-stalls.test.mjs` | 18 | 18 | 0 | (k) F33 now passes. Rerun at `822ee4a0` itself: 18 of 18. |
| `M235-finding-resolution.test.mjs` | 11 | 9 | 2 | The two failures are "(a) F26" and "(a) F33", the engine cases, unchanged; they stay failing until the Builder's correction. |
| `M239-the-verifiers-check-writing-package.test.mjs` | 2 | 2 | 0 | |
| `M342-the-verifiers-deployment-check-package.test.mjs` | 1 | 1 | 0 | |
| `M442-the-rehearsal-plays-from-the-package.test.mjs` | 42 | 42 | 0 | |
| `M442-the-rehearsal-with-the-packages-whole.test.mjs` | 3 | 3 | 0 | |
| `M442-the-role-packages-state-what-the-engine-reads.test.mjs` | 11 | 11 | 0 | |
| `M537-the-designers-and-verifiers-packages-state-what-the-engine-reads.test.mjs` | 6 | 6 | 0 | |
| `M537-the-rehearsal-plays-from-the-designers-package.test.mjs` | 13 | 13 | 0 | |

These are every kernel-lane file that imports `harness/real/`. The rest (M136 to M140, M239 and M342 real journeys, M420, M443, M444, M519, M535) are manifest `real` and were not run.

The corrected `activity()` applied read-only to a copy of the run's store is in section 3. Its sha256 was the same before and after the read.

## 7. Design decisions for Sean, in one place

- **D-1** (question 1): what a finding raised by a run whose work names no candidate applies to.
  - (A) `project` scope **(recommended)**.
  - (B) The latest unsuperseded candidate at raise time.
  - (C) Refuse `fix` on it. Not enough alone.
- **D-2** (question 2): which evaluation the engine makes for a plain verifying fix. Recommended: D7 §6.5's form extended to plain fixes (section 2).
- **D-3** (question 2): when nothing can judge it, a `blocker` on the fix with `retry` and `cancel`, the reason value and the question text (section 2).
- **D-4** (question 2): revisit E100 item 1 so that a fix's current candidate for D3 §2.10 is the latest unsuperseded candidate holding it by ancestry.
- **D-5** (question 3, optional): whether a step that reaches its end with stuck work records it in its `rule_25` value (recommended) or fails.
- Once these are decided, the Verifier narrows M235's two cases to the chosen options.

## 8. Sean's rulings (2026-10-23)

Recorded on `main` as errata E180 (commit `bf1ca304`; this branch does not carry that commit). Quoted verbatim:

> 1. D-1 — Project scope. A role finding with no source candidate must apply at project scope, except for separately governed Builder objections. Preserve its reported scope and the reason for normalization in the audit record. Explicitly document and test how existing malformed findings are handled in future evaluations; do not rewrite historical evaluations or the closed Waterlog store.
> 2. D-2 — Extend the asset-fix evaluation rule to ordinary fixes. Schedule the appropriate existing gates on the current, non-superseded candidate that holds the fix directly or through ancestry. Require the applicable check set and fresh evidence. Do not reopen completed stages or expand check coverage merely to manufacture an evaluation.
> 3. D-3 — Approve `fix_unjudged`. When no supported evaluation can judge the fix, raise one actionable blocker identifying the fix, finding, check and missing prerequisite. Ordinary work still in flight is not this condition. Retry re-evaluates eligibility; it must not launch another paid Builder merely because evaluation remains impossible. Cancel cancels the fix only, preserves the unresolved finding and presents whatever disposition remains owed. Prevent duplicate blockers and automatic retry loops.
> 4. D-4 — Amend E100 item 1 narrowly. A fix's current candidate may be the latest non-superseded candidate holding it through ancestry. This preserves the repair's opportunity to finish; it does not reuse superseded results as current evidence. Preserve freshness requirements, repair limits and deduplication. Supersession alone must not trigger another Builder.
> 5. D-5 — Record stuck work at every step boundary. Keep intermediate steps' existing acceptance conditions unless a separate amendment is necessary. Final completion must not silently pass with stuck work. Keep the new prompt stall failure when only unmovable work prevents progress.
> Before implementation, tighten the regression expectations around these rulings. A normally judgeable fix must actually resolve its finding and complete; merely raising a blocker is insufficient. Test the genuinely unjudgeable fallback separately, along with superseded evidence, unrelated candidates, legacy malformed findings and duplicate repair prevention. Keep the Verifier's commits and failing-first evidence intact. Fix the E38 citation on the branch.

**The E38 citation.** It is fixed in the objection's own file: its question 1 now says "Errata E38 item 6".

**How legacy malformed findings are handled (D-1).** "Legacy" means a row already stored with `scope` `lineage` or `candidate` and `candidate` null. The Waterlog store has four, three of them role findings and one a Builder objection.

- **Read as project findings by later evaluations.** Every evaluation made after the Builder's correction reads such a row as a `project` finding. It is in the evaluation's findings read. An open row is a subject of `FINDING_UNSATISFIED` (or `FINDING_BLOCKING` at a blocking severity), as for any project finding. A `fix` row is resolved by its named check passing after its disposition, and its verifying fix then completes.
- **Nothing is rewritten.** The row's stored `scope`, `candidate` and `subject_id` stay as written. No migration runs. No earlier evaluation is changed or re-stamped: an evaluation keeps the findings it read and its outcome.
- **The closed Waterlog store is not opened by any engine.** If it were, its role findings would be read as above at its next evaluation.
- **Builder objections are excluded.** A Builder's objection (D3 §5 X2) with a null candidate keeps its separately governed route and is not normalized.
- **The case** is M235's "(a) D-1 legacy rows" (section 9). The rows are made in the test's own store with the engine stopped (`harness/checks/stuck-fix.mjs` `legacyShape`), because once D-1 is built the API no longer writes them.

## 9. The cases under the rulings, and their results

The cases were narrowed and added in `1825c141`, before any implementation. The D-5 harness correction is `3a10c0d5`. The engine is unchanged on this branch.

| Ruling | File (row) | Case | Against the current engine |
|---|---|---|---|
| D-1, D-2 | M235 (row M235 (a)) | "(a) F26, D-1 and D-2 …": finding resolved and fix complete (never a blocker); stored at project scope; `finding.raised` payload `scope` `project`, `reported_scope` `candidate`, `scope_reason` `no_source_candidate`; no open question about the fix | **Fails**: "F26 (D-1, D-2): a judgeable fix must resolve its finding and complete: the fix … is verifying and its finding … dispositioned … the finding is stored scope candidate, candidate null, which applies to no candidate … no evaluation read it …" |
| D-2 | M235 (row M235 (a)) | "(a) F33, D-2 …", two plain fixes, fix 1's candidate superseded before verification:<br>• both findings resolved by the current holder's stage gate, from its own results;<br>• a superseded candidate's pass (recorded after the dispositions) never evidence;<br>• no evaluation of candidate 1 (not a holder) or the superseded candidate after the dispositions;<br>• the verified stage not reopened (work `complete`, no transition, stage `verified`);<br>• the stage scope's keys unchanged (no check added);<br>• fresh evidence (execution after the disposition);<br>• no `fix_unjudged`. | **Fails**: "F33 (D-2): a judgeable fix must resolve its finding and complete: fix 1 … is verifying … no gate was scheduled for it … gates.ts dueStageGates makes due only a verifying stage_build's gates or an asset_updated fix's" |
| D-3 | M235 (row M235 (c), the fallback beside the missing-verification route) | "(c) D-3 …", `login` required at `alpha_authorize` only:<br>• no `fix_unjudged` while the fix's run is held or its candidate's verification is pending;<br>• then exactly one, with `cause` `fix_unjudged`, `finding`, `check` `login`, a non-empty `missing`, a question naming all three, options `cancel` and `retry`; the fix `verifying`;<br>• no stage scope gains `login`;<br>• no duplicate on ticks;<br>• `retry`: no Builder run, still `verifying`, one open again, at most two raised in all;<br>• `cancel`: the fix `cancelled` and nothing else, the finding unresolved, one open `finding_disposition` about it, no Builder run, the stage untouched. | **Fails**: "D-3: a fix no supported evaluation can judge gets one fix_unjudged blocker: 0 raised; the fix … is verifying, its finding dispositioned, nothing asked about either ([]) …" |
| D-1 legacy | M235 (row M235 (a)) | "(a) D-1 legacy rows …":<br>• two rows put in the malformed shape with the engine stopped;<br>• the `fix` one resolved by the fix candidate's fresh `login` result, its fix complete;<br>• the open one a `FINDING_UNSATISFIED` subject of the next stage evaluation;<br>• neither row's `scope`/`candidate` rewritten;<br>• an evaluation recorded before unchanged. | **Fails**: "D-1 legacy: a stored finding with scope candidate and no candidate must be read as a project finding by future evaluations: the dispositioned one … is dispositioned, its fix verifying, read by [] …" |
| D-4 | M234 (row M234 (a), with (e) and (f)) | "(a) D-4 …":<br>• supersession alone: nothing sent back, no Builder run;<br>• a superseded candidate's failure: nothing;<br>• the named check failing on the current holder: fix 1 sent back once, `check_repair.candidate` that holder;<br>• ticks, a restart and a second failure there: no second repair; no Builder run while paused. | **Fails** at the send-back: "D-4: fix 1's named check failed on cand_…, the latest non-superseded candidate holding it by ancestry: it must be sent back once … (observed: verifying, repair_attempts 0, 0 repairs, check_repair null; its current candidate is still its own cand_…, superseded by …)". Its first two assertions (supersession alone, a superseded failure) **pass** on the current engine. |
| D-5 | M512 (row M512 (k)) | "(k) D-5 …":<br>• `ruleTwentyFive` records `stuck` without failing an intermediate step;<br>• `e179Record` not satisfied, not clean, not completed under E179;<br>• `e179RunEnd` (M535 (j)) and `runEndStuck` (M519 (h)) fail naming both fixes;<br>• with nothing stuck, as before. | **Failed** at `1825c141` ("the step's rule-25 value records the stuck work … (value: ["handed_over","design_holds"], stuck undefined)"); **passes** at `3a10c0d5` (the Verifier's harness correction). |
| §561 | M512 (row M512 (k)) | "(k) F33 …", now judged on a store backup with every question about the fixes consumed, and with `login` at `alpha_authorize` only: the D-3 engine asks `fix_unjudged` there, so the run's unasked state is reproduced only on a backup. | Passes (harness correction of `822ee4a0`). |

**Results at `3a10c0d5`**, each file run whole with `node --test --test-reporter=spec` after `npm run build`, `TMPDIR=/tmp/vrf-f33`. Every file had 0 skipped and 0 cancelled.

| File | Tests | Passed | Failed |
|---|---|---|---|
| `M512-design-due-and-no-silent-stalls.test.mjs` | 19 | 19 | 0 |
| `M235-finding-resolution.test.mjs` | 13 | 9 | 4: (a) F26, (a) F33, (c) D-3, (a) D-1 legacy rows; the engine's, for the Builder |
| `M234-the-repair-loop.test.mjs` | 12 | 11 | 1: (a) D-4; the engine's, for the Builder |
| `M239-the-verifiers-check-writing-package.test.mjs` | 2 | 2 | 0 |
| `M342-the-verifiers-deployment-check-package.test.mjs` | 1 | 1 | 0 |
| `M442-the-rehearsal-plays-from-the-package.test.mjs` | 42 | 42 | 0 |
| `M442-the-rehearsal-with-the-packages-whole.test.mjs` | 3 | 3 | 0 |
| `M442-the-role-packages-state-what-the-engine-reads.test.mjs` | 11 | 11 | 0 |
| `M537-the-designers-and-verifiers-packages-state-what-the-engine-reads.test.mjs` | 6 | 6 | 0 |
| `M537-the-rehearsal-plays-from-the-designers-package.test.mjs` | 13 | 13 | 0 |

These are every kernel-lane file that imports `harness/real/`, plus M234 and M235. `M519-the-real-run-design-before-build-and-at-alpha.test.mjs` (manifest `real`) gained one call in (h). It was syntax-checked (`node --check`), not run. No `real` or `exhaust` file was run, and no process, unit or test home was left.

**About "an unrelated candidate".** Inside one project, every candidate's lineage starts from the one before it, so there is no unsuperseded candidate that does not hold a later fix by ancestry. The case therefore pins what does arise: after the dispositions, nothing is evaluated on candidate 1 (which precedes the fix and does not hold it) or on the superseded holder. Only the current holder is evaluated.

## 10. The Builder's brief (`build/f33-fix-verifying`, cut from this branch's tip)

**Run.** `npm run build`, then the M235 and M234 cases above and `npm run test:unit`. Every other case of M234, M235 and M512 must stay as it is. Do not edit any acceptance test (file an objection instead).

**Paths.** Builder paths only: `packages/engine/src/`, `migrations/` (none expected), `api/`, `test/unit/`.

The pins are SEAM.md §562.

### D-1: project scope for a role finding with no source candidate

**Engine change**
- **`store/transitions/findings.ts` `recordReport`:** when the run's work subject names no candidate, record each finding of `report.findings` with `scope` `project` and `subject_id` the project, whatever scope the role reported. The exception is a Builder's objection, which keeps its X2 route as built (`repair.ts` `recordObjections`, `isObjection`).
- **`raiseFinding`** emits the one `finding.raised` with payload `{ scope: "project", reported_scope: <the role's scope, "candidate" when it gave none>, scope_reason: "no_source_candidate", category, severity, candidate: null }`. With a source candidate the payload is as before; omit the two new fields, or set them only when normalized.
- **`store/transitions/gates.ts` `findingApplies`:** a non-objection finding whose `scope` is not `project` and whose `candidate` is null applies as a `project` finding (always, unless an approved assessment excludes the candidate). This is how legacy rows are read.

**Cases:** M235 "(a) F26 …" and "(a) D-1 legacy rows …".

**Must not:**
- migrate or rewrite any stored finding or evaluation;
- touch any run store outside a test's own home;
- normalize an objection;
- change applicability for a row with a candidate.

### D-2: the asset-fix rule extended to ordinary fixes

**Engine change** (`gates.ts` `dueStageGates`, beside the `asset_updated` loop):
- **Which fixes.** Every verifying `fix` whose subject names a finding and is not `asset_updated`.
- **Which candidate.** The fix's current candidate, as D-4 defines it (the latest non-superseded candidate holding it, itself or by ancestry), and only once that candidate's `verification` work is `complete`.
- **Which finding.** Only one `open`, or `dispositioned` `fix`, that applies to that candidate (`findingApplies`).
- **What becomes due.** The `stage` gate on that candidate of each stage it holds (`stagesHeld`) whose required set at the effective version (`requiredSet`, kind `stage`) contains the finding's named check, with that check verifying the finding's criterion (`verifiesCriterion`, or `verifiesByCheck` for a finding naming no criterion). It is due when that (candidate, stage) has no evaluation or its latest is stale.
- **Nothing else changes.** The evaluation and its existing resolution rule do the rest.

**Cases:** M235 "(a) F26 …" and "(a) F33 …".

**Must not:**
- evaluate a superseded candidate, or any candidate other than the current holder;
- register executions or add a check to a scope;
- reopen a stage: `completeStageWork` acts only on a verifying `stage_build`, and the stage's `status` stays;
- complete a fix in any other way than its finding's resolution;
- raise a blocker for a fix this makes judgeable.

**Not pinned** (the cases are T1): at T2 and T3, `evaluate` queues a review after a `stage` evaluation (`queueReview`). Re-evaluating a verified stage's gate on a fix's candidate must not queue a second paid review that the `asset_updated` path would not. Follow that path's behaviour. If the two differ, file an objection rather than choosing.

### D-3: `fix_unjudged`

**The condition** (at the tick's Gates step, after D-2's due gates are known). A verifying fix:
- has no run that has not ended;
- has no `verification`, `review` or `phase_verification` work not complete or cancelled for its current candidate;
- has its current candidate's verification complete (or no non-superseded candidate holds it);
- and D-2 makes no gate due for it on its current candidate and has none to make. That is: no stage it holds requires the named check, or no current candidate exists.

**The blocker.** Raise exactly one `blocker` decision (`raiseQuestion`, subject `work_item` the fix). The fix's status stays `verifying`: no park, no `awaiting_decision`, never `eligible`.
- **`dependency_manifest`:** `{ work_item, subject_status: "verifying", cause: "fix_unjudged", finding: <id>, check: <key>, candidate: <current candidate id or null>, missing: <non-empty text naming the missing prerequisite> }`. In M235 (c) the missing prerequisite is that `login` is required at `alpha_authorize` only, which the engine evaluates only for a proposed deployment authorization.
- **The question** names the fix, the finding and the check, for example: "Fix `<wi>` for finding `<fnd>` (check `<key>`) is verifying, and no gate the engine evaluates on `<candidate>` can judge it: `<missing>`. Retry to judge it again, or cancel the fix (the finding stays unresolved and its disposition is asked again)."
- **Options:** exactly `retry` and `cancel`.
- **The reason** `fix_unjudged` is a new blocker cause (Sean approved it, E180 item 3). Add it wherever blocker causes are enumerated (the decision contract, `api/`, the reads).

**`retry`:** no transition. The fix is judged again at the next tick:
- now judgeable, D-2 makes its gate due;
- still unjudgeable, one new `fix_unjudged` is raised (a new semantic generation), at most once per `retry` answer.
- No Builder is ever dispatched by it.

**`cancel`:**
- The fix goes `verifying → cancelled` (the existing "Cancel" edge of the work-item contract), and nothing else is cancelled.
- The finding is not resolved. It goes back to owing its disposition: its `fix` disposition cleared, or the owed question raised by the existing route.
- So exactly one `finding_disposition` about it is open (`askUndispositioned`'s `disposition_owed`, or a scope the Builder names in SEAM).
- No Builder run.

**Deduplication:**
- never two open `fix_unjudged` about one fix;
- no re-raise on ticks while one is open;
- none raised automatically after an answer except that one per `retry`.

**Case:** M235 "(c) D-3 …".

**Must not:**
- raise it while a run, a verification or a due gate is in flight;
- raise it for a judgeable fix;
- send the fix to `eligible`;
- launch any Builder;
- resolve or delete the finding;
- loop.

### D-4: a fix's current candidate

**Engine change** (`store/transitions/repair.ts` `currentCandidate`): for a `fix`, return the latest non-superseded candidate holding it, itself or by ancestry (`heldByAncestry`), as for a `stage_build`. Return null when none does. Everything else in D3 §2.10 stands:
- `repairView`'s refusal of a superseded candidate;
- one repair per item, candidate and generation (`check_repair`);
- `repair_attempts_max` and `no_progress_max`;
- the progress key;
- the failed outputs in the next context;
- "only the latest registration counts".

**Case:** M234 "(a) D-4 …". Every other M234 case must still pass, notably (a) "a fix …" (its own candidate is then also the latest holder), (e) and (f).

**Must not:**
- send a fix back on a superseded candidate's result;
- send it back, or dispatch it, on supersession alone;
- take a second repair for the same candidate and generation.

### D-5: the harness

**Done by the Verifier** (`3a10c0d5`, SEAM.md §563). Nothing for the Builder.

### Throughout

- **Out of scope:** the run store `~/s7-1020`, any acceptance row, rule 25, `ruleTwentyFive`, `recordActs` and E179's exception.
- **M535 (l) still fails** on a driver-performed central act. Nothing here may change that.
- **One unit case per change** in `test/unit/` where the Builder's conventions ask for one.
