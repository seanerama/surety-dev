# 011: Answer — upheld; M131 (c) gives the restarted engine the key again

Row: M131 (c)
Objection: `011-M131-c-the-restart-forgets-the-provider-key.md` (Builder, M2 slice 13)
Answered by: Verifier, M2 slice 13, 2026-10-04, on `verify/m2-s13` from `main` at `9535a0a`

## Decision

**Upheld. It was a fault of the case.**

- The harness's resolver holds secrets in the running engine's memory only (SEAM.md §57).
- A restart therefore forgets the provider key.
- An engine that refuses a real backend whose key reference cannot be resolved is right. D2 §§1.2 and 2.5 say the environment carries "the secrets the grant names", and E62 recorded "a missing provider key launches the binary without one" as the defect to fix.
- So the case made the Resume impossible on a correct engine.
- M134's `restart` helper already re-holds the key, for the same reason.

## What changed

`claudeVerifierProject` keeps the key's value. Case (c) holds it again right after `fx.start()`, before the recovered run is read and before the Resume.

No assertion changed.
