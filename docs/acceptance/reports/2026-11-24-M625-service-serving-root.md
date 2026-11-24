# M625: serving verification of a service that serves a directory (Verifier report, 2026-11-24)

Branch: `verify/m625-service-serving-root`, cut from f50dbcc8 (main 5b7c000a plus the driver's companion commit adding row M625, ROWS and the manifest entries). The engine on this branch is the **pre-fix** engine; the Builder's `serving` is on `build/service-serving-root`, which this branch has not seen.

Source of the row: DECISIONS item 40, Sean 2026-11-24: "The acceptance case is the one we just hit: a Python service serves public/ from a sealed repository, and Surety verifies the bytes actually served against that directory. Include a changed-file case that must fail verification."

## Files

- `packages/engine/test/acceptance/M625-a-service-serving-a-directory.test.mjs`: kernel lane, slice 49, cases (a) to (d).
- `packages/engine/test/acceptance/M625-a-python-service-on-a-real-unit.test.mjs`: sandbox lane, slice 50, case (e).
- `packages/engine/test/acceptance/harness/deploy/python-service.mjs` (new): the fixture.
- `packages/engine/test/acceptance/harness/deploy/static.mjs`: `runServingProgram` takes `root`. The default is `.`, so M614 is unchanged; it was re-run, 10/10 passed.
- The manifest, ROWS and the plan are unchanged: the file names are the ones the driver's companion commit lists.

## The fixture

- **Repository.** The repository holds M614's site (`SITE`: an entry, a stylesheet, a module script importing one local module, an image) under `public/`, plus `server.py`.
- **server.py.** It uses the standard library only (`http.server.ThreadingHTTPServer` and `SimpleHTTPRequestHandler`). It serves `public/` next to itself on `127.0.0.1` and `$PORT`, GET and HEAD only. A path with a `..` segment, or one that resolves outside the served directory, is 404. This was checked by hand: `/../server.py`, `/%2e%2e/server.py` and `/js/%2e%2e/%2e%2e/server.py` are all 404.
- **The changed copy.** With `SURETY_TEST_SERVE_CHANGED=<path>` set, server.py copies `public/` file by file into its own `$TMPDIR`, replaces that one file's bytes with `body { color: red; }\n`, and serves the copy. The sealed artifact is never written.
- **Runtime.** The configuration's `runtime` is `/usr/bin/python3`, pinned with the SHA-256 of the file that path names, computed at run time. If Python is missing, the test fails with that reason (`requirePython`); it never skips.
- **Kernel lane.** The test runs server.py itself with the host's `/usr/bin/python3`, on a free port of 127.0.0.1. Its working directory is the deployment's sealed artifact directory, or a changed copy of it (`changedCopy`, as in M614). The child is ended through its own handle at `t.after`.
- **Sandbox lane.** The engine runs `python3 server.py` in a real `local_service` unit, on the port `hostConfig` chooses.

## What each case asserts

### (a) The configuration, kernel lane

- **Accepted.** In service mode, `serving {root: public, entry: index.html}` is accepted (201). The version's content holds it, with no `mode` and no `static` added. The read says `mode: service`, has no `static` part, and states the root and entry.
- **Defaults, as static mode's.** `{root: public}` is filled to entry `index.html`, and `{}` to root `.` and entry `index.html`, in the content.
- **Refused 422 `config_invalid`, naming the field.**
  - `serving.root`: absolute, `../`, a `..` segment, empty, not a string, longer than 256 characters.
  - `serving.entry`: absolute, `../`, `.`, empty.
  - `serving`: an extra key, not an object.
  - In each case no environment is made.
- **Mode crossings.** `static` in service mode is still refused, naming `static`. `serving` in static mode is refused, naming `serving`.
- **Identity.**
  - No serving, `public`, `site`, and `site` with `home.html` give four distinct `config_identity` values.
  - The same content written again answers 200 with the same identity.
- **At deployment.** The request is refused 422 `config_invalid` naming `serving.entry`, with no authorization row, no deploy work and no deploy operation, for each of these:
  - an entry the root does not hold;
  - a root the artifact does not hold;
  - an entry that is a directory (`js`);
  - an entry that exists only outside the root (`server.py`).
- **The environment read.**
  - It states the configured root and entry before any deployment, and again once deployed.
  - After a later version declaring root `site`, it states both `site` (the current configuration) and `public` (the running generation).
  - The read is searched for any object carrying `root` and `entry`, because the row names no shape (objection 231, item 2).

### (b) The round and the program, kernel lane

- **The round.** The round has two required post-deploy checks: `behaves` (`post_deploy_behavior`, a service's own requirement, unchanged) and `serve` (`post_deploy_serving`). Both are recorded exit 0 through the scripted check boundary. The outcome: verification `verified`, `alpha_complete` satisfied, the candidate `alpha_deployed`.
- **No serving claim.** Nothing is recorded as serving verified. The verification's `serving` is null, the evaluation's `serving` is null, and `last_verified` has no `serving`; no `serving_verified` appears anywhere.
- **The freeze.** The deployment's frozen inputs (`finalizer_inputs`) hold `{public, index.html}`. A later configuration version leaves them byte-identical, and they do not take its root.
- **The program.** The engine's `dist/checks/programs/static-serving.mjs`, run as this test's child with `SURETY_STATIC_ROOT=public`, against server.py over the sealed artifact, exits 0. It lists `index.html`, `style.css`, `js/app.js`, `img/logo.svg` and `js/lap.js` relative to the root, each with served = expected SHA-256, status 200 and `match`. No path carries the `public/` prefix, and the summary says `serving_verified: true` with the statement.

### (c) A changed file, kernel lane

- **One file changed.** In a changed copy, `public/style.css` is overwritten. The program exits 1: `style.css` has served `sha256(changed)`, expected `sha256(original)`, status 200, `differs`. The other paths still `match`.
- **A path not in the artifact.** The copy's entry references `extra.css`, which only the copy holds. The program exits 1, and `extra.css` is listed with served digest, expected `-`, status 200, `not_in_artifact`. See objection 231 item 3 on why the entry necessarily differs too.
- **The round.** In a second deployment, the round's `serve` is recorded exit 1 (and `behaves` exit 0). The outcome:
  - verification `failed`, with its `serving` null;
  - `last_verified` null, and `attempted.outcome` `verification_failed`;
  - `alpha_complete` `not_satisfied` naming `DEPLOY_VERIFICATION_FAILED`, and the candidate not `alpha_deployed`.
- **The blocker, as today.** The deploy work item is `awaiting_decision`. Its blocker reason starts `deploy_completion_refused:` and names `DEPLOY_VERIFICATION_FAILED` and the operation, and a `blocker` decision on the item is open.

### (d) No serving declared, kernel lane

- **Content and request.** The content is as written: no `serving` and no `mode` added, `mode: service`, no `static`. The deployment request is issued even though the sealed tree has no `index.html` at `.`; there is no entry refusal without a declared serving. The frozen inputs hold no `public` spec.
- **The Lap-Lab finding, pinned.** The program with the default root `.` against server.py over `public/` exits 1, and every fetched path is served 200 with expected `-`, `not_in_artifact`.
- **The contrast.** The same program, artifact and server, given root `public`, exits 0 with every path `match`. Only the root the program is handed differs.

### (e) A real unit, sandbox lane

- **Setup.** `hostDeployable`, as M613 (d) uses it, provides the project and the held `behaves` check, plus the `serve` definition. Environment `alpha` is configured with `runtime` set to the pinned Python, `start [/usr/bin/python3, server.py]` and `serving {public, index.html}`.
- **The unit.**
  - The authorization is issued.
  - The recorded application argv is `[/usr/bin/python3, server.py]`.
  - Read from the host: the application's `/proc/<pid>/exe` SHA-256 is the pinned Python's, and its cmdline ends with `server.py`.
- **The first round.** `behaves` is released with GET `/` only. The outcome:
  - verification `verified`;
  - the serving check's result exit 0, from a toolchain path ending `checks/programs/static-serving.mjs`;
  - its output starts with the description, and lists each path as `<p>\t<sha>\t<sha>\t200\tmatch` relative to `public`;
  - the candidate `alpha_deployed`.
- **The changed file.** A second configuration version adds `SURETY_TEST_SERVE_CHANGED=style.css`, and the same candidate is deployed again. Both deployments carry the same artifact digest, with one artifact row of that digest, and the sealed manifest still records the original digest for `public/style.css`. The round's serving check exits 1: `style.css` has the changed and sealed digests, 200, `differs`, and the other paths `match`. The outcome is verification `failed`, `attempted` `verification_failed`, and `last_verified` still the first operation's.
- **Teardown.** The operator's teardown is applied, no unit of the environment's prefix is left, `running` is null, and the first verification is kept. `operatorGuard` checks before and after that no other unit was touched.

## How it was run, and what was observed on the pre-fix engine

Workstation, `TMPDIR=/tmp/ssr-v`, `npm ci --offline`, `npm run build` (exit 0); each file run with `node --test <file>` from the worktree root.

**Kernel file, final run: 34 tests, 8 pass, 17 fail, 9 cancelled, 0 skipped; exit 1, about 10 s.**

- **Fail: every (a) case that needs `serving` accepted or validated.** That is 1, 2, 3 to 12, and 17 of the configuration suite. The engine refuses the field itself:
  `422 {"code":"config_invalid","reason":"The configuration's serving is not a configuration field.","what_to_do":"Correct the configuration and write it again; no version was written.","subject":{"field":"serving"}}`
  The refusal cases fail because the field named is `serving` where `serving.root` or `serving.entry` is required (for example `+ 'serving' - 'serving.root'`).
- **Fail: all four deployment-time entry cases.** `deployable` cannot configure the environment, with the same 422 quoted above.
- **Cancelled: all nine (b)/(c) cases.** The suite's `before` hook failed at the configuration, with the same 422.
- **Pass: (a)'s extra-key and non-object refusals.** Both name `serving`, which the pre-fix engine also names.
- **Pass: `static` in service mode, and `serving` in static mode.** Both refusals are unchanged.
- **Pass: all four (d) cases.** These are today's behaviour, including the Lap-Lab `not_in_artifact` result and the `public` contrast. The contrast shows the program already passes with root `public`, as the brief expected.

**Sandbox file: 4 tests, 0 pass, 0 fail, 4 cancelled; exit 1, about 20 s.**

- The host checks passed. The project was built and nominated, and its workspace checks were recorded.
- The `before` hook then failed at `hostEnvironment`'s configuration, with the same 422 `serving` "is not a configuration field".
- The user unit list was the same before and after (only MAIN's three `surety-fa82848a4151*` entries).

**A probe, not part of the deliverable: the sandbox flow on the pre-fix engine with `serving` omitted.**

- **What was changed.** A scratch copy of the sandbox file, removed afterwards and never committed, dropped `serving` and the `alpha_deployed` wait. It ran on a real unit: 4 tests, 1 pass, 3 fail, about 50 s.
- **The unit ran Python.** The unit-and-runtime case passed: the real unit ran `/usr/bin/python3 server.py` with the pinned SHA-256.
- **The first round reproduced Lap-Lab's failure on a real unit.** Its verification was `failed`, because the serving check compared against root `.`.
- **The changed copy was served.** In the second deployment, the serving check listed `style.css` served `9767e91e…2c16` (the SHA-256 of the changed text), expected `-`, 200, `not_in_artifact`. So the unit served the changed copy, and the pre-fix root made it `not_in_artifact` rather than `differs`.
- **Teardown.** Teardown applied, no unit of the prefix was left, and the unit list was unchanged afterwards.
- **What it settles.** The fixture works on a real unit. The only missing piece is the engine accepting and handing over `serving`.

## Ambiguities and choices (details in objection 231)

1. **The freeze.** "A configuration version written later does not change what a deployment's check compares against" is not observable as written. The kernel lane has no check domain. The sandbox cannot order the round's two checks under `max_concurrent_checks` 1. The tests read the frozen inputs and the real domain's output relative to `public` instead.
2. **(d)'s defaults.** "Root `.` and entry `index.html`" is read as: the content stays as written (no `serving` filled in), and there is no deployment-time entry refusal. The environment read is not asserted for a configuration with no `serving`.
3. **Shapes.** The shape of the environment read's root and entry, and where the deployment freezes them, are not named by the row. Both are read without assuming a shape.
4. **The not-in-artifact case.** "A served path not in the artifact under the root" can only be reached through a changed entry, so that case also has a `differs` entry row.
5. **No sandbox not-in-artifact case.** The sandbox file has no `not_in_artifact` case. The row's (e) asks only for the pass and the changed file.
6. **`alpha_complete` needs both checks.** In (b), `alpha_complete` is satisfied only because the round also carries a passing behaviour check. For an output that is not `static_site`, the serving check is not the deployment-specific requirement (D4 §13.2 unchanged; M614 (d)).

## Objections

231: `docs/acceptance/objections/231-M625-the-frozen-serving-root-is-observable-only-indirectly.md`.

## Not done

SEAM.md was not given a section for M625; this report says what each case reads. The real and exhaust lanes were not run.
