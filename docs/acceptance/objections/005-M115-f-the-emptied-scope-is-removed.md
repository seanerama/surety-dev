# 005: In M115 (f) the prior incarnation's scope empties and the manager removes it, so the case's own read of the domain's `cgroup.events` throws

Row: M115
Test: packages/engine/test/acceptance/M115-every-unknown-quarantines.test.mjs, case "(f) cgroup.kill refused during termination: …", the liveness loop after `fx.scripted.release(item)` (line 239: `for (let i = 0; i < 10 && populated(domain.cgroup_path) !== 0; i++)`) and the assertion after it
Filed by: Builder, M2 slice 11, 2026-10-03

## Claim

Every step of the case up to the release passes on `build/m2-s11`: the Stop closes the launch, the kill is refused, the run is quarantined `unknown` with the role alive, the quarantine holds across ticks and across the restart, and with `cgroup.kill` writable again a tick keeps the quarantine with the role alive. Then the test releases the role and reads the domain's `populated`:

```
not ok 6 - (f) cgroup.kill refused during termination: …
  error: "ENOENT: no such file or directory, open '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/surety-2d49bee0b4172a68-inc_01M41CT8V229FC7KM0KXZR6G39.scope/dom_01M41CT9CNTEME98Z1HGZVXX9R/cgroup.events'"
```

The domain is in the scope of the incarnation the case killed (`scope_cgroup` of the first engine). Recovery killed that incarnation's supervisor leaf (empty), so the role's processes were the last members of that scope. Once the released role exits and the domain init with it (SEAM.md §126: "the init exits once the backend has"), the scope is empty, and the user manager removes an emptied transient scope together with its empty children, which SEAM.md §124 itself states ("the manager removes an emptied scope by itself, together with its empty children") and §128 relies on ("A quarantined domain that is empty when its engine dies loses its scope"). So between `waitForRun` and the loop the directory may be gone, and `populated()` (`harness/sandbox/cgroup.mjs`, which reads `cgroup.events`) throws. The engine had not removed it: no tick ran between the release and the read, and the run was still quarantined.

The next tick then finds the domain absent inside the verified hierarchy, which D2 §3.3 makes termination, and clears the quarantine once; that is what `assertClearedOnce` accepts (it requires the directory gone).

## Proposed change

Treat absence as emptiness in the liveness loop and its assertion, for example `!cgroupExists(domain.cgroup_path) || populated(domain.cgroup_path) === 0`, with the message saying the role is gone and the domain empty or removed by the manager. Nothing the case pins about the engine changes.

## Sources

- SEAM.md §124 (the manager removes an emptied scope with its empty children), §126 (the init exits once the backend has), §128 ("Across a restart").
- D2 §3.3: absence in the verified hierarchy is termination.
