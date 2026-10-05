# 021: M136 "S1 (the review)" expects a passing attempt, which the fake lane cannot give: its containment canary never runs the provider-tunnel control

Row: M136 "E86 review", S1 (sandbox lane, the fake `claude`)
Test: packages/engine/test/acceptance/M136-adapter-with-a-fake-backend.test.mjs, the S1 case's last assertion:
`assert.deepEqual([done.status, k.passed], ['succeeded', true], "the backend's planted config does not change the canary's verdict …")`

Filed by: Builder, E86 review, 2026-10-05

## Claim

The case's own target holds. The planted ~/.gitconfig and workspace .gitconfig change none of the engine's actions. The canary fails for a reason that has nothing to do with them: SEAM §165's provider-tunnel control. For a real backend's canary (the fake is qualified as `claude`) that control needs "an accepted CONNECT to a candidate destination with bytes both ways" in the egress log. In this lane the fake's only candidate destination is `api.provider.example`. The test file says it is "never resolved" (SEAM §132), and the harness resolver's map is empty. So no tunnel is ever accepted, and no fake `claude` containment canary in the sandbox lane can pass, whatever the backend does.

The evidence, from a run of the case alone on build/m2-e86 at 144cf2f (2026-10-05, 21:31:00Z to 21:31:36Z UTC, engine home kept at /tmp/surety-acc-s2-ihaTkq, evidence rec_01M46ZNCW1V79Y1WAV8Y69MZ0V):

- every action passed, each completed under its hardening with the backend running:
  - token_read: denied (ENOENT);
  - git_config: denied ("status 4; direct open for writing EACCES; unchanged; error: could not write config file /surety/git/config: Device or resource busy"). The planted files are not read, and the detail names no .gitconfig;
  - engine_port: denied (ECONNREFUSED);
  - unlisted_connect: denied (status 403);
  - workspace_write: allowed (written).
- backend: seen at 21:31:04.954Z, in the domain at both host reads, `running_throughout` true;
- controls: workspace_write ran; provider_tunnel did not ("no accepted CONNECT to a candidate destination carried bytes both ways");
- reason: "a control did not run: provider_tunnel". The class is `containment_failed`.

Every other fake `claude` containment canary kept from this lane ends the same way. These are attempts with backend `claude` and candidate_egress ["api.provider.example"]: homes surety-acc-s2-VoawoT, -NDghma, -uLlEaO, -n93qcR, -mHtQTJ, -kumLKa and -hvTC0v. Each has reason "a control did not run: provider_tunnel" and status `failed`. The coordinator's full run (main + 6b1056b, run_01M46ZH5W4HTY6JBAHCWY31FXF) failed the case the same way.

A tunnel with bytes both ways cannot be made hermetically in this lane. The address policy refuses loopback and private answers. A documentation address is never connected (egress_connect_hang holds it: an accepted tunnel with no bytes, E85 (b)).

## Proposed change

Replace the attempt-level assertion with the containment verdict on the actions, which is what S1 is about:
- git_config witnessed, completed, `denied`, its detail the filesystem's refusal of the write (as the case already checks);
- every action passed;
- the canary's reason is exactly the provider-tunnel control, "a control did not run: provider_tunnel", or `actions.every(a => a.passed)` with `backend.running_throughout` true.

The alternative is an engine change: no tunnel control for a fake in the test mode. That would make the fake lane's canary pass on less evidence than the real one, so I don't propose it.
