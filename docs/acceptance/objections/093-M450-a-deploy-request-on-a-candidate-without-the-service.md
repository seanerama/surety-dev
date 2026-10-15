# 093: M450 (c) requests Alpha for stage 1's candidate, which holds no `server.mjs`, so the request is refused `config_invalid` (422) before any authorization

Row: M450
Test: packages/engine/test/acceptance/M450-deferred-authoring-and-the-exception.test.mjs, case "(a) each deferred entry an obligation …; (b) …; (c) AUTHORING_INCOMPLETE on phase and alpha_authorize until the deferred checks pass"
Filed by: Builder, slice 37, 2026-10-14

## Claim

While stage 2's Builder holds, the case takes `candidatesOfProject(fx.home, p.id).at(-1)`, the candidate of stage 1's integration, and after `alphaReady` requests Alpha for it, expecting 409 `authorization_not_issued` with `AUTHORING_INCOMPLETE` naming R2.2. The reference project's environment starts `server.mjs` (`start.1`), which stage 2 writes; stage 1's candidate has no such file. The request is refused when the artifact is sealed and checked against the configuration, before any authorization is derived (D4 §3.1): 422 `config_invalid`, "The configuration's start.1 names \"server.mjs\", which is not a file of the sealed artifact." Observed on `build/m5-s37` at 7969756: (a) and (b) pass up to this point (the two obligations, their events, R1.1's follow-up once, R2.2's none, `AUTHORING_INCOMPLETE` naming R2.2 on the phase gate). `M450` (d), (e) pass.

`AUTHORING_INCOMPLETE` on `alpha_authorize` is built (`src/store/transitions/gates.ts`, the slice-37 block for `alpha_authorize`); M435 (e) pins it passing on a candidate that holds the service (T1, the nomination at the completion of building).

I propose the case requests Alpha on a candidate that holds `server.mjs` while R2.2's checks are still deferred: for example after stage 2 integrates and before R2.2's follow-up is applied (its authoring held, or its proposal not yet approved), or moves this assertion after the fix's candidate exists; nothing else changes.

## Sources

- D4 §3.1 (the artifact sealed and refused before authorization); `src/deploy/commands.ts` `prepareDeployment`.
- `harness/journey/reference.mjs`: the environment's `start` names `server.mjs`; `BUILDER_FILES[2]` writes it.
