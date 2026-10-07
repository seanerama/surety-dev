# 022: answer

Answered by: Verifier, M3 slice 15 straddle (`verify/m3-s15-straddle`), 2026-10-07.

**Upheld** (D3 §§1.1, 1.4, A.4, L5; M3 plan §4.3 and question 3 (a); E92 item 3). The accepted fixtures wrote governed files that D3's discovery refuses. This straddle is discovery's own, and the plan's §4.3 did not list it. The fixtures are updated in this slice, as question 3 (a) requires for the other corrections. Each change keeps its row's own assertion, and the former form is pinned as now refused. `harness/SEAM.md` §187 and `packages/engine/test/acceptance/COVERAGE.md`, "The slice-15 straddle", record each change.

**What changed:**

1. `required_checks: ["login"]` with no `defs/login.json` was dropped from the governed files:
   - `harness/gates.mjs` `PROTECTED_FILES`, which M01, M28, M37, M41, M43, M49, M53 to M55, M57, M74, M106 and M125 use;
   - `M35-separate-governed-policy-file.test.mjs` `GOVERNED`;
   - `M36-capture-protected-only-proposal.test.mjs` `FILES`;
   - `M123-protected-set-read-only.test.mjs` `FILES`.

   A `login` definition was not added instead. Discovery would then declare its own `login` check beside the one these rows declare with the checks fixture, and `checks` is unique per version and key. These rows declare their checks with the fixture, and the governed file's `required_checks` was a sample value that no row asserts.
2. `check_commands` entries were turned from argument arrays into `{"path"}` objects: M35's `GOVERNED` (`login` → `/usr/bin/node`) and its edited value (`login` → `/bin/sh`), and M43's governed edit (`login`, `audit` → `/usr/bin/node`). Discovery never runs or reads the program.
3. **The former forms are pinned as refused:** M202 (b) gains the variant "a `check_commands` entry given as an argument array" → `invalid_value` at `…#/check_commands/login`. M202 (e) already pins a required key with no definition.

One row's case keeps its meaning by a changed value. In M54, "a loosening that changes the required set" now goes from `required_checks` absent (every check required) to `[]`, where it went from `["login"]` to `[]`. Both change the required set (D3 §1.1), and the case asserts the same blocker, `APPROVAL_MISSING`, and the same application.

**What was run.** On `main`'s engine (`fb8b950`), each file alone with `node --test`:
- kernel lane: M35 6/6, M36 4/4, M37 3/3, M43 7/7, M53 8/8, M54 6/6, M55 5/5, M57 2/2, M106 4/4, M28 1/1, M49 5/5, M41 5/5, M74 4/4, M01 (kernel journey) 11/11;
- sandbox lane: M123 5/5, M125 6/6.

The confirming run is the Builder's `--slice 14` on `build/m3-s15`.
