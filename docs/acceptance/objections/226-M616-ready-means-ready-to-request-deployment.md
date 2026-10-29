# 226: M616 (e) pins NOW's `build_complete` sentence for `ready` as "It can be deployed to alpha (…)."; under the owner's ruling of 2026-10-29 it says ready to request deployment, and what follows before the preview opens

Row: M616 (the owner's draft M7 plan, `docs/acceptance/sdlc-M7-acceptance-plan.md` §3b)
Test: packages/engine/test/acceptance/M616-deployment-compatibility-and-readiness.test.mjs, cases "(e) complete, configured where it can be hosted: ready, deploy" and "(e) the checks passed: ready, deploy"
Filed by: Builder, branch integration/alpha-preview, 2026-10-29
For: the Verifier (restate the two equalities); the owner if he reads the ruling differently

## Claim

The owner ruled on 2026-10-29: "If a serving check has not yet been proposed, readiness may mean ready to request deployment, not 'verified' or 'ready to open.' State that approval and verification follow."

The engine now serves this with `ready`:
- `build.deploy_readiness.means`: `request_deployment` (or `verified`, only when the current candidate is `alpha_deployed` and the deployment running in that environment is its own, deployed);
- `build.deploy_readiness.follows`: what follows a request, in order, before the preview opens (`serving_check_proposal`, `deployment_checks_authoring`, `approval`, `request_again`, `deployment`, `verification`), or null when that cannot be read;
- the readiness reason and NOW's `build_complete` sentence say the same in words.

`primary_action` stays `deploy`, because the request is the action. The state stays `ready`. Every other readiness state, its reason and its sentence are unchanged.

The two cases pin NOW's whole reason with `assert.equal`, so they fail on the new sentence alone. Observed, the file run alone (`node --test --test-concurrency=1 --test-timeout=600000`, `TMPDIR=/tmp/bld`), on the Builder's working tree before commit: tests 20, pass 18, fail 2:

```
not ok 8 - (e) complete, configured where it can be hosted: ready, deploy
+ 'The planned build and its automated gates are complete. It is ready to request deployment to alpha (Node service, local_service service mode), not verified and not open: the deployment-specific post-deploy check is not in place yet: a request is refused naming it and asks a Verifier to write it, and its approval, a request again, the deployment and its verification follow before the preview opens.'
- 'The planned build and its automated gates are complete. It can be deployed to alpha (Node service, local_service service mode).'

not ok 7 - (e) the checks passed: ready, deploy
+ 'The planned build and its automated gates are complete. It is ready to request deployment to alpha (static site, local_service static mode), not verified and not open: the deployment and its verification follow before the preview opens.'
- 'The planned build and its automated gates are complete. It can be deployed to alpha (static site, local_service static mode).'
```

After that run, the clauses' inner colons became semicolons. The committed text of the first case reads "…not in place yet, so a request is refused naming it and asks a Verifier to write it; its approval, a request again, the deployment and its verification follow before the preview opens." The second case's text is as shown.

What the cases mean to protect still holds and passes in the same file:
- the state `ready`;
- `primary_action` `deploy`;
- the first sentence "The planned build and its automated gates are complete.";
- the reason's prefix "The environment alpha can host this output (…) with local_service in … mode.";
- the reason claims no visual, acceptance or production readiness (the doesNotMatch on /visual|accept|production/i holds on the new text).

I ask the Verifier to restate both equalities as follows:
- the reason begins with "The planned build and its automated gates are complete. It is ready to request deployment to alpha (<kind>, local_service <mode> mode), not verified and not open: ";
- `build.deploy_readiness.means` is `request_deployment`;
- `follows` ends with `deployment`, `verification`.

For the static page whose serving check is applied, `follows` is exactly `['deployment', 'verification']`. For the Node service whose effective version has no required `post_deploy_behavior` check in the `alpha_complete` scope, it is `['deployment_checks_authoring', 'approval', 'request_again', 'deployment', 'verification']`.

If the owner prefers NOW's sentence unchanged, and the ruling carried only by `means`, `follows` and the readiness reason, this objection is withdrawn. The engine change is then one line in `deploy/compatibility.ts readinessOf` (the `sentence` of the `ready` branch).

## Sources

- The owner's ruling of 2026-10-29, quoted above, given to the Builder in the integration brief (task 3).
- D4 §13.4: the `build_complete` status says that the implementation is complete and, apart from it, whether and where the candidate can be deployed.
- Developer tests: `test/unit/deploy-readiness.test.mjs`, the cases "the build complete in static mode", "ready means ready to request deployment …" and "ready for another output kind …".
