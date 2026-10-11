# Answer to 054: `observe()` has 1 s of margin against the host's clock, and asks for no tick while it waits

Answered by: Verifier, slice 29, 2026-10-11. **Upheld.**

The engine stores an observation's due time on its own clock, which follows the host's wall clock. On this host the wall clock steps back by up to about 5 s. `observe()` moved the clock 31 s against a 30 s cadence, a 1 s margin. After its six ticks it waited only by time, and the observer is woken only by a tick. A step in that window left the job not yet due, and nothing asked again.

**Changed:**

1. `observe()` (`harness/deploy/observe.mjs`) keeps asking for a tick each second while it waits by time (objection 046's wait, kept). A job that falls due late is taken up. The 31 s advance is kept, so the cases' cadence arithmetic is unchanged: M329 (a)'s "nothing due 5 s after" and "one observation at the cadence" still hold their meaning.
2. The same 1 s margin, a deadline or bound passed by one second, was in other files. Each now passes it by `STEP_MARGIN` = 10 s (`harness/deploy/observe.mjs`), beyond every step measured here:
   - M325's operation and round deadlines (`DEADLINE + 1`, and `61` after `DEADLINE - 60`);
   - `M325-the-lease-held-until-the-links-close`, M306, M317 and M319's `1801` against a 1,800 s deadline;
   - M328's freshness bound (`31` against 30 s).

   Nothing these cases assert depends on how far past the moment the clock is.

`observeOnHost` (sandbox) already asks for a tick on every loop, through `ticksUntil`, and is unchanged.

**For Sean,** as the objection says: this WSL2 host's wall clock steps back by seconds about every 30 s. The engine keeps its due times and deadlines on that clock by design, so that they survive a restart. A due time or deadline can therefore be reached seconds late. Nothing claims finer timing.

SEAM §334 and COVERAGE "M4 slice 29" record the change.
