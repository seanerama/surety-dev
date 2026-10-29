# 226, answered: upheld; M616 (e) reads `ready` as ready to request deployment, with `means` and `follows`

Answer to objection 226, by the Verifier on `verify/alpha-preview` at f6807fcd (the Builder's 6cbb7fc8 and d22a9da7; the M7 plan as amended on `main` a02ef863), 2026-10-29.

**Upheld.** The owner ruled on 2026-10-29: "If a serving check has not yet been proposed, readiness may mean ready to request deployment, not 'verified' or 'ready to open.' State that approval and verification follow."

The plan's M616 (e) now says the same. For `ready`, the readiness sentence says ready to request deployment, not verified and not open, and names what follows before the preview opens. `deploy_readiness.means` is `request_deployment` until the current candidate's own deployment there is verified, and `deploy_readiness.follows` lists what follows.

## What changed (tests only; SEAM.md §582)

`packages/engine/test/acceptance/M616-deployment-compatibility-and-readiness.test.mjs`:

**"(e) complete, configured where it can be hosted: ready, deploy"** (the Node service):
- `means` is `request_deployment`;
- `follows` is exactly `deployment_checks_authoring, approval, request_again, deployment, verification`;
- the readiness reason carries "Ready to request deployment, not verified and not open: ";
- NOW's reason begins "The planned build and its automated gates are complete. It is ready to request deployment to alpha (Node service, local_service service mode), not verified and not open: ";
- it names the approval and the verification, and says they follow before the preview opens;
- `primary_action` is `deploy`.

**"(e) the checks passed: ready, deploy"** (the static page, its serving check applied):
- `means` is `request_deployment`;
- `follows` is exactly `deployment, verification`;
- NOW's reason begins with the same sentence, for "static site, local_service static mode";
- `primary_action` is `deploy`.

**Added: the ruling's own case, a serving check not proposed.** The owner rejects the engine's proposal. Then:
- the state is `ready`, with `means` `request_deployment`;
- `follows` is exactly `serving_check_proposal, approval, deployment, verification`;
- the sentence names the approval and the verification;
- it never says "can be deployed", "is verified" or "is open".

**Also added under the same ruling set:**
- With an open decision, NOW is `waiting_on_you` with `answer_decision`, while `build {complete, completed_at, deploy_readiness}` is still served. This holds on both the project read and the list summary.
- The phase-completion path: the tick re-evaluates the stale phase gate, then readiness is `ready` and the deliverable is ready, with no client request.

Nothing else in the file changed.

## Runs

`node --test --test-concurrency=1 --test-timeout=600000`, file alone, `TMPDIR=/tmp/vfy`, after `npm run build`: M616: tests 23, pass 23, fail 0.
