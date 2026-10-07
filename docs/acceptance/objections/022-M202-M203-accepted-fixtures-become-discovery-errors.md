# 022: Accepted M1/M2 fixtures write governed files that D3's discovery now refuses, so their gates become incomplete and their corrections cannot be approved

Row: M202 (d), (e); M203; and the accepted rows whose fixtures they change (M28, M35, M36, M37, M43, M53, M54, M55, M57, M106, M123, M125 expected; the exact set is reported after the build runs `--slice 14`)
Test: packages/engine/test/acceptance/harness/gates.mjs `PROTECTED_FILES` and `correction()`; M35-separate-governed-policy-file.test.mjs `GOVERNED`; M36-capture-protected-only-proposal.test.mjs `FILES`; M43-severity-tier-and-independence-floors.test.mjs line 178 (the governed edit); M123-protected-set-read-only.test.mjs line 46
Filed by: Builder, M3 slice 15, 2026-10-07

## Claim

The slice-15 rows pin three rules of D3 §1.1, §1.4 and L5 that the accepted fixtures break:

1. `required_checks` naming a key with no definition is `required_key_without_definition` (M202 (e)). `PROTECTED_FILES` (`{"protected_paths": [".surety/checks/"], "required_checks": ["login"]}`), M36's and M123's governed files list `login`, and no tree has `.surety/checks/defs/login.json`.
2. `check_commands` entries are `{"path": <absolute>, "sha256"?}` (A.4). M35's governed file and M43's governed edit give arrays (`{"login": ["node", ".surety/checks/login.mjs"]}`), which are `invalid_value`.
3. While the effective version has discovery errors every gate carries `ACCEPTANCE_SCOPE_INCOMPLETE` naming the path (M202 (d)), and the `approve` option of a `check_correction_*` decision about a proposal whose discovery has errors carries `CHECK_DEFINITION_INVALID` and is refused 409 (M202 (d), L5).

So an engine that passes M202 and M203 makes those accepted rows fail where they expect a satisfied gate or an approved correction. The M3 plan §4.3 lists the straddles of L3, L6, Q9 and F2, and none for discovery itself.

What the tests should require: the accepted fixtures should write governed files that are valid under A.4 (a `login` definition under `defs/` where `login` is required, or no `required_checks`; `check_commands` as `{path}` objects), with the former insufficient fixture pinned as now refused, as plan question 3 (a) does for the other corrections.

## Sources

- D3 §1.1: "A listed key with no definition is a discovery error." A.4: "`check_commands`: `{name: {path: absolute, sha256?: 64 hex}}`".
- D3 §1.4: "while the effective version has any, every gate of the project carries `ACCEPTANCE_SCOPE_INCOMPLETE` naming the paths ... A proposal with errors cannot be approved (L5)."
- SEAM §178, "Gates of a version with errors" and "A proposal with errors (L5)".
- M3 plan §4.3 and question 3 (a); E92 item 3.

The driver ruled on 2026-10-07, by E92 item 3, that the Verifier updates these fixtures in slice 15 and records each change in COVERAGE.md.
