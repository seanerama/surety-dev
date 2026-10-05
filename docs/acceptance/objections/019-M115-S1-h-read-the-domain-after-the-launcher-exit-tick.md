# 019: M115 S1 and (h) read the domain after its launcher's exit, before the test's tick; under SEAM §170 the engine's own tick has cleared it by then

Rows: M115 S1 (the slice-11 review) and M115 (h) (sandbox lane)
Test: packages/engine/test/acceptance/M115-every-unknown-quarantines.test.mjs
- S1: line 314 (`waitFor(() => populated(domain.cgroup_path) === 0 …)` once the launcher is gone), lines 318 and 319 ("no termination is recorded before the tick that observes it", the quarantine asserted still standing);
- (h): the loop after `fx.scripted.release(second)` that reads `populated(domain.cgroup_path)` until 0, then the assertion "the role exited by itself and the domain is empty".

Filed by: Builder, M2 slice 14 follow-up (E79 item 2), 2026-10-05

## Claim

SEAM.md §170 (E79 item 2, decided by Sean) says: when a launcher of this engine exits while its domain is quarantined or closing, the engine requests a tick itself. That tick re-observes the domain and, under section 128's prerequisites, terminates it, clears the quarantine and removes its directory. The engine on `build/m2-tick` does this (`1539a33`). The new case (e) "the launcher-exit tick" requires it.

S1 and (h) were written when no tick came between the launcher's exit and the test's own tick. Each reads the domain in that interval:
- **S1** releases the paused launcher. It waits for it to leave, then for the domain to read `populated 0`, then asserts that no `domain.terminated` is recorded and that the quarantine stands, all before its own tick. The launcher's exit now brings the engine's tick. By the time S1 reads, the domain may be terminated and its directory removed. The read then throws ENOENT, or the "no termination before the tick" assertion fails.
- **(h)** releases the role of a quarantined domain and reads `populated` until 0. The role's exit ends the domain init and so the launcher. The engine's tick follows, and the directory is removed under the read: ENOENT.

Both failed so on the engine with the change, in the run of the file before `main`'s new case was merged (2026-10-05, `build/m2-tick` at `1539a33`):
- S1: "timed out after 10000 ms waiting for the domain to read populated 0 once the launcher is gone: ENOENT: no such file or directory, open '…/dom_…/cgroup.events'";
- (h): "ENOENT: no such file or directory, open '…/surety-c09d98609b808ae9-inc_01M453FD6BE0Q01G7VTADGMJ5J.scope/dom_01M453FJ1F6S10QVBSDHDJNC2C/cgroup.events'".

The test output is kept at `/tmp/claude-1000/-home-smahoney-projects-sdlc-x/fa384943-ed62-4381-ae56-c1ae7b3402e5/scratchpad/s14-build/tick-M115-every-unknown-quarantines.log`.

What S1 pins is unchanged and still holds on this engine: no termination is recorded while this engine's launcher is outstanding (alive and unplaced), and the clearance comes once. Only the claim that nothing happens between the launcher's exit and the test's tick is superseded by §170.

## Proposed change

- **S1:** after the launcher is gone, accept either outcome:
  - the engine's own tick has already terminated the domain and cleared the quarantine once. The domain is "empty or removed" (the file's own `emptyOrRemoved`, objection 005), there is exactly one `domain.terminated`, and it comes after the launcher's exit;
  - or the domain is still quarantined. Then the test's tick clears it once, as now.

  Keep the part that S1 is about: while the launcher is outstanding, no `domain.terminated`.
- **(h):** read the domain with `emptyOrRemoved` after releasing the role. Then let `assertClearedOnce` accept a clearance that the engine's own tick has already made.
