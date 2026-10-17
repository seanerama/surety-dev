# M6 rule 23: the first preview on a real unit (M536, 2026-10-17)

The driver ran slice 40's project-lane journey, the first run to deploy a design preview on a real systemd user unit (M6 build spec §4.1 rule 23), and recorded the `surety-*` user unit list before and after it. Sean reviewed the evidence on 2026-10-17 (E162 item 5). These files were first kept in the driver's session scratchpad; they are copied here so that `/tmp` is not their only home.

**Revision:** `231b6d1` ("Merge main into build/m6-s40: slice 44's cases"), in the slice 40 Builder's worktree. **Host:** the workstation. **`TMPDIR`:** `/tmp/drv536`.

**Commands and exit statuses**, in order, from the driver's session (`O` was the scratchpad directory `m536-first/`):

1. Unit list before, then the build:

   ```
   export TMPDIR=/tmp/drv536; mkdir -p $TMPDIR
   systemctl --user list-units --all --plain --no-legend 'surety-*' > $O/units-before.txt
   wc -l < $O/units-before.txt          # printed 0
   npm run build --silent >/dev/null 2>&1 && echo built   # printed "built" (exit 0)
   ```

2. The journey and the unit list after:

   ```
   (date -u; node --test --test-concurrency=1 packages/engine/test/acceptance/M536-the-design-journey-on-the-scripted-backend.test.mjs; echo "rc=$?"; date -u) > $O/run.log 2>&1
   systemctl --user list-units --all --plain --no-legend 'surety-*' > $O/units-after.txt
   echo "after: $(wc -l < $O/units-after.txt)"   # printed "after: 0"
   ```

**Results** (the journey's output is kept as `run-log.txt`, since the repository ignores `*.log`):

- `units-before.txt` is empty (0 bytes).
- `units-after.txt` is empty (0 bytes).
- `run.log` records 12 tests, 12 passed, 0 failed, and `rc=0`, from 07:15:44 to 07:22:41 UTC.

**What this shows, and what it does not** (Sean, E162 item 5): no `surety-*` user unit was loaded immediately before the run, and none was left immediately after it. It does not establish that unrelated units were unchanged throughout the run: the lists cover `surety-*` units only, and only at the two moments.
