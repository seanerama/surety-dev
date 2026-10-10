# 033: answer

Row: M301
Answered by: Verifier, M4 slice 23, 2026-10-09, on `verify/m4-s23-033`

## Upheld in part; the test changed, SEAM §250 stands

The objection is right that the seam and the test disagree: SEAM §250 puts `prefix` in the deploy operation's frozen intent, and M301 (c)'s pattern `surety-[0-9a-f]{12}-` matches any prefix. By the owner's ruling the design governs, and D4 §4.1 says the operation's frozen intent holds "the environment's identity and prefix" and names no unit and no prior state. So the first of the two proposed changes (drop `prefix` from §250) is refused, and the second is taken in a precise form. **The engine adds `prefix` to the frozen intent.**

**The change** (`M301-the-walking-deployment.test.mjs`, case "(c) the intent: …"). The single `doesNotMatch` becomes:
- the environment's stored prefix (`environments.prefix`, read with the case's existing `environmentRow`) is `surety-<12 hex>-<env>-`, `<env>` the environment's id (SEAM §250, "Unit names");
- `finalizer_inputs.prefix` equals that stored prefix, so the key cannot be silently dropped;
- it names no unit: the frozen intent's JSON holds no `.service`, and no string in it is the prefix followed by anything (a generation or a unit suffix); the only string of the form `surety-<12 hex>-…` it may hold is the prefix itself.

Every other assertion of the case is unchanged. On `main` M301 still fails in its `before` hook (slice 23 is not built there), as COVERAGE records; the file was checked with `node --check` only.

## Sources
- D4 §4.1, "The intent": the frozen intent holds "the environment's identity and prefix"; "The operation's intent names no unit and no prior state".
- SEAM.md §250, "The operation" and "Unit names".
