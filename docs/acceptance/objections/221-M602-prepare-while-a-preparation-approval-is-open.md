# 221: `POST …/iterations/:i/prepare` while a preparation approval is open answers 201, not the 409 that row M602 (d) requires

Row: M602 (the owner's draft M7 plan, `docs/acceptance/sdlc-M7-acceptance-plan.md` §3)
Test: packages/engine/test/acceptance/M602-preparation-is-authorized-before-it-runs.test.mjs, case "(d) …/prepare after a failed preparation: a new approval; 409 while one is open"
Filed by: Verifier, branch verify/rapid-prototype (merged up to the Builder's build/rapid-prototype 4bb74433, slice E5), 2026-10-28
For: the Builder (an engine change); the owner if he reads the row otherwise

## Claim

Row M602 (d) names two cases for `…/prepare`. After a failed preparation it must give "a new approval". While a preparation approval is open, it must give "409".

The engine at 4bb74433 meets the first. The test observed every part of it:

- the failed run is never repaired;
- the iteration is `preparing`, next step "prepare again or discard", and the reason names the run;
- its work is cancelled;
- `…/prepare` answers 201 with a new `prototype_preparation_approval`.

The engine does not meet the second. While that new approval is open, a second `POST …/prepare` answers **201** with a decision, not 409. No second question is raised: the open list still holds the one question, and nothing more is run. The same 201 comes back when `…/prepare` is called right after creation, while the first iteration's question is open.

Observed, the file run alone (`node --test`, `TMPDIR=/tmp/rpv-m7`): tests 4, pass 3, fail 1. The failure is the last assertion of (d), after every other assertion of the case passed:

```
…/prepare while a preparation approval is open (→ 201 {"decision":{"id":"dec_01M62BS7FT2VF9GGDK7H140SQB","kind":"prototype_preparation_approval","status":"open","preview_hash":"2c0b3449…"}})
expected: 409
actual: 201
```

What the engine does (`packages/engine/src/prototype/brief.ts` `requestPreparation`):

- It refuses 409 only while a preparation the owner has **authorized** is not over (`preparationPending`, a `brief_preparation` work item not complete, cancelled or parked).
- It does not check for an open `prototype_preparation_approval`. It calls `raisePreparation`, whose `raiseQuestion` gives back the question already open, and answers 201 with it.

The response does not say that it is the question already open. A client cannot tell a new approval from an existing one.

I keep the assertion as the row states it. The Builder can make the route refuse while a `prototype_preparation_approval` of the iteration is open: 409 `illegal_transition`, naming the open decision, as the route already does for an authorized preparation not yet over. If the owner prefers the idempotent answer (201 with the open question, marked as the existing one), the row should say so. That is the owner's to decide; the test changes only on his ruling.

## Sources

- The owner's draft M7 plan, row M602, case (d): "`…/prepare` after a failed preparation; while a preparation approval is open." The required result: "(d) a new approval; 409 while one is open."
- The owner's ruling R5 of 2026-10-28 (`PROPOSAL-2026-10-28.md` §7): the preparation is authorized before it runs, one run per approval.
