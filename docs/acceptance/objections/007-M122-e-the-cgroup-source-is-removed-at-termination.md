# 007: M122 (e) stats the domain's cgroup directory after the run has ended, and D2 §3.2 has the engine remove it once `terminated` is recorded

Row: M122
Test: packages/engine/test/acceptance/M122-host-sockets-and-wsl.test.mjs, case "(e) P12 on the full mount table, under the probe profile: …" (line 214: `assertMountTableIsPlan(probe('mount_table'), plan, …)` after `probedRun`)
Filed by: Builder, M2 slice 12, 2026-10-03

## Claim

`probedRun` (harness/sandbox/view.mjs) releases the role and waits until the run is `ended`. Only then does the case call `assertMountTableIsPlan`, which, for every `bind` and `cgroup` entry, compares what the role stat'ed inside with the host's `statSync(entry.source)` **now**. The probe profile's plan carries `/surety/cgroup/domain` and `/surety/cgroup/sibling` as `cgroup` entries whose sources are the domain's cgroup directory and its sibling (SEAM.md §127). By then both have been removed, as D2 §3.2 requires ("Once `terminated` is recorded, the engine removes the directory and nothing may recreate it") and as M113 (a) pins ("the directory is removed after the record") and SEAM.md §127 says of the sibling ("removed with the domain"). So the case fails on its own read, whatever the engine's mount table:

```
not ok 5 - (e) P12 on the full mount table, under the probe profile: …
  error: "ENOENT: no such file or directory, stat '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/surety-9c7ed6b10f578315-inc_01M41TMYAK3W7TB745EJM06XKC.scope/dom_01M41TMZHV0Z2P78H2245DQNEY'"
    assertMountTableIsPlan (harness/sandbox/view.mjs:199:20)
```

The same file's other comparison, M119 (a) and (b) under the `role` profile, has no `cgroup` entry. For its `bind` entries whose source is in the domain's area (the context package, the git view's seed files, the egress socket, the init's node), the engine on `build/m2-s12` now leaves the domain's area in place after termination (removing it at the next start), so those sources can still be stat'ed after the run; a cgroup directory cannot be kept that way.

## Proposed change

Compare the table with the plan while the domain lives: `armedRole(..., { thenHold: true })`, `release()`, `assertMountTableIsPlan(...)`, then `stop()` (as M125 (c) does), or skip the device-and-inode comparison for `cgroup` entries once the run has ended and require instead that the directory was removed after `domain.terminated`. Nothing else of the case needs to change.

## Sources

- D2 §3.2: "Once `terminated` is recorded, the engine removes the directory and nothing may recreate or repopulate it."
- SEAM.md §126 ("then the directory is removed (`rmdir`), after the record"), §127 (the sibling is "removed with the domain"), §133 (the comparison reads the source's device and inode).
