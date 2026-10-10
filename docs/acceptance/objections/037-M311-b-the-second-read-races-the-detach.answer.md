# 037: answer

Row: M311
Answered by: Verifier, M4 slice 24, 2026-10-10, on `verify/m4-s24-obj2`

## Upheld; the check ends only after the host shows the application gone

The objection is right. The `detach` act answered, then acted 150 ms later and exited 1,000 ms after that, while the check exited on the answer; the engine made the round's second read after the check's result was recorded, with the application still running, and a `match` was the right reading of it. D4 §5.3 puts the second read after the last required check's result, and nothing in D4 delays it further, so the test must hold the check until the scenario of row M311 (b) has happened.

**The changes.**
- `harness/deploy/target-check.mjs`: a plan may name `"then": "again"`. After asking for its paths, the program waits (bounded, 280 s) for a second release file whose plan names no act, then exits with that plan's `exit` (SEAM §258).
- `harness/deploy/fixture-service.cjs`, act `detach`: after starting its child it waits until the child answers on the port (at most 10 s), then exits 1 s later. Before, it exited 1 s after the spawn whether or not the child was listening. The child retries a still-taken port up to 20 times.
- `M311-identity-from-the-target.test.mjs`, case (b): the plan is `{get: ["/act/detach"], then: "again"}`. The test then waits on the host, with no sleep and no engine tick, for two facts in turn. First, a `--detached-child` process in the unit's cgroup holds a listening socket on `127.0.0.1:<port>` (`listenerOf`), and the application no longer does, while the application still runs. Second, the application is gone (its pid absent, reused or a zombie). Only then does it write the second release, so the check ends and the second read follows the application's exit. The assertions are unchanged: the second read is `differs` or `unread`, the outcome is not `verified`, the domain is `terminated`, the original instance stays recorded, and no descendant is left.

"With the descendant still holding its port" is established at the moment the application exits: the descendant was listening before that and nothing of the test's ends it. Whether it still listens when the engine reads is not the test's to arrange. D4 §9.2 has the init terminate the remaining descendants when the application exits, and the case asserts that none is left.

Like (f), the case runs through `heldCase`, so a failure still ends its environment by the engine's teardown and the test's exact-name stop.

On `build/m4-s24` at `9b2a25d` with this change cherry-picked, after `npm run build`, `M311-identity-from-the-target.test.mjs` run alone: 14 of 14, (b) included; the user manager `running` before and after, and no `surety-*` unit before or after.

## Sources
- M4 plan §3.2, M311 (b): "the application exits while a descendant keeps its port with output closed"; expected "the domain terminal; no descendant bound in the application's place".
- D4 §3.4: "an application that exited (nothing restarts it, §9.2) … fail[s] step 4 and read[s] `differs` or `unread`, never `match`".
- D4 §5.3 item 5: the second read "after the last required execution's result is recorded".
- D4 §9.2, the domain's life: when the application exits, the init "closes ingress, and terminates the remaining descendants".
- SEAM.md §258.
