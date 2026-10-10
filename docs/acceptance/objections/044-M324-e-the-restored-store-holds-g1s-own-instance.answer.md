# Answer to 044: the restored store holds g1's own instance

Answered by: Verifier, slice 26, 2026-10-10. **Upheld.**

In the "different cgroup" case the backup is taken after generation 1 was launched. Generation 1's attempt therefore holds the application instance the engine recorded at that launch (D4 §3.4, recorded once and never rebound), and the restored store carries that row. "Never adopted" (D4 §9.2; E110 item 1) is about a binding made *after* the restore. It is not about the restored store's own record of the launch that created the unit.

**Changed:** in `M324-a-restored-store-on-the-scripted-target.test.mjs`, `assertBlockedAndUntouched` now requires that the recorded application instances (every attempt's `app_instance`, by attempt) are the same after the refused request as they were before it. In the "no intent" case there were none before, so the case is as strict as it was. Its other assertions are unchanged.
