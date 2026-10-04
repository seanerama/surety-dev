# 011: M131 (c) restarts the engine without holding the provider key again, so the Resume is refused before launch, as E62 asks of a key that cannot be resolved

Row: M131 (c)
Test: packages/engine/test/acceptance/M131-usage-resume-session-id.test.mjs, case "(c) A12: …", lines 139 to 148 (`await fx.engine.kill(); await fx.start();` … `await standIn.waitForLaunch({}, { timeoutMs: 60_000 })`)
Filed by: Builder, M2 slice 13, 2026-10-04

## Claim

The case holds the provider key once, in `claudeVerifierProject` (`holdSecret(fx.engine, apiKeyRef(BACKENDS.claude), …)`), kills the engine at `launcher.before_authorization` and starts it again. The resolver holds secrets in the engine's memory only (SEAM.md §57: `POST /v1/harness/secrets`), so after the restart `backend/claude/api_key` cannot be resolved. The brief for this slice, from E62's recorded item ("a missing provider key launches the binary without one rather than refusing"), asks that a real backend's launch be refused when its key reference cannot be resolved; `build/m2-s13` does that (`backend_refused`, `refusal.subject.reference` the reference, before any launcher starts). So the Resume's run is refused and the case times out waiting for the stand-in:

```
error: 'timed out after 60000 ms waiting for a launch of the stand-in binary matching {}'
```

Everything before the restart passes on `build/m2-s13` (the receipt's `provider_session_id` is the derivation from its id before `domain.placed`; the run holds the same id; recovery ends the first run `recovered` with the stand-in never launched). M134's own `restart` helper holds the key again after every start, for the same reason.

## Proposed change

Hold the key again after `fx.start()` in (c), as M134's `restart` does (`await holdSecret(fx.engine, apiKeyRef(BACKENDS.claude), key)`, the same value kept in a variable). No assertion changes.

## Sources

- E62, "Suspected, not confirmed as serious": "a missing provider key launches the binary without one rather than refusing" (assigned to slice 13).
- D2 §§1.2, 2.5: the environment carries "the secrets the grant names"; the resolver passes values only.
- SEAM.md §57 (the harness's secrets are held by the running engine), §116 (the provider key's reference).
