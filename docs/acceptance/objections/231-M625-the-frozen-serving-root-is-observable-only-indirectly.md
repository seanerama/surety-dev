# 231: M625 (b)'s "a configuration version written later does not change what a deployment's check compares against" cannot be observed as written in either lane; three readings of the row to confirm

Row: M625 (`docs/acceptance/sdlc-M7-acceptance-plan.md` §3d, "Serving verification of a service that serves a directory")
Tests: packages/engine/test/acceptance/M625-a-service-serving-a-directory.test.mjs (kernel, cases (a) to (d)); packages/engine/test/acceptance/M625-a-python-service-on-a-real-unit.test.mjs (sandbox, case (e))
Filed by: Verifier, branch verify/m625-service-serving-root, 2026-11-24
For: the owner (one testability question, three readings to confirm)

## Claim 1: the freeze is tested indirectly

The row says the `post_deploy_serving` check runs with `SURETY_STATIC_ROOT` and `SURETY_STATIC_ENTRY` "frozen with the deployment at its finalization (a configuration version written later does not change what a deployment's check compares against)". Neither lane can show that as written:

- **Kernel lane.** There is no check domain. The round's serving execution moves through the scripted check boundary (SEAM.md §190), and the variables the check runner would hand the program (`checks/run.ts`, from the admission's `serving`) are never computed or exposed. The kernel file reads what it can: the deployment's frozen inputs (`operations.finalizer_inputs`) hold `{root: public, entry: index.html}`; after a later configuration version declaring root `site` they are byte-for-byte unchanged and do not hold `site`; and the environment read states both `site` (current configuration) and `public` (running generation).
- **Sandbox lane.** The round has two required post-deploy checks: the behaviour check (a service's deployment-specific requirement; the serving check alone does not meet it for an output that is not `static_site`, D4 §13.2) and the serving check. With `max_concurrent_checks` 1 their admission order is the engine's, not the test's. So a configuration version written while the behaviour check is held may land before or after the serving check has run. A pass after such a write proves the freeze only if the serving check was still queued. The sandbox file therefore does not write a later version during a round. It proves only that the engine handed the declared root to a real check domain: every path is listed relative to `public` and matches. Under root `.` every path would read `not_in_artifact`, which is the Lap-Lab finding pinned in kernel (d).

**Question.** Does the indirect reading satisfy the row? If not, one of these is needed, and adding it is the owner's decision:
(i) a harness read of the variables an admission would hand a check (a seam addition for the Builder);
(ii) a way for the test to order the round's checks (for example a project key, or holding the serving check);
(iii) dropping the parenthesis from the row.

## Claim 2: readings to confirm (not defects)

1. **(d) "no `serving`: root `.` and entry `index.html`"** is read as follows. The configuration's content stays as written: no `serving` key is added, unlike static mode, which fills `static` with its defaults. Filling it would change the identity of every existing service configuration when it is written again, and the row says "exactly today's behaviour". There is also no deployment-time entry refusal without a declared `serving`: a Python tree with no `index.html` at its root is still issued, as today. The environment read for a configuration with no `serving` is not asserted. The row's "states the serving root and entry of the current configuration" leaves open whether it states the defaults or nothing.
2. **Where the environment read states the root and entry** is not named by the row, so the tests read it without assuming a shape. They find every object carrying string `root` and `entry` anywhere in the read, and the same for the deployment's frozen inputs. If the owner wants a pinned shape (for example `serving {root, entry}` and `running.serving`), the row should say so.
3. **(c) "a served path the artifact has no file for under the root"** cannot occur with the served entry byte-identical to the artifact's. A path is fetched only if the entry, or a script it references, names it. So the test serves a changed copy whose entry references one more stylesheet that only the copy holds. The case asserts the `not_in_artifact` row for that stylesheet and exit 1. The entry's own `differs` row comes with it and is not what the case is about.

## Sources

- The row, M7 plan §3d M625 (b): "the `post_deploy_serving` check runs with `SURETY_STATIC_ROOT` the declared root and `SURETY_STATIC_ENTRY` the declared entry, frozen with the deployment at its finalization (a configuration version written later does not change what a deployment's check compares against)"; (d): "no `serving`: root `.` and entry `index.html`, exactly today's behaviour (M614 unchanged)"; (a): "the environment read states the serving root and entry of the current configuration and of the running generation".
- SEAM.md §578, M614 (b) and (c): "the kernel lane has no check domain, so the round's serving execution moves through the scripted check boundary (§190)".
- The engine on this branch (pre-fix, f50dbcc8): `src/store/transitions/checks.ts` `admitExecution` takes `max_concurrent_checks` (default 1) and admits the round's queued executions in `execution_seq` order; `servingOf` derives the variables from the operation's `finalizer_inputs`; `src/checks/run.ts` sets them only in a real check domain.
