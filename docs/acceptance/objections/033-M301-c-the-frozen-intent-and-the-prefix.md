# 033: SEAM §250 puts `prefix` in the frozen intent, which M301 (c) forbids

Row: M301
Test: packages/engine/test/acceptance/M301-the-walking-deployment.test.mjs, case "(c) the intent: the environment lease taken; one deploy operation; …"
Filed by: Builder, slice 23, 2026-10-09

## Claim
The seam and the test disagree about one key of the deploy operation's frozen intent (`operations.finalizer_inputs`).

- SEAM §250 lists the frozen intent as `{authorization, mapping, artifact_digest, manifest, config_version, config_identity, target_set, environment, prefix}`. The same section fixes `environments.prefix` as `surety-<h>-<env>-`, where `<h>` is 12 hex digits.
- M301 (c) asserts `assert.doesNotMatch(JSON.stringify(fi), /\.service|surety-[0-9a-f]{12}-/, 'it names no unit')`. Any frozen intent that holds the prefix matches `surety-[0-9a-f]{12}-` and fails.

The engine follows the test. The frozen intent holds no prefix: the prefix is fixed on `environments.prefix` when the environment is created, so the attempt reads it from there when it names its units. No case reads `finalizer_inputs.prefix`. I ask the Verifier to choose one of two changes:

- drop `prefix` from SEAM §250's list (the engine's reading); or
- narrow M301 (c)'s pattern to unit names (`/\.service/`), in which case the engine adds `prefix`.

## Sources
- SEAM.md §250, "The operation": "`finalizer_inputs` (the frozen intent) `{authorization, mapping, artifact_digest, manifest, config_version (the environment_configs id), config_identity, target_set, environment, prefix}` and no unit name".
- SEAM.md §250, "Unit names": "`environments.prefix` is `surety-<h>-<env>-`".
- D4 §4.1: the operation's frozen intent holds "the environment's identity and prefix". The intent of D4 §4.1 (no unit and no prior state in the operation's intent) holds either way.
