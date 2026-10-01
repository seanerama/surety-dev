# Acceptance tests

This directory belongs to the Verifier. The Builder may read it and may not change it (build spec §4).

- `manifest.json` lists, by base name, the test files each slice must pass. Slice 7 is the end-to-end journey, row M01.
- Test files are named `M<nn>-<slug>.test.mjs`; the slug is lower-case letters, digits and hyphens. A row may have several files. Each named case in a row is its own subtest with its own fixture.
- `COVERAGE.md` lists every named case of every row in `docs/acceptance/sdlc-M1-acceptance-plan-Astra.md`: its file, the slice it is listed under, and whether it is written. It is how one Verifier session hands over to the next.
- `contract/` holds the Verifier's expected transition tables. Cases are generated from these, never from the engine's own tables.
- `harness/` holds the test side of the seam and `SEAM.md`, which states exactly what the engine must provide (build spec §8).

The tests of slices 1 and 2 exist; later slices add theirs. `harness/selfcheck/run.mjs` checks the harness helpers that carry logic (it is not an acceptance test and the runner does not run it): run it with `node packages/engine/test/acceptance/harness/selfcheck/run.mjs` after changing anything under `harness/` or `contract/`, or any slice-2 test. Its last part runs the slice-2 test files against a witness engine and against mutants of it (`harness/SEAM.md` §21); that takes a few minutes, and `--fast` leaves it out. The witness engine is not the engine and is not a model for it.

From slice 2 on the tests drive the engine through a scripted backend. `harness/scripted/child.mjs` is the role program the engine launches in place of a coding agent; `harness/scripted.mjs` scripts it and instructs the scripted execution boundary; `harness/runs.mjs` holds the fixtures, commands and waits; `harness/invariants.mjs` holds what the store must show about a run; `harness/transitions.mjs` reads the contract tables and generates the transition cases.

Run with `node scripts/run-tests.mjs acceptance --slice N` for slices 1 to N, or without `--slice` for the full suite. The runner builds first and runs one file at a time. It fails on a failing, skipped or todo test, a file with no passing test, a file not named for a known row, a file not listed in the manifest, a listed file that is missing, and, on a full run, any row without a file.
