# 135: the preview's unit name `surety-<h>-design-preview-g<n>.service` carries no project, so two projects' previews in one home share one name

Row: M510 (b) (and M536 (d), M520's sandbox file, every case that reads the preview's unit)
Test: packages/engine/test/acceptance/M510-the-preview-on-a-real-unit.test.mjs, case "(b) the unit surety-<h>-design-preview-g1.service by exact name; …"
Filed by: Verifier, slice 42, 2026-10-17 (a question for Sean, not a Builder's objection; slice 40's Verifier noted it and did not file it)

## Claim

BS6 §4.1 rule 1 and the M6 plan's M510 (b) name the preview's unit `surety-<h>-design-preview-g<n>.service`, `<h>` the home's hash. D7 §5.7 says there is **one preview per project** ("one per project, adapter `local_service`"; "One preview generation per project"), and D4 §9.3 derives every other unit name from the environment's id (`surety-<h>-<env id>-g<n>.service`; on `main` the engine answers an owner's `design-preview` configuration with the prefix `surety-<h>-env_<ULID>-`). The reserved environment `design-preview` is a row per project, so it has a distinct id per project, but the name BS6 gives it does not use that id.

With two projects in one engine home, each with a preview, both first generations would be `surety-<h>-design-preview-g1.service`: the second would collide with the first (D4's `create_units` names must be unique on the host), or the engine would have to number generations across projects, which "one preview generation per project" does not say. The fail-closed teardown and `operatorGuard` (SEAM §257) also read units by the `surety-<h>-env_` prefix and so do not see a preview unit at all; the slice-42 files read the preview's prefix themselves.

The tests pin BS6's name as written, and each uses one previewing project per home, so they neither depend on nor exercise the collision. The choice is Sean's:

- (a) keep `surety-<h>-design-preview-g<n>.service` and say what a second project's preview does (refused while another project's preview runs in the home, or generations numbered per home);
- (b) name the preview's unit from its environment's id as D4 §9.3 names every unit (`surety-<h>-env_<ULID>-g<n>.service`), which makes it per project, puts it under the guard's prefix, and changes rule 1's wording, M510 (b) and SEAM §§488, 499 (the tests would then read the name from the environment's id);
- (c) `surety-<h>-design-preview-<project id>-g<n>.service`.

Whichever is chosen, the test changes to read it: a decision for the errata.

## Sources

- BS6 §4.1 rule 1: "the preview's unit is `surety-<h>-design-preview-g<n>.service`"; rule 23.
- M6 plan §3.4 M510 (b): "`surety-<h>-design-preview-g1.service` by exact name".
- D7 §5.7: "Environment `design-preview`, reserved, engine-configured …, one per project"; "One preview generation per project"; "the unit name derived from the home as D4 §9.3".
- D4 §9.3; SEAM §§250, 257 (`unitPrefix(home, environment)`, `ownUnitPattern`).
- COVERAGE, "M6 slice 40": "Noted, not filed: the preview's unit name … carries no project".

## Decided

Option (b), decided by the driver under Sean's delegation, 2026-10-17; applied by the Verifier on `verify/m6-o135` from main 0119ac0.

The preview's unit is named as D4 §9.3 names every unit, from its environment's id: `surety-<h>-env_<ULID>-g<n>.service`, `<ULID>` the id of the project's reserved `design-preview` environment row.

Why:
- D7 §5.7 already derives the name "from the home as D4 §9.3", and the environment row is per project. Rule 1's fixed `design-preview` name was the outlier.
- The id makes the name per project, so two projects' previews in one home never collide. Nothing new has to be said about cross-project generations or refusals, as (a) would require.
- The name falls under the `surety-<h>-env_` prefix and `ownUnitPattern`, so the fixture's fail-closed teardown and `operatorGuard` (SEAM §257) see a preview unit as they see every other unit. Under BS6's name they could not.
- (c) would also be per project, but it would stay outside the guard's prefix and add a second naming scheme.

What changed in the tests:
- `harness/design/preview42.mjs`: `previewPrefix`, `previewUnitName`, `previewUnits` and `previewCgroups` take the reserved row's id and are built on `unitPrefix`/`unitName`. `stopPreviewLeftovers` reads the row and stops a leftover only by its exact name, through `stopOwnUnit` (an attempt intent of the home must name it).
- M510, `M520-simulation-labelling-through-the-preview-unit` and M536 (d), (l) read the name from `previewEnvRow(home, project).id`. Each asserts the exact name, that it matches the guard's pattern (`assertOwnUnit`), the identity reads, and that nothing of the prefix is left after teardown, unit or cgroup. Each file keeps its own exact-prefix reads beside the guard.
- SEAM §§488, 499 and 503 are updated to match.

BS6 §4.1 rule 1's wording and the M6 plan's M510 (b) text belong to the owner and are left for the errata.
