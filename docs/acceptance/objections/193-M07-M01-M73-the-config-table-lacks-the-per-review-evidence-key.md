# 193: the Verifier's configuration table lacks `design_review_evidence_max_review_bytes`, the per-review key SEAM.md §522 names and M528 (c) reads

Row: M07 (project bootstrap and policy), M01 (kernel journey), M73 (executable contract); M528 (c) (slice 45)
Test: packages/engine/test/acceptance/contract/config.json (the Verifier's closed configuration); read by M07-project-bootstrap-and-policy.test.mjs, cases "a policy file that was in the repository before the project existed …" and "is committed through the journal, recorded as a revision, …"; M01-kernel-journey.test.mjs, case "runtime data stays outside tracked source"; M73-executable-contract.test.mjs, case "the contract holds the accepted corrections, as the Verifier's tables state them …"
Filed by: Builder, slice 45, 2026-10-17

## Claim

SEAM.md §522 (slice 45's Verifier): "the files together past **`design_review_evidence_max_review_bytes` †**, the per-review bound of D7 A.7's '512 MiB per review': a project policy key in bytes, default 536870912, its range not pinned." M528 (c) asserts the key in the project's effective policy at 536870912, and M528 (b) lowers it by a policy change. Slice 45 adds it (`src/config/schema.ts`), so `api/schema.json` and `appendix-a.md` are regenerated with it and `surety contract check` has no findings.

`contract/config.json` still says (its `$comment`) "`design_review_evidence_max_bytes` (64 MiB per file …; the 512 MiB per review has no key, M528's) … Slices 41 to 45 read these keys and add none", and its `project` table has no entry for the new key. So three earlier files fail on the key alone, observed on `build/m6-s45` (each run alone, `TMPDIR=/tmp/b45`):

```
M73: the project configuration keys … + 'design_review_evidence_max_review_bytes',
M07: the effective policy is the schema defaults … + design_review_evidence_max_review_bytes: 536870912,
M07: and the schema defaults are in effect … + design_review_evidence_max_review_bytes: 536870912,
M01: design_review_evidence_max_review_bytes is a project key
```

**Asked:** `contract/config.json`'s `project` table gains

```json
"design_review_evidence_max_review_bytes": { "default": 536870912, "min": 1048576, "max": 17179869184, "integer": true }
```

(the same form as `design_review_evidence_max_bytes`), and the `$comment` says slice 45 adds it. The range is the Builder's, since §522 leaves it unpinned: 1 MiB (the per-file key's minimum) to 16 GiB (eight times the per-file key's 2 GiB maximum). If the Verifier pins another range, I will change the engine to it.

One note for the reader of the key: the review route's body cap (`src/design/evidence.ts`, `REVIEW_BODY_CAP`) is the default 512 MiB, base64, so a review whose files together pass 512 MiB is refused at the transport (413 `payload_too_large`) even where a raised key would allow it. The per-review key bounds downward only in practice; raising the transport cap with it would mean reading a body of several GiB as JSON.

## Sources

- SEAM.md §522 (the key, its default, "its range not pinned"); §516.
- D7 A.7 (`design_review_evidence_max_bytes`: "64 MiB per file, 512 MiB per review"; range "1 MiB to 2 GiB per file").
- BS6 §11.1 (the table's `design_review_evidence_max_bytes` row, pinned by M528 (c)).
