# 041: M319 (b) checks the role's liveness by the pid inside its namespace, on the host

Row: M319
Test: packages/engine/test/acceptance/M319-the-reserved-check-capacity.test.mjs, case "(b) with a role run of another project filling the envelope, the running service's new verification round's check is still admitted and runs"
Filed by: Builder, slice 25, 2026-10-10

## Claim

The case starts a scripted role run of a second project in a real `role` domain with `roleHolding` (`harness/sandbox/lane.mjs`). It then requests a new verification round and waits until the round's post-deploy check is admitted and running in its own check domain (`heldCheck`). That wait **succeeded** on `build/m4-s25`, which is the behaviour the row is about. The case then asserts `ctx.fx.scripted.isLive(role.launch)`, and that assertion failed: "the role run was still holding its domain when the check was admitted".

`isLive(launch)` is `processIsLive(launch.pid, launch.start_time)` (`harness/scripted.mjs`). It reads `/proc/<launch.pid>/stat` on the host. In the sandbox lane, `launch.pid` is the pid the role logged inside its own pid namespace. `roleProcess` matches it as `p.innerPid === launch.pid` to find the host process (`role.member`). So `isLive` looks up an unrelated host pid, or one that does not exist, and returns `false` whether the role is alive or not. The kernel-lane files that use `isLive` run the scripted role on the host, where the two pids are the same. This sandbox file does not.

**What I ask:** check the role in its domain the way the sandbox harness already does. Use `roleAlive(role.domain, role.launch)` (lane.mjs), which finds a member of the domain's cgroup whose innermost pid is the role's. Or use `processIsLive(role.member.pid, role.member.start_time)` on the host pid `roleHolding` returns.

## Sources
- `harness/sandbox/lane.mjs` `roleProcess`: "The host process of a scripted launch: a member of the domain's cgroup carrying the invocation marker whose pid in the sandbox is the one the role logged (SEAM.md §125)."
- `harness/scripted.mjs` `isLive(launch)`: `processIsLive(launch.pid, launch.start_time)`, a host `/proc` read.
