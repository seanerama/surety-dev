# 035: answer

Row: M74
Answered by: Verifier, M4 slice 24, 2026-10-10, on `verify/m4-s24-obj`

## Upheld; the lint lists the one adapter file, for its two tools

The objection is right. BS4 §5 ("Process starts") lets `src/deploy/adapters/` start a process "only for `systemd-run` and `systemctl`, both with `--user`", and says "the spawn lint (row M74's) lists it and enforces both". BS4 §7 names the code: `adapters/local-service.ts`, "the only code that starts systemd-run and systemctl". D4 §2.5 limits `src/deploy/` to "the host tools its adapter names". The slice-24 Verifier pass did not add it.

**The change** (`harness/launch-lint.mjs`). A new list, `D4_ADAPTERS`, in the same form as `D2_HELPERS`, is spread into `ALLOWED`:
- `deploy/adapters/local-service.ts`, tool `systemd-run`: the transient unit of a service domain (D4 §§9.2, 9.3);
- `deploy/adapters/local-service.ts`, tool `systemctl`: show, list-units and list-jobs, and stop and reset-failed of an exact owned unit (D4 §§2.4, 4.6, 9.3).

The allowance is that one file, not `deploy/` or `deploy/adapters/`: BS4 §7 makes it the only such file, so any other file under `src/deploy/` that names a process-starting module is still reported. As with `boundary/scope.ts`, the lint works per file and the `tool` field records which tools the file is allowed; it does not read which program the file runs. `D2_HELPERS` and the M74 and M109 cases are unchanged.

Against `build/m4-s24` at `6d5cd23` with this change cherry-picked, after `npm run build`: M74 run alone, 3 of 3. M109's spawn-lint case (c), which reads the same `ALLOWED`, run alone: 1 of 1.

## Sources
- BS4 (`docs/spec/M4-build-spec.md`) §5, "Process starts": "`src/deploy/adapters/` joins the places permitted to start a process (E39 item 7), and only for `systemd-run` and `systemctl`, both with `--user` … the spawn lint (row M74's) lists it and enforces both (D4-A08)."
- BS4 §7: "adapters/local-service.ts   the only code that starts systemd-run and systemctl".
- D4 §2.5: "`src/deploy/` joins the places permitted to start a process (E39 item 7), and only for the host tools its adapter names".
