# Cross-review brief for D1 (handed to Astra, 2026-09-30)

Astra, this is a cross-review request for the first detailed-design document of the new harness, now working-named Surety. Same role as before: second architect, adversarial, against source. Nothing you write here is an implementation authorization.

## Read, in this order

1. `sdlc-framework-foundations-v1.0.md`: the agreed foundations. Unchanged since you accepted it.
2. `sdlc-foundations-v1.1-errata-draft.md`: seventeen amendments (E1 to E17) decided by Sean after a review of v1.0 against your review and Claude's. These include decisions O8 (product shape), O9 (stack), O10 (reuse of Verity). They are Sean's decisions and are not open for relitigation in this review. If D1 contradicts one, say so; if you believe one is wrong, file it as a separate note at the end, not as a D1 objection.
3. `sdlc-foundations-v1.1-appendix-b-decision-trail.md`: the reconstructed map from every foundations section and errata entry to the findings in the two reviews. Use it to check that D1 answers what it claims to answer.
4. `sdlc-design-D1-engine-core.md`: the document under review. Draft 1.
5. `mockup/README.md` and the eight `.dc.html` files: the accepted MVP UI. D1's API (section 11) and NOW projection (section 12.3) must be able to serve those screens; treat the mockup as a consumer of the API, not as a spec.

The git log in this directory shows the order these were produced.

## What D1 is

The engine's durable model and the mechanisms every later design builds on: identities, entities and state machines, the SQLite runtime store, engine-performed git with diff validation, scheduler and leases, the gate function, the attention queue, the local API, the event log, the ledger, records and redaction, the model-invocation choke point, crash recovery, security invariants, twenty acceptance scenarios, repository layout, and eight open questions. D2 (backend adapters, trust table, containment) and D3 (protected acceptance path, check runner, diff classifier) are not written yet; where D1 depends on them it says so.

## What I want from you

Write `sdlc-review-D1-Astra.md` with these sections, in this order.

**1. Verdict.** One of: approve; approve with the amendments in section 2 applied; reject with reasons. One paragraph.

**2. Blocking objections.** Each one: the D1 section, what is wrong, the evidence (a foundations or errata clause it violates, an incident from the Verity record it would reproduce, an internal contradiction, or something you verified by inspection), and proposed replacement text I can paste. Do not edit D1 yourself.

**3. Non-blocking suggestions.** Same shape, lower bar.

**4. The eight open questions in D1 section 20.** Your recommendation on each with one or two sentences of reasoning. Questions 2, 3, 4, and 8 are mine to decide; give me your recommendation anyway.

**5. Conformance table.** One row per errata entry E1 to E17: where D1 implements it (section numbers), or "gap" with what is missing.

**6. Scenario coverage.** One row per acceptance scenario A01 to A25 from your review's section 10: the D1 scenario that covers it, or "D2", "D3", "later", or "gap".

**7. Incident coverage.** One row per incident 1 to 20 in Claude's review, section 3.4: the D1 mechanism that prevents it, or "gap". This is the test I care about most. Each of those incidents cost real time and money.

**8. What you verified versus inferred.** Use your evidence labels from the last review. Where O10 names Verity modules to port, check they exist at the paths Claude's review section 8 gives and note any that do not.

## Where to press hardest

These are the places I am least sure of. Treat them as prompts, not as the only places to look.

- Section 9.3, the gate function. Is the input list complete against foundations 5.7, 6.1, 6.2, 6.3, and 3.11? Is anything in there that lets a non-passed check become a pass by another route?
- Section 8.3, fenced leases in a single-process engine. Over-engineered, under-engineered, or right for crash recovery and a future second worker?
- Section 6.1 and 11, one synchronous SQLite connection, server-sent event streams, and long git operations on one Node event loop. Where does this block, and does the per-step deadline in 8.5 actually save the tick?
- Section 7.3 step 2, the Verifier's protected-path changes becoming proposals. Does that path ever let a protected change reach the integration branch without a ProtectedVersion row?
- Section 11.3, "reads never call adapters." What does the environment's observed condition look like between ticks, and is a 30-second tick honest enough for the three-facts display?
- Section 7.6, out-of-band detection. Which branches are tracked, how do nomination tags and `surety/oob/*` refs avoid tripping it, and what happens to a developer's own feature branches in the same repository?
- Section 10.2, the decision dedupe key. Can two legitimately different questions collide, and can one question evade dedupe by a trivially different evidence hash?
- Section 15.2, sessions. You know the two CLIs' continuation mechanisms better than this document does. Say whether session mode is realistic on each at the versions you last canaried.
- Section 11.1, token plus Origin plus Host allowlist. Does this close the DNS-rebinding class you found in the console, and is anything in the console's 21 security invariants missing here?
- Scenario D1-02. Is "store is branch-independent" actually proven by that test as written?

## Constraints

- Read-only. Do not change any file in this directory. Do not run model benchmarks or anything that spends money. Read-only inspection of `~/projects/verity-framework` and `~/projects/verity-console` is fine and expected for section 8.
- Cite file paths and section numbers for every claim so I can check them.
- Keep proposed amendment text in the same register as D1: requirements a test can pin, not advice.
- If a question needs an answer from me before you can judge a section, list it under a final "Questions for Sean" heading rather than guessing.

When you are done, tell me the verdict in one line and where the file is.
