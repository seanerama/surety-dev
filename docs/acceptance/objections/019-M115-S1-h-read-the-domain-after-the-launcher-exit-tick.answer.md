# 019: Answer — upheld; S1 and (h) take the domain as empty or removed after the launcher's exit, and S1 keeps its rule across that window

Rows: M115 S1 (the slice-11 review) and M115 (h) (sandbox lane)
Objection: `019-M115-S1-h-read-the-domain-after-the-launcher-exit-tick.md` (Builder, the E79 item 2 follow-up, filed on `build/m2-tick`)
Answered by: Verifier, 2026-10-05, on `verify/m2-tick-019` from `main` at `ce7d9f4`

## Decision

**Upheld.** Both faults are in the cases. Each was written when nothing could happen between a launcher's exit and the test's next tick. SEAM §170 (E79 item 2, decided by Sean) changed that: the launcher's exit now brings the engine's own tick. Under §128's prerequisites, that tick terminates the domain, clears the quarantine and removes the directory (§126).

- **S1:** after the release, the case read the domain's `cgroup.events` and required no termination before its own tick.
- **(h):** the domain init is the launcher by exec (§125), so the role's exit brings that tick too. The case read the domain's `populated` until 0.

Both reads now race a removal the seam requires. The Builder's evidence shows each throwing ENOENT on that engine.

## What each case is for, and what is kept

**S1 pins D2 §3.2 at a tick:** "populated 0 on a domain whose launcher is outstanding is not termination". Then it pins one clearance once the launcher is gone, with nothing granted and nothing run.

- **Unchanged:** the two ticks with the launcher outstanding (no `domain.terminated`, quarantined and unknown, the launcher alive, unplaced, the domain empty). That is the property under test, and §170 does not touch it.
- **Dropped:** the assertion "no termination is recorded before the tick that observes it", made after the launcher's exit. Under §170 the engine's tick is the tick that observes it, so the requirement was the old "nothing between the exit and the test's tick", not the rule.
- **Added:** the rule is now held across the new window as well, from the release to the launcher's exit. At every read, the case fails if a `domain.terminated` is already recorded while the launcher is still alive (non-zombie). The launcher is read on the host after the events, so it was alive when the event was written. This is a stricter version of the Builder's "it comes after the launcher's exit", because it is checked continuously and not only at the end.
- **Then:** the domain must be empty or removed (objection 005's `emptyOrRemoved`). If it is removed, exactly one `domain.terminated` must already be recorded: while its scope lives, only the engine removes the directory, and only after the record (§126).
- **Kept:** the test's tick. Whichever tick observes first clears the domain, and `assertClearedOnce` with S1's own checks requires one clearance:
  - one `domain.terminated`;
  - one `domain.quarantined`;
  - one reservation, released;
  - `refused` and uncharged;
  - no placement after the termination;
  - no grant, no role;
  - the work `held`.

  S1's last part (a further tick writes nothing more, the waiting item then completes) is unchanged.

**(h) pins** that a real `daemon-reexec` changes nothing, and that under `manager_unreachable` nothing is signalled. Once the fault is lifted, `populated 1` keeps the quarantine with the role alive. Once the role is gone, the quarantine is cleared once. All of that up to the release is unchanged.

- **After the release:** the role's exit is read on the host (its host pid gone). Then the domain must be empty or removed, and if removed, exactly one `domain.terminated` must be recorded.
- **Then:** the test's tick and `assertClearedOnce`, as before.

The old loop polled `populated` for "the role exited by itself and the domain is empty". It is replaced by the host-read exit and the same empty-or-removed reading.

**Nothing else in the file changed.** (e), the launcher-exit case and (f) already read through `emptyOrRemoved` or read nothing after the exit. (a) to (d) and (g) have no launcher exit after their quarantine.

## Not taken

The Builder's alternative branch for S1 ("or the domain is still quarantined; then the test's tick clears it") is not written as a separate path. The test's tick is sent in either case, and the one-clearance assertions cover both. That the engine does not leave it for the test's tick is the launcher-exit case's to pin, not S1's.

## Runs

`M115-every-unknown-quarantines.test.mjs` was run alone with `node --test`, on the Builder's tip `f842022`, in a detached scratch worktree after `npm ci` and `npm run build`, with this branch's file copied in. In every run S1 and (h) took the new path: the engine's own tick had cleared the domain and removed it before the test read it.

- Run 1: 12 of 12 passed.
- Run 2: 12 of 12 passed.
- Run 3: 12 of 12 passed.

The results, and what else was running at the time, are in `packages/engine/test/acceptance/COVERAGE.md`, "After objection 019".
