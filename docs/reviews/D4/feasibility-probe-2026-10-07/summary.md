# D4 §9.6 feasibility probe of the user service manager, 2026-10-07

**Run by:** the owner's assistant, with Sean's approval and conditions (fresh unique unit name refused if present; kill only the probe's creator; stop and clean only what the probe created; bounded with cleanup on failure and success; commands, observations and cleanup kept as evidence). **Files:** `probe.sh` (the exact script), `log.txt` (its complete output, with the command line and host). **Host:** the workstation, WSL2 kernel 6.6.87.2, systemd 255.4, user manager `running` (lingering). **Started:** 2026-10-07T21:24:04Z; ran about 2 s; exit status 0.

**What this proves and what it does not.** The probe used a **stand-in launcher and init** (`unshare` and a shell; the application a Node process on a read-only bind), not D2's launcher, domain init, constructed root (`pivot_root`), control channel or launch authorization. It establishes feasibility of the service-manager half of D4 §3.4 and §9.2 on this host only. Qualification of the actual D2-derived launcher (D4 §2.6) remains necessary.

## Observations

| D4 claim | Observed | Result |
|---|---|---|
| `systemd-run --user` creates a transient service with `Delegate=yes` and limits as properties | unit `surety-probe-d7714647232d.service` active; `Delegate=yes`, `MemoryMax=67108864`, `TasksMax=32` | holds |
| Its cgroup is outside the creating process's cgroup | unit under `/user.slice/user-1000.slice/user@1000.service/app.slice/…`; creator in `/init.scope` | holds |
| Limits readable back from the cgroup before authorizing | `memory.max=67108864`, `memory.swap.max=0`, `pids.max=32` | holds |
| The unit's `MainPID` is the launcher, not the application (RV1) | `MainPID` 1269201 = outer `unshare`; application 1269206 | holds: `MainPID` must not be taken for the application |
| §3.4 step 2: the init is found from the host | member with `NSpid [1269205 1]`, child of the inner `unshare` | holds |
| §3.4 step 3: the init's report and the host read agree | init reported application ns pid 2; exactly one member with innermost `NSpid` 2 and parent = init | holds |
| §3.4 step 4: executable, start time, mount source, tree hash read from the host | exe = configured `node` (sha256 prefix `1bec56ef7cfa9a76`), start time 54734491; `mountinfo` shows the bind `ro` from the source directory; file via `/proc/1269206/root/…` hashes equal to the source | holds |
| The application cannot be altered through its view | host write through `/proc/<pid>/root` to the bind: refused | holds |
| The unit survives its creator's SIGKILL | creator killed (marker checked); unit `active`, `InvocationID` unchanged, application same pid and start time | holds |
| `InvocationID` changes on restart | `bc78b734…` → `093a9ad8…`; new launcher, init and application; old application pid gone | holds |
| A stop is observable as closure and emptiness | after `stop`: `LoadState=not-found`, `ActiveState=inactive`, the unit's cgroup directory absent, application pid gone | holds (absence of the cgroup in the verified hierarchy, as D2 §3.3 accepts; `populated 0` itself was not readable because the directory was removed) |

## Cleanup

The cleanup trap ran on exit: the unit was already `not-found`, its cgroup directory absent, the work directory removed. An independent check afterwards: no `surety-probe-*` unit loaded, no such cgroup under `app.slice`, no probe process, no probe work directory; the user manager still `running`.

## Not established by this probe (stays class B in D4 §11)

D2's real launcher and domain init inside a service unit, including `pivot_root` into a constructed root (the `/proc/<pid>/root` read here went through a private mount namespace without a new root); launch authorization over the engine's socket; the init's control channel surviving an engine restart; the unit surviving the death of an engine **incarnation scope** (the creator here ran in `/init.scope`); behaviour across a restart of the user manager or the host; a launcher creating child cgroups under `Delegate=yes`; the immutable-pathname property for the `service` profile; detection of a same-runtime, same-argument re-exec (not claimed).
