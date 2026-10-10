# 036: answer

Row: M311
Answered by: Verifier, M4 slice 24, 2026-10-10, on `verify/m4-s24-obj2`

## Upheld; the fixture re-executes with the vector the kernel holds, and the case waits for the re-execution

The objection is right. `reexec-same` re-executed with `[process.argv0, ...process.argv.slice(1)]`, and Node makes `process.argv[1]` absolute, so the new image's `/proc/<pid>/cmdline` was `[<runtime>, "/surety/app/server.js"]` against a start command of `[<runtime>, "server.js"]` (SEAM §259: `start[1..]` are relative to `/surety/app`). That is "an `exec` with other arguments", which D4 §3.4 step 4 reads `differs`, and the engine read it so. Row M311 (f) asks for "a re-exec of the same runtime with identical arguments"; the fixture did not make one.

The case had a second fault the objection did not name: like 037's, its check exited as soon as the act answered, 150 ms before the act, so a `match` could have been the original image read before the re-execution.

**The changes.**
- `harness/deploy/fixture-service.cjs`, act `reexec-same`: re-executes the runtime with the vector of `/proc/self/cmdline`, split on NUL, byte for byte as the init started it.
- `M311-identity-from-the-target.test.mjs`, case (f): before the act it reads from the host the application's `cmdline` bytes and the inode of the socket it listens on (`listenerOf`, `/proc/<pid>/net/tcp` and `/proc/<pid>/fd`). The check's plan asks for `/hello` and the act, then holds again (`then`, SEAM §258). The test waits on the host (`hostUntil`, no sleep) until the same instance (pid and start time) listens on a new socket, which is the re-executed image serving; it asserts `/proc/<pid>/cmdline` is byte-identical to before and equals the start command; only then does it let the check end (`releaseAgain`, with one more `/hello`). Then: both `/hello` answers 200, the second read `match`, with the original pid and start time. The `sleep(500)` is gone.
- **Cleanup on failure.** Case (f) (and (b)) runs through `heldCase`: in a `finally`, a check still held is let go (exit 1, no act), the environment is ended by `endEnvironment` (the engine's teardown, then the test's stop by exact name of a unit its own intents name), and the release files are removed. A failed (f) can no longer leave a service holding the check capacity that admission keeps free for (g).

(f) still asserts what the row says: `match`, labelled not claimed. D4 §3.4 and §11 class C do not claim to detect this re-execution, and the case only records that the read cannot.

On `build/m4-s24` at `9b2a25d` with this change cherry-picked, after `npm run build`, `M311-identity-from-the-target.test.mjs` run alone: 14 of 14; `systemctl --user is-system-running` `running` before and after, and no `surety-*` unit before or after.

## Sources
- D4 §3.4: an `exec` "with other arguments" fails step 4 and reads `differs` or `unread`; "an application that re-executes the same runtime with identical arguments keeps its pid, start time, executable and arguments, so these fields do not distinguish it, and D4 does not claim to (§11 class C)".
- M4 plan §3.2, M311 (f): "`match`, labelled not claimed (D4 §3.4, class C)".
- SEAM.md §259 (`argv` is `/proc/<pid>/cmdline`, the start command; `start[1..]` relative to `/surety/app`), §258 (the second hold).
