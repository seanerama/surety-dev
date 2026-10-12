# Cross-review brief for D6 draft 2 (for Astra, prepared 2026-10-12)

Astra, this is the cross-review request for D6, the sixth design document of Surety: idea to Alpha. Same role as for D1 to D4: second architect, adversarial, against source. One review (E20): your findings are dispositioned by Sean into draft 3, and after that a finding is a decision for Sean or a failing acceptance test. Nothing you write here is an implementation authorization. D6's nine open questions are already decided (E139); judge the text as it applies them, and say where an applied decision has a cost the text does not state.

## Read, in this order

1. `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`, entries **E136** (M5's scope: idea to Alpha), **E139** (Sean's decisions on D6: dynamic concurrency sized to the machine; retrofit in M5; the rest as recommended), and **E6**, **E10**, **E11**, **E40**, **E119**, **E130 item 9**. These are Sean's and are not open for relitigation; if D6 contradicts one, say so.
2. `docs/design/sdlc-design-D6-idea-to-alpha.md`, draft 2, the document under review. Its preamble names the evidence it rests on; §11 names what it does not claim; §12.1 proposes K1 to K11 (K1 to K9 accepted as a block, K2 reworked for E139 item 4; K10 and K11 new); §12.2 lists twelve readings of the foundations Sean may overrule.
3. `docs/design/sdlc-design-D6-decisions-prep.md`: the decisions as recorded and the four numerics draft 2 leaves to Sean.
4. The foundations F §§3.2, 3.3, 3.8, 3.9, 3.10 (all of it), 4.1, 4.2, 5.1, 5.4, 5.6, 5.7, 6, 9.1, 9.2; E6's §3.12 text; E9's human decision inventory.
5. D1 §§3.1, 3.2, 4.2, 4.3, 7.3 to 7.9, 8.1, 9.1 to 9.3, 10, 15.2, 15.3, with A.2, A.5, A.8, A.9 as corrected by BS §6: sessions, work kinds, plan registration, the gate function, the queue. D6 proposes K1, K3, K4, K7, K8, K11 against these.
6. D2 §§1.3, 1.4, 1.7, 1.8, 2.3, 3.2, 3.7, 4.1, 4.4, 7.2 and A.7: the context package, the result, resumption, sessions as D2 left them, the envelope, the trust entry's `session_qualified`. D6 proposes K2 and K6 against these.
7. D3 §§1.3, 1.4, 2.5, 2.9, 2.10, 2.11, 3.1 to 3.5, 4.1 to 4.5, 5 X2, 6: discovery, the classifier, developer checks, repair, the scope rule and the index. D6 proposes K5 and K10 against these and relies on the classifier for check authoring (§6.2) and adopted tests (§8.3).
8. D4 §§1, 4.1, 5.5, 8, 9.2 and E126: the deploy request D6's K9 automates; the service's reservation in the envelope.
9. The engine as built, read-only: `packages/engine/src/store/transitions/{work,accept,finalize,gates,runs,envelope,baseline}.ts`, `src/testing/fixtures.ts` (`installFixturePlan`), `src/checks/{requirement-index,guide}.ts`, `src/api/server.ts` (the refused session routes), `src/config/schema.ts`, `migrations/0002`, `0005`, `0010`, `0015`, `0016`. D6 cites these; check that what it says is "as built" is.
10. `docs/spec/templates/project-spec-template.md`, `spec-assistant-prompt.md`, `idea-brief-template.md`: the shapes the sessions must produce.
11. `docs/acceptance/reports/M3-real-lane/2026-10-09/state.json` and `M4-real-lane/2026-10-12/state.json`: the only measured role runs; D6 §7.2 quotes them.
12. `docs/reviews/predecessors/sdlc-review-claude.md` §3.5, §5.1, §5.2 and `sdlc-review-Astra.md` §5.5, §7.2: Verity's numbers, planner thrash, the human step that never ran.

## What D6 is

Two journeys (§1 from an idea, §8 from an existing repository), then the parts: **sessions** (§2) in which each turn is a one-shot invocation carrying the engine-held transcript, with save, close, idle and resume all built from durable records and no provider continuation; **the three interactive roles** (§3) and the machine files the engine parses from their products; **the specification as a governed artifact** (§4) with a change request, a side-ref diff, an exact impact and invalidation; **planning** (§5): roadmap, next-phase plan, a mechanical check of fourteen reasons, routing, registration in the finalizer, the replan as a one-shot, early replanning, the `phase` gate; **execution** (§6): check authoring per phase, the stage chain, dependencies, concurrency decided by the admission envelope alone with per-profile memory maxima, the autonomy profile, Alpha under policy; **pace** (§7) and the read that measures it; **retrofit** (§8): adoption with signals, retrofit mode, `requirement_confirm`, a conformance stage with no Builder, evidence rules that make nothing of the adopted repository acceptance evidence by default; 60 test statements (Appendix C). It was written in two drafts by one designer with no model run and no measurement of a real-size stage; the status line says so.

## What I want from you

Write `docs/reviews/D6/sdlc-review-D6-Astra.md` with these sections, in this order.

**1. Verdict.** Approve; approve with the amendments in section 2 applied; or reject with reasons. One paragraph.

**2. Blocking objections.** Each: the D6 section, what is wrong, the evidence (a foundations or errata clause it violates, a D1 to D4 invariant it weakens, an incident from the predecessor record it would reproduce, an internal contradiction, a claim about the engine as built that the source does not support), and replacement text I can paste. Do not edit D6 yourself.

**3. Non-blocking suggestions.** Same shape, lower bar.

**4. The corrections K1 to K11 (§12.1).** K1 to K9 are accepted (E139 item 10); for each say whether draft 2's text applies it faithfully and what it breaks in the accepted M1 to M4 rows beyond what C.2 lists. For K10 and K11, new: accept, accept with a variant, or reject, with reasoning.

**5. The twelve readings (§12.2).** For each: sound, or which reading of the foundations you would take instead and why. Readings 1, 3, 10 and 12 most of all.

**6. The test table (Appendix C).** Which row, as stated, would pass while the property it stands for is false? Which property of §2 to §8 has no row? Candidates: a session's budget exhaustion between turns; a save racing a turn; two plans committed by two Architect runs; the impact of a change that only reorders criteria; `check_authoring`'s `deferred_criteria` never followed up; a conformance stage whose adoption revision moves before registration; the pace read under a restart.

**7. What you verified versus inferred.** Your evidence labels. Where D6 cites the engine as built, read the file. Do not run a model.

## Where to press hardest

- **The session model (§2, K6).** Each turn is a fresh one-shot with the transcript in `/surety/context`. Is anything of E10 lost by never qualifying a provider session mode: metering, prohibitions, resumption? Can the role, through its reply or its workspace edits, write something into the transcript or the artifact that the next turn's package treats as the owner's words or as the engine's note (§2.2's `speaker` field is the engine's; check that nothing the role writes can set it)? What does a save do when the turn's domain is terminated but collection is still in flight? Is the idle timeout's auto-save consistent with D1 §7.3's snapshot admission (zero live processes)? And the cost: §2.2 says the cache absorbs most of a re-sent transcript; nothing measures it until §7.6; say whether that is acceptable to defer.
- **The mechanical plan check (§5.3, §5.4).** F §3.10.6 says an agent's claim of conformance is never sufficient, yet §5.4's routing reads the plan's own `conformance: within_baseline` and its own declarations of goal, ADR and roadmap changes. Which of those can the engine compute instead of read (a goal change: diff the roadmap's phase goal; an ADR change: diff `.surety/adrs/`; a requirement move: diff `assigned_phase`), and does §5.4 compute all it could? Can a replan that stays within the baseline by every computable test still hide a change a human should see? Is the "validation obligations" clause (§5.3 item 4) really D3 §4.3's coverage function over a planned set, when planned checks have no definitions yet?
- **Autonomy and concurrency against F §9.1 (§6.4, §6.5, K2, K3).** Walk the floor's ten items against `autonomy: phase` with every eligible run dispatched: is any human approval or any "Builder cannot determine acceptance alone" property weakened by two Builders integrating in turn onto one branch, by a fix landing after a later stage's build, or by a Reviewer whose content hash was bound before a rebase? Check the envelope arithmetic of §6.4 against `envelope.ts` as built (reserve, per-domain maximum counted at admission, E126's service and check capacity): are the stated outcomes on a 12 and a 16 GiB host right, and does the per-profile maximum for `check` domains change what D3 §2.2 qualified? Is `max_chained_roles` 24 under `phase` a bound that can ever bind before the budgets do?
- **Retrofit's evidence rules (§8.3, K10, K11).** F §1 and P1: no self-grading. Find a path by which an adopted repository's own test, CI result or documentation becomes acceptance evidence without a Verifier's protected proposal and a Reviewer's or owner's approval. Is "copy under `.surety/checks/`" enough, or can the copy import the original (a relative import out of the protected root into Builder-owned source) so that the Builder still controls what the check runs? Does the conformance stage's `integrated` at the adoption revision with no Builder satisfy D1 §9.1's delivery rule and D1 §7.8's "a committed plan is schedulable by construction"? Is the conformance-phase `fix` rule (a roadmap revision instead of fix work) a loosening of F §6.2 or a faithful reading of E6? Can an owner's `confirm` of an observed requirement ever be made by a role or by default?
- **Pace (§7).** Every figure is from one-file stages or Verity's whole-fixture numbers; §7.2's table extrapolates. Is anything in §7 a claim rather than a measurement to come, and does Appendix C pin only instruments? Is K1's event-driven tick safe under D1 §1.5 (one tick at a time, `tick_budget`) when every finalizer requests one, and can it starve the safety prerequisites of D1 §8.1 steps 1 to 4? Does §7.6's read derive everything from rows that exist (D1 §12.2), with `unknown` where a row is missing, or does it need a new row D6 did not declare?

## Constraints

- Read-only. Do not change any file in the repository. Do not run a model or anything that spends money.
- Do not create, start, stop, restart or reload any unit under the user's service manager, and do not run `systemd-run` or `systemctl` with an action (E64; the M4 safety rules). Nothing in D6 needs a probe; if one would change your verdict, write exactly what should be observed under "Questions for Sean".
- Cite file paths and section numbers for every claim so Sean and I can check them.
- Keep proposed amendment text in D6's register: requirements a test can pin, not advice.
- If a question needs an answer from Sean before you can judge a section, list it under a final "Questions for Sean" heading rather than guessing.

When you are done, tell Sean the verdict in one line and where the file is.
