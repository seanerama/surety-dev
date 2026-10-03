# Cross-review brief for D3 draft 1 (for Astra, prepared 2026-10-03)

Astra, this is the cross-review request for D3, the third design document of Surety: the protected acceptance path at runtime, the check runner, the diff classifier and validation scope. Same role as for D1 and D2: second architect, adversarial, against source. One review (E48 item 2's rule carried to D3 by its brief): your findings are dispositioned by Sean into draft 2, and after that a finding is a decision for Sean or a failing acceptance test (E20). Nothing you write here is an implementation authorization.

## Read, in this order

1. `docs/design/sdlc-design-D3-brief.md`: the owner's brief D3 was written to. It fixes what D3 covers, the questions it must answer (P1 to P4, R1 to R9, C1 to C5, S1 to S3, X1 to X3), what it inherits and may not reopen, and what it produces. Judge D3 against it.
2. `docs/design/sdlc-design-D3-checks.md`: the document under review, draft 1 (304 lines).
3. `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`, entries **E56 to E59**: your D2 review's dispositions, the optional observer, D2's approval with the architect's variants, the M2 plan's adoption. The decisions there are Sean's and are not open for relitigation; if D3 contradicts one, say so.
4. `docs/design/sdlc-design-D2-backends-and-isolation.md` draft 2 (approved to build, E58), especially §2.3 (the mount plan and its forbidden set), §2.5, §3.2 (launch authorization and closure), §3.7 (the envelope), §3.8 (the `check` profile D3 defines) and §5 C2 (K8). D3 reuses D2's launcher, domain init, volatile filesystem and boundary; it proposes one correction to D2's binding (L1).
5. D1 §§3.4, 5.2, 7.3, 7.9, 9.1 to 9.5, 10.5 and Appendix A with the M1 build spec's section 6 corrections: the gate function, check state assignment, protected proposals and their application. D3 changes none of §9.2's rules; it makes "runner-established" real and proposes L3 and L4 as corrections to §9.1 and §9.2.
6. The foundations F §§5.2 to 5.7 and 6, with E8, E9, E13 and E19.
7. The engine as built, read-only: `packages/engine/src/gates/prepare.ts`, `src/protected/set.ts`, `src/store/transitions/{gates,protected,findings,evidence,baseline}.ts`, and the seam `packages/engine/test/acceptance/harness/SEAM.md` §§66 to 77 and 99 to 104 (what the kernel already pins about gates, proposals, classification fixtures and the fix loop). D3 cites these; check that what it says is "as built" is.
8. `docs/acceptance/sdlc-M2-acceptance-plan.md` §2 and §5 (the three lanes and the slices M2 is built in); D3's rows are meant to join that plan or open M3's, as Sean decides.

## What D3 is

The design that lets the engine run a check itself, so that a `passed` state comes from an execution the engine observed rather than from a scripted result. Its four parts: the governed set at runtime, with a closed schema for the five governed policy fields and a closed check-definition schema, discovery as a pure function of a tree, and materialization of the protected set at the effective version (§1); the check runner, which executes one definition in a `check`-profile domain of D2's sandbox with a discarded writable overlay and strictly read-only protected inputs, establishes `execution_established` only from the domain init's reports on a channel check code cannot reach, records no row while termination is unknown, orders results by registration, qualifies the `direct` class by a runner self-test, and sends a fix back to its Builder when its finding's check fails again (§2); the diff classifier, which compares two discoveries element by element and calls a change a tightening only when every existing check's fingerprint is unchanged and something strict is added, with every change to a command, input, or governed execution field unclassifiable, re-run at application as an effect precondition (K8), and authoritative only once a named classifier version is set (§3); and validation scope, where the required set comes from the scope's tier (with module overrides), the obligation requirements' criteria and the sensitivity categories, a scope is validated only when every criterion is covered by an acceptance-origin check and every area has a floor check (§4). Then the carried items (§5: the gate's own ref reads before evaluation, X1; the requirement-conflict route, X2; the place left for M3's environment-bound check, X3), what it does not claim (§6), five proposed corrections L1 to L5 and seven open questions (§7), closed enumerations (Appendix A), the `.surety/checks/` reference (Appendix B), and 53 test statements in three lanes, `kernel`, `sandbox` and a new `project` lane against a real toolchain with no model (Appendix C).

Two facts about how it was written. It departs from its brief in two places and says so: the check gets a discarded writable overlay rather than declared writable paths (§2.2), and the check's toolchain is governed in `runner_config.direct.read_paths` rather than D2's `sandbox_read_paths` (§1.1). And it rests on one scratch probe, that Node 22's `node --test` exits 0 with every test skipped or no test at all, which it records in §6 as the reason a bare runner invocation is a vacuous check.

## What I want from you

Write `docs/reviews/D3/sdlc-review-D3-Astra.md` with these sections, in this order.

**1. Verdict.** One of: approve; approve with the amendments in section 2 applied; reject with reasons. One paragraph.

**2. Blocking objections.** Each one: the D3 section, what is wrong, the evidence (a foundations or errata clause it violates, a D1 or D2 invariant it weakens, an incident from the predecessor record it would reproduce, an internal contradiction, a claim about the engine as built that the source does not support, or something you verified by inspection or by a probe on this host), and proposed replacement text I can paste. Do not edit D3 yourself.

**3. Non-blocking suggestions.** Same shape, lower bar.

**4. The five proposed corrections (§7.1, L1 to L5).** For each: accept, accept with a variant, or reject, with the reasoning in one or two sentences.

**5. The seven open questions (§7.2, Q1 to Q7).** Your recommendation on each with one or two sentences of reasoning. All are Sean's to decide; give the recommendation anyway. Q2 and Q4 change what the kernel does today; say so if you agree.

**6. Brief conformance.** One row per question of the brief's section 3: the D3 section that answers it, "open question" with the Q number, or "gap" with what is missing. D3's own table in §7.3 is its claim; check it, and check the two departures from the brief against the brief's reasons.

**7. Incident coverage.** One row per incident in `docs/reviews/predecessors/sdlc-review-claude.md` section 3.4 that concerns checks, runners, evidence or vacuous tests (at least 1, 8, 12, 17, 19), and your own findings on vacuous tests and on Verity's test runner being a gate: the D3 mechanism that prevents it, or "gap".

**8. The test table (Appendix C) and the classifier's rules (§3.1).** Which row, as stated, would pass while the property it stands for is false? Which property of §1 to §4 has no row? For the classifier: find a change the rules call a tightening that loosens what a check establishes, or one they call unclassifiable that a person would obviously approve; say whether the fallback is conservative enough and whether it is too conservative to be usable.

**9. What you verified versus inferred.** Your evidence labels. Where D3 cites the engine as built, you may read the file; where it cites its Node probe, you may repeat it; do not run a model.

## Where to press hardest

- §2.6 and L4: `execution_established` from the init's `started` report plus termination with closure. Is there a way for check code to make the init report `started` for a process that is not the check's command, or to make an exit status of 0 reach the engine from a process other than the check's own? Does "no row while unknown" leave a gate honest, or can a quarantined execution be mistaken for one never registered?
- §2.2: the `check` profile. The writable overlay is discarded; the protected inputs are read-only binds over it. Can candidate code that the check runs (a test that imports the project's modules) write, rename or replace an input through a path the bind does not cover, a symlink in the lower layer, or a hard link? Does the absence of `.git` in the check tree break any real toolchain (a test that calls `git describe`), and is the right answer "unsupported" or a read-only view?
- §2.5: registration order. "The later-registered decides whichever finishes first" with `max_concurrent_checks` 1 and an operator re-run: can a flaky check be laundered into a pass (§6 class C admits it); should the gate read show every execution, and should the engine refuse to re-run a check whose last execution passed at the same bindings?
- §3.1: the fingerprint and `inputs`. Under default inputs (Q3 (a)) every protected file is in every check's inputs, so almost any proposal is unclassifiable; under declared inputs a Verifier can declare too few and hide a changed expectation from the fingerprint. Which failure is worse, and is "inputs mandatory" (Q3 (b)) the honest default?
- §3.1: a tightening that removes nothing but adds a vacuous check covering a criterion is a tightening (§3.2, §6). Is the Reviewer's assessment plus the protected delta at human gates (E13) enough control, or must a tightening a Reviewer approves alone exclude new checks that cover criteria already covered?
- §4.2 and §4.3: the required set and `validated`. Is anything in F §5.6 and §5.7 (verification cadence, module overrides, the floor) not computed here? Does the acceptance content hash, which now includes sensitivity categories computed from the spec and modules, change for an accepted M1 case?
- §5 X1 and Q4: reading the refs before every evaluation. Does this close the window E51 question 1 found, and does it introduce a read that can itself fail the gate wrongly (a transient git error becoming `OUT_OF_BAND_CHANGE`)?
- §5 X2: the requirement-conflict route. A Builder result field `objections` is a new input from an untrusted role: can it be used to stall work or to force a `spec_change` decision in front of the owner at will?
- §2.10 and Q2: a fix (and perhaps a stage build) sent back to its Builder on a failed check. Does the progress key stop an endless repair, and does E36 item 3 (review queued only once checks pass) leave any other route for a failed stage check?
- §6: is anything in class C something that should block a real check instead?

## Constraints

- Read-only. Do not change any file in the repository. Do not run a model or anything that spends money. Scratch probes of the kind D3's preamble lists (`node --test`, `git read-tree`, `checkout-index`, overlay and bind mounts inside `unshare -Urm`) are fine; clean up what you create.
- Cite file paths and section numbers for every claim so Sean and I can check them.
- Keep proposed amendment text in D3's register: requirements a test can pin, not advice.
- If a question needs an answer from Sean before you can judge a section, list it under a final "Questions for Sean" heading rather than guessing.

When you are done, tell Sean the verdict in one line and where the file is.
