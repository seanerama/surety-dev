# 036: M311 (f)'s fixture re-execs with an argument vector other than the one it was started with

Row: M311
Test: packages/engine/test/acceptance/M311-identity-from-the-target.test.mjs, case "(f) a re-exec of the same runtime with identical arguments: match, the same instance; …"; fixture `harness/deploy/fixture-service.cjs`, act `reexec-same`
Filed by: Builder, slice 24, 2026-10-10

## Claim
The case expects the second identity read to be `match`. On `build/m4-s24` (sandbox lane, real unit) it is `differs`. The read is right: the fixture does not re-exec with identical arguments.

The environment's start command is `[<runtime>, "server.js"]`, a path relative to the working directory `/surety/app` (SEAM.md §259). That is what the init passed and what `/proc/<pid>/cmdline` shows. The act re-execs with `[process.argv0, ...process.argv.slice(1)]`. Node resolves `process.argv[1]` to an absolute path, so after the act `/proc/<pid>/cmdline` reads `[<runtime>, "/surety/app/server.js"]`. Its arguments differ from the start command, so D4 §3.4 step 4 reads `differs` (CD4's case (g) relies on the same comparison). Checked on this host: `node argv1.js` run from its directory prints `process.argv[1]` as `/tmp/claude-1000/argv1.js`.

To re-exec with the identical vector, the act could read its own `/proc/self/cmdline` (split on NUL) and pass that, or re-exec with `[process.argv0, 'server.js']`.

A consequence in the same file: when (f) fails, its `endEnvironment` never runs, so its service keeps running, and so does the one check capacity admission keeps free while any service runs (the provisionally accepted admission rule). Then case (g)'s Builder run waits for admission until its 120 s bound. Run alone (`--test-name-pattern "Builder's package"`), (g) passes.

## Sources
D4 §3.4: an `exec` "with other arguments" fails step 4 and reads `differs` or `unread`; "an application that re-executes the same runtime with identical arguments keeps its pid, start time, executable and arguments". SEAM.md §259: `argv` is `/proc/<pid>/cmdline` (the start command); `start[1..]` are paths relative to `/surety/app`.
