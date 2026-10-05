# 017: Answer — upheld; (a) and (b) pause until the lease has expired on the engine's own clock

Row: M118 (a), (b) (sandbox lane)
Objection: `017-M118-a-b-pause-margin-under-clock-steps.md` (Builder, M2 slice 14)
Decided by: Sean, E76 item 3: keep the wall clock for lease expiry; the test waits until the lease has really expired on the engine's clock; the residual effect is listed as not claimed.
Answered by: Verifier, M2 slice 14, 2026-10-04, on `verify/m2-s14-017` from `main` at `4b961a0`

## Decision

**Upheld.** The fault was the case's. A fixed pause of `lease_ttl + 3` s assumes 33 s of real time is at least 30 s on the clock that judges the lease. On this host the wall clock steps back about every 31.6 s, so that does not hold.

When it fails:
- the engine continues with the lease not yet expired by its rule;
- it rightly sends no challenge;
- the case waits for an event the rule does not call for.

The Builder's reproduction shows it deterministically: the engine's wall clock stepped back 5.8 s inside the pause fails (a) and (b) 3 of 3, and the unstepped controls pass. The rule itself is Sean's and stays as it is.

## What changed (M118 (a) and (b) only)

- **`pauseUntilExpired(fx, runId)`** replaces the fixed pause for (a) and (b), as the objection's first option proposes. The engine is stopped and stays stopped for at least `PAUSE_MS` of real time (`lease_ttl` + 3 s, as before). It is then kept stopped until the wall clock has passed two things by `MARGIN_MS` (2 s):
  - the stored `expires_at`, read from the store while the engine is stopped;
  - the stop time plus `lease_ttl`, which covers a renewal the engine may have been writing, uncommitted, when it was stopped.

  The wall clock used is this host's, which is the clock the engine will read on continuing.
- **The ceiling.** If that has not happened within `lease_ttl` + 60 s of real time (monotonic), the engine is continued and the case fails with its reason: the stored expiry, the stop time, the wall clock now.
- **"After the pause"** keeps the midpoint rule, measured on the pause actually made (`afterPause`).
- **What (a) and (b) pin is unchanged:**
  - (a): a fresh challenge with its nonce, sent and answered after the pause; the re-grant on the same generation; `expires_at` renewed; the deadline unchanged; no buffered heartbeat's renewal before the re-grant; the run completing clean.
  - (b): the dropped response re-granting nothing; no buffered heartbeat renewing; the run recovered through the boundary; the work held.

Cases (c) to (g) keep the fixed pause; their outcomes do not depend on the lease having expired. Case (c)'s failure was an engine defect, fixed on `build/m2-s14` at `c7d533b` (E76 item 3).

## What is not claimed (Sean, E76 item 3)

A run paused just past its lease, whose role goes on heartbeating, can be renewed by those heartbeats without a fresh challenge on a host whose wall clock steps back. By the engine's clock the lease never lapsed. `M2-not-claimed.md` lists it.

## Runs

See `COVERAGE.md`, "M2 slice 14", "After objection 017": M118 alone on the Builder's tip, several times, and once with the engine's wall clock stepped back 5.8 s inside the pause.
