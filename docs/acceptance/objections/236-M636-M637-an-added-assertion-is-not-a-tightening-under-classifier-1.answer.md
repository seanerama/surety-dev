# 236, answered: upheld, option 1; M636 (b) and M637 (b) add a check beside the existing one, an edited input is M636 (e)'s unclassifiable case

Answer to objection 236 (Builder B, build/item57-checks-findings-clock 050ce8f6), by Verifier 2 on `verify/item57-v2`, 2026-11-26.

**Upheld, option 1.** The driver's ruling during the rulings batch, recorded in DECISIONS item 57 ("2026-11-26 ~02:30Z — the driver's rulings during the rulings batch", flagged for Sean): "Objection 236 (Builder B): option 1 adopted as implementation. Classifier version 1 classifies an ADDED check as a tightening and an edited input file (`input_changed`) as unclassifiable, so under D2 an added assertion in an existing scenario goes to Sean, as the ruling says. The rows' (b) cases are therefore realised by a correction that adds a check covering the criterion beside the existing one; D3's "verifiable" = a failed established result of any required acceptance check covering the finding's criterion on the finding's candidate, the finding's `check` bound to that check with the old one kept in its history, and the resolution verified by it."

The rows are amended on `driver/item57-rulings-rows` 8e36459e (M7 plan §3j M636 (b), (e); M637 (b), (c); M646).

The objection's reading of classifier 1 is confirmed against `packages/engine/src/checks/classify.ts`: `input_changed` and `unhandled_change` are in `UNCLASSIFIABLE_REASONS`, and `kindOf` makes a proposal unclassifiable if any element is. A further fact the files rely on: a definition that declares no `inputs` takes every file under the protected roots as its input manifest (checks/schema.ts `expandInputs`, Q3 (a)), so under the default any added file under `.surety/checks/` is `input_changed` for every such check. The acceptance files' check trees therefore declare `inputs: []` (or their own scenario file), so that an added check is the classifier's `check_added` alone.

## What changed (tests only)

`packages/engine/test/acceptance/M636-the-brief-authorizes-its-own-check-tightenings.test.mjs`:
- (b): phase 2's authoring adds `accept-r1-order` beside `accept-r1`, covering R1.1 with the same approved command and its own new scenario file; applied by policy as (a).
- (e): the unclassifiable proposals are an added assertion inside an existing check's declared input file (`input_changed`) and, separately, an existing check's timeout changed; each the owner's `check_correction_unclassifiable` question with the policy's reason.

`packages/engine/test/acceptance/M637-a-verifiable-defect-is-repaired-within-the-brief.test.mjs`:
- (b): X (`accept-r3x`) passes on C; the Verifier's correction adds Y (`accept-r3y`) covering R3.1 beside X, applied by policy; Y fails on C; F's `check` is bound to Y with X kept in its history (read as an event about F naming both, or X on F's row); then (a) with Y as the verifying check (`resolution_verification` names Y's passing result on the fix's candidate).
- (c): X and Y both still pass on C under the corrected version: the owner's `finding_disposition` question, its recorded reason saying the repair could not be verified.

Nothing else in either file changed for this answer.
