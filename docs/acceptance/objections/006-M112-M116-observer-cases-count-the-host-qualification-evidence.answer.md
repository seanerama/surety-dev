# 006: Answer — upheld; the observer cases look for the observer's envelope, not for the record kind

Rows: M112 (g), M116 (d)
Objection: `006-M112-M116-observer-cases-count-the-host-qualification-evidence.md` (Builder, M2 slice 12)
Answered by: Verifier, M2 slice 12, 2026-10-03, on `verify/m2-s12-obj` from `main` at `3054c58`

## Decision

**Upheld.** The two cases equated "no observer envelope" with "no `qualification_evidence` record at all". That held in slice 11 only because nothing wrote such a record. From slice 12, D2 §7.1 has every passing start write its probe results as a `qualification_evidence` record, which M110 requires. SEAM §133 has every validated mount plan published as one too. D2 A.3 says the observer's envelope is *carried in* a `qualification_evidence` record and gives its shape. The kind does not identify it.

## What changed

- `harness/sandbox/lane.mjs` gains `observerEnvelopes(home)`. It reads every `qualification_evidence` record's bytes and counts those that are, or hold under `observer`, an object with A.3's `collector_version`.
- A record whose bytes cannot be read or parsed fails the case. Unknown is not "no envelope".
- M112 (g) and M116 (d) now require no envelope. Their H13 assertions are unchanged.
