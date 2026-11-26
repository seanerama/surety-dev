# The Workshop Cut Planner fixture (row M646)

Vendored by the Verifier (item 57 rulings batch, 2026-11-26) from the owner's Workshop Cut Planner repository, read-only: `git -C <repo> archive <rev> <paths> | tar -x`, `git show <rev>:<path>`, `git diff --full-index`. Nothing in a test reads that repository (mini-hp01 has no clone). Every vendored file's git blob id below was checked equal to the repository's (`git hash-object`) when the fixture was made.

## Revisions

| Rev | Commit (WCP) | What it is in the replay |
|---|---|---|
| 29160a3 | bootstrap | `spec/idea.md`: the idea the project is made from |
| 76ea487 | w-1 brief_preparation | `spec/spec-v1.md`: spec version 1 as the Spec Writer wrote it (b7c6fc7 is the engine's approval commit of it) |
| c9faeaa | w-2 replan | iteration 1's architecture: `rev/c9faeaa/` (architecture.md, modules.json, roadmap.json) with `tree/.surety/adrs/ADR-001.md`, `ADR-002.md` and `tree/.surety/phases/phase-1.json` (unchanged since) |
| ff2ac28 + 8b965c6 | protected proposals | iteration 1's checks: `tree/.surety/checks/` less the files `index.mjs` `ITERATION2_CHECK_FILES` lists (23 definitions) |
| 17f0a3d | w-4 stage_build | iteration 1's code, its Alpha: `rev/a88fa57-to-17f0a3d.patch` applied to `tree/` (public/, server.mjs) |
| 3fa256d | w-9 brief_preparation | `spec/spec-v2.md`: spec version 2 as the Spec Writer wrote it (6dc246e approves it) |
| 2578102 | w-10 replan (its third run) | iteration 2's plan: `tree/.surety/{architecture,roadmap,adrs/ADR-003.md,phases/phase-2.json}`; phase-2.json declares `conformance: uncertain` |
| 226f7c0 + 3f631ef | protected proposals | iteration 2's checks: `tree/.surety/checks/` whole (33 definitions; 32 checks run before Alpha, user-operation at alpha_complete) |
| eed79f1 | w-12 stage_build | stage 1 of phase 2: `rev/a88fa57-to-eed79f1.patch` |
| a88fa57 | w-13 stage_build | stage 2 of phase 2 = candidate 2, the print defect: `tree/` (public/, server.mjs) |
| 1d32e51 | w-16 fix | the print fix = candidate 3: `rev/a88fa57-to-1d32e51.patch` (public/styles.css, 2 lines) |

The patches are the production diffs from a88fa57 (`git diff --full-index a88fa57 <rev> -- public server.mjs`); applied to `tree/` each reproduces that revision's public/ and server.mjs exactly (checked with `diff -r` when the fixture was made).

## Kept, rewritten, dropped

- Kept from a88fa57: `public/**`, `server.mjs`, `.surety/checks/{protected-policy.json,defs/**,run/**,post-deploy/**}`, `.surety/{adrs,architecture,roadmap,phases}/**`. 430 KB in all; the analyst's estimate (~300 KB) left out the plan products and the patches.
- Rewritten at use, not on disk: `protected-policy.json` names the owner's nvm node (v22.22.0) in `check_commands.node.path`, `runner_config.direct.read_paths` and `path`. `index.mjs` `governedForHost()` replaces those three with this host's node (`process.execPath`, `nodeReadPaths()`, its bin directory with /usr/bin and /bin), as M223's fixture names the engine's own node. Phase plans' `prepared_against.revision` is written `__HEAD__` for the scripted Architect to substitute.
- Dropped: `tests/**` (the Builders' own node:test files: named `*.test.mjs`, the acceptance runner would take them for rows), `.surety/checks/README.md`, `.surety/{spec,policy.json,project.json,idea.md}` at a88fa57 (the engine writes its own; the spec texts are under `spec/`), `README.md`, and 91d2080 (iteration 1's first stage: the replay's iteration 1 emits 17f0a3d's tree in its two stages, split by file).

## Not production files

- `tightened/accept-r5-5-print.json` and `tightened/units-r5-print.mjs`: the Verifier's check correction of the print finding in this replay. One check is added for R5.5 under the approved `node` command, shaped as 3f631ef added accept-r1-1-unit (`check-scenario.mjs <scenario> <criterion>`, a new scenario file, covers R5.5 only). accept-r5-5 and every existing file stay unchanged. With the saved two-board plan loaded, the new scenario requires the printed page to name the selected unit (millimetres, then inches) before the first board diagram. An edit of `scenarios/units-r5.mjs` would be classified `unclassifiable` (`input_changed`, classify.ts) and so goes to the owner under D2; an added check is `check_added`, a tightening. Observed when made (node v22.22.0): accept-r5-5-print exits 1 on a88fa57 (both print-order assertions fail) and 0 on 1d32e51. WCP's accept-r5-5 exits 0 on both (21 assertions) and 1 on eed79f1 (stage 1 has no print unit yet).
- `two-board-plan.json`: the saved plan (`CP_STORAGE` for lib/page.mjs): `cutPlanner.plan` as iteration 1's own `public/js/store.mjs` saved it, and `cutPlanner.unit: "mm"` (the key a88fa57's store.mjs names). Made by `derive-two-board-plan.mjs` (boards 1000 mm and 500 mm, three 400 mm pieces, a 3 mm blade, as the walkthrough entered them; layout offcuts 194 mm and 97 mm); the test derives it again and compares.
- `direct-scenario.mjs`: the test's own page sessions (print-visible text; the walkthrough's facts), run by the tree's lib/page.mjs; never registered with the engine.
- `index.mjs`: the harness module.

## The production finding

The replay's Verifier reports the print finding with criterion R5.5, check accept-r5-5, category defect, severity low, on candidate 2 (fnd_01M89FZ0TWRJEY7YNQC4VXQ6V8 as the analyst read it from MAIN). Its message text here is reconstructed from the walkthrough (l.81) and 1d32e51's commit message: MAIN's store was not read by the Verifier (COMMON-RULES). The iteration's change text is reconstructed the same way from 3fa256d's commit message.

## Files of `tree/` (source revision = the last WCP commit at or before a88fa57 that wrote the file; blob id)

| Path | Rev | Blob |
|---|---|---|
| `.surety/adrs/ADR-001.md` | c9faeaa | 4a180c9c9aca |
| `.surety/adrs/ADR-002.md` | c9faeaa | 86b0382bb4b9 |
| `.surety/adrs/ADR-003.md` | 2578102 | 98822c993218 |
| `.surety/architecture/architecture.md` | 2578102 | a3818a628f8d |
| `.surety/architecture/modules.json` | 2578102 | 5ec6e3fc2aaa |
| `.surety/checks/defs/accept-r1-1-unit.json` | 3f631ef | 412f8a5db8c6 |
| `.surety/checks/defs/accept-r1-1.json` | ff2ac28 | e9e863b6ea7d |
| `.surety/checks/defs/accept-r1-2.json` | ff2ac28 | 5d19499e3e86 |
| `.surety/checks/defs/accept-r1-3.json` | ff2ac28 | 39588fe79db3 |
| `.surety/checks/defs/accept-r1-4.json` | ff2ac28 | 0056bce28bfb |
| `.surety/checks/defs/accept-r1-5.json` | 226f7c0 | 3a68e7f6be16 |
| `.surety/checks/defs/accept-r1-6.json` | 226f7c0 | 34282241a228 |
| `.surety/checks/defs/accept-r1-7.json` | 226f7c0 | a291e7d363b4 |
| `.surety/checks/defs/accept-r2-1.json` | ff2ac28 | fd9ba63cd143 |
| `.surety/checks/defs/accept-r2-2.json` | ff2ac28 | d373b5352eb1 |
| `.surety/checks/defs/accept-r2-3.json` | ff2ac28 | 4d473c0abb22 |
| `.surety/checks/defs/accept-r2-4.json` | ff2ac28 | 34a1b908270e |
| `.surety/checks/defs/accept-r2-5.json` | 226f7c0 | 9feef8900fb1 |
| `.surety/checks/defs/accept-r3-1.json` | ff2ac28 | 4b164a2c4fc4 |
| `.surety/checks/defs/accept-r3-2.json` | ff2ac28 | 8f1255fe6fc9 |
| `.surety/checks/defs/accept-r3-3.json` | ff2ac28 | 4e2edee6b6f0 |
| `.surety/checks/defs/accept-r3-4.json` | ff2ac28 | 41cfbb9684d1 |
| `.surety/checks/defs/accept-r3-5.json` | ff2ac28 | 044fb179eb05 |
| `.surety/checks/defs/accept-r3-6.json` | 226f7c0 | e94b2f3277e3 |
| `.surety/checks/defs/accept-r4-1.json` | ff2ac28 | d9b6146ab678 |
| `.surety/checks/defs/accept-r4-2.json` | ff2ac28 | de0f76b342b6 |
| `.surety/checks/defs/accept-r4-3.json` | ff2ac28 | 319f524ce94c |
| `.surety/checks/defs/accept-r4-4-unit.json` | 3f631ef | fbcfe182d212 |
| `.surety/checks/defs/accept-r4-4.json` | ff2ac28 | 436771a82f55 |
| `.surety/checks/defs/accept-r4-5.json` | 226f7c0 | 900925bfdbc1 |
| `.surety/checks/defs/accept-r4-6.json` | 226f7c0 | a3b3dc1c59bf |
| `.surety/checks/defs/accept-r5-1.json` | ff2ac28 | 6f72ecec4934 |
| `.surety/checks/defs/accept-r5-2.json` | ff2ac28 | d119837cdc6e |
| `.surety/checks/defs/accept-r5-3.json` | ff2ac28 | a48ebccc1d35 |
| `.surety/checks/defs/accept-r5-4.json` | ff2ac28 | f1949609676d |
| `.surety/checks/defs/accept-r5-5.json` | 226f7c0 | e814c02cc516 |
| `.surety/checks/defs/smoke-server.json` | ff2ac28 | 36040bf39d74 |
| `.surety/checks/defs/user-operation.json` | 8b965c6 | be91acae6e46 |
| `.surety/checks/post-deploy/scenario.mjs` | 8b965c6 | 069fe1667213 |
| `.surety/checks/post-deploy/user-operation.mjs` | 8b965c6 | 1ad2f337af75 |
| `.surety/checks/protected-policy.json` | ff2ac28 | d22f534a30a8 |
| `.surety/checks/run/check-scenario.mjs` | 3f631ef | daf4f522a168 |
| `.surety/checks/run/check-units.mjs` | 226f7c0 | 2845b40e950a |
| `.surety/checks/run/check.mjs` | ff2ac28 | 9d5b85b95090 |
| `.surety/checks/run/lib/css.mjs` | ff2ac28 | c67f5d33b74f |
| `.surety/checks/run/lib/dom.mjs` | ff2ac28 | c4f93312e964 |
| `.surety/checks/run/lib/hooks.mjs` | ff2ac28 | dfc58a6dbe3d |
| `.surety/checks/run/lib/page.mjs` | ff2ac28 | 4258c19093cb |
| `.surety/checks/run/lib/selectors.mjs` | ff2ac28 | 948d3f461bf9 |
| `.surety/checks/run/lib/steps.mjs` | ff2ac28 | ff25829610b1 |
| `.surety/checks/run/lib/ui.mjs` | ff2ac28 | f5b2b77c8627 |
| `.surety/checks/run/lib/units.mjs` | 226f7c0 | c801e8583ff6 |
| `.surety/checks/run/scenarios/r1.mjs` | ff2ac28 | 11f56f974d64 |
| `.surety/checks/run/scenarios/r2.mjs` | ff2ac28 | 4c591f503643 |
| `.surety/checks/run/scenarios/r3.mjs` | ff2ac28 | 2cb0a4fc45f2 |
| `.surety/checks/run/scenarios/r4.mjs` | ff2ac28 | d16fe08cb111 |
| `.surety/checks/run/scenarios/r5.mjs` | ff2ac28 | 98bd5f93677b |
| `.surety/checks/run/scenarios/units-defaults.mjs` | 3f631ef | 455cf982c1b6 |
| `.surety/checks/run/scenarios/units-r1.mjs` | 226f7c0 | 2b119e3219df |
| `.surety/checks/run/scenarios/units-r2.mjs` | 226f7c0 | e26222273188 |
| `.surety/checks/run/scenarios/units-r3.mjs` | 226f7c0 | df6c5c571fd7 |
| `.surety/checks/run/scenarios/units-r4.mjs` | 226f7c0 | 667a94b2b5f0 |
| `.surety/checks/run/scenarios/units-r5.mjs` | 226f7c0 | ef996c400e6c |
| `.surety/checks/run/smoke.mjs` | ff2ac28 | 9db589712e72 |
| `.surety/phases/phase-1.json` | c9faeaa | 3f888f9bfbb0 |
| `.surety/phases/phase-2.json` | 2578102 | 6d5b7fb7314a |
| `.surety/roadmap/roadmap.json` | 2578102 | 9902d83fee19 |
| `public/index.html` | eed79f1 | 6c6baf2d0708 |
| `public/js/app.mjs` | a88fa57 | 76c1e5911774 |
| `public/js/planner.mjs` | a88fa57 | 20202750e69f |
| `public/js/store.mjs` | a88fa57 | 6404efbb843b |
| `public/js/units.mjs` | eed79f1 | aa559144f667 |
| `public/styles.css` | a88fa57 | db9df09877f3 |
| `server.mjs` | 91d2080 | f5980a4e232e |
