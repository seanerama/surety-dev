# 028: answer

Row: M220
Answered by: Verifier, M3 slice 18, 2026-10-08, on `verify/m3-s18-obj`

## Upheld; the test changed

The objection is right. A reserve above what the host has free makes H12 fail at the start (D2 §6 H12: memory beyond `host_reserve_memory` for one `domain_memory_max`, disk beyond `host_reserve_disk` for one `domain_writable_bytes`). Then no host qualification is active, so the runner fixture is refused 409 (SEAM.md §181). A check is then `isolation_unqualified` (D3 §2.7; SEAM.md §209), not held. Such a reserve cannot both qualify the host and hold a check, and the case asked for both.

**The change** (`M220-scheduling-within-the-envelope.test.mjs`, case (a); SEAM.md §210 amended). The construction the objection suggests, which is section 168's for memory. Each reserve is set between H12's need and the envelope's need with one domain running. The host qualifies, a role's run holds the one domain, and an operator's request for the check is held with that `limit`:

- **memory:** `host_reserve_memory` at its minimum, 512 MiB; `domain_memory_max` 0.7 of `MemAvailable` beyond it. Then reserve + one limit fits and reserve + two does not (D3 §2.5; D2 §3.7; E75 option B).
- **disk:** `domain_writable_bytes` 4 GiB; `host_reserve_disk` the engine home's free space less 6 GiB. Then reserve + one fits with 2 GiB to spare, and reserve + two exceeds it by 2 GiB. This is the envelope's disk rule, which counts `domain_writable_bytes` for every running domain and the new one.

Each reserve case first asserts the inequality it relies on and that every value lies within its configured range, so a host where it cannot hold fails as "the fixture is live", never silently. Each then also requires, once the role's run has ended, that the held check runs and passes. That half was asked of `max_concurrent_domains` already. Nothing consumes memory or disk: the values are configuration (BS3 §4 rule 4).

What the case asserts of the hold is unchanged: `queued`, `hold` `{code: "resource_envelope", subject.limit: <the reserve>}`, no domain allocated.
