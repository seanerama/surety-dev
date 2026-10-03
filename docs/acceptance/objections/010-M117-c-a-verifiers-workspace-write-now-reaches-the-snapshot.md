# 010: M117 (c)'s control writes a source file in a Verifier's workspace; from slice 12 that write reaches the snapshot, and a Verifier may change only the protected set

Row: M117
Test: packages/engine/test/acceptance/M117-processes-and-descriptors.test.mjs, case "(c) P14: …", its `probedRun` (a `verification` item, `script.complete([... step.write('p14.txt', ...), ..., step.probe('mount_attempt', { target: 'p14-mount' })])`, then `waitForWork(fx.home, item, 'complete')`)
Filed by: Builder, M2 slice 12, 2026-10-03

## Claim

The case was written for slice 11, where a role's workspace writes stayed in its overlay and went with the domain (SEAM.md §122: "A slice-11 role writes files it reads back itself; nothing here claims a role's write reached the checkout"; "the materialization of a role's workspace writes … M132"). Slice 12 materializes them (SEAM.md §135, "Materialization (M121 (e))": "after termination the screened upper layer reaches the checkout and the snapshot commits it as section 28 says"), which M121 (e) pins and which passes on `build/m2-s12`. A `verification` run is a Verifier's, and M1's validation refuses a Verifier's change outside the protected set (SEAM.md §28; M19). So the control's `p14.txt` (and the `p14-mount` directory the mount attempt makes) now fail the run, and the item never becomes `complete`:

```
RUN failed diff_violation the run changed p14.txt: p14.txt is not in the protected set, and a verifier may change only the protected set
not ok 3 - (c) P14: …
  error: 'timed out after 30000 ms waiting for work item … to be complete'
```

(reproduced with the same script on a scratch sandbox-lane engine; every P14 assertion the case makes is about the role's `self_status`, the mount attempt and the read-back, none about the snapshot). M117 (a) and (b) pass.

## Proposed change

Keep the control inside the role's own volatile files, where a Verifier may write without changing its workspace: for example `step.write('/tmp/p14.txt', …)` and `read_back` of the same path, and `mount_attempt` with a target under `/tmp`; or dispatch the case's run as a Builder's (`stage_build`/`fix`), whose source write is committed. Nothing the case pins about P14 changes.

## Sources

- SEAM.md §122 (slice 11: writes not materialized), §135 ("Materialization"), §28 and row M19 (what each role may change).
- D2 §2.3: "after termination the engine screens the upper layer (§2.5) and only then materializes it into the checkout for snapshot admission".
