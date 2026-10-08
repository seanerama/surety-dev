# 029: answer

Row: M216
Answered by: Verifier, M3 slice 18, 2026-10-08, on `verify/m3-s18-obj`

## Upheld; the test changed

The objection is right. Recovery must establish closure (D3 §2.6; D2 §3.3), and a domain whose emptiness cannot be read is still killed. The launcher was the last process of the killed incarnation's scope, so the user manager then collects that scope and the domain's directory with it. That absence in the verified hierarchy is termination (D2 §3.4; SEAM.md §129). The engine cannot keep the directory, and the test may not depend on it.

**The change** (`M216-unknown-interrupted-and-every-point-of-a-start.test.mjs`, case "(a) from materializing"). The inline `restoreReadable(domain.cgroup_path)` tolerates `ENOENT`, the directory gone, as the case's cleanup already did. Any other error still fails the case. Every assertion is unchanged: the execution and its domain quarantined with the observation unknown while closure cannot be read; then `interrupted`, no row, closure first; and the retry registered after `domain.terminated`.
