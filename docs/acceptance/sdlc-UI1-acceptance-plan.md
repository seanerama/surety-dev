# UI1 — engine acceptance rows for the operator console's prerequisites

**Owner:** Sean Mahoney. **Added:** 2026-10-23, for the console's engine prerequisite P1 (surety-console `docs/spec/UI1-build-spec.md` §4.1). One row, slice 47. The console's own rows (U01–U51) live in its repository and run under its harness; this plan holds only what the engine must do for the console to be hosted.

## 3. Rows

| Row | Statement | Expected | Sources | Lane | Slice |
|---|---|---|---|---|---|
| M547 | **The production shell parameter.** `surety serve --shell <dir>` names the static shell without `--harness`. (a) `--shell` with a missing path, a non-directory, or given twice, and `--shell` together with `--harness-shell`, are refused by usage (exit 2) before anything starts; (b) `--harness-shell` stays accepted only with `--harness`; (c) started **without** `--harness` on a disposable home with `--shell <dir>`, the engine reaches `mode: full` through every startup step in its own `surety-<home>-<incarnation>.scope`, serves `/` and each `/assets/<name>` byte for byte with `SHELL_CSP` and the defensive headers and without a token, serves no nested or unknown path as a shell route (they need the token), reports `bootstrap_exception: false`, and on SIGTERM exits leaving no `surety-*` unit under the user's service manager; (d) under `--harness`, `--shell` serves the directory exactly as `--harness-shell` does. | as stated; the served bytes equal the files; the CSP string equals `api/shell.ts`'s | UI1 build spec §4.1 (P1); `api/shell.ts`; `cli.ts`; D2 §3.1 (the scope) | kernel; (c) starts one non-harness engine on a disposable home and stops it by its pid | 47 |

## 4. Notes

(c) is the only acceptance test that starts an engine without `--harness`; it creates and removes one scope under the user's service manager, named from its own disposable home, and runs the host checks. It is listed under slice 47 so that `--slice 46` still runs the M1–M6 set unchanged. Demonstrated by hand on 2026-10-23 on the Builder's branch `build/ui1-p1-shell-flag` at `24fef2ea` before the row was written.
