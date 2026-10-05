# 020: the E86 word rule fails on canary.json's own `kind`, which SEAM §175 fixes as "containment"

Rows: M136 "E83/E86", M135 "E86 (a)" (sandbox lane)
Test:
- packages/engine/test/acceptance/M136-adapter-with-a-fake-backend.test.mjs, lines 292 to 296 (`WORDS = /\b(containment|probe|sanctioned|check)\b/i`, applied to `canary.json` among the four files);
- packages/engine/test/acceptance/M135-qualification-attempt.test.mjs, lines 365 to 368 (`PROBE_WORDS`, applied to `canary.json` among the four files).

Filed by: Builder, E86, 2026-10-05

## Claim

SEAM §175 says both of these:
- "`canary.json` is `{"kind": "containment", "attempt", "wait_seconds", "result"}`";
- "None of the words `containment`, `probe`, `sanctioned` or `check` appears in the prompt, `instructions.md`, `canary.json` or `result-schema.json`."

They cannot both hold. The first puts the word `containment` in canary.json as the value of `kind`, and the second forbids it there. The harness relies on the first. The fake `claude` branches on `canary.kind === 'containment'` (harness/standin/fake-claude.mjs line 222). The scripted role program picks its canary script by `canary-${canary.kind}.json` (harness/scripted/child.mjs lines 412 to 415). Sections 149 and 165 name the canary kinds by these words too.

On build/m2-e86 the engine writes canary.json as `{"kind":"containment","attempt":…,"result":{"status":"completed","summary":"qualification run of <attempt>"},"wait_seconds":30}`. Nothing else in the four files matches the word rule: `prompt.md`, `instructions.md` and `result-schema.json` hold none of the four words, and the result's summary was changed so that it does not name the kind. The only match is the `kind` value.

## Proposed change

Apply the word rule to canary.json with its `kind` value left out (for example, test `JSON.stringify({ ...canaryJson, kind: undefined })`), or apply it to the other three files only, and say so in §175. The key check on canary.json (`{kind, attempt, wait_seconds, result}`) stays as it is.

The alternative is renaming the containment canary's kind in canary.json (for example to `wait`). That would contradict §175's own text and §§149 and 165, and would break the fakes and the scripted role program, so I don't propose it.
