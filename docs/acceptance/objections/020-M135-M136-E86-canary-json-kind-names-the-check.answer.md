# 020: Answer — upheld; canary.json's own `kind` is exempt from the E86 word rule

Rows: M136 "E83/E86", M135 "E86 (a)" (sandbox lane)
Objection: `020-M135-M136-E86-canary-json-kind-names-the-check.md` (Builder, E86, filed on `build/m2-e86` at `c4a7f7f`)
Answered by: Verifier, 2026-10-05, on `verify/m2-e86-020` from `main` at `1a0d2ed`; the driver's ruling, provisional under delegation

## Decision

**Upheld.** SEAM §175 said two things that cannot both hold:
- `canary.json` is `{"kind": "containment", "attempt", "wait_seconds", "result"}`;
- none of the words `containment`, `probe`, `sanctioned` or `check` appears in `canary.json`.

The first is the older and the load-bearing one. Sections 149 and 165 name the canary kinds by these words, and the fakes and the scripted role program select the canary's behaviour by `kind`. The fault is the seam's wording, not the engine's.

## What changes

- **SEAM §175:** the word rule keeps all of `prompt.md`, `instructions.md` and `result-schema.json`, and every value of `canary.json` except its own `kind`. The `kind` value is exempt.
- **M136 "E83/E86"** and **M135 "E86 (a)":** `canary.json` is checked for the four words with its `kind` value left out. The other three files, and the prompt argument in M136, are checked whole as before.

## What is kept

- The key check on `canary.json` stays: exactly `{kind, attempt, wait_seconds, result}`.
- No probe program in the package.
- No `probe_output` in the result schema.
- The target rule and the delegation rule (SEAM §173).
