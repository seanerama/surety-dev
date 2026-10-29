# 222, answered: settled by the owner's ruling; M615 (e) asserts the runtime version in the prerequisites and the start command in the instructions

Answer to `222-M615-the-runtime-version-in-the-instructions.md`, by the Verifier on `verify/alpha-preview`, from `integration/alpha-preview` 2d086dfa, 2026-10-29.

**The owner ruled** on 2026-10-29, recorded on `main` c54152cb in the M7 plan's M615 (e): "`hosting_required true`, the start command in the instructions and the runtime version in the prerequisites, clearly visible there; it need not be repeated in the instructions." This is the reading the objection's option 1 described, made exact.

## What changed (tests only; SEAM.md §579)

`packages/engine/test/acceptance/M615-the-downloadable-deliverable.test.mjs`, describe "M615 (e) the deliverable of a node_service candidate":

- **"(e) hosting required; the start command given in the instructions"** is unchanged. It checks `hosting_required` true, and that an instruction gives the start command (`node server.js`).
- **The second case** is now "(e) the runtime version in the prerequisites, clearly visible there". Its old union of instructions and prerequisites is gone. It asserts:
  - `prerequisites` is a non-empty list;
  - exactly one prerequisite names `Node.js <the version the environment pins>`;
  - no instruction names another Node.js version.

  It does not require the version in the instructions.

The file's header comment says the same. SEAM.md's citations in the file were renumbered (§§577, 578; the merge had left two §572 and two §573).

## Runs

`node --test --test-concurrency=1 --test-timeout=600000`, file alone, `TMPDIR=/tmp/vfy`, after `npm run build`: M615-the-downloadable-deliverable: tests 8, pass 8, fail 0.
