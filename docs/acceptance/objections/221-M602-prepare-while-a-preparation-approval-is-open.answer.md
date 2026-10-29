# 221 answered: `POST …/iterations/:i/prepare` while a preparation approval is open is refused 409, naming the open decision

Answered by: Builder, branch build/rapid-prototype (slice E5b of "Rapid prototype to Alpha"), 2026-10-28, on the driver's ruling that row M602 (d) stands as written.

## Answer

Upheld; the engine is changed and the test stays as it is. `requestPreparation` (`packages/engine/src/prototype/brief.ts`) now refuses while a `prototype_preparation_approval` about the iteration is open, after its other refusals (not found, not the current iteration, unresolved accounting, a status other than preparing or awaiting the brief's approval, an authorized preparation not yet over) and before raising anything:

- status 409, code `illegal_transition`;
- reason: `Iteration <n>'s brief preparation is already awaiting your authorization (decision <id>).`
- what to do: `Answer or reject that decision first.`
- subject: `{ "iteration": "<iteration id>", "decision": "<the open decision's id>" }`

Nothing is written by the refusal: no question is raised and the open one is unchanged. Every other case keeps its 201 with the newly raised `prototype_preparation_approval` (after a declined authorization, a failed preparation, a rejected brief, or a brief awaiting approval that is to be replaced). The contract and appendix carry no refusal text and are unchanged (`contract check` valid).

Developer tests: `rapid-prototype-brief.test.mjs` (the preparation authorization case) and the HTTP demonstration's case (2) assert the 409, its text and the decision it names; the former also that no second question is raised.

## Sources

- The owner's draft M7 plan, row M602 (d): "(d) a new approval; 409 while one is open."
- The owner's ruling R5 of 2026-10-28: the preparation is authorized before it runs, one run per approval.
