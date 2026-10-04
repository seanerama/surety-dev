# 006: The observer's `[not_exercised]` cases of M112 (g) and M116 (d) count every `qualification_evidence` record, and a qualified host writes one for its host qualification

Row: M112, M116
Test: packages/engine/test/acceptance/M112-placement-and-launch-authorization.test.mjs, case "(g) [not_exercised] the observer's record of a late launcher …" (lines 231 to 232); packages/engine/test/acceptance/M116-membership-cannot-be-escaped.test.mjs, case "(d) [not_exercised] attribution with the observer …" (line 164)
Filed by: Builder, M2 slice 12, 2026-10-03

## Claim

Both cases assert that "no observer evidence envelope exists" by requiring that the store holds no record of kind `qualification_evidence` at all:

```
const envelopes = withStore(fx.home, (db) => db.prepare(`SELECT "id" FROM "records" WHERE "kind" = 'qualification_evidence'`).all());
assert.deepEqual(envelopes, [], 'no observer evidence envelope exists (no qualification_evidence record at all)');
```

That held in slice 11 only because no host qualified there. From slice 12 every passing start writes its `host_qualifications` row with "the probe suite's results as a `qualification_evidence` record" (D2 §7.1; A.3 `host_qualifications.evidence* →records`), which `M110-qualification-per-start.test.mjs` (a) requires ("the row's evidence is a published engine-scoped qualification_evidence record"). On `build/m2-s12` the host qualifies, so both cases fail on that record, which is the host qualification's evidence and not an observer envelope:

```
not ok 4 - (d) [not_exercised] attribution with the observer: …
  error: no observer evidence envelope exists
  + [ { id: 'rec_01M41S3JBZE7BFPV65MRYCC73D' } ]
  - []
```

The two cases' other assertions (H13 `not_exercised`, with a reason) pass. Every other case of both files passes on the same engine.

## Proposed change

Look for the observer's envelope, not for the record kind: D2 A.3 gives the envelope's shape (`{collector_version, kernel, hooks[], capture_scope, bindings, interval, loss, complete}`, carried in a `qualification_evidence` record), so a case can require that no `qualification_evidence` record holds an object with `collector_version` (or that no record other than the host qualifications' `evidence` exists). The engine writes no observer envelope (H13 is `not_exercised`).

## Sources

- D2 §7.1: "A pass writes a `host_qualifications` row (…, the probe suite's results as a `qualification_evidence` record, …)".
- D2 A.3: `host_qualifications … evidence* →records`; "Observer evidence envelope (§3.9), carried in a `qualification_evidence` record".
- M2 plan §3.2 M110 (a): "one `host_qualifications` row `active` with … an `evidence` record".
