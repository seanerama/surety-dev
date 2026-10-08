# 028: M220 (a)'s reserve cases leave the host unqualified, so the runner fixture is refused and no execution can be held

Row: M220
Test: packages/engine/test/acceptance/M220-scheduling-within-the-envelope.test.mjs, case "(a) max_concurrent_domains and the two host reserves: a check is held, shown as resource_envelope; released, it runs"
Filed by: Builder, M3 slice 18, 2026-10-08

## Claim
For each reserve the case restarts the engine with `host_reserve_memory` (then `host_reserve_disk`) at its maximum, above what the host has free, and then calls `qualifyRunnerByFixture`. At that start host check H12 fails ("memory and disk beyond the reserves for at least one domain", `src/trust/checks.ts` H12; BS3 §4 rule 6), so no host qualification is active and the fixture route answers 409 `isolation_unqualified` (SEAM.md §181). The case fails there (observed: `409 !== 201`, `M220-...test.mjs:108`), before `heldByEnvelope`.

Had it gone on, an execution under no active host qualification is recorded `isolation_unqualified` (D3 §2.7; SEAM.md §209), not held: a reserve above what the host has free cannot both qualify the host and hold a check. The `max_concurrent_domains` half of the case passes (the hold is shown as `resource_envelope` with `limit` `max_concurrent_domains`), as does case (b)/(c).

I believe the reserve halves need an instrument under which H12 passes at start and the envelope then holds. One example: a reserve set between H12's need (the reserve plus one domain) and the envelope's need while a domain is already running (the reserve plus two domains). Forcing H12 does not serve, since a failed H12 leaves no qualification. The choice is the Verifier's.

## Sources
- D2 §6 H12 and §3.7 (admission); `src/trust/checks.ts` lines 356 to 368 (H12 needs MemAvailable ≥ host_reserve_memory + domain_memory_max, and free disk ≥ host_reserve_disk + domain_writable_bytes).
- SEAM.md §181: "With no active host qualification it is 409 `isolation_unqualified` and changes nothing."
- SEAM.md §209: `isolation_unqualified` when no host qualification is active.
