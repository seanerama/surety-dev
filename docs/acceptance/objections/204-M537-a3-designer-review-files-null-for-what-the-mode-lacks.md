# 204: M537 (a3) requires every `designer.review.files` member to name a file; the slice-46 review's S4 has the engine name only the files the package holds, `null` for the rest

Row: M537 (a3) (slice 46)
Test: packages/engine/test/acceptance/M537-the-designers-and-verifiers-packages-state-what-the-engine-reads.test.mjs, case "(a3) the base elements and designer.review: the build identifier verbatim and owner_reported, each evidence file owner_supplied, no engine observation"; harness/design/packages46.mjs `elementProblems`, case `designer.review`
Filed by: Builder, slice 46, 2026-10-17

## Claim

`elementProblems` requires

```js
need(isObj(v.files) && ['review', 'approved', 'source', 'check_results', 'observations', 'evidence'].every((k) => text(v.files[k])), …)
```

that is, each of the six members must be a non-empty string, whatever the mode. The slice-46 review's S4, which the coordinator passed to the Builder, asks that `designer.review.files` list only the files present in that mode, with `null` for the absent ones. Two kinds of file can be absent:

- one the mode never has: an owner-invoked review has no `design/observations.json` (the engine observes nothing of an owner's build), and a review at Alpha has no `design/evidence.json`;
- one the package does not hold this time: no `design/approved/` before any design is approved (a first design at Alpha), and no `design/source/` when no candidate is named or no `ui` module has paths.

A path named for a file that is not there tells the Designer to read something it cannot find. The engine now states (on `build/m6-s46`, `f3fbc8c`):

```
owner-invoked: {"review":"design/review.json","approved":"design/approved/","source":null,"check_results":"design/check-results.json","observations":null,"evidence":"design/evidence.json"}
```

So (a3) fails on that member alone (`TMPDIR=/tmp/b46`, the file alone; the other five cases pass):

```
- designer.review: files: review, approved, source, check_results, observations, evidence (got {"review":"design/review.json","approved":"design/approved/","source":null,"check_results":"design/check-results.json","observations":null,"evidence":"design/evidence.json"})
```

**Asked:** `elementProblems` checks `files` as: each of the six keys present, each a non-empty string or `null`. For an owner-invoked review (`facts.review` given), `observations` is `null` and `evidence` names a file. SEAM.md §538's `designer.review` row says so.

In the same element, S4 also states the owner's `observed_on` as `{value, provenance: "owner_reported"}` (the file stays `owner_supplied`). The case does not read `observed_on`, so nothing else changes.

## Sources

- The slice-46 review's S4 (via the coordinator, 2026-10-17): "`designer.review.files` lists only the files present in that mode, with `null` for the absent ones."
- SEAM.md §523 (the review package's files: `design/approved/…` "Absent when none is approved"; `design/evidence.json` for owner-invoked reviews; `design/observations.json` beside §489's observations).
- D7 §10.5 (an owner-invoked review: the engine observes nothing of the build).

## Decision

Upheld by the driver under the owner's delegation, 2026-10-17 (Verifier, `verify/m6-s46b`; checked against `build/m6-s46` `9a7e58b`).

- `harness/design/packages46.mjs` `elementProblems`, `designer.review`: each of the six `files` members must be present and be a path or `null`. `review` is always a path. The modes are checked as follows:
  - an owner-invoked review (`owner` an object): `observations` is `null` and `evidence` is a path;
  - a review at Alpha (`owner` `null`): `observations` is a path and `evidence` is `null`;
  - `approved` and `source` may be `null` in either mode, for a package that does not hold them.
- SEAM.md §538's `designer.review` row says so. It also gives the owner's `observed_on` in S4's form, `{value, provenance: "owner_reported"}` or `null`.
- The Designer fake's review mode now writes that `value` (or a bare value) on the screens it judges, never the object.

M537 (a) passes 6 of 6 on `9a7e58b` with these files, run alone. SEAM.md §546 records this decision.
