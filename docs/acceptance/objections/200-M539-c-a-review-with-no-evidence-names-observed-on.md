# 200: M539 (c)'s review with no evidence passes `--observed-on device`, which the review route refuses

Row: M539 (slice 46)
Test: packages/engine/test/acceptance/M539-the-pace-reads-design-figures.test.mjs, suite "M539 (c) a review with no evidence: its evidence by provenance unknown, never zero" (its `before`), case "(c) the review's evidence is {unknown} with its reason"
Filed by: Builder, slice 46, 2026-10-17

## Claim

The fixture opens the owner-invoked review with

```js
designReview(fx, d.p.id, { target: 'android', build: 'pantry 3.0 (60)', observedOn: 'device' })
```

and no evidence. `designReview` (harness/design/review45.mjs) passes `--observed-on device`. Since slice 45 (`6de71a1`, the slice-45 review's N10) the route refuses `observed_on` without evidence, because it says where evidence was seen and there is none:

```
surety design review with no evidence exits 0 ( 400 {"code":"invalid_value","reason":"\"observed_on\" says where your evidence was seen, and this review carries none.","what_to_do":"Leave observed_on out, or send the evidence it is about (--evidence).","subject":{"field":"observed_on"}}
)
```

Observed on `build/m6-s46` (`TMPDIR=/tmp/b46`, the file alone): the `before` fails, so the case is cancelled. The other ten cases of the file pass.

The test was written against `main`, which did not have slice 45's refusal yet. Nothing in the case needs `observed_on` on the review: the B.14 screen the session writes keeps its own `observed_on: 'device'`, which is a field of the review file, not of the request.

**Asked:** drop `observedOn: 'device'` from that one `designReview` call. Run so on this branch (a copy of the fixture under `/tmp/b46`, not the test file), the review opens, its session records the review, and the pace read gives

```
{"review":"drv_…","subject":"owner_build","seconds":2.262,"deltas":{},"evidence":{"unknown":"the review recorded no evidence"}}
```

which is what the case asserts.

## Sources

- SEAM.md §540, `reviews[]`: "`evidence` by provenance, `{unknown}` for a review that recorded no evidence".
- D7 §10.5: `observed_on` is where the owner saw what his evidence shows.
- `src/design/owner-review.ts` (slice 45, the review's N10): "It says where evidence was seen; with none, it says nothing."

## Decision

Upheld by the driver under the owner's delegation, 2026-10-17 (Verifier, `verify/m6-s46b` from `build/m6-s46` `60cefbc`).

The `designReview` call in M539 (c)'s fixture no longer passes `observedOn`. Since slice 45 the route refuses `observed_on` on a review with no evidence, because it says where evidence was seen. The screen the session writes keeps its own `observed_on: device`, which belongs to the review file and not to the request. The case's assertion is unchanged: the review's `evidence` reads `{unknown}` with its reason, never `{}` or zero. SEAM.md §540 says so, and §546 records this decision.
