# 018: Answer — upheld; M115 (e) ticks once the released launcher is gone

Row: M115 (e) (sandbox lane)
Objection: `018-M115-e-single-tick-before-the-released-launcher-is-gone.md` (Builder, M2 slice 14)
Answered by: Verifier, M2 slice 14, 2026-10-05, on `verify/m2-s14-018` from `main` at `97195aa`; the driver's default (the objection's first option)

## Decision

**Upheld.** The fault was the case's. After releasing the launcher held at `launcher.before_placement`, (e) sent its one tick at once. The released launcher may place itself after closure, which D2 §3.2 allows and SEAM §131 does not pin. It is then refused its grant and exits.

While it is still in the domain, the domain is populated and its launcher outstanding. D2 §3.2 says that is not termination, and the slice-11 review's S1 pins exactly that rule. So a tick landing in that window rightly leaves the quarantine. With `tick_interval` 600 s, nothing re-observed it before the case's 30 s wait ran out.

The failing run shows the timing: `domain.placed` at 02:02:17.028, the case's tick at 02:02:17.063, then nothing. The engine did what the rule says.

## What changed (M115 (e) only)

- Before the release, the case finds the launcher as S1 does: the one node process in the engine's supervisor leaf beside the engine.
- After the release, it waits (host-read) until that pid is gone, at most 20 s.
- It then waits until the domain's cgroup reads `populated 0` or is removed, at most 10 s.
- Only then does it send the tick.

So "the next tick clears it" holds by construction. Every assertion stands: the unknown quarantine, no role launched, no `domain.launch_authorized`, the clearance once with the invocation refused and uncharged, and the work held.

**S1, checked.** S1 already waits for the launcher's exit (`waitHostGone`) and for `populated 0` before its clearing tick, so it has not this pattern and is unchanged. The other single ticks of the file follow a role's or a condition's settled state, not a released launcher, and are unchanged.

## Not taken

The engine-side alternative (the engine requests a tick itself when its own launcher of a quarantined domain exits) is new scope. D2 §3.4 has each tick observe again and does not ask for it. It is recorded as a possible later improvement, not built now.

## Runs

`M115-every-unknown-quarantines.test.mjs` alone on the Builder's tip `25cefa4`, three times: see `COVERAGE.md`, "M2 slice 14", "After objection 018".
