# 232: M627 (a)'s consequence text names the scripted backend's model, not the model configured for the Verifier

Row: M627 (`docs/acceptance/sdlc-M7-acceptance-plan.md` §3f, "The owner asks for the missing deployment check")
Test: packages/engine/test/acceptance/M627-the-owner-asks-for-the-missing-check.test.mjs, "(a) before: … its consequence naming the Verifier and its configured model"
Filed by: Verifier, branch verify/m627-m628-ask-verifier-signoff, 2026-11-24
For: the owner (one reading of the row to settle); the Builder if the row stands as the test reads it

## What the row says

M627 (a): "`authoring {state: 'none', offer: {method: 'POST', path, consequence_text}}`, the consequence text naming the Verifier role and its configured model". DECISIONS item 43 (Sean): "Say that this can use the configured model"; the driver's reading: "`consequence_text` is the engine's sentence naming the Verifier role and the model configured for it".

## What was observed

Gate tree: my branch (4285843c) merged with the Builder's a9971627 (`/tmp/avb-v/vgate`, removed after). The project is created with `model_verifier: 'sonnet-m627-verifier'` (the kernel lane's backend for every role is `scripted`).

- `consequence_text`: "Queues a Verifier check-authoring run on the configured model scripted: it writes the missing post_deploy_behavior check as a proposal you review; nothing is deployed."
- The Verifier's run that the request then queued records `model_requested` = `sonnet-m627-verifier` (read from the `runs` row while the run is held).

So the engine names one model in the sentence and records another as the model the very run it describes requests.

## Why

The Builder takes the model from `roleModelOf(db, project, 'verifier')` (src/prototype/brief.ts): the active trust entry's model, the scripted backend's `'scripted'`, or `model_verifier` when the backend is refused. `runs.ts` (claim) records `model_requested` as `roleModel(…) ?? backend.model`, i.e. `model_verifier` first ("its role's `model_<role>` key … recorded on the run and its ledger row and passed to a real backend's launch"). On a real backend the two agree (`resolveBackend` filters active entries by `sameModel(model_verifier, entry.model)`); on the scripted backend they do not.

## Question

Is "its configured model" the project's `model_verifier` (the model the run records it requests: what the test asserts), or the model the role's backend resolves to (the Builder's reading, which is `scripted` in the kernel lane)?

- If the former: the Builder names `roleModel(db, project, 'verifier')` where it is set (falling back to the backend's), as `runs.ts` does; the test stands.
- If the latter: the row should say "the model the Verifier's backend resolves to", and the test's assertion changes to that (the kernel lane then cannot distinguish it from a constant, and the real lane is where it would mean something).

The test is not bent meanwhile: that one assertion fails on the gate tree; the rest of M627 passes (11 of 12).
