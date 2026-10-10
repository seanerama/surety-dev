# 035: M74's launch lint does not list the `local_service` adapter, which BS4 §5 places among the process-starting files

Row: M74
Test: packages/engine/test/acceptance/M74-invocation-boundary.test.mjs, case "the engine's source starts a process only in the choke point, in the git runner and in the seam folder" (allow list in `harness/launch-lint.mjs`, `ALLOWED` / `D2_HELPERS`)
Filed by: Builder, slice 24, 2026-10-10

## Claim
On `build/m4-s24` the case fails with one violation:

```
packages/engine/src/deploy/adapters/local-service.ts:32: imports 'node:child_process', a module that can start a process, outside invoke/, git/exec.ts, testing/, boundary/scope.ts, boundary/scope.ts
```

That file is the production `local_service` adapter. It is the only file in the engine that starts `systemd-run` and `systemctl`, both with `--user`, resolved to absolute paths from the system directories, with argument arrays and no shell. BS4 §5 makes it a permitted place, and says the lint must list it and enforce it. The Verifier's slice-24 pass did not add it to the allow list. I ask that `harness/launch-lint.mjs` list `deploy/adapters/local-service.ts` with its two tools, in the same form as `boundary/scope.ts`:

- `deploy/adapters/local-service.ts`, `systemd-run --user`: the transient unit of a service domain (D4 §9.2, §9.3).
- `deploy/adapters/local-service.ts`, `systemctl --user`: show, list-units and list-jobs (reads), and stop and reset-failed of an exact owned unit (D4 §§2.4, 4.6, 9.3).

No other file under `src/deploy/` names a process-starting module. `service-host.ts` and `identity.ts` read `/proc` and the cgroup files and listen on sockets, and start nothing.

## Sources
BS4 §5: "`src/deploy/adapters/` joins the places permitted to start a process (E39 item 7), and only for `systemd-run` and `systemctl`, both with `--user`, resolved to absolute paths and recorded with their versions on the qualification; the spawn lint (row M74's) lists it and enforces both (D4-A08)."
BS4 §7: "adapters/local-service.ts   the only code that starts systemd-run and systemctl".
D4 §2.5: "`src/deploy/` joins the places permitted to start a process (E39 item 7), and only for the host tools its adapter names; the lint that enforces E39 item 7 enforces this."
