# 205: M537 pins B.14's delta to `{state, owner_words, kind}`; F4's ruling adds the optional `criterion` and `check` the engine now reads, and the package must state them

Row: M537 (a1), (a3), (a4) (slice 46)
Test: packages/engine/test/acceptance/M537-the-designers-and-verifiers-packages-state-what-the-engine-reads.test.mjs, cases "(a1) the Designer's session package states the inventory, B.8 to B.16, …", "(a3) the base elements and designer.review: …", "(a4) the base elements and designer.retrofit: …"; harness/design/packages46.mjs, the B.14 entry of the schema expectations (line 170)
Filed by: Builder, F4 (`build/f4`), 2026-10-18

## Claim

The harness requires the Designer's `designer.schemas` B.14 entry to hold exactly these delta fields:

```js
'screens[].deltas[]': ['state', 'owner_words', 'kind'],
```

compared with `sameSet`. Sean's F4 ruling (2026-10-18), as the driver's contract for this branch reads it (item 2), adds two optional fields to a delta, accepted in the review file and in the confirmation's edits: `criterion` (a criterion of the requirement index in force) and `check` (a check of the effective protected version covering it; only with `criterion`). The Verifier's own F4 cases at `711da7f` write them in a review file and require the design check to pass on them (M531 (j): "a delta proposing a criterion and its covering check passes the review file's check (B.14)") and to refuse a check that does not cover its criterion (M531 (j), the close refused `design_check_failed`).

The engine reads them, so M537's purpose ("the packages state what the engine reads", SEAM.md §538) requires the package to state them; leaving them out would tell the Designer, in a closed schema (`additionalProperties: false`), that the fields the review-mode instruction asks it to write are not allowed. The engine on `build/f4` now states:

```
screens[].deltas[]: state, owner_words, kind, criterion, check   (required: owner_words, kind)
```

The expectation should read:

```js
'screens[].deltas[]': ['state', 'owner_words', 'kind', 'criterion', 'check'],
```

Observed (`TMPDIR=/tmp/bf4/r4`, the file alone, after `npm run build` on `build/f4`): 3 pass, 3 fail, each failure this one gap alone:

```
- designer.schemas: B.14 .surety/design/reviews/review-<n>.json screens[].deltas[]: the fields ["kind","owner_words","state"] (got ["check","criterion","kind","owner_words","state"])
```

(the same line for the session package (a1), the review-mode package (a3) and the retrofit-mode package (a4)).

## Sources

- Sean's F4 ruling (2026-10-18): "link a confirmed implementation difference to the criterion it actually concerns. If that relationship is not established, record it without a criterion or check."
- The driver's contract for `build/f4`, item 2: "A delta gains optional `criterion` … and `check` … Accepted both in the review file (B.14 delta `{state?, owner_words, kind, criterion?, check?}` …) and in the confirmation's `edits`."
- M531 (j) at `711da7f`: the Designer's review file proposing `criterion: 'R3.2', check: 'marker-android'` on a delta passes the review file's check, and the confirmed finding names them.
