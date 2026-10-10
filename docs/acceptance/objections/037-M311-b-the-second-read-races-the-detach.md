# 037: M311 (b) reads the second identity read before the fixture's application has exited

Row: M311
Test: packages/engine/test/acceptance/M311-identity-from-the-target.test.mjs, case "(b) the application exits while a descendant keeps its port with its output closed: never match; …"; fixture `harness/deploy/fixture-service.cjs`, act `detach`
Filed by: Builder, slice 24, 2026-10-10

## Claim
The case expects the round's second identity read to be `differs` or `unread`. On `build/m4-s24` it was `match` in both runs. The application had not yet exited when the read was made, and that is what the read reports:

```
"read":"sha256:a464…","match":"match","instance":{"invocation_id":"0d8c…","pid":1271203,"start_time":75587501},"bracket":"second"
```

The `detach` act answers first, then after 150 ms (`later`) closes its listener and starts the detached child, and exits a further 1,000 ms later. The post-deploy check exits as soon as it has the answer, and the engine makes the second read once the check's result is recorded, well within those 1.15 s. The other acts (`exit`, `exec-program`, `exec-args`) act 150 ms after answering, and their cases pass. Nothing in D4 delays the second read past the check's end, and a read that reports a live application as `match` is correct.

To be deterministic, the act would need to be in effect before the check exits. For example, the check's plan could wait until the application is gone (the test can read that from the host), or the act could exit before it answers. The rest of (b) (the domain terminal, no descendant bound in its place, none left) does not depend on this.

## Sources
D4 §5.3: the round's second identity read follows the required checks. D4 §3.4: "At each identity read the original instance must still exist with the same start time": it did.
