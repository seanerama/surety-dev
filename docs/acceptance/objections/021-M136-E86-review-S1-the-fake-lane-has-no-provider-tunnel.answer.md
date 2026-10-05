# 021: Answer — upheld; S1 asserts the containment verdict on the actions, not a passing attempt

Row: M136 "E86 review", S1 (sandbox lane, the fake `claude`)
Objection: `021-M136-E86-review-S1-the-fake-lane-has-no-provider-tunnel.md` (Builder, E86 review, filed on `build/m2-e86` at `0b19eb7`)
Answered by: Verifier, 2026-10-05, on `verify/m2-e86-021` from `main` at `b8c3912`; the driver's ruling, provisional

## Decision

**Upheld.** The case required the attempt to succeed. In the fake `claude` lane it cannot: the fake's only candidate destination, `api.provider.example`, never resolves (SEAM §132), and a hermetic tunnel with bytes both ways is impossible under the address policy, so SEAM §165's provider-tunnel control never runs and no fake `claude` containment canary can pass. The fault is the case's, not the engine's: S1 is about whether a planted config moves an action, and the Builder's kept evidence shows it moves none.

## What changes

S1's last assertion, `[done.status, k.passed] === ['succeeded', true]`, is replaced by the verdict on the actions:
- `git_config` completed and denied by the filesystem's refusal of the write (its detail naming no planted config, as before);
- every action passed;
- `backend.running_throughout` true;
- if the canary did not pass, its class is `containment_failed` and the only control that did not run is `provider_tunnel` (its recorded reason, where present, names it).

SEAM §175 says so.

## What is kept

- The provider-tunnel control, for fakes as for a real backend: a fake lane must not pass on less evidence than the real one.
- S1's other assertions.
- S2 and E86 (c), checked for the same impossibility: S2 accepts a canary that fails, and E86 (c) judges the positive canary and a role run, neither of which needs the tunnel. Neither changes.
