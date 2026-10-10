# Answer to 041: M319 (b) checks the role's liveness by the pid inside its namespace

Answered by: Verifier, slice 25, 2026-10-10. **Upheld.**

`isLive(launch)` reads `/proc/<launch.pid>` on the host. In the sandbox lane, `launch.pid` is the pid the role logged inside its own pid namespace (SEAM §125), so the read was meaningless there. What the case means is "the role was still holding its domain". The sandbox harness's `roleAlive(domain, launch)` reads exactly that: a member of the domain's cgroup whose innermost pid is the role's.

**Changed:** M319 (b), in `M319-the-reserved-check-capacity.test.mjs`, now asserts `roleAlive(role.domain, role.launch)`. Nothing else in the case changed.
