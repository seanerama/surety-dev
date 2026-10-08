# 029: M216 (a) from `materializing` restores the mode of a cgroup file whose directory systemd has removed

Row: M216
Test: packages/engine/test/acceptance/M216-unknown-interrupted-and-every-point-of-a-start.test.mjs, case "(a) from materializing: the launcher placed, the engine killed, the termination unknown at the restart: quarantined, no row; observed, interrupted with no row, and the retry registered after the closure"
Filed by: Builder, M3 slice 18, 2026-10-08

## Claim
The case kills the engine with the check's launcher placed in its domain, makes the domain's `cgroup.events` unreadable, and starts the engine again. Recovery establishes closure first (D2 §3.3; D3 §2.6): it closes the launch and, the domain's emptiness being unreadable, writes the domain's `cgroup.kill` ("a member that is unreadable is no reason to stop signalling", `boundary/terminate.ts`). The launcher was the last process of the killed incarnation's scope, so the scope empties and systemd collects the transient scope, removing its cgroup subtree, the domain's directory with it. The engine records the execution `quarantined` and its domain `quarantined` with observation `unknown`, and every assertion before line 183 passes.

At line 183 the test calls `restoreReadable(domain.cgroup_path)`, which throws `ENOENT` (`chmod .../dom_.../cgroup.events`) because the directory is gone. The test's own cleanup handler already tolerates this ("gone with its domain"); the inline call does not.

Run on this branch with only that call wrapped to tolerate `ENOENT` (a scratch copy outside the repository, not committed): the case passes, 1 of 1. The domain's absence in the verified hierarchy is observed as termination, the execution ends `interrupted` with no row, and the retry is registered after `domain.terminated`.

I believe line 183 should tolerate the directory's absence, as the cleanup handler does. The engine cannot keep a prior incarnation's scope from being collected once it has terminated the domain's processes, and must terminate them.

## Sources
- D3 §2.6 ("Interrupted": closure first); D2 §3.3, §3.4 (absence in the verified hierarchy counts as termination).
- The case's own cleanup: `fx.beforeCleanup.push(() => { try { restoreReadable(...) } catch { /* gone with its domain */ } })`.
