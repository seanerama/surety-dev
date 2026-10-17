# 201: M537 (c)'s correction fake writes design checks that name no program, so the correction is never approvable and the design never ready

Row: M537 (c) (slice 46); the same fake plays M519's and M535's dress rehearsals (BS6 §12) and M541's hands-on run (SEAM.md §544)
Test: packages/engine/test/acceptance/M537-the-rehearsal-plays-from-the-designers-package.test.mjs, case "(c) the correction fake writes a check covering each design criterion from verifier.design_catalogue alone; the design becomes ready; the UI stages are dispatched"; harness/standin/package-fakes.cjs `designChecks`, `programOf`
Filed by: Builder, slice 46, 2026-10-17

## Claim

The correction fake (`designChecks`) takes its program from `programOf(R, null)`, which reads only `R['verifier.toolchain'].current.check_commands`. The correction package never states `verifier.toolchain`: M442 pins its absence (`harness/real/packages.mjs` `CORRECTION_ABSENT = ['verifier.toolchain', 'verifier.authoring_result', 'verifier.adoption_rule']`). So `programOf` gives `null`, and each definition's `command` starts with the program file itself:

```
"command": [".surety/checks/run/design-r2-2.mjs"]
```

Discovery refuses each one, `program_not_allowed`. Observed on `build/m6-s46` (`TMPDIR=/tmp/b46`, a copy of (c)'s fixture under `/tmp/b46` that logs refused answers and the proposal's discovery errors):

```
PROP prop_… awaiting_human [{"path":".surety/checks/defs/design-r2-2.json#/command/0","code":"program_not_allowed"},{"path":".surety/checks/defs/design-r2-3.json#/command/0","code":"program_not_allowed"},{"path":".surety/checks/defs/design-r3-2.json#/command/0","code":"program_not_allowed"}] null
REFUSED …/decisions/dec_…/answer 409 {"code":"illegal_transition","reason":"Option approve of decision dec_… cannot be chosen now: CHECK_DEFINITION_INVALID.", …}
```

The pump answers the `check_correction_unclassifiable` 80 times, each refused 409, and (c) fails "the design ready on the covering protected version: not reached within 80 ticks". The judgement of the correction's checks (`judgeDesignChecks`) would pass: a check covers each criterion, with `asset_inputs` for the slots. The 12 other cases of the file pass.

A model playing the correction has the same gap in its blocks: the correction package names its programs only in the guide's prose (`src/checks/guide.ts`, "### Programs"), never in a `surety-reads` block. So the engine now states them where a design check is written. `verifier.design_catalogue` gains

```json
"command": { "member": "command", "programs": ["node"], "rule": "A design check's command names one of these programs first, by its name, never a path (the governed file's check_commands); its program file is under the protected root." }
```

`programs` holds the governed file's `check_commands` names, sorted, or `null` when the governed values cannot be read (unknown, never none). It is stated in the authoring packages too, where it is `null` before the first phase names its toolchain.

**Asked:**
1. `programOf(R, governed)` in `package-fakes.cjs` falls back to `R['verifier.design_catalogue']?.command?.programs?.[0]` when `verifier.toolchain` names none (or `designChecks` reads it there first).
2. SEAM.md §538's `verifier.design_catalogue` row lists `command: {member, programs, rule}`.

The alternative, stating `verifier.toolchain` in the correction package, would contradict M442's `CORRECTION_ABSENT`, so I have not done it.

## Sources

- SEAM.md §539, "Assets and design checks": "A `check_correction` writes, for each criterion of `verifier.design_catalogue`, an acceptance check `design-<id>` covering it (its gate kinds from `verifier.gate_kinds_floor`), its program CONTENT's `design_checks[<kind>]`".
- D3 Appendix B, `command`: its first string names a program of the governed file's `check_commands` (`src/checks/schema.ts` `parseDefinition`, `program_not_allowed`).
- M442's `CORRECTION_ABSENT` (harness/real/packages.mjs line 42).
- E151; BS6 §11.4 ("the package states what the engine reads").
