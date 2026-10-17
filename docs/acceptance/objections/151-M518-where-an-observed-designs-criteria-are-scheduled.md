# 151: where an observed design's criteria are scheduled

Row: M518 (f) (slice 45)
Test: packages/engine/test/acceptance/M518-retrofit-the-observed-design.test.mjs, case "(d), (e) under at_alpha … (f) the criterion never in the conformance set"
Filed by: Verifier, slice 45, 2026-10-17 (a question for Sean, not a Builder's objection)

## Claim

D7 §12 says an observed design's "proposed criteria go through the same consolidated spec change, but **are scheduled to the first change phase, never to the conformance set**". It gives B11's reason: the conformance phase carries the code unchanged, and a design criterion the adopted code fails would block conformance on an aspiration. D7 does not say how a criterion is scheduled apart from its requirement.

- A criterion is written into the spec as `R<n>.<m>` under its requirement (D7 §7.2; B.13 `requirement: "R<n>"`).
- A requirement is in one phase.
- An observed design's criteria are naturally about the observed, confirmed requirements, which are the conformance set's.

Three readings, each consistent with the text:

- (a) The criterion stays under its requirement (R5.2 under R5), and the engine keeps it out of every conformance-phase gate's acceptance scope. Its check and obligation belong to the first change phase's gates.
- (b) The Spec Writer, told so by the change request, writes each such criterion as a new `intended` requirement in the first change phase. But E156 Q3 leaves a `requirement: "new"` criterion `REQUIREMENT_UNASSIGNED` until an approved roadmap revision assigns it, so "scheduled to the first change phase" would need the engine to assign it, as E156 Q3 does only for the human tests.
- (c) The change request carries the schedule, and the impact (D6 §4.4) registers the criterion's obligation against the first change phase.

What slice 45 pins, without choosing among them (SEAM §528): the negative half, which holds under every reading. With the observed design's criterion (R5.2 on R5) approved and its check failing on c-1:
- the conformance stage is `conformed` and phase 1 completes;
- no stage or phase gate evaluation that is not satisfied names R5.2 or its check;
- R5.2 is in no conformance stage's `validation.criteria`.

The scripted Spec Writer writes R5.2 under R5 (reading (a)'s text). The positive half, where the criterion then lives, is not asserted.

On `build/m6-s40` at `348ad12`, with the rest of the case worked past on a scratch copy, R5.2 enters phase 1's scope: with its check failing, phase 1 does not complete; with it passing, phase 1 completes, but phase 1's earlier gate evaluations list R5.2's check as missing.

**Asked:** which reading? If (b), the engine's narrow assignment of E156 Q3 would extend to these criteria. If (a) or (c), the next Verifier pins where the obligation is read, for example phase 2's first gate naming R5.2.

## Sources

- D7 §12; §7.1; §7.2; B.13; B11's reasoning (D6).
- M6 plan §3.7 M518 (f): "scheduled to the first change phase, never the conformance set".
- E156 Q3; BS6 §11.5.
