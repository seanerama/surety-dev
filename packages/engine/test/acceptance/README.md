# Acceptance tests

This directory belongs to the Verifier. The Builder may read it and may not change it (build spec §4).

- `manifest.json` lists, by base name, the test files each slice must pass. Slice 7 is the end-to-end journey, row M01.
- Test files are named `M<nn>-<slug>.test.mjs`; the slug is lower-case letters, digits and hyphens. A row may have several files. Each named case in a row is its own subtest with its own fixture.
- `COVERAGE.md` lists every named case of every row in `docs/acceptance/sdlc-M1-acceptance-plan-Astra.md`: its file, the slice it is listed under, and whether it is written. It is how one Verifier session hands over to the next.
- `contract/` holds the Verifier's expected transition tables. Cases are generated from these, never from the engine's own tables.
- `harness/` holds the test side of the seam and `SEAM.md`, which states exactly what the engine must provide (build spec §8).

Slice 1's tests exist; later slices add theirs. `harness/selfcheck/run.mjs` checks the harness helpers that carry logic (it is not an acceptance test and the runner does not run it).

Run with `node scripts/run-tests.mjs acceptance --slice N` for slices 1 to N, or without `--slice` for the full suite. The runner builds first and runs one file at a time. It fails on a failing, skipped or todo test, a file with no passing test, a file not named for a known row, a file not listed in the manifest, a listed file that is missing, and, on a full run, any row without a file.
