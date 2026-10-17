# 191: M518 (a) expects `design_due` open after a refused retrofit close under `before_build`, but no UI stage is held in the conformance phase, so D7 §11 raises none

Row: M518 (a), (d), (e) (slice 45)
Test: packages/engine/test/acceptance/M518-retrofit-the-observed-design.test.mjs, case "(a) a retrofit-mode Designer session: … (d), (e) under before_build DESIGN_CONVENTION_UNKNOWN and DESIGN_INTERFACE_SHAPE_UNKNOWN block approval"
Filed by: Builder, slice 45, 2026-10-17 (a question for the driver or Sean, not only a test change)

## Claim

After the refused close, the case asserts:

```js
assert.deepEqual([closed.status, closed.body?.code], [422, 'design_check_failed'], …);
assert.ok(openDesignDue(fx.home, p.id), 'design_due open: no silent stall');
```

On `build/m6-s45` everything before that line passes (the package says retrofit and carries the adopted pages under `design/source/`, the inventory lists `history-feed` `shape_known: false` with no obligation and no fixture, the save is refused with `DESIGN_CONVENTION_UNKNOWN` on S2 and `DESIGN_INTERFACE_SHAPE_UNKNOWN` on S1 and S2, the close is 422 `design_check_failed`), and this line fails: no `design_due` exists.

D7 §11 raises `design_due` "when a UI stage is first held `design_pending` or `design_stale`, when a design is rejected or sent back for revision, and on `alpha_complete`". At this point Shelf has only its conformance plan. The conformance stage builds nothing: it is integrated at publication (`source_bound`) and has no `stage_build` work, so nothing carries the `design_ready` milestone and nothing is held (`heldStages` is empty). No design was rejected or sent back, and there is no Alpha. None of the three triggers has fired.

Nor is this a silent stall in BS6 §4.1 rule 25's sense: the Designer session is still open (a refused close ends nothing; the owner's next act is a turn), and the conformance phase is not waiting on the design at all (D7 §12, B11).

I have not made the engine raise `design_due` on a refused close, or hold the conformance stage under `before_build`. Either would be a new rule: the first is not among §11's triggers; the second would make conformance wait on a design approval, against §12's "never the conformance set" and B11's reasoning.

**Asked**, one of:
- (a) the case drops the assertion, or asserts what holds: the session is still open (its run not ended) and no design revision is approved; or
- (b) a ruling that under `before_build`/`both` an adopted project's conformance stage is a held UI stage (then the engine holds conformance until the observed design is approved and ready, which I would build), or that a refused Designer close raises `design_due` (D7 §11 would need the trigger).

I recommend (a). The first UI stage of the first change phase is held, and raises `design_due`, as in every other project.

## Sources

- D7 §11 (the three triggers; "A Designer session that ends without a product … leaves `design_due` open", which presupposes it open); §12; §8.2 (holds are on UI stages' builds).
- B11's reasoning (D6), quoted in D7 §12.
- BS6 §4.1 rule 25.
- `src/design/readiness.ts` `heldStages` (holds read `stage_build` work with the `design_ready` milestone); `src/adopt/conformance.ts` (the conformance stage integrated at publication).
